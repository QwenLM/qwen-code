/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import yargs from 'yargs';
import { handlePrune, pruneCommand } from './prune.js';

const mockPruneUnusedVersions = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    pruneUnusedVersions: mockPruneUnusedVersions,
  }),
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

describe('extensions prune command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses prune flags cleanly', () => {
    const parser = yargs([]).command(pruneCommand).fail(false).locale('en');
    const argv = parser.parse('prune --dry-run --keep-missing-workspaces') as {
      dryRun?: boolean;
      keepMissingWorkspaces?: boolean;
    };
    expect(argv.dryRun).toBe(true);
    expect(argv.keepMissingWorkspaces).toBe(true);
  });

  it('prints dry-run summary without mutating store', async () => {
    mockPruneUnusedVersions.mockResolvedValueOnce({
      pruned: [
        {
          id: 'a'.repeat(64),
          name: 'foo',
          versionSlot: '2.0.0',
          directory: '/tmp/.qwen/extension-versions/foo/2.0.0',
        },
      ],
      removedWorkspaceRefs: 1,
    });

    await handlePrune({ dryRun: true });

    expect(mockPruneUnusedVersions).toHaveBeenCalledWith({
      dryRun: true,
      removeMissingWorkspaces: true,
    });
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Would prune 1 stale workspace reference(s).',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Would prune foo (2.0.0) at /tmp/.qwen/extension-versions/foo/2.0.0',
    );
  });

  it('reports when nothing needs pruning', async () => {
    mockPruneUnusedVersions.mockResolvedValueOnce({
      pruned: [],
      removedWorkspaceRefs: 0,
    });

    await handlePrune();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No unused extension versions to prune.',
    );
  });
});
