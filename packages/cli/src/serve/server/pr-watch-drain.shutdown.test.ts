/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import type { SessionPrBindingSummary } from '../routes/session-pr-bindings.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  createPrWatchDrainState,
  runPrWatchDrainTick,
  stopPrWatch,
  type PrWatchDrainDeps,
  type PrWatchDrainState,
} from './pr-watch-drain.js';
import {
  claimPrWatchOwnershipSync,
  prWatchOwnerPath,
  readPrWatchStateSync,
  releaseOwnedPrWatchSync,
  writePrWatchStateSync,
  type PrWatchIdentity,
} from './pr-watch-store.js';

const identity: PrWatchIdentity = {
  host: 'github.com',
  repo: 'owner/repo',
  number: 42,
};
const KEY = 'pr-state:owner/repo#42:ci_failure:aaa';
const T0 = '2026-11-08T00:00:00.000Z';

let dir: string;
let state: PrWatchDrainState;
let locks: PathMutexRegistry;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pr-watch-shutdown-'));
  state = createPrWatchDrainState();
  locks = new PathMutexRegistry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function runtime(): WorkspaceRuntime {
  return {
    workspaceCwd: '/ws',
    trusted: true,
    primary: false,
  } as unknown as WorkspaceRuntime;
}

function binding(): SessionPrBindingSummary {
  return {
    sessionId: 's1',
    workspaceCwd: '/ws',
    prs: [{ number: 42, url: 'https://github.com/owner/repo/pull/42' }],
  };
}

function seedPending(): void {
  writePrWatchStateSync(dir, identity, {
    pr: identity,
    observedAt: T0,
    state: 'open',
    headSha: 'a'.repeat(40),
    checks: 'passing',
    pending: [
      { type: 'ci_failure', key: KEY, summary: 'CI failing', detectedAt: T0 },
    ],
  });
}

function makeDeps(overrides: Partial<PrWatchDrainDeps> = {}): PrWatchDrainDeps {
  return {
    watchDir: dir,
    locks,
    scanBindings: async () => ({ bindings: [binding()], partial: false }),
    resolveRuntime: () => runtime(),
    isSessionLive: () => true,
    wakeSession: async () => ({ kind: 'unavailable' }),
    admitPrompt: async () => ({ deduplicated: false }),
    readPushedHeads: async () => undefined,
    now: () => Date.parse(T0) + 60_000,
    log: () => {},
    ...overrides,
  };
}

/** A restore held open until the returned gate is opened. */
function gatedWake(): { deps: Partial<PrWatchDrainDeps>; open: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    open,
    deps: {
      isSessionLive: () => false,
      wakeSession: () =>
        gate.then(() => ({
          kind: 'restored' as const,
          release: async () => {},
        })),
    },
  };
}

