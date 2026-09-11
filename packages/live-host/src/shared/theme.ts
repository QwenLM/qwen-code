export const LIVE_THEMES = ['system', 'light', 'dark'] as const;
export type LiveTheme = (typeof LIVE_THEMES)[number];
export type ResolvedTheme = 'light' | 'dark';
export function isLiveTheme(value: unknown): value is LiveTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}
