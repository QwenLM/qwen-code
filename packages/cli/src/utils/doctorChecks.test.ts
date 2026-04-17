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

vi.mock('./systemInfo.js');
vi.mock('../config/auth.js');
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
    vi.mocked(authModule.validateAuthMethod).mockReturnValue(null);
  });

  afterEach(() => {
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

  it('should warn git check when git service is missing', async () => {
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

    const results = await runDoctorChecks(mockContext);
    const gitCheck = results.find((r) => r.name === 'Git');
    expect(gitCheck!.status).toBe('warn');
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
});
