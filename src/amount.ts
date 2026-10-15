import { LedgerError } from './errors.js';

/** Amounts are integer strings in minor units (e.g. satoshi, wei, cents). Never floats. */
export function parseAmount(value: string): bigint {
  if (!/^[1-9][0-9]{0,76}$/.test(value)) {
    throw new LedgerError(400, 'INVALID_AMOUNT', 'amount must be a positive integer string in minor units');
  }
  return BigInt(value);
}

export function parseCurrency(value: string): string {
  if (!/^[A-Z0-9]{2,10}$/.test(value)) {
    throw new LedgerError(400, 'INVALID_CURRENCY', 'currency must be 2-10 uppercase letters or digits');
  }
  return value;
}
