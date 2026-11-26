/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnAsync } from '@qwen-code/core';
import { reviewCommand } from './reviewCommand.js';
import type { CommandContext } from './types.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    spawnAsync: vi.fn(),
  };
});

function createCommandContext() {
  const dialogs: React.ReactElement[] = [];
  const setCustomDialog = vi.fn((dialog: React.ReactNode) => {
    if (React.isValidElement(dialog)) {
      dialogs.push(dialog);
    }
  });

  const context = {
    ui: { setCustomDialog },
    services: {
      agentContext: {
        config: {
          getWorkingDir: () => process.cwd(),
        },
      },
    },
  } as unknown as CommandContext;

  return { context, dialogs, setCustomDialog };
}

describe('reviewCommand', () => {
  beforeEach(() => {
    vi.mocked(spawnAsync).mockReset();
  });

  it('submits explicit arguments as custom review instructions', async () => {
    const { context } = createCommandContext();

    const result = await reviewCommand.action?.(
      context,
      'Focus on parser regressions only.',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Focus on parser regressions only.',
      isMeta: true,
    });
  });

  it('classifies explicit bridge invocations as prompt-safe', () => {
    const bridgeCommandType = reviewCommand.bridgeCommandType;

    expect(typeof bridgeCommandType).toBe('function');
    if (typeof bridgeCommandType !== 'function') {
      return;
    }
    expect(
      bridgeCommandType('Focus on parser regressions only.', {
        input: '/review Focus on parser regressions only.',
        command: reviewCommand,
      }),
    ).toBe('prompt');
    expect(
      bridgeCommandType('', {
        input: '/review',
        command: reviewCommand,
      }),
    ).toBe('local-jsx');
  });

  it('submits a generated review prompt after selecting current changes', async () => {
    const { context, dialogs, setCustomDialog } = createCommandContext();

    const resultPromise = reviewCommand.action?.(context, '');
    const firstDialog = dialogs[0];
    expect(firstDialog).toBeDefined();

    const props = firstDialog.props as { onSelect: (mode: string) => void };
    props.onSelect('current_changes');

    const result = await resultPromise;

    expect(setCustomDialog).toHaveBeenCalledWith(null);
    expect(result?.type).toBe('submit_prompt');
    expect(
      String(result && 'content' in result ? result.content : ''),
    ).toContain('Review the current code changes');
    expect(result).not.toHaveProperty('isUserDecision');
  });

  it('marks instructions typed in the dialog as the user own words', async () => {
    const { context, dialogs } = createCommandContext();

    const resultPromise = reviewCommand.action?.(context, '');
    const props = dialogs[0].props as {
      onCustomInstructions: (instructions: string) => void;
    };
    props.onCustomInstructions('Only check the migration scripts.');

    expect(await resultPromise).toEqual({
      type: 'submit_prompt',
      content: 'Only check the migration scripts.',
      isMeta: true,
      isUserDecision: true,
    });
  });

  it('cancels from the commit selector when escape is pressed', async () => {
    vi.mocked(spawnAsync).mockResolvedValue({
      stdout: 'abc1234567890\0Fix review command\n',
      stderr: '',
    });
    const { context, dialogs, setCustomDialog } = createCommandContext();

    const resultPromise = reviewCommand.action?.(context, '');
    const firstDialog = dialogs[0];
    expect(firstDialog).toBeDefined();

    const firstDialogProps = firstDialog.props as {
      onSelect: (mode: string) => void;
    };
    firstDialogProps.onSelect('commit');

    await vi.waitFor(() => {
      expect(dialogs).toHaveLength(2);
    });

    const commitDialog = dialogs[1];
    const commitDialogProps = commitDialog.props as { onClose: () => void };
    commitDialogProps.onClose();

    const result = await resultPromise;

    expect(result).toBeUndefined();
    expect(setCustomDialog).toHaveBeenCalledWith(null);
  });

  it('sorts base branches alphabetically and pins the default branch to the top', async () => {
    vi.mocked(spawnAsync).mockResolvedValue({
      stdout: 'zeta\nfeature/a\nmaster\nmain\nbugfix/b\n',
      stderr: '',
    });
    const { context, dialogs } = createCommandContext();

    const resultPromise = reviewCommand.action?.(context, '');
    const firstDialog = dialogs[0];
    expect(firstDialog).toBeDefined();

    const firstDialogProps = firstDialog.props as {
      onSelect: (mode: string) => void;
    };
    firstDialogProps.onSelect('base_branch');

    await vi.waitFor(() => {
      expect(dialogs).toHaveLength(2);
    });

    const branchDialogProps = dialogs[1].props as {
      branches: Array<{ name: string }>;
      onClose: () => void;
    };

    expect(branchDialogProps.branches.map((branch) => branch.name)).toEqual([
      'main',
      'bugfix/b',
      'feature/a',
      'master',
      'zeta',
    ]);

    branchDialogProps.onClose();
    await resultPromise;
  });
});
