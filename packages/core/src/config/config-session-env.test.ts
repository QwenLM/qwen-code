/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the module-level `sessionEnvClaimed` and `modelEnvClaimed`
 * guards in Config.
 *
 * The guards ensure that only the first Config instance in a process sets
 * `process.env['QWEN_CODE_SESSION_ID']` / `process.env['QWEN_CODE_MODEL']`,
 * preventing throwaway instances (e.g. telemetry-only) from overwriting the
 * real session's values.
 *
 * We use `vi.isolateModules` to get a fresh module scope (resetting the
 * module-level flags) for each test.
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
  DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: 1024 * 1024,
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT: 100 * 1024 * 1024,
  isTelemetrySdkInitialized: vi.fn().mockReturnValue(false),
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  refreshSessionContext: vi.fn(),
  logSessionEnd: vi.fn(),
}));
vi.mock('../core/contentGenerator.js', () => ({
  resolveContentGeneratorConfigWithSources: vi.fn().mockReturnValue({
    config: { model: 'test-model', apiKey: 'test-key' },
    sources: {},
  }),
  createContentGeneratorConfig: vi.fn().mockReturnValue({}),
  createContentGenerator: vi.fn().mockReturnValue({}),
  AuthType: { USE_GEMINI: 'gemini', QWEN_OAUTH: 'qwen-oauth' },
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
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  targetDir: '/tmp',
  debugMode: false,
  model: 'test-model',
  telemetry: { enabled: false },
  usageStatisticsEnabled: false,
  overrideExtensions: [],
};

// Each test re-imports config.js's full transitive module graph cold
// (afterEach calls vi.resetModules() so the module-level sessionEnvClaimed
// flag resets). That cold transform+evaluate runs several seconds and, under
// a contended CI runner, crosses the 5s default — a flaky timeout, not a hang.
// The reset is load-bearing for what these tests check, so give them headroom.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let originalEnv: string | undefined;
let originalModelEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env['QWEN_CODE_SESSION_ID'];
  delete process.env['QWEN_CODE_SESSION_ID'];
  originalModelEnv = process.env['QWEN_CODE_MODEL'];
  delete process.env['QWEN_CODE_MODEL'];

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
  if (originalModelEnv !== undefined) {
    process.env['QWEN_CODE_MODEL'] = originalModelEnv;
  } else {
    delete process.env['QWEN_CODE_MODEL'];
  }
  vi.resetModules();
});

describe('Config sessionEnvClaimed guard', () => {
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

describe('Config modelEnvClaimed guard', () => {
  it('first Config publishes its model to QWEN_CODE_MODEL', async () => {
    const { Config } = await import('./config.js');
    new Config({ ...baseParams });

    expect(process.env['QWEN_CODE_MODEL']).toBe('test-model');
  });

  it('a later Config does not overwrite the claimed slot', async () => {
    const { Config } = await import('./config.js');
    new Config({ ...baseParams });

    // Second Config (daemon side-session or telemetry-only throwaway)
    new Config({ ...baseParams, model: 'other-model' });

    expect(process.env['QWEN_CODE_MODEL']).toBe('test-model');
  });

  it('only the claiming Config republishes on setModel', async () => {
    const { Config } = await import('./config.js');
    const owner = new Config({ ...baseParams });
    const later = new Config({ ...baseParams, model: 'other-model' });

    // Simulate /model on the live session
    await owner.setModel('switched-model');
    expect(process.env['QWEN_CODE_MODEL']).toBe('switched-model');

    // A non-owner's switch must not touch the process-global slot
    await later.setModel('hijacked-model');
    expect(process.env['QWEN_CODE_MODEL']).toBe('switched-model');
  });

  it('republishes on refreshAuth when the resolved model changes', async () => {
    const { Config } = await import('./config.js');
    // Import from the same (mocked) module instance the cold config.js import
    // above binds to, so the re-mock below is what refreshAuth actually calls.
    const { resolveContentGeneratorConfigWithSources, AuthType } = await import(
      '../core/contentGenerator.js'
    );
    const config = new Config({ ...baseParams });
    expect(process.env['QWEN_CODE_MODEL']).toBe('test-model');

    // Auth flows call refreshAuth directly — no model-change listener fires —
    // and the resolved model can differ from the pre-auth one; the slot must
    // follow it so subprocesses report the model that is actually active.
    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: {
        model: 'auth-resolved-model',
        apiKey: 'k',
      } as ContentGeneratorConfig,
      sources: {},
    });
    await config.refreshAuth(AuthType.USE_GEMINI);

    expect(process.env['QWEN_CODE_MODEL']).toBe('auth-resolved-model');
  });

  it("registers each Config's model per session, so a daemon side-session reads its own", async () => {
    const { Config } = await import('./config.js');
    // Import from the same cold module graph the Config above bound to, so this
    // reads the registry the constructor actually wrote.
    const { getSessionModel } = await import('../utils/sessionIdContext.js');
    const first = new Config({ ...baseParams });
    const later = new Config({ ...baseParams, model: 'other-model' });

    // The process-global slot is first-writer-wins (covered above), but the
    // per-session registry holds EACH session's model — this is what daemon
    // mode reads at spawn time, so a later session is not stuck reporting the
    // first session's model.
    expect(getSessionModel(first.getSessionId())).toBe('test-model');
    expect(getSessionModel(later.getSessionId())).toBe('other-model');
  });

  it('re-keys the per-session model registry on startNewSession', async () => {
    const { Config } = await import('./config.js');
    const { getSessionModel } = await import('../utils/sessionIdContext.js');
    // Owner boots first and claims the process-global slot; the side-session
    // is the non-owner Config whose subprocesses read the per-session registry.
    new Config({ ...baseParams });
    const side = new Config({ ...baseParams, model: 'other-model' });
    const oldSessionId = side.getSessionId();
    expect(getSessionModel(oldSessionId)).toBe('other-model');

    // /clear (and /reset, /new, /resume) flow through startNewSession, which
    // mints a new session id. The registry entry must move with it — leaving
    // it keyed on the old id would make the side-session's subprocesses miss
    // and fall back to the owner's model.
    const newSessionId = side.startNewSession();

    expect(newSessionId).not.toBe(oldSessionId);
    expect(getSessionModel(newSessionId)).toBe('other-model');
    expect(getSessionModel(oldSessionId)).toBeUndefined();
  });
});
