/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ENGINE_NODE,
  MOD_RENDER_TEXT_CAP,
  adjustRenderTree,
  validateRenderTree,
  type ModRenderElement,
} from './render-tree.js';

const box = (props?: object, children?: unknown[]) => ({
  type: 'Box',
  ...(props ? { props } : {}),
  ...(children ? { children } : {}),
});
const text = (children: unknown[], props?: object) => ({
  type: 'Text',
  ...(props ? { props } : {}),
  children,
});

describe('validateRenderTree', () => {
  it('accepts the trees Token Weather draws', () => {
    expect(() =>
      validateRenderTree(
        box({ flexDirection: 'row', paddingX: 1 }, [
          text(['☀  Clear'], { color: 'yellow', bold: true }),
          text(['  12% of context']),
          text(['  12k / 100k'], { dimColor: true }),
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    ['a root string', 'hello', 'the root must be an element'],
    ['a root array', [box()], 'the root must be an element'],
    [
      'an element the terminal has but Qwen Code does not draw yet',
      box({}, [{ type: 'Button', props: { key: 'go', label: 'Go' } }]),
      'Button is not drawn by Qwen Code yet',
    ],
    [
      'an element the terminal lacks',
      { type: 'Svg' },
      'Svg is not an element of the terminal',
    ],
    [
      'a prop the element does not take',
      box({ color: 'red' }),
      'Box prop "color" is not allowed',
    ],
    [
      'a value outside an enumeration',
      box({ flexDirection: 'diagonal' }),
      'Box prop "flexDirection" must be one of row, column, row-reverse, column-reverse',
    ],
    [
      'a size past the cells a terminal has',
      box({ width: 10_001 }),
      'Box prop "width" must be 0 to 10000 cells or a percentage',
    ],
    [
      'a spacing step that does not exist',
      box({ gap: 'xxl' }),
      'Box prop "gap" must be a number of cells or xs, sm, md, lg or xl',
    ],
    [
      'an offset that is not a whole number',
      box({ top: 1.5 }),
      'Box prop "top" must be a whole number of cells up to 10000',
    ],
    [
      'a color with an escape in it',
      text(['x'], { color: '\u001b[31m' }),
      'Text prop "color" must be a theme key or a color',
    ],
    [
      'a flag that is not a boolean',
      text(['x'], { bold: 'yes' }),
      'Text prop "bold" must be true or false',
    ],
    [
      'a prop value that is an object',
      box({ padding: { x: 1 } }),
      'Box prop "padding" is object',
    ],
    [
      'props that are not an object',
      { type: 'Box', props: [] },
      'Box props is an array',
    ],
    [
      'children that are not a list',
      { type: 'Box', children: 'x' },
      'Box children is string',
    ],
    ['a Box inside a Text', text([box()]), 'Box inside an inline element'],
    [
      'the engine node inside a Text',
      box({}, [text([ENGINE_NODE])]),
      'engine node inside an inline element',
    ],
    [
      'the engine node under a sized Box',
      box({ width: 10 }, [box({}, [ENGINE_NODE])]),
      'engine node under a Box with prop "width"',
    ],
    [
      'a text with an escape sequence',
      text(['\u001b[2J']),
      'a text child holds a control character (an escape sequence)',
    ],
    [
      'a text with a lone surrogate',
      text(['\ud800']),
      'a text child holds a control character (an escape sequence)',
    ],
    [
      'a hover prop the element does not take',
      { type: 'Text', hover: { wrap: 'end' } },
      'Text prop "wrap" is not allowed',
    ],
    [
      'fields beside props and children',
      { type: 'Box', press: { plugin: 'x', handle: 1 } },
      'Box holds fields other than props and children',
    ],
  ])('refuses %s', (_case, tree, reason) => {
    expect(() => validateRenderTree(tree)).toThrow(reason);
  });

  it('accepts the engine node in a plain Box and tab, line feed and carriage return in text', () => {
    expect(() =>
      validateRenderTree(
        box({ flexDirection: 'column', padding: 'md' }, [
          ENGINE_NODE,
          text(['a\tb\nc\r']),
        ]),
      ),
    ).not.toThrow();
  });

  it('bounds the depth and the nodes of a tree', () => {
    let deep: object = text(['leaf']);
    for (let i = 0; i < 32; i++) deep = box({}, [deep]);
    expect(() => validateRenderTree(deep)).toThrow('deeper than 32');
    expect(() =>
      validateRenderTree(
        box(
          {},
          Array.from({ length: 20_000 }, () => 'x'),
        ),
      ),
    ).toThrow('more than 20000 nodes');
  });
});

describe('adjustRenderTree', () => {
  it('drops a Box key it cannot address by and a border the terminal lacks', () => {
    const { tree, notes } = adjustRenderTree(
      box({ key: '', borderStyle: 'wavy', padding: 1 }, [
        box({ key: 'ok', borderStyle: 'round' }),
        { type: 'Box', hover: { borderStyle: 3 } },
      ]) as ModRenderElement,
      'AbovePrompt',
    );
    expect(tree).toEqual(
      box({ padding: 1 }, [
        box({ key: 'ok', borderStyle: 'round' }),
        { type: 'Box' },
      ]),
    );
    // The first border the terminal lacks stands for the kind.
    expect(notes).toEqual([
      {
        key: 'borderStyle',
        text: 'ui.render (AbovePrompt): Box borderStyle "wavy" is not a border style (the styles are single, double, round, bold, singleDouble, doubleSingle, classic, arrow, dashed, quote); the Box is drawn with no border',
      },
    ]);
    expect(
      adjustRenderTree(
        { type: 'Box', hover: { borderStyle: 3 } } as ModRenderElement,
        'AbovePrompt',
      ).notes,
    ).toEqual([
      {
        key: 'borderStyle',
        text: 'ui.render (AbovePrompt): Box borderStyle is number, not a style name (the styles are single, double, round, bold, singleDouble, doubleSingle, classic, arrow, dashed, quote); the Box is drawn with no border',
      },
    ]);
  });

  it('cuts text past the cap in the order written and says so once', () => {
    const long = 'a'.repeat(MOD_RENDER_TEXT_CAP - 10);
    const { tree, notes } = adjustRenderTree(
      box({}, [
        text([long]),
        text(['b'.repeat(30)]),
        'after',
      ]) as ModRenderElement,
      'AbovePrompt',
    );
    expect(tree).toEqual(
      box(undefined, [
        text([long]),
        text(['b'.repeat(10) + '\n… 20 more characters, not drawn']),
        '',
      ]),
    );
    expect(notes).toEqual([
      {
        key: 'text cut',
        text: `ui.render (AbovePrompt): ${MOD_RENDER_TEXT_CAP + 25} characters of text are drawn up to the first ${MOD_RENDER_TEXT_CAP}`,
      },
    ]);
  });

  it('never cuts between the halves of a surrogate pair', () => {
    const { tree, notes } = adjustRenderTree(
      text(['a'.repeat(MOD_RENDER_TEXT_CAP - 1) + '😀😀']) as ModRenderElement,
      'AbovePrompt',
    );
    expect(tree).toEqual(
      text([
        'a'.repeat(MOD_RENDER_TEXT_CAP - 1) +
          '\n… 4 more characters, not drawn',
      ]),
    );
    expect(() => validateRenderTree(tree)).not.toThrow();
    expect(notes).toEqual([
      {
        key: 'text cut',
        text: `ui.render (AbovePrompt): ${MOD_RENDER_TEXT_CAP + 3} characters of text are drawn up to the first ${MOD_RENDER_TEXT_CAP - 1}`,
      },
    ]);
  });

  it('leaves an accepted tree within the rules as it is', () => {
    const tree = box({ key: 'band', flexDirection: 'row' }, [
      text(['ok'], { color: 'success' }),
      ENGINE_NODE,
    ]) as ModRenderElement;
    expect(adjustRenderTree(tree, 'AbovePrompt')).toEqual({ tree, notes: [] });
    expect(Object.isFrozen(ENGINE_NODE)).toBe(true);
  });
});
