/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// Shared mocks needed by Config constructor.
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
import type { ConfigParameters } from './config.js';
import { Config } from './config.js';

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  targetDir: '/tmp',
  debugMode: false,
  model: 'test-model',
  telemetry: { enabled: false },
  usageStatisticsEnabled: false,
  overrideExtensions: [],
};

describe('Config workflows feature gate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
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
    // Restore env vars touched by tests
    for (const key of [
      'QWEN_CODE_ENABLE_WORKFLOWS',
      'QWEN_CODE_DISABLE_WORKFLOWS',
    ]) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('defaults to disabled', () => {
    delete process.env['QWEN_CODE_ENABLE_WORKFLOWS'];
    delete process.env['QWEN_CODE_DISABLE_WORKFLOWS'];
    const cfg = new Config({ ...baseParams });
    expect(cfg.isWorkflowsEnabled()).toBe(false);
  });

  it('respects QWEN_CODE_ENABLE_WORKFLOWS=1', () => {
    delete process.env['QWEN_CODE_DISABLE_WORKFLOWS'];
    process.env['QWEN_CODE_ENABLE_WORKFLOWS'] = '1';
    const cfg = new Config({ ...baseParams });
    expect(cfg.isWorkflowsEnabled()).toBe(true);
  });

  // TST-I1: "respects setWorkflowsEnabled(true)" was deleted — it is a
  // getter/setter tautology that tests no logic.

  it('QWEN_CODE_DISABLE_WORKFLOWS=1 overrides everything', () => {
    process.env['QWEN_CODE_DISABLE_WORKFLOWS'] = '1';
    process.env['QWEN_CODE_ENABLE_WORKFLOWS'] = '1';
    const cfg = new Config({ ...baseParams });
    cfg.setWorkflowsEnabled(true);
    expect(cfg.isWorkflowsEnabled()).toBe(false);
  });

  it('honors workflowsEnabled passed via ConfigParameters', () => {
    const cfg = new Config({ ...baseParams, workflowsEnabled: true });
    expect(cfg.isWorkflowsEnabled()).toBe(true);
  });
});
