import { Injectable, Module } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { Fraction } from '../common/fraction';
import { ConflictError, FieldError, NotFoundError, ValidationException } from '../common/errors';
import { isKnownUnit, convert, type FuelProps } from '../units/units.service';
import { MasterDataModule, MasterDataService } from '../master-data/master-data.service';
import {
  FactorLibraryModule,
  FactorLibraryService,
  type FactorRow,
  monthToDate
} from '../factor-library/factor-library.service';

export interface ActivityInput {
  recordNo: string;
  siteCode: string;
  sourceCode: string;
  /** YYYY-MM */
  month: string;
  fuelKey: string;
  scope: 1 | 2;
  quantity: number | string;
  unit: string;
  /** Present exactly when this record is a correction of another. */
  supersedesRecordNo?: string;
}

export interface CorrectionInput extends ActivityInput {
  supersedesRecordNo: string;
}

export interface ImportResultItem {
  recordNo: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  errors?: FieldError[];
}

export interface BulkImportInput {
  records: ActivityInput[];
  /**
   * If given, every record is additionally validated against this factor
   * version (unit convertibility, applicability period, scope). Import never
   * binds a record to a version: the same records remain usable by any later
   * factor version.
   */
  validateAgainstFactorVersion?: string | number;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

interface StoredRecord {
  record_no: string;
  site_code: string;
  source_code: string;
  month: Date;
  fuel_key: string;
  scope: number;
  quantity_num: string;
  quantity_den: string;
  unit: string;
  is_correction: boolean;
  supersedes_record_no: string | null;
  created_at: Date;
}

function monthToString(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export interface ActivityRecord extends Omit<ActivityInput, 'supersedesRecordNo'> {
  quantityFraction: Fraction;
  isCorrection: boolean;
  supersedesRecordNo: string | null;
  createdAt: Date;
}

function hydrate(r: StoredRecord): ActivityRecord {
  return {
    recordNo: r.record_no,
    siteCode: r.site_code,
    sourceCode: r.source_code,
    month: monthToString(r.month),
    fuelKey: r.fuel_key,
    scope: r.scope as 1 | 2,
    quantity: Fraction.of(BigInt(r.quantity_num), BigInt(r.quantity_den)).toDecimalString(12),
    quantityFraction: Fraction.of(BigInt(r.quantity_num), BigInt(r.quantity_den)),
    unit: r.unit,
    isCorrection: r.is_correction,
    supersedesRecordNo: r.supersedes_record_no,
    createdAt: r.created_at
  };
}

@Injectable()
export class ActivityDataService {
  constructor(
    private readonly db: DbService,
    private readonly masterData: MasterDataService,
    private readonly factors: FactorLibraryService
  ) {}

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  private async validateRecord(
    rec: ActivityInput,
    index: number,
    opts: {
      factorRows?: FactorRow[];
      factorDensity?: FuelProps;
      /** Resolved status of the correction target, checked server-side. */
      correctionTarget?: { exists: boolean; free: boolean };
    }
  ): Promise<{ valid: boolean; errors: FieldError[]; quantity?: Fraction }> {
    const p = `records[${index}]`;
    const errors: FieldError[] = [];

    if (!rec.recordNo) errors.push({ field: `${p}.recordNo`, code: 'MISSING_FIELD', message: 'recordNo required' });
    if (!rec.siteCode) errors.push({ field: `${p}.siteCode`, code: 'MISSING_FIELD', message: 'siteCode required' });
    if (!rec.sourceCode) errors.push({ field: `${p}.sourceCode`, code: 'MISSING_FIELD', message: 'sourceCode required' });

    let quantity: Fraction | undefined;
    if (rec.quantity === undefined || rec.quantity === null || (rec.quantity as unknown) === '') {
      errors.push({ field: `${p}.quantity`, code: 'MISSING_FIELD', message: 'quantity required' });
    } else {
      try {
        quantity = Fraction.from(rec.quantity);
        if (quantity.sign() < 0) {
          errors.push({ field: `${p}.quantity`, code: 'NEGATIVE_OR_NON_FINITE', message: 'quantity must not be negative' });
        }
      } catch {
        errors.push({
          field: `${p}.quantity`,
          code: 'NEGATIVE_OR_NON_FINITE',
          message: `quantity is not a finite number: ${String(rec.quantity)}`
        });
      }
    }

    if (!rec.unit) {
      errors.push({ field: `${p}.unit`, code: 'MISSING_FIELD', message: 'unit required' });
    } else if (!isKnownUnit(rec.unit)) {
      errors.push({ field: `${p}.unit`, code: 'UNKNOWN_UNIT', message: `unknown unit: ${rec.unit}` });
    }

    if (!MONTH_RE.test(rec.month ?? '')) {
      errors.push({ field: `${p}.month`, code: 'BAD_MONTH', message: 'month must be YYYY-MM' });
    }

    if (rec.scope !== 1 && rec.scope !== 2) {
      errors.push({ field: `${p}.scope`, code: 'INVALID_VALUE', message: 'scope must be 1 or 2' });
    }

    const source =
      rec.siteCode && rec.sourceCode
        ? await this.masterData.getSource(rec.siteCode, rec.sourceCode)
        : null;
    if (rec.siteCode && rec.sourceCode && !source) {
      errors.push({
        field: `${p}.sourceCode`,
        code: 'NOT_FOUND',
        message: `emission source ${rec.siteCode}/${rec.sourceCode} is not registered`
      });
    }
    if (source && rec.fuelKey && source.fuelKey !== rec.fuelKey) {
      errors.push({
        field: `${p}.fuelKey`,
        code: 'INVALID_VALUE',
        message: `source ${source.code} is registered as fuelKey ${source.fuelKey}, got ${rec.fuelKey}`
      });
    }
    if (source && rec.scope && source.scope !== rec.scope) {
      errors.push({
        field: `${p}.scope`,
        code: 'SCOPE_MISMATCH',
        message: `source is scope ${source.scope}, record declares scope ${rec.scope}`
      });
    }

    if (rec.supersedesRecordNo !== undefined && opts.correctionTarget) {
      const target = rec.supersedesRecordNo;
      if (!opts.correctionTarget.exists) {
        errors.push({
          field: `${p}.supersedesRecordNo`,
          code: 'CORRECTION_TARGET_MISSING',
          message: `correction target does not exist: ${target}`
        });
      } else if (!opts.correctionTarget.free) {
        errors.push({
          field: `${p}.supersedesRecordNo`,
          code: 'CORRECTION_TARGET_ALREADY_CORRECTED',
          message: `record ${target} has already been corrected`
        });
      }
    }

    if (opts.factorRows && MONTH_RE.test(rec.month ?? '')) {
      const rows = opts.factorRows.filter(
        (f) => f.fuelKey === rec.fuelKey && f.scope === rec.scope
      );
      const applicable = rows.filter((f) => f.validFrom <= rec.month && rec.month <= f.validTo);
      if (rows.length === 0) {
        errors.push({
          field: `${p}.fuelKey`,
          code: 'FACTOR_NOT_APPLICABLE',
          message: `factor version has no factor for ${rec.fuelKey}/scope${rec.scope}`
        });
      } else if (applicable.length === 0) {
        errors.push({
          field: `${p}.month`,
          code: 'MONTH_OUTSIDE_FACTOR_PERIOD',
          message: `month ${rec.month} is outside every factor applicability period for ${rec.fuelKey}/scope${rec.scope}`
        });
      } else if (quantity && isKnownUnit(rec.unit)) {
        for (const f of applicable) {
          try {
            convert(quantity, rec.unit, f.activityUnit, opts.factorDensity ?? undefined);
          } catch (e) {
            errors.push({
              field: `${p}.unit`,
              code: 'UNIT_NOT_CONVERTIBLE',
              message: `unit ${rec.unit} cannot be converted to factor unit ${f.factorUnit} for ${f.gas}: ${(e as Error).message}`
            });
            break;
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, quantity };
  }

  // --------------------------------------------------------------------------
  // Bulk import
  // --------------------------------------------------------------------------

  async bulkImport(input: BulkImportInput): Promise<ImportResultItem[]> {
    if (!Array.isArray(input.records)) {
      throw new ValidationException([{ field: 'records', code: 'MISSING_FIELD', message: 'records array required' }]);
    }
    const results: ImportResultItem[] = [];

    // Deterministic de-duplication within the batch: first occurrence wins,
    // later identical recordNos are reported individually.
    const firstIndex = new Map<string, number>();
    const batchDuplicate = new Set<number>();
    input.records.forEach((r, i) => {
      if (!r.recordNo) return;
      if (firstIndex.has(r.recordNo)) batchDuplicate.add(i);
      else firstIndex.set(r.recordNo, i);
    });

    await this.db.withTransaction(async (client) => {
      // Factor context for optional cross-validation. Density/NCV are
      // versioned per fuel; resolved per record from this map.
      let factorRows: FactorRow[] | undefined;
      let fuelProps: Map<string, { density: Fraction | null; ncv: Fraction | null }> | undefined;
      if (input.validateAgainstFactorVersion !== undefined) {
        const v = await this.factors.getVersion(input.validateAgainstFactorVersion);
        factorRows = await this.factors.getFactors(client, v.id);
        fuelProps = await this.factors.getFuelProperties(client, v.id);
      }

      // Existing record numbers in this batch.
      const nos = input.records.map((r) => r.recordNo).filter(Boolean);
      const existing = new Map<string, StoredRecord>();
      if (nos.length) {
        const res = await client.query<StoredRecord>(
          `SELECT record_no, site_code, source_code, month, fuel_key, scope,
                  quantity_num, quantity_den, unit, is_correction,
                  supersedes_record_no, created_at
           FROM activity_records WHERE record_no = ANY($1)`,
          [nos]
        );
        for (const row of res.rows) existing.set(row.record_no, row);
      }

      const correctionTargets = input.records
        .map((r) => r.supersedesRecordNo)
        .filter((x): x is string => !!x);
      const targetRows = correctionTargets.length
        ? await client.query<{ record_no: string }>(
            `SELECT record_no FROM activity_records WHERE record_no = ANY($1)`,
            [correctionTargets]
          )
        : null;
      const targetExists = new Set((targetRows?.rows ?? []).map((r) => r.record_no));
      const alreadyCorrected = new Set<string>();
      if (correctionTargets.length) {
        const used = await client.query<{ supersedes_record_no: string }>(
          `SELECT supersedes_record_no FROM activity_records
           WHERE supersedes_record_no = ANY($1)`,
          [correctionTargets]
        );
        used.rows.forEach((r) => alreadyCorrected.add(r.supersedes_record_no));
      }
      // Targets claimed earlier inside the same batch are also occupied.
      const claimedInBatch = new Set<string>();

      const accepted: Array<{ rec: ActivityInput; qty: Fraction }> = [];

      for (let i = 0; i < input.records.length; i++) {
        const rec = input.records[i];

        if (batchDuplicate.has(i)) {
          results[i] = {
            recordNo: rec.recordNo,
            status: 'duplicate',
            errors: [
              {
                field: `records[${i}].recordNo`,
                code: 'DUPLICATE_KEY',
                message: `recordNo ${rec.recordNo} already appeared earlier in this batch; ignored`,
                recordId: rec.recordNo
              }
            ]
          };
          continue;
        }

        const prior = rec.recordNo ? existing.get(rec.recordNo) : undefined;
        if (prior) {
          // Idempotent re-submission: identical payload => no-op success.
          const same =
            prior.site_code === rec.siteCode &&
            prior.source_code === rec.sourceCode &&
            prior.fuel_key === rec.fuelKey &&
            prior.scope === rec.scope &&
            prior.unit === rec.unit &&
            monthToString(prior.month) === rec.month &&
            prior.supersedes_record_no === (rec.supersedesRecordNo ?? null) &&
            Fraction.of(BigInt(prior.quantity_num), BigInt(prior.quantity_den)).compare(
              Fraction.from(rec.quantity)
            ) === 0;
          results[i] = same
            ? { recordNo: rec.recordNo, status: 'duplicate' }
            : {
                recordNo: rec.recordNo,
                status: 'rejected',
                errors: [
                  {
                    field: `records[${i}].recordNo`,
                    code: 'DUPLICATE_KEY',
                    message: `recordNo ${rec.recordNo} already exists with different content`,
                    recordId: rec.recordNo
                  }
                ]
              };
          continue;
        }

        const supersedes = rec.supersedesRecordNo;
        const correctionTarget = supersedes
          ? {
              exists: targetExists.has(supersedes),
              free:
                targetExists.has(supersedes) &&
                !alreadyCorrected.has(supersedes) &&
                !claimedInBatch.has(supersedes)
            }
          : undefined;

        const v = await this.validateRecord(rec, i, {
          factorRows,
          factorDensity: (() => {
            const p = rec.fuelKey ? fuelProps?.get(rec.fuelKey) : undefined;
            return p ? { density: p.density ?? undefined, ncvMass: p.ncv ?? undefined } : undefined;
          })(),
          correctionTarget
        });
        if (!v.valid || !v.quantity) {
          results[i] = { recordNo: rec.recordNo, status: 'rejected', errors: v.errors };
          continue;
        }
        if (supersedes) claimedInBatch.add(supersedes);
        accepted.push({ rec, qty: v.quantity });
        results[i] = { recordNo: rec.recordNo, status: 'accepted' };
      }

      for (const { rec, qty } of accepted) {
        await client.query(
          `INSERT INTO activity_records
             (record_no, site_code, source_code, month, fuel_key, scope,
              quantity_num, quantity_den, unit, is_correction, supersedes_record_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            rec.recordNo,
            rec.siteCode,
            rec.sourceCode,
            monthToDate(rec.month),
            rec.fuelKey,
            rec.scope,
            qty.num,
            qty.den,
            rec.unit,
            rec.supersedesRecordNo ? true : false,
            rec.supersedesRecordNo ?? null
          ]
        );
      }
    });

    return results;
  }

  // --------------------------------------------------------------------------
  // Single correction (concurrency-safe)
  // --------------------------------------------------------------------------

  async correct(
    input: CorrectionInput,
    validateAgainstFactorVersion?: string | number
  ): Promise<{ status: 'accepted' | 'duplicate'; recordNo: string }> {
    const res = await this.bulkImport({
      records: [input],
      validateAgainstFactorVersion
    });
    const item = res[0];
    if (item.status === 'rejected') {
      const conflict = item.errors?.find((e) => e.code === 'CORRECTION_TARGET_ALREADY_CORRECTED');
      if (conflict) throw new ConflictError('supersedesRecordNo', conflict.message, input.recordNo);
      throw new ValidationException(item.errors ?? []);
    }
    return { status: item.status, recordNo: item.recordNo };
  }

  /**
   * Concurrent correction guard intended for explicit racing calls: relies on
   * the partial unique index `activity_one_correction_per_record`. One of two
   * racing transactions commits; the other gets 23505 and we surface a 409.
   */
  async correctConcurrent(input: CorrectionInput): Promise<void> {
    try {
      const r = await this.correct(input);
      void r;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new ConflictError(
          'supersedesRecordNo',
          `record ${input.supersedesRecordNo} was corrected concurrently; only one correction is accepted`,
          input.recordNo
        );
      }
      throw e;
    }
  }

  async getRecord(recordNo: string): Promise<ActivityRecord | null> {
    const res = await this.db.query<StoredRecord>(
      `SELECT record_no, site_code, source_code, month, fuel_key, scope,
              quantity_num, quantity_den, unit, is_correction,
              supersedes_record_no, created_at
       FROM activity_records WHERE record_no = $1`,
      [recordNo]
    );
    return res.rows[0] ? hydrate(res.rows[0]) : null;
  }

  // --------------------------------------------------------------------------
  // Cut-off points
  // --------------------------------------------------------------------------

  async createCut(asOfIso: string, label?: string): Promise<{ id: number; asOf: Date }> {
    const asOf = new Date(asOfIso);
    if (Number.isNaN(asOf.getTime())) {
      throw new ValidationException([{ field: 'asOf', code: 'INVALID_VALUE', message: 'bad ISO timestamp' }]);
    }
    try {
      const res = await this.db.query<{ id: number; as_of: Date }>(
        'INSERT INTO activity_cuts(label, as_of) VALUES ($1, $2) RETURNING id, as_of',
        [label ?? null, asOf]
      );
      return { id: res.rows[0].id, asOf: res.rows[0].as_of };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        const res = await this.db.query<{ id: number; as_of: Date }>(
          'SELECT id, as_of FROM activity_cuts WHERE as_of = $1',
          [asOf]
        );
        return { id: res.rows[0].id, asOf: res.rows[0].as_of };
      }
      throw e;
    }
  }

  /** Convenience: a cut meaning "everything committed up to now". */
  async createCutNow(label?: string): Promise<{ id: number; asOf: Date }> {
    return this.db.withTransaction(async (client) => {
      const res = await client.query<{ id: number; as_of: Date }>(
        `INSERT INTO activity_cuts(label, as_of)
         VALUES ($1, clock_timestamp())
         RETURNING id, as_of`,
        [label ?? null]
      );
      return { id: res.rows[0].id, asOf: res.rows[0].as_of };
    });
  }

  async getCut(id: number): Promise<{ id: number; asOf: Date; label: string | null }> {
    return this.getCutOn(this.db, id);
  }

  async getCutOn(
    client: Queryer,
    id: number
  ): Promise<{ id: number; asOf: Date; label: string | null }> {
    const res = await client.query<{ id: number; as_of: Date; label: string | null }>(
      'SELECT id, as_of, label FROM activity_cuts WHERE id = $1',
      [id]
    );
    if (!res.rows[0]) throw new NotFoundError(`activity cut not found: ${id}`);
    return { id: res.rows[0].id, asOf: res.rows[0].as_of, label: res.rows[0].label };
  }

  /**
   * The effective record set at a cut: for every correction chain, the head
   * whose created_at <= as_of (NOT EXISTS a successor visible by the cut).
   * Records created after the cut are invisible even if they correct a visible
   * record — this is exactly what "活动数据截止点" means.
   */
  async getEffectiveRecords(client: Queryer, asOf: Date): Promise<ActivityRecord[]> {
    const res = await client.query<StoredRecord>(
      `SELECT r.record_no, r.site_code, r.source_code, r.month, r.fuel_key,
              r.scope, r.quantity_num, r.quantity_den, r.unit, r.is_correction,
              r.supersedes_record_no, r.created_at
       FROM activity_records r
       WHERE r.created_at <= $1
         AND NOT EXISTS (
             SELECT 1 FROM activity_records s
             WHERE s.supersedes_record_no = r.record_no
               AND s.created_at <= $1
         )
       ORDER BY r.record_no`,
      [asOf]
    );
    return res.rows.map(hydrate);
  }
}

@Module({
  imports: [DbModule, MasterDataModule, FactorLibraryModule],
  providers: [ActivityDataService],
  exports: [ActivityDataService]
})
export class ActivityDataModule {}
