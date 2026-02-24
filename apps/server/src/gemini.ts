import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { ExtractionResult } from './types.js';

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
}): Promise<{ result: ExtractionResult; rawResultJson: string }> {
  const prompt = [
    'You are extracting tabular chart data from a scanned Billboard chart image.',
    '',
    'Goal: return a JSON object with `rows` (an array). Each row represents one entry on a chart.',
    '',
    'The image can contain:',
    '- a single chart block, or',
    '- two different chart blocks (different chart titles), or',
    '- one chart split into sections (e.g. "TOP 80" and "TOP 100").',
    '',
    'For every extracted row, include:',
    '- chartTitle: the overall chart title for the block (e.g. "12 INCH SINGLES SALES", "CLUB PLAY")',
    '- chartSection: the section/sub-chart heading (e.g. "TOP 80", "TOP 100") or empty string if none',
    '- thisWeekRank, lastWeekRank, twoWeeksAgoRank, weeksOnChart: as text (may be blank/null if unreadable)',
    '- title, artist, label: as printed in the chart',
    '',
    'Rules:',
    '- Do not invent values. If unreadable, use null or empty string.',
    '- Preserve row order as it appears in the image within each chart block/section.',
    '- Only return valid JSON matching the schema.',
  ].join('\n');

  const response = await generateObject({
    model: google(args.model),
    schema: ExtractionSchema,
    messages: [
      { role: 'system', content: 'You are a careful data extraction engine.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image: args.image, mimeType: args.mimeType },
        ],
      },
    ],
  });

  const rawResultJson = JSON.stringify(
    {
      object: response.object,
      usage: response.usage,
      warnings: response.warnings,
    },
    null,
    2,
  );

  return { result: response.object, rawResultJson };
}
