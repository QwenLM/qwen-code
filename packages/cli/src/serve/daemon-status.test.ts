/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AcpHttpConnectionDiagnostic,
  AcpHttpHandle,
  AcpHttpSnapshot,
} from './acp-http/index.js';
import type {
  AcpSessionBridge,
  BridgeDaemonStatusSnapshot,
} from './acp-session-bridge.js';
import { DeviceFlowRegistry } from './auth/device-flow.js';
import {
  buildDaemonStatusResponse,
  type BuildDaemonStatusOptions,
  type DaemonMetricsBucket,
} from './daemon-status.js';
import type { ChannelWorkerSnapshot } from './channel-worker-supervisor.js';
import type { RateLimiterInstance, RateLimitTier } from './rate-limit.js';
import type { DaemonWorkspaceService } from './workspace-service/index.js';
import type { DaemonLogger } from './daemon-logger.js';
import { createChildHeapPolicy } from '@qwen-code/acp-bridge/childHeapPolicy';
import { resolveDaemonMemoryBudget } from '@qwen-code/acp-bridge/daemonMemoryBudget';

const BASE_WORKSPACE = '/work/status';

const BASE_BRIDGE_SNAPSHOT: BridgeDaemonStatusSnapshot = {
  limits: {
    maxSessions: 20,
    maxPendingPromptsPerSession: 5,
    eventRingSize: 8000,
    compactedReplayMaxBytes: 4 * 1024 * 1024,
    maxJournalEvents: 10_000,
    maxJournalBytes: 8 * 1024 * 1024,
    journalGrowth: null,
    channelIdleTimeoutMs: 0,
    sessionIdleTimeoutMs: 1_800_000,
  },
  sessionCount: 0,
  pendingPermissionCount: 0,
  channelLive: true,
  permissionPolicy: 'first-responder',
  sessions: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('buildDaemonStatusResponse', () => {
  it('uses one logger snapshot and exposes summary/full log diagnostics', async () => {
    const getStatus = vi.fn(() => ({
      runId: '0123456789abcdef0123456789abcdef',
      mode: 'stable' as const,
      health: 'ok' as const,
      issues: [] as const,
      droppedRecords: 2,
      droppedBytes: 42,
    }));
    const daemonLog = {
      getStatus,
      getDaemonId: () => 'daemon:123',
      getLogPath: () => '/runtime/debug/daemon/daemon.log',
    } as unknown as DaemonLogger;

    const summary = await buildDaemonStatusResponse(
      'summary',
      makeOptions({ daemonLog }),
    );
    expect(getStatus).toHaveBeenCalledOnce();
    expect(summary.daemon).toMatchObject({
      runId: '0123456789abcdef0123456789abcdef',
      logMode: 'stable',
      logHealth: 'ok',
    });
    expect(summary.daemon).not.toHaveProperty('logPath');
    expect(summary.daemon).not.toHaveProperty('logIssues');

    getStatus.mockClear();
    const full = await buildDaemonStatusResponse(
      'full',
      makeOptions({ daemonLog }),
    );
    expect(getStatus).toHaveBeenCalledOnce();
    expect(full.daemon).toMatchObject({
      logPath: '/runtime/debug/daemon/daemon.log',
      logIssues: [],
      logDroppedRecords: 2,
      logDroppedBytes: 42,
    });
  });

  it('rolls degraded logger health into a path-free warning', async () => {
    const daemonLog = {
      getStatus: () => ({
        runId: '0123456789abcdef0123456789abcdef',
        mode: 'stderr-only' as const,
        health: 'degraded' as const,
        issues: ['init_failed'] as const,
        droppedRecords: 0,
        droppedBytes: 0,
      }),
      getDaemonId: () => 'daemon:123',
      getLogPath: () => '/secret/path',
    } as unknown as DaemonLogger;
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({ daemonLog }),
    );

    expect(response.status).toBe('warning');
    expect(response.issues).toContainEqual({
      code: 'daemon_log_degraded',
      severity: 'warning',
      message:
        'Daemon file logging is degraded; inspect full status for details.',
    });
    expect(JSON.stringify(response.issues)).not.toContain('/secret/path');
  });

  it('includes maxTotalSessions in daemon status limits', async () => {
    const options = makeOptions();
    options.opts.maxTotalSessions = 50;
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.limits.maxTotalSessions).toBe(50);
  });

  it('reports the modeled partition without claiming it is applied', async () => {
    const budget = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
    const options = makeOptions();
    options.opts.daemonMemoryBudget = budget;
    const policy = createChildHeapPolicy({ budget, mode: 'observe' });
    policy.decide(10_000); // one would-be refusal, so the counter is not trivially 0
    options.getChildHeapPolicySnapshot = () => policy.snapshot();

    const response = await buildDaemonStatusResponse('summary', options);

    // The figures an operator needs to judge the partition for themselves —
    // publishing them is the substitute for a refusal count that cannot say
    // whether the ceiling would fit their workload.
    expect(response.limits.memory).toMatchObject({
      enforced: false,
      childHeap: {
        mode: 'observe',
        maxConcurrentChildren: 7,
        perChildCeilingMb: 526,
        refusals: 1,
      },
    });
  });

  it('reports no child-heap policy as null rather than as a disabled one', async () => {
    // Direct-embed and the bootstrap window build no policy. `null` says
    // "there is no policy", which a client must not read as "mode off".
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 8_192,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.limits.memory).toMatchObject({
      enforced: false,
      childHeap: null,
    });
  });

  it('reports adaptive journal growth as the budget runtime effect', async () => {
    // Growth is the one figure under limits.memory with runtime effect;
    // the daemon status must expose it — pool ownership/size, hard cap,
    // and the baselines sessions grow from — alongside the modeled
    // partition that stays unapplied.
    const poolBytes = 204 * 1024 * 1024;
    const options = makeOptions({
      bridgeSnapshot: {
        ...BASE_BRIDGE_SNAPSHOT,
        limits: {
          ...BASE_BRIDGE_SNAPSHOT.limits,
          journalGrowth: {
            poolBytes,
            hardCapBytes: 256 * 1024 * 1024,
          },
        },
      },
    });
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 8_192,
    });

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.limits.memory).toMatchObject({
      enforced: false,
      journalGrowth: {
        poolBytes,
        hardCapBytes: 256 * 1024 * 1024,
        baselineMaxEvents: 10_000,
        baselineMaxBytes: 8 * 1024 * 1024,
      },
    });
  });

  it('reports disabled journal growth as null rather than omitting it', async () => {
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 8_192,
    });

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.limits.memory).toMatchObject({
      journalGrowth: null,
    });
  });

  it('reports an off policy as present but modeling nothing', async () => {
    // The third state, and the reason the two above are not enough: a policy
    // exists and its mode is visible, but it published no partition. On this
    // same budget `observe` reports 7 children at 526 MB, so carrying those
    // figures here would show an operator a partition they turned off.
    const options = makeOptions();
    const budget = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
    options.opts.daemonMemoryBudget = budget;
    const policy = createChildHeapPolicy({ budget, mode: 'off' });
    options.getChildHeapPolicySnapshot = () => policy.snapshot();

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.limits.memory).toMatchObject({
      enforced: false,
      childHeap: {
        mode: 'off',
        maxConcurrentChildren: null,
        perChildCeilingMb: null,
        refusals: 0,
      },
    });
  });

  it('reports the resolved memory budget in daemon status limits', () => {
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });
    return buildDaemonStatusResponse('summary', options).then((response) => {
      expect(response.limits.memory).toMatchObject({
        enforced: false,
        configuredBudgetMb: 16_384,
        effectiveBudgetMb: 16_384,
        budgetSource: 'derived',
        availableMemoryMb: 32_768,
        insufficientMemory: false,
        modeled: {
          rootReserveMb: 1_024,
          childPoolMb: 15_360,
          legacyChildCeilingMb: 16_384,
        },
      });
    });
  });

  it('distinguishes the configured budget from the effective one', async () => {
    // Every other case injects a budget equal to half of available memory, so
    // configured === effective and transposing the two mapping lines would go
    // unnoticed. This one forces them apart.
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      budgetMb: 65_536,
      availableMemoryMb: 32_768,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.limits.memory).toMatchObject({
      configuredBudgetMb: 65_536,
      effectiveBudgetMb: 32_768,
      budgetSource: 'flag',
    });
  });

  it('reports live child counts and advisory shares under runtime', async () => {
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    // The single bound workspace has a live channel in BASE_BRIDGE_SNAPSHOT.
    expect(response.runtime.memory).toEqual({
      registeredWorkspaces: 1,
      activeAcpChildren: 1,
      childRssCoverage: 'active_children',
      // No registry in this case, so there are no bridges to enumerate — the
      // honest reading is "nothing measured", not "no children".
      children: { rssBytes: 0, sampled: 0, oldestReadingAgeMs: null },
      modeled: {
        recommendedShareAtRegisteredMb: 15_360,
        recommendedShareAtActiveMb: 15_360,
      },
      // Real process figures; asserted for shape here and for arithmetic in
      // the dedicated pressure tests. `toEqual` still fails on an extra key.
      pressure: expect.objectContaining({ mode: 'observe' }),
    });
  });

  it('models no per-child share when no ACP child is active', async () => {
    const options = makeOptions({
      bridgeSnapshot: { ...BASE_BRIDGE_SNAPSHOT, channelLive: false },
    });
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory).toMatchObject({
      activeAcpChildren: 0,
      modeled: { recommendedShareAtActiveMb: null },
    });
  });

  it('models no registered share when no workspace is registered', async () => {
    // With no registered entries the registered share must be null — the same
    // guard the active share already has — not the undivided child pool.
    const options = makeOptions();
    options.workspaceRegistry = {
      list: () => [],
      listManaged: () => [],
      listEntries: () => [],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory).toEqual({
      registeredWorkspaces: 0,
      activeAcpChildren: 0,
      childRssCoverage: 'active_children',
      // No registry in this case, so there are no bridges to enumerate — the
      // honest reading is "nothing measured", not "no children".
      children: { rssBytes: 0, sampled: 0, oldestReadingAgeMs: null },
      modeled: {
        recommendedShareAtRegisteredMb: null,
        recommendedShareAtActiveMb: null,
      },
      pressure: expect.objectContaining({ mode: 'observe' }),
    });
  });

  it('counts dynamically registered workspaces and only their live children', async () => {
    // The registered-vs-active gap this section exists to expose: two
    // workspaces registered, one with a live ACP child.
    const liveBridge = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const dormantBridge = {
      getDaemonStatusSnapshot: () => ({
        ...BASE_BRIDGE_SNAPSHOT,
        channelLive: false,
      }),
      isChannelLive: () => false,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const options = makeOptions();
    options.bridge = liveBridge;
    const runtimes = [
      {
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        bridge: liveBridge,
      },
      {
        workspaceId: 'dynamic',
        workspaceCwd: '/work/dynamic',
        bridge: dormantBridge,
      },
    ];
    options.workspaceRegistry = {
      primary: { workspaceCwd: BASE_WORKSPACE, bridge: liveBridge },
      list: () => runtimes,
      listManaged: () => runtimes,
      listEntries: () => [{}, {}],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory).toMatchObject({
      registeredWorkspaces: 2,
      activeAcpChildren: 1,
    });
    // The whole point: the two shares differ, and the registered one is the
    // pessimistic figure a count-based policy would have applied.
    expect(response.runtime.memory?.modeled).toEqual({
      recommendedShareAtRegisteredMb: 7_680,
      recommendedShareAtActiveMb: 15_360,
    });
  });

  it('sums only the children that actually reported, and says how many did', async () => {
    // Every state a live child can be in, in one response. `sampled` is what
    // separates "measured and small" from "never measured": without it, the
    // three unreported children below are indistinguishable from children
    // using no memory.
    const liveWith = (rssBytes: number, ageMs: number) =>
      ({
        getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
        isChannelLive: () => true,
        getChildResourceSnapshot: () => ({ rssBytes, cpuPercent: 1, ageMs }),
        lastActivityAt: null,
      }) as unknown as AcpSessionBridge;
    const liveUnpolled = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      // Live, but stale or never polled — the hook exists and returns nothing.
      getChildResourceSnapshot: () => undefined,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const liveOlderContract = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      // An injected bridge predating the hook entirely.
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const dormant = {
      getDaemonStatusSnapshot: () => ({
        ...BASE_BRIDGE_SNAPSHOT,
        channelLive: false,
      }),
      isChannelLive: () => false,
      // Deliberately unfaithful: the real hook self-gates on a live channel
      // and would return undefined here. This stub does not, so the test
      // fails unless the sum gates on `isChannelLive` itself.
      getChildResourceSnapshot: () => ({
        rssBytes: 999,
        cpuPercent: 1,
        ageMs: 1,
      }),
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;

    const runtimes = [
      // Descending age on purpose: with the oldest reading enumerated FIRST,
      // a plain-overwrite accumulator yields 1_000 and fails. Ascending order
      // would let "last contributor wins" pass with the same expectation.
      {
        workspaceId: 'a',
        workspaceCwd: BASE_WORKSPACE,
        bridge: liveWith(100, 9_000),
      },
      {
        workspaceId: 'b',
        workspaceCwd: '/work/b',
        bridge: liveWith(200, 1_000),
      },
      { workspaceId: 'c', workspaceCwd: '/work/c', bridge: liveUnpolled },
      { workspaceId: 'd', workspaceCwd: '/work/d', bridge: liveOlderContract },
      { workspaceId: 'e', workspaceCwd: '/work/e', bridge: dormant },
    ];
    const options = makeOptions();
    options.bridge = runtimes[0].bridge;
    options.workspaceRegistry = {
      primary: { workspaceCwd: BASE_WORKSPACE, bridge: runtimes[0].bridge },
      list: () => runtimes,
      listManaged: () => runtimes,
      listEntries: () => runtimes.map(() => ({})),
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory?.childRssCoverage).toBe('active_children');
    // Four children are live; only two reported. The dormant one is excluded
    // from both figures even though its stub would have returned a value.
    expect(response.runtime.memory?.activeAcpChildren).toBe(4);
    expect(response.runtime.memory?.children).toEqual({
      rssBytes: 300,
      sampled: 2,
      // The oldest contributor, not the newest: the sum spans this much time.
      oldestReadingAgeMs: 9_000,
    });
    // The gap is visible without the client having to know it exists.
    expect(response.runtime.memory!.children.sampled).toBeLessThan(
      response.runtime.memory!.activeAcpChildren,
    );
  });

  it('reports a zero age as zero, and ages a mixed-contract sum by the ones that can', async () => {
    // `ageMs` is exactly 0 when a status read lands in the same millisecond as
    // the sampler's stamp. A truthiness guard, or a trailing `|| null`, turns
    // that measured-fresh reading into `null` — which the field's own docs say
    // never means fresh.
    const freshBridge = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      getChildResourceSnapshot: () => ({
        rssBytes: 100,
        cpuPercent: 1,
        ageMs: 0,
      }),
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const withRegistry = (bridges: AcpSessionBridge[]) => {
      const runtimes = bridges.map((bridge, i) => ({
        workspaceId: `w${i}`,
        workspaceCwd: i === 0 ? BASE_WORKSPACE : `/work/w${i}`,
        bridge,
      }));
      const options = makeOptions();
      options.bridge = bridges[0];
      options.workspaceRegistry = {
        primary: { workspaceCwd: BASE_WORKSPACE, bridge: bridges[0] },
        list: () => runtimes,
        listManaged: () => runtimes,
        listEntries: () => runtimes.map(() => ({})),
      } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
      options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
        availableMemoryMb: 32_768,
      });
      return options;
    };

    const fresh = await buildDaemonStatusResponse(
      'summary',
      withRegistry([freshBridge]),
    );
    expect(fresh.runtime.memory?.children.oldestReadingAgeMs).toBe(0);

    // Mixing an age-carrying contributor with a pre-`ageMs` one must age the
    // sum by the ones that can report, not reset the whole thing to null.
    const olderContract = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      getChildResourceSnapshot: () => ({ rssBytes: 50, cpuPercent: 1 }),
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const aged = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      getChildResourceSnapshot: () => ({
        rssBytes: 70,
        cpuPercent: 1,
        ageMs: 5_000,
      }),
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const mixed = await buildDaemonStatusResponse(
      'summary',
      withRegistry([olderContract, aged]),
    );
    expect(mixed.runtime.memory?.children).toMatchObject({
      rssBytes: 120,
      sampled: 2,
      oldestReadingAgeMs: 5_000,
    });
  });

  it('counts a child whose bridge predates ageMs, but cannot age the sum', async () => {
    // Distinct from a missing hook: the hook is present and returns a reading,
    // it just carries no age. That child must still contribute memory, and
    // `null` must not be mistaken for "sampled nothing".
    const preAgeMs = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      getChildResourceSnapshot: () => ({ rssBytes: 512, cpuPercent: 3 }),
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const runtimes = [
      { workspaceId: 'a', workspaceCwd: BASE_WORKSPACE, bridge: preAgeMs },
    ];
    const options = makeOptions();
    options.bridge = preAgeMs;
    options.workspaceRegistry = {
      primary: { workspaceCwd: BASE_WORKSPACE, bridge: preAgeMs },
      list: () => runtimes,
      listManaged: () => runtimes,
      listEntries: () => [{}],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory?.children).toEqual({
      rssBytes: 512,
      sampled: 1,
      oldestReadingAgeMs: null,
    });
  });

  it('counts a draining workspace that still holds a live child', async () => {
    // A workspace mid-drain (or mid-replacement, or blocked) is dropped by
    // list() — active-state only — yet its ACP child is still alive. The live
    // count must reflect the process actually held, not the narrower
    // active-state view, or an admission policy would see free capacity that
    // does not exist.
    const primaryBridge = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      isChannelLive: () => true,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const drainingBridge = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT, // channelLive: true
      isChannelLive: () => true,
      // Reports RSS too: `list()` is active-state only and would drop this
      // draining-but-process-holding workspace, so summing over it instead of
      // `listManaged()` under-reports child RSS in exactly the drain window
      // while `activeAcpChildren` still counts the child.
      getChildResourceSnapshot: () => ({
        rssBytes: 4_096,
        cpuPercent: 1,
        ageMs: 10,
      }),
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const primaryRuntime = {
      workspaceId: 'primary',
      workspaceCwd: BASE_WORKSPACE,
      bridge: primaryBridge,
    };
    const drainingRuntime = {
      workspaceId: 'draining',
      workspaceCwd: '/work/draining',
      bridge: drainingBridge,
    };
    const options = makeOptions();
    options.bridge = primaryBridge;
    options.workspaceRegistry = {
      primary: primaryRuntime,
      // list() is active-state only: the draining workspace is absent.
      list: () => [primaryRuntime],
      // listManaged() is the process-holding set: both children are alive.
      listManaged: () => [primaryRuntime, drainingRuntime],
      listEntries: () => [{}, {}],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory).toMatchObject({
      registeredWorkspaces: 2,
      activeAcpChildren: 2,
    });
    // Only the draining bridge reports a reading, so this byte count can come
    // from nowhere else: it pins that the sum enumerates the process-holding
    // set (`listManaged()`), not the active-state set (`list()`), which would
    // drop this child and leave `sampled` at 0 — a silent under-report
    // confined to the drain window, while `activeAcpChildren` still counts it.
    expect(response.runtime.memory?.children).toMatchObject({
      rssBytes: 4_096,
      sampled: 1,
    });
  });

  it('counts a single workspace on the external-bridge path', async () => {
    // No registry installed (direct-embed / injected bridge): the fallback
    // must still report exactly one registered workspace.
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory).toMatchObject({
      registeredWorkspaces: 1,
      activeAcpChildren: 1,
    });
  });

  it('reports pressure figures in both modes, but only observe raises an issue', async () => {
    // A 1 MiB denominator puts this test process far past `critical`, which is
    // the only way to exercise the gate: at a realistic denominator the level
    // is `normal` and no issue is raised in either mode, so the assertion
    // below would hold even with the gate deleted.
    const responses = await Promise.all(
      (['off', 'observe'] as const).map((mode) => {
        const options = makeOptions();
        options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
          availableMemoryMb: 1,
        });
        options.opts.memoryPressureMode = mode;
        return buildDaemonStatusResponse('summary', options);
      }),
    );
    const [offResponse, observeResponse] = responses;

    // Both report the reading — that is the point of `off` still observing.
    for (const response of responses) {
      expect(response.runtime.memory?.pressure.level).toBe('critical');
      expect(response.runtime.memory?.pressure.availableBytes).toBe(
        1024 * 1024,
      );
    }
    expect(offResponse.runtime.memory?.pressure.mode).toBe('off');
    expect(observeResponse.runtime.memory?.pressure.mode).toBe('observe');

    // Only `observe` turns it into a verdict.
    const pressureIssues = (r: (typeof responses)[number]) =>
      r.issues.filter((issue) => issue.code === 'daemon_memory_pressure');
    expect(pressureIssues(offResponse)).toHaveLength(0);
    expect(pressureIssues(observeResponse)).toHaveLength(1);
    // Warning, not error, while the thresholds are uncalibrated.
    expect(pressureIssues(observeResponse)[0].severity).toBe('warning');
    // Pin the wire strings at runtime. Both the issue-code union member and
    // the `pressure` field declaration are otherwise guarded only by tsc,
    // which vitest does not run — a rename would ship green.
    expect(pressureIssues(observeResponse)[0].code).toBe(
      'daemon_memory_pressure',
    );
    expect(
      Object.keys(observeResponse.runtime.memory!.pressure).sort(),
    ).toEqual([
      'availableBytes',
      'heapLimitBytes',
      'heapRatio',
      'heapUsedBytes',
      'level',
      'mode',
      'ratio',
      'rssBytes',
      'rssRatio',
      'source',
    ]);
    // The denominator named in the message follows `source`; inverting the
    // ternary is otherwise invisible, and would send an operator hunting RSS
    // growth during a heap-driven incident.
    expect(pressureIssues(observeResponse)[0].message).toContain(
      'of available memory',
    );
    // Both halves of the documented contract: the issue reaches the rollup in
    // `observe` (a severity or list that bypassed it would leave this `ok`),
    // and `off` leaves the rollup exactly where it was. Same input, so the
    // only difference between these two is the mode.
    expect(observeResponse.status).not.toBe('ok');
    expect(offResponse.status).toBe('ok');
  });

  it('raises nothing on a healthy daemon, and a warning once pressure leaves normal', async () => {
    // The `level !== 'normal'` half of the gate. Without this, deleting that
    // clause keeps the whole suite green while every /daemon/status response
    // on a healthy daemon carries a daemon_memory_pressure warning and a
    // top-level `warning` status — the exact false positive `off` exists for.
    const healthy = makeOptions();
    healthy.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 1_048_576,
    });
    const healthyResponse = await buildDaemonStatusResponse('summary', healthy);
    expect(healthyResponse.runtime.memory?.pressure.level).toBe('normal');
    expect(
      healthyResponse.issues.filter(
        (issue) => issue.code === 'daemon_memory_pressure',
      ),
    ).toHaveLength(0);
    expect(healthyResponse.status).toBe('ok');

    // And the other side of the same clause: a denominator sized so this
    // process lands between the soft and hard thresholds must raise exactly
    // one warning. Tightening the gate to `=== 'critical'` fails here.
    const rss = process.memoryUsage().rss;
    const softOptions = makeOptions();
    softOptions.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      // Target ~57% — comfortably inside [0.5, 0.65) at either rounding edge.
      availableMemoryMb: Math.ceil(rss / 0.57 / (1024 * 1024)),
    });
    const softResponse = await buildDaemonStatusResponse(
      'summary',
      softOptions,
    );
    expect(softResponse.runtime.memory?.pressure.level).toBe('soft');
    expect(
      softResponse.issues.filter(
        (issue) => issue.code === 'daemon_memory_pressure',
      ),
    ).toHaveLength(1);
  });

  it('defaults to observe when no mode was configured', async () => {
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.memory?.pressure.mode).toBe('observe');
  });

  it('converts the budget from megabytes when computing the ratio', async () => {
    // The budget module speaks MB and the pressure module speaks bytes. A
    // missing 1024x here still yields a plausible-looking ratio, so assert the
    // denominator directly rather than trusting the level.
    const options = makeOptions();
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 4_096,
    });
    const response = await buildDaemonStatusResponse('summary', options);

    const pressure = response.runtime.memory!.pressure;
    expect(pressure.availableBytes).toBe(4_096 * 1024 * 1024);
    expect(pressure.rssRatio).toBeCloseTo(
      pressure.rssBytes / (4_096 * 1024 * 1024),
      10,
    );
  });

  it('omits memory reporting when no budget was resolved', async () => {
    const response = await buildDaemonStatusResponse('summary', makeOptions());

    expect(response.limits.memory).toBeNull();
    expect(response.runtime.memory).toBeUndefined();
  });

  it('warns when total session capacity is high and reports in-flight admission', async () => {
    const options = makeOptions({
      totalAdmissionInFlight: 1,
      bridgeSnapshot: {
        ...BASE_BRIDGE_SNAPSHOT,
        sessionCount: 7,
      },
    });
    options.opts.maxTotalSessions = 10;

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.sessions).toMatchObject({
      active: 7,
      admissionInFlight: 1,
    });
    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'total_session_capacity_high' }),
      ]),
    });
  });

  it('uses total admission live count for total session capacity warnings', async () => {
    const options = makeOptions({
      totalAdmissionLiveCount: 8,
      totalAdmissionInFlight: 1,
      bridgeSnapshot: {
        ...BASE_BRIDGE_SNAPSHOT,
        sessionCount: 1,
      },
    });
    options.opts.maxTotalSessions = 10;

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.sessions).toMatchObject({
      active: 1,
      admissionInFlight: 1,
    });
    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'total_session_capacity_high',
          message: 'Total active and in-flight sessions are at 9/10.',
        }),
      ]),
    });
  });

  it('still takes one snapshot per bridge when a memory budget is resolved', async () => {
    // The reuse above is guarded by a test that does not resolve a budget, so a
    // second snapshot pass taken only on the budget path would stay invisible
    // to it — while running on every production /daemon/status call.
    const primarySnapshot = vi.fn(() => BASE_BRIDGE_SNAPSHOT);
    const secondarySnapshot = vi.fn(() => BASE_BRIDGE_SNAPSHOT);
    const primaryBridge = {
      getDaemonStatusSnapshot: primarySnapshot,
      isChannelLive: () => true,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const secondaryBridge = {
      getDaemonStatusSnapshot: secondarySnapshot,
      isChannelLive: () => true,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const runtimes = [
      {
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        bridge: primaryBridge,
      },
      {
        workspaceId: 'secondary',
        workspaceCwd: '/work/secondary',
        bridge: secondaryBridge,
      },
    ];
    const options = makeOptions();
    options.bridge = primaryBridge;
    options.opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
      availableMemoryMb: 32_768,
    });
    options.workspaceRegistry = {
      primary: runtimes[0],
      list: () => runtimes,
      listManaged: () => runtimes,
      listEntries: () =>
        runtimes.map((r) => ({ workspaceCwd: r.workspaceCwd })),
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];

    await buildDaemonStatusResponse('summary', options);

    expect(primarySnapshot).toHaveBeenCalledTimes(1);
    expect(secondarySnapshot).toHaveBeenCalledTimes(1);
  });

  it('reuses the primary bridge snapshot when a workspace registry is installed', async () => {
    const primarySnapshot = vi.fn(() => ({
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 1,
    }));
    const secondarySnapshot = vi.fn(() => ({
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 2,
    }));
    const primaryBridge = {
      getDaemonStatusSnapshot: primarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const secondaryBridge = {
      getDaemonStatusSnapshot: secondarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const options = makeOptions();
    options.bridge = primaryBridge;
    options.workspaceRegistry = {
      primary: {
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        primary: true,
        trusted: true,
        bridge: primaryBridge,
      },
      list: () => [
        {
          workspaceId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          primary: true,
          trusted: true,
          bridge: primaryBridge,
        },
        {
          workspaceId: 'secondary',
          workspaceCwd: '/work/secondary',
          displayName: 'Secondary workspace',
          primary: false,
          trusted: true,
          bridge: secondaryBridge,
        },
      ],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(primarySnapshot).toHaveBeenCalledTimes(1);
    expect(secondarySnapshot).toHaveBeenCalledTimes(1);
    expect(response.runtime.sessions.active).toBe(3);
    expect(response.workspaces).toEqual([
      {
        id: 'primary',
        cwd: BASE_WORKSPACE,
        primary: true,
        trusted: true,
      },
      {
        id: 'secondary',
        cwd: '/work/secondary',
        displayName: 'Secondary workspace',
        primary: false,
        trusted: true,
      },
    ]);
  });

  it('aggregates an internal runtime without exposing its workspace path', async () => {
    const internalCwd = '/private/conversations-runtime';
    const primaryBridge = {
      getDaemonStatusSnapshot: () => BASE_BRIDGE_SNAPSHOT,
      lastActivityAt: null,
      pendingPromptTotal: 0,
      activePromptCount: 1,
    } as unknown as AcpSessionBridge;
    const internalBridge = {
      getDaemonStatusSnapshot: () => ({
        ...BASE_BRIDGE_SNAPSHOT,
        limits: { ...BASE_BRIDGE_SNAPSHOT.limits, maxSessions: 10 },
        sessionCount: 8,
        channelLive: false,
        sessions: [
          {
            sessionId: 'internal-session',
            workspaceCwd: internalCwd,
            createdAt: '2026-08-14T00:00:00.000Z',
            clientCount: 1,
            subscriberCount: 0,
            attachCount: 1,
            pendingPromptCount: 0,
            pendingPermissionCount: 0,
            hasActivePrompt: false,
            lastEventId: 0,
            maxJournalEvents: 10_000,
            maxJournalBytes: 8 * 1024 * 1024,
          },
        ],
      }),
      lastActivityAt: null,
      pendingPromptTotal: 2,
      activePromptCount: 3,
    } as unknown as AcpSessionBridge;
    const primary = {
      workspaceId: 'primary',
      workspaceCwd: BASE_WORKSPACE,
      primary: true,
      trusted: true,
      bridge: primaryBridge,
    };
    const internal = {
      workspaceId: 'internal',
      workspaceCwd: internalCwd,
      primary: false,
      trusted: true,
      provenance: 'live-conversation' as const,
      bridge: internalBridge,
    };
    const options = makeOptions();
    options.bridge = primaryBridge;
    options.workspaceRegistry = {
      primary,
      list: () => [primary],
      listAll: () => [primary, internal],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.sessions.active).toBe(8);
    expect(response.runtime.activity.activePrompts).toBe(4);
    expect(response.runtime.activity.queuedPrompts).toBe(2);
    expect(response.workspaces).toBeUndefined();
    expect(JSON.stringify(response.issues)).not.toContain(internalCwd);
    expect(response.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'session_capacity_high',
          message: expect.stringContaining('internal runtime'),
        }),
        expect.objectContaining({
          code: 'acp_channel_down',
          message: expect.stringContaining('internal runtime'),
        }),
      ]),
    );

    const full = await buildDaemonStatusResponse('full', options);
    expect(JSON.stringify(full.full?.sessions)).not.toContain(internalCwd);
  });

  it('reports every runtime issue code from daemon counters', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          limits: { ...BASE_BRIDGE_SNAPSHOT.limits, maxSessions: 10 },
          sessionCount: 8,
          pendingPermissionCount: 2,
          channelLive: false,
        },
        acpSnapshot: {
          connectionCount: 8,
          connectionCap: 10,
          connectionStreams: 1,
          sessionStreams: 1,
          sseStreams: 1,
          wsStreams: 0,
          pendingClientRequests: 0,
          bufferedConnectionFrames: 0,
          bufferedSessionFrames: 0,
          pendingDeliveryFrames: 0,
          preAttachOwnedFrames: 0,
          preAttachOwnedBytes: 0,
          preAttachGuardFailures: 0,
          connections: [],
        },
        rateLimitHits: { prompt: 1, mutation: 2, read: 3 },
        rateLimitEnabled: true,
      }),
    );

    expect(response).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'session_capacity_high' }),
        expect.objectContaining({ code: 'connection_capacity_high' }),
        expect.objectContaining({ code: 'pending_permissions' }),
        expect.objectContaining({ code: 'acp_channel_down' }),
        expect.objectContaining({ code: 'rate_limit_hits' }),
      ]),
    });
  });

  it('reports aggregate workspace-attributed ACP diagnostics in full status', async () => {
    const primaryDiagnostic = makeAcpDiagnostic(null, BASE_WORKSPACE, true);
    const secondaryDiagnostic = makeAcpDiagnostic(
      'secondary-id',
      '/work/secondary',
      false,
    );
    const primaryRegistrySnapshot = {
      connectionCount: 1,
      connectionCap: 10,
      connectionStreams: 1,
      sessionStreams: 0,
      sseStreams: 0,
      wsStreams: 1,
      pendingClientRequests: 0,
      bufferedConnectionFrames: 0,
      bufferedSessionFrames: 0,
      pendingDeliveryFrames: 0,
      preAttachOwnedFrames: 0,
      preAttachOwnedBytes: 0,
      preAttachGuardFailures: 0,
      connections: [primaryDiagnostic],
    };

    const response = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        acpSnapshot: primaryRegistrySnapshot,
        acpAggregate: {
          connectionCount: 2,
          connectionStreams: 2,
          sessionStreams: 0,
          sseStreams: 0,
          wsStreams: 2,
          pendingClientRequests: 0,
          bufferedConnectionFrames: 0,
          bufferedSessionFrames: 0,
          pendingDeliveryFrames: 1,
          preAttach: {
            usedFrames: 3,
            usedBytes: 4096,
            pendingDeliveryFrames: 1,
            highWaterFrames: 7,
            highWaterBytes: 8192,
            guardFailures: 4,
          },
          mounts: [
            {
              workspaceId: null,
              primary: true,
              connectionCount: 1,
              wsStreams: 1,
              preAttachGuardFailures: 1,
            },
            {
              workspaceId: 'secondary-id',
              primary: false,
              connectionCount: 1,
              wsStreams: 1,
              preAttachGuardFailures: 3,
            },
          ],
          connections: [primaryDiagnostic, secondaryDiagnostic],
        },
      }),
    );

    expect(response.runtime.transport.acp.connections).toBe(2);
    expect(response.runtime.transport.acp.preAttach).toEqual({
      bufferedConnectionFrames: 0,
      bufferedSessionFrames: 0,
      pendingDeliveryFrames: 1,
      usedFrames: 3,
      usedBytes: 4096,
      highWaterFrames: 7,
      highWaterBytes: 8192,
      guardFailures: 4,
    });
    expect(response.limits).toMatchObject({
      acpPreAttachMaxFramesPerStream: 256,
      acpPreAttachMaxFramesPerConnection: 1024,
      acpPreAttachMaxFramesGlobal: 4096,
      acpPreAttachMaxPayloadBytesPerConnection: 64 * 1024 * 1024,
      acpPreAttachMaxPayloadBytesGlobal: 256 * 1024 * 1024,
    });
    expect(response.full?.acpConnections).toEqual([
      primaryDiagnostic,
      secondaryDiagnostic,
    ]);
    expect(response.full?.acpMounts).toEqual([
      {
        workspaceId: null,
        primary: true,
        connectionCount: 1,
        wsStreams: 1,
        preAttachGuardFailures: 1,
      },
      {
        workspaceId: 'secondary-id',
        primary: false,
        connectionCount: 1,
        wsStreams: 1,
        preAttachGuardFailures: 3,
      },
    ]);
  });

  it('embeds runtime.metrics.series when getMetricsSeries is provided, and omits it otherwise', async () => {
    const base = makeOptions({});
    const withSeries = await buildDaemonStatusResponse('summary', {
      ...base,
      getMetricsSeries: () => [{ t: 1 } as DaemonMetricsBucket],
    });
    expect(withSeries.runtime.metrics?.series).toHaveLength(1);

    // Omitting the provider leaves no `metrics` key — backward compatible with
    // older clients that don't expect it.
    const without = await buildDaemonStatusResponse('summary', base);
    expect(without.runtime.metrics).toBeUndefined();
  });

  it('reports permanently failed channel worker snapshots as errors', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'failed',
          channels: ['telegram'],
          pid: 1234,
          error: 'ipc failed',
          restartCount: 2,
          lastExitAt: '2026-07-01T01:00:00.000Z',
          lastRestartAt: '2026-07-01T01:00:05.000Z',
          lastHeartbeatAt: '2026-07-01T00:59:50.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_exited',
          severity: 'error',
          message:
            'Channel worker is failed (pid=1234, restarts=2, lastExitAt=2026-07-01T01:00:00.000Z, lastRestartAt=2026-07-01T01:00:05.000Z, lastHeartbeatAt=2026-07-01T00:59:50.000Z): ipc failed.',
          section: 'runtime.channelWorker',
        }),
      ]),
      runtime: {
        channelWorker: {
          enabled: true,
          state: 'failed',
          channels: ['telegram'],
          pid: 1234,
          error: 'ipc failed',
          restartCount: 2,
          lastExitAt: '2026-07-01T01:00:00.000Z',
          lastRestartAt: '2026-07-01T01:00:05.000Z',
          lastHeartbeatAt: '2026-07-01T00:59:50.000Z',
        },
      },
    });
  });

  it('reports and diagnoses non-primary channel workers', async () => {
    const options = makeOptions({
      channelWorkerSnapshot: {
        enabled: false,
        state: 'disabled',
        channels: [],
      },
    });
    options.workspaceRegistry = {
      list: () => [
        {
          workspaceId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          primary: true,
          trusted: true,
          bridge: options.bridge,
        },
        {
          workspaceId: 'secondary',
          workspaceCwd: '/work/secondary',
          primary: false,
          trusted: true,
          bridge: options.bridge,
        },
      ],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    options.getChannelWorkerSnapshots = () => [
      {
        enabled: true,
        state: 'failed',
        channels: ['telegram'],
        error: 'secondary failed',
        workspaceId: 'secondary',
        workspaceCwd: '/work/secondary',
        primary: false,
      },
    ];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.channelWorkers).toEqual(
      options.getChannelWorkerSnapshots(),
    );
    expect(response).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_exited',
          severity: 'error',
          section: 'runtime.channelWorkers',
          message: expect.stringContaining('/work/secondary'),
        }),
      ]),
    });
  });

  it('preserves partial startup failures for multi-workspace workers', async () => {
    const options = makeOptions({
      channelWorkerSnapshot: {
        enabled: false,
        state: 'disabled',
        channels: [],
      },
    });
    options.workspaceRegistry = {
      list: () => [{ bridge: options.bridge }, { bridge: options.bridge }],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    const secondary = {
      enabled: true,
      state: 'running' as const,
      channels: ['telegram'],
      requestedChannels: ['telegram', 'feishu'],
      startupFailures: [
        {
          channel: 'feishu',
          phase: 'connect' as const,
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
      workspaceId: 'secondary',
      workspaceCwd: '/work/secondary',
      primary: false,
    };
    options.getChannelWorkerSnapshots = () => [secondary];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.channelWorkers).toEqual([secondary]);
    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_partial_connect',
          section: 'runtime.channelWorkers',
          message: expect.stringContaining('/work/secondary'),
        }),
      ]),
    });
  });

  it('omits channelWorkers for single-workspace and empty multi-workspace snapshots', async () => {
    const single = makeOptions();
    single.getChannelWorkerSnapshots = () => [
      {
        enabled: true,
        state: 'running',
        channels: ['telegram'],
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        primary: true,
      },
    ];
    expect(
      (await buildDaemonStatusResponse('summary', single)).runtime
        .channelWorkers,
    ).toBeUndefined();

    const multi = makeOptions();
    multi.workspaceRegistry = {
      list: () => [{ bridge: multi.bridge }, { bridge: multi.bridge }],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    multi.getChannelWorkerSnapshots = () => [];
    expect(
      (await buildDaemonStatusResponse('summary', multi)).runtime
        .channelWorkers,
    ).toBeUndefined();
  });

  it('warns for failed channel worker snapshots that still have a scheduled restart', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'failed',
          channels: ['telegram'],
          error: 'restart failed',
          restartCount: 1,
          nextRestartAt: '2026-07-01T01:01:00.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_exited',
          severity: 'warning',
          message:
            'Channel worker is failed (restarts=1, nextRestartAt=2026-07-01T01:01:00.000Z): restart failed.',
          section: 'runtime.channelWorker',
        }),
      ]),
    });
  });

  it('does not warn for a running channel worker that restarted successfully', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'running',
          channels: ['telegram'],
          requestedChannels: ['telegram'],
          pid: 2345,
          restartCount: 1,
          lastRestartAt: '2026-07-01T01:00:00.000Z',
          lastHeartbeatAt: '2026-07-01T01:00:10.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'ok',
      issues: [],
      runtime: {
        channelWorker: {
          enabled: true,
          state: 'running',
          pid: 2345,
          restartCount: 1,
          lastRestartAt: '2026-07-01T01:00:00.000Z',
          lastHeartbeatAt: '2026-07-01T01:00:10.000Z',
        },
      },
    });
  });

  it('warns when a running channel worker only connected part of its requested channels', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'running',
          channels: ['telegram'],
          requestedChannels: ['telegram', 'feishu', 'dingtalk'],
          startupFailures: [
            {
              channel: 'feishu',
              phase: 'connect',
              code: 'ECONNREFUSED',
              message: 'connection refused',
            },
          ],
          pid: 1234,
          restartCount: 1,
          lastHeartbeatAt: '2026-07-01T01:00:10.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_partial_connect',
          severity: 'warning',
          message:
            'Channel worker connected 1/3 channel(s). Failed: feishu, dingtalk.',
          section: 'runtime.channelWorker',
        }),
      ]),
      runtime: {
        channelWorker: {
          enabled: true,
          state: 'running',
          channels: ['telegram'],
          requestedChannels: ['telegram', 'feishu', 'dingtalk'],
          startupFailures: [
            {
              channel: 'feishu',
              phase: 'connect',
              code: 'ECONNREFUSED',
              message: 'connection refused',
            },
          ],
          pid: 1234,
        },
      },
    });
  });

  it('rolls up statuses inside tools, hooks, and extensions', async () => {
    const response = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        toolsStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          acpChannelLive: true,
          tools: [{ name: 'broken-tool', enabled: true, status: 'error' }],
        },
        hooksStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          disabled: false,
          hooks: [{ kind: 'hook', eventName: 'Stop', status: 'warning' }],
          events: {},
        },
        extensionsStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          extensions: [{ kind: 'extension', id: 'broken', status: 'error' }],
        },
      }),
    );

    expect(response).toMatchObject({
      full: {
        workspace: {
          tools: { status: 'error' },
          hooks: { status: 'warning' },
          extensions: { status: 'error' },
        },
      },
    });
  });

  it('reports MCP budget warning and exhausted issue codes', async () => {
    const warning = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          clientCount: 3,
          clientBudget: 4,
          servers: [],
        },
      }),
    );
    expect(warning).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'mcp_budget_warning' }),
      ]),
    });

    const exhausted = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          clientCount: 4,
          clientBudget: 4,
          servers: [],
        },
      }),
    );
    expect(exhausted).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'mcp_budget_exhausted' }),
      ]),
    });
  });

  it('summarizes MCP server health in workspace.mcp.summary', async () => {
    const response = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          servers: [
            { name: 'a', mcpStatus: 'connected', disabled: false },
            { name: 'b', mcpStatus: 'connected', disabled: false },
            {
              name: 'c',
              mcpStatus: 'disconnected',
              status: 'error',
              disabled: false,
            },
            { name: 'd', disabled: true },
          ],
        },
      }),
    );
    const mcpSummary = response.full?.workspace?.['mcp']?.summary;
    expect(mcpSummary).toMatchObject({
      serversCount: 4,
      serversConnected: 2,
      serversErrored: 1,
      serversDisabled: 1,
    });
  });

  it('marks a timed-out full workspace section unavailable', async () => {
    vi.useFakeTimers();

    const pending = buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: new Promise(() => {}),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'workspace_status_unavailable',
          section: 'mcp',
        }),
      ]),
      full: {
        workspace: {
          mcp: {
            status: 'unavailable',
            error: { kind: 'timeout' },
          },
        },
      },
    });
  });

  it('includes additive daemon startup timing when provided', async () => {
    const options = makeOptions() as BuildDaemonStatusOptions & {
      startup: {
        processStartedAt: string;
        listenerReadyAt?: string;
        processToListenMs?: number;
        runQwenServeToListenMs?: number;
        preheat: { status: string; durationMs?: number; error?: string };
      };
    };
    options.startup = {
      processStartedAt: '2026-06-23T08:00:00.000Z',
      listenerReadyAt: '2026-06-23T08:00:01.250Z',
      processToListenMs: 1250,
      runQwenServeToListenMs: 500,
      preheat: { status: 'succeeded', durationMs: 300 },
    };

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response).toMatchObject({
      status: 'ok',
      daemon: {
        startup: {
          processStartedAt: '2026-06-23T08:00:00.000Z',
          listenerReadyAt: '2026-06-23T08:00:01.250Z',
          processToListenMs: 1250,
          runQwenServeToListenMs: 500,
          preheat: { status: 'succeeded', durationMs: 300 },
        },
      },
    });
  });

  it('includes additive daemon performance data when provided', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        perfSnapshot: {
          eventLoop: { meanMs: 1, p50Ms: 2, p99Ms: 3, maxMs: 4 },
          promptQueueWait: { count: 2, meanMs: 15, maxMs: 25, lastMs: 5 },
          pipe: {
            inbound: { count: 5, totalBytes: 600, maxBytes: 300 },
            outbound: { count: 7, totalBytes: 800, maxBytes: 400 },
          },
        },
      }),
    );

    expect(response.runtime.perf).toEqual({
      eventLoop: { meanMs: 1, p50Ms: 2, p99Ms: 3, maxMs: 4 },
      promptQueueWait: { count: 2, meanMs: 15, maxMs: 25, lastMs: 5 },
      pipe: {
        inbound: { count: 5, totalBytes: 600, maxBytes: 300 },
        outbound: { count: 7, totalBytes: 800, maxBytes: 400 },
      },
    });
  });

  it('omits daemon performance data when no provider is injected', async () => {
    const response = await buildDaemonStatusResponse('summary', makeOptions());

    expect(response.runtime).not.toHaveProperty('perf');
  });

  it('includes activity fields in runtime', async () => {
    vi.useFakeTimers({ now: 1719990005000 });
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        activePromptCount: 3,
        lastActivityAt: 1719990000000,
      }),
    );
    expect(response.runtime.activity).toEqual({
      activePrompts: 3,
      pendingPrompts: 0,
      queuedPrompts: 0,
      lastActivityAt: '2024-07-03T07:00:00.000Z',
      idleSinceMs: 5000,
    });
  });

  it('summarizes pending and queued prompts across sessions without warning', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        activePromptCount: 1,
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          sessionCount: 2,
          sessions: [
            {
              sessionId: 's1',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:00:00.000Z',
              clientCount: 2,
              subscriberCount: 2,
              attachCount: 2,
              pendingPromptCount: 3,
              pendingPermissionCount: 0,
              hasActivePrompt: true,
              lastEventId: 10,
              maxJournalEvents: 10_000,
              maxJournalBytes: 8 * 1024 * 1024,
            },
            {
              sessionId: 's2',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:01:00.000Z',
              clientCount: 1,
              subscriberCount: 1,
              attachCount: 1,
              pendingPromptCount: 0,
              pendingPermissionCount: 0,
              hasActivePrompt: false,
              lastEventId: 0,
              maxJournalEvents: 10_000,
              maxJournalBytes: 8 * 1024 * 1024,
            },
          ],
        },
      }),
    );

    expect(response.runtime.activity).toMatchObject({
      activePrompts: 1,
      pendingPrompts: 3,
      queuedPrompts: 2,
    });
    expect(response.status).toBe('ok');
  });

  it('uses bridge queued prompt total when available', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        pendingPromptTotal: 0,
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          sessions: [
            {
              sessionId: 's1',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:00:00.000Z',
              clientCount: 1,
              subscriberCount: 1,
              attachCount: 1,
              pendingPromptCount: 1,
              pendingPermissionCount: 0,
              hasActivePrompt: false,
              lastEventId: 1,
              maxJournalEvents: 10_000,
              maxJournalBytes: 8 * 1024 * 1024,
            },
          ],
        },
      }),
    );

    expect(response.runtime.activity).toMatchObject({
      pendingPrompts: 1,
      queuedPrompts: 0,
    });
  });

  it('derives queued prompts per runtime when pendingPromptTotal is unavailable', async () => {
    const primarySnapshot = {
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 1,
      sessions: [
        {
          sessionId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          createdAt: '2026-07-01T00:00:00.000Z',
          clientCount: 1,
          subscriberCount: 1,
          attachCount: 1,
          pendingPromptCount: 3,
          pendingPermissionCount: 0,
          hasActivePrompt: true,
          lastEventId: 1,
          maxJournalEvents: 10_000,
          maxJournalBytes: 8 * 1024 * 1024,
        },
      ],
    };
    const secondarySnapshot = {
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 1,
      sessions: [
        {
          sessionId: 'secondary',
          workspaceCwd: '/work/secondary',
          createdAt: '2026-07-01T00:00:00.000Z',
          clientCount: 1,
          subscriberCount: 1,
          attachCount: 1,
          pendingPromptCount: 2,
          pendingPermissionCount: 0,
          hasActivePrompt: false,
          lastEventId: 1,
          maxJournalEvents: 10_000,
          maxJournalBytes: 8 * 1024 * 1024,
        },
      ],
    };
    const primaryBridge = {
      getDaemonStatusSnapshot: () => primarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const secondaryBridge = {
      getDaemonStatusSnapshot: () => secondarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const options = makeOptions();
    options.bridge = primaryBridge;
    options.workspaceRegistry = {
      primary: {
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        primary: true,
        trusted: true,
        bridge: primaryBridge,
      },
      list: () => [
        {
          workspaceId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          primary: true,
          trusted: true,
          bridge: primaryBridge,
        },
        {
          workspaceId: 'secondary',
          workspaceCwd: '/work/secondary',
          primary: false,
          trusted: true,
          bridge: secondaryBridge,
        },
      ],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.activity).toMatchObject({
      pendingPrompts: 5,
      queuedPrompts: 4,
    });
  });

  it('does not report negative queued prompts from inconsistent snapshots', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        activePromptCount: 1,
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          sessions: [
            {
              sessionId: 's1',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:00:00.000Z',
              clientCount: 1,
              subscriberCount: 1,
              attachCount: 1,
              pendingPromptCount: 0,
              pendingPermissionCount: 0,
              hasActivePrompt: true,
              lastEventId: 1,
              maxJournalEvents: 10_000,
              maxJournalBytes: 8 * 1024 * 1024,
            },
          ],
        },
      }),
    );

    expect(response.runtime.activity).toMatchObject({
      pendingPrompts: 0,
      queuedPrompts: 0,
    });
  });

  it('reports null activity when daemon has never been active', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({ activePromptCount: 0, lastActivityAt: null }),
    );
    expect(response.runtime.activity).toEqual({
      activePrompts: 0,
      pendingPrompts: 0,
      queuedPrompts: 0,
      lastActivityAt: null,
      idleSinceMs: null,
    });
  });
});

