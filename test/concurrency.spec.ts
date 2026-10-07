import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Pool, type PoolClient } from 'pg';
import { AppModule } from '../src/app.module';
import { DbService, PG_POOL } from '../src/database/database.module';
import { ConflictError } from '../src/common/errors';
import { Fraction } from '../src/common/fraction';
import { resetHarness, seedBaseScenario, type Harness } from './harness';
import type { ActivityInput } from '../src/activity-data/activity-data.service';
import { MasterDataService } from '../src/master-data/master-data.service';
import { FactorLibraryService } from '../src/factor-library/factor-library.service';
import { GwpService } from '../src/factor-library/gwp.service';
import {
  ActivityDataService,
  ACTIVITY_VISIBILITY_LOCK_KEY
} from '../src/activity-data/activity-data.service';
import { AccountingService } from '../src/accounting/accounting.service';
import { RestatementService } from '../src/restatement/restatement.service';
import { CloseService } from '../src/close/close.service';
import { LineageService } from '../src/lineage/lineage.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * These specs reproduce, deterministically, the two concurrency defects that
 * only appear while multi-hundred-row import transactions are open:
 *
 *  1. a "now" cut queried mid-import returned one total and a different total
 *     when the same cut was re-queried after COMMIT (the visibility predicate
 *     used transaction-START time, which pre-dates the cut);
 *  2. a close started mid-import materialised a snapshot (2,212 t) that did
 *     not equal a recomputation at the cut/factor/GWP it had locked (35,392 t).
 *
 * Deterministic harness — a second, test-only advisory lock used as a gate:
 *
 *   - a row trigger makes every batch transaction block on a SHARED request
 *     on GATE_KEY when inserting its first row, which is strictly AFTER it
 *     acquired the production visibility shared lock (the first statement of
 *     the import transaction). A blocked batch is therefore provably "in
 *     flight: holds the visibility lock, has not committed";
 *   - the test holds GATE_KEY in EXCLUSIVE mode to park batches and releases
 *     it to let the parked cohort continue and commit together;
 *   - pg_locks is polled (no wall-clock race) to wait until the expected
 *     number of batches are parked.
 *
 * Under the fixed code a "now" cut (and a close) cannot complete while
 * batches are parked: it queues for the exclusive visibility lock until they
 * commit. Under the old code it completed immediately and later drifted.
 *
 * The Jest application pool is capped at 4 (test/setup-env.ts); these specs
 * need more concurrent backends, so they build their own Nest application
 * with PG_POOL overridden to 20, plus one dedicated gate connection.
 */

// Arbitrary positive 64-bit key, distinct from the production visibility key.
const GATE_KEY = 9_123_456_789_012_345n;

// pg_advisory_lock stores the 64-bit key as (classid, objid) = unsigned
// high/low 32 bits. Pre-compute both for counting granted visibility locks.
function keyParts(key: bigint): [number, number] {
  const u = BigInt.asUintN(64, key);
  return [Number((u >> 32n) & 0xffffffffn), Number(u & 0xffffffffn)];
}
const [GATE_HI, GATE_LO] = keyParts(GATE_KEY);
// The production activity-visibility lock, used here to fence corrections
// strictly after a cut in the correction regression test.
const VISIBILITY_KEY = BigInt(ACTIVITY_VISIBILITY_LOCK_KEY);

const GATE_FUNCTION = `
CREATE OR REPLACE FUNCTION ghg_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The batch already holds the production visibility shared lock; park here
  -- on the first row (B*-0000) until the test releases the gate. xact-scoped,
  -- so it is released on COMMIT/ROLLBACK too.
  IF NEW.record_no LIKE 'B_-0000' THEN
    PERFORM pg_advisory_xact_lock_shared(${GATE_KEY});
  END IF;
  RETURN NEW;
END; $$`;

async function buildWideHarness(): Promise<{
  h: Harness;
  app: TestingModule;
  pool: Pool;
  gate: PoolClient;
}> {
  const connectionString =
    process.env.DATABASE_URL_TEST ?? 'postgres://postgres@localhost:55432/ghg_test';
  const pool = new Pool({ connectionString, max: 20 });
  const app = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .compile();
  app.enableShutdownHooks();
  const h: Harness = {
    app,
    db: app.get(DbService),
    master: app.get(MasterDataService),
    factors: app.get(FactorLibraryService),
    gwp: app.get(GwpService),
    activity: app.get(ActivityDataService),
    accounting: app.get(AccountingService),
    restatement: app.get(RestatementService),
    close: app.get(CloseService),
    lineage: app.get(LineageService),
    shutdown: () => app.close()
  };
  // Dedicated connection whose only job is holding / releasing the gate.
  const gate = await pool.connect();
  return { h, app, pool, gate };
}

