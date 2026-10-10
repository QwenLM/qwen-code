import type { ResolvedTheme } from '../shared/theme.ts';

export function applyTheme(
  document: Document,
  theme: ResolvedTheme = 'dark',
): void {
  if (document.documentElement.dataset.theme !== theme)
    document.documentElement.dataset.theme = theme;
}
