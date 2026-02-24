export function coerceRank(value: unknown): number | null {
  if (value == null) return null;
  const asString = String(value).trim();
  if (!asString) return null;

  const digits = asString.replaceAll(/[^0-9]/g, '');
  if (!digits) return null;

  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

