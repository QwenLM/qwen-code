import type { ResolvedTheme, LiveThemeColor } from '../shared/theme.ts';

export function applyTheme(
  document: Document,
  theme: ResolvedTheme = 'dark',
  themeColor: LiveThemeColor = 'iris',
): void {
  if (document.documentElement.dataset.themeColor !== themeColor)
    document.documentElement.dataset.themeColor = themeColor;
  if (document.documentElement.dataset.theme !== theme)
    document.documentElement.dataset.theme = theme;
}
