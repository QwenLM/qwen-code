/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServeProtocolVersions } from './capabilities.js';
import type { AcpHttpHandle, AcpHttpSnapshot } from './acp-http/index.js';
import {
  ACP_PRE_ATTACH_MAX_FRAMES_GLOBAL,
  ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION,
  ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM,
  ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_GLOBAL,
  ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION,
} from './acp-http/pre-attach-budget.js';
import type { DeviceFlowRegistry } from './auth/device-flow.js';
import type {
  DaemonLogger,
  DaemonLogHealth,
  DaemonLogIssue,
  DaemonLogMode,
} from './daemon-logger.js';
import type {
  AcpSessionBridge,
  BridgeDaemonStatusSnapshot,
} from './acp-session-bridge.js';
import {
  MAX_CHILD_HEAP_MB,
  MIN_CHILD_HEAP_MB,
  recommendedChildShareMb,
  type DaemonMemoryBudget,
} from '@qwen-code/acp-bridge/daemonMemoryBudget';
import type {
  ChildHeapMode,
  ChildHeapPolicySnapshot,
} from '@qwen-code/acp-bridge/childHeapPolicy';
import {
  computeDaemonMemoryPressure,
  type DaemonMemoryPressure,
} from './daemon-memory-pressure.js';
import { isLoopbackBind } from './loopback-binds.js';
import type { RateLimiterInstance, RateLimitTier } from './rate-limit.js';
import type { ServeOptions } from './types.js';
import type { ChannelWorkerSnapshot } from './channel-worker-supervisor.js';
import type { ChannelWorkerGroupSnapshot } from './channel-worker-group.js';
import type { DaemonMetricsBucket } from './daemon-metrics-ring.js';
import type {
  DaemonWorkspaceService,
  WorkspaceRequestContext,
} from './workspace-service/index.js';
import type { TotalSessionAdmissionSnapshot } from './total-session-admission.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import { isInternalWorkspaceRuntime } from './workspace-runtime-visibility.js';

// Re-export so downstream consumers (server.ts, routes, the SDK type mirror)
// import the bucket shape from the status module alongside the rest of the
// response contract, matching how DaemonPerfSnapshot is sourced.
export type { DaemonMetricsBucket };

const DEFAULT_LISTENER_MAX_CONNECTIONS = 256;
const SECTION_TIMEOUT_MS = 1_000;
const CAPACITY_WARNING_RATIO = 0.8;

export type DaemonStatusDetail = 'summary' | 'full';
export type DaemonStatusLevel = 'ok' | 'warning' | 'error';
type SectionStatus = DaemonStatusLevel | 'unavailable';
type IssueSeverity = 'warning' | 'error';
type SectionSummary = Record<string, string | number | boolean | null>;
type StatusRecord = Record<string, unknown>;

export type DaemonStartupPreheatStatus =
  | 'external_bridge'
  | 'not_scheduled'
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface DaemonStartupSnapshot {
  processStartedAt: string;
  listenerReadyAt?: string;
  processToListenMs?: number;
  runQwenServeToListenMs?: number;
  preheat: {
    status: DaemonStartupPreheatStatus;
    durationMs?: number;
    error?: string;
  };
}

export interface DaemonStatusIssue {
  code:
    | 'session_capacity_high'
    | 'total_session_capacity_high'
    | 'connection_capacity_high'
    | 'pending_permissions'
    | 'acp_channel_down'
    | 'preflight_error'
    | 'mcp_budget_warning'
    | 'mcp_budget_exhausted'
    | 'rate_limit_hits'
    | 'workspace_status_unavailable'
    | 'channel_worker_exited'
    | 'channel_worker_partial_connect'
    | 'daemon_runtime_starting'
    | 'daemon_runtime_failed'
    | 'daemon_log_degraded'
    | 'daemon_memory_pressure';
  severity: IssueSeverity;
  message: string;
  section?: string;
}

export interface ParseDaemonStatusDetailResult {
  ok: boolean;
  detail?: DaemonStatusDetail;
}

export interface BuildDaemonStatusOptions {
  opts: ServeOptions;
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspaceRegistry?: WorkspaceRegistry;
  workspace: DaemonWorkspaceService;
  daemonLog?: DaemonLogger;
  qwenCodeVersion?: string;
  acpHandle?: AcpHttpHandle;
  rateLimiter?: RateLimiterInstance;
  getRestSseActive: () => number;
  features: readonly string[];
  protocolVersions: ServeProtocolVersions;
  supportedDeviceFlowProviders: readonly string[];
  deviceFlowRegistry: DeviceFlowRegistry;
  sessionShellCommandEnabled: boolean;
  startup?: DaemonStartupSnapshot;
  getChannelWorkerSnapshot?: () => ChannelWorkerSnapshot;
  getChannelWorkerSnapshots?: () => ChannelWorkerGroupSnapshot[];
  getPerfSnapshot?: () => DaemonPerfSnapshot;
  getMetricsSeries?: () => DaemonMetricsBucket[];
  getTotalSessionAdmissionSnapshot?: () => TotalSessionAdmissionSnapshot;
  /** Returns undefined when no policy was built — direct-embed, or no budget. */
  getChildHeapPolicySnapshot?: () => ChildHeapPolicySnapshot | undefined;
}

interface DaemonStatusSection<T> {
  status: SectionStatus;
  durationMs: number;
  summary?: SectionSummary;
  data?: T;
  error?: {
    kind: 'timeout' | 'error';
    message: string;
  };
}

type WorkspaceStatusSection = DaemonStatusSection<unknown>;

interface FullDaemonStatus {
  sessions: BridgeDaemonStatusSnapshot['sessions'];
  acpMounts: AcpHttpSnapshot['mounts'];
  acpConnections: AcpHttpSnapshot['connections'];
  workspace: Record<string, WorkspaceStatusSection>;
  auth: {
    supportedDeviceFlowProviders: string[];
    pendingDeviceFlowCount: number;
  };
}

interface WorkspaceBridgeStatusSnapshot {
  workspaceCwd: string;
  internal?: boolean;
  snapshot: BridgeDaemonStatusSnapshot;
  lastActivity: number | null;
}

interface DaemonStatusSecurity {
  tokenConfigured: boolean;
  requireAuth: boolean;
  loopbackBind: boolean;
  allowOriginConfigured: boolean;
  allowOriginMode: string;
  sessionShellCommandEnabled: boolean;
}

interface DaemonStatusLimits {
  maxSessions: number | null;
  maxTotalSessions: number | null;
  maxPendingPromptsPerSession: number | null;
  listenerMaxConnections: number | null;
  eventRingSize: number;
  compactedReplayMaxBytes: number;
  maxJournalEvents: number;
  maxJournalBytes: number;
  promptDeadlineMs: number | null;
  writerIdleTimeoutMs: number | null;
  channelIdleTimeoutMs: number;
  sessionIdleTimeoutMs: number;
  sessionPromptSettledCloseGraceMs: number;
  acpConnectionCap: number | null;
  acpPreAttachMaxFramesPerStream: number | null;
  acpPreAttachMaxFramesPerConnection: number | null;
  acpPreAttachMaxFramesGlobal: number | null;
  acpPreAttachMaxPayloadBytesPerConnection: number | null;
  acpPreAttachMaxPayloadBytesGlobal: number | null;
  /**
   * The daemon's resolved memory figures. Observed and reported only: nothing
   * consumes them to size a child. `null` on paths that resolve none, such as
   * direct-embed bridges.
   */
  memory: DaemonStatusMemoryLimits | null;
}

