const ENTRY_DATE_REGEX = /(\d{4}-\d{2}-\d{2})/;

export function parseEntryDate(filename: string): string | null {
  const match = filename.match(ENTRY_DATE_REGEX);
  return match ? match[1] : null;
}
