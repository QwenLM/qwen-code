/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_AUTOCOMPACT_WINDOW } from "../config/brand.js";

import {
  testProviderModelResolution,
  testCompressionConfig,
  testModelProviderManager,
} from './provider-test-helpers.js';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompressionStatus } from '../core/turn-events.js';
import { DEFAULT_COMPRESSION_CONFIG } from './config.js';
import { createEmptyCompressionPipelineState } from './state-store.js';
import { runAutoCompactStage } from './auto-compact.js';
import type { CompressionStageContext } from './types.js';
import type { TextBlock } from '../protocol/transcript/message.js';
import { getContentBlocks } from './message-types.js';
import { makeUser, makeAssistant } from './test-helpers.js';
import { getConfigValue } from '../config-service/index.js';
import { getAutoCompactThreshold } from './thresholds.js';
import { coreEvents } from '../utils/events.js';

/**
 * Drive the auto-compact threshold below the test history's token count so
 * the threshold gate never short-circuits the runs we care about. Tests that
 * need the production threshold (e.g. ones that exercise the post-compact
 * production threshold) intentionally do NOT call this. The global
 * test-setup afterEach unstubs envs between tests.
 */
function forceLowAutoCompactThreshold(): void {
  vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '100');
}

vi.mock('../core/prompts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/prompts.js')>()),
  getCompressionPrompt: () => 'compression prompt',
  getCompactSummaryUserMessage: (summary: string) => summary,
}));

vi.mock('../utils/environmentContext.js', () => ({
  getInitialChatHistory: async (
    _config: unknown,
    extraHistory?: CompressionStageContext['workingHistory'],
  ) => extraHistory ?? [],
}));

vi.mock('../utils/tokenCalculation.js', async () => {
  const actual = await vi.importActual('../utils/tokenCalculation.js');
  return { ...actual };
});

vi.mock('../core/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(async () => ({
    messages: [],
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    textContent:
      '<analysis>internal reasoning</analysis>\n<summary>generated compact snapshot</summary>',
  })),
}));

vi.mock('../config-service/index.js', () => ({
  getConfigValue: vi.fn(),
}));

let tmpRoot: string;

function createContext(
  maxConsecutiveFailures = 3,
  consecutiveFailures = 0,
): CompressionStageContext {
  const manager = testModelProviderManager();
  return {
    input: {
      modelProviderManager: manager,
      modelResolution: testProviderModelResolution('test-model'),
      history: [],
      requestPrefixMessages: [],
      promptTokenCount: 123,
      systemPrompt: undefined,
      tools: [],
      promptId: 'prompt-1',
      force: false,
      trigger: 'auto',
      autoCompactTracking: { consecutiveFailures },
      config: {
        ...testCompressionConfig(manager),
        getCompressionConfig: () => ({
          ...DEFAULT_COMPRESSION_CONFIG,
          autoCompact: {
            ...DEFAULT_COMPRESSION_CONFIG.autoCompact,
            maxConsecutiveFailures,
          },
        }),
        getToolRegistry: () => ({ getAllTools: () => [] }),
        getApprovedPlanPath: () => undefined,
        getMemoryContextManager: () => undefined,
        getParentToolSchemas: () => [],
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
        storage: {
          getProjectTempDir: () => tmpRoot,
          getProjectRoot: () => tmpRoot,
        },
      } as unknown as CompressionStageContext['input']['config'],
      target: 'main',
      rootSessionId: 'root-session-main',
      sessionScopeId: 'session-main',
    },
    state: createEmptyCompressionPipelineState(),
    boundary: {
      startIndex: 0,
      prefixContents: [],
      contents: [],
      source: 'initial_history',
    },
    fullHistory: [],
    workingHistory: [
      makeUser([{ type: 'text' as const, text: 'history content' }]),
      makeAssistant([{ type: 'text' as const, text: 'model reply' }]),
      makeUser([{ type: 'text' as const, text: 'follow up' }]),
    ],
  };
}