export interface DaemonStatusMemoryLimits {
  /**
   * False, and required — scoped to the CHILD-HEAP model: every figure in
   * this section except `journalGrowth` is resolved input or a model of a
   * policy that does not exist yet; nothing sizes or bounds a child
   * process. The flag exists so a client can never mistake the modeled
   * partition for enforcement that has not shipped. Adaptive live-journal
   * growth IS a runtime effect of the budget and is reported separately
   * under `journalGrowth`.
   */
  enforced: false;
  /**
   * Adaptive live-journal growth derived from this budget — the one figure
   * in this section with runtime effect: session journal caps really do
   * grow within this pool mid-turn (per-session effective limits appear on
   * each session diagnostic in `detail=full`). `null` when growth is
   * disabled (an operator-pinned journal cap, or a budget that leaves no
   * usable pool). The pool is owned daemon-wide: every workspace bridge
   * accounts its sessions against the same single aggregate.
   */
  journalGrowth: {
    poolBytes: number;
    hardCapBytes: number;
    baselineMaxEvents: number;
    baselineMaxBytes: number;
  } | null;
  /**
   * The per-child heap partition the daemon models but does not apply.
   * `null` when no policy was built.
   */
  childHeap: {
    mode: ChildHeapMode;
    /**
     * Children the pool could host at once. 0 when no partition can be
     * modeled — either the pool cannot cover one child at the minimum heap,
     * or the ceiling would land under that minimum once capped at today's
     * host-derived one. `null` under `off`, which models nothing and so is
     * not the same claim as a pool that hosts zero children.
     */
    maxConcurrentChildren: number | null;
    /**
     * What each would receive. Never 0 and never below
     * `modeled.minChildHeapMb`; `null` instead, both under `off` and wherever
     * the partition cannot be modeled within that floor.
     */
    perChildCeilingMb: number | null;
    /**
     * Spawns that would have exceeded `maxConcurrentChildren`. Admission
     * pressure only: 0 does **not** mean the partition is safe to apply,
     * because children still run on the much larger host-derived ceiling.
     *
     * Two known sources of counts that are not capacity pressure: a channel
     * swap on a daemon already at `maxConcurrentChildren` books one, because
     * the terminating child is counted until it exits; and on a host too
     * small to model a partition this equals the total ACP spawn count, with
     * `insufficientMemory` as the field that says why.
     */
    refusals: number;
  } | null;
  /** What was asked for: the flag value, or half of available memory. */
  configuredBudgetMb: number;
  /** `configured` capped at resolved cgroup/host memory. */
  effectiveBudgetMb: number;
  budgetSource: 'flag' | 'derived';
  /** Cgroup limit when one applies, otherwise host total. */
  availableMemoryMb: number;
  availableMemorySource: 'constrained' | 'host';
  insufficientMemory: boolean;
  /**
   * Derived figures for a capacity policy that has not shipped. Grouped, and
   * named for what they are, so they cannot read as memory already reserved or
   * limits already applied.
   */
  modeled: {
    rootReserveMb: number;
    childPoolMb: number;
    minChildHeapMb: number;
    maxChildHeapMb: number;
    /**
     * A conservative model of the ceiling an ACP child receives today, with no
     * budget involved. Re-derived rather than observed, so it can sit below
     * the figure a child actually receives (see the spawn-path divergences).
     */
    legacyChildCeilingMb: number;
  };
}

export function toDaemonStatusMemoryLimits(
  budget: DaemonMemoryBudget | undefined,
  childHeap?: ChildHeapPolicySnapshot,
  journalGrowth?: DaemonStatusMemoryLimits['journalGrowth'],
): DaemonStatusMemoryLimits | null {
  if (!budget) return null;
  return {
    enforced: false,
    journalGrowth: journalGrowth ?? null,
    childHeap: childHeap
      ? {
          mode: childHeap.mode,
          maxConcurrentChildren: childHeap.maxConcurrentChildren,
          perChildCeilingMb: childHeap.perChildCeilingMb,
          refusals: childHeap.refusals,
        }
      : null,
    configuredBudgetMb: budget.configuredBudgetMb,
    effectiveBudgetMb: budget.effectiveBudgetMb,
    budgetSource: budget.budgetSource,
    availableMemoryMb: budget.availableMemoryMb,
    availableMemorySource: budget.availableMemorySource,
    insufficientMemory: budget.insufficientMemory,
    modeled: {
      rootReserveMb: budget.rootReserveMb,
      childPoolMb: budget.childPoolMb,
      minChildHeapMb: MIN_CHILD_HEAP_MB,
      maxChildHeapMb: MAX_CHILD_HEAP_MB,
      legacyChildCeilingMb: budget.legacyChildCeilingMb,
    },
  };
}

interface DaemonStatusRuntime {
  loading?: boolean;
  error?: string;
  sessions: { active: number; admissionInFlight?: number };
  permissions: {
    pending: number;
    policy: string;
  };
  channel: { live: boolean };
  channelWorker: ChannelWorkerSnapshot;
  /**
   * Per-workspace channel workers on a multi-workspace daemon. Additive to
   * `channelWorker` (which stays as the primary workspace snapshot). Absent on
   * single-workspace daemons.
   */
  channelWorkers?: ChannelWorkerGroupSnapshot[];
  transport: {
    restSseActive: number;
    acp: {
      enabled: boolean;
      connections: number;
      connectionStreams: number;
      sessionStreams: number;
      sseStreams: number;
      wsStreams: number;
      pendingClientRequests: number;
      preAttach: {
        bufferedConnectionFrames: number;
        bufferedSessionFrames: number;
        pendingDeliveryFrames: number;
        usedFrames: number;
        usedBytes: number;
        highWaterFrames: number;
        highWaterBytes: number;
        guardFailures: number;
      };
    };
  };
  rateLimit: {
    enabled: boolean;
    rejectedSinceStart: Record<RateLimitTier, number>;
  };
  /**
   * Live counts against the resolved memory budget, and what a per-child share
   * would come to at each count. The shares are advisory: nothing applies
   * them, and the gap between the registered and live figures is the reason a
   * capacity policy has to key on live children rather than registrations.
   * Absent when no budget resolved.
   */
  memory?: DaemonStatusRuntimeMemory;
  perf?: DaemonPerfSnapshot;
  /**
   * Rolling per-interval activity series backing the Daemon Status charts
   * (requests, latency, tokens, memory over time). Optional/additive to v=1:
   * absent when the daemon predates it or the sampler has not sealed a bucket
   * yet. Ordered oldest→newest.
   */
  metrics?: { series: DaemonMetricsBucket[] };
  activity: {
    activePrompts: number;
    pendingPrompts: number;
    queuedPrompts: number;
    lastActivityAt: string | null;
    idleSinceMs: number | null;
  };
  process: NodeJS.MemoryUsage;
}

