/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real-process, real-timer coverage of the channel liveness busy grace and
// failure evidence: a real CPU-burning child and a real SIGSTOPped child are
// sampled through the production /proc sampler and the production startup
// wiring (makeBridge), with no mocked sampler and no fake timers. Linux only
// because the sampler reads /proc; other platforms keep the pre-grace
// accounting by construction and are covered by the unit platform gate.

import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  makeBridge,
  makeChannel,
} from '@qwen-code/acp-bridge/internal/testUtils';
import {
  CHANNEL_LIVENESS_META_KEY,
  CHANNEL_LIVENESS_VERSION,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { SERVE_STATUS_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import type {
  BridgeTelemetry,
  BridgeTelemetryAttributes,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// Mirrors the busy-extension limit in packages/acp-bridge/src/channel-liveness.ts.
const BUSY_LIMIT = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LivenessCapture {
  events: Array<[string, Record<string, unknown>]>;
  lines: string[];
  restore: () => void;
}

function capture(): LivenessCapture {
  const events: Array<[string, Record<string, unknown>]> = [];
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write');
  spy.mockImplementation((chunk: unknown) => {
    const s = String(chunk);
    if (s.startsWith('qwen serve: channel liveness')) lines.push(s);
    return true;
  });
  return {
    events,
    lines,
    restore: () => spy.mockRestore(),
  };
}

function telemetryFor(cap: LivenessCapture): BridgeTelemetry {
  return {
    captureContext: () => undefined,
    runWithContext: async <T>(_captured: unknown, fn: () => Promise<T>) =>
      await fn(),
    withSpan: async <T>(
      _operation: string,
      _attributes: BridgeTelemetryAttributes,
      fn: () => Promise<T>,
    ) => await fn(),
    event: (name: string, attrs: BridgeTelemetryAttributes) => {
      cap.events.push([name, attrs]);
    },
    injectPromptContext: <T extends object>(request: T) => request,
    metrics: {
      sessionLifecycle: () => {},
      channelLifecycle: () => {},
      promptQueueWait: () => {},
      promptDuration: () => {},
      cancelled: () => {},
    },
  };
}

async function runCase(
  cmd: string,
  stopAfterSpawn: boolean,
  opts: { pollBudgetMs: number; answerPing?: boolean },
): Promise<{
  child: ChildProcess;
  elapsed: number;
  attrs: Record<string, unknown>;
  grace: string[];
  kill: string[];
  cap: LivenessCapture;
  killedBeforeShutdown: boolean;
}> {
  const child = spawn(process.execPath, ['-e', cmd], { stdio: 'ignore' });
  const cap = capture();
  try {
    await sleep(400);
    if (stopAfterSpawn) process.kill(child.pid!, 'SIGSTOP');
    const handle = makeChannel({
      initializeImpl: () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'liveness-grace-it', version: '0' },
        authMethods: [],
        agentCapabilities: {},
        _meta: { [CHANNEL_LIVENESS_META_KEY]: { v: CHANNEL_LIVENESS_VERSION } },
      }),
      extMethodImpl: (method: string, params: Record<string, unknown>) =>
        method === SERVE_STATUS_EXT_METHODS.channelPing
          ? opts.answerPing
            ? { v: CHANNEL_LIVENESS_VERSION, nonce: params['nonce'] }
            : new Promise(() => {})
          : {},
    });
    handle.channel = { ...handle.channel, pid: child.pid };
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      telemetry: telemetryFor(cap),
    });
    const t0 = Date.now();
    await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
    let failure: [string, Record<string, unknown>] | undefined;
    // Poll budget stays strictly below the enclosing it() timeout so a slow
    // run fails on an assertion instead of stranding the child on timeout.
    while (!failure && Date.now() - t0 < opts.pollBudgetMs) {
      await sleep(250);
      failure = cap.events.find(([n]) => n === 'channel.liveness_failed');
    }
    const elapsed = Date.now() - t0;
    // Sample before shutdown: shutdown kills every alive channel anyway, so
    // a later read would be true even if the liveness teardown never ran.
    const killedBeforeShutdown = handle.killed;
    await bridge.shutdown();
    cap.restore();
    return {
      child,
      elapsed,
      attrs: failure?.[1] ?? {},
      grace: cap.lines.filter((l) => l.includes('extending grace')),
      kill: cap.lines.filter((l) => l.includes('killing channel')),
      cap,
      killedBeforeShutdown,
    };
  } catch (error) {
    // Anything throwing between spawn and return must not orphan a core
    // burner or leave the stderr spy mocked for the sibling case.
    try {
      process.kill(child.pid!, 'SIGKILL');
    } catch {
      // already reaped
    }
    cap.restore();
    throw error;
  }
}