describe('runAutoCompactStage', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Clear any inherited ENV_AUTOCOMPACT_WINDOW so getAutoCompactThreshold
    // uses the full model context window rather than a reduced test/dev value.
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-auto-compact-'));
  });

  // The global test-setup afterEach should unstub envs between tests, but
  // a leaked `ENV_AUTOCOMPACT_WINDOW=100` from forceLowAutoCompactThreshold()
  // drops the auto-compact threshold into negative territory and shifts
  // downstream tests into branches they weren't written for. Belt-and-
  // suspenders cleanup here.
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skips auto-compact when the circuit breaker is tripped', async () => {
    forceLowAutoCompactThreshold();
    const context = createContext(3, 3);
    const progressSpy = vi.spyOn(coreEvents, 'emitCompressionProgress');

    const result = await runAutoCompactStage(context);

    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.info.originalTokenCount).toBeGreaterThan(0);
    expect(progressSpy).not.toHaveBeenCalled();
  });

  it('does not announce progress before the automatic threshold is reached', async () => {
    const context = createContext();
    const progressSpy = vi.spyOn(coreEvents, 'emitCompressionProgress');

    const result = await runAutoCompactStage(context);

    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(progressSpy).not.toHaveBeenCalled();
  });

  it('uses the request context window when the model is a routing alias', async () => {
    const context = createContext();
    const thresholdObserver = vi.fn();
    context.input.modelResolution = testProviderModelResolution(
      'auto',
      context.input.modelResolution.config,
    );
    context.input.modelResolution = {
      ...context.input.modelResolution,
      config: {
        ...context.input.modelResolution.config,
        context: { contextWindow: 128_000 },
      },
    };
    context.input.promptTokenCount = 100_000;
    context.input.onAutoCompactThresholdResolved = thresholdObserver;

    const result = await runAutoCompactStage(context);

    expect(thresholdObserver).toHaveBeenCalledExactlyOnceWith(95_000);
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
  });

  it('announces progress only after automatic compaction is accepted', async () => {
    forceLowAutoCompactThreshold();
    const context = createContext();
    const progressSpy = vi.spyOn(coreEvents, 'emitCompressionProgress');

    await runAutoCompactStage(context);

    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'starting',
        trigger: 'auto',
        sessionScopeId: 'session-main',
        target: 'main',
      }),
    );
  });

  it.each(['manual', 'reactive'] as const)(
    'allows forced %s compaction through an open auto circuit',
    async (trigger) => {
      forceLowAutoCompactThreshold();
      const context = createContext(3, 3);
      context.input.force = true;
      context.input.trigger = trigger;

      const result = await runAutoCompactStage(context);

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    },
  );

  it('does not retry reactive compaction while a prerequisite is blocked', async () => {
    forceLowAutoCompactThreshold();
    const context = createContext(3, 0);
    context.input.force = true;
    context.input.trigger = 'reactive';
    context.input.autoCompactTracking.blockedReason = 'quota_exhausted';

    const result = await runAutoCompactStage(context);

    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });

  it('runs the fork snapshot compactor', async () => {
    forceLowAutoCompactThreshold();
    const context = createContext(3, 2);

    const result = await runAutoCompactStage(context);

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    // Pipeline prepends a system/compact_boundary marker; snapshot now sits
    // at index 1.
    expect(result.newHistory![0].type).toBe('system');
    expect((result.newHistory![0] as { subtype?: string }).subtype).toBe(
      'compact_boundary',
    );
    expect(
      (getContentBlocks(result.newHistory![1])[0] as TextBlock)?.text,
    ).toContain('generated compact snapshot');
  });

  it('freezes compact routing before PreCompact and reports that model', async () => {
    forceLowAutoCompactThreshold();
    const context = createContext();
    const selectCompactModel = vi.fn().mockResolvedValue(
      testProviderModelResolution('compact-model', {
        reasoning: { effort: 'low' },
      }),
    );
    vi.mocked(context.input.modelProviderManager.select).mockImplementation(
      selectCompactModel,
    );
    context.input.abortSignal = new AbortController().signal;
    const firePreCompactEvent = vi.fn().mockResolvedValue(undefined);
    (
      context.input.config as unknown as {
        getHookSystem: () => unknown;
      }
    ).getHookSystem = () => ({ firePreCompactEvent });

    const result = await runAutoCompactStage(context);

    expect(selectCompactModel).toHaveBeenCalledTimes(1);
    expect(firePreCompactEvent).toHaveBeenCalledWith(
      'auto',
      '',
      undefined,
      'compact-model',
    );
    expect(result.hookModel).toBe('compact-model');
  });

  it('short-circuits when a PreCompact hook returns decision:block', async () => {
    forceLowAutoCompactThreshold();
    const context = createContext(3, 2);
    const firePreCompactEvent = vi.fn().mockResolvedValue({
      success: true,
      allOutputs: [],
      errors: [],
      totalDuration: 0,
      finalOutput: {
        decision: 'block',
        reason: 'critical operation in progress',
        isBlockingDecision: () => true,
        getEffectiveReason: () => 'critical operation in progress',
      },
    });
    const firePostCompactEvent = vi.fn();
    (
      context.input.config as unknown as {
        getHookSystem: () => unknown;
      }
    ).getHookSystem = () => ({
      firePreCompactEvent,
      firePostCompactEvent,
    });

    const result = await runAutoCompactStage(context);

    expect(firePreCompactEvent).toHaveBeenCalledTimes(1);
    expect(firePostCompactEvent).not.toHaveBeenCalled();
    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED,
    );
    expect(result.info.blockReason).toBe('critical operation in progress');
  });
});

