/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { computeDiffColumnWidths, diffCommand } from './diffCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { fetchGitDiff, type GitDiffResult } from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...actual,
    fetchGitDiff: vi.fn(),
  };
});

function makeContextWithCwd(cwd = '/tmp/repo'): CommandContext {
  // Non-interactive by default here because these tests assert on the
  // plain-text `MessageActionReturn`; interactive mode dispatches via
  // `context.ui.addItem` and is covered in a separate describe block.
  return createMockCommandContext({
    executionMode: 'non_interactive',
    services: {
      config: {
        getWorkingDir: () => cwd,
        getProjectRoot: () => cwd,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    },
  });
}

function makeInteractiveContext(cwd = '/tmp/repo'): CommandContext {
  return createMockCommandContext({
    executionMode: 'interactive',
    services: {
      config: {
        getWorkingDir: () => cwd,
        getProjectRoot: () => cwd,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    },
  });
}

describe('diffCommand', () => {
  let mockContext: CommandContext;
  let mockFetchGitDiff: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGitDiff = vi.mocked(fetchGitDiff);
    mockContext = makeContextWithCwd();
  });

  it('errors when config is unavailable', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    const noConfigContext = createMockCommandContext();
    const result = await diffCommand.action(noConfigContext, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
  });

  it('errors when getWorkingDir and getProjectRoot both return empty', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    const noCwdContext = createMockCommandContext({
      services: {
        config: {
          getWorkingDir: () => '',
          getProjectRoot: () => '',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    const result = await diffCommand.action(noCwdContext, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
  });

  it('surfaces an error when fetchGitDiff throws', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockRejectedValueOnce(new Error('permission denied'));
    const result = await diffCommand.action(mockContext, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain(
      'permission denied',
    );
  });

  it('reports when not in a git repo or transient state', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue(null);
    const result = await diffCommand.action(mockContext, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect((result as { content: string }).content).toMatch(
      /not a git repository|merge|rebase/i,
    );
  });

  it('reports clean working tree when stats show zero changes', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map(),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    expect((result as { content: string }).content).toMatch(
      /Clean working tree/i,
    );
  });

  it('uses singular "file" when exactly one file changed', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 1, linesAdded: 3, linesRemoved: 1 },
      perFileStats: new Map([
        ['src/a.ts', { added: 3, removed: 1, isBinary: false }],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    expect(content).toMatch(/\b1 file\b/);
    expect(content).not.toMatch(/\b1 files\b/);
  });

  it('renders header and per-file rows with +added / -removed', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 2, linesAdded: 7, linesRemoved: 3 },
      perFileStats: new Map([
        ['src/a.ts', { added: 5, removed: 2, isBinary: false }],
        ['src/b.ts', { added: 2, removed: 1, isBinary: false }],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    expect(content).toContain('2 files changed');
    expect(content).toContain('+7');
    expect(content).toContain('-3');
    expect(content).toContain('src/a.ts');
    expect(content).toContain('src/b.ts');
  });

  it('shows untracked text files with their line count and a (new) marker', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 2, linesAdded: 12, linesRemoved: 2 },
      perFileStats: new Map([
        ['src/a.ts', { added: 10, removed: 2, isBinary: false }],
        [
          'notes.md',
          { added: 2, removed: 0, isBinary: false, isUntracked: true },
        ],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    const lines = content.split('\n');
    const aLine = lines.find((l) => l.endsWith('src/a.ts'))!;
    const newLine = lines.find((l) => l.includes('notes.md'))!;
    expect(newLine).toContain('+ 2');
    expect(newLine).toContain('(new)');
    // Stat columns stay aligned across tracked and new rows.
    expect(aLine.indexOf('src/a.ts')).toBe(newLine.indexOf('notes.md'));
  });

  it('marks truncated untracked text files with (new, partial)', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 1, linesAdded: 10000, linesRemoved: 0 },
      perFileStats: new Map([
        [
          'big.log',
          {
            added: 10000,
            removed: 0,
            isBinary: false,
            isUntracked: true,
            truncated: true,
          },
        ],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    const row = content.split('\n').find((l) => l.includes('big.log'))!;
    expect(row).toContain('(new, partial)');
    expect(row).not.toContain(' (new)');
  });

  it('marks deleted tracked files with (deleted)', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 1, linesAdded: 0, linesRemoved: 5 },
      perFileStats: new Map([
        [
          'gone.txt',
          { added: 0, removed: 5, isBinary: false, isDeleted: true },
        ],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    const row = content.split('\n').find((l) => l.includes('gone.txt'))!;
    expect(row).toContain('(deleted)');
    expect(row).toContain('-5');
  });

  it('marks deleted binary tracked files with (binary, deleted)', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 1, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map([
        ['gone.bin', { added: 0, removed: 0, isBinary: true, isDeleted: true }],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    const row = content.split('\n').find((l) => l.includes('gone.bin'))!;
    expect(row).toContain('(binary, deleted)');
    expect(row.trimStart().startsWith('~')).toBe(true);
  });

  it('marks binary untracked files with (binary, new) and no line count', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 1, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map([
        [
          'blob.bin',
          { added: 0, removed: 0, isBinary: true, isUntracked: true },
        ],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    const binaryLine = content.split('\n').find((l) => l.includes('blob.bin'))!;
    expect(binaryLine).toContain('(binary, new)');
    expect(binaryLine).not.toMatch(/\+\d/);
    expect(binaryLine.trimStart().startsWith('~')).toBe(true);
  });

  it('pads counts consistently for 4-digit values', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 2, linesAdded: 9999, linesRemoved: 1 },
      perFileStats: new Map([
        ['big.ts', { added: 9999, removed: 0, isBinary: false }],
        ['tiny.ts', { added: 0, removed: 1, isBinary: false }],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    // Both rows must use the same prefix width so they align.
    const bigLine = content.split('\n').find((l) => l.endsWith('big.ts'))!;
    const tinyLine = content.split('\n').find((l) => l.endsWith('tiny.ts'))!;
    expect(bigLine.indexOf('big.ts')).toBe(tinyLine.indexOf('tiny.ts'));
    expect(content).toContain('+9999');
  });

  it('notes how many files were hidden beyond the per-file cap', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 60, linesAdded: 100, linesRemoved: 20 },
      perFileStats: new Map([
        ['src/a.ts', { added: 1, removed: 0, isBinary: false }],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    expect(content).toContain('60 files changed');
    expect(content).toMatch(/59 more/);
  });

  it('shows header only when the shortstat fast path yields no per-file data', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 1000, linesAdded: 50_000, linesRemoved: 8_000 },
      perFileStats: new Map(),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    expect(content).toContain('1000 files changed');
    expect(content).not.toMatch(/more \(showing first/);
  });
});

describe('diffCommand interactive mode', () => {
  let mockFetchGitDiff: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGitDiff = vi.mocked(fetchGitDiff);
  });

  it('dispatches a diff_stats history item instead of returning text', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    const ctx = makeInteractiveContext();
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 2, linesAdded: 7, linesRemoved: 3 },
      perFileStats: new Map([
        ['src/a.ts', { added: 5, removed: 2, isBinary: false }],
        ['src/b.ts', { added: 2, removed: 1, isBinary: false }],
      ]),
    } satisfies GitDiffResult);

    const result = await diffCommand.action(ctx, '');
    expect(result).toBeUndefined();
    expect(ctx.ui.addItem).toHaveBeenCalledTimes(1);
    const call = (ctx.ui.addItem as Mock).mock.calls[0][0];
    expect(call.type).toBe('diff_stats');
    expect(call.model).toMatchObject({
      filesCount: 2,
      linesAdded: 7,
      linesRemoved: 3,
      hiddenCount: 0,
    });
    expect(call.model.rows).toHaveLength(2);
    expect(call.model.rows[0]).toMatchObject({
      filename: 'src/a.ts',
      added: 5,
      removed: 2,
      isBinary: false,
      isUntracked: false,
    });
  });

  it('still returns a plain-text info message for the "clean tree" case', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    const ctx = makeInteractiveContext();
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map(),
    } satisfies GitDiffResult);

    const result = await diffCommand.action(ctx, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect(ctx.ui.addItem).not.toHaveBeenCalled();
  });

  it('still returns an error MessageActionReturn when fetchGitDiff throws', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    const ctx = makeInteractiveContext();
    mockFetchGitDiff.mockRejectedValueOnce(new Error('boom'));

    const result = await diffCommand.action(ctx, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(ctx.ui.addItem).not.toHaveBeenCalled();
  });

  it('propagates hiddenCount to the history item for fast-path results', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    const ctx = makeInteractiveContext();
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 60, linesAdded: 100, linesRemoved: 20 },
      perFileStats: new Map([
        ['src/a.ts', { added: 1, removed: 0, isBinary: false }],
      ]),
    } satisfies GitDiffResult);

    await diffCommand.action(ctx, '');
    const call = (ctx.ui.addItem as Mock).mock.calls[0][0];
    expect(call.model.hiddenCount).toBe(59);
    expect(call.model.rows).toHaveLength(1);
  });
});

