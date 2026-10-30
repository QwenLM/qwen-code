/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI port of ink's `ModBand`: the tree the Mods' `ui.render` hooks
 * settled on for the band above the prompt, drawn with OpenTUI's box and
 * text from the same normalized tree.
 */

import {
  TextAttributes,
  borderCharsToArray,
  type BorderCharacters,
  type BoxRenderable,
  type OptimizedBuffer,
} from '@opentui/core';
import type { ReactNode } from 'react';
import type {
  ModRenderElement,
  ModRenderNode,
  ModRenderProps,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { ModBand } from '../../services/interactive-mod-session.js';
import { toHex } from '../themes/color-utils.js';
import {
  MOD_BAND_BORDERS,
  MOD_BAND_RESERVED_COLUMNS,
  cleanModBandText,
  modBandBold,
  modBandChildKeys,
  modBandColor,
  modBandLayout,
  modBandWrap,
  type ModBandBorder,
  type ModBandPalette,
} from '../utils/mod-band-tree.js';
import { OpenTuiErrorBoundary } from './opentui-error-boundary.js';
import { C } from './theme.js';

const logger = createDebugLogger('MODS');

// The theme keys follow OpenTUI's active palette.
const palette = (): ModBandPalette => ({
  text: C.text,
  subtle: C.dim,
  success: C.green,
  error: C.red,
  warning: C.yellow,
  accent: C.accent,
});

// ansi256's first sixteen are the ANSI colors, then a cube and a gray ramp.
const ANSI16 = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];
const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (...rgb: number[]) =>
  `#${rgb.map((value) => Math.min(255, value).toString(16).padStart(2, '0')).join('')}`;

/** An Ink color as OpenTUI takes it: a hex value. */
export function openTuiColor(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  const rgb = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/.exec(color);
  if (rgb) return hex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const indexed = /^ansi256\(\s?(\d+)\s?\)$/.exec(color);
  if (indexed) {
    const n = Math.min(255, Number(indexed[1]));
    if (n < 16) return toHex(n < 8 ? ANSI16[n] : `${ANSI16[n - 8]}Bright`);
    if (n >= 232) {
      const gray = 8 + 10 * (n - 232);
      return hex(gray, gray, gray);
    }
    const cube = n - 16;
    return hex(
      CUBE[Math.floor(cube / 36)],
      CUBE[Math.floor(cube / 6) % 6],
      CUBE[cube % 6],
    );
  }
  return toHex(color);
}

const color = (value: unknown) => openTuiColor(modBandColor(value, palette()));

// OpenTUI draws one horizontal and one vertical stroke per border.
const chars = (border: ModBandBorder): BorderCharacters => ({
  topLeft: border.topLeft,
  topRight: border.topRight,
  bottomLeft: border.bottomLeft,
  bottomRight: border.bottomRight,
  horizontal: border.top,
  vertical: border.left,
  topT: border.top,
  bottomT: border.bottom,
  leftT: border.left,
  rightT: border.right,
  cross: border.top,
});
const NAMED_BORDERS: Record<string, 'single' | 'double' | 'rounded' | 'heavy'> =
  { single: 'single', double: 'double', round: 'rounded', bold: 'heavy' };
// Ink's other styles, as cli-boxes draws them. `arrow` points its edges
// inward, which one stroke per axis cannot: its top and left arrows go all
// round.
const DRAWN_BORDERS: Record<string, ModBandBorder> = {
  ...MOD_BAND_BORDERS,
  singleDouble: {
    topLeft: '╓',
    top: '─',
    topRight: '╖',
    right: '║',
    bottomRight: '╜',
    bottom: '─',
    bottomLeft: '╙',
    left: '║',
  },
  doubleSingle: {
    topLeft: '╒',
    top: '═',
    topRight: '╕',
    right: '│',
    bottomRight: '╛',
    bottom: '═',
    bottomLeft: '╘',
    left: '│',
  },
  classic: {
    topLeft: '+',
    top: '-',
    topRight: '+',
    right: '|',
    bottomRight: '+',
    bottom: '-',
    bottomLeft: '+',
    left: '|',
  },
  arrow: {
    topLeft: '↘',
    top: '↓',
    topRight: '↙',
    right: '←',
    bottomRight: '↖',
    bottom: '↑',
    bottomLeft: '↗',
    left: '→',
  },
};

