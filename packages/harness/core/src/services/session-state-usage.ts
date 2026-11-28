/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { recordScopedCredits } from '../usage/conversation-metering.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { sessionStatsService } from '../services/session-stats.js';
import { runLogger } from '../utils/runLogger.js';
import type {
  SessionStatePayload,
  SessionStateStore,
} from './session-state-store.js';

export const SESSION_USAGE_SEGMENT_KEY = 's0';

export interface SessionCreditsSnapshot {
  observed: boolean;
  /** Historical usage could not be restored; totals cover only new requests. */
  historyIncomplete?: true;
  totalCredits: number;
  byModel: Record<string, { credits: number }>;
}

export interface PersistedSessionCredits {
  total: number;
  byModel: Record<string, { credits: number }>;
}

export interface SessionUsageCounters {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface SessionUsageState {
  updatedAt: string;
  latest?: SessionUsageCounters;
  historyIncomplete?: true;
  /** Identifies the response whose private usage may anchor a resumed request. */
  latestRequestId?: string;
  total: SessionUsageCounters;
  credits?: PersistedSessionCredits;
}

interface SessionCreditsTrackerState {
  snapshot: SessionCreditsSnapshot;
  recordedRequestIds: Map<string, number>;
  /** 服务端完整计量字段，供 transcript 恢复消息级 usage。 */
  recordedRequestMetering: Map<string, MeteredRequestUsage>;
  /** 逻辑请求 ID → 最终落地的物理请求 ID（排队/重试会更换物理 ID）。 */
  meteringAliases: Map<string, string>;
}

interface BoundCreditsStore {
  store: SessionStateStore;
  sessionId: string;
}

const sessionCreditsById = new Map<string, SessionCreditsTrackerState>();
const boundCreditsStores = new Set<BoundCreditsStore>();
const activeCreditsRequestsBySession = new Map<string, Set<symbol>>();
const activeCreditsRequestWaiters = new Map<
  string,
  Set<(settled: boolean) => void>
>();
export const CREDITS_REQUEST_SETTLE_TIMEOUT_MS = 30_000;
/**
 * Interactive session swaps (rewind, `/resume`, history reloads) must not stall
 * the TUI while credits settle. The full budget above stays reserved for
 * process shutdown, where losing in-flight metering actually matters.
 */
export const INTERACTIVE_CREDITS_REQUEST_SETTLE_TIMEOUT_MS = 1_500;
export const INTERACTIVE_USAGE_REQUEST_SETTLE_TIMEOUT_MS =
  INTERACTIVE_CREDITS_REQUEST_SETTLE_TIMEOUT_MS;

export interface SessionCreditsDisposeOptions {
  /** Defaults to {@link CREDITS_REQUEST_SETTLE_TIMEOUT_MS}. */
  settleTimeoutMs?: number;
}

export type SessionCreditsPersistenceDisposer = (
  options?: SessionCreditsDisposeOptions,
) => Promise<void>;
export type SessionUsagePersistenceDisposer =
  SessionCreditsPersistenceDisposer;

function emptySessionCreditsSnapshot(): SessionCreditsSnapshot {
  return {
    observed: false,
    totalCredits: 0,
    byModel: {},
  };
}

function cloneSessionCreditsSnapshot(
  snapshot: SessionCreditsSnapshot,
): SessionCreditsSnapshot {
  return {
    observed: snapshot.observed,
    ...(snapshot.historyIncomplete ? { historyIncomplete: true } : {}),
    totalCredits: snapshot.totalCredits,
    byModel: Object.fromEntries(
      Object.entries(snapshot.byModel).map(([model, usage]) => [
        model,
        { credits: usage.credits },
      ]),
    ),
  };
}

function getOrCreateSessionCreditsState(
  sessionId: string,
): SessionCreditsTrackerState {
  let state = sessionCreditsById.get(sessionId);
  if (!state) {
    state = {
      snapshot: emptySessionCreditsSnapshot(),
      recordedRequestIds: new Map<string, number>(),
      recordedRequestMetering: new Map<string, MeteredRequestUsage>(),
      meteringAliases: new Map<string, string>(),
    };
    sessionCreditsById.set(sessionId, state);
  }
  return state;
}

export function getSessionCreditsSnapshot(
  sessionId: string,
): SessionCreditsSnapshot {
  const state = sessionCreditsById.get(sessionId);
  return state
    ? cloneSessionCreditsSnapshot(state.snapshot)
    : emptySessionCreditsSnapshot();
}

export function clearSessionCredits(sessionId: string): void {
  sessionCreditsById.delete(sessionId);
  sessionStatsService.setSessionCreditsSnapshot(
    sessionId,
    emptySessionCreditsSnapshot(),
  );
}

/** Authoritative charge for a request observed in this process; missing is unknown. */
export function getRequestCredits(
  sessionId: string,
  requestId: string,
): number | undefined {
  return sessionCreditsById.get(sessionId)?.recordedRequestIds.get(requestId);
}

function buildSessionCreditsSnapshot(
  persisted?: PersistedSessionCredits | null,
  historyIncomplete = false,
): SessionCreditsSnapshot {
  const snapshot: SessionCreditsSnapshot = persisted
    ? {
        observed: true,
        totalCredits: persisted.total,
        byModel: Object.fromEntries(
          Object.entries(persisted.byModel).map(([model, usage]) => [
            model,
            { credits: usage.credits },
          ]),
        ),
      }
    : emptySessionCreditsSnapshot();
  if (historyIncomplete) snapshot.historyIncomplete = true;
  return snapshot;
}

export function hydrateSessionCredits(
  sessionId: string,
  persisted?: PersistedSessionCredits | null,
  historyIncomplete = false,
): void {
  const state = getOrCreateSessionCreditsState(sessionId);
  state.snapshot = buildSessionCreditsSnapshot(persisted, historyIncomplete);
  state.recordedRequestIds.clear();
  state.recordedRequestMetering.clear();
  state.meteringAliases.clear();
  sessionStatsService.setSessionCreditsSnapshot(sessionId, state.snapshot);
}

/** Server-provided metering for one completed request. */
export interface MeteredRequestUsage {
  credits?: number;
  originalCredits?: number;
  billable?: boolean;
}

export function recordCompletedRequest(params: {
  sessionId: string;
  requestId: string;
  model: string;
  usage?: MeteredRequestUsage;
}): boolean {
  const { sessionId, requestId, model, usage } = params;
  if (!usage) {
    return false;
  }
  // 先逐字段保留服务端计费事实，供 transcript 恢复消息级 usage；
  // 是否纳入累计扣费仍由下方严格校验单独决定。同一物理请求的重发以最后一次为准。
  const metering = sanitizeMeteredRequestUsage(usage);
  if (metering) {
    getOrCreateSessionCreditsState(sessionId).recordedRequestMetering.set(
      requestId,
      metering,
    );
  }
  if (typeof usage.billable !== 'boolean') {
    if (usage.credits !== undefined || usage.originalCredits !== undefined) {
      runLogger.debug(
        `[session.credits] ignored incomplete metering request=${requestId}: billable is missing`,
      );
    }
    return false;
  }
  if (
    usage.billable &&
    (typeof usage.credits !== 'number' ||
      !Number.isFinite(usage.credits) ||
      usage.credits < 0)
  ) {
    runLogger.debug(
      `[session.credits] ignored incomplete metering request=${requestId}: billable request has no valid credits`,
    );
    return false;
  }
  if (
    usage.billable === false &&
    typeof usage.credits === 'number' &&
    Number.isFinite(usage.credits) &&
    usage.credits > 0
  ) {
    runLogger.debug(
      `[session.credits] ignored non-zero credits for non-billable request=${requestId}`,
    );
  }
  if (
    typeof usage.credits === 'number' &&
    typeof usage.originalCredits === 'number' &&
    Number.isFinite(usage.credits) &&
    Number.isFinite(usage.originalCredits) &&
    usage.originalCredits < usage.credits
  ) {
    runLogger.debug(
      `[session.credits] original credits are below actual credits request=${requestId}`,
    );
  }

  const state = getOrCreateSessionCreditsState(sessionId);
  if (state.recordedRequestIds.has(requestId)) {
    return false;
  }

  const delta = usage.billable ? (usage.credits ?? 0) : 0;
  state.recordedRequestIds.set(requestId, delta);
  recordScopedCredits(
    sessionId,
    requestId,
    delta
  );
  state.snapshot.observed = true;
  state.snapshot.totalCredits += delta;
  const modelUsage = state.snapshot.byModel[model] ?? { credits: 0 };
  modelUsage.credits += delta;
  state.snapshot.byModel[model] = modelUsage;

  const snapshot = cloneSessionCreditsSnapshot(state.snapshot);
  for (const binding of boundCreditsStores) {
    if (binding.sessionId === sessionId) {
      recordSessionCreditsInMemory(binding.store, snapshot);
    }
  }
  sessionStatsService.setSessionCreditsSnapshot(sessionId, snapshot);
  return true;
}

/** 消息级 transcript usage 使用的计费字段（服务端 snake_case 口径）。 */
export interface RequestUsageBilling {
  credits?: number;
  original_credits?: number;
  billable?: boolean;
}

/**
 * 读取本进程为该逻辑请求记录的服务端计费字段。
 * 排队重投或重试会更换物理请求 ID，由 linkRequestMeteringId 完成映射。
 * 缺少计量时返回 undefined，不根据 token 或价格推算。
 */
export function getRequestUsageBilling(
  sessionId: string,
  requestId: string,
): RequestUsageBilling | undefined {
  const state = sessionCreditsById.get(sessionId);
  if (!state) return undefined;
  const aliasedRequestId = state.meteringAliases.get(requestId);
  // 逻辑 ID 可能恰好是首次尝试的物理 ID；结算后的映射优先于旧尝试计量。
  const metering = aliasedRequestId
    ? state.recordedRequestMetering.get(aliasedRequestId)
    : state.recordedRequestMetering.get(requestId);
  if (!metering) return undefined;
  return {
    ...(metering.credits !== undefined ? { credits: metering.credits } : {}),
    ...(metering.originalCredits !== undefined
      ? { original_credits: metering.originalCredits }
      : {}),
    ...(metering.billable !== undefined ? { billable: metering.billable } : {}),
  };
}

/** 记录逻辑请求 ID 与最终物理请求 ID 的对应关系，供 transcript 读回计费字段。 */
export function linkRequestMeteringId(
  sessionId: string,
  logicalRequestId: string,
  physicalRequestId: string,
): void {
  if (!physicalRequestId || logicalRequestId === physicalRequestId) return;
  getOrCreateSessionCreditsState(sessionId).meteringAliases.set(
    logicalRequestId,
    physicalRequestId,
  );
}

/** 将已记录的服务端计费字段补回请求级 usage。 */
export function attachRequestUsageBilling(
  usage: NonNullableUsage,
  sessionId: string,
  requestId: string,
): void {
  const billing = getRequestUsageBilling(sessionId, requestId);
  if (!billing) return;
  if (billing.credits !== undefined) usage.credits = billing.credits;
  if (billing.original_credits !== undefined) {
    usage.original_credits = billing.original_credits;
  }
  if (billing.billable !== undefined) usage.billable = billing.billable;
}

export async function bindSessionCreditsPersistence(
  sessionId: string,
  store: SessionStateStore,
): Promise<SessionCreditsPersistenceDisposer> {
  const segment = await store.getSegment(SESSION_USAGE_SEGMENT_KEY);
  const state = parseSessionUsageState(segment);
  hydrateSessionCredits(sessionId, state?.credits, state?.historyIncomplete);

  const binding = { sessionId, store };
  boundCreditsStores.add(binding);
  let disposePromise: Promise<void> | undefined;
  // The first call wins, including its settle budget. A single disposer is only
  // ever reachable from one budget: interactive rebuilds dispose the previous
  // disposer and install a new one, while shutdown disposes whichever one is
  // current.
  return (options) => {
    const settleTimeoutMs =
      options?.settleTimeoutMs ?? CREDITS_REQUEST_SETTLE_TIMEOUT_MS;
    disposePromise ??= (async () => {
      const settled = await waitForActiveCreditsRequests(
        sessionId,
        settleTimeoutMs,
      );
      if (!settled) {
        runLogger.warn(
          `[session.credits] timed out waiting for active requests session=${sessionId} timeout_ms=${settleTimeoutMs}`,
        );
      }
      try {
        await flushSessionUsage(store);
      } catch (error) {
        runLogger.warn(
          `[session.credits] failed final persistence flush session=${sessionId}`,
          error,
        );
      } finally {
        boundCreditsStores.delete(binding);
      }
    })();
    return disposePromise;
  };
}

export const bindSessionUsagePersistence = bindSessionCreditsPersistence;

/**
 * Marks one metered request in flight so a final persistence flush waits for
 * its credits; the returned callback releases it exactly once.
 */
export function beginActiveCreditsRequest(sessionId: string): () => void {
  const requestToken = Symbol(sessionId);
  let activeRequests = activeCreditsRequestsBySession.get(sessionId);
  if (!activeRequests) {
    activeRequests = new Set<symbol>();
    activeCreditsRequestsBySession.set(sessionId, activeRequests);
  }
  activeRequests.add(requestToken);

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const currentRequests = activeCreditsRequestsBySession.get(sessionId);
    currentRequests?.delete(requestToken);
    if (currentRequests && currentRequests.size > 0) {
      return;
    }
    activeCreditsRequestsBySession.delete(sessionId);
    const waiters = activeCreditsRequestWaiters.get(sessionId);
    activeCreditsRequestWaiters.delete(sessionId);
    for (const resolve of waiters ?? []) {
      resolve(true);
    }
  };
}