interface DaemonStatusRuntimeMemory {
  /**
   * Registration count: every non-removed workspace entry, including ones
   * mid-drain, mid-replacement, or blocked. Registration is not allocation, so
   * this can exceed the live child count and is unsafe to divide the pool by.
   */
  registeredWorkspaces: number;
  /**
   * Daemon-managed ACP children with a live (non-dying) channel, including
   * transitioning or blocked entries. Excludes a workspace whose kill has
   * started (dying channel) even if the child process has not exited yet.
   * Deliberately narrow — it also excludes channel workers, MCP descendants,
   * and spawn reservations that have not attached, so a later admission policy
   * cannot mistake it for a process-tree count. Such a policy will additionally
   * need an in-flight spawn count to admit without racing.
   */
  activeAcpChildren: number;
  /**
   * Which children the daemon's RSS sampling covers: every ACP child with a
   * live channel, i.e. the same set `activeAcpChildren` counts. Still not
   * process-tree observation — channel workers and the children's own MCP
   * descendants report nothing (see `children`).
   *
   * Sampling is gated on an active SSE/WS watcher; with no client observing,
   * `children.sampled` falls to 0 even though children are live. The drop is
   * not instant: after the last watcher detaches, each reading persists until
   * it ages out of the staleness window (~30s).
   */
  childRssCoverage: 'active_children';
  /**
   * Aggregate RSS across the children `childRssCoverage` names.
   *
   * Read it as a floor and an over-count at the same time. Over, because
   * summing per-process RSS double-counts pages the children share (the node
   * binary, libc). Under, because each child reports only its own process —
   * MCP servers it spawned are invisible here, and channel workers have no
   * reporting path at all. It is not "the daemon tree's memory".
   */
  children: {
    /**
     * Sum over children that produced a reading. When `sampled` is below the
     * sibling `activeAcpChildren`, this is a floor rather than a total.
     */
    rssBytes: number;
    /**
     * How many children contributed. The denominator is `activeAcpChildren`,
     * deliberately not repeated here. 0 with live children means nothing was
     * measured — either no watcher is gating the sampler open, or the daemon
     * was built without a workspace registry to enumerate.
     */
    sampled: number;
    /**
     * Age of the oldest reading in the sum, so a caller can tell how far apart
     * its parts were taken. `null` when nothing was sampled — and also when
     * every contributor predates the field, so `null` never means "fresh".
     */
    oldestReadingAgeMs: number | null;
    /**
     * Lifetime V8 old-generation high-water marks across the sampled children,
     * as a **maximum, not a sum**. A heap ceiling applies per child, and the
     * peaks were reached at different times, so a total answers no question
     * anybody has; each field is an independent maximum, not a portrait of
     * one child. A per-child ceiling is judged against each axis on its own.
     *
     * `null` — never a zeroed object — when no sampled child reported. The
     * gating on `childRssCoverage` makes this the common case rather than an
     * edge one: with no SSE/WS watcher attached the daemon takes no sample at
     * all while children keep running. Publishing zeros there would assert
     * that no child needs any heap.
     *
     * Observational. Nothing here sizes a child or refuses a spawn; see
     * `limits.memory.enforced`, which stays `false`.
     */
    heap: {
      /** Committed high-water. Rises with the ceiling the child was given, so
       *  it bounds what the workload needs rather than stating it. */
      peakOldGenerationBytes: number;
      /** Retained-after-major-GC high-water, independent of the ceiling. The
       *  figure able to say a child cannot fit one. */
      peakLiveSetBytes: number;
      /** `total_heap_size` high-water. Includes the young generation. */
      peakTotalHeapBytes: number;
      majorGcCount: number;
      majorGcMs: number;
      /**
       * Union across the sampled children of heap spaces none of them could
       * classify. Non-empty means the byte figures are incomplete and must not
       * be read as a full measurement — a V8 taxonomy change is the way this
       * goes wrong, and it under-counts, making a child look like it fits.
       */
      unclassifiedSpaceNames: string[];
      /**
       * How many of `children.sampled` contributed a heap report. Below
       * `sampled` when some children predate the fields, so the maxima above
       * cover only part of the sampled set.
       */
      reported: number;
    } | null;
  };
  /**
   * Modeled per-child shares. Advisory; nothing applies them. Each is capped
   * at the legacy child ceiling, and floored at the minimum child heap only
   * when the ceiling allows — on a small host the ceiling sits below the
   * floor, so share x count can exceed the child pool. Read a share as
   * advisory, not a partition of the pool.
   */
  modeled: {
    /** `null` when no workspace is registered — there is no share to divide. */
    recommendedShareAtRegisteredMb: number | null;
    /** `null` when no ACP child is active — there is no share to divide. */
    recommendedShareAtActiveMb: number | null;
  };
  /**
   * The daemon root's own memory pressure. Reported in both modes; only
   * `observe` also raises a status issue from it. Covers the root process
   * alone: these figures are `process.memoryUsage()` of this process, so a
   * daemon whose children are the ones growing still reports `normal`.
   * Compare against `children.rssBytes` to see that gap.
   *
   * The computed shape is referenced rather than restated so the two cannot
   * drift: a field added or renamed in `daemon-memory-pressure.ts` would not
   * be caught by a hand copy, since spreading an object with an extra property
   * is not an excess-property error. `availableBytes` is the same figure as
   * `limits.memory.availableMemoryMb`, repeated here in bytes so the ratio can
   * be checked without cross-referencing.
   *
   * Nested here rather than at `runtime`, so it is absent whenever no budget
   * resolved — even though the heap half of the signal needs no budget. That
   * reaches direct-embed callers, and also the bootstrap `/daemon/status`
   * route — which omits `runtime.memory` wholesale even though the budget is
   * resolved before the bootstrap app exists, so `limits.memory` is populated
   * there while `pressure` is not. That window is not only startup: a daemon
   * whose runtime fails to start keeps serving the bootstrap app for its
   * lifetime, which is exactly when the reading would explain the most. Do
   * not write a client against "budget resolved implies pressure present".
   * Hoisting it out would restructure the block for a path that does not need
   * the reading.
   */
  pressure: DaemonMemoryPressure & { mode: 'off' | 'observe' };
}

export interface DaemonPipeStatsSnapshot {
  count: number;
  totalBytes: number;
  maxBytes: number;
}

