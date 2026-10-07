import { Injectable, Module } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { ActivityDataModule, ActivityDataService, type ActivityRecord } from '../activity-data/activity-data.service';
import {
  FactorLibraryModule,
  FactorLibraryService
} from '../factor-library/factor-library.service';
import { GwpModule, GwpService } from '../factor-library/gwp.service';
import {
  aggregate,
  evaluateAll,
  grandTotal,
  type AggregateQuery,
  type AggregateRow,
  type Caliber,
  type FactorIndex,
  type RecordLeaf
} from './engine';
import { NotFoundError } from '../common/errors';

/**
 * Resolution of a caliber against immutable database objects. Once built, a
 * Bundle contains no live references: all arithmetic runs on frozen in-memory
 * tables, which is what makes repeated queries bit-identical.
 */
export interface CaliberBundle {
  caliber: Caliber;
  asOf: Date;
  /** Microsecond-precision cut timestamp; the operative visibility bound. */
  asOfText: string;
  factorVersion: string;
  gwpSetCode: string;
  records: ActivityRecord[];
  index: FactorIndex;
  leaves: RecordLeaf[];
}

@Injectable()
export class AccountingService {
  constructor(
    private readonly db: DbService,
    private readonly activity: ActivityDataService,
    private readonly factors: FactorLibraryService,
    private readonly gwp: GwpService
  ) {}

  /** Load everything one caliber needs. Read-only; may run in any snapshot. */
  async loadBundle(client: Queryer, caliber: Caliber): Promise<CaliberBundle> {
    const cut = await this.activity.getCutOn(client, caliber.cutId);
    const version = await this.factors.getVersionOn(client, caliber.factorVersionId);
    const gwpSet = await client.query<{ id: number; code: string }>(
      'SELECT id, code FROM gwp_sets WHERE id = $1',
      [caliber.gwpSetId]
    );
    if (!gwpSet.rows[0]) {
      throw new NotFoundError(`GWP set not found: ${caliber.gwpSetId}`);
    }
    // Issue the supporting reads serially on the SAME connection: never run
    // parallel queries against one pooled PoolClient (pg multiplexes them
    // onto one wire and the interleaving is deprecated). The cost is three
    // index-only scans per caliber, negligible next to the record scan.
    const records = await this.activity.getEffectiveRecords(client, cut.asOfText);
    const rows = await this.factors.getFactors(client, caliber.factorVersionId);
    const props = await this.factors.getFuelProperties(client, caliber.factorVersionId);
    const gwpValues = await this.gwp.getValues(client, caliber.gwpSetId);
    const index: FactorIndex = { rows, props, gwp: gwpValues };
    return {
      caliber,
      asOf: cut.asOf,
      asOfText: cut.asOfText,
      factorVersion: version.version,
      gwpSetCode: gwpSet.rows[0].code,
      records,
      index,
      leaves: evaluateAll(records, index)
    };
  }

  aggregate(bundle: CaliberBundle, query: AggregateQuery = {}): AggregateRow[] {
    return aggregate(bundle.leaves, query);
  }

  grandTotal(bundle: CaliberBundle, query: AggregateQuery = {}) {
    return grandTotal(bundle.leaves, query);
  }

  /** Load a caliber bundle through the service's own pool. */
  loadCaliber(caliber: Caliber): Promise<CaliberBundle> {
    return this.loadBundle(this.db, caliber);
  }
}

@Module({
  imports: [DbModule, ActivityDataModule, FactorLibraryModule, GwpModule],
  providers: [AccountingService],
  exports: [AccountingService]
})
export class AccountingModule {}
