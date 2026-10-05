/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { Config as ConfigImpl, ApprovalMode } from '../config/config.js';
import { AgentHeadless } from './runtime/agent-headless.js';
import {
  AgentEventType,
  type AgentEventEmitter,
} from './runtime/agent-events.js';
import { AgentTerminateMode } from './runtime/agent-types.js';
import type { ModelConfig, PromptConfig } from './runtime/agent-types.js';
import { runForkedAgent, type AgentPathParams } from './forkedAgent.js';
import { ToolNames } from '../tools/tool-names.js';
import { EditTool } from '../tools/edit.js';
import {
  hasRebuiltToolRegistry,
  TOOL_REGISTRY_REBUILT,
} from '../tools/agent/agent.js';
import { AuthType } from '../core/contentGenerator.js';
import type { RuntimeContentGeneratorView } from './runtime/agent-context.js';
import { createRuntimeContentGeneratorView } from '../models/content-generator-config.js';

vi.mock('../models/content-generator-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../models/content-generator-config.js')
    >();
  return {
    ...actual,
    createRuntimeContentGeneratorView: vi.fn(),
  };
});

/**
 * `runForkedAgent` defers its early-completion abort to a macrotask so the
 * batch that triggered it finishes emitting first. A probe that reads
 * `signal.aborted` in the statement after an emit therefore reports `false`
 * for every run, aborting or not — it has to yield to the same queue first.
 */