describe('PrWatchDrainState.idle', () => {
  it('resolves immediately when nothing is in flight', async () => {
    await expect(state.idle()).resolves.toBeUndefined();
  });

  it('waits for a running tick', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const deps = makeDeps({
      scanBindings: () => gate.then(() => ({ bindings: [], partial: false })),
    });
    const tick = runPrWatchDrainTick([runtime()], deps, state);
    let settled = false;
    const idle = state.idle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    open();
    await tick;
    await idle;
    expect(settled).toBe(true);
  });

  it('waits for an off-tick restore and resolves once it settles', async () => {
    seedPending();
    const wake = gatedWake();
    const deps = makeDeps(wake.deps);
    await runPrWatchDrainTick([runtime()], deps, state);
    expect(state.restoring.size).toBe(1);
    let settled = false;
    const idle = state.idle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    wake.open();
    await idle;
    expect(settled).toBe(true);
    expect(state.restoring.size).toBe(0);
  });

  it('does not wait on an admitted mark left by a failed recording write', async () => {
    // That mark is a retry the next owner performs, not work in flight;
    // waiting on it would hold shutdown open forever.
    state.inFlight.set(KEY, { sessionId: 's1', admitted: true, group: null });
    await expect(state.idle()).resolves.toBeUndefined();
  });

  it('does not settle at tick end while a restore is still in flight', async () => {
    // A restore is dispatched, then a second tick runs and ends. settleIfIdle
    // fires at that tick's end with the restore still in flight and must not
    // resolve — idle()'s fast-path check cannot cover this, because the waiter
    // was registered while both were active.
    seedPending();
    const wake = gatedWake();
    await runPrWatchDrainTick([runtime()], makeDeps(wake.deps), state);
    expect(state.restoring.size).toBe(1);
    let openScan: () => void = () => {};
    const scanGate = new Promise<void>((resolve) => {
      openScan = resolve;
    });
    const second = runPrWatchDrainTick(
      [runtime()],
      makeDeps({
        scanBindings: () =>
          scanGate.then(() => ({ bindings: [], partial: false })),
      }),
      state,
    );
    await Promise.resolve();
    let settled = false;
    const idle = state.idle().then(() => {
      settled = true;
    });
    openScan();
    await second;
    await Promise.resolve();
    // The tick ended but the restore has not: still not idle.
    expect(settled).toBe(false);
    wake.open();
    await idle;
    expect(settled).toBe(true);
  });

  it('does not settle at restore end while another tick is still running', async () => {
    seedPending();
    const wake = gatedWake();
    await runPrWatchDrainTick([runtime()], makeDeps(wake.deps), state);
    expect(state.restoring.size).toBe(1);
    // A second tick is now in flight, parked on its scan.
    let openScan: () => void = () => {};
    const scanGate = new Promise<void>((resolve) => {
      openScan = resolve;
    });
    const second = runPrWatchDrainTick(
      [runtime()],
      makeDeps({
        scanBindings: () =>
          scanGate.then(() => ({ bindings: [], partial: false })),
      }),
      state,
    );
    await Promise.resolve();
    let settled = false;
    const idle = state.idle().then(() => {
      settled = true;
    });
    wake.open();
    await vi.waitFor(() => expect(state.restoring.size).toBe(0));
    await Promise.resolve();
    // The restore settled but the second tick has not: still not idle.
    expect(settled).toBe(false);
    openScan();
    await second;
    await idle;
    expect(settled).toBe(true);
  });

  it('settles every waiter, not just the first', async () => {
    const wake = gatedWake();
    seedPending();
    await runPrWatchDrainTick([runtime()], makeDeps(wake.deps), state);
    const all = Promise.all([state.idle(), state.idle(), state.idle()]);
    wake.open();
    await expect(all).resolves.toHaveLength(3);
  });
});

