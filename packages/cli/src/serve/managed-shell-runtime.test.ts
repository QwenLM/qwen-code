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
import { shellUnitNameOf } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-protocol.js';
import type {
  ManagedShellCapturePublisher,
  ManagedShellCaptureSink,
} from './managed-runtime-tool-executor.js';
import { ManagedBackgroundShellRegistry } from './managed-background-shell-registry.js';
import {
  ManagedShellError,
  ManagedShellRuntime,
} from './managed-shell-runtime.js';

const SESSION = 'runtime-session-1';
const TARGET = 'abc.def-ghi';
const UNIT = shellUnitNameOf(TARGET);
const SCOPE = { tenantId: 'tenant', sessionId: 'session' };

function operation(kind: string, extra: Record<string, unknown> = {}) {
  return {
    kind,
    sessionKey: SCOPE,
    operationId: 'abc.def-ghi',
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

function fakeProcess(evidence: ChildRunExitEvidence): ManagedChildRunProcess {
  return {
    unitName: UNIT,
    child: fakeChild(),
    get exited() {
      return true;
    },
    get evidence() {
      return evidence;
    },
    async terminate(): Promise<ChildRunExitEvidence | null> {
      return evidence;
    },
    async settleOnEmpty(): Promise<ChildRunExitEvidence | null> {
      return evidence;
    },
  } as unknown as ManagedChildRunProcess;
}

function doubles() {
  const sink: ManagedShellCaptureSink & {
    identity: unknown;
  } = {
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

function registerLive(
  registry: ManagedBackgroundShellRegistry,
  sessionId = SESSION,
  evidence: ChildRunExitEvidence = { exitCode: 0, exitSignal: null },
): ManagedChildRunProcess {
  const process = fakeProcess(evidence);
  const stored = doubles();
  registry.register({
    unitName: UNIT,
    sessionId,
    process,
    sink: stored.sink as ManagedShellCaptureSink,
    publisher: stored.publisher,
    identity: stored.sink.identity as Parameters<
      typeof registry.register
    >[0]['identity'],
  });
  return process;
}

describe('ManagedShellRuntime', () => {
  it('refuses envelopes and operations outside the closed key set', async () => {
    const runtime = new ManagedShellRuntime(
      new ManagedBackgroundShellRegistry(),
    );
    for (const candidate of [
      { ...operation('shell-status'), operationId: '' },
      { ...operation('shell-status'), kind: 'shell-kill' },
      { ...operation('shell-status'), extra: true },
      { kind: 'shell-status' },
      { ...operation('shell-status'), sessionKey: { tenantId: 'tenant' } },
    ]) {
      await expect(runtime.control(SESSION, candidate)).rejects.toBeInstanceOf(
        ManagedShellError,
      );
    }
  });

  it('answers unknown for anything it does not own physically', async () => {
    const runtime = new ManagedShellRuntime(
      new ManagedBackgroundShellRegistry(),
    );
    const view = await runtime.control(SESSION, operation('shell-status'));
    expect(view).toEqual({ operationId: 'abc.def-ghi', state: 'unknown' });
  });

  it('answers running only for the registered Session scope', async () => {
    const registry = new ManagedBackgroundShellRegistry();
    registerLive(registry);
    const runtime = new ManagedShellRuntime(registry);
    expect(await runtime.control(SESSION, operation('shell-status'))).toEqual({
      operationId: 'abc.def-ghi',
      state: 'running',
      unitName: UNIT,
    });
    expect(
      await runtime.control('another-session', operation('shell-status')),
    ).toEqual({ operationId: 'abc.def-ghi', state: 'unknown' });
  });

  it('terminates with evidence and answers exited with it', async () => {
    const registry = new ManagedBackgroundShellRegistry();
    registerLive(registry, SESSION, { exitCode: 7, exitSignal: null });
    const runtime = new ManagedShellRuntime(registry);
    const view = await runtime.control(SESSION, operation('shell-terminate'));
    expect(view).toEqual({
      operationId: 'abc.def-ghi',
      state: 'exited',
      unitName: UNIT,
      evidence: { exitCode: 7, exitSignal: null },
    });
    expect(registry.hasHolds(SESSION)).toBe(false);
  });

  it('never claims an unproven end, and the hold survives it', async () => {
    const registry = new ManagedBackgroundShellRegistry();
    const stored = doubles();
    registry.register({
      unitName: UNIT,
      sessionId: SESSION,
      process: {
        unitName: UNIT,
        child: fakeChild(),
        exited: false,
        evidence: null,
        terminate: async () => null,
      } as unknown as ManagedChildRunProcess,
      sink: stored.sink as ManagedShellCaptureSink,
      publisher: stored.publisher,
      identity: stored.sink.identity as Parameters<
        typeof registry.register
      >[0]['identity'],
    });
    const runtime = new ManagedShellRuntime(registry);
    const view = await runtime.control(SESSION, operation('shell-terminate'));
    expect(view).toEqual({ operationId: 'abc.def-ghi', state: 'unknown' });
    // An unproven terminate refuses to settle: the hold is still there.
    expect(registry.hasHolds(SESSION)).toBe(true);
  });

  it('stopSession drains one Session and leaves another alone', async () => {
    const registry = new ManagedBackgroundShellRegistry(10);
    const stored = doubles();
    const otherStored = doubles();
    const targetChild = fakeChild();
    let targetEvidence: ChildRunExitEvidence | null = null;
    targetChild.on('exit', (code, signal) => {
      targetEvidence = {
        exitCode: typeof code === 'number' ? code : null,
        exitSignal: typeof signal === 'string' ? signal : null,
      };
    });
    const target = {
      unitName: 'qwen-bg-target',
      child: targetChild,
      get exited() {
        return targetEvidence !== null;
      },
      get evidence() {
        return targetEvidence;
      },
      async terminate(): Promise<ChildRunExitEvidence | null> {
        targetChild.emit('exit', null, 'SIGTERM');
        return targetEvidence;
      },
      async settleOnEmpty(): Promise<ChildRunExitEvidence | null> {
        return targetEvidence;
      },
    } as unknown as ManagedChildRunProcess;
    registry.register({
      unitName: 'qwen-bg-target',
      sessionId: SESSION,
      process: target,
      sink: stored.sink as ManagedShellCaptureSink,
      publisher: stored.publisher,
      identity: stored.sink.identity as Parameters<
        typeof registry.register
      >[0]['identity'],
    });
    registry.register({
      unitName: UNIT,
      sessionId: 'other-session',
      process: {
        unitName: UNIT,
        child: fakeChild(),
        exited: false,
        evidence: null,
        terminate: async () => null,
      } as unknown as ManagedChildRunProcess,
      sink: otherStored.sink as ManagedShellCaptureSink,
      publisher: otherStored.publisher,
      identity: otherStored.sink.identity as Parameters<
        typeof registry.register
      >[0]['identity'],
    });

    await registry.stopSession(SESSION, 100);
    expect(registry.hasHolds(SESSION)).toBe(false);
    expect(registry.hasHolds('other-session')).toBe(true);
    expect(
      (await registry.describeFinished('qwen-bg-target'))?.receipt.evidence,
    ).toEqual({ exitCode: null, exitSignal: 'SIGTERM' });

    // And the surviving entry answers only its own drain.
    await registry.stopSession('other-session', 100);
    expect(registry.hasHolds('other-session')).toBe(true);
  });

  it('answers exited from the retained receipt after a natural end', async () => {
    const registry = new ManagedBackgroundShellRegistry();
    const process = fakeProcess({ exitCode: 3, exitSignal: null });
    const stored = doubles();
    const completion = registry.register({
      unitName: UNIT,
      sessionId: SESSION,
      process,
      sink: stored.sink as ManagedShellCaptureSink,
      publisher: stored.publisher,
      identity: stored.sink.identity as Parameters<
        typeof registry.register
      >[0]['identity'],
    });
    const receipt = await completion;
    expect(receipt.evidence).toEqual({ exitCode: 3, exitSignal: null });
    // The hold dropped with the end; the receipt stays answerable anyway.
    expect(registry.hasHolds(SESSION)).toBe(false);

    const runtime = new ManagedShellRuntime(registry);
    const exited = {
      operationId: 'abc.def-ghi',
      state: 'exited',
      unitName: UNIT,
      evidence: { exitCode: 3, exitSignal: null },
    };
    expect(await runtime.control(SESSION, operation('shell-status'))).toEqual(
      exited,
    );
    expect(
      await runtime.control(SESSION, operation('shell-terminate')),
    ).toEqual(exited);
    expect(
      await runtime.control('another-session', operation('shell-status')),
    ).toEqual({ operationId: 'abc.def-ghi', state: 'unknown' });
  });

  it('supervises a natural end until its unit proves empty, never settling exited over live members', async () => {
    const registry = new ManagedBackgroundShellRegistry(10);
    const daemonChild = fakeChild();
    let evidence: ChildRunExitEvidence | null = null;
    daemonChild.on('exit', (code, signal) => {
      evidence = {
        exitCode: typeof code === 'number' ? code : null,
        exitSignal: typeof signal === 'string' ? signal : null,
      };
    });
    let drain: () => void = () => undefined;
    const membership = new Promise<void>((resolve) => {
      drain = resolve;
    });
    // The H7b/H5 shape: the root exits while the unit still holds members —
    // the settle waits for the drain, never claims exited over live members.
    const daemon = {
      unitName: 'qwen-bg-daemon',
      child: daemonChild,
      get exited() {
        return evidence !== null;
      },
      get evidence() {
        return evidence;
      },
      async terminate(): Promise<ChildRunExitEvidence | null> {
        return evidence;
      },
      async settleOnEmpty(): Promise<ChildRunExitEvidence | null> {
        await membership;
        return evidence;
      },
    } as unknown as ManagedChildRunProcess;
    const stored = doubles();
    const completion = registry.register({
      unitName: 'qwen-bg-daemon',
      sessionId: SESSION,
      process: daemon,
      sink: stored.sink as ManagedShellCaptureSink,
      publisher: stored.publisher,
      identity: stored.sink.identity as Parameters<
        typeof registry.register
      >[0]['identity'],
    });
    daemonChild.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The root's exit alone answered nothing: the hold and the record wait.
    expect(registry.hasHolds(SESSION)).toBe(true);
    expect(
      (await registry.describeFinished('qwen-bg-daemon'))?.receipt,
    ).toBeUndefined();
    drain();
    const finished = await completion;
    expect(finished.evidence).toEqual({ exitCode: 0, exitSignal: null });
    expect(registry.hasHolds(SESSION)).toBe(false);
    expect(
      (await registry.describeFinished('qwen-bg-daemon'))?.receipt.evidence,
    ).toEqual({ exitCode: 0, exitSignal: null });
  });

  it('stays unknown when the end carried no evidence it could keep', async () => {
    const registry = new ManagedBackgroundShellRegistry();
    const child = fakeChild();
    const stored = doubles();
    const completion = registry.register({
      unitName: UNIT,
      sessionId: SESSION,
      process: {
        unitName: UNIT,
        child,
        exited: false,
        evidence: null,
        terminate: async () => null,
      } as unknown as ManagedChildRunProcess,
      sink: stored.sink as ManagedShellCaptureSink,
      publisher: stored.publisher,
      identity: stored.sink.identity as Parameters<
        typeof registry.register
      >[0]['identity'],
    });
    child.emit('exit');
    const receipt = await completion;
    expect(receipt.evidence).toBeNull();

    const runtime = new ManagedShellRuntime(registry);
    expect(await runtime.control(SESSION, operation('shell-status'))).toEqual({
      operationId: 'abc.def-ghi',
      state: 'unknown',
    });
    expect(registry.hasHolds(SESSION)).toBe(false);
  });
});
