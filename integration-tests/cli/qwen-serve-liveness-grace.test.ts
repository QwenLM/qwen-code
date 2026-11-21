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
): Promise<{
  child: ChildProcess;
  elapsed: number;
  attrs: Record<string, unknown>;
  grace: string[];
  kill: string[];
  cap: LivenessCapture;
}> {
  const child = spawn(process.execPath, ['-e', cmd], { stdio: 'ignore' });
  await sleep(400);
  if (stopAfterSpawn) process.kill(child.pid!, 'SIGSTOP');
  const cap = capture();
  const handle = makeChannel({
    initializeImpl: () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'liveness-grace-it', version: '0' },
      authMethods: [],
      agentCapabilities: {},
      _meta: { [CHANNEL_LIVENESS_META_KEY]: { v: CHANNEL_LIVENESS_VERSION } },
    }),
    extMethodImpl: (method: string) =>
      method === SERVE_STATUS_EXT_METHODS.channelPing
        ? new Promise(() => {})
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
  while (!failure && Date.now() - t0 < 120_000) {
    await sleep(250);
    failure = cap.events.find(([n]) => n === 'channel.liveness_failed');
  }
  const elapsed = Date.now() - t0;
  await bridge.shutdown();
  cap.restore();
  return {
    child,
    elapsed,
    attrs: failure?.[1] ?? {},
    grace: cap.lines.filter((l) => l.includes('extending grace')),
    kill: cap.lines.filter((l) => l.includes('killing channel')),
    cap,
  };
}

describe.runIf(process.platform === 'linux')(
  'channel liveness busy grace — real processes',
  () => {
    it('grants bounded busy extensions to a CPU-burning unresponsive agent, then kills with evidence', async () => {
      const r = await runCase('for(;;){}', false);
      try {
        expect(r.grace).toHaveLength(BUSY_LIMIT - 1);
        expect(r.grace[0]).toContain(`agent pid=${r.child.pid} consumed CPU (`);
        expect(r.grace[0]).toContain('state=R');
        expect(r.grace[0]).toContain(`extending grace 1/${BUSY_LIMIT}`);
        expect(r.grace[BUSY_LIMIT - 2]).toContain(
          `extending grace ${BUSY_LIMIT - 1}/${BUSY_LIMIT}`,
        );
        expect(r.kill).toHaveLength(1);
        expect(r.kill[0]).toContain(`pid=${r.child.pid}`);
        expect(r.kill[0]).toContain('busy=6 timeouts=0');
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
        // Upper bound is load-tolerant: local-delay forgiveness can add
        // windows on a busy host; the extension/kill counts above are the
        // bounded-grace pin.
        expect(r.elapsed).toBeLessThan(140_000);
      } finally {
        try {
          process.kill(r.child.pid!, 'SIGKILL');
        } catch {
          // already reaped
        }
      }
    }, 150_000);

    it('still kills a zero-CPU stopped agent on the two-strike fast path with evidence', async () => {
      const r = await runCase('setInterval(()=>{},1000)', true);
      try {
        expect(r.grace).toHaveLength(0);
        expect(r.kill).toHaveLength(1);
        expect(r.kill[0]).toContain(`pid=${r.child.pid}`);
        expect(r.kill[0]).toContain('state=T');
        expect(r.kill[0]).toContain('cpuDelta=0 busy=0 timeouts=2');
        expect(
          r.attrs['qwen-code.daemon.channel.liveness.consecutive_timeouts'],
        ).toBe(2);
        expect(
          r.attrs['qwen-code.daemon.channel.liveness.cpu_delta_ticks'],
        ).toBe(0);
        expect(r.attrs['qwen-code.daemon.channel.liveness.state']).toBe('T');
        expect(r.elapsed).toBeLessThan(60_000);
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