describe('computeDiffColumnWidths', () => {
  // Direct contract test — both the Ink component and the plain-text
  // renderer call this helper, so its output binds their column alignment.
  // If anyone changes the formula, both paths must shift together.

  it('reports min widths of 1 for an empty row list', () => {
    expect(computeDiffColumnWidths([])).toEqual({
      addWidth: 1,
      remWidth: 1,
      statColumnWidth: 5, // `+_ -_` with single-digit padding
    });
  });

  it('sizes columns to the widest non-binary row', () => {
    const widths = computeDiffColumnWidths([
      {
        filename: 'a',
        added: 9999,
        removed: 5,
        isBinary: false,
        isUntracked: false,
        isDeleted: false,
        truncated: false,
      },
      {
        filename: 'b',
        added: 2,
        removed: 100,
        isBinary: false,
        isUntracked: false,
        isDeleted: false,
        truncated: false,
      },
    ]);
    // 1 (`+`) + 4 (digits) + 1 (` `) + 1 (`-`) + 3 (digits) = 10
    expect(widths).toEqual({ addWidth: 4, remWidth: 3, statColumnWidth: 10 });
  });

  it('ignores binary rows when computing widths', () => {
    // A binary row must not push the numeric column wider, otherwise the
    // `~` placeholder ends up padded to a column that no real number ever
    // occupies.
    const widths = computeDiffColumnWidths([
      {
        filename: 'a',
        added: 1,
        removed: 1,
        isBinary: false,
        isUntracked: false,
        isDeleted: false,
        truncated: false,
      },
      {
        filename: 'b.bin',
        isBinary: true,
        isUntracked: false,
        isDeleted: false,
        truncated: false,
      },
    ]);
    expect(widths).toEqual({ addWidth: 1, remWidth: 1, statColumnWidth: 5 });
  });

  it('counts untracked text rows in width calculation', () => {
    // Untracked rows render as `+N -0  filename (new)`; their `added`
    // value must be allowed to widen the column.
    const widths = computeDiffColumnWidths([
      {
        filename: 'fresh.log',
        added: 12345,
        removed: 0,
        isBinary: false,
        isUntracked: true,
        isDeleted: false,
        truncated: false,
      },
    ]);
    expect(widths.addWidth).toBe(5);
    expect(widths.statColumnWidth).toBe(1 + 5 + 1 + 1 + 1);
  });
});

