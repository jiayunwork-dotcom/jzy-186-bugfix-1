import { Fraction } from '../src/common/fraction';

describe('Fraction exact arithmetic', () => {
  test('parses decimals, integers and scientific notation exactly', () => {
    expect(Fraction.from('56.1').key()).toBe('561/10');
    expect(Fraction.from(100).key()).toBe('100/1');
    expect(Fraction.from('0.0001').key()).toBe('1/10000');
    expect(Fraction.from('1e3').key()).toBe('1000/1');
    expect(Fraction.from('2.5e-2').key()).toBe('1/40');
    expect(Fraction.from('-0.5').key()).toBe('-1/2');
  });

  test('rejects non-finite numbers', () => {
    expect(() => Fraction.from(NaN)).toThrow(/not finite/);
    expect(() => Fraction.from(Infinity)).toThrow(/not finite/);
    expect(() => Fraction.from('abc')).toThrow(/bad decimal/);
  });

  test('the worked example: 100 GJ * 56.1 kg/GJ = 5.61 t exactly', () => {
    const energy = Fraction.from('100'); // GJ
    const factor = Fraction.from('56.1'); // kg/GJ
    const kg = energy.mul(factor); // 5610 kg
    const tonnes = kg.div(Fraction.from(1000)); // 5.61 t
    expect(tonnes.key()).toBe('561/100');
    expect(tonnes.toDecimalString()).toBe('5.61');
  });

  test('addition/multiplication are exact for decimal data', () => {
    const xs = ['0.1', '0.2', '0.3'];
    let s = Fraction.ZERO;
    for (const x of xs) s = s.add(Fraction.from(x));
    expect(s.toDecimalString()).toBe('0.6');
    expect(s.key()).toBe('3/5');
  });

  test('canonical keys make equal values bit-identical', () => {
    const a = Fraction.from(2).div(Fraction.from(4));
    const b = Fraction.from(1).div(Fraction.from(2));
    expect(a.key()).toBe(b.key());
  });

  test('division by zero and zero denominator throw', () => {
    expect(() => Fraction.ONE.div(Fraction.ZERO)).toThrow();
  });
});
