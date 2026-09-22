// Force strict mode and setup for ESM
"use strict";
import {
  classifyTopLevelConversationSource
} from "./chunk-OHU2H5CS.js";
import {
  A1_MIN_VERSION,
  a1VersionAtLeast,
  isAoneCanonicalHost,
  parseA1Version,
  parseRemoteUrl
} from "./chunk-4VQBQLIZ.js";
import {
  safeLogValue
} from "./chunk-LAUEEBDL.js";
import {
  createSessionOrganizationService
} from "./chunk-UH6N3LO7.js";
import {
  normalizeSessionIdForLookup,
  parseCallerSuppliedSessionId
} from "./chunk-ZEZKIS2K.js";
import {
  SessionArchivedError,
  SessionArchivingError,
  SessionConflictError,
  SessionNotArchivedError,
  SessionNotFoundError
} from "./chunk-YXHY6BKS.js";
import {
  readWorktreeSession,
  readWorktreeSessionStrict
} from "./chunk-M5YIHMXP.js";
import {
  SESSION_PR_LIST_LIMIT,
  SESSION_PR_URL_MAX_LENGTH,
  SessionIdCaseConflictError,
  SessionOrganizationError,
  SessionService,
  SessionTranscriptChangedError,
  SessionWriterUnavailableError,
  canonicalSessionPrUrl,
  gitEnv,
  readSessionPrs,
  toSessionPrInfo
} from "./chunk-MRTRBONQ.js";
import {
  cronTaskSessionDeletionId,
  getCronFilePath,
  updateCronTasks
} from "./chunk-C4FISGDN.js";
import {
  GitWorktreeService,
  WORKTREE_SESSION_FILE,
  readWorktreeSessionMarkerStrict
} from "./chunk-KS6F6LZQ.js";
import {
  NO_EXEC_CONFIG,
  findGitRoot
} from "./chunk-AUFTA63J.js";
import {
  addDaemonRequestAttribute
} from "./chunk-GVTAFLWB.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/server/session-list.ts
init_esbuild_shims();

// packages/cli/src/serve/server/persisted-session-list-cache.ts
init_esbuild_shims();
import path from "node:path";
var PersistedSessionListCache = class {
  constructor(ttlMs, maxRetainedSummaries) {
    this.ttlMs = ttlMs;
    this.maxRetainedSummaries = maxRetainedSummaries;
  }
  static {
    __name(this, "PersistedSessionListCache");
  }
  slots = /* @__PURE__ */ new Map();
  retainedSummaries = 0;
  lookup(scope, loader, options = {}) {
    options.signal?.throwIfAborted();
    const key = this.key(scope);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { generation: 0 };
      this.slots.set(key, slot);
    }
    const now = Date.now();
    if (slot.value) {
      const cacheAgeMs = Math.max(0, now - slot.value.completedAt);
      if (cacheAgeMs < this.ttlMs) {
        const snapshot = slot.value.snapshot;
        return {
          status: "cache_hit",
          promise: Promise.resolve().then(() => {
            options.signal?.throwIfAborted();
            return snapshot;
          }),
          cacheAgeMs
        };
      }
      this.removeValue(slot);
    }
    if (slot.inFlight !== void 0 && slot.inFlight.generation === slot.generation && !slot.inFlight.controller.signal.aborted) {
      return {
        status: "single_flight",
        promise: this.attachWaiter(key, slot, slot.inFlight, options.signal)
      };
    }
    const generation = slot.generation;
    const controller = new AbortController();
    const load = {
      generation,
      controller,
      promise: void 0,
      waiterCount: 0,
      settled: false
    };
    const managed = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return loader(controller.signal);
    }).then(
      (snapshot) => {
        load.settled = true;
        const current = this.slots.get(key);
        if (current === slot && current.inFlight === load) {
          current.inFlight = void 0;
          if (current.generation === generation && !controller.signal.aborted && snapshot.sessions.length <= this.maxRetainedSummaries) {
            this.installValue(key, current, snapshot);
          } else if (current.value === void 0) {
            this.slots.delete(key);
          }
        }
        return snapshot;
      },
      (error) => {
        load.settled = true;
        const current = this.slots.get(key);
        if (current === slot && current.inFlight === load) {
          current.inFlight = void 0;
          if (current.value === void 0) this.slots.delete(key);
        }
        throw error;
      }
    );
    load.promise = managed;
    slot.inFlight = load;
    return {
      status: "scan",
      promise: this.attachWaiter(key, slot, load, options.signal)
    };
  }
  invalidate(scope) {
    const key = this.key(scope);
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.generation += 1;
    this.removeValue(slot);
    if (slot.inFlight === void 0) this.slots.delete(key);
  }
  clear() {
    for (const slot of this.slots.values()) {
      if (slot.value) clearTimeout(slot.value.expiryTimer);
    }
    this.slots.clear();
    this.retainedSummaries = 0;
  }
  installValue(key, slot, snapshot) {
    const completedAt = Date.now();
    this.evictFor(snapshot.sessions.length);
    const remainingTtlMs = Math.max(0, this.ttlMs - (Date.now() - completedAt));
    const expiryTimer = setTimeout(() => {
      const current = this.slots.get(key);
      if (current !== slot || current.value?.expiryTimer !== expiryTimer) {
        return;
      }
      this.removeValue(current);
      if (current.inFlight === void 0) this.slots.delete(key);
    }, remainingTtlMs);
    if (typeof expiryTimer.unref === "function") expiryTimer.unref();
    const value = { snapshot, completedAt, expiryTimer };
    slot.value = value;
    this.retainedSummaries += snapshot.sessions.length;
  }
  evictFor(incomingSummaries) {
    while (this.retainedSummaries + incomingSummaries > this.maxRetainedSummaries) {
      let oldest;
      for (const [key, slot] of this.slots) {
        if (slot.value && (oldest === void 0 || slot.value.completedAt < oldest.completedAt)) {
          oldest = { key, slot, completedAt: slot.value.completedAt };
        }
      }
      if (!oldest) return;
      this.removeValue(oldest.slot);
      if (oldest.slot.inFlight === void 0) this.slots.delete(oldest.key);
    }
  }
  removeValue(slot) {
    const value = slot.value;
    if (!value) return;
    clearTimeout(value.expiryTimer);
    this.retainedSummaries -= value.snapshot.sessions.length;
    slot.value = void 0;
  }
  attachWaiter(key, slot, load, signal) {
    load.waiterCount += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = /* @__PURE__ */ __name((finish) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        load.waiterCount -= 1;
        if (load.waiterCount === 0 && !load.settled) {
          load.controller.abort(
            new DOMException("No active session list waiters", "AbortError")
          );
          const current = this.slots.get(key);
          if (current === slot && current.inFlight === load) {
            current.inFlight = void 0;
            if (current.value === void 0) this.slots.delete(key);
          }
        }
        finish();
      }, "settle");
      const onAbort = /* @__PURE__ */ __name(() => {
        if (load.settled) return;
        settle(() => reject(signal?.reason));
      }, "onAbort");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void load.promise.then(
        (snapshot) => settle(() => resolve(snapshot)),
        (error) => settle(() => reject(error))
      );
    });
  }
  key(scope) {
    return JSON.stringify([
      path.resolve(scope.runtimeBaseDir),
      scope.workspaceCwd,
      scope.archiveState
    ]);
  }
};

// packages/cli/src/serve/server/activity-timestamp.ts
init_esbuild_shims();
function laterActivityTimestamp(live, persisted) {
  const liveTime = live === void 0 ? Number.NaN : Date.parse(live);
  const persistedTime = persisted === void 0 ? Number.NaN : Date.parse(persisted);
  const liveValid = Number.isFinite(liveTime);
  const persistedValid = Number.isFinite(persistedTime);
  if (liveValid && persistedValid) {
    return liveTime >= persistedTime ? live : persisted;
  }
  if (liveValid) return live;
  if (persistedValid) return persisted;
  return live ?? persisted;
}
__name(laterActivityTimestamp, "laterActivityTimestamp");

