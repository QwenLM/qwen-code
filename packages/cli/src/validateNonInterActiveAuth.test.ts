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

describe('validateNonInterActiveAuth', () => {
  let originalEnvGeminiApiKey: string | undefined;
  let originalEnvVertexAi: string | undefined;
  let originalEnvGcp: string | undefined;
  let originalEnvOpenAiApiKey: string | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let refreshAuthMock: vi.Mock;
  let mockSettings: LoadedSettings;

  beforeEach(() => {
    originalEnvGeminiApiKey = process.env['GEMINI_API_KEY'];
    originalEnvVertexAi = process.env['GOOGLE_GENAI_USE_VERTEXAI'];
    originalEnvGcp = process.env['GOOGLE_GENAI_USE_GCA'];
    originalEnvOpenAiApiKey = process.env['OPENAI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
    delete process.env['GOOGLE_GENAI_USE_GCA'];
    delete process.env['OPENAI_API_KEY'];
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });
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
    vi.restoreAllMocks();
  });

  it('exits if no auth type is configured or env vars set', async () => {
    const nonInteractiveConfig = {
      refreshAuth: refreshAuthMock,
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ authType: undefined }),
    } as unknown as Config;
    try {
      await validateNonInteractiveAuth(
        undefined,
        undefined,
        nonInteractiveConfig,
        mockSettings,
      );
      expect.fail('Should have exited');
    } catch (e) {
      expect((e as Error).message).toContain('process.exit(1) called');
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Please set an Auth method'),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('uses USE_OPENAI if OPENAI_API_KEY is set', async () => {
    process.env['OPENAI_API_KEY'] = 'fake-openai-key';
    const nonInteractiveConfig = {
      refreshAuth: refreshAuthMock,
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ authType: undefined }),
    } as unknown as Config;
    await validateNonInteractiveAuth(
      undefined,
      undefined,
      nonInteractiveConfig,
      mockSettings,
    );
    expect(refreshAuthMock).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('uses configured QWEN_OAUTH if provided', async () => {
    const nonInteractiveConfig = {
      refreshAuth: refreshAuthMock,
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ authType: undefined }),
    } as unknown as Config;
    await validateNonInteractiveAuth(
      AuthType.QWEN_OAUTH,
      undefined,
      nonInteractiveConfig,
      mockSettings,
    );
    expect(refreshAuthMock).toHaveBeenCalledWith(AuthType.QWEN_OAUTH);
  });

  it('exits if validateAuthMethod returns error', async () => {
    // Mock validateAuthMethod to return error
    vi.spyOn(auth, 'validateAuthMethod').mockReturnValue('Auth error!');
    const nonInteractiveConfig = {
      refreshAuth: refreshAuthMock,
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ authType: undefined }),
    } as unknown as Config;
    try {
      await validateNonInteractiveAuth(
        AuthType.USE_GEMINI,
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
    const nonInteractiveConfig = {
      refreshAuth: refreshAuthMock,
    } as unknown as Config;

    // Even with an invalid auth type, it should not exit
    // because validation is skipped.
    await validateNonInteractiveAuth(
      'invalid-auth-type' as AuthType,
      true, // useExternalAuth = true
      nonInteractiveConfig,
      mockSettings,
    );

    expect(validateAuthMethodSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
    // We still expect refreshAuth to be called with the (invalid) type
    expect(refreshAuthMock).toHaveBeenCalledWith('invalid-auth-type');
  });

  it('uses enforcedAuthType if provided', async () => {
    mockSettings.merged.security!.auth!.enforcedType = AuthType.USE_OPENAI;
    mockSettings.merged.security!.auth!.selectedType = AuthType.USE_OPENAI;
    // Set required env var for USE_OPENAI to ensure enforcedAuthType takes precedence
    process.env['OPENAI_API_KEY'] = 'fake-key';
    const nonInteractiveConfig = {
      refreshAuth: refreshAuthMock,
    } as unknown as Config;
    await validateNonInteractiveAuth(
      AuthType.USE_OPENAI,
      undefined,
      nonInteractiveConfig,
      mockSettings,
    );
    expect(refreshAuthMock).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('exits if currentAuthType does not match enforcedAuthType', async () => {
    mockSettings.merged.security!.auth!.enforcedType = AuthType.QWEN_OAUTH;
    process.env['OPENAI_API_KEY'] = 'fake-key';
    const nonInteractiveConfig = {
      refreshAuth: refreshAuthMock,
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ authType: undefined }),
    } as unknown as Config;
    try {
      await validateNonInteractiveAuth(
        AuthType.USE_OPENAI,
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
    it('prints JSON error when no auth is configured and exits with code 1', async () => {
      const nonInteractiveConfig = {
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.JSON),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: undefined }),
      } as unknown as Config;

      let thrown: Error | undefined;
      try {
        await validateNonInteractiveAuth(
          undefined,
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown?.message).toBe('process.exit(1) called');
      const errorArg = consoleErrorSpy.mock.calls[0]?.[0] as string;
      const payload = JSON.parse(errorArg);
      expect(payload.error.type).toBe('Error');
      expect(payload.error.code).toBe(1);
      expect(payload.error.message).toContain(
        'Please set an Auth method in your',
      );
    });

    it('prints JSON error when enforced auth mismatches current auth and exits with code 1', async () => {
      mockSettings.merged.security!.auth!.enforcedType = AuthType.QWEN_OAUTH;
      process.env['OPENAI_API_KEY'] = 'fake-key';

      const nonInteractiveConfig = {
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.JSON),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: undefined }),
      } as unknown as Config;

      let thrown: Error | undefined;
      try {
        await validateNonInteractiveAuth(
          undefined,
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown?.message).toBe('process.exit(1) called');
      {
        const errorArg = consoleErrorSpy.mock.calls[0]?.[0] as string;
        const payload = JSON.parse(errorArg);
        expect(payload.error.type).toBe('Error');
        expect(payload.error.code).toBe(1);
        expect(payload.error.message).toContain(
          'The configured auth type is qwen-oauth, but the current auth type is openai.',
        );
      }
    });

    it('prints JSON error when validateAuthMethod fails and exits with code 1', async () => {
      vi.spyOn(auth, 'validateAuthMethod').mockReturnValue('Auth error!');
      process.env['OPENAI_API_KEY'] = 'fake-key';

      const nonInteractiveConfig = {
        refreshAuth: refreshAuthMock,
        getOutputFormat: vi.fn().mockReturnValue(OutputFormat.JSON),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: undefined }),
      } as unknown as Config;

      let thrown: Error | undefined;
      try {
        await validateNonInteractiveAuth(
          AuthType.USE_OPENAI,
          undefined,
          nonInteractiveConfig,
          mockSettings,
        );
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown?.message).toBe('process.exit(1) called');
      {
        const errorArg = consoleErrorSpy.mock.calls[0]?.[0] as string;
        const payload = JSON.parse(errorArg);
        expect(payload.error.type).toBe('Error');
        expect(payload.error.code).toBe(1);
        expect(payload.error.message).toBe('Auth error!');
      }
    });
  });
});
