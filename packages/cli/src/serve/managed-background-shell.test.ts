/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { getShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import {
  registerSessionProjectDir,
  sessionIdContext,
  unregisterSessionProjectDir,
} from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import type {
  ChildRunExitEvidence,
  ManagedChildRunProcess,
  ManagedChildRunSupervisor,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { HookCommandIsolationUnavailableError } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { ManagedBackgroundShellRegistry } from './managed-background-shell-registry.js';
import {
  ManagedToolExecutor,
  type ManagedShellCapturePublisher,
  type ManagedShellCaptureSink,
  type ManagedToolSet,
} from './managed-runtime-tool-executor.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'managed-background-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fakeChild(unitName: string): ChildProcess & {
  emitExit: (code: number | null, signal: string | null) => void;
} {
  const child = new EventEmitter() as ChildProcess & {
    emitExit: (code: number | null, signal: string | null) => void;
  };
  (child as unknown as { pid: number }).pid = 4242;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout as ChildProcess['stdout'];
  child.stderr = stderr as ChildProcess['stderr'];
  stdout.resume();
  stderr.resume();
  stdout.write(`out:${unitName}\n`);
  stderr.write('');
  child.emitExit = (code, signal) => {
    stdout.end();
    stderr.end();
    child.emit('exit', code, signal ?? null);
  };
  child.kill = (signal) => {
    child.emitExit(null, typeof signal === 'string' ? signal : 'SIGKILL');
    return true;
  };
  return child;
}

function fakeProcess(unitName: string): ManagedChildRunProcess {
  const child = fakeChild(unitName);
  let evidence: ChildRunExitEvidence | null = null;
  child.on('exit', (code, signal) => {
    evidence = {
      exitCode: typeof code === 'number' ? code : null,
      exitSignal: typeof signal === 'string' ? signal : null,
    };
  });
  const process = {
    unitName,
    child,
    get exited() {
      return evidence !== null;
    },
    get evidence() {
      return evidence;
    },
    async terminate(_graceMs: number): Promise<ChildRunExitEvidence | null> {
      if (evidence === null) child.emitExit(null, 'SIGTERM');
      return evidence;
    },
    async settleOnEmpty(): Promise<ChildRunExitEvidence | null> {
      return evidence;
    },
  };
  return process as unknown as ManagedChildRunProcess;
}

interface FakeSink extends ManagedShellCaptureSink {
  readonly writes: Array<readonly [string, string]>;
  readonly finishes: Array<readonly [string, boolean]>;
  pid: number;
  started: boolean;
  failed: boolean;
}

function fakeSink(): FakeSink {
  const writes: Array<readonly [string, string]> = [];
  const finishes: Array<readonly [string, boolean]> = [];
  const sink = {
    writes,
    finishes,
    pid: 0,
    started: false,
    failed: false,
    async write(id: 'stdout' | 'stderr', chunk: Buffer) {
      writes.push([id, chunk.toString()]);
    },
    setStarted(pid: number) {
      sink.started = true;
      sink.pid = pid;
    },
    setProcessResult(_result: unknown) {},
    failCapture() {
      sink.failed = true;
    },
    async finish(id: 'stdout' | 'stderr', complete: boolean) {
      finishes.push([id, complete]);
    },
    async finalize(
      executionStatus: ToolResultEnvelope['executionStatus'],
      responseParts: readonly unknown[],
      error?: { readonly message: string },
    ): Promise<ToolResultEnvelope> {
      return {
        executionStatus,
        responseParts,
        ...(error ? { error } : {}),
        capture: {
          captureStatus: 'complete',
          captureReason: null,
          manifest: null,
          previewTruncated: false,
          deliveryStatus: 'pending',
        },
      } as ToolResultEnvelope;
    },
    identity: {
      captureId: 'capture-1',
      revision: 1,
    } as unknown as ToolResultExpectedIdentity,
  };
  return sink;
}

const IDENTITY = {
  captureId: 'capture-1',
  revision: 1,
} as ToolResultExpectedIdentity;

interface Rig {
  readonly executor: ManagedToolExecutor;
  readonly sink: FakeSink;
  readonly publisher: ManagedShellCapturePublisher & {
    readonly prepares: number;
    readonly preparedRequests: unknown[];
    readonly finished: ToolResultEnvelope[];
  };
  readonly supervisor: {
    start: ReturnType<typeof vi.fn>;
  };
  readonly process: ManagedChildRunProcess;
}

function rig(
  options: {
    withSupervisor?: boolean;
    prepareRejects?: boolean;
    sleepBlocked?: boolean;
  } = {},
): Rig {
  const process = fakeProcess('qwen-bg-call-1');
  const sink = fakeSink();
  const publisher = {
    prepares: 0,
    preparedRequests: [] as unknown[],
    finished: [] as ToolResultEnvelope[],
    async prepare(request: unknown) {
      publisher.prepares += 1;
      publisher.preparedRequests.push(request);
      if (options.prepareRejects === true) {
        throw new Error('publisher route is gone');
      }
      return { identity: IDENTITY, sink, publisher: undefined };
    },
    async finish(_identity: unknown, envelope: ToolResultEnvelope) {
      publisher.finished.push(envelope);
    },
  };
  const supervisor = {
    start: vi.fn(
      (spec: { readonly unitName: string; readonly onOutput: unknown }) =>
        spec.unitName === 'qwen-bg-call-1'
          ? process
          : fakeProcess(spec.unitName),
    ),
  };
  const tool = {
    validateToolParams: (params: Record<string, unknown>) => {
      const command = params['command'];
      if (
        options.sleepBlocked === true &&
        typeof command === 'string' &&
        /^\s*sleep\s/.test(command)
      )
        return 'commands cannot run a standalone sleep as a foreground call';
      return null;
    },
  };
  const tools: ManagedToolSet = {
    sessionId: 'runtime-session-1',
    directory,
    tools: new Map([['run_shell_command', tool]]),
    admitsDirectory: (each: string) => each.startsWith(directory),
  } as unknown as ManagedToolSet;
  const executor = new ManagedToolExecutor(
    async () => tools,
    publisher as unknown as ManagedShellCapturePublisher,
    undefined,
    undefined,
    undefined,
    options.withSupervisor === false
      ? undefined
      : (supervisor as unknown as ManagedChildRunSupervisor),
  );
  return {
    executor,
    sink,
    publisher: publisher as unknown as Rig['publisher'],
    supervisor,
    process,
  };
}

const INPUT = { command: 'echo hi', is_background: true };
const REFERENCE = {
  sessionId: 'rs-1',
  promptId: 'prompt-1',
  callId: 'call-1',
  argsDigest: `sha256:${managedToolDigest(INPUT)}`,
};
const CAPTURE = {
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  executionCallId: 'exec-1',
  bindingGeneration: '1',
  capturePolicy: 'complete_required' as const,
};

function execute(
  ctx: Rig,
  input: Record<string, unknown> = INPUT,
  callId = 'call-1',
) {
  return ctx.executor.executeV3({
    reference: {
      ...REFERENCE,
      callId,
      argsDigest: `sha256:${managedToolDigest(input)}`,
    },
    capture: CAPTURE,
    toolName: 'run_shell_command',
    input,
  });
}

describe('managed v3 Monitor watch', () => {
  const MONITOR_INPUT = { command: 'tail -f build.log', is_monitor: true };

  it('settles a started watch with its detached handle and holds the Session', async () => {
    const ctx = rig();
    const view = await execute(ctx, MONITOR_INPUT);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'success',
        capture: { captureStatus: 'detached', manifest: null },
      },
    });
    expect(ctx.supervisor.start).toHaveBeenCalledWith(
      expect.objectContaining({ unitName: 'qwen-mon-call-1' }),
    );
    expect(ctx.publisher.preparedRequests[0]).toMatchObject({
      capture: { background: true, monitoring: true },
    });
    expect(
      (
        ctx.executor as unknown as {
          monitorRegistry: { countBySession(id: string): number };
        }
      ).monitorRegistry.countBySession('rs-1'),
    ).toBe(1);

    // Watch output lands on the open-ended capture byte for byte — never
    // rebuilt from lines (round-5 finding), and never line-split.
    const spec = ctx.supervisor.start.mock.calls[0]![0] as unknown as {
      onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => unknown;
    };
    spec.onOutput('stdout', Buffer.from('size 1\nsize 2\ntail'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.sink.writes).toEqual([['stdout', 'size 1\nsize 2\ntail']]);
  });

  it('refuses a fifth live watch of one Session', async () => {
    const ctx = rig();
    await execute(ctx, MONITOR_INPUT, 'call-1');
    await execute(ctx, MONITOR_INPUT, 'call-2');
    await execute(ctx, MONITOR_INPUT, 'call-3');
    await execute(ctx, MONITOR_INPUT, 'call-4');
    const fifth = await execute(ctx, MONITOR_INPUT, 'call-5');
    expect(fifth).toMatchObject({
      result: {
        executionStatus: 'not_started',
        error: { message: 'Session already runs 4 Monitor watches.' },
      },
    });
  });

  it('admits an is_monitor long wait past the foreground sleep gate', async () => {
    const ctx = rig({ sleepBlocked: true });
    // Mirror the ShellTool foreground guard the wire shape cannot see: a
    // standalone sleep would be blocked as a foreground long wait, but the
    // monitor family exists so that wait is durable rather than refused.
    const sleepInput = { command: 'sleep 3600', is_monitor: true };
    const view = await ctx.executor.executeV3({
      reference: {
        ...REFERENCE,
        argsDigest: `sha256:${managedToolDigest(sleepInput)}`,
      },
      capture: CAPTURE,
      toolName: 'run_shell_command',
      input: sleepInput,
    });
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'success',
        capture: { captureStatus: 'detached', manifest: null },
      },
    });
    expect(ctx.supervisor.start).toHaveBeenCalledWith(
      expect.objectContaining({ unitName: 'qwen-mon-call-1' }),
    );
  });

  it('refuses a workspace-foreign monitor directory before any capture exists', async () => {
    const ctx = rig();
    const view = await execute(ctx, {
      command: 'tail -f build.log',
      is_monitor: true,
      directory: '/tmp/elsewhere-qwen-watch',
    });
    expect(view).toMatchObject({
      result: {
        executionStatus: 'not_started',
        error: {
          message:
            "Directory '/tmp/elsewhere-qwen-watch' is not within any of the registered workspace directories.",
        },
      },
    });
    expect(ctx.publisher.prepares).toBe(0);
  });

  it('refuses the watch when the Runtime owns no delegated cgroup', async () => {
    const ctx = rig({ withSupervisor: false });
    const view = await execute(ctx, MONITOR_INPUT);
    expect(view).toMatchObject({
      result: {
        executionStatus: 'not_started',
        error: {
          message:
            'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
        },
      },
    });
  });

  it('captures the watch’s stderr byte for byte, like the Shell path', async () => {
    const ctx = rig();
    await execute(ctx, MONITOR_INPUT);
    const spec = ctx.supervisor.start.mock.calls[0]![0] as unknown as {
      onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => unknown;
    };
    spec.onOutput('stdout', Buffer.from('size 42\n'));
    spec.onOutput('stderr', Buffer.from('du: cannot read\n'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.sink.writes).toEqual([
      ['stdout', 'size 42\n'],
      ['stderr', 'du: cannot read\n'],
    ]);
  });

  it('settles the admission instead of parking it when the capture cannot be prepared', async () => {
    const ctx = rig({ prepareRejects: true });
    const view = await execute(ctx, MONITOR_INPUT);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: {
          message:
            'Monitor watch capture could not be prepared: publisher route is gone',
        },
      },
    });
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
    // The same call re-answers from the settled journal, never as a parked
    // 'prepared' entry waiting on nothing.
    const again = await execute(ctx, MONITOR_INPUT);
    expect(again.state).toBe('settled');
  });

  it('holds and drains a live watch on the release route', async () => {
    const ctx = rig();
    await execute(ctx, MONITOR_INPUT);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(true);
    await ctx.executor.stopBackgroundSession('rs-1');
    expect(ctx.publisher.finished).toHaveLength(1);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });

  it('drains a live watch when the worker closes', async () => {
    const ctx = rig();
    await execute(ctx, MONITOR_INPUT);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(true);
    await ctx.executor.close();
    expect(ctx.publisher.finished).toHaveLength(1);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });
});

