/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * ink `ModBand` parity: the same normalized tree drawn with OpenTUI's box,
 * text and span, its props, colors and borders, the clip and the error
 * boundary.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ModRenderElement } from '@qwen-code/qwen-code-core/mods/render-tree.js';

const mocks = vi.hoisted(() => {
  async function buildJsxRuntime() {
    const React = await import('react');
    // A host element keeps its tag and props, and draws them as data; a text
    // holding "THROW" throws, as a renderer would on a tree it cannot draw.
    const Host = ({
      tag,
      children,
      ...props
    }: {
      tag: string;
      children?: React.ReactNode;
    }) => {
      if (tag === 'text' && [children].flat()[0] === 'THROW')
        throw new Error('boom');
      return React.createElement(
        'div',
        { 'data-tag': tag, 'data-props': JSON.stringify(props) },
        children,
      );
    };
    const jsx = (
      type: unknown,
      props: Record<string, unknown> | null,
      key?: React.Key,
    ) => {
      const { children, ...rest } = props ?? {};
      return typeof type === 'string'
        ? React.createElement(
            Host,
            { ...rest, tag: type, key },
            children as React.ReactNode,
          )
        : React.createElement(
            type as React.ElementType,
            { ...rest, key },
            children as React.ReactNode,
          );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { buildJsxRuntime };
});

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  borderCharsToArray: (chars: unknown) => chars,
  MouseButton: { LEFT: 0 },
  TextAttributes: {
    NONE: 0,
    BOLD: 1,
    DIM: 2,
    ITALIC: 4,
    UNDERLINE: 8,
    BLINK: 16,
    INVERSE: 32,
    HIDDEN: 64,
    STRIKETHROUGH: 128,
  },
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import { C } from './theme.js';
import {
  OpenTuiModBand,
  clipBorder,
  drawOpenTuiModTree,
  openTuiColor,
  type PlacedBox,
} from './mod-band.js';

type Drawn = ReactElement<
  Record<string, unknown> & { tag: string; children?: unknown }
>;
const drawn = (tree: ModRenderElement) => drawOpenTuiModTree(tree) as Drawn;
const children = (element: Drawn) =>
  [element.props.children].flat() as Array<Drawn | string>;
const band = (tree: ModRenderElement, revision = 1) => ({
  tree,
  owner: 'token-weather',
  revision,
});
const hosts = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-tag]')].map((node) => ({
    tag: node.getAttribute('data-tag'),
    props: JSON.parse(node.getAttribute('data-props')!) as Record<
      string,
      unknown
    >,
    text: node.textContent,
  }));

