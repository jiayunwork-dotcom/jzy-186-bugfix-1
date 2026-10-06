import { Pool } from 'pg';
import type { Queryer } from '../src/database/database.module';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://postgres@localhost:55432/ghg_test';

export const testPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

export const RESET_TABLES_SQL =
  'TRUNCATE snapshot_lineage, snapshot_rows, close_periods, restatement_notes, ' +
  'base_year_flags, activity_records, activity_cuts, emission_factors, ' +
  'fuel_properties, factor_versions, gwp_values, gwp_sets, emission_sources, sites ' +
  'RESTART IDENTITY CASCADE';

/** Reset using whatever pool the test actually uses (avoids cross-pool locks). */
export async function resetTables(q: Queryer): Promise<void> {
  await q.query(RESET_TABLES_SQL);
}