function waitForActiveCreditsRequests(
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  if ((activeCreditsRequestsBySession.get(sessionId)?.size ?? 0) === 0) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let waiters = activeCreditsRequestWaiters.get(sessionId);
    if (!waiters) {
      waiters = new Set<(settled: boolean) => void>();
      activeCreditsRequestWaiters.set(sessionId, waiters);
    }

    const finish = (settled: boolean) => {
      clearTimeout(timer);
      const currentWaiters = activeCreditsRequestWaiters.get(sessionId);
      currentWaiters?.delete(finish);
      if (currentWaiters?.size === 0) {
        activeCreditsRequestWaiters.delete(sessionId);
      }
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    waiters.add(finish);
    if ((activeCreditsRequestsBySession.get(sessionId)?.size ?? 0) === 0) {
      finish(true);
      return;
    }
  });
}

export async function recordSessionUsage(
  store: SessionStateStore,
  usage: NonNullableUsage,
  now: Date = new Date(),
): Promise<SessionUsageState> {
  let nextState: SessionUsageState | undefined;

  await store.update((payload) => {
    const previous = parseSessionUsageState(
      payload.segments[SESSION_USAGE_SEGMENT_KEY],
    );
    const nextLatest = cloneUsageForSessionState(usage);
    nextState = {
      updatedAt: now.toISOString(),
      ...(previous?.historyIncomplete ? { historyIncomplete: true } : {}),
      latest: nextLatest,
      latestRequestId: usage.request_id,
      total: addUsageCounters(previous?.total, nextLatest),
      ...(previous?.credits ? { credits: previous.credits } : {}),
    };

    setPrivateRuntimeSegment(payload, nextState);
  });

  if (!nextState) {
    throw new Error('Session usage state update did not produce a payload.');
  }

  return nextState;
}

