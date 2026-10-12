/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefinitionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { loadCliConfig } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import {
  HostedWorkflowTurnError,
  parseHostedWorkflowLaunchBlock,
  runHostedWorkflowTurn,
  workflowLaunchSummaryText,
} from './hosted-workflow-turn.js';
import { HostedModelUnavailableError } from './hosted-agent-definition.js';

// The runner is the ordinary headless engine; the suite pins the turn's
// own behavior — pin re-verification, outcome rendering, failure and abort
// discipline — against an injected run, not a model call.
const start = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/qwen-code-core/agents/runtime/workflow-runner.js', () => ({
  WorkflowRunner: { start },
}));

// The per-turn Config must come up initialized and authenticated before
// the runner spends anything, and shut down on every exit arm — the
// sibling text turn's own lifecycle, pinned here by the doubles the mock
// hands out.
const configDouble = vi.hoisted(() => {
  type State = {
    initialized: boolean;
    refreshed: boolean;
    shut: boolean;
    authType: string | undefined;
    initialize: ReturnType<typeof vi.fn>;
    refreshAuth: ReturnType<typeof vi.fn>;
    shutdownImpl: ReturnType<typeof vi.fn>;
    switchModel: ReturnType<typeof vi.fn>;
  };
  return {
    current: undefined as State | undefined,
    forcedAuthType: undefined as string | undefined,
    models: [] as Array<{
      id: string;
      authType: string;
      isRuntimeModel?: boolean;
      registryBaseUrl?: string;
    }>,
  };
});
vi.mock('../config/config.js', () => ({
  loadCliConfig: vi.fn(async () => {
    const state = {
      initialized: false,
      refreshed: false,
      shut: false,
      authType: (configDouble.forcedAuthType === 'missing'
        ? undefined
        : (configDouble.forcedAuthType ?? 'openai')) as string | undefined,
      initialize: vi.fn(async () => {
        state.initialized = true;
      }),
      refreshAuth: vi.fn(async () => {
        state.refreshed = true;
      }),
      shutdownImpl: vi.fn(async () => {
        state.shut = true;
      }),
      switchModel: vi.fn(async () => undefined),
    };
    configDouble.current = state;
    return {
      initialize: state.initialize,
      refreshAuth: state.refreshAuth,
      shutdown: state.shutdownImpl,
      switchModel: state.switchModel,
      getAllConfiguredModels: () => configDouble.models,
      getModelsConfig: () => ({
        getCurrentAuthType: () => state.authType,
      }),
    };
  }),
}));
vi.mock('../config/settings.js', () => ({
  loadSettings: vi.fn(() => ({ merged: {} })),
}));

const SCRIPT =
  'export const meta = { name: "audit", description: "d" };\nreturn 1;';

function pin(script: string): DefinitionPin {
  return {
    definitionId: 'workflow/audit',
    definitionRevision: 1,
    definitionDigest: createHash('sha256').update(script, 'utf8').digest('hex'),
  };
}

function handleWith(settlement: unknown) {
  return {
    completion: Promise.resolve(settlement),
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  configDouble.current = undefined;
  configDouble.forcedAuthType = undefined;
  configDouble.models = [];
});