type BorderSide = 'top' | 'right' | 'bottom' | 'left';
const SIDES: readonly BorderSide[] = ['top', 'right', 'bottom', 'left'];
const hasSide = (border: unknown, side: BorderSide) =>
  border === true || (Array.isArray(border) && border.includes(side));

/** A laid-out box, as far as its clipping reads it. */
export interface PlacedBox {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  border?: unknown;
  overflow?: string;
  parent: PlacedBox | null;
}

/**
 * A bordered box's rectangle within the boxes that clip it, and the sides of
 * its border left in view; nothing when it is clipped away.
 */
export function clipBorder(
  box: PlacedBox,
):
  | { x: number; y: number; width: number; height: number; sides: BorderSide[] }
  | undefined {
  let left = box.screenX;
  let top = box.screenY;
  let right = left + box.width;
  let bottom = top + box.height;
  for (let node = box.parent; node; node = node.parent) {
    if (node.overflow === undefined || node.overflow === 'visible') continue;
    // A bordered box clips within its border.
    const inset = (side: BorderSide) => (hasSide(node.border, side) ? 1 : 0);
    left = Math.max(left, node.screenX + inset('left'));
    top = Math.max(top, node.screenY + inset('top'));
    right = Math.min(right, node.screenX + node.width - inset('right'));
    bottom = Math.min(bottom, node.screenY + node.height - inset('bottom'));
  }
  if (right <= left || bottom <= top) return undefined;
  const shown: Record<BorderSide, boolean> = {
    top: top === box.screenY,
    right: right === box.screenX + box.width,
    bottom: bottom === box.screenY + box.height,
    left: left === box.screenX,
  };
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    sides: SIDES.filter((side) => hasSide(box.border, side) && shown[side]),
  };
}

// OpenTUI clips a box's fill to the boxes around it but not its border, so a
// bordered box taller than the band would draw over the prompt. The border is
// drawn within them instead, without the sides they cut off, as Ink clips it.
function drawClippedBox(this: BoxRenderable, buffer: OptimizedBuffer): void {
  const clipped = clipBorder(this);
  if (!clipped) return;
  const { sides, ...rect } = clipped;
  const custom = this.customBorderChars;
  buffer.drawBox({
    ...rect,
    border: sides,
    borderStyle: this.borderStyle,
    customBorderChars: custom && borderCharsToArray(custom),
    borderColor: this.borderColor,
    backgroundColor: this.backgroundColor,
    shouldFill: this.shouldFill,
  });
}

function boxProps(props: ModRenderProps): Record<string, unknown> {
  // Ink lays a Box out in a row and lets it shrink; OpenTUI's own box stacks
  // and stops shrinking once it has a width or height.
  const out: Record<string, unknown> = {
    flexDirection: 'row',
    flexShrink: 1,
    ...modBandLayout(props),
  };
  if (out['display'] === 'none') out['visible'] = false;
  delete out['display'];
  const background = color(props['backgroundColor']);
  if (background) out['backgroundColor'] = background;
  const style = props['borderStyle'];
  if (typeof style !== 'string') return out;
  // An uncolored border takes the text color, as Ink leaves it to the
  // terminal's; OpenTUI's own default is white.
  out['borderColor'] =
    color(props['borderColor']) ??
    (props['borderDimColor'] === true ? C.dim : C.text);
  if (NAMED_BORDERS[style]) {
    out['border'] = true;
    out['borderStyle'] = NAMED_BORDERS[style];
  } else if (style === 'quote') {
    // Its only stroke is on the left, beside the content rows; the other
    // sides keep a blank cell, as Ink draws them.
    out['border'] = ['left'];
    out['customBorderChars'] = chars(DRAWN_BORDERS['quote']);
    const side = (name: string, axis: string, all: string) =>
      Number(out[name] ?? out[axis] ?? out[all] ?? 0) + 1;
    out['marginTop'] = side('marginTop', 'marginY', 'margin');
    out['marginBottom'] = side('marginBottom', 'marginY', 'margin');
    out['paddingRight'] = side('paddingRight', 'paddingX', 'padding');
    // Ink's blank top and bottom sit within the height; these margins do not.
    for (const name of ['height', 'minHeight']) {
      const value = out[name];
      if (typeof value === 'number') out[name] = Math.max(0, value - 2);
    }
  } else if (DRAWN_BORDERS[style]) {
    out['border'] = true;
    out['customBorderChars'] = chars(DRAWN_BORDERS[style]);
  }
  if (out['border']) out['renderSelf'] = drawClippedBox;
  return out;
}

