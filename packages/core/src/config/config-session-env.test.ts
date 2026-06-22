/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the module-level `sessionEnvClaimed` guard in Config.
 *
 * The guard ensures that only the first Config instance in a process sets
 * `process.env['QWEN_CODE_SESSION_ID']`, preventing throwaway instances
 * (e.g. telemetry-only) from overwriting the real session's ID.
 *
 * We use `vi.isolateModules` to get a fresh module scope (resetting the
 * module-level flag) for each test.
 */

// Shared mocks needed by Config constructor
vi.mock('node:fs');
vi.mock('node:fs/promises');
vi.mock('../telemetry/index.js', () => ({
  QwenLogger: vi.fn().mockImplementation(() => ({
    logStartSessionEvent: vi.fn().mockResolvedValue(undefined),
    logEndSessionEvent: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
  DEFAULT_TELEMETRY_TARGET: 'none',
  DEFAULT_OTLP_ENDPOINT: '',
  isTelemetrySdkInitialized: vi.fn().mockReturnValue(false),
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  refreshSessionContext: vi.fn(),
}));
vi.mock('../core/contentGenerator.js', () => ({
  resolveContentGeneratorConfigWithSources: vi.fn().mockReturnValue({
    config: { model: 'test-model', apiKey: 'test-key' },
    sources: {},
  }),
  createContentGeneratorConfig: vi.fn().mockReturnValue({}),
  createContentGenerator: vi.fn().mockReturnValue({}),
  AuthType: { API_KEY: 'apiKey' },
  Protocol: {
    OPENAI: 'openai',
    QWEN_OAUTH: 'qwen-oauth',
    GEMINI: 'gemini',
    ANTHROPIC: 'anthropic',
  },
}));
vi.mock('../core/baseLlmClient.js');
vi.mock('../core/toolHookTriggers.js', () => ({
  fireNotificationHook: vi.fn().mockResolvedValue({}),
}));
vi.mock('../services/skillManager.js', () => {
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.refreshCache = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stopWatching = vi.fn();
  SkillManagerMock.prototype.listSkills = vi.fn().mockResolvedValue([]);
  SkillManagerMock.prototype.addChangeListener = vi.fn();
  SkillManagerMock.prototype.removeChangeListener = vi.fn();
  SkillManagerMock.prototype.matchAndActivateByPath = vi
    .fn()
    .mockResolvedValue([]);
  SkillManagerMock.prototype.matchAndActivateByPaths = vi
    .fn()
    .mockResolvedValue([]);
  return { SkillManager: SkillManagerMock };
});
vi.mock('../subagents/subagent-manager.js', () => {
  const SubagentManagerMock = vi.fn();
  SubagentManagerMock.prototype.loadSessionSubagents = vi.fn();
  SubagentManagerMock.prototype.addChangeListener = vi
    .fn()
    .mockReturnValue(() => {});
  SubagentManagerMock.prototype.listSubagents = vi.fn().mockResolvedValue([]);
  return { SubagentManager: SubagentManagerMock };
});
vi.mock('../ide/ide-client.js', () => ({
  IdeClient: {
    getInstance: vi.fn().mockResolvedValue({
      getConnectionStatus: vi.fn(),
      initialize: vi.fn(),
      shutdown: vi.fn(),
    }),
  },
}));
vi.mock('../memory/const.js', () => ({
  setGeminiMdFilename: vi.fn(),
}));

import * as fs from 'node:fs';
import type { Mock } from 'vitest';
import type { ConfigParameters } from './config.js';

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  targetDir: '/tmp',
  debugMode: false,
  model: 'test-model',
  telemetry: { enabled: false },
  usageStatisticsEnabled: false,
  overrideExtensions: [],
};

describe('Config sessionEnvClaimed guard', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];

    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([]);
    (fs.statSync as Mock).mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    });
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    (fs.mkdirSync as Mock).mockImplementation(() => undefined);
    (fs.writeFileSync as Mock).mockImplementation(() => undefined);
    (fs.renameSync as Mock).mockImplementation(() => undefined);
    (fs.copyFileSync as Mock).mockImplementation(() => undefined);
    (fs.unlinkSync as Mock).mockImplementation(() => undefined);
    (fs.readFileSync as Mock).mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['QWEN_CODE_SESSION_ID'] = originalEnv;
    } else {
      delete process.env['QWEN_CODE_SESSION_ID'];
    }
    vi.resetModules();
  });

  it('first Config sets process.env QWEN_CODE_SESSION_ID to its sessionId', async () => {
    const { Config } = await import('./config.js');
    const config = new Config({ ...baseParams });

    expect(process.env['QWEN_CODE_SESSION_ID']).toBe(config.getSessionId());
  });

  it('subsequent Config does not overwrite the env var set by the first', async () => {
    const { Config } = await import('./config.js');
    const firstConfig = new Config({ ...baseParams });
    const firstSessionId = firstConfig.getSessionId();

    // Second Config (e.g. telemetry-only throwaway instance)
    const secondConfig = new Config({
      ...baseParams,
      sessionId: 'throwaway-session-id',
    });

    // The env var should still be the first config's session ID
    expect(process.env['QWEN_CODE_SESSION_ID']).toBe(firstSessionId);
    expect(process.env['QWEN_CODE_SESSION_ID']).not.toBe(
      secondConfig.getSessionId(),
    );
  });

  it('startNewSession updates env var to the new session ID', async () => {
    const { Config } = await import('./config.js');
    const config = new Config({ ...baseParams });
    const originalSessionId = config.getSessionId();

    expect(process.env['QWEN_CODE_SESSION_ID']).toBe(originalSessionId);

    // Simulate /clear or session switch
    config.startNewSession('new-session-uuid-123');

    expect(process.env['QWEN_CODE_SESSION_ID']).toBe('new-session-uuid-123');
    expect(process.env['QWEN_CODE_SESSION_ID']).not.toBe(originalSessionId);
  });
});
