/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskUserTool, Config, ResourceService, ToolRegistry, installConfigService, stopConfigService } from '@qwen-code/core';
import { EnvConfigService } from '../../../../../core/src/config-service/env-config-service.js';
import { AskUserAsyncTool } from '../../../../../core/src/tools/ask-user-async.js';
import { SleepTool } from '../../../../../core/src/tools/sleep.js';
import { SettingsService } from '@qwen-code/resource';
import { createEmptyLoadedSettings, attachTestPermission } from '../../../../../core/src/test-utils/config.js';
import type { ThreadSessionInternals } from '../contract/handlerContract.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type { ThreadSessionDeclarations } from '../contract/threadSessionTypes.js';
import { initialize } from './initializeHandlers.js';

// Snapshot collection is unrelated to model/permission ordering; keep the real Config checks.
vi.mock('../initialize/sessionInitializeSnapshot.js', () => ({
  buildSessionInitializeSnapshot: async (config: Config) => ({
    commands: [],
    permissionMode: config.getPermissionMode(),
    asyncUserInteraction: config.isAsyncUserInteractionEnabled(),
  }),
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0)) await dispose();
  await stopConfigService();
});

function fixture(
  options: { trustedFolder?: boolean; disableYoloMode?: boolean } = {},
) {
  const resourceService = new ResourceService();
  const settingsService = new SettingsService();
  cleanup.push(
    () => resourceService.dispose(),
    () => settingsService.dispose(),
  );
  const loadedSettings = createEmptyLoadedSettings();
  if (options.disableYoloMode) {
    loadedSettings.merged.security = {
      ...loadedSettings.merged.security,
      disableYoloMode: true,
    };
  }
  const config = new Config({
    sessionId: 'auto-initialize',
    cwd: '/tmp',
    targetDir: '/tmp',
    model: '',
    debugMode: false,
    sessionPersistence: false,
    folderTrust: true,
    trustedFolder: options.trustedFolder ?? true,
    loadedSettings,
    resourceService,
    settingsService,
  });
  attachTestPermission(config);
  vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({
    classifier: 'llm',
  });
  const order: string[] = [];
  const apply = vi.fn(async (declarations: ThreadSessionDeclarations) => {
    order.push('declarations');
    if (typeof declarations.model === 'string')
      config.setModel(declarations.model, true);
  });
  const ready = vi.fn(async () => {
    order.push('ready');
    if (!config.getModel()) config.setModel('auto', true);
  });
  const initialized = vi.fn();
  const emit = vi.fn(async () => {
    order.push('snapshot');
  });
  const hooks = vi.fn(async () => {});
  const session = {
    sessionId: 'auto-initialize',
    isInitialized: () => false,
    requireConfig: () => config,
    setIndependentPlanModeControls: vi.fn(),
    setPromptSuggestionsEnabled: vi.fn(),
    phaseLog: {
      phase: async (_label: string, _detail: string, task: () => unknown) =>
        task(),
      summary: vi.fn(),
    },
    applyInitializeDeclarations: apply,
    ensureInferenceReady: ready,
    getInitializeDeclarationProducts: () => ({}),
    emitInitSnapshot: emit,
    setInitialized: initialized,
    recoverHostArtifacts: vi.fn(),
    startSessionBroadcast: vi.fn(),
    ensureSessionStartHooks: hooks,
  } as unknown as ThreadSessionInternals;
  const ctx = { signal: new AbortController().signal } as ThreadCallContext;
  return {
    config,
    session,
    ctx,
    apply,
    ready,
    emit,
    initialized,
    hooks,
    order,
  };
}

function asyncFixture() {
  const f = fixture();
  const registry = new ToolRegistry(f.config, true);
  registry.registerTool(new AskUserTool(f.config));
  registry.registerTool(new AskUserAsyncTool(f.config));
  registry.registerTool(new SleepTool(f.config));
  f.apply.mockImplementationOnce(async (declarations) => {
    f.order.push('declarations');
    if (typeof declarations.asyncUserInteraction === 'boolean')
      await f.config.setAsyncUserInteractionEnabled(declarations.asyncUserInteraction);
  });
  f.ready.mockImplementationOnce(async () => {
    f.order.push('ready');
    f.config.setModel('auto', true);
    vi.spyOn(f.config, 'getToolRegistry').mockReturnValue(registry);
  });
  return { ...f, registry };
}

