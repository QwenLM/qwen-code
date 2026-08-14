/**
 * Theme support: detect the terminal's light/dark mode via OSC 10/11
 * (opentui `waitForThemeMode`), subscribe to live changes (`theme_mode`),
 * and swap the palette. POC previously hard-coded a dark palette, which is
 * invisible on light terminal themes (Warp light, etc.).
 */
import { SyntaxStyle } from '@opentui/core';

export interface Palette {
  text: string;
  dim: string;
  accent: string;
  green: string;
  red: string;
  yellow: string;
  purple: string;
  hover: string;
  /** Mode background; lets selection colors keep contrast on light themes. */
  bg?: string;
  selectionBg?: string;
  selectionFg?: string;
}

// Hex values mirror the original qwen-code default themes (themes/theme.ts):
// dark = Catppuccin-like, light = original light palette.
const DARK: Palette = {
  text: '#CDD6F4',
  dim: '#6C7086',
  accent: '#CBA6F7',
  green: '#A6E3A1',
  red: '#F38BA8',
  yellow: '#F9E2AF',
  purple: '#89B4FA',
  hover: '#313244',
  // No bg on dark: the default invert selection (bg=text fg, fg=black) is
  // readable on dark terminals, and leaving bg unset keeps transparency.
  selectionBg: '#264F78',
  selectionFg: '#FFFFFF',
};

const LIGHT: Palette = {
  text: '#1F2328',
  dim: '#97a0b0',
  accent: '#8B5CF6',
  green: '#3CA84B',
  red: '#DD4C4C',
  yellow: '#D5A40A',
  purple: '#3B82F6',
  hover: '#E6E9EF',
  // Light: paint the markdown block with the original light theme's
  // Background so opentui's invert-selection (fg→bg swap) stays readable —
  // with an undefined cell bg the fallback selection fg is black-on-black.
  bg: '#FAFAFA',
  selectionBg: '#ADD6FF',
  selectionFg: '#1F2328',
};

/** Mutable palette object — components read `C.x` at render time;
 *  `applyThemeMode` mutates it and a React re-render picks it up. */
export const C: Palette = { ...DARK };

function buildSyntax(mode: 'dark' | 'light'): SyntaxStyle {
  return mode === 'light'
    ? SyntaxStyle.fromStyles({
        // `default` colors unstyled markdown chunks (table cells, plain
        // inline text); without it TextTable falls back to #FFFFFF.
        default: { fg: '#1f2328' },
        keyword: { fg: '#cf222e', bold: true },
        string: { fg: '#0a3069' },
        comment: { fg: '#59636e', italic: true },
        function: { fg: '#8250df' },
        type: { fg: '#953800' },
        number: { fg: '#0550ae' },
        operator: { fg: '#0550ae' },
        variable: { fg: '#1f2328' },
        heading: { fg: '#0550ae', bold: true },
        emphasis: { italic: true },
        strong: { bold: true },
        link: { fg: '#0969da' },
        code: { fg: '#0a3069' },
      })
    : SyntaxStyle.fromStyles({
        default: { fg: '#e6edf3' },
        keyword: { fg: '#bb9af7', bold: true },
        string: { fg: '#9ece6a' },
        comment: { fg: '#565f89', italic: true },
        function: { fg: '#7aa2f7' },
        type: { fg: '#e0af68' },
        number: { fg: '#ff9e64' },
        operator: { fg: '#89ddff' },
        variable: { fg: '#e6edf3' },
        heading: { fg: '#7aa2f7', bold: true },
        emphasis: { italic: true },
        strong: { bold: true },
        link: { fg: '#7aa2f7' },
        code: { fg: '#9ece6a' },
      });
}

/** Mutable syntax style — rebuilt on theme change. */
export let SYNTAX: SyntaxStyle = buildSyntax('dark');

export function applyThemeMode(
  mode: 'dark' | 'light' | null | undefined,
): void {
  const m = mode === 'light' ? 'light' : 'dark';
  Object.assign(C, m === 'light' ? LIGHT : DARK);
  SYNTAX = buildSyntax(m);
}
