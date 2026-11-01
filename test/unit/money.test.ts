import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain/shared/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('parsing and serialization', () => {
    it.each([
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['25.50', '25.50'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('reads %p and always serializes with two decimals as %p', (input, expected) => {
      expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    });

    it('serializes through JSON.stringify as the string contract', () => {
      expect(JSON.stringify({ money: brl('10') })).toBe('{"money":{"amount":"10.00","currency":"BRL"}}');
    });

    it('formats negative results of arithmetic', () => {
      expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
      expect(brl('0.05').subtract(brl('1.00')).toString()).toBe('-0.95 BRL');
    });
  });

  describe('invalid input', () => {
    it.each([
      [''],
      [' '],
      ['abc'],
      ['NaN'],
      ['Infinity'],
      ['-Infinity'],
      ['1e3'],
      ['1E3'],
      ['-1.00'],
      ['+1.00'],
      ['1.001'],
      ['01.00'],
      ['.50'],
      ['5.'],
      ['1,00'],
      [' 1.00'],
      ['1 000.00'],
      ['1000000000000000000.00'],
    ])('rejects %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejects instead of rounding when there are more than two decimals', () => {
      expect(() => brl('10.005')).toThrow(InvalidMoneyError);
      expect(() => brl('10.999')).toThrow(InvalidMoneyError);
    });

    it('rejects non-string amounts coming from untyped JSON', () => {
      for (const amount of [25, 25.5, null, undefined, {}, 10n]) {
        expect(() => Money.from({ amount, currency: 'BRL' } as never)).toThrow(InvalidMoneyError);
      }
    });

    it.each([[''], ['brl'], ['BR'], ['BRLX'], ['R$']])('rejects currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('is exact where floating point is not', () => {
      expect(0.1 + 0.2).not.toBe(0.3);
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('keeps precision for large amounts', () => {
      const big = brl('999999999999999999.98');
      expect(big.add(brl('0.01')).toJSON().amount).toBe('999999999999999999.99');
    });

    it('adds and subtracts', () => {
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
      expect(brl('19.99').add(brl('0.01')).toJSON().amount).toBe('20.00');
    });

    it('compares', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
      expect(brl('0').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0').isPositive()).toBe(false);
      expect(brl('1.00').negate().isNegative()).toBe(true);
    });

    it('is immutable', () => {
      const original = brl('10.00');
      const result = original.add(brl('5.00'));

      expect(result).not.toBe(original);
      expect(original.toJSON().amount).toBe('10.00');
      expect(Object.isFrozen(original)).toBe(true);
    });
  });

  describe('currencies', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    it('refuses to mix currencies', () => {
      expect(() => brl('10.00').add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('10.00').subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('10.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    });

    it('treats the same amount in another currency as different', () => {
      expect(brl('10.00').equals(usd)).toBe(false);
    });
  });
});
