/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { makeFakeConfig } from '@qwen-code/core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { waitFor } from '../../../test-utils/async.js';
import { MemoryOverview } from './MemoryOverview.js';
import { isGitRepository } from '../../utils/gitDiff.js';
import { openFileInEditor } from '../../utils/editorUtils.js';

vi.mock('../../utils/editorUtils.js', () => ({
  openFileInEditor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/gitDiff.js', () => ({
  isGitRepository: vi.fn().mockResolvedValue(false),
}));

describe('MemoryOverview Worktree resources', () => {
  it('shows memory before repository detection finishes and updates the project label', async () => {
    let resolveProbe!: (value: boolean) => void;
    vi.mocked(isGitRepository).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const config = makeFakeConfig({
      autoMemoryEnabled: false,
      autoMemoryUserScopeEnabled: false,
    });
    const cwd = config.storage.getProjectRoot();
    vi.spyOn(config, 'getCategorizedMemoryPaths').mockReturnValue({
      global: [],
      plugin: [],
      local: [],
      project: [path.join(cwd, config.getCurrentContextFileName())],
    });
    const view = await renderWithProviders(
      <MemoryOverview config={config} onClose={() => {}} />,
      { config },
    );
    try {
      expect(view.lastFrame()).toContain('Saved in');
      expect(isGitRepository).toHaveBeenCalledWith(cwd);
      await act(async () => resolveProbe(true));
      await waitFor(() => expect(view.lastFrame()).toContain('Checked in at'));
    } finally {
      view.unmount();
      await config.dispose();
    }
  });

  it('creates project memory in the original project after the runtime cwd changes', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'memory-worktree-'),
    );
    const originalCwd = path.join(temporaryRoot, 'project');
    const worktreeCwd = path.join(temporaryRoot, 'worktree');
    await fs.mkdir(originalCwd);
    await fs.mkdir(worktreeCwd);
    const config = makeFakeConfig({
      targetDir: originalCwd,
      cwd: originalCwd,
      autoMemoryEnabled: false,
      autoMemoryUserScopeEnabled: false,
    });
    config.setTargetDir(worktreeCwd);
    config.setWorkingDir(worktreeCwd);
    const view = await renderWithProviders(
      <MemoryOverview config={config} onClose={() => {}} />,
      { config },
    );
    try {
      await act(async () => {
        view.stdin.write('2');
      });
      await waitFor(() => expect(openFileInEditor).toHaveBeenCalled());

      const fileName = path.basename(config.getCurrentContextFileName());
      expect(await fs.readFile(path.join(originalCwd, fileName), 'utf8')).toBe(
        '',
      );
      await expect(
        fs.stat(path.join(worktreeCwd, fileName)),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      view.unmount();
      await config.dispose();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
