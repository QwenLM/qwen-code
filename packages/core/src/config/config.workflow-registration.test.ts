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
import { ToolNames } from '../tools/tool-names.js';

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  targetDir: '/tmp',
  debugMode: false,
  model: 'test-model',
  telemetry: { enabled: false },
  usageStatisticsEnabled: false,
  overrideExtensions: [],
};

describe('WorkflowTool registration', () => {
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

  it('is NOT registered when isWorkflowsEnabled() is false', async () => {
    delete process.env['QWEN_CODE_ENABLE_WORKFLOWS'];
    delete process.env['QWEN_CODE_DISABLE_WORKFLOWS'];
    const cfg = new Config({ ...baseParams });
    const registry = await cfg.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    expect(registry.getAllToolNames()).not.toContain(ToolNames.WORKFLOW);
  });

  it('is registered when isWorkflowsEnabled() is true', async () => {
    delete process.env['QWEN_CODE_DISABLE_WORKFLOWS'];
    process.env['QWEN_CODE_ENABLE_WORKFLOWS'] = '1';
    const cfg = new Config({ ...baseParams });
    const registry = await cfg.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    expect(registry.getAllToolNames()).toContain(ToolNames.WORKFLOW);
  });

  it('QWEN_CODE_DISABLE_WORKFLOWS=1 overrides enable-via-settings', async () => {
    process.env['QWEN_CODE_DISABLE_WORKFLOWS'] = '1';
    delete process.env['QWEN_CODE_ENABLE_WORKFLOWS'];
    const cfg = new Config({ ...baseParams });
    cfg.setWorkflowsEnabled(true);
    const registry = await cfg.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    expect(registry.getAllToolNames()).not.toContain(ToolNames.WORKFLOW);
  });
});

// FIX-G (Round 4 test Important): regression test for the FIX-8 anti-recursion
// guard. A subagent spawned BY a workflow must not be able to call the
// Workflow tool again — that would create unbounded O(k^n) fan-out. Without
// this assertion, a rename of `ToolNames.WORKFLOW` or accidental deletion of
// the exclusion entry would silently open the recursion.
describe('Workflow anti-recursion guard', () => {
  it('ToolNames.WORKFLOW is in EXCLUDED_TOOLS_FOR_SUBAGENTS', async () => {
    const { EXCLUDED_TOOLS_FOR_SUBAGENTS } = await import(
      '../agents/runtime/agent-core.js'
    );
    expect(EXCLUDED_TOOLS_FOR_SUBAGENTS.has(ToolNames.WORKFLOW)).toBe(true);
  });
});