export interface DaemonPerfSnapshot {
  eventLoop: {
    meanMs: number;
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  promptQueueWait: {
    count: number;
    meanMs: number;
    maxMs: number;
    lastMs: number | null;
  };
  pipe: {
    inbound: DaemonPipeStatsSnapshot;
    outbound: DaemonPipeStatsSnapshot;
  };
}

export interface DaemonStatusResponse {
  v: 1;
  detail: DaemonStatusDetail;
  generatedAt: string;
  status: DaemonStatusLevel;
  issues: DaemonStatusIssue[];
  daemon: StatusRecord & {
    pid: number;
    uptimeMs: number;
    mode: ServeOptions['mode'];
    workspaceCwd: string;
    runId?: string;
    logMode?: DaemonLogMode;
    logHealth?: DaemonLogHealth;
    logIssues?: readonly DaemonLogIssue[];
    logDroppedRecords?: number;
    logDroppedBytes?: number;
  };
  security: DaemonStatusSecurity;
  limits: DaemonStatusLimits;
  workspaces?: Array<{
    id: string;
    cwd: string;
    displayName?: string;
    primary: boolean;
    trusted: boolean;
  }>;
  capabilities: {
    protocolVersions: ServeProtocolVersions;
    features: string[];
  };
  runtime: DaemonStatusRuntime;
  full?: FullDaemonStatus;
}

class SectionTimeoutError extends Error {
  constructor(
    readonly section: string,
    readonly timeoutMs: number,
  ) {
    super(`${section} status timed out after ${timeoutMs}ms`);
    this.name = 'SectionTimeoutError';
  }
}

export function parseDaemonStatusDetail(
  raw: unknown,
): ParseDaemonStatusDetailResult {
  if (raw === undefined) return { ok: true, detail: 'summary' };
  if (raw === 'summary' || raw === 'full') {
    return { ok: true, detail: raw };
  }
  return { ok: false };
}

export async function buildDaemonStatusResponse(
  detail: DaemonStatusDetail,
  input: BuildDaemonStatusOptions,
): Promise<DaemonStatusResponse> {
  const daemonLogStatus = input.daemonLog?.getStatus();
  const bridgeSnapshot = input.bridge.getDaemonStatusSnapshot();
  const lastActivity = input.bridge.lastActivityAt ?? null;
  const workspaceRuntimes = input.workspaceRegistry?.list();
  const aggregateRuntimes =
    input.workspaceRegistry?.listAll?.() ?? workspaceRuntimes;
  const workspaceSnapshots: WorkspaceBridgeStatusSnapshot[] =
    aggregateRuntimes?.map((runtime) => ({
      workspaceCwd: runtime.workspaceCwd,
      internal: isInternalWorkspaceRuntime(runtime),
      snapshot:
        runtime.bridge === input.bridge
          ? bridgeSnapshot
          : runtime.bridge.getDaemonStatusSnapshot(),
      lastActivity:
        runtime.bridge === input.bridge
          ? lastActivity
          : (runtime.bridge.lastActivityAt ?? null),
    })) ?? [
      {
        workspaceCwd: input.boundWorkspace,
        snapshot: bridgeSnapshot,
        lastActivity,
      },
    ];
  const aggregatedSessionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.sessionCount,
    0,
  );
  const aggregatedPendingPermissionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.pendingPermissionCount,
    0,
  );
  const aggregatedChannelLive = workspaceSnapshots.some(
    (item) => item.snapshot.channelLive,
  );
  const memoryBudget = input.opts.daemonMemoryBudget;
  let runtimeMemory: DaemonStatusRuntimeMemory | undefined;
  if (memoryBudget) {
    // Count managed runtimes whose channel is live (non-dying), not what is
    // merely active-state. `list()` (active-state only) drops workspaces
    // mid-replacement or blocked, which would under-report children in exactly
    // the window an admission policy must not treat as free capacity.
    // `listManaged()` is the managed set; `listEntries()` is the registration
    // count. A workspace whose kill has started but whose child has not exited
    // is excluded (dying channel); registered-but-dormant workspaces have no
    // live child, so the registered count remains unsafe to divide by.
    const managedRuntimes = input.workspaceRegistry?.listManaged();
    const activeAcpChildCount = managedRuntimes
      ? managedRuntimes.filter((runtime) => runtime.bridge.isChannelLive())
          .length
      : workspaceSnapshots.filter((item) => item.snapshot.channelLive).length;
    const registeredWorkspaceCount = input.workspaceRegistry
      ? (
          input.workspaceRegistry.listAllEntries?.() ??
          input.workspaceRegistry.listEntries()
        ).length
      : workspaceSnapshots.length;
    // Summed in the SAME synchronous pass that produced `activeAcpChildCount`
    // above, over the same array. Keep it that way: an `await` slipped between
    // them would not break `sampled <= activeAcpChildren` — a child that dies
    // drops out of the sum, and one that starts has no cached reading yet — it
    // would instead make the two figures describe different instants, so the
    // gap between them would quietly absorb children that came or went while
    // the response was being built. That gap is the entire reason `sampled` is
    // reported, and no assertion would catch it going wrong.
    let childRssBytesTotal = 0;
    let childRssSampled = 0;
    let oldestChildReadingAgeMs: number | null = null;
    // Maxima, not running totals — see the `heap` field docs. `heapReported`
    // is tracked separately from `childRssSampled` because a sampled child
    // that predates the fields contributes rss but no heap.
    let heapReported = 0;
    let peakOldGenerationBytes = 0;
    let peakLiveSetBytes = 0;
    let peakTotalHeapBytes = 0;
    let heapMajorGcCount = 0;
    let heapMajorGcMs = 0;
    const heapUnclassified = new Set<string>();
    for (const runtime of managedRuntimes ?? []) {
      // Gate on the same predicate `activeAcpChildCount` used, rather than
      // trusting `getChildResourceSnapshot` to return nothing for a dead
      // channel. It does today, but that is another package's internal, and
      // leaning on it would make `sampled <= activeAcpChildren` — the one
      // thing this block promises — hold by coincidence instead of by
      // construction.
      if (!runtime.bridge.isChannelLive()) continue;
      const snapshot = runtime.bridge.getChildResourceSnapshot?.();
      if (!snapshot) continue;
      childRssBytesTotal += snapshot.rssBytes;
      childRssSampled += 1;
      // Absent on bridges predating the field; such a child still counts
      // toward the sum, it just cannot say how old its reading is.
      if (snapshot.ageMs !== undefined) {
        oldestChildReadingAgeMs = Math.max(
          oldestChildReadingAgeMs ?? 0,
          snapshot.ageMs,
        );
      }
      // Absent on a child spawned without the daemon marker or predating the
      // fields. Skipped rather than counted as zero, so `reported` stays an
      // honest denominator for the maxima.
      const heap = snapshot.heap;
      if (!heap) continue;
      heapReported += 1;
      peakOldGenerationBytes = Math.max(
        peakOldGenerationBytes,
        heap.peakOldGenerationBytes,
      );
      peakLiveSetBytes = Math.max(peakLiveSetBytes, heap.peakLiveSetBytes);
      peakTotalHeapBytes = Math.max(
        peakTotalHeapBytes,
        heap.peakTotalHeapBytes,
      );
      heapMajorGcCount = Math.max(heapMajorGcCount, heap.majorGcCount);
      heapMajorGcMs = Math.max(heapMajorGcMs, heap.majorGcMs);
      // Union, not max: one child seeing an unknown space is enough to make
      // the aggregate incomplete, and naming which space is the whole point.
      for (const name of heap.unclassifiedSpaceNames) {
        heapUnclassified.add(name);
      }
    }
    const pressureMode = input.opts.memoryPressureMode ?? 'observe';
    // One reading for the two figures of a single ratio. Reading twice would
    // divide an rss and a heapUsed sampled at different instants.
    //
    // Deliberately not shared with `runtime.process` further down: a
    // `detail=full` request awaits the workspace sections between here and
    // there, so reusing this snapshot would silently change which instant that
    // pre-existing field reports. A second syscall is cheaper than a semantics
    // change to a field this PR is not about.
    const pressureMemory = process.memoryUsage();
    runtimeMemory = {
      registeredWorkspaces: registeredWorkspaceCount,
      activeAcpChildren: activeAcpChildCount,
      childRssCoverage: 'active_children',
      children: {
        rssBytes: childRssBytesTotal,
        sampled: childRssSampled,
        oldestReadingAgeMs: oldestChildReadingAgeMs,
        // `null` on zero reporters, so an unmeasured daemon never publishes a
        // zeroed object that reads as "no child needs any heap".
        heap:
          heapReported > 0
            ? {
                peakOldGenerationBytes,
                peakLiveSetBytes,
                peakTotalHeapBytes,
                majorGcCount: heapMajorGcCount,
                majorGcMs: heapMajorGcMs,
                unclassifiedSpaceNames: [...heapUnclassified],
                reported: heapReported,
              }
            : null,
      },
      modeled: {
        recommendedShareAtRegisteredMb:
          registeredWorkspaceCount > 0
            ? recommendedChildShareMb(memoryBudget, registeredWorkspaceCount)
            : null,
        recommendedShareAtActiveMb:
          activeAcpChildCount > 0
            ? recommendedChildShareMb(memoryBudget, activeAcpChildCount)
            : null,
      },
      pressure: {
        ...computeDaemonMemoryPressure({
          rssBytes: pressureMemory.rss,
          heapUsedBytes: pressureMemory.heapUsed,
          // `availableMemoryMb`, not `effectiveBudgetMb`: pressure asks how
          // close this process is to being killed, and what kills it is the
          // cgroup limit or host memory. An operator's budget is a policy
          // number — exceeding it is not fatal, so classifying against it
          // would report `critical` for a daemon in no danger.
          // Note the unit change: the budget carries megabytes.
          availableBytes: memoryBudget.availableMemoryMb * 1024 * 1024,
        }),
        // After the spread, so the flag stays authoritative if the computed
        // shape ever grows a field of this name.
        mode: pressureMode,
      },
    };
  }
  const aggregatedLastActivity = workspaceSnapshots.reduce<number | null>(
    (latest, item) =>
      item.lastActivity !== null &&
      (latest === null || item.lastActivity > latest)
        ? item.lastActivity
        : latest,
    null,
  );
  const acpSnapshot = input.acpHandle?.registry.getSnapshot();
  // Aggregate across all mounts (primary + trusted secondaries) so the transport
  // summary matches the metrics sampler; the connection cap below stays
  // primary-scoped because it is the uniform per-mount cap.
  const acpAggregate = input.acpHandle?.getSnapshot();
  const rateLimitHits = input.rateLimiter?.getHitCounts() ?? zeroRateHits();
  let pendingPrompts = 0;
  let derivedQueuedPrompts = 0;
  const derivedQueuedPromptsByWorkspace: number[] = [];
  for (const [index, { snapshot }] of workspaceSnapshots.entries()) {
    let derivedQueuedPromptsForWorkspace = 0;
    for (const session of snapshot.sessions) {
      pendingPrompts += session.pendingPromptCount;
      const sessionQueuedPrompts = Math.max(
        0,
        session.pendingPromptCount - (session.hasActivePrompt ? 1 : 0),
      );
      derivedQueuedPrompts += sessionQueuedPrompts;
      derivedQueuedPromptsForWorkspace += sessionQueuedPrompts;
    }
    derivedQueuedPromptsByWorkspace[index] = derivedQueuedPromptsForWorkspace;
  }
  const queuedPrompts =
    aggregateRuntimes?.reduce(
      (sum, runtime, index) =>
        sum +
        (runtime.bridge.pendingPromptTotal ??
          derivedQueuedPromptsByWorkspace[index] ??
          0),
      0,
    ) ??
    input.bridge.pendingPromptTotal ??
    derivedQueuedPrompts;
  const channelWorker = input.getChannelWorkerSnapshot?.() ?? {
    enabled: false,
    state: 'disabled',
    channels: [],
  };
  // Per-workspace worker list is multi-workspace only; single-workspace status
  // keeps the byte-identical `channelWorker` shape.
  const channelWorkers =
    (workspaceRuntimes?.length ?? 1) > 1
      ? input.getChannelWorkerSnapshots?.()
      : undefined;
  const totalAdmissionSnapshot = input.getTotalSessionAdmissionSnapshot?.();
  const issues: DaemonStatusIssue[] = [];
  let full: FullDaemonStatus | undefined;

  pushRuntimeIssues(
    issues,
    acpSnapshot,
    acpAggregate,
    rateLimitHits,
    input,
    channelWorker,
    channelWorkers,
    totalAdmissionSnapshot,
    workspaceSnapshots,
  );
  // Only `observe` turns the level into an issue. `off` still reported the
  // figures above; what it withholds is the effect on `rollupStatus`, which
  // any one issue flips from `ok` to `warning`. The thresholds are inherited
  // from an interactive-CLI monitor and are not yet calibrated for a
  // long-running daemon, so a deployment that alerts on the top-level status
  // needs a way to take the reading without the verdict.
  if (
    runtimeMemory &&
    runtimeMemory.pressure.mode === 'observe' &&
    runtimeMemory.pressure.level !== 'normal'
  ) {
    const { level, ratio, source } = runtimeMemory.pressure;
    issues.push({
      code: 'daemon_memory_pressure',
      // `warning` at every level, including `critical`. An `error` severity
      // makes `rollupStatus` return `error` for the whole daemon, which is a
      // strong claim to stake on thresholds borrowed from an interactive-CLI
      // monitor and not yet calibrated here. The level itself is reported in
      // `runtime.memory.pressure`, so nothing is lost by keeping the rollup
      // at `warning` until the numbers have been checked against real
      // deployments — which is what this phase is for.
      severity: 'warning',
      // Name the denominator, not the numerator: "% of the rss limit" would
      // call the measured value a limit. `section` is omitted because every
      // other use of it names a workspace status section, and this is a
      // daemon-level concern — the same reason `daemon_log_degraded` omits it.
      // One decimal, not zero: at 0 decimals a ratio of 0.795 rounds to "80%"
      // while `level` still reads `hard`, and 80% is critical's documented
      // threshold. An oncall engineer comparing the two sees a contradiction
      // in the one feature whose whole purpose is trustworthy triage.
      message:
        `Daemon memory pressure is ${level} at ` +
        `${(ratio * 100).toFixed(1)}% of ` +
        `${source === 'heap' ? 'the V8 heap limit' : 'available memory'}.`,
    });
  }
  if (daemonLogStatus?.health === 'degraded') {
    issues.push({
      code: 'daemon_log_degraded',
      severity: 'warning',
      message:
        'Daemon file logging is degraded; inspect full status for details.',
    });
  }

  if (detail === 'full') {
    full = await buildFullStatus(
      input,
      acpAggregate,
      workspaceSnapshots
        .filter((item) => item.internal !== true)
        .flatMap((item) => item.snapshot.sessions),
    );
    pushFullIssues(issues, full);
  }

  return {
    v: 1,
    detail,
    generatedAt: new Date().toISOString(),
    status: rollupStatus(issues),
    issues,
    daemon: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      mode: input.opts.mode,
      workspaceCwd: input.boundWorkspace,
      ...(input.startup ? { startup: cloneStartup(input.startup) } : {}),
      ...(input.qwenCodeVersion
        ? { qwenCodeVersion: input.qwenCodeVersion }
        : {}),
      ...(input.daemonLog?.getDaemonId()
        ? { daemonId: input.daemonLog.getDaemonId() }
        : {}),
      ...(daemonLogStatus
        ? {
            runId: daemonLogStatus.runId,
            logMode: daemonLogStatus.mode,
            logHealth: daemonLogStatus.health,
          }
        : {}),
      ...(detail === 'full' && input.daemonLog?.getLogPath()
        ? { logPath: input.daemonLog.getLogPath() }
        : {}),
      ...(detail === 'full' && daemonLogStatus
        ? {
            logIssues: daemonLogStatus.issues,
            logDroppedRecords: daemonLogStatus.droppedRecords,
            logDroppedBytes: daemonLogStatus.droppedBytes,
          }
        : {}),
    },
    security: {
      tokenConfigured: Boolean(input.opts.token),
      requireAuth: input.opts.requireAuth === true,
      loopbackBind: isLoopbackBind(input.opts.hostname),
      allowOriginConfigured:
        input.opts.allowOrigins !== undefined &&
        input.opts.allowOrigins.length > 0,
      allowOriginMode: allowOriginMode(input.opts.allowOrigins),
      sessionShellCommandEnabled: input.sessionShellCommandEnabled,
    },
    limits: {
      maxSessions: bridgeSnapshot.limits.maxSessions,
      maxTotalSessions: positiveFiniteOrNull(input.opts.maxTotalSessions),
      maxPendingPromptsPerSession:
        bridgeSnapshot.limits.maxPendingPromptsPerSession,
      listenerMaxConnections: listenerMaxConnections(input.opts.maxConnections),
      eventRingSize: bridgeSnapshot.limits.eventRingSize,
      compactedReplayMaxBytes: bridgeSnapshot.limits.compactedReplayMaxBytes,
      maxJournalEvents: bridgeSnapshot.limits.maxJournalEvents,
      maxJournalBytes: bridgeSnapshot.limits.maxJournalBytes,
      promptDeadlineMs: positiveFiniteOrNull(input.opts.promptDeadlineMs),
      writerIdleTimeoutMs: positiveFiniteOrNull(input.opts.writerIdleTimeoutMs),
      channelIdleTimeoutMs: bridgeSnapshot.limits.channelIdleTimeoutMs,
      sessionIdleTimeoutMs: bridgeSnapshot.limits.sessionIdleTimeoutMs,
      sessionPromptSettledCloseGraceMs:
        bridgeSnapshot.limits.sessionPromptSettledCloseGraceMs,
      acpConnectionCap: acpSnapshot?.connectionCap ?? null,
      acpPreAttachMaxFramesPerStream:
        acpSnapshot !== undefined ? ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM : null,
      acpPreAttachMaxFramesPerConnection:
        acpSnapshot !== undefined
          ? ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION
          : null,
      acpPreAttachMaxFramesGlobal:
        acpSnapshot !== undefined ? ACP_PRE_ATTACH_MAX_FRAMES_GLOBAL : null,
      acpPreAttachMaxPayloadBytesPerConnection:
        acpSnapshot !== undefined
          ? ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION
          : null,
      acpPreAttachMaxPayloadBytesGlobal:
        acpSnapshot !== undefined
          ? ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_GLOBAL
          : null,
      memory: toDaemonStatusMemoryLimits(
        memoryBudget,
        input.getChildHeapPolicySnapshot?.(),
        bridgeSnapshot.limits.journalGrowth
          ? {
              ...bridgeSnapshot.limits.journalGrowth,
              baselineMaxEvents: bridgeSnapshot.limits.maxJournalEvents,
              baselineMaxBytes: bridgeSnapshot.limits.maxJournalBytes,
            }
          : null,
      ),
    },
    ...(workspaceRuntimes && workspaceRuntimes.length > 1
      ? {
          workspaces: workspaceRuntimes.map((runtime) => ({
            id: runtime.workspaceId,
            cwd: runtime.workspaceCwd,
            ...(runtime.displayName !== undefined
              ? { displayName: runtime.displayName }
              : {}),
            primary: runtime.primary,
            trusted: runtime.trusted,
          })),
        }
      : {}),
    capabilities: {
      protocolVersions: input.protocolVersions,
      features: [...input.features],
    },
    runtime: {
      sessions: {
        active: aggregatedSessionCount,
        ...(totalAdmissionSnapshot
          ? { admissionInFlight: totalAdmissionSnapshot.inFlight }
          : {}),
      },
      permissions: {
        pending: aggregatedPendingPermissionCount,
        policy: bridgeSnapshot.permissionPolicy,
      },
      channel: { live: aggregatedChannelLive },
      channelWorker,
      ...(channelWorkers && channelWorkers.length > 0
        ? { channelWorkers }
        : {}),
      transport: {
        restSseActive: input.getRestSseActive(),
        acp: {
          enabled: acpSnapshot !== undefined,
          connections: acpAggregate?.connectionCount ?? 0,
          connectionStreams: acpAggregate?.connectionStreams ?? 0,
          sessionStreams: acpAggregate?.sessionStreams ?? 0,
          sseStreams: acpAggregate?.sseStreams ?? 0,
          wsStreams: acpAggregate?.wsStreams ?? 0,
          pendingClientRequests: acpAggregate?.pendingClientRequests ?? 0,
          preAttach: {
            bufferedConnectionFrames:
              acpAggregate?.bufferedConnectionFrames ?? 0,
            bufferedSessionFrames: acpAggregate?.bufferedSessionFrames ?? 0,
            pendingDeliveryFrames: acpAggregate?.pendingDeliveryFrames ?? 0,
            usedFrames: acpAggregate?.preAttach.usedFrames ?? 0,
            usedBytes: acpAggregate?.preAttach.usedBytes ?? 0,
            highWaterFrames: acpAggregate?.preAttach.highWaterFrames ?? 0,
            highWaterBytes: acpAggregate?.preAttach.highWaterBytes ?? 0,
            guardFailures: acpAggregate?.preAttach.guardFailures ?? 0,
          },
        },
      },
      rateLimit: {
        enabled: input.opts.rateLimit === true,
        rejectedSinceStart: rateLimitHits,
      },
      ...(input.getPerfSnapshot ? { perf: input.getPerfSnapshot() } : {}),
      ...(input.getMetricsSeries
        ? { metrics: { series: input.getMetricsSeries() } }
        : {}),
      activity: {
        activePrompts:
          aggregateRuntimes?.reduce(
            (sum, runtime) => sum + (runtime.bridge.activePromptCount ?? 0),
            0,
          ) ??
          input.bridge.activePromptCount ??
          0,
        pendingPrompts,
        queuedPrompts,
        lastActivityAt:
          aggregatedLastActivity !== null
            ? new Date(aggregatedLastActivity).toISOString()
            : null,
        idleSinceMs:
          aggregatedLastActivity !== null
            ? Date.now() - aggregatedLastActivity
            : null,
      },
      ...(runtimeMemory ? { memory: runtimeMemory } : {}),
      process: process.memoryUsage(),
    },
    ...(full ? { full } : {}),
  };
}

