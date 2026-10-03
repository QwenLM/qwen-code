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
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import type { ChildRunExitEvidence , ManagedChildRunProcess } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { HookCommandIsolationUnavailableError } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
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

function fakeChild(
  unitName: string,
): ChildProcess & {
  emitExit: (code: number | null, signal: string | null) => void;
} {
  const child = new EventEmitter() as ChildProcess & {
    emitExit: (code: number | null, signal: string | null) => void;
  };
  (child as unknown as { pid: number }).pid = 4242;
  child.stdout = new PassThrough() as ChildProcess['stdout'];
  child.stderr = new PassThrough() as ChildProcess['stderr'];
  child.stdout!.resume();
  child.stderr!.resume();
  child.stdout!.write(`out:${unitName}\n`);
  child.stderr!.write('');
  child.emitExit = (code, signal) => {
    child.stdout!.end();
    child.stderr!.end();
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
  };
  return process as unknown as ManagedChildRunProcess;
}

interface FakeSink extends ManagedShellCaptureSink {
  readonly writes: Array<readonly [string, string]>;
  readonly finishes: Array<readonly [string, boolean]>;
  pid: number;
  started: boolean;
}

function fakeSink(): FakeSink {
  const writes: Array<readonly [string, string]> = [];
  const finishes: Array<readonly [string, boolean]> = [];
  const sink = {
    writes,
    finishes,
    pid: 0,
    started: false,
    async write(id: 'stdout' | 'stderr', chunk: Buffer) {
      writes.push([id, chunk.toString()]);
    },
    setStarted(pid: number) {
      sink.started = true;
      sink.pid = pid;
    },
    setProcessResult(_result: unknown) {},
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
  return sink as unknown as FakeSink;
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
    readonly finished: ToolResultEnvelope[];
  };
  readonly supervisor: {
    start: ReturnType<typeof vi.fn>;
  };
  readonly process: ManagedChildRunProcess;
}

function rig(options: { withSupervisor?: boolean } = {}): Rig {
  const process = fakeProcess('qwen-bg-call-1');
  const sink = fakeSink();
  const publisher = {
    prepares: 0,
    finished: [] as ToolResultEnvelope[],
    async prepare() {
      publisher.prepares += 1;
      return { identity: IDENTITY, sink, publisher: undefined };
    },
    async finish(_identity: unknown, envelope: ToolResultEnvelope) {
      publisher.finished.push(envelope);
    },
  };
  const supervisor = {
    start: vi.fn(() => process),
  };
  const tool = { validateToolParams: () => null };
  const tools: ManagedToolSet = {
    sessionId: 'runtime-session-1',
    directory,
    tools: new Map([['run_shell_command', tool]]),
    admitsDirectory: (each) => each.startsWith(directory),
  } as unknown as ManagedToolSet;
  const executor = new ManagedToolExecutor(
    async () => tools,
    publisher as unknown as ManagedShellCapturePublisher,
    undefined,
    undefined,
    options.withSupervisor === false
      ? undefined
      : (supervisor as unknown as { start: never }),
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

function execute(ctx: Rig, input: Record<string, unknown> = INPUT) {
  return ctx.executor.executeV3({
    reference: {
      ...REFERENCE,
      argsDigest: `sha256:${managedToolDigest(input)}`,
    },
    capture: CAPTURE,
    toolName: 'run_shell_command',
    input,
  });
}

describe('managed v3 background Shell', () => {
  it('settles the start result and holds the Runtime until the process exits', async () => {
    const ctx = rig();
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'success', capture: null },
    });
    expect(ctx.supervisor.start).toHaveBeenCalledWith(
      expect.objectContaining({
        unitName: 'qwen-bg-call-1',
        executable: '/bin/sh',
        args: ['-c', 'echo hi'],
        cwd: directory,
      }),
    );
    expect(ctx.publisher.prepares).toBe(1);
    expect(ctx.sink.pid).toBe(4242);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(true);

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

  it('records an admission refusal when isolation is unavailable', async () => {
    const ctx = rig();
    ctx.supervisor.start.mockImplementation(() => {
      throw new HookCommandIsolationUnavailableError();
    });
    const view = await execute(ctx);
    expect(view).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'error',
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
        executionStatus: 'error',
        capture: null,
        error: {
          message:
            'Background Shell requires a delegated Linux cgroup v2 root on this Runtime.',
        },
      },
    });
    expect(ctx.publisher.prepares).toBe(0);
    expect(ctx.executor.hasActiveSession('rs-1')).toBe(false);
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
      result: { executionStatus: 'error', capture: null },
    });
    expect(ctx.publisher.prepares).toBe(0);
    expect(ctx.supervisor.start).not.toHaveBeenCalled();
  });

  it('acknowledges the start handle exactly with a null manifest', async () => {
    const ctx = rig();
    await execute(ctx);
    const accepted = ctx.executor.acknowledgeV3(REFERENCE, {
      executionCallId: 'exec-1',
      manifest: null,
      deliveryStatus: 'committed',
      historyRevision: 1,
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
        deliveryStatus: 'committed',
        historyRevision: 1,
      }),
    ).toThrow(/conflicts/);
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
});
