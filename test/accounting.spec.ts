import 'reflect-metadata';
import { Fraction } from '../src/common/fraction';
import { buildHarness, resetHarness, seedBaseScenario, type Harness } from './harness';

describe('accounting engine (integration)', () => {
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

  async function seedRecordsAndCut() {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'R1', siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' },
        { recordNo: 'R2', siteCode: 'S1', sourceCode: 'BOILER', month: '2024-02', fuelKey: 'natural_gas', scope: 1, quantity: '200', unit: 'GJ' },
        { recordNo: 'R3', siteCode: 'S1', sourceCode: 'GRID', month: '2024-01', fuelKey: 'electricity', scope: 2, quantity: '1000', unit: 'kWh' }
      ]
    });
    const cut = await h.activity.createCutNow('test-cut');
    return cut.id;
  }

  test('worked example: 100 GJ × 56.1 kg/GJ = 5.61 t CO2', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'R1', siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' }
      ]
    });
    const cutId = (await h.activity.createCutNow('t')).id;
    const { factorVersionId, gwpSetId } = await ids(h, 'FV1', 'AR5');
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });

    const jan = h.accounting
      .aggregate(bundle, { groupBy: ['site', 'source', 'month'], siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01' })
      .find((r) => r.scope === 1)!;
    expect(jan.totals.CO2.toDecimalString()).toBe('5.61');
    expect(jan.totals.CO2.key()).toBe('561/100');
    // CH4 100 GJ × 1 kg/GJ = 0.1 t; N2O 100 × 0.1 kg/GJ = 0.01 t
    expect(jan.totals.CH4.toDecimalString()).toBe('0.1');
    expect(jan.totals.N2O.toDecimalString()).toBe('0.01');
    // CO2e = 5.61 + 0.1*28 + 0.01*265 = 5.61 + 2.8 + 2.65 = 11.06 t
    expect(jan.totals.CO2E.toDecimalString()).toBe('11.06');
  });

  test('site total equals the sum of its sources', async () => {
    const cutId = await seedRecordsAndCut();
    const { factorVersionId, gwpSetId } = await ids(h, 'FV1', 'AR5');
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });

    const siteRows = h.accounting.aggregate(bundle, { groupBy: ['site'] });
    const sourceRows = h.accounting.aggregate(bundle, { groupBy: ['site', 'source'] });

    for (const scope of [1, 2] as const) {
      const siteTotal = siteRows.find((r) => r.siteCode === 'S1' && r.scope === scope)!.totals.CO2;
      const sourceSum = sourceRows
        .filter((r) => r.siteCode === 'S1' && r.scope === scope)
        .reduce((acc, r) => acc.add(r.totals.CO2), Fraction.ZERO);
      expect(sourceSum.key()).toBe(siteTotal.key());
    }
    // GRID check: 1000 kWh × 0.4 kg/kWh = 0.4 t
    const grid = sourceRows.find((r) => r.sourceCode === 'GRID')!.totals.CO2;
    expect(grid.toDecimalString()).toBe('0.4');
  });

  test('annual total equals the sum of months', async () => {
    const cutId = await seedRecordsAndCut();
    const { factorVersionId, gwpSetId } = await ids(h, 'FV1', 'AR5');
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });

    const grand = h.accounting.grandTotal(bundle, { siteCode: 'S1', sourceCode: 'BOILER' });
    const monthRows = h.accounting.aggregate(bundle, {
      groupBy: ['month'],
      siteCode: 'S1',
      sourceCode: 'BOILER'
    });
    const monthSum = monthRows.reduce((acc, r) => acc.add(r.totals.CO2), Fraction.ZERO);
    // Jan 5.61 + Feb 11.22 = 16.83 t
    expect(monthSum.toDecimalString()).toBe('16.83');
    expect(grand.CO2.key()).toBe(monthSum.key());
  });

  test('the same caliber recomputed is bit-identical, repeatedly', async () => {
    const cutId = await seedRecordsAndCut();
    const { factorVersionId, gwpSetId } = await ids(h, 'FV1', 'AR5');
    const first = JSON.stringify((await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId })).leaves);
    for (let i = 0; i < 5; i++) {
      const b = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
      expect(JSON.stringify(b.leaves)).toBe(first);
    }
    // and stable against a different summation route
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    const byAggregate = h.accounting.grandTotal(bundle).CO2E;
    const byFold = bundle.leaves
      .flatMap((l) => (['CO2', 'CH4', 'N2O'] as const).map((g) => l.byGas[g].co2eTonnes))
      .sort((a, b) => (a.key() < b.key() ? -1 : 1))
      .reduce((a, b) => a.add(b), Fraction.ZERO);
    expect(byAggregate.key()).toBe(byFold.key());
  });

  test('lineage explains each number from records and factors', async () => {
    const cutId = await seedRecordsAndCut();
    const { factorVersionId, gwpSetId } = await ids(h, 'FV1', 'AR5');
    const report = await h.lineage.explain({
      cutId,
      factorVersionId,
      gwpSetId,
      filter: { siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01' }
    });
    expect(report.contributions).toHaveLength(1);
    const c = report.contributions[0];
    expect(c.recordNo).toBe('R1');
    const co2 = c.perGas.find((g) => g.gas === 'CO2')!;
    expect(co2.factorValue.toDecimalString()).toBe('56.1');
    expect(co2.factorUnit).toBe('kg/GJ');
    expect(co2.activityQty.toDecimalString()).toBe('100');
    expect(co2.gasTonnes.toDecimalString()).toBe('5.61');
    expect(co2.gwp.toDecimalString()).toBe('1');
    expect(co2.co2eTonnes.toDecimalString()).toBe('5.61');
    expect(co2.factorValidFrom).toBe('2023-01');
  });
});

async function ids(h: Harness, version: string, gwpCode: string) {
  const factorVersionId = (await h.factors.getVersion(version)).id;
  const gwpSetId = await h.gwp.resolveSetId(h.db, gwpCode);
  return { factorVersionId, gwpSetId };
}
