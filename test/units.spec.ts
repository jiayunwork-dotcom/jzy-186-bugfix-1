import { Fraction } from '../src/common/fraction';
import { convert, dimensionOf, isKnownUnit, UnitError } from '../src/units/units.service';

describe('unit conversion', () => {
  test('within-dimension SI conversions are exact', () => {
    expect(convert(Fraction.from(1), 't', 'kg').key()).toBe('1000/1');
    expect(convert(Fraction.from(1), 'kg', 't').toDecimalString()).toBe('0.001');
    expect(convert(Fraction.from(1000), 'L', 'm3').key()).toBe('1/1');
    expect(convert(Fraction.from(1), 'MWh', 'GJ').key()).toBe('18/5');
    expect(convert(Fraction.from(1), 'kWh', 'GJ').toDecimalString()).toBe('0.0036');
    expect(dimensionOf('t')).toBe('mass');
    expect(dimensionOf('L')).toBe('volume');
    expect(isKnownUnit('nope')).toBe(false);
  });

  test('cross-dimension via density + NCV and exact round trip', () => {
    // Diesel-ish: 800 kg/m3, NCV 45 GJ/t.
    const fuel = { density: Fraction.from(800), ncvMass: Fraction.from(45) };
    const m3 = Fraction.from(1000);
    const gj = convert(m3, 'm3', 'GJ', fuel);
    // 1000 m3 * 800 kg/m3 = 800 t * 45 GJ/t = 36000 GJ
    expect(gj.key()).toBe('36000/1');
    // reverse path GJ -> t -> kg -> m3 recovers the input exactly
    const back = convert(gj, 'GJ', 'm3', fuel);
    expect(back.key()).toBe(m3.key());
    // L -> GJ -> L
    const liters = Fraction.from('37.5');
    const roundTrip = convert(convert(liters, 'L', 'GJ', fuel), 'GJ', 'L', fuel);
    expect(roundTrip.key()).toBe(liters.key());
  });

  test('cross-dimension conversion fails loudly without fuel properties', () => {
    expect(() => convert(Fraction.from(1), 'm3', 'GJ')).toThrow(UnitError);
    expect(() => convert(Fraction.from(1), 'GJ', 'kg', {})).toThrow(UnitError);
    expect(() => convert(Fraction.from(1), 'kg', 'each', {})).toThrow(UnitError);
  });

  test('unknown units are rejected', () => {
    expect(() => convert(Fraction.from(1), 'bogus', 'kg')).toThrow(UnitError);
  });
});
