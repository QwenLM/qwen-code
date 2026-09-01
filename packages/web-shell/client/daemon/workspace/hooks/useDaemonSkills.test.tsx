/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => {
  const legacyStatus = {
    v: 1 as const,
    workspaceCwd: '/work/a',
    initialized: true,
    skills: [{ name: 'legacy', status: 'ok' as const }],
  };
  const workspaceClient = {
    workspaceConfigSkills: vi.fn(),
    workspaceRuntimeSkills: vi.fn(),
    runtimeStatus: vi.fn(),
    ensureRuntime: vi.fn(),
    setWorkspaceConfigSkillEnabled: vi.fn(),
    installWorkspaceConfigSkill: vi.fn(),
    deleteWorkspaceConfigSkill: vi.fn(),
  };
  const client = {
    workspaceByCwd: vi.fn(() => workspaceClient),
    installWorkspaceConfigSkill: vi.fn(),
    deleteWorkspaceConfigSkill: vi.fn(),
  };
  const actions = {
    loadSkillsStatus: vi.fn(async () => legacyStatus),
    setWorkspaceSkillEnabled: vi.fn(),
    installWorkspaceSkill: vi.fn(),
    deleteWorkspaceSkill: vi.fn(),
  };
  return {
    actions,
    client,
    context: {
      current: {
        actions,
        capabilities: { features: [] as string[] },
        client,
        workspaceCwd: '/work/a',
      },
    },
    legacyStatus,
    workspaceClient,
  };
});

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => mocks.context.current,
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => undefined,
}));

const { useDaemonSkills } = await import('./useDaemonSkills.js');

