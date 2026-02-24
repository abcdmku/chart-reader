import { google } from '@ai-sdk/google';
import { generateText, Output, zodSchema } from 'ai';
import { z } from 'zod';
import type { ExtractionResult } from './types.js';
import type { MissingChartGroup } from './utils/extractionCompleteness.js';
import { formatRankRanges } from './utils/extractionCompleteness.js';
import { normalizeExtractedText, normalizeRankText } from './utils/normalizeExtractedText.js';

const ExtractedRowSchema = z.object({
  chartTitle: z.string().min(1),
  chartSection: z.string().default(''),
  thisWeekRank: z.string().nullable().default(null),
  lastWeekRank: z.string().nullable().default(null),
  twoWeeksAgoRank: z.string().nullable().default(null),
  weeksOnChart: z.string().nullable().default(null),
  title: z.string().min(1),
  artist: z.string().min(1),
  label: z.string().min(1),
});

const ExtractionSchema = z.object({
  rows: z.array(ExtractedRowSchema),
});

export async function extractChartRows(args: {
  image: Buffer;
  mimeType: string;
  model: string;
  abortSignal?: AbortSignal;
}): Promise<{ result: ExtractionResult; rawResultJson: string }> {
  const systemPrompt = [
    'You are a high-precision OCR + table extraction engine for scanned Billboard chart pages.',
    'Return only JSON that matches the provided schema (no commentary, no markdown).',
    'Never guess: if you cannot confidently read something, prefer null (for rank fields) or omit the row (for required text fields).',
    'Never mix data across different chart tables on the same page.',
  ].join('\n');

  const userPrompt = [
    'Extract chart table rows from this scanned Billboard page.',
    '',
    'Output format: a JSON object with `rows` (an array). Each row is one chart entry.',
    '',
    'Terminology:',
    '- A "chart block" is one chart table with its own chart title and column headers. Pages can have multiple chart blocks.',
    '- chartTitle: the specific chart title for the chart block (e.g. "12 INCH SINGLES SALES", "CLUB PLAY", "DISCO TOP 80"). Do not include the "Billboard" masthead.',
    '- chartSection: the broader page/category header that groups charts on the page (e.g. "HOT DANCE/DISCO"). If none, use "" (empty string).',
    '',
    'Critical rules (do not violate):',
    '1) Multi-chart pages: if there are multiple chart blocks (side-by-side or stacked), treat them as completely separate tables.',
    '   - NEVER copy ranks from one chart block onto rows from another chart block, even if the rows line up horizontally.',
    '   - Extract all rows for one chart block before moving to the next chart block.',
    '   - If a single chart is laid out in multiple columns (same chartTitle repeated with separate column headers), treat each column as an independent table region and never combine cells across columns.',
    '2) Ranks (thisWeekRank/lastWeekRank/twoWeeksAgoRank/weeksOnChart):',
    '   - Only read rank values from the columns in the SAME chart block as the row\'s title/artist/label.',
    '   - Ignore decorative icons/symbols (stars, circles, bullets) printed near or around ranks; they are not part of the number.',
    '   - If a rank cell is blank, a dash (like "-"), "NEW", or unreadable, return null for that field.',
    '   - Return ranks as digits only (e.g. "12"), not "12*", "(12)", or "star 12".',
    '3) Text fields (title/artist/label):',
    '   - Copy the printed text from the SAME row of the SAME chart block.',
    '   - Trim whitespace and remove trailing separator dashes (e.g. "SONG TITLE -" => "SONG TITLE").',
    '   - Ignore decorative bullets/symbols that are not part of the text.',
    '4) Scope: extract ONLY chart table rows. Ignore articles, ads, and sidebars that are not chart tables.',
    '',
    'Ordering: preserve row order top-to-bottom within each table region; output regions in reading order (left-to-right, then top-to-bottom).',
    '',
    'Example mapping: if the page header says "HOT DANCE/DISCO" and it contains two charts titled "12 INCH SINGLES SALES" and "CLUB PLAY", then chartSection="HOT DANCE/DISCO" for both charts, and chartTitle is the chart\'s own title.',
    '',
    'If you cannot confidently extract a row\'s title OR artist OR label, omit that row (do not guess).',
    '',
    'Return only valid JSON.',
  ].join('\n');

  const response = await generateText({
    model: google(args.model),
    output: Output.object({
      schema: zodSchema(ExtractionSchema),
      name: 'billboard_chart_rows',
      description: 'Extracted chart rows from scanned Billboard chart tables.',
    }),
    abortSignal: args.abortSignal,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image', image: args.image, mediaType: args.mimeType },
        ],
      },
    ],
  });

  const normalizedResult: ExtractionResult = {
    rows: response.output.rows
      .map((row) => ({
        ...row,
        chartTitle: normalizeExtractedText(row.chartTitle),
        chartSection: normalizeExtractedText(row.chartSection ?? ''),
        thisWeekRank: normalizeRankText(row.thisWeekRank),
        lastWeekRank: normalizeRankText(row.lastWeekRank),
        twoWeeksAgoRank: normalizeRankText(row.twoWeeksAgoRank),
        weeksOnChart: normalizeRankText(row.weeksOnChart),
        title: normalizeExtractedText(row.title),
        artist: normalizeExtractedText(row.artist),
        label: normalizeExtractedText(row.label),
      }))
      .filter((row) => row.chartTitle && row.title && row.artist && row.label),
  };

  const rawResultJson = JSON.stringify(
    {
      object: normalizedResult,
      usage: response.totalUsage,
      warnings: response.warnings,
    },
    null,
    2,
  );

  return { result: normalizedResult, rawResultJson };
}