function makeAcpDiagnostic(
  workspaceId: string | null,
  workspaceCwd: string,
  primary: boolean,
): AcpHttpConnectionDiagnostic {
  return {
    connectionIdPrefix: primary ? 'primary' : 'secondary',
    fromLoopback: true,
    destroyed: false,
    lastActiveMs: 0,
    ownedSessionCount: 0,
    sessionBindingCount: 0,
    closingSessionCount: 0,
    pendingClientRequests: 0,
    connectionStreamOpen: true,
    sessionStreams: 0,
    sseStreams: 0,
    wsStreams: 1,
    bufferedConnectionFrames: 0,
    bufferedSessionFrames: 0,
    pendingDeliveryFrames: 0,
    preAttachOwnedFrames: 0,
    preAttachOwnedBytes: 0,
    workspaceId,
    workspaceCwd,
    primary,
  };
}

interface MakeOptionsInput {
  bridgeSnapshot?: BridgeDaemonStatusSnapshot;
  acpSnapshot?: ReturnType<AcpHttpHandle['registry']['getSnapshot']>;
  acpAggregate?: AcpHttpSnapshot;
  rateLimitHits?: Record<RateLimitTier, number>;
  rateLimitEnabled?: boolean;
  mcpStatus?: unknown;
  toolsStatus?: unknown;
  hooksStatus?: unknown;
  extensionsStatus?: unknown;
  channelWorkerSnapshot?: ChannelWorkerSnapshot;
  perfSnapshot?: {
    eventLoop: { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number };
    promptQueueWait: {
      count: number;
      meanMs: number;
      maxMs: number;
      lastMs: number | null;
    };
    pipe: {
      inbound: { count: number; totalBytes: number; maxBytes: number };
      outbound: { count: number; totalBytes: number; maxBytes: number };
    };
  };
  activePromptCount?: number;
  pendingPromptTotal?: number;
  lastActivityAt?: number | null;
  totalAdmissionLiveCount?: number;
  totalAdmissionInFlight?: number;
  daemonLog?: DaemonLogger;
}

