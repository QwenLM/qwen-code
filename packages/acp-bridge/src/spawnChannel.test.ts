/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `defaultSpawnChannelFactory`'s security-critical env
 * scrubbing (wenshao #4319 Critical fold-in). The wider 174-test
 * `httpAcpBridge.test.ts` suite uses mock channels and never spawns a
 * real child, so none of those tests exercise `defaultSpawnChannelFactory`
 * or `scrubChildEnv` directly. These tests close that gap.
 *
 * Why this matters: now that `defaultSpawnChannelFactory` is a public
 * export of `@qwen-code/acp-bridge`, channels (`packages/channels/base/
 * AcpBridge.ts`) and the VSCode IDE companion will consume it directly
 * and cannot rely on cli-package integration tests for env-scrubbing
 * guarantees. The scrubbing logic protects against:
 *
 *   - `QWEN_SERVER_TOKEN` (the daemon's own bearer token) leaking into
 *     the spawned agent's environment, where prompt-injection could
 *     turn the agent into an authenticated client of its own daemon.
 *   - `QWEN_CODE_SIMPLE` leaking from the daemon/IDE process into
 *     per-session ACP children, where it would silently suppress skills.
 *   - An `overrides` map smuggling a scrubbed key BACK into the child
 *     env (defense-in-depth — operators / embedders can pass overrides,
 *     but the denylist still wins).
 *   - An `overrides` map with `undefined` value silently failing to
 *     delete a stale inherited var (PR 14 fix #4247 wenshao R5 —
 *     the `run-qwen-serve.ts:216` use case).
 *
 * Each branch listed below is now regression-guarded by an assertion.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { ClientSideConnection } from '@agentclientprotocol/sdk';
import { ProcessRegistry } from './process-registry.js';
import { createChildHeapPolicy } from './child-heap-policy.js';
import { resolveDaemonMemoryBudget } from './daemon-memory-budget.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile, mockSpawn, mockSpawnSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockSpawn: vi.fn(),
  mockSpawnSync: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: mockExecFile,
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
  };
});

import {
  DAEMON_ACP_NDJSON_LIMITS,
  createSpawnChannelFactory,
  createStderrForwarder,
  getAcpMemoryArgs,
  scrubChildEnv,
} from './spawnChannel.js';

function createFakeChildProcess(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
    const signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    child.emit('exit', null, signalCode);
    return true;
  });
  return child as unknown as ChildProcess;
}

beforeEach(() => {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(
      Object.assign(new Error('mock process lookup failure'), {
        code: 'ENOENT',
      }),
      '',
      '',
    );
    return new EventEmitter();
  });
  mockSpawnSync.mockReturnValue({
    error: Object.assign(new Error('mock process lookup failure'), {
      code: 'ENOENT',
    }),
    status: null,
    stderr: '',
    stdout: '',
  });
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (pid < 0) {
      throw Object.assign(new Error('missing fake process group'), {
        code: 'ESRCH',
      });
    }
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockExecFile.mockReset();
  mockSpawnSync.mockReset();
});

function expectedTreeFallbackSignal(): NodeJS.Signals {
  return process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
}

