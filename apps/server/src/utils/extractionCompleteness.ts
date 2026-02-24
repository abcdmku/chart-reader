import type { ExtractedRow } from '../types.js';
import { coerceRank } from './coerceRank.js';

export type MissingChartGroup = {
  chartTitle: string;
  chartSection: string;
  expectedMaxRank: number;
  minRank: number;
  maxRank: number;
  expectedRowCount: number;
  actualRowCount: number;
  missingThisWeekRanks: number[];
};

function clampExpectedMaxRank(value: number | null): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  const asInt = Math.floor(value);
  // Billboard charts on these pages are usually <= 100; keep a generous ceiling.
  if (asInt < 2 || asInt > 200) return null;
  return asInt;
}

function inferExpectedMaxRankFromTitle(chartTitle: string): number | null {
  const text = chartTitle.trim();
  if (!text) return null;

  const topMatch = text.match(/\bTOP\s*(\d{2,3})\b/i);
  if (topMatch) return clampExpectedMaxRank(Number.parseInt(topMatch[1], 10));

  const hotMatch = text.match(/\bHOT\s*(\d{2,3})\b/i);
  if (hotMatch) return clampExpectedMaxRank(Number.parseInt(hotMatch[1], 10));

  return null;
}

function inferExpectedMaxRankFromFilename(filename: string): number | null {
  const text = filename.trim();
  if (!text) return null;

  const topMatch = text.match(/\btop[_ -]?(\d{2,3})\b/i);
  if (topMatch) return clampExpectedMaxRank(Number.parseInt(topMatch[1], 10));

  return null;
}

export function formatRankRanges(ranks: number[], opts?: { maxRanges?: number }): string {
  const maxRanges = Math.max(1, opts?.maxRanges ?? 20);
  const sorted = Array.from(new Set(ranks.filter((n) => Number.isFinite(n)).map((n) => Math.floor(n)))).sort((a, b) => a - b);
  if (sorted.length === 0) return '';

  const ranges: Array<{ start: number; end: number }> = [];
  for (const rank of sorted) {
    const last = ranges.at(-1);
    if (!last || rank > last.end + 1) {
      ranges.push({ start: rank, end: rank });
      continue;
    }
    last.end = rank;
  }

  const text = ranges
    .slice(0, maxRanges)
    .map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`))
    .join(', ');
  return ranges.length > maxRanges ? `${text}, …` : text;
}

export function findMissingChartGroups(args: { rows: ExtractedRow[]; sourceFilename?: string | null }): MissingChartGroup[] {
  const groups = new Map<string, { chartTitle: string; chartSection: string; rows: ExtractedRow[] }>();
  const orderedKeys: string[] = [];

  for (const row of args.rows) {
    const chartTitle = row.chartTitle ?? '';
    const chartSection = row.chartSection ?? '';
    const key = `${chartSection}|||${chartTitle}`;
    let group = groups.get(key);
    if (!group) {
      group = { chartTitle, chartSection, rows: [] };
      groups.set(key, group);
      orderedKeys.push(key);
    }
    group.rows.push(row);
  }

  const missing: MissingChartGroup[] = [];

  for (const key of orderedKeys) {
    const group = groups.get(key);
    if (!group) continue;

    const ranks = group.rows.map((r) => coerceRank(r.thisWeekRank)).filter((n): n is number => n != null);
    if (ranks.length === 0) continue;

    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);

    const expectedFromTitle = inferExpectedMaxRankFromTitle(group.chartTitle);
    const expectedFromFilename = args.sourceFilename ? inferExpectedMaxRankFromFilename(args.sourceFilename) : null;
    const expectedMaxRank = clampExpectedMaxRank(expectedFromTitle ?? expectedFromFilename ?? maxRank);
    if (expectedMaxRank == null) continue;

    const finalExpectedMax = Math.max(expectedMaxRank, maxRank);
    if (finalExpectedMax < minRank) continue;

    const expectedRowCount = finalExpectedMax - minRank + 1;
    const actualRowCount = group.rows.length;
    if (actualRowCount >= expectedRowCount) continue;

    const present = new Set(ranks);
    const missingThisWeekRanks: number[] = [];
    for (let r = minRank; r <= finalExpectedMax; r += 1) {
      if (!present.has(r)) missingThisWeekRanks.push(r);
    }

    missing.push({
      chartTitle: group.chartTitle,
      chartSection: group.chartSection,
      expectedMaxRank: finalExpectedMax,
      minRank,
      maxRank,
      expectedRowCount,
      actualRowCount,
      missingThisWeekRanks,
    });
  }

  return missing;
}

