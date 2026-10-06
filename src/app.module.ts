import { Module } from '@nestjs/common';
import { DbModule } from './database/database.module';
import { ActivityApiModule } from './interfaces/activity.controller';
import { FactorApiModule } from './interfaces/factor.controller';
import { SummaryApiModule } from './interfaces/summary.controller';
import { RestatementApiModule } from './interfaces/restatement.controller';
import { CloseApiModule } from './interfaces/close.controller';

@Module({
  imports: [
    DbModule,
    ActivityApiModule,
    FactorApiModule,
    SummaryApiModule,
    RestatementApiModule,
    CloseApiModule
  ]
})
export class AppModule {}