describe('createSpawnChannelFactory env policy', () => {
  const originalArgv1 = process.argv[1];
  let originalSimple: string | undefined;
  let originalServerToken: string | undefined;
  let originalGuardToken: string | undefined;
  let originalCliEntry: string | undefined;
  let originalRuntimeOnlyForTest: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    originalSimple = process.env['QWEN_CODE_SIMPLE'];
    originalServerToken = process.env['QWEN_SERVER_TOKEN'];
    originalGuardToken = process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'];
    originalCliEntry = process.env['QWEN_CLI_ENTRY'];
    originalRuntimeOnlyForTest = process.env['RUNTIME_ONLY_FOR_TEST'];
    process.argv[1] = '/tmp/qwen.js';
    process.env['QWEN_CODE_SIMPLE'] = '1';
    process.env['QWEN_SERVER_TOKEN'] = 'secret';
    process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'] = 'guard-secret';
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    if (originalSimple === undefined) {
      delete process.env['QWEN_CODE_SIMPLE'];
    } else {
      process.env['QWEN_CODE_SIMPLE'] = originalSimple;
    }
    if (originalServerToken === undefined) {
      delete process.env['QWEN_SERVER_TOKEN'];
    } else {
      process.env['QWEN_SERVER_TOKEN'] = originalServerToken;
    }
    if (originalGuardToken === undefined) {
      delete process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'];
    } else {
      process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'] = originalGuardToken;
    }
    if (originalCliEntry === undefined) {
      delete process.env['QWEN_CLI_ENTRY'];
    } else {
      process.env['QWEN_CLI_ENTRY'] = originalCliEntry;
    }
    if (originalRuntimeOnlyForTest === undefined) {
      delete process.env['RUNTIME_ONLY_FOR_TEST'];
    } else {
      process.env['RUNTIME_ONLY_FOR_TEST'] = originalRuntimeOnlyForTest;
    }
  });

  it('scrubs daemon-only env vars from the spawned ACP child', async () => {
    mockSpawn.mockReturnValue(createFakeChildProcess());

    const factory = createSpawnChannelFactory();
    await factory('/tmp/project', {
      QWEN_CODE_SIMPLE: '1',
      QWEN_SERVER_TOKEN: 'override-secret',
      QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN: 'override-guard-secret',
    });

    const spawnOptions = mockSpawn.mock.calls[0]?.[2] as
      | {
          detached?: boolean;
          env?: NodeJS.ProcessEnv;
          windowsHide?: boolean;
        }
      | undefined;
    expect(spawnOptions?.windowsHide).toBe(true);
    expect(spawnOptions?.detached).toBe(process.platform !== 'win32');
    expect(spawnOptions?.env).not.toHaveProperty('QWEN_CODE_SIMPLE');
    expect(spawnOptions?.env).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(spawnOptions?.env).not.toHaveProperty(
      'QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN',
    );
    expect(spawnOptions?.env?.['QWEN_CODE_NO_RELAUNCH']).toBe('true');
  });

  it('marks the spawned ACP child as daemon-spawned for telemetry', async () => {
    mockSpawn.mockReturnValue(createFakeChildProcess());

    const factory = createSpawnChannelFactory();
    await factory('/tmp/project');

    const spawnOptions = mockSpawn.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(spawnOptions?.env?.['QWEN_CODE_SERVE']).toBe('1');
  });

  it('attaches the spawned ACP child as an owned process tree', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const registry = new ProcessRegistry();
    const reserve = registry.reserve.bind(registry);
    let attachmentOptions:
      | Parameters<ReturnType<ProcessRegistry['reserve']>['attach']>[1]
      | undefined;
    vi.spyOn(registry, 'reserve').mockImplementation(() => {
      const reservation = reserve();
      const attach = reservation.attach.bind(reservation);
      vi.spyOn(reservation, 'attach').mockImplementation(
        (attachedChild, options) => {
          attachmentOptions = options;
          return attach(attachedChild, options);
        },
      );
      return reservation;
    });

    await createSpawnChannelFactory({ processRegistry: registry })(
      '/tmp/project',
    );

    expect(attachmentOptions).toEqual({ ownsProcessTree: true });
  });

  it('passes optional child args after --acp', async () => {
    mockSpawn.mockReturnValue(createFakeChildProcess());

    const factory = createSpawnChannelFactory({
      extraArgs: ['--experimental-lsp'],
    });
    await factory('/tmp/project');

    const args = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
    expect(args?.slice(-2)).toEqual(['--acp', '--experimental-lsp']);
  });

  it('builds child env and cli entry from sourceEnv when provided', async () => {
    mockSpawn.mockReturnValue(createFakeChildProcess());
    process.env['QWEN_CLI_ENTRY'] = '/process/qwen.js';
    process.env['RUNTIME_ONLY_FOR_TEST'] = 'from-process';

    const factory = createSpawnChannelFactory({
      sourceEnv: {
        QWEN_CLI_ENTRY: '/runtime/qwen.js',
        RUNTIME_ONLY_FOR_TEST: 'from-runtime',
        QWEN_SERVER_TOKEN: 'runtime-secret',
        QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN: 'runtime-guard-secret',
      },
    });
    await factory('/tmp/project');

    const args = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
    const spawnOptions = mockSpawn.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(args).toContain('/runtime/qwen.js');
    expect(args).not.toContain('/process/qwen.js');
    expect(spawnOptions?.env?.['RUNTIME_ONLY_FOR_TEST']).toBe('from-runtime');
    expect(spawnOptions?.env).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(spawnOptions?.env).not.toHaveProperty(
      'QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN',
    );
  });

  it('threads NDJSON pipe hooks through daemon-side spawned channels', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const onMessageSent = vi.fn();
    const onMessageReceived = vi.fn();
    const factory = createSpawnChannelFactory({
      pipeHooks: { onMessageSent, onMessageReceived },
    });
    const channel = await factory('/tmp/project');
    const writer = channel.stream.writable.getWriter();
    const reader = channel.stream.readable.getReader();

    await writer.write({ jsonrpc: '2.0', method: 'daemon-to-child' });
    (child.stdout as PassThrough).write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'child-to-daemon' })}\n`,
    );
    await expect(reader.read()).resolves.toMatchObject({
      value: { jsonrpc: '2.0', method: 'child-to-daemon' },
      done: false,
    });

    expect(onMessageSent).toHaveBeenCalledWith(
      Buffer.byteLength(
        JSON.stringify({ jsonrpc: '2.0', method: 'daemon-to-child' }),
      ),
    );
    expect(onMessageReceived).toHaveBeenCalledWith(
      Buffer.byteLength(
        JSON.stringify({ jsonrpc: '2.0', method: 'child-to-daemon' }),
      ),
    );

    reader.releaseLock();
    writer.releaseLock();
  });

  it('terminates the tracked child when a bounded pipe fails', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const factory = createSpawnChannelFactory({
      pipeLimits: {
        maxFrameBytes: 16,
        maxQueuedMessages: 2,
        maxQueuedBytes: 32,
      },
    });
    const channel = await factory('/tmp/project');
    const reader = channel.stream.readable.getReader();

    (child.stdout as PassThrough).write('x'.repeat(17));

    await expect(reader.closed).resolves.toBeUndefined();
    await expect(channel.transportFailed).resolves.toMatchObject({
      code: 'ndjson_frame_too_large',
    });
    await vi.waitFor(() =>
      expect(child.kill).toHaveBeenCalledWith(expectedTreeFallbackSignal()),
    );
    reader.releaseLock();
  });

  it('rejects invalid known-method params before ACP SDK validation', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = await createSpawnChannelFactory({
      pipeLimits: {
        maxFrameBytes: 4096,
        maxQueuedMessages: 4,
        maxQueuedBytes: 16_384,
      },
    })('/tmp/project');
    const connection = new ClientSideConnection(
      () => ({}) as never,
      channel.stream,
    );

    (child.stdout as PassThrough).write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'terminal/create',
        params: { command: 'true', sessionId: 'session', args: [1] },
      })}\n`,
    );

    await expect(channel.transportFailed).resolves.toMatchObject({
      code: 'ndjson_invalid_message',
    });
    await expect(connection.closed).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls[0]?.[0]).toBe('Failed to parse JSON message:');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(
      'Error handling request',
    );
    stderr.mockRestore();
  });

  it('terminates a bounded child that closes stdout without exiting', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const channel = await createSpawnChannelFactory({
      pipeLimits: {
        maxFrameBytes: 4096,
        maxQueuedMessages: 4,
        maxQueuedBytes: 16_384,
      },
    })('/tmp/project');
    const connection = new ClientSideConnection(
      () => ({}) as never,
      channel.stream,
    );

    (child.stdout as PassThrough).end();

    await expect(channel.transportFailed).resolves.toMatchObject({
      code: 'ndjson_unexpected_eof',
    });
    await expect(connection.closed).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(child.kill).toHaveBeenCalledWith(expectedTreeFallbackSignal()),
    );
  });

  it('terminates the tracked child when outbound serialization fails', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const factory = createSpawnChannelFactory({
      pipeLimits: {
        maxFrameBytes: 1024,
        maxQueuedMessages: 2,
        maxQueuedBytes: 2048,
      },
    });
    const channel = await factory('/tmp/project');
    const writer = channel.stream.writable.getWriter();
    const cyclic: Record<string, unknown> = {
      jsonrpc: '2.0',
      method: 'cycle',
    };
    cyclic['self'] = cyclic;

    await expect(writer.write(cyclic as never)).rejects.toBeInstanceOf(
      TypeError,
    );
    await vi.waitFor(() =>
      expect(child.kill).toHaveBeenCalledWith(expectedTreeFallbackSignal()),
    );
    writer.releaseLock();
  });

  it('holds prepared response bytes until the response is written', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const factory = createSpawnChannelFactory({
      pipeLimits: {
        maxFrameBytes: 4096,
        maxQueuedMessages: 2,
        maxQueuedBytes: 5000,
      },
    });
    const channel = await factory('/tmp/project');
    const writer = channel.stream.writable.getWriter();
    const first = { text: 'x'.repeat(1000) };
    const second = { text: 'y'.repeat(1000) };
    const third = { text: 'z'.repeat(1000) };

    const releaseOutbound = channel.transportGuard?.reserveOutboundOperation([
      'method',
      { optional: undefined },
    ]);
    releaseOutbound?.();
    expect(() =>
      channel.transportGuard?.reservePreparedResponse(first),
    ).not.toThrow();
    await writer.write({ jsonrpc: '2.0', id: 1, result: first });
    expect(() =>
      channel.transportGuard?.reservePreparedResponse(second),
    ).not.toThrow();
    expect(() =>
      channel.transportGuard?.reservePreparedResponse(third),
    ).toThrow('NDJSON decoded queue is full');

    await expect(channel.transportFailed).resolves.toMatchObject({
      code: 'ndjson_queue_limit_exceeded',
    });
    await vi.waitFor(() =>
      expect(child.kill).toHaveBeenCalledWith(expectedTreeFallbackSignal()),
    );
    writer.releaseLock();
  });

  it('stops estimating a large response once its byte budget is exceeded', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const channel = await createSpawnChannelFactory({
      pipeLimits: {
        maxFrameBytes: 64_000,
        maxQueuedMessages: 2,
        maxQueuedBytes: 5_000,
      },
    })('/tmp/project');
    let elementReads = 0;
    const response = new Proxy(
      Array.from({ length: 10_000 }, () => 0),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) {
            elementReads++;
          }
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) {
            elementReads++;
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    expect(() =>
      channel.transportGuard?.reservePreparedResponse(response),
    ).toThrow('NDJSON decoded queue is full');
    expect(elementReads).toBeLessThan(1_000);
    await expect(channel.transportFailed).resolves.toMatchObject({
      code: 'ndjson_queue_limit_exceeded',
    });
  });

  it('charges JSON string escaping before admitting prepared responses', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const channel = await createSpawnChannelFactory({
      pipeLimits: {
        maxFrameBytes: 64_000,
        maxQueuedMessages: 2,
        maxQueuedBytes: 6_000,
      },
    })('/tmp/project');
    const response = {
      content: '\u0001'.repeat(700),
    };

    expect(() =>
      channel.transportGuard?.reservePreparedResponse(response),
    ).toThrow('NDJSON decoded queue is full');
    await expect(channel.transportFailed).resolves.toMatchObject({
      code: 'ndjson_queue_limit_exceeded',
    });
  });

  it('keeps the default factory unbounded and validates opt-in limits early', () => {
    expect(DAEMON_ACP_NDJSON_LIMITS).toEqual({
      maxFrameBytes: 64 * 1024 * 1024,
      maxQueuedMessages: 256,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    expect(() => createSpawnChannelFactory()).not.toThrow();
    expect(() =>
      createSpawnChannelFactory({
        pipeLimits: {
          maxFrameBytes: 0,
          maxQueuedMessages: 1,
          maxQueuedBytes: 1,
        },
      }),
    ).toThrow('maxFrameBytes must be a positive safe integer');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('settles exited on an async spawn error only when no process exists', async () => {
    const child = createFakeChildProcess();
    Object.defineProperty(child, 'pid', { value: undefined });
    mockSpawn.mockReturnValue(child);
    const channel = await createSpawnChannelFactory()('/tmp/project');

    child.emit('error', new Error('ENOENT'));

    await expect(channel.exited).resolves.toBeUndefined();
  });

  it('does not treat a post-spawn error as process exit', async () => {
    const child = createFakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const channel = await createSpawnChannelFactory()('/tmp/project');
    let settled = false;
    void channel.exited.then(() => {
      settled = true;
    });

    child.emit('spawn');
    child.emit('error', new Error('transport error'));
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('exit', 1, null);
    await expect(channel.exited).resolves.toEqual({
      exitCode: 1,
      signalCode: null,
    });
  });
});

describe('createSpawnChannelFactory child-heap observation', () => {
  const originalArgv1 = process.argv[1];
  const budget = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });

  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(createFakeChildProcess());
    process.argv[1] = '/tmp/qwen.js';
    process.env['QWEN_CLI_ENTRY'] = '/tmp/qwen.js';
  });
  afterEach(() => {
    process.argv[1] = originalArgv1;
    delete process.env['QWEN_CLI_ENTRY'];
  });

  it('leaves argv byte-identical while counting what it would have refused', async () => {
    const policy = createChildHeapPolicy({ budget, mode: 'observe' });
    const registry = new ProcessRegistry();
    const factory = createSpawnChannelFactory({
      processRegistry: registry,
      childHeapPolicy: policy,
    });
    // Non-null because the mode is `observe`; `off` publishes no limit.
    const limit = policy.snapshot().maxConcurrentChildren!;

    for (let i = 0; i < limit + 2; i++) await factory(`/tmp/w${i}`);
    const observed = mockSpawn.mock.calls.at(-1)?.[1] as string[];

    mockSpawn.mockClear();
    await createSpawnChannelFactory({ processRegistry: new ProcessRegistry() })(
      '/tmp/w0',
    );
    const bare = mockSpawn.mock.calls[0]?.[1] as string[];

    // Nothing applied: passing a derived --max-old-space-size would change the
    // child's GC and OOM behaviour, which an observing mode may not do.
    expect(observed).toEqual(bare);
    // Every spawn still went through — and the two past the modeled limit are
    // counted, which is the whole product of this mode.
    expect(registry.committedProcessCount).toBe(limit + 2);
    expect(policy.snapshot().refusals).toBe(2);
  });

  it('releases the reservation when a supplied policy throws', async () => {
    // `childHeapPolicy` is a public factory option, so `decide()` is caller
    // code and may throw. The reservation is taken before it runs; if the
    // throw escapes without cancelling, the token is held for the process
    // lifetime and every later spawn sees an inflated committed count.
    const registry = new ProcessRegistry();
    const factory = createSpawnChannelFactory({
      processRegistry: registry,
      childHeapPolicy: {
        decide: () => {
          throw new Error('policy exploded');
        },
        snapshot: () => {
          throw new Error('unused');
        },
      },
    });

    await expect(factory('/tmp/w0')).rejects.toThrow('policy exploded');

    // Nothing was spawned, so nothing may remain committed. A leak shows up
    // here as 1 — the reservation that outlived its own spawn.
    expect(registry.committedProcessCount).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('createStderrForwarder', () => {
  it('calls onDiagnosticLine for each complete line', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[test] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('hello\nworld\n');
    expect(captured).toEqual([
      { line: '[test] hello', level: 'warn' },
      { line: '[test] world', level: 'warn' },
    ]);
    // Also writes to process.stderr
    expect(stderrSpy).toHaveBeenCalledWith('[test] hello\n');
    expect(stderrSpy).toHaveBeenCalledWith('[test] world\n');
    stderrSpy.mockRestore();
  });

  it('buffers partial lines until newline arrives', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('partial');
    expect(captured).toHaveLength(0); // no newline yet
    forwarder.onData(' more\n');
    expect(captured).toEqual([{ line: '[p] partial more', level: 'warn' }]);
    stderrSpy.mockRestore();
  });

  it('flushes buffered content on end', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('partial');
    expect(captured).toHaveLength(0);
    forwarder.onEnd();
    expect(captured).toEqual([{ line: '[p] partial', level: 'warn' }]);
    stderrSpy.mockRestore();
  });

  it('does not call onDiagnosticLine for empty lines', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('\n\n');
    expect(captured).toHaveLength(0);
    stderrSpy.mockRestore();
  });

  it('force-flushes with [truncated] when buffer exceeds 64 KiB cap', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[x] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    // Write 65 KiB without a newline — exceeds the 64 KiB cap
    const bigChunk = 'A'.repeat(65 * 1024);
    forwarder.onData(bigChunk);
    // Should have force-flushed the first 64 KiB with [truncated]
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]!.line).toContain('[truncated]');
    expect(captured[0]!.level).toBe('warn');
    // The flushed line should have the prefix
    expect(captured[0]!.line).toMatch(/^\[x\] /);
    stderrSpy.mockRestore();
  });

  it('redacts credentials from forwarded lines', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('Authorization: Bearer eyJsecret123\n');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.line).not.toContain('eyJsecret123');
    expect(captured[0]!.line).toContain('<redacted>');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('<redacted>'),
    );
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('eyJsecret123'),
    );
    stderrSpy.mockRestore();
  });

  it('redacts credentials in force-truncated lines', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[x] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    const bigChunk = 'Bearer secrettoken123 ' + 'A'.repeat(65 * 1024);
    forwarder.onData(bigChunk);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]!.line).toContain('<redacted>');
    expect(captured[0]!.line).not.toContain('secrettoken123');
    stderrSpy.mockRestore();
  });

  it('redacts credentials flushed via onEnd (partial line)', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('Bearer secrettoken123');
    expect(captured).toHaveLength(0);
    forwarder.onEnd();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.line).not.toContain('secrettoken123');
    expect(captured[0]!.line).toContain('<redacted>');
    stderrSpy.mockRestore();
  });

  it('works without onDiagnosticLine (still writes to stderr)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[no-cb] ',
    });
    forwarder.onData('line1\n');
    expect(stderrSpy).toHaveBeenCalledWith('[no-cb] line1\n');
    stderrSpy.mockRestore();
  });
});

