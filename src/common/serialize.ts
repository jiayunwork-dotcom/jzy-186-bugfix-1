import { Fraction } from './fraction';
import type { GasTotals } from '../accounting/engine';

/**
 * Wire format for exact numbers: both the exact decimal string (terminating
 * for all 2/5-smooth factor arithmetic) and the canonical num/den pair.
 * Clients display `decimal`; tests assert equality on `key` / num-den to
 * prove bit-identical recomputation.
 */
export function fracDto(f: Fraction): { decimal: string; num: string; den: string } {
  return { decimal: f.toDecimalString(18), num: f.num.toString(), den: f.den.toString() };
}

export function totalsDto(t: GasTotals) {
  return {
    co2Tonnes: fracDto(t.CO2),
    ch4Tonnes: fracDto(t.CH4),
    n2oTonnes: fracDto(t.N2O),
    co2eTonnes: fracDto(t.CO2E)
  };
}
