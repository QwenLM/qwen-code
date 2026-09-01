/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplKernelManager } from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';

const managers: NodeReplKernelManager[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Node REPL host capabilities', () => {
  it('routes generic capability calls through the active cell', async () => {
    const calls: unknown[] = [];
    const manager = createManager(async ({ signal, ...call }) => {
      calls.push({ ...call, aborted: signal.aborted });
      return { total: 7 };
    });

    const outcome = await manager.exec({
      timeoutMs: 5_000,
      code: [
        'const result = await nodeRepl.invokeHost("math", "sum", { values: [3, 4] });',
        'nodeRepl.write(result);',
      ].join('\n'),
    });

    expect(outcome.status).toBe('ok');
    expect(calls).toEqual([
      {
        capability: 'math',
        method: 'sum',
        args: { values: [3, 4] },
        aborted: false,
      },
    ]);
    expect(outcome.events).toContainEqual({
      type: 'text',
      kind: 'write',
      text: '{ total: 7 }',
    });
  }, 15_000);

  it('preserves structured host errors inside the cell', async () => {
    const manager = createManager(async () => {
      throw Object.assign(new Error('not allowed'), {
        name: 'CapabilityError',
        code: 'DENIED',
        retryable: true,
        details: { policy: 'test' },
      });
    });

    const outcome = await manager.exec({
      timeoutMs: 5_000,
      code: [
        'try {',
        '  await nodeRepl.invokeHost("example", "read", {});',
        '} catch (error) {',
        '  nodeRepl.write({ name: error.name, message: error.message, code: error.code, retryable: error.retryable, details: error.details });',
        '}',
      ].join('\n'),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.events).toContainEqual({
      type: 'text',
      kind: 'write',
      text: "{ name: 'CapabilityError', message: 'not allowed', code: 'DENIED', retryable: true, details: { policy: 'test' } }",
    });
  }, 15_000);

  it('normalizes errors with throwing metadata getters', async () => {
    const manager = createManager(async () => {
      const error = new Error('host failed');
      Object.defineProperty(error, 'code', {
        get: () => {
          throw new Error('metadata getter failed');
        },
      });
      throw error;
    });

    const outcome = await manager.exec({
      timeoutMs: 5_000,
      code: 'await nodeRepl.invokeHost("example", "read", {});',
    });

    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toBe('host failed');
    expect(outcome.stats.kernelReplaced).toBe(false);
  }, 15_000);

  it('rejects non-serializable arguments without replacing the kernel', async () => {
    const manager = createManager(async () => null);
    const outcome = await manager.exec({
      timeoutMs: 5_000,
      code: [
        'const args = {};',
        'args.self = args;',
        'await nodeRepl.invokeHost("example", "write", args);',
      ].join('\n'),
    });

    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toContain(
      'Host call arguments must be JSON-serializable',
    );
    expect(outcome.stats.kernelReplaced).toBe(false);

    const followUp = await manager.exec({
      timeoutMs: 5_000,
      code: 'nodeRepl.write("still alive");',
    });
    expect(followUp.status).toBe('ok');
    expect(followUp.stats.pid).toBe(outcome.stats.pid);
  }, 15_000);

  it('rejects oversized arguments without replacing the kernel', async () => {
    let dispatcherCalled = false;
    const manager = createManager(async () => {
      dispatcherCalled = true;
      return null;
    });
    const outcome = await manager.exec({
      timeoutMs: 30_000,
      code: [
        'await nodeRepl.invokeHost("example", "write", {',
        '  value: "x".repeat(64 * 1024 * 1024),',
        '});',
      ].join('\n'),
    });

    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toContain(
      'Host call could not cross the protocol boundary',
    );
    expect(outcome.stats.kernelReplaced).toBe(false);
    expect(dispatcherCalled).toBe(false);

    const followUp = await manager.exec({
      timeoutMs: 5_000,
      code: 'nodeRepl.write("still alive");',
    });
    expect(followUp.status).toBe('ok');
    expect(followUp.stats.pid).toBe(outcome.stats.pid);
  }, 30_000);

  it('bounds errors raised while serializing host results', async () => {
    const manager = createManager(async () => ({
      toJSON() {
        throw new Error('x'.repeat(64 * 1024 * 1024));
      },
    }));
    const outcome = await manager.exec({
      timeoutMs: 5_000,
      code: 'await nodeRepl.invokeHost("example", "read", {});',
    });

    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toBe('Host result is not serializable.');
    expect(outcome.stats.kernelReplaced).toBe(false);

    const followUp = await manager.exec({
      timeoutMs: 5_000,
      code: 'nodeRepl.write("still alive");',
    });
    expect(followUp.status).toBe('ok');
    expect(followUp.stats.pid).toBe(outcome.stats.pid);
  }, 30_000);

  it('rejects a cell that leaves a host call outstanding', async () => {
    const manager = createManager(
      async () =>
        await new Promise((resolve) => setTimeout(() => resolve(null), 50)),
    );
    const outcome = await manager.exec({
      timeoutMs: 5_000,
      code: 'nodeRepl.invokeHost("example", "write", {});',
    });

    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toContain('UNAWAITED_HOST_CALL');
  }, 15_000);

  it('cancels a pending host call at the cell timeout', async () => {
    let dispatcherAborted = false;
    const manager = createManager(
      async ({ signal }) =>
        await new Promise<never>((_, reject) => {
          const onAbort = () => {
            dispatcherAborted = true;
            reject(new Error('host call aborted'));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const outcome = await manager.exec({
      timeoutMs: 500,
      code: 'await nodeRepl.invokeHost("example", "wait", {});',
    });

    expect(outcome.status).toBe('timeout');
    expect(outcome.stats.kernelReplaced).toBe(false);
    expect(dispatcherAborted).toBe(true);

    const followUp = await manager.exec({
      timeoutMs: 5_000,
      code: 'nodeRepl.write("still alive");',
    });
    expect(followUp.status).toBe('ok');
    expect(followUp.stats.pid).toBe(outcome.stats.pid);
  }, 15_000);

  it('bounds cancellation when a host call ignores its signal', async () => {
    let hostSignal: AbortSignal | undefined;
    const manager = createManager(async ({ signal }) => {
      hostSignal = signal;
      return await new Promise<never>(() => undefined);
    });
    const outcome = await manager.exec({
      timeoutMs: 100,
      code: 'await nodeRepl.invokeHost("example", "wait", {});',
    });

    expect(outcome.status).toBe('timeout');
    expect(outcome.stats.kernelReplaced).toBe(true);
    expect(outcome.stats.durationMs).toBeLessThan(5_000);
    expect(outcome.error?.message).toContain(
      'did not acknowledge cancellation',
    );
    expect(hostSignal?.aborted).toBe(true);

    const followUp = await manager.exec({
      timeoutMs: 5_000,
      code: 'nodeRepl.write("restarted");',
    });
    expect(followUp.status).toBe('ok');
    expect(followUp.stats.generation).toBeGreaterThan(outcome.stats.generation);
  }, 15_000);

  it('rejects host calls locally when no dispatcher is configured', async () => {
    const manager = createManager();
    const outcome = await manager.exec({
      timeoutMs: 5_000,
      code: 'await nodeRepl.invokeHost("example", "read", {});',
    });

    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toContain(
      'Host capabilities are not enabled',
    );
    expect(outcome.stats.kernelReplaced).toBe(false);
  }, 15_000);
});

function createManager(
  hostCallDispatcher?: ConstructorParameters<
    typeof NodeReplKernelManager
  >[0]['hostCallDispatcher'],
): NodeReplKernelManager {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-host-call-'));
  roots.push(root);
  const manager = new NodeReplKernelManager({
    cwd: root,
    homeDir: os.homedir(),
    tmpRootDir: path.join(root, 'tmp'),
    readableRoots: [root],
    policy: NodeReplSecurityPolicy.default(),
    hostCallDispatcher,
  });
  managers.push(manager);
  return manager;
}
