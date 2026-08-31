/**
 * Absolute calendar date in the local timezone, `yyyy-MM-dd`. Used where a
 * precise date matters (hover details) instead of a relative "3d ago".
 */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
