/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text, type BoxProps, type TextProps } from 'ink';
import type { ReactNode } from 'react';
import type {
  ModRenderElement,
  ModRenderNode,
  ModRenderProps,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { ModBand as ModBandAnswer } from '../../services/interactive-mod-session.js';
import { theme } from '../semantic-colors.js';
import {
  getCachedStringWidth,
  sanitizeTerminalText,
  stripUnsafeCharacters,
} from '../utils/textUtils.js';
import { ErrorBoundary } from './shared/ErrorBoundary.js';

const logger = createDebugLogger('MODS');

/** The columns Claude Code keeps beside the band for its collapse mark. */
export const MOD_BAND_RESERVED_COLUMNS = 5;

/** The rows the band may take: a third of the terminal's, at least one. */
export function modBandMaxRows(rows: number): number {
  return Math.max(1, Math.floor(rows / 3));
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

// Claude Code's own border styles, beside the ones Ink draws by name.
const BORDERS: Record<string, BoxProps['borderStyle']> = {
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

function color(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value) {
    case 'text':
      return theme.text.primary;
    case 'subtle':
    case 'inactive':
      return theme.text.secondary;
    case 'success':
      return theme.status.success;
    case 'error':
      return theme.status.error;
    case 'warning':
      return theme.status.warning;
    case 'claude':
    case 'suggestion':
      return theme.text.accent;
    default:
      return !UNMAPPED_KEYS.has(value) &&
        (NAMED.has(value) || CODED.some((pattern) => pattern.test(value)))
        ? value
        : undefined;
  }
}

function boxProps(props: ModRenderProps): BoxProps {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    const step = typeof value === 'string' ? STEPS[value] : undefined;
    if (name === 'key') continue;
    if (name === 'borderStyle') out[name] = BORDERS[value as string] ?? value;
    else if (name === 'borderColor' || name === 'backgroundColor')
      out[name] = color(value);
    else if (step && BOTH[name]) {
      // An axis the tree also sets keeps its own value.
      const [across, down] = BOTH[name];
      out[across] ??= step[0];
      out[down] ??= step[1];
    } else if (step) out[name] = ACROSS.has(name) ? step[0] : step[1];
    else out[name] = value;
  }
  return out as BoxProps;
}

function textProps(props: ModRenderProps): TextProps {
  const weight = props['weight'];
  const wrap = props['wrap'];
  return {
    color: color(props['color']),
    backgroundColor: color(props['backgroundColor']),
    dimColor: props['dimColor'] === true,
    bold: props['bold'] === true || weight === 'semibold' || weight === 'bold',
    italic: props['italic'] === true,
    underline: props['underline'] === true,
    strikethrough: props['strikethrough'] === true,
    inverse: props['inverse'] === true,
    ...(typeof wrap === 'string' && {
      wrap: (wrap === 'end' || wrap === 'middle'
        ? `truncate-${wrap}`
        : wrap) as TextProps['wrap'],
    }),
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

const clean = (text: string) =>
  expandTabs(sanitizeTerminalText(stripUnsafeCharacters(text)));

function drawNode(
  node: ModRenderNode,
  key: string,
  inText: boolean,
): ReactNode {
  if (typeof node === 'string')
    return inText ? clean(node) : <Text key={key}>{clean(node)}</Text>;
  if (node.type === 'engine') return null;
  const props = node.props ?? {};
  // A Box keeps its own key; a repeated one falls back to the position.
  const seen = new Set<string>();
  const children = (node.children ?? []).map((child, index) => {
    const own =
      typeof child !== 'string' && child.type === 'Box'
        ? child.props?.['key']
        : undefined;
    const fresh = typeof own === 'string' && !seen.has(own);
    if (fresh) seen.add(own);
    return drawNode(
      child,
      fresh ? `k${own}` : String(index),
      node.type === 'Text',
    );
  });
  return node.type === 'Text' ? (
    <Text key={key} {...textProps(props)}>
      {children}
    </Text>
  ) : (
    <Box key={key} {...boxProps(props)}>
      {children}
    </Box>
  );
}

/** Draws a tree the runtime accepted, as Claude Code's terminal draws it. */
export function drawModTree(tree: ModRenderElement): ReactNode {
  return drawNode(tree, 'root', false);
}

interface ModBandProps {
  band: ModBandAnswer | undefined;
  maxRows: number;
}

/**
 * The band above the prompt: the last tree the `ui.render` hooks settled on,
 * clipped to `maxRows`. A tree that throws while drawn shows nothing, and the
 * next answer is drawn afresh.
 */
export const ModBand = ({ band, maxRows }: ModBandProps) => {
  if (!band) return null;
  return (
    <ErrorBoundary
      key={band.revision}
      fallback={() => null}
      onError={(error) =>
        logger.debug(
          `${band.owner}: ui.render (AbovePrompt) threw while drawn: ${error.message}; nothing was drawn`,
        )
      }
    >
      <Box
        flexDirection="column"
        flexShrink={0}
        maxHeight={maxRows}
        overflowX="hidden"
        overflowY="hidden"
      >
        <Box
          flexDirection="column"
          flexShrink={0}
          marginRight={MOD_BAND_RESERVED_COLUMNS}
        >
          {drawModTree(band.tree)}
        </Box>
      </Box>
    </ErrorBoundary>
  );
};
