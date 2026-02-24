import { describe, expect, it } from 'vitest';
import { parseEntryDate } from './parseEntryDate';

describe('parseEntryDate', () => {
  it('finds YYYY-MM-DD anywhere in the filename', () => {
    expect(parseEntryDate('1986-04-12_top100.jpg')).toBe('1986-04-12');
    expect(parseEntryDate('foo_1986-04-12_bar.webp')).toBe('1986-04-12');
  });

  it('returns null when not present', () => {
    expect(parseEntryDate('top100.jpg')).toBeNull();
    expect(parseEntryDate('1986-4-12.jpg')).toBeNull();
  });
});

