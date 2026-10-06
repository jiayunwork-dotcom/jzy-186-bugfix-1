import { Injectable, Module } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { Fraction } from '../common/fraction';
import { ConflictError, FieldError, NotFoundError, ValidationException } from '../common/errors';
import { GASES, type Gas } from './factor-library.service';

export interface GwpValueInput {
  gas: Gas;
  value: number | string;
}

export interface PublishGwpSetInput {
  code: string;
  name: string;
  values: GwpValueInput[];
}

@Injectable()
export class GwpService {
  constructor(private readonly db: DbService) {}

  async publishSet(input: PublishGwpSetInput): Promise<number> {
    const errors: FieldError[] = [];
    if (!input.code) errors.push({ field: 'code', code: 'MISSING_FIELD', message: 'code required' });
    if (!input.name) errors.push({ field: 'name', code: 'MISSING_FIELD', message: 'name required' });

    const seen = new Set<Gas>();
    input.values.forEach((v, i) => {
      if (!GASES.includes(v.gas)) {
        errors.push({ field: `values[${i}].gas`, code: 'INVALID_VALUE', message: `gas must be one of ${GASES.join('/')}` });
      }
      if (seen.has(v.gas)) {
        errors.push({ field: `values[${i}].gas`, code: 'DUPLICATE_KEY', message: `duplicate gas ${v.gas}` });
      }
      seen.add(v.gas);
      try {
        const frac = Fraction.from(v.value);
        if (frac.sign() < 0) {
          errors.push({ field: `values[${i}].value`, code: 'NEGATIVE_OR_NON_FINITE', message: 'GWP must be non-negative' });
        }
      } catch {
        errors.push({
          field: `values[${i}].value`,
          code: 'NEGATIVE_OR_NON_FINITE',
          message: `not a finite non-negative decimal: ${String(v.value)}`
        });
      }
    });
    for (const gas of GASES) {
      if (!seen.has(gas)) {
        errors.push({ field: 'values', code: 'MISSING_FIELD', message: `missing GWP for ${gas}` });
      }
    }
    if (errors.length) throw new ValidationException(errors);

    return this.db.withTransaction(async (client) => {
      const exists = await client.query<{ id: number }>('SELECT id FROM gwp_sets WHERE code = $1', [
        input.code
      ]);
      if (exists.rows[0]) throw new ConflictError('code', `GWP set already exists: ${input.code}`);
      const ins = await client.query<{ id: number }>(
        'INSERT INTO gwp_sets(code, name) VALUES ($1, $2) RETURNING id',
        [input.code, input.name]
      );
      const id = ins.rows[0].id;
      for (const v of input.values) {
        const f = Fraction.from(v.value);
        await client.query(
          'INSERT INTO gwp_values(gwp_set_id, gas, value_num, value_den) VALUES ($1, $2, $3, $4)',
          [id, v.gas, f.num, f.den]
        );
      }
      return id;
    });
  }

  async resolveSetId(client: Queryer, codeOrId: string | number): Promise<number> {
    const res = await client.query<{ id: number }>(
      typeof codeOrId === 'number'
        ? 'SELECT id FROM gwp_sets WHERE id = $1'
        : 'SELECT id FROM gwp_sets WHERE code = $1',
      [codeOrId]
    );
    if (!res.rows[0]) throw new NotFoundError(`GWP set not found: ${codeOrId}`);
    return res.rows[0].id;
  }

  async getValues(client: Queryer, setId: number): Promise<Record<Gas, Fraction>> {
    const res = await client.query<{ gas: Gas; value_num: string; value_den: string }>(
      'SELECT gas, value_num, value_den FROM gwp_values WHERE gwp_set_id = $1',
      [setId]
    );
    const out = {} as Record<Gas, Fraction>;
    for (const r of res.rows) {
      out[r.gas] = Fraction.of(BigInt(r.value_num), BigInt(r.value_den));
    }
    for (const gas of GASES) {
      if (!out[gas]) throw new NotFoundError(`GWP set ${setId} missing value for ${gas}`);
    }
    return out;
  }

  async listSets(): Promise<{ id: number; code: string; name: string }[]> {
    const res = await this.db.query<{ id: number; code: string; name: string }>(
      'SELECT id, code, name FROM gwp_sets ORDER BY id'
    );
    return res.rows;
  }
}

@Module({
  imports: [DbModule],
  providers: [GwpService],
  exports: [GwpService]
})
export class GwpModule {}
