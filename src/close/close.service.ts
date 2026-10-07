import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService } from '../database/database.module';
import { Fraction } from '../common/fraction';
import {
  AccountingModule,
  AccountingService
} from '../accounting/accounting.service';
import { ACTIVITY_VISIBILITY_LOCK_KEY } from '../activity-data/activity-data.service';
import { GwpModule, GwpService } from '../factor-library/gwp.service';
import { GASES, type Gas } from '../factor-library/factor-library.service';
import { flattenLeaves } from '../accounting/engine';
import {
  ConflictError,
  NotFoundError,
  ValidationException
} from '../common/errors';

export interface CloseMonthInput {
  month: string; // YYYY-MM
  factorVersionId: number;
  gwpSetId: number;
  /** Close a single site; omit for the company-wide disclosure close. */
  siteCode?: string;
  /**
   * Activity cut to lock. If omitted, the close captures its own cut at the
   * instant it starts (clock_timestamp inside the repeatable-read txn).
   */
  cutId?: number;
}

export interface SnapshotQuery {
  closeId: number;
  siteCode?: string;
  sourceCode?: string;
  scope?: 1 | 2;
}

@Injectable()
export class CloseService {
  constructor(
    private readonly db: DbService,
    private readonly accounting: AccountingService,
    private readonly gwp: GwpService
  ) {}

