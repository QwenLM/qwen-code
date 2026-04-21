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
import { fetchGitDiff } from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...actual,
    fetchGitDiff: vi.fn(),
  };
});

describe('diffCommand', () => {
  let mockContext: CommandContext;
  let mockFetchGitDiff: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGitDiff = vi.mocked(fetchGitDiff) as unknown as Mock;

    mockContext = createMockCommandContext({
      services: {
        config: {
          getWorkingDir: () => '/tmp/repo',
          getProjectRoot: () => '/tmp/repo',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
  });

  it('errors when config is unavailable', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    const noConfigContext = createMockCommandContext();
    const result = await diffCommand.action(noConfigContext, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
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
    });
    const result = await diffCommand.action(mockContext, '');
    expect((result as { content: string }).content).toMatch(
      /Clean working tree/i,
    );
  });

  it('renders header and per-file rows with +added / -removed', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 2, linesAdded: 7, linesRemoved: 3 },
      perFileStats: new Map([
        ['src/a.ts', { added: 5, removed: 2, isBinary: false }],
        ['src/b.ts', { added: 2, removed: 1, isBinary: false }],
      ]),
    });
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    expect(content).toContain('2 files changed');
    expect(content).toContain('+7');
    expect(content).toContain('-3');
    expect(content).toContain('src/a.ts');
    expect(content).toContain('src/b.ts');
  });

  it('marks untracked and binary entries distinctly', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 2, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map([
        [
          'new.txt',
          { added: 0, removed: 0, isBinary: false, isUntracked: true },
        ],
        ['img.png', { added: 0, removed: 0, isBinary: true }],
      ]),
    });
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    expect(content).toContain('?');
    expect(content).toContain('new.txt');
    expect(content).toContain('(binary)');
    expect(content).toContain('img.png');
  });

  it('notes how many files were hidden beyond the per-file cap', async () => {
    if (!diffCommand.action) throw new Error('Command has no action');
    mockFetchGitDiff.mockResolvedValue({
      stats: { filesCount: 60, linesAdded: 100, linesRemoved: 20 },
      perFileStats: new Map([
        ['src/a.ts', { added: 1, removed: 0, isBinary: false }],
      ]),
    });
    const result = await diffCommand.action(mockContext, '');
    const content = (result as { content: string }).content;
    expect(content).toContain('60 files changed');
    expect(content).toMatch(/59 more/);
  });
});
