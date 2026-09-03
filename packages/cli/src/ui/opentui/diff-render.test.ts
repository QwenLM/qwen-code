/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// theme.ts builds SyntaxStyles at module scope; the real implementation
// needs the OpenTUI native FFI, which is unavailable under vitest's Node.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: {
    fromStyles: (styles: Record<string, unknown>) => ({ styles }),
  },
}));

import { renderDiffBody } from './diff-render.js';
import { C } from './theme.js';

const plain = (text: string) => ({ text, color: C.text });

describe('renderDiffBody', () => {
  it('renders an all-additions diff as plain sequentially numbered content', () => {
    const diff = [
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '+const a = 1;',
      '+const b = 2;',
      '+const c = 3;',
    ].join('\n');
    expect(renderDiffBody(diff)).toEqual([
      [{ text: '1 ', color: C.dim }, plain('const a = 1;')],
      [{ text: '2 ', color: C.dim }, plain('const b = 2;')],
      [{ text: '3 ', color: C.dim }, plain('const c = 3;')],
    ]);
  });

  it('renders a mixed diff with numbered gutter and colored prefixes', () => {
    const diff = [
      'Index: packages/x/f.ts',
      '=== separator ===',
      '--- a/packages/x/f.ts',
      '+++ b/packages/x/f.ts',
      '@@ -10,4 +10,4 @@',
      ' keep',
      '-old line',
      '+new line',
      ' tail',
    ].join('\n');
    expect(renderDiffBody(diff)).toEqual([
      [
        { text: '10 ', color: C.dim },
        { text: '  ', color: C.text },
        plain('keep'),
      ],
      [
        { text: '11 ', color: C.dim },
        { text: '- ', color: C.red },
        plain('old line'),
      ],
      [
        { text: '11 ', color: C.dim },
        { text: '+ ', color: C.green },
        plain('new line'),
      ],
      [
        { text: '12 ', color: C.dim },
        { text: '  ', color: C.text },
        plain('tail'),
      ],
    ]);
  });

  it('renders a deletion-only diff through the mixed path', () => {
    const diff = ['@@ -1,2 +1 @@', '-gone', ' keep'].join('\n');
    expect(renderDiffBody(diff)).toEqual([
      [
        { text: '1 ', color: C.dim },
        { text: '- ', color: C.red },
        plain('gone'),
      ],
      [
        { text: '1 ', color: C.dim },
        { text: '  ', color: C.text },
        plain('keep'),
      ],
    ]);
  });

  it('reports no changes for an empty diff', () => {
    expect(renderDiffBody('')).toEqual([
      [{ text: 'No changes detected.', color: C.dim }],
    ]);
  });

  it('ignores the no-newline marker in both paths', () => {
    const newFile = [
      '@@ -0,0 +1,1 @@',
      '+only line',
      '\\ No newline at end of file',
    ].join('\n');
    expect(renderDiffBody(newFile)).toEqual([
      [{ text: '1 ', color: C.dim }, plain('only line')],
    ]);
    const mixed = [
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
    ].join('\n');
    expect(renderDiffBody(mixed)).toEqual([
      [
        { text: '1 ', color: C.dim },
        { text: '- ', color: C.red },
        plain('old'),
      ],
      [
        { text: '1 ', color: C.dim },
        { text: '+ ', color: C.green },
        plain('new'),
      ],
    ]);
  });
});
