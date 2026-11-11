/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { CoreEvent, coreEvents, type Config } from '@qwen-code/core';
import { refreshActivePlugins } from './refreshActivePlugins.js';

vi.mock('../refresh.js', () => ({ clearAllPluginCaches: vi.fn() }));

describe('refreshActivePlugins', () => {
  it.each([true, false])(
    'reloads agent resources from refreshed plugins (registry present: %s)',
    async (hasRegistry) => {
      let pluginAgents = ['old-agent'];
      let visibleAgents = ['old-agent'];
      const reloadAgents = async () => {
        visibleAgents = [...pluginAgents];
      };
      const config = {
        getEnabledPlugins: () => [],
        reloadPlugins: async () => {
          pluginAgents = ['new-agent'];
          return { enabled: [], errors: [] };
        },
        getMcpClientManager: () => undefined,
        getHookSystem: () => undefined,
        getAgentRegistry: () =>
          hasRegistry ? { reload: reloadAgents } : undefined,
        reloadAgents: hasRegistry
          ? async () => {
              throw new Error('Existing registry must own the reload');
            }
          : reloadAgents,
      } as unknown as Config;

      await refreshActivePlugins({ config, reason: 'sync-install' });

      expect(visibleAgents).toEqual(['new-agent']);
    },
  );
});

function configWithReload(
  reload: () => Promise<{ enabled: unknown[]; errors: unknown[] }>,
): Config {
  return {
    getEnabledPlugins: () => [],
    reloadPlugins: reload,
    getMcpClientManager: () => undefined,
    getHookSystem: () => undefined,
    getAgentRegistry: () => undefined,
    reloadAgents: async () => {},
    reloadSkills: async () => {},
  } as unknown as Config;
}

describe('refreshActivePlugins 去重作用域', () => {
  it('同一 Config 的并发刷新共享一次执行', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reload = vi.fn(async () => {
      await gate;
      return { enabled: [], errors: [] };
    });
    const config = configWithReload(reload);

    const both = Promise.all([
      refreshActivePlugins({ config, reason: 'reload-command' }),
      refreshActivePlugins({ config, reason: 'reload-command' }),
    ]);
    release();
    const [first, second] = await both;

    expect(reload).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('不同 Config 的并发刷新各自执行，互不吞结果', async () => {
    // 回归模块级单槽去重：会话 B 曾直接拿到会话 A 的 promise——B 的 Config 一次都没
    // 重载，回包却是成功 + A 的插件清单。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reloadA = vi.fn(async () => {
      await gate;
      return { enabled: [{ name: 'a' }], errors: [] };
    });
    const reloadB = vi.fn(async () => {
      await gate;
      return { enabled: [{ name: 'b' }], errors: [] };
    });
    const configA = configWithReload(reloadA);
    const configB = configWithReload(reloadB);

    const both = Promise.all([
      refreshActivePlugins({ config: configA, reason: 'reload-command' }),
      refreshActivePlugins({ config: configB, reason: 'reload-command' }),
    ]);
    release();
    const [resultA, resultB] = await both;

    expect(reloadA).toHaveBeenCalledTimes(1);
    expect(reloadB).toHaveBeenCalledTimes(1);
    expect(resultA.enabled.map((p) => p.name)).toEqual(['a']);
    expect(resultB.enabled.map((p) => p.name)).toEqual(['b']);
  });

  it('在途刷新结算后同 Config 可再次刷新', async () => {
    const reload = vi.fn(async () => ({ enabled: [], errors: [] }));
    const config = configWithReload(reload);
    await refreshActivePlugins({ config, reason: 'sync-install' });
    await refreshActivePlugins({ config, reason: 'sync-install' });
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

it('reports plugin refresh failure to the owning session without swallowing it', async () => {
  const error = new Error('read failed');
  const config = configWithReload(async () => {
    throw error;
  });
  config.getSessionId = () => 'failed-refresh-session';
  const listener = vi.fn();
  const unsubscribe = coreEvents.onSessionEvent(
    CoreEvent.HookDiagnosticsChanged,
    'failed-refresh-session',
    listener,
  );
  try {
    await expect(
      refreshActivePlugins({ config, reason: 'reload-command' }),
    ).rejects.toBe(error);
    expect(listener).toHaveBeenCalledWith({
      sessionId: 'failed-refresh-session',
      failed: true,
    });
  } finally {
    unsubscribe();
  }
});
