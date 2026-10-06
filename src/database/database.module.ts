import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export const PG_POOL = Symbol('PG_POOL');

export interface PgConfig {
  connectionString: string;
  max?: number;
}

/**
 * Minimal structural queryer accepted by services that can run either on the
 * pool (on-demand reads) or inside a transaction (close snapshot).
 */
export interface Queryer {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) readonly pool: Pool) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Repeatable-read transaction. The close operation captures its three
   * caliber references (activity cut timestamp, factor version id, GWP set
   * id) inside the transaction and every subsequent read is explicitly
   * filtered by those immutable references, so a factor publication or
   * correction committed while the close is running cannot affect it. The
   * repeatable-read snapshot additionally protects the supporting
   * master-data reads.
   */
  async withSnapshotTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      // Advisory lock of the close grain is taken inside the service.
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const connectionString =
          process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/ghg';
        return new Pool({
          connectionString,
          max: process.env.PG_POOL_MAX ? parseInt(process.env.PG_POOL_MAX, 10) : 10
        });
      }
    },
    DbService
  ],
  exports: [PG_POOL, DbService]
})
export class DbModule {}

const SCHEMA_TRACKING = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
)`;

export async function runMigrations(pool: Pool, migrationsDir?: string): Promise<string[]> {
  const dir = migrationsDir ?? join(__dirname);
  await pool.query(SCHEMA_TRACKING);
  const applied = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