describe('parseHostedWorkflowLaunchBlock', () => {
  it('parses a well-formed launch block, args optional', () => {
    const pinValue = pin(SCRIPT);
    expect(
      parseHostedWorkflowLaunchBlock({
        type: 'workflow_launch',
        definition: pinValue,
        script: SCRIPT,
        args: { x: 1 },
      }),
    ).toEqual({ definition: pinValue, script: SCRIPT, args: { x: 1 } });
    expect(
      parseHostedWorkflowLaunchBlock({
        type: 'workflow_launch',
        definition: pinValue,
        script: SCRIPT,
      }),
    ).toEqual({ definition: pinValue, script: SCRIPT, args: undefined });
  });

  it('refuses malformed blocks', () => {
    const pinValue = pin(SCRIPT);
    const refusals: unknown[] = [
      undefined,
      null,
      'x',
      { type: 'text', text: 'x' },
      // A stray key changes the closed set.
      {
        type: 'workflow_launch',
        definition: pinValue,
        script: SCRIPT,
        extra: 1,
      },
      { type: 'workflow_launch', definition: pinValue, script: '' },
      { type: 'workflow_launch', script: SCRIPT },
      {
        type: 'workflow_launch',
        definition: { ...pinValue, definitionDigest: 'not-hex' },
        script: SCRIPT,
      },
      {
        type: 'workflow_launch',
        definition: { ...pinValue, definitionRevision: 0 },
        script: SCRIPT,
      },
      {
        type: 'workflow_launch',
        definition: { ...pinValue, definitionId: '' },
        script: SCRIPT,
      },
      {
        type: 'workflow_launch',
        definition: { definitionDigest: pinValue.definitionDigest },
        script: SCRIPT,
      },
      // R1-11(1): the route delegates the pin to `parseDefinitionPin`,
      // which enforces the id layer's own bounds — a definitionId past
      // 512 UTF-8 bytes and one carrying a control character are both
      // refused, exactly as the envelope decoder beside it refuses them.
      {
        type: 'workflow_launch',
        definition: { ...pinValue, definitionId: 'a'.repeat(513) },
        script: SCRIPT,
      },
      {
        type: 'workflow_launch',
        definition: { ...pinValue, definitionId: 'wf\x00' },
        script: SCRIPT,
      },
    ];
    for (const block of refusals) {
      expect(parseHostedWorkflowLaunchBlock(block)).toBeUndefined();
    }
  });
});

describe('workflowLaunchSummaryText', () => {
  it('names the workflow, revision and short digest on one line', () => {
    const pinned = pin(SCRIPT);
    expect(
      workflowLaunchSummaryText({
        definition: pinned,
        script: SCRIPT,
        args: null,
      }),
    ).toBe(
      `<workflow workflow/audit@1 sha256:${pinned.definitionDigest.slice(0, 16)}>`,
    );
  });
});