describe('diffCommand registration', () => {
  it('declares all execution modes so it works in non-interactive and ACP', () => {
    expect(diffCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });
});

describe('renderDiffModelText filename sanitization', () => {
  // Regression for the non-interactive ANSI-injection vector: the
  // interactive path runs the full HistoryItem through
  // `escapeAnsiCtrlCodes(item)` in `HistoryItemDisplay`, but text output
  // (non-interactive / ACP) was streaming `r.filename` straight into
  // stdout / logs / transports without that hop. A hostile filename like
  // `evil\x1b[31m.txt` could therefore inject color resets, cursor moves,
  // or full screen clears into CI logs. The renderer now pipes filenames
  // through `escapeAnsiCtrlCodes` at the text boundary.
  let mockFetchGitDiff: Mock;
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGitDiff = vi.mocked(fetchGitDiff);
  });

  async function renderText(perFileStats: Map<string, unknown>) {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 1, linesAdded: 1, linesRemoved: 0 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      perFileStats: perFileStats as any,
    } satisfies GitDiffResult);
    const result = await diffCommand.action(makeContextWithCwd(), '');
    return (result as { content: string }).content;
  }

  it('escapes raw ANSI escape sequences embedded in tracked filenames', async () => {
    const evil = 'safe\x1b[31mEVIL\x1b[0m.txt';
    const content = await renderText(
      new Map([[evil, { added: 1, removed: 0, isBinary: false }]]),
    );
    // The raw ESC byte must not survive into the text output — it would
    // otherwise be interpreted as an SGR by any downstream terminal.
    expect(content).not.toContain('\x1b[');
    // The literal escaped form is what `escapeAnsiCtrlCodes` produces.
    expect(content).toContain('\\u001b[31m');
  });

  it('escapes ANSI sequences in untracked / binary / deleted suffix rows', async () => {
    const evilBinary = 'img\x1b[2J.png';
    const evilUntracked = 'note\x1b[H.md';
    const evilDeleted = 'gone\x1b[0K.txt';
    const content = await renderText(
      new Map<string, unknown>([
        [evilBinary, { added: 0, removed: 0, isBinary: true }],
        [
          evilUntracked,
          { added: 1, removed: 0, isBinary: false, isUntracked: true },
        ],
        [
          evilDeleted,
          { added: 0, removed: 1, isBinary: false, isDeleted: true },
        ],
      ]),
    );
    expect(content).not.toContain('\x1b[');
    // All three suffix branches still render their markers.
    expect(content).toContain('(binary)');
    expect(content).toContain('(new)');
    expect(content).toContain('(deleted)');
  });

  it('escapes standalone control bytes that ansi-regex does not match', async () => {
    // Filenames git permits but that aren't part of an ANSI escape sequence:
    // raw newline, carriage return, backspace, BEL, and DEL. Each one would
    // otherwise reorder, overwrite, or beep its way through the rendered
    // diff in the non-interactive / ACP path.
    const newline = 'bad\nINJECTED.txt';
    const cr = 'bad\roverwrite.txt';
    const bs = 'noisy\x08\x08\x08gone.txt';
    const bel = 'beep\x07.txt';
    const del = 'tail\x7f.txt';
    const content = await renderText(
      new Map<string, unknown>([
        [newline, { added: 1, removed: 0, isBinary: false }],
        [cr, { added: 1, removed: 0, isBinary: false }],
        [bs, { added: 1, removed: 0, isBinary: false }],
        [bel, { added: 1, removed: 0, isBinary: false }],
        [del, { added: 1, removed: 0, isBinary: false }],
      ]),
    );
    // None of the raw control bytes should survive into the rendered text.
    expect(content).not.toContain('\n\nINJECTED.txt');
    expect(content).not.toMatch(/\roverwrite\.txt/);
    expect(content).not.toContain('\x08');
    expect(content).not.toContain('\x07');
    expect(content).not.toContain('\x7f');
    // The escaped forms (JSON-style) are what we render instead.
    expect(content).toContain('bad\\nINJECTED.txt');
    expect(content).toContain('bad\\roverwrite.txt');
  });
});
