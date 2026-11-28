/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// What both terminals share in drawing the Mods' band above the prompt: its
// input, and the parts of a tree that read the same in Ink and OpenTUI.

import type {
  ModBandInput,
  ModRenderNode,
  ModRenderProps,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import {
  getCachedStringWidth,
  sanitizeTerminalText,
  stripUnsafeCharacters,
} from './textUtils.js';

/** The columns Claude Code keeps beside the band for its collapse mark. */
export const MOD_BAND_RESERVED_COLUMNS = 5;

/** The rows the band may take: a third of the terminal's, at least one. */
export function modBandMaxRows(rows: number): number {
  return Math.max(1, Math.floor(rows / 3));
}

/** The band's `ui.render` input, as Claude Code gives it. */
export function modBandInput(terminal: {
  columns: number;
  rows: number;
  isFullscreen: boolean;
  hasSurvey: boolean;
  isWorking: boolean;
}): ModBandInput {
  const maxRows = modBandMaxRows(terminal.rows);
  return {
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    viewport: {
      columns: terminal.columns,
      rows: terminal.rows,
      isFullscreen: terminal.isFullscreen,
    },
    props: {
      hasSurvey: terminal.hasSurvey,
      isWorking: terminal.isWorking,
      maxRows,
      bodyColumns: Math.max(0, terminal.columns - MOD_BAND_RESERVED_COLUMNS),
      scroll: { offset: 0, bodyRows: Math.max(0, maxRows - 1) },
      view: {},
    },
  };
}

// Spacing steps as cells across and down.
const STEPS: Record<string, [number, number]> = {
  xs: [1, 0],
  sm: [1, 0],
  md: [2, 1],
  lg: [3, 1],
  xl: [4, 2],
};
const ACROSS = new Set([
  'columnGap',
  'marginX',
  'marginLeft',
  'marginRight',
  'paddingX',
  'paddingLeft',
  'paddingRight',
]);
// A step on every side splits into its two axes.
const BOTH: Record<string, [string, string]> = {
  gap: ['columnGap', 'rowGap'],
  margin: ['marginX', 'marginY'],
  padding: ['paddingX', 'paddingY'],
};
// The props each renderer reads its own way, and those a terminal ignores:
// it is always monospaced, and cuts what would scroll sideways.
const STYLED = new Set([
  'key',
  'borderStyle',
  'borderColor',
  'borderDimColor',
  'backgroundColor',
  'overflowX',
  'mono',
]);

/** A Box's layout props, its spacing steps turned into cells. */
export function modBandLayout(props: ModRenderProps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (STYLED.has(name)) continue;
    const step = typeof value === 'string' ? STEPS[value] : undefined;
    if (step && BOTH[name]) {
      // An axis the tree also sets keeps its own value.
      const [across, down] = BOTH[name];
      out[across] ??= step[0];
      out[down] ??= step[1];
    } else if (step) out[name] = ACROSS.has(name) ? step[0] : step[1];
    else out[name] = value;
  }
  return out;
}

export interface ModBandBorder {
  topLeft: string;
  top: string;
  topRight: string;
  right: string;
  bottomRight: string;
  bottom: string;
  bottomLeft: string;
  left: string;
}

/** Claude Code's own border styles, beside the ones Ink names. */
export const MOD_BAND_BORDERS: Readonly<Record<string, ModBandBorder>> = {
  dashed: {
    topLeft: ' ',
    top: '╌',
    topRight: ' ',
    right: '╎',
    bottomRight: ' ',
    bottom: '╌',
    bottomLeft: ' ',
    left: '╎',
  },
  quote: {
    topLeft: ' ',
    top: ' ',
    topRight: ' ',
    right: ' ',
    bottomRight: ' ',
    bottom: ' ',
    bottomLeft: ' ',
    left: '▎',
  },
};

/** The colors Claude Code's theme keys follow in a terminal's theme. */
export interface ModBandPalette {
  text: string;
  subtle: string;
  success: string;
  error: string;
  warning: string;
  accent: string;
}

// Claude Code's theme keys that have no counterpart here yet.
const UNMAPPED_KEYS = new Set([
  'inverseText',
  'remember',
  'merged',
  'permission',
  'planMode',
  'autoAccept',
  'promptBorder',
  'bashBorder',
  'ide',
  'diffAdded',
  'diffRemoved',
  'diffAddedDimmed',
  'diffRemovedDimmed',
  'diffAddedWord',
  'diffRemovedWord',
]);
// Ink calls any name chalk holds, so only its colors pass by name. chalk has
// gray and grey but no bright form of either.
const NAMED = new Set([
  'gray',
  'grey',
  ...[
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
  ].flatMap((name) => [name, `${name}Bright`]),
]);
const CODED = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i,
  /^rgb\(\s?\d+,\s?\d+,\s?\d+\s?\)$/,
  /^ansi256\(\s?\d+\s?\)$/,
];