export async function loadLatestSessionUsage(
  store?: SessionStateStore | null,
): Promise<NonNullableUsage | null> {
  if (!store) {
    return null;
  }

  const segment = await store.getSegment(SESSION_USAGE_SEGMENT_KEY);
  const state = parseSessionUsageState(segment);
  const latest = state?.latest;
  if (!latest) {
    return null;
  }

  return {
    ...usageCountersToAnthropicUsage(latest),
    request_id: state?.latestRequestId,
  };
}

/**
 * Read persisted session credits from a `SessionStateStore` without mutating
 * in-memory tracking state.
 */
export async function loadSessionCreditsSnapshot(
  store?: SessionStateStore | null,
): Promise<SessionCreditsSnapshot> {
  if (!store) {
    return emptySessionCreditsSnapshot();
  }

  const segment = await store.getSegment(SESSION_USAGE_SEGMENT_KEY);
  const state = parseSessionUsageState(segment);
  return buildSessionCreditsSnapshot(state?.credits, state?.historyIncomplete);
}

interface UsageCache {
  latestRequestId?: string;
  latestUsage: SessionUsageCounters;
  totalDelta: SessionUsageCounters;
  dirty: boolean;
}

const usageCacheMap = new WeakMap<SessionStateStore, UsageCache>();

