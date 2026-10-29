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
  MOD_BAND_BORDERS,
  MOD_BAND_RESERVED_COLUMNS,
  cleanModBandText,
  modBandBold,
  modBandChildKeys,
  modBandColor,
  modBandLayout,
  modBandWrap,
  type ModBandPalette,
} from '../utils/mod-band-tree.js';
import { ErrorBoundary } from './shared/ErrorBoundary.js';

const logger = createDebugLogger('MODS');

// Ink's border styles by name, and Claude Code's own beside them.
const BORDERS: Record<string, BoxProps['borderStyle']> = MOD_BAND_BORDERS;

// The theme keys follow Ink's active theme.
const palette = (): ModBandPalette => ({
  text: theme.text.primary,
  subtle: theme.text.secondary,
  success: theme.status.success,
  error: theme.status.error,
  warning: theme.status.warning,
  accent: theme.text.accent,
});

function boxProps(props: ModRenderProps): BoxProps {
  const colors = palette();
  const style = props['borderStyle'];
  return {
    ...modBandLayout(props),
    ...(typeof style === 'string' && {
      borderStyle: BORDERS[style] ?? (style as BoxProps['borderStyle']),
    }),
    ...(props['borderColor'] !== undefined && {
      borderColor: modBandColor(props['borderColor'], colors),
    }),
    ...(props['borderDimColor'] !== undefined && {
      borderDimColor: props['borderDimColor'] === true,
    }),
    ...(props['backgroundColor'] !== undefined && {
      backgroundColor: modBandColor(props['backgroundColor'], colors),
    }),
  } as BoxProps;
}

function textProps(props: ModRenderProps): TextProps {
  const colors = palette();
  const wrap = modBandWrap(props);
  return {
    color: modBandColor(props['color'], colors),
    backgroundColor: modBandColor(props['backgroundColor'], colors),
    dimColor: props['dimColor'] === true,
    bold: modBandBold(props),
    italic: props['italic'] === true,
    underline: props['underline'] === true,
    strikethrough: props['strikethrough'] === true,
    inverse: props['inverse'] === true,
    ...(wrap !== undefined && { wrap: wrap as TextProps['wrap'] }),
  };
}

function drawNode(
  node: ModRenderNode,
  key: string,
  inText: boolean,
): ReactNode {
  if (typeof node === 'string')
    return inText ? (
      cleanModBandText(node)
    ) : (
      <Text key={key}>{cleanModBandText(node)}</Text>
    );
  if (node.type === 'engine') return null;
  const props = node.props ?? {};
  const kids = node.children ?? [];
  const keys = modBandChildKeys(kids);
  const children = kids.map((child, index) =>
    drawNode(child, keys[index], node.type === 'Text'),
  );
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
