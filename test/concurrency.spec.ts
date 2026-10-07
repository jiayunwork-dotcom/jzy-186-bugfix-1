import 'reflect-metadata';
import { Pool, PoolClient } from 'pg';
import { Fraction } from '../src/common/fraction';
import { buildHarness, resetHarness, seedBaseScenario, type Harness } from './harness';
import type { ActivityInput, BulkImportInput } from '../src/activity-data/activity-data.service';

/**
 * Concurrency regressions for the two symptoms reported at mid-year review:
 *
 *  1. A "now" cut queried while big imports are in flight must return, on every
 *     later re-query, the exact totals observed at creation — rows of a
 *     transaction that had not committed when the cut froze can never leak in.
 *
 *  2. A monthly close taken while big imports are in flight: the disclosed
 *     snapshot rows/lineage and an on-demand recomputation using the close's
 *     locked cut must stay identical forever.
 *
 * Both tests *hold the import transactions open* on dedicated connections and
 * only let them commit after the cuts / close have frozen their boundaries —
 * the exact interleaving that made wall-clock cuts drift.
 */

const MONTH = '2024-01';
const BASE_RECORDS = 200;
const PARALLEL_BATCHES = 6;
const RECORDS_PER_BATCH = 500;

// 100 GJ of natural gas under the seed factors/GWP is, per record:
//   CO2 100*56.1 kg = 5.61 t, CH4 0.1 t, N2O 0.01 t
//   CO2e = 5.61*1 + 0.1*28 + 0.01*265 = 5.61 + 2.8 + 2.65 = 11.06 t
const CO2E_PER_RECORD = '11.06';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordsFor(prefix: string, count: number): ActivityInput[] {
  const out: ActivityInput[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      recordNo: `${prefix}-${i.toString().padStart(5, '0')}`,
      siteCode: 'S1',
      sourceCode: 'BOILER',
      month: MONTH,
      fuelKey: 'natural_gas',
      scope: 1,
      quantity: '100',
      unit: 'GJ'
    });
  }
  return out;
}

/**
 * Run one bulk import on a dedicated client/transaction. The promise resolves
 * once all rows are validated and inserted (but the transaction is still
 * open); `release` commits it. Other sessions cannot see the rows meanwhile.
 */
async function startImportTransaction(
  h: Harness,
  pool: Pool,
  payload: BulkImportInput
): Promise<{ release: () => Promise<void>; client: PoolClient }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  // bulkImportOn validates and inserts but never commits; awaiting it means
  // the rows are in (still invisible to other sessions) and the transaction
  // stays open until release() commits.
  await h.activity.bulkImportOn(client, payload);
  return {
    client,
    release: async () => {
      await client.query('COMMIT');
      client.release();
    }
  };
}