interface CreditsCache {
  snapshot: SessionCreditsSnapshot;
  dirty: boolean;
}

const creditsCacheMap = new WeakMap<SessionStateStore, CreditsCache>();

function recordSessionCreditsInMemory(
  store: SessionStateStore,
  snapshot: SessionCreditsSnapshot,
): void {
  creditsCacheMap.set(store, {
    snapshot: cloneSessionCreditsSnapshot(snapshot),
    dirty: true,
  });
}

export function recordSessionUsageInMemory(
  store: SessionStateStore,
  usage: NonNullableUsage,
): void {
  let cache = usageCacheMap.get(store);
  if (!cache) {
    cache = { latestUsage: zeroCounters(), totalDelta: zeroCounters(), dirty: false };
    usageCacheMap.set(store, cache);
  }
  const counters = cloneUsageForSessionState(usage);
  cache.latestUsage = counters;
  cache.latestRequestId = usage.request_id;
  cache.totalDelta = addUsageCounters(cache.totalDelta, counters);
  cache.dirty = true;
}

export async function flushSessionUsage(
  store: SessionStateStore,
  now: Date = new Date(),
): Promise<void> {
  const cache = usageCacheMap.get(store);
  const creditsCache = creditsCacheMap.get(store);
  if ((!cache || !cache.dirty) && (!creditsCache || !creditsCache.dirty)) {
    return;
  }

  await store.update((payload) => {
    const previous = parseSessionUsageState(
      payload.segments[SESSION_USAGE_SEGMENT_KEY],
    );
    const nextState: SessionUsageState = {
      updatedAt: now.toISOString(),
      ...(previous?.historyIncomplete ? { historyIncomplete: true } : {}),
      latest: cache?.dirty ? cache.latestUsage : previous?.latest,
      latestRequestId: cache?.dirty
        ? cache.latestRequestId
        : previous?.latestRequestId,
      total: cache?.dirty
        ? addUsageCounters(previous?.total, cache.totalDelta)
        : (previous?.total ?? zeroCounters()),
      ...(creditsCache?.dirty
        ? { credits: snapshotToPersistedCredits(creditsCache.snapshot) }
        : previous?.credits
          ? { credits: previous.credits }
          : {}),
    };
    setPrivateRuntimeSegment(payload, nextState);
  });

  if (cache?.dirty) {
    cache.latestUsage = zeroCounters();
    cache.totalDelta = zeroCounters();
    cache.dirty = false;
  }
  if (creditsCache?.dirty) {
    creditsCache.dirty = false;
  }
}

