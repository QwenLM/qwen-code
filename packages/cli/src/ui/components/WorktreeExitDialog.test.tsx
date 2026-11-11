/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeFakeConfig,
  type WorktreeSettings,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { WorktreeExitDialog } from './WorktreeExitDialog.js';

const coreMocks = vi.hoisted(() => ({
  finalize: vi.fn(),
}));

vi.mock('./shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: vi.fn(() => null),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    worktreeSessionService: {
      ...actual.worktreeSessionService,
      finalize: coreMocks.finalize,
    },
  };
});

describe('WorktreeExitDialog', () => {
  const suiteCwd = process.cwd();
  let temporaryRoot: string;
  let ownerSettings: WorktreeSettings;

  beforeEach(() => {
    vi.clearAllMocks();
    temporaryRoot = mkdtempSync(nodePath.join(tmpdir(), 'worktree-exit-'));
    const originalCwd = nodePath.join(temporaryRoot, 'repo');
    const worktreePath = nodePath.join(
      originalCwd,
      '.qwen',
      'worktrees',
      'feature',
    );
    mkdirSync(worktreePath, { recursive: true });
    ownerSettings = {
      name: 'feature',
      path: worktreePath,
      worktreeCwd: worktreePath,
      baseSha: 'current-head',
      lifecycle: 'owner',
      sessionId: 'test-session-id',
      originalCwd,
    };
    coreMocks.finalize.mockImplementation(async (_context, request) =>
      request.action === 'inspect'
        ? {
            action: 'inspect',
            changedFiles: 0,
            commits: 0,
            owner: true,
          }
        : { action: request.action },
    );
  });

  afterEach(() => {
    if (process.cwd() !== suiteCwd) process.chdir(suiteCwd);
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('leaves an attached worktree untouched without offering removal', async () => {
    coreMocks.finalize.mockResolvedValueOnce({
      action: 'inspect',
      changedFiles: 0,
      commits: 0,
      owner: false,
    });
    const onDone = vi.fn();

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog
        worktreeSettings={{ ...ownerSettings, lifecycle: 'attached' }}
        onDone={onDone}
      />,
    );
    await waitUntilReady();

    await act(async () => {
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalledWith(
          'keep',
          `Worktree left untouched at ${ownerSettings.path}`,
        );
      });
    });
    expect(coreMocks.finalize).toHaveBeenLastCalledWith(
      expect.any(Object),
      { action: 'keep' },
    );
    expect(RadioButtonSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('prompts a clean owner instead of deleting on exit', async () => {
    const onDone = vi.fn();

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog worktreeSettings={ownerSettings} onDone={onDone} />,
    );
    await waitUntilReady();

    await act(async () => {
      await vi.waitFor(() => {
        expect(RadioButtonSelect).toHaveBeenCalled();
      });
    });
    expect(coreMocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'runtime',
        sessionId: 'test-session-id',
      }),
      { action: 'inspect' },
    );
    const items = vi.mocked(RadioButtonSelect).mock.calls.at(-1)?.[0].items;
    expect(items?.map((item) => item.value)).toEqual(['keep', 'remove']);
    expect(onDone).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps a Git worktree when its state cannot be verified', async () => {
    coreMocks.finalize.mockResolvedValueOnce({
      action: 'inspect',
      changedFiles: null,
      commits: null,
      owner: true,
    });
    const onDone = vi.fn();

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog worktreeSettings={ownerSettings} onDone={onDone} />,
    );
    await waitUntilReady();

    await act(async () => {
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalledWith(
          'keep',
          `Could not verify worktree state; left untouched at ${ownerSettings.path}`,
        );
      });
    });
    expect(RadioButtonSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('lets a hook-based owner explicitly run removal when inspection is unavailable', async () => {
    coreMocks.finalize.mockResolvedValueOnce({
      action: 'inspect',
      changedFiles: null,
      commits: null,
      owner: true,
    });
    const settings = { ...ownerSettings, hookBased: true, baseSha: '' };
    const onDone = vi.fn();

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog worktreeSettings={settings} onDone={onDone} />,
    );
    await waitUntilReady();
    await act(async () => {
      await vi.waitFor(() => expect(RadioButtonSelect).toHaveBeenCalled());
    });
    const onSelect = vi
      .mocked(RadioButtonSelect)
      .mock.calls.at(-1)?.[0].onSelect;

    await act(async () => {
      onSelect?.('remove');
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalledWith('remove', 'Worktree removed.');
      });
    });

    expect(coreMocks.finalize).toHaveBeenLastCalledWith(
      expect.any(Object),
      { action: 'remove', force: true },
    );
    unmount();
  });

  it('uses the service keep path and preserves the existing completion message', async () => {
    const onDone = vi.fn();

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog worktreeSettings={ownerSettings} onDone={onDone} />,
    );
    await waitUntilReady();
    await act(async () => {
      await vi.waitFor(() => expect(RadioButtonSelect).toHaveBeenCalled());
    });
    const onSelect = vi
      .mocked(RadioButtonSelect)
      .mock.calls.at(-1)?.[0].onSelect;

    await act(async () => {
      onSelect?.('keep');
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalledWith(
          'keep',
          `Worktree kept at ${ownerSettings.path} on branch unknown`,
        );
      });
    });

    expect(coreMocks.finalize).toHaveBeenLastCalledWith(
      expect.any(Object),
      { action: 'keep' },
    );
    unmount();
  });

  it('keeps the worktree when service removal fails and does not relocate JSONL', async () => {
    const onDone = vi.fn();
    const config = makeFakeConfig({
      sessionId: 'test-session-id',
      targetDir: ownerSettings.path,
      cwd: ownerSettings.path,
    });
    coreMocks.finalize
      .mockResolvedValueOnce({
        action: 'inspect',
        changedFiles: 0,
        commits: 0,
        owner: true,
      })
      .mockRejectedValueOnce(new Error('owner mismatch'));

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog worktreeSettings={ownerSettings} onDone={onDone} />,
      { config },
    );
    await waitUntilReady();
    await act(async () => {
      await vi.waitFor(() => expect(RadioButtonSelect).toHaveBeenCalled());
    });
    const onSelect = vi
      .mocked(RadioButtonSelect)
      .mock.calls.at(-1)?.[0].onSelect;

    await act(async () => {
      onSelect?.('remove');
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalledWith(
          'keep',
          `Worktree left untouched at ${ownerSettings.path}: owner mismatch`,
        );
      });
    });

    unmount();
  });

  it('records removal through the active Writer before reporting success', async () => {
    const onDone = vi.fn();
    const config = makeFakeConfig({
      sessionId: 'test-session-id',
      targetDir: ownerSettings.path,
      cwd: ownerSettings.path,
    });
    const recordWorktreeState = vi
      .spyOn(config, 'recordWorktreeState')
      .mockResolvedValue(undefined);
    coreMocks.finalize.mockImplementation(async (context, request) => {
      if (request.action === 'inspect') {
        return {
          action: 'inspect',
          changedFiles: 0,
          commits: 0,
          owner: true,
        };
      }
      if (request.action === 'remove') {
        await context.recordWorktreeState?.(null);
      }
      return { action: request.action };
    });

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog worktreeSettings={ownerSettings} onDone={onDone} />,
      { config },
    );
    await waitUntilReady();
    await act(async () => {
      await vi.waitFor(() => expect(RadioButtonSelect).toHaveBeenCalled());
    });
    const onSelect = vi
      .mocked(RadioButtonSelect)
      .mock.calls.at(-1)?.[0].onSelect;

    await act(async () => {
      onSelect?.('remove');
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalledWith('remove', 'Worktree removed.');
      });
    });

    expect(recordWorktreeState).toHaveBeenCalledWith(null);
    unmount();
  });

  it('reports partial cleanup instead of claiming the worktree was removed', async () => {
    const onDone = vi.fn();
    coreMocks.finalize
      .mockResolvedValueOnce({
        action: 'inspect',
        changedFiles: 0,
        commits: 0,
        owner: true,
      })
      .mockResolvedValueOnce({
        action: 'remove',
        cleanup: {
          status: 'partial',
          message: 'remove hook failed',
        },
      });

    const { waitUntilReady, unmount } = await renderWithProviders(
      <WorktreeExitDialog worktreeSettings={ownerSettings} onDone={onDone} />,
    );
    await waitUntilReady();
    await act(async () => {
      await vi.waitFor(() => expect(RadioButtonSelect).toHaveBeenCalled());
    });
    const onSelect = vi
      .mocked(RadioButtonSelect)
      .mock.calls.at(-1)?.[0].onSelect;

    await act(async () => {
      onSelect?.('remove');
      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalledWith(
          'remove',
          `Exited worktree. Cleanup incomplete; the checkout may remain at ${ownerSettings.path}. remove hook failed`,
        );
      });
    });

    unmount();
  });
});
