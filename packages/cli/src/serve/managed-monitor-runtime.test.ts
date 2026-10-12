/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type {
  ChildRunExitEvidence,
  ManagedChildRunProcess,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import { monitorUnitNameOf } from '@qwen-code/qwen-code-core/managed-runtime/managed-monitor-protocol.js';
import type {
  ManagedShellCapturePublisher,
  ManagedShellCaptureSink,
} from './managed-runtime-tool-executor.js';
import { ManagedMonitorRegistry } from './managed-monitor-registry.js';
import {
  ManagedMonitorError,
  ManagedMonitorRuntime,
} from './managed-monitor-runtime.js';

const SESSION = 'runtime-session-1';
const TARGET = 'watch.call-1';
const UNIT = monitorUnitNameOf(TARGET);
const SCOPE = { tenantId: 'tenant', sessionId: 'session' };

function operation(kind: string, extra: Record<string, unknown> = {}) {
  return {
    kind,
    sessionKey: SCOPE,
    operationId: TARGET,
    targetOperationId: TARGET,
    ...extra,
  };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.resume();
  stderr.resume();
  stdout.end();
  stderr.end();
  child.stdout = stdout as ChildProcess['stdout'];
  child.stderr = stderr as ChildProcess['stderr'];
  return child;
}

function fakeWatch(
  spec: {
    unitName?: string;
    terminateEvidence?: ChildRunExitEvidence | null;
    preExited?: ChildRunExitEvidence | null;
  } = {},
): ManagedChildRunProcess {
  const child = fakeChild();
  let current = spec.preExited ?? null;
  child.on('exit', (code, signal) => {
    current = {
      exitCode: typeof code === 'number' ? code : null,
      exitSignal: typeof signal === 'string' ? signal : null,
    };
  });
  return {
    unitName: spec.unitName ?? UNIT,
    child,
    get exited() {
      return current !== null;
    },
    get evidence() {
      return current;
    },
    async terminate(): Promise<ChildRunExitEvidence | null> {
      if (current === null && spec.terminateEvidence !== null) {
        const next = spec.terminateEvidence ?? {
          exitCode: 0,
          exitSignal: null,
        };
        child.emit('exit', next.exitCode, next.exitSignal);
      }
      return current;
    },
    async settleOnEmpty(): Promise<ChildRunExitEvidence | null> {
      return current;
    },
  } as unknown as ManagedChildRunProcess;
}

function doubles() {
  const sink: ManagedShellCaptureSink & { identity: unknown } = {
    identity: {
      tenantId: 'tenant',
      sessionId: 'session',
      turnId: 'turn',
      executionCallId: 'exec',
      callId: 'call',
      invocationDigest: 'sh',
      bindingGeneration: '1',
      captureId: 'capture-1',
      revision: 1,
    },
    async write() {},
    setStarted() {},
    setProcessResult() {},
    failCapture() {},
    async finish() {},
    async finalize(
      executionStatus: ToolResultEnvelope['executionStatus'],
      responseParts: readonly unknown[],
    ): Promise<ToolResultEnvelope> {
      return { executionStatus, responseParts, capture: null };
    },
  };
  const publisher = {
    async prepare() {
      throw new Error('unused');
    },
    async finish() {},
    async accept() {
      throw new Error('unused');
    },
  };
  return {
    sink,
    publisher: publisher as unknown as ManagedShellCapturePublisher,
  };
}

function register(
  registry: ManagedMonitorRegistry,
  spec: Parameters<typeof fakeWatch>[0] & { sessionId?: string } = {},
) {
  const process = fakeWatch(spec);
  const stored = doubles();
  const completion = registry.register({
    unitName: spec.unitName ?? UNIT,
    sessionId: spec.sessionId ?? SESSION,
    process,
    sink: stored.sink as ManagedShellCaptureSink,
    publisher: stored.publisher,
    identity: stored.sink.identity as Parameters<
      typeof registry.register
    >[0]['identity'],
  });
  return { process, completion };
}

describe('ManagedMonitorRuntime', () => {
  it('refuses envelopes and kinds outside the closed shape', async () => {
    const runtime = new ManagedMonitorRuntime(new ManagedMonitorRegistry());
    for (const candidate of [
      { ...operation('monitor-status'), operationId: '' },
      { ...operation('monitor-status'), kind: 'monitor-erase' },
      { ...operation('monitor-status'), extra: true },
      { kind: 'monitor-status' },
      { ...operation('monitor-status'), sessionKey: { tenantId: 'tenant' } },
    ]) {
      await expect(runtime.control(SESSION, candidate)).rejects.toBeInstanceOf(
        ManagedMonitorError,
      );
    }
  });

  it('answers unknown for a watch it does not hold physically', async () => {
    const runtime = new ManagedMonitorRuntime(new ManagedMonitorRegistry());
    expect(await runtime.control(SESSION, operation('monitor-status'))).toEqual(
      { operationId: TARGET, state: 'unknown' },
    );
  });

  it('answers running only for the registered Session scope', async () => {
    const registry = new ManagedMonitorRegistry();
    register(registry);
    const runtime = new ManagedMonitorRuntime(registry);
    expect(await runtime.control(SESSION, operation('monitor-status'))).toEqual(
      { operationId: TARGET, state: 'running', unitName: UNIT },
    );
    expect(
      await runtime.control('another-session', operation('monitor-status')),
    ).toEqual({ operationId: TARGET, state: 'unknown' });
    expect(registry.hasHolds(SESSION)).toBe(true);
  });

  it('answers exited from evidence after a natural end, idempotently', async () => {
    const registry = new ManagedMonitorRegistry();
    const { process, completion } = register(registry);
    (process.child as EventEmitter).emit('exit', 7, null);
    await completion;
    const runtime = new ManagedMonitorRuntime(registry);
    const answered = {
      operationId: TARGET,
      state: 'exited',
      unitName: UNIT,
      evidence: { exitCode: 7, exitSignal: null },
    };
    expect(await runtime.control(SESSION, operation('monitor-status'))).toEqual(
      answered,
    );
    expect(registry.hasHolds(SESSION)).toBe(false);
    expect(await runtime.control(SESSION, operation('monitor-stop'))).toEqual(
      answered,
    );
    expect(
      await runtime.control('another-session', operation('monitor-status')),
    ).toEqual({ operationId: TARGET, state: 'unknown' });
  });

  it('stops with evidence, and keeps an unproven end unknown', async () => {
    const proven = new ManagedMonitorRegistry();
    const { completion } = register(proven, {
      terminateEvidence: { exitCode: 0, exitSignal: null },
    });
    const runtime = new ManagedMonitorRuntime(proven);
    expect(await runtime.control(SESSION, operation('monitor-stop'))).toEqual({
      operationId: TARGET,
      state: 'exited',
      unitName: UNIT,
      evidence: { exitCode: 0, exitSignal: null },
    });
    await completion;
    expect(proven.hasHolds(SESSION)).toBe(false);

    const unproven = new ManagedMonitorRegistry();
    register(unproven, { terminateEvidence: null });
    const second = new ManagedMonitorRuntime(unproven);
    expect(await second.control(SESSION, operation('monitor-stop'))).toEqual({
      operationId: TARGET,
      state: 'unknown',
    });
    expect(unproven.hasHolds(SESSION)).toBe(true);
  });

  it('stay unknown when a natural end carried no evidence', async () => {
    const registry = new ManagedMonitorRegistry();
    const child = fakeChild();
    const stored = doubles();
    const evidence: ChildRunExitEvidence | null = null;
    const completion = registry.register({
      unitName: UNIT,
      sessionId: SESSION,
      process: {
        unitName: UNIT,
        child,
        get exited() {
          return evidence !== null;
        },
        get evidence() {
          return evidence;
        },
        async terminate() {
          return evidence;
        },
      } as unknown as ManagedChildRunProcess,
      sink: stored.sink as ManagedShellCaptureSink,
      publisher: stored.publisher,
      identity: stored.sink.identity as Parameters<
        typeof registry.register
      >[0]['identity'],
    });
    child.emit('exit');
    await completion;
    const runtime = new ManagedMonitorRuntime(registry);
    expect(await runtime.control(SESSION, operation('monitor-status'))).toEqual(
      { operationId: TARGET, state: 'unknown' },
    );
    expect(registry.hasHolds(SESSION)).toBe(false);
  });

  it('stopSession drains one Session and leaves another alone', async () => {
    const registry = new ManagedMonitorRegistry();
    const own = register(registry, { sessionId: SESSION });
    register(registry, {
      unitName: 'qwen-mon-other',
      sessionId: 'other-session',
      terminateEvidence: null,
    });
    await registry.stopSession(SESSION, 100);
    await own.completion;
    expect(registry.hasHolds(SESSION)).toBe(false);
    expect((await registry.describeFinished(UNIT))?.receipt.evidence).toEqual({
      exitCode: 0,
      exitSignal: null,
    });
    await registry.stopSession('other-session', 100);
    expect(registry.hasHolds('other-session')).toBe(true);
  });
});
