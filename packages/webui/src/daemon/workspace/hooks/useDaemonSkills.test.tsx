/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadSkillsConfigStatus, loadSkillsStatus, ensureRuntime, actions } =
  vi.hoisted(() => {
    const loadConfig = vi.fn();
    const loadRuntime = vi.fn();
    const prepareRuntime = vi.fn();
    return {
      loadSkillsConfigStatus: loadConfig,
      loadSkillsStatus: loadRuntime,
      ensureRuntime: prepareRuntime,
      actions: {
        loadSkillsConfigStatus: loadConfig,
        loadSkillsStatus: loadRuntime,
        ensureRuntime: prepareRuntime,
        setWorkspaceSkillEnabled: vi.fn(),
        installWorkspaceSkill: vi.fn(),
        deleteWorkspaceSkill: vi.fn(),
      },
    };
  });

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspaceActions: () => actions,
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => undefined,
}));

const { useDaemonSkills } = await import('./useDaemonSkills.js');

describe('useDaemonSkills', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadSkillsConfigStatus.mockReset();
    loadSkillsStatus.mockReset();
    ensureRuntime.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads only the config inventory on mount', async () => {
    loadSkillsConfigStatus.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'config',
      skills: [{ name: 'review', status: 'ok' }],
    });
    let result: ReturnType<typeof useDaemonSkills> | undefined;

    function TestComponent() {
      result = useDaemonSkills({ autoLoad: true });
      return null;
    }

    await act(async () => {
      root.render((<TestComponent />) as ReactNode);
      await Promise.resolve();
    });

    expect(result?.configStatus?.source).toBe('config');
    expect(result?.skills).toEqual([{ name: 'review', status: 'ok' }]);
    expect(result?.runtimeStatus).toBeUndefined();
    expect(result?.loading).toBe(false);
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(loadSkillsStatus).not.toHaveBeenCalled();
  });

  it('ensures only when explicitly requested and reuses its runtime status', async () => {
    const staleCatalog = {
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      runtimeEpoch: 2,
      source: 'config',
      skills: [{ name: 'review', status: 'disabled' }],
    };
    const liveCatalog = {
      ...staleCatalog,
      initialized: true,
      runtimeEpoch: 4,
      source: 'live',
      skills: [{ name: 'review', status: 'ok' }],
    };
    const liveRuntime = {
      v: 1 as const,
      workspaceCwd: '/workspace',
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: {
          state: 'ready',
          runtimeEpoch: 4,
        },
      },
    };
    loadSkillsConfigStatus.mockResolvedValue(staleCatalog);
    loadSkillsStatus.mockResolvedValue({
      ...liveCatalog,
      runtimeState: 'ready',
      coordinatorRuntimeEpoch: 4,
      capabilityRuntimeEpoch: 4,
      runtimeCatalogEpoch: 4,
      runtimeCatalogInitialized: true,
      runtimeCatalogSource: 'live',
      runtimeSkills: liveCatalog.skills,
    });
    ensureRuntime.mockResolvedValue(liveRuntime);
    let result: ReturnType<typeof useDaemonSkills> | undefined;

    function TestComponent() {
      result = useDaemonSkills({ autoLoad: true });
      return null;
    }

    await act(async () => {
      root.render((<TestComponent />) as ReactNode);
    });

    expect(result?.runtimeStatus).toBeUndefined();
    expect(ensureRuntime).not.toHaveBeenCalled();

    let prepared:
      | Awaited<ReturnType<ReturnType<typeof useDaemonSkills>['ensureRuntime']>>
      | undefined;
    await act(async () => {
      prepared = await result?.ensureRuntime();
    });

    expect(ensureRuntime).toHaveBeenCalledOnce();
    expect(loadSkillsStatus).toHaveBeenCalledOnce();
    expect(loadSkillsStatus).toHaveBeenCalledWith(liveRuntime);
    expect(prepared).toMatchObject({
      runtimeState: 'ready',
      coordinatorRuntimeEpoch: 4,
      capabilityRuntimeEpoch: 4,
      runtimeCatalogEpoch: 4,
      runtimeCatalogInitialized: true,
      runtimeCatalogSource: 'live',
    });
    expect(result?.runtimeStatus).toMatchObject({
      runtimeState: 'ready',
      coordinatorRuntimeEpoch: 4,
      capabilityRuntimeEpoch: 4,
    });
  });

  it('keeps an ensure warning visible when the config fallback loads', async () => {
    const fallback = {
      v: 1 as const,
      workspaceCwd: '/workspace',
      initialized: false,
      source: 'config' as const,
      skills: [],
      runtimeState: 'error' as const,
    };
    ensureRuntime.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      state: 'error',
      runtimeLive: false,
      runtimeEpoch: 0,
      capabilities: {
        skills: {
          state: 'error',
          error: { code: 'skills_prepare_failed', message: 'ACP unavailable' },
        },
      },
    });
    loadSkillsStatus.mockResolvedValue(fallback);
    let result: ReturnType<typeof useDaemonSkills> | undefined;

    function TestComponent() {
      result = useDaemonSkills();
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    await act(async () => {
      await result?.ensureRuntime();
    });

    expect(result?.warning?.message).toBe('ACP unavailable');
    expect(result?.error).toBeUndefined();
  });

  it('keeps ordinary config and snapshot reloads read-only', async () => {
    const catalog = {
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      runtimeEpoch: 2,
      source: 'config',
      skills: [],
    };
    loadSkillsConfigStatus.mockResolvedValue(catalog);
    loadSkillsStatus.mockResolvedValue(catalog);
    let result: ReturnType<typeof useDaemonSkills> | undefined;

    function TestComponent() {
      result = useDaemonSkills({ autoLoad: true });
      return null;
    }

    await act(async () => {
      root.render((<TestComponent />) as ReactNode);
    });
    await act(async () => {
      await result?.reloadConfig();
      await result?.reload();
    });

    expect(loadSkillsConfigStatus).toHaveBeenCalledTimes(3);
    expect(loadSkillsStatus).toHaveBeenCalledOnce();
    expect(ensureRuntime).not.toHaveBeenCalled();
  });
});