describe.runIf(process.platform === 'linux')(
  'channel liveness busy grace — real processes',
  () => {
    it('grants bounded busy extensions to a CPU-burning unresponsive agent, then kills with evidence', async () => {
      const r = await runCase('for(;;){}', false, { pollBudgetMs: 150_000 });
      try {
        // Cardinality is load-fragile: a >1 s late callback is local_delay,
        // which resets busyExtensions and restarts the sequence at 1/6. Pin
        // the reset-surviving shape; the kill line and busy_extensions
        // telemetry below are the load-independent bounded-grace proof.
        expect(r.grace.length).toBeGreaterThanOrEqual(BUSY_LIMIT - 1);
        expect(r.grace[0]).toContain(`agent pid=${r.child.pid} consumed CPU (`);
        expect(r.grace[0]).toContain('state=R');
        expect(r.grace[0]).toContain(`extending grace 1/${BUSY_LIMIT}`);
        expect(r.grace.at(-1)).toContain(
          `extending grace ${BUSY_LIMIT - 1}/${BUSY_LIMIT}`,
        );
        expect(
          r.kill,
          'liveness kill line must appear within the poll budget',
        ).toHaveLength(1);
        expect(r.kill[0]).toContain(`pid=${r.child.pid}`);
        expect(r.kill[0]).toContain('busy=6 timeouts=0');
        expect(r.killedBeforeShutdown).toBe(true);
        expect(r.attrs['qwen-code.daemon.channel.liveness.pid']).toBe(
          r.child.pid,
        );
        expect(
          r.attrs['qwen-code.daemon.channel.liveness.busy_extensions'],
        ).toBe(BUSY_LIMIT);
        expect(
          r.attrs['qwen-code.daemon.channel.liveness.consecutive_timeouts'],
        ).toBe(0);
        expect(
          Number(r.attrs['qwen-code.daemon.channel.liveness.cpu_delta_ticks']),
        ).toBeGreaterThan(0);
        expect(r.elapsed).toBeGreaterThan(60_000);
      } finally {
        try {
          process.kill(r.child.pid!, 'SIGKILL');
        } catch {
          // already reaped
        }
      }
    }, 180_000);

    it('still kills a zero-CPU stopped agent on the two-strike fast path with evidence', async () => {
      const r = await runCase('setInterval(()=>{},1000)', true, {
        pollBudgetMs: 80_000,
      });
      try {
        expect(r.grace).toHaveLength(0);
        expect(
          r.kill,
          'liveness kill line must appear within the poll budget',
        ).toHaveLength(1);
        expect(r.kill[0]).toContain(`pid=${r.child.pid}`);
        expect(r.kill[0]).toContain('state=T');
        expect(r.kill[0]).toContain('cpuDelta=0 busy=0 timeouts=2');
        expect(r.killedBeforeShutdown).toBe(true);
        expect(
          r.attrs['qwen-code.daemon.channel.liveness.consecutive_timeouts'],
        ).toBe(2);
        expect(
          r.attrs['qwen-code.daemon.channel.liveness.cpu_delta_ticks'],
        ).toBe(0);
        expect(r.attrs['qwen-code.daemon.channel.liveness.state']).toBe('T');
      } finally {
        try {
          process.kill(r.child.pid!, 'SIGKILL');
        } catch {
          // already reaped
        }
      }
    }, 90_000);

    it('leaves a healthy answering channel alive across probe cycles', async () => {
      const r = await runCase('setInterval(()=>{},1000)', false, {
        pollBudgetMs: 50_000,
        answerPing: true,
      });
      try {
        // The false-kill class this PR exists to prevent: a wiring bug that
        // condemns a healthy channel (counter never reset, grace path failing
        // instead of returning) must turn this case red.
        expect(r.grace).toHaveLength(0);
        expect(r.kill).toHaveLength(0);
        expect(r.attrs).toEqual({});
        expect(r.killedBeforeShutdown).toBe(false);
        expect(() => process.kill(r.child.pid!, 0)).not.toThrow();
      } finally {
        try {
          process.kill(r.child.pid!, 'SIGKILL');
        } catch {
          // already reaped
        }
      }
    }, 90_000);
  },
);
