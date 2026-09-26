/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import {
  ManagedToolRuntime,
  type ManagedToolV2Client,
} from './managed-tool-runtime.js';
import { RuntimeBackedTool } from './runtime-backed-tool.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
  type ToolResultDisplay,
  ToolConfirmationOutcome,
} from './tools.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

class WorkspaceTool extends BaseDeclarativeTool<{ value: string }, ToolResult> {
  readonly buildSpy = vi.fn();
  readonly confirmSpy = vi.fn(async () => {});
  readonly executeSpy = vi.fn(
    async (
      _signal: AbortSignal,
      _output?: (output: ToolResultDisplay) => void,
    ): Promise<ToolResult> => ({
      llmContent: 'result',
      returnDisplay: 'display',
    }),
  );

  constructor() {
    super(
      'workspace_write',
      'Write',
      'Write file',
      Kind.Edit,
      {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      true,
      true,
      true,
      false,
      'file write',
    );
  }
  override get maxOutputChars() {
    return Infinity;
  }
  override get truncateKeep() {
    return 'head' as const;
  }
  override toAutoClassifierInput(params: { value: string }) {
    return { length: params.value.length };
  }

  protected createInvocation(params: { value: string }) {
    this.buildSpy(params);
    const { confirmSpy, executeSpy } = this;
    return new (class extends BaseToolInvocation<
      { value: string },
      ToolResult
    > {
      getDescription() {
        return `write ${this.params.value}`;
      }
      override toolLocations() {
        return [{ path: '/runtime/file' }];
      }
      override async getDefaultPermission() {
        return 'ask' as const;
      }
      override async getConfirmationDetails() {
        return {
          type: 'info' as const,
          title: 'Write',
          prompt: this.getDescription(),
          onConfirm: confirmSpy,
        };
      }
      execute(
        signal: AbortSignal,
        output?: (output: ToolResultDisplay) => void,
      ) {
        return executeSpy(signal, output);
      }
    })({ value: params.value.trim() });
  }
}

describe('RuntimeBackedTool', () => {
  const sessionId = 'c911c54f-ad76-420f-8c76-fb124c0ce623';
  const context = { promptId: 'turn-one', callId: 'call-one' };
  let real: WorkspaceTool;
  let runtime: ManagedToolRuntime;
  let client: ManagedToolV2Client;
  let proxy: RuntimeBackedTool;
  let controller: AbortController;
  let snapshot: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    real = new WorkspaceTool();
    snapshot = vi.fn(async () => {});
    runtime = new ManagedToolRuntime(
      {
        getSessionId: () => sessionId,
        getFileHistoryService: () => ({ makeSnapshot: snapshot }),
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getDisableAllHooks: () => true,
        getShellExecutionConfig: () => ({}),
      } as unknown as Config,
      () => [real],
      () => 'policy-one',
    );
    client = {
      manifest: vi.fn<ManagedToolV2Client['manifest']>(async () =>
        runtime.manifest(),
      ),
      beginTurn: vi.fn<ManagedToolV2Client['beginTurn']>(async (...args) =>
        runtime.beginTurn(...args),
      ),
      prepare: vi.fn<ManagedToolV2Client['prepare']>(async (...args) =>
        runtime.prepare(...args),
      ),
      confirmation: vi.fn<ManagedToolV2Client['confirmation']>(
        async (...args) => runtime.confirmation(...args),
      ),
      confirm: vi.fn<ManagedToolV2Client['confirm']>(async (...args) =>
        runtime.confirm(...args),
      ),
      preflight: vi.fn<ManagedToolV2Client['preflight']>(async (...args) =>
        runtime.preflight(...args),
      ),
      execute: vi.fn<ManagedToolV2Client['execute']>(async (...args) =>
        runtime.execute(...args),
      ),
      status: vi.fn<ManagedToolV2Client['status']>(async (...args) =>
        runtime.status(...args),
      ),
      cancel: vi.fn<ManagedToolV2Client['cancel']>(async (...args) =>
        runtime.cancel(...args),
      ),
    };
    proxy = new RuntimeBackedTool({
      descriptor: runtime.manifest().tools[0],
      sessionId,
      getClient: async () => client,
      projectClassifierInput: (params) =>
        real.toAutoClassifierInput(params as { value: string }),
    });
    controller = new AbortController();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  async function prepared() {
    const invocation = proxy.build({ value: '  text  ' });
    await invocation.managed.prepare(controller.signal, context);
    return invocation;
  }

  async function authorized() {
    const invocation = await prepared();
    await invocation.managed.preflight();
    invocation.managed.authorize();
    return invocation;
  }

  it('builds a pure proxy and waits for Runtime before exposing effective arguments or descriptions', async () => {
    const invocation = proxy.build({ value: '  text  ' });
    expect(real.buildSpy).not.toHaveBeenCalled();
    expect(client.manifest).not.toHaveBeenCalled();
    expect(() => invocation.getDescription()).toThrow('prepared');
    expect(() => invocation.params).toThrow('prepared');
    await invocation.managed.prepare(controller.signal, context);
    expect(real.buildSpy).toHaveBeenCalledTimes(1);
    expect(invocation.params).toEqual({ value: 'text' });
    expect(invocation.getDescription()).toBe('write text');
    expect(invocation.toolLocations()).toEqual([{ path: '/runtime/file' }]);
    expect(await invocation.getDefaultPermission()).toBe('ask');
    expect(invocation.managed.toolUseId).toMatch(/^toolu_/);
    expect(real.executeSpy).not.toHaveBeenCalled();
    await invocation.managed.cancelAndDrain();
  });

  it('snapshots media before Runtime warmup and retains it when recovering a lost preparation', async () => {
    const media = { inputModalities: { image: true } };
    const getMediaContext = vi.fn(() => media);
    const ready = deferred<ManagedToolV2Client>();
    const mediaProxy = new RuntimeBackedTool({
      descriptor: runtime.manifest().tools[0],
      sessionId,
      getClient: () => ready.promise,
      getMediaContext,
      projectClassifierInput: () => '',
    });
    client.prepare = vi.fn<ManagedToolV2Client['prepare']>(
      async (identity, name, input) => runtime.prepare(identity, name, input),
    );
    vi.mocked(client.prepare).mockImplementationOnce(
      async (identity, name, input) => {
        await runtime.prepare(identity, name, input);
        throw new Error('lost media preparation response');
      },
    );
    const invocation = mediaProxy.build({ value: 'first' });
    const preparing = invocation.managed.prepare(controller.signal, context);
    expect(getMediaContext).toHaveBeenCalledOnce();
    media.inputModalities.image = false;
    ready.resolve(client);
    await expect(preparing).rejects.toThrow('lost media preparation');
    await invocation.managed.cancelAndDrain();
    expect(client.prepare).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(client.prepare).mock.calls) {
      expect(call[4]).toEqual({ inputModalities: { image: true } });
    }
    const next = mediaProxy.build({ value: 'next' });
    await next.managed.prepare(controller.signal, {
      ...context,
      callId: 'next',
    });
    expect(getMediaContext).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.prepare).mock.calls[2][4]).toEqual({
      inputModalities: { image: false },
    });
    await next.managed.cancelAndDrain();
    expect(real.executeSpy).not.toHaveBeenCalled();
  });

  it('preserves output budgets, deferred discovery and historical classifier projection without preparing tools', () => {
    expect(proxy.maxOutputChars).toBe(Infinity);
    expect(proxy.truncateKeep).toBe('head');
    expect(proxy.shouldDefer).toBe(true);
    expect(proxy.searchHint).toBe('file write');
    expect(proxy.schema).toEqual(real.schema);
    expect(proxy.toAutoClassifierInput({ value: 'private contents' })).toEqual({
      length: 16,
    });
    expect(real.buildSpy).not.toHaveBeenCalled();
  });

  it('rejects convenience execution and explicit authorization before preflight', async () => {
    await expect(
      proxy.buildAndExecute({ value: 'text' }, controller.signal),
    ).rejects.toThrow('prepared');
    const invocation = await prepared();
    expect(() => invocation.execute(controller.signal)).toThrow('authorized');
    expect(() => invocation.managed.authorize()).toThrow('preflight');
    expect(real.executeSpy).not.toHaveBeenCalled();
    await invocation.managed.cancelAndDrain();
  });

  it('does not call the Runtime onConfirm for automatic allowance', async () => {
    const invocation = await authorized();
    expect(await invocation.execute(controller.signal)).toMatchObject({
      llmContent: 'result',
      executionStatus: 'success',
    });
    expect(real.confirmSpy).not.toHaveBeenCalled();
    expect(real.executeSpy).toHaveBeenCalledTimes(1);
    expect(invocation.managed.result?.postHook).toEqual({ shouldStop: false });
  });

  it('invokes the real confirmation and runs a tool exactly once', async () => {
    const invocation = await prepared();
    const details = await invocation.getConfirmationDetails(controller.signal);
    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect(real.confirmSpy).toHaveBeenCalledExactlyOnceWith(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
    await invocation.managed.preflight();
    invocation.managed.authorize();
    const [first, second] = await Promise.all([
      invocation.execute(controller.signal),
      invocation.execute(controller.signal),
    ]);
    expect(first).toEqual(second);
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(real.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('reserves a durable execution identity before starting the Runtime', async () => {
    const order: string[] = [];
    client.prepareExecution = vi.fn(async () => {
      order.push('reserve');
      return {
        executionCallId: 'execution-1',
        invocationBindingId: 'runtime-1',
      };
    });
    client.startExecution = vi.fn(async (reference, executionCallId) => {
      expect(executionCallId).toBe('execution-1');
      order.push('start');
      return runtime.execute(reference);
    });
    const invocation = await authorized();

    await expect(invocation.managed.prepareExecution()).resolves.toEqual({
      executionCallId: 'execution-1',
      invocationBindingId: 'runtime-1',
    });
    await invocation.managed.prepareExecution();
    expect(order).toEqual(['reserve']);

    await expect(invocation.execute(controller.signal)).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(order).toEqual(['reserve', 'start']);
    expect(client.prepareExecution).toHaveBeenCalledTimes(1);
    expect(client.startExecution).toHaveBeenCalledTimes(1);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('fails closed when only half of the reservation contract is present', async () => {
    client.prepareExecution = vi.fn(async () => ({
      executionCallId: 'execution-1',
      invocationBindingId: 'runtime-1',
    }));
    const invocation = await authorized();

    await expect(invocation.managed.prepareExecution()).rejects.toThrow(
      'reservation contract is incomplete',
    );
    expect(client.prepareExecution).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
    await invocation.managed.cancelAndDrain();
  });

  it('keeps cancellation pending until the real invocation settles, including successful late writes', async () => {
    const done = deferred<ToolResult>();
    real.executeSpy.mockImplementation(async () => done.promise);
    const invocation = await authorized();
    const execution = invocation.execute(controller.signal);
    await vi.waitFor(() => expect(real.executeSpy).toHaveBeenCalledTimes(1));
    controller.abort();
    let drained = false;
    const drain = invocation.managed.cancelAndDrain().then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(1));
    expect(drained).toBe(false);
    expect(runtime.hasActiveWork()).toBe(true);
    done.resolve({
      llmContent: 'write completed',
      returnDisplay: 'done',
      executionStatus: 'success',
    });
    await drain;
    expect(await execution).toMatchObject({ executionStatus: 'success' });
    expect(drained).toBe(true);
    expect(runtime.hasActiveWork()).toBe(false);
  });

  it('drains a preparation response that arrives after cancellation', async () => {
    const gate = deferred<void>();
    const original = client.prepare;
    client.prepare = vi.fn<ManagedToolV2Client['prepare']>(async (...args) => {
      const result = await original(...args);
      await gate.promise;
      return result;
    });
    const invocation = proxy.build({ value: 'text' });
    const preparing = invocation.managed.prepare(controller.signal, context);
    const rejected = preparing.catch((error: unknown) => error);
    await vi.waitFor(() => expect(real.buildSpy).toHaveBeenCalledTimes(1));
    controller.abort();
    let drained = false;
    const drain = invocation.managed.cancelAndDrain().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    gate.resolve();
    expect(await rejected).toBeInstanceOf(Error);
    await drain;
    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(real.executeSpy).not.toHaveBeenCalled();
    expect(runtime.hasActiveWork()).toBe(false);
  });

  it('recovers a lost accepted preparation only to cancel its original reference', async () => {
    const original = client.prepare;
    client.prepare = vi
      .fn<ManagedToolV2Client['prepare']>(original)
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('lost prepare response');
      });
    const invocation = proxy.build({ value: 'text' });
    await expect(
      invocation.managed.prepare(controller.signal, context),
    ).rejects.toThrow('lost prepare');
    await invocation.managed.cancelAndDrain();
    expect(real.buildSpy).toHaveBeenCalledTimes(1);
    expect(real.executeSpy).not.toHaveBeenCalled();
    expect(runtime.hasActiveWork()).toBe(false);
  });

  it('waits for an accepted turn snapshot even when its beginTurn response is lost', async () => {
    const gate = deferred<void>();
    snapshot.mockImplementation(async () => gate.promise);
    vi.mocked(client.beginTurn).mockImplementationOnce(async (...args) => {
      void runtime.beginTurn(...args).catch(() => {});
      throw new Error('lost beginTurn response');
    });
    const invocation = proxy.build({ value: 'text' });
    await expect(
      invocation.managed.prepare(controller.signal, context),
    ).rejects.toThrow('lost beginTurn');
    let drained = false;
    const draining = invocation.managed.cancelAndDrain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      expect(drained).toBe(false);
      expect(runtime.hasActiveWork()).toBe(true);
    } finally {
      gate.resolve();
      await draining;
    }
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(real.buildSpy).not.toHaveBeenCalled();
    expect(runtime.hasActiveWork()).toBe(false);
  });

  it('does not turn an unknown preparation outcome into successful cleanup', async () => {
    const original = client.prepare;
    client.prepare = vi.fn<ManagedToolV2Client['prepare']>(async (...args) => {
      await original(...args);
      throw new Error('unreachable response');
    });
    const invocation = proxy.build({ value: 'text' });
    await expect(
      invocation.managed.prepare(controller.signal, context),
    ).rejects.toThrow('unreachable');
    await expect(invocation.managed.cancelAndDrain()).rejects.toThrow(
      'unreachable',
    );
    expect(runtime.hasActiveWork()).toBe(true);
  });

  it('queries the same invocation after an execution response is lost without retrying effects', async () => {
    client.execute = vi.fn<ManagedToolV2Client['execute']>(async (...args) => {
      await runtime.execute(...args);
      throw new Error('lost execution response');
    });
    const invocation = await authorized();
    expect(await invocation.execute(controller.signal)).toMatchObject({
      executionStatus: 'success',
    });
    expect(real.executeSpy).toHaveBeenCalledTimes(1);
    expect(client.execute).toHaveBeenCalledTimes(1);
  });

  it('cancels a prepared reference when execute was never accepted', async () => {
    client.execute = vi.fn<ManagedToolV2Client['execute']>(async () => {
      throw new Error('unaccepted execute');
    });
    const invocation = await authorized();
    expect(await invocation.execute(controller.signal)).toMatchObject({
      executionStatus: 'not_started',
    });
    expect(real.executeSpy).not.toHaveBeenCalled();
    expect(runtime.hasActiveWork()).toBe(false);
  });

  it('rejects a changed manifest before a workspace tool is built', async () => {
    client.manifest = vi.fn<ManagedToolV2Client['manifest']>(async () => {
      const manifest = runtime.manifest();
      manifest.tools[0] = { ...manifest.tools[0], description: 'changed' };
      return manifest;
    });
    const invocation = proxy.build({ value: 'text' });
    await expect(
      invocation.managed.prepare(controller.signal, context),
    ).rejects.toThrow('declaration changed');
    expect(real.buildSpy).not.toHaveBeenCalled();
    await invocation.managed.cancelAndDrain();
  });

  it('reprepares changed arguments under the same call and invalidates the old confirmation callback', async () => {
    const oldInvocation = await prepared();
    const oldDetails = await oldInvocation.getConfirmationDetails(
      controller.signal,
    );
    await oldInvocation.managed.cancelAndDrain();
    const next = proxy.build({ value: 'changed' });
    await next.managed.prepare(controller.signal, context);
    expect(next.getDescription()).toBe('write changed');
    expect(real.buildSpy).toHaveBeenCalledTimes(2);
    await expect(
      oldDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce),
    ).rejects.toThrow('cancelled');
    expect(real.confirmSpy).not.toHaveBeenCalled();
    expect(() => next.execute(controller.signal)).toThrow('authorized');
    const details = await next.getConfirmationDetails(controller.signal);
    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    await next.managed.preflight();
    next.managed.authorize();
    await next.execute(controller.signal);
    expect(real.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('streams sequenced Runtime progress and waits through temporary status failures', async () => {
    const done = deferred<ToolResult>();
    real.executeSpy.mockImplementation(async (_signal, output) => {
      output?.('first');
      output?.('second');
      return done.promise;
    });
    vi.mocked(client.status).mockRejectedValueOnce(
      new Error('temporary transport failure'),
    );
    const invocation = await authorized();
    const output = vi.fn();
    const executing = invocation.execute(controller.signal, output);
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(2));
    expect(output.mock.calls).toEqual([['first'], ['second']]);
    done.resolve({ llmContent: 'complete', returnDisplay: 'complete' });
    expect(await executing).toMatchObject({ executionStatus: 'success' });
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(2);
  });

  it('does not allow a prepared invocation to move between call identities', async () => {
    const invocation = await prepared();
    await expect(
      invocation.managed.prepare(controller.signal, {
        ...context,
        callId: 'different',
      }),
    ).rejects.toThrow('identity');
    expect(real.buildSpy).toHaveBeenCalledTimes(1);
    await invocation.managed.cancelAndDrain();
  });

  it('drains a rejected preparation whose returned parameter digest does not match', async () => {
    const original = client.prepare;
    client.prepare = vi.fn<ManagedToolV2Client['prepare']>(async (...args) => ({
      ...(await original(...args)),
      params: { value: 'tampered' },
    }));
    const invocation = proxy.build({ value: 'text' });
    await expect(
      invocation.managed.prepare(controller.signal, context),
    ).rejects.toThrow('parameters');
    await invocation.managed.cancelAndDrain();
    expect(real.executeSpy).not.toHaveBeenCalled();
    expect(runtime.hasActiveWork()).toBe(false);
  });
});
