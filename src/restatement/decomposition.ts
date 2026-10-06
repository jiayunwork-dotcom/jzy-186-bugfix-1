import { Fraction } from '../common/fraction';
import { GASES, type Gas } from '../factor-library/factor-library.service';
import type { AggregateQuery, GasTotals } from '../accounting/engine';

/**
 * Factor index (A, F, G) under one specific caliber. `value` evaluates the
 * target metric (one gas or CO2e, with the requested filter) under it.
 */
export interface DecompPoint {
  /** symbolic labels kept for the audit trail, never used in arithmetic */
  label: { cutId: number; factorVersionId: number; gwpSetId: number };
  evaluate: (query: AggregateQuery) => GasTotals;
}

export interface MetricDelta {
  total: Fraction;
  activity: Fraction;
  factors: Fraction;
  gwp: Fraction;
}

export interface MetricDecomposition {
  metric: Gas | 'CO2E';
  total: Fraction;
  activity: Fraction;
  factors: Fraction;
  gwp: Fraction;
}

/**
 * Shapley-value three-factor decomposition of f(A,F,G) - f(A0,F0,G0).
 *
 * For 3 factors the Shapley share of factor i is the mean of its marginal
 * contribution over all 3! = 6 replacement orders:
 *
 *   phi_i = 1/6 * sum over permutations [ v(S_plus_i) - v(S) ]
 *
 * The weighted corner formula (weights |S|!(n-|S|-1)!/n!):
 *   phi_A = 1/6 * ( 2 f100 + f110 + f101 + 2 f111
 *                  - 2 f000 - f010 - f001 - 2 f011 )
 *   phi_F = 1/6 * ( 2 f010 + f110 + f011 + 2 f111
 *                  - 2 f000 - f100 - f001 - 2 f101 )
 *   phi_G = 1/6 * ( 2 f001 + f101 + f011 + 2 f111
 *                  - 2 f000 - f100 - f010 - 2 f110 )
 *
 * Exact check (algebraic identity, not rounding): each non-extreme corner
 * appears with +k and −k across the three shares (e.g. f100: +2,−1,−1), f000
 * sums to −6 and f111 to +6, so phi_A + phi_F + phi_G = f111 − f000. Because
 * every value is an exact Fraction, the identity holds bit-for-bit.
 *
 * Fairness: Shapley is the *only* allocation satisfying symmetry (factors
 * with identical marginal effects get identical shares), dummy-factor
 * (a factor that changes nothing gets zero) and additivity. A fixed-order
 * (Laspeyres-style) decomposition biases against whichever factor is moved
 * last; the order-average removes that ordering bias, which is precisely the
 * auditor's concern ("按不同顺序逐项替换得到的分解不一样").
 *
 * Cost: 8 corner evaluations instead of 4 for a fixed order — i.e. at most
 * twice the calculation. Each corner is one cheap scan of already-loaded
 * records with bigint arithmetic; there is no approximation and no Monte
 * Carlo sampling, so the result is deterministic and reproducible.
 */
export function shapleyMetric(
  corners: Corners<Fraction>
): MetricDelta {
  const { f000, f001, f010, f011, f100, f101, f110, f111 } = corners;
  const six = Fraction.from(6);
  const two = Fraction.from(2);

  const activity = two
    .mul(f100)
    .add(f110)
    .add(f101)
    .add(two.mul(f111))
    .sub(two.mul(f000))
    .sub(f010)
    .sub(f001)
    .sub(two.mul(f011))
    .div(six);
  const factors = two
    .mul(f010)
    .add(f110)
    .add(f011)
    .add(two.mul(f111))
    .sub(two.mul(f000))
    .sub(f100)
    .sub(f001)
    .sub(two.mul(f101))
    .div(six);
  const gwp = two
    .mul(f001)
    .add(f101)
    .add(f011)
    .add(two.mul(f111))
    .sub(two.mul(f000))
    .sub(f100)
    .sub(f010)
    .sub(two.mul(f110))
    .div(six);
  const total = f111.sub(f000);
  return { total, activity, factors, gwp };
}

export interface Corners<T> {
  f000: T; // A0 F0 G0
  f001: T; // A0 F0 G1
  f010: T; // A0 F1 G0
  f011: T; // A0 F1 G1
  f100: T; // A1 F0 G0
  f101: T; // A1 F0 G1
  f110: T; // A1 F1 G0
  f111: T; // A1 F1 G1
}

/**
 * Evaluate all 8 caliber corners and decompose CO2, CH4, N2O and CO2e.
 *
 * Consequence used by the tests: a bare gas mass f(...) for CO2 does not
 * depend on the GWP set at all, so corners differing only in G share equal
 * CO2 values and phi_G(CO2) === 0 exactly.
 */
export function decomposeTotals(
  evaluateCorner: (a: 0 | 1, f: 0 | 1, g: 0 | 1) => GasTotals,
  query: AggregateQuery
): {
  corners: Corners<GasTotals>;
  components: MetricDecomposition[];
} {
  const c: Corners<GasTotals> = {
    f000: evaluateCorner(0, 0, 0),
    f001: evaluateCorner(0, 0, 1),
    f010: evaluateCorner(0, 1, 0),
    f011: evaluateCorner(0, 1, 1),
    f100: evaluateCorner(1, 0, 0),
    f101: evaluateCorner(1, 0, 1),
    f110: evaluateCorner(1, 1, 0),
    f111: evaluateCorner(1, 1, 1)
  };
  void query;

  const components: MetricDecomposition[] = [];
  for (const metric of [...GASES, 'CO2E'] as Array<Gas | 'CO2E'>) {
    const pick = (t: GasTotals): Fraction => t[metric];
    const d = shapleyMetric({
      f000: pick(c.f000),
      f001: pick(c.f001),
      f010: pick(c.f010),
      f011: pick(c.f011),
      f100: pick(c.f100),
      f101: pick(c.f101),
      f110: pick(c.f110),
      f111: pick(c.f111)
    });
    components.push({ metric, ...d });
  }
  return { corners: c, components };
}
