/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelCommand, fetchModels } from './modelCommand.js';
import { type CommandContext, CommandKind } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  AuthType,
  type ContentGeneratorConfig,
  type Config,
  fetchWithTimeout,
} from '@qwen-code/qwen-code-core';

// Helper function to create a mock config
function createMockConfig(
  contentGeneratorConfig: ContentGeneratorConfig | null,
): Partial<Config> {
  return {
    getContentGeneratorConfig: vi.fn().mockReturnValue(contentGeneratorConfig),
  };
}

describe('modelCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
    vi.clearAllMocks();
  });

  it('should have the correct name and description', () => {
    expect(modelCommand.name).toBe('model');
    expect(modelCommand.description).toBe(
      'Switch the model for this session (--fast for suggestion model)',
    );
  });

  it('should return error when config is not available', async () => {
    mockContext.services.config = null;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });

  it('should return error when content generator config is not available', async () => {
    const mockConfig = createMockConfig(null);
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Content generator configuration not available.',
    });
  });

  it('should return error when auth type is not available', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: undefined,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Authentication type not available.',
    });
  });

  it('should return dialog action for QWEN_OAUTH auth type', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.QWEN_OAUTH,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should return dialog action for USE_OPENAI auth type', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should return dialog action for unsupported auth types', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: 'UNSUPPORTED_AUTH_TYPE' as AuthType,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should handle undefined auth type', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: undefined,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Authentication type not available.',
    });
  });

  describe('non-interactive mode', () => {
    it('should return current model without triggering dialog when no args', async () => {
      mockContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'qwen-max',
              authType: AuthType.QWEN_OAUTH,
            }),
            getModel: vi.fn().mockReturnValue('qwen-max'),
          },
        },
      });

      const result = await modelCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('qwen-max'),
      });
      expect((result as { type: string }).type).toBe('message');
    });

    it('should return current fast model without triggering dialog for --fast no args', async () => {
      mockContext = createMockCommandContext({
        executionMode: 'non_interactive',
        invocation: { args: '--fast' },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'qwen-max',
              authType: AuthType.QWEN_OAUTH,
            }),
            getModel: vi.fn().mockReturnValue('qwen-max'),
          },
          settings: {
            merged: { fastModel: 'qwen-turbo' } as Record<string, unknown>,
          },
        },
      });

      const result = await modelCommand.action!(mockContext, '--fast');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('qwen-turbo'),
      });
    });
  });

  describe('completion', () => {
    it('should return --fast and list completions when no partial', async () => {
      const result = await modelCommand.completion!(mockContext, '');
      expect(result).toEqual([
        expect.objectContaining({ value: '--fast' }),
        expect.objectContaining({ value: 'list' }),
      ]);
    });

    it('should filter by partial match for --fast', async () => {
      const result = await modelCommand.completion!(mockContext, '--f');
      expect(result).toEqual([expect.objectContaining({ value: '--fast' })]);
    });

    it('should filter by partial match for list', async () => {
      const result = await modelCommand.completion!(mockContext, 'l');
      expect(result).toEqual([expect.objectContaining({ value: 'list' })]);
    });

    it('should return null when no match', async () => {
      const result = await modelCommand.completion!(mockContext, 'xyz');
      expect(result).toBeNull();
    });
  });
});