describe('initialize async user interaction', () => {
  it('waits for config readiness and freezes a disabled rollout before the snapshot', async () => {
    const f = asyncFixture();
    const environment: NodeJS.ProcessEnv = {};
    const source = new EnvConfigService({ environment });
    vi.spyOn(source, 'start').mockImplementation(async () => {
      expect(f.ready).toHaveBeenCalledOnce();
      environment['QWEN_CONFIG_ASYNC_USER_INTERACTION'] = '{"enabled":false}';
    });
    installConfigService(source);
    const result = await initialize(f.session, f.ctx, { asyncUserInteraction: true });
    expect(result.snapshot.asyncUserInteraction).toBe(false);
    expect(f.registry.getModelFunctionDeclarations('auto').map((tool) => tool.name))
      .toEqual(['AskUserQuestion']);
    environment['QWEN_CONFIG_ASYNC_USER_INTERACTION'] = '{"enabled":true}';
    expect(f.config.isAsyncUserInteractionEnabled()).toBe(false);
    expect(f.initialized).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['Sleep', 'AskUserQuestionAsync'])(
    'rejects when the final model tools omit %s despite registration',
    async (missingTool) => {
      const f = asyncFixture();
      vi.spyOn(f.config, 'getMainAgentTools').mockReturnValue(
        ['AskUserQuestionAsync', 'Sleep'].filter((name) => name !== missingTool),
      );
      await expect(
        initialize(f.session, f.ctx, { asyncUserInteraction: true }),
      ).rejects.toThrow(
        `asyncUserInteraction conflicts with unavailable tool ${missingTool}`,
      );
      expect(f.registry.getAllKnownTools().map((tool) => tool.name)).toContain(missingTool);
      expect(f.ready).toHaveBeenCalledOnce();
      expect(f.emit).not.toHaveBeenCalled();
      expect(f.initialized).not.toHaveBeenCalled();
      expect(f.hooks).not.toHaveBeenCalled();
    },
  );

  it('accepts the complete tool set after inference readiness', async () => {
    const f = asyncFixture();
    vi.spyOn(f.config, 'getMainAgentTools').mockReturnValue(['AskUserQuestionAsync', 'Sleep']);
    await initialize(f.session, f.ctx, { asyncUserInteraction: true });
    expect(f.config.isAsyncUserInteractionEnabled()).toBe(true);
    expect(f.order).toEqual(['declarations', 'ready', 'snapshot']);
    expect(f.initialized).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([undefined, false])('does not require async tools when enabled=%s', async (enabled) => {
    const f = asyncFixture();
    vi.spyOn(f.config, 'getMainAgentTools').mockReturnValue([]);
    const declarations = vi.spyOn(f.registry, 'getModelFunctionDeclarations');
    await initialize(f.session, f.ctx, enabled === undefined ? {} : { asyncUserInteraction: enabled });
    expect(f.config.isAsyncUserInteractionEnabled()).toBe(false);
    expect(declarations).not.toHaveBeenCalled();
    expect(f.initialized).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe('initialize permission and model ordering', () => {
  it.each(['acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'])(
    'still rejects %s in an untrusted directory',
    async (permissionMode) => {
      const f = fixture({ trustedFolder: false });
      await expect(
        initialize(f.session, f.ctx, { model: 'auto', permissionMode }),
      ).rejects.toThrow('untrusted folder');
      expect(f.config.getPermissionMode()).toBe('default');
      expect(f.emit).not.toHaveBeenCalled();
    },
  );

  it('still enforces the local bypass-permission policy', async () => {
    const f = fixture({ disableYoloMode: true });
    await expect(
      initialize(f.session, f.ctx, { permissionMode: 'bypassPermissions' }),
    ).rejects.toThrow('Bypass permissions mode is disabled');
    expect(f.config.getPermissionMode()).toBe('default');
    expect(f.emit).not.toHaveBeenCalled();
  });

  it.each(['default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'])(
    'validates %s with both Plan states and explicit/default model selection',
    async (permissionMode) => {
      for (const planMode of [false, true]) {
        for (const model of [undefined, 'auto']) {
          const f = fixture();
          const request = {
            permissionMode,
            planMode,
            ...(model ? { model } : {}),
          };
          if (permissionMode === 'dontAsk' && planMode) {
            await expect(initialize(f.session, f.ctx, request)).rejects.toThrow(
              'Plan mode is unavailable',
            );
            expect(f.config.getPermissionMode()).toBe('default');
            expect(f.config.planStateManager.isActive).toBe(false);
          } else {
            await initialize(f.session, f.ctx, request);
            expect(f.config.getPermissionMode()).toBe(
              permissionMode === 'bypassPermissions' ? 'yolo' : permissionMode,
            );
            expect(f.config.planStateManager.isActive).toBe(planMode);
          }
        }
      }
    },
  );

  it('restores an explicit model before enabling Auto from an empty initial model', async () => {
    const f = fixture();
    const setModel = vi.spyOn(f.config, 'setModel');
    const result = await initialize(f.session, f.ctx, {
      model: 'auto',
      permissionMode: 'auto',
    });
    expect(f.config.getModel()).toBe('auto');
    expect(f.config.getPermissionMode()).toBe('auto');
    expect(result.snapshot.permissionMode).toBe('auto');
    expect(setModel).toHaveBeenCalledExactlyOnceWith('auto', true);
    expect(f.order).toEqual(['declarations', 'ready', 'snapshot']);
    expect(f.hooks).not.toHaveBeenCalled();
    await result.afterResponseSent();
    expect(f.hooks).toHaveBeenCalledOnce();
  });

  it('allows readiness to select the default model when no model was declared', async () => {
    const f = fixture();
    await initialize(f.session, f.ctx, { permissionMode: 'auto' });
    expect(f.config.getModel()).toBe('auto');
    expect(f.config.getPermissionMode()).toBe('auto');
    expect(f.ready).toHaveBeenCalledOnce();
  });

  it('waits for model readiness before applying Auto', async () => {
    const f = fixture();
    let finish!: () => void;
    f.ready.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.config.setModel('auto', true);
            resolve();
          };
        }),
    );
    const pending = initialize(f.session, f.ctx, { permissionMode: 'auto' });
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce());
    expect(f.config.getPermissionMode()).toBe('default');
    expect(f.emit).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(f.config.getPermissionMode()).toBe('auto');
  });

  it('still rejects Auto if readiness leaves the classifier model unavailable', async () => {
    const f = fixture();
    f.ready.mockResolvedValueOnce(undefined);
    await expect(
      initialize(f.session, f.ctx, { permissionMode: 'auto' }),
    ).rejects.toThrow('Auto mode needs a classifier model');
    expect(f.config.getPermissionMode()).toBe('default');
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.initialized).not.toHaveBeenCalled();
  });

  it('does not enable Auto when inference readiness fails', async () => {
    const f = fixture();
    const error = new Error('inference unavailable');
    f.ready.mockRejectedValueOnce(error);
    await expect(
      initialize(f.session, f.ctx, { model: 'auto', permissionMode: 'auto' }),
    ).rejects.toBe(error);
    expect(f.config.getPermissionMode()).toBe('default');
    expect(f.emit).not.toHaveBeenCalled();
  });

  it('still rejects an unresolved model alias after restoring the declaration', async () => {
    const f = fixture();
    await expect(
      initialize(f.session, f.ctx, { model: 'base', permissionMode: 'auto' }),
    ).rejects.toThrow('Auto mode needs a classifier model');
    expect(f.config.getModel()).toBe('base');
    expect(f.config.getPermissionMode()).toBe('default');
    expect(f.emit).not.toHaveBeenCalled();
  });

  it.each(['default', 'acceptEdits'] as const)(
    'preserves early application of %s permissions',
    async (permissionMode) => {
      const f = fixture();
      f.apply.mockImplementationOnce(async () => {
        expect(f.config.getPermissionMode()).toBe(permissionMode);
      });
      await initialize(f.session, f.ctx, { permissionMode });
      expect(f.apply).toHaveBeenCalledOnce();
    },
  );

  it('preserves early rejection of an unknown permission mode', async () => {
    const f = fixture();
    await expect(
      initialize(f.session, f.ctx, { permissionMode: 'invalid' }),
    ).rejects.toThrow('unknown permission_mode');
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
  });
});
