import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService } from '../database/database.module';
import { Fraction } from '../common/fraction';
import { AccountingModule, AccountingService } from '../accounting/accounting.service';
import {
  decomposeTotals,
  type Corners,
  type MetricDecomposition
} from './decomposition';
import type { AggregateQuery, GasTotals } from '../accounting/engine';
import { ValidationException } from '../common/errors';

export interface RestatementComparisonInput {
  base: { cutId: number; factorVersionId: number; gwpSetId: number };
  current: { cutId: number; factorVersionId: number; gwpSetId: number };
  /** Aggregation filter the difference is evaluated at (any rollup level). */
  filter?: AggregateQuery;
  /** Base year (YYYY) when this comparison is used for the significance check. */
  baseYear?: number;
  significanceThreshold?: number | string;
}

export interface RestatementResult {
  baseCaliber: RestatementComparisonInput['base'];
  currentCaliber: RestatementComparisonInput['current'];
  baseTotals: GasTotals;
  currentTotals: GasTotals;
  components: MetricDecomposition[];
  corners: Corners<GasTotals>;
  /** Present when baseYear was supplied. */
  significance?: {
    baseYear: number;
    oldTotal: Fraction;
    newTotal: Fraction;
    changeRatio: Fraction;
    threshold: Fraction;
    triggered: boolean;
    note: string;
    noteId?: number;
  };
}

@Injectable()
export class RestatementService {
  constructor(
    private readonly db: DbService,
    private readonly accounting: AccountingService
  ) {}

  /**
   * Load the 8 corners (2A x 2F x 2G) bracketing the two calibers and return
   * the Shapley decomposition. The eight bundles are independent and loaded
   * serially in fixed order: deterministic record/factor resolution plus
   * exact rationals make this reproducible, and it is still only eight
   * filtered scans.
   */
  async compare(input: RestatementComparisonInput): Promise<RestatementResult> {
    const filter = input.filter ?? {};

    const [bA, bF, bG] = [input.base.cutId, input.base.factorVersionId, input.base.gwpSetId];
    const [cA, cF, cG] = [input.current.cutId, input.current.factorVersionId, input.current.gwpSetId];

    const cornersDef: Array<{ key: keyof Corners<unknown>; a: number; f: number; g: number }> = [
      { key: 'f000', a: bA, f: bF, g: bG },
      { key: 'f001', a: bA, f: bF, g: cG },
      { key: 'f010', a: bA, f: cF, g: bG },
      { key: 'f011', a: bA, f: cF, g: cG },
      { key: 'f100', a: cA, f: bF, g: bG },
      { key: 'f101', a: cA, f: bF, g: cG },
      { key: 'f110', a: cA, f: cF, g: bG },
      { key: 'f111', a: cA, f: cF, g: cG }
    ];

    const out = {} as Corners<GasTotals>;
    for (const d of cornersDef) {
      const bundle = await this.accounting.loadBundle(this.db, {
        cutId: d.a,
        factorVersionId: d.f,
        gwpSetId: d.g
      });
      out[d.key] = this.accounting.grandTotal(bundle, filter);
    }

    const result: RestatementResult = {
      baseCaliber: input.base,
      currentCaliber: input.current,
      baseTotals: out.f000,
      currentTotals: out.f111,
      components: decomposeFromCorners(out),
      corners: out
    };

    if (input.baseYear !== undefined) {
      result.significance = await this.checkBaseYear(input, out.f000.CO2E, out.f111.CO2E);
    }
    return result;
  }

  /**
   * Base-year rule: if |new-old| / |old| > threshold (default 5%), mark the
   * base year as needing recalculation and always leave an explanatory note.
   */
  private async checkBaseYear(
    input: RestatementComparisonInput,
    oldTotal: Fraction,
    newTotal: Fraction
  ): Promise<NonNullable<RestatementResult['significance']>> {
    const threshold = Fraction.from(input.significanceThreshold ?? 0.05);
    if (oldTotal.sign() === 0) {
      throw new ValidationException([
        { field: 'baseYear', code: 'INVALID_VALUE', message: 'base year total is zero; cannot compute change ratio' }
      ]);
    }
    const change = newTotal.sub(oldTotal).abs();
    const ratio = change.div(oldTotal.abs());
    const triggered = ratio.compare(threshold) > 0;
    const note = triggered
      ? `Base year ${input.baseYear} recalculation required: CO2e changed by ${ratio.toDecimalString(6)} (> threshold ${threshold.toDecimalString(4)}).`
      : `Base year ${input.baseYear} unchanged within significance threshold: |change|/base = ${ratio.toDecimalString(6)} <= ${threshold.toDecimalString(4)}.`;

    return this.db.withTransaction(async (client) => {
      const noteRes = await client.query<{ id: number }>(
        `INSERT INTO restatement_notes
           (base_year, caliber_a, caliber_b,
            old_total_num, old_total_den, new_total_num, new_total_den,
            change_ratio_num, change_ratio_den,
            threshold_num, threshold_den, triggered, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          input.baseYear,
          JSON.stringify(input.base),
          JSON.stringify(input.current),
          oldTotal.num,
          oldTotal.den,
          newTotal.num,
          newTotal.den,
          ratio.num,
          ratio.den,
          threshold.num,
          threshold.den,
          triggered,
          note
        ]
      );
      if (triggered) {
        await client.query(
          `INSERT INTO base_year_flags(base_year, needs_recalc, reason)
           VALUES ($1, true, $2)
           ON CONFLICT (base_year) DO UPDATE
             SET needs_recalc = true, marked_at = now(), reason = EXCLUDED.reason`,
          [input.baseYear, note]
        );
      }
      return {
        baseYear: input.baseYear!,
        oldTotal,
        newTotal,
        changeRatio: ratio,
        threshold,
        triggered,
        note,
        noteId: noteRes.rows[0].id
      };
    });
  }

  async getBaseYearFlag(baseYear: number): Promise<{ baseYear: number; needsRecalc: boolean } | null> {
    const res = await this.db.query<{ base_year: number; needs_recalc: boolean }>(
      'SELECT base_year, needs_recalc FROM base_year_flags WHERE base_year = $1',
      [baseYear]
    );
    return res.rows[0] ? { baseYear: res.rows[0].base_year, needsRecalc: res.rows[0].needs_recalc } : null;
  }

  async listNotes(baseYear?: number) {
    const res = await this.db.query(
      baseYear !== undefined
        ? 'SELECT * FROM restatement_notes WHERE base_year = $1 ORDER BY id'
        : 'SELECT * FROM restatement_notes ORDER BY id',
      baseYear !== undefined ? [baseYear] : []
    );
    return res.rows;
  }
}

function decomposeFromCorners(c: Corners<GasTotals>): MetricDecomposition[] {
  const { components } = decomposeTotals(
    (a: 0 | 1, f: 0 | 1, g: 0 | 1) => c[`f${a}${f}${g}` as keyof Corners<GasTotals>],
    {}
  );
  return components;
}

@Module({
  imports: [DbModule, AccountingModule],
  providers: [RestatementService],
  exports: [RestatementService]
})
export class RestatementModule {}
