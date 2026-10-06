import { Body, Controller, Module, Post, Get, Param, Query } from '@nestjs/common';
import {
  RestatementModule,
  RestatementService,
  type RestatementComparisonInput
} from '../restatement/restatement.service';
import { fracDto } from '../common/serialize';

@Controller('restatements')
export class RestatementController {
  constructor(private readonly restatements: RestatementService) {}

  /**
   * Compare two calibers at any rollup level and return the exact three-part
   * (activity / factors / GWP) Shapley decomposition. component sums equal the
   * total bit-for-bit.
   */
  @Post('compare')
  async compare(@Body() body: RestatementComparisonInput) {
    const r = await this.restatements.compare(body);
    return {
      baseCaliber: r.baseCaliber,
      currentCaliber: r.currentCaliber,
      baseTotals: {
        co2Tonnes: fracDto(r.baseTotals.CO2),
        ch4Tonnes: fracDto(r.baseTotals.CH4),
        n2oTonnes: fracDto(r.baseTotals.N2O),
        co2eTonnes: fracDto(r.baseTotals.CO2E)
      },
      currentTotals: {
        co2Tonnes: fracDto(r.currentTotals.CO2),
        ch4Tonnes: fracDto(r.currentTotals.CH4),
        n2oTonnes: fracDto(r.currentTotals.N2O),
        co2eTonnes: fracDto(r.currentTotals.CO2E)
      },
      components: r.components.map((c) => ({
        metric: c.metric,
        total: fracDto(c.total),
        activity: fracDto(c.activity),
        factors: fracDto(c.factors),
        gwp: fracDto(c.gwp)
      })),
      significance: r.significance
        ? {
            baseYear: r.significance.baseYear,
            oldTotal: fracDto(r.significance.oldTotal),
            newTotal: fracDto(r.significance.newTotal),
            changeRatio: fracDto(r.significance.changeRatio),
            threshold: fracDto(r.significance.threshold),
            triggered: r.significance.triggered,
            note: r.significance.note,
            noteId: r.significance.noteId
          }
        : undefined
    };
  }

  @Get('base-year-flags/:year')
  getFlag(@Param('year') year: string) {
    return this.restatements.getBaseYearFlag(parseInt(year, 10));
  }

  @Get('notes')
  listNotes(@Query('baseYear') baseYear?: string) {
    return this.restatements.listNotes(baseYear ? parseInt(baseYear, 10) : undefined);
  }
}

@Module({
  imports: [RestatementModule],
  controllers: [RestatementController]
})
export class RestatementApiModule {}