describe('commit-serial cut visibility under concurrent bulk import', () => {
  let h: Harness;
  /** Dedicated pool: held import transactions must not consume app-pool slots. */
  let importPool: Pool;

  beforeAll(async () => {
    h = await buildHarness();
    importPool = new Pool({
      connectionString:
        process.env.DATABASE_URL_TEST ?? 'postgres://postgres@localhost:55432/ghg_test',
      max: PARALLEL_BATCHES + 2
    });
  });
  afterAll(async () => {
    await importPool.end();
    await h.shutdown();
  });
  beforeEach(async () => {
    await resetHarness(h);
    await seedBaseScenario(h);
  });

  async function co2eForCut(cutId: number, fvId: number, gwpId: number): Promise<string> {
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId: fvId, gwpSetId: gwpId });
    return h.accounting.grandTotal(bundle, { month: MONTH }).CO2E.key();
  }

  test('cuts created during parallel imports keep their totals after the imports commit', async () => {
    // Baseline already landed before the window.
    await h.activity.bulkImport({ records: recordsFor('BASE', BASE_RECORDS) });
    const fvId = (await h.factors.getVersion('FV1')).id;
    const gwpId = await h.gwp.resolveSetId(h.db, 'AR5');

    const expectedBefore = Fraction.from(BASE_RECORDS).mul(Fraction.from(CO2E_PER_RECORD));
    const expectedAfter = Fraction.from(BASE_RECORDS + PARALLEL_BATCHES * RECORDS_PER_BATCH).mul(
      Fraction.from(CO2E_PER_RECORD)
    );

    // Open six import transactions; hold each uncommitted.
    const held: Array<{ release: () => Promise<void> }> = [];
    for (let b = 0; b < PARALLEL_BATCHES; b++) {
      held.push(await startImportTransaction(h, importPool, { records: recordsFor(`B${b}`, RECORDS_PER_BATCH) }));
    }

    // While every import transaction is open, repeatedly take "now" cuts and
    // immediately read each one's grand total. The records already inserted but
    // uncommitted must not belong to any of these cuts.
    const created: Array<{ cutId: number; totalAtCreation: string }> = [];
    for (let i = 0; i < 8; i++) {
      const cut = await h.activity.createCutNow(`racing-${i}`);
      created.push({ cutId: cut.id, totalAtCreation: await co2eForCut(cut.id, fvId, gwpId) });
      // Every racing cut sees exactly the committed baseline.
      expect(created[i].totalAtCreation).toBe(expectedBefore.key());
    }

    // Let all six imports finish.
    await Promise.all(held.map((x) => x.release()));

    // Re-query every cut: totals must be bit-identical to creation time.
    for (const c of created) {
      expect(await co2eForCut(c.cutId, fvId, gwpId)).toBe(c.totalAtCreation);
    }

    // A cut taken after the window sees the whole world.
    const after = await h.activity.createCutNow('after');
    expect(await co2eForCut(after.id, fvId, gwpId)).toBe(expectedAfter.key());
  }, 30000);

  test('a close taken during parallel imports reconciles with recomputation after the imports commit', async () => {
    await h.activity.bulkImport({ records: recordsFor('BASE', BASE_RECORDS) });
    const fvId = (await h.factors.getVersion('FV1')).id;
    const gwpId = await h.gwp.resolveSetId(h.db, 'AR5');

    const expectedSnapshot = Fraction.from(BASE_RECORDS).mul(Fraction.from(CO2E_PER_RECORD));
    const expectedWorld = Fraction.from(BASE_RECORDS + PARALLEL_BATCHES * RECORDS_PER_BATCH).mul(
      Fraction.from(CO2E_PER_RECORD)
    );

    const held: Array<{ release: () => Promise<void> }> = [];
    for (let b = 0; b < PARALLEL_BATCHES; b++) {
      held.push(await startImportTransaction(h, importPool, { records: recordsFor(`C${b}`, RECORDS_PER_BATCH) }));
    }

    // Close the month with the six import transactions still open.
    const { closeId, cutId } = await h.close.closeMonth({
      month: MONTH,
      factorVersionId: fvId,
      gwpSetId: gwpId
    });

    // Snapshot rows sum to the disclosed total (only the baseline).
    const rows = await h.close.querySnapshot({ closeId });
    const snapshotCO2e = rows
      .filter((r) => r.gas === 'CO2E')
      .reduce((a, r) => a.add(r.value), Fraction.ZERO);
    expect(snapshotCO2e.key()).toBe(expectedSnapshot.key());

    // Now let the imports land.
    await Promise.all(held.map((x) => x.release()));

    // Recompute the same month with the close's locked caliber: must equal the
    // snapshot row sum exactly (this was 2212 vs 35k under wall-clock cuts).
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId: fvId, gwpSetId: gwpId });
    const recomputed = h.accounting.grandTotal(bundle, { month: MONTH }).CO2E;
    expect(recomputed.key()).toBe(snapshotCO2e.key());
    expect(recomputed.key()).toBe(expectedSnapshot.key());

    // And the snapshot itself is still unchanged, while a fresh "now" cut sees
    // the complete post-import world.
    const rowsAfter = await h.close.querySnapshot({ closeId });
    const snapshotAfter = rowsAfter
      .filter((r) => r.gas === 'CO2E')
      .reduce((a, r) => a.add(r.value), Fraction.ZERO);
    expect(snapshotAfter.key()).toBe(expectedSnapshot.key());

    const fresh = await h.activity.createCutNow('fresh');
    const freshBundle = await h.accounting.loadCaliber({
      cutId: fresh.id,
      factorVersionId: fvId,
      gwpSetId: gwpId
    });
    expect(h.accounting.grandTotal(freshBundle, { month: MONTH }).CO2E.key()).toBe(expectedWorld.key());

    // Lineage of the close still references exactly the baseline record set.
    const lineageAfter = await h.close.querySnapshotLineage({ closeId });
    const lineageRecords = new Set(lineageAfter.map((l) => l.recordNo));
    expect(lineageRecords.size).toBe(BASE_RECORDS);
    expect([...lineageRecords].every((no) => no.startsWith('BASE-'))).toBe(true);
  }, 30000);

  test('a correction committed after a racing cut never changes that cut (corrections share the import path)', async () => {
    const fvId = (await h.factors.getVersion('FV1')).id;
    const gwpId = await h.gwp.resolveSetId(h.db, 'AR5');

    await h.activity.bulkImport({ records: recordsFor('R1', 1).map((r) => ({ ...r, recordNo: 'R1' })) });

    // Hold the correction transaction open exactly like a bulk import batch.
    const correction: ActivityInput = {
      recordNo: 'R1B',
      siteCode: 'S1',
      sourceCode: 'BOILER',
      month: MONTH,
      fuelKey: 'natural_gas',
      scope: 1,
      quantity: '140',
      unit: 'GJ',
      supersedesRecordNo: 'R1'
    };
    const held = await startImportTransaction(h, importPool, { records: [correction] });

    const cut = await h.activity.createCutNow('before-correction');
    const bundleAtCut = await h.accounting.loadCaliber({
      cutId: cut.id,
      factorVersionId: fvId,
      gwpSetId: gwpId
    });
    const headAtCut = h.accounting
      .grandTotal(bundleAtCut, { month: MONTH })
      .CO2;
    // Original record: 100 GJ -> 5.61 t CO2.
    expect(headAtCut.toDecimalString()).toBe('5.61');
    const captured = headAtCut.key();

    await held.release();

    // Same cut, later: chain head is still R1.
    const bundleAgain = await h.accounting.loadCaliber({
      cutId: cut.id,
      factorVersionId: fvId,
      gwpSetId: gwpId
    });
    expect(h.accounting.grandTotal(bundleAgain, { month: MONTH }).CO2.key()).toBe(captured);

    // A fresh cut sees the corrected head (140 GJ -> 7.854 t).
    const fresh = await h.activity.createCutNow('after-correction');
    const bundleFresh = await h.accounting.loadCaliber({
      cutId: fresh.id,
      factorVersionId: fvId,
      gwpSetId: gwpId
    });
    expect(h.accounting.grandTotal(bundleFresh, { month: MONTH }).CO2.toDecimalString()).toBe('7.854');
  }, 30000);

  test('manual cuts with an explicit past asOf keep wall-clock timestamp semantics', async () => {
    const fvId = (await h.factors.getVersion('FV1')).id;
    const gwpId = await h.gwp.resolveSetId(h.db, 'AR5');

    await h.activity.bulkImport({ records: [{ ...recordsFor('EARLY', 1)[0], recordNo: 'EARLY' }] });
    const early = await h.activity.getRecord('EARLY');
    expect(early).toBeTruthy();

    await sleep(10);
    await h.activity.bulkImport({ records: [{ ...recordsFor('LATE', 1)[0], recordNo: 'LATE' }] });
    const late = await h.activity.getRecord('LATE');

    // Manual cut strictly between the two commits: only the early record.
    const between = new Date((early!.createdAt.getTime() + late!.createdAt.getTime()) / 2);
    const cutBetween = await h.activity.createCut(between.toISOString(), 'manual-between');
    expect(cutBetween.mode).toBe('timestamp');
    const infoBetween = await h.activity.getCut(cutBetween.id);
    const b1 = await h.accounting.loadCaliber({ cutId: infoBetween.id, factorVersionId: fvId, gwpSetId: gwpId });
    expect(h.accounting.grandTotal(b1, { month: MONTH }).CO2.toDecimalString()).toBe('5.61');

    // Manual cut after both: both records (11.22 t CO2).
    const after = new Date(late!.createdAt.getTime() + 5);
    const cutAfter = await h.activity.createCut(after.toISOString(), 'manual-after');
    const infoAfter = await h.activity.getCut(cutAfter.id);
    expect(infoAfter.asOf).not.toBeNull();
    const b2 = await h.accounting.loadCaliber({ cutId: infoAfter.id, factorVersionId: fvId, gwpSetId: gwpId });
    expect(h.accounting.grandTotal(b2, { month: MONTH }).CO2.toDecimalString()).toBe('11.22');

    // Re-creating the manual cut at the same timestamp resolves to the same id
    // (idempotent), and re-querying it is still stable.
    const again = await h.activity.createCut(after.toISOString(), 'manual-after');
    expect(again.id).toBe(cutAfter.id);
    const b3 = await h.accounting.loadCaliber({ cutId: again.id, factorVersionId: fvId, gwpSetId: gwpId });
    expect(h.accounting.grandTotal(b3, { month: MONTH }).CO2.toDecimalString()).toBe('11.22');
  }, 30000);
});