function makeOptions(input: MakeOptionsInput = {}): BuildDaemonStatusOptions {
  const registry = new DeviceFlowRegistry({
    events: { publish: () => {} },
    resolveProvider: () => undefined,
    scheduleInterval: () => fakeInterval(),
    clearScheduledInterval: () => {},
  });
  const bridge = {
    getDaemonStatusSnapshot: () => input.bridgeSnapshot ?? BASE_BRIDGE_SNAPSHOT,
    getWorkspaceToolsStatus: async () =>
      input.toolsStatus ?? okStatus({ tools: [] }),
    activePromptCount: input.activePromptCount ?? 0,
    pendingPromptTotal: input.pendingPromptTotal,
    lastActivityAt: input.lastActivityAt ?? null,
  } as unknown as AcpSessionBridge;
  const workspace = {
    getWorkspaceMcpStatus: async () =>
      input.mcpStatus ?? okStatus({ servers: [] }),
    getWorkspaceSkillsStatus: async () => okStatus({ skills: [] }),
    getWorkspaceProvidersStatus: async () => okStatus({ providers: [] }),
    getWorkspaceEnvStatus: async () => okStatus({ cells: [] }),
    getWorkspacePreflightStatus: async () => okStatus({ cells: [] }),
    getWorkspaceHooksStatus: async () =>
      input.hooksStatus ?? okStatus({ hooks: [], events: {} }),
    getWorkspaceExtensionsStatus: async () =>
      input.extensionsStatus ?? okStatus({ extensions: [] }),
  } as unknown as DaemonWorkspaceService;

  return {
    opts: {
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
      rateLimit: input.rateLimitEnabled,
    },
    boundWorkspace: BASE_WORKSPACE,
    bridge,
    workspace,
    qwenCodeVersion: 'test',
    daemonLog: input.daemonLog,
    ...(input.acpSnapshot
      ? {
          acpHandle: {
            registry: { getSnapshot: () => input.acpSnapshot },
            getSnapshot: () =>
              input.acpAggregate ?? {
                connectionCount: input.acpSnapshot!.connectionCount,
                connectionStreams: input.acpSnapshot!.connectionStreams,
                sessionStreams: input.acpSnapshot!.sessionStreams,
                sseStreams: input.acpSnapshot!.sseStreams,
                wsStreams: input.acpSnapshot!.wsStreams,
                pendingClientRequests: input.acpSnapshot!.pendingClientRequests,
                bufferedConnectionFrames:
                  input.acpSnapshot!.bufferedConnectionFrames,
                bufferedSessionFrames: input.acpSnapshot!.bufferedSessionFrames,
                pendingDeliveryFrames: input.acpSnapshot!.pendingDeliveryFrames,
                preAttach: {
                  usedFrames: input.acpSnapshot!.preAttachOwnedFrames,
                  usedBytes: input.acpSnapshot!.preAttachOwnedBytes,
                  pendingDeliveryFrames:
                    input.acpSnapshot!.pendingDeliveryFrames,
                  highWaterFrames: input.acpSnapshot!.preAttachOwnedFrames,
                  highWaterBytes: input.acpSnapshot!.preAttachOwnedBytes,
                  guardFailures: input.acpSnapshot!.preAttachGuardFailures,
                },
                mounts: [
                  {
                    workspaceId: null,
                    primary: true,
                    connectionCount: input.acpSnapshot!.connectionCount,
                    wsStreams: input.acpSnapshot!.wsStreams,
                    preAttachGuardFailures:
                      input.acpSnapshot!.preAttachGuardFailures,
                  },
                ],
                connections: [],
              },
          } as unknown as AcpHttpHandle,
        }
      : {}),
    ...(input.rateLimitHits
      ? { rateLimiter: makeRateLimiter(input.rateLimitHits) }
      : {}),
    getRestSseActive: () => 0,
    features: ['health', 'daemon_status'],
    protocolVersions: { current: 'v1', supported: ['v1'] },
    supportedDeviceFlowProviders: ['qwen-oauth'],
    deviceFlowRegistry: registry,
    sessionShellCommandEnabled: false,
    ...(input.channelWorkerSnapshot
      ? { getChannelWorkerSnapshot: () => input.channelWorkerSnapshot! }
      : {}),
    ...(input.perfSnapshot
      ? { getPerfSnapshot: () => input.perfSnapshot! }
      : {}),
    ...(input.totalAdmissionInFlight === undefined
      ? {}
      : {
          getTotalSessionAdmissionSnapshot: () => ({
            liveCount:
              input.totalAdmissionLiveCount ??
              (input.bridgeSnapshot ?? BASE_BRIDGE_SNAPSHOT).sessionCount,
            inFlight: input.totalAdmissionInFlight!,
          }),
        }),
  };
}

function okStatus(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    workspaceCwd: BASE_WORKSPACE,
    initialized: true,
    ...extra,
  };
}

function makeRateLimiter(
  hits: Record<RateLimitTier, number>,
): RateLimiterInstance {
  const middleware: RequestHandler = (_req, _res, next) => next();
  return {
    middleware,
    checkRate: () => true,
    reset: () => {},
    setDraining: () => {},
    dispose: () => {},
    getHitCounts: () => hits,
  };
}

function fakeInterval(): ReturnType<typeof setInterval> {
  return {
    ref: () => {},
    unref: () => {},
  } as unknown as ReturnType<typeof setInterval>;
}
