import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService, type Queryer } from '../database/database.module';

export interface Site {
  code: string;
  name: string;
}

export interface EmissionSource {
  siteCode: string;
  code: string;
  name: string;
  /** Fuel / activity key matched against the factor library. */
  fuelKey: string;
  scope: 1 | 2;
}

@Injectable()
export class MasterDataService {
  constructor(private readonly db: DbService) {}

  async upsertSite(site: Site): Promise<void> {
    await this.db.query(
      `INSERT INTO sites(code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [site.code, site.name]
    );
  }

  async upsertSource(source: EmissionSource): Promise<void> {
    await this.upsertSite({ code: source.siteCode, name: source.siteCode });
    await this.db.query(
      `INSERT INTO emission_sources(site_code, code, name, fuel_key, scope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (site_code, code)
       DO UPDATE SET name = EXCLUDED.name, fuel_key = EXCLUDED.fuel_key, scope = EXCLUDED.scope`,
      [source.siteCode, source.code, source.name, source.fuelKey, source.scope]
    );
  }

  async getSource(siteCode: string, code: string): Promise<EmissionSource | null> {
    return this.getSourceOn(this.db, siteCode, code);
  }

  /**
   * Transaction-scoped variant. Code running inside withTransaction MUST use
   * this (not getSource): otherwise the inner read checks out a *second*
   * client from the global pool while the outer transaction keeps holding
   * one, which self-deadlocks the pool once enough transactions are open
   * (each open transaction consumes 2 of N pool slots and can wait forever
   * for the second while holding the first).
   */
  async getSourceOn(client: Queryer, siteCode: string, code: string): Promise<EmissionSource | null> {
    const res = await client.query<{
      site_code: string;
      code: string;
      name: string;
      fuel_key: string;
      scope: number;
    }>(
      `SELECT site_code, code, name, fuel_key, scope
       FROM emission_sources WHERE site_code = $1 AND code = $2`,
      [siteCode, code]
    );
    const r = res.rows[0];
    return r
      ? { siteCode: r.site_code, code: r.code, name: r.name, fuelKey: r.fuel_key, scope: r.scope as 1 | 2 }
      : null;
  }
}

@Module({
  imports: [DbModule],
  providers: [MasterDataService],
  exports: [MasterDataService]
})
export class MasterDataModule {}
