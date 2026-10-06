import { Body, Controller, Module, Post } from '@nestjs/common';
import {
  AccountingModule,
  AccountingService
} from '../accounting/accounting.service';
import { totalsDto } from '../common/serialize';
import type { AggregateQuery, Caliber, DimensionKey } from '../accounting/engine';

interface SummaryRequest {
  caliber: Caliber;
  groupBy?: DimensionKey[];
  filter?: Omit<AggregateQuery, 'groupBy'>;
}

@Controller('accounting')
export class SummaryController {
  constructor(private readonly accounting: AccountingService) {}

  /**
   * On-demand summary by caliber. The same caliber always returns identical
   * values: it is recomputed from immutable cut/version/GWP objects with exact
   * rationals in fixed summation order.
   */
  @Post('summary')
  async summary(@Body() body: SummaryRequest) {
    const bundle = await this.accounting.loadCaliber(body.caliber);
    const query: AggregateQuery = { ...(body.filter ?? {}), groupBy: body.groupBy ?? ['site', 'source', 'month'] };
    const rows = this.accounting.aggregate(bundle, query);
    return {
      caliber: {
        ...body.caliber,
        cutAsOf: bundle.asOf,
        factorVersion: bundle.factorVersion,
        gwpSetCode: bundle.gwpSetCode
      },
      rows: rows.map((r) => ({
        siteCode: r.siteCode,
        sourceCode: r.sourceCode,
        month: r.month,
        scope: r.scope,
        totals: totalsDto(r.totals)
      })),
      grandTotal: totalsDto(this.accounting.grandTotal(bundle, body.filter ?? {}))
    };
  }
}

@Module({
  imports: [AccountingModule],
  controllers: [SummaryController]
})
export class SummaryApiModule {}
