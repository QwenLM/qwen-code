/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import type {
  ModRenderElement,
  ModRenderProps,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { theme } from '../semantic-colors.js';
import { modBandMaxRows } from '../utils/mod-band-tree.js';
import { ModBand, drawModTree } from './ModBand.js';

const band = (tree: ModRenderElement, revision = 1) => ({
  tree,
  owner: 'token-weather',
  revision,
});
// The props an element is drawn with.
const drawn = (tree: ModRenderElement) =>
  (drawModTree(tree) as ReactElement<Record<string, unknown>>).props;

describe('ModBand', () => {
  it('draws boxes, texts and the strings a box holds', () => {
    const { lastFrame } = render(
      <ModBand
        maxRows={4}
        band={band({
          type: 'Box',
          props: { flexDirection: 'row', gap: 1 },
          children: [
            { type: 'Text', props: { bold: true }, children: ['☀ Clear'] },
            '12%',
            { type: 'Box', children: [{ type: 'engine', ref: 0 }] },
            {
              type: 'Text',
              children: ['a', { type: 'Text', children: ['b'] }],
            },
          ],
        })}
      />,
    );
    expect(lastFrame()).toBe('☀ Clear 12%  ab');
  });

  it('draws nothing without a tree', () => {
    expect(render(<ModBand maxRows={4} band={undefined} />).lastFrame()).toBe(
      '',
    );
  });

  it('clips a tree taller than maxRows and keeps the collapse columns', () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      type: 'Text' as const,
      children: [`row ${index}`],
    }));
    const { lastFrame } = render(
      <ModBand
        maxRows={2}
        band={band({
          type: 'Box',
          props: { flexDirection: 'column' },
          children: rows,
        })}
      />,
    );
    const lines = lastFrame()!.split('\n');
    expect(lines).toEqual(['row 0', 'row 1']);
    const wide = render(
      <ModBand
        maxRows={3}
        band={band({ type: 'Text', children: ['y'.repeat(100)] })}
      />,
    ).lastFrame()!;
    // ink-testing-library draws 100 columns.
    expect(wide.split('\n')[0]).toBe('y'.repeat(95));
  });

  it('truncates text whose wrap is end or middle, as Claude Code does', () => {
    const text = 'ab '.repeat(70).trim();
    for (const [wrap, expected] of [
      ['end', 'truncate-end'],
      ['middle', 'truncate-middle'],
    ] as const) {
      const truncated = render(
        <ModBand
          maxRows={4}
          band={band({
            type: 'Box',
            children: [
              { type: 'Text', props: { wrap: expected }, children: [text] },
            ],
          })}
        />,
      ).lastFrame();
      const frame = render(
        <ModBand
          maxRows={4}
          band={band({
            type: 'Box',
            children: [{ type: 'Text', props: { wrap }, children: [text] }],
          })}
        />,
      ).lastFrame()!;
      // ink-testing-library draws 100 columns.
      expect(
        Math.max(...frame.split('\n').map((line) => line.length)),
      ).toBeLessThanOrEqual(100);
      expect(frame).toBe(truncated);
    }
  });

  it('keeps a tree wider than the terminal within its columns', () => {
    const cases: ModRenderProps[] = [
      { width: 500 },
      { minWidth: 300 },
      { marginLeft: 200 },
    ];
    for (const props of cases) {
      const lines = render(
        <ModBand
          maxRows={4}
          band={band({ type: 'Box', props, children: ['x'.repeat(400)] })}
        />,
      )
        .lastFrame()!
        .split('\n');
      // ink-testing-library draws 100 columns.
      expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
        100,
      );
    }
  });

  it('takes a third of the terminal rows, at least one', () => {
    expect(modBandMaxRows(24)).toBe(8);
    expect(modBandMaxRows(2)).toBe(1);
  });

  it('turns spacing steps into cells across and down', () => {
    expect(
      drawn({
        type: 'Box',
        props: { padding: 'md', marginX: 'xl', marginTop: 'lg', gap: 'xs' },
      }),
    ).toMatchObject({
      paddingX: 2,
      paddingY: 1,
      marginX: 4,
      marginTop: 1,
      columnGap: 1,
      rowGap: 0,
    });
    expect(
      drawn({ type: 'Box', props: { paddingX: 3, padding: 'lg' } }),
    ).toMatchObject({ paddingX: 3, paddingY: 1 });
    expect(drawn({ type: 'Box', props: { margin: 2 } })).toMatchObject({
      margin: 2,
    });
  });

  it('maps weights, drops what the terminal does not draw, and maps theme keys', () => {
    const text = drawn({
      type: 'Text',
      props: {
        weight: 'semibold',
        size: 'title',
        mono: true,
        tabular: true,
        dir: 'rtl',
        color: 'success',
        backgroundColor: 'claude',
        wrap: 'truncate-end',
      },
      children: ['x'],
    });
    expect(text).toMatchObject({
      bold: true,
      color: theme.status.success,
      backgroundColor: theme.text.accent,
      wrap: 'truncate-end',
    });
    for (const name of ['size', 'mono', 'tabular', 'dir'])
      expect(text).not.toHaveProperty(name);
    const colors: Array<[string, string | undefined]> = [
      ['text', theme.text.primary],
      ['subtle', theme.text.secondary],
      ['inactive', theme.text.secondary],
      ['error', theme.status.error],
      ['warning', theme.status.warning],
      ['suggestion', theme.text.accent],
      ['permission', undefined],
      ['diffAdded', undefined],
      ['cyanBright', 'cyanBright'],
      ['grey', 'grey'],
      ['grayBright', undefined],
      ['#0af', '#0af'],
      ['rgb(1, 2, 3)', 'rgb(1, 2, 3)'],
      ['ansi256(42)', 'ansi256(42)'],
      ['level', undefined],
      ['bold', undefined],
      ['not a color', undefined],
    ];
    for (const [color, expected] of colors)
      expect(
        drawn({ type: 'Text', props: { color }, children: ['x'] })['color'],
      ).toBe(expected);
    expect(
      drawn({ type: 'Box', props: { borderColor: 'warning' } })['borderColor'],
    ).toBe(theme.status.warning);
  });

  it('draws Claude Code’s dashed and quote borders', () => {
    const { lastFrame } = render(
      <ModBand
        maxRows={6}
        band={band({
          type: 'Box',
          props: { flexDirection: 'column' },
          children: [
            {
              type: 'Box',
              props: { borderStyle: 'dashed', width: 5 },
              children: ['a'],
            },
            {
              type: 'Box',
              props: { borderStyle: 'quote' },
              children: ['b'],
            },
          ],
        })}
      />,
    );
    expect(lastFrame()).toContain('╎a  ╎');
    expect(lastFrame()).toContain('▎b');
  });

  it('keys boxes by their own key, and a repeated key by position', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { lastFrame } = render(
        <ModBand
          maxRows={2}
          band={band({
            type: 'Box',
            children: ['a', 'b', 'a'].map((key) => ({
              type: 'Box' as const,
              props: { key },
              children: [key],
            })),
          })}
        />,
      );
      expect(lastFrame()).toBe('aba');
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    } finally {
      errors.mockRestore();
    }
  });

  it('sanitizes the text it draws', () => {
    const { lastFrame } = render(
      <ModBand
        maxRows={2}
        band={band({ type: 'Text', children: ['a\u001b[31mb\u0007c‮d'] })}
      />,
    );
    expect(lastFrame()).toBe('abcd');
  });

  it('expands tabs to the next 8-column stop, as Claude Code does', () => {
    // Ink measures a tab as no columns while the terminal jumps to a stop.
    const { lastFrame } = render(
      <ModBand
        maxRows={2}
        band={band({ type: 'Text', children: ['ctx\t42%'] })}
      />,
    );
    expect(lastFrame()).toBe('ctx     42%');
  });

  it('shows nothing for an answer that throws while drawn, and draws the next afresh', () => {
    const broken = band({
      type: 'Text',
      children: [{ type: 'Box', children: ['x'] } as unknown as string],
    });
    const { lastFrame, rerender } = render(
      <ModBand maxRows={2} band={broken} />,
    );
    expect(lastFrame()).toBe('');
    rerender(<ModBand maxRows={2} band={{ ...broken }} />);
    expect(lastFrame()).toBe('');
    rerender(
      <ModBand
        maxRows={2}
        band={band({ type: 'Text', children: ['ok'] }, 2)}
      />,
    );
    expect(lastFrame()).toBe('ok');
  });
});