describe('fetchModels', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return model IDs on success', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'model-1' }, { id: 'model-2' }, { id: 'model-3' }],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const models = await fetchModels('https://api.example.com/v1/');

    expect(models).toEqual(['model-1', 'model-2', 'model-3']);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'application/json',
        }),
      }),
    );
  });

  it('should support bare array response', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue(['model-x', 'model-y']),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const models = await fetchModels('https://api.example.com/v1/');
    expect(models).toEqual(['model-x', 'model-y']);
  });

  it('should support object-wrapped array response (models field)', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        models: [{ id: 'm1' }, { id: 'm2' }],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const models = await fetchModels('https://api.example.com/v1/');
    expect(models).toEqual(['m1', 'm2']);
  });

  it('should include Authorization header when apiKey is provided', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'model-1' }],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await fetchModels('https://api.example.com/v1/', 'my-api-key');

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const lastCall = fetchMock.mock.calls[0];
    expect(lastCall[1]?.headers?.authorization).toBe('Bearer my-api-key');
  });

  it('should merge and lowercase custom headers', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [] }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await fetchModels(
      'https://api.example.com/v1/',
      'key',
      AuthType.USE_OPENAI,
      {
        'X-CUSTOM': 'val',
        Authorization: 'Other Token',
      },
    );

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const lastCall = fetchMock.mock.calls[0];
    const headers = lastCall[1].headers;
    expect(headers['x-custom']).toBe('val');
    expect(headers['authorization']).toBe('Other Token'); // Override
    expect(headers['Authorization']).toBeUndefined(); // Should be lowercased
  });

  it('should throw for Qwen OAuth', async () => {
    await expect(
      fetchModels(
        'https://api.example.com/v1/',
        undefined,
        AuthType.QWEN_OAUTH,
      ),
    ).rejects.toThrow('not supported for Qwen OAuth');
  });

  it('should throw FetchError immediately for zero timeout', async () => {
    await expect(
      fetchWithTimeout('https://api.example.com/v1/', 0),
    ).rejects.toThrow('timed out');
  });

  it('should throw FetchError immediately for negative timeout', async () => {
    await expect(
      fetchWithTimeout('https://api.example.com/v1/', -1000),
    ).rejects.toThrow('timed out');
  });

  it('should throw on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(fetchModels('https://api.example.com/v1/')).rejects.toThrow(
      'Network error',
    );
  });

  it('should throw on non-2xx response', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(fetchModels('https://api.example.com/v1/')).rejects.toThrow(
      /Request to https:\/\/api\.example\.com\/v1\/models failed \(401\)/,
    );
  });

  it('should sanitize apiKey in error messages', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Error with secret-key-12345'),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(
      fetchModels('https://api.example.com/v1/', 'secret-key-12345'),
    ).rejects.toThrow('[REDACTED]');
  });

  it('should handle empty data array', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [] }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const models = await fetchModels('https://api.example.com/v1/');
    expect(models).toEqual([]);
  });

  it('should filter out non-string and empty model IDs', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [
          { id: 'valid-model' },
          { id: 123 },
          { id: '' },
          { id: null },
          { id: 'another-valid' },
        ],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const models = await fetchModels('https://api.example.com/v1/');
    expect(models).toEqual(['valid-model', 'another-valid']);
  });

  it('should sanitize model IDs for ANSI escape sequences', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: '\x1b[31mmodel-a\x1b[0m' }, { id: 'model-b\x1b[H\x1b[J' }],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await fetchModels('https://api.example.com/v1/');
    expect(result).toEqual(['model-a', 'model-b']);
  });

  it('should throw on missing data array in response', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(fetchModels('https://api.example.com/v1/')).rejects.toThrow(
      'Unexpected response format: missing data array',
    );
  });

  it('should normalize baseUrl by removing trailing slashes', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'model-1' }],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await fetchModels('https://api.example.com/v1/');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.any(Object),
    );
  });

  it('should throw on invalid URL', async () => {
    await expect(fetchModels('not-a-valid-url')).rejects.toThrow(
      'Invalid baseUrl',
    );
  });

  it('should throw on non-HTTPS URL', async () => {
    await expect(fetchModels('http://api.example.com/v1/')).rejects.toThrow(
      'baseUrl must use HTTPS',
    );
  });

  it('should throw on private IP address (SSRF check) without calling fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await expect(fetchModels('https://192.168.1.1/api/')).rejects.toThrow(
      'private IP',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should throw on localhost (SSRF check) without calling fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await expect(fetchModels('https://localhost:8080/api/')).rejects.toThrow(
      'SSRF check',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should throw when data field is present but not an array', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ data: 'not-an-array' }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(fetchModels('https://api.example.com/v1/')).rejects.toThrow(
      'Unexpected response format: missing data array',
    );
  });

  it('should handle baseUrl with query string correctly', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'model-1' }],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await fetchModels('https://api.example.com/v1?version=2');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models?version=2',
      expect.any(Object),
    );
  });

  it('should include URL in non-2xx error message', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(fetchModels('https://api.example.com/v1/')).rejects.toThrow(
      'Request to https://api.example.com/v1/models failed (401)',
    );
  });

  it('should use "points to" in SSRF error message without calling fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await expect(fetchModels('https://192.168.1.1/api/')).rejects.toThrow(
      'points to a private IP address',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('/model list subcommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
    });
    vi.clearAllMocks();
  });

  it('should return error when config is not available', async () => {
    mockContext.services.config = null;

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });

  it('should return error when content generator config is not available', async () => {
    const mockConfig = createMockConfig(null);
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Content generator configuration not available.',
    });
  });

  it('should return error when baseUrl is not configured', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      baseUrl: undefined,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('No baseUrl configured'),
    });
  });

  it('should return "no models found" when fetchModels returns empty', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api.example.com/v1/',
    });
    mockContext.services.config = mockConfig as Config;

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [] }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No models found from the configured endpoint.',
    });
  });

  it('should return model list on success path', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api.example.com/v1/',
    });
    mockContext.services.config = mockConfig as Config;

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'model-a' }, { id: 'model-b' }],
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'model-a\nmodel-b',
    });
  });

  it('should return error when fetchModels throws', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api.example.com/v1/',
    });
    mockContext.services.config = mockConfig as Config;

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Failed to fetch models'),
    });
  });

  it('should show specific error message for Qwen OAuth in list subcommand', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.QWEN_OAUTH,
      baseUrl: 'https://api.example.com/v1/',
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining(
        'Model discovery is not supported for Qwen OAuth',
      ),
    });
  });

  it('should include URL in list subcommand error message', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api.example.com/v1/',
    });
    mockContext.services.config = mockConfig as Config;

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const result = await modelCommand.subCommands![0].action!(mockContext, '');

    expect((result as { content: string }).content).toContain(
      'https://api.example.com/v1/',
    );
  });
});

describe('list subcommand metadata', () => {
  it('should have correct name, kind, and supportedModes', () => {
    const listSub = modelCommand.subCommands![0];
    expect(listSub.name).toBe('list');
    expect(listSub.kind).toBe(CommandKind.BUILT_IN);
    expect(listSub.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('should have a description', () => {
    const listSub = modelCommand.subCommands![0];
    expect(listSub.description).toContain('List available models');
  });
});
