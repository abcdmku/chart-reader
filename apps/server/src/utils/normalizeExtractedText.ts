const EDGE_DECORATION_RE =
  /^[\s*\u2605\u2606\u2022\u25CF\u25CB\u25C6\u2666\u25E6\u25AA]+|[\s*\u2605\u2606\u2022\u25CF\u25CB\u25C6\u2666\u25E6\u25AA]+$/g;
const TRAILING_DASH_RE = /[\u2010\u2011\u2012\u2013\u2014\u2212-]+$/g;

export function normalizeExtractedText(value: string): string {
  let text = value.replaceAll(/\s+/g, ' ').trim();
  if (!text) return '';

  text = text.replaceAll(EDGE_DECORATION_RE, '').trim();
  text = text.replaceAll(TRAILING_DASH_RE, '').trim();
  return text;
}

export function normalizeRankText(value: string | null): string | null {
  if (value == null) return null;
  const text = normalizeExtractedText(value);
  if (!text) return null;

  if (text.toUpperCase() === 'NEW') return null;

  const digits = text.replaceAll(/[^0-9]/g, '');
  return digits ? digits : null;
}
