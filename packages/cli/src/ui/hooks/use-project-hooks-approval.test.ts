/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { useProjectHooksApproval } from './use-project-hooks-approval.js';
import { ProjectHooksApprovalChoice } from '../components/hooks/ProjectHooksApprovalDialog.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import {
  HOOK_APPROVALS_FILENAME,
  loadHookApprovals,
  resetHookApprovalsForTesting,
} from '../../config/hook-approvals.js';

describe('useProjectHooksApproval', () => {
  let dir: string;
  let pending: boolean;
  let rejected: boolean;
  let reload: ReturnType<typeof vi.fn>;
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: './setup.sh' }] }],
  };

  const makeConfig = (): Config => {
    reload = vi.fn().mockResolvedValue(undefined);
    return {
      isProjectHooksPendingApproval: () => pending,
      setProjectHooksPendingApproval: (value: boolean, rej = false) => {
        pending = value;
        rejected = rej;
      },
      getWorkingDir: () => path.join(dir, 'elsewhere'),
      getHookSystem: () => ({ reload }),
    } as unknown as Config;
  };
  const makeSettings = (projectHooks: Record<string, unknown> | undefined) =>
    ({
      getProjectHooks: () => projectHooks,
      workspace: {
        path: path.join(dir, '.qwen', 'settings.json'),
        originalSettings: { hooks: projectHooks },
      },
    }) as unknown as LoadedSettings;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'use-hooks-approval-'));
    process.env['QWEN_CODE_HOOK_APPROVALS_PATH'] = path.join(
      dir,
      HOOK_APPROVALS_FILENAME,
    );
    resetHookApprovalsForTesting();
    pending = true;
    rejected = false;
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_HOOK_APPROVALS_PATH'];
    resetHookApprovalsForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is closed when the config does not gate the project hooks', () => {
    pending = false;
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(false);
  });

  it('opens with one line per hook while the decision is pending', () => {
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(true);
    expect(result.current.pendingProjectHooks?.lines).toEqual([
      'SessionStart  ./setup.sh',
    ]);
  });

  it('does not re-prompt a settled rejection', async () => {
    await loadHookApprovals().setState(dir, hooks, 'rejected');
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(false);
  });

  it.each([
    [ProjectHooksApprovalChoice.APPROVE, false],
    [ProjectHooksApprovalChoice.REJECT, false],
    [ProjectHooksApprovalChoice.DISMISS, true],
  ])('on %s, notes withheld hooks: %s', async (choice, notes) => {
    const addInfo = vi.fn();
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings, addInfo),
    );
    await act(() => result.current.handleProjectHooksApprovalSelect(choice));
    expect(addInfo).toHaveBeenCalledTimes(notes ? 1 : 0);
    if (notes) {
      expect(addInfo.mock.calls[0][0]).toContain('were not loaded');
    }
  });

  it('approve persists, un-gates the session, reloads the hooks and closes', async () => {
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    await act(() =>
      result.current.handleProjectHooksApprovalSelect(
        ProjectHooksApprovalChoice.APPROVE,
      ),
    );
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(false);
    expect(pending).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    resetHookApprovalsForTesting();
    expect(loadHookApprovals().getState(dir, hooks)).toBe('approved');
  });

  it('reject persists the rejection, keeps the gate and closes', async () => {
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    await act(() =>
      result.current.handleProjectHooksApprovalSelect(
        ProjectHooksApprovalChoice.REJECT,
      ),
    );
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(false);
    expect(pending).toBe(true);
    expect(rejected).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    resetHookApprovalsForTesting();
    expect(loadHookApprovals().getState(dir, hooks)).toBe('rejected');
  });

  it('keeps the hooks withheld and says so when the decision cannot be saved', async () => {
    fs.mkdirSync(path.join(dir, HOOK_APPROVALS_FILENAME));
    const addInfo = vi.fn();
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings, addInfo),
    );
    await act(() =>
      result.current.handleProjectHooksApprovalSelect(
        ProjectHooksApprovalChoice.APPROVE,
      ),
    );
    expect(pending).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(addInfo.mock.calls[0][0]).toContain('could not be saved');
  });

  it('keeps one select handler across a new addInfo', () => {
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result, rerender } = renderHook(
      ({ addInfo }: { addInfo: (text: string) => void }) =>
        useProjectHooksApproval(config, settings, addInfo),
      { initialProps: { addInfo: vi.fn() } },
    );
    const before = result.current.handleProjectHooksApprovalSelect;
    rerender({ addInfo: vi.fn() });
    expect(result.current.handleProjectHooksApprovalSelect).toBe(before);
  });

  it('dismiss closes without storing a decision, so the next start asks again', async () => {
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    await act(() =>
      result.current.handleProjectHooksApprovalSelect(
        ProjectHooksApprovalChoice.DISMISS,
      ),
    );
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(false);
    expect(pending).toBe(true);
    resetHookApprovalsForTesting();
    expect(loadHookApprovals().getState(dir, hooks)).toBe('pending');
  });

  it('stays dismissed for the session until the block changes', async () => {
    const config = makeConfig();
    const current = { hooks: hooks as Record<string, unknown> };
    const settings = {
      getProjectHooks: () => current.hooks,
      workspace: {
        path: path.join(dir, '.qwen', 'settings.json'),
        get originalSettings() {
          return { hooks: current.hooks };
        },
      },
    } as unknown as LoadedSettings;
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    await act(() =>
      result.current.handleProjectHooksApprovalSelect(
        ProjectHooksApprovalChoice.DISMISS,
      ),
    );
    // A `/hooks` reload of the same block must not re-open it.
    act(() => {
      appEvents.emit(AppEvent.ProjectHooksPendingApprovalChanged);
    });
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(false);
    act(() => {
      current.hooks = {
        SessionStart: [{ hooks: [{ type: 'command', command: './other.sh' }] }],
      };
      appEvents.emit(AppEvent.ProjectHooksPendingApprovalChanged);
    });
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(true);
  });

  it('re-evaluates when a hooks reload leaves the block pending', () => {
    pending = false;
    const config = makeConfig();
    const settings = makeSettings(hooks);
    const { result } = renderHook(() =>
      useProjectHooksApproval(config, settings),
    );
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(false);
    act(() => {
      pending = true;
      appEvents.emit(AppEvent.ProjectHooksPendingApprovalChanged);
    });
    expect(result.current.isProjectHooksApprovalDialogOpen).toBe(true);
  });
});