describe('useDaemonSkills', () => {
  let container: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof useDaemonSkills> | undefined;

  function HookHost() {
    result = useDaemonSkills({ autoLoad: true });
    return null;
  }

  async function renderHook(): Promise<void> {
    await act(async () => root.render(<HookHost />));
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    result = undefined;
    mocks.context.current.capabilities.features = [];
    for (const fn of [
      ...Object.values(mocks.actions),
      ...Object.values(mocks.workspaceClient),
      mocks.client.installWorkspaceConfigSkill,
      mocks.client.deleteWorkspaceConfigSkill,
    ]) {
      fn.mockClear();
    }
    mocks.actions.loadSkillsStatus.mockResolvedValue(mocks.legacyStatus);
    mocks.actions.setWorkspaceSkillEnabled.mockResolvedValue({ changed: true });
    mocks.actions.installWorkspaceSkill.mockResolvedValue({
      skillName: 'review',
      scope: 'workspace',
      installedPath: '/work/a/.qwen/skills/review/SKILL.md',
    });
    mocks.actions.deleteWorkspaceSkill.mockResolvedValue({
      skillName: 'review',
      scope: 'workspace',
      deleted: true,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('keeps legacy daemons on the legacy Skills routes', async () => {
    await renderHook();
    expect(mocks.actions.loadSkillsStatus).toHaveBeenCalledOnce();
    expect(mocks.workspaceClient.workspaceConfigSkills).not.toHaveBeenCalled();

    await act(async () => {
      await result?.ensureRuntime();
      await result?.setEnabled('review', false, { clientId: 'client-1' });
      await result?.install({
        name: 'review',
        scope: 'workspace',
        source: { type: 'folder', path: '/tmp/review' },
      });
      await result?.remove('review', 'workspace');
    });

    expect(mocks.workspaceClient.ensureRuntime).not.toHaveBeenCalled();
    expect(mocks.actions.setWorkspaceSkillEnabled).toHaveBeenCalledOnce();
    expect(mocks.actions.installWorkspaceSkill).toHaveBeenCalledOnce();
    expect(mocks.actions.deleteWorkspaceSkill).toHaveBeenCalledOnce();
  });

  it('does not route a legacy secondary workspace to primary', async () => {
    function SecondaryHookHost() {
      result = useDaemonSkills({
        autoLoad: true,
        workspaceCwd: '/work/secondary',
      });
      return null;
    }

    await act(async () => root.render(<SecondaryHookHost />));

    expect(result?.error?.message).toBe(
      'Legacy Skills management supports only the primary workspace.',
    );
    expect(mocks.actions.loadSkillsStatus).not.toHaveBeenCalled();
  });

  it('keeps config Skills when the runtime epoch does not match', async () => {
    mocks.context.current.capabilities.features = [
      'workspace_skills_config_runtime',
    ];
    mocks.workspaceClient.workspaceConfigSkills.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      initialized: true,
      skills: [{ name: 'configured', status: 'ok' }],
    });
    mocks.workspaceClient.ensureRuntime.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      state: 'active',
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: { state: 'ready', revision: 1, runtimeEpoch: 4 },
      },
    });
    mocks.workspaceClient.workspaceRuntimeSkills.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      initialized: true,
      runtimeEpoch: 3,
      skills: [{ name: 'stale-runtime', status: 'ok' }],
    });

    await renderHook();
    await act(async () => {
      await result?.ensureRuntime();
      await result?.setEnabled('configured', false, {
        clientId: 'client-1',
      });
    });

    expect(result?.skills.map((skill) => skill.name)).toEqual(['configured']);
    expect(
      mocks.workspaceClient.setWorkspaceConfigSkillEnabled,
    ).toHaveBeenCalledWith('configured', false, { clientId: 'client-1' });

    mocks.context.current.capabilities.features = [];
    await renderHook();
    expect(result?.skills.map((skill) => skill.name)).toEqual(['legacy']);
  });

  it('drops a stopped runtime catalog and prepares a new epoch', async () => {
    vi.useFakeTimers();
    mocks.context.current.capabilities.features = [
      'workspace_skills_config_runtime',
    ];
    mocks.workspaceClient.workspaceConfigSkills.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      initialized: true,
      skills: [{ name: 'configured', status: 'ok' }],
    });
    mocks.workspaceClient.workspaceRuntimeSkills
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        runtimeEpoch: 4,
        skills: [{ name: 'runtime-4', status: 'ok' }],
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        runtimeEpoch: 5,
        skills: [{ name: 'runtime-5', status: 'ok' }],
      });
    mocks.workspaceClient.ensureRuntime
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        state: 'active',
        runtimeLive: true,
        runtimeEpoch: 4,
        capabilities: {
          skills: { state: 'ready', revision: 1, runtimeEpoch: 4 },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        state: 'active',
        runtimeLive: true,
        runtimeEpoch: 5,
        capabilities: {
          skills: { state: 'ready', revision: 1, runtimeEpoch: 5 },
        },
      });
    mocks.workspaceClient.runtimeStatus
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        state: 'cold',
        runtimeLive: false,
        runtimeEpoch: 4,
        capabilities: {
          skills: { state: 'stale', revision: 1, runtimeEpoch: 4 },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        state: 'active',
        runtimeLive: true,
        runtimeEpoch: 5,
        capabilities: {
          skills: { state: 'starting', revision: 1, runtimeEpoch: 5 },
        },
      });

    await renderHook();
    await act(async () => {
      await result?.ensureRuntime();
    });
    expect(result?.skills.map((skill) => skill.name)).toEqual([
      'configured',
      'runtime-4',
    ]);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(result?.skills.map((skill) => skill.name)).toEqual(['configured']);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.workspaceClient.ensureRuntime).toHaveBeenCalledTimes(2);
    expect(result?.skills.map((skill) => skill.name)).toEqual([
      'configured',
      'runtime-5',
    ]);
  });

  it('loads the runtime catalog when background preparation becomes ready', async () => {
    vi.useFakeTimers();
    mocks.context.current.capabilities.features = [
      'workspace_skills_config_runtime',
    ];
    mocks.workspaceClient.workspaceConfigSkills.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      initialized: true,
      skills: [{ name: 'configured', status: 'ok' }],
    });
    mocks.workspaceClient.ensureRuntime.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      state: 'active',
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: { state: 'starting', revision: 1, runtimeEpoch: 4 },
      },
    });
    mocks.workspaceClient.workspaceRuntimeSkills
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        initialized: false,
        runtimeEpoch: 4,
        skills: [],
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        runtimeEpoch: 4,
        skills: [{ name: 'runtime', status: 'ok' }],
      });
    mocks.workspaceClient.runtimeStatus.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      state: 'active',
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: { state: 'ready', revision: 1, runtimeEpoch: 4 },
      },
    });

    await renderHook();
    await act(async () => {
      await result?.ensureRuntime();
    });
    expect(result?.skills.map((skill) => skill.name)).toEqual(['configured']);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(result?.skills.map((skill) => skill.name)).toEqual([
      'configured',
      'runtime',
    ]);
  });

  it('reloads the runtime catalog when its revision changes', async () => {
    vi.useFakeTimers();
    mocks.context.current.capabilities.features = [
      'workspace_skills_config_runtime',
    ];
    const configStatus = {
      v: 1 as const,
      workspaceCwd: '/work/a',
      initialized: true,
      skills: [],
    };
    mocks.workspaceClient.workspaceConfigSkills
      .mockResolvedValueOnce(configStatus)
      .mockRejectedValueOnce(new Error('temporary config failure'))
      .mockResolvedValue(configStatus);
    mocks.workspaceClient.ensureRuntime.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      state: 'active',
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: { state: 'ready', revision: 1, runtimeEpoch: 4 },
      },
    });
    mocks.workspaceClient.workspaceRuntimeSkills
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        runtimeEpoch: 4,
        skills: [{ name: 'runtime-1', status: 'ok' }],
      })
      .mockResolvedValue({
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        runtimeEpoch: 4,
        skills: [{ name: 'runtime-2', status: 'ok' }],
      });
    mocks.workspaceClient.runtimeStatus.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      state: 'active',
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: { state: 'ready', revision: 2, runtimeEpoch: 4 },
      },
    });

    await renderHook();
    await act(async () => {
      await result?.ensureRuntime();
    });
    expect(result?.skills.map((skill) => skill.name)).toEqual(['runtime-1']);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(result?.skills.map((skill) => skill.name)).toEqual(['runtime-2']);
    expect(mocks.workspaceClient.workspaceConfigSkills).toHaveBeenCalledTimes(
      2,
    );

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.workspaceClient.workspaceConfigSkills).toHaveBeenCalledTimes(
      3,
    );
  });

  it('ensures the runtime during a manual reload', async () => {
    mocks.context.current.capabilities.features = [
      'workspace_skills_config_runtime',
    ];
    mocks.workspaceClient.workspaceConfigSkills.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      initialized: true,
      skills: [],
    });
    mocks.workspaceClient.ensureRuntime.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      state: 'active',
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: { state: 'ready', revision: 1, runtimeEpoch: 4 },
      },
    });
    mocks.workspaceClient.workspaceRuntimeSkills.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/a',
      initialized: true,
      runtimeEpoch: 4,
      skills: [],
    });

    await renderHook();
    await act(async () => {
      await result?.reload();
    });

    expect(mocks.workspaceClient.ensureRuntime).toHaveBeenCalledOnce();
    expect(mocks.workspaceClient.workspaceRuntimeSkills).toHaveBeenCalledOnce();
  });
});