  /**
   * Monthly close — the explicit disclosure operation.
   *
   * Isolation guarantees ("关账进行中若有人提交导入/更正/补录，快照只认关账
   * 开始那一刻已提交的数据"，且快照永远等于按锁定口径重算):
   *  0. The FIRST statement of the close transaction takes the activity
   *     visibility advisory lock in EXCLUSIVE mode
   *     (ACTIVITY_VISIBILITY_LOCK_KEY). This both:
   *       (a) drains every import/correction transaction already in flight
   *           (they hold the same lock shared) — only once they COMMIT does
   *           the statement return, so everything read afterwards includes
   *           exactly what was committed up to that point; and
   *       (b) blocks new writers until COMMIT, so no transaction can commit a
   *           row with created_at <= as_of AFTER the snapshot was written —
   *           the set the snapshot stored is the very same set every future
   *           recomputation against the locked cut derives.
   *     The exclusive lock is held for the whole close (typically tens of
   *     milliseconds here); imports queue rather than interleave.
   *  1. An auto cut is created INSIDE that transaction with clock_timestamp()
   *     only after the drain, so its as_of is later than every drained row's
   *     created_at and earlier than every row a queued writer can stamp (its
   *     timestamp is captured while blocked on the shared lock it only gets
   *     at release). A caller-supplied cut (e.g. a manual historical
   *     timestamp) keeps its as_of verbatim; the drain still closes the
   *     in-flight gap for it.
   *  2. The three caliber references are *immutable objects*: a factor
   *     version id always points at the same rows and the activity cut is a
   *     fixed timestamp. A concurrent publish creates a *new* version id and
   *     cannot alter the one the close holds.
   *  3. A per-grain advisory lock makes concurrent closes of the same month
   *     deterministic: the second sees the first's committed row and fails
   *     with ALREADY_CLOSED. Every close acquires visibility-before-grain, a
   *     single global order, so the two locks cannot deadlock.
   *
   * The transaction is READ COMMITTED, not REPEATABLE READ: an RR snapshot
   * is taken at the START of the first statement, i.e. while it is still
   * WAITING for the exclusive lock — before the drained rows commit. That
   * snapshot would exclude the very rows the drain waits for even though the
   * cut (stamped after) includes them, recreating the snapshot/recompute
   * mismatch. RC is safe here precisely because points 0-3 freeze the data:
   * writers are blocked for the whole close, activity membership is the
   * explicit created_at <= as_of predicate, and factors/GWP/master data are
   * append-only objects referenced by fixed id. All per-statement RC
   * snapshots inside one close therefore see one identical state.
   */
  async closeMonth(input: CloseMonthInput): Promise<{ closeId: number; cutId: number }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
      throw new ValidationException([
        { field: 'month', code: 'BAD_MONTH', message: 'month must be YYYY-MM' }
      ]);
    }
    const monthDate = new Date(`${input.month}-01T00:00:00Z`);
    const isCompanyWide = !input.siteCode;

    // READ COMMITTED (not RR) + the exclusive visibility fence — see the
    // method doc for why RR would snapshot before the drain completes.
    return this.db.withTransaction(async (client) => {
      // FIRST statement: drain + fence activity writers for the whole close.
      await client.query('SELECT pg_advisory_xact_lock($1)', [ACTIVITY_VISIBILITY_LOCK_KEY]);

      // Grain lock key: company-wide closes share one key per month,
      // site closes a separate namespaced key.
      const lockKey = isCompanyWide
        ? hashLockKey(`close:company:${input.month}`)
        : hashLockKey(`close:site:${input.siteCode}:${input.month}`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      const dup = await client.query<{ id: number }>(
        `SELECT id FROM close_periods
         WHERE month = $1 AND is_company_wide = $2
           AND site_code IS NOT DISTINCT FROM $3 AND status = 'closed'`,
        [monthDate, isCompanyWide, input.siteCode ?? null]
      );
      if (dup.rows[0]) {
        throw new ConflictError('month', `${input.month} is already closed (close id ${dup.rows[0].id})`);
      }

      // Auto cut: stamp now that the drain has happened and writers are
      // fenced. A caller-supplied cut is validated and otherwise untouched
      // (manual historical cuts keep their meaning).
      let cutId = input.cutId;
      if (cutId === undefined) {
        const r = await client.query<{ id: number }>(
          `INSERT INTO activity_cuts(label, as_of)
           VALUES ($1, clock_timestamp()) RETURNING id, as_of`,
          [`close ${input.month}${input.siteCode ? ` ${input.siteCode}` : ''}`]
        );
        cutId = r.rows[0].id;
      } else {
        const cutCheck = await client.query<{ id: number }>(
          'SELECT id FROM activity_cuts WHERE id = $1',
          [cutId]
        );
        if (!cutCheck.rows[0]) throw new NotFoundError(`activity cut ${cutId} not found`);
      }
      const fv = await client.query<{ id: number }>('SELECT id FROM factor_versions WHERE id = $1', [
        input.factorVersionId
      ]);
      if (!fv.rows[0]) throw new NotFoundError(`factor version ${input.factorVersionId} not found`);
      const gwpId = await this.gwp.resolveSetId(client, input.gwpSetId);

      const cp = await client.query<{ id: number }>(
        `INSERT INTO close_periods(month, is_company_wide, site_code, cut_id,
                                   factor_version_id, gwp_set_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING id`,
        [monthDate, isCompanyWide, input.siteCode ?? null, cutId, input.factorVersionId, gwpId]
      );
      const closeId = cp.rows[0].id;

      // Compute the disclosure numbers from the immutable caliber. The month
      // (and optional site) filter defines the snapshot grain.
      const bundle = await this.accounting.loadBundle(client, {
        cutId,
        factorVersionId: input.factorVersionId,
        gwpSetId: gwpId
      });
      const leaves = bundle.leaves.filter(
        (l) => l.month === input.month && (!input.siteCode || l.siteCode === input.siteCode)
      );

      // 1) aggregate rows: one row per (site, source, month, scope, gas) plus CO2E
      type AggKey = string;
      const agg = new Map<
        AggKey,
        {
          siteCode: string;
          sourceCode: string;
          scope: 1 | 2;
          values: { CO2: Fraction; CH4: Fraction; N2O: Fraction; CO2E: Fraction };
        }
      >();
      for (const leaf of leaves) {
        const key = JSON.stringify([leaf.siteCode, leaf.sourceCode, leaf.scope]);
        let row = agg.get(key);
        if (!row) {
          row = {
            siteCode: leaf.siteCode,
            sourceCode: leaf.sourceCode,
            scope: leaf.scope,
            values: { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO, CO2E: Fraction.ZERO }
          };
          agg.set(key, row);
        }
        for (const gas of GASES) {
          row.values[gas] = row.values[gas].add(leaf.byGas[gas].gasTonnes);
          row.values.CO2E = row.values.CO2E.add(leaf.byGas[gas].co2eTonnes);
        }
      }
      for (const row of [...agg.values()].sort((a, b) =>
        `${a.siteCode}|${a.sourceCode}|${a.scope}`.localeCompare(
          `${b.siteCode}|${b.sourceCode}|${b.scope}`
        )
      )) {
        for (const gas of ['CO2', 'CH4', 'N2O', 'CO2E'] as const) {
          const v = row.values[gas];
          await client.query(
            `INSERT INTO snapshot_rows
               (close_id, site_code, source_code, month, scope, gas, value_num, value_den)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [closeId, row.siteCode, row.sourceCode, monthDate, row.scope, gas, v.num, v.den]
          );
        }
      }

      // 2) lineage: one row per (record, gas) with the exact factor and the
      //    quantity expressed in the factor unit.
      const flat = flattenLeaves(leaves);
      for (const item of flat) {
        await client.query(
          `INSERT INTO snapshot_lineage
             (close_id, site_code, source_code, month, scope, gas, record_no,
              factor_id, activity_qty_num, activity_qty_den,
              gas_mass_num, gas_mass_den)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            closeId,
            item.siteCode,
            item.sourceCode,
            monthDate,
            item.scope,
            item.gas,
            item.recordNo,
            item.factorId,
            item.activityQty.num,
            item.activityQty.den,
            item.gasTonnes.num,
            item.gasTonnes.den
          ]
        );
      }

      await client.query(
        `UPDATE close_periods SET status = 'closed', closed_at = now() WHERE id = $1`,
        [closeId]
      );
      return { closeId, cutId };
    });
  }

  async getClose(closeId: number) {
    const res = await this.db.query(
      `SELECT cp.id, cp.month, cp.is_company_wide, cp.site_code, cp.status,
              cp.cut_id, cp.factor_version_id, cp.gwp_set_id,
              cp.started_at, cp.closed_at,
              fv.version AS factor_version, gs.code AS gwp_set, ac.as_of AS cut_as_of
       FROM close_periods cp
       JOIN factor_versions fv ON fv.id = cp.factor_version_id
       JOIN gwp_sets gs ON gs.id = cp.gwp_set_id
       JOIN activity_cuts ac ON ac.id = cp.cut_id
       WHERE cp.id = $1`,
      [closeId]
    );
    if (!res.rows[0]) throw new NotFoundError(`close ${closeId} not found`);
    return res.rows[0];
  }

  /** Materialized snapshot rows (never recomputed; this is disclosure data). */
  async querySnapshot(query: SnapshotQuery) {
    const res = await this.db.query(
      `SELECT site_code, source_code, month, scope, gas, value_num, value_den
       FROM snapshot_rows
       WHERE close_id = $1
         AND ($2::text IS NULL OR site_code = $2)
         AND ($3::text IS NULL OR source_code = $3)
         AND ($4::smallint IS NULL OR scope = $4)
       ORDER BY site_code, source_code, month, scope, gas`,
      [query.closeId, query.siteCode ?? null, query.sourceCode ?? null, query.scope ?? null]
    );
    return res.rows.map((r) => ({
      siteCode: r.site_code,
      sourceCode: r.source_code,
      month: (r.month as Date).toISOString().slice(0, 7),
      scope: r.scope,
      gas: r.gas,
      value: Fraction.of(BigInt(r.value_num), BigInt(r.value_den))
    }));
  }

  /** Lineage rows stored for a snapshot. */
  async querySnapshotLineage(query: SnapshotQuery) {
    const res = await this.db.query(
      `SELECT site_code, source_code, month, scope, gas, record_no, factor_id,
              activity_qty_num, activity_qty_den, gas_mass_num, gas_mass_den
       FROM snapshot_lineage
       WHERE close_id = $1
         AND ($2::text IS NULL OR site_code = $2)
         AND ($3::text IS NULL OR source_code = $3)
         AND ($4::smallint IS NULL OR scope = $4)
       ORDER BY site_code, source_code, record_no, gas`,
      [query.closeId, query.siteCode ?? null, query.sourceCode ?? null, query.scope ?? null]
    );
    return res.rows.map((r) => ({
      siteCode: r.site_code,
      sourceCode: r.source_code,
      month: (r.month as Date).toISOString().slice(0, 7),
      scope: r.scope,
      gas: r.gas as Gas,
      recordNo: r.record_no,
      factorId: r.factor_id,
      activityQty: Fraction.of(BigInt(r.activity_qty_num), BigInt(r.activity_qty_den)),
      gasTonnes: Fraction.of(BigInt(r.gas_mass_num), BigInt(r.gas_mass_den))
    }));
  }
}

/** Stable 64-bit hash for advisory-lock keys (xxhash-style FNV-1a 64). */
function hashLockKey(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  // pg_advisory_xact_lock takes signed bigint; map to signed range.
  if (h > 0x7fffffffffffffffn) h -= 0x10000000000000000n;
  return h;
}

@Module({
  imports: [DbModule, AccountingModule, GwpModule],
  providers: [CloseService],
  exports: [CloseService]
})
export class CloseModule {}