function snapshotToPersistedCredits(
  snapshot: SessionCreditsSnapshot,
): PersistedSessionCredits {
  return {
    total: snapshot.totalCredits,
    byModel: Object.fromEntries(
      Object.entries(snapshot.byModel).map(([model, usage]) => [
        model,
        { credits: usage.credits },
      ]),
    ),
  };
}

function zeroCounters(): SessionUsageCounters {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
}

export function cloneUsageForSessionState(
  usage: NonNullableUsage,
): SessionUsageCounters {
  return {
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    output_tokens: usage.output_tokens,
  };
}

function setPrivateRuntimeSegment(
  payload: SessionStatePayload,
  state: SessionUsageState,
): void {
  payload.segments[SESSION_USAGE_SEGMENT_KEY] = state;
  payload.encryptedSegmentKeys = [
    ...new Set([...payload.encryptedSegmentKeys, SESSION_USAGE_SEGMENT_KEY]),
  ].sort();
}

function parseSessionUsageState(value: unknown): SessionUsageState | null {
  if (!isRecord(value)) {
    return null;
  }

  const latest = parseUsage(value['latest']);
  const updatedAt = value['updatedAt'];
  const credits = parsePersistedSessionCredits(value['credits']);
  if (
    (!latest && !credits && value['historyIncomplete'] !== true) ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }
  const total = parseUsage(value['total']) ?? latest ?? zeroCounters();

  return {
    updatedAt,
    ...(latest ? { latest } : {}),
    ...(value['historyIncomplete'] === true ? { historyIncomplete: true } : {}),
    latestRequestId:
      isString(value['latestRequestId'])
        ? value['latestRequestId']
        : undefined,
    total,
    ...(credits ? { credits } : {}),
  };
}