describe('stopPrWatch', () => {
  it('stops the timer and releases the record once idle', async () => {
    expect(claimPrWatchOwnershipSync(dir, () => {}).kind).toBe('claimed');
    const order: string[] = [];
    const logs: string[] = [];
    await stopPrWatch({
      state,
      watchDir: dir,
      stopTimer: () => order.push('stop'),
      log: (m) => {
        logs.push(m);
        order.push('log');
      },
    });
    expect(order[0]).toBe('stop');
    expect(existsSync(prWatchOwnerPath(dir))).toBe(false);
    expect(logs.some((l) => l.includes('released the owner record'))).toBe(
      true,
    );
  });

  it('keeps the record until an in-flight restore settles', async () => {
    claimPrWatchOwnershipSync(dir, () => {});
    seedPending();
    const wake = gatedWake();
    await runPrWatchDrainTick([runtime()], makeDeps(wake.deps), state);
    const stopped = stopPrWatch({
      state,
      watchDir: dir,
      stopTimer: () => {},
      timeoutMs: 5_000,
    });
    // A macrotask, not a microtask: one microtask turn is too early to observe
    // a release that must not happen, which would make the assertion vacuous.
    await new Promise((resolve) => setImmediate(resolve));
    // Still in flight: releasing now would let a successor overlap.
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
    wake.open();
    await stopped;
    expect(existsSync(prWatchOwnerPath(dir))).toBe(false);
  });

  it('keeps the record until the claim-holding tick settles', async () => {
    // Drain-idle alone is not enough: the observation holds the claim without
    // ever entering a drain tick.
    claimPrWatchOwnershipSync(dir, () => {});
    let openTick: () => void = () => {};
    const tickGate = new Promise<void>((resolve) => {
      openTick = resolve;
    });
    const stopped = stopPrWatch({
      state,
      watchDir: dir,
      stopTimer: () => {},
      waitForTick: () => tickGate,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
    openTick();
    await stopped;
    expect(existsSync(prWatchOwnerPath(dir))).toBe(false);
  });

  it('keeps the record when the tick outlasts the shutdown wait', async () => {
    claimPrWatchOwnershipSync(dir, () => {});
    const logs: string[] = [];
    let openTick: () => void = () => {};
    const tickGate = new Promise<void>((resolve) => {
      openTick = resolve;
    });
    await stopPrWatch({
      state,
      watchDir: dir,
      stopTimer: () => {},
      waitForTick: () => tickGate,
      timeoutMs: 20,
      log: (m) => logs.push(m),
    });
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
    expect(logs.some((l) => l.includes('keeping the owner record'))).toBe(true);
    openTick();
  });

  it('keeps the record on timeout rather than letting a successor overlap', async () => {
    claimPrWatchOwnershipSync(dir, () => {});
    seedPending();
    const wake = gatedWake();
    const logs: string[] = [];
    await runPrWatchDrainTick([runtime()], makeDeps(wake.deps), state);
    await stopPrWatch({
      state,
      watchDir: dir,
      stopTimer: () => {},
      timeoutMs: 20,
      log: (m) => logs.push(m),
    });
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
    expect(logs.some((l) => l.includes('keeping the owner record'))).toBe(true);
    // The pending entry is untouched: the successor resumes it.
    const stored = readPrWatchStateSync(dir, identity);
    expect(stored.kind).toBe('state');
    wake.open();
    await vi.waitFor(() => expect(state.restoring.size).toBe(0));
  });

  it('releases nothing when this daemon never claimed', async () => {
    const logs: string[] = [];
    await stopPrWatch({
      state,
      watchDir: dir,
      stopTimer: () => {},
      log: (m) => logs.push(m),
    });
    expect(existsSync(prWatchOwnerPath(dir))).toBe(false);
    expect(logs).toEqual([]);
  });

  it('leaves a foreign owner record alone', async () => {
    claimPrWatchOwnershipSync(dir, () => {});
    // A record this machine cannot verify blocks the claim and must survive
    // our shutdown: it is not ours to remove.
    writeFileSync(
      prWatchOwnerPath(dir),
      JSON.stringify({
        pid: process.pid,
        procStart: 'foreign-boot:0',
        startedAt: new Date().toISOString(),
      }),
    );
    await stopPrWatch({ state, watchDir: dir, stopTimer: () => {} });
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
  });

  it('refuses a foreign PID namespace even when the process token matches', async () => {
    // The token really is this process's, so `isSameProcess` accepts it — and
    // where no token is readable (macOS/Windows) it degrades to PID liveness.
    // The claim still refuses the record, so the release must apply the claim's
    // identity rule too. Reproduces on every platform, not just those two.
    expect(claimPrWatchOwnershipSync(dir, () => {}).kind).toBe('claimed');
    const ownerPath = prWatchOwnerPath(dir);
    const record = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
      pidNs?: number | null;
    };
    writeFileSync(
      ownerPath,
      JSON.stringify({ ...record, pidNs: (record.pidNs ?? 0) + 1 }),
    );
    expect(claimPrWatchOwnershipSync(dir, () => {}).kind).toBe('blocked');
    expect(releaseOwnedPrWatchSync(dir)).toBe(false);
    expect(existsSync(ownerPath)).toBe(true);
  });

  it('waits for a restore the tick dispatches after shutdown began', async () => {
    // Shutdown lands mid-observation: drain-idle is already true, and the tick
    // then enters a drain and dispatches a restore that outlives it. Sampling
    // the two arms in parallel releases the record while that restore is still
    // admitting; drain-idle has to be sampled after the tick ends.
    claimPrWatchOwnershipSync(dir, () => {});
    seedPending();
    const wake = gatedWake();
    let openTick: () => void = () => {};
    const tickGate = new Promise<void>((resolve) => {
      openTick = resolve;
    });
    const stopped = stopPrWatch({
      state,
      watchDir: dir,
      stopTimer: () => {},
      waitForTick: async () => {
        await tickGate;
        // The tick's drain runs to completion, leaving a restore in flight.
        await runPrWatchDrainTick([runtime()], makeDeps(wake.deps), state);
      },
      timeoutMs: 5_000,
    });
    let released = false;
    void stopped.then(() => {
      released = true;
    });
    openTick();
    await vi.waitFor(() => expect(state.restoring.size).toBe(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(released).toBe(false);
    expect(existsSync(prWatchOwnerPath(dir))).toBe(true);
    wake.open();
    await stopped;
    expect(existsSync(prWatchOwnerPath(dir))).toBe(false);
  });
});
