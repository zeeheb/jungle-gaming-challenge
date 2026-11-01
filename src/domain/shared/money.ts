import { DomainError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);

// Plain decimal notation only: no sign, no exponent, no leading zeros and at
// most two fractional digits. 18 integer digits is what NUMERIC(20,2) holds.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Exact amount with a fixed scale of 2, kept as an integer number of minor
 * units (cents). Nothing here ever rounds: input with more precision than the
 * scale is rejected instead.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses an input contract, so negative amounts are not accepted here. */
  static from(props: MoneyProps): Money {
    const amount: unknown = props.amount;
    const match = typeof amount === 'string' ? AMOUNT_PATTERN.exec(amount) : null;
    if (!match) {
      throw new InvalidMoneyError(
        `Invalid amount ${describe(amount)}: expected a non-negative decimal string with up to ${SCALE} decimal places`,
      );
    }

    const [, integer = '0', fraction = ''] = match;
    const minorUnits = BigInt(integer) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
    return new Money(minorUnits, Money.parseCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Amounts in different currencies are simply not equal; asking is not an error. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const absolute = this.isNegative() ? -this.minorUnits : this.minorUnits;
    const integer = absolute / FACTOR;
    const fraction = (absolute % FACTOR).toString().padStart(SCALE, '0');
    return `${this.isNegative() ? '-' : ''}${integer}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency ${describe(currency)}: expected an ISO-4217 code such as BRL`);
    }
    return currency;
  }
}

// Input can be anything a client put in a JSON body; never let the error
// message itself blow up (JSON.stringify throws on bigint, for instance).
function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : `of type ${typeof value}`;
}
