import { describe, expect, it } from 'vitest';
import { normalizeExtractedText, normalizeRankText } from './normalizeExtractedText';

describe('normalizeExtractedText', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeExtractedText('  A   B \n C  ')).toBe('A B C');
  });

  it('removes decorative edge symbols', () => {
    expect(normalizeExtractedText('\u2022 SHEENA EASTON')).toBe('SHEENA EASTON');
    expect(normalizeExtractedText('SHEENA EASTON \u2022')).toBe('SHEENA EASTON');
    expect(normalizeExtractedText('\u2605 MADONNA \u2605')).toBe('MADONNA');
  });

  it('removes trailing separator dashes', () => {
    expect(normalizeExtractedText('SONG TITLE -')).toBe('SONG TITLE');
    expect(normalizeExtractedText('SONG TITLE\u2014')).toBe('SONG TITLE');
    expect(normalizeExtractedText('SONG TITLE \u2013')).toBe('SONG TITLE');
  });
});

describe('normalizeRankText', () => {
  it('returns digits only', () => {
    expect(normalizeRankText('\u260512')).toBe('12');
    expect(normalizeRankText(' 7 ')).toBe('7');
    expect(normalizeRankText('(12)')).toBe('12');
  });

  it('returns null for blanks and NEW', () => {
    expect(normalizeRankText(null)).toBeNull();
    expect(normalizeRankText('')).toBeNull();
    expect(normalizeRankText('-')).toBeNull();
    expect(normalizeRankText('\u2014')).toBeNull();
    expect(normalizeRankText('NEW')).toBeNull();
    expect(normalizeRankText('new')).toBeNull();
  });
});
