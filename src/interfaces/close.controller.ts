import { Body, Controller, Module, Post, Get, Param, Query } from '@nestjs/common';
import { CloseModule, CloseService, type CloseMonthInput, type SnapshotQuery } from '../close/close.service';
import { LineageModule, LineageService, type LineageRequest } from '../lineage/lineage.service';
import { fracDto } from '../common/serialize';

@Controller('closes')
export class CloseController {
  constructor(private readonly close: CloseService) {}

  /** Explicit monthly close: locks cut + factor version + GWP into a snapshot. */
  @Post()
  closeMonth(@Body() body: CloseMonthInput) {
    return this.close.closeMonth(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.close.getClose(parseInt(id, 10));
  }

  @Get(':id/snapshot')
  async snapshot(
    @Param('id') id: string,
    @Query('siteCode') siteCode?: string,
    @Query('sourceCode') sourceCode?: string,
    @Query('scope') scope?: string
  ) {
    const q: SnapshotQuery = {
      closeId: parseInt(id, 10),
      siteCode: siteCode ?? undefined,
      sourceCode: sourceCode ?? undefined,
      scope: scope ? (parseInt(scope, 10) as 1 | 2) : undefined
    };
    const rows = await this.close.querySnapshot(q);
    return {
      closeId: q.closeId,
      rows: rows.map((r) => ({ ...r, value: fracDto(r.value) }))
    };
  }

  @Get(':id/lineage')
  async lineage(
    @Param('id') id: string,
    @Query('siteCode') siteCode?: string,
    @Query('sourceCode') sourceCode?: string,
    @Query('scope') scope?: string
  ) {
    const q: SnapshotQuery = {
      closeId: parseInt(id, 10),
      siteCode: siteCode ?? undefined,
      sourceCode: sourceCode ?? undefined,
      scope: scope ? (parseInt(scope, 10) as 1 | 2) : undefined
    };
    const rows = await this.close.querySnapshotLineage(q);
    return {
      closeId: q.closeId,
      rows: rows.map((r) => ({
        ...r,
        activityQty: fracDto(r.activityQty),
        gasTonnes: fracDto(r.gasTonnes)
      }))
    };
  }
}

@Controller('lineage')
export class LineageController {
  constructor(private readonly lineage: LineageService) {}

  /** Explain an on-demand aggregate number by caliber + filter. */
  @Post('explain')
  async explain(@Body() body: LineageRequest) {
    const report = await this.lineage.explain(body);
    return {
      caliber: report.caliber,
      contributions: report.contributions.map((c) => ({
        ...c,
        inputQuantity: { value: fracDto(c.inputQuantity.value), unit: c.inputQuantity.unit },
        perGas: c.perGas.map((g) => ({
          ...g,
          factorValue: fracDto(g.factorValue),
          activityQty: fracDto(g.activityQty),
          gasTonnes: fracDto(g.gasTonnes),
          gwp: fracDto(g.gwp),
          co2eTonnes: fracDto(g.co2eTonnes)
        }))
      }))
    };
  }
}

@Module({
  imports: [CloseModule, LineageModule],
  controllers: [CloseController, LineageController]
})
export class CloseApiModule {}
