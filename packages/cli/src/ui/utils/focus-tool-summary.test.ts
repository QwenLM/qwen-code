/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { setLanguageAsync } from '../../i18n/index.js';
import {
  getFocusToolSummary,
  type FocusToolSummaryInput,
} from './focus-tool-summary.js';

const tool: FocusToolSummaryInput = {
  name: 'run_shell_command',
  status: 'success',
  description: 'echo PRIVATE-COMMAND',
  args: { command: 'echo PRIVATE-COMMAND' },
};

describe('getFocusToolSummary', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'renders inherited object key %s as a tool name',
    (name) => {
      expect(getFocusToolSummary([{ ...tool, name, status: 'error' }])).toEqual(
        {
          text: `${name} failed (Ctrl+O for details)`,
          status: 'error',
        },
      );
    },
  );

  it('strips invisible controls in short names and paths', () => {
    for (const control of [
      '\u200b',
      '\u200e',
      '\u200f',
      '\u061c',
      '\u2028',
      '\u2029',
      '\ufeff',
    ]) {
      for (const input of [
        { ...tool, name: `a${control}b` },
        {
          ...tool,
          name: 'read_file',
          args: { file_path: `src/a${control}b.ts` },
        },
      ]) {
        expect(getFocusToolSummary([input])?.text).not.toContain(control);
      }
    }
  });

  it('preserves real notebook arguments and legacy edit aliases', () => {
    expect(
      getFocusToolSummary([
        {
          ...tool,
          name: 'notebook_edit',
          args: { notebook_path: 'src/example.ipynb' },
        },
      ])?.text,
    ).toContain('src/example.ipynb');
    expect(
      getFocusToolSummary([
        { ...tool, name: 'replace', args: { file_path: 'src/example.ts' } },
      ])?.text,
    ).toBe('Edit src/example.ts (Ctrl+O for details)');
  });

  it('keeps mention identities without repeating labels or error descriptions', () => {
    expect(
      getFocusToolSummary([
        {
          name: 'Read Directory',
          status: 'success',
          description: 'Read directory src',
        },
      ])?.text,
    ).toBe('Read Directory src (Ctrl+O for details)');
    expect(
      getFocusToolSummary([
        { name: 'Read File', status: 'success', description: 'Read File(s)' },
      ])?.text,
    ).toBe('Read File (Ctrl+O for details)');
    expect(
      getFocusToolSummary([
        {
          name: 'Read File',
          status: 'success',
          description: 'Read file example.ts',
        },
      ])?.text,
    ).toBe('Read File example.ts (Ctrl+O for details)');
    expect(
      getFocusToolSummary([
        {
          name: 'Read File(s)',
          status: 'error',
          description: 'Error attempting to read files',
        },
      ])?.text,
    ).toBe('Read File(s) failed (Ctrl+O for details)');
    expect(
      getFocusToolSummary([
        { name: 'Read Directory', status: 'success', description: '@src' },
      ])?.text,
    ).toContain('@src');
  });

  it('localizes tool labels without losing file identity', async () => {
    await setLanguageAsync('zh');
    try {
      expect(getFocusToolSummary([tool])?.text).toContain('运行命令');
      expect(getFocusToolSummary([tool])?.text).not.toContain('Shell');
      expect(
        getFocusToolSummary([
          { ...tool, name: 'read_file', args: { file_path: 'src/example.ts' } },
        ])?.text,
      ).toContain('src/example.ts');
    } finally {
      await setLanguageAsync('en');
    }
  });

  it('preserves the basename of paths ending in a separator', () => {
    expect(
      getFocusToolSummary([
        {
          ...tool,
          name: 'read_file',
          args: { file_path: '/long-directory/'.repeat(20) },
        },
      ])?.text,
    ).toContain('long-directory');
  });

  it('reserves the detail shortcut within the caller width', () => {
    const expected = [
      'Edit …/focus.ts failed (Ctrl+O for details)',
      'Tools: 3, failed: 3 (Edit, …) (Ctrl+O for details)',
    ];
    let index = 0;
    for (const inputs of [
      [
        {
          ...tool,
          name: 'edit',
          status: 'error' as const,
          args: { file_path: '/long-directory/'.repeat(20) + 'focus.ts' },
        },
      ],
      ['edit', 'write_file', 'run_shell_command'].map((name) => ({
        ...tool,
        name,
        status: 'error' as const,
      })),
    ]) {
      const summary = getFocusToolSummary(inputs, { maxWidth: 60 });
      expect(summary?.text).toBe(expected[index++]);
      expect(summary?.text).toContain('Ctrl+O for details');
      expect(stringWidth(summary!.text)).toBeLessThanOrEqual(60);
    }
  });
  it('preserves directory listing identity', () => {
    expect(
      getFocusToolSummary([
        { ...tool, name: 'list_directory', args: { path: 'src/components' } },
      ])?.text,
    ).toBe('ListFiles src/components (Ctrl+O for details)');
  });

  it('retains basename characters within a narrow identity budget', () => {
    const summary = getFocusToolSummary(
      [
        {
          ...tool,
          name: 'write_file',
          args: { file_path: '/long-directory/'.repeat(20) + 'focus.ts' },
        },
      ],
      { maxWidth: 34 },
    );
    expect(summary?.text).toBe('WriteFile fo… (Ctrl+O for details)');
    expect(summary?.text).not.toContain('…/…');
    expect(stringWidth(summary!.text)).toBeLessThanOrEqual(34);
  });
  it('keeps the tool identity but never shell arguments or descriptions', () => {
    expect(getFocusToolSummary([tool])).toEqual({
      text: 'Shell (Ctrl+O for details)',
      status: 'success',
    });
  });

  it.each(['read_file', 'ReadFile', 'edit', 'write_file', 'notebook_edit'])(
    'preserves the file identity for %s',
    (name) => {
      const summary = getFocusToolSummary([
        { ...tool, name, args: { file_path: 'src/example.ts' } },
      ]);
      expect(summary?.text).toContain('src/example.ts');
      expect(summary?.text).not.toContain('PRIVATE');
    },
  );

  it('uses legacy descriptions only for known file tools and rejects JSON argument fallbacks', () => {
    expect(
      getFocusToolSummary([
        { name: 'ReadFile', status: 'success', description: 'src/legacy.ts' },
      ])?.text,
    ).toContain('src/legacy.ts');
    expect(
      getFocusToolSummary([
        {
          name: 'ReadFile',
          status: 'error',
          description: '{"file_path":"secret.ts","content":"PRIVATE"}',
        },
      ])?.text,
    ).toBe('ReadFile failed (Ctrl+O for details)');
    expect(
      getFocusToolSummary([{ ...tool, name: 'custom_tool' }])?.text,
    ).not.toContain('PRIVATE');
  });

  it('names failed tools and counts terminal cancellations in a mixed group', () => {
    expect(
      getFocusToolSummary([
        tool,
        { ...tool, name: 'edit', status: 'error' },
        { ...tool, status: 'cancelled' },
      ]),
    ).toEqual({
      text: 'Tools: 3, failed: 1 (Edit), cancelled: 1 (Ctrl+O for details)',
      status: 'error',
    });
  });

  it('does not label cancellation as success', () => {
    expect(getFocusToolSummary([{ ...tool, status: 'cancelled' }])).toEqual({
      text: 'Shell cancelled (Ctrl+O for details)',
      status: 'cancelled',
    });
  });

  it.each([
    { isUserInitiated: true },
    { isSubagent: true },
    { hasImages: true },
    { hasNotice: true },
    { status: 'pending' as const },
  ])('preserves visible exceptions: %j', (exception) => {
    expect(
      getFocusToolSummary([tool, { ...tool, ...exception }]),
    ).toBeUndefined();
  });

  it('preserves pending and user-initiated groups, including terminal members', () => {
    expect(getFocusToolSummary([tool], { isPending: true })).toBeUndefined();
    expect(
      getFocusToolSummary([tool], { isUserInitiated: true }),
    ).toBeUndefined();
    expect(getFocusToolSummary([])).toBeUndefined();
  });

  it('bounds display cells and strips terminal controls from untrusted identities', () => {
    const summary = getFocusToolSummary([
      { ...tool, name: '\u001b[31m' + '模'.repeat(80) + '\n\u0007\u202e' },
    ]);
    for (const control of ['\n', '\u001b', '\u0007', '\u202e']) {
      expect(summary?.text).not.toContain(control);
    }
    expect(stringWidth(summary!.text)).toBeLessThanOrEqual(80);
  });

  it('retains the basename for a very long directory path', () => {
    const summary = getFocusToolSummary([
      {
        ...tool,
        name: 'read_file',
        args: { file_path: '/long-directory/'.repeat(20) + 'focus.ts' },
      },
    ]);
    expect(summary?.text).toContain('focus.ts');
    expect(stringWidth(summary!.text)).toBeLessThanOrEqual(80);
  });

  it('retains Windows basenames in bounded summaries', () => {
    expect(
      getFocusToolSummary([
        {
          ...tool,
          name: 'read_file',
          args: { file_path: 'C:\\long-directory'.repeat(20) + '\\focus.ts' },
        },
      ])?.text,
    ).toContain('focus.ts');
  });

  it('bounds many distinct failed tool names and preserves the failure count', () => {
    const summary = getFocusToolSummary(
      ['edit', 'write_file', 'run_shell_command', 'custom'].map((name) => ({
        ...tool,
        name,
        status: 'error' as const,
      })),
    );
    expect(summary?.text).toContain('failed: 4 (Edit, WriteFile, …)');
    expect(stringWidth(summary!.text)).toBeLessThanOrEqual(80);
  });

  it('honors caller width while retaining terminal status', () => {
    const summary = getFocusToolSummary([{ ...tool, status: 'error' }], {
      maxWidth: 20,
    });
    expect(summary?.status).toBe('error');
    expect(summary?.text).toBe('Shell failed');
    expect(stringWidth(summary!.text)).toBeLessThanOrEqual(20);
  });

  it.each(['en', 'pt', 'de', 'zh'] as const)(
    'keeps localized hints and parentheses whole at narrow widths (%s)',
    async (language) => {
      await setLanguageAsync(language);
      try {
        for (const maxWidth of [20, 34, 60]) {
          for (const inputs of [
            [{ ...tool, status: 'error' as const }],
            ['edit', 'write_file', 'run_shell_command'].map((name) => ({
              ...tool,
              name,
              status: 'error' as const,
            })),
          ]) {
            const text = getFocusToolSummary(inputs, { maxWidth })!.text;
            expect(stringWidth(text)).toBeLessThanOrEqual(maxWidth);
            expect((text.match(/[（(]/g) ?? []).length).toBe(
              (text.match(/[)）]/g) ?? []).length,
            );
            expect(text).not.toMatch(/(?:Ctrl|Strg)[^）)]*…/);
          }
        }
      } finally {
        await setLanguageAsync('en');
      }
    },
  );
});