// packages/cli/src/serve/server/session-list.ts
var DEFAULT_SESSION_PAGE_SIZE = 20;
var MAX_SESSION_PAGE_SIZE = 100;
var MAX_ORGANIZED_SESSIONS = 5e4;
var MAX_EMITTED_CURSOR_SESSION_IDS = 64;
var PERSISTED_SESSION_LIST_CACHE_TTL_MS = 2e3;
var persistedSessionListCache = new PersistedSessionListCache(
  PERSISTED_SESSION_LIST_CACHE_TTL_MS,
  MAX_ORGANIZED_SESSIONS
);
function invalidateWorkspaceSessionListCache(options) {
  for (const archiveState of options.archiveStates) {
    persistedSessionListCache.invalidate({
      runtimeBaseDir: options.runtimeBaseDir,
      workspaceCwd: options.workspaceCwd,
      archiveState
    });
  }
}
__name(invalidateWorkspaceSessionListCache, "invalidateWorkspaceSessionListCache");
var InvalidCursorError = class extends Error {
  static {
    __name(this, "InvalidCursorError");
  }
  constructor(cursor, kind = "numeric") {
    super(`Invalid cursor: "${cursor}" is not a valid ${kind} cursor`);
    this.name = "InvalidCursorError";
  }
};
function parseSessionCursor(cursor) {
  if (cursor === "") return void 0;
  const trimmed = cursor.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new InvalidCursorError(cursor);
  }
  return parsed;
}
__name(parseSessionCursor, "parseSessionCursor");
function parseEmittedSessionIds(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    return void 0;
  }
  return value;
}
__name(parseEmittedSessionIds, "parseEmittedSessionIds");
function parseOrganizedCursor(cursor, expected) {
  if (cursor === "") return void 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    const last = parsed.last;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof last !== "object" || last === null || Array.isArray(last) || typeof last.isPinned !== "boolean" || typeof last.activityTime !== "number" || !Number.isFinite(last.activityTime) || typeof last.sessionId !== "string" || last.sessionId.length === 0 || parsed.group !== expected.group || parsed.archiveState !== expected.archiveState || parsed.sourceType !== expected.sourceType || parsed.sourceId !== expected.sourceId || parsed.conversationKind !== expected.conversationKind) {
      throw new Error("invalid organized cursor");
    }
    const emitted = parseEmittedSessionIds(parsed.emitted);
    if (emitted === void 0) {
      throw new Error("invalid organized cursor");
    }
    return { last, emitted };
  } catch {
    throw new InvalidCursorError(cursor, "organized");
  }
}
__name(parseOrganizedCursor, "parseOrganizedCursor");
function encodeOrganizedCursor(last, group, archiveState, sourceType, sourceId, conversationKind, emitted = []) {
  return Buffer.from(
    JSON.stringify({
      group,
      archiveState,
      sourceType,
      sourceId,
      conversationKind,
      last,
      ...emitted.length > 0 ? { emitted } : {}
    }),
    "utf8"
  ).toString("base64url");
}
__name(encodeOrganizedCursor, "encodeOrganizedCursor");
function parseLiveSessionCursor(cursor) {
  if (cursor === "") return void 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof parsed.activityTime !== "number" || !Number.isFinite(parsed.activityTime) || typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) {
      throw new Error("invalid live cursor");
    }
    return parsed;
  } catch {
    throw new InvalidCursorError(cursor, "live");
  }
}
__name(parseLiveSessionCursor, "parseLiveSessionCursor");
function encodeLiveSessionCursor(last) {
  return Buffer.from(JSON.stringify(last), "utf8").toString("base64url");
}
__name(encodeLiveSessionCursor, "encodeLiveSessionCursor");
function matchesSessionMetadataSource(session, filter) {
  if (filter.conversationKind === "standalone-top-level" && classifyTopLevelConversationSource(session)?.kind !== "standalone") {
    return false;
  }
  const sourceTypeMatches = filter.sourceType === void 0 || session.sourceType === filter.sourceType || // Live-created tasks retain attribution while sharing the task catalog.
  filter.sourceType === "default" && (session.sourceType === void 0 || session.sourceType === "qwen-live");
  return sourceTypeMatches && // Source identifiers remain exact within the selected catalog.
  (filter.sourceId === void 0 || session.sourceId === filter.sourceId);
}
__name(matchesSessionMetadataSource, "matchesSessionMetadataSource");
function parseMetadataSessionCursor(cursor, expected) {
  if (cursor === "") return void 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    const last = parsed.last;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof last !== "object" || last === null || Array.isArray(last) || typeof last.activityTime !== "number" || !Number.isFinite(last.activityTime) || typeof last.sessionId !== "string" || last.sessionId.length === 0 || parsed.parentSessionId !== expected.parentSessionId || parsed.sourceType !== expected.sourceType || parsed.sourceId !== expected.sourceId || parsed.conversationKind !== expected.conversationKind || parsed.archiveState !== expected.archiveState) {
      throw new Error("invalid metadata cursor");
    }
    const emitted = parseEmittedSessionIds(
      parsed.emitted
    );
    if (emitted === void 0) {
      throw new Error("invalid metadata cursor");
    }
    return {
      last: { activityTime: last.activityTime, sessionId: last.sessionId },
      emitted
    };
  } catch {
    throw new InvalidCursorError(
      cursor,
      expected.sourceType === void 0 ? "parent" : "metadata"
    );
  }
}
__name(parseMetadataSessionCursor, "parseMetadataSessionCursor");
function encodeMetadataSessionCursor(last, filter, archiveState, emitted = []) {
  return Buffer.from(
    JSON.stringify({
      ...filter,
      archiveState,
      last,
      ...emitted.length > 0 ? { emitted } : {}
    }),
    "utf8"
  ).toString("base64url");
}
__name(encodeMetadataSessionCursor, "encodeMetadataSessionCursor");
async function enrichWorktreeSidecars(bySessionId, sessionService, archiveState = "active", signal) {
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    if (summary.worktree) continue;
    let sidecar;
    try {
      const sidecarPath = sessionService.getWorktreeSessionPathForArchiveState(
        sessionId,
        archiveState
      );
      sidecar = signal ? await readWorktreeSession(sidecarPath, { signal }) : await readWorktreeSession(sidecarPath);
    } catch {
      signal?.throwIfAborted();
      sidecar = null;
    }
    if (sidecar) {
      bySessionId.set(sessionId, {
        ...summary,
        worktree: {
          slug: sidecar.slug,
          path: sidecar.worktreePath,
          branch: sidecar.worktreeBranch
        }
      });
    }
  }
}
__name(enrichWorktreeSidecars, "enrichWorktreeSidecars");
async function enrichPrSidecars(bySessionId, sessionService, archiveState, signal) {
  for (const [sessionId, summary] of bySessionId) {
    signal?.throwIfAborted();
    let sidecar;
    try {
      const sidecarPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        archiveState
      );
      sidecar = signal ? await readSessionPrs(sidecarPath, { signal }) : await readSessionPrs(sidecarPath);
    } catch {
      signal?.throwIfAborted();
      sidecar = null;
    }
    if (sidecar) {
      bySessionId.set(sessionId, {
        ...summary,
        prs: sidecarToPrInfos(sidecar)
      });
    }
  }
}
__name(enrichPrSidecars, "enrichPrSidecars");
function toSummary(item) {
  return {
    sessionId: item.sessionId,
    workspaceCwd: item.cwd,
    createdAt: item.startTime,
    updatedAt: new Date(item.mtime).toISOString(),
    displayName: item.customTitle || item.prompt,
    ...item.customTitle && item.titleSource ? { titleSource: item.titleSource } : {},
    ...item.parentSessionId ? { parentSessionId: item.parentSessionId } : {},
    ...item.sourceType ? { sourceType: item.sourceType } : {},
    ...item.sourceId !== void 0 ? { sourceId: item.sourceId } : {},
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: item.isArchived === true
  };
}
__name(toSummary, "toSummary");
function mergeLiveSessionSummary(existing, live) {
  const merged = {
    ...existing,
    ...live,
    createdAt: existing.createdAt,
    displayName: live.displayName ?? existing.displayName,
    // Immutable lineage; the persisted transcript is authoritative, and a live
    // entry only carries it when spawned this run.
    parentSessionId: existing.parentSessionId ?? live.parentSessionId,
    sourceType: existing.sourceType ?? live.sourceType,
    sourceId: existing.sourceType !== void 0 ? existing.sourceId : live.sourceId,
    updatedAt: laterActivityTimestamp(live.updatedAt, existing.updatedAt),
    clientCount: live.clientCount,
    hasActivePrompt: live.hasActivePrompt,
    backgroundTurn: live.backgroundTurn,
    hasRunningBackgroundTasks: live.hasRunningBackgroundTasks,
    isArchived: false
  };
  if (existing.prs || live.prs) {
    merged.prs = mergeSummaryPrs(existing.prs, live.prs);
  }
  return merged;
}
__name(mergeLiveSessionSummary, "mergeLiveSessionSummary");
function sidecarToPrInfos(sidecar) {
  return sidecar.map(toSessionPrInfo);
}
__name(sidecarToPrInfos, "sidecarToPrInfos");
function mergeSummaryPrs(persistedPrs, livePrs) {
  const live = livePrs ?? [];
  const persisted = persistedPrs ?? [];
  const liveByNumber = new Map(live.map((l) => [l.number, l]));
  const persistedNumbers = new Set(persisted.map((p) => p.number));
  const consumedLive = /* @__PURE__ */ new Set();
  const ordered = [];
  for (const p of persisted) {
    const liveEntry = liveByNumber.get(p.number);
    if (!liveEntry) {
      ordered.push(p);
      continue;
    }
    const samePr = canonicalSessionPrUrl(p.url) === canonicalSessionPrUrl(liveEntry.url);
    const matchedTwinExists = persisted.some(
      (q) => q.number === p.number && canonicalSessionPrUrl(q.url) === canonicalSessionPrUrl(liveEntry.url)
    );
    if (!samePr && matchedTwinExists) continue;
    if (consumedLive.has(p.number)) continue;
    consumedLive.add(p.number);
    ordered.push(
      samePr ? {
        ...liveEntry,
        ...p.state ? { state: p.state } : {},
        ...p.issues ? { issues: p.issues } : {}
      } : p
    );
  }
  for (const liveEntry of live) {
    if (!persistedNumbers.has(liveEntry.number) && persisted.length < SESSION_PR_LIST_LIMIT) {
      ordered.push(liveEntry);
    }
  }
  return ordered.slice(-SESSION_PR_LIST_LIMIT);
}
__name(mergeSummaryPrs, "mergeSummaryPrs");
async function liveOnlySummary(live, sessionService, signal) {
  const summary = {
    ...live,
    createdAt: live.createdAt,
    clientCount: live.clientCount,
    hasActivePrompt: live.hasActivePrompt,
    backgroundTurn: live.backgroundTurn,
    hasRunningBackgroundTasks: live.hasRunningBackgroundTasks,
    isArchived: false
  };
  let sidecar;
  try {
    const sidecarPath = sessionService.getPrSessionPathForArchiveState(
      live.sessionId,
      "active"
    );
    sidecar = signal ? await readSessionPrs(sidecarPath, { signal }) : await readSessionPrs(sidecarPath);
  } catch {
    signal?.throwIfAborted();
    sidecar = null;
  }
  if (sidecar) {
    summary.prs = mergeSummaryPrs(sidecarToPrInfos(sidecar), live.prs);
  }
  return summary;
}
__name(liveOnlySummary, "liveOnlySummary");
function clonePersistedSummary(session) {
  return {
    ...session,
    ...session.worktree ? { worktree: { ...session.worktree } } : {}
  };
}
__name(clonePersistedSummary, "clonePersistedSummary");
async function loadAllPersistedSummaries(sessionService, archiveState, signal) {
  const scanStartedAt = performance.now();
  signal.throwIfAborted();
  const sessions = [];
  let truncated = false;
  let scanPages = 0;
  let cursor;
  do {
    scanPages += 1;
    const page = await sessionService.listSessions({
      cursor,
      size: 1e4,
      archiveState,
      signal
    });
    signal.throwIfAborted();
    const remaining = MAX_ORGANIZED_SESSIONS - sessions.length;
    sessions.push(...page.items.slice(0, remaining).map(toSummary));
    cursor = page.nextCursor;
    if (page.items.length === 0) {
      break;
    }
    if (page.items.length > remaining || sessions.length >= MAX_ORGANIZED_SESSIONS && cursor !== void 0) {
      writeStderrLine(
        `qwen serve: organized session list truncated at ${MAX_ORGANIZED_SESSIONS} sessions`
      );
      truncated = true;
      break;
    }
  } while (cursor !== void 0);
  const bySessionId = new Map(
    sessions.map((session) => [session.sessionId, session])
  );
  await enrichWorktreeSidecars(
    bySessionId,
    sessionService,
    archiveState,
    signal
  );
  await enrichPrSidecars(bySessionId, sessionService, archiveState, signal);
  signal.throwIfAborted();
  return {
    sessions: [...bySessionId.values()],
    truncated,
    scanPages,
    scanDurationMs: Math.max(0, performance.now() - scanStartedAt)
  };
}
__name(loadAllPersistedSummaries, "loadAllPersistedSummaries");
async function listAllPersistedSummaries(sessionService, workspaceCwd, archiveState, runtimeBaseDir, queryKind, signal) {
  const lookup = persistedSessionListCache.lookup(
    { runtimeBaseDir, workspaceCwd, archiveState },
    (loadSignal) => loadAllPersistedSummaries(sessionService, archiveState, loadSignal),
    { signal }
  );
  addDaemonRequestAttribute(
    "qwen-code.daemon.session_list.cache_status",
    lookup.status
  );
  addDaemonRequestAttribute(
    "qwen-code.daemon.session_list.archive_state",
    archiveState
  );
  addDaemonRequestAttribute(
    "qwen-code.daemon.session_list.query_kind",
    queryKind
  );
  if (lookup.cacheAgeMs !== void 0) {
    addDaemonRequestAttribute(
      "qwen-code.daemon.session_list.cache_age_ms",
      lookup.cacheAgeMs
    );
  }
  const snapshot = await lookup.promise;
  signal?.throwIfAborted();
  addDaemonRequestAttribute(
    "qwen-code.daemon.session_list.persisted_sessions",
    snapshot.sessions.length
  );
  addDaemonRequestAttribute(
    "qwen-code.daemon.session_list.scan_pages",
    snapshot.scanPages
  );
  addDaemonRequestAttribute(
    "qwen-code.daemon.session_list.truncated",
    snapshot.truncated
  );
  if (lookup.status !== "cache_hit") {
    addDaemonRequestAttribute(
      "qwen-code.daemon.session_list.scan_duration_ms",
      snapshot.scanDurationMs
    );
  }
  return snapshot;
}
__name(listAllPersistedSummaries, "listAllPersistedSummaries");
function getSummaryActivityTime(session) {
  const time = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(time) ? time : 0;
}
__name(getSummaryActivityTime, "getSummaryActivityTime");
function getLiveSessionCursorKey(session) {
  return {
    activityTime: getSummaryActivityTime(session),
    sessionId: session.sessionId
  };
}
__name(getLiveSessionCursorKey, "getLiveSessionCursorKey");
function compareLiveSessionCursorKeys(a, b) {
  const byTime = b.activityTime - a.activityTime;
  if (byTime !== 0) return byTime;
  return a.sessionId.localeCompare(b.sessionId);
}
__name(compareLiveSessionCursorKeys, "compareLiveSessionCursorKeys");
function compareOrganizedSessions(activityTimeById, a, b) {
  return compareOrganizedCursorKeys(
    getOrganizedCursorKey(activityTimeById, a),
    getOrganizedCursorKey(activityTimeById, b)
  );
}
__name(compareOrganizedSessions, "compareOrganizedSessions");
function getOrganizedCursorKey(activityTimeById, session) {
  return {
    isPinned: session.isPinned === true,
    activityTime: activityTimeById.get(session.sessionId) ?? 0,
    sessionId: session.sessionId
  };
}
__name(getOrganizedCursorKey, "getOrganizedCursorKey");
function compareOrganizedCursorKeys(a, b) {
  const byPinned = Number(b.isPinned) - Number(a.isPinned);
  if (byPinned !== 0) return byPinned;
  const byTime = b.activityTime - a.activityTime;
  if (byTime !== 0) return byTime;
  return a.sessionId.localeCompare(b.sessionId);
}
__name(compareOrganizedCursorKeys, "compareOrganizedCursorKeys");
function nextEmittedSessionIds(options) {
  const candidates = new Set(options.carried);
  for (const row of options.page) {
    if (options.liveSessionIds.has(row.sessionId)) {
      candidates.add(row.sessionId);
    }
  }
  const kept = [];
  for (const sessionId of candidates) {
    const row = options.listedById.get(sessionId);
    if (!row) {
      kept.push({ sessionId, persistedTime: Number.NEGATIVE_INFINITY });
      continue;
    }
    const persistedTime = options.persistedTimeById.get(sessionId);
    if (persistedTime === void 0) {
      kept.push({ sessionId, persistedTime: Number.NEGATIVE_INFINITY });
      continue;
    }
    if (options.reenters(row, persistedTime)) {
      kept.push({ sessionId, persistedTime });
    }
  }
  if (kept.length > MAX_EMITTED_CURSOR_SESSION_IDS) {
    kept.sort((a, b) => a.persistedTime - b.persistedTime);
    kept.length = MAX_EMITTED_CURSOR_SESSION_IDS;
  }
  return kept.map((entry) => entry.sessionId);
}
__name(nextEmittedSessionIds, "nextEmittedSessionIds");
function applyOrganization(session, organization) {
  return {
    ...session,
    groupId: organization?.groupId ?? null,
    color: organization?.color ?? null,
    isPinned: organization?.isPinned === true,
    ...organization?.pinnedAt !== void 0 ? { pinnedAt: organization.pinnedAt } : {}
  };
}
__name(applyOrganization, "applyOrganization");
async function listOrganizedWorkspaceSessionsForResponse(bridge, workspaceCwd, options, pageSize, readOptions) {
  const archiveState = options.archiveState ?? "active";
  const sessionService = new SessionService(workspaceCwd);
  const organizationService = createSessionOrganizationService(workspaceCwd);
  readOptions.signal?.throwIfAborted();
  const snapshot = await organizationService.readSnapshot();
  readOptions.signal?.throwIfAborted();
  const knownGroupIds = new Set(snapshot.groups.map((group2) => group2.id));
  const group = options.group ?? "all";
  if (group !== "all" && group !== "pinned" && group !== "ungrouped" && !knownGroupIds.has(group)) {
    throw new SessionOrganizationError(
      `Group not found: ${group}`,
      "group_not_found",
      "group"
    );
  }
  const cursor = options.cursor !== void 0 ? parseOrganizedCursor(options.cursor, {
    group,
    archiveState,
    sourceType: options.sourceType,
    sourceId: options.sourceId,
    conversationKind: options.conversationKind
  }) : void 0;
  const cursorKey = cursor?.last;
  const emittedBeforePage = new Set(cursor?.emitted ?? []);
  const isFirstPage = cursorKey === void 0;
  let liveMergeFailed = false;
  const bySessionId = /* @__PURE__ */ new Map();
  const persisted = await listAllPersistedSummaries(
    sessionService,
    workspaceCwd,
    archiveState,
    readOptions.runtimeBaseDir,
    "organized",
    readOptions.signal
  );
  readOptions.signal?.throwIfAborted();
  for (const session of persisted.sessions) {
    bySessionId.set(
      session.sessionId,
      applyOrganization(
        clonePersistedSummary(session),
        snapshot.sessions.get(session.sessionId)
      )
    );
  }
  const persistedTimeById = new Map(
    persisted.sessions.map((session) => [
      session.sessionId,
      getSummaryActivityTime(session)
    ])
  );
  const liveSessionIds = /* @__PURE__ */ new Set();
  if (readOptions.mergeLive !== false && archiveState !== "archived") {
    try {
      const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
      for (const live of liveSessions) {
        liveSessionIds.add(live.sessionId);
        const existing = bySessionId.get(live.sessionId);
        const organization = snapshot.sessions.get(live.sessionId);
        if (existing) {
          bySessionId.set(
            live.sessionId,
            applyOrganization(
              mergeLiveSessionSummary(existing, live),
              organization
            )
          );
        } else if (
          // A live-only row has no persisted key to page by, so it stays a
          // first-page-only insertion as before.
          isFirstPage && // `listAllPersistedSummaries` already scanned every persisted
          // session when the scan wasn't truncated, so a `sessionId` missing
          // from `bySessionId` is definitively new — no disk re-check
          // needed. Re-checking here raced a session that persists its
          // first write (e.g. a `displayName` update) between the scan
          // above and this point: `existing` stayed undefined but
          // `sessionExists` flipped to true, silently dropping the live
          // session from the response instead of merging it.
          (!persisted.truncated || !await (readOptions.signal ? sessionService.sessionExists(live.sessionId, {
            signal: readOptions.signal
          }) : sessionService.sessionExists(live.sessionId)))
        ) {
          bySessionId.set(
            live.sessionId,
            applyOrganization(
              await liveOnlySummary(live, sessionService, readOptions.signal),
              organization
            )
          );
        }
      }
    } catch (error) {
      readOptions.signal?.throwIfAborted();
      liveMergeFailed = true;
      writeStderrLine(
        `qwen serve: organized session list live merge failed; using persisted sessions only: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const filtered = [...bySessionId.values()].filter((session) => {
    if (!matchesSessionMetadataSource(session, options)) return false;
    if (group === "all") return true;
    if (group === "pinned") return session.isPinned === true;
    if (group === "ungrouped")
      return session.groupId == null && session.color == null;
    return session.color == null && session.groupId === group;
  });
  readOptions.signal?.throwIfAborted();
  const activityTimeById = new Map(
    filtered.map((session) => [
      session.sessionId,
      getSummaryActivityTime(session)
    ])
  );
  filtered.sort((a, b) => compareOrganizedSessions(activityTimeById, a, b));
  readOptions.signal?.throwIfAborted();
  const afterCursor = cursorKey === void 0 ? filtered : filtered.filter(
    (session) => (
      // A row already emitted at a live-derived key stays excluded even
      // if its key regressed behind the cursor (live retirement, or a
      // live-only row that persisted mid-pass).
      !emittedBeforePage.has(session.sessionId) && compareOrganizedCursorKeys(
        cursorKey,
        getOrganizedCursorKey(activityTimeById, session)
      ) < 0
    )
  );
  const page = afterCursor.slice(0, pageSize);
  let nextCursor;
  if (page.length < afterCursor.length) {
    const boundary = getOrganizedCursorKey(
      activityTimeById,
      page[page.length - 1]
    );
    const emitted = nextEmittedSessionIds({
      carried: emittedBeforePage,
      page,
      liveSessionIds,
      listedById: new Map(
        filtered.map((session) => [session.sessionId, session])
      ),
      persistedTimeById,
      // `isPinned` is re-read from the organization snapshot on every page
      // request, so a pin flip between fetches can move the persisted key
      // across the pinned/unpinned blocks. Keep the identity while the key
      // could re-enter under either state.
      reenters: /* @__PURE__ */ __name((row, persistedTime) => [true, false].some(
        (isPinned) => compareOrganizedCursorKeys(boundary, {
          isPinned,
          activityTime: persistedTime,
          sessionId: row.sessionId
        }) < 0
      ), "reenters")
    });
    nextCursor = encodeOrganizedCursor(
      boundary,
      group,
      archiveState,
      options.sourceType,
      options.sourceId,
      options.conversationKind,
      emitted
    );
  }
  return {
    sessions: page,
    ...nextCursor !== void 0 ? { nextCursor } : {},
    ...liveMergeFailed ? { liveMergeFailed: true } : {},
    ...persisted.truncated ? { truncated: true } : {}
  };
}
__name(listOrganizedWorkspaceSessionsForResponse, "listOrganizedWorkspaceSessionsForResponse");
async function listWorkspaceSessionsByMetadataForResponse(bridge, workspaceCwd, options, pageSize, filter, readOptions) {
  const archiveState = options.archiveState ?? "active";
  const sessionService = new SessionService(workspaceCwd);
  const bySessionId = /* @__PURE__ */ new Map();
  const persisted = await listAllPersistedSummaries(
    sessionService,
    workspaceCwd,
    archiveState,
    readOptions.runtimeBaseDir,
    "metadata",
    readOptions.signal
  );
  readOptions.signal?.throwIfAborted();
  const canonicalizeStandaloneIds = filter.conversationKind === "standalone-top-level";
  const conflictedStandaloneIds = /* @__PURE__ */ new Set();
  const persistedTimeById = /* @__PURE__ */ new Map();
  for (const session of persisted.sessions) {
    let sessionId = session.sessionId;
    if (canonicalizeStandaloneIds) {
      const parsed = parseCallerSuppliedSessionId(sessionId);
      if (parsed.kind !== "valid") continue;
      sessionId = parsed.sessionId;
      if (conflictedStandaloneIds.has(sessionId)) continue;
      if (bySessionId.has(sessionId)) {
        bySessionId.delete(sessionId);
        persistedTimeById.delete(sessionId);
        conflictedStandaloneIds.add(sessionId);
        continue;
      }
    }
    bySessionId.set(sessionId, {
      ...clonePersistedSummary(session),
      sessionId
    });
    persistedTimeById.set(sessionId, getSummaryActivityTime(session));
  }
  const liveSessionIds = /* @__PURE__ */ new Set();
  let liveMergeFailed = false;
  if (readOptions.mergeLive !== false && archiveState !== "archived") {
    try {
      for (const live of bridge.listWorkspaceSessions(workspaceCwd)) {
        let sessionId = live.sessionId;
        if (canonicalizeStandaloneIds) {
          const parsed = parseCallerSuppliedSessionId(sessionId);
          if (parsed.kind !== "valid" || conflictedStandaloneIds.has(parsed.sessionId)) {
            continue;
          }
          sessionId = parsed.sessionId;
        }
        const canonicalLive = sessionId === live.sessionId ? live : { ...live, sessionId };
        liveSessionIds.add(sessionId);
        const existing = bySessionId.get(sessionId);
        if (existing) {
          bySessionId.set(
            sessionId,
            mergeLiveSessionSummary(existing, canonicalLive)
          );
        } else if (
          // See the matching comment in
          // `listOrganizedWorkspaceSessionsForResponse`: an untruncated scan
          // already covers every persisted session, so skip the racy
          // re-check when nothing was truncated.
          !persisted.truncated || !await (readOptions.signal ? sessionService.sessionExists(sessionId, {
            signal: readOptions.signal
          }) : sessionService.sessionExists(sessionId))
        ) {
          bySessionId.set(
            sessionId,
            await liveOnlySummary(
              canonicalLive,
              sessionService,
              readOptions.signal
            )
          );
        }
      }
    } catch (error) {
      readOptions.signal?.throwIfAborted();
      liveMergeFailed = true;
      writeStderrLine(
        `qwen serve: session metadata filter live merge failed; using persisted sessions only: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const matches = [...bySessionId.values()].filter(
    (session) => (filter.parentSessionId === void 0 || session.parentSessionId === filter.parentSessionId) && matchesSessionMetadataSource(session, filter)
  ).sort(
    (a, b) => compareLiveSessionCursorKeys(
      getLiveSessionCursorKey(a),
      getLiveSessionCursorKey(b)
    )
  );
  readOptions.signal?.throwIfAborted();
  const cursor = options.cursor !== void 0 && options.cursor !== "" ? parseMetadataSessionCursor(options.cursor, {
    ...filter,
    archiveState
  }) : void 0;
  const cursorKey = cursor?.last;
  const emittedBeforePage = new Set(cursor?.emitted ?? []);
  const afterCursor = cursorKey === void 0 ? matches : matches.filter(
    (session) => (
      // See the organized path: exclude rows already emitted at a
      // live-derived key whose key regressed behind the cursor.
      !emittedBeforePage.has(session.sessionId) && compareLiveSessionCursorKeys(
        cursorKey,
        getLiveSessionCursorKey(session)
      ) < 0
    )
  );
  const page = afterCursor.slice(0, pageSize);
  let nextCursor;
  if (page.length < afterCursor.length) {
    const boundary = getLiveSessionCursorKey(page[page.length - 1]);
    const emitted = nextEmittedSessionIds({
      carried: emittedBeforePage,
      page,
      liveSessionIds,
      listedById: new Map(
        matches.map((session) => [session.sessionId, session])
      ),
      persistedTimeById,
      reenters: /* @__PURE__ */ __name((row, persistedTime) => compareLiveSessionCursorKeys(boundary, {
        activityTime: persistedTime,
        sessionId: row.sessionId
      }) < 0, "reenters")
    });
    nextCursor = encodeMetadataSessionCursor(
      boundary,
      filter,
      archiveState,
      emitted
    );
  }
  return {
    sessions: page,
    ...nextCursor !== void 0 ? { nextCursor } : {},
    ...liveMergeFailed ? { liveMergeFailed: true } : {},
    ...persisted.truncated ? { truncated: true } : {}
  };
}
__name(listWorkspaceSessionsByMetadataForResponse, "listWorkspaceSessionsByMetadataForResponse");
async function listWorkspaceSessionsForResponse(bridge, workspaceCwd, options, readOptions = {}) {
  readOptions.signal?.throwIfAborted();
  const runtimeBaseDir = new Storage(
    workspaceCwd,
    readOptions.runtimeBaseDir
  ).getRuntimeBaseDir();
  const result = await Storage.runWithResolvedRuntimeBaseDir(
    runtimeBaseDir,
    () => listWorkspaceSessionsForResponseInRuntime(bridge, workspaceCwd, options, {
      ...readOptions.mergeLive !== void 0 ? { mergeLive: readOptions.mergeLive } : {},
      ...readOptions.signal !== void 0 ? { signal: readOptions.signal } : {},
      runtimeBaseDir
    })
  );
  readOptions.signal?.throwIfAborted();
  return result;
}
__name(listWorkspaceSessionsForResponse, "listWorkspaceSessionsForResponse");
async function listWorkspaceSessionsForResponseInRuntime(bridge, workspaceCwd, options, readOptions) {
  readOptions.signal?.throwIfAborted();
  const rawSize = options?.size;
  const requestedSize = typeof rawSize === "number" && Number.isSafeInteger(rawSize) ? rawSize : DEFAULT_SESSION_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_SESSION_PAGE_SIZE);
  if (options?.view === "organized") {
    return listOrganizedWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      options,
      pageSize,
      readOptions
    );
  }
  if (options?.parentSessionId !== void 0 || options?.sourceType !== void 0 || options?.conversationKind !== void 0) {
    return listWorkspaceSessionsByMetadataForResponse(
      bridge,
      workspaceCwd,
      options,
      pageSize,
      {
        ...options.parentSessionId !== void 0 ? { parentSessionId: options.parentSessionId } : {},
        ...options.sourceType !== void 0 ? { sourceType: options.sourceType } : {},
        ...options.sourceId !== void 0 ? { sourceId: options.sourceId } : {},
        ...options.conversationKind !== void 0 ? { conversationKind: options.conversationKind } : {}
      },
      readOptions
    );
  }
  let numericCursor;
  if (options?.cursor != null) {
    numericCursor = parseSessionCursor(options.cursor);
  }
  const isFirstPage = numericCursor === void 0;
  const sessionService = new SessionService(workspaceCwd);
  const archiveState = options?.archiveState ?? "active";
  const persisted = await sessionService.listSessions({
    cursor: numericCursor,
    size: pageSize,
    archiveState,
    ...readOptions.signal ? { signal: readOptions.signal } : {}
  });
  readOptions.signal?.throwIfAborted();
  const bySessionId = /* @__PURE__ */ new Map();
  for (const item of persisted.items) {
    bySessionId.set(item.sessionId, toSummary(item));
  }
  await enrichWorktreeSidecars(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal
  );
  await enrichPrSidecars(
    bySessionId,
    sessionService,
    archiveState,
    readOptions.signal
  );
  readOptions.signal?.throwIfAborted();
  if (archiveState === "archived" || readOptions.mergeLive === false) {
    const sessions2 = [...bySessionId.values()];
    const nextCursor2 = persisted.nextCursor != null ? String(persisted.nextCursor) : void 0;
    return { sessions: sessions2, nextCursor: nextCursor2 };
  }
  const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
  for (const live of liveSessions) {
    const existing = bySessionId.get(live.sessionId);
    if (existing) {
      bySessionId.set(live.sessionId, mergeLiveSessionSummary(existing, live));
    } else if (isFirstPage && // If this is a complete scan (no further pages), a missing
    // `sessionId` here is definitively new — no disk re-check needed.
    // Re-checking raced a session that persists its first write (e.g. a
    // `displayName` update) between the scan above and this point:
    // `existing` stayed undefined but `sessionExists` flipped to true,
    // silently dropping the live session from the response instead of
    // merging it.
    (persisted.nextCursor == null || !await (readOptions.signal ? sessionService.sessionExists(live.sessionId, {
      signal: readOptions.signal
    }) : sessionService.sessionExists(live.sessionId)))) {
      bySessionId.set(
        live.sessionId,
        await liveOnlySummary(live, sessionService, readOptions.signal)
      );
    }
  }
  const sessions = [...bySessionId.values()].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? a.createdAt);
    const bTime = Date.parse(b.updatedAt ?? b.createdAt);
    return bTime - aTime;
  });
  readOptions.signal?.throwIfAborted();
  const nextCursor = persisted.nextCursor != null ? String(persisted.nextCursor) : void 0;
  return { sessions, nextCursor };
}
__name(listWorkspaceSessionsForResponseInRuntime, "listWorkspaceSessionsForResponseInRuntime");
async function listLiveWorkspaceSessionsForResponse(bridge, workspaceCwd, options, readOptions = {}) {
  const runtimeBaseDir = new Storage(
    workspaceCwd,
    readOptions.runtimeBaseDir
  ).getRuntimeBaseDir();
  return Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
    const rawSize = options?.size;
    const requestedSize = typeof rawSize === "number" && Number.isSafeInteger(rawSize) ? rawSize : DEFAULT_SESSION_PAGE_SIZE;
    const pageSize = Math.min(
      Math.max(requestedSize, 1),
      MAX_SESSION_PAGE_SIZE
    );
    const cursorKey = options?.cursor !== void 0 ? parseLiveSessionCursor(options.cursor) : void 0;
    const sessions = bridge.listWorkspaceSessions(workspaceCwd).sort(
      (a, b) => compareLiveSessionCursorKeys(
        getLiveSessionCursorKey(a),
        getLiveSessionCursorKey(b)
      )
    );
    const afterCursor = cursorKey === void 0 ? sessions : sessions.filter(
      (session) => compareLiveSessionCursorKeys(
        cursorKey,
        getLiveSessionCursorKey(session)
      ) < 0
    );
    const page = afterCursor.slice(0, pageSize);
    const sessionService = new SessionService(workspaceCwd);
    const enriched = await Promise.all(
      page.map(
        (summary) => liveOnlySummary(summary, sessionService, readOptions.signal)
      )
    );
    const nextCursor = page.length < afterCursor.length ? encodeLiveSessionCursor(
      getLiveSessionCursorKey(page[page.length - 1])
    ) : void 0;
    return {
      sessions: enriched,
      ...nextCursor !== void 0 ? { nextCursor } : {}
    };
  });
}
__name(listLiveWorkspaceSessionsForResponse, "listLiveWorkspaceSessionsForResponse");
async function searchWorkspaceSessionsForResponse(workspaceCwd, query, options = {}, readOptions = {}) {
  readOptions.signal?.throwIfAborted();
  const runtimeBaseDir = new Storage(
    workspaceCwd,
    readOptions.runtimeBaseDir
  ).getRuntimeBaseDir();
  return Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
    const sessionService = new SessionService(workspaceCwd);
    const hits = await sessionService.searchSessionContent(query, {
      ...options.maxResults !== void 0 ? { maxResults: options.maxResults } : {},
      ...readOptions.signal ? { signal: readOptions.signal } : {}
    });
    const bySessionId = /* @__PURE__ */ new Map();
    const organizationSnapshot = await createSessionOrganizationService(workspaceCwd).readSnapshot();
    readOptions.signal?.throwIfAborted();
    for (const hit of hits) {
      readOptions.signal?.throwIfAborted();
      const item = await sessionService.getSessionListItem(hit.sessionId);
      if (item)
        bySessionId.set(
          hit.sessionId,
          applyOrganization(
            toSummary(item),
            organizationSnapshot.sessions.get(hit.sessionId)
          )
        );
    }
    await enrichWorktreeSidecars(
      bySessionId,
      sessionService,
      "active",
      readOptions.signal
    );
    await enrichPrSidecars(
      bySessionId,
      sessionService,
      "active",
      readOptions.signal
    );
    readOptions.signal?.throwIfAborted();
    const results = [];
    for (const hit of hits) {
      const session = bySessionId.get(hit.sessionId);
      if (session) results.push({ session, snippet: hit.snippet });
    }
    return { results };
  });
}
__name(searchWorkspaceSessionsForResponse, "searchWorkspaceSessionsForResponse");
async function getWorkspaceSessionInfoForResponse(bridge, workspaceCwd, options = {}) {
  const counts = await new SessionService(workspaceCwd).getSessionInfoCounts();
  return {
    active: counts.active,
    archived: counts.archived,
    total: counts.total,
    ...options.includeLive === false ? {} : { live: bridge.listWorkspaceSessions(workspaceCwd).length },
    expensive: true,
    cost: "disk_scan",
    ...counts.truncated ? { truncated: true } : {}
  };
}
__name(getWorkspaceSessionInfoForResponse, "getWorkspaceSessionInfoForResponse");
function parseSessionPageSizeQuery(raw) {
  if (typeof raw !== "string") return void 0;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return void 0;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return void 0;
  if (Number.isSafeInteger(parsed)) return parsed;
  return trimmed.startsWith("-") ? 1 : MAX_SESSION_PAGE_SIZE;
}
__name(parseSessionPageSizeQuery, "parseSessionPageSizeQuery");

