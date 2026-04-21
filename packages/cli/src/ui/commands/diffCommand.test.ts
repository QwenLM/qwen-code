/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { diffCommand } from './diffCommand.js';
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
  return createMockCommandContext({
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

  it('aligns untracked/binary rows with the numeric stat column', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 3, linesAdded: 10, linesRemoved: 2 },
      perFileStats: new Map([
        ['src/a.ts', { added: 10, removed: 2, isBinary: false }],
        [
          'new.txt',
          { added: 0, removed: 0, isBinary: false, isUntracked: true },
        ],
        ['img.png', { added: 0, removed: 0, isBinary: true }],
      ]),
    } satisfies GitDiffResult);
    const result = await diffCommand.action(mockContext, '');
    const lines = (result as { content: string }).content.split('\n');
    const aLine = lines.find((l) => l.endsWith('src/a.ts'))!;
    const newLine = lines.find((l) => l.endsWith('new.txt'))!;
    const imgLine = lines.find((l) => l.endsWith('img.png (binary)'))!;
    // Filename column starts at the same offset in every row so that `?` / `~`
    // markers line up with `+X -Y` entries.
    expect(aLine.indexOf('src/a.ts')).toBe(newLine.indexOf('new.txt'));
    expect(aLine.indexOf('src/a.ts')).toBe(imgLine.indexOf('img.png'));
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

describe('diffCommand registration', () => {
  it('declares all execution modes so it works in non-interactive and ACP', () => {
    expect(diffCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });
});
