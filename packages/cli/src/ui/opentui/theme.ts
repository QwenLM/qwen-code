/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Theme support: detect the terminal's light/dark mode via OSC 10/11
 * (opentui `waitForThemeMode`), subscribe to live changes (`theme_mode`),
 * and swap the palette. POC previously hard-coded a dark palette, which is
 * invisible on light terminal themes (Warp light, etc.).
 *
 * Named-theme support (settings `ui.theme` / `/theme`) layers on top through
 * `applyOpenTuiTheme`, which maps one of the ink themes (via theme-parity)
 * onto the mutable `C` palette and `SYNTAX` token map.
 */
import { SyntaxStyle, type StyleDefinitionInput } from '@opentui/core';
import type { OpenTuiThemeDefinition } from './theme-parity.js';
import { toHex } from '../themes/color-utils.js';

export interface Palette {
  text: string;
  dim: string;
  accent: string;
  green: string;
  red: string;
  yellow: string;
  /** ink `status.warningDim` / `status.errorDim` — the approval-mode chrome. */
  warningDim: string;
  errorDim: string;
  purple: string;
  /** ink `ui.symbol` — the shell-mode status color. */
  symbol: string;
  /** ink `border.focused` / `border.default` — the composer outline. */
  borderFocused: string;
  borderDefault: string;
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
  warningDim: '#8B7530',
  errorDim: '#8B3A4A',
  purple: '#89B4FA',
  symbol: '#89DCEB',
  borderFocused: '#89B4FA',
  borderDefault: '#6C7086',
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
  warningDim: '#8B7000',
  errorDim: '#993333',
  purple: '#3B82F6',
  symbol: '#06B6D4',
  borderFocused: '#3B82F6',
  borderDefault: '#97a0b0',
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

function buildSyntax(
  mode: 'dark' | 'light',
): Record<string, StyleDefinitionInput> {
  const styles =
    mode === 'light'
      ? {
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
        }
      : {
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
        };
  return {
    ...styles,
    ...markdownMarkupTokens(mode),
  };
}

/**
 * The OpenTUI markdown renderable styles inline structure and headings with
 * tree-sitter `markup.*` captures (not the `emphasis`/`strong`/`code`/…
 * token names used for fenced code). Without these entries headings render
 * unstyled and inline code / emphasis / links lose their formatting, so the
 * mapped names mirror the markdown / markdown_inline `highlights.scm`
 * captures: `markup.heading[.N]`, `markup.raw`, `markup.italic`,
 * `markup.strong`, `markup.link[.url|.label]`.
 */
export function markdownMarkupTokens(
  mode: 'dark' | 'light',
): Record<
  string,
  { fg?: string; bold?: boolean; italic?: boolean; underline?: boolean }
> {
  const heading = mode === 'light' ? '#0550ae' : '#7aa2f7';
  const inlineCode = mode === 'light' ? '#0a3069' : '#9ece6a';
  const link = mode === 'light' ? '#0969da' : '#7aa2f7';
  const headingStyle = { fg: heading, bold: true };
  return {
    'markup.heading': headingStyle,
    'markup.heading.1': headingStyle,
    'markup.heading.2': headingStyle,
    'markup.heading.3': headingStyle,
    'markup.heading.4': headingStyle,
    'markup.heading.5': headingStyle,
    'markup.heading.6': headingStyle,
    'markup.raw': { fg: inlineCode },
    'markup.italic': { italic: true },
    'markup.strong': { bold: true },
    'markup.link': { fg: link },
    'markup.link.label': { fg: link },
    'markup.link.url': { fg: link, underline: true },
  };
}

/** Mutable syntax styles — rebuilt on theme change. */
export let SYNTAX: SyntaxStyle;

/**
 * The thought-body variant. ink renders it through MarkdownDisplay with
 * `textColor={theme.text.secondary}`, which paints its plain text *and* its
 * headings — only inline code and links keep their own colors. OpenTUI's
 * `default` token colors plain inline text and wins over the element's `fg`
 * prop, so the dimmed body needs its own token map. A theme that omits
 * `default` (NoColor) keeps it omitted, as ink leaves that text uncolored.
 */
export let SYNTAX_DIM: SyntaxStyle;

function dimThoughtTokens(
  styles: Record<string, StyleDefinitionInput>,
): Record<string, StyleDefinitionInput> {
  const dimmed = { ...styles };
  for (const token of Object.keys(dimmed)) {
    if (token === 'default' || token.startsWith('markup.heading')) {
      dimmed[token] = { ...dimmed[token], fg: C.dim };
    }
  }
  return dimmed;
}

function setSyntax(styles: Record<string, StyleDefinitionInput>): void {
  SYNTAX = SyntaxStyle.fromStyles(styles);
  SYNTAX_DIM = SyntaxStyle.fromStyles(dimThoughtTokens(styles));
}

setSyntax(buildSyntax('dark'));

/**
 * The banner wordmark ramp — ink's `ui.gradient` for the active theme. Empty
 * means the logo renders uncolored, which is what ink does when a theme has
 * no two usable stops. Seeded with the built-in themes' `GradientColors` so
 * the first paint, before any theme is applied, already matches ink.
 */
const DEFAULT_GRADIENT = ['#4796E4', '#847ACE', '#C3677F'];

export let GRADIENT: string[] = DEFAULT_GRADIENT;

/**
 * Bumped on every repaint of the mutable palette. `C` is mutated in place and
 * neither `settings` nor `config` changes identity when `/theme` writes, so a
 * colour-bearing `useMemo` needs this as a dependency to recompute.
 */
export let THEME_REVISION = 0;

export function applyThemeMode(
  mode: 'dark' | 'light' | null | undefined,
): void {
  THEME_REVISION++;
  const m = mode === 'light' ? 'light' : 'dark';
  const surface = m === 'light' ? LIGHT : DARK;
  Object.assign(C, surface);
  // The dark surface has no `bg` (terminal transparency); Object.assign
  // never deletes keys, so a previous light `bg` must be cleared explicitly.
  C.bg = surface.bg;
  GRADIENT = DEFAULT_GRADIENT;
  setSyntax(buildSyntax(m));
}

/**
 * Applies one mapped ink theme (theme-parity `OpenTuiThemeDefinition`) — the
 * settings `ui.theme` / `/theme` path. The mapped palette carries the
 * semantic text/status colors but no opentui-only surface colors (bg /
 * selection / hover contrast), so those are re-derived from the built-in
 * dark/light surfaces based on the theme type to keep selection readable.
 *
 * Colors are resolved to #rrggbb first: opentui's parseColor recognizes only
 * a small named-color table, while ink themes accept the ~120 CSS names
 * ('coral', …) and *bright names — unresolved, they would silently degrade
 * to magenta. Unresolvable values stay unset (ink degrades similarly).
 */
export function applyOpenTuiTheme(definition: OpenTuiThemeDefinition): void {
  THEME_REVISION++;
  const light = definition.type === 'light';
  const surface = light ? LIGHT : DARK;
  // Empty-string palette values mean "no color" in ink themes (the NoColor
  // theme is all empty strings) and must stay unset like unresolvable ones.
  const palette = Object.fromEntries(
    Object.entries(definition.palette)
      .map(([key, value]) => [key, value === '' ? undefined : toHex(value)])
      .filter(([, hex]) => hex !== undefined),
  ) as Partial<Palette>;
  Object.assign(C, surface, palette);
  // The dark surface intentionally has no `bg` (keeps terminal transparency);
  // Object.assign never clears keys, so reset it explicitly.
  C.bg = surface.bg;
  // Same parseColor reason as the palette: resolve the stops to #rrggbb.
  // Fewer than two survivors means no ramp at all — ink renders the logo
  // uncolored in that case rather than painting a single stop.
  const gradient = definition.gradient
    .map((stop) => toHex(stop))
    .filter((stop): stop is string => stop !== undefined);
  GRADIENT = gradient.length >= 2 ? gradient : [];
  const syntaxStyles: Record<string, StyleDefinitionInput> = {};
  for (const [token, style] of Object.entries(definition.syntaxStyles)) {
    const resolved: StyleDefinitionInput = { ...style };
    if (typeof style.fg === 'string') {
      resolved.fg = toHex(style.fg);
      if (resolved.fg === undefined) delete resolved.fg;
    }
    if (typeof style.bg === 'string') {
      resolved.bg = toHex(style.bg);
      if (resolved.bg === undefined) delete resolved.bg;
    }
    syntaxStyles[token] = resolved;
  }
  setSyntax({
    // `default` colors unstyled markdown chunks (table cells, plain inline
    // text); anchor it on the theme's own foreground when it resolved.
    ...(palette.text ? { default: { fg: palette.text } } : {}),
    ...syntaxStyles,
    // Markdown structure tokens are not part of the ink hljs maps; keep
    // headings/inline styling alive on the theme's dark/light family.
    ...markdownMarkupTokens(light ? 'light' : 'dark'),
  });
}
