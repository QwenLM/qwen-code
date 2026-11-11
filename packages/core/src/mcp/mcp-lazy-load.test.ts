/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';

const { applyMcpLazyLoad } = await import('./mcp-lazy-load.js');

describe('MCP lazy-load application', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks the built-in default (lazy) once per CLI process', async () => {
    const rig = createRig('default', 3, undefined, 'completed', 1, true);

    await expect(applyMcpLazyLoad(rig.config)).resolves.toEqual({
      status: 'default-lazy',
      actualMode: 'lazy',
    });
    await applyMcpLazyLoad(rig.config);
  });

  it('does not override explicit settings or environment choices', async () => {
    for (const source of ['settings', 'environment'] as const) {
      await expect(
        applyMcpLazyLoad(createRig(source).config),
      ).resolves.toMatchObject({ status: 'bypassed-explicit', source });
    }
  });

  it('skips the lazy preference when CodeMode replaces lazy loading', async () => {
    const rig = createRig();
    const manager = rig.config.getMcpClientManager()!;
    rig.config.getCodeModeExposure = () => 'on';
    rig.config.getMcpClientManager = () =>
      ({ ...manager, peekRegistrationMode: () => 'deferred' }) as never;
    await expect(applyMcpLazyLoad(rig.config)).resolves.toEqual({
      status: 'bypassed-code-mode',
      actualMode: 'deferred',
    });
  });

  it('locks and reports no tools without retrying after reload', async () => {
    const rig = createRig('default', 0);
    await expect(applyMcpLazyLoad(rig.config)).resolves.toEqual({
      status: 'not-attempted-no-tools',
      actualMode: 'eager',
    });

    rig.getAllDiscoveredMcpTools.mockReturnValue([
      { serverName: 'server-0', alwaysLoad: false },
    ]);
    await applyMcpLazyLoad(rig.config);
  });

  it('distinguishes pending discovery from a settled empty tool set without retrying', async () => {
    const rig = createRig('default', 0, undefined, 'in_progress', 1);

    await expect(applyMcpLazyLoad(rig.config)).resolves.toEqual({
      status: 'not-attempted-discovery-pending',
      actualMode: 'eager',
    });

    rig.getAllDiscoveredMcpTools.mockReturnValue([
      { serverName: 'server-0', alwaysLoad: false },
    ]);
    await applyMcpLazyLoad(rig.config);
  });

  it.each(['completed', 'in_progress'] as const)(
    '空工具目录保留已配置的模式（%s）',
    async (discoveryState) => {
      const rig = createRig('default', 0, undefined, discoveryState, 1, true);
      const result = await applyMcpLazyLoad(rig.config);
      expect(result.actualMode).toBe('lazy');
      expect(rig.setMcpLazyLoad).not.toHaveBeenCalled();
    },
  );
});

function createRig(
  source: 'default' | 'settings' | 'environment' = 'default',
  toolCount = 3,
  appliedModeOverride?: boolean,
  discoveryState: 'not_started' | 'in_progress' | 'completed' = 'completed',
  configuredServerCount = toolCount > 0 ? 1 : 0,
  initialLazy = false,
) {
  const setMcpLazyLoad = vi.fn();
  let configuredLazy = initialLazy;
  setMcpLazyLoad.mockImplementation((value: boolean) => {
    configuredLazy = value;
  });
  const peekLazyMode = vi.fn(() => appliedModeOverride ?? configuredLazy);
  const getAllDiscoveredMcpTools = vi.fn(() =>
    Array.from({ length: toolCount }, (_, index) => ({
      serverName: `server-${index % 2}`,
      alwaysLoad: index === 0 && toolCount > 1,
    })),
  );
  const config = {
    getSessionId: () => 'session-1',
    isInteractive: () => true,
    getMcpLazyLoadSource: () => source,
    getCodeModeExposure: () => undefined,
    getMcpClientManager: () => ({
      getAllDiscoveredMcpTools,
      getDiscoveryState: () => discoveryState,
      getMcpServers: () =>
        Object.fromEntries(
          Array.from({ length: configuredServerCount }, (_, index) => [
            `server-${index}`,
            {},
          ]),
        ),
      peekLazyMode,
    }),
    setMcpLazyLoad,
  } as unknown as Config;

  return {
    config,
    getAllDiscoveredMcpTools,
    peekLazyMode,
    setMcpLazyLoad,
  };
}
