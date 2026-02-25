import { describe, expect, it } from 'vitest';

import type { ExtractedRow } from '../types.js';
import { filterRowsToDiscoDanceCharts } from './discoDance.js';

function row(partial: Partial<ExtractedRow>): ExtractedRow {
  return {
    chartTitle: partial.chartTitle ?? 'CHART',
    chartSection: partial.chartSection ?? '',
    thisWeekRank: null,
    lastWeekRank: null,
    twoWeeksAgoRank: null,
    weeksOnChart: null,
    title: partial.title ?? 'TITLE',
    artist: partial.artist ?? 'ARTIST',
    label: partial.label ?? 'LABEL',
  };
}

describe('filterRowsToDiscoDanceCharts', () => {
  it('filters by chartSection when section contains dance/disco', () => {
    const rows: ExtractedRow[] = [
      row({ chartSection: 'HOT DANCE/DISCO', chartTitle: 'CLUB PLAY', title: 'A' }),
      row({ chartSection: 'HOT DANCE/DISCO', chartTitle: '12 INCH SINGLES SALES', title: 'B' }),
      row({ chartSection: 'HOT COUNTRY', chartTitle: 'COUNTRY TOP', title: 'C' }),
    ];

    const filtered = filterRowsToDiscoDanceCharts(rows);
    expect(filtered.mode).toBe('section');
    expect(filtered.rows.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('filters by chartTitle when section is blank but title mentions disco/dance', () => {
    const rows: ExtractedRow[] = [
      row({ chartSection: '', chartTitle: 'DISCO TOP 80', title: 'A' }),
      row({ chartSection: '', chartTitle: 'HOT 100', title: 'B' }),
    ];

    const filtered = filterRowsToDiscoDanceCharts(rows);
    expect(filtered.mode).toBe('title');
    expect(filtered.rows.map((r) => r.title)).toEqual(['A']);
  });

  it('treats CLUB PLAY and 12 INCH as dance/disco related titles', () => {
    const rows: ExtractedRow[] = [
      row({ chartSection: '', chartTitle: 'CLUB PLAY', title: 'A' }),
      row({ chartSection: '', chartTitle: '12 INCH SINGLES SALES', title: 'B' }),
      row({ chartSection: '', chartTitle: 'HOT 100', title: 'C' }),
    ];

    const filtered = filterRowsToDiscoDanceCharts(rows);
    expect(filtered.mode).toBe('title');
    expect(filtered.rows.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('returns none when no disco/dance is detected', () => {
    const rows: ExtractedRow[] = [row({ chartSection: 'HOT 100', chartTitle: 'HOT 100' })];
    const filtered = filterRowsToDiscoDanceCharts(rows);
    expect(filtered.mode).toBe('none');
    expect(filtered.rows).toEqual([]);
  });
});