/**
 * A tree's color as Ink spells colors: a theme key in the palette, or an ANSI
 * name, hex, `rgb()` or `ansi256()` value; anything else draws the default.
 */
export function modBandColor(
  value: unknown,
  palette: ModBandPalette,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value) {
    case 'text':
      return palette.text;
    case 'subtle':
    case 'inactive':
      return palette.subtle;
    case 'success':
      return palette.success;
    case 'error':
      return palette.error;
    case 'warning':
      return palette.warning;
    case 'claude':
    case 'suggestion':
      return palette.accent;
    default:
      return !UNMAPPED_KEYS.has(value) &&
        (NAMED.has(value) || CODED.some((pattern) => pattern.test(value)))
        ? value
        : undefined;
  }
}

/** Whether a Text draws bold, by `bold` or by weight. */
export function modBandBold(props: ModRenderProps): boolean {
  const weight = props['weight'];
  return props['bold'] === true || weight === 'semibold' || weight === 'bold';
}

/**
 * A Text's wrap, its `end` and `middle` aliases spelled out. `clip` draws an
 * ellipsis here as at its end; so does a Text inside a Box that would scroll
 * sideways, and a one-row `maxLines`, unless the Text already cuts.
 */
export function modBandWrap(
  props: ModRenderProps,
  inScroller: boolean,
): string | undefined {
  const wrap = props['wrap'];
  if (typeof wrap === 'string' && wrap !== 'wrap')
    return wrap === 'end' || wrap === 'middle' || wrap === 'clip'
      ? `truncate-${wrap === 'clip' ? 'end' : wrap}`
      : wrap;
  if (inScroller || props['maxLines'] === 1) return 'truncate-end';
  return typeof wrap === 'string' ? wrap : undefined;
}

/** The rows a Text may take, or nothing where it takes what it needs. */
export function modBandMaxLines(
  props: ModRenderProps,
  inScroller: boolean,
): number | undefined {
  const lines = props['maxLines'];
  return !inScroller && typeof lines === 'number' && lines >= 1
    ? lines
    : undefined;
}

/**
 * Whether a Box cuts its Texts at its edge instead of scrolling them: one that
 * would scroll, or one inside it that keeps no width of its own.
 */
export function modBandScrolls(
  props: ModRenderProps,
  inScroller: boolean,
): boolean {
  return (
    props['overflowX'] === 'scroll' ||
    (inScroller && props['width'] === undefined)
  );
}

const PROGRESS_CELLS = 10;

/**
 * A Progress as the band draws it: its label, a bar of cells filled to its
 * fraction, and the figure after it; a task with no known end has no bar.
 */
export function modBandProgress(props: ModRenderProps): {
  label: string;
  bar?: { filled: number; empty: number };
  figure?: string;
} {
  const label = cleanModBandText(String(props['label'] ?? ''));
  const value = props['value'];
  const max = props['max'] ?? 1;
  const known =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    typeof max === 'number' &&
    Number.isFinite(max) &&
    max > 0;
  const fraction = known ? Math.min(1, Math.max(0, value / max)) : undefined;
  const text = props['valueText'];
  const figure =
    typeof text === 'string'
      ? cleanModBandText(text)
      : fraction !== undefined
        ? `${Math.round(fraction * 100)}%`
        : undefined;
  if (fraction === undefined) return { label, figure };
  const filled = Math.round(fraction * PROGRESS_CELLS);
  return {
    label,
    bar: { filled, empty: PROGRESS_CELLS - filled },
    figure,
  };
}

// Ink measures a tab as no columns while the terminal moves to the next
// stop, so tabs become spaces to 8-column stops, as Claude Code's Ink does.
function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  let column = 0;
  return text
    .split(/(\t|\n)/)
    .map((part) => {
      if (part === '\t') {
        const spaces = 8 - (column % 8);
        column += spaces;
        return ' '.repeat(spaces);
      }
      column = part === '\n' ? 0 : column + getCachedStringWidth(part);
      return part;
    })
    .join('');
}

/** Text as the terminal may draw it, as Mod transcript lines are cleaned. */
export function cleanModBandText(text: string): string {
  return expandTabs(sanitizeTerminalText(stripUnsafeCharacters(text)));
}

/**
 * The React keys of a node's children: a Box keeps its own key, and one its
 * siblings already took falls back to the position.
 */
export function modBandChildKeys(children: readonly ModRenderNode[]): string[] {
  const seen = new Set<string>();
  return children.map((child, index) => {
    const own =
      typeof child !== 'string' && child.type === 'Box'
        ? child.props?.['key']
        : undefined;
    if (typeof own !== 'string' || seen.has(own)) return String(index);
    seen.add(own);
    return `k${own}`;
  });
}
