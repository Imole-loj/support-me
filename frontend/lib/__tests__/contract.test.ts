import { describe, expect, it } from 'vitest';
import { DonationError, toStroops } from '@/lib/contract';

describe('toStroops', () => {
  it('converts integers exactly', () => expect(toStroops('5')).toBe(BigInt(50_000_000)));
  it('converts seven decimal places exactly', () => expect(toStroops('0.1234567')).toBe(BigInt(1_234_567)));
  it('multiplies exact stroops for approved periods', () => expect(toStroops('0.1', 12)).toBe(BigInt(12_000_000)));

  it.each(['5abc', '0.12345678', ''])('rejects invalid amount %j with a typed simulation error', (amount) => {
    try {
      toStroops(amount);
      throw new Error('Expected toStroops to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DonationError);
      expect((error as DonationError).type).toBe('simulation');
    }
  });
});