describe('runHostedWorkflowTurn', () => {
  const base = {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    cwd: '/tmp/work',
  };

  it('refuses a script whose bytes do not match the pin, spending nothing', async () => {
    const launch = {
      definition: pin('return 2;'),
      script: SCRIPT,
      args: null,
    };
    await expect(
      runHostedWorkflowTurn({
        ...base,
        launch,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(HostedWorkflowTurnError);
    await expect(
      runHostedWorkflowTurn({
        ...base,
        launch,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('does not match its script');
    expect(start).not.toHaveBeenCalled();
    // R1-14: the refusal answers from the pin itself — it never reaches
    // the per-turn config bring-up, so the model corrections cost no spend.
    expect(vi.mocked(loadCliConfig)).not.toHaveBeenCalled();
    expect(vi.mocked(loadSettings)).not.toHaveBeenCalled();
  });

  it('renders a completed run as the turn content, bounded and readable', async () => {
    start.mockResolvedValue(
      handleWith({
        ok: true,
        outcome: {
          runId: 'wf_0123456789abcdef',
          result: { answer: 2 },
          phases: ['collect', 'review'],
          logs: ['collected 3 files'],
          meta: { name: 'audit', description: 'd' },
        },
      }),
    );
    const launch = { definition: pin(SCRIPT), script: SCRIPT, args: { x: 1 } };
    const signal = new AbortController().signal;
    const result = await runHostedWorkflowTurn({
      ...base,
      launch,
      signal,
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        script: SCRIPT,
        args: { x: 1 },
        signal,
        // The runtime second line under the admission gate: a nested
        // scriptPath reference throws instead of resolving.
        restrictNestedScriptPaths: true,
        config: expect.objectContaining({
          initialize: expect.any(Function),
          refreshAuth: expect.any(Function),
          shutdown: expect.any(Function),
        }),
      }),
    );
    // The sibling text turn's lifecycle: the config comes up before the
    // runner spends, and shuts down with the turn.
    expect(configDouble.current?.initialize).toHaveBeenCalledTimes(1);
    expect(configDouble.current?.refreshAuth).toHaveBeenCalledTimes(1);
    expect(configDouble.current?.shutdownImpl).toHaveBeenCalledTimes(1);
    // R1-14: the ordering is load-bearing, pinned by invocation order —
    // initialize() then refreshAuth() and only then any runner spend.
    const initOrder =
      configDouble.current!.initialize.mock.invocationCallOrder[0]!;
    const authOrder =
      configDouble.current!.refreshAuth.mock.invocationCallOrder[0]!;
    const runOrder = start.mock.invocationCallOrder[0]!;
    expect(initOrder).toBeLessThan(authOrder);
    expect(authOrder).toBeLessThan(runOrder);
    // R1-14: the per-turn config posture itself: safe-mode argv, a
    // throw-on-conflict ninth argument, never a host policy refit; and the
    // settings load is pinned untrusted.
    const loadCalls = vi.mocked(loadCliConfig).mock.calls;
    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0]).toHaveLength(9);
    expect((loadCalls[0]![1] as { safeMode?: boolean }).safeMode).toBe(true);
    // #13858: the agents' chats open without this Harness's cwd listing.
    expect(
      (loadCalls[0]![0] as { model?: { skipStartupContext?: boolean } }).model
        ?.skipStartupContext,
    ).toBe(true);
    expect(loadCalls[0]![8]).toBe(true);
    expect(loadCalls[0]![9]).toBeUndefined();
    expect(vi.mocked(loadSettings).mock.calls[0]![1]).toMatchObject({
      workspaceTrusted: false,
    });
    expect(result.model).toBe('workflow');
    expect(result.text).toContain(
      'Workflow run wf_0123456789abcdef completed.',
    );
    expect(result.text).toContain('{"answer":2}');
    expect(result.text).toContain('- collect');
    expect(result.text).toContain('collected 3 files');
    expect(result.parts).toEqual([{ text: result.text }]);
  });

  it('bounds an oversized outcome under the turn content limit', async () => {
    start.mockResolvedValue(
      handleWith({
        ok: true,
        outcome: {
          runId: 'wf_0123456789abcdef',
          result: 'r'.repeat(128 * 1024),
          phases: [],
          logs: [],
          meta: null,
        },
      }),
    );
    const result = await runHostedWorkflowTurn({
      ...base,
      launch: { definition: pin(SCRIPT), script: SCRIPT, args: null },
      signal: new AbortController().signal,
    });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(result.text).toContain(
      `truncated: the outcome exceeded ${32 * 1024} bytes; have the script return a smaller result`,
    );
    // R1-32: never a pointer to a snapshot this Session cannot read.
    expect(result.text).not.toContain('snapshot');
    // The cut keeps the outcome's body: a bounded() that discarded it
    // would match the length bound too.
    expect(result.text).toContain(
      'Workflow run wf_0123456789abcdef completed.',
    );
    expect(result.text.length).toBeGreaterThan(1024);
  });

  it('truncates an astral outcome at a code point boundary', async () => {
    start.mockResolvedValue(
      handleWith({
        ok: true,
        outcome: {
          runId: 'wf_0123456789abcdef',
          result: '🙂'.repeat(40_000),
          phases: [],
          logs: [],
          meta: null,
        },
      }),
    );
    const result = await runHostedWorkflowTurn({
      ...base,
      launch: { definition: pin(SCRIPT), script: SCRIPT, args: null },
      signal: new AbortController().signal,
    });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      32 * 1024,
    );
    // The walk-back ends at a code point boundary: no replacement
    // character and no lone surrogate survives a sloppy cut.
    expect(result.text).not.toContain('�');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.text)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.text)).toBe(false);
  });

  it('keeps the settled outcome when the config cleanup throws', async () => {
    let settle!: (value: unknown) => void;
    const completion = new Promise((resolve) => {
      settle = resolve;
    });
    start.mockResolvedValue(handleWith(completion));
    const running = runHostedWorkflowTurn({
      ...base,
      launch: { definition: pin(SCRIPT), script: SCRIPT, args: null },
      signal: new AbortController().signal,
    });
    // The double exists as soon as the config comes up — before the
    // settled outcome reaches the finally arm of the turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    configDouble.current!.shutdownImpl.mockRejectedValueOnce(
      new Error('cleanup went wrong'),
    );
    settle({
      ok: true,
      outcome: {
        runId: 'wf_0123456789abcdef',
        result: { answer: 2 },
        phases: [],
        logs: [],
        meta: null,
      },
    });
    const result = await running;
    expect(result.text).toContain(
      'Workflow run wf_0123456789abcdef completed.',
    );
    expect(configDouble.current!.shutdownImpl).toHaveBeenCalledTimes(1);
  });

  it('throws a failed settlement toward the turn classifications', async () => {
    start.mockResolvedValue(
      handleWith({ ok: false, message: 'script threw: boom' }),
    );
    await expect(
      runHostedWorkflowTurn({
        ...base,
        launch: { definition: pin(SCRIPT), script: SCRIPT, args: null },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Workflow run failed: script threw: boom');
    expect(configDouble.current?.shutdownImpl).toHaveBeenCalledTimes(1);
  });

  it('names its failure evidence, details and its disconnection cap', async () => {
    start.mockResolvedValue(
      handleWith({
        ok: false,
        message: 'script threw',
        details: { code: 'boom' },
      }),
    );
    await expect(
      runHostedWorkflowTurn({
        ...base,
        launch: { definition: pin(SCRIPT), script: SCRIPT, args: null },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('{"code":"boom"}');
    const huge = 'x'.repeat(4096);
    start.mockResolvedValue(
      handleWith({ ok: false, message: 'script threw', details: huge }),
    );
    try {
      await runHostedWorkflowTurn({
        ...base,
        launch: { definition: pin(SCRIPT), script: SCRIPT, args: null },
        signal: new AbortController().signal,
      });
      expect.unreachable('must throw');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      expect(message).toContain('Workflow run failed: script threw');
      expect(message.length).toBeLessThanOrEqual(
        'Workflow run failed: script threw ("")'.length + 2048 + 100,
      );
    }
  });

  it('refuses to start without model authentication and still cleans up', async () => {
    configDouble.forcedAuthType = 'missing';
    const launch = { definition: pin(SCRIPT), script: SCRIPT, args: null };
    await expect(
      runHostedWorkflowTurn({
        ...base,
        launch,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Hosted Harness model authentication is unavailable.');
    expect(start).not.toHaveBeenCalled();
    expect(configDouble.current?.shutdownImpl).toHaveBeenCalledTimes(1);
  });

  // #13858 R3-4: the workflow lane runs every agent() dispatch on the
  // Session's pinned model, exactly as the sibling text Turn does.
  it("switches to the Session's pinned model before the run starts", async () => {
    configDouble.models = [
      { id: 'pinned', authType: 'openai', registryBaseUrl: 'https://m' },
      { id: 'pinned', authType: 'openai', isRuntimeModel: true },
    ];
    start.mockResolvedValue(
      handleWith({
        ok: true,
        outcome: { runId: 'r', result: 1, phases: [], logs: [] },
      }),
    );
    const launch = { definition: pin(SCRIPT), script: SCRIPT, args: null };
    await runHostedWorkflowTurn({
      ...base,
      launch,
      signal: new AbortController().signal,
      agentDefinition: { model: { id: 'pinned' } } as never,
    });
    expect(configDouble.current?.switchModel).toHaveBeenCalledWith(
      'openai',
      'pinned',
      { requireCachedCredentials: true, baseUrl: 'https://m' },
    );
    expect(
      configDouble.current!.switchModel.mock.invocationCallOrder[0],
    ).toBeLessThan(start.mock.invocationCallOrder[0]!);
  });

  it('fails the Turn on a pin that does not resolve instead of falling back', async () => {
    configDouble.models = [{ id: 'other', authType: 'openai' }];
    const launch = { definition: pin(SCRIPT), script: SCRIPT, args: null };
    await expect(
      runHostedWorkflowTurn({
        ...base,
        launch,
        signal: new AbortController().signal,
        agentDefinition: { model: { id: 'pinned' } } as never,
      }),
    ).rejects.toThrow(HostedModelUnavailableError);
    expect(start).not.toHaveBeenCalled();
    expect(configDouble.current?.switchModel).not.toHaveBeenCalled();
    expect(configDouble.current?.shutdownImpl).toHaveBeenCalledTimes(1);
  });

  it('wires the turn abort signal to the runner abort', async () => {
    const handle = handleWith(
      new Promise(() => {
        // never settles
      }),
    );
    start.mockResolvedValue(handle);
    const controller = new AbortController();
    const running = runHostedWorkflowTurn({
      ...base,
      launch: { definition: pin(SCRIPT), script: SCRIPT, args: null },
      signal: controller.signal,
    });
    // Let the executor reach the listener registration past its two
    // async boundaries (config load, runner start).
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(handle.abort).toHaveBeenCalledTimes(1);
    // Keep the unbounded completion promise from failing the process; the
    // turn's own wait is the caller's to classify.
    await Promise.race([
      running.catch(() => 'settled-by-abort'),
      new Promise((resolve) => setTimeout(resolve, 10)),
    ]);
  });
});
