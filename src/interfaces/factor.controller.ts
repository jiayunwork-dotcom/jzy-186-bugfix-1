import { Body, Controller, Module, Post, Get } from '@nestjs/common';
import {
  FactorLibraryModule,
  FactorLibraryService,
  type PublishFactorVersionInput
} from '../factor-library/factor-library.service';
import { GwpModule, GwpService, type PublishGwpSetInput } from '../factor-library/gwp.service';
import { MasterDataModule, MasterDataService } from '../master-data/master-data.service';

@Controller('factor-versions')
export class FactorController {
  constructor(private readonly factors: FactorLibraryService) {}

  /** Publish an immutable factor-library version (fuels, factors, periods). */
  @Post()
  publish(@Body() body: PublishFactorVersionInput) {
    return this.factors.publishVersion(body);
  }

  @Get()
  list() {
    return this.factors.listVersions();
  }
}

@Controller('gwp-sets')
export class GwpController {
  constructor(private readonly gwp: GwpService) {}

  @Post()
  publish(@Body() body: PublishGwpSetInput) {
    return this.gwp.publishSet(body).then((id) => ({ id }));
  }

  @Get()
  list() {
    return this.gwp.listSets();
  }
}

@Controller('master-data')
export class MasterDataController {
  constructor(private readonly master: MasterDataService) {}

  @Post('sites')
  upsertSite(@Body() body: { code: string; name: string }) {
    return this.master.upsertSite(body).then(() => ({ ok: true }));
  }

  @Post('sources')
  upsertSource(
    @Body()
    body: {
      siteCode: string;
      code: string;
      name: string;
      fuelKey: string;
      scope: 1 | 2;
    }
  ) {
    return this.master.upsertSource(body).then(() => ({ ok: true }));
  }
}

@Module({
  imports: [FactorLibraryModule, GwpModule, MasterDataModule],
  controllers: [FactorController, GwpController, MasterDataController]
})
export class FactorApiModule {}
