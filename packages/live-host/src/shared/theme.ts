export const LIVE_THEMES = ['system', 'light', 'dark'] as const;
export type LiveTheme = (typeof LIVE_THEMES)[number];
export type ResolvedTheme = 'light' | 'dark';
export function isLiveTheme(value: unknown): value is LiveTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

export const LIVE_THEME_COLORS = [
  'iris',
  'clay',
  'sage',
  'tide',
  'graphite',
  'rose',
  'berry',
] as const;
export type LiveThemeColor = (typeof LIVE_THEME_COLORS)[number];
export function isLiveThemeColor(value: unknown): value is LiveThemeColor {
  return (
    typeof value === 'string' &&
    LIVE_THEME_COLORS.some((color) => color === value)
  );
}
