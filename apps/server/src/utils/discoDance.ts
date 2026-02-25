import type { ExtractedRow } from '../types.js';

function normalizeForMatch(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

function hasDiscoOrDance(value: string): boolean {
  const text = normalizeForMatch(value);
  return /\bdisco\b/i.test(text) || /\bdance\b/i.test(text);
}

function hasDiscoDanceRelatedChartTitle(value: string): boolean {
  const text = normalizeForMatch(value);
  return (
    hasDiscoOrDance(text) ||
    /\bclub\s*play\b/i.test(text) ||
    /\b12\s*inch\b/i.test(text) ||
    /\b12\s*in\.\b/i.test(text)
  );
}

export type DiscoDanceFilterResult = {
  mode: 'section' | 'title' | 'none';
  rows: ExtractedRow[];
  matchedChartSections: string[];
  matchedChartKeys: string[];
};

export function filterRowsToDiscoDanceCharts(rows: ExtractedRow[]): DiscoDanceFilterResult {
  const groups = new Map<
    string,
    { chartKey: string; chartTitle: string; chartSection: string; sectionMatch: boolean; titleMatch: boolean }
  >();

  for (const row of rows) {
    const chartTitle = row.chartTitle ?? '';
    const chartSection = row.chartSection ?? '';
    const chartKey = `${chartSection}|||${chartTitle}`;
    if (groups.has(chartKey)) continue;
    groups.set(chartKey, {
      chartKey,
      chartTitle,
      chartSection,
      sectionMatch: hasDiscoOrDance(chartSection),
      titleMatch: hasDiscoDanceRelatedChartTitle(chartTitle),
    });
  }

  const matchedSections = Array.from(new Set(Array.from(groups.values()).filter((g) => g.sectionMatch).map((g) => g.chartSection)));
  if (matchedSections.length > 0) {
    const sectionSet = new Set(matchedSections);
    const filtered = rows.filter((r) => sectionSet.has(r.chartSection ?? ''));
    const matchedKeys = Array.from(groups.values())
      .filter((g) => sectionSet.has(g.chartSection))
      .map((g) => g.chartKey);
    return { mode: 'section', rows: filtered, matchedChartSections: matchedSections, matchedChartKeys: matchedKeys };
  }

  const matchedKeys = Array.from(groups.values())
    .filter((g) => g.titleMatch)
    .map((g) => g.chartKey);
  if (matchedKeys.length > 0) {
    const keySet = new Set(matchedKeys);
    const filtered = rows.filter((r) => keySet.has(`${r.chartSection ?? ''}|||${r.chartTitle ?? ''}`));
    return { mode: 'title', rows: filtered, matchedChartSections: [], matchedChartKeys: matchedKeys };
  }

  return { mode: 'none', rows: [], matchedChartSections: [], matchedChartKeys: [] };
}