describe('managed v3 background Shell', () => {
  it('settles the admission instead of parking it when the capture cannot be prepared', async () => {
    const ctx = rig({ prepareRejects: true });
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: {
          message:
            'Background Shell capture could not be prepared: publisher route is gone',
        },
      },
    });
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
    const again = await execute(ctx);
    expect(again.state).toBe('settled');
  });

  it('settles the start when the worker closes mid-admission', async () => {
    const ctx = rig();
    // The close lands between the entry gate and the admission recheck:
    // it must never park the entry either.
    vi.spyOn(ctx.publisher, 'prepare').mockImplementationOnce(async () => {
      (ctx.executor as unknown as { closing: boolean }).closing = true;
      return { identity: IDENTITY, sink: ctx.sink, publisher: undefined };
    });
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: { message: 'Managed Runtime worker is no longer active.' },
      },
    });
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });

  it('slows the pipes while the bounded capture drains', async () => {
    const ctx = rig();
    const stdout = ctx.process.child.stdout!;
    const pauseSpy = vi.spyOn(stdout, 'pause');
    const resumeSpy = vi.spyOn(stdout, 'resume');
    pauseSpy.mockClear();
    resumeSpy.mockClear();

    const deferred: Array<() => void> = [];
    ctx.sink.write = async (id: 'stdout' | 'stderr', chunk: Buffer) => {
      ctx.sink.writes.push([id, chunk.toString()]);
      await new Promise<void>((resolve) => deferred.push(resolve));
    };
    await execute(ctx);

    const spec = ctx.supervisor.start.mock.calls[0]![0] as unknown as {
      onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => unknown;
    };
    const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
    for (let count = 0; count < 17; count++) spec.onOutput('stdout', oneMiB);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(17);

    for (let drained = 0; drained < 12; drained++) deferred.shift()!();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    // 5 MiB still in flight: above the resume watermark.
    expect(resumeSpy).not.toHaveBeenCalled();
    while (deferred.length > 0) deferred.shift()!();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('settles the start result and holds the Runtime until the process exits', async () => {
    const ctx = rig();
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'success',
        capture: { captureStatus: 'detached', manifest: null },
      },
    });
    expect(ctx.supervisor.start).toHaveBeenCalledWith(
      expect.objectContaining({
        unitName: 'qwen-bg-call-1',
        executable: getShellConfiguration().executable,
        args: [...getShellConfiguration().argsPrefix, 'echo hi'],
        cwd: directory,
      }),
    );
    expect(ctx.publisher.prepares).toBe(1);
    expect(ctx.publisher.preparedRequests[0]).toMatchObject({
      capture: { background: true },
    });
    expect(ctx.sink.pid).toBe(4242);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(true);

    // Every pipe chunk lands in the bounded capture sink.
    const spec = ctx.supervisor.start.mock.calls[0]![0] as unknown as {
      onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => unknown;
    };
    spec.onOutput('stdout', Buffer.from('hello bytes'));
    spec.onOutput('stderr', Buffer.from('warn'));
    expect(ctx.sink.writes).toEqual([
      ['stdout', 'hello bytes'],
      ['stderr', 'warn'],
    ]);

    (ctx.process.child as unknown as ReturnType<typeof fakeChild>).emitExit(
      0,
      null,
    );
    const receipt = await (
      ctx.executor as unknown as {
        backgroundRegistry: {
          receipt: (unitName: string) => Promise<{
            evidence: ChildRunExitEvidence | null;
            captureError: string | null;
          }>;
        };
      }
    ).backgroundRegistry.receipt('qwen-bg-call-1')!;
    expect(receipt).toMatchObject({
      evidence: { exitCode: 0, exitSignal: null },
      captureError: null,
    });
    expect(ctx.sink.finishes).toEqual([
      ['stdout', true],
      ['stderr', true],
    ]);
    expect(ctx.publisher.finished).toHaveLength(1);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });

  it('spawns the background child with this Session’s own shell context', async () => {
    // The worker registers the tool set under its composite runtime
    // session key (managed-context-worker.ts: runtimeSessionKey), so the
    // spawn must resolve by tools.sessionId — resolving by the call's
    // raw reference.sessionId would pick that other registration, and a
    // lookup finding nothing would fall back to the worker's
    // first-session global slot.
    registerSessionProjectDir('runtime-session-1', '/proj/runtime-session-1');
    registerSessionProjectDir('rs-1', '/proj/rs-1');
    try {
      const ctx = rig();
      await execute(ctx);
      const env = (
        ctx.supervisor.start.mock.calls[0]![0] as unknown as {
          env: NodeJS.ProcessEnv;
        }
      ).env;
      expect(env['QWEN_CODE_SESSION_ID']).toBe('runtime-session-1');
      expect(env['QWEN_CODE_PROJECT_DIR']).toBe('/proj/runtime-session-1');
    } finally {
      unregisterSessionProjectDir('runtime-session-1');
      unregisterSessionProjectDir('rs-1');
    }
  });

  it('prefers the call’s own session over an ambient context for the environment', async () => {
    registerSessionProjectDir('runtime-session-1', '/proj/runtime-session-1');
    registerSessionProjectDir('rs-ambient', '/proj/rs-ambient');
    try {
      const ctx = rig();
      await sessionIdContext.run('rs-ambient', () => execute(ctx));
      const env = (
        ctx.supervisor.start.mock.calls[0]![0] as unknown as {
          env: NodeJS.ProcessEnv;
        }
      ).env;
      expect(env['QWEN_CODE_SESSION_ID']).toBe('runtime-session-1');
      expect(env['QWEN_CODE_PROJECT_DIR']).toBe('/proj/runtime-session-1');
    } finally {
      unregisterSessionProjectDir('runtime-session-1');
      unregisterSessionProjectDir('rs-ambient');
    }
  });

  it('records an admission refusal when isolation is unavailable', async () => {
    const ctx = rig();
    ctx.supervisor.start.mockImplementation(() => {
      throw new HookCommandIsolationUnavailableError();
    });
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: {
          message:
            'Background Shell requires a delegated Linux cgroup v2 directory on this Runtime.',
        },
      },
    });
    expect(ctx.publisher.prepares).toBe(1);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });

  it('records an admission refusal when no supervisor is configured', async () => {
    const ctx = rig({ withSupervisor: false });
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: {
          message:
            'Background Shell requires a delegated Linux cgroup v2 root on this Runtime.',
          type: 'managed_isolation_root_missing',
        },
      },
    });
    expect(ctx.publisher.prepares).toBe(0);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });

  it('records a distinct cause discriminator for a pre-existing non-empty unit', async () => {
    // One message and no code cannot tell a name collision from a broken
    // deployment: the recorded refusal carries the discriminator, so the
    // model and the task surface branch on what actually failed.
    const ctx = rig();
    ctx.supervisor.start.mockImplementation(() => {
      throw new HookCommandIsolationUnavailableError('unit_not_empty');
    });
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: {
          message:
            'Background Shell requires a delegated Linux cgroup v2 directory: another unit still holds processes under that name on this Runtime.',
          type: 'managed_isolation_unit_not_empty',
        },
      },
    });
    expect(ctx.publisher.prepares).toBe(1);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
    const missing = rig({ withSupervisor: false });
    const missingView = await execute(missing);
    expect(missingView).toMatchObject({
      result: {
        error: { type: 'managed_isolation_root_missing' },
      },
    });
  });

  it('records an admission refusal for a directory outside the workspace', async () => {
    const ctx = rig();
    const view = await execute(ctx, {
      command: 'echo hi',
      is_background: true,
      directory: '/somewhere-else',
    });
    expect(view).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'not_started', capture: null },
    });
    expect(ctx.publisher.prepares).toBe(0);
    expect(ctx.supervisor.start).not.toHaveBeenCalled();
  });

  it('refuses the ninth live background Shell as a committed quota refusal', async () => {
    const ctx = rig();
    for (let index = 0; index < 8; index++) {
      const view = await execute(ctx, INPUT, `call-bg-${index}`);
      expect(view.state).toBe('settled');
    }
    expect(ctx.publisher.prepares).toBe(8);
    const ninth = await execute(ctx, INPUT, 'call-bg-9');
    expect(ninth).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: { message: 'Session already runs 8 background Shells.' },
      },
    });
    expect(ctx.publisher.prepares).toBe(8);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(true);
  });

  it('joins a repeated start call without a second process', async () => {
    const ctx = rig();
    const first = await execute(ctx);
    const again = await execute(ctx);
    expect(again.result).toEqual(first.result);
    expect(ctx.supervisor.start).toHaveBeenCalledTimes(1);
    expect(ctx.publisher.prepares).toBe(1);
  });

  it('acknowledges the start handle exactly with a null manifest', async () => {
    const ctx = rig();
    await execute(ctx);
    const accepted = ctx.executor.acknowledgeV3(REFERENCE, {
      executionCallId: 'exec-1',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    expect(accepted.state).toBe('settled');
    expect(() =>
      ctx.executor.acknowledgeV3(REFERENCE, {
        executionCallId: 'exec-1',
        manifest: {
          resourceId: 'other-manifest',
          kind: 'managed-tool-result-manifest',
          schemaVersion: 1,
          byteLength: 2,
          digest: 'f'.repeat(64),
        },
        deliveryStatus: 'blocked',
        historyRevision: null,
      }),
    ).toThrow(/conflicts/);
  });

  it('drains a spawn-time process error instead of holding forever', async () => {
    const ctx = rig();
    await execute(ctx);
    const child = ctx.process.child as unknown as ReturnType<typeof fakeChild>;
    (child.stdout as unknown as PassThrough).end();
    (child.stderr as unknown as PassThrough).end();
    child.emit('error', new Error('spawn refused'));
    const receipt = await (
      ctx.executor as unknown as {
        backgroundRegistry: {
          receipt: (unitName: string) => Promise<{
            evidence: ChildRunExitEvidence | null;
            captureError: string | null;
          }>;
        };
      }
    ).backgroundRegistry.receipt('qwen-bg-call-1')!;
    expect(receipt).toMatchObject({
      evidence: null,
      captureError: 'spawn refused',
    });
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });

  it('drains the registry on close and releases the hold', async () => {
    const ctx = rig();
    await execute(ctx);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(true);
    await ctx.executor.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.process.evidence).toEqual({
      exitCode: null,
      exitSignal: 'SIGTERM',
    });
    expect(ctx.publisher.finished).toHaveLength(1);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
  });

  it('caps a pipe that a surviving descendant keeps open', async () => {
    // Evidence exists, but the pipes never end — inherited by a daemon.
    const process = fakeProcess('qwen-bg-capped');
    (process.child as unknown as EventEmitter).emit('exit', 0, null);
    const sink = fakeSink();
    const publisher = {
      finished: [] as ToolResultEnvelope[],
      async finish(_identity: unknown, envelope: ToolResultEnvelope) {
        publisher.finished.push(envelope);
      },
    };
    const registry = new ManagedBackgroundShellRegistry(25);
    const receipt = await registry.register({
      unitName: 'qwen-bg-capped',
      sessionId: 'rs-1',
      process,
      sink,
      publisher: publisher as unknown as ManagedShellCapturePublisher,
      identity: IDENTITY,
    });
    expect(receipt.evidence).toEqual({ exitCode: 0, exitSignal: null });
    expect(sink.finishes).toEqual([
      ['stdout', false],
      ['stderr', false],
    ]);
    expect(publisher.finished).toHaveLength(1);
    expect(registry.hasHolds('rs-1')).toBe(false);
  });
});
