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
import {
  applyRestoredSessionModel,
  recordDaemonSessionModel,
  recordDaemonSessionModelFromConfig,
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
});
