/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BackgroundShellRegistry,
  type ShellTaskRegistration,
} from '@qwen-code/qwen-code-core/services/backgroundShellRegistry.js';
import * as processLiveness from '@qwen-code/qwen-code-core/utils/process-liveness.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveDetachedBackgroundWork,
  resetDetachedWorkProbeCache,
  type ProcessInspector,
} from './detached-work-liveness.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-work-'));
  resetDetachedWorkProbeCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function writeShellSidecar(
  sessionId: string,
  shellId: string,
  payload: Record<string, unknown> | null,
): void {
  const dir = path.join(tempRoot, 'background-shells', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `shell-${shellId}.status`),
    JSON.stringify(payload, null, 2),
  );
}

const RUNNING = (pid: number | undefined, startTime = '2026-01-01T00:00:00Z') =>
  ({
    id: 'x',
    status: 'running',
    command: 'npm run dev',
    cwd: '/repo',
    startTime,
    updatedAt: startTime,
    ...(pid !== undefined ? { pid } : {}),
  }) as Record<string, unknown>;

const TERMINAL = {
  id: 'x',
  status: 'completed',
  command: 'npm run build',
  cwd: '/repo',
  startTime: '2026-01-01T00:00:00Z',
  endTime: '2026-01-01T00:01:00Z',
  exitCode: 0,
};

const verified: ProcessInspector = () => 'alive-verified';
const dead: ProcessInspector = () => 'dead';
const unverifiable: ProcessInspector = () => 'alive-unverified';

function resolve(sessionIds: string[], inspector: ProcessInspector) {
  return resolveDetachedBackgroundWork({
    sessionIds,
    projectTempDir: tempRoot,
    inspector,
  });
}