/**
 * Number of batch backends currently parked: they have inserted their first
 * row and are now WAITING on the gate shared lock (not yet granted). This is
 * independent of the production visibility lock, so it works both against
 * the fixed code (batches hold visibility shared, wait on gate) and the old
 * code under the red-check revert (no visibility lock, still wait on gate).
 */
async function parkedCount(h: Harness): Promise<number> {
  const res = await h.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted AND mode = 'ShareLock'
       AND classid = $1 AND objid = $2 AND objsubid = 1`,
    [GATE_HI, GATE_LO]
  );
  return Number(res.rows[0].n);
}

function batchRecords(prefix: string, n: number): ActivityInput[] {
  return Array.from({ length: n }, (_, i) => ({
    recordNo: `${prefix}-${String(i).padStart(4, '0')}`,
    siteCode: 'S1',
    sourceCode: 'BOILER',
    month: '2024-03',
    fuelKey: 'natural_gas',
    scope: 1 as const,
    quantity: '100',
    unit: 'GJ'
  }));
}

// One 100 GJ record at CO2 56.1 / CH4 1 / N2O 0.1 kg/GJ, GWP 1/28/265:
// 5.61 + 2.8 + 2.65 = 11.06 t CO2e.
const T_PER_RECORD = Fraction.from('11.06');
const tForRecords = (n: number) => T_PER_RECORD.mul(Fraction.from(n));

describe('concurrent imports vs. "now" cuts and monthly closes', () => {
  let h: Harness;
  let app: TestingModule;
  let pool: Pool;
  let gate: PoolClient;
  let fvId: number;
  let gwpId: number;

  beforeAll(async () => {
    ({ h, app, pool, gate } = await buildWideHarness());
  });
  afterAll(async () => {
    // Return the gate client first: pool.end() (run by DbModule's
    // onModuleDestroy inside app.close) waits for every checked-out client.
    gate.release();
    await app.close();
  });
  beforeEach(async () => {
    await resetHarness(h);
    await seedBaseScenario(h, {
      sites: [{ code: 'S1', sources: [{ code: 'BOILER', fuelKey: 'natural_gas', scope: 1 as const }] }]
    });
    fvId = (await h.factors.getVersion('FV1')).id;
    gwpId = await h.gwp.resolveSetId(h.db, 'AR5');
    await h.db.query(GATE_FUNCTION);
    await h.db.query(`DROP TRIGGER IF EXISTS ghg_test_gate ON activity_records`);
  });
  afterEach(async () => {
    await gate.query('SELECT pg_advisory_unlock_all()').catch(() => {});
    await h.db.query(`DROP TRIGGER IF EXISTS ghg_test_gate ON activity_records`).catch(() => {});
    await h.db.query(`DROP FUNCTION IF EXISTS ghg_test_gate()`).catch(() => {});
  });

  /** Hold GATE exclusive and install the trigger, parking subsequent batches. */
  async function armGate(): Promise<void> {
    await gate.query('SELECT pg_advisory_unlock_all()');
    await gate.query('SELECT pg_advisory_lock($1)', [GATE_KEY]);
    await h.db.query(`DROP TRIGGER IF EXISTS ghg_test_gate ON activity_records`);
    await h.db.query(`CREATE TRIGGER ghg_test_gate AFTER INSERT ON activity_records
                       FOR EACH ROW EXECUTE FUNCTION ghg_test_gate()`);
  }

  /** Let every parked batch proceed and commit. */
  async function releaseGate(): Promise<void> {
    await gate.query('SELECT pg_advisory_unlock_all()');
  }

  /** Wait until exactly n batches are parked (visibility shared, gate blocked). */
  async function waitParked(n: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if ((await parkedCount(h)) === n) return;
      await sleep(25);
    }
    throw new Error(`expected ${n} parked batches, saw ${await parkedCount(h)}`);
  }

  /** Rejects if the promise stays pending past the timeout. */
  async function assertSettles<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('promise did not settle in time')), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Asserts the promise is still pending after ms. */
  async function assertStillPending(p: Promise<unknown>, ms: number): Promise<void> {
    let settled = false;
    // Observe without awaiting: awaiting here would deadlock the test (a
    // parked cut/close only settles AFTER this helper returns and the test
    // releases the gate). Both branches return undefined, so no unhandled
    // rejection dangles.
    p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await sleep(ms);
    expect(settled).toBe(false);
  }

  async function co2eAtCut(cutId: number): Promise<Fraction> {
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId: fvId, gwpSetId: gwpId });
    return h.accounting.grandTotal(bundle, { month: '2024-03' }).CO2E;
  }

  test('a cut observed once stays bit-identical while six batches land', async () => {
    // 200 pre-existing records.
    await h.activity.bulkImport({ records: batchRecords('PRE', 200) });
    // A cut from before the import window must keep the pre-state forever.
    const cPre = await h.activity.createCutNow('pre');
    expect((await co2eAtCut(cPre.id)).key()).toBe(tForRecords(200).key());

    await armGate();
    const importers = [0, 1, 2, 3, 4, 5].map((b) =>
      h.activity.bulkImport({ records: batchRecords(`B${b}`, 500) })
    );
    await waitParked(6);

    // All six batches in flight (uncommitted): creating a "now" cut MUST block
    // — the fixed semantics drain in-flight writers before stamping as_of.
    const midCutP = h.activity.createCutNow('mid');
    await assertStillPending(midCutP, 400);

    // Releasing the cohort commits the batches; the queued cut then drains
    // them and completes already containing all six on its FIRST observation.
    await releaseGate();
    const importResults = (await Promise.all(importers)).flat();
    expect(importResults.filter((r) => r.status === 'accepted')).toHaveLength(3000);
    const cMid = await assertSettles(midCutP, 10000);
    expect((await co2eAtCut(cMid.id)).key()).toBe(tForRecords(3200).key());

    // Second wave parked: existing cuts must not move while it is open.
    await armGate();
    const wave2 = [6, 7].map((b) => h.activity.bulkImport({ records: batchRecords(`B${b}`, 500) }));
    await waitParked(2);
    expect((await co2eAtCut(cPre.id)).key()).toBe(tForRecords(200).key());
    expect((await co2eAtCut(cMid.id)).key()).toBe(tForRecords(3200).key());
    await releaseGate();
    await Promise.all(wave2);

    // ...and bit-identical again after every import has returned.
    expect((await co2eAtCut(cPre.id)).key()).toBe(tForRecords(200).key());
    expect((await co2eAtCut(cMid.id)).key()).toBe(tForRecords(3200).key());

    // A fresh cut sees all 4,200 records.
    const cEnd = await h.activity.createCutNow('end');
    expect((await co2eAtCut(cEnd.id)).toDecimalString()).toBe(tForRecords(4200).toDecimalString());

    // All four gases re-query bit-identically.
    const loadAll = async (cutId: number) => {
      const b = await h.accounting.loadCaliber({ cutId, factorVersionId: fvId, gwpSetId: gwpId });
      const t = h.accounting.grandTotal(b, { month: '2024-03' });
      return [t.CO2.key(), t.CH4.key(), t.N2O.key(), t.CO2E.key()];
    };
    const first = await loadAll(cMid.id);
    await sleep(5);
    expect(await loadAll(cMid.id)).toEqual(first);
  }, 30000);

  test('a close started mid-import: snapshot, lineage and recomputation agree', async () => {
    await h.activity.bulkImport({ records: batchRecords('PRE', 200) });
    await armGate();

    const importers = [0, 1, 2, 3, 4, 5].map((b) =>
      h.activity.bulkImport({ records: batchRecords(`B${b}`, 500) })
    );
    await waitParked(6);

    // The close is requested while all six batches are in flight; its drain
    // cut must block rather than snapshot a pre-state that recomputes bigger.
    const closeP = h.close.closeMonth({ month: "2024-03", factorVersionId: fvId, gwpSetId: gwpId });
    await assertStillPending(closeP, 400);

    await releaseGate();
    const { closeId, cutId } = await assertSettles(closeP, 10000);
    const importResults = (await Promise.all(importers)).flat();
    expect(importResults.filter((r) => r.status === 'accepted')).toHaveLength(3000);

    const rows = await h.close.querySnapshot({ closeId });
    const sumGas = (gas: string) =>
      rows.filter((r) => r.gas === gas).reduce((a, r) => a.add(r.value), Fraction.ZERO);
    const snap = {
      CO2: sumGas('CO2'),
      CH4: sumGas('CH4'),
      N2O: sumGas('N2O'),
      CO2E: sumGas('CO2E')
    };

    // On-demand recomputation with exactly the caliber stored in close_periods.
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId: fvId, gwpSetId: gwpId });
    const live = h.accounting.grandTotal(bundle, { month: '2024-03' });
    expect(snap.CO2.key()).toBe(live.CO2.key());
    expect(snap.CH4.key()).toBe(live.CH4.key());
    expect(snap.N2O.key()).toBe(live.N2O.key());
    expect(snap.CO2E.key()).toBe(live.CO2E.key());
    // The drain cut waited for the in-flight cohort: both sides are the full
    // 3,200-record figure (old code: 2,212 in the snapshot vs 35,392 recomputed).
    expect(snap.CO2E.toDecimalString()).toBe('35392');
    expect(live.CO2E.toDecimalString()).toBe(tForRecords(3200).toDecimalString());

    // The snapshot lineage reconstructs the same CO2e record by record.
    const lineage = await h.close.querySnapshotLineage({ closeId });
    const gwpOf = (gas: string) =>
      gas === 'CO2' ? Fraction.ONE : gas === 'CH4' ? Fraction.from('28') : Fraction.from('265');
    const lineageCO2E = lineage.reduce((a, l) => a.add(l.gasTonnes.mul(gwpOf(l.gas))), Fraction.ZERO);
    expect(lineageCO2E.key()).toBe(snap.CO2E.key());

    // Closing the same month again still conflicts.
    await expect(
      h.close.closeMonth({ month: "2024-03", factorVersionId: fvId, gwpSetId: gwpId })
    ).rejects.toThrow(/already closed/);

    // A later cut still yields the same 35,392: nothing sneaks into the
    // locked caliber afterwards.
    const cAfter = await h.activity.createCutNow('after');
    expect((await co2eAtCut(cAfter.id)).key()).toBe(snap.CO2E.key());
  }, 30000);

  test('concurrent corrections: exactly one wins, the other conflicts; old cuts stay stable', async () => {
    // Original record uses a number the gate trigger never matches.
    const target = {
      recordNo: 'TARGET-1',
      siteCode: 'S1',
      sourceCode: 'BOILER',
      month: '2024-03',
      fuelKey: 'natural_gas',
      scope: 1 as const,
      quantity: '100',
      unit: 'GJ'
    };
    await h.activity.bulkImport({ records: [target] });

    // Build cBefore inside a short exclusive visibility-lock critical
    // section ON the gate connection itself (so no second connection waits
    // for the same lock). No writer can start (and thus stamp a batch
    // timestamp) while the lock is held, so corrections launched only after
    // release necessarily stamp strictly after cBefore.as_of — making
    // "cBefore excludes them" exact rather than a timing hope.
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock($1)', [VISIBILITY_KEY]);
    const cutRow = await gate.query<{ id: number }>(
      `INSERT INTO activity_cuts(label, as_of)
       VALUES ($1, clock_timestamp()) RETURNING id`,
      ['before-corrections']
    );
    const cBeforeId = cutRow.rows[0].id;
    await gate.query('COMMIT');

    const outcomesP = Promise.allSettled([
      h.activity.correctConcurrent({ ...target, recordNo: 'CORR-A', quantity: '110', supersedesRecordNo: 'TARGET-1' }),
      h.activity.correctConcurrent({ ...target, recordNo: 'CORR-B', quantity: '120', supersedesRecordNo: 'TARGET-1' })
    ]);

    // Let the corrections proceed: the partial unique index accepts exactly
    // one; the loser surfaces as 409.
    const outcomes = await assertSettles(outcomesP, 10000);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // cBefore was fenced before the corrections queued, so it never sees
    // either one — queried now and again later, bit-identically at the
    // original chain head.
    const headsAt = async (cutId: number) => {
      const b = await h.accounting.loadCaliber({ cutId, factorVersionId: fvId, gwpSetId: gwpId });
      return b.records
        .filter((r) => r.sourceCode === 'BOILER')
        .map((r) => `${r.recordNo}:${r.quantityFraction.toDecimalString()}`)
        .sort();
    };
    expect(await headsAt(cBeforeId)).toEqual(['TARGET-1:100']);
    expect(await headsAt(cBeforeId)).toEqual(['TARGET-1:100']);

    // A cut created only AFTER the corrections drained sees exactly one chain
    // head and is itself stable on repeated queries.
    const cAfter = await h.activity.createCutNow('after-corrections');
    const first = await headsAt(cAfter.id);
    expect(first).toHaveLength(1);
    expect(['CORR-A:110', 'CORR-B:120']).toContain(first[0]);
    expect(await headsAt(cAfter.id)).toEqual(first);
  }, 30000);
});
