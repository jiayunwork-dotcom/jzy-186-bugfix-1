import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService } from '../database/database.module';
import {
  AccountingModule,
  AccountingService,
  type CaliberBundle
} from '../accounting/accounting.service';
import { GASES, type Gas } from '../factor-library/factor-library.service';
import { Fraction } from '../common/fraction';
import type { AggregateQuery } from '../accounting/engine';

export interface LineageRequest {
  cutId: number;
  factorVersionId: number;
  gwpSetId: number;
  filter?: AggregateQuery;
}

export interface LineageContribution {
  siteCode: string;
  sourceCode: string;
  month: string;
  scope: 1 | 2;
  recordNo: string;
  fuelKey: string;
  inputQuantity: { value: Fraction; unit: string };
  perGas: Array<{
    gas: Gas;
    factorId: number;
    factorValue: Fraction;
    factorUnit: string;
    factorValidFrom: string;
    factorValidTo: string;
    /** quantity converted to the factor unit */
    activityQty: Fraction;
    activityUnit: string;
    gasTonnes: Fraction;
    gwp: Fraction;
    co2eTonnes: Fraction;
  }>;
}

export interface LineageReport {
  caliber: {
    cutId: number;
    cutMode: 'timestamp' | 'committed';
    cutAsOf: Date | null;
    factorVersionId: number;
    factorVersion: string;
    gwpSetId: number;
    gwpSetCode: string;
  };
  contributions: LineageContribution[];
}

@Injectable()
export class LineageService {
  constructor(
    private readonly db: DbService,
    private readonly accounting: AccountingService
  ) {}

  /**
   * "这条汇总数字由哪些原始记录和哪些因子得出" — reconstruct a total for a
   * caliber+filter and return every leaf contribution with the exact record,
   * the exact factor row (value, unit, applicability period), the converted
   * quantity and the GWP applied. Because it recomputes from the immutable
   * caliber objects, the answer for one caliber never changes and always
   * reconciles with the aggregate endpoint.
   */
  async explain(request: LineageRequest): Promise<LineageReport> {
    const q = request.filter ?? {};
    const bundle: CaliberBundle = await this.accounting.loadBundle(this.db, {
      cutId: request.cutId,
      factorVersionId: request.factorVersionId,
      gwpSetId: request.gwpSetId
    });

    const matches = bundle.leaves.filter((l) => {
      if (q.siteCode && l.siteCode !== q.siteCode) return false;
      if (q.sourceCode && l.sourceCode !== q.sourceCode) return false;
      if (q.month && l.month !== q.month) return false;
      if (q.scope && l.scope !== q.scope) return false;
      return true;
    });

    const contributions: LineageContribution[] = matches.map((l) => ({
      siteCode: l.siteCode,
      sourceCode: l.sourceCode,
      month: l.month,
      scope: l.scope,
      recordNo: l.recordNo,
      fuelKey: l.fuelKey,
      inputQuantity: { value: l.quantity, unit: l.unit },
      perGas: GASES.map((gas) => {
        const g = l.byGas[gas];
        return {
          gas,
          factorId: g.factorId,
          factorValue: g.factor.value,
          factorUnit: g.factor.factorUnit,
          factorValidFrom: g.factor.validFrom,
          factorValidTo: g.factor.validTo,
          activityQty: g.activityQty,
          activityUnit: g.factor.activityUnit,
          gasTonnes: g.gasTonnes,
          gwp: bundle.index.gwp[gas],
          co2eTonnes: g.co2eTonnes
        };
      })
    }));

    contributions.sort((a, b) => a.recordNo.localeCompare(b.recordNo));

    return {
      caliber: {
        cutId: bundle.caliber.cutId,
        cutMode: bundle.cut.mode,
        cutAsOf: bundle.cut.asOf,
        factorVersionId: bundle.caliber.factorVersionId,
        factorVersion: bundle.factorVersion,
        gwpSetId: bundle.caliber.gwpSetId,
        gwpSetCode: bundle.gwpSetCode
      },
      contributions
    };
  }
}

@Module({
  imports: [DbModule, AccountingModule],
  providers: [LineageService],
  exports: [LineageService]
})
export class LineageModule {}
