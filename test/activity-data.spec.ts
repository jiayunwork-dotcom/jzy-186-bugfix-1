import 'reflect-metadata';
import { ConflictError, ValidationException } from '../src/common/errors';
import { buildHarness, resetHarness, seedBaseScenario, type Harness } from './harness';

describe('activity data validation, corrections and idempotency', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.shutdown();
  });
  beforeEach(async () => {
    await resetHarness(h);
    await seedBaseScenario(h);
  });

  const baseRec = {
    recordNo: 'R1',
    siteCode: 'S1',
    sourceCode: 'BOILER',
    month: '2024-01',
    fuelKey: 'natural_gas',
    scope: 1 as const,
    quantity: '100',
    unit: 'GJ'
  };

  test('bulk import reports every record individually; bad rows do not block good rows', async () => {
    const results = await h.activity.bulkImport({
      validateAgainstFactorVersion: 'FV1',
      records: [
        { ...baseRec, recordNo: 'GOOD', quantity: '10' },
        { ...baseRec, recordNo: 'NEG', quantity: '-5' },
        { ...baseRec, recordNo: 'INF', quantity: 'Infinity' },
        { ...baseRec, recordNo: 'BADUNIT', unit: 'GJ', quantity: '100' }
      ]
    });
    const byNo = Object.fromEntries(results.map((r) => [r.recordNo, r]));
    expect(byNo['GOOD'].status).toBe('accepted');
    expect(byNo['NEG'].status).toBe('rejected');
    expect(byNo['NEG'].errors?.[0].field).toBe('records[1].quantity');
    expect(byNo['NEG'].errors?.[0].code).toBe('NEGATIVE_OR_NON_FINITE');
    expect(byNo['INF'].status).toBe('rejected');
    expect(byNo['INF'].errors?.[0].field).toBe('records[2].quantity');
    expect(byNo['BADUNIT'].status).toBe('accepted'); // GJ is valid
    // the good row really landed
    expect(await h.activity.getRecord('GOOD')).toBeTruthy();
    expect(await h.activity.getRecord('NEG')).toBeNull();
  });

  test('unit not convertible to the factor unit is rejected with the field named', async () => {
    // Electricity factor is per kWh (energy). A mass quantity cannot reach it.
    const [r] = await h.activity.bulkImport({
      validateAgainstFactorVersion: 'FV1',
      records: [
        {
          recordNo: 'MASSQ',
          siteCode: 'S1',
          sourceCode: 'GRID',
          month: '2024-01',
          fuelKey: 'electricity',
          scope: 2,
          quantity: '100',
          unit: 'kg'
        }
      ]
    });
    expect(r.status).toBe('rejected');
    expect(r.errors?.some((e) => e.field === 'records[0].unit' && e.code === 'UNIT_NOT_CONVERTIBLE')).toBe(true);
  });

  test('month outside factor applicability period is rejected', async () => {
    const [r] = await h.activity.bulkImport({
      validateAgainstFactorVersion: 'FV1',
      records: [{ ...baseRec, recordNo: 'OLDMONTH', month: '2020-01' }]
    });
    expect(r.status).toBe('rejected');
    expect(r.errors?.some((e) => e.field === 'records[0].month' && e.code === 'MONTH_OUTSIDE_FACTOR_PERIOD')).toBe(true);
  });

  test('correction pointing at a missing or already-corrected record is rejected', async () => {
    await h.activity.bulkImport({ records: [{ ...baseRec }] });
    const missing = await h.activity.bulkImport({
      records: [{ ...baseRec, recordNo: 'C0', supersedesRecordNo: 'NOPE' }]
    });
    expect(missing[0].status).toBe('rejected');
    expect(missing[0].errors?.[0].code).toBe('CORRECTION_TARGET_MISSING');

    const first = await h.activity.bulkImport({
      records: [{ ...baseRec, recordNo: 'C1', quantity: '110', supersedesRecordNo: 'R1' }]
    });
    expect(first[0].status).toBe('accepted');

    const second = await h.activity.bulkImport({
      records: [{ ...baseRec, recordNo: 'C2', quantity: '120', supersedesRecordNo: 'R1' }]
    });
    expect(second[0].status).toBe('rejected');
    expect(second[0].errors?.[0].code).toBe('CORRECTION_TARGET_ALREADY_CORRECTED');

    // the single-correction endpoint throws a 409-style conflict
    await expect(
      h.activity.correct({ ...baseRec, recordNo: 'C3', quantity: '130', supersedesRecordNo: 'R1' })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('concurrent corrections of the same record: exactly one survives', async () => {
    await h.activity.bulkImport({ records: [{ ...baseRec }] });
    const mk = (no: string) =>
      h.activity.correctConcurrent({
        ...baseRec,
        recordNo: no,
        quantity: no === 'X1' ? '101' : '102',
        supersedesRecordNo: 'R1'
      });
    const outcomes = await Promise.allSettled([mk('X1'), mk('X2')]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(ConflictError);
    // only one correction row points at R1
    const cut = await h.activity.createCutNow('c');
    const eff = await h.activity.getEffectiveRecords(h.db, cut.asOfText);
    const chains = eff.filter((r) => r.siteCode === 'S1' && r.sourceCode === 'BOILER');
    expect(chains).toHaveLength(1);
    expect(['101', '102']).toContain(chains[0].quantityFraction.toDecimalString());
  });

  test('repeated submission of the same recordNo is idempotent and never double counts', async () => {
    const payload = { ...baseRec, recordNo: 'IDEM' };
    const first = await h.activity.bulkImport({ records: [payload] });
    const again = await h.activity.bulkImport({ records: [payload, payload, { ...payload }] });
    expect(first[0].status).toBe('accepted');
    expect(again.every((r) => r.status === 'duplicate')).toBe(true);

    const cut = await h.activity.createCutNow('i');
    const bundle = await h.accounting.loadCaliber({
      cutId: cut.id,
      factorVersionId: (await h.factors.getVersion('FV1')).id,
      gwpSetId: await h.gwp.resolveSetId(h.db, 'AR5')
    });
    const total = h.accounting.grandTotal(bundle, { siteCode: 'S1', sourceCode: 'BOILER' }).CO2;
    expect(total.toDecimalString()).toBe('5.61');
  });

  test('same recordNo with different content is rejected', async () => {
    await h.activity.bulkImport({ records: [{ ...baseRec, recordNo: 'DUP' }] });
    const [r] = await h.activity.bulkImport({
      records: [{ ...baseRec, recordNo: 'DUP', quantity: '999' }]
    });
    expect(r.status).toBe('rejected');
    expect(r.errors?.[0].code).toBe('DUPLICATE_KEY');
  });

  test('factor period overlap is rejected at publish time', async () => {
    await expect(
      h.factors.publishVersion({
        version: 'BAD',
        factors: [
          { fuelKey: 'x', gas: 'CO2', scope: 1, value: '1', unit: 'kg/GJ', validFrom: '2024-01', validTo: '2024-06' },
          { fuelKey: 'x', gas: 'CO2', scope: 1, value: '2', unit: 'kg/GJ', validFrom: '2024-06', validTo: '2024-12' }
        ]
      })
    ).rejects.toBeInstanceOf(ValidationException);
  });

  test('correction chain: the newest visible record wins at a cut', async () => {
    await h.activity.bulkImport({ records: [{ ...baseRec, quantity: '100' }] });
    const cut0 = await h.activity.createCutNow('cut0');
    await new Promise((r) => setTimeout(r, 5));
    await h.activity.bulkImport({
      records: [{ ...baseRec, recordNo: 'R1B', quantity: '140', supersedesRecordNo: 'R1' }]
    });
    const cut1 = await h.activity.createCutNow('cut1');
    const at0 = await h.activity.getEffectiveRecords(h.db, cut0.asOfText);
    const at1 = await h.activity.getEffectiveRecords(h.db, cut1.asOfText);
    expect(at0.find((r) => r.recordNo === 'R1')?.quantityFraction.toDecimalString()).toBe('100');
    expect(at1.find((r) => r.recordNo === 'R1B')?.quantityFraction.toDecimalString()).toBe('140');
    expect(at1.find((r) => r.recordNo === 'R1')).toBeUndefined();
  });
});
