import 'reflect-metadata';
import { Fraction } from '../src/common/fraction';
import { buildHarness, resetHarness, seedBaseScenario, type Harness } from './harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('restatement & Shapley decomposition', () => {
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

  async function setupTwoFactorVersions() {
    // Version 2: CO2 factor rises 6% (56.1 -> 59.466), CH4/N2O unchanged.
    await h.factors.publishVersion({
      version: 'FV2',
      fuels: [{ fuelKey: 'natural_gas', density: '0.8', ncv: '45' }],
      factors: [
        { fuelKey: 'natural_gas', gas: 'CO2', scope: 1, value: '59.466', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'CH4', scope: 1, value: '1.0', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'N2O', scope: 1, value: '0.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CO2', scope: 2, value: '0.4', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CH4', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'N2O', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' }
      ]
    });
    await h.gwp.publishSet({
      code: 'AR6',
      name: 'AR6',
      values: [
        { gas: 'CO2', value: '1' },
        { gas: 'CH4', value: '29.8' },
        { gas: 'N2O', value: '273' }
      ]
    });

    // Initial activity: 100 GJ in the base year month.
    await h.activity.bulkImport({
      records: [
        { recordNo: 'R1', siteCode: 'S1', sourceCode: 'BOILER', month: '2023-06', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' }
      ]
    });
    const cut1 = await h.activity.createCutNow('cut-before-correction');

    // Site supplements ("补报") activity data: correct R1 to 110 GJ.
    await sleep(5);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'R1-C1', siteCode: 'S1', sourceCode: 'BOILER', month: '2023-06', fuelKey: 'natural_gas', scope: 1, quantity: '110', unit: 'GJ', supersedesRecordNo: 'R1' }
      ]
    });
    const cut2 = await h.activity.createCutNow('cut-after-correction');

    const fv1 = (await h.factors.getVersion('FV1')).id;
    const fv2 = (await h.factors.getVersion('FV2')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    const ar6 = await h.gwp.resolveSetId(h.db, 'AR6');
    return { cut1: cut1.id, cut2: cut2.id, fv1, fv2, ar5, ar6 };
  }

  test('components sum to the total exactly, for every metric', async () => {
    const { cut1, cut2, fv1, fv2, ar5, ar6 } = await setupTwoFactorVersions();
    const r = await h.restatement.compare({
      base: { cutId: cut1, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut2, factorVersionId: fv2, gwpSetId: ar6 },
      filter: { siteCode: 'S1', month: '2023-06' }
    });

    for (const c of r.components) {
      const sum = c.activity.add(c.factors).add(c.gwp);
      expect(sum.key()).toBe(c.total.key());
    }
    // grand total delta = current - base
    expect(r.components.find((c) => c.metric === 'CO2E')!.total.key())
      .toBe(r.currentTotals.CO2E.sub(r.baseTotals.CO2E).key());
  });

  test('activity-only and factor-only effects are the expected Shapley halves', async () => {
    const { cut1, cut2, fv1, fv2, ar5 } = await setupTwoFactorVersions();
    const r = await h.restatement.compare({
      base: { cutId: cut1, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut2, factorVersionId: fv2, gwpSetId: ar5 },
      filter: { siteCode: 'S1', month: '2023-06' }
    });
    const co2 = r.components.find((c) => c.metric === 'CO2')!;
    // A change alone: 10 GJ × 56.1 kg/GJ = 0.561 t
    // F change alone: 100 GJ × 3.366 kg/GJ = 0.3366 t
    // Shapley: half the interaction (10 × 3.366 = 0.03366) goes each way.
    expect(co2.activity.toDecimalString(12)).toBe('0.57783');
    expect(co2.factors.toDecimalString(12)).toBe('0.35343');
    expect(co2.gwp.key()).toBe('0/1');
    expect(co2.total.toDecimalString(12)).toBe('0.93126');
    // 110 × 59.466 − 100 × 56.1 = 6541.26 − 5610 = 931.26 kg = 0.93126 t
  });

  test('changing only the GWP set leaves CO2/CH4/N2O gas masses unchanged', async () => {
    const { cut2, fv1, ar5, ar6 } = await setupTwoFactorVersions();
    const r = await h.restatement.compare({
      base: { cutId: cut2, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut2, factorVersionId: fv1, gwpSetId: ar6 },
      filter: { siteCode: 'S1', month: '2023-06' }
    });
    for (const metric of ['CO2', 'CH4', 'N2O'] as const) {
      const c = r.components.find((x) => x.metric === metric)!;
      expect(c.total.key()).toBe('0/1');
      expect(c.activity.key()).toBe('0/1');
      expect(c.factors.key()).toBe('0/1');
      expect(c.gwp.key()).toBe('0/1');
    }
    // Only CO2e moves.
    const co2e = r.components.find((x) => x.metric === 'CO2E')!;
    expect(co2e.total.compare(Fraction.ZERO)).not.toBe(0);
    expect(co2e.activity.key()).toBe('0/1');
    expect(co2e.factors.key()).toBe('0/1');
    // CH4: 0.11 t × (29.8−28) = 0.198; N2O: 0.011 × (273−265) = 0.088; total 0.286
    expect(co2e.gwp.toDecimalString(10)).toBe('0.286');
  });

  test('significance threshold: 6% change flags the base year', async () => {
    const { cut1, cut2, fv1, fv2, ar5 } = await setupTwoFactorVersions();
    // Activity +10% and factor +6% combined -> clearly above 5%.
    const r = await h.restatement.compare({
      base: { cutId: cut1, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut2, factorVersionId: fv2, gwpSetId: ar5 },
      filter: { siteCode: 'S1', month: '2023-06' },
      baseYear: 2023,
      significanceThreshold: '0.05'
    });
    expect(r.significance?.triggered).toBe(true);
    const flag = await h.restatement.getBaseYearFlag(2023);
    expect(flag?.needsRecalc).toBe(true);
    const notes = await h.restatement.listNotes(2023);
    expect(notes).toHaveLength(1);
    expect(notes[0].triggered).toBe(true);
  });

  test('a density/NCV update is attributed entirely to the factor component', async () => {
    // 1000 m3 of gas under two factor versions: the per-GJ emission factor is
    // unchanged (56.1 kg/GJ), only NCV changes 45 -> 47.7 GJ/t (a factor-
    // library change). Activity volume and GWP set are identical.
    await h.factors.publishVersion({
      version: 'FVA',
      fuels: [{ fuelKey: 'gas_vol', density: '800', ncv: '45' }],
      factors: [
        { fuelKey: 'gas_vol', gas: 'CO2', scope: 1, value: '56.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'gas_vol', gas: 'CH4', scope: 1, value: '1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'gas_vol', gas: 'N2O', scope: 1, value: '0.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' }
      ]
    });
    await h.factors.publishVersion({
      version: 'FVB',
      fuels: [{ fuelKey: 'gas_vol', density: '800', ncv: '47.7' }],
      factors: [
        { fuelKey: 'gas_vol', gas: 'CO2', scope: 1, value: '56.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'gas_vol', gas: 'CH4', scope: 1, value: '1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'gas_vol', gas: 'N2O', scope: 1, value: '0.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' }
      ]
    });
    await h.master.upsertSource({
      siteCode: 'S1', code: 'VOLBOILER', name: 'vol boiler', fuelKey: 'gas_vol', scope: 1
    });
    await h.activity.bulkImport({
      validateAgainstFactorVersion: 'FVA',
      records: [
        { recordNo: 'V1', siteCode: 'S1', sourceCode: 'VOLBOILER', month: '2023-06', fuelKey: 'gas_vol', scope: 1, quantity: '1000', unit: 'm3' }
      ]
    });
    const cutId = (await h.activity.createCutNow('v')).id;
    const fva = (await h.factors.getVersion('FVA')).id;
    const fvb = (await h.factors.getVersion('FVB')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');

    const r = await h.restatement.compare({
      base: { cutId, factorVersionId: fva, gwpSetId: ar5 },
      current: { cutId, factorVersionId: fvb, gwpSetId: ar5 },
      filter: { siteCode: 'S1', sourceCode: 'VOLBOILER', month: '2023-06' }
    });
    const co2 = r.components.find((c) => c.metric === 'CO2')!;
    expect(co2.activity.key()).toBe('0/1');
    expect(co2.gwp.key()).toBe('0/1');
    // 1000 m3 × 800 kg/m3 = 800 t; Δenergy = 800 × 2.7 = 2160 GJ;
    // ΔCO2 = 2160 × 56.1 kg = 121176 kg = 121.176 t, wholly the factor share.
    expect(co2.factors.toDecimalString(6)).toBe('121.176');
    expect(co2.total.key()).toBe(co2.factors.key());
    // 800×45=36000 GJ → 2019.6 t ; 800×47.7=38160 GJ → 2140.776 t
    expect(r.baseTotals.CO2.toDecimalString(6)).toBe('2019.6');
    expect(r.currentTotals.CO2.toDecimalString(6)).toBe('2140.776');
  });

  test('change below the threshold does not flag the base year', async () => {
    const { cut1, fv1, ar5 } = await setupTwoFactorVersions();
    // Compare base against itself: zero change.
    const r = await h.restatement.compare({
      base: { cutId: cut1, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut1, factorVersionId: fv1, gwpSetId: ar5 },
      filter: { siteCode: 'S1', month: '2023-06' },
      baseYear: 2023
    });
    expect(r.significance?.triggered).toBe(false);
    expect(await h.restatement.getBaseYearFlag(2023)).toBeNull();
  });
});