export async function extractMissingChartRows(args: {
  image: Buffer;
  mimeType: string;
  model: string;
  missing: MissingChartGroup[];
  abortSignal?: AbortSignal;
}): Promise<{ result: ExtractionResult; rawResultJson: string }> {
  const systemPrompt = [
    'You are a high-precision OCR + table extraction engine for scanned Billboard chart pages.',
    'Return only JSON that matches the provided schema (no commentary, no markdown).',
    'Never guess: if you cannot confidently read something, prefer null (for rank fields) or omit the row (for required text fields).',
    'Never mix data across different chart tables on the same page.',
  ].join('\n');

  const missingText = args.missing
    .map((g, index) => {
      const label = `${g.chartTitle || '(unknown chart)'}${g.chartSection ? ` [${g.chartSection}]` : ''}`;
      const missingRanks = formatRankRanges(g.missingThisWeekRanks, { maxRanges: 60 }) || '(unknown)';
      return `${index + 1}) ${label}: extracted ${g.actualRowCount}/${g.expectedRowCount}; missing thisWeekRank ${missingRanks}`;
    })
    .join('\n');

  const userPrompt = [
    'You previously extracted chart table rows from this scanned Billboard page, but some rows were missed. Base their location off of the ranks you can clearly read, and the chart titles/sections they belong to.',
    '',
    'Task: find the missing rows and output ONLY those missing rows.',
    '',
    'Rules:',
    '- Output ONLY missing rows; do not repeat already-extracted ranks.',
    '- Each output row must include the correct chartTitle and chartSection for its chart block.',
    '- Never guess: if you cannot confidently read a missing row, omit it.',
    '',
    'Missing rows to find:',
    missingText,
    '',
    'Return only valid JSON.',
  ].join('\n');

  const response = await generateText({
    model: google(args.model),
    output: Output.object({
      schema: zodSchema(ExtractionSchema),
      name: 'billboard_missing_chart_rows',
      description: 'Missing extracted chart rows from scanned Billboard chart tables.',
    }),
    abortSignal: args.abortSignal,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image', image: args.image, mediaType: args.mimeType },
        ],
      },
    ],
  });

  const normalizedResult: ExtractionResult = {
    rows: response.output.rows
      .map((row) => ({
        ...row,
        chartTitle: normalizeExtractedText(row.chartTitle),
        chartSection: normalizeExtractedText(row.chartSection ?? ''),
        thisWeekRank: normalizeRankText(row.thisWeekRank),
        lastWeekRank: normalizeRankText(row.lastWeekRank),
        twoWeeksAgoRank: normalizeRankText(row.twoWeeksAgoRank),
        weeksOnChart: normalizeRankText(row.weeksOnChart),
        title: normalizeExtractedText(row.title),
        artist: normalizeExtractedText(row.artist),
        label: normalizeExtractedText(row.label),
      }))
      .filter((row) => row.chartTitle && row.title && row.artist && row.label),
  };

  const rawResultJson = JSON.stringify(
    {
      object: normalizedResult,
      usage: response.totalUsage,
      warnings: response.warnings,
    },
    null,
    2,
  );

  return { result: normalizedResult, rawResultJson };
}