describe('QCS automatic threshold cap', () => {
  beforeEach(() => {
    vi.mocked(getConfigValue).mockReturnValue({
      enabled: true,
      model_threshold_caps: { qmodel_38max: 600000, qfmodel: 600000 },
    });
  });
  afterEach(() => vi.mocked(getConfigValue).mockReset());

  it.each(['qmodel_38max', 'qfmodel'])(
    'starts compaction at exactly 600K for %s without extra routing',
    async (model) => {
      const ctx = createContext();
      ctx.input.modelResolution = testProviderModelResolution(
        model,
        ctx.input.modelResolution.config,
      );
      ctx.input.modelResolution = {
        ...ctx.input.modelResolution,
        config: {
          ...ctx.input.modelResolution.config,
          context: {
            ...ctx.input.modelResolution.config.context,
            contextWindow: 1000000,
          },
        },
      };
      ctx.input.promptTokenCount = 599999;
      const resolve = vi
        .fn()
        .mockResolvedValue(
          testProviderModelResolution(model, {
            context: { contextWindow: 1000000 },
          }),
        );
      vi.mocked(ctx.input.modelProviderManager.select).mockImplementation(
        resolve,
      );
      const observe = vi.fn();
      ctx.input.onAutoCompactPolicyResolved = observe;
      expect((await runAutoCompactStage(ctx)).info.compressionStatus).toBe(
        CompressionStatus.NOOP,
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(observe).toHaveBeenLastCalledWith(
        {
          model,
          base_threshold_tokens: getAutoCompactThreshold(
            ctx.input.modelResolution.model,
            1000000,
          ),
          qcs_cap_tokens: 600000,
          evaluated_tokens: 599999,
        },
        600000,
      );

      ctx.input.promptTokenCount = 600000;
      // Stop at the existing hook, proving the threshold fired without a model call.
      ctx.input.config.getHookSystem = vi.fn().mockReturnValue({
        firePreCompactEvent: vi.fn().mockResolvedValue({
          finalOutput: {
            shouldStopExecution: () => true,
            getEffectiveReason: () => 'test stop',
          },
        }),
      });
      expect((await runAutoCompactStage(ctx)).info.compressionStatus).toBe(
        CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED,
      );
      expect(resolve).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'unconfigured model',
      'cmodel',
      { enabled: true, model_threshold_caps: { qfmodel: 600000 } },
    ],
    ['missing config', 'qfmodel', undefined],
    [
      'invalid cap',
      'qfmodel',
      { enabled: true, model_threshold_caps: { qfmodel: 0 } },
    ],
    [
      'disabled config',
      'qfmodel',
      { enabled: false, model_threshold_caps: { qfmodel: 600000 } },
    ],
  ] as const)(
    'uses the original threshold for %s',
    async (_reason, model, value) => {
      vi.mocked(getConfigValue).mockReturnValue(value);
      const ctx = createContext();
      ctx.input.modelResolution = testProviderModelResolution(
        model,
        ctx.input.modelResolution.config,
      );
      ctx.input.modelResolution = {
        ...ctx.input.modelResolution,
        config: {
          ...ctx.input.modelResolution.config,
          context: {
            ...ctx.input.modelResolution.config.context,
            contextWindow: 1000000,
          },
        },
      };
      ctx.input.promptTokenCount = 600000;
      const observe = vi.fn();
      const resolve = vi.fn();
      ctx.input.onAutoCompactPolicyResolved = observe;
      vi.mocked(ctx.input.modelProviderManager.select).mockImplementation(
        resolve,
      );
      const base = getAutoCompactThreshold(
        ctx.input.modelResolution.model,
        1000000,
      );
      expect(base).toBeGreaterThan(600000);
      expect((await runAutoCompactStage(ctx)).info.compressionStatus).toBe(
        CompressionStatus.NOOP,
      );
      expect(observe).toHaveBeenCalledWith(
        {
          model,
          base_threshold_tokens: base,
          qcs_cap_tokens: null,
          evaluated_tokens: 600000,
        },
        base,
      );
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('never raises a smaller original threshold and preserves failure blocking', async () => {
    const ctx = createContext(3, 3);
    ctx.input.modelResolution = testProviderModelResolution(
      'qfmodel',
      ctx.input.modelResolution.config,
    );
    ctx.input.modelResolution = {
      ...ctx.input.modelResolution,
      config: {
        ...ctx.input.modelResolution.config,
        context: {
          ...ctx.input.modelResolution.config.context,
          contextWindow: 200000,
        },
      },
    };
    ctx.input.promptTokenCount = 600000;
    const observe = vi.fn();
    ctx.input.onAutoCompactPolicyResolved = observe;
    const resolve = vi.fn();
    vi.mocked(ctx.input.modelProviderManager.select).mockImplementation(
      resolve,
    );
    const base = getAutoCompactThreshold(
      ctx.input.modelResolution.model,
      200000,
    );
    expect((await runAutoCompactStage(ctx)).info.compressionStatus).toBe(
      CompressionStatus.NOOP,
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        base_threshold_tokens: base,
        qcs_cap_tokens: 600000,
      }),
      base,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['manual', 'reactive', 'auto'] as const)(
    'does not apply the cap or report automatic policy for forced %s',
    async (trigger) => {
      const ctx = createContext();
      ctx.input.modelResolution = testProviderModelResolution(
        'qfmodel',
        ctx.input.modelResolution.config,
      );
      ctx.input.modelResolution = {
        ...ctx.input.modelResolution,
        config: {
          ...ctx.input.modelResolution.config,
          context: {
            ...ctx.input.modelResolution.config.context,
            contextWindow: 1000000,
          },
        },
      };
      ctx.input.trigger = trigger;
      ctx.input.force = true;
      ctx.input.autoCompactTracking.blockedReason = 'quota_exhausted';
      const observe = vi.fn();
      const threshold = vi.fn();
      ctx.input.onAutoCompactPolicyResolved = observe;
      ctx.input.onAutoCompactThresholdResolved = threshold;
      await runAutoCompactStage(ctx);
      expect(threshold).toHaveBeenCalledWith(
        getAutoCompactThreshold(ctx.input.modelResolution.model, 1000000),
      );
      expect(observe).not.toHaveBeenCalled();
    },
  );
});