// A span inherits its text's color; a text without one takes the theme's, as
// Ink leaves it to the terminal's, where OpenTUI's own default is white.
function textProps(
  props: ModRenderProps,
  inText: boolean,
): Record<string, unknown> {
  let attributes = TextAttributes.NONE;
  if (modBandBold(props)) attributes |= TextAttributes.BOLD;
  if (props['dimColor'] === true) attributes |= TextAttributes.DIM;
  if (props['italic'] === true) attributes |= TextAttributes.ITALIC;
  if (props['underline'] === true) attributes |= TextAttributes.UNDERLINE;
  if (props['strikethrough'] === true)
    attributes |= TextAttributes.STRIKETHROUGH;
  if (props['inverse'] === true) attributes |= TextAttributes.INVERSE;
  return {
    fg: color(props['color']) ?? (inText ? undefined : C.text),
    bg: color(props['backgroundColor']),
    attributes,
  };
}

const textOf = (node: ModRenderNode): string =>
  typeof node === 'string'
    ? node
    : node.type === 'engine'
      ? ''
      : (node.children ?? []).map(textOf).join('');

// Ink measures a Text with nothing to draw as no rows, where OpenTUI's text
// takes one; an empty box keeps its place in the layout.
const emptyText = (key: string) => <box key={key} width={0} height={0} />;

function drawNode(
  node: ModRenderNode,
  key: string,
  inText: boolean,
): ReactNode {
  if (typeof node === 'string') {
    const text = cleanModBandText(node);
    if (inText) return text;
    return text ? (
      <text key={key} fg={C.text}>
        {text}
      </text>
    ) : (
      emptyText(key)
    );
  }
  if (node.type === 'engine') return null;
  const props = node.props ?? {};
  const kids = node.children ?? [];
  const keys = modBandChildKeys(kids);
  const children = kids.map((child, index) =>
    drawNode(child, keys[index], node.type === 'Text'),
  );
  if (node.type === 'Box')
    return (
      <box key={key} {...boxProps(props)}>
        {children}
      </box>
    );
  // A Text within a Text is a span of it.
  if (inText)
    return (
      <span key={key} {...textProps(props, true)}>
        {children}
      </span>
    );
  if (!cleanModBandText(textOf(node))) return emptyText(key);
  // OpenTUI truncates in the middle; Ink's other truncations clip.
  const wrap = modBandWrap(props);
  const truncation: { wrapMode?: 'none'; truncate?: true } =
    wrap === 'truncate-middle'
      ? { wrapMode: 'none', truncate: true }
      : wrap !== undefined && wrap !== 'wrap'
        ? { wrapMode: 'none' }
        : {};
  return (
    <text key={key} {...textProps(props, false)} {...truncation}>
      {children}
    </text>
  );
}

/** Draws a tree the runtime accepted, as Claude Code's terminal draws it. */
export function drawOpenTuiModTree(tree: ModRenderElement): ReactNode {
  return drawNode(tree, 'root', false);
}

export interface OpenTuiModBandProps {
  band: ModBand | undefined;
  maxRows: number;
}

/**
 * The band above the prompt, clipped to `maxRows`. A tree that throws while
 * drawn shows nothing, and the next answer is drawn afresh.
 */
export const OpenTuiModBand = ({ band, maxRows }: OpenTuiModBandProps) => {
  if (!band) return null;
  return (
    <OpenTuiErrorBoundary
      key={band.revision}
      fallback={() => null}
      onError={(error) =>
        logger.debug(
          `${band.owner}: ui.render (AbovePrompt) threw while drawn: ${error.message}; nothing was drawn`,
        )
      }
    >
      <box
        flexDirection="column"
        flexShrink={0}
        maxHeight={maxRows}
        overflow="hidden"
      >
        <box
          flexDirection="column"
          flexShrink={0}
          marginRight={MOD_BAND_RESERVED_COLUMNS}
        >
          {drawOpenTuiModTree(band.tree)}
        </box>
      </box>
    </OpenTuiErrorBoundary>
  );
};
