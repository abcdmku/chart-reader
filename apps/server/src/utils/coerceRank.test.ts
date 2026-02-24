import { describe, expect, it } from 'vitest';
import { coerceRank } from './coerceRank';

describe('coerceRank', () => {
  it('parses digits and returns an integer', () => {
    expect(coerceRank('1')).toBe(1);
    expect(coerceRank(' 12 ')).toBe(12);
    expect(coerceRank('12*')).toBe(12);
    expect(coerceRank(34)).toBe(34);
  });

  it('returns null for non-numeric content', () => {
    expect(coerceRank('NEW')).toBeNull();
    expect(coerceRank('—')).toBeNull();
    expect(coerceRank('')).toBeNull();
    expect(coerceRank(null)).toBeNull();
    expect(coerceRank(undefined)).toBeNull();
  });
});

