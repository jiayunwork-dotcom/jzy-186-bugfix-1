/* Standalone migration runner: `npm run migrate` / container startup. */
import { Pool } from 'pg';
import { join } from 'path';
import { runMigrations } from '../database/database.module';

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/ghg'
  });
  try {
    const applied = await runMigrations(pool, join(__dirname));
    if (applied.length === 0) {
      console.log('migrations: already up to date');
    } else {
      console.log(`migrations applied: ${applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
