/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
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
    expect(summary?.text).toContain('Shell failed');
    expect(stringWidth(summary!.text)).toBeLessThanOrEqual(20);
  });
});