function parsePersistedSessionCredits(
  value: unknown,
): PersistedSessionCredits | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const total = readNonNegativeNumber(value['total']);
  const rawByModel = value['byModel'];
  if (total === undefined || !isRecord(rawByModel)) {
    return undefined;
  }

  const byModel: Record<string, { credits: number }> = {};
  for (const [model, rawUsage] of Object.entries(rawByModel)) {
    if (!isRecord(rawUsage)) continue;
    const credits = readNonNegativeNumber(rawUsage['credits']);
    if (credits !== undefined) {
      byModel[model] = { credits };
    }
  }
  return { total, byModel };
}

function parseUsage(value: unknown): SessionUsageCounters | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    input_tokens: readNumber(value['input_tokens']),
    cache_creation_input_tokens: readNumber(
      value['cache_creation_input_tokens'],
    ),
    cache_read_input_tokens: readNumber(value['cache_read_input_tokens']),
    output_tokens: readNumber(value['output_tokens']),
  };
}

function addUsageCounters(
  previous: SessionUsageCounters | undefined,
  next: SessionUsageCounters,
): SessionUsageCounters {
  return {
    input_tokens: (previous?.input_tokens ?? 0) + next.input_tokens,
    cache_creation_input_tokens:
      (previous?.cache_creation_input_tokens ?? 0) +
      next.cache_creation_input_tokens,
    cache_read_input_tokens:
      (previous?.cache_read_input_tokens ?? 0) + next.cache_read_input_tokens,
    output_tokens: (previous?.output_tokens ?? 0) + next.output_tokens,
  };
}

function usageCountersToAnthropicUsage(
  counters: SessionUsageCounters,
): NonNullableUsage {
  return {
    ...cloneUsage(),
    input_tokens: counters.input_tokens,
    cache_creation_input_tokens: counters.cache_creation_input_tokens,
    cache_read_input_tokens: counters.cache_read_input_tokens,
    output_tokens: counters.output_tokens,
  };
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** 逐字段保留合法的服务端计费事实；缺失或非法字段不推断。 */
function sanitizeMeteredRequestUsage(
  usage: MeteredRequestUsage,
): MeteredRequestUsage | undefined {
  const credits = readNonNegativeNumber(usage.credits);
  const originalCredits = readNonNegativeNumber(usage.originalCredits);
  const billable =
    typeof usage.billable === 'boolean' ? usage.billable : undefined;
  if (
    credits === undefined &&
    originalCredits === undefined &&
    billable === undefined
  ) {
    return undefined;
  }
  return {
    ...(credits !== undefined ? { credits } : {}),
    ...(originalCredits !== undefined ? { originalCredits } : {}),
    ...(billable !== undefined ? { billable } : {}),
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