// packages/cli/src/serve/workspace-runtime-storage.ts
init_esbuild_shims();
function runWithWorkspaceRuntimeStorage(runtime, fn) {
  return Storage.runWithResolvedRuntimeBaseDir(
    runtime.sessionRuntimeBaseDir,
    fn
  );
}
__name(runWithWorkspaceRuntimeStorage, "runWithWorkspaceRuntimeStorage");
function createWorkspaceRuntimeSessionService(runtime, options = {}) {
  return new SessionService(runtime.workspaceCwd, {
    ...options,
    runtimeBaseDir: runtime.sessionRuntimeBaseDir
  });
}
__name(createWorkspaceRuntimeSessionService, "createWorkspaceRuntimeSessionService");

// packages/cli/src/serve/server/session-archive.ts
init_esbuild_shims();
import fs2 from "node:fs";

// packages/cli/src/serve/scheduled-task-session-lifecycle.ts
init_esbuild_shims();
import { access } from "node:fs/promises";
function isBoundTask(task) {
  return typeof task.sessionId === "string" && task.sessionId.length > 0;
}
__name(isBoundTask, "isBoundTask");
async function disableTasksForSessions(projectRoot, sessionIds, options = {}) {
  if (sessionIds.length === 0) return;
  const targets = new Set(sessionIds);
  await updateCronTasks(
    projectRoot,
    (tasks) => {
      let changed = false;
      const next = tasks.map((task) => {
        if (isBoundTask(task) && targets.has(task.sessionId) && task.enabled !== false) {
          changed = true;
          return { ...task, enabled: false, disabledByArchive: true };
        }
        return task;
      });
      return changed ? next : tasks;
    },
    options
  );
}
__name(disableTasksForSessions, "disableTasksForSessions");
async function enableTasksForSessions(projectRoot, sessionIds, now = Date.now(), options = {}) {
  if (sessionIds.length === 0) return;
  const targets = new Set(sessionIds);
  await updateCronTasks(
    projectRoot,
    (tasks) => {
      let changed = false;
      const next = tasks.map((task) => {
        if (isBoundTask(task) && targets.has(task.sessionId) && task.enabled === false && task.disabledByArchive === true) {
          changed = true;
          const resumed = { ...task, enabled: true };
          delete resumed.disabledByArchive;
          const minute = now - now % 6e4;
          if (resumed.recurring) {
            resumed.lastFiredAt = minute;
          } else {
            resumed.createdAt = now;
            resumed.lastFiredAt = minute;
          }
          return resumed;
        }
        return task;
      });
      return changed ? next : tasks;
    },
    options
  );
}
__name(enableTasksForSessions, "enableTasksForSessions");
async function removeTasksForSessions(projectRoot, sessionIds, options = {}) {
  if (sessionIds.length === 0) return;
  try {
    await access(getCronFilePath(projectRoot));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const targets = new Set(sessionIds.map(cronTaskSessionDeletionId));
  const removedIds = [];
  await updateCronTasks(
    projectRoot,
    (tasks) => {
      const next = tasks.filter((task) => {
        if (!isBoundTask(task) || !targets.has(cronTaskSessionDeletionId(task.sessionId)))
          return true;
        removedIds.push(task.id);
        return false;
      });
      return next.length === tasks.length ? tasks : next;
    },
    { ...options, deletionIds: /* @__PURE__ */ __name(() => [...removedIds, ...targets], "deletionIds") }
  );
}
__name(removeTasksForSessions, "removeTasksForSessions");

// packages/cli/src/serve/server/worktree-orphan-cleanup.ts
init_esbuild_shims();
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path2 from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// packages/cli/src/serve/server/worktree-ownership-op.ts
init_esbuild_shims();
var worktreeOwnershipOpTails = /* @__PURE__ */ new Map();
async function acquireWorktreeOwnershipOp(worktreeKey) {
  const previous = worktreeOwnershipOpTails.get(worktreeKey);
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const tail = (previous ?? Promise.resolve()).then(() => gate);
  worktreeOwnershipOpTails.set(worktreeKey, tail);
  if (previous) {
    await previous;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (worktreeOwnershipOpTails.get(worktreeKey) === tail) {
      worktreeOwnershipOpTails.delete(worktreeKey);
    }
  };
}
__name(acquireWorktreeOwnershipOp, "acquireWorktreeOwnershipOp");

// packages/cli/src/serve/server/worktree-orphan-cleanup.ts
function canonicalPath(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}
__name(canonicalPath, "canonicalPath");
var execFileAsync = promisify(execFile);
var DISPOSABLE_IGNORED_ROOTS = /* @__PURE__ */ new Set(["node_modules", "dist", "coverage"]);
async function checkoutHasWork(worktreePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        ...NO_EXEC_CONFIG,
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--ignored=matching"
      ],
      { cwd: worktreePath, env: gitEnv() }
    );
    return stdout.split("\n").filter((line) => line.trim().length > 0).some((line) => {
      const entry = line.slice(3);
      if (entry === WORKTREE_SESSION_FILE) return false;
      if (line.startsWith("!!")) {
        return !DISPOSABLE_IGNORED_ROOTS.has(entry.split("/")[0]);
      }
      return true;
    });
  } catch {
    return true;
  }
}
__name(checkoutHasWork, "checkoutHasWork");
function logWarning(message) {
  writeStderrLine(`qwen serve: ${message}`);
}
__name(logWarning, "logWarning");
function logWorktreeCleanupPreserve(sessionId, reason) {
  logWarning(
    `worktree cleanup preserved checkout action=delete session=${safeLogValue(
      sessionId
    )} reason=${safeLogValue(reason)}`
  );
}
__name(logWorktreeCleanupPreserve, "logWorktreeCleanupPreserve");
async function preclassifyWorktreeCleanup(service, sessionId, runtimeWorkspaceCwd) {
  let sidecarPath = service.getWorktreeSessionPath(sessionId);
  let sidecar = await readWorktreeSessionStrict(sidecarPath);
  if (sidecar.state === "missing") {
    const archivedPath = service.getWorktreeSessionPathForArchiveState(
      sessionId,
      "archived"
    );
    if (archivedPath !== sidecarPath) {
      sidecarPath = archivedPath;
      sidecar = await readWorktreeSessionStrict(sidecarPath);
    }
  }
  if (sidecar.state === "missing") return void 0;
  if (sidecar.state === "invalid") {
    logWorktreeCleanupPreserve(
      sessionId,
      `unreadable sidecar (${sidecar.reason})`
    );
    return void 0;
  }
  const session = sidecar.session;
  if (session.workspaceCwd === void 0) return void 0;
  if (session.supersededBy !== void 0) return void 0;
  if (!path2.isAbsolute(session.workspaceCwd) || !path2.isAbsolute(session.originalCwd)) {
    logWorktreeCleanupPreserve(
      sessionId,
      "sidecar base is not an absolute path"
    );
    return void 0;
  }
  if (runtimeWorkspaceCwd !== void 0) {
    if (canonicalPath(session.workspaceCwd) !== canonicalPath(runtimeWorkspaceCwd)) {
      logWorktreeCleanupPreserve(
        sessionId,
        "sidecar belongs to another workspace"
      );
      return void 0;
    }
    const workspaceRoots = [canonicalPath(runtimeWorkspaceCwd)];
    try {
      const repoTop = await new GitWorktreeService(
        runtimeWorkspaceCwd
      ).getRepoTopLevel();
      if (repoTop && canonicalPath(repoTop) !== workspaceRoots[0]) {
        workspaceRoots.push(canonicalPath(repoTop));
      }
    } catch {
    }
    if (!workspaceRoots.includes(canonicalPath(session.originalCwd))) {
      logWorktreeCleanupPreserve(
        sessionId,
        "sidecar original cwd is outside the accepted roots"
      );
      return void 0;
    }
  }
  return {
    sessionId,
    sidecar: session,
    sidecarPath,
    lockKey: canonicalPath(session.worktreePath)
  };
}
__name(preclassifyWorktreeCleanup, "preclassifyWorktreeCleanup");
function acquireWorktreeCleanupLock(plan) {
  return acquireWorktreeOwnershipOp(plan.lockKey);
}
__name(acquireWorktreeCleanupLock, "acquireWorktreeCleanupLock");
async function worktreeAllowedRoots(workspaceCwd, originalCwd) {
  const roots = /* @__PURE__ */ new Set();
  for (const base of [workspaceCwd, originalCwd]) {
    if (!path2.isAbsolute(base)) continue;
    roots.add(path2.join(base, ".qwen", "worktrees"));
    try {
      const repoTop = await new GitWorktreeService(base).getRepoTopLevel();
      if (repoTop) {
        roots.add(path2.join(repoTop, ".qwen", "worktrees"));
      }
    } catch {
    }
  }
  return [...roots];
}
__name(worktreeAllowedRoots, "worktreeAllowedRoots");
async function verifyWorktreeCleanupOwnership(plan) {
  const { sessionId, sidecar } = plan;
  const locked = await readWorktreeSessionStrict(plan.sidecarPath);
  if (locked.state !== "valid") {
    return {
      ok: false,
      reason: locked.state === "missing" ? "sidecar disappeared before delete" : `unreadable sidecar (${locked.reason})`
    };
  }
  const current = locked.session;
  if (current.workspaceCwd === void 0 || current.supersededBy !== void 0 || current.slug !== sidecar.slug || current.worktreePath !== sidecar.worktreePath || current.originalCwd !== sidecar.originalCwd || current.workspaceCwd !== sidecar.workspaceCwd) {
    return { ok: false, reason: "sidecar changed before delete" };
  }
  const marker = await readWorktreeSessionMarkerStrict(plan.lockKey);
  if (marker.state !== "valid" || marker.sessionId !== sessionId) {
    return {
      ok: false,
      reason: marker.state === "valid" ? "marker names another session" : `marker ${marker.state}`
    };
  }
  const allowedRoots = await worktreeAllowedRoots(
    current.workspaceCwd,
    current.originalCwd
  );
  const contained = allowedRoots.some((root) => {
    try {
      const realRoot = fs.realpathSync(root);
      return plan.lockKey === realRoot || plan.lockKey.startsWith(realRoot + path2.sep);
    } catch {
      return false;
    }
  });
  if (!contained) {
    return { ok: false, reason: "checkout outside workspace worktree roots" };
  }
  const chatsDir = path2.dirname(plan.sidecarPath);
  const ownFile = path2.basename(plan.sidecarPath);
  let entries;
  try {
    entries = await fsp.readdir(chatsDir);
  } catch (error) {
    return {
      ok: false,
      reason: `sidecar scan failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".worktree.json") || entry === ownFile) continue;
    const other = await readWorktreeSessionStrict(path2.join(chatsDir, entry));
    if (other.state === "missing") continue;
    if (other.state === "invalid") {
      return { ok: false, reason: `unreadable sibling sidecar ${entry}` };
    }
    if (canonicalPath(other.session.worktreePath) === plan.lockKey) {
      if (other.session.supersededBy === sessionId) continue;
      return { ok: false, reason: `checkout shared with ${entry}` };
    }
  }
  const removalTarget = canonicalPath(
    new GitWorktreeService(current.originalCwd).getUserWorktreePath(
      current.slug
    )
  );
  if (removalTarget !== plan.lockKey) {
    return {
      ok: false,
      reason: "slug does not resolve to the verified checkout"
    };
  }
  plan.sidecar = current;
  return { ok: true };
}
__name(verifyWorktreeCleanupOwnership, "verifyWorktreeCleanupOwnership");
async function checkoutStillPopulated(worktreePath) {
  try {
    return (await fsp.readdir(worktreePath)).length > 0;
  } catch {
    return false;
  }
}
__name(checkoutStillPopulated, "checkoutStillPopulated");
async function executeWorktreeCleanup(plan) {
  const { sessionId, sidecar } = plan;
  const marker = await readWorktreeSessionMarkerStrict(plan.lockKey);
  if (marker.state !== "valid" || marker.sessionId !== sessionId) {
    logWorktreeCleanupPreserve(sessionId, "marker changed after delete");
    return;
  }
  if (await checkoutHasWork(plan.lockKey)) {
    logWorktreeCleanupPreserve(sessionId, "checkout has uncommitted work");
    return;
  }
  const result = await new GitWorktreeService(
    sidecar.originalCwd
  ).removeUserWorktree(sidecar.slug, { deleteBranch: true });
  if (!result.success) {
    const errorText = result.error ?? "unknown error";
    if (await checkoutStillPopulated(plan.lockKey)) {
      logWorktreeCleanupPreserve(
        sessionId,
        `checkout removal failed: ${errorText}`
      );
    } else {
      logWarning(
        `worktree cleanup removal failed, checkout may be partially deleted action=delete session=${safeLogValue(
          sessionId
        )} reason=${safeLogValue(errorText)}`
      );
    }
    return;
  }
  if (result.branchPreserved) {
    logWarning(
      `worktree cleanup removed checkout but kept branch action=delete session=${safeLogValue(
        sessionId
      )} slug=${safeLogValue(sidecar.slug)} branch=${safeLogValue(
        sidecar.worktreeBranch
      )} reason=unmerged commits`
    );
  }
}
__name(executeWorktreeCleanup, "executeWorktreeCleanup");

// packages/cli/src/serve/server/session-archive.ts
var DaemonDrainingError = class extends Error {
  static {
    __name(this, "DaemonDrainingError");
  }
  name = "DaemonDrainingError";
  code = "daemon_draining";
  constructor() {
    super("The daemon is draining and no longer accepts session maintenance.");
  }
};
var SessionArchiveCoordinator = class {
  static {
    __name(this, "SessionArchiveCoordinator");
  }
  exclusive = /* @__PURE__ */ new Set();
  shared = /* @__PURE__ */ new Map();
  sharedDrains = /* @__PURE__ */ new Map();
  maintenanceSealed = false;
  activeMaintenance = 0;
  maintenanceDrain;
  // Lock keys are canonicalized like every other session-id lookup: batch
  // delete/archive/unarchive lock raw caller spellings while restore locks
  // the request spelling, and on a case-insensitive filesystem both reach
  // the same transcript file — uncanonicalized keys would let a differently
  // cased caller id slip past a held guard and unlink it mid-restore.
  assertNotTransitioning(sessionId) {
    if (this.exclusive.has(normalizeSessionIdForLookup(sessionId))) {
      throw new SessionArchivingError(sessionId);
    }
  }
  async runExclusiveMany(sessionIds, fn) {
    if (this.maintenanceSealed) {
      throw new DaemonDrainingError();
    }
    const uniqueSessionIds = [
      ...new Set(sessionIds.map(normalizeSessionIdForLookup))
    ];
    for (const sessionId of uniqueSessionIds) {
      this.assertNotTransitioning(sessionId);
      if ((this.shared.get(sessionId) ?? 0) > 0) {
        throw new SessionArchivingError(sessionId, "shared");
      }
    }
    for (const sessionId of uniqueSessionIds) {
      this.exclusive.add(sessionId);
    }
    this.activeMaintenance++;
    try {
      return await fn();
    } finally {
      for (const sessionId of uniqueSessionIds) {
        this.exclusive.delete(sessionId);
      }
      this.activeMaintenance--;
      if (this.activeMaintenance === 0) {
        this.maintenanceDrain?.resolve();
        this.maintenanceDrain = void 0;
      }
    }
  }
  async runExclusiveAfterShared(rawSessionId, fn) {
    if (this.maintenanceSealed) {
      throw new DaemonDrainingError();
    }
    const sessionId = normalizeSessionIdForLookup(rawSessionId);
    this.assertNotTransitioning(sessionId);
    this.exclusive.add(sessionId);
    this.activeMaintenance++;
    try {
      const sharedCount = this.shared.get(sessionId) ?? 0;
      if (sharedCount > 0) {
        let drain = this.sharedDrains.get(sessionId);
        if (!drain) {
          let resolve;
          const promise = new Promise((done) => {
            resolve = done;
          });
          drain = { promise, resolve };
          this.sharedDrains.set(sessionId, drain);
        }
        await drain.promise;
      }
      return await fn();
    } finally {
      this.sharedDrains.delete(sessionId);
      this.exclusive.delete(sessionId);
      this.activeMaintenance--;
      if (this.activeMaintenance === 0) {
        this.maintenanceDrain?.resolve();
        this.maintenanceDrain = void 0;
      }
    }
  }
  sealMaintenanceAndWait() {
    this.maintenanceSealed = true;
    if (this.activeMaintenance === 0) {
      return Promise.resolve();
    }
    if (!this.maintenanceDrain) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      this.maintenanceDrain = { promise, resolve };
    }
    return this.maintenanceDrain.promise;
  }
  async runSharedMany(sessionIds, fn) {
    if (this.maintenanceSealed) {
      throw new DaemonDrainingError();
    }
    const uniqueSessionIds = [
      ...new Set(sessionIds.map(normalizeSessionIdForLookup))
    ];
    for (const sessionId of uniqueSessionIds) {
      this.assertNotTransitioning(sessionId);
    }
    for (const sessionId of uniqueSessionIds) {
      this.shared.set(sessionId, (this.shared.get(sessionId) ?? 0) + 1);
    }
    this.activeMaintenance++;
    try {
      return await fn();
    } finally {
      for (const sessionId of uniqueSessionIds) {
        const count = (this.shared.get(sessionId) ?? 1) - 1;
        if (count <= 0) {
          this.shared.delete(sessionId);
          this.sharedDrains.get(sessionId)?.resolve();
          this.sharedDrains.delete(sessionId);
        } else {
          this.shared.set(sessionId, count);
        }
      }
      this.activeMaintenance--;
      if (this.activeMaintenance === 0) {
        this.maintenanceDrain?.resolve();
        this.maintenanceDrain = void 0;
      }
    }
  }
};
async function runWithDaemonWriterLease(params) {
  const {
    action,
    sessionId,
    service,
    mutate,
    mutationAppliedAfterError,
    afterMutationApplied
  } = params;
  let lease;
  try {
    const leaseOptions = {
      processKind: "daemon",
      reclaimPolicy: "never",
      takeoverPolicy: "certified"
    };
    try {
      lease = await service.acquireSessionWriterLease(sessionId, leaseOptions);
    } catch (error) {
      if (!(error instanceof SessionWriterUnavailableError) && !(error instanceof SessionTranscriptChangedError)) {
        throw error;
      }
      lease = await service.acquireSessionMaintenanceLease(
        sessionId,
        leaseOptions
      );
    }
  } catch (error) {
    return { mutationApplied: false, error };
  }
  let value;
  let mutationApplied = false;
  let mutationError;
  try {
    const mutation = await mutate(
      () => lease.assertOwnedAndUnchanged(),
      () => lease.assertCleanupOwned()
    );
    value = mutation.value;
    mutationApplied = mutation.mutationApplied;
  } catch (error) {
    mutationError = error;
    try {
      mutationApplied = await mutationAppliedAfterError();
    } catch {
      mutationApplied = false;
    }
  }
  let maintenanceError;
  if (mutationApplied) {
    try {
      await afterMutationApplied();
    } catch (error) {
      maintenanceError = error;
      logSessionArchiveWarning(
        `scheduled task lifecycle update failed action=${action} workspace=${safeLogValue(
          service.getProjectRoot()
        )} session=${safeLogValue(sessionId)} error=${safeLogValue(
          errorMessage(error)
        )}`
      );
    }
  }
  let releaseError;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (releaseError !== void 0) {
    logMaintenanceLeaseReleaseFailure({
      action,
      workspace: service.getProjectRoot(),
      sessionId,
      error: releaseError,
      mutationApplied
    });
    if (mutationError !== void 0) {
      logSessionArchiveWarning(
        `session maintenance mutation also failed action=${action} workspace=${safeLogValue(
          service.getProjectRoot()
        )} session=${safeLogValue(sessionId)} error=${safeLogValue(
          errorMessage(mutationError)
        )}`
      );
    }
    return { mutationApplied, error: releaseError, maintenanceError };
  }
  if (mutationError !== void 0) {
    return { mutationApplied, error: mutationError, maintenanceError };
  }
  return { value, mutationApplied, maintenanceError };
}
__name(runWithDaemonWriterLease, "runWithDaemonWriterLease");
function logMaintenanceLeaseReleaseFailure(params) {
  const errorKind = typeof params.error === "object" && params.error !== null && typeof params.error.errorKind === "string" ? params.error.errorKind : "unknown";
  logSessionArchiveWarning(
    `session maintenance lease release failed action=${params.action} workspace=${safeLogValue(
      params.workspace
    )} session=${safeLogValue(params.sessionId)} errorKind=${safeLogValue(
      errorKind
    )} mutationApplied=${params.mutationApplied}`
  );
}
__name(logMaintenanceLeaseReleaseFailure, "logMaintenanceLeaseReleaseFailure");
async function classifySessionLocation(service, sessionId) {
  return service.getMaintainableSessionLocation(sessionId);
}
__name(classifySessionLocation, "classifySessionLocation");
function sessionLocationError(sessionId) {
  const error = new SessionConflictError(sessionId);
  error.message = `Session "${sessionId}" exists in both active and archived directories. Retry with resolveConflicts: true to keep one copy.`;
  return error;
}
__name(sessionLocationError, "sessionLocationError");
function updateScheduledTaskForMaintenance(service, sessionId, action, assertCanMutate) {
  if (action === "archive") {
    return disableTasksForSessions(service.getProjectRoot(), [sessionId], {
      assertCanCommit: assertCanMutate
    });
  }
  if (action === "unarchive") {
    return enableTasksForSessions(
      service.getProjectRoot(),
      [sessionId],
      Date.now(),
      { assertCanCommit: assertCanMutate }
    );
  }
  return removeTasksForSessions(service.getProjectRoot(), [sessionId], {
    assertCanCommit: assertCanMutate
  });
}
__name(updateScheduledTaskForMaintenance, "updateScheduledTaskForMaintenance");
async function deletePersistedSessionWithLease(service, sessionId, assertCanMutate) {
  const initialLocation = await classifySessionLocation(service, sessionId);
  if (initialLocation === void 0) {
    let maintenanceError;
    try {
      assertCanMutate?.();
      await updateScheduledTaskForMaintenance(
        service,
        sessionId,
        "delete",
        assertCanMutate
      );
    } catch (error) {
      maintenanceError = error;
      logSessionArchiveWarning(
        `scheduled task lifecycle update failed action=delete workspace=${safeLogValue(
          service.getProjectRoot()
        )} session=${safeLogValue(sessionId)} error=${safeLogValue(
          errorMessage(error)
        )}`
      );
    }
    return {
      kind: "notFound",
      mutationApplied: false,
      maintenanceError
    };
  }
  const mutation = await runWithDaemonWriterLease({
    action: "delete",
    sessionId,
    service,
    mutate: /* @__PURE__ */ __name(async (assertOwnedAndUnchanged, assertCleanupOwned) => {
      const lockedLocation = await classifySessionLocation(service, sessionId);
      if (lockedLocation === void 0) {
        return {
          value: "notFound",
          mutationApplied: false
        };
      }
      const removed = await service.removeSession(sessionId, {
        assertStorageUnchanged: assertOwnedAndUnchanged,
        assertCanMutate,
        assertCleanupOwned
      });
      return {
        value: removed ? "removed" : "notFound",
        mutationApplied: removed
      };
    }, "mutate"),
    mutationAppliedAfterError: /* @__PURE__ */ __name(async () => await classifySessionLocation(service, sessionId) === void 0, "mutationAppliedAfterError"),
    afterMutationApplied: /* @__PURE__ */ __name(async () => {
      assertCanMutate?.();
      await updateScheduledTaskForMaintenance(
        service,
        sessionId,
        "delete",
        assertCanMutate
      );
    }, "afterMutationApplied")
  });
  if (mutation.error !== void 0) {
    return {
      kind: "error",
      error: mutation.error,
      mutationApplied: mutation.mutationApplied,
      maintenanceError: mutation.maintenanceError
    };
  }
  return {
    kind: mutation.value ?? "notFound",
    mutationApplied: mutation.mutationApplied,
    maintenanceError: mutation.maintenanceError
  };
}
__name(deletePersistedSessionWithLease, "deletePersistedSessionWithLease");
async function deleteDaemonSessions(params) {
  const {
    sessionIds,
    service,
    bridge,
    coordinator,
    coordinatorLockHeld = false,
    assertCanMutate,
    runtimeWorkspaceCwd,
    onError
  } = params;
  const uniqueSessionIds = [
    ...new Set(sessionIds.map(normalizeSessionIdForLookup))
  ];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const runWithWorktreeCleanup = /* @__PURE__ */ __name(async (sessionId, mutateSession) => {
    const activeSidecarPath = service.getWorktreeSessionPath(sessionId);
    const archivedSidecarPath = service.getWorktreeSessionPathForArchiveState(
      sessionId,
      "archived"
    );
    if (!fs2.existsSync(activeSidecarPath) && (archivedSidecarPath === activeSidecarPath || !fs2.existsSync(archivedSidecarPath))) {
      return coordinator.runExclusiveMany([sessionId], mutateSession);
    }
    const cleanupPlan = await preclassifyWorktreeCleanup(
      service,
      sessionId,
      runtimeWorkspaceCwd
    );
    if (!cleanupPlan) {
      return coordinator.runExclusiveMany([sessionId], mutateSession);
    }
    const releaseCleanupLock = await acquireWorktreeCleanupLock(cleanupPlan);
    try {
      const ownership = await verifyWorktreeCleanupOwnership(cleanupPlan);
      if (!ownership.ok) {
        logWorktreeCleanupPreserve(sessionId, ownership.reason);
      }
      const result = await coordinator.runExclusiveMany(
        [sessionId],
        mutateSession
      );
      if (ownership.ok && result.kind === "removed") {
        try {
          assertCanMutate?.();
          await executeWorktreeCleanup(cleanupPlan);
        } catch (error) {
          logWorktreeCleanupPreserve(
            sessionId,
            `cleanup execution failed: ${errorMessage(error)}`
          );
        }
      }
      return result;
    } finally {
      releaseCleanupLock();
    }
  }, "runWithWorktreeCleanup");
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = /* @__PURE__ */ __name(async () => {
          assertCanMutate?.();
          const removePersistedSession = /* @__PURE__ */ __name(async () => {
            const result = await deletePersistedSessionWithLease(
              service,
              sessionId,
              assertCanMutate
            );
            if (result.kind === "error") {
              onError?.({
                phase: "remove",
                sessionId,
                error: errorMessage(result.error)
              });
              return result;
            }
            try {
              if (assertCanMutate) {
                await bridge.deleteSessionAttachments(sessionId, {
                  assertCanCommit: assertCanMutate
                });
              } else {
                await bridge.deleteSessionAttachments(sessionId);
              }
              return result;
            } catch (error) {
              onError?.({
                phase: "delete",
                sessionId,
                error: errorMessage(error)
              });
              return {
                kind: "error",
                error,
                mutationApplied: result.mutationApplied,
                maintenanceError: result.maintenanceError
              };
            }
          }, "removePersistedSession");
          try {
            await bridge.closeSession(sessionId);
          } catch (error) {
            if (isSessionNotFoundError(error) && error.code !== "session_closing") {
              return await removePersistedSession();
            }
            onError?.({
              phase: "close",
              sessionId,
              error: errorMessage(error)
            });
            return {
              kind: "error",
              error,
              mutationApplied: false
            };
          }
          return await removePersistedSession();
        }, "mutateSession");
        return await (coordinatorLockHeld ? mutateSession() : runWithWorktreeCleanup(sessionId, mutateSession));
      } catch (error) {
        if (error instanceof DaemonDrainingError) {
          throw error;
        }
        onError?.({
          phase: "delete",
          sessionId,
          error: errorMessage(error)
        });
        return {
          kind: "error",
          error,
          mutationApplied: false
        };
      }
    })
  );
  const removed = [];
  const notFound = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i];
    const result = results[i];
    if (result.kind === "removed") {
      removed.push(sessionId);
    } else if (result.kind === "notFound") {
      notFound.push(sessionId);
    } else {
      errors.push({ sessionId, error: errorMessage(result.error) });
    }
    if (result.maintenanceError !== void 0) {
      errors.push({
        sessionId,
        error: "Scheduled task lifecycle update failed."
      });
    }
  }
  return { removed, notFound, errors };
}
__name(deleteDaemonSessions, "deleteDaemonSessions");
async function deleteDaemonSessionIfOrphan(params) {
  const { sessionId, service, bridge, coordinator } = params;
  coordinator.assertNotTransitioning(sessionId);
  const result = await coordinator.runExclusiveMany([sessionId], async () => {
    let killed = false;
    try {
      killed = await bridge.killSession(sessionId, {
        requireZeroAttaches: true
      });
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
      killed = true;
    }
    if (!killed) {
      try {
        bridge.getSessionSummary(sessionId);
        return void 0;
      } catch (error) {
        if (!isSessionNotFoundError(error)) throw error;
      }
    }
    const removal = await deletePersistedSessionWithLease(service, sessionId);
    if (removal.kind !== "error") {
      await bridge.deleteSessionAttachments(sessionId);
    }
    return removal;
  });
  if (result === void 0) {
    return false;
  }
  if (result.kind === "error") {
    throw result.error;
  }
  bridge.markSessionCatalogChanged();
  return true;
}
__name(deleteDaemonSessionIfOrphan, "deleteDaemonSessionIfOrphan");
async function assertSessionLoadable(workspaceCwd, sessionId, runtimeBaseDir, options = {}) {
  const service = new SessionService(workspaceCwd, {
    runtimeBaseDir
  });
  const location = await service.getSessionLocation(sessionId);
  if (location === "archived") {
    throw new SessionArchivedError(sessionId);
  }
  if (location === "conflict") {
    if (options.allowActiveConflict) {
      try {
        await service.findSessionIdIgnoringCase(sessionId);
      } catch (error) {
        if (error instanceof SessionIdCaseConflictError && error.reason === "case_conflict" && error.candidateSessionId === sessionId) {
          return "active";
        }
        if (!(error instanceof SessionIdCaseConflictError)) throw error;
      }
    }
    throw new SessionConflictError(sessionId);
  }
  return location;
}
__name(assertSessionLoadable, "assertSessionLoadable");
async function resolveSessionIdForRestore(service, sessionId) {
  try {
    return await service.findSessionIdIgnoringCase(sessionId);
  } catch (error) {
    if (error instanceof SessionIdCaseConflictError) {
      if (error.candidateSessionId === sessionId) return sessionId;
      throw new SessionConflictError(sessionId);
    }
    throw error;
  }
}
__name(resolveSessionIdForRestore, "resolveSessionIdForRestore");
async function assertSessionRestorable(workspaceCwd, sessionId, requestedSessionId, runtimeBaseDir) {
  const location = await new SessionService(workspaceCwd, {
    runtimeBaseDir
  }).getSessionLocation(sessionId);
  if (location === "archived") {
    throw new SessionArchivedError(sessionId);
  }
  if (location === "conflict") {
    if (sessionId !== requestedSessionId) {
      throw new SessionConflictError(requestedSessionId);
    }
    return "active";
  }
  return location;
}
__name(assertSessionRestorable, "assertSessionRestorable");
async function assertSessionArchived(workspaceCwd, sessionId, runtimeBaseDir) {
  const location = await new SessionService(workspaceCwd, {
    runtimeBaseDir
  }).getSessionLocation(sessionId);
  if (location === "active") {
    throw new SessionNotArchivedError(sessionId);
  }
  if (location === "conflict") {
    throw new SessionConflictError(sessionId);
  }
  if (location === void 0) {
    throw new SessionNotFoundError(sessionId);
  }
}
__name(assertSessionArchived, "assertSessionArchived");
function isSessionNotFoundError(err) {
  return err instanceof SessionNotFoundError || err instanceof Error && err.name === "SessionNotFoundError";
}
__name(isSessionNotFoundError, "isSessionNotFoundError");
function logSessionArchiveResult(action, result) {
  const changedLabel = action === "archive" ? "archived" : "unarchived";
  const alreadyLabel = action === "archive" ? "alreadyArchived" : "alreadyActive";
  const details = [
    `requested=${result.requested.length} requestedIds=${formatSessionIds(result.requested)}`,
    `${changedLabel}=${result.changed.length} ${changedLabel}Ids=${formatSessionIds(result.changed)}`,
    `${alreadyLabel}=${result.already.length} ${alreadyLabel}Ids=${formatSessionIds(result.already)}`,
    `notFound=${result.notFound.length} notFoundIds=${formatSessionIds(result.notFound)}`,
    `errors=${result.errors.length} errorIds=${formatSessionErrors(result.errors)}`
  ].join(" ");
  writeStderrLine(`qwen serve: sessions ${action} result ${details}`);
}
__name(logSessionArchiveResult, "logSessionArchiveResult");
function formatSessionIds(sessionIds) {
  return `[${sessionIds.map((sessionId) => safeLogValue(sessionId)).join(",")}]`;
}
__name(formatSessionIds, "formatSessionIds");
function formatSessionErrors(errors) {
  return `[${errors.map(
    ({ sessionId, error }) => `${safeLogValue(sessionId)}:${safeLogValue(errorMessage(error))}`
  ).join(",")}]`;
}
__name(formatSessionErrors, "formatSessionErrors");
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(errorMessage, "errorMessage");
function logSessionArchiveWarning(message) {
  writeStderrLine(`qwen serve: ${sanitizeLogLine(message)}`);
}
__name(logSessionArchiveWarning, "logSessionArchiveWarning");
var LOG_LINE_UNSAFE_RE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
function sanitizeLogLine(message) {
  return message.replace(LOG_LINE_UNSAFE_RE, " ").slice(0, 4096);
}
__name(sanitizeLogLine, "sanitizeLogLine");
async function archiveDaemonSessions(params) {
  const {
    sessionIds,
    service,
    bridge,
    coordinator,
    coordinatorLockHeld = false,
    resolveConflicts = false,
    assertCanMutate
  } = params;
  const uniqueSessionIds = [
    ...new Set(sessionIds.map(normalizeSessionIdForLookup))
  ];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = /* @__PURE__ */ __name(async () => {
          assertCanMutate?.();
          try {
            await bridge.closeSession(sessionId, void 0, {
              requireAgentClose: true
            });
          } catch (error) {
            if (!isSessionNotFoundError(error)) {
              return {
                kind: "error",
                error,
                mutationApplied: false
              };
            }
          }
          const initialLocation = await classifySessionLocation(
            service,
            sessionId
          );
          if (initialLocation === void 0) {
            return { kind: "notFound", mutationApplied: false };
          }
          if (initialLocation === "conflict" && !resolveConflicts) {
            return {
              kind: "error",
              error: sessionLocationError(sessionId),
              mutationApplied: false
            };
          }
          const mutation = await runWithDaemonWriterLease({
            action: "archive",
            sessionId,
            service,
            mutate: /* @__PURE__ */ __name(async (assertOwnedAndUnchanged, assertCleanupOwned) => {
              const lockedLocation = await classifySessionLocation(
                service,
                sessionId
              );
              if (lockedLocation === void 0) {
                return {
                  value: "notFound",
                  mutationApplied: false
                };
              }
              if (lockedLocation === "conflict" && !resolveConflicts) {
                throw sessionLocationError(sessionId);
              }
              const result = await service.archiveSessions([sessionId], {
                resolveConflicts,
                assertStorageUnchanged: assertOwnedAndUnchanged,
                assertCanMutate,
                assertCleanupOwned
              });
              if (result.errors[0]) throw result.errors[0].error;
              if (result.archived.length > 0) {
                return {
                  value: result.resolvedConflicts.length ? "resolvedConflict" : "archived",
                  mutationApplied: true
                };
              }
              return {
                value: result.alreadyArchived.length > 0 ? "alreadyArchived" : "notFound",
                mutationApplied: false
              };
            }, "mutate"),
            mutationAppliedAfterError: /* @__PURE__ */ __name(async () => await classifySessionLocation(service, sessionId) === "archived", "mutationAppliedAfterError"),
            afterMutationApplied: /* @__PURE__ */ __name(async () => {
              assertCanMutate?.();
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                "archive",
                assertCanMutate
              );
            }, "afterMutationApplied")
          });
          if (mutation.error !== void 0) {
            return {
              kind: "error",
              error: mutation.error,
              mutationApplied: mutation.mutationApplied,
              maintenanceError: mutation.maintenanceError
            };
          }
          let maintenanceError = mutation.maintenanceError;
          if (mutation.value === "alreadyArchived") {
            try {
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                "archive",
                assertCanMutate
              );
            } catch (error) {
              maintenanceError = error;
              logSessionArchiveWarning(
                `scheduled task lifecycle update failed action=archive workspace=${safeLogValue(
                  service.getProjectRoot()
                )} session=${safeLogValue(sessionId)} error=${safeLogValue(
                  errorMessage(error)
                )}`
              );
            }
          }
          return {
            kind: mutation.value ?? "notFound",
            mutationApplied: mutation.mutationApplied,
            maintenanceError
          };
        }, "mutateSession");
        return await (coordinatorLockHeld ? mutateSession() : coordinator.runExclusiveMany([sessionId], mutateSession));
      } catch (error) {
        if (error instanceof DaemonDrainingError) {
          throw error;
        }
        return {
          kind: "error",
          error,
          mutationApplied: false,
          maintenanceError: void 0
        };
      }
    })
  );
  const archived = [];
  const alreadyArchived = [];
  const resolvedConflicts = [];
  const notFound = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i];
    const result = results[i];
    if (result.kind === "archived") archived.push(sessionId);
    else if (result.kind === "resolvedConflict") {
      archived.push(sessionId);
      resolvedConflicts.push(sessionId);
    } else if (result.kind === "alreadyArchived") {
      alreadyArchived.push(sessionId);
    } else if (result.kind === "notFound") notFound.push(sessionId);
    else errors.push({ sessionId, error: result.error });
    if ("maintenanceError" in result && result.maintenanceError !== void 0) {
      errors.push({ sessionId, error: result.maintenanceError });
    }
  }
  logSessionArchiveResult("archive", {
    requested: uniqueSessionIds,
    changed: archived,
    already: alreadyArchived,
    notFound,
    errors
  });
  return {
    archived,
    alreadyArchived,
    resolvedConflicts,
    notFound,
    errors
  };
}
__name(archiveDaemonSessions, "archiveDaemonSessions");
async function unarchiveDaemonSessions(params) {
  const {
    sessionIds,
    service,
    coordinator,
    coordinatorLockHeld = false,
    resolveConflicts = false,
    assertCanMutate
  } = params;
  const uniqueSessionIds = [
    ...new Set(sessionIds.map(normalizeSessionIdForLookup))
  ];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = /* @__PURE__ */ __name(async () => {
          assertCanMutate?.();
          const initialLocation = await classifySessionLocation(
            service,
            sessionId
          );
          if (initialLocation === void 0) {
            return { kind: "notFound", mutationApplied: false };
          }
          if (initialLocation === "conflict" && !resolveConflicts) {
            return {
              kind: "error",
              error: sessionLocationError(sessionId),
              mutationApplied: false
            };
          }
          const mutation = await runWithDaemonWriterLease({
            action: "unarchive",
            sessionId,
            service,
            mutate: /* @__PURE__ */ __name(async (assertOwnedAndUnchanged, assertCleanupOwned) => {
              const lockedLocation = await classifySessionLocation(
                service,
                sessionId
              );
              if (lockedLocation === void 0) {
                return {
                  value: "notFound",
                  mutationApplied: false
                };
              }
              if (lockedLocation === "conflict" && !resolveConflicts) {
                throw sessionLocationError(sessionId);
              }
              const result = await service.unarchiveSessions([sessionId], {
                resolveConflicts,
                assertStorageUnchanged: assertOwnedAndUnchanged,
                assertCanMutate,
                assertCleanupOwned
              });
              if (result.errors[0]) throw result.errors[0].error;
              if (result.unarchived.length > 0) {
                return {
                  value: result.resolvedConflicts.length ? "resolvedConflict" : "unarchived",
                  mutationApplied: true
                };
              }
              return {
                value: result.alreadyActive.length > 0 ? "alreadyActive" : "notFound",
                mutationApplied: false
              };
            }, "mutate"),
            mutationAppliedAfterError: /* @__PURE__ */ __name(async () => await classifySessionLocation(service, sessionId) === "active", "mutationAppliedAfterError"),
            afterMutationApplied: /* @__PURE__ */ __name(async () => {
              assertCanMutate?.();
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                "unarchive",
                assertCanMutate
              );
            }, "afterMutationApplied")
          });
          if (mutation.error !== void 0) {
            return {
              kind: "error",
              error: mutation.error,
              mutationApplied: mutation.mutationApplied,
              maintenanceError: mutation.maintenanceError
            };
          }
          let maintenanceError = mutation.maintenanceError;
          if (mutation.value === "alreadyActive") {
            try {
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                "unarchive",
                assertCanMutate
              );
            } catch (error) {
              maintenanceError = error;
              logSessionArchiveWarning(
                `scheduled task lifecycle update failed action=unarchive workspace=${safeLogValue(
                  service.getProjectRoot()
                )} session=${safeLogValue(sessionId)} error=${safeLogValue(
                  errorMessage(error)
                )}`
              );
            }
          }
          return {
            kind: mutation.value ?? "notFound",
            mutationApplied: mutation.mutationApplied,
            maintenanceError
          };
        }, "mutateSession");
        return await (coordinatorLockHeld ? mutateSession() : coordinator.runExclusiveMany([sessionId], mutateSession));
      } catch (error) {
        if (error instanceof DaemonDrainingError) {
          throw error;
        }
        return {
          kind: "error",
          error,
          mutationApplied: false,
          maintenanceError: void 0
        };
      }
    })
  );
  const unarchived = [];
  const alreadyActive = [];
  const resolvedConflicts = [];
  const notFound = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i];
    const result = results[i];
    if (result.kind === "unarchived") unarchived.push(sessionId);
    else if (result.kind === "resolvedConflict") {
      unarchived.push(sessionId);
      resolvedConflicts.push(sessionId);
    } else if (result.kind === "alreadyActive") alreadyActive.push(sessionId);
    else if (result.kind === "notFound") notFound.push(sessionId);
    else errors.push({ sessionId, error: result.error });
    if (result.maintenanceError !== void 0) {
      errors.push({ sessionId, error: result.maintenanceError });
    }
  }
  logSessionArchiveResult("unarchive", {
    requested: uniqueSessionIds,
    changed: unarchived,
    already: alreadyActive,
    notFound,
    errors
  });
  return {
    unarchived,
    alreadyActive,
    resolvedConflicts,
    notFound,
    errors
  };
}
__name(unarchiveDaemonSessions, "unarchiveDaemonSessions");

// packages/cli/src/serve/server/aone-mrs.ts
init_esbuild_shims();
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
var a1AvailabilityVerified = false;
var defaultA1Exec = /* @__PURE__ */ __name(async (args, options) => {
  const { stdout } = await execFileAsync2("a1", [...args], {
    ...options,
    encoding: "utf8",
    windowsHide: true
    // No env override: a1 authenticates through its own `a1 auth login`
    // config (review precedent); there is no A1_* token convention.
  });
  return { stdout };
}, "defaultA1Exec");
var a1Exec = defaultA1Exec;
var A1_TIMEOUT_MS = 2e4;
var A1_MAX_BUFFER = 16 * 1024 * 1024;
var GIT_ORIGIN_TIMEOUT_MS = 5e3;
var A1_VERSION_TIMEOUT_MS = 1e4;
var A1_ERROR_MESSAGE_MAX = 512;
var AONE_DETAIL_URL_HOST = "code.alibaba-inc.com";
var AONE_MAX_MR_VIEW_CALLS_PER_RUN = 25;
var AoneCliUnavailableError = class extends Error {
  static {
    __name(this, "AoneCliUnavailableError");
  }
};
var AoneCommandError = class extends Error {
  static {
    __name(this, "AoneCommandError");
  }
};
function mapAoneMrState(raw) {
  switch (raw?.toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return "open";
  }
}
__name(mapAoneMrState, "mapAoneMrState");
async function resolveAoneWorkspaceRepo(workspaceCwd, env) {
  const gitRoot = findGitRoot(workspaceCwd);
  if (!gitRoot) return void 0;
  let origin;
  try {
    ({ stdout: origin } = await execFileAsync2(
      "git",
      ["remote", "get-url", "origin"],
      {
        cwd: gitRoot,
        timeout: GIT_ORIGIN_TIMEOUT_MS,
        encoding: "utf8",
        windowsHide: true,
        // Same sanitization as every sibling git spawn in these paths —
        // an inherited GIT_DIR/GIT_CONFIG_* would resolve origin against
        // a different repository despite the cwd.
        env: gitEnv(env)
      }
    ));
  } catch {
    return void 0;
  }
  const identity = parseRemoteUrl(origin.trim());
  if (!identity || !isAoneCanonicalHost(identity.host)) return void 0;
  return { gitRoot, repoPath: identity.groupPath };
}
__name(resolveAoneWorkspaceRepo, "resolveAoneWorkspaceRepo");
function isAoneDetailUrlForRepo(repoPath, number, url) {
  return canonicalSessionPrUrl(url) === canonicalSessionPrUrl(
    `https://${AONE_DETAIL_URL_HOST}/${repoPath}/codereview/${number}`
  );
}
__name(isAoneDetailUrlForRepo, "isAoneDetailUrlForRepo");
function isA1ErrorObject(value) {
  return typeof value === "object" && value !== null && value["schemaVersion"] === "a1.error/v1";
}
__name(isA1ErrorObject, "isA1ErrorObject");
function a1ErrorMessage(error) {
  if (error?.killed === true) {
    return `a1 timed out after ${A1_TIMEOUT_MS / 1e3}s`;
  }
  const stderr = error?.stderr;
  const raw = typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, A1_ERROR_MESSAGE_MAX);
}
__name(a1ErrorMessage, "a1ErrorMessage");
function assertA1Version(stdout) {
  const triple = parseA1Version(stdout);
  const floor = parseA1Version(A1_MIN_VERSION);
  if (triple && floor && !a1VersionAtLeast(triple, floor)) {
    throw new AoneCliUnavailableError(
      `a1 ${A1_MIN_VERSION}+ is required (found ${stdout.trim().split("\n")[0]}); upgrade from https://code.alibaba-inc.com/aone/a1`
    );
  }
}
__name(assertA1Version, "assertA1Version");
async function runA1Json(args) {
  let stdout;
  try {
    ({ stdout } = await a1Exec([...args, "--format", "json"], {
      timeout: A1_TIMEOUT_MS,
      maxBuffer: A1_MAX_BUFFER
    }));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AoneCliUnavailableError(
        "a1 CLI not installed; install it and run `a1 auth login`"
      );
    }
    const errorStdout = error?.stdout;
    if (typeof errorStdout === "string" && errorStdout.trim()) {
      try {
        const parsed2 = JSON.parse(errorStdout);
        if (isA1ErrorObject(parsed2)) {
          throw new AoneCommandError(parsed2.message || "a1 command failed");
        }
      } catch (parseError) {
        if (parseError instanceof AoneCommandError) throw parseError;
      }
    }
    throw new AoneCommandError(a1ErrorMessage(error));
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AoneCommandError("a1 returned non-JSON output");
  }
  if (isA1ErrorObject(parsed)) {
    throw new AoneCommandError(parsed.message || "a1 command failed");
  }
  return parsed;
}
__name(runA1Json, "runA1Json");
async function checkA1Available() {
  if (a1AvailabilityVerified) return;
  let stdout;
  try {
    ({ stdout } = await a1Exec(["--version"], {
      timeout: A1_VERSION_TIMEOUT_MS
    }));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AoneCliUnavailableError(
        "a1 CLI not installed; install it and run `a1 auth login`"
      );
    }
    return;
  }
  assertA1Version(stdout);
  a1AvailabilityVerified = true;
}
__name(checkA1Available, "checkA1Available");
function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
__name(hasControlCharacter, "hasControlCharacter");
function parseAoneMrView(raw, id) {
  const mr = raw !== null && typeof raw === "object" ? raw["mergeRequest"] : void 0;
  if (mr === null || typeof mr !== "object") {
    throw new AoneCommandError("unexpected a1 mr view output");
  }
  const v = mr;
  const url = typeof v["detailUrl"] === "string" ? v["detailUrl"] : "";
  if (!/^https?:\/\//i.test(url)) {
    throw new AoneCommandError("a1 mr view returned no detailUrl");
  }
  if (url.length > SESSION_PR_URL_MAX_LENGTH) {
    throw new AoneCommandError("a1 mr view returned an oversized detailUrl");
  }
  if (hasControlCharacter(url)) {
    throw new AoneCommandError("a1 mr view returned a malformed detailUrl");
  }
  return {
    number: id,
    url,
    state: mapAoneMrState(
      typeof v["state"] === "string" ? v["state"] : void 0
    )
  };
}
__name(parseAoneMrView, "parseAoneMrView");
async function viewAoneMergeRequest(repoPath, id) {
  await checkA1Available();
  const parsed = await runA1Json([
    "repo",
    "mr",
    "view",
    String(id),
    "--repo",
    repoPath
  ]);
  return parseAoneMrView(parsed, id);
}
__name(viewAoneMergeRequest, "viewAoneMergeRequest");
var defaultAoneMrBackend = {
  view: viewAoneMergeRequest
};

export {
  laterActivityTimestamp,
  invalidateWorkspaceSessionListCache,
  InvalidCursorError,
  listWorkspaceSessionsForResponse,
  listLiveWorkspaceSessionsForResponse,
  searchWorkspaceSessionsForResponse,
  getWorkspaceSessionInfoForResponse,
  parseSessionPageSizeQuery,
  runWithWorkspaceRuntimeStorage,
  createWorkspaceRuntimeSessionService,
  acquireWorktreeOwnershipOp,
  DaemonDrainingError,
  SessionArchiveCoordinator,
  deleteDaemonSessions,
  deleteDaemonSessionIfOrphan,
  assertSessionLoadable,
  resolveSessionIdForRestore,
  assertSessionRestorable,
  assertSessionArchived,
  logSessionArchiveWarning,
  archiveDaemonSessions,
  unarchiveDaemonSessions,
  AONE_MAX_MR_VIEW_CALLS_PER_RUN,
  resolveAoneWorkspaceRepo,
  isAoneDetailUrlForRepo,
  defaultAoneMrBackend
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
