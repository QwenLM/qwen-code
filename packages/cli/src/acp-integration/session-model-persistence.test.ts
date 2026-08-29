/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import type {
  Config,
  SessionRestoreProjection,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import {
  applyRestoredSessionModel as applyRestoredSessionModelWithSettings,
  recordDaemonSessionModel,
  recordDaemonSessionModelFromConfig,
  restoreSessionModelThenAuthenticate,
} from './session-model-persistence.js';

function recordingProjection(
  recording: SessionRestoreProjection['runtime']['recording'],
): SessionRestoreProjection {
  return {
    sessionId: 'session-1',
    filePath: '/tmp/session.jsonl',
    startTime: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    runtime: {
      apiHistory: [],
      uiTelemetryEvents: [],
      recording,
      goalRecords: [],
      initialTurn: 0,
      backgroundNotificationTaskIds: [],
    },
  };
}

function resolvedWhen(baseUrl: string) {
  return vi.fn((_auth: string, _model: string, url?: string) =>
    url === baseUrl ? { id: _model } : undefined,
  );
}

const emptySettings = { merged: {} } as LoadedSettings;

function applyRestoredSessionModel(
  config: Config,
  projection: SessionRestoreProjection | undefined,
  settings = emptySettings,
): Promise<void> {
  return applyRestoredSessionModelWithSettings(config, projection, settings);
}

describe('session-model-persistence', () => {
  it('records through ChatRecordingService', async () => {
    const recordSessionModel = vi.fn().mockResolvedValue(true);
    const config = {
      getChatRecordingService: vi.fn().mockReturnValue({ recordSessionModel }),
    } as unknown as Config;

    await recordDaemonSessionModel(config, {
      modelId: 'qwen3-coder-plus',
      authType: AuthType.USE_OPENAI,
    });

    expect(recordSessionModel).toHaveBeenCalledWith({
      modelId: 'qwen3-coder-plus',
      authType: AuthType.USE_OPENAI,
    });
  });

  it('does not throw when recording fails', async () => {
    const config = {
      getChatRecordingService: vi.fn().mockReturnValue({
        recordSessionModel: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
    } as unknown as Config;

    await expect(
      recordDaemonSessionModel(config, {
        modelId: 'qwen3-coder-plus',
        authType: AuthType.USE_OPENAI,
      }),
    ).resolves.toBeUndefined();
  });

  it('captures the current config model for a new daemon session', async () => {
    const recordSessionModel = vi.fn().mockResolvedValue(true);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getCurrentModelRegistryBaseUrl: vi
        .fn()
        .mockReturnValue('https://example.test/v1'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        baseUrl: 'https://example.test/v1',
      }),
      getChatRecordingService: vi.fn().mockReturnValue({ recordSessionModel }),
    } as unknown as Config;

    await recordDaemonSessionModelFromConfig(config);

    expect(recordSessionModel).toHaveBeenCalledWith({
      modelId: 'qwen3-coder-plus',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://example.test/v1',
    });
  });

  it('omits baseUrl for an implicit registry route', async () => {
    const recordSessionModel = vi.fn().mockResolvedValue(true);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(null),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      }),
      getChatRecordingService: vi.fn().mockReturnValue({ recordSessionModel }),
    } as unknown as Config;

    await recordDaemonSessionModelFromConfig(config);

    expect(recordSessionModel).toHaveBeenCalledWith({
      modelId: 'qwen3-coder-plus',
      authType: AuthType.USE_OPENAI,
    });
  });

  it('restores a recorded session model before matching no-ops', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getResolvedModelConfig: resolvedWhen('https://example.test/v1'),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://example.test/v1',
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      { baseUrl: 'https://example.test/v1' },
    );
  });

  it('clears an incompatible live effort after restoring a toggle-only model', async () => {
    let routeIdentity = 'qwen3.8-max@route';
    const setReasoningEffort = vi.fn();
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3.8-max'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getModelRouteIdentity: vi.fn(() => routeIdentity),
      getReasoningPreference: vi.fn().mockReturnValue('ultra'),
      setReasoningEffort,
      disableReasoning: vi.fn(),
      switchModel: vi.fn().mockImplementation(async () => {
        routeIdentity = 'qwen3.7-max@route';
      }),
    } as unknown as Config;
    const setValue = vi.fn();
    const settings = {
      merged: { model: { reasoningEffort: 'ultra' } },
      setValue,
    } as unknown as LoadedSettings;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3.7-max',
          authType: AuthType.USE_OPENAI,
        },
      }),
      settings,
    );

    expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('falls back to the last assistant model when no session_model exists', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        lastAssistantModel: 'old-turn-model',
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'old-turn-model',
      undefined,
    );
  });

  it('uses modelsConfig auth for last-assistant fallback before content-generator auth exists', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(undefined),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      }),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        lastAssistantModel: 'legacy-turn-model',
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'legacy-turn-model',
      undefined,
    );
  });

  it('prefers the session_model record over lastAssistantModel', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
        },
        lastAssistantModel: 'older-model',
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      undefined,
    );
  });

  it('does not switch when the live config already matches', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi
        .fn()
        .mockReturnValue('https://example.test/v1'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        baseUrl: 'https://example.test/v1',
      }),
      getResolvedModelConfig: resolvedWhen('https://example.test/v1'),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://example.test/v1',
        },
      }),
    );

    expect(switchModel).not.toHaveBeenCalled();
  });

  it('does not switch an implicit registry record when the live registry baseUrl is unset', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
        },
      }),
    );

    expect(switchModel).not.toHaveBeenCalled();
  });

  it('leaves a same-id runtime snapshot when restoring an implicit registry route', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        authType: AuthType.USE_OPENAI,
        modelId: 'qwen3-coder-plus',
      }),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      undefined,
    );
  });

  it('does not switch last-assistant fallback when the live model already matches', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        authType: AuthType.USE_OPENAI,
        modelId: 'qwen3-coder-plus',
      }),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        lastAssistantModel: 'qwen3-coder-plus',
      }),
    );

    expect(switchModel).not.toHaveBeenCalled();
  });

  it('does not fail restore when switchModel rejects', async () => {
    const switchModel = vi.fn().mockRejectedValue(new Error('unknown model'));
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await expect(
      applyRestoredSessionModel(
        config,
        recordingProjection({
          lastCompletedUuid: 'leaf',
          turnParentUuids: [null],
          sessionModel: {
            modelId: 'gone-runtime',
            authType: AuthType.USE_OPENAI,
            isRuntime: true,
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'gone-runtime',
      undefined,
    );
  });

  it('uses a live runtime snapshot id when that snapshot is still present', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        authType: AuthType.USE_OPENAI,
        modelId: 'custom-runtime',
      }),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'custom-runtime',
          authType: AuthType.USE_OPENAI,
          isRuntime: true,
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      `$runtime|${AuthType.USE_OPENAI}|custom-runtime`,
      undefined,
    );
  });

  it('requires cached credentials when restoring Qwen OAuth from another auth', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'coder-model',
          authType: AuthType.QWEN_OAUTH,
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.QWEN_OAUTH,
      'coder-model',
      { requireCachedCredentials: true },
    );
  });

  it('switches when recorded authType differs even if the model id matches', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('coder-model'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'coder-model',
          authType: AuthType.QWEN_OAUTH,
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.QWEN_OAUTH,
      'coder-model',
      { requireCachedCredentials: true },
    );
  });

  it('trims padded recorded authType before switching', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: ' qwen3-coder-plus ',
          authType: `${AuthType.USE_OPENAI}\n`,
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      undefined,
    );
  });

  it('retries authentication on the settings model when restored auth fails', async () => {
    let currentAuth: string | undefined = AuthType.USE_OPENAI;
    let currentModel = 'settings-default';
    const switchModel = vi.fn(
      async (authType: string, modelId: string): Promise<void> => {
        currentAuth = authType;
        currentModel = modelId;
      },
    );
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('oauth expired'))
      .mockResolvedValueOnce(undefined);
    const config = {
      getModel: vi.fn(() => currentModel),
      getAuthType: vi.fn(() => currentAuth),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await restoreSessionModelThenAuthenticate(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'coder-model',
          authType: AuthType.QWEN_OAUTH,
        },
      }),
      authenticate,
      emptySettings,
    );

    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(switchModel).toHaveBeenNthCalledWith(
      1,
      AuthType.QWEN_OAUTH,
      'coder-model',
      { requireCachedCredentials: true },
    );
    expect(switchModel).toHaveBeenNthCalledWith(
      2,
      AuthType.USE_OPENAI,
      'settings-default',
      undefined,
    );
  });

  it('restores the live effort when authentication rolls back the restored model', async () => {
    let currentAuth: string | undefined = AuthType.USE_OPENAI;
    let currentModel = 'qwen3.8-max';
    let reasoningPreference: false | string | undefined = 'ultra';
    const setReasoningEffort = vi.fn((effort: string | undefined) => {
      reasoningPreference = effort;
    });
    const switchModel = vi.fn(
      async (authType: string, modelId: string): Promise<void> => {
        currentAuth = authType;
        currentModel = modelId;
      },
    );
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('oauth expired'))
      .mockResolvedValueOnce(undefined);
    const config = {
      getModel: vi.fn(() => currentModel),
      getAuthType: vi.fn(() => currentAuth),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getReasoningPreference: vi.fn(() => reasoningPreference),
      setReasoningEffort,
      disableReasoning: vi.fn(() => {
        reasoningPreference = false;
      }),
      switchModel,
    } as unknown as Config;

    await restoreSessionModelThenAuthenticate(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3.7-max',
          authType: AuthType.QWEN_OAUTH,
        },
      }),
      authenticate,
      { merged: { model: { reasoningEffort: 'ultra' } } } as LoadedSettings,
    );

    expect(setReasoningEffort).toHaveBeenNthCalledWith(1, undefined);
    expect(setReasoningEffort).toHaveBeenNthCalledWith(2, 'ultra');
    expect(reasoningPreference).toBe('ultra');
  });

  it('does not retry authentication when restore did not change the live model', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const authenticate = vi.fn().mockRejectedValue(new Error('auth required'));
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await expect(
      restoreSessionModelThenAuthenticate(
        config,
        recordingProjection({
          lastCompletedUuid: 'leaf',
          turnParentUuids: [null],
          lastAssistantModel: 'qwen3-coder-plus',
        }),
        authenticate,
        emptySettings,
      ),
    ).rejects.toThrow('auth required');

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('retries authentication when restore only changed the registry baseUrl', async () => {
    let currentAuth: string | undefined = AuthType.USE_OPENAI;
    let currentModel = 'qwen3-coder-plus';
    let currentBaseUrl: string | undefined = 'https://settings.example/v1';
    const switchModel = vi.fn(
      async (
        authType: string,
        modelId: string,
        options?: { baseUrl?: string },
      ): Promise<void> => {
        currentAuth = authType;
        currentModel = modelId;
        currentBaseUrl = options?.baseUrl;
      },
    );
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('oauth expired'))
      .mockResolvedValueOnce(undefined);
    const config = {
      getModel: vi.fn(() => currentModel),
      getAuthType: vi.fn(() => currentAuth),
      getCurrentModelRegistryBaseUrl: vi.fn(() => currentBaseUrl),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getResolvedModelConfig: resolvedWhen('https://session.example/v1'),
      switchModel,
    } as unknown as Config;

    await restoreSessionModelThenAuthenticate(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://session.example/v1',
        },
      }),
      authenticate,
      emptySettings,
    );

    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(switchModel).toHaveBeenNthCalledWith(
      1,
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      { baseUrl: 'https://session.example/v1' },
    );
    expect(switchModel).toHaveBeenNthCalledWith(
      2,
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      { baseUrl: 'https://settings.example/v1' },
    );
  });

  it('rolls back to the settings runtime snapshot id after restored auth fails', async () => {
    let currentAuth: string | undefined = AuthType.USE_OPENAI;
    let currentModel = 'custom-runtime';
    const switchModel = vi.fn(
      async (authType: string, modelId: string): Promise<void> => {
        if (modelId === 'custom-runtime') {
          throw new Error('Model not found');
        }
        currentAuth = authType;
        currentModel = modelId;
      },
    );
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('oauth expired'))
      .mockResolvedValueOnce(undefined);
    const config = {
      getModel: vi.fn(() => currentModel),
      getAuthType: vi.fn(() => currentAuth),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        authType: AuthType.USE_OPENAI,
        modelId: 'custom-runtime',
      }),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await restoreSessionModelThenAuthenticate(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'coder-model',
          authType: AuthType.QWEN_OAUTH,
        },
      }),
      authenticate,
      emptySettings,
    );

    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(switchModel).toHaveBeenNthCalledWith(
      1,
      AuthType.QWEN_OAUTH,
      'coder-model',
      { requireCachedCredentials: true },
    );
    expect(switchModel).toHaveBeenNthCalledWith(
      2,
      AuthType.USE_OPENAI,
      `$runtime|${AuthType.USE_OPENAI}|custom-runtime`,
      undefined,
    );
  });

  it('retries authentication when restore leaves a same-id runtime snapshot', async () => {
    let currentAuth: string | undefined = AuthType.USE_OPENAI;
    let currentModel = 'qwen3-coder-plus';
    let snapshot:
      | { id?: string; authType: string; modelId: string }
      | undefined = {
      authType: AuthType.USE_OPENAI,
      modelId: 'qwen3-coder-plus',
    };
    const switchModel = vi.fn(
      async (authType: string, modelId: string): Promise<void> => {
        currentAuth = authType;
        currentModel = modelId;
        snapshot = modelId.startsWith('$runtime|')
          ? {
              id: modelId,
              authType,
              modelId: modelId.split('|').slice(2).join('|'),
            }
          : undefined;
      },
    );
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('oauth expired'))
      .mockResolvedValueOnce(undefined);
    const config = {
      getModel: vi.fn(() => currentModel),
      getAuthType: vi.fn(() => currentAuth),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getActiveRuntimeModelSnapshot: vi.fn(() => snapshot),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await restoreSessionModelThenAuthenticate(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
        },
      }),
      authenticate,
      emptySettings,
    );

    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(switchModel).toHaveBeenNthCalledWith(
      1,
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      undefined,
    );
    expect(switchModel).toHaveBeenNthCalledWith(
      2,
      AuthType.USE_OPENAI,
      `$runtime|${AuthType.USE_OPENAI}|qwen3-coder-plus`,
      undefined,
    );
  });

  it('surfaces the settings-model auth error when rollback authentication also fails', async () => {
    let currentAuth: string | undefined = AuthType.USE_OPENAI;
    let currentModel = 'settings-default';
    const switchModel = vi.fn(
      async (authType: string, modelId: string): Promise<void> => {
        currentAuth = authType;
        currentModel = modelId;
      },
    );
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('oauth expired'))
      .mockRejectedValueOnce(new Error('settings auth failed'));
    const config = {
      getModel: vi.fn(() => currentModel),
      getAuthType: vi.fn(() => currentAuth),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await expect(
      restoreSessionModelThenAuthenticate(
        config,
        recordingProjection({
          lastCompletedUuid: 'leaf',
          turnParentUuids: [null],
          sessionModel: {
            modelId: 'coder-model',
            authType: AuthType.QWEN_OAUTH,
          },
        }),
        authenticate,
        emptySettings,
      ),
    ).rejects.toThrow('settings auth failed');

    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(switchModel).toHaveBeenNthCalledWith(
      2,
      AuthType.USE_OPENAI,
      'settings-default',
      undefined,
    );
  });

  it('surfaces the restored auth error when rollback switchModel fails', async () => {
    let currentAuth: string | undefined = AuthType.USE_OPENAI;
    let currentModel = 'settings-default';
    const switchModel = vi.fn(
      async (authType: string, modelId: string): Promise<void> => {
        if (modelId === 'settings-default') {
          throw new Error('Model not found');
        }
        currentAuth = authType;
        currentModel = modelId;
      },
    );
    const authenticate = vi.fn().mockRejectedValue(new Error('oauth expired'));
    const config = {
      getModel: vi.fn(() => currentModel),
      getAuthType: vi.fn(() => currentAuth),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await expect(
      restoreSessionModelThenAuthenticate(
        config,
        recordingProjection({
          lastCompletedUuid: 'leaf',
          turnParentUuids: [null],
          sessionModel: {
            modelId: 'coder-model',
            authType: AuthType.QWEN_OAUTH,
          },
        }),
        authenticate,
        emptySettings,
      ),
    ).rejects.toThrow('oauth expired');

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(switchModel).toHaveBeenNthCalledWith(
      2,
      AuthType.USE_OPENAI,
      'settings-default',
      undefined,
    );
  });

  it('marks the payload isRuntime when a runtime snapshot is active', async () => {
    const recordSessionModel = vi.fn().mockResolvedValue(true);
    const config = {
      getModel: vi.fn().mockReturnValue('custom-runtime'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        authType: AuthType.USE_OPENAI,
        modelId: 'custom-runtime',
      }),
      getCurrentModelRegistryBaseUrl: vi
        .fn()
        .mockReturnValue('https://example.test/v1'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getChatRecordingService: vi.fn().mockReturnValue({ recordSessionModel }),
    } as unknown as Config;

    await recordDaemonSessionModelFromConfig(config);

    expect(recordSessionModel).toHaveBeenCalledWith({
      modelId: 'custom-runtime',
      authType: AuthType.USE_OPENAI,
      isRuntime: true,
    });
  });

  it('keeps the settings model when the projection has neither record nor fallback', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
      }),
    );

    expect(switchModel).not.toHaveBeenCalled();
  });

  it('does not switch when the live model carries a runtime prefix over the recorded bare id', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi
        .fn()
        .mockReturnValue(`$runtime|${AuthType.USE_OPENAI}|qwen3-coder-plus`),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        authType: AuthType.USE_OPENAI,
        modelId: 'qwen3-coder-plus',
      }),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          isRuntime: true,
        },
      }),
    );

    expect(switchModel).not.toHaveBeenCalled();
  });

  it('does not switch when the live model carries a stacked runtime prefix', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi
        .fn()
        .mockReturnValue(
          `$runtime|${AuthType.USE_OPENAI}|$runtime|${AuthType.USE_OPENAI}|qwen3-coder-plus`,
        ),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        authType: AuthType.USE_OPENAI,
        modelId: 'qwen3-coder-plus',
      }),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          isRuntime: true,
        },
      }),
    );

    expect(switchModel).not.toHaveBeenCalled();
  });

  it('corrects the route when the recorded explicit baseUrl differs from the live one', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi
        .fn()
        .mockReturnValue('https://b.example/v1'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        baseUrl: 'https://b.example/v1',
      }),
      getResolvedModelConfig: resolvedWhen('https://a.example/v1'),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://a.example/v1',
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      { baseUrl: 'https://a.example/v1' },
    );
  });

  it('corrects the route when the recorded explicit baseUrl meets a live implicit route', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(null),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getResolvedModelConfig: resolvedWhen('https://a.example/v1'),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://a.example/v1',
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      { baseUrl: 'https://a.example/v1' },
    );
  });

  it('corrects the route when the recorded implicit route meets a live explicit baseUrl', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi
        .fn()
        .mockReturnValue('https://b.example/v1'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        baseUrl: 'https://b.example/v1',
      }),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      undefined,
    );
  });

  it('drops a recorded baseUrl that is not a configured registry route', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getCurrentModelRegistryBaseUrl: vi.fn().mockReturnValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getResolvedModelConfig: vi.fn().mockReturnValue(undefined),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://attacker.example/v1',
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      undefined,
    );
  });

  it('ignores a recorded authType that is not a known AuthType', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const config = {
      getModel: vi.fn().mockReturnValue('settings-default'),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      switchModel,
    } as unknown as Config;

    await applyRestoredSessionModel(
      config,
      recordingProjection({
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: 'not-an-auth',
        },
      }),
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3-coder-plus',
      undefined,
    );
  });
});
