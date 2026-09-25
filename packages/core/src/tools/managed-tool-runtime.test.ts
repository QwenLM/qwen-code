/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { getInvocationContext } from '../utils/invocation-context.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
  type ToolResult,
  type ToolResultDisplay,
} from './tools.js';
import {
  ManagedToolRuntime,
  createBuiltinManagedToolRuntime,
  type ManagedToolExecutionResult,
  type ManagedToolRuntimeFileHistory,
} from './managed-tool-runtime.js';
import { managedToolDigest } from './managed-tool-protocol.js';
import type {
  ManagedToolCallIdentity,
  ManagedToolInvocationReference,
  ManagedToolPrepareResponse,
} from './managed-tool-protocol.js';

const hooks = vi.hoisted(() => ({
  pre: vi.fn(),
  post: vi.fn(),
  failure: vi.fn(),
}));
vi.mock('../core/toolHookTriggers.js', () => ({
  generateToolUseId: () => 'test-tool-use-id',
  firePreToolUseHook: hooks.pre,
  firePostToolUseHook: hooks.post,
  firePostToolUseFailureHook: hooks.failure,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const sessionId = 'c911c54f-ad76-420f-8c76-fb124c0ce623';
const rawResult: ToolResult = { llmContent: 'done', returnDisplay: 'Done' };
const input = { value: 'original' };

class FixtureInvocation extends BaseToolInvocation<
  { value: string },
  ToolResult
> {
  getDescription() {
    return `write ${this.params.value}`;
  }
  override toolLocations() {
    return [{ path: '/scratch/output' }];
  }
  override getDefaultPermission = vi.fn(async () => 'ask' as const);
  onConfirm = vi.fn(async () => {});
  override getConfirmationDetails = vi.fn(
    async (_signal: AbortSignal): Promise<ToolCallConfirmationDetails> => ({
      type: 'info',
      title: 'Write',
      prompt: this.getDescription(),
      onConfirm: this.onConfirm,
    }),
  );
  execute = vi.fn(
    async (
      _signal: AbortSignal,
      _update?: (output: ToolResultDisplay) => void,
    ): Promise<ToolResult> => structuredClone(rawResult),
  );
}

class FixtureTool extends BaseDeclarativeTool<{ value: string }, ToolResult> {
  invocations: FixtureInvocation[] = [];
  setup = (_invocation: FixtureInvocation) => {};
  constructor() {
    super('fixture_write', 'Write', 'Write fixture', Kind.Edit, {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    });
  }
  protected createInvocation(params: { value: string }) {
    const invocation = new FixtureInvocation(params);
    this.setup(invocation);
    this.invocations.push(invocation);
    return invocation;
  }
}

function reference(
  value: ManagedToolPrepareResponse,
): ManagedToolInvocationReference {
  const {
    sessionId,
    promptId,
    callId,
    capabilityDigest,
    policyRevision,
    invocationId,
    argsDigest,
  } = value;
  return {
    sessionId,
    promptId,
    callId,
    capabilityDigest,
    policyRevision,
    invocationId,
    argsDigest,
  };
}

describe('ManagedToolRuntime', () => {
  let tool: FixtureTool;
  let runtime: ManagedToolRuntime;
  let snapshot: ReturnType<typeof vi.fn>;
  let revision: string;
  let identity: ManagedToolCallIdentity;
  let events: string[];
  let config: Config;

  beforeEach(() => {
    vi.resetAllMocks();
    events = [];
    hooks.pre.mockImplementation(async () => {
      events.push('preflight');
      return { shouldProceed: true };
    });
    hooks.post.mockImplementation(async () => {
      events.push('post');
      return { shouldStop: false };
    });
    hooks.failure.mockResolvedValue({});
    snapshot = vi.fn(async () => {
      events.push('snapshot');
    });
    config = {
      getSessionId: () => sessionId,
      getDisableAllHooks: () => false,
      getMessageBus: () => undefined,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getFileHistoryService: () => ({ makeSnapshot: snapshot }),
      getShellExecutionConfig: () => ({
        terminalWidth: 80,
        terminalHeight: 24,
        showColor: false,
      }),
    } as unknown as Config;
    revision = 'workspace-generation-1';
    tool = new FixtureTool();
    runtime = new ManagedToolRuntime(
      config,
      () => [tool],
      () => revision,
    );
    identity = {
      sessionId,
      promptId: 'prompt-1',
      callId: 'call-1',
      capabilityDigest: runtime.manifest().capabilityDigest,
      policyRevision: revision,
    };
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  async function prepare(args = input, call = identity) {
    await runtime.beginTurn(call);
    return reference(await runtime.prepare(call, tool.name, args));
  }

  function useSharedHistory(history: ManagedToolRuntimeFileHistory) {
    runtime = new ManagedToolRuntime(
      config,
      () => [tool],
      () => revision,
      history,
    );
  }

  it('waits for the shared parent history without creating child snapshots', async () => {
    const ready = deferred<void>();
    const prepareTurn = vi.fn(() => ready.promise);
    useSharedHistory({ prepareTurn, execute: (operation) => operation() });
    const beginning = runtime.beginTurn(identity);
    const preparing = runtime.prepare(identity, tool.name, input);
    await Promise.resolve();
    expect(prepareTurn).toHaveBeenCalledExactlyOnceWith(identity);
    expect(tool.invocations).toHaveLength(0);
    expect(snapshot).not.toHaveBeenCalled();
    ready.resolve();
    await beginning;
    const ref = reference(await preparing);
    await runtime.preflight(ref);
    await runtime.execute(ref);
    await runtime.beginTurn({ ...identity, promptId: 'child-prompt-2' });
    expect(prepareTurn).toHaveBeenCalledTimes(2);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'policy', 'session'] as const)(
    'settles queued %s invalidation without physically executing the tool',
    async (change) => {
      const gate = deferred<void>();
      const execute = vi.fn(
        async (operation: () => Promise<ManagedToolExecutionResult>) => {
          await gate.promise;
          return operation();
        },
      );
      useSharedHistory({ prepareTurn: async () => {}, execute });
      const ref = await prepare();
      await runtime.preflight(ref);
      const pending = runtime.execute(ref);
      expect(tool.invocations[0].execute).not.toHaveBeenCalled();
      if (change === 'cancel') runtime.cancel(ref);
      if (change === 'policy') revision = 'replaced-policy';
      if (change === 'session') {
        vi.spyOn(config, 'getSessionId').mockReturnValue(
          '4f17902c-bb4c-4ae8-bb5e-a3f25753a6ab',
        );
      }
      expect(runtime.status(ref).state).not.toBe('settled');
      gate.resolve();
      expect(await pending).toMatchObject({
        executionStatus: 'not_started',
        error: { message: expect.any(String) },
      });
      expect(runtime.status(ref)).toMatchObject({
        state: 'settled',
        result: { executionStatus: 'not_started' },
      });
      expect(tool.invocations[0].execute).not.toHaveBeenCalled();
      expect(hooks.post).not.toHaveBeenCalled();
      expect(hooks.failure).not.toHaveBeenCalled();
    },
  );

  it('waits for queued execution cancellation before Runtime disposal finishes', async () => {
    const gate = deferred<void>();
    useSharedHistory({
      prepareTurn: async () => {},
      execute: async (operation) => {
        await gate.promise;
        return operation();
      },
    });
    const ref = await prepare();
    await runtime.preflight(ref);
    const pending = runtime.execute(ref);
    let disposed = false;
    const disposal = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    gate.resolve();
    expect((await pending).executionStatus).toBe('not_started');
    await disposal;
    expect(disposed).toBe(true);
    expect(tool.invocations[0].execute).not.toHaveBeenCalled();
  });

  it('binds admitted builtins once to the child tool Config and forwards shared history', async () => {
    const { ReadFileTool } = await import('./read-file.js');
    const parentRead = new ReadFileTool(config);
    const parentBuild = vi.spyOn(parentRead, 'build');
    const getTool = vi.fn((name: string) =>
      name === ReadFileTool.Name ? parentRead : tool,
    );
    config.getToolRegistry = () =>
      ({
        getTool,
        ensureTool: vi.fn(async () => undefined),
      }) as unknown as ReturnType<Config['getToolRegistry']>;
    config.isLsToolEnabled = () => false;
    const childConfig = Object.assign(Object.create(config) as Config, {
      getTargetDir: () => '/managed-child',
      getFileService: () => ({ shouldQwenIgnoreFile: () => false }),
      getWorkspaceContext: () => ({ isPathWithinWorkspace: () => true }),
      getPlansDir: () => '/managed-child/plans',
      storage: {
        getProjectTempDir: () => '/managed-child/tmp',
        getProjectDir: () => '/managed-child',
        getUserSkillsDirs: () => [],
        getWorkflowRunsDir: () => '/managed-child/workflow-runs',
      },
    });
    const prepareTurn = vi.fn(async () => {});
    const build = vi.spyOn(ReadFileTool.prototype, 'build');
    try {
      runtime = await createBuiltinManagedToolRuntime(
        config,
        {
          prepareTurn,
          execute: (operation) => operation(),
        },
        childConfig,
      );
      const manifest = runtime.manifest();
      expect(manifest.tools.map(({ name }) => name)).toEqual([
        ReadFileTool.Name,
      ]);
      expect(runtime.manifest()).toEqual(manifest);
      const call = {
        ...identity,
        policyRevision: manifest.policyRevision,
        capabilityDigest: manifest.capabilityDigest,
      };
      await runtime.beginTurn(call);
      const first = await runtime.prepare(call, ReadFileTool.Name, {
        file_path: '/managed-child/a.txt',
      });
      await runtime.prepare({ ...call, callId: 'call-2' }, ReadFileTool.Name, {
        file_path: '/managed-child/b.txt',
      });
      expect(first.params).toEqual({ file_path: '/managed-child/a.txt' });
      expect(first.argsDigest).toBe(managedToolDigest(first.params));
      expect(first.description).toBe('a.txt');
      expect(first.defaultPermission).toBe('allow');
      expect(first.sessionId).toBe(sessionId);
      expect(prepareTurn).toHaveBeenCalledExactlyOnceWith(call);
      expect(snapshot).not.toHaveBeenCalled();
      expect(parentBuild).not.toHaveBeenCalled();
      expect(build).toHaveBeenCalledTimes(2);
      expect(build.mock.instances[0]).toBe(build.mock.instances[1]);
      expect(build.mock.instances[0]).not.toBe(parentRead);
      getTool.mockReturnValue(tool);
      expect(runtime.manifest().tools).toEqual([]);
      await expect(runtime.preflight(reference(first))).rejects.toThrow(
        'capability changed',
      );
    } finally {
      build.mockRestore();
      parentBuild.mockRestore();
    }
  });

  it('prepares once without execution and checkpoints at the explicit turn boundary', async () => {
    await runtime.beginTurn(identity);
    const prepared = await runtime.prepare(identity, tool.name, input);
    const repeated = await runtime.prepare(identity, tool.name, {
      value: 'original',
    });
    expect(repeated).toEqual(prepared);
    expect(tool.invocations).toHaveLength(1);
    expect(tool.invocations[0].execute).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({
      params: input,
      description: 'write original',
      defaultPermission: 'ask',
      locations: [{ path: '/scratch/output' }],
    });
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(identity.promptId);
    expect(runtime.hasActiveWork()).toBe(true);
  });

  it('rejects preparation without a turn and does not retain a rejected call', async () => {
    await expect(runtime.prepare(identity, tool.name, input)).rejects.toThrow(
      'turn has not started',
    );
    await runtime.beginTurn(identity);
    const prepared = await runtime.prepare(identity, tool.name, input);
    expect(prepared.params).toEqual(input);
  });

  it('serializes concurrent preparations and owns copies of their identity and args', async () => {
    const gate = deferred<'ask'>();
    tool.setup = (invocation) =>
      invocation.getDefaultPermission.mockReturnValue(gate.promise);
    await runtime.beginTurn(identity);
    const mutableIdentity = { ...identity };
    const mutableArgs = { ...input };
    const first = runtime.prepare(mutableIdentity, tool.name, mutableArgs);
    const second = runtime.prepare(identity, tool.name, input);
    mutableIdentity.callId = 'changed';
    mutableArgs.value = 'changed';
    await vi.waitFor(() => expect(tool.invocations).toHaveLength(1));
    gate.resolve('ask');
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.callId).toBe(identity.callId);
    expect(a.params).toEqual(input);
  });

  it('does not let a conflicting prepare erase the original idempotency record', async () => {
    const prepared = await prepare();
    await expect(
      runtime.prepare(identity, tool.name, { value: 'changed' }),
    ).rejects.toThrow('already owns');
    expect(
      reference(await runtime.prepare(identity, tool.name, input)),
    ).toEqual(prepared);
    expect(tool.invocations).toHaveLength(1);
  });

  it('allows queued retry after a rejected build', async () => {
    await runtime.beginTurn(identity);
    const bad = runtime.prepare(identity, tool.name, {});
    const retry = runtime.prepare(identity, tool.name, input);
    await expect(bad).rejects.toThrow();
    expect((await retry).params).toEqual(input);
  });

  it('build, confirmation, preflight and execution carry the original invocation context', async () => {
    const assertContext = () => {
      expect(getInvocationContext()).toEqual({
        version: 1,
        sessionId,
        promptId: identity.promptId,
      });
      expect(promptIdContext.getStore()).toBe(identity.promptId);
    };
    tool.setup = (invocation) => {
      assertContext();
      invocation.getDefaultPermission.mockImplementation(async () => {
        assertContext();
        return 'ask';
      });
      invocation.onConfirm.mockImplementation(async () => {
        assertContext();
      });
      invocation.execute.mockImplementation(async () => {
        assertContext();
        return rawResult;
      });
    };
    hooks.pre.mockImplementation(async () => {
      assertContext();
      return { shouldProceed: true };
    });
    hooks.post.mockImplementation(async () => {
      assertContext();
      return { shouldStop: false };
    });
    const ref = await prepare();
    const dto = await runtime.confirmation(ref);
    expect(dto).not.toHaveProperty('onConfirm');
    await runtime.confirm(ref, ToolConfirmationOutcome.ProceedOnce);
    await runtime.preflight(ref);
    await runtime.execute(ref);
  });

  it('leaves an always choice to the Harness and approves the invocation once locally', async () => {
    tool.setup = (invocation) => {
      invocation.getDefaultPermission.mockResolvedValue('ask');
    };
    const ref = await prepare();
    await runtime.confirmation(ref);
    await runtime.confirm(ref, ToolConfirmationOutcome.ProceedAlways);
    expect(tool.invocations[0].onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
    // The decision itself is still recorded as the choice the Harness made.
    await expect(
      runtime.confirm(ref, ToolConfirmationOutcome.ProceedOnce),
    ).rejects.toThrow('already decided');
  });

  it('requires preflight and supports trusted automatic allow without onConfirm', async () => {
    const ref = await prepare();
    expect(() => runtime.execute(ref)).toThrow('preflight');
    await runtime.preflight(ref);
    expect(await runtime.execute(ref)).toMatchObject({
      executionStatus: 'success',
      result: rawResult,
    });
    expect(tool.invocations[0].onConfirm).not.toHaveBeenCalled();
    expect(events).toEqual(['snapshot', 'preflight', 'post']);
  });

  it('runs the preflight hook once across the second confirmation bounce', async () => {
    hooks.pre.mockResolvedValue({ shouldProceed: false, blockType: 'ask' });
    const ref = await prepare();
    await runtime.confirm(ref, ToolConfirmationOutcome.ProceedOnce);
    await runtime.preflight(ref);
    expect(() => runtime.execute(ref)).toThrow('preflight');
    await runtime.confirm(
      ref,
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
      'preflight',
    );
    await runtime.confirm(
      ref,
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
      'preflight',
    );
    await runtime.preflight(ref);
    expect((await runtime.execute(ref)).executionStatus).toBe('success');
    expect(tool.invocations[0].onConfirm).toHaveBeenCalledTimes(2);
    expect(hooks.pre).toHaveBeenCalledTimes(1);
    expect(hooks.pre.mock.calls[0][3]).toBe(hooks.post.mock.calls[0][4]);
  });

  it.each(['denied', 'stop'])(
    'cannot confirm away a preflight %s',
    async (blockType) => {
      hooks.pre.mockResolvedValue({ shouldProceed: false, blockType });
      const ref = await prepare();
      await runtime.preflight(ref);
      await expect(
        runtime.confirm(
          ref,
          ToolConfirmationOutcome.ProceedOnce,
          undefined,
          'preflight',
        ),
      ).rejects.toThrow('did not request');
      expect(() => runtime.execute(ref)).toThrow('preflight');
      expect(tool.invocations[0].execute).not.toHaveBeenCalled();
    },
  );

  it('waits for permission callback before preflight and rejects contradictory confirmation', async () => {
    const gate = deferred<void>();
    tool.setup = (invocation) =>
      invocation.onConfirm.mockReturnValue(gate.promise);
    const ref = await prepare();
    const confirming = runtime.confirm(
      ref,
      ToolConfirmationOutcome.ProceedOnce,
    );
    const flight = runtime.preflight(ref);
    await vi.waitFor(() =>
      expect(tool.invocations[0].onConfirm).toHaveBeenCalledTimes(1),
    );
    expect(hooks.pre).not.toHaveBeenCalled();
    await expect(
      runtime.confirm(ref, ToolConfirmationOutcome.ProceedAlways),
    ).rejects.toThrow('already decided');
    gate.resolve();
    await confirming;
    await flight;
    await runtime.execute(ref);
  });

  it('invalidates modified arguments and permits exactly one replacement build', async () => {
    const ref = await prepare();
    await expect(
      runtime.confirm(ref, ToolConfirmationOutcome.ProceedOnce, {
        updatedInput: { value: 'changed' },
      }),
    ).rejects.toThrow('new preparation');
    const [a, b] = await Promise.all([
      runtime.prepare(identity, tool.name, { value: 'changed' }),
      runtime.prepare(identity, tool.name, { value: 'changed' }),
    ]);
    expect(a.invocationId).not.toBe(ref.invocationId);
    expect(a).toEqual(b);
    expect(() => runtime.execute(ref)).toThrow('cancelled');
    expect(tool.invocations[0].onConfirm).not.toHaveBeenCalled();
    expect(tool.invocations[0].execute).not.toHaveBeenCalled();
    await runtime.preflight(reference(a));
    await runtime.execute(reference(a));
    expect(tool.invocations[1].execute).toHaveBeenCalledTimes(1);
  });

  it('rejects parameters mutated after prepare before any side effect', async () => {
    const ref = await prepare();
    await runtime.preflight(ref);
    tool.invocations[0].params.value = 'modified';
    expect(() => runtime.execute(ref)).toThrow('parameters changed');
    expect(tool.invocations[0].execute).not.toHaveBeenCalled();
  });

  it.each([
    'sessionId',
    'promptId',
    'callId',
    'invocationId',
    'capabilityDigest',
    'policyRevision',
    'argsDigest',
  ] as const)(
    'rejects a forged %s for cancel/status/execute',
    async (field) => {
      const ref = await prepare();
      const forged = { ...ref, [field]: 'forged' };
      expect(() => runtime.cancel(forged)).toThrow('identity');
      expect(() => runtime.status(forged)).toThrow('identity');
      expect(() => runtime.execute(forged)).toThrow('identity');
      expect(runtime.status(ref).cancelRequested).toBe(false);
    },
  );

  it('rejects stale policy for new execution but preserves a completed result', async () => {
    const first = await prepare();
    await runtime.preflight(first);
    await runtime.execute(first);
    const second = reference(
      await runtime.prepare(
        { ...identity, callId: 'call-2' },
        tool.name,
        input,
      ),
    );
    await runtime.preflight(second);
    revision = 'generation-2';
    expect(() => runtime.execute(second)).toThrow('capability changed');
    expect((await runtime.execute(first)).executionStatus).toBe('success');
    expect(runtime.status(first).result?.executionStatus).toBe('success');
  });

  it('executes at most once across concurrent delivery and a retry after a lost response', async () => {
    const gate = deferred<ToolResult>();
    tool.setup = (invocation) =>
      invocation.execute.mockReturnValue(gate.promise);
    const ref = await prepare();
    await runtime.preflight(ref);
    const first = runtime.execute(ref);
    const duplicate = runtime.execute(ref);
    expect(tool.invocations[0].execute).toHaveBeenCalledTimes(1);
    expect(runtime.status(ref).state).toBe('executing');
    gate.resolve(rawResult);
    const [a, b] = await Promise.all([first, duplicate]);
    expect(a).toEqual(b);
    a.result!.llmContent = 'modified client copy';
    expect((await runtime.execute(ref)).result?.llmContent).toBe('done');
    expect(runtime.status(ref).result?.result?.llmContent).toBe('done');
    expect(tool.invocations[0].execute).toHaveBeenCalledTimes(1);
  });

  it('does not turn a successful side effect into a failure when a post hook stops or fails', async () => {
    hooks.post
      .mockResolvedValueOnce({ shouldStop: true, stopReason: 'policy stop' })
      .mockRejectedValueOnce(new Error('hook failed'));
    const first = await prepare();
    await runtime.preflight(first);
    expect(await runtime.execute(first)).toMatchObject({
      executionStatus: 'success',
      postHook: { shouldStop: true },
    });
    const second = reference(
      await runtime.prepare(
        { ...identity, callId: 'call-2' },
        tool.name,
        input,
      ),
    );
    await runtime.preflight(second);
    expect(await runtime.execute(second)).toMatchObject({
      executionStatus: 'success',
      postHook: { hookError: 'hook failed' },
    });
    expect(hooks.failure).not.toHaveBeenCalled();
  });

  it('records failure once and drops model control fields from workspace output', async () => {
    tool.setup = (invocation) =>
      invocation.execute.mockResolvedValue({
        ...rawResult,
        modelOverride: 'foreign-model',
        terminateTurn: true,
        persistedOutputFiles: [],
        resultFilePaths: ['/scratch/output'],
        error: { message: 'write failed' },
      });
    const ref = await prepare();
    await runtime.preflight(ref);
    const result = await runtime.execute(ref);
    expect(result.executionStatus).toBe('error');
    expect(result.result).toMatchObject({
      persistedOutputFiles: [],
      resultFilePaths: ['/scratch/output'],
    });
    expect(result.result).not.toHaveProperty('modelOverride');
    expect(result.result).not.toHaveProperty('terminateTurn');
    await runtime.execute(ref);
    expect(hooks.failure).toHaveBeenCalledTimes(1);
    expect(hooks.post).not.toHaveBeenCalled();
  });

  it('reports progress gaps and keeps the final result after dropping oversized progress', async () => {
    tool.setup = (invocation) =>
      invocation.execute.mockImplementation(async (_signal, update) => {
        update!('first');
        update!('x'.repeat(1024 * 1024));
        update!('last');
        return rawResult;
      });
    const ref = await prepare();
    await runtime.preflight(ref);
    await runtime.execute(ref);
    expect(runtime.status(ref)).toMatchObject({
      state: 'settled',
      lastSeq: 3,
      firstAvailableSeq: 3,
      progressGap: true,
      progress: [{ seq: 3, output: 'last' }],
    });
    expect(runtime.status(ref, 2).progressGap).toBe(false);
    expect(() => runtime.status(ref, -1)).toThrow('cursor');
  });

  it('separates a cancel acknowledgment from underlying execution settlement and shutdown', async () => {
    const gate = deferred<ToolResult>();
    tool.setup = (invocation) =>
      invocation.execute.mockReturnValue(gate.promise);
    const ref = await prepare();
    await runtime.preflight(ref);
    const executing = runtime.execute(ref);
    expect(runtime.cancel(ref)).toMatchObject({
      state: 'cancel_requested',
      cancelRequested: true,
    });
    expect(runtime.hasActiveWork()).toBe(true);
    let disposed = false;
    const disposal = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(tool.invocations[0].execute.mock.calls[0][0].aborted).toBe(true);
    gate.resolve({ ...rawResult, error: { message: 'cancelled' } });
    expect((await executing).executionStatus).toBe('cancelled');
    await disposal;
    expect(disposed).toBe(true);
    expect(hooks.failure).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate cancellation when an already running write actually succeeds', async () => {
    const gate = deferred<ToolResult>();
    tool.setup = (invocation) =>
      invocation.execute.mockReturnValue(gate.promise);
    const ref = await prepare();
    await runtime.preflight(ref);
    const executing = runtime.execute(ref);
    runtime.cancel(ref);
    gate.resolve(rawResult);
    expect((await executing).executionStatus).toBe('success');
    expect(runtime.status(ref)).toMatchObject({
      state: 'settled',
      cancelRequested: true,
    });
  });

  it('keeps a prepared cancellation un-settled until its confirmation callback returns', async () => {
    const gate = deferred<void>();
    tool.setup = (invocation) =>
      invocation.onConfirm.mockReturnValue(gate.promise);
    const ref = await prepare();
    const confirming = runtime.confirm(
      ref,
      ToolConfirmationOutcome.ProceedOnce,
    );
    const rejection = confirming.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(tool.invocations[0].onConfirm).toHaveBeenCalledTimes(1),
    );
    expect(runtime.cancel(ref).state).toBe('cancel_requested');
    expect(runtime.hasActiveWork()).toBe(true);
    gate.resolve();
    expect(await rejection).toMatchObject({
      message: expect.stringContaining('cancelled'),
    });
    await vi.waitFor(() => expect(runtime.status(ref).state).toBe('settled'));
    expect(runtime.status(ref).result?.executionStatus).toBe('not_started');
    expect(tool.invocations[0].execute).not.toHaveBeenCalled();
  });

  it('replays cancel confirmation idempotently and never runs the tool', async () => {
    const ref = await prepare();
    await runtime.confirm(ref, ToolConfirmationOutcome.Cancel);
    await runtime.confirm(ref, ToolConfirmationOutcome.Cancel);
    await vi.waitFor(() => expect(runtime.status(ref).state).toBe('settled'));
    expect(tool.invocations[0].onConfirm).toHaveBeenCalledTimes(1);
    expect(tool.invocations[0].execute).not.toHaveBeenCalled();
  });

  it('does not switch turns around queued preparations or pending snapshots', async () => {
    const gate = deferred<void>();
    snapshot.mockReturnValue(gate.promise);
    const starting = runtime.beginTurn(identity);
    expect(() => runtime.beginTurn({ ...identity, promptId: 'other' })).toThrow(
      'unfinished',
    );
    expect(runtime.hasActiveWork()).toBe(true);
    gate.resolve();
    await starting;
    const pending = runtime.prepare(identity, tool.name, input);
    expect(() => runtime.beginTurn({ ...identity, promptId: 'other' })).toThrow(
      'unfinished',
    );
    await pending;
  });

  it('seals admission immediately and waits for a build that has not yet returned an id', async () => {
    const gate = deferred<'ask'>();
    tool.setup = (invocation) =>
      invocation.getDefaultPermission.mockReturnValue(gate.promise);
    await runtime.beginTurn(identity);
    const preparing = runtime.prepare(identity, tool.name, input);
    const rejection = preparing.catch((error: unknown) => error);
    await vi.waitFor(() => expect(tool.invocations).toHaveLength(1));
    runtime.seal();
    expect(() => runtime.beginTurn(identity)).toThrow('closed');
    let disposed = false;
    const disposal = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    gate.resolve('ask');
    expect(await rejection).toMatchObject({
      message: expect.stringContaining('closed'),
    });
    await disposal;
    expect(tool.invocations[0].execute).not.toHaveBeenCalled();
  });
});