describe('OpenTuiModBand', () => {
  it('draws boxes, texts, spans and the strings a box holds', () => {
    const root = drawn({
      type: 'Box',
      props: { flexDirection: 'row', gap: 1 },
      children: [
        { type: 'Text', props: { bold: true }, children: ['☀ Clear'] },
        '12%',
        { type: 'Box', children: [{ type: 'engine', ref: 0 }] },
        { type: 'Text', children: ['a', { type: 'Text', children: ['b'] }] },
      ],
    });
    expect(root.props.tag).toBe('box');
    expect(root.props).toMatchObject({ flexDirection: 'row', gap: 1 });
    const [title, loose, engine, nested] = children(root) as Drawn[];
    expect(title.props).toMatchObject({ tag: 'text', attributes: 1 });
    expect(children(title)).toEqual(['☀ Clear']);
    expect(loose.props.tag).toBe('text');
    expect(children(loose)).toEqual(['12%']);
    expect(children(engine)).toEqual([null]);
    const [plain, span] = children(nested) as [string, Drawn];
    expect(plain).toBe('a');
    expect(span.props.tag).toBe('span');
    // Uncolored text takes the theme's color, and a span its text's.
    expect([title, loose, nested].map((text) => text.props['fg'])).toEqual([
      C.text,
      C.text,
      C.text,
    ]);
    expect(span.props['fg']).toBeUndefined();
    // Ink's Box defaults: a row that shrinks, though it has a width.
    expect(drawn({ type: 'Box', props: { width: 4 } }).props).toMatchObject({
      flexDirection: 'row',
      flexShrink: 1,
    });
    expect(
      drawn({ type: 'Box', props: { flexDirection: 'column', flexShrink: 0 } })
        .props,
    ).toMatchObject({ flexDirection: 'column', flexShrink: 0 });
  });

  it('maps borders, their colors and display', () => {
    const box = (props: Record<string, string | number | boolean>) =>
      drawn({ type: 'Box', props }).props;
    expect(box({ borderStyle: 'round' })).toMatchObject({
      border: true,
      borderStyle: 'rounded',
    });
    expect(box({ borderStyle: 'bold' })).toMatchObject({
      borderStyle: 'heavy',
    });
    expect(box({ borderStyle: 'dashed' })).toMatchObject({
      border: true,
      customBorderChars: { horizontal: '╌', vertical: '╎', topLeft: ' ' },
    });
    expect(box({ borderStyle: 'quote', padding: 'md' })).toMatchObject({
      border: ['left'],
      customBorderChars: { vertical: '▎' },
      paddingX: 2,
      paddingY: 1,
      paddingRight: 3,
      marginTop: 1,
      marginBottom: 1,
    });
    expect(box({ borderStyle: 'quote', marginY: 2 })).toMatchObject({
      marginTop: 3,
      marginBottom: 3,
    });
    // Ink's blank rows sit within the height; the margins here do not.
    expect(
      box({ borderStyle: 'quote', height: 3, minHeight: 1 }),
    ).toMatchObject({ height: 1, minHeight: 0 });
    expect(box({ borderStyle: 'quote', height: '50%' })).toMatchObject({
      height: '50%',
    });
    expect(box({ borderStyle: 'arrow' })).toMatchObject({
      customBorderChars: { topLeft: '↘', horizontal: '↓', vertical: '→' },
    });
    expect(
      box({ borderStyle: 'single', borderColor: 'warning' }),
    ).toMatchObject({ borderColor: C.yellow.toLowerCase() });
    expect(box({ borderStyle: 'single', borderDimColor: true })).toMatchObject({
      borderColor: C.dim,
    });
    expect(box({ borderStyle: 'single' })).toMatchObject({
      borderColor: C.text,
    });
    expect(box({ gap: 'md' })).toMatchObject({ columnGap: 2, rowGap: 1 });
    expect(box({ borderColor: 'warning' })).not.toHaveProperty('borderColor');
    expect(box({ display: 'none' })).toMatchObject({ visible: false });
    expect(box({ display: 'flex' })).not.toHaveProperty('display');
    expect(box({ backgroundColor: '#123' })).toMatchObject({
      backgroundColor: '#112233',
    });
  });

  it('draws text with nothing to draw as an empty box, as Ink takes no rows', () => {
    const root = drawn({
      type: 'Box',
      children: [
        '',
        { type: 'Text', children: [] },
        { type: 'Text', children: ['', { type: 'Text', children: [''] }] },
        { type: 'Text', children: ['\u0007'] },
        { type: 'Text', children: [' '] },
      ],
    });
    const drawnChildren = children(root) as Drawn[];
    expect(drawnChildren.map((child) => child.props.tag)).toEqual([
      'box',
      'box',
      'box',
      'box',
      'text',
    ]);
    for (const empty of drawnChildren.slice(0, 4))
      expect(empty.props).toMatchObject({ width: 0, height: 0 });
  });

  it('keeps borders within the boxes that clip them', () => {
    const box = (props: Record<string, string | number | boolean>) =>
      drawn({ type: 'Box', props }).props;
    expect(box({ borderStyle: 'single' })['renderSelf']).toBeTypeOf('function');
    expect(box({ borderStyle: 'quote' })['renderSelf']).toBeTypeOf('function');
    expect(box({})).not.toHaveProperty('renderSelf');

    const at = (
      screenX: number,
      screenY: number,
      width: number,
      height: number,
      extra: Partial<PlacedBox> = {},
    ): PlacedBox => ({
      screenX,
      screenY,
      width,
      height,
      parent: null,
      ...extra,
    });
    const band = at(0, 1, 40, 4, { overflow: 'hidden' });
    const tall = at(0, 1, 35, 8, {
      border: true,
      parent: at(0, 1, 35, 8, { parent: band }),
    });
    // Cut off at the band's bottom: no bottom side, as Ink clips it.
    expect(clipBorder(tall)).toEqual({
      x: 0,
      y: 1,
      width: 35,
      height: 4,
      sides: ['top', 'right', 'left'],
    });
    expect(
      clipBorder(at(0, 1, 35, 3, { border: ['left'], parent: band })),
    ).toEqual({ x: 0, y: 1, width: 35, height: 3, sides: ['left'] });
    // A bordered clip keeps its own border; one wholly outside draws nothing.
    const framed = at(0, 0, 20, 5, { overflow: 'hidden', border: true });
    expect(
      clipBorder(at(1, 1, 30, 2, { border: true, parent: framed })),
    ).toEqual({
      x: 1,
      y: 1,
      width: 18,
      height: 2,
      sides: ['top', 'bottom', 'left'],
    });
    expect(
      clipBorder(at(0, 6, 10, 2, { border: true, parent: band })),
    ).toBeUndefined();

    const drawBox = vi.fn();
    const renderSelf = box({ borderStyle: 'dashed', borderColor: 'red' })[
      'renderSelf'
    ] as (this: unknown, buffer: unknown) => void;
    renderSelf.call(
      {
        ...tall,
        borderStyle: 'single',
        customBorderChars: { vertical: '╎' },
        borderColor: 'border',
        backgroundColor: 'background',
        shouldFill: true,
      },
      { drawBox },
    );
    expect(drawBox).toHaveBeenCalledWith({
      x: 0,
      y: 1,
      width: 35,
      height: 4,
      border: ['top', 'right', 'left'],
      borderStyle: 'single',
      customBorderChars: { vertical: '╎' },
      borderColor: 'border',
      backgroundColor: 'background',
      shouldFill: true,
    });
  });

  it('draws text attributes, theme keys, colors and truncation', () => {
    const text = (props: Record<string, string | number | boolean>) =>
      drawn({ type: 'Text', props, children: ['x'] }).props;
    expect(
      text({
        weight: 'semibold',
        dimColor: true,
        italic: true,
        underline: true,
        strikethrough: true,
        inverse: true,
      })['attributes'],
    ).toBe(1 | 2 | 4 | 8 | 128 | 32);
    expect(text({ color: 'success', backgroundColor: 'claude' })).toMatchObject(
      { fg: C.green.toLowerCase(), bg: C.accent.toLowerCase() },
    );
    expect(text({ color: 'subtle' })['fg']).toBe(C.dim.toLowerCase());
    expect(text({ color: 'permission' })['fg']).toBe(C.text);
    expect(text({ wrap: 'truncate-middle' })).toMatchObject({
      wrapMode: 'none',
      truncate: true,
    });
    expect(text({ wrap: 'middle' })).toMatchObject({
      wrapMode: 'none',
      truncate: true,
    });
    expect(text({ wrap: 'end' })).toMatchObject({ wrapMode: 'none' });
    expect(text({ wrap: 'end' })).not.toHaveProperty('truncate');
    expect(text({ wrap: 'truncate-end' })).toMatchObject({ wrapMode: 'none' });
    expect(text({ wrap: 'truncate-end' })).not.toHaveProperty('truncate');
    expect(text({ wrap: 'wrap' })).not.toHaveProperty('truncate');
    expect(openTuiColor('cyanBright')).toBe('#80ffff');
    expect(openTuiColor('#0af')).toBe('#00aaff');
    expect(openTuiColor('rgb(1, 2, 300)')).toBe('#0102ff');
    expect(openTuiColor('ansi256(9)')).toBe('#ff8080');
    expect(openTuiColor('ansi256(42)')).toBe('#00d787');
    expect(openTuiColor('ansi256(100)')).toBe('#878700');
    expect(openTuiColor('ansi256(240)')).toBe('#585858');
    expect(text({ color: 'level' })['fg']).toBe(C.text);
    expect(text({ color: 'grayBright' })['fg']).toBe(C.text);
    expect(text({ color: 'grey' })['fg']).toBe('#808080');
  });

  it('sanitizes the text it draws and keys boxes once each', () => {
    const root = drawn({
      type: 'Box',
      children: [
        { type: 'Text', children: ['a\u001b[31mb\u0007c‮d'] },
        ...['k', 'k'].map((key) => ({
          type: 'Box' as const,
          props: { key },
        })),
      ],
    });
    const [text, first, second] = children(root) as Drawn[];
    expect(children(text)).toEqual(['abcd']);
    expect([first.key, second.key]).toEqual(['kk', '2']);
  });

  it('clips the band at maxRows and keeps the collapse columns', () => {
    const { container } = render(
      <OpenTuiModBand
        maxRows={3}
        band={band({ type: 'Text', children: ['☀'] })}
      />,
    );
    const [outer, inner] = hosts(container);
    expect(outer.props).toEqual({
      flexDirection: 'column',
      flexShrink: 0,
      maxHeight: 3,
      overflow: 'hidden',
    });
    expect(inner.props).toMatchObject({ flexShrink: 0, marginRight: 5 });
    expect(container.textContent).toBe('☀');
    expect(
      render(<OpenTuiModBand maxRows={3} band={undefined} />).container
        .textContent,
    ).toBe('');
  });

  it('shows nothing for an answer that throws while drawn, and draws the next afresh', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = band({ type: 'Text', children: ['THROW'] });
      const { container, rerender } = render(
        <OpenTuiModBand maxRows={2} band={broken} />,
      );
      expect(container.textContent).toBe('');
      rerender(<OpenTuiModBand maxRows={2} band={{ ...broken }} />);
      expect(container.textContent).toBe('');
      rerender(
        <OpenTuiModBand
          maxRows={2}
          band={band({ type: 'Text', children: ['ok'] }, 2)}
        />,
      );
      expect(container.textContent).toBe('ok');
    } finally {
      errors.mockRestore();
    }
  });
});
