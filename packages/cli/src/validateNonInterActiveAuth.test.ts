/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { AuthType, OutputFormat } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import * as auth from './config/auth.js';
import { type LoadedSettings } from './config/settings.js';
import * as JsonOutputAdapterModule from './nonInteractive/io/JsonOutputAdapter.js';
import * as StreamJsonOutputAdapterModule from './nonInteractive/io/StreamJsonOutputAdapter.js';
import * as cleanupModule from './utils/cleanup.js';

type ModelsConfig = ReturnType<Config['getModelsConfig']>;

// Helper to create a mock Config with modelsConfig
function createMockConfig(overrides?: Partial<Config>): Config {
  const baseModelsConfig = {
    getModel: vi.fn().mockReturnValue('default-model'),
    getCurrentAuthType: vi.fn().mockReturnValue(AuthType.QWEN_OAUTH),
  } as unknown as ModelsConfig;
  const baseConfig: Partial<Config> = {
    refreshAuth: vi.fn().mockResolvedValue('refreshed'),
    getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
    getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: undefined }),
    getModelsConfig: vi.fn().mockReturnValue(baseModelsConfig),
  };
  return {
    ...baseConfig,
    ...overrides,
  } as Config;
}

describe('validateNonInterActiveAuth', () => {
  let originalEnvGeminiApiKey: string | undefined;
  let originalEnvVertexAi: string | undefined;
  let originalEnvGcp: string | undefined;
  let originalEnvOpenAiApiKey: string | undefined;
  let originalEnvQwenOauth: string | undefined;
  let originalEnvGoogleApiKey: string | undefined;
  let originalEnvAnthropicApiKey: string | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn<[code?: number], never>>;
  let refreshAuthMock: ReturnType<typeof vi.fn>;
  let mockSettings: LoadedSettings;

  beforeEach(() => {
    originalEnvGeminiApiKey = process.env['GEMINI_API_KEY'];
    originalEnvVertexAi = process.env['GOOGLE_GENAI_USE_VERTEXAI'];
    originalEnvGcp = process.env['GOOGLE_GENAI_USE_GCA'];
    originalEnvOpenAiApiKey = process.env['OPENAI_API_KEY'];
    originalEnvQwenOauth = process.env['QWEN_OAUTH'];
    originalEnvGoogleApiKey = process.env['GOOGLE_API_KEY'];
    originalEnvAnthropicApiKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
    delete process.env['GOOGLE_GENAI_USE_GCA'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['QWEN_OAUTH'];
    delete process.env['GOOGLE_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    }) as ReturnType<typeof vi.spyOn<[code?: number], never>>;
    refreshAuthMock = vi.fn().mockResolvedValue('refreshed');
    mockSettings = {
      system: { path: '', settings: {} },
      systemDefaults: { path: '', settings: {} },
      user: { path: '', settings: {} },
      workspace: { path: '', settings: {} },
      errors: [],
      setValue: vi.fn(),
      merged: {
        security: {
          auth: {
            enforcedType: undefined,
          },
        },
      },
      isTrusted: true,
      migratedInMemorScopes: new Set(),
      forScope: vi.fn(),
      computeMergedSettings: vi.fn(),
    } as unknown as LoadedSettings;
  });

  afterEach(() => {
    if (originalEnvGeminiApiKey !== undefined) {
      process.env['GEMINI_API_KEY'] = originalEnvGeminiApiKey;
    } else {
      delete process.env['GEMINI_API_KEY'];
    }
    if (originalEnvVertexAi !== undefined) {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = originalEnvVertexAi;
    } else {
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
    }
    if (originalEnvGcp !== undefined) {
      process.env['GOOGLE_GENAI_USE_GCA'] = originalEnvGcp;
    } else {
      delete process.env['GOOGLE_GENAI_USE_GCA'];
    }
    if (originalEnvOpenAiApiKey !== undefined) {
      process.env['OPENAI_API_KEY'] = originalEnvOpenAiApiKey;
    } else {
      delete process.env['OPENAI_API_KEY'];
    }
    if (originalEnvQwenOauth !== undefined) {
      process.env['QWEN_OAUTH'] = originalEnvQwenOauth;
    } else {
      delete process.env['QWEN_OAUTH'];
    }
    if (originalEnvGoogleApiKey !== undefined) {
      process.env['GOOGLE_API_KEY'] = originalEnvGoogleApiKey;
    } else {
      delete process.env['GOOGLE_API_KEY'];
    }
    if (originalEnvAnthropicApiKey !== undefined) {
      process.env['ANTHROPIC_API_KEY'] = originalEnvAnthropicApiKey;
    } else {
      delete process.env['ANTHROPIC_API_KEY'];
    }
    vi.restoreAllMocks();
  });

  it('exits if validateAuthMethod fails for default auth type', async () => {
    // Mock validateAuthMethod to return error (e.g., missing API key)
    vi.spyOn(auth, 'validateAuthMethod').mockReturnValue(
      'Missing API key for authentication',
    );
    const nonInteractiveConfig = createMockConfig({
      refreshAuth: refreshAuthMock,
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('default-model'),
        getCurrentAuthType: vi.fn().mockReturnValue(AuthType.QWEN_OAUTH),
      }),
    });
    try {
      await validateNonInteractiveAuth(
        undefined,
        nonInteractiveConfig,
        mockSettings,
      );
      expect.fail('Should have exited');
    } catch (e) {
      expect((e as Error).message).toContain('process.exit(1) called');
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Missing API key'),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('uses USE_OPENAI if OPENAI_API_KEY is set', async () => {
    process.env['OPENAI_API_KEY'] = 'fake-openai-key';
    const nonInteractiveConfig = createMockConfig({
      refreshAuth: refreshAuthMock,
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('default-model'),
        getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      }),
    });
    await validateNonInteractiveAuth(
      undefined,
      nonInteractiveConfig,
      mockSettings,
    );
    expect(refreshAuthMock).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('uses configured QWEN_OAUTH if provided', async () => {
    const nonInteractiveConfig = createMockConfig({
      refreshAuth: refreshAuthMock,
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('default-model'),
        getCurrentAuthType: vi.fn().mockReturnValue(AuthType.QWEN_OAUTH),
      }),
    });
    await validateNonInteractiveAuth(
      undefined,
      nonInteractiveConfig,
      mockSettings,
    );
    expect(refreshAuthMock).toHaveBeenCalledWith(AuthType.QWEN_OAUTH);
  });

  it('exits if validateAuthMethod returns error', async () => {
    // Mock validateAuthMethod to return error
    vi.spyOn(auth, 'validateAuthMethod').mockReturnValue('Auth error!');
    const nonInteractiveConfig = createMockConfig({
      refreshAuth: refreshAuthMock,
    });
    try {
      await validateNonInteractiveAuth(
        undefined,
        nonInteractiveConfig,
        mockSettings,
      );
      expect.fail('Should have exited');
    } catch (e) {
      expect((e as Error).message).toContain('process.exit(1) called');
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith('Auth error!');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('skips validation if useExternalAuth is true', async () => {
    // Mock validateAuthMethod to return error to ensure it's not being called
    const validateAuthMethodSpy = vi
      .spyOn(auth, 'validateAuthMethod')
      .mockReturnValue('Auth error!');
    const nonInteractiveConfig = createMockConfig({
      refreshAuth: refreshAuthMock,
    });

    // Even with validation errors, it should not exit
    // because validation is skipped when useExternalAuth is true.
    await validateNonInteractiveAuth(
      true, // useExternalAuth = true
      nonInteractiveConfig,
      mockSettings,
    );

    expect(validateAuthMethodSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
    // refreshAuth is called with the authType from config.getModelsConfig().getCurrentAuthType()
    expect(refreshAuthMock).toHaveBeenCalledWith(AuthType.QWEN_OAUTH);
  });

  it('uses enforcedAuthType if provided', async () => {
    mockSettings.merged.security!.auth!.enforcedType = AuthType.USE_OPENAI;
    mockSettings.merged.security!.auth!.selectedType = AuthType.USE_OPENAI;
    // Set required env var for USE_OPENAI to ensure enforcedAuthType takes precedence
    process.env['OPENAI_API_KEY'] = 'fake-key';
    const nonInteractiveConfig = createMockConfig({
      refreshAuth: refreshAuthMock,
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('default-model'),
        getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      }),
    });
    await validateNonInteractiveAuth(
      undefined,
      nonInteractiveConfig,
      mockSettings,
    );
    expect(refreshAuthMock).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('exits if currentAuthType does not match enforcedAuthType', async () => {
    mockSettings.merged.security!.auth!.enforcedType = AuthType.QWEN_OAUTH;
    process.env['OPENAI_API_KEY'] = 'fake-key';
    const nonInteractiveConfig = createMockConfig({
      refreshAuth: refreshAuthMock,
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('default-model'),
        getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      }),
    });
    try {
      await validateNonInteractiveAuth(
        undefined,
        nonInteractiveConfig,
        mockSettings,
      );
      expect.fail('Should have exited');
    } catch (e) {
      expect((e as Error).message).toContain('process.exit(1) called');
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'The configured auth type is qwen-oauth, but the current auth type is openai. Please re-authenticate with the correct type.',
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  describe('JSON output mode', () => {
    let emitResultMock: ReturnType<typeof vi.fn>;
    let runExitCleanupMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      emitResultMock = vi.fn();
      runExitCleanupMock = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(JsonOutputAdapterModule, 'JsonOutputAdapter').mockImplementation(
        () =>
          ({
            emitResult: emitResultMock,
          }) as unknown as JsonOutputAdapterModule.JsonOutputAdapter,
      );
      vi.spyOn(cleanupModule, 'runExitCleanup').mockImplementation(
        runExitCleanupMock,
      );
    });

    it('emits error result and exits when validateAuthMethod fails', async () => {
      vi.spyOn(auth, 'validateAuthMethod').mockReturnValue(
        'Missing API key for authentication',
      );
      const nonInteractiveConfig = createMockConfig({
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.JSON),
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('default-model'),
          getCurrentAuthType: vi.fn().mockReturnValue(AuthType.QWEN_OAUTH),
        }),
      });

      try {
        await validateNonInteractiveAuth(
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
        expect.fail('Should have exited');
      } catch (e) {
        expect((e as Error).message).toContain('process.exit(1) called');
      }

      expect(emitResultMock).toHaveBeenCalledWith({
        isError: true,
        errorMessage: expect.stringContaining('Missing API key'),
        durationMs: 0,
        apiDurationMs: 0,
        numTurns: 0,
        usage: undefined,
      });
      expect(runExitCleanupMock).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('emits error result and exits when enforced auth mismatches current auth', async () => {
      mockSettings.merged.security!.auth!.enforcedType = AuthType.QWEN_OAUTH;
      process.env['OPENAI_API_KEY'] = 'fake-key';

      const nonInteractiveConfig = createMockConfig({
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.JSON),
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('default-model'),
          getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
        }),
      });

      try {
        await validateNonInteractiveAuth(
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
        expect.fail('Should have exited');
      } catch (e) {
        expect((e as Error).message).toContain('process.exit(1) called');
      }

      expect(emitResultMock).toHaveBeenCalledWith({
        isError: true,
        errorMessage: expect.stringContaining(
          'The configured auth type is qwen-oauth, but the current auth type is openai.',
        ),
        durationMs: 0,
        apiDurationMs: 0,
        numTurns: 0,
        usage: undefined,
      });
      expect(runExitCleanupMock).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('emits error result and exits when API key validation fails', async () => {
      vi.spyOn(auth, 'validateAuthMethod').mockReturnValue('Auth error!');
      process.env['OPENAI_API_KEY'] = 'fake-key';

      const nonInteractiveConfig = createMockConfig({
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.JSON),
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('default-model'),
          getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
        }),
      });

      try {
        await validateNonInteractiveAuth(
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
        expect.fail('Should have exited');
      } catch (e) {
        expect((e as Error).message).toContain('process.exit(1) called');
      }

      expect(emitResultMock).toHaveBeenCalledWith({
        isError: true,
        errorMessage: 'Auth error!',
        durationMs: 0,
        apiDurationMs: 0,
        numTurns: 0,
        usage: undefined,
      });
      expect(runExitCleanupMock).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('STREAM_JSON output mode', () => {
    let emitResultMock: ReturnType<typeof vi.fn>;
    let runExitCleanupMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      emitResultMock = vi.fn();
      runExitCleanupMock = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(
        StreamJsonOutputAdapterModule,
        'StreamJsonOutputAdapter',
      ).mockImplementation(
        () =>
          ({
            emitResult: emitResultMock,
          }) as unknown as StreamJsonOutputAdapterModule.StreamJsonOutputAdapter,
      );
      vi.spyOn(cleanupModule, 'runExitCleanup').mockImplementation(
        runExitCleanupMock,
      );
    });

    it('emits error result and exits when validateAuthMethod fails', async () => {
      vi.spyOn(auth, 'validateAuthMethod').mockReturnValue(
        'Missing API key for authentication',
      );
      const nonInteractiveConfig = createMockConfig({
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.STREAM_JSON),
        getIncludePartialMessages: vi.fn().mockReturnValue(false),
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('default-model'),
          getCurrentAuthType: vi.fn().mockReturnValue(AuthType.QWEN_OAUTH),
        }),
      });

      try {
        await validateNonInteractiveAuth(
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
        expect.fail('Should have exited');
      } catch (e) {
        expect((e as Error).message).toContain('process.exit(1) called');
      }

      expect(emitResultMock).toHaveBeenCalledWith({
        isError: true,
        errorMessage: expect.stringContaining('Missing API key'),
        durationMs: 0,
        apiDurationMs: 0,
        numTurns: 0,
        usage: undefined,
      });
      expect(runExitCleanupMock).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('emits error result and exits when enforced auth mismatches current auth', async () => {
      mockSettings.merged.security!.auth!.enforcedType = AuthType.QWEN_OAUTH;
      process.env['OPENAI_API_KEY'] = 'fake-key';

      const nonInteractiveConfig = createMockConfig({
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.STREAM_JSON),
        getIncludePartialMessages: vi.fn().mockReturnValue(false),
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('default-model'),
          getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
        }),
      });

      try {
        await validateNonInteractiveAuth(
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
        expect.fail('Should have exited');
      } catch (e) {
        expect((e as Error).message).toContain('process.exit(1) called');
      }

      expect(emitResultMock).toHaveBeenCalledWith({
        isError: true,
        errorMessage: expect.stringContaining(
          'The configured auth type is qwen-oauth, but the current auth type is openai.',
        ),
        durationMs: 0,
        apiDurationMs: 0,
        numTurns: 0,
        usage: undefined,
      });
      expect(runExitCleanupMock).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('emits error result and exits when API key validation fails', async () => {
      vi.spyOn(auth, 'validateAuthMethod').mockReturnValue('Auth error!');
      process.env['OPENAI_API_KEY'] = 'fake-key';

      const nonInteractiveConfig = createMockConfig({
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.STREAM_JSON),
        getIncludePartialMessages: vi.fn().mockReturnValue(false),
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('default-model'),
          getCurrentAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
        }),
      });

      try {
        await validateNonInteractiveAuth(
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
        expect.fail('Should have exited');
      } catch (e) {
        expect((e as Error).message).toContain('process.exit(1) called');
      }

      expect(emitResultMock).toHaveBeenCalledWith({
        isError: true,
        errorMessage: 'Auth error!',
        durationMs: 0,
        apiDurationMs: 0,
        numTurns: 0,
        usage: undefined,
      });
      expect(runExitCleanupMock).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
