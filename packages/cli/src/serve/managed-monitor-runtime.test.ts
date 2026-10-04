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
import { monitorUnitNameOf } from '@qwen-code/qwen-code-core/managed-runtime/managed-monitor-protocol.js';
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
  child.stdout = stdout as ChildProcess['stdout'];
  child.stderr = stderr as ChildProcess['stderr'];
  return child;
}

interface WatchSpec {
  readonly unitName?: string;
  readonly sessionId?: string;
  readonly evidence?: ChildRunExitEvidence | null;
  readonly terminateEvidence?: ChildRunExitEvidence | null;
  readonly preExited?: boolean;
}

function fakeWatch({
  unitName = UNIT,
  evidence = null,
  terminateEvidence = { exitCode: 0, exitSignal: null },
  preExited = false,
}: WatchSpec): ManagedChildRunProcess {
  const child = fakeChild();
  let current = preExited ? evidence : null;
  child.on('exit', (code, signal) => {
    current = {
      exitCode: typeof code === 'number' ? code : null,
      exitSignal: typeof signal === 'string' ? signal : null,
    };
  });
  return {
    unitName,
    child,
    get exited() {
      return current !== null;
    },
    get evidence() {
      return current;
    },
    async terminate(graceMs: number): Promise<ChildRunExitEvidence | null> {
      if (current === null && terminateEvidence !== null) {
        current = terminateEvidence;
        child.emit('exit', terminateEvidence.exitCode, null);
      }
      return current && graceMs >= 0 ? current : null;
    },
  } as unknown as ManagedChildRunProcess;
}

function register(
  registry: ManagedMonitorRegistry,
  spec: WatchSpec = {},
): ManagedChildRunProcess {
  const watch = fakeWatch(spec);
  registry.register({
    unitName: spec.unitName ?? UNIT,
    sessionId: spec.sessionId ?? SESSION,
    process: watch,
  });
  return watch;
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
    const watch = register(registry, { evidence: null });
    const runtime = new ManagedMonitorRuntime(registry);
    (watch.child as EventEmitter).emit('exit', 7, null);
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
    register(proven, { terminateEvidence: { exitCode: 0, exitSignal: null } });
    const runtime = new ManagedMonitorRuntime(proven);
    expect(await runtime.control(SESSION, operation('monitor-stop'))).toEqual({
      operationId: TARGET,
      state: 'exited',
      unitName: UNIT,
      evidence: { exitCode: 0, exitSignal: null },
    });
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

  it('stopSession drains one Session and leaves another alone', async () => {
    const registry = new ManagedMonitorRegistry();
    register(registry, { unitName: UNIT, sessionId: SESSION });
    register(registry, {
      unitName: 'qwen-mon-other',
      sessionId: 'other-session',
      terminateEvidence: null,
    });
    await registry.stopSession(SESSION, 100);
    expect(registry.hasHolds(SESSION)).toBe(false);
    expect((await registry.describeFinished(UNIT))?.receipt).toEqual({
      exitCode: 0,
      exitSignal: null,
    });
    await registry.stopSession('other-session', 100);
    expect(registry.hasHolds('other-session')).toBe(true);
  });
});
