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
  let reload: ReturnType<typeof vi.fn>;
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: './setup.sh' }] }],
  };

  const makeConfig = (): Config => {
    reload = vi.fn().mockResolvedValue(undefined);
    return {
      isProjectHooksPendingApproval: () => pending,
      setProjectHooksPendingApproval: (value: boolean) => {
        pending = value;
      },
      getWorkingDir: () => path.join(dir, 'elsewhere'),
      getHookSystem: () => ({ reload }),
    } as unknown as Config;
  };
  const makeSettings = (projectHooks: Record<string, unknown> | undefined) =>
    ({
      getProjectHooks: () => projectHooks,
      workspace: { path: path.join(dir, '.qwen', 'settings.json') },
    }) as unknown as LoadedSettings;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'use-hooks-approval-'));
    process.env['QWEN_CODE_HOOK_APPROVALS_PATH'] = path.join(
      dir,
      HOOK_APPROVALS_FILENAME,
    );
    resetHookApprovalsForTesting();
    pending = true;
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
    expect(reload).not.toHaveBeenCalled();
    resetHookApprovalsForTesting();
    expect(loadHookApprovals().getState(dir, hooks)).toBe('rejected');
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
