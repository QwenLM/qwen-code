/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { runDoctorChecks } from './doctorChecks.js';
import { type CommandContext } from '../ui/commands/types.js';
import { createMockCommandContext } from '../test-utils/mockCommandContext.js';
import * as systemInfoUtils from './systemInfo.js';
import * as authModule from '../config/auth.js';
import * as allProviders from '../auth/allProviders.js';

vi.mock('./systemInfo.js');
vi.mock('../config/auth.js');
vi.mock('../auth/allProviders.js', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('../auth/allProviders.js');
  return {
    ...actual,
    findProviderByCredentials: vi.fn(actual.findProviderByCredentials),
  };
});
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('@qwen-code/qwen-code-core');
  return {
    ...actual,
    canUseRipgrep: vi.fn().mockResolvedValue(true),
    getMCPServerStatus: vi.fn().mockReturnValue('connected'),
    MCPServerStatus: {
      CONNECTED: 'connected',
      CONNECTING: 'connecting',
      DISCONNECTED: 'disconnected',
    },
  };
});

describe('runDoctorChecks', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getAuthType: vi.fn().mockReturnValue('openai'),
          getGeminiClient: vi.fn().mockReturnValue({
            isInitialized: vi.fn().mockReturnValue(true),
          }),
          getModel: vi.fn().mockReturnValue('gpt-4'),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'openrouter/auto',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKeyEnvKey: 'OPENROUTER_API_KEY',
          }),
          getMcpServers: vi.fn().mockReturnValue({}),
          getToolRegistry: vi.fn().mockReturnValue({
            getAllTools: vi.fn().mockReturnValue([{ name: 'tool1' }]),
          }),
          getUseBuiltinRipgrep: vi.fn().mockReturnValue(false),
        },
        settings: {
          merged: {},
        },
        git: {} as never,
      },
    } as unknown as CommandContext);

    vi.mocked(systemInfoUtils.getNpmVersion).mockResolvedValue('10.0.0');
    vi.mocked(systemInfoUtils.getGitVersion).mockResolvedValue(
      'git version 2.39.0',
    );
    vi.mocked(authModule.validateAuthMethod).mockReturnValue(null);
  });

  afterEach(() => {
    delete process.env['OPENROUTER_API_KEY'];
    vi.clearAllMocks();
  });

  it('should return results for all categories', async () => {
    const results = await runDoctorChecks(mockContext);

    const categories = [...new Set(results.map((r) => r.category))];
    expect(categories).toContain('System');
    expect(categories).toContain('Authentication');
    expect(categories).toContain('Configuration');
    expect(categories).toContain('Tools');
    expect(categories).toContain('Git');
  });

  it('should pass Node.js version check for v20+', async () => {
    const results = await runDoctorChecks(mockContext);
    const nodeCheck = results.find((r) => r.name === 'Node.js version');
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe('pass');
  });

  it('should pass npm check when npm is available', async () => {
    const results = await runDoctorChecks(mockContext);
    const npmCheck = results.find((r) => r.name === 'npm version');
    expect(npmCheck).toBeDefined();
    expect(npmCheck!.status).toBe('pass');
    expect(npmCheck!.message).toBe('10.0.0');
  });

  it('should warn when npm is not available', async () => {
    vi.mocked(systemInfoUtils.getNpmVersion).mockResolvedValue('unknown');
    const results = await runDoctorChecks(mockContext);
    const npmCheck = results.find((r) => r.name === 'npm version');
    expect(npmCheck!.status).toBe('warn');
  });

  it('should fail auth check when auth is not configured', async () => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getAuthType: vi.fn().mockReturnValue(undefined),
          getGeminiClient: vi.fn().mockReturnValue({
            isInitialized: vi.fn().mockReturnValue(false),
          }),
          getModel: vi.fn().mockReturnValue('gpt-4'),
          getMcpServers: vi.fn().mockReturnValue({}),
          getToolRegistry: vi.fn().mockReturnValue({
            getAllTools: vi.fn().mockReturnValue([]),
          }),
          getUseBuiltinRipgrep: vi.fn().mockReturnValue(false),
        },
        settings: { merged: {} },
        git: {} as never,
      },
    } as unknown as CommandContext);

    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');
    expect(authCheck!.status).toBe('fail');
  });

  it('should pass auth check when credentials are valid', async () => {
    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');
    expect(authCheck!.status).toBe('pass');
  });

  it('should show provider detail when credentials match a known provider', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');

    expect(authCheck!.detail).toContain('Provider: OpenRouter');
    expect(authCheck!.detail).toContain(
      'Base URL: https://openrouter.ai/api/v1',
    );
    expect(authCheck!.detail).toContain('Model: openrouter/auto');
    expect(authCheck!.detail).toContain(
      'API key: configured (OPENROUTER_API_KEY)',
    );
  });

  it('should show a missing API key in provider detail', async () => {
    delete process.env['OPENROUTER_API_KEY'];

    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');

    expect(authCheck!.detail).toContain('API key: OPENROUTER_API_KEY not set');
  });

  it('should treat an empty API key environment variable as not set', async () => {
    process.env['OPENROUTER_API_KEY'] = '';

    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');

    expect(authCheck!.detail).toContain('API key: OPENROUTER_API_KEY not set');
  });

  it('should omit provider detail when credentials do not match a known provider', async () => {
    vi.mocked(allProviders.findProviderByCredentials).mockReturnValueOnce(
      undefined,
    );

    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');

    expect(authCheck!.detail).not.toContain('Provider:');
    expect(authCheck!.detail).toContain(
      'Base URL: https://openrouter.ai/api/v1',
    );
  });

  it('should fall back to config model when content generator config is missing', async () => {
    const config = mockContext.services.config;
    vi.mocked(config!.getContentGeneratorConfig).mockImplementationOnce(
      () => undefined as never,
    );

    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');

    expect(authCheck!.detail).toBe('Model: gpt-4');
  });

  it('should omit detail when no enriched auth fields are available', async () => {
    const config = mockContext.services.config;
    vi.mocked(config!.getModel).mockReturnValueOnce(undefined as never);
    vi.mocked(config!.getContentGeneratorConfig).mockReturnValueOnce(
      {} as never,
    );

    const results = await runDoctorChecks(mockContext);
    const authCheck = results.find((r) => r.name === 'API key');

    expect(authCheck!.detail).toBeUndefined();
  });

  it('should pass tool registry check when registry is loaded', async () => {
    const results = await runDoctorChecks(mockContext);
    const toolCheck = results.find((r) => r.name === 'Tool registry');
    expect(toolCheck!.status).toBe('pass');
    expect(toolCheck!.message).toContain('1');
  });

  it('should pass git check when git service exists', async () => {
    const results = await runDoctorChecks(mockContext);
    const gitCheck = results.find((r) => r.name === 'Git');
    expect(gitCheck!.status).toBe('pass');
  });

  it('should warn git check when git service is missing and git binary is unavailable', async () => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getAuthType: vi.fn().mockReturnValue('openai'),
          getGeminiClient: vi.fn().mockReturnValue({
            isInitialized: vi.fn().mockReturnValue(true),
          }),
          getModel: vi.fn().mockReturnValue('gpt-4'),
          getMcpServers: vi.fn().mockReturnValue({}),
          getToolRegistry: vi.fn().mockReturnValue({
            getAllTools: vi.fn().mockReturnValue([]),
          }),
          getUseBuiltinRipgrep: vi.fn().mockReturnValue(false),
        },
        settings: { merged: {} },
        git: undefined,
      },
    } as unknown as CommandContext);

    vi.mocked(systemInfoUtils.getGitVersion).mockResolvedValue('unknown');

    const results = await runDoctorChecks(mockContext);
    const gitCheck = results.find((r) => r.name === 'Git');
    expect(gitCheck!.status).toBe('warn');
  });

  it('should pass git check when git service is missing but git binary is available', async () => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getAuthType: vi.fn().mockReturnValue('openai'),
          getGeminiClient: vi.fn().mockReturnValue({
            isInitialized: vi.fn().mockReturnValue(true),
          }),
          getModel: vi.fn().mockReturnValue('gpt-4'),
          getMcpServers: vi.fn().mockReturnValue({}),
          getToolRegistry: vi.fn().mockReturnValue({
            getAllTools: vi.fn().mockReturnValue([]),
          }),
          getUseBuiltinRipgrep: vi.fn().mockReturnValue(false),
        },
        settings: { merged: {} },
        git: undefined,
      },
    } as unknown as CommandContext);

    vi.mocked(systemInfoUtils.getGitVersion).mockResolvedValue(
      'git version 2.39.0',
    );

    const results = await runDoctorChecks(mockContext);
    const gitCheck = results.find((r) => r.name === 'Git');
    expect(gitCheck!.status).toBe('pass');
    expect(gitCheck!.message).toBe('git version 2.39.0');
  });

  it('should report disabled MCP servers as pass instead of fail', async () => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getAuthType: vi.fn().mockReturnValue('openai'),
          getGeminiClient: vi.fn().mockReturnValue({
            isInitialized: vi.fn().mockReturnValue(true),
          }),
          getModel: vi.fn().mockReturnValue('gpt-4'),
          getMcpServers: vi
            .fn()
            .mockReturnValue({ 'my-server': { command: 'node' } }),
          isMcpServerDisabled: vi.fn().mockReturnValue(true),
          getToolRegistry: vi.fn().mockReturnValue({
            getAllTools: vi.fn().mockReturnValue([]),
          }),
          getUseBuiltinRipgrep: vi.fn().mockReturnValue(false),
        },
        settings: { merged: {} },
        git: {} as never,
      },
    } as unknown as CommandContext);

    const results = await runDoctorChecks(mockContext);
    const mcpCheck = results.find((r) => r.name === 'my-server');
    expect(mcpCheck).toBeDefined();
    expect(mcpCheck!.status).toBe('pass');
    expect(mcpCheck!.message).toBe('disabled');
  });

  it('should not report MCP connection status in non-interactive mode', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {
          getAuthType: vi.fn().mockReturnValue('openai'),
          getGeminiClient: vi.fn().mockReturnValue({
            isInitialized: vi.fn().mockReturnValue(true),
          }),
          getModel: vi.fn().mockReturnValue('gpt-4'),
          getMcpServers: vi
            .fn()
            .mockReturnValue({ 'my-server': { command: 'node' } }),
          isMcpServerDisabled: vi.fn().mockReturnValue(false),
          getToolRegistry: vi.fn().mockReturnValue({
            getAllTools: vi.fn().mockReturnValue([]),
          }),
          getUseBuiltinRipgrep: vi.fn().mockReturnValue(false),
        },
        settings: { merged: {} },
        git: {} as never,
      },
    } as unknown as CommandContext);

    const results = await runDoctorChecks(mockContext);
    const mcpCheck = results.find((r) => r.name === 'my-server');
    expect(mcpCheck).toBeDefined();
    // In non-interactive mode, servers are never connected — must not report as fail
    expect(mcpCheck!.status).toBe('pass');
  });
});