function cloneStartup(startup: DaemonStartupSnapshot): DaemonStartupSnapshot {
  return {
    processStartedAt: startup.processStartedAt,
    ...(startup.listenerReadyAt
      ? { listenerReadyAt: startup.listenerReadyAt }
      : {}),
    ...(startup.processToListenMs !== undefined
      ? { processToListenMs: startup.processToListenMs }
      : {}),
    ...(startup.runQwenServeToListenMs !== undefined
      ? { runQwenServeToListenMs: startup.runQwenServeToListenMs }
      : {}),
    preheat: {
      status: startup.preheat.status,
      ...(startup.preheat.durationMs !== undefined
        ? { durationMs: startup.preheat.durationMs }
        : {}),
      ...(startup.preheat.error ? { error: startup.preheat.error } : {}),
    },
  };
}

async function buildFullStatus(
  input: BuildDaemonStatusOptions,
  acpSnapshot: AcpHttpSnapshot | undefined,
  sessions: BridgeDaemonStatusSnapshot['sessions'],
): Promise<FullDaemonStatus> {
  const ctx: WorkspaceRequestContext = {
    route: 'GET /daemon/status',
    workspaceCwd: input.boundWorkspace,
  };
  const [mcp, skills, tools, providers, env, preflight, hooks, extensions] =
    await Promise.all([
      collectSection('workspace.mcp', () =>
        input.workspace.getWorkspaceMcpStatus(ctx),
      ),
      collectSection('workspace.skills', () =>
        input.workspace.getWorkspaceSkillsStatus(ctx),
      ),
      collectSection('workspace.tools', () =>
        input.bridge.getWorkspaceToolsStatus(),
      ),
      collectSection('workspace.providers', () =>
        input.workspace.getWorkspaceProvidersStatus(ctx),
      ),
      collectSection('workspace.env', () =>
        input.workspace.getWorkspaceEnvStatus(ctx),
      ),
      collectSection('workspace.preflight', () =>
        input.workspace.getWorkspacePreflightStatus(ctx),
      ),
      collectSection('workspace.hooks', () =>
        input.workspace.getWorkspaceHooksStatus(ctx),
      ),
      collectSection('workspace.extensions', () =>
        input.workspace.getWorkspaceExtensionsStatus(ctx),
      ),
    ]);

  return {
    sessions,
    acpMounts: acpSnapshot?.mounts ?? [],
    acpConnections: acpSnapshot?.connections ?? [],
    workspace: {
      mcp,
      skills,
      tools,
      providers,
      env,
      preflight,
      hooks,
      extensions,
    },
    auth: {
      supportedDeviceFlowProviders: [...input.supportedDeviceFlowProviders],
      pendingDeviceFlowCount: input.deviceFlowRegistry.listPending().length,
    },
  };
}