describe('resolveDetachedBackgroundWork', () => {
  it('reports running when a sidecar claims a verified-live pid', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    expect((await resolve(['s1'], verified)).get('s1')).toBe('running');
  });

  it('reports nothing when every running pid is provably dead', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    writeShellSidecar('s1', 'bg_a2', RUNNING(124));
    expect((await resolve(['s1'], dead)).get('s1')).toBeUndefined();
  });

  it('reports unknown when a running pid cannot be verified', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    expect((await resolve(['s1'], unverifiable)).get('s1')).toBe('unknown');
  });

  it('settles a registry-written sidecar against the live writer process', async (ctx) => {
    // Real writer (core registry) + real reader (default inspector): the
    // production write path must carry the identity tokens the probe needs,
    // or a verified-running verdict is unreachable outside of tests.
    const selfProcStart = processLiveness.readProcStartToken(process.pid);
    const selfPidNs = processLiveness.readPidNamespaceId();
    if (selfProcStart === null || selfPidNs === null) {
      ctx.skip(); // identity tokens are Linux-procfs only; token-less paths covered above
      return;
    }
    const sessionDir = path.join(tempRoot, 'background-shells', 'live');
    fs.mkdirSync(sessionDir, { recursive: true });
    const registration: ShellTaskRegistration = {
      shellId: 'bg_live1',
      command: 'sleep 60',
      cwd: tempRoot,
      pid: process.pid,
      status: 'running',
      startTime: Date.now(),
      outputPath: path.join(sessionDir, 'shell-bg_live1.output'),
      abortController: new AbortController(),
    };
    new BackgroundShellRegistry().register(registration);

    const payload = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'shell-bg_live1.status'), 'utf8'),
    ) as Record<string, unknown>;
    expect(payload['pid']).toBe(process.pid);
    expect(payload['procStart']).toBe(selfProcStart);
    expect(payload['pidNs']).toBe(selfPidNs);

    const verdicts = await resolveDetachedBackgroundWork({
      sessionIds: ['live'],
      projectTempDir: tempRoot,
    });
    expect(verdicts.get('live')).toBe('running');
  });

  it('reports nothing for terminal-only sidecars', async () => {
    writeShellSidecar('s1', 'bg_a1', TERMINAL);
    expect((await resolve(['s1'], verified)).get('s1')).toBeUndefined();
  });

  it('reports unknown for a running sidecar without a pid', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(undefined));
    expect((await resolve(['s1'], verified)).get('s1')).toBe('unknown');
  });

  it('reports nothing for a session with no shell directory', async () => {
    expect((await resolve(['s1'], verified)).get('s1')).toBeUndefined();
  });

  it('prefers running over unknown when one shell verifies', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    writeShellSidecar('s1', 'bg_a2', RUNNING(undefined));
    expect((await resolve(['s1'], verified)).get('s1')).toBe('running');
  });

  it('treats an unreadable sidecar as unknown, not terminal', async () => {
    const dir = path.join(tempRoot, 'background-shells', 's1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'shell-bg_bad.status'), '{oops');
    expect((await resolve(['s1'], dead)).get('s1')).toBe('unknown');
  });

  it('treats a valid JSON null sidecar as unknown', async () => {
    writeShellSidecar('s1', 'bad', null);
    expect((await resolve(['s1'], dead)).get('s1')).toBe('unknown');
  });

  it('reports unknown when the shell directory cannot be read', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    vi.spyOn(fsp, 'opendir').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    expect((await resolve(['s1'], dead)).get('s1')).toBe('unknown');
  });

  it('reports unknown for an oversized status file', async () => {
    writeShellSidecar('s1', 'bg_a1', {
      ...RUNNING(123),
      command: 'x'.repeat(20_000),
    });
    const inspector = vi.fn(verified);
    expect((await resolve(['s1'], inspector)).get('s1')).toBe('unknown');
    expect(inspector).not.toHaveBeenCalled();
  });

  it('settles a missing-identity pid as dead when no process owns it', async () => {
    // Namespace-less platform: ESRCH alone is definitive there. On hosts
    // with pid namespaces the same record stays unknown (covered below).
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(null);
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(
      (
        await resolveDetachedBackgroundWork({
          sessionIds: ['s1'],
          projectTempDir: tempRoot,
        })
      ).get('s1'),
    ).toBeUndefined();
  });

  it('stays unknown when a missing-identity pid exists but cannot be verified', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(null);
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(
      (
        await resolveDetachedBackgroundWork({
          sessionIds: ['s1'],
          projectTempDir: tempRoot,
        })
      ).get('s1'),
    ).toBe('unknown');
  });

  it('stays unknown when a start token is recorded without a namespace claim', async () => {
    // A namespace-capable host shares its boot id across containers, so a
    // token without a namespace cannot rule out a sibling container's live
    // shell vanishing from the local table (#17819).
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(123);
    writeShellSidecar('s1', 'bg_a1', {
      ...RUNNING(123),
      procStart: 'boot-x:4210',
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(
      (
        await resolveDetachedBackgroundWork({
          sessionIds: ['s1'],
          projectTempDir: tempRoot,
        })
      ).get('s1'),
    ).toBe('unknown');
  });

  it('stays unknown when Linux cannot read its own namespace', async () => {
    // A failed /proc/self/ns/pid read on Linux is not "no namespaces":
    // sibling containers sharing the runtime directory still make the local
    // pid table meaningless, so ESRCH there must not settle the verdict.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(null);
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(
      (
        await resolveDetachedBackgroundWork({
          sessionIds: ['s1'],
          projectTempDir: tempRoot,
        })
      ).get('s1'),
    ).toBe('unknown');
  });

  it('stays unknown when the record claims a namespace this host is not in', async () => {
    // Shared runtime directory: the pid may be alive in a sibling container,
    // so the local table — where it resolves to nothing — cannot settle it.
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(123);
    writeShellSidecar('s1', 'bg_a1', {
      ...RUNNING(123),
      pidNs: 456,
    });
    expect(
      (
        await resolveDetachedBackgroundWork({
          sessionIds: ['s1'],
          projectTempDir: tempRoot,
        })
      ).get('s1'),
    ).toBe('unknown');
  });

  it('settles dead within a matching namespace even without a start token', async () => {
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(123);
    writeShellSidecar('s1', 'bg_a1', {
      ...RUNNING(123),
      pidNs: 123,
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(
      (
        await resolveDetachedBackgroundWork({
          sessionIds: ['s1'],
          projectTempDir: tempRoot,
        })
      ).get('s1'),
    ).toBeUndefined();
  });

  it('uses the recorded OS identity even when the background registration time differs', async () => {
    const procStart = 'abc:1234';
    const pidNs = 123;
    vi.spyOn(processLiveness, 'readLocalBootId').mockReturnValue('abc');
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(pidNs);
    vi.spyOn(processLiveness, 'readProcStartToken')
      .mockReturnValueOnce(procStart)
      .mockReturnValueOnce('abc:5678')
      .mockReturnValueOnce(procStart);
    vi.spyOn(processLiveness, 'isZombie').mockReturnValue(false);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const base = RUNNING(123, '2000-01-01T00:00:00Z');
    writeShellSidecar('promoted', 'bg_a1', {
      ...base,
      procStart,
      pidNs,
      status: 'cancelled',
    });
    writeShellSidecar('reused', 'bg_a1', { ...base, procStart, pidNs });
    writeShellSidecar('transport-failed', 'bg_a1', {
      ...base,
      procStart,
      pidNs,
      status: 'failed',
    });
    writeShellSidecar('legacy', 'bg_a1', base);
    writeShellSidecar('malformed', 'bg_a1', {
      ...base,
      procStart: 'abc:bad',
      pidNs,
    });
    const verdicts = await resolveDetachedBackgroundWork({
      sessionIds: [
        'promoted',
        'reused',
        'transport-failed',
        'legacy',
        'malformed',
      ],
      projectTempDir: tempRoot,
    });
    expect(verdicts.get('promoted')).toBe('running');
    expect(verdicts.get('reused')).toBeUndefined();
    expect(verdicts.get('transport-failed')).toBe('running');
    expect(verdicts.get('legacy')).toBe('unknown');
    expect(verdicts.get('malformed')).toBe('unknown');
  });

  it('ignores non-status files in the shell directory', async () => {
    const dir = path.join(tempRoot, 'background-shells', 's1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'shell-bg_a1.output'), 'hello');
    expect((await resolve(['s1'], verified)).get('s1')).toBeUndefined();
  });

  it('serves repeat probes from the TTL cache', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    let calls = 0;
    const counting: ProcessInspector = (...args) => {
      calls += 1;
      return verified(...args);
    };
    const first = await resolve(['s1'], counting);
    const second = await resolve(['s1'], counting);
    expect(first.get('s1')).toBe('running');
    expect(second.get('s1')).toBe('running');
    expect(calls).toBe(1);
  });

  it('negative results are cached too, until the TTL expires', async () => {
    writeShellSidecar('s1', 'bg_a1', RUNNING(123));
    let calls = 0;
    let verdict: ReturnType<ProcessInspector> = 'dead';
    const flipping: ProcessInspector = (...args) => {
      calls += 1;
      return verdict === 'dead' ? dead(...args) : verified(...args);
    };
    const t0 = 1_000_000;
    await resolveDetachedBackgroundWork({
      sessionIds: ['s1'],
      projectTempDir: tempRoot,
      inspector: flipping,
      now: t0,
    });
    // Still within TTL: the dead verdict sticks even though the shell died.
    const fresh = await resolveDetachedBackgroundWork({
      sessionIds: ['s1'],
      projectTempDir: tempRoot,
      inspector: flipping,
      now: t0 + 1000,
    });
    expect(fresh.get('s1')).toBeUndefined();
    verdict = 'alive-verified';
    const afterExpiry = await resolveDetachedBackgroundWork({
      sessionIds: ['s1'],
      projectTempDir: tempRoot,
      inspector: flipping,
      now: t0 + 60_000,
    });
    expect(afterExpiry.get('s1')).toBe('running');
    expect(calls).toBe(2);
  });

  it('caps probes per refresh and rolls the rest over', async () => {
    for (const s of ['s1', 's2', 's3']) {
      writeShellSidecar(s, 'bg_a1', RUNNING(123));
    }
    const probed: string[] = [];
    const counting: ProcessInspector = (pid) => {
      probed.push(String(pid));
      return 'alive-verified';
    };
    const opts = {
      sessionIds: ['s1', 's2', 's3'],
      projectTempDir: tempRoot,
      inspector: counting,
      now: 1_000_000,
      maxSessionsPerRefresh: 2,
    };
    const first = await resolveDetachedBackgroundWork(opts);
    expect(probed).toHaveLength(2);
    const second = await resolveDetachedBackgroundWork({
      ...opts,
      now: 1_000_001,
    });
    expect(probed).toHaveLength(3);
    expect(first.size).toBe(2);
    expect(second.size).toBe(3);
  });
});