function flushDeferredAbort(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function makeRuntimeView(model: string): RuntimeContentGeneratorView {
  return {
    contentGenerator: {} as RuntimeContentGeneratorView['contentGenerator'],
    contentGeneratorConfig: {
      model,
      authType: AuthType.USE_OPENAI,
    },
  };
}

const PROJECT_MD = '/repo/.qwen/memories/project.md';

/**
 * Regression: `runForkedAgent` (AgentHeadless path) used to produce its
 * YOLO wrapper via `Object.create(parent) + getApprovalMode = YOLO`,
 * which left the parent's already-bound `EditTool` / `WriteFileTool` /
 * `ReadFileTool` reachable through the wrapper's prototype chain. Bound
 * tools then read `this.config.getApprovalMode()` from the parent
 * (silently ignoring the YOLO override) and `this.config.getFileReadCache()`
 * from the parent's cache.
 *
 * The fix: route through `createApprovalModeOverride`, which rebuilds
 * the tool registry on the wrapper so bound tools resolve `this.config`
 * to the wrapper.
 */
describe('runForkedAgent (AgentHeadless path) bound-tool isolation', () => {
  beforeEach(() => {
    vi.mocked(createRuntimeContentGeneratorView).mockReset();
  });

  // Bare mode keeps the registry small (ReadFile / Edit / Shell only) so
  // the rebuild covers the file tools we actually care about.
  const baseParams = {
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
    usageStatisticsEnabled: false,
    bareMode: true,
  };

  /** A bare-mode parent Config with its own tool registry installed. */
  async function makeParent(overrides: Partial<typeof baseParams> = {}) {
    const parent = new ConfigImpl({ ...baseParams, ...overrides });
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;
    return { parent, parentRegistry };
  }

  const forkParams = (
    config: Config,
    extra: Partial<AgentPathParams> = {},
  ): AgentPathParams => ({
    name: 'test-fork',
    systemPrompt: 'You are a test fork.',
    taskPrompt: 'do the task',
    config,
    ...extra,
  });

  /** runForkedAgent(forkParams(...)); `restore` runs once it settles. */
  async function fork(
    restore: () => void,
    config: Config,
    extra: Partial<AgentPathParams> = {},
  ) {
    try {
      return await runForkedAgent(forkParams(config, extra));
    } finally {
      restore();
    }
  }

  /** A stand-in AgentHeadless with a fixed terminate mode and final text. */
  const fakeHeadless = (
    terminateMode: AgentTerminateMode,
    finalText: string,
    execute = vi.fn().mockResolvedValue(undefined),
  ) =>
    ({
      execute,
      getTerminateMode: vi.fn().mockReturnValue(terminateMode),
      getFinalText: vi.fn().mockReturnValue(finalText),
    }) as unknown as AgentHeadless;

  /** Stubs AgentHeadless.create to resolve `headless`; returns the restore. */
  function stubCreate(headless: AgentHeadless) {
    const spy = vi
      .spyOn(AgentHeadless, 'create')
      .mockImplementation(async () => headless);
    return () => spy.mockRestore();
  }

  // Spy on AgentHeadless.create at the source module rather than mocking
  // the re-export layer in `agents/index.js` — vitest's module-mock layer
  // doesn't reliably forward `export *` re-exports through `...actual`,
  // and stubbing the full surface manually is brittle.
  function captureAgentHeadlessConfig() {
    const captured: {
      config?: Config;
      promptConfig?: PromptConfig;
      modelConfig?: ModelConfig;
      runtimeView?: RuntimeContentGeneratorView;
    } = {};
    const spy = vi
      .spyOn(AgentHeadless, 'create')
      .mockImplementation(
        async (
          _name,
          config,
          promptConfig,
          modelConfig,
          _runConfig,
          _toolConfig,
          _eventEmitter,
          _hooks,
          runtimeView,
        ) => {
          Object.assign(captured, {
            config,
            promptConfig,
            modelConfig,
            runtimeView,
          });
          return fakeHeadless(AgentTerminateMode.GOAL, 'done');
        },
      );
    return { captured, restore: () => spy.mockRestore() };
  }

  /**
   * Stubs AgentHeadless.create with a headless whose execute runs `body`
   * against the fork's event emitter and abort signal; returns the restore.
   */
  function stubExecute(
    body: (emitter: AgentEventEmitter, signal: AbortSignal) => Promise<void>,
    terminateMode = AgentTerminateMode.CANCELLED,
    finalText = '',
  ) {
    const spy = vi
      .spyOn(AgentHeadless, 'create')
      .mockImplementation(async (_n, _c, _p, _m, _r, _t, eventEmitter) =>
        fakeHeadless(
          terminateMode,
          finalText,
          vi
            .fn()
            .mockImplementation((_context, signal) =>
              body(eventEmitter as AgentEventEmitter, signal),
            ),
        ),
      );
    return () => spy.mockRestore();
  }

  // `kind` picks the tool name and doubles as the call's description.
  const TOOL = {
    read: ToolNames.READ_FILE,
    write: ToolNames.WRITE_FILE,
    edit: ToolNames.EDIT,
  };
  type Kind = keyof typeof TOOL;
  function toolCall(
    emitter: AgentEventEmitter,
    callId: string,
    kind: Kind,
    file_path: string,
    round = 1,
  ) {
    emitter.emit(AgentEventType.TOOL_CALL, {
      subagentId: 'fork',
      round,
      callId,
      name: TOOL[kind],
      args: { file_path },
      description: kind,
      timestamp: Date.now(),
    });
  }
  function toolResult(
    emitter: AgentEventEmitter,
    callId: string,
    kind: Kind,
    success: boolean,
    round = 1,
  ) {
    emitter.emit(AgentEventType.TOOL_RESULT, {
      subagentId: 'fork',
      round,
      callId,
      name: TOOL[kind],
      success,
      timestamp: Date.now(),
    });
  }
  /** A TOOL_CALL immediately followed by its TOOL_RESULT. */
  function tool(
    emitter: AgentEventEmitter,
    callId: string,
    kind: Kind,
    file_path: string,
    success = true,
    round = 1,
  ) {
    toolCall(emitter, callId, kind, file_path, round);
    toolResult(emitter, callId, kind, success, round);
  }

  /** Makes every registry `parent` creates use `stopSpy` as its stop(). */
  function spyOnRegistryStop(parent: Config) {
    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const originalCreate = parent.createToolRegistry.bind(parent);
    vi.spyOn(parent, 'createToolRegistry').mockImplementation(async (...args) =>
      Object.assign(await originalCreate(...args), { stop: stopSpy }),
    );
    return stopSpy;
  }

  it('rejects a tool-capable fork when the operator requires container execution', async () => {
    const parent = new ConfigImpl({
      ...baseParams,
      agentExecutionBackend: 'container',
    });
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    const registrySpy = vi
      .spyOn(parent, 'getToolRegistry')
      .mockReturnValue(parentRegistry);
    const executeSpy = vi.spyOn(AgentHeadless.prototype, 'execute');

    try {
      await expect(runForkedAgent(forkParams(parent))).rejects.toThrow(
        'has no execution environment',
      );
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      executeSpy.mockRestore();
      registrySpy.mockRestore();
      await parentRegistry.stop();
    }
  });

  it('does not treat empty extraHistory as caller-owned initial messages by default', async () => {
    const { parent } = await makeParent();
    const { captured, restore } = captureAgentHeadlessConfig();
    await fork(restore, parent, { extraHistory: [] });

    expect(captured.promptConfig?.initialMessages).toBeUndefined();
  });

  it('can preserve empty extraHistory when the caller intentionally owns history', async () => {
    const { parent } = await makeParent();
    const { captured, restore } = captureAgentHeadlessConfig();
    await fork(restore, parent, {
      extraHistory: [],
      preserveEmptyExtraHistory: true,
    });

    expect(captured.promptConfig?.initialMessages).toEqual([]);
  });

  it('passes a Config with the rebuilt-registry marker and YOLO approval mode to AgentHeadless.create', async () => {
    const { parent, parentRegistry } = await makeParent();
    const { captured, restore } = captureAgentHeadlessConfig();
    const result = await fork(restore, parent);
    expect(result.status).toBe('completed');

    expect(captured.config).toBeDefined();
    // The wrapper passed to AgentHeadless must:
    // 1. Have its own rebuilt registry (Symbol marker propagation)
    expect(hasRebuiltToolRegistry(captured.config!)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((captured.config as any)[TOOL_REGISTRY_REBUILT]).toBe(true);
    // 2. Resolve approval mode to YOLO (the override)
    expect(captured.config!.getApprovalMode()).toBe(ApprovalMode.YOLO);
    // 3. Hand out a different ToolRegistry instance from the parent
    expect(captured.config!.getToolRegistry()).not.toBe(parentRegistry);
  });

  it('strips internal tags from completed finalText', async () => {
    const { parent } = await makeParent();
    const tagged = '<analysis>scratch</analysis><summary>done</summary>';
    const restore = stubCreate(fakeHeadless(AgentTerminateMode.GOAL, tagged));
    const result = await fork(restore, parent);

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('done');
  });

  it.each([AgentTerminateMode.MAX_TURNS, AgentTerminateMode.LOOP_DETECTED])(
    'reports %s as failed',
    async (terminateMode) => {
      const { parent } = await makeParent();
      const restore = stubCreate(fakeHeadless(terminateMode, 'stopped'));
      const result = await fork(restore, parent);

      expect(result.status).toBe('failed');
      expect(result.terminateReason).toBe(terminateMode);
    },
  );

  it('reports filesWritten from successful mutating tool results only', async () => {
    const { parent } = await makeParent();
    const restore = stubExecute(
      async (emitter) => {
        tool(emitter, 'read-1', 'read', '/repo/README.md');
        tool(emitter, 'write-1', 'write', PROJECT_MD);
        tool(emitter, 'edit-1', 'edit', '/repo/outside.md', false);
      },
      AgentTerminateMode.GOAL,
      'done',
    );
    const result = await fork(restore, parent);

    expect(result.filesTouched).toEqual([
      '/repo/README.md',
      PROJECT_MD,
      '/repo/outside.md',
    ]);
    expect(result.filesWritten).toEqual([PROJECT_MD]);
  });

  it('counts a successful edit as a write and completes early on it', async () => {
    const { parent } = await makeParent();
    let executeSignal: AbortSignal | undefined;
    let abortedAfterEdit: boolean | undefined;
    const restore = stubExecute(async (emitter, signal) => {
      executeSignal = signal;
      tool(emitter, 'edit-1', 'edit', PROJECT_MD);
      await flushDeferredAbort();
      abortedAfterEdit = signal.aborted;
    });
    const result = await fork(restore, parent, {
      taskPrompt: 'amend one file',
      completeAfterFirstSuccessfulWrite: true,
    });

    // Every other test in this file drives the write path with
    // `write_file`, and the one edit it emits fails — so `edit` counting as
    // a mutating tool was asserted nowhere on its success side. A remember
    // agent amending an existing entry takes exactly this path.
    expect(abortedAfterEdit).toBe(true);
    expect(executeSignal?.aborted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
    expect(result.filesWritten).toEqual([PROJECT_MD]);
  });

  it('completes after the first successful write without waiting for another model turn', async () => {
    const { parent } = await makeParent();
    let executeSignal: AbortSignal | undefined;
    const restore = stubExecute(async (emitter, signal) => {
      executeSignal = signal;
      tool(emitter, 'write-1', 'write', PROJECT_MD);
    });
    const result = await fork(restore, parent, {
      taskPrompt: 'write one file',
      completeAfterFirstSuccessfulWrite: true,
    });

    expect(executeSignal?.aborted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
    expect(result.finalText).toBeUndefined();
    expect(result.filesWritten).toEqual([PROJECT_MD]);
  });

  it('defers the early-completion abort until the current batch finishes emitting', async () => {
    // agent-core emits a parallel batch's TOOL_RESULT events one by one,
    // synchronously. Aborting synchronously from inside the first result's
    // handler re-enters agent-core's onAbort mid-emission, which replaces
    // the still-unemitted real successes of the same batch with synthetic
    // cancellation failures — so filesWritten under-reports writes that
    // actually landed on disk. The abort must be deferred out of the
    // emitter handler; the rest of the batch still has to emit real
    // results.
    const { parent } = await makeParent();
    let executeSignal: AbortSignal | undefined;
    let abortedMidBatch: boolean | undefined;
    const restore = stubExecute(async (emitter, signal) => {
      executeSignal = signal;
      toolCall(emitter, 'write-a', 'write', '/repo/.qwen/memories/a.md');
      toolCall(emitter, 'write-b', 'write', '/repo/.qwen/memories/b.md');
      toolResult(emitter, 'write-a', 'write', true);
      abortedMidBatch = signal.aborted;
      toolResult(emitter, 'write-b', 'write', true);
      await new Promise((resolve) => setImmediate(resolve));
    });
    const result = await fork(restore, parent, {
      taskPrompt: 'write two files',
      completeAfterFirstSuccessfulWrite: true,
    });

    // Mid-batch the run must not be aborted synchronously, and the
    // deferred abort must land once the batch emission is over.
    expect(abortedMidBatch).toBe(false);
    expect(executeSignal?.aborted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
    expect(result.filesWritten).toEqual([
      '/repo/.qwen/memories/a.md',
      '/repo/.qwen/memories/b.md',
    ]);
  });

  it('resolves completed when the deferred self-abort lands inside the next model round', async () => {
    // The deferred early-completion abort lands after the reasoning loop's
    // post-batch abort check, inside the next model round, so the in-flight
    // stream rejects with an AbortError. The goal write is already on disk
    // at that point — the run must report the completion instead of
    // surfacing the self-triggered abort as a failure.
    const { parent } = await makeParent();
    let executeSignal: AbortSignal | undefined;
    const restore = stubExecute(async (emitter, signal) => {
      executeSignal = signal;
      tool(emitter, 'write-1', 'write', PROJECT_MD);
      // Yield a macrotask so the queued self-abort fires first,
      // then fail the way a model stream aborted mid-flight does.
      await new Promise((resolve) => setImmediate(resolve));
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const result = await fork(restore, parent, {
      taskPrompt: 'write one file',
      completeAfterFirstSuccessfulWrite: true,
    });

    expect(executeSignal?.aborted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
    expect(result.finalText).toBeUndefined();
    expect(result.filesWritten).toEqual([PROJECT_MD]);
  });

  it('still rejects when an external abort beats the deferred self-abort', async () => {
    // An external cancel that fires while the self-abort is queued must
    // keep rejecting the run: only the run's own early-completion abort
    // is converted into a completion.
    const { parent } = await makeParent();
    const external = new AbortController();
    const restore = stubExecute(async (emitter) => {
      tool(emitter, 'write-1', 'write', PROJECT_MD);
      // The external cancel wins the race against the queued
      // self-abort.
      external.abort();
      await new Promise((resolve) => setImmediate(resolve));
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    await expect(
      fork(restore, parent, {
        taskPrompt: 'write one file',
        completeAfterFirstSuccessfulWrite: true,
        abortSignal: external.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports an external abort that resolves after the write as cancelled', async () => {
    // Twin of the reject case above. When the external cancel lands on a
    // batch boundary, agent-core RESOLVES cancelled instead of throwing, so
    // the catch never runs — the latched early completion then reported the
    // cancelled run as a successful GOAL. Same user action, opposite outcome
    // depending only on which event-loop boundary the cancel hit.
    const { parent } = await makeParent();
    const external = new AbortController();
    const restore = stubExecute(async (emitter) => {
      tool(emitter, 'write-1', 'write', PROJECT_MD);
      // The external cancel wins the race, and the run then settles
      // by RESOLVING on the batch boundary rather than throwing.
      external.abort();
      await new Promise((resolve) => setImmediate(resolve));
    });
    const result = await fork(restore, parent, {
      taskPrompt: 'write one file',
      completeAfterFirstSuccessfulWrite: true,
      abortSignal: external.signal,
    });

    expect(result.status).not.toBe('completed');
    expect(result).toMatchObject({
      status: 'cancelled',
      terminateReason: AgentTerminateMode.CANCELLED,
    });
  });

  it('keeps running past successful writes the early-completion predicate excludes', async () => {
    const { parent } = await makeParent();
    let executeSignal: AbortSignal | undefined;
    let abortedAfterIndexWrite: boolean | undefined;
    let abortedAfterEntryWrite: boolean | undefined;
    const restore = stubExecute(async (emitter, signal) => {
      executeSignal = signal;
      tool(emitter, 'write-index', 'write', '/repo/.qwen/memories/MEMORY.md');
      // The early-completion abort is deferred to a macrotask
      // (`setImmediate` in forkedAgent.ts), so a synchronous read here
      // is `false` no matter what the predicate decided. Flush first,
      // and the reading becomes a statement about the predicate.
      await flushDeferredAbort();
      abortedAfterIndexWrite = signal.aborted;
      tool(emitter, 'write-entry', 'write', PROJECT_MD);
      await flushDeferredAbort();
      abortedAfterEntryWrite = signal.aborted;
    });
    const result = await fork(restore, parent, {
      taskPrompt: 'write one file',
      completeAfterFirstSuccessfulWrite: (filePath) =>
        !filePath.endsWith('MEMORY.md'),
    });

    // The excluded MEMORY.md write must not abort the run; the entry
    // write that follows must.
    //
    // Both probes are read after the deferred abort has had a macrotask
    // to land. The `true` reading is what makes the `false` one mean
    // anything: it proves the flush is long enough to observe an abort
    // that did fire, so `false` after the excluded write is the predicate
    // holding the run open rather than the probe reading too early.
    expect(abortedAfterEntryWrite).toBe(true);
    expect(abortedAfterIndexWrite).toBe(false);
    expect(executeSignal?.aborted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
    expect(result.filesWritten).toEqual([
      '/repo/.qwen/memories/MEMORY.md',
      PROJECT_MD,
    ]);
  });

  it('keeps running past a failed write when completing after the first successful write', async () => {
    const { parent } = await makeParent();
    let executeSignal: AbortSignal | undefined;
    let abortedAfterFailedWrite: boolean | undefined;
    let abortedAfterRetryWrite: boolean | undefined;
    const restore = stubExecute(async (emitter, signal) => {
      executeSignal = signal;
      tool(emitter, 'write-failed', 'write', PROJECT_MD, false);
      // Same deferral as the twin above — read after the flush, or
      // the probe reports `false` for a run that did abort.
      await flushDeferredAbort();
      abortedAfterFailedWrite = signal.aborted;
      tool(emitter, 'write-retry', 'write', PROJECT_MD, true, 2);
      await flushDeferredAbort();
      abortedAfterRetryWrite = signal.aborted;
    });
    const result = await fork(restore, parent, {
      taskPrompt: 'write one file',
      completeAfterFirstSuccessfulWrite: true,
    });

    // The failed write must not trigger early completion; the retry's
    // successful write must. Same pairing as the twin above: without the
    // `true` reading taken after the same flush, `false` here is satisfied
    // by a probe that simply ran before the deferred abort landed.
    expect(abortedAfterRetryWrite).toBe(true);
    expect(abortedAfterFailedWrite).toBe(false);
    expect(executeSignal?.aborted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
    expect(result.filesWritten).toEqual([PROJECT_MD]);
  });

  it('keeps cancellation as cancellation when no write succeeded', async () => {
    const { parent } = await makeParent();
    const restore = stubCreate(fakeHeadless(AgentTerminateMode.CANCELLED, ''));
    const result = await fork(restore, parent, {
      taskPrompt: 'write one file',
      completeAfterFirstSuccessfulWrite: true,
    });

    expect(result.status).toBe('cancelled');
    expect(result.filesWritten).toEqual([]);
  });

  it('binds EditTool from the wrapper registry to the wrapper Config (not the parent)', async () => {
    const { parent } = await makeParent();
    const { captured, restore } = captureAgentHeadlessConfig();
    await fork(restore, parent);

    expect(captured.config).toBeDefined();
    const wrapperRegistry = captured.config!.getToolRegistry();
    const editTool = await wrapperRegistry.ensureTool(ToolNames.EDIT);
    expect(editTool).toBeInstanceOf(EditTool);
    const boundConfig = (editTool as unknown as { config: Config }).config;
    expect(boundConfig).toBe(captured.config);
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.YOLO);
    expect(boundConfig.getFileReadCache()).toBe(
      captured.config!.getFileReadCache(),
    );
    expect(boundConfig.getFileReadCache()).not.toBe(parent.getFileReadCache());
  });

  it('preserves an upstream getPermissionManager override (memory-scoped composition)', async () => {
    // The memory extraction / dream agent path stacks two wrappers:
    //   parent
    //     └── scopedConfig (Object.create + getPermissionManager override)
    //           └── yoloConfig (createApprovalModeOverride, sets registry + marker)
    // Bound tools must see:
    //   - approval mode = YOLO (from yoloConfig's own override)
    //   - permission manager = scopedPm (walks proto past yoloConfig to scopedConfig)
    const { parent } = await makeParent();

    // Production memory-scoped overrides implement the full registration
    // surface (MemoryScopedPermissionManager in memory-scoped-agent-config.ts
    // picks getToolRegistrationStatus): createToolRegistry's registerLazy
    // resolves the PM through getPermissionManager() and consults it at
    // registration time (#10075), so the stub must answer that call or the
    // bare-mode factories are skipped and ensureTool resolves undefined.
    const scopedPm = {
      id: 'scoped-pm-marker',
      getToolRegistrationStatus: async () => 'registered' as const,
    } as never;
    const scopedConfig = Object.create(parent) as Config;
    scopedConfig.getPermissionManager = () => scopedPm;

    const { captured, restore } = captureAgentHeadlessConfig();
    await fork(restore, scopedConfig);

    expect(captured.config).toBeDefined();
    const editTool = await captured
      .config!.getToolRegistry()
      .ensureTool(ToolNames.EDIT);
    expect(editTool).toBeInstanceOf(EditTool);
    const boundConfig = (editTool as unknown as { config: Config }).config;
    // YOLO from yoloConfig's own override
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.YOLO);
    // Scoped PM from scopedConfig (one prototype level up)
    expect(boundConfig.getPermissionManager?.()).toBe(scopedPm);
  });

  it('stops the per-fork ToolRegistry after the AgentHeadless body finishes', async () => {
    const { parent } = await makeParent();
    // Every registry parent.createToolRegistry returns to
    // `createApprovalModeOverride` carries the stop spy; the wrapper's own
    // getToolRegistry is then assigned this same instance.
    const stopSpy = spyOnRegistryStop(parent);
    const { restore } = captureAgentHeadlessConfig();
    await fork(restore, parent);

    // stop() is fire-and-forget inside the runForkedAgent finally —
    // it is awaited by the runtime via the resolved promise chain, so
    // by the time `await runForkedAgent` returns the stop call has
    // already started; flush microtasks for the catch handler.
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('stops the per-fork ToolRegistry even when AgentHeadless.create rejects', async () => {
    // Failure-path regression: a future refactor could accidentally
    // move the stop() out of the `finally` and onto the success path
    // while every other test still passes. This test pins that the
    // cleanup runs when `AgentHeadless.create` rejects before any
    // body executes.
    const { parent } = await makeParent();
    const stopSpy = spyOnRegistryStop(parent);
    const createSpy = vi
      .spyOn(AgentHeadless, 'create')
      .mockRejectedValue(new Error('agent-headless-create-blew-up'));

    await expect(fork(() => createSpy.mockRestore(), parent)).rejects.toThrow(
      'agent-headless-create-blew-up',
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('stops the per-fork ToolRegistry even when headless.execute rejects', async () => {
    // Same shape as the create-rejects test, but for the execute
    // failure path. Together they pin the lifecycle stop to the
    // `finally` block rather than any specific success branch.
    const { parent } = await makeParent();
    const stopSpy = spyOnRegistryStop(parent);
    const restore = stubCreate(
      fakeHeadless(
        AgentTerminateMode.GOAL,
        '',
        vi.fn().mockRejectedValue(new Error('headless-execute-blew-up')),
      ),
    );

    await expect(fork(restore, parent)).rejects.toThrow(
      'headless-execute-blew-up',
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('forwards FINISH token totals into the forked-agent result', async () => {
    const parent = new ConfigImpl(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    vi.spyOn(parent, 'getToolRegistry').mockReturnValue(parentRegistry);
    const createSpy = vi.spyOn(AgentHeadless, 'create').mockImplementation(
      async (
        _name,
        _config,
        _promptConfig,
        _modelConfig,
        _runConfig,
        _toolConfig,
        emitter?: AgentEventEmitter,
      ): Promise<AgentHeadless> =>
        ({
          execute: vi.fn().mockImplementation(async () => {
            emitter!.emit(AgentEventType.FINISH, {
              subagentId: 'test-fork',
              terminateReason: AgentTerminateMode.GOAL,
              timestamp: Date.now(),
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
            });
          }),
          getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
          getFinalText: vi.fn().mockReturnValue('done'),
        }) as unknown as AgentHeadless,
    );

    try {
      await expect(
        runForkedAgent({
          name: 'test-fork',
          systemPrompt: 'You are a test fork.',
          taskPrompt: 'do the task',
          config: parent,
        }),
      ).resolves.toMatchObject({
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      });
    } finally {
      createSpy.mockRestore();
    }
  });

  it('uses a runtime content-generator view for cross-auth fast models', async () => {
    const fastModel = 'deepseek-v4-flash';
    const runtimeView = makeRuntimeView(fastModel);
    vi.mocked(createRuntimeContentGeneratorView).mockResolvedValue(runtimeView);

    const { parent } = await makeParent({ model: 'claude-main' });
    vi.spyOn(parent, 'getContentGeneratorConfig').mockReturnValue({
      model: 'claude-main',
      authType: AuthType.USE_ANTHROPIC,
    });
    vi.spyOn(parent, 'getFastModel').mockReturnValue(
      `${AuthType.USE_OPENAI}:${fastModel}`,
    );
    vi.spyOn(parent, 'getAllConfiguredModels').mockImplementation(
      (authTypes?: AuthType[]) =>
        authTypes?.includes(AuthType.USE_OPENAI)
          ? [
              {
                id: fastModel,
                label: fastModel,
                authType: AuthType.USE_OPENAI,
              },
            ]
          : [],
    );

    const { captured, restore } = captureAgentHeadlessConfig();
    const result = await fork(restore, parent);
    expect(result.status).toBe('completed');

    expect(captured.modelConfig?.model).toBe(fastModel);
    expect(captured.runtimeView).toBe(runtimeView);
    expect(createRuntimeContentGeneratorView).toHaveBeenCalledWith(
      parent,
      captured.config,
      fastModel,
      { authType: AuthType.USE_OPENAI },
    );
  });
});