async function collectSection<T>(
  name: string,
  read: () => Promise<T>,
): Promise<DaemonStatusSection<T>> {
  const startMs = Date.now();
  try {
    const data = await withTimeout(read(), name, SECTION_TIMEOUT_MS);
    return {
      status: inferSectionStatus(data),
      durationMs: Date.now() - startMs,
      summary: summarizeStatusData(data),
      data,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      durationMs: Date.now() - startMs,
      error: {
        kind: err instanceof SectionTimeoutError ? 'timeout' : 'error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  section: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SectionTimeoutError(section, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pushRuntimeIssues(
  issues: DaemonStatusIssue[],
  acpSnapshot: ReturnType<AcpHttpHandle['registry']['getSnapshot']> | undefined,
  acpAggregate: AcpHttpSnapshot | undefined,
  rateLimitHits: Record<RateLimitTier, number>,
  input: BuildDaemonStatusOptions,
  channelWorker: ChannelWorkerSnapshot,
  channelWorkers: readonly ChannelWorkerGroupSnapshot[] | undefined,
  totalAdmissionSnapshot: TotalSessionAdmissionSnapshot | undefined,
  workspaceSnapshots: readonly WorkspaceBridgeStatusSnapshot[],
): void {
  for (const { workspaceCwd, internal, snapshot } of workspaceSnapshots) {
    if (
      snapshot.limits.maxSessions !== null &&
      snapshot.limits.maxSessions > 0 &&
      snapshot.sessionCount / snapshot.limits.maxSessions >=
        CAPACITY_WARNING_RATIO
    ) {
      issues.push({
        code: 'session_capacity_high',
        severity: 'warning',
        message:
          workspaceSnapshots.length > 1
            ? internal
              ? `An internal runtime's active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.`
              : `Workspace ${workspaceCwd} active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.`
            : `Active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.`,
      });
    }
  }

  const maxTotalSessions = positiveFiniteOrNull(input.opts.maxTotalSessions);
  if (maxTotalSessions !== null) {
    const fallbackLiveCount = workspaceSnapshots.reduce(
      (sum, item) => sum + item.snapshot.sessionCount,
      0,
    );
    const totalActive =
      (totalAdmissionSnapshot?.liveCount ?? fallbackLiveCount) +
      (totalAdmissionSnapshot?.inFlight ?? 0);
    if (totalActive / maxTotalSessions >= CAPACITY_WARNING_RATIO) {
      issues.push({
        code: 'total_session_capacity_high',
        severity: 'warning',
        message: `Total active and in-flight sessions are at ${totalActive}/${maxTotalSessions}.`,
      });
    }
  }

  if (
    acpSnapshot !== undefined &&
    acpSnapshot.connectionCap !== null &&
    acpSnapshot.connectionCap > 0
  ) {
    // Per-mount cap is uniform (opts.maxConnections); warn on the busiest mount
    // so a saturated secondary workspace is visible, not just the primary's.
    const cap = acpSnapshot.connectionCap;
    const busiest = (acpAggregate?.mounts ?? []).reduce(
      (max, m) => Math.max(max, m.connectionCount),
      acpSnapshot.connectionCount,
    );
    if (busiest / cap >= CAPACITY_WARNING_RATIO) {
      issues.push({
        code: 'connection_capacity_high',
        severity: 'warning',
        message: `ACP connections are at ${busiest}/${cap} on the busiest workspace mount.`,
      });
    }
  }

  const pendingPermissionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.pendingPermissionCount,
    0,
  );
  if (pendingPermissionCount > 0) {
    issues.push({
      code: 'pending_permissions',
      severity: 'warning',
      message: `${pendingPermissionCount} permission request(s) are pending.`,
    });
  }

  const downWorkspaces = workspaceSnapshots.filter(
    (item) => item.snapshot.sessionCount > 0 && !item.snapshot.channelLive,
  );
  if (downWorkspaces.length > 0) {
    issues.push({
      code: 'acp_channel_down',
      severity: 'error',
      message:
        downWorkspaces.length === 1
          ? downWorkspaces[0]!.internal
            ? 'Active sessions exist but the ACP channel is not live for an internal runtime.'
            : `Active sessions exist but the ACP channel is not live for ${downWorkspaces[0]!.workspaceCwd}.`
          : `Active sessions exist but the ACP channel is not live for ${downWorkspaces.length} workspace(s).`,
    });
  }

  if (input.opts.rateLimit === true && sumRateHits(rateLimitHits) > 0) {
    issues.push({
      code: 'rate_limit_hits',
      severity: 'warning',
      message: `${sumRateHits(rateLimitHits)} request(s) have been rejected by rate limiting since start.`,
    });
  }

  const groupedWorkers =
    channelWorkers && channelWorkers.length > 0 ? channelWorkers : undefined;
  const workers = groupedWorkers ?? [channelWorker];
  for (const worker of workers) {
    pushChannelWorkerIssues(issues, worker, groupedWorkers !== undefined);
  }
}

function pushChannelWorkerIssues(
  issues: DaemonStatusIssue[],
  channelWorker: ChannelWorkerSnapshot | ChannelWorkerGroupSnapshot,
  grouped: boolean,
): void {
  const workspace =
    'workspaceCwd' in channelWorker
      ? ` for workspace ${channelWorker.workspaceCwd}`
      : '';
  const section = grouped ? 'runtime.channelWorkers' : 'runtime.channelWorker';

  if (
    channelWorker.enabled &&
    (channelWorker.state === 'exited' || channelWorker.state === 'failed')
  ) {
    const detailParts = [
      channelWorker.pid !== undefined ? `pid=${channelWorker.pid}` : undefined,
      channelWorker.exitCode !== undefined
        ? `code=${channelWorker.exitCode ?? 'null'}`
        : undefined,
      channelWorker.signal ? `signal=${channelWorker.signal}` : undefined,
      channelWorker.restartCount !== undefined
        ? `restarts=${channelWorker.restartCount}`
        : undefined,
      channelWorker.lastExitAt
        ? `lastExitAt=${channelWorker.lastExitAt}`
        : undefined,
      channelWorker.lastRestartAt
        ? `lastRestartAt=${channelWorker.lastRestartAt}`
        : undefined,
      channelWorker.nextRestartAt
        ? `nextRestartAt=${channelWorker.nextRestartAt}`
        : undefined,
      channelWorker.lastHeartbeatAt
        ? `lastHeartbeatAt=${channelWorker.lastHeartbeatAt}`
        : undefined,
      channelWorker.staleHeartbeatAt
        ? `staleHeartbeatAt=${channelWorker.staleHeartbeatAt}`
        : undefined,
    ].filter(Boolean);
    const details =
      detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';
    const error = channelWorker.error ? `: ${channelWorker.error}` : '';
    const isPermanentFailure =
      channelWorker.state === 'failed' && !channelWorker.nextRestartAt;
    issues.push({
      code: 'channel_worker_exited',
      severity: isPermanentFailure ? 'error' : 'warning',
      message: `Channel worker${workspace} is ${channelWorker.state}${details}${error}.`,
      section,
    });
  }

  if (
    channelWorker.enabled &&
    channelWorker.state === 'running' &&
    channelWorker.requestedChannels !== undefined
  ) {
    const connected = new Set(channelWorker.channels);
    const failed = channelWorker.requestedChannels.filter(
      (channel) => !connected.has(channel),
    );
    if (failed.length > 0) {
      issues.push({
        code: 'channel_worker_partial_connect',
        severity: 'warning',
        message:
          `Channel worker${workspace} connected ${channelWorker.channels.length}/${channelWorker.requestedChannels.length} channel(s). ` +
          `Failed: ${failed.join(', ')}.`,
        section,
      });
    }
  }
}

function pushFullIssues(
  issues: DaemonStatusIssue[],
  full: FullDaemonStatus,
): void {
  for (const [name, section] of Object.entries(full.workspace)) {
    if (section.status === 'unavailable') {
      issues.push({
        code: 'workspace_status_unavailable',
        severity: 'warning',
        section: name,
        message: `${name} status is unavailable.`,
      });
    }
  }

  const preflight = full.workspace['preflight'];
  if (preflight && sectionHasStatus(preflight, 'error')) {
    issues.push({
      code: 'preflight_error',
      severity: 'error',
      section: 'preflight',
      message: 'Workspace preflight reports an error.',
    });
  }

  const mcp = full.workspace['mcp'];
  const mcpBudget = mcp ? inspectMcpBudget(mcp) : undefined;
  if (mcpBudget === 'exhausted') {
    issues.push({
      code: 'mcp_budget_exhausted',
      severity: 'error',
      section: 'mcp',
      message: 'MCP client budget is exhausted.',
    });
  } else if (mcpBudget === 'warning') {
    issues.push({
      code: 'mcp_budget_warning',
      severity: 'warning',
      section: 'mcp',
      message: 'MCP client budget is near capacity.',
    });
  }
}

function inferSectionStatus(data: unknown): DaemonStatusLevel {
  const statuses = collectStatuses(data);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function summarizeStatusData(data: unknown): SectionSummary {
  const summary: SectionSummary = {};
  if (!isRecord(data)) return summary;

  copyBoolean(data, summary, 'initialized');
  copyBoolean(data, summary, 'acpChannelLive');
  copyString(data, summary, 'discoveryState');
  copyString(data, summary, 'budgetMode');
  copyNumber(data, summary, 'clientCount');
  copyNumber(data, summary, 'clientBudget');

  for (const key of [
    'cells',
    'errors',
    'servers',
    'budgets',
    'skills',
    'tools',
    'providers',
    'hooks',
    'extensions',
  ]) {
    const value = data[key];
    if (Array.isArray(value)) {
      summary[`${key}Count`] = value.length;
    }
  }

  summarizeMcpServers(data, summary);

  return summary;
}

function summarizeMcpServers(
  data: StatusRecord,
  summary: SectionSummary,
): void {
  const servers = data['servers'];
  if (!Array.isArray(servers)) return;
  let connected = 0;
  let errored = 0;
  let disabled = 0;
  for (const server of servers) {
    if (!isRecord(server)) continue;
    if (server['disabled'] === true) {
      disabled++;
    } else if (server['status'] === 'error') {
      errored++;
    } else if (server['mcpStatus'] === 'connected') {
      connected++;
    }
  }
  summary['serversConnected'] = connected;
  summary['serversErrored'] = errored;
  summary['serversDisabled'] = disabled;
}

function collectStatuses(data: unknown): string[] {
  const statuses: string[] = [];
  visitStatusContainers(data, (record) => {
    const status = record['status'];
    if (typeof status === 'string') statuses.push(status);
  });
  return statuses;
}

function sectionHasStatus(
  section: WorkspaceStatusSection,
  status: string,
): boolean {
  return collectStatuses(section.data).includes(status);
}

function inspectMcpBudget(
  section: WorkspaceStatusSection,
): 'warning' | 'exhausted' | undefined {
  const data = section.data;
  if (!isRecord(data)) return undefined;
  const budgetIssue = inspectBudgetContainers(data);
  if (budgetIssue) return budgetIssue;

  const clientCount = numberValue(data['clientCount']);
  const clientBudget = numberValue(data['clientBudget']);
  if (
    clientCount !== undefined &&
    clientBudget !== undefined &&
    clientBudget > 0
  ) {
    const ratio = clientCount / clientBudget;
    if (ratio >= 1) return 'exhausted';
    if (ratio >= 0.75) return 'warning';
  }
  return undefined;
}

function inspectBudgetContainers(
  data: unknown,
): 'warning' | 'exhausted' | undefined {
  let result: 'warning' | 'exhausted' | undefined;
  visitStatusContainers(data, (record) => {
    if (result === 'exhausted') return;
    const errorKind = record['errorKind'];
    const disabledReason = record['disabledReason'];
    const status = record['status'];
    const kind = record['kind'];
    const refusedCount = numberValue(record['refusedCount']);
    if (
      errorKind === 'budget_exhausted' ||
      disabledReason === 'budget' ||
      (kind === 'mcp_budget' && status === 'error') ||
      (refusedCount !== undefined && refusedCount > 0)
    ) {
      result = 'exhausted';
      return;
    }
    if (kind === 'mcp_budget' && status === 'warning') {
      result = 'warning';
    }
  });
  return result;
}

function visitStatusContainers(
  data: unknown,
  visit: (record: StatusRecord) => void,
): void {
  if (!isRecord(data)) return;
  visit(data);
  for (const key of [
    'cells',
    'errors',
    'servers',
    'budgets',
    'skills',
    'tools',
    'providers',
    'hooks',
    'extensions',
  ]) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) visitStatusContainers(item, visit);
  }
}

function rollupStatus(issues: readonly DaemonStatusIssue[]): DaemonStatusLevel {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.length > 0) return 'warning';
  return 'ok';
}

export function allowOriginMode(
  allowOrigins: readonly string[] | undefined,
): 'none' | 'specific' | 'any' {
  if (!allowOrigins || allowOrigins.length === 0) return 'none';
  return allowOrigins.includes('*') ? 'any' : 'specific';
}

export function listenerMaxConnections(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_LISTENER_MAX_CONNECTIONS;
  if (value === 0 || value === Infinity) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function positiveFiniteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function zeroRateHits(): Record<RateLimitTier, number> {
  return { prompt: 0, mutation: 0, read: 0 };
}

function sumRateHits(hits: Record<RateLimitTier, number>): number {
  return hits.prompt + hits.mutation + hits.read;
}

function isRecord(value: unknown): value is StatusRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function copyBoolean(
  from: StatusRecord,
  to: SectionSummary,
  key: string,
): void {
  const value = from[key];
  if (typeof value === 'boolean') to[key] = value;
}

function copyString(from: StatusRecord, to: SectionSummary, key: string): void {
  const value = from[key];
  if (typeof value === 'string') to[key] = value;
}

function copyNumber(from: StatusRecord, to: SectionSummary, key: string): void {
  const value = numberValue(from[key]);
  if (value !== undefined) to[key] = value;
}
