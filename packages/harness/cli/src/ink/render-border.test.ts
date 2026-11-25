/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyColor } from './colorize.js';
import type { DOMNode } from './dom.js';
import type Output from './output.js';
import renderBorder from './render-border.js';

function renderTopBorder(
  style: Record<string, unknown>,
  width: number,
): string {
  const write = vi.fn();
  const node = {
    style: {
      borderStyle: 'round',
      borderLeft: false,
      borderRight: false,
      ...style,
    },
    yogaNode: {
      getComputedWidth: () => width,
      getComputedHeight: () => 3,
    },
  } as unknown as DOMNode;
  renderBorder(0, 0, node, { write } as unknown as Output);
  return write.mock.calls[0][2] as string;
}

describe('renderBorder border text', () => {
  let previousLevel: typeof chalk.level;

  beforeEach(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('pads the text and keeps one border cell after it when aligned to the end', () => {
    const top = renderTopBorder(
      {
        borderText: {
          content: 'hello',
          position: 'top',
          align: 'end',
          padding: 1,
        },
      },
      12,
    );

    expect(top).toBe('──── hello ─');
  });

  it('colors the text with its own color and the dashes with the border color', () => {
    const top = renderTopBorder(
      {
        borderColor: '#112233',
        borderText: {
          content: 'hello',
          position: 'top',
          align: 'end',
          padding: 1,
          color: '#445566',
        },
      },
      12,
    );

    expect(top).toBe(
      applyColor('────', '#112233') +
        applyColor(' hello ', '#445566') +
        applyColor('─', '#112233'),
    );
  });

  it('dims colored text together with a dimmed border', () => {
    const top = renderTopBorder(
      {
        borderColor: '#112233',
        borderDimColor: true,
        borderText: {
          content: 'hello',
          position: 'top',
          align: 'end',
          padding: 1,
          color: '#112233',
        },
      },
      12,
    );

    expect(top).toBe(
      chalk.dim(applyColor('────', '#112233')) +
        chalk.dim(applyColor(' hello ', '#112233')) +
        chalk.dim(applyColor('─', '#112233')),
    );
  });

  it('truncates text that does not fit and keeps a border cell on each side', () => {
    const top = renderTopBorder(
      {
        borderText: {
          content: 'abcdefghij',
          position: 'top',
          align: 'end',
          padding: 1,
        },
      },
      10,
    );

    expect(top).toBe('─ abcde… ─');
  });

  it.each([1, 2, 4])(
    'draws a plain border when %i cells cannot hold any text',
    (width) => {
      const top = renderTopBorder(
        {
          borderText: {
            content: 'hello',
            position: 'top',
            align: 'end',
            padding: 1,
          },
        },
        width,
      );

      expect(top).toBe('─'.repeat(width));
    },
  );
});
