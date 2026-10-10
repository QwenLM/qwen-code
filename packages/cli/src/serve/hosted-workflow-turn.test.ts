/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefinitionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  HostedWorkflowTurnError,
  parseHostedWorkflowLaunchBlock,
  runHostedWorkflowTurn,
  workflowLaunchSummaryText,
} from './hosted-workflow-turn.js';

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
  };
  return {
    current: undefined as State | undefined,
    forcedAuthType: undefined as string | undefined,
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
    };
    configDouble.current = state;
    return {
      initialize: state.initialize,
      refreshAuth: state.refreshAuth,
      shutdown: state.shutdownImpl,
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
    expect(result.text).toContain('truncated: the full outcome');
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
