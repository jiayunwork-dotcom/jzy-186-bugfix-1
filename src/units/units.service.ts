import { Fraction } from '../common/fraction';

/**
 * Quantity kind.  Only quantities of the same dimension are comparable /
 * summable.  The engine converts everything to a canonical base unit before
 * multiplying with an emission factor, and the factor declares which
 * dimension its unit must have.
 */
export type Dimension = 'mass' | 'volume' | 'energy' | 'count';

/**
 * Built-in units.  Conversion rule:
 *  - mass / volume of a *fuel substance* may additionally use that fuel's
 *    library-defined density (kg/m3) and NCV (net calorific value, GJ/t or
 *    GJ/m3) — those are factor-library data, not global constants.
 *  - global multipliers below are pure SI prefixes and agreed definitions
 *    (1 t = 1000 kg, 1 L = 0.001 m3, 1 kWh = 3.6 GJ).
 */
const UNITS: Record<string, { dim: Dimension; toBase: Fraction; base: string }> = {
  // mass, base kg
  kg: { dim: 'mass', toBase: Fraction.ONE, base: 'kg' },
  t: { dim: 'mass', toBase: Fraction.from(1000), base: 'kg' },
  g: { dim: 'mass', toBase: Fraction.from(1).div(Fraction.from(1000)), base: 'kg' },
  // volume, base m3
  m3: { dim: 'volume', toBase: Fraction.ONE, base: 'm3' },
  L: { dim: 'volume', toBase: Fraction.from(1).div(Fraction.from(1000)), base: 'm3' },
  l: { dim: 'volume', toBase: Fraction.from(1).div(Fraction.from(1000)), base: 'm3' },
  // energy, base GJ
  GJ: { dim: 'energy', toBase: Fraction.ONE, base: 'GJ' },
  MJ: { dim: 'energy', toBase: Fraction.from(1).div(Fraction.from(1000)), base: 'GJ' },
  kWh: { dim: 'energy', toBase: Fraction.from(3.6).div(Fraction.from(1000)), base: 'GJ' },
  MWh: { dim: 'energy', toBase: Fraction.from(3.6), base: 'GJ' },
  // dimensionless count, base each
  each: { dim: 'count', toBase: Fraction.ONE, base: 'each' },
  unit: { dim: 'count', toBase: Fraction.ONE, base: 'each' }
};

/**
 * Per-fuel properties from the factor library, exactly as stored for the
 * factor version used by a calculation.
 *  - density:  kg per m3        (volume <-> mass)
 *  - ncvMass:  GJ per tonne     (mass <-> energy)
 *
 * Volume<->energy is derived exactly as density * ncvMass / 1000 (GJ per m3);
 * no separate ncvVolume constant is stored, so the two routes cannot drift.
 */
export interface FuelProps {
  density?: Fraction;
  ncvMass?: Fraction;
}

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

export function dimensionOf(unit: string): Dimension {
  const u = UNITS[unit];
  if (!u) throw new UnitError(`unknown unit: ${unit}`);
  return u.dim;
}

export function isKnownUnit(unit: string): boolean {
  return unit in UNITS;
}

/**
 * Convert `amount` expressed in `fromUnit` to `toUnit`.
 *
 * `fuel` is required exactly when the conversion crosses between two of
 * {mass, volume, energy} that are not the same dimension; the needed
 * density/NCV is then taken from the factor version being used, so the same
 * activity record converted under two factor versions may legitimately yield
 * different base quantities.
 *
 * Within-dimension conversions use only the decimal SI constants above and
 * are therefore exact and reversible.
 */
export function convert(
  amount: Fraction,
  fromUnit: string,
  toUnit: string,
  fuel?: FuelProps
): Fraction {
  if (fromUnit === toUnit) return amount;
  const src = UNITS[fromUnit];
  const dst = UNITS[toUnit];
  if (!src) throw new UnitError(`unknown unit: ${fromUnit}`);
  if (!dst) throw new UnitError(`unknown unit: ${toUnit}`);

  // Step 1: amount -> dimension base unit (kg / m3 / GJ / each)
  let base = amount.mul(src.toBase);
  let dim = src.dim;

  // Step 2: cross-dimension bridges via fuel properties.
  if (dim !== dst.dim) {
    if (!fuel) {
      throw new UnitError(
        `cannot convert ${fromUnit} (${dim}) to ${toUnit} (${dst.dim}) without fuel density/calorific value`
      );
    }
    // Normalize through kg: mass is the pivot.
    if (dim === 'volume') {
      if (!fuel.density) {
        throw new UnitError('fuel density is required for volume<->mass conversion');
      }
      base = base.mul(fuel.density); // m3 -> kg
      dim = 'mass';
    } else if (dim === 'energy') {
      if (!fuel.ncvMass || fuel.ncvMass.sign() === 0) {
        throw new UnitError('fuel net calorific value (GJ/t) is required for energy<->mass conversion');
      }
      // GJ / (GJ/t) = t ; ncvMass is GJ per tonne -> kg per GJ = 1000/ncvMass
      base = base.mul(Fraction.from(1000)).div(fuel.ncvMass); // GJ -> kg
      dim = 'mass';
    }
    if (dst.dim === 'volume') {
      if (dim !== 'mass' || !fuel.density) {
        throw new UnitError('fuel density is required for mass<->volume conversion');
      }
      base = base.div(fuel.density); // kg -> m3
      dim = 'volume';
    } else if (dst.dim === 'energy') {
      if (!fuel.ncvMass || fuel.ncvMass.sign() === 0) {
        throw new UnitError('fuel net calorific value (GJ/t) is required for mass<->energy conversion');
      }
      // kg -> t -> GJ
      base = base.div(Fraction.from(1000)).mul(fuel.ncvMass);
      dim = 'energy';
    }
  }

  if (dim !== dst.dim) {
    throw new UnitError(`cannot convert ${fromUnit} to ${toUnit}: incompatible dimensions`);
  }

  // Step 3: base unit -> requested target unit
  return base.div(dst.toBase);
}

/**
 * Check that a unit is usable for an emission factor declared in
 * `factorUnit`. Returns the dimension of the factor unit (the engine always
 * converts activity quantity to exactly the factor unit before multiplying).
 */
export function assertConvertible(
  activityUnit: string,
  factorUnit: string,
  fuel?: FuelProps
): Dimension {
  // throws if either end is unknown or no bridge exists
  convert(Fraction.ONE, activityUnit, factorUnit, fuel);
  return dimensionOf(factorUnit);
}
