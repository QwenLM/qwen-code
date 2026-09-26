/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, deriveConfig } from '../config/config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import { GlobTool } from './glob.js';
import { LSTool } from './ls.js';
import { GrepTool } from './grep.js';
import { RipGrepTool } from './ripGrep.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import {
  createBuiltinManagedToolRuntime,
  type ManagedToolRuntime,
} from './managed-tool-runtime.js';
import { ToolRegistry } from './tool-registry.js';

vi.mock('../utils/ripgrepUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/ripgrepUtils.js')>()),
  canUseRipgrep: vi.fn(),
}));

describe('managed search Runtime context', () => {
  let root: string;
  let config: Config;
  let registry: ToolRegistry;
  let runtime: ManagedToolRuntime | undefined;
  const registration = vi.fn<PermissionManager['getToolRegistrationStatus']>();

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'managed-search-context-')),
    );
    vi.stubEnv('QWEN_HOME', join(root, 'home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(root, 'worker-output'));
    vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', undefined);
    config = new Config({
      targetDir: root,
      cwd: root,
      model: 'test',
      debugMode: false,
      telemetry: { enabled: false },
      usageStatisticsEnabled: false,
    });
    registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registration.mockReset().mockResolvedValue('registered');
    vi.spyOn(config, 'getPermissionManager').mockReturnValue({
      getToolRegistrationStatus: registration,
    } as unknown as PermissionManager);
    runtime = undefined;
    vi.mocked(canUseRipgrep).mockReset().mockResolvedValue(true);
  });
  afterEach(async () => {
    await runtime?.dispose();
    await registry.stop();
    await config.shutdown({ shutdownTelemetry: false });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['registered', 'deferred', 'disabled'] as const)(
    'preserves Runtime %s permission status when the Gateway explicitly enables LS',
    async (status) => {
      registration.mockResolvedValue(status);
      const view = deriveConfig(config, { isLsToolEnabled: () => true });
      expect(config.isLsToolEnabled()).toBe(false);
      runtime = await createBuiltinManagedToolRuntime(config, undefined, view);
      expect(registration).toHaveBeenCalledWith(LSTool.Name);
      if (status === 'disabled') {
        expect(runtime.manifest().tools).toEqual([]);
        expect(registry.getAllToolNames()).not.toContain(LSTool.Name);
      } else {
        expect(registry.getTool(LSTool.Name)).toBeInstanceOf(LSTool);
        expect(runtime.manifest().tools.map((tool) => tool.name)).toEqual([
          LSTool.Name,
        ]);
        expect(registry.isPermissionDeferred(LSTool.Name)).toBe(
          status === 'deferred',
        );
        class ReplacedLS extends LSTool {}
        registry.registerTool(new ReplacedLS(config));
        expect(runtime.manifest().tools).toEqual([]);
      }
    },
  );

  it('does not enable LS without a Gateway opt-in or overwrite an existing lazy name', async () => {
    const view = deriveConfig(config, { isLsToolEnabled: () => false });
    runtime = await createBuiltinManagedToolRuntime(config, undefined, view);
    expect(registration).not.toHaveBeenCalled();
    expect(runtime.manifest().tools).toEqual([]);
    await runtime.dispose();
    const existing = vi.fn(async () => new LSTool(config));
    registry.registerFactory(LSTool.Name, existing);
    runtime = await createBuiltinManagedToolRuntime(
      config,
      undefined,
      deriveConfig(config, { isLsToolEnabled: () => true }),
    );
    expect(registration).not.toHaveBeenCalled();
    expect(existing).not.toHaveBeenCalled();
    expect(registry.getAllToolNames()).toEqual([LSTool.Name]);
    expect(runtime.manifest().tools).toEqual([]);
  });

  it('does not publish LS after a failed permission check', async () => {
    registration.mockRejectedValue(new Error('policy unavailable'));
    await expect(
      createBuiltinManagedToolRuntime(
        config,
        undefined,
        deriveConfig(config, { isLsToolEnabled: () => true }),
      ),
    ).rejects.toThrow('policy unavailable');
    expect(registry.getAllToolNames()).toEqual([]);
  });

  it('keeps an explicitly disabled LS out of the Runtime registry', async () => {
    config.setDisabledTools(new Set([LSTool.Name]));
    runtime = await createBuiltinManagedToolRuntime(
      config,
      undefined,
      deriveConfig(config, { isLsToolEnabled: () => true }),
    );
    expect(registry.getAllToolNames()).toEqual([]);
    expect(runtime.manifest().tools).toEqual([]);
  });

  it('uses the supplied memory root for search permissions instead of the worker output root', async () => {
    const workspace = join(root, 'workspace');
    const memory = join(root, 'gateway-memory');
    const worker = join(root, 'worker-output');
    const outside = join(root, 'outside');
    for (const directory of [workspace, memory, worker, outside])
      await mkdir(directory, { recursive: true });
    config.getWorkspaceContext().setDirectories([workspace]);
    const view = deriveConfig(config, { getMemoryBaseDir: () => memory });
    for (const selected of [view, config]) {
      const glob = new GlobTool(selected);
      const ls = new LSTool(selected);
      const selectedMemory = selected === view ? memory : worker;
      const otherMemory = selected === view ? worker : memory;
      for (const [directory, permission] of [
        [selectedMemory, 'allow'],
        [otherMemory, 'ask'],
        [outside, 'ask'],
      ] as const) {
        expect(
          await glob
            .build({ pattern: '*', path: directory })
            .getDefaultPermission(),
        ).toBe(permission);
        expect(await ls.build({ path: directory }).getDefaultPermission()).toBe(
          permission,
        );
      }
    }
  });

  it.each([
    { useRipgrep: false, healthy: true, selected: GrepTool },
    { useRipgrep: true, healthy: false, selected: GrepTool },
    { useRipgrep: true, healthy: true, selected: RipGrepTool },
  ])(
    'selects only the bound Grep backend ($useRipgrep / $healthy)',
    async ({ useRipgrep, healthy, selected }) => {
      registry.registerTool(new RipGrepTool(config));
      vi.mocked(canUseRipgrep).mockResolvedValue(healthy);
      const view = deriveConfig(config, {
        getUseRipgrep: () => useRipgrep,
        getUseBuiltinRipgrep: () => false,
      });
      const fallbackBuild = vi.spyOn(GrepTool.prototype, 'build');
      const ripgrepBuild = vi.spyOn(RipGrepTool.prototype, 'build');
      runtime = await createBuiltinManagedToolRuntime(config, undefined, view);
      const manifest = runtime.manifest();
      expect(manifest.tools.map((tool) => tool.name)).toEqual([GrepTool.Name]);
      const call = {
        sessionId: config.getSessionId(),
        promptId: 'grep-turn',
        callId: 'grep-call',
        capabilityDigest: manifest.capabilityDigest,
        policyRevision: manifest.policyRevision,
      };
      await runtime.beginTurn(call);
      await runtime.prepare(call, GrepTool.Name, { pattern: 'needle' });
      expect(fallbackBuild).toHaveBeenCalledTimes(
        selected === GrepTool ? 1 : 0,
      );
      expect(ripgrepBuild).toHaveBeenCalledTimes(
        selected === RipGrepTool ? 1 : 0,
      );
      if (useRipgrep)
        expect(canUseRipgrep).toHaveBeenCalledWith(false, {
          requireProcessGroupExit: true,
          cwd: root,
        });
      else expect(canUseRipgrep).not.toHaveBeenCalled();
      registry.registerTool(new RipGrepTool(config));
      expect(runtime.manifest().tools).toEqual([]);
    },
  );

  it('does not probe or admit a missing or replaced Grep implementation', async () => {
    class CustomGrep extends GrepTool {}
    registry.registerTool(new CustomGrep(config));
    runtime = await createBuiltinManagedToolRuntime(config);
    expect(runtime.manifest().tools).toEqual([]);
    expect(canUseRipgrep).not.toHaveBeenCalled();
  });
});
