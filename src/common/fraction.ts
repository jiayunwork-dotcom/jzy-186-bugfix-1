/**
 * Exact rational arithmetic over bigint.
 *
 * Every accounting number (activity quantity, converted energy, each gas
 * emission, CO2e, every aggregate and every decomposition component) is a
 * Fraction end to end.  This gives the system three properties the audit
 * relies on:
 *
 *  1. Determinism: a+b is the same value regardless of summation container
 *     (no map/order-dependent float drift).  Callers still sort keys before
 *     summing so the reduced canonical form is identical too.
 *  2. Strict additivity: the three decomposition components are added with
 *     the same Fraction addition used for the total, so component1 +
 *     component2 + component3 === total exactly (bit identical after
 *     canonicalization), never off by one ULP.
 *  3. Round-trip exactness: unit conversion chains whose factors are decimal
 *     constants are exact, so m3 -> GJ -> m3 equals the input exactly.
 */
export class Fraction {
  /** Always canonical: denominator > 0, gcd(|numerator|, denominator) === 1. */
  private constructor(
    readonly num: bigint,
    readonly den: bigint
  ) {
    if (den === 0n) throw new Error('Fraction: zero denominator');
  }

  /** Canonizing factory: normalizes sign and reduces. */
  static of(num: bigint, den: bigint): Fraction {
    if (den === 0n) throw new Error('Fraction: zero denominator');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    if (num === 0n) return Fraction.ZERO;
    const g = Fraction.gcd(num, den);
    return g === 1n ? new Fraction(num, den) : new Fraction(num / g, den / g);
  }

  static ZERO = new Fraction(0n, 1n);
  static ONE = new Fraction(1n, 1n);

  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  /**
   * Parse a decimal number or string exactly.
   * Accepts: 56.1, -3, "100", "0.0001", "1e3", "2.5e-2".
   * Rejects NaN / Infinity / non-finite values.
   */
  static from(value: number | string | bigint | Fraction): Fraction {
    if (value instanceof Fraction) return value;
    if (typeof value === 'bigint') return Fraction.of(value, 1n);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`Fraction: value is not finite: ${String(value)}`);
      }
      value = Number.isInteger(value) ? value.toString() : value.toString();
    }
    const s = value.trim();
    const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error(`Fraction: bad decimal: ${value}`);
    const sign = m[1] === '-' ? -1n : 1n;
    const intPart = m[2];
    const fracPart = m[3] ?? '';
    const exp = m[4] !== undefined ? parseInt(m[4], 10) : 0;
    let digits = intPart + fracPart;
    let scale = BigInt(fracPart.length) - BigInt(exp);
    // strip leading zeros to keep bigints small
    digits = digits.replace(/^0+/, '') || '0';
    let n = BigInt(digits) * sign;
    if (scale >= 0n) {
      return Fraction.of(n, 10n ** scale);
    }
    n *= 10n ** -scale;
    return Fraction.of(n, 1n);
  }

  static gcd(a: bigint, b: bigint): bigint {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a;
  }

  reduce(): Fraction {
    return Fraction.of(this.num, this.den);
  }

  // --------------------------------------------------------------------------
  // Arithmetic
  // --------------------------------------------------------------------------

  add(o: Fraction): Fraction {
    return Fraction.of(
      this.num * o.den + o.num * this.den,
      this.den * o.den
    );
  }

  sub(o: Fraction): Fraction {
    return Fraction.of(
      this.num * o.den - o.num * this.den,
      this.den * o.den
    );
  }

  mul(o: Fraction): Fraction {
    return Fraction.of(this.num * o.num, this.den * o.den);
  }

  div(o: Fraction): Fraction {
    if (o.num === 0n) throw new Error('Fraction: division by zero');
    return Fraction.of(this.num * o.den, this.den * o.num);
  }

  neg(): Fraction {
    return Fraction.of(-this.num, this.den);
  }

  abs(): Fraction {
    return this.num < 0n ? this.neg() : this;
  }

  compare(o: Fraction): -1 | 0 | 1 {
    const lhs = this.num * o.den;
    const rhs = o.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  sign(): -1 | 0 | 1 {
    return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
  }

  // --------------------------------------------------------------------------
  // Output
  // --------------------------------------------------------------------------

  /**
   * Exact finite decimal when the denominator is 2/5-smooth (true for every
   * factor/GWP driven computation in this system); otherwise round half-up to
   * `places` digits as a defensive fallback.
   */
  toDecimalString(places = 18): string {
    if (this.num === 0n) return '0';
    const neg = this.num < 0n;
    const num = neg ? -this.num : this.num;
    const factors = this.primeFactorsOtherThan2and5();
    if (factors === null) {
      // terminating decimal
      let twos = 0n;
      let fives = 0n;
      let d = this.den;
      while (d % 2n === 0n) { d /= 2n; twos++; }
      while (d % 5n === 0n) { d /= 5n; fives++; }
      const k = twos > fives ? twos : fives;
      const scaled = num * (10n ** k / this.den);
      const s = scaled.toString();
      let intPart: string;
      let fracPart: string;
      if (k === 0n) {
        intPart = s;
        fracPart = '';
      } else if (BigInt(s.length) <= k) {
        intPart = '0';
        fracPart = '0'.repeat(Number(k - BigInt(s.length))) + s;
      } else {
        intPart = s.slice(0, s.length - Number(k));
        fracPart = s.slice(s.length - Number(k));
      }
      fracPart = fracPart.replace(/0+$/, '');
      return (neg ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
    }
    // non-terminating defensive path: half-up to `places`
    const scale = 10n ** BigInt(places);
    const q = (num * scale * 2n) / this.den;
    let rounded = q / 2n;
    if (q - rounded * 2n >= 1n) rounded += 1n;
    const s = rounded.toString().padStart(places + 1, '0');
    const intPart = s.slice(0, s.length - places) || '0';
    const fracPart = s.slice(s.length - places).replace(/0+$/, '');
    return (neg ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
  }

  private primeFactorsOtherThan2and5(): null | true {
    let d = this.den;
    while (d % 2n === 0n) d /= 2n;
    while (d % 5n === 0n) d /= 5n;
    return d === 1n ? null : true;
  }

  toNumber(): number {
    return Number(this.toDecimalString(15));
  }

  toJSON(): string {
    return this.toDecimalString();
  }

  toString(): string {
    return this.toDecimalString();
  }

  /**
   * Deterministic identity key: fully reduced fractions of equal value have
   * equal keys.  Used for exact-equality assertions and cache keys.
   */
  key(): string {
    return `${this.num}/${this.den}`;
  }
}
