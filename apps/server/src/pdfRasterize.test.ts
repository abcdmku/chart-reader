import { describe, expect, it } from 'vitest';

import { scorePdfTextForChartPicker } from './pdfRasterize';

function makeRanks(maxRank: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= maxRank; i += 1) parts.push(String(i));
  return parts.join(' ');
}

describe('scorePdfTextForChartPicker', () => {
  it('prioritizes DISCO/DANCE chart pages when present', () => {
    const hot100 = [
      'BILLBOARD',
      'HOT 100',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(100),
    ].join(' ');

    const danceDisco = [
      'BILLBOARD',
      'HOT DANCE/DISCO',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(80),
    ].join(' ');

    const scoredHot100 = scorePdfTextForChartPicker(hot100);
    const scoredDanceDisco = scorePdfTextForChartPicker(danceDisco);

    expect(scoredDanceDisco.discoDanceBoost).toBeGreaterThan(0);
    expect(scoredDanceDisco.effectiveScore).toBeGreaterThan(scoredHot100.effectiveScore);
  });

  it('handles DISCO/DANCE header order variations', () => {
    const discoDance = [
      'BILLBOARD',
      'HOT DISCO/DANCE',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(40),
    ].join(' ');

    const scored = scorePdfTextForChartPicker(discoDance);
    expect(scored.discoDanceBoost).toBeGreaterThan(0);
  });

  it('matches HOT DANCE MUSIC/DISCO header variants', () => {
    const danceMusicDisco = [
      'BILLBOARD',
      'HOT DANCE MUSIC/DISCO',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(40),
    ].join(' ');

    const scored = scorePdfTextForChartPicker(danceMusicDisco);
    expect(scored.discoDanceBoost).toBeGreaterThan(0);
  });

  it('prioritizes DISCO TOP charts over other genre chart pages (e.g. rock)', () => {
    const rock = [
      'BILLBOARD',
      'HOT ROCK TRACKS',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(80),
    ].join(' ');

    const discoTop80 = [
      'BILLBOARD',
      'DISCO TOP 80',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(80),
    ].join(' ');

    const scoredRock = scorePdfTextForChartPicker(rock);
    const scoredDisco = scorePdfTextForChartPicker(discoTop80);

    expect(scoredDisco.discoDanceBoost).toBeGreaterThan(0);
    expect(scoredDisco.effectiveScore).toBeGreaterThan(scoredRock.effectiveScore);
  });

  it('prioritizes CLUB PLAY charts over other genre chart pages (e.g. rock)', () => {
    const rock = [
      'BILLBOARD',
      'ROCK',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(60),
    ].join(' ');

    const clubPlay = [
      'BILLBOARD',
      'HOT DANCE/DISCO',
      'CLUB PLAY',
      'THIS WEEK',
      'LAST WEEK',
      'WEEKS ON CHART',
      'ARTIST',
      'TITLE',
      'LABEL',
      'CHART',
      makeRanks(60),
    ].join(' ');

    const scoredRock = scorePdfTextForChartPicker(rock);
    const scoredClubPlay = scorePdfTextForChartPicker(clubPlay);

    expect(scoredClubPlay.discoDanceBoost).toBeGreaterThan(0);
    expect(scoredClubPlay.effectiveScore).toBeGreaterThan(scoredRock.effectiveScore);
  });

  it('does not apply DISCO/DANCE boosts to non-chart pages', () => {
    const notAChart = 'A feature article about dance and disco culture in the late 1970s.';
    const scored = scorePdfTextForChartPicker(notAChart);
    expect(scored.baseScore).toBeLessThan(140);
    expect(scored.discoDanceBoost).toBe(0);
  });
});
