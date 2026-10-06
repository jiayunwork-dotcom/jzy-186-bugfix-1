import { Body, Controller, Module, Post, Get, Param } from '@nestjs/common';
import {
  ActivityDataModule,
  ActivityDataService,
  type BulkImportInput
} from '../activity-data/activity-data.service';
import { NotFoundError } from '../common/errors';

@Controller('activity-records')
export class ActivityController {
  constructor(private readonly activity: ActivityDataService) {}

  /**
   * Batch import. Every record is reported individually; one bad record never
   * rejects the batch. Re-submitting an identical recordNo is reported as
   * "duplicate" and never double-counted.
   */
  @Post('import')
  import(@Body() body: BulkImportInput) {
    return this.activity.bulkImport(body);
  }

  /** Correct one record: inserts a new numbered record pointing at the old. */
  @Post('correct')
  correct(
    @Body()
    body: {
      recordNo: string;
      siteCode: string;
      sourceCode: string;
      month: string;
      fuelKey: string;
      scope: 1 | 2;
      quantity: number | string;
      unit: string;
      supersedesRecordNo: string;
      validateAgainstFactorVersion?: string | number;
    }
  ) {
    const { validateAgainstFactorVersion, ...correction } = body;
    return this.activity.correct(correction, validateAgainstFactorVersion);
  }

  @Get(':recordNo')
  async get(@Param('recordNo') recordNo: string) {
    const rec = await this.activity.getRecord(recordNo);
    if (!rec) {
      throw new NotFoundError(`record not found: ${recordNo}`);
    }
    return {
      recordNo: rec.recordNo,
      siteCode: rec.siteCode,
      sourceCode: rec.sourceCode,
      month: rec.month,
      fuelKey: rec.fuelKey,
      scope: rec.scope,
      quantity: rec.quantity,
      unit: rec.unit,
      isCorrection: rec.isCorrection,
      supersedesRecordNo: rec.supersedesRecordNo,
      createdAt: rec.createdAt
    };
  }

  /** Register / resolve an activity-data cut-off point. */
  @Post('cuts')
  createCut(@Body() body: { asOf?: string; label?: string }) {
    return body.asOf ? this.activity.createCut(body.asOf, body.label) : this.activity.createCutNow(body.label);
  }

  @Get('cuts/:id')
  getCut(@Param('id') id: string) {
    return this.activity.getCut(parseInt(id, 10));
  }
}

@Module({
  imports: [ActivityDataModule],
  controllers: [ActivityController]
})
export class ActivityApiModule {}
