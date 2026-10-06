import { Fraction } from '../common/fraction';
import { UnitError, isKnownUnit, dimensionOf, type Dimension } from '../units/units.service';

/**
 * Parse a "mass per activity" factor unit such as "kg/GJ", "kg/m3", "t/t".
 * The numerator must be a mass unit (emitted gas mass); the denominator is
 * the activity unit the record quantity must be convertible to.
 */
export interface ParsedFactorUnit {
  numerator: string;
  denominator: string;
}

export function parseFactorUnit(factorUnit: string): ParsedFactorUnit {
  const parts = factorUnit.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UnitError(`invalid factor unit (expected "<mass>/<activity>"): ${factorUnit}`);
  }
  const [numerator, denominator] = parts;
  if (dimensionOf(numerator) !== 'mass') {
    throw new UnitError(`factor numerator must be a mass unit: ${factorUnit}`);
  }
  if (!isKnownUnit(denominator)) {
    throw new UnitError(`unknown activity unit in factor unit: ${factorUnit}`);
  }
  return { numerator, denominator };
}

/** kg-to-tonnes conversion helpers (factor numerators may be kg or t). */
const MASS_TO_TONNES: Record<string, Fraction> = {
  g: Fraction.from(1).div(Fraction.from(1_000_000)),
  kg: Fraction.from(1).div(Fraction.from(1000)),
  t: Fraction.ONE
};

export function factorNumeratorToTonnes(massUnit: string): Fraction {
  const f = MASS_TO_TONNES[massUnit];
  if (!f) throw new UnitError(`unsupported mass unit: ${massUnit}`);
  return f;
}

export function factorActivityDimension(factorUnit: string): Dimension {
  return dimensionOf(parseFactorUnit(factorUnit).denominator);
}