// Decoupled canary: we deliberately hand-roll the test set instead of
// importing `SCRUBBED_CHILD_ENV_KEYS` from `spawnChannel.ts` so the
// helper's behavior (clone + scrub + override + denylist-wins ordering)
// is tested as a pure function with parameterized input, independent
// of any current production denylist. The multi-key test below
// forward-guards expansion when a future sandboxed-agent mode grows
// the production set per the WARNING on `SCRUBBED_CHILD_ENV_KEYS`.
const SCRUBBED = new Set<string>([
  'QWEN_SERVER_TOKEN',
  'QWEN_CODE_SIMPLE',
  'QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN',
]);

describe('scrubChildEnv (defaultSpawnChannelFactory env policy)', () => {
  it('shallow-clones source — never aliases into the live process.env', () => {
    const source = { FOO: 'bar' };
    const result = scrubChildEnv(source, SCRUBBED);
    result['MUTATED'] = 'yes';
    expect(source).not.toHaveProperty('MUTATED');
  });

  it('strips QWEN_SERVER_TOKEN from the child env', () => {
    const source = { QWEN_SERVER_TOKEN: 'super-secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('strips QWEN_CODE_SIMPLE from the child env', () => {
    const source = { QWEN_CODE_SIMPLE: '1', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_CODE_SIMPLE');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('passes through non-scrubbed env vars unchanged', () => {
    const source = {
      OPENAI_API_KEY: 'sk-test',
      DASHSCOPE_API_KEY: 'ds-test',
      HOME: '/home/user',
    };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).toEqual(source);
  });

  it('overrides with a string value ADD the key', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { NEW_KEY: 'new-value' });
    expect(result['NEW_KEY']).toBe('new-value');
  });

  it('overrides with a string value REPLACE an existing key', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { PATH: '/override/bin' });
    expect(result['PATH']).toBe('/override/bin');
  });

  it('overrides with undefined value DELETE the key from the child env (PR 14 fix #4247 wenshao R5)', () => {
    const source = { STALE_VAR: 'leftover', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { STALE_VAR: undefined });
    expect(result).not.toHaveProperty('STALE_VAR');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('overrides CANNOT re-introduce a scrubbed key (defense in depth)', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: 'sneaky-attempt-via-override',
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('overrides CANNOT re-introduce QWEN_CODE_SIMPLE', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_CODE_SIMPLE: '1',
    });
    expect(result).not.toHaveProperty('QWEN_CODE_SIMPLE');
  });

  it('overrides CANNOT undo the scrub by setting undefined for a scrubbed key', () => {
    // Edge case: `undefined` value would normally delete; but for a
    // scrubbed key, the `continue` in the loop short-circuits BEFORE
    // the undefined-vs-string check. The key stays deleted (by the
    // earlier scrub pass) regardless of what overrides says.
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: undefined,
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('overrides are applied AFTER scrub — the denylist always wins', () => {
    // Verifies the documented ordering invariant: even if the scrub
    // and override touch the same key in conflicting ways, scrub wins.
    const source = { QWEN_SERVER_TOKEN: 'from-process-env' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: 'from-override',
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('empty overrides leaves scrub-only behavior intact', () => {
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {});
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('no overrides arg works the same as empty overrides', () => {
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('multi-key scrub set strips every listed key', () => {
    // Forward-compat: if a future sandboxed-agent mode expands the
    // denylist (as the WARNING comment on SCRUBBED_CHILD_ENV_KEYS
    // anticipates), this verifies the loop handles multiple keys.
    const sandboxScrub = new Set<string>([
      'QWEN_SERVER_TOKEN',
      'QWEN_CODE_SIMPLE',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
    ]);
    const source = {
      QWEN_SERVER_TOKEN: 't1',
      QWEN_CODE_SIMPLE: 't2',
      AWS_SECRET_ACCESS_KEY: 't3',
      OPENAI_API_KEY: 't4',
      PATH: '/usr/bin',
    };
    const result = scrubChildEnv(source, sandboxScrub);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result).not.toHaveProperty('QWEN_CODE_SIMPLE');
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result['PATH']).toBe('/usr/bin');
  });
});

describe('getAcpMemoryArgs', () => {
  it('always includes --expose-gc and optionally --max-old-space-size', () => {
    const args = getAcpMemoryArgs();
    expect(args).toContain('--expose-gc');
    const heapArg = args.find((a) => a.startsWith('--max-old-space-size='));
    if (heapArg) {
      const sizeMB = Number(heapArg.split('=')[1]);
      expect(sizeMB).toBeGreaterThan(0);
      expect(sizeMB).toBeLessThanOrEqual(16_384);
    }
  });

  it('respects the 16GB cap', () => {
    const args = getAcpMemoryArgs();
    const heapArg = args.find((a) => a.startsWith('--max-old-space-size='));
    if (heapArg) {
      const sizeMB = Number(heapArg.split('=')[1]);
      expect(sizeMB).toBeLessThanOrEqual(16_384);
    }
  });
});
