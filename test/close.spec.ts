import 'reflect-metadata';
import { Fraction } from '../src/common/fraction';
import { buildHarness, resetHarness, seedBaseScenario, type Harness } from './harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('monthly close snapshots', () => {
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

  async function seedJanuary() {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'R1', siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' },
        { recordNo: 'R2', siteCode: 'S1', sourceCode: 'GRID', month: '2024-01', fuelKey: 'electricity', scope: 2, quantity: '1000', unit: 'kWh' }
      ]
    });
  }

  test('snapshot is unaffected by factor publications and corrections after the close', async () => {
    await seedJanuary();
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');

    const { closeId, cutId } = await h.close.closeMonth({
      month: '2024-01',
      factorVersionId: fv1,
      gwpSetId: ar5
    });
    expect(cutId).toBeGreaterThan(0);

    const before = await h.close.querySnapshot({ closeId });
    const beforeJson = JSON.stringify(before.map((r) => ({ ...r, value: r.value.key() })));

    // After close: publish new factors AND correct activity AND add late records.
    await sleep(5);
    await h.factors.publishVersion({
      version: 'FV2',
      fuels: [{ fuelKey: 'natural_gas', density: '0.8', ncv: '45' }],
      factors: [
        { fuelKey: 'natural_gas', gas: 'CO2', scope: 1, value: '99', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'CH4', scope: 1, value: '9', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'N2O', scope: 1, value: '0.9', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CO2', scope: 2, value: '9', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CH4', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'N2O', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' }
      ]
    });
    await h.activity.bulkImport({
      records: [
        { recordNo: 'R1-C', siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '500', unit: 'GJ', supersedesRecordNo: 'R1' },
        { recordNo: 'LATE', siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '500', unit: 'GJ' }
      ]
    });

    const after = await h.close.querySnapshot({ closeId });
    const afterJson = JSON.stringify(after.map((r) => ({ ...r, value: r.value.key() })));
    expect(afterJson).toBe(beforeJson);

    // Still the worked-example numbers.
    const co2Rows = before.filter((r) => r.gas === 'CO2' && r.scope === 1);
    const co2 = co2Rows.reduce((a, r) => a.add(r.value), Fraction.ZERO);
    expect(co2.toDecimalString()).toBe('5.61');

    const meta = await h.close.getClose(closeId);
    expect(meta.status).toBe('closed');
    expect(meta.factor_version).toBe('FV1');
  });

  test('snapshot rows reconcile with a full recomputation at the close caliber', async () => {
    await seedJanuary();
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    const { closeId, cutId } = await h.close.closeMonth({
      month: '2024-01',
      factorVersionId: fv1,
      gwpSetId: ar5
    });

    const rows = await h.close.querySnapshot({ closeId });
    const snapCO2 = rows.filter((r) => r.gas === 'CO2').reduce((a, r) => a.add(r.value), Fraction.ZERO);
    const snapCO2e = rows.filter((r) => r.gas === 'CO2E').reduce((a, r) => a.add(r.value), Fraction.ZERO);

    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId: fv1, gwpSetId: ar5 });
    const live = h.accounting.grandTotal(bundle, { month: '2024-01' });
    expect(snapCO2.key()).toBe(live.CO2.key());
    expect(snapCO2e.key()).toBe(live.CO2E.key());
  });

  test('snapshot carries factor lineage for every number', async () => {
    await seedJanuary();
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    const { closeId } = await h.close.closeMonth({ month: '2024-01', factorVersionId: fv1, gwpSetId: ar5 });
    const lineage = await h.close.querySnapshotLineage({ closeId, sourceCode: 'BOILER' });
    const gases = new Set(lineage.map((l) => `${l.recordNo}:${l.gas}`));
    expect(gases.has('R1:CO2')).toBe(true);
    expect(gases.has('R1:CH4')).toBe(true);
    expect(gases.has('R1:N2O')).toBe(true);
    const co2 = lineage.find((l) => l.recordNo === 'R1' && l.gas === 'CO2')!;
    expect(co2.gasTonnes.toDecimalString()).toBe('5.61');
    expect(co2.activityQty.toDecimalString()).toBe('100');
  });

  test('closing the same month twice fails', async () => {
    await seedJanuary();
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    await h.close.closeMonth({ month: '2024-01', factorVersionId: fv1, gwpSetId: ar5 });
    await expect(
      h.close.closeMonth({ month: '2024-01', factorVersionId: fv1, gwpSetId: ar5 })
    ).rejects.toThrow(/already closed/);
  });
});
