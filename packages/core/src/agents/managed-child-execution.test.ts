/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createManagedChildExecutionScope } from '../tools/managed-tool-session.js';
import { AgentHeadless, ContextState } from './runtime/agent-headless.js';
import { createManagedAgentTestConfig } from './managed-child-execution-test-utils.js';
import {
  bindManagedChildExecution,
  createManagedChildCleanup,
} from './managed-child-execution.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Managed child Agent execution ownership', () => {
  it('tracks continuation execution and drains before closing Runtime and writer', async () => {
    const { config, sessions } = createManagedAgentTestConfig();
    const scope = createManagedChildExecutionScope(config);
    const gate = deferred();
    let receivedSignal: AbortSignal | undefined;
    const execute = vi.fn(
      async (_context: ContextState, signal?: AbortSignal) => {
        receivedSignal = signal;
        await gate.promise;
      },
    );
    const agent = Object.assign(
      Object.create(AgentHeadless.prototype) as AgentHeadless,
      { execute },
    );
    bindManagedChildExecution(agent, scope);
    const writerClosed = vi.fn();
    const cleanup = createManagedChildCleanup(scope, writerClosed);
    const pending = agent.executeExternalInputs([
      { kind: 'notification', text: 'continue' },
    ]);
    const parentClosed = config.closeManagedToolSession();
    expect(receivedSignal?.aborted).toBe(true);
    expect(sessions[1]!.close).not.toHaveBeenCalled();
    expect(writerClosed).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    await parentClosed;
    expect(sessions[1]!.close).toHaveBeenCalledOnce();
    expect(writerClosed).toHaveBeenCalledOnce();
    await cleanup();
    expect(writerClosed).toHaveBeenCalledOnce();
    await expect(agent.execute(new ContextState())).rejects.toThrow('closing');
    expect(execute).toHaveBeenCalledOnce();
    expect(
      sessions.every(
        (session) => vi.mocked(session.getClient).mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it('keeps failed writer cleanup owned by the parent and retries it', async () => {
    const { config } = createManagedAgentTestConfig();
    const scope = createManagedChildExecutionScope(config);
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error('writer drain'))
      .mockResolvedValue(undefined);
    createManagedChildCleanup(scope, cleanup);
    await expect(config.closeManagedToolSession()).rejects.toThrow(
      'cleanup failed',
    );
    await config.closeManagedToolSession();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
