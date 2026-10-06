import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { DbService, PG_POOL } from '../src/database/database.module';
import type { Pool } from 'pg';
import { MasterDataService } from '../src/master-data/master-data.service';
import { resetTables } from './db';
import { FactorLibraryService, type PublishFactorVersionInput } from '../src/factor-library/factor-library.service';
import { GwpService } from '../src/factor-library/gwp.service';
import { ActivityDataService, type ActivityInput } from '../src/activity-data/activity-data.service';
import { AccountingService } from '../src/accounting/accounting.service';
import { RestatementService } from '../src/restatement/restatement.service';
import { CloseService } from '../src/close/close.service';
import { LineageService } from '../src/lineage/lineage.service';

export interface Harness {
  app: TestingModule;
  db: DbService;
  master: MasterDataService;
  factors: FactorLibraryService;
  gwp: GwpService;
  activity: ActivityDataService;
  accounting: AccountingService;
  restatement: RestatementService;
  close: CloseService;
  lineage: LineageService;
  shutdown: () => Promise<void>;
}

export async function buildHarness(): Promise<Harness> {
  const app = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
  // Per-test reset runs via resetHarness(h) in the spec's beforeEach; the
  // spec registers afterAll(() => h.shutdown()) at describe scope, where Jest
  // hook registration is synchronous and guaranteed to run.
  return h;
}

/** Truncate every table through the harness's own application pool. */
export async function resetHarness(h: Harness): Promise<void> {
  await resetTables(h.db);
}

export interface SeedScenarioOptions {
  factorVersion?: string;
  /** factor value overrides per gas (kg/GJ), defaults to the worked example. */
  factorValues?: Partial<Record<'CO2' | 'CH4' | 'N2O', string>>;
  gwpCode?: string;
  gwp?: { CO2: string; CH4: string; N2O: string };
  sites?: Array<{ code: string; sources: Array<{ code: string; fuelKey: string; scope: 1 | 2 }> }>;
}

export async function seedBaseScenario(
  h: Harness,
  opts: SeedScenarioOptions = {}
): Promise<{ factorVersionId: number; gwpSetId: number }> {
  const sites = opts.sites ?? [
    {
      code: 'S1',
      sources: [
        { code: 'BOILER', fuelKey: 'natural_gas', scope: 1 as const },
        { code: 'GRID', fuelKey: 'electricity', scope: 2 as const }
      ]
    }
  ];
  for (const site of sites) {
    for (const src of site.sources) {
      await h.master.upsertSource({
        siteCode: site.code,
        code: src.code,
        name: src.code,
        fuelKey: src.fuelKey,
        scope: src.scope
      });
    }
  }

  const version = opts.factorVersion ?? 'FV1';
  const input: PublishFactorVersionInput = {
    version,
    fuels: [
      { fuelKey: 'natural_gas', density: '0.8', ncv: '45' }
    ],
    factors: [
      {
        fuelKey: 'natural_gas',
        gas: 'CO2',
        scope: 1,
        value: opts.factorValues?.CO2 ?? '56.1',
        unit: 'kg/GJ',
        validFrom: '2023-01',
        validTo: '2025-12'
      },
      {
        fuelKey: 'natural_gas',
        gas: 'CH4',
        scope: 1,
        value: opts.factorValues?.CH4 ?? '1.0',
        unit: 'kg/GJ',
        validFrom: '2023-01',
        validTo: '2025-12'
      },
      {
        fuelKey: 'natural_gas',
        gas: 'N2O',
        scope: 1,
        value: opts.factorValues?.N2O ?? '0.1',
        unit: 'kg/GJ',
        validFrom: '2023-01',
        validTo: '2025-12'
      },
      {
        fuelKey: 'electricity',
        gas: 'CO2',
        scope: 2,
        value: '0.4',
        unit: 'kg/kWh',
        validFrom: '2023-01',
        validTo: '2025-12'
      },
      {
        fuelKey: 'electricity',
        gas: 'CH4',
        scope: 2,
        value: '0',
        unit: 'kg/kWh',
        validFrom: '2023-01',
        validTo: '2025-12'
      },
      {
        fuelKey: 'electricity',
        gas: 'N2O',
        scope: 2,
        value: '0',
        unit: 'kg/kWh',
        validFrom: '2023-01',
        validTo: '2025-12'
      }
    ]
  };
  const fv = await h.factors.publishVersion(input);

  const gwpCode = opts.gwpCode ?? 'AR5';
  const values = opts.gwp ?? { CO2: '1', CH4: '28', N2O: '265' };
  const gwpSetId = await h.gwp.publishSet({
    code: gwpCode,
    name: gwpCode,
    values: [
      { gas: 'CO2', value: values.CO2 },
      { gas: 'CH4', value: values.CH4 },
      { gas: 'N2O', value: values.N2O }
    ]
  });

  return { factorVersionId: fv.id, gwpSetId };
}

/** Helper: import one record and assert it was accepted. */
export async function importRecord(h: Harness, rec: ActivityInput & { supersedesRecordNo?: string }) {
  const results = await h.activity.bulkImport({ records: [rec] });
  return results[0];
}
