// Force strict mode and setup for ESM
"use strict";
import {
  CLIENT_ID_RE,
  MAX_CLIENT_ID_LENGTH
} from "./chunk-LAUEEBDL.js";
import {
  formatHostForAuthority,
  isLoopbackBind
} from "./chunk-DMEUXLSS.js";
import {
  isPreAuthWebShellRequest
} from "./chunk-PXBV45LZ.js";
import {
  isInternalWorkspaceRuntime
} from "./chunk-NYWWQ437.js";
import {
  conversationRuntimeUnavailableError
} from "./chunk-Y5TM7SBV.js";
import {
  MAX_CHILD_HEAP_MB,
  MIN_CHILD_HEAP_MB,
  recommendedChildShareMb
} from "./chunk-LYD3T3H7.js";
import {
  CLIENT_MCP_OVER_WS_CONFIG_FLAG
} from "./chunk-RN6A53UJ.js";
import {
  MAX_REGISTERED_WORKSPACES
} from "./chunk-62ZLCVXZ.js";
import {
  parseToolWriteOriginMeta
} from "./chunk-GELRJXE2.js";
import {
  ROOT_CONTEXT,
  context,
  init_esm
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/auth/device-flow.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var SANITIZE_FOR_STDERR_RE = new RegExp(
  // ASCII C0 (0x00–0x1f), DEL (0x7f), C1 (0x80–0x9f), plus Unicode
  // lookalike controls:
  //   \u200b–\u200f: zero-width chars + LRM/RLM
  //   \u2028–\u2029: LINE / PARAGRAPH SEPARATOR (terminal newline equivalents)
  //   \u202a–\u202e: bidirectional EMBEDDING / OVERRIDE controls
  //   \u2066–\u2069: bidirectional ISOLATE controls (CVE-2021-42574)
  //   \ufeff:         BOM / ZWNBSP
  String.raw`[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]`,
  "g"
);
function sanitizeForStderr(value) {
  return value.replace(SANITIZE_FOR_STDERR_RE, "?");
}
__name(sanitizeForStderr, "sanitizeForStderr");
var DEVICE_FLOW_DEFAULT_INTERVAL_MS = 5e3;
var DEVICE_FLOW_TERMINAL_GRACE_MS = 5 * 6e4;
var DEVICE_FLOW_SWEEP_INTERVAL_MS = 3e4;
var DEVICE_FLOW_MAX_CONCURRENT = 4;
var DEVICE_FLOW_SLOW_DOWN_BUMP_MS = 5e3;
var DEVICE_FLOW_PERSIST_TIMEOUT_MS = 3e4;
var DEVICE_FLOW_START_TIMEOUT_MS = 3e4;
var DEVICE_FLOW_POLL_TIMEOUT_MS = 3e4;
var DEVICE_FLOW_MAX_EXPIRES_IN_SEC = 60 * 60;
var DEVICE_FLOW_MIN_EXPIRES_IN_SEC = 30;
var DEVICE_FLOW_MAX_INTERVAL_MS = 6e4;
var SECRET_BRAND = Symbol("DeviceFlowSecret");
var SECRETS = /* @__PURE__ */ new WeakMap();
function brandSecret(value) {
  const wrapper = Object.freeze({
    [SECRET_BRAND]: true,
    toString: /* @__PURE__ */ __name(() => "[redacted]", "toString"),
    toJSON: /* @__PURE__ */ __name(() => "[redacted]", "toJSON"),
    [Symbol.toPrimitive]: () => "[redacted]"
  });
  SECRETS.set(wrapper, value);
  return wrapper;
}
__name(brandSecret, "brandSecret");
function unsafeRevealSecret(secret) {
  const value = SECRETS.get(secret);
  if (value === void 0) {
    throw new Error(
      "unsafeRevealSecret: argument is not a BrandedSecret (was never registered, or its WeakMap binding was lost via serialization)"
    );
  }
  return value;
}
__name(unsafeRevealSecret, "unsafeRevealSecret");
var UnsupportedDeviceFlowProviderError = class extends Error {
  static {
    __name(this, "UnsupportedDeviceFlowProviderError");
  }
  code = "unsupported_provider";
  constructor(providerId) {
    super(
      `Unsupported device-flow provider (internal: declared but not registered): ${providerId}`
    );
    this.name = "UnsupportedDeviceFlowProviderError";
  }
};
var TooManyActiveDeviceFlowsError = class extends Error {
  static {
    __name(this, "TooManyActiveDeviceFlowsError");
  }
  code = "too_many_active_flows";
  constructor() {
    super(
      `Too many active device-flow attempts. Cancel one of the existing flows or wait for them to expire.`
    );
    this.name = "TooManyActiveDeviceFlowsError";
  }
};
var UpstreamDeviceFlowError = class extends Error {
  static {
    __name(this, "UpstreamDeviceFlowError");
  }
  code = "upstream_error";
  constructor(message) {
    super(message);
    this.name = "UpstreamDeviceFlowError";
  }
};
var DeviceFlowPollTimeoutError = class extends Error {
  static {
    __name(this, "DeviceFlowPollTimeoutError");
  }
  code = "poll_timeout";
  timeoutMs;
  /**
   * Runtime brand the registry sets ONLY on instances it constructed
   * inside its own timer callback. Default `false` for any
   * `new DeviceFlowPollTimeoutError(...)` call from outside the registry
   * — prevents a provider from spoofing the timeout signal.
   */
  _isRegistryTimeout = false;
  constructor(timeoutMs) {
    super(`device-flow poll timeout after ${timeoutMs}ms`);
    this.name = "DeviceFlowPollTimeoutError";
    this.timeoutMs = timeoutMs;
  }
};
function makeRegistryPollTimeoutError(timeoutMs) {
  const err = new DeviceFlowPollTimeoutError(timeoutMs);
  err._isRegistryTimeout = true;
  return err;
}
__name(makeRegistryPollTimeoutError, "makeRegistryPollTimeoutError");
var DEVICE_FLOW_REGISTRY_LOCAL = "deviceFlowRegistry";
function setDeviceFlowRegistry(app, registry) {
  app.locals[DEVICE_FLOW_REGISTRY_LOCAL] = registry;
}
__name(setDeviceFlowRegistry, "setDeviceFlowRegistry");
function getDeviceFlowRegistry(app) {
  return app.locals[DEVICE_FLOW_REGISTRY_LOCAL];
}
__name(getDeviceFlowRegistry, "getDeviceFlowRegistry");
var DeviceFlowRegistry = class {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((ms, cb) => setTimeout(cb, ms));
    this.scheduleInterval = deps.scheduleInterval ?? ((ms, cb) => setInterval(cb, ms));
    this.clearScheduled = deps.clearScheduled ?? ((h) => clearTimeout(h));
    this.clearScheduledInterval = deps.clearScheduledInterval ?? ((h) => clearInterval(h));
    this.sweeperHandle = this.scheduleInterval(
      DEVICE_FLOW_SWEEP_INTERVAL_MS,
      () => this.sweep()
    );
    if (this.sweeperHandle && typeof this.sweeperHandle.unref === "function") {
      this.sweeperHandle.unref();
    }
  }
  static {
    __name(this, "DeviceFlowRegistry");
  }
  byId = /* @__PURE__ */ new Map();
  byProvider = /* @__PURE__ */ new Map();
  /**
   * Coalesces concurrent `start()` calls for the same `providerId`. Two
   * SDK clients posting `POST /workspace/auth/device-flow` in parallel
   * would otherwise both pass the "no existing pending entry" check,
   * each call `provider.start()` (a real IdP round-trip), and one's
   * write to `byProvider` would clobber the other — leaving an orphan
   * `byId` entry with a still-running poll timer that consumes IdP
   * quota for nothing. Mirrors `SharedTokenManager`'s in-flight refresh
   * coalescing pattern.
   */
  inFlightStarts = /* @__PURE__ */ new Map();
  sweeperHandle;
  disposed = false;
  now;
  schedule;
  scheduleInterval;
  clearScheduled;
  clearScheduledInterval;
  /**
   * Start a new device flow OR — under per-provider singleton semantics —
   * return the existing pending entry (`attached: true`). The take-over
   * branch deliberately does NOT re-call `provider.start()`; making the
   * second POST a no-op (rather than a fresh IdP request) is the property
   * that lets a reconnecting SDK pick up an in-flight login without
   * burning IdP quota.
   */
  async start(params) {
    if (this.disposed) {
      throw new Error("DeviceFlowRegistry disposed");
    }
    const provider = this.deps.resolveProvider(params.providerId);
    if (!provider) {
      throw new UnsupportedDeviceFlowProviderError(params.providerId);
    }
    const existing = this.byProvider.get(params.providerId);
    if (existing && existing.status === "pending") {
      this.recordTakeover(existing, params.initiatorClientId);
      return { view: toPublicView(existing), attached: true };
    }
    const inFlight = this.inFlightStarts.get(params.providerId);
    if (inFlight) {
      const result = await inFlight;
      const justCreated = this.byProvider.get(params.providerId);
      if (justCreated) {
        this.recordTakeover(justCreated, params.initiatorClientId);
      }
      return { view: result.view, attached: true };
    }
    if (this.countActive() >= DEVICE_FLOW_MAX_CONCURRENT) {
      throw new TooManyActiveDeviceFlowsError();
    }
    const promise = this.doStart(params, provider);
    this.inFlightStarts.set(params.providerId, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightStarts.get(params.providerId) === promise) {
        this.inFlightStarts.delete(params.providerId);
      }
    }
  }
  async doStart(params, provider) {
    const cancelController = new AbortController();
    let startResult;
    let startTimer;
    try {
      startResult = await new Promise(
        (resolve2, reject) => {
          startTimer = this.schedule(DEVICE_FLOW_START_TIMEOUT_MS, () => {
            try {
              cancelController.abort(new Error("device-flow start timeout"));
            } catch {
            }
            reject(
              new UpstreamDeviceFlowError(
                "device-flow start timeout (upstream IdP unresponsive)"
              )
            );
          });
          provider.start({ signal: cancelController.signal }).then(resolve2, reject);
        }
      );
    } finally {
      if (startTimer !== void 0) this.clearScheduled(startTimer);
    }
    if (this.disposed) {
      throw new Error("DeviceFlowRegistry disposed during start");
    }
    const expiresInSec = Number.isFinite(startResult.expiresIn) && startResult.expiresIn > 0 ? Math.min(
      DEVICE_FLOW_MAX_EXPIRES_IN_SEC,
      Math.max(DEVICE_FLOW_MIN_EXPIRES_IN_SEC, startResult.expiresIn)
    ) : 600;
    const expiresAt = this.now() + expiresInSec * 1e3;
    const intervalSec = Number.isFinite(startResult.interval) && startResult.interval > 0 ? startResult.interval : DEVICE_FLOW_DEFAULT_INTERVAL_MS / 1e3;
    const intervalMs = Math.min(
      DEVICE_FLOW_MAX_INTERVAL_MS,
      Math.max(1e3, intervalSec * 1e3)
    );
    const entry = {
      deviceFlowId: randomUUID(),
      providerId: params.providerId,
      deviceCode: startResult.deviceCode,
      pkceVerifier: startResult.pkceVerifier,
      userCode: startResult.userCode,
      verificationUri: startResult.verificationUri,
      verificationUriComplete: startResult.verificationUriComplete,
      intervalMs,
      expiresAt,
      status: "pending",
      initiatorClientId: params.initiatorClientId,
      createdAt: this.now(),
      cancelController
    };
    this.byId.set(entry.deviceFlowId, entry);
    this.byProvider.set(entry.providerId, entry);
    this.deps.events.publish(
      {
        type: "started",
        data: {
          deviceFlowId: entry.deviceFlowId,
          providerId: entry.providerId,
          expiresAt: entry.expiresAt
        }
      },
      entry.initiatorClientId
    );
    this.deps.audit?.record({
      deviceFlowId: entry.deviceFlowId,
      providerId: entry.providerId,
      clientId: entry.initiatorClientId,
      status: "started",
      expiresInMs: entry.expiresAt - this.now()
    });
    this.schedulePoll(entry, provider);
    return { view: toPublicView(entry), attached: false };
  }
  get(deviceFlowId) {
    const entry = this.byId.get(deviceFlowId);
    if (!entry) return void 0;
    return toPublicView(entry);
  }
  /**
   * Cancel a pending flow. Idempotent on terminal entries (returns
   * `{ alreadyTerminal: true }` and does NOT re-emit `cancelled` —
   * RFC 7231 §4.3.5: DELETE may still be a 204 even when nothing was
   * removed). Returns `undefined` for unknown ids so the route layer
   * can map it to 404.
   */
  cancel(deviceFlowId, cancellerClientId) {
    const entry = this.byId.get(deviceFlowId);
    if (!entry) return void 0;
    if (entry.persistInFlight) {
      entry.cancelRequestedDuringPersist = true;
      if (!entry.cancellerRecorded) {
        entry.cancellerRecorded = true;
        if (cancellerClientId) {
          entry.cancellerClientId = cancellerClientId;
        }
      }
      try {
        entry.cancelController.abort(new Error("cancel during persist"));
      } catch {
      }
      this.deps.audit?.record({
        deviceFlowId: entry.deviceFlowId,
        providerId: entry.providerId,
        clientId: cancellerClientId,
        status: "cancelled",
        hint: "deferred (persist in flight; final state decided by persist resolution)"
      });
      return { alreadyTerminal: false };
    }
    if (!this.transitionTerminal(entry, "cancelled")) {
      return { alreadyTerminal: true };
    }
    this.deps.events.publish(
      {
        type: "cancelled",
        data: { deviceFlowId: entry.deviceFlowId }
      },
      cancellerClientId
    );
    this.deps.audit?.record({
      deviceFlowId: entry.deviceFlowId,
      providerId: entry.providerId,
      clientId: cancellerClientId,
      status: "cancelled"
    });
    return { alreadyTerminal: false };
  }
  /**
   * Active = pending entries already installed in `byProvider` PLUS
   * in-flight starts that haven't yet completed `provider.start()`.
   * Terminal entries in grace don't count toward the cap. Including
   * `inFlightStarts.size` prevents concurrent starts for distinct
   * providers from bypassing the workspace-wide cap.
   */
  countActive() {
    let n = 0;
    for (const entry of this.byProvider.values()) {
      if (entry.status === "pending") n += 1;
    }
    return n + this.inFlightStarts.size;
  }
  schedulePoll(entry, provider) {
    if (entry.status !== "pending") return;
    if (entry.deviceCode === void 0) return;
    if (this.disposed) return;
    entry.pollHandle = this.schedule(entry.intervalMs, () => {
      void this.runPollTick(entry, provider);
    });
    if (entry.pollHandle && typeof entry.pollHandle.unref === "function") {
      entry.pollHandle.unref();
    }
  }
  async runPollTick(entry, provider) {
    if (entry.status !== "pending") return;
    if (this.disposed) return;
    if (entry.deviceCode === void 0) return;
    const now = this.now();
    if (now >= entry.expiresAt) {
      this.expireEntry(entry);
      return;
    }
    entry.lastPolledAt = now;
    let result;
    let rawProviderError;
    let pollTimedOut = false;
    let pollTimer;
    let providerPollPromise;
    try {
      result = await new Promise((resolve2, reject) => {
        pollTimer = this.schedule(DEVICE_FLOW_POLL_TIMEOUT_MS, () => {
          const timeoutError = makeRegistryPollTimeoutError(
            DEVICE_FLOW_POLL_TIMEOUT_MS
          );
          try {
            entry.cancelController.abort(timeoutError);
          } catch {
          }
          reject(timeoutError);
        });
        providerPollPromise = provider.poll(
          {
            deviceCode: entry.deviceCode,
            pkceVerifier: entry.pkceVerifier
          },
          { signal: entry.cancelController.signal }
        );
        providerPollPromise.then(resolve2, reject);
      });
    } catch (err) {
      if (err instanceof DeviceFlowPollTimeoutError && err._isRegistryTimeout === true) {
        pollTimedOut = true;
        result = {
          kind: "error",
          errorKind: "upstream_error",
          hint: `provider.poll() timed out after ${err.timeoutMs}ms; check IdP connectivity`
        };
      } else {
        rawProviderError = err instanceof Error ? err.message : String(err);
        result = {
          kind: "error",
          errorKind: "upstream_error",
          hint: "provider.poll() failed; see daemon audit log for details"
        };
      }
    } finally {
      if (pollTimer !== void 0) this.clearScheduled(pollTimer);
    }
    if (pollTimedOut && providerPollPromise !== void 0) {
      const tracked = providerPollPromise;
      const auditDeviceFlowId = entry.deviceFlowId;
      const auditProviderId = entry.providerId;
      const auditClientId = entry.initiatorClientId;
      const audit = this.deps.audit;
      void tracked.then(
        (latePollResult) => {
          audit?.record({
            deviceFlowId: auditDeviceFlowId,
            providerId: auditProviderId,
            clientId: auditClientId,
            status: "failed",
            errorKind: "upstream_error",
            // Distinguish "real late response" (pending/slow_down/
            // success) from "provider's abort cooperation" (error).
            // `latePollResult.kind` is provider-controlled — sanitize
            // before interpolation to prevent log injection.
            hint: latePollResult.kind === "error" ? `lost_late_poll_after_timeout: provider.poll() resolved kind=error after ${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling \u2014 likely abort-driven cooperation; IdP responsiveness unknown` : `lost_late_poll_after_timeout: provider.poll() resolved kind=${sanitizeForStderr(latePollResult.kind)} after ${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling \u2014 IdP is responsive but slow; consider raising the operator-side IdP latency alert threshold`
          });
        },
        (lateErr) => {
          if (lateErr instanceof DeviceFlowPollTimeoutError && lateErr._isRegistryTimeout === true)
            return;
          const safeDetail = lateErr instanceof Error ? `${sanitizeForStderr(lateErr.name)} (message ${lateErr.message.length} bytes; raw suppressed)` : `<non-Error throw: ${typeof lateErr}>`;
          audit?.record({
            deviceFlowId: auditDeviceFlowId,
            providerId: auditProviderId,
            clientId: auditClientId,
            status: "failed",
            errorKind: "upstream_error",
            hint: `lost_late_poll_after_timeout: provider.poll() rejected after ${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling: ${safeDetail}`
          });
        }
        // Terminal `.catch` so a throw inside either handler doesn't
        // surface as an unhandled rejection (audit is best-effort).
      ).catch(() => {
      });
    }
    if (this.disposed) return;
    if (entry.status !== "pending") return;
    switch (result.kind) {
      case "pending":
        this.schedulePoll(entry, provider);
        return;
      case "slow_down":
        entry.intervalMs = Math.min(
          DEVICE_FLOW_MAX_INTERVAL_MS,
          entry.intervalMs + DEVICE_FLOW_SLOW_DOWN_BUMP_MS
        );
        this.deps.events.publish(
          {
            type: "throttled",
            data: {
              deviceFlowId: entry.deviceFlowId,
              intervalMs: entry.intervalMs
            }
          },
          entry.initiatorClientId
        );
        this.schedulePoll(entry, provider);
        return;
      case "success": {
        let metadata = {};
        let persistError;
        let persistTimer;
        let persistTimedOut = false;
        entry.persistInFlight = true;
        let persistTracker;
        try {
          persistTracker = result.persist({
            signal: entry.cancelController.signal
          });
        } catch (syncErr) {
          persistError = syncErr;
          persistTracker = Promise.reject(syncErr);
          persistTracker.catch(() => {
          });
        }
        persistTracker.then(
          (lateMeta) => {
            if (!persistTimedOut) return;
            this.deps.audit?.record({
              deviceFlowId: entry.deviceFlowId,
              providerId: entry.providerId,
              clientId: entry.initiatorClientId,
              status: "authorized",
              hint: `lost_success_after_timeout (provider.persist ignored timeout signal; credentials on disk but registry already published persist_failed; expiresAt=${lateMeta.expiresAt ?? "unknown"})`
            });
          },
          () => {
          }
        );
        if (persistError === void 0) {
          try {
            metadata = await new Promise((resolve2, reject) => {
              persistTimer = this.schedule(
                DEVICE_FLOW_PERSIST_TIMEOUT_MS,
                () => {
                  persistTimedOut = true;
                  try {
                    entry.cancelController.abort(new Error("persist timeout"));
                  } catch {
                  }
                  reject(new Error("persist timeout"));
                }
              );
              persistTracker.then(resolve2, reject);
            });
          } catch (err) {
            persistError = err;
          } finally {
            if (persistTimer !== void 0) this.clearScheduled(persistTimer);
            entry.persistInFlight = false;
          }
        } else {
          entry.persistInFlight = false;
        }
        if (this.disposed) return;
        const cancelDuringPersist = entry.cancelRequestedDuringPersist === true;
        if (persistError) {
          if (cancelDuringPersist) {
            if (this.transitionTerminal(entry, "cancelled")) {
              this.deps.events.publish(
                {
                  type: "cancelled",
                  data: { deviceFlowId: entry.deviceFlowId }
                },
                entry.cancellerClientId ?? entry.initiatorClientId
              );
            }
          } else if (this.transitionTerminal(entry, "error", "persist_failed")) {
            const pastExpiry = this.now() >= entry.expiresAt;
            this.deps.events.publish(
              {
                type: "failed",
                data: {
                  deviceFlowId: entry.deviceFlowId,
                  errorKind: "persist_failed",
                  hint: "credentials could not be written to the daemon filesystem \u2014 check disk space and permissions"
                }
              },
              entry.initiatorClientId
            );
            this.deps.audit?.record({
              deviceFlowId: entry.deviceFlowId,
              providerId: entry.providerId,
              clientId: entry.initiatorClientId,
              status: "failed",
              errorKind: "persist_failed",
              ...pastExpiry ? {
                hint: "persist_also_failed_past_expiry (root cause is disk I/O; entry was past expiresAt by the time persist resolved)"
              } : {}
            });
          }
          return;
        }
        if (this.transitionTerminal(entry, "authorized")) {
          this.deps.events.publish(
            {
              type: "authorized",
              data: {
                deviceFlowId: entry.deviceFlowId,
                providerId: entry.providerId,
                expiresAt: metadata.expiresAt,
                accountAlias: metadata.accountAlias
              }
            },
            entry.initiatorClientId
          );
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: "authorized",
            ...cancelDuringPersist ? {
              hint: "lost_success_kept (cancel during persist; credentials kept per IdP approval)"
            } : {}
          });
        }
        return;
      }
      case "error":
        entry.hint = result.hint;
        if (this.transitionTerminal(entry, "error", result.errorKind)) {
          this.deps.events.publish(
            {
              type: "failed",
              data: {
                deviceFlowId: entry.deviceFlowId,
                errorKind: result.errorKind,
                hint: result.hint
              }
            },
            entry.initiatorClientId
          );
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: "failed",
            errorKind: result.errorKind,
            // When a provider threw, include the full raw message in
            // the audit hint. When `rawProviderError` is undefined,
            // use the structured `result.hint` so the audit trail
            // matches the SSE event.
            ...rawProviderError !== void 0 ? {
              hint: `provider.poll() threw (raw): ${sanitizeForStderr(rawProviderError)}`
            } : result.hint !== void 0 ? { hint: result.hint } : {}
          });
        }
        return;
      default: {
        const _exhaustive = result;
        void _exhaustive;
      }
    }
  }
  /**
   * Record a take-over: a second SDK client posted for a provider that
   * already has a pending entry. When the caller differs from the
   * entry's initiator, stamp it on `lastOriginatorClientId` and emit
   * an audit breadcrumb. No event publish — the `attached: true` HTTP
   * response is the second caller's signal.
   */
  recordTakeover(entry, takeoverClientId) {
    if (!takeoverClientId) return;
    if (takeoverClientId === entry.initiatorClientId) return;
    if (takeoverClientId === entry.lastOriginatorClientId) return;
    entry.lastOriginatorClientId = takeoverClientId;
    this.deps.audit?.record({
      deviceFlowId: entry.deviceFlowId,
      providerId: entry.providerId,
      clientId: takeoverClientId,
      status: "started",
      hint: `take-over (per-provider singleton; original initiator=${entry.initiatorClientId ?? "(none)"})`
    });
  }
  /**
   * Drive a pending entry to the time-based `expired` terminal.
   * Extracted so the poll-tick and sweeper share a single event shape.
   * No-op if the entry has already transitioned.
   */
  expireEntry(entry) {
    if (!this.transitionTerminal(entry, "expired", "expired_token")) return;
    this.deps.events.publish(
      {
        type: "failed",
        data: {
          deviceFlowId: entry.deviceFlowId,
          errorKind: "expired_token",
          hint: "device-flow expired without authorization"
        }
      },
      entry.initiatorClientId
    );
    this.deps.audit?.record({
      deviceFlowId: entry.deviceFlowId,
      providerId: entry.providerId,
      clientId: entry.initiatorClientId,
      status: "expired",
      errorKind: "expired_token"
    });
  }
  /**
   * Move a pending entry to terminal state. Returns **`true` exactly once**
   * — the call site that successfully drove the transition. Subsequent
   * calls (sweeper × poll-tick race, double cancel, etc.) return `false`
   * so the caller can suppress duplicate event publish + audit log.
   *
   * On a successful transition:
   *   1. clears any pending poll timer
   *   2. wipes the secret material from `entry.deviceCode` /
   *      `entry.pkceVerifier`. The PRIMARY guard against secret leaks
   *      is the `entry.status !== 'pending'` check at the top of
   *      `runPollTick` — a stale timer that managed to fire post-clear
   *      bails out before touching the entry. Secret-clearing here is
   *      DEFENSE IN DEPTH: even if a future refactor weakens the
   *      status guard, the registry's in-memory state can no longer
   *      hand out the upstream `device_code` to a late-arriving
   *      logger / serializer.
   *   3. records `terminalAt` for the sweeper to evict after grace
   *   4. removes the per-provider singleton index so a new POST creates
   *      a fresh flow instead of taking over the terminal one
   */
  transitionTerminal(entry, status, errorKind) {
    if (entry.status !== "pending") return false;
    entry.status = status;
    if (errorKind) entry.errorKind = errorKind;
    entry.terminalAt = this.now();
    if (entry.pollHandle) {
      this.clearScheduled(entry.pollHandle);
      entry.pollHandle = void 0;
    }
    entry.deviceCode = void 0;
    entry.pkceVerifier = void 0;
    try {
      entry.cancelController.abort();
    } catch {
    }
    if (this.byProvider.get(entry.providerId) === entry) {
      this.byProvider.delete(entry.providerId);
    }
    return true;
  }
  /**
   * Periodic sweeper:
   *   (a) pending entries past `expiresAt` get a synthetic timeout event
   *       (the polling loop also handles this on its next tick, but a
   *       wedged poll path should not block expiry)
   *   (b) terminal entries past their grace window get evicted entirely
   */
  sweep() {
    if (this.disposed) return;
    const now = this.now();
    for (const entry of [...this.byId.values()]) {
      if (entry.persistInFlight) continue;
      if (entry.status === "pending" && now >= entry.expiresAt) {
        this.expireEntry(entry);
        continue;
      }
      if (entry.status !== "pending" && entry.terminalAt !== void 0 && now - entry.terminalAt >= DEVICE_FLOW_TERMINAL_GRACE_MS) {
        this.byId.delete(entry.deviceFlowId);
      }
    }
  }
  /**
   * For diagnostics / GET /workspace/auth/status: report only pending
   * flows. Terminal entries are an implementation detail of the SDK
   * reconnect path and shouldn't be enumerated to all authorized status
   * callers.
   */
  listPending() {
    const out = [];
    for (const entry of this.byId.values()) {
      if (entry.status === "pending") out.push(toPublicView(entry));
    }
    return out;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweeperHandle) {
      this.clearScheduledInterval(this.sweeperHandle);
      this.sweeperHandle = void 0;
    }
    for (const entry of this.byId.values()) {
      if (entry.pollHandle) {
        this.clearScheduled(entry.pollHandle);
        entry.pollHandle = void 0;
      }
      try {
        entry.cancelController.abort();
      } catch {
      }
      entry.deviceCode = void 0;
      entry.pkceVerifier = void 0;
    }
    this.byId.clear();
    this.byProvider.clear();
  }
};
function toPublicView(entry) {
  const base = {
    deviceFlowId: entry.deviceFlowId,
    providerId: entry.providerId,
    status: entry.status,
    createdAt: entry.createdAt,
    initiatorClientId: entry.initiatorClientId
  };
  if (entry.errorKind) base.errorKind = entry.errorKind;
  if (entry.hint) base.hint = entry.hint;
  if (entry.lastPolledAt !== void 0) base.lastPolledAt = entry.lastPolledAt;
  if (entry.status === "pending") {
    base.userCode = entry.userCode;
    base.verificationUri = entry.verificationUri;
    base.verificationUriComplete = entry.verificationUriComplete;
    base.expiresAt = entry.expiresAt;
    base.intervalMs = entry.intervalMs;
  }
  return base;
}
__name(toPublicView, "toPublicView");

// packages/cli/src/serve/bridge-file-system-adapter.ts
init_esbuild_shims();
var ACP_WRITE_ROUTE = "ACP writeTextFile";
var ACP_READ_ROUTE = "ACP readTextFile";
function buildAuditContext(params, route) {
  return {
    route,
    ...params.sessionId ? { sessionId: params.sessionId } : {}
  };
}
__name(buildAuditContext, "buildAuditContext");
function createBridgeFileSystemAdapter(factory, options = {}) {
  return {
    async writeText(params) {
      const ctx = buildAuditContext(params, ACP_WRITE_ROUTE);
      if (options.allowSameHostToolWritesOutsideWorkspace === true && parseToolWriteOriginMeta(params._meta) !== void 0 && factory.writeSameHostToolText !== void 0) {
        await factory.writeSameHostToolText(ctx, {
          path: params.path,
          content: params.content,
          ...sanitizeWriteMeta(params._meta)
        });
        return {};
      }
      const wfs = factory.forRequest(ctx);
      const resolved = await wfs.resolve(params.path, "write");
      await wfs.writeTextOverwrite(resolved, params.content);
      return {};
    },
    async readText(params) {
      const wfs = factory.forRequest(buildAuditContext(params, ACP_READ_ROUTE));
      const resolved = await wfs.resolve(params.path, "read");
      const opts = {};
      if (typeof params.line === "number" && params.line > 0) {
        opts.line = params.line;
      }
      if (typeof params.limit === "number" && params.limit > 0) {
        opts.limit = params.limit;
      }
      const { content } = await wfs.readText(resolved, opts);
      return { content };
    }
  };
}
__name(createBridgeFileSystemAdapter, "createBridgeFileSystemAdapter");
function sanitizeWriteMeta(meta) {
  const sanitized = {};
  if (typeof meta?.["bom"] === "boolean") {
    sanitized.bom = meta["bom"];
  }
  if (typeof meta?.["encoding"] === "string") {
    sanitized.encoding = meta["encoding"];
  }
  if (meta?.["lineEnding"] === "lf" || meta?.["lineEnding"] === "crlf") {
    sanitized.lineEnding = meta["lineEnding"];
  }
  return Object.keys(sanitized).length > 0 ? { meta: sanitized } : {};
}
__name(sanitizeWriteMeta, "sanitizeWriteMeta");

// packages/cli/src/serve/fs/path-mutex-registry.ts
init_esbuild_shims();
var PathMutexRegistry = class {
  static {
    __name(this, "PathMutexRegistry");
  }
  tails = /* @__PURE__ */ new Map();
  async runExclusive(key, fn) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve2) => {
      release = resolve2;
    });
    const tail = previous.catch(() => void 0).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => void 0);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
};

// packages/cli/src/serve/health-query.ts
init_esbuild_shims();
function isDeepHealthQuery(raw) {
  return raw === "1" || raw === "true" || raw === "";
}
__name(isDeepHealthQuery, "isDeepHealthQuery");

// packages/cli/src/serve/local-control/credentials.ts
init_esbuild_shims();
import { createHash, timingSafeEqual } from "node:crypto";
var CredentialStore = class {
  static {
    __name(this, "CredentialStore");
  }
  #runtime;
  /** Pairing id → sha256 of the pairing secret. */
  #pairing = /* @__PURE__ */ new Map();
  constructor(runtimeToken) {
    this.#runtime = hashToken(runtimeToken);
  }
  addPairingToken(id, token) {
    this.#pairing.set(id, createHash("sha256").update(token, "utf8").digest());
  }
  revokePairingToken(id) {
    return this.#pairing.delete(id);
  }
  /**
   * Is the gate open — i.e. may an unauthenticated request through?
   *
   * Only ever true on the primary listener of a no-token loopback daemon,
   * preserving today's developer default. The LAN listener is never open: it
   * exists only while a pairing token does, and it must not inherit the
   * "operator chose the surface area" reasoning that governs `--hostname`.
   */
  isOpen(listener) {
    if (listener.kind === "local-control") return false;
    return this.#runtime === void 0;
  }
  /**
   * Constant-time check of a presented credential against those valid for
   * `listener`. Every candidate in scope is compared even after a match so the
   * work is independent of which credential matched — with a handful of
   * pairing tokens the cost is negligible and the timing signal is not worth
   * reasoning about separately.
   */
  verify(credentials, listener) {
    const candidate = createHash("sha256").update(credentials, "utf8").digest();
    let matched = false;
    if (listener.kind === "local-control") {
      for (const expected of this.#pairing.values()) {
        if (equalDigest(candidate, expected)) matched = true;
      }
      return matched;
    }
    return this.#runtime !== void 0 && equalDigest(candidate, this.#runtime);
  }
};
function singleTokenCredentials(token) {
  const expected = hashToken(token);
  return {
    isOpen: /* @__PURE__ */ __name((listener) => expected === void 0 && listener.kind !== "local-control", "isOpen"),
    verify: /* @__PURE__ */ __name((candidate, listener) => {
      if (expected === void 0 || listener.kind === "local-control") {
        return false;
      }
      return equalDigest(
        createHash("sha256").update(candidate, "utf8").digest(),
        expected
      );
    }, "verify")
  };
}
__name(singleTokenCredentials, "singleTokenCredentials");
function hashToken(token) {
  return token === void 0 || token === "" ? void 0 : createHash("sha256").update(token, "utf8").digest();
}
__name(hashToken, "hashToken");
function equalDigest(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}
__name(equalDigest, "equalDigest");

// packages/cli/src/serve/local-control/listener-identity.ts
init_esbuild_shims();
var LISTENER_TAG = Symbol.for("qwen.serve.listenerIdentity");
function tagListener(server, identity) {
  server[LISTENER_TAG] = identity;
}
__name(tagListener, "tagListener");
var PRIMARY = { kind: "primary" };
function fromServer(server) {
  if (!server || typeof server !== "object") return void 0;
  return server[LISTENER_TAG];
}
__name(fromServer, "fromServer");
function listenerIdentityOf(req) {
  const socket = req.socket;
  return fromServer(socket?.server) ?? PRIMARY;
}
__name(listenerIdentityOf, "listenerIdentityOf");
function listenerIdentityOfSocket(socket) {
  const withServer = socket;
  return fromServer(withServer?.server) ?? PRIMARY;
}
__name(listenerIdentityOfSocket, "listenerIdentityOfSocket");

// packages/cli/src/serve/server/access-log.ts
init_esbuild_shims();
init_esm();
import { performance } from "node:perf_hooks";

// packages/cli/src/serve/server/telemetry-context.ts
init_esbuild_shims();
var daemonTelemetryResponseContext = Symbol(
  "daemonTelemetryResponseContext"
);
var daemonInboundTraceIdContext = Symbol(
  "daemonInboundTraceIdContext"
);
function getDaemonTelemetryInboundTraceId(res) {
  try {
    return res[daemonInboundTraceIdContext];
  } catch {
    return void 0;
  }
}
__name(getDaemonTelemetryInboundTraceId, "getDaemonTelemetryInboundTraceId");

// packages/cli/src/serve/server/access-log.ts
var SESSION_ID_RE = /\/session\/([^/]+)/;
var ACCESS_LOG_BURST = 60;
var ACCESS_LOG_REFILL_PER_SECOND = 2;
var ACCESS_LOG_REJECT_BURST = 30;
var ACCESS_LOG_REJECT_REFILL_PER_SECOND = 1;
var ROUTE_MAX_BYTES = 2 * 1024;
var SESSION_ID_MAX_BYTES = 256;
var CLIENT_ID_MAX_BYTES = 256;
var ACCESS_LOG_CONTROLLER_LOCAL = "accessLogController";
var ACCESS_LOG_REJECT_LOCAL = "accessLogPreAuthReject";
function emptySuppressedCounts() {
  return {
    suppressed: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    statusOther: 0
  };
}
__name(emptySuppressedCounts, "emptySuppressedCounts");
function countSuppressed(counts, status) {
  counts.suppressed += 1;
  if (status >= 200 && status < 300) counts.status2xx += 1;
  else if (status >= 300 && status < 400) counts.status3xx += 1;
  else if (status >= 400 && status < 500) counts.status4xx += 1;
  else if (status >= 500 && status < 600) counts.status5xx += 1;
  else counts.statusOther += 1;
}
__name(countSuppressed, "countSuppressed");
function firstRawHeader(rawHeaders, targetName) {
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === targetName) return rawHeaders[i + 1];
  }
  return void 0;
}
__name(firstRawHeader, "firstRawHeader");
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 192) === 128) end -= 1;
  return {
    value: bytes.subarray(0, end).toString("utf8"),
    originalBytes: bytes.length
  };
}
__name(truncateUtf8, "truncateUtf8");
function installAccessLogMiddleware(app, daemonLog, monotonicNow = () => performance.now()) {
  let sealed = false;
  let tokens = ACCESS_LOG_BURST;
  let refillBaseline = monotonicNow();
  let rejectTokens = ACCESS_LOG_REJECT_BURST;
  let rejectRefillBaseline = refillBaseline;
  const suppressed = emptySuppressedCounts();
  const suppressedRejects = emptySuppressedCounts();
  const refill = /* @__PURE__ */ __name(() => {
    const now = Math.max(monotonicNow(), refillBaseline);
    tokens = Math.min(
      ACCESS_LOG_BURST,
      tokens + (now - refillBaseline) / 1e3 * ACCESS_LOG_REFILL_PER_SECOND
    );
    refillBaseline = now;
  }, "refill");
  const refillReject = /* @__PURE__ */ __name(() => {
    const now = Math.max(monotonicNow(), rejectRefillBaseline);
    rejectTokens = Math.min(
      ACCESS_LOG_REJECT_BURST,
      rejectTokens + (now - rejectRefillBaseline) / 1e3 * ACCESS_LOG_REJECT_REFILL_PER_SECOND
    );
    rejectRefillBaseline = now;
  }, "refillReject");
  const flushSuppressed = /* @__PURE__ */ __name((counts) => {
    if (!daemonLog || counts.suppressed === 0) return false;
    context.with(ROOT_CONTEXT, () => {
      daemonLog.warn("access logs suppressed", { ...counts });
    });
    Object.assign(counts, emptySuppressedCounts());
    return true;
  }, "flushSuppressed");
  const controller = {
    sealAndFlushSuppressed: /* @__PURE__ */ __name(() => {
      if (sealed) return;
      sealed = true;
      try {
        flushSuppressed(suppressed);
        flushSuppressed(suppressedRejects);
      } catch {
      }
    }, "sealAndFlushSuppressed")
  };
  app.locals[ACCESS_LOG_CONTROLLER_LOCAL] = controller;
  if (!daemonLog) return controller;
  app.use((req, res, next) => {
    const { method, path: reqPath } = req;
    if (method === "GET" && reqPath === "/health" || method === "POST" && reqPath.endsWith("/heartbeat")) {
      return next();
    }
    const startMs = monotonicNow();
    res.on("finish", () => {
      try {
        if (sealed) return;
        const status = res.statusCode;
        if (method === "GET" && reqPath.endsWith("/events") && status === 200) {
          return;
        }
        refill();
        refillReject();
        const isPreAuthReject = Boolean(
          res.locals?.[ACCESS_LOG_REJECT_LOCAL]
        );
        if (isPreAuthReject) {
          if (suppressedRejects.suppressed > 0 && rejectTokens >= 1) {
            rejectTokens -= 1;
            flushSuppressed(suppressedRejects);
          }
          if (rejectTokens < 1) {
            countSuppressed(suppressedRejects, status);
            return;
          }
          rejectTokens -= 1;
        } else {
          if (suppressed.suppressed > 0 && tokens >= 1) {
            tokens -= 1;
            flushSuppressed(suppressed);
          }
          if (tokens < 1) {
            countSuppressed(suppressed, status);
            return;
          }
          tokens -= 1;
        }
        const route = truncateUtf8(`${method} ${reqPath}`, ROUTE_MAX_BYTES);
        const sessionMatch = reqPath.match(SESSION_ID_RE);
        const sessionId = sessionMatch?.[1] ? truncateUtf8(sessionMatch[1], SESSION_ID_MAX_BYTES) : void 0;
        const rawClientId = firstRawHeader(req.rawHeaders, "x-qwen-client-id");
        const clientId = rawClientId ? truncateUtf8(rawClientId, CLIENT_ID_MAX_BYTES) : void 0;
        const inboundTraceId = getDaemonTelemetryInboundTraceId(res);
        const ctx = {
          route: route.value,
          ...route.originalBytes ? { routeOriginalBytes: route.originalBytes } : {},
          ...sessionId ? {
            sessionId: sessionId.value,
            ...sessionId.originalBytes ? { sessionIdOriginalBytes: sessionId.originalBytes } : {}
          } : {},
          ...clientId ? {
            clientId: clientId.value,
            ...clientId.originalBytes ? { clientIdOriginalBytes: clientId.originalBytes } : {}
          } : {},
          ...inboundTraceId ? { traceId: inboundTraceId } : {},
          status,
          durationMs: Math.max(0, Math.round(monotonicNow() - startMs))
        };
        if (status >= 400) daemonLog.warn("request completed", ctx);
        else daemonLog.info("request completed", ctx);
      } catch {
      }
    });
    next();
  });
  return controller;
}
__name(installAccessLogMiddleware, "installAccessLogMiddleware");

// packages/cli/src/serve/auth.ts
init_esbuild_shims();
function markPreAuthReject(res) {
  (res.locals ??= {})[ACCESS_LOG_REJECT_LOCAL] = true;
}
__name(markPreAuthReject, "markPreAuthReject");
var denyBrowserOriginCors = /* @__PURE__ */ __name((req, res, next) => {
  if (req.headers.origin) {
    res.setHeader("Vary", "Origin");
    markPreAuthReject(res);
    res.status(403).json({ error: "Request denied by CORS policy" });
    return;
  }
  next();
}, "denyBrowserOriginCors");
var InvalidAllowOriginPatternError = class extends Error {
  static {
    __name(this, "InvalidAllowOriginPatternError");
  }
  pattern;
  constructor(pattern, reason) {
    super(
      `Invalid --allow-origin pattern ${JSON.stringify(pattern)}: ${reason}. Expected \`*\` or a URL origin of the form \`<scheme>://<host>[:<port>]\` (no trailing slash, no path, no userinfo, no query).`
    );
    this.name = "InvalidAllowOriginPatternError";
    this.pattern = pattern;
  }
};
function parseAllowOriginPatterns(raw) {
  const origins = /* @__PURE__ */ new Set();
  let allowAny = false;
  for (const entry of raw) {
    if (entry === "*") {
      allowAny = true;
      continue;
    }
    let parsed;
    try {
      parsed = new URL(entry);
    } catch {
      throw new InvalidAllowOriginPatternError(entry, "not a parseable URL");
    }
    const canonical = parsed.origin === "null" ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
    if (canonical !== entry) {
      throw new InvalidAllowOriginPatternError(
        entry,
        `expected the canonical origin ${JSON.stringify(canonical)} without trailing slash, path, userinfo, or query`
      );
    }
    origins.add(canonical.toLowerCase());
  }
  return { allowAny, origins };
}
__name(parseAllowOriginPatterns, "parseAllowOriginPatterns");
function findNonLoopbackHttpOrigin(patterns) {
  for (const origin of patterns.origins) {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !isLoopbackBind(parsed.hostname)) {
      return origin;
    }
  }
  return void 0;
}
__name(findNonLoopbackHttpOrigin, "findNonLoopbackHttpOrigin");
var MutableOriginAllowlist = class {
  static {
    __name(this, "MutableOriginAllowlist");
  }
  #allowAny;
  #static;
  #dynamic = /* @__PURE__ */ new Map();
  constructor(base) {
    this.#allowAny = base.allowAny;
    this.#static = new Set(base.origins);
  }
  allows(origin) {
    if (this.#allowAny) return true;
    const normalized = origin.toLowerCase();
    if (this.#static.has(normalized)) return true;
    for (const value of this.#dynamic.values()) {
      if (value === normalized) return true;
    }
    return false;
  }
  /** Add a runtime origin under `key`; re-adding the same key replaces it. */
  add(key, origin) {
    this.#dynamic.set(key, origin.toLowerCase());
  }
  remove(key) {
    this.#dynamic.delete(key);
  }
};
function toMatcher(patterns) {
  return "allows" in patterns ? patterns : {
    allows: /* @__PURE__ */ __name((origin) => patterns.allowAny || patterns.origins.has(origin.toLowerCase()), "allows")
  };
}
__name(toMatcher, "toMatcher");
function allowOriginCors(patterns) {
  const matcher = toMatcher(patterns);
  const allowedMethods = "GET, POST, PATCH, DELETE, OPTIONS";
  const allowedHeaders = "Authorization, Content-Type, X-Qwen-Client-Id, Last-Event-ID, X-Qwen-Event-Epoch";
  const maxAgeSeconds = "86400";
  const exposedHeaders = "Retry-After, X-Qwen-Event-Epoch, X-Qwen-SSE-Stream-Id";
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (origin === "null") {
      res.setHeader("Vary", "Origin");
      markPreAuthReject(res);
      res.status(403).json({ error: "Request denied by CORS policy" });
      return;
    }
    const matched = matcher.allows(origin);
    if (matched) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", allowedMethods);
      res.setHeader("Access-Control-Allow-Headers", allowedHeaders);
      res.setHeader("Access-Control-Max-Age", maxAgeSeconds);
      res.setHeader("Access-Control-Expose-Headers", exposedHeaders);
      if (req.method === "OPTIONS" && (req.headers["access-control-request-method"] || req.headers["access-control-request-headers"])) {
        res.status(204).end();
        return;
      }
      next();
      return;
    }
    res.setHeader("Vary", "Origin");
    markPreAuthReject(res);
    res.status(403).json({ error: "Request denied by CORS policy" });
  };
}
__name(allowOriginCors, "allowOriginCors");
function hostAllowlist(bind, getPort) {
  const primaryGate = buildPrimaryHostGate(bind, getPort);
  return (req, res, next) => {
    const listener = listenerIdentityOf(req);
    if (listener.kind !== "local-control") {
      primaryGate(req, res, next);
      return;
    }
    const host = (req.headers.host || "").toLowerCase();
    const browserHost = listener.origin === void 0 ? void 0 : new URL(listener.origin).host.toLowerCase();
    if (listener.authority === void 0 || host !== listener.authority && host !== browserHost) {
      markPreAuthReject(res);
      res.status(403).json({ error: "Invalid Host header" });
      return;
    }
    next();
  };
}
__name(hostAllowlist, "hostAllowlist");
function buildPrimaryHostGate(bind, getPort) {
  if (!isLoopbackBind(bind)) {
    return (_req, _res, next) => next();
  }
  let cachedPort = -1;
  let cachedAllowed = /* @__PURE__ */ new Set();
  const boundHost = formatHostForAuthority(bind);
  const allowedFor = /* @__PURE__ */ __name((port) => {
    if (port === cachedPort) return cachedAllowed;
    cachedPort = port;
    cachedAllowed = /* @__PURE__ */ new Set([
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      `host.docker.internal:${port}`,
      `${boundHost}:${port}`
    ]);
    if (port === 80 || port === 443) {
      cachedAllowed.add("localhost");
      cachedAllowed.add("127.0.0.1");
      cachedAllowed.add("[::1]");
      cachedAllowed.add("host.docker.internal");
      cachedAllowed.add(boundHost);
    }
    return cachedAllowed;
  }, "allowedFor");
  return (req, res, next) => {
    const port = getPort();
    const host = (req.headers.host || "").toLowerCase();
    if (!allowedFor(port).has(host)) {
      markPreAuthReject(res);
      res.status(403).json({ error: "Invalid Host header" });
      return;
    }
    next();
  };
}
__name(buildPrimaryHostGate, "buildPrimaryHostGate");
function bearerAuth(source) {
  const credentials = typeof source === "object" && source !== null ? source : singleTokenCredentials(source);
  return (req, res, next) => {
    const listener = listenerIdentityOf(req);
    if (credentials.isOpen(listener)) {
      next();
      return;
    }
    const header = req.headers.authorization;
    if (!header) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const schemeEnd = header.indexOf(" ");
    if (schemeEnd <= 0) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const scheme = header.slice(0, schemeEnd).toLowerCase();
    if (scheme !== "bearer") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    let credStart = schemeEnd + 1;
    while (credStart < header.length && (header.charCodeAt(credStart) === 32 || header.charCodeAt(credStart) === 9)) {
      credStart++;
    }
    const presented = header.slice(credStart);
    if (presented.length === 0) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!credentials.verify(presented, listener)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req[AUTHENTICATED_REQUEST] = true;
    next();
  };
}
__name(bearerAuth, "bearerAuth");
var AUTHENTICATED_REQUEST = Symbol("qwen.serve.authenticatedRequest");
function requestWasAuthenticated(req) {
  return req[AUTHENTICATED_REQUEST] === true;
}
__name(requestWasAuthenticated, "requestWasAuthenticated");
function isTrustedLoopbackMode(input) {
  return input.loopbackBind && !input.tokenConfigured && !input.requireAuth;
}
__name(isTrustedLoopbackMode, "isTrustedLoopbackMode");
function requestHasOperatorAuthority(req, trustedLoopbackMode) {
  return requestWasAuthenticated(req) || trustedLoopbackMode && listenerIdentityOf(req).kind === "primary";
}
__name(requestHasOperatorAuthority, "requestHasOperatorAuthority");
function createMutationGate(deps) {
  const passthrough = /* @__PURE__ */ __name((_req, _res, next) => next(), "passthrough");
  if (deps.tokenConfigured) {
    return () => passthrough;
  }
  const trustedLoopbackMode = deps.trustedLoopbackMode === true && deps.requireAuth === false;
  const strictDenier = /* @__PURE__ */ __name((req, res, next) => {
    if (requestHasOperatorAuthority(req, trustedLoopbackMode)) {
      next();
      return;
    }
    res.status(401).json({
      error: "This route requires the daemon to be configured with a bearer token. Set QWEN_SERVER_TOKEN or pass --token to enable bearer auth.",
      code: "token_required"
    });
  }, "strictDenier");
  return (opts = {}) => opts.strict ? strictDenier : passthrough;
}
__name(createMutationGate, "createMutationGate");

// packages/cli/src/serve/server/self-origin.ts
init_esbuild_shims();
import { TLSSocket } from "node:tls";
function installRemoteSelfOriginMiddleware(app, bind, token) {
  if (isLoopbackBind(bind) || !token) return;
  const authenticate = bearerAuth(token);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host || listenerIdentityOf(req).kind !== "primary") {
      next();
      return;
    }
    const scheme = req.socket instanceof TLSSocket && req.socket.encrypted ? "https" : "http";
    let authority = host.toLowerCase();
    if (scheme === "http" && authority.endsWith(":80"))
      authority = authority.slice(0, -3);
    else if (scheme === "https" && authority.endsWith(":443"))
      authority = authority.slice(0, -4);
    if (origin !== `${scheme}://${authority}`) {
      next();
      return;
    }
    try {
      if (new URL(origin).origin !== origin) {
        next();
        return;
      }
    } catch {
      next();
      return;
    }
    (res.locals ??= {})[ACCESS_LOG_REJECT_LOCAL] = true;
    const allow = /* @__PURE__ */ __name(() => {
      delete res.locals[ACCESS_LOG_REJECT_LOCAL];
      delete req.headers.origin;
      next();
    }, "allow");
    if (isPreAuthWebShellRequest(req)) allow();
    else authenticate(req, res, allow);
  });
}
__name(installRemoteSelfOriginMiddleware, "installRemoteSelfOriginMiddleware");
function installSelfOriginStripMiddleware(app, getPort, bind) {
  let cachedStripPort = -1;
  let cachedSelfOrigins = /* @__PURE__ */ new Set();
  const boundHost = isLoopbackBind(bind) ? formatHostForAuthority(bind) : void 0;
  app.use((req, _res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const port = getPort();
      if (port !== cachedStripPort) {
        cachedStripPort = port;
        cachedSelfOrigins = /* @__PURE__ */ new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          `http://host.docker.internal:${port}`,
          `https://127.0.0.1:${port}`,
          `https://localhost:${port}`,
          `https://[::1]:${port}`,
          `https://host.docker.internal:${port}`
        ]);
        if (boundHost) {
          cachedSelfOrigins.add(`http://${boundHost}:${port}`);
          cachedSelfOrigins.add(`https://${boundHost}:${port}`);
        }
        if (port === 80) {
          for (const host of [
            "127.0.0.1",
            "localhost",
            "[::1]",
            "host.docker.internal"
          ]) {
            cachedSelfOrigins.add(`http://${host}`);
          }
          if (boundHost) {
            cachedSelfOrigins.add(`http://${boundHost}`);
          }
        } else if (port === 443) {
          for (const host of [
            "127.0.0.1",
            "localhost",
            "[::1]",
            "host.docker.internal"
          ]) {
            cachedSelfOrigins.add(`https://${host}`);
          }
          if (boundHost) {
            cachedSelfOrigins.add(`https://${boundHost}`);
          }
        }
      }
      if (cachedSelfOrigins.has(origin)) {
        delete req.headers.origin;
      }
    }
    next();
  });
}
__name(installSelfOriginStripMiddleware, "installSelfOriginStripMiddleware");

// packages/cli/src/serve/acp-child-extra-args.ts
init_esbuild_shims();
function acpChildExtraArgs(opts) {
  const extraArgs = [
    ...opts.experimentalLsp === true ? ["--experimental-lsp"] : [],
    ...opts.restoreAskUserQuestion === true ? ["--restore-ask-user-question"] : []
  ];
  return extraArgs.length > 0 ? extraArgs : void 0;
}
__name(acpChildExtraArgs, "acpChildExtraArgs");

// packages/cli/src/serve/acp-http/client-mcp-sender-registry.ts
init_esbuild_shims();
var ClientMcpSenderRegistry = class {
  static {
    __name(this, "ClientMcpSenderRegistry");
  }
  senders = /* @__PURE__ */ new Map();
  sessionSenders = /* @__PURE__ */ new Map();
  sessionScopedServerNames = /* @__PURE__ */ new Set();
  /**
   * Record a server's WS sender, owned by `owner` (the registering
   * connection's stable client id). Idempotent; last writer wins and takes
   * ownership, so the new owner's `delete` is the one that takes effect.
   */
  set(serverName, sender, owner) {
    this.senders.set(serverName, { sender, owner });
  }
  /**
   * Forget a server's WS sender — but only when `owner` still owns the entry.
   * Idempotent. The ownership guard stops a disconnecting connection from
   * clobbering an entry a later connection re-registered under the same name.
   */
  delete(serverName, owner) {
    if (this.senders.get(serverName)?.owner === owner) {
      this.senders.delete(serverName);
    }
  }
  /** Whether `owner` currently owns the entry for `serverName`. */
  owns(serverName, owner) {
    return this.senders.get(serverName)?.owner === owner;
  }
  setSession(serverName, sessionId, sender, owner, registration) {
    let bySession = this.sessionSenders.get(serverName);
    if (!bySession) {
      bySession = /* @__PURE__ */ new Map();
      this.sessionSenders.set(serverName, bySession);
    }
    bySession.set(sessionId, { sender, owner, registration });
    this.sessionScopedServerNames.add(serverName);
  }
  ownsSession(serverName, sessionId, owner) {
    return this.sessionSenders.get(serverName)?.get(sessionId)?.owner === owner;
  }
  /** Whether any connection currently owns a sender route for the session. */
  hasSession(serverName, sessionId) {
    return this.sessionSenders.get(serverName)?.has(sessionId) === true;
  }
  deleteSession(serverName, sessionId, owner, registration) {
    const bySession = this.sessionSenders.get(serverName);
    const entry = bySession?.get(sessionId);
    if (entry?.owner !== owner) return false;
    if (registration !== void 0 && entry.registration !== registration) {
      return false;
    }
    bySession.delete(sessionId);
    if (bySession.size === 0) {
      this.sessionSenders.delete(serverName);
      this.sessionScopedServerNames.delete(serverName);
    }
    return true;
  }
  /** Currently-registered server names (tests / accounting). */
  serverNames() {
    return [...this.senders.keys()];
  }
  /**
   * The {@link ClientMcpMessageSender} the bridge consumes. Returns a
   * `(payload) => Promise<payload>` bound to the named server, or `undefined`
   * when no client currently hosts it. The bridge passes a `JSONRPCMessage` as
   * `payload`; we keep the public type `unknown` to match the bridge's
   * SDK-free contract.
   */
  lookup = /* @__PURE__ */ __name((serverName) => {
    const entry = this.senders.get(serverName);
    const sessionEntries = this.sessionSenders.get(serverName);
    if (!entry && !sessionEntries) return void 0;
    return (payload, context2) => {
      if (context2?.sessionId) {
        const sessionEntry = sessionEntries?.get(context2.sessionId);
        if (sessionEntry) return sessionEntry.sender(payload);
        if (this.sessionScopedServerNames.has(serverName)) {
          return Promise.reject(
            new Error(
              `No session-scoped MCP sender for '${serverName}' in session '${context2.sessionId}'.`
            )
          );
        }
      }
      if (this.sessionScopedServerNames.has(serverName)) {
        return Promise.reject(
          new Error(
            `Session-scoped MCP server '${serverName}' requires a session context.`
          )
        );
      }
      if (!entry) {
        return Promise.reject(
          new Error(`No client MCP sender for '${serverName}'.`)
        );
      }
      return entry.sender(
        serverName,
        payload
      );
    };
  }, "lookup");
};
async function registerSessionScopedClientMcpServer(registry, bridge, originatorClientId, serverName, sendSdkMcpMessage, sessionId) {
  const registration = {};
  registry.setSession(
    serverName,
    sessionId,
    (payload) => sendSdkMcpMessage(
      serverName,
      payload
    ),
    originatorClientId,
    registration
  );
  try {
    const runtimeConfig = {
      type: "sdk",
      [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true,
      // The user connected this server on purpose, for this session. Left
      // deferred, its tools sit behind tool_search and the agent has to guess
      // their names before it can use the bridge at all. The daemon's
      // chrome-devtools registration sets the same flag for the same reason.
      alwaysLoadTools: true
    };
    const result = await bridge.addSessionRuntimeMcpServer(
      sessionId,
      serverName,
      runtimeConfig,
      originatorClientId
    );
    if (result.skipped) {
      throw new Error(
        `runtime MCP add skipped: ${result.reason ?? "unknown"}`
      );
    }
    if (result.shadowedSettings) {
      throw new Error(
        `client MCP server '${serverName}' conflicts with a configured MCP server`
      );
    }
    if (!registry.ownsSession(serverName, sessionId, originatorClientId)) {
      if (!registry.hasSession(serverName, sessionId)) {
        await bridge.removeSessionRuntimeMcpServer(
          sessionId,
          serverName,
          originatorClientId
        ).catch(() => {
        });
      }
      throw new Error(
        `client MCP registration for '${serverName}' was superseded`
      );
    }
    return { toolCount: result.toolCount };
  } catch (err) {
    if (registry.deleteSession(
      serverName,
      sessionId,
      originatorClientId,
      registration
    )) {
      await bridge.removeSessionRuntimeMcpServer(
        sessionId,
        serverName,
        originatorClientId
      ).catch(() => {
      });
    }
    throw err;
  }
}
__name(registerSessionScopedClientMcpServer, "registerSessionScopedClientMcpServer");
function createClientMcpServerProvider(registry, bridge, originatorClientId) {
  return {
    async registerClientMcpServer(serverName, sendSdkMcpMessage, scope) {
      if (scope?.sessionId !== void 0) {
        return registerSessionScopedClientMcpServer(
          registry,
          bridge,
          originatorClientId,
          serverName,
          sendSdkMcpMessage,
          scope.sessionId
        );
      }
      registry.set(serverName, sendSdkMcpMessage, originatorClientId);
      try {
        const runtimeConfig = {
          // SDK-type so the child binds `SdkControlClientTransport`
          // (`isSdkMcpServerConfig`); the flag tells the child to KEEP the
          // type and bind `sendSdkMcpMessage` to the reverse ext-method.
          type: "sdk",
          [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true
        };
        const result = await bridge.addRuntimeMcpServer(
          serverName,
          runtimeConfig,
          originatorClientId
        );
        if (result.skipped) {
          registry.delete(serverName, originatorClientId);
          throw new Error(
            `runtime MCP add skipped: ${result.reason ?? "unknown"}`
          );
        }
        if (result.shadowedSettings) {
          await bridge.removeRuntimeMcpServer(serverName, originatorClientId).catch(() => {
          });
          throw new Error(
            `client MCP server '${serverName}' conflicts with a configured MCP server`
          );
        }
        return { toolCount: result.toolCount };
      } catch (err) {
        registry.delete(serverName, originatorClientId);
        throw err;
      }
    },
    async unregisterClientMcpServer(serverName, scope) {
      const sessionId = scope?.sessionId;
      if (sessionId !== void 0) {
        if (!registry.deleteSession(serverName, sessionId, originatorClientId)) {
          return;
        }
        await bridge.removeSessionRuntimeMcpServer(
          sessionId,
          serverName,
          originatorClientId
        ).catch(() => {
        });
        return;
      }
      if (!registry.owns(serverName, originatorClientId)) return;
      registry.delete(serverName, originatorClientId);
      await bridge.removeRuntimeMcpServer(serverName, originatorClientId).catch(() => {
      });
    }
  };
}
__name(createClientMcpServerProvider, "createClientMcpServerProvider");

// packages/cli/src/serve/capabilities.ts
init_esbuild_shims();
var SERVE_PROTOCOL_VERSION = "v1";
var SUPPORTED_SERVE_PROTOCOL_VERSIONS = [
  SERVE_PROTOCOL_VERSION
];
var SERVE_CAPABILITY_REGISTRY = {
  health: { since: "v1" },
  daemon_status: { since: "v1" },
  capabilities: { since: "v1" },
  session_create: { since: "v1" },
  session_id_override: { since: "v1" },
  session_scope_override: { since: "v1" },
  session_load: { since: "v1" },
  session_resume: { since: "v1" },
  // Deprecated alias — kept until @agentclientprotocol/sdk graduates
  // the underlying ACP method from unstable_resumeSession to resumeSession.
  unstable_session_resume: { since: "v1" },
  session_list: { since: "v1" },
  // Aggregate persisted session counts via
  // `GET /workspace/:id/session-info` (and the plural
  // `/workspaces/:workspace/session-info` twin). Performs a disk scan of
  // local JSONL files — advertised so clients can discover it, but the
  // response itself marks `expensive: true` / `cost: "disk_scan"` and
  // must not be polled in a tight loop.
  session_info: { since: "v1" },
  session_source_metadata: { since: "v1" },
  session_side_task: { since: "v1" },
  session_prompt: { since: "v1" },
  session_turn_status: { since: "v1" },
  // Prompts and mid-turn messages reference session-scoped image and file
  // attachments by their stored filename.
  session_attachments: { since: "v1" },
  session_attachment_list: { since: "v1" },
  session_mid_turn_message_mutation: { since: "v1" },
  // Daemon-owned reconciliation surface for mid-turn messages:
  // `GET /session/:id/mid-turn-messages` returns the messages still waiting
  // in the queue plus bounded settled/promoted id rings. Clients pre-flight
  // this tag before calling the route; an
  // older daemon without it leaves them on the legacy client-fallback
  // behavior. Client-generated message ids make retries idempotent.
  session_mid_turn_message_query: { since: "v1" },
  session_cancel: { since: "v1" },
  session_events: { since: "v1" },
  session_artifacts: { since: "v1" },
  session_artifacts_persistence: { since: "v1" },
  session_sources: { since: "v1" },
  // Daemon emits `slow_client_warning` synthetic frames at 75% queue
  // fill and honors `?maxQueued=N` (range [16, 2048]) on
  // `GET /session/:id/events`. Old daemons silently lack both — SDK
  // clients pre-flight this tag before opting in.
  slow_client_warning: { since: "v1" },
  // SDK consumers can detect `KnownDaemonEvent` schema support without
  // pinning against this SDK release — `narrowDaemonEvent` falls back
  // to `kind: 'unknown'` for daemons that don't advertise the tag,
  // so the tag is purely informational.
  typed_event_schema: { since: "v1" },
  session_set_model: { since: "v1" },
  client_identity: { since: "v1" },
  client_heartbeat: { since: "v1" },
  session_permission_vote: { since: "v1" },
  permission_vote: { since: "v1" },
  workspace_mcp: { since: "v1" },
  workspace_skills: { since: "v1" },
  workspace_skills_config_runtime: { since: "v1" },
  workspace_providers: { since: "v1" },
  workspace_acp_preheat: { since: "v1" },
  workspace_acp_status: { since: "v1" },
  auth_provider_install: { since: "v1" },
  // Workspace memory CRUD (`GET/POST /workspace/memory`). Daemon exposes
  // hierarchical QWEN.md state and accepts append/replace writes scoped
  // to either the bound workspace or the global ~/.qwen directory.
  workspace_memory: { since: "v1" },
  workspace_memory_remember: {
    since: "v1",
    modes: ["workspace", "clean"]
  },
  // Explicit remember targets and scoped forget (`scope` parameter). Old
  // daemons silently ignore an unknown `scope`, so the SDK pre-flights the
  // matching tag before sending one. The sibling no-op behavior change — a
  // zero-write remember now fails `remember_no_update` instead of completing
  // with 'No memory files updated.' — is deliberately untagged: it changes a
  // task's terminal outcome, not the surface shape, and every client sees it
  // as a typed `failed` task status that cannot be mistaken for success.
  workspace_memory_remember_project_scope: { since: "v1" },
  workspace_memory_remember_user_scope: { since: "v1" },
  workspace_memory_forget: { since: "v1" },
  workspace_memory_forget_scope: { since: "v1" },
  workspace_memory_dream: { since: "v1" },
  // Workspace agents CRUD (`GET/POST /workspace/agents` +
  // `GET/POST/DELETE /workspace/agents/:agentType`). Wraps
  // `SubagentManager` over HTTP so remote clients can list / read /
  // create / update / delete project- and user-level subagent
  // definitions. Built-in / extension agents stay read-only.
  workspace_agents: { since: "v1" },
  workspace_agent_generate: { since: "v1" },
  workspace_env: { since: "v1" },
  workspace_preflight: { since: "v1" },
  session_context: { since: "v1" },
  session_context_usage: { since: "v1" },
  session_supported_commands: { since: "v1" },
  session_tasks: { since: "v1" },
  session_agents: { since: "v1" },
  session_agent_trace: { since: "v1" },
  scheduled_task_session_reuse: { since: "v1" },
  session_monitor_tool_correlation: { since: "v1" },
  session_stats: { since: "v1" },
  session_lsp: { since: "v1" },
  session_resources: { since: "v1" },
  session_status: { since: "v1" },
  session_close: { since: "v1" },
  session_archive: { since: "v1" },
  session_storage_conflict_repair: { since: "v1" },
  session_metadata: { since: "v1" },
  session_organization: { since: "v1" },
  session_export: { since: "v1" },
  standalone_sessions_v1: { since: "v1" },
  standalone_session_options_v1: { since: "v1" },
  session_transcript: { since: "v1" },
  session_transcript_pagination: { since: "v1" },
  session_turn_navigation: { since: "v1" },
  // Daemon supports the MCP client guardrail surface: an in-process
  // counter exposed on `GET /workspace/mcp`, a `--mcp-client-budget=N`
  // flag with `--mcp-budget-mode={enforce, warn, off}`, and a
  // `disabledReason: 'budget'` tag on per-server cells when refused at
  // discovery. `modes` enumerates the implemented behaviors.
  mcp_guardrails: { since: "v1", modes: ["warn", "enforce"] },
  workspace_mcp_manage: { since: "v1" },
  // Daemon emits typed push events for MCP budget state crossings:
  // `mcp_budget_warning` and `mcp_child_refused_batch`. Always-on;
  // orthogonal to `mcp_guardrails` (the snapshot surface).
  mcp_guardrail_events: { since: "v1" },
  // Managed ACP invokes an authenticated external policy provider exactly once
  // at the final tool-execution boundary. Advertised only after the required
  // provider completed its startup handshake.
  external_tool_guard: { since: "v1", modes: ["required"] },
  // Always-on. Daemon supports runtime MCP server mutation via
  // `POST /workspace/mcp/servers` (add) and
  // `DELETE /workspace/mcp/servers/:name` (remove). SDK clients
  // pre-flight this tag before calling those routes.
  mcp_server_runtime_mutation: { since: "v1" },
  // Daemon supports the read-only workspace file surface:
  // `GET /file`, `GET /list`, `GET /glob`, `GET /stat`. The four
  // routes are gated as a single feature because they share the same
  // backing `WorkspaceFileSystem` boundary and failure shape.
  workspace_file_read: { since: "v1" },
  // Daemon supports bounded raw byte reads via `GET /file/bytes`.
  // Separate from `workspace_file_read` because older daemons may
  // advertise the text/list/stat/glob surface without byte-window
  // support.
  workspace_file_bytes: { since: "v1" },
  // Daemon supports byte-cursor paging on `GET /file`: responses carry
  // `nextCursor`/`hasMore` and requests accept `cursor`. A separate tag from
  // `workspace_file_read` because the convention here is that new behavior
  // gets a new tag — a client that preflighted the old one must not silently
  // receive a surface it cannot recognise. Same split as
  // `workspace_file_bytes` from `workspace_file_read`, and
  // `session_transcript_pagination` from `session_transcript`.
  workspace_file_read_cursor: { since: "v1" },
  // Daemon supports hash-aware text mutation routes
  // (`POST /file/write`, `POST /file/edit`) behind the strict mutation
  // gate. Clients should still pre-flight `require_auth` separately for
  // deployment posture; this tag only means the route contract exists.
  workspace_file_write: { since: "v1" },
  // Daemon hosts binary file upload (`POST /file/upload`) behind the strict
  // mutation gate. Uploads never overwrite; occupied names auto-number. New
  // route contract = new tag (same split as `workspace_file_bytes` from
  // `workspace_file_read`). The advertised upload byte cap is surfaced via
  // `limits.maxWorkspaceFileUploadBytes`.
  workspace_file_upload: { since: "v1" },
  // Daemon hosts the session-level approval-mode
  // control route `POST /session/:id/approval-mode` (gated by the
  // mutation gate, strict). The route accepts `{mode, persist?}` —
  // `persist:true` also writes `tools.approvalMode` to workspace
  // settings via the daemon's `loadedSettings` handle. SDK helper:
  // `DaemonClient.setSessionApprovalMode`.
  session_approval_mode_control: { since: "v1" },
  // `POST /workspace/tools/:name/enable` toggles a
  // tool name in the workspace's `tools.disabled` settings list. The
  // bridge writes the settings file directly (no ACP roundtrip) and
  // fan-outs a `tool_toggled` event to all live session SSE buses.
  // Already-registered tools in active sessions are NOT retroactively
  // unregistered — the toggle takes effect on the next ACP child spawn
  // (`tools.disabled` is consulted at `Config` construction time).
  workspace_tool_toggle: { since: "v1" },
  workspace_skill_settings_toggle: { since: "v1" },
  workspace_skill_settings_batch_toggle: { since: "v1" },
  extension_batch_activation_v2: { since: "v1" },
  // Extension activation commits do not refresh active sessions. Clients that
  // need immediate runtime application must submit the independent refresh
  // operation after the activation operation commits.
  extension_activation_explicit_refresh: { since: "v1" },
  workspace_skill_manage: { since: "v1" },
  // `GET /brand` — the Web Shell's product name and logo, resolved from the
  // operator settings scopes. Unconditional because the route is registered
  // unconditionally. Advertised so a host can preflight rather than issue the
  // request and swallow a 404 from a daemon too old to have it.
  web_shell_brand: { since: "v1" },
  workspace_settings: { since: "v1" },
  // `GET /workspace/permissions` is always available when this tag is
  // advertised. `POST /workspace/permissions` updates the active ACP
  // child and returns `permission_session_required` when no live ACP
  // session exists; the tag means the route contract exists, not that
  // the current daemon state can accept a write.
  workspace_permissions: { since: "v1" },
  workspace_voice: { since: "v1" },
  workspace_voice_transcription: { since: "v1", modes: ["batch"] },
  // Inspect bound workspace trust and request local operator action.
  // Remote clients cannot directly write trustedFolders.json.
  workspace_trust: { since: "v1" },
  // Workspace trust policy changes rebuild the affected runtime generation
  // without restarting the daemon. V2 trust status exposes convergence.
  workspace_trust_hot_reload: { since: "v1" },
  // `POST /workspace/init` scaffolds an empty `QWEN.md` (or the
  // workspace `context.fileName` value injected as `contextFilename`)
  // at the bound workspace root. Body: `{force?: boolean}`. Default
  // refuses with 409 when the file already exists; `force: true`
  // overwrites. Mechanical only — does NOT call the LLM. To AI-fill the
  // file, the caller should follow up with `POST /session/:id/prompt`.
  workspace_init: { since: "v1" },
  // `POST /workspace/setup-github` installs the fixed
  // qwen-code-action workflow set into the bound workspace after
  // explicit consent. The route reuses the interactive `/setup-github`
  // release lookup, workflow download, and `.gitignore` update logic.
  workspace_github_setup: { since: "v1" },
  // `GET /workspaces/:workspace/github/prs` lists the open pull requests
  // of the workspace's GitHub remote via the `gh` CLI (read-only). The
  // tag means the route contract exists; runtime availability of `gh`
  // and its auth is reported per-request through the
  // `github_cli_unavailable` / `github_prs_failed` error codes.
  workspace_github_prs: { since: "v1" },
  // `POST /workspace/mcp/:server/restart` performs
  // a single-server MCP restart (disconnect + reconnect + rediscover)
  // through the ACP child's `McpClientManager`. Pre-checks the live
  // budget snapshot: when the target server is not
  // already in `reservedSlots` AND the live count would exceed the
  // configured budget under `enforce` mode, returns 200 with
  // `{restarted:false, skipped:true, reason:'budget_would_exceed'}`
  // rather than triggering a refusal cascade. Other skip reasons:
  // `'in_flight'` (concurrent discovery in progress), `'disabled'`
  // (server is configured but explicitly disabled).
  workspace_mcp_restart: { since: "v1" },
  // Daemon hosts `POST /session/:id/recap`, which
  // generates a one-sentence "where did I leave off" summary by
  // running `generateSessionRecap` (`core/services/sessionRecap.ts`) as
  // a side-query against the fast model. Non-strict mutation gate —
  // posture mirrors `/session/:id/prompt` (token cost, not state
  // mutation). The route returns `{sessionId, recap}` where `recap`
  // may be `null` for too-short histories or transient model failures
  // (best-effort, never throws). SDK helper: `DaemonClient.recapSession`.
  session_recap: { since: "v1" },
  // `POST /session/:id/generate` streams a stateless, tool-free model call.
  // The ACP child prefers fastModel and falls back to the main session model.
  session_generation: { since: "v1" },
  // `POST /workspace/generate` runs the same stateless, tool-free generation
  // protocol against the resolved workspace runtime without a live session.
  workspace_generation: { since: "v1" },
  // Side question (/btw) against the session's conversation context.
  // Single-turn, tool-free LLM call via runForkedAgent (cache path).
  session_btw: { since: "v1" },
  // Direct daemon-side shell execution for an existing session.
  // Advertised CONDITIONALLY: operators must explicitly enable it and
  // either configure bearer auth or use trusted-loopback mode. Clients must
  // still send a session-bound X-Qwen-Client-Id when calling the route.
  session_shell_command: { since: "v1" },
  // Daemon hosts a workspace-shared MCP transport
  // pool (`QwenAgent.mcpPool`); `GET /workspace/mcp` reflects pool-level
  // accounting (`entryCount`, `entrySummary` on each per-server cell).
  // Advertised CONDITIONALLY — the kill switch
  // `QWEN_SERVE_NO_MCP_POOL=1` env var falls back to per-session MCP
  // clients and the tag is omitted so SDK consumers
  // pre-flighting on the tag get accurate "pool is on" semantics.
  mcp_workspace_pool: { since: "v1" },
  // `POST /workspace/mcp/:server/restart`
  // accepts an optional `?entryIndex=N` (or `*`) query parameter
  // and may return the new `{entries: RestartResult[]}` shape when
  // the pool holds multiple entries for the same server name (e.g.
  // sessions injected divergent OAuth headers). Single-entry
  // restarts continue to return the legacy `{restarted, durationMs}`
  // shape for compatibility with pre-F2 SDK clients. Advertised
  // CONDITIONALLY in lockstep with `mcp_workspace_pool`: pool
  // off → both tags absent, pool on → both tags present. Operators
  // pre-flighting on this tag can branch on whether the response
  // shape may include `entries[]`.
  mcp_pool_restart: { since: "v1" },
  // Daemon was booted with `--require-auth` (or
  // `requireAuth: true`), so even loopback callers must carry a bearer
  // token. Advertised CONDITIONALLY — only when the flag is on — so
  // SDK clients can branch on its presence to surface a clear "this
  // deployment requires auth" hint instead of speculatively trying
  // requests and parsing the resulting 401 body. Loopback developer
  // defaults (no flag) omit the tag, preserving the bit-for-bit shape
  // older clients expect.
  require_auth: { since: "v1" },
  // Daemon was booted with `--allow-origin <pattern>`
  // (at least one entry, including the `*` literal). Advertised
  // CONDITIONALLY — only when the flag is set — so browser SDK clients
  // can pre-flight whether the daemon will honor their cross-origin
  // request before issuing it (and parsing a 403). The configured
  // pattern list is intentionally NOT echoed in the capabilities
  // envelope — a browser client knows its own origin, and surfacing the
  // list would let an unauthenticated `/capabilities` reader
  // enumerate every trusted origin, which is useful recon for a
  // misconfigured deployment.
  allow_origin: { since: "v1" },
  // Daemon exposes the device-flow auth surface
  // (`POST /workspace/auth/device-flow`, GET/DELETE on `/:id`, and
  // `GET /workspace/auth/status`). Advertised UNCONDITIONALLY: the
  // routes themselves return `400 unsupported_provider` if the daemon
  // can't satisfy a specific provider, so clients always probe via the
  // route. The list of supported providers is surfaced through the
  // status route (extension data on `/capabilities` would inflate the
  // descriptor shape; we keep the registry uniform).
  auth_device_flow: { since: "v1" },
  permission_mediation: {
    since: "v1",
    modes: ["first-responder", "designated", "consensus", "local-only"]
  },
  prompt_absolute_deadline: { since: "v1" },
  writer_idle_timeout: { since: "v1" },
  non_blocking_prompt: { since: "v1" },
  session_language: { since: "v1" },
  // Sessionless user-level language sync (`POST /language`) for hosts that
  // switch language before any session exists (issue #10234). Advertised
  // CONDITIONALLY with `workspace_settings`: the route persists user-scope
  // settings, so daemons without settings persistence omit the tag and
  // return 404.
  user_language_sync: { since: "v1" },
  session_rewind: { since: "v1" },
  workspace_hooks: { since: "v1" },
  session_hooks: { since: "v1" },
  workspace_extensions: { since: "v1" },
  session_branch: { since: "v1" },
  rate_limit: { since: "v1" },
  workspace_reload: { since: "v1" },
  // Immediate best-effort channel delivery for prompt/scheduled finals and
  // direct workspace notifications. Presence describes the route/event
  // contract; current worker availability is reported per delivery.
  channel_delivery: { since: "v1" },
  // Daemon supports reloading its daemon-managed channel worker via
  // `POST /workspace/channel/reload`. The worker is stopped and relaunched;
  // on relaunch it re-reads settings.json (channels / proxy / per-channel
  // model), so channel settings changes apply without a full daemon restart.
  // Advertised CONDITIONALLY while the runtime manager has a committed or
  // recoverable channel worker selection.
  channel_reload: { since: "v1" },
  // Runtime GET/PUT/DELETE control for daemon-managed channel selection.
  // The route exists even when no selection was supplied at daemon boot.
  channel_control: { since: "v1" },
  // Sanitized workspace Channel configuration, lifecycle, and pairing.
  channel_management: { since: "v1" },
  // Read-only workspace graph of recently observed channel contacts.
  workspace_channel_observed_contacts: { since: "v1" },
  // Multi-workspace session routing. Advertised only when one daemon hosts
  // more than one registered workspace runtime.
  multi_workspace_sessions: { since: "v1" },
  // Singular session rewind routes resolve the owning live workspace runtime.
  multi_workspace_session_rewind: { since: "v1" },
  // Singular session shell routes resolve the owning live workspace runtime.
  multi_workspace_session_shell: { since: "v1" },
  dynamic_workspace_registration: { since: "v1" },
  persistent_workspace_registration: { since: "v1" },
  // Optional presentation-only names and updates to those names for workspace
  // runtimes. Workspace ids and canonical paths remain the routing identities.
  workspace_display_name: { since: "v1" },
  scratch_workspace_registration: { since: "v1" },
  workspace_runtime_removal: { since: "v1" },
  // A native OS directory picker can be opened on the daemon host
  // (osascript on macOS, PowerShell on Windows, zenity on a Linux host
  // with a display). Headless hosts omit the tag so clients hide the
  // Browse affordance instead of surfacing a guaranteed picker failure.
  native_directory_picker: { since: "v1" },
  // Workspace-owned runtime lifecycle status and explicit on-demand startup.
  workspace_runtime: { since: "v1" },
  // The daemon host can open a workspace directory in the host's OS file
  // manager (Finder via `open` on macOS, Explorer via `explorer.exe` on
  // Windows, xdg-open on a Linux host with a display). Headless hosts omit
  // the tag so clients hide the Open-locally affordance instead of
  // surfacing a guaranteed launch failure.
  workspace_local_open: { since: "v1" },
  // The daemon host can open a terminal window in a workspace directory
  // (`open -a Terminal` on macOS, wt.exe/cmd.exe on Windows, a common
  // terminal emulator on a Linux host with a display). Headless hosts omit
  // the tag so clients hide the Open-in-terminal affordance instead of
  // surfacing a guaranteed launch failure.
  workspace_local_terminal: { since: "v1" },
  // Workspace-qualified core REST routes under `/workspaces/:workspace/...`.
  // Covers core file read/write/upload, status/permissions/trust/lifecycle/MCP/tool,
  // memory, workspace agent CRUD, and persisted session organization surfaces.
  // Workspace-qualified settings also require the existing
  // `workspace_settings` tag because that surface depends on settings
  // persistence. ACP/WebSocket and auth stay outside this core tag;
  // workspace-qualified Voice REST/WebSocket routes use their separate
  // `workspace_qualified_voice` capability below. V2 extension management
  // is advertised separately via `extension_management_v2`.
  workspace_qualified_rest_core: { since: "v1" },
  // Workspace-qualified Voice REST and WebSocket routes. This tag is enough
  // to discover plural modalities because legacy Voice tags describe only
  // the primary runtime and may be absent for a secondary-only setup.
  workspace_qualified_voice: { since: "v1" },
  // Workspace-qualified managed-memory routes
  // (`/workspaces/:workspace/memory/{remember,forget,dream}`). Each
  // registered workspace gets its own task lane; the primary lane is the
  // same instance as the singular `/workspace/memory` surface.
  workspace_qualified_memory: { since: "v1" },
  // Global extension catalog/mutations plus workspace-qualified activation
  // projections. This is additive to the legacy primary-workspace
  // `workspace_extensions` contract.
  extension_management_v2: { since: "v1" },
  extension_state: { since: "v1" },
  extension_git_credentials: { since: "v1" },
  extension_local_path_install: { since: "v1" },
  // Workspace-qualified, daemon-local persisted transcript paging. The tag is
  // unconditional because the route also serves a trusted single-workspace
  // primary; authorization is evaluated for the selected runtime per request.
  workspace_persisted_transcript: { since: "v1" },
  // Workspace-qualified full session export from active persisted storage.
  // This is separate from `session_export` so clients do not infer the plural
  // route from the legacy primary-workspace export capability.
  workspace_session_export: { since: "v1" },
  // Workspace-qualified full session export from archived persisted storage.
  // This remains independent from active export so older daemons cannot ignore
  // archive intent and return an active transcript with the same session id.
  workspace_archived_session_export: { since: "v1" },
  // Workspace-qualified, memory-only session live-state snapshot plus the
  // in-memory catalog version token
  // (`GET /workspaces/:workspace/sessions/live-state`). Independent from
  // `workspace_qualified_rest_core`: released daemons can advertise that tag
  // without implementing this route, so clients must pre-flight it directly.
  // The route stays subject to the per-workspace trust check even when the
  // tag is advertised.
  workspace_session_live_state: { since: "v1" },
  // Workspace-qualified metadata updates for active, inactive, and archived
  // persisted sessions.
  workspace_session_metadata: { since: "v1" },
  // Worktree-backed session create/load responses are durably persisted and
  // carry per-response `persisted-v1` attestation.
  session_worktree_persistence_v1: { since: "v1" },
  // Worktree ownership transfer: `POST /session/:id/worktree-reset` moves a
  // session's checkout ownership to a fresh replacement session, and the
  // restore surface reports the superseded / interrupted / missing-marker
  // classifications as typed 409s.
  session_worktree_reset_v1: { since: "v1" },
  // Workspace-qualified ACP transport (issue #6378 Phase 4):
  // `/workspaces/:workspace/acp` mounts a per-runtime ACP dispatcher (HTTP +
  // WebSocket) for each registered workspace, with per-runtime device-flow and
  // reverse client-MCP. Legacy `/acp` stays bound to the primary runtime.
  // Advertised only when the daemon hosts more than one workspace runtime.
  workspace_qualified_acp: { since: "v1" },
  // Phase 2 "reverse tool channel" (issue #5626). A connected WS client (e.g.
  // the Chrome extension) can host an MCP server that the daemon's agent
  // calls by carrying `mcp_message` JSON-RPC frames over the daemon WS,
  // reusing the SDK-MCP-server control-plane pattern. Inbound WS frame types:
  // `mcp_register` { server }, `mcp_message` { id, server, payload }
  // (bidirectional, request/response correlated by `id`), `mcp_unregister`
  // { server }. Advertised CONDITIONALLY so clients pre-flight this tag before
  // attempting to register a client-hosted server. `runQwenServe` enables it
  // only when explicitly requested by option or env.
  client_mcp_over_ws: { since: "v1" },
  // Plan C "CDP tunnel" (issue #5626): the daemon exposes a `/cdp` WebSocket
  // where a loopback CDP client drives ONE real tab
  // via the extension's `chrome.debugger`, tunneled over `/acp` as `cdp_*`
  // frames. Advertised when explicitly enabled or when the daemon is serving a
  // Chrome extension origin.
  cdp_tunnel_over_ws: { since: "v1" },
  // Browser automation MCP tools are available only when the CDP tunnel is on
  // and the operator has configured an external stdio adapter via
  // QWEN_CDP_MCP_COMMAND. This is separate from `cdp_tunnel_over_ws`: a daemon
  // may expose the tunnel while intentionally not bundling/registering a
  // chrome-devtools MCP adapter.
  browser_automation_mcp: { since: "v1" },
  // Daemon hosts the `/voice/stream` WebSocket: the browser captures audio and
  // streams raw PCM, the daemon transcribes server-side via the configured
  // `voiceModel` (credentials never reach the client). Advertised
  // UNCONDITIONALLY (like `auth_device_flow`): presence means the endpoint
  // exists, not that a voice model is configured. The WS returns an `error`
  // frame when no transcribable `voiceModel` is set, so clients probe by
  // connecting rather than reading ambient settings into `/capabilities` (which
  // would make the envelope depend on the user's home config). `modes`
  // enumerates the two transcription paths (realtime vs. on-stop batch).
  voice_transcribe: { since: "v1", modes: ["streaming", "batch"] },
  // Process-global Live Voice control plane. Advertisement requires a macOS
  // WebShell daemon with native Host integration and the hot-applied enabled
  // gate. `/live/status` remains the dynamic readiness surface for the Host,
  // permissions, self-checks, and provider reachability.
  realtime_voice: { since: "v1" },
  web_terminal: { since: "v1" }
};
var CONDITIONAL_SERVE_FEATURES = /* @__PURE__ */ new Map([
  ["require_auth", (toggles) => toggles.requireAuth === true],
  [
    "standalone_sessions_v1",
    (toggles) => toggles.standaloneSessionsAvailable === true
  ],
  [
    "standalone_session_options_v1",
    (toggles) => toggles.standaloneSessionsAvailable === true
  ],
  ["mcp_workspace_pool", (toggles) => toggles.mcpPoolActive === true],
  ["mcp_pool_restart", (toggles) => toggles.mcpPoolActive === true],
  [
    "external_tool_guard",
    (toggles) => toggles.externalToolGuardActive === true
  ],
  ["allow_origin", (toggles) => toggles.allowOriginActive === true],
  [
    "prompt_absolute_deadline",
    (toggles) => typeof toggles.promptDeadlineMs === "number" && toggles.promptDeadlineMs > 0
  ],
  [
    "writer_idle_timeout",
    (toggles) => typeof toggles.writerIdleTimeoutMs === "number" && toggles.writerIdleTimeoutMs > 0
  ],
  ["workspace_settings", (toggles) => toggles.persistSettingAvailable === true],
  ["user_language_sync", (toggles) => toggles.persistSettingAvailable === true],
  ["workspace_voice", (toggles) => toggles.persistSettingAvailable === true],
  [
    "workspace_voice_transcription",
    (toggles) => toggles.voiceTranscriptionAvailable === true
  ],
  [
    "session_shell_command",
    (toggles) => toggles.sessionShellCommandEnabled === true
  ],
  [
    "session_artifacts_persistence",
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true
  ],
  [
    "session_sources",
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true
  ],
  [
    "session_generation",
    (toggles) => toggles.sessionGenerationAvailable === true
  ],
  [
    "scheduled_task_session_reuse",
    (toggles) => toggles.currentSessionSchedulingAvailable === true
  ],
  [
    "workspace_generation",
    (toggles) => toggles.workspaceGenerationAvailable === true
  ],
  ["rate_limit", (toggles) => toggles.rateLimit === true],
  ["workspace_reload", (toggles) => toggles.reloadAvailable === true],
  [
    "workspace_trust_hot_reload",
    (toggles) => toggles.workspaceTrustHotReloadAvailable === true
  ],
  ["channel_reload", (toggles) => toggles.channelReloadAvailable === true],
  ["channel_control", (toggles) => toggles.channelControlAvailable === true],
  [
    "channel_management",
    (toggles) => toggles.channelManagementAvailable === true
  ],
  [
    "multi_workspace_sessions",
    (toggles) => toggles.multiWorkspaceSessionsEnabled === true
  ],
  [
    "multi_workspace_session_rewind",
    (toggles) => toggles.multiWorkspaceSessionsEnabled === true
  ],
  [
    "multi_workspace_session_shell",
    (toggles) => toggles.multiWorkspaceSessionsEnabled === true && toggles.sessionShellCommandEnabled === true
  ],
  [
    "dynamic_workspace_registration",
    (toggles) => toggles.dynamicWorkspaceRegistrationAvailable === true
  ],
  [
    "persistent_workspace_registration",
    (toggles) => toggles.persistentWorkspaceRegistrationAvailable === true
  ],
  [
    "scratch_workspace_registration",
    (toggles) => toggles.scratchWorkspaceRegistrationAvailable === true
  ],
  [
    "workspace_runtime_removal",
    (toggles) => toggles.workspaceRuntimeRemovalAvailable === true
  ],
  [
    "native_directory_picker",
    (toggles) => toggles.nativeDirectoryPickerAvailable === true
  ],
  [
    "workspace_runtime",
    (toggles) => toggles.workspaceRuntimeAvailable === true
  ],
  [
    "workspace_skills_config_runtime",
    (toggles) => toggles.workspaceRuntimeAvailable === true
  ],
  [
    "workspace_local_open",
    (toggles) => toggles.localPathOpenAvailable === true
  ],
  [
    "workspace_local_terminal",
    (toggles) => toggles.localTerminalOpenAvailable === true
  ],
  [
    "workspace_qualified_acp",
    // The plural routes are pre-mounted for workspaces registered after app
    // creation, but the capability becomes meaningful only once a secondary
    // runtime exists. Until then the qualified primary route is only an alias
    // for the always-available legacy `/acp` surface.
    (toggles) => toggles.acpHttpEnabled === true && toggles.multiWorkspaceSessionsEnabled === true
  ],
  [
    "workspace_qualified_voice",
    // Like qualified ACP, the plural Voice surface is mounted ahead of time
    // but only becomes useful once the daemon has a secondary runtime.
    (toggles) => toggles.acpHttpEnabled === true && toggles.multiWorkspaceSessionsEnabled === true
  ],
  [
    "workspace_qualified_memory",
    (toggles) => toggles.acpHttpEnabled === true && toggles.multiWorkspaceSessionsEnabled === true
  ],
  ["client_mcp_over_ws", (toggles) => toggles.clientMcpOverWsEnabled === true],
  ["cdp_tunnel_over_ws", (toggles) => toggles.cdpTunnelOverWsEnabled === true],
  [
    "browser_automation_mcp",
    (toggles) => toggles.browserAutomationMcpAvailable === true
  ],
  [
    // Advertised whenever the `/voice/stream` WS endpoint exists. A configured
    // token (or `--require-auth`) no longer suppresses it: browsers can't set
    // an `Authorization` header on a WebSocket, so the Web Shell carries the
    // bearer token in the `Sec-WebSocket-Protocol` subprotocol, which the ACP
    // upgrade listener verifies (see acp-http/index.ts).
    "voice_transcribe",
    (toggles) => toggles.voiceWsAvailable !== false
  ],
  [
    "realtime_voice",
    (toggles) => toggles.acpHttpEnabled === true && toggles.realtimeVoiceEnabled === true
  ],
  ["web_terminal", (toggles) => toggles.acpHttpEnabled === true]
]);
var SERVE_FEATURES = Object.freeze(
  Object.keys(SERVE_CAPABILITY_REGISTRY)
);
function serveProtocolVersionIndex(version) {
  return SUPPORTED_SERVE_PROTOCOL_VERSIONS.indexOf(version);
}
__name(serveProtocolVersionIndex, "serveProtocolVersionIndex");
function isFeatureAvailableInProtocol(feature, protocolVersion) {
  return serveProtocolVersionIndex(SERVE_CAPABILITY_REGISTRY[feature].since) <= serveProtocolVersionIndex(protocolVersion);
}
__name(isFeatureAvailableInProtocol, "isFeatureAvailableInProtocol");
function getAdvertisedServeFeatures(protocolVersion = SERVE_PROTOCOL_VERSION, toggles = {}) {
  return SERVE_FEATURES.filter((feature) => {
    if (!isFeatureAvailableInProtocol(feature, protocolVersion)) return false;
    const predicate = CONDITIONAL_SERVE_FEATURES.get(feature);
    if (predicate !== void 0) return predicate(toggles);
    return true;
  });
}
__name(getAdvertisedServeFeatures, "getAdvertisedServeFeatures");
function getServeProtocolVersions() {
  return {
    current: SERVE_PROTOCOL_VERSION,
    supported: [...SUPPORTED_SERVE_PROTOCOL_VERSIONS]
  };
}
__name(getServeProtocolVersions, "getServeProtocolVersions");

// packages/cli/src/serve/native-directory-picker.ts
init_esbuild_shims();
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var PICKER_TIMEOUT_MS = 3e5;
var NativeDirectoryPickerUnavailableError = class extends Error {
  static {
    __name(this, "NativeDirectoryPickerUnavailableError");
  }
};
function isNativeDirectoryPickerAvailable(env = process.env, macOsSessionUids = process.platform === "darwin" ? readMacOsSessionUids() : void 0) {
  if (process.platform === "darwin") {
    return macOsSessionUids?.processUid !== void 0 && macOsSessionUids.processUid > 0 && macOsSessionUids.consoleUid === macOsSessionUids.processUid && !env["SSH_CONNECTION"] && !env["SSH_TTY"];
  }
  if (process.platform === "win32") {
    const sessionName = env["SESSIONNAME"]?.trim();
    return Boolean(sessionName && sessionName.toLowerCase() !== "services");
  }
  if (process.platform !== "linux") return false;
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return false;
  return (env["PATH"] ?? "").split(delimiter).some((dir) => dir !== "" && isExecutableFile(join(dir, "zenity")));
}
__name(isNativeDirectoryPickerAvailable, "isNativeDirectoryPickerAvailable");
function readMacOsSessionUids() {
  try {
    return {
      processUid: process.getuid?.(),
      consoleUid: statSync("/dev/console").uid
    };
  } catch {
    return {};
  }
}
__name(readMacOsSessionUids, "readMacOsSessionUids");
function isExecutableFile(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
__name(isExecutableFile, "isExecutableFile");
async function pickNativeDirectory(signal) {
  try {
    if (process.platform === "darwin") {
      const script = [
        "const app = Application.currentApplication();",
        "app.includeStandardAdditions = true;",
        "app.chooseFolder({",
        'withPrompt: "Select a workspace folder",',
        "}).toString();"
      ].join(" ");
      const { stdout } = await execFileAsync(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        { timeout: PICKER_TIMEOUT_MS, signal }
      );
      return stdout.trim() || void 0;
    }
    if (process.platform === "win32") {
      const script = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
        "[Console]::Out.Write($dialog.SelectedPath)",
        "}"
      ].join(" ");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", script],
        { timeout: PICKER_TIMEOUT_MS, signal }
      );
      return stdout.trim() || void 0;
    }
    if (process.platform === "linux") {
      const { stdout } = await execFileAsync(
        "zenity",
        [
          "--file-selection",
          "--directory",
          "--title=Select a workspace folder"
        ],
        { timeout: PICKER_TIMEOUT_MS, signal }
      );
      return stdout.trim() || void 0;
    }
  } catch (error) {
    const result = error;
    if (result.killed) {
      return void 0;
    }
    if (process.platform === "darwin" && (result.stderr?.includes("(-128)") || result.stderr?.includes("User canceled")) || // Zenity exits 1 both for a deliberate cancel and for "cannot open
    // display" on headless Linux; only the former is a silent cancel.
    process.platform === "linux" && result.code === 1 && !result.stderr?.includes("cannot open display")) {
      return void 0;
    }
    throw new NativeDirectoryPickerUnavailableError(
      error instanceof Error ? error.message : String(error)
    );
  }
  throw new NativeDirectoryPickerUnavailableError(
    `Native directory picker is not supported on ${process.platform}`
  );
}
__name(pickNativeDirectory, "pickNativeDirectory");

// packages/cli/src/serve/local-path-open.ts
init_esbuild_shims();
import { execFile as execFile2, spawn } from "node:child_process";
import { accessSync as accessSync2, constants as constants2, statSync as statSync2 } from "node:fs";
import { delimiter as delimiter2, join as join2 } from "node:path";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
var OPEN_TIMEOUT_MS = 1e4;
var LINUX_TERMINAL_NAMES = ["gnome-terminal", "konsole", "xterm"];
function linuxTerminalCandidates(env) {
  return env["DISPLAY"] ? LINUX_TERMINAL_NAMES : LINUX_TERMINAL_NAMES.filter((name) => name !== "xterm");
}
__name(linuxTerminalCandidates, "linuxTerminalCandidates");
var LocalPathOpenUnavailableError = class extends Error {
  static {
    __name(this, "LocalPathOpenUnavailableError");
  }
};
var SpawnHangError = class extends Error {
  static {
    __name(this, "SpawnHangError");
  }
};
function defaultMacOsSessionUids() {
  return process.platform === "darwin" ? readMacOsSessionUids2() : void 0;
}
__name(defaultMacOsSessionUids, "defaultMacOsSessionUids");
function hasGuiSession(env, macOsSessionUids) {
  if (process.platform === "darwin") {
    return macOsSessionUids?.processUid !== void 0 && macOsSessionUids.processUid > 0 && macOsSessionUids.consoleUid === macOsSessionUids.processUid && !env["SSH_CONNECTION"] && !env["SSH_TTY"];
  }
  if (process.platform === "win32") {
    const sessionName = env["SESSIONNAME"]?.trim();
    return Boolean(sessionName && sessionName.toLowerCase() !== "services");
  }
  return void 0;
}
__name(hasGuiSession, "hasGuiSession");
function findExecutableOnPath(env, names) {
  for (const name of names) {
    for (const dir of (env["PATH"] ?? "").split(delimiter2)) {
      if (dir === "") continue;
      const candidate = join2(dir, name);
      if (isExecutableFile2(candidate)) return candidate;
    }
  }
  return void 0;
}
__name(findExecutableOnPath, "findExecutableOnPath");
function isLocalPathOpenAvailable(env = process.env, macOsSessionUids = defaultMacOsSessionUids()) {
  const guiSession = hasGuiSession(env, macOsSessionUids);
  if (guiSession !== void 0) return guiSession;
  if (process.platform !== "linux") return false;
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return false;
  return findExecutableOnPath(env, ["xdg-open"]) !== void 0;
}
__name(isLocalPathOpenAvailable, "isLocalPathOpenAvailable");
function isLocalTerminalAvailable(env = process.env, macOsSessionUids = defaultMacOsSessionUids()) {
  const guiSession = hasGuiSession(env, macOsSessionUids);
  if (guiSession !== void 0) return guiSession;
  if (process.platform !== "linux") return false;
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return false;
  return findExecutableOnPath(env, linuxTerminalCandidates(env)) !== void 0;
}
__name(isLocalTerminalAvailable, "isLocalTerminalAvailable");
function readMacOsSessionUids2() {
  try {
    return {
      processUid: process.getuid?.(),
      consoleUid: statSync2("/dev/console").uid
    };
  } catch {
    return {};
  }
}
__name(readMacOsSessionUids2, "readMacOsSessionUids");
function isExecutableFile2(file) {
  try {
    if (!statSync2(file).isFile()) return false;
    accessSync2(file, constants2.X_OK);
    return true;
  } catch {
    return false;
  }
}
__name(isExecutableFile2, "isExecutableFile");
async function openPathLocally(path, timeoutMs) {
  try {
    if (process.platform === "darwin") {
      await execFileAsync2("open", [path], { timeout: OPEN_TIMEOUT_MS });
      return;
    }
    if (process.platform === "win32") {
      assertPathExists(path);
      await spawnAndIgnoreExitCode("explorer.exe", [path], { timeoutMs });
      return;
    }
    if (process.platform === "linux") {
      await execFileAsync2("xdg-open", [path], { timeout: OPEN_TIMEOUT_MS });
      return;
    }
  } catch (error) {
    throw new LocalPathOpenUnavailableError(
      error instanceof Error ? error.message : String(error)
    );
  }
  throw new LocalPathOpenUnavailableError(
    `Local path open is not supported on ${process.platform}`
  );
}
__name(openPathLocally, "openPathLocally");
function assertPathExists(path) {
  try {
    statSync2(path);
  } catch {
    throw new LocalPathOpenUnavailableError(`Path does not exist: ${path}`);
  }
}
__name(assertPathExists, "assertPathExists");
async function openTerminalLocally(path, timeoutMs) {
  try {
    if (process.platform === "darwin") {
      await execFileAsync2("open", ["-a", "Terminal", path], {
        timeout: OPEN_TIMEOUT_MS
      });
      return;
    }
    if (process.platform === "win32") {
      assertPathExists(path);
      await spawnWindowsTerminal(path, timeoutMs);
      return;
    }
    if (process.platform === "linux") {
      assertPathExists(path);
      await spawnLinuxTerminal(path, timeoutMs);
      return;
    }
  } catch (error) {
    if (error instanceof LocalPathOpenUnavailableError) throw error;
    throw new LocalPathOpenUnavailableError(
      error instanceof Error ? error.message : String(error)
    );
  }
  throw new LocalPathOpenUnavailableError(
    `Local terminal open is not supported on ${process.platform}`
  );
}
__name(openTerminalLocally, "openTerminalLocally");
async function spawnWindowsTerminal(path, timeoutMs) {
  try {
    await spawnAndIgnoreExitCode("wt.exe", ["-d", path], { timeoutMs });
  } catch (error) {
    if (error instanceof SpawnHangError) throw error;
    await spawnAndIgnoreExitCode(
      "powershell.exe",
      [
        "-NoProfile",
        "-STA",
        "-Command",
        'Start-Process cmd.exe -WorkingDirectory "$env:QWEN_LOCAL_OPEN_DIR"'
      ],
      { extraEnv: { QWEN_LOCAL_OPEN_DIR: path }, timeoutMs }
    );
  }
}
__name(spawnWindowsTerminal, "spawnWindowsTerminal");
async function spawnLinuxTerminal(path, timeoutMs) {
  const env = process.env;
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) {
    throw new LocalPathOpenUnavailableError("No display server available");
  }
  const terminal = findExecutableOnPath(env, linuxTerminalCandidates(env));
  if (terminal === void 0) {
    throw new LocalPathOpenUnavailableError(
      "No terminal emulator found on PATH"
    );
  }
  const name = terminal.split(/[\\/]/).pop();
  if (name === "gnome-terminal") {
    await spawnLongLived(terminal, [`--working-directory=${path}`], timeoutMs);
    return;
  }
  if (name === "konsole") {
    await spawnLongLived(terminal, ["--workdir", path], timeoutMs);
    return;
  }
  await spawnLongLived(
    terminal,
    ["-e", "sh", "-c", 'cd "$1" && exec "${SHELL:-/bin/sh}"', "sh", path],
    timeoutMs
  );
}
__name(spawnLinuxTerminal, "spawnLinuxTerminal");
function spawnAndIgnoreExitCode(command, args, options = {}) {
  const { extraEnv, timeoutMs = OPEN_TIMEOUT_MS } = options;
  return new Promise((resolve2, reject) => {
    const child = spawn(command, [...args], {
      stdio: "ignore",
      ...extraEnv ? { env: { ...process.env, ...extraEnv } } : {}
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new SpawnHangError(`${command} did not exit within ${timeoutMs}ms`)
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve2();
    });
  });
}
__name(spawnAndIgnoreExitCode, "spawnAndIgnoreExitCode");
function spawnLongLived(command, args, timeoutMs = OPEN_TIMEOUT_MS) {
  return new Promise((resolve2, reject) => {
    const child = spawn(command, [...args], {
      stdio: "ignore",
      detached: true
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new SpawnHangError(`${command} did not spawn within ${timeoutMs}ms`)
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("spawn", () => {
      clearTimeout(timer);
      child.unref();
      resolve2();
    });
  });
}
__name(spawnLongLived, "spawnLongLived");

// packages/cli/src/serve/types.ts
init_esbuild_shims();
var CAPABILITIES_SCHEMA_VERSION = 1;

// packages/cli/src/serve/managed-scratch-workspace.ts
init_esbuild_shims();
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, mkdtemp } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join as join3,
  relative,
  resolve
} from "node:path";
var isSamePath = /* @__PURE__ */ __name((left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right, "isSamePath");
var isWithinRoot = /* @__PURE__ */ __name((candidate, root) => {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}, "isWithinRoot");
function isManagedScratchChild(canonicalCwd, canonicalRoot) {
  return isSamePath(dirname(canonicalCwd), canonicalRoot) && /^scratch-.+/.test(basename(canonicalCwd));
}
__name(isManagedScratchChild, "isManagedScratchChild");
function isScratchRootCompatible(canonicalCwd, canonicalRoot) {
  if (isSamePath(canonicalCwd, canonicalRoot)) return false;
  if (isManagedScratchChild(canonicalCwd, canonicalRoot)) return true;
  return !isWithinRoot(canonicalCwd, canonicalRoot) && !isWithinRoot(canonicalRoot, canonicalCwd);
}
__name(isScratchRootCompatible, "isScratchRootCompatible");
function validateRootStats(stats) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Managed scratch root must be a non-symlink directory");
  }
  if (process.platform !== "win32" && typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Managed scratch root must be owned by the daemon user");
  }
  if (process.platform !== "win32" && (stats.mode & 63) !== 0) {
    throw new Error(
      "Managed scratch root must be accessible only to its owner"
    );
  }
}
__name(validateRootStats, "validateRootStats");
function hasVerifiableInode(ino) {
  return Number(ino) !== 0;
}
__name(hasVerifiableInode, "hasVerifiableInode");
function prepareManagedScratchRoot(root, startupWorkspaceCwds) {
  mkdirSync(root, { recursive: true, mode: 448 });
  const before = lstatSync(root);
  validateRootStats(before);
  const canonicalRoot = realpathSync.native(resolve(root));
  const after = lstatSync(canonicalRoot);
  validateRootStats(after);
  if (!hasVerifiableInode(after.ino)) {
    throw new Error(
      "Managed scratch root identity cannot be verified on this volume"
    );
  }
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("Managed scratch root identity changed during validation");
  }
  if (startupWorkspaceCwds.some(
    (cwd) => !isScratchRootCompatible(cwd, canonicalRoot)
  )) {
    throw new Error("Managed scratch root conflicts with a startup workspace");
  }
  return {
    canonicalRoot,
    device: after.dev,
    inode: after.ino
  };
}
__name(prepareManagedScratchRoot, "prepareManagedScratchRoot");
async function revalidateManagedScratchRoot(root) {
  const stats = await lstat(root.canonicalRoot);
  validateRootStats(stats);
  if (stats.dev !== root.device || stats.ino !== root.inode) {
    throw new Error("Managed scratch root identity changed");
  }
  const canonical = realpathSync.native(root.canonicalRoot);
  if (!isSamePath(canonical, root.canonicalRoot)) {
    throw new Error("Managed scratch root canonical path changed");
  }
}
__name(revalidateManagedScratchRoot, "revalidateManagedScratchRoot");
async function createManagedScratchDirectory(root) {
  await revalidateManagedScratchRoot(root);
  const created = await mkdtemp(join3(root.canonicalRoot, "scratch-"));
  const canonical = realpathSync.native(created);
  if (!isManagedScratchChild(canonical, root.canonicalRoot)) {
    throw new Error("Managed scratch directory escaped its accepted root");
  }
  await revalidateManagedScratchRoot(root);
  return canonical;
}
__name(createManagedScratchDirectory, "createManagedScratchDirectory");

// packages/cli/src/serve/serve-app-lifecycle.ts
init_esbuild_shims();
var SERVE_APP_LIFECYCLE = Symbol("qwen.serveAppLifecycle");
var DEFAULT_CLOSE_TIMEOUT_MS = 5e3;
var SECONDARY_CLOSE_TIMEOUT_MS = 2e3;
function deferred() {
  let resolve2;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve2 = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => void 0);
  return { promise, resolve: resolve2, reject };
}
__name(deferred, "deferred");
var ServeAppLifecycleController = class {
  static {
    __name(this, "ServeAppLifecycleController");
  }
  admission = deferred();
  server;
  startupReady = true;
  listenerReady = false;
  listenerClosed = false;
  sealed = false;
  closePending;
  appDrain;
  hostDrain;
  bootStarter;
  bootPending;
  bootStarted = false;
  bindServer(server, options = {}) {
    if (this.server || server.listening || this.bootStarted || this.sealed) {
      throw new Error(
        "Serve app lifecycle must bind one server before its first listen."
      );
    }
    this.server = server;
    this.hostDrain = options.drainHost;
    this.startupReady = options.startupReady === void 0;
    server.once("listening", () => {
      this.listenerReady = true;
      if (this.sealed) {
        server.close();
        server.closeAllConnections();
        return;
      }
      this.openAdmissionIfReady();
    });
    server.on("close", () => {
      this.listenerClosed = true;
      this.seal();
      void this.close().catch(() => void 0);
    });
    server.on("error", (error) => {
      if (!this.listenerReady && options.startupReady === void 0) {
        this.seal(error);
        void this.close().catch(() => void 0);
      }
    });
    if (options.startupReady) {
      void options.startupReady.then(
        () => {
          this.startupReady = true;
          this.openAdmissionIfReady();
        },
        (error) => {
          this.seal(error instanceof Error ? error : new Error(String(error)));
        }
      );
    }
  }
  close(options = {}) {
    if (this.closePending) return this.closePending;
    const pending = this.closeOnce(options);
    this.closePending = pending;
    void pending.catch(() => {
      if (this.closePending === pending) this.closePending = void 0;
    });
    return pending;
  }
  setAppDrain(drain) {
    this.appDrain = drain;
  }
  setBootStarter(starter) {
    this.bootStarter = starter;
    this.openAdmissionIfReady();
  }
  async awaitBootAdmission() {
    if (!this.server || this.sealed) {
      throw conversationRuntimeUnavailableError();
    }
    try {
      await this.admission.promise;
    } catch (error) {
      throw conversationRuntimeUnavailableError(error);
    }
    if (this.sealed) {
      throw conversationRuntimeUnavailableError();
    }
  }
  async startBoot(starter = this.bootStarter) {
    await this.awaitBootAdmission();
    await this.beginBoot(starter);
  }
  getBootPromise() {
    return this.bootPending;
  }
  isBootStarted() {
    return this.bootStarted;
  }
  sealBoot() {
    this.seal();
  }
  openAdmissionIfReady() {
    if (this.sealed || !this.server || !this.listenerReady || !this.startupReady) {
      return;
    }
    this.admission.resolve();
    const bootStarter = this.bootStarter;
    if (bootStarter && !this.bootStarted) {
      void this.beginBoot(bootStarter)?.catch(() => void 0);
    }
  }
  beginBoot(starter) {
    if (!starter) return void 0;
    if (this.sealed) {
      return Promise.reject(conversationRuntimeUnavailableError());
    }
    if (this.bootPending) return this.bootPending;
    this.bootStarted = true;
    const pending = Promise.resolve().then(starter);
    const tracked = pending.finally(() => {
      if (this.bootPending === tracked) this.bootPending = void 0;
    });
    this.bootPending = tracked;
    void tracked.catch(() => void 0);
    return tracked;
  }
  seal(error) {
    if (this.sealed) return;
    this.sealed = true;
    this.admission.reject(error ?? conversationRuntimeUnavailableError());
  }
  async closeOnce(options) {
    this.seal();
    const drains = [
      this.startDrain(this.appDrain),
      this.startDrain(this.hostDrain),
      this.bootPending?.catch(() => void 0)
    ].filter((value) => value !== void 0);
    const listenerClose = this.closeListener(
      options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    );
    const results = await Promise.allSettled([...drains, listenerClose]);
    const errors = results.filter(
      (result) => result.status === "rejected"
    ).map((result) => result.reason);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Serve app shutdown is incomplete.");
    }
  }
  startDrain(drain) {
    if (!drain) return void 0;
    try {
      return drain();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  closeListener(timeoutMs) {
    if (!this.server || this.listenerClosed || !this.listenerReady && !this.server.listening) {
      return Promise.resolve();
    }
    const server = this.server;
    if (!server.listening) {
      return this.waitForClosingListener(server, timeoutMs);
    }
    return new Promise((resolve2, reject) => {
      let secondaryTimer;
      const forceTimer = setTimeout(
        () => {
          server.closeAllConnections();
          secondaryTimer = setTimeout(() => {
            reject(new Error("The serve listener did not confirm shutdown."));
          }, SECONDARY_CLOSE_TIMEOUT_MS);
          secondaryTimer.unref();
        },
        Math.max(0, timeoutMs)
      );
      forceTimer.unref();
      server.close((error) => {
        clearTimeout(forceTimer);
        if (secondaryTimer) clearTimeout(secondaryTimer);
        if (error) reject(error);
        else {
          this.listenerClosed = true;
          resolve2();
        }
      });
    });
  }
  waitForClosingListener(server, timeoutMs) {
    return new Promise((resolve2, reject) => {
      let secondaryTimer;
      const onClose = /* @__PURE__ */ __name(() => {
        server.off("close", onClose);
        clearTimeout(forceTimer);
        if (secondaryTimer) clearTimeout(secondaryTimer);
        this.listenerClosed = true;
        resolve2();
      }, "onClose");
      const forceTimer = setTimeout(
        () => {
          server.closeAllConnections();
          secondaryTimer = setTimeout(() => {
            server.off("close", onClose);
            reject(new Error("The serve listener did not confirm shutdown."));
          }, SECONDARY_CLOSE_TIMEOUT_MS);
          secondaryTimer.unref();
        },
        Math.max(0, timeoutMs)
      );
      forceTimer.unref();
      server.once("close", onClose);
      if (this.listenerClosed) onClose();
    });
  }
};
function installServeAppLifecycle(app, lifecycle = new ServeAppLifecycleController()) {
  const locals = app.locals;
  if (locals[SERVE_APP_LIFECYCLE]) {
    throw new Error("Serve app lifecycle is already installed.");
  }
  locals[SERVE_APP_LIFECYCLE] = lifecycle;
  return lifecycle;
}
__name(installServeAppLifecycle, "installServeAppLifecycle");

// packages/cli/src/serve/rate-limit.ts
init_esbuild_shims();
var MAX_BUCKETS = 1e4;
var GC_REQUEST_INTERVAL = 1e3;
var GC_TIMER_INTERVAL_MS = 5 * 60 * 1e3;
var WORKSPACE_QUALIFIED_ACP_PATH = /^\/workspaces\/[^/]+\/acp$/i;
function resolveTier(method, path, workspaceQualifiedAcpEnabled) {
  const p = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  if (method === "OPTIONS") return null;
  if ((method === "GET" || method === "HEAD") && p === "/health") return null;
  if (method === "POST" && p.startsWith("/session/") && p.endsWith("/heartbeat"))
    return null;
  if (method === "GET" && p.startsWith("/session/") && p.endsWith("/events"))
    return null;
  if (p === "/acp" || p.startsWith("/acp/")) return null;
  if (workspaceQualifiedAcpEnabled && WORKSPACE_QUALIFIED_ACP_PATH.test(p))
    return null;
  if (method === "POST" && p.startsWith("/session/") && p.endsWith("/prompt"))
    return "prompt";
  if (method !== "GET" && method !== "HEAD") return "mutation";
  return "read";
}
__name(resolveTier, "resolveTier");
function normalizeIp(raw) {
  if (raw.startsWith("::ffff:")) {
    return raw.slice(7);
  }
  return raw;
}
__name(normalizeIp, "normalizeIp");
function createKeyExtractor(hostname) {
  const loopback = isLoopbackBind(hostname);
  return (req) => {
    const raw = req.get("x-qwen-client-id");
    const clientId = raw && raw.length <= MAX_CLIENT_ID_LENGTH && CLIENT_ID_RE.test(raw) ? raw : void 0;
    if (loopback) {
      return clientId ? `cid:${clientId}` : "anonymous";
    }
    const ip = normalizeIp(req.socket?.remoteAddress ?? "unknown");
    return clientId ? `${ip}:${clientId}` : ip;
  };
}
__name(createKeyExtractor, "createKeyExtractor");
var LOG_SAMPLE_INTERVAL = 100;
function createSampledLogger(onLog) {
  const state = /* @__PURE__ */ new Map();
  return {
    log(tier, key) {
      const logKey = `${tier}:${key}`;
      let entry = state.get(logKey);
      if (!entry) {
        entry = { count: 0, suppressed: 0 };
        state.set(logKey, entry);
      }
      entry.count++;
      if (entry.count === 1 || entry.count % LOG_SAMPLE_INTERVAL === 0) {
        onLog(tier, key, entry.suppressed);
        entry.suppressed = 0;
      } else {
        entry.suppressed++;
      }
    },
    clear() {
      state.clear();
    }
  };
}
__name(createSampledLogger, "createSampledLogger");
function createRateLimiter(config) {
  for (const [tier, cfg] of Object.entries(config.tiers)) {
    if (!Number.isFinite(cfg.max) || cfg.max <= 0) {
      throw new Error(
        `rate limit: ${tier}.max must be a positive number, got ${cfg.max}`
      );
    }
    if (!Number.isFinite(cfg.windowMs) || cfg.windowMs <= 0) {
      throw new Error(
        `rate limit: ${tier}.windowMs must be a positive number, got ${cfg.windowMs}`
      );
    }
  }
  const buckets = /* @__PURE__ */ new Map();
  const keyExtractor = createKeyExtractor(config.hostname);
  const hitCounts = {
    prompt: 0,
    mutation: 0,
    read: 0
  };
  const rates = {
    prompt: config.tiers.prompt.max / config.tiers.prompt.windowMs,
    mutation: config.tiers.mutation.max / config.tiers.mutation.windowMs,
    read: config.tiers.read.max / config.tiers.read.windowMs
  };
  let draining = false;
  let requestCount = 0;
  const sampledLog = config.onLimitReached ? createSampledLogger(config.onLimitReached) : void 0;
  function sweep() {
    const now = Date.now();
    for (const [key, tierMap] of buckets) {
      let allStale = true;
      for (const [tier, bucket] of tierMap) {
        if (now - bucket.lastRefill < config.tiers[tier].windowMs * 2) {
          allStale = false;
          break;
        }
      }
      if (allStale) {
        buckets.delete(key);
      }
    }
  }
  __name(sweep, "sweep");
  const gcTimer = setInterval(sweep, GC_TIMER_INTERVAL_MS);
  gcTimer.unref();
  const middleware = /* @__PURE__ */ __name((req, res, next) => {
    try {
      if (draining) {
        next();
        return;
      }
      const tier = resolveTier(
        req.method,
        req.path,
        config.workspaceQualifiedAcpEnabled === true
      );
      if (tier === null) {
        next();
        return;
      }
      requestCount++;
      if (requestCount % GC_REQUEST_INTERVAL === 0) {
        sweep();
      }
      const key = keyExtractor(req);
      if (tryConsume(key, tier)) {
        next();
      } else {
        const tierConfig = config.tiers[tier];
        const rate = rates[tier];
        const bucket = buckets.get(key)?.get(tier);
        const retryAfterMs = Math.ceil((1 - (bucket?.tokens ?? 0)) / rate);
        const retryAfterSec = Math.ceil(retryAfterMs / 1e3);
        res.setHeader("Retry-After", String(retryAfterSec));
        res.setHeader("X-RateLimit-Limit", String(tierConfig.max));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader(
          "X-RateLimit-Reset",
          String(Math.ceil((Date.now() + retryAfterMs) / 1e3))
        );
        res.status(429).json({
          error: "Rate limit exceeded",
          code: "rate_limit_exceeded",
          tier,
          retryAfterMs
        });
      }
    } catch (err) {
      config.onError?.(err, req.path);
      next();
    }
  }, "middleware");
  function tryConsume(key, tier) {
    if (draining) return true;
    const tierConfig = config.tiers[tier];
    const rate = rates[tier];
    const now = Date.now();
    let tierMap = buckets.get(key);
    if (!tierMap) {
      if (buckets.size >= MAX_BUCKETS) {
        config.onError?.(
          new Error(`rate limit bucket overflow: ${buckets.size} keys`),
          `tryConsume:${tier}`
        );
        return true;
      }
      tierMap = /* @__PURE__ */ new Map();
      buckets.set(key, tierMap);
    }
    let bucket = tierMap.get(tier);
    if (!bucket) {
      bucket = { tokens: tierConfig.max, lastRefill: now };
      tierMap.set(tier, bucket);
    }
    const elapsed = Math.max(0, now - bucket.lastRefill);
    bucket.tokens = Math.min(tierConfig.max, bucket.tokens + elapsed * rate);
    bucket.lastRefill = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    hitCounts[tier]++;
    if (sampledLog) sampledLog.log(tier, key);
    return false;
  }
  __name(tryConsume, "tryConsume");
  return {
    middleware,
    checkRate: tryConsume,
    reset() {
      buckets.clear();
      hitCounts.prompt = 0;
      hitCounts.mutation = 0;
      hitCounts.read = 0;
      requestCount = 0;
      sampledLog?.clear();
    },
    setDraining(v) {
      draining = v;
    },
    dispose() {
      clearInterval(gcTimer);
      buckets.clear();
      sampledLog?.clear();
    },
    getHitCounts() {
      return { ...hitCounts };
    }
  };
}
__name(createRateLimiter, "createRateLimiter");
var RATE_LIMITER_KEY = "_rateLimiter";
function setRateLimiter(app, limiter) {
  app.locals[RATE_LIMITER_KEY] = limiter;
}
__name(setRateLimiter, "setRateLimiter");
function getRateLimiter(app) {
  return app.locals[RATE_LIMITER_KEY];
}
__name(getRateLimiter, "getRateLimiter");

// packages/cli/src/serve/acp-http-enabled.ts
init_esbuild_shims();
function resolveAcpHttpEnabled(env = process.env) {
  return env["QWEN_SERVE_ACP_HTTP"] !== "0";
}
__name(resolveAcpHttpEnabled, "resolveAcpHttpEnabled");

// packages/cli/src/serve/daemon-status.ts
init_esbuild_shims();

// packages/cli/src/serve/acp-http/pre-attach-budget.ts
init_esbuild_shims();
var ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM = 256;
var ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION = 1024;
var ACP_PRE_ATTACH_MAX_FRAMES_GLOBAL = 4096;
var ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION = 64 * 1024 * 1024;
var ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_GLOBAL = 256 * 1024 * 1024;
var AcpPreAttachBudget = class {
  constructor(limits = {
    maxFrames: ACP_PRE_ATTACH_MAX_FRAMES_GLOBAL,
    maxBytes: ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_GLOBAL
  }) {
    this.limits = limits;
  }
  static {
    __name(this, "AcpPreAttachBudget");
  }
  usedFrames = 0;
  usedBytes = 0;
  pendingDeliveryFrames = 0;
  highWaterFrames = 0;
  highWaterBytes = 0;
  guardFailures = 0;
  tryReserve(bytes) {
    if (this.usedFrames >= this.limits.maxFrames || bytes > this.limits.maxBytes - this.usedBytes) {
      this.guardFailures += 1;
      return void 0;
    }
    this.usedFrames += 1;
    this.usedBytes += bytes;
    this.highWaterFrames = Math.max(this.highWaterFrames, this.usedFrames);
    this.highWaterBytes = Math.max(this.highWaterBytes, this.usedBytes);
    let released = false;
    let pendingDelivery = false;
    return {
      markPendingDelivery: /* @__PURE__ */ __name(() => {
        if (released || pendingDelivery) return;
        pendingDelivery = true;
        this.pendingDeliveryFrames += 1;
      }, "markPendingDelivery"),
      release: /* @__PURE__ */ __name(() => {
        if (released) return;
        released = true;
        if (pendingDelivery) this.pendingDeliveryFrames -= 1;
        this.usedFrames -= 1;
        this.usedBytes -= bytes;
      }, "release")
    };
  }
  recordGuardFailure() {
    this.guardFailures += 1;
  }
  snapshot() {
    return {
      usedFrames: this.usedFrames,
      usedBytes: this.usedBytes,
      pendingDeliveryFrames: this.pendingDeliveryFrames,
      highWaterFrames: this.highWaterFrames,
      highWaterBytes: this.highWaterBytes,
      guardFailures: this.guardFailures
    };
  }
};

// packages/cli/src/serve/daemon-memory-pressure.ts
init_esbuild_shims();
import { getHeapStatistics } from "node:v8";
var SOFT_PRESSURE_RATIO = 0.5;
var HARD_PRESSURE_RATIO = 0.65;
var CRITICAL_PRESSURE_RATIO = 0.8;
function classify(ratio) {
  if (ratio >= CRITICAL_PRESSURE_RATIO) return "critical";
  if (ratio >= HARD_PRESSURE_RATIO) return "hard";
  if (ratio >= SOFT_PRESSURE_RATIO) return "soft";
  return "normal";
}
__name(classify, "classify");
function computeDaemonMemoryPressure(input) {
  const heapLimitBytes = usableDenominator(
    input.heapLimitBytes ?? getHeapStatistics().heap_size_limit
  );
  const availableBytes = usableDenominator(input.availableBytes);
  const rss = usableNumerator(input.rssBytes);
  const heapUsed = usableNumerator(input.heapUsedBytes);
  const rssBytes = rss ?? 0;
  const heapUsedBytes = heapUsed ?? 0;
  const rssMeasured = availableBytes > 0 && rss !== null;
  const heapMeasured = heapLimitBytes > 0 && heapUsed !== null;
  const rssRatio = rssMeasured ? rssBytes / availableBytes : 0;
  const heapRatio = heapMeasured ? heapUsedBytes / heapLimitBytes : 0;
  let source;
  if (!rssMeasured && !heapMeasured) source = "unknown";
  else if (!heapMeasured) source = "rss";
  else if (!rssMeasured) source = "heap";
  else source = rssRatio >= heapRatio ? "rss" : "heap";
  const ratio = Math.max(rssRatio, heapRatio);
  return {
    level: classify(ratio),
    ratio,
    source,
    rssBytes,
    rssRatio,
    availableBytes,
    heapUsedBytes,
    heapRatio,
    heapLimitBytes
  };
}
__name(computeDaemonMemoryPressure, "computeDaemonMemoryPressure");
function usableDenominator(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
__name(usableDenominator, "usableDenominator");
function usableNumerator(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}
__name(usableNumerator, "usableNumerator");

// packages/cli/src/serve/daemon-status.ts
var DEFAULT_LISTENER_MAX_CONNECTIONS = 256;
var SECTION_TIMEOUT_MS = 1e3;
var CAPACITY_WARNING_RATIO = 0.8;
function toDaemonStatusMemoryLimits(budget, childHeap, journalGrowth, admissionEnforced = false) {
  if (!budget) return null;
  return {
    enforced: false,
    journalGrowth: journalGrowth ?? null,
    childHeap: childHeap ? {
      mode: childHeap.mode,
      admissionEnforced,
      maxConcurrentChildren: childHeap.maxConcurrentChildren,
      perChildCeilingMb: childHeap.perChildCeilingMb,
      refusals: childHeap.refusals
    } : null,
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
      legacyChildCeilingMb: budget.legacyChildCeilingMb
    }
  };
}
__name(toDaemonStatusMemoryLimits, "toDaemonStatusMemoryLimits");
var SectionTimeoutError = class extends Error {
  constructor(section, timeoutMs) {
    super(`${section} status timed out after ${timeoutMs}ms`);
    this.section = section;
    this.timeoutMs = timeoutMs;
    this.name = "SectionTimeoutError";
  }
  static {
    __name(this, "SectionTimeoutError");
  }
};
function parseDaemonStatusDetail(raw) {
  if (raw === void 0) return { ok: true, detail: "summary" };
  if (raw === "summary" || raw === "full") {
    return { ok: true, detail: raw };
  }
  return { ok: false };
}
__name(parseDaemonStatusDetail, "parseDaemonStatusDetail");
async function buildDaemonStatusResponse(detail, input) {
  const daemonLogStatus = input.daemonLog?.getStatus();
  const bridgeSnapshot = input.bridge.getDaemonStatusSnapshot();
  const lastActivity = input.bridge.lastActivityAt ?? null;
  const workspaceRuntimes = input.workspaceRegistry?.list();
  const aggregateRuntimes = input.workspaceRegistry?.listAll?.() ?? workspaceRuntimes;
  const workspaceSnapshots = aggregateRuntimes?.map((runtime) => ({
    workspaceCwd: runtime.workspaceCwd,
    internal: isInternalWorkspaceRuntime(runtime),
    snapshot: runtime.bridge === input.bridge ? bridgeSnapshot : runtime.bridge.getDaemonStatusSnapshot(),
    lastActivity: runtime.bridge === input.bridge ? lastActivity : runtime.bridge.lastActivityAt ?? null
  })) ?? [
    {
      workspaceCwd: input.boundWorkspace,
      snapshot: bridgeSnapshot,
      lastActivity
    }
  ];
  const aggregatedSessionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.sessionCount,
    0
  );
  const aggregatedPendingPermissionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.pendingPermissionCount,
    0
  );
  const aggregatedChannelLive = workspaceSnapshots.some(
    (item) => item.snapshot.channelLive
  );
  const memoryBudget = input.opts.daemonMemoryBudget;
  let runtimeMemory;
  if (memoryBudget) {
    const managedRuntimes = input.workspaceRegistry?.listManaged();
    const activeAcpChildCount = managedRuntimes ? managedRuntimes.filter((runtime) => runtime.bridge.isChannelLive()).length : workspaceSnapshots.filter((item) => item.snapshot.channelLive).length;
    const registeredWorkspaceCount = input.workspaceRegistry ? (input.workspaceRegistry.listAllEntries?.() ?? input.workspaceRegistry.listEntries()).length : workspaceSnapshots.length;
    let childRssBytesTotal = 0;
    let childRssSampled = 0;
    let oldestChildReadingAgeMs = null;
    let heapReported = 0;
    let peakOldGenerationBytes = 0;
    let peakLiveSetBytes = 0;
    let peakTotalHeapBytes = 0;
    let heapMajorGcCount = 0;
    let heapMajorGcMs = 0;
    const heapUnclassified = /* @__PURE__ */ new Set();
    for (const runtime of managedRuntimes ?? []) {
      if (!runtime.bridge.isChannelLive()) continue;
      const snapshot = runtime.bridge.getChildResourceSnapshot?.();
      if (!snapshot) continue;
      childRssBytesTotal += snapshot.rssBytes;
      childRssSampled += 1;
      if (snapshot.ageMs !== void 0) {
        oldestChildReadingAgeMs = Math.max(
          oldestChildReadingAgeMs ?? 0,
          snapshot.ageMs
        );
      }
      const heap = snapshot.heap;
      if (!heap) continue;
      heapReported += 1;
      peakOldGenerationBytes = Math.max(
        peakOldGenerationBytes,
        heap.peakOldGenerationBytes
      );
      peakLiveSetBytes = Math.max(peakLiveSetBytes, heap.peakLiveSetBytes);
      peakTotalHeapBytes = Math.max(
        peakTotalHeapBytes,
        heap.peakTotalHeapBytes
      );
      heapMajorGcCount = Math.max(heapMajorGcCount, heap.majorGcCount);
      heapMajorGcMs = Math.max(heapMajorGcMs, heap.majorGcMs);
      for (const name of heap.unclassifiedSpaceNames) {
        heapUnclassified.add(name);
      }
    }
    const pressureMode = input.opts.memoryPressureMode ?? "observe";
    const pressureMemory = process.memoryUsage();
    runtimeMemory = {
      registeredWorkspaces: registeredWorkspaceCount,
      activeAcpChildren: activeAcpChildCount,
      committedAcpChildren: input.getCommittedAcpChildCount?.() ?? null,
      childRssCoverage: "active_children",
      children: {
        rssBytes: childRssBytesTotal,
        sampled: childRssSampled,
        oldestReadingAgeMs: oldestChildReadingAgeMs,
        // `null` on zero reporters, so an unmeasured daemon never publishes a
        // zeroed object that reads as "no child needs any heap".
        heap: heapReported > 0 ? {
          peakOldGenerationBytes,
          peakLiveSetBytes,
          peakTotalHeapBytes,
          majorGcCount: heapMajorGcCount,
          majorGcMs: heapMajorGcMs,
          unclassifiedSpaceNames: [...heapUnclassified],
          reported: heapReported
        } : null
      },
      modeled: {
        recommendedShareAtRegisteredMb: registeredWorkspaceCount > 0 ? recommendedChildShareMb(memoryBudget, registeredWorkspaceCount) : null,
        recommendedShareAtActiveMb: activeAcpChildCount > 0 ? recommendedChildShareMb(memoryBudget, activeAcpChildCount) : null
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
          availableBytes: memoryBudget.availableMemoryMb * 1024 * 1024
        }),
        // After the spread, so the flag stays authoritative if the computed
        // shape ever grows a field of this name.
        mode: pressureMode
      }
    };
  }
  const aggregatedLastActivity = workspaceSnapshots.reduce(
    (latest, item) => item.lastActivity !== null && (latest === null || item.lastActivity > latest) ? item.lastActivity : latest,
    null
  );
  const acpSnapshot = input.acpHandle?.registry.getSnapshot();
  const acpAggregate = input.acpHandle?.getSnapshot();
  const rateLimitHits = input.rateLimiter?.getHitCounts() ?? zeroRateHits();
  let pendingPrompts = 0;
  let derivedQueuedPrompts = 0;
  const derivedQueuedPromptsByWorkspace = [];
  for (const [index, { snapshot }] of workspaceSnapshots.entries()) {
    let derivedQueuedPromptsForWorkspace = 0;
    for (const session of snapshot.sessions) {
      pendingPrompts += session.pendingPromptCount;
      const sessionQueuedPrompts = Math.max(
        0,
        session.pendingPromptCount - (session.hasActivePrompt ? 1 : 0)
      );
      derivedQueuedPrompts += sessionQueuedPrompts;
      derivedQueuedPromptsForWorkspace += sessionQueuedPrompts;
    }
    derivedQueuedPromptsByWorkspace[index] = derivedQueuedPromptsForWorkspace;
  }
  const queuedPrompts = aggregateRuntimes?.reduce(
    (sum, runtime, index) => sum + (runtime.bridge.pendingPromptTotal ?? derivedQueuedPromptsByWorkspace[index] ?? 0),
    0
  ) ?? input.bridge.pendingPromptTotal ?? derivedQueuedPrompts;
  const channelWorker = input.getChannelWorkerSnapshot?.() ?? {
    enabled: false,
    state: "disabled",
    channels: []
  };
  const channelWorkers = (workspaceRuntimes?.length ?? 1) > 1 ? input.getChannelWorkerSnapshots?.() : void 0;
  const totalAdmissionSnapshot = input.getTotalSessionAdmissionSnapshot?.();
  const issues = [];
  let full;
  pushRuntimeIssues(
    issues,
    acpSnapshot,
    acpAggregate,
    rateLimitHits,
    input,
    channelWorker,
    channelWorkers,
    totalAdmissionSnapshot,
    workspaceSnapshots
  );
  if (runtimeMemory && runtimeMemory.pressure.mode === "observe" && runtimeMemory.pressure.level !== "normal") {
    const { level, ratio, source } = runtimeMemory.pressure;
    issues.push({
      code: "daemon_memory_pressure",
      // `warning` at every level, including `critical`. An `error` severity
      // makes `rollupStatus` return `error` for the whole daemon, which is a
      // strong claim to stake on thresholds borrowed from an interactive-CLI
      // monitor and not yet calibrated here. The level itself is reported in
      // `runtime.memory.pressure`, so nothing is lost by keeping the rollup
      // at `warning` until the numbers have been checked against real
      // deployments — which is what this phase is for.
      severity: "warning",
      // Name the denominator, not the numerator: "% of the rss limit" would
      // call the measured value a limit. `section` is omitted because every
      // other use of it names a workspace status section, and this is a
      // daemon-level concern — the same reason `daemon_log_degraded` omits it.
      // One decimal, not zero: at 0 decimals a ratio of 0.795 rounds to "80%"
      // while `level` still reads `hard`, and 80% is critical's documented
      // threshold. An oncall engineer comparing the two sees a contradiction
      // in the one feature whose whole purpose is trustworthy triage.
      message: `Daemon memory pressure is ${level} at ${(ratio * 100).toFixed(1)}% of ${source === "heap" ? "the V8 heap limit" : "available memory"}.`
    });
  }
  if (daemonLogStatus?.health === "degraded") {
    issues.push({
      code: "daemon_log_degraded",
      severity: "warning",
      message: "Daemon file logging is degraded; inspect full status for details."
    });
  }
  if (detail === "full") {
    full = await buildFullStatus(
      input,
      acpAggregate,
      workspaceSnapshots.filter((item) => item.internal !== true).flatMap((item) => item.snapshot.sessions)
    );
    pushFullIssues(issues, full);
  }
  return {
    v: 1,
    detail,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: rollupStatus(issues),
    issues,
    daemon: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1e3),
      mode: input.opts.mode,
      workspaceCwd: input.boundWorkspace,
      ...input.startup ? { startup: cloneStartup(input.startup) } : {},
      ...input.qwenCodeVersion ? { qwenCodeVersion: input.qwenCodeVersion } : {},
      ...input.daemonLog?.getDaemonId() ? { daemonId: input.daemonLog.getDaemonId() } : {},
      ...daemonLogStatus ? {
        runId: daemonLogStatus.runId,
        logMode: daemonLogStatus.mode,
        logHealth: daemonLogStatus.health
      } : {},
      ...detail === "full" && input.daemonLog?.getLogPath() ? { logPath: input.daemonLog.getLogPath() } : {},
      ...detail === "full" && daemonLogStatus ? {
        logIssues: daemonLogStatus.issues,
        logDroppedRecords: daemonLogStatus.droppedRecords,
        logDroppedBytes: daemonLogStatus.droppedBytes
      } : {}
    },
    security: {
      tokenConfigured: Boolean(input.opts.token),
      requireAuth: input.opts.requireAuth === true,
      loopbackBind: isLoopbackBind(input.opts.hostname),
      allowOriginConfigured: input.opts.allowOrigins !== void 0 && input.opts.allowOrigins.length > 0,
      allowOriginMode: allowOriginMode(input.opts.allowOrigins),
      sessionShellCommandEnabled: input.sessionShellCommandEnabled
    },
    limits: {
      maxRegisteredWorkspaces: input.opts.maxRegisteredWorkspaces ?? MAX_REGISTERED_WORKSPACES,
      ...input.maxChannelControlWorkspaces !== void 0 ? { maxChannelControlWorkspaces: input.maxChannelControlWorkspaces } : {},
      maxSessions: bridgeSnapshot.limits.maxSessions,
      maxTotalSessions: positiveFiniteOrNull(input.opts.maxTotalSessions),
      maxPendingPromptsPerSession: bridgeSnapshot.limits.maxPendingPromptsPerSession,
      listenerMaxConnections: listenerMaxConnections(input.opts.maxConnections),
      eventRingSize: bridgeSnapshot.limits.eventRingSize,
      compactedReplayMaxBytes: bridgeSnapshot.limits.compactedReplayMaxBytes,
      maxJournalEvents: bridgeSnapshot.limits.maxJournalEvents,
      maxJournalBytes: bridgeSnapshot.limits.maxJournalBytes,
      promptDeadlineMs: positiveFiniteOrNull(input.opts.promptDeadlineMs),
      writerIdleTimeoutMs: positiveFiniteOrNull(input.opts.writerIdleTimeoutMs),
      channelIdleTimeoutMs: bridgeSnapshot.limits.channelIdleTimeoutMs,
      sessionIdleTimeoutMs: bridgeSnapshot.limits.sessionIdleTimeoutMs,
      sessionPromptSettledCloseGraceMs: bridgeSnapshot.limits.sessionPromptSettledCloseGraceMs,
      acpConnectionCap: acpSnapshot?.connectionCap ?? null,
      acpPreAttachMaxFramesPerStream: acpSnapshot !== void 0 ? ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM : null,
      acpPreAttachMaxFramesPerConnection: acpSnapshot !== void 0 ? ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION : null,
      acpPreAttachMaxFramesGlobal: acpSnapshot !== void 0 ? ACP_PRE_ATTACH_MAX_FRAMES_GLOBAL : null,
      acpPreAttachMaxPayloadBytesPerConnection: acpSnapshot !== void 0 ? ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION : null,
      acpPreAttachMaxPayloadBytesGlobal: acpSnapshot !== void 0 ? ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_GLOBAL : null,
      memory: toDaemonStatusMemoryLimits(
        memoryBudget,
        input.getChildHeapPolicySnapshot?.(),
        bridgeSnapshot.limits.journalGrowth ? {
          ...bridgeSnapshot.limits.journalGrowth,
          baselineMaxEvents: bridgeSnapshot.limits.maxJournalEvents,
          baselineMaxBytes: bridgeSnapshot.limits.maxJournalBytes
        } : null,
        input.childAdmissionEnforced
      )
    },
    ...workspaceRuntimes && workspaceRuntimes.length > 1 ? {
      workspaces: workspaceRuntimes.map((runtime) => ({
        id: runtime.workspaceId,
        cwd: runtime.workspaceCwd,
        ...runtime.displayName !== void 0 ? { displayName: runtime.displayName } : {},
        primary: runtime.primary,
        trusted: runtime.trusted
      }))
    } : {},
    capabilities: {
      protocolVersions: input.protocolVersions,
      features: [...input.features]
    },
    runtime: {
      sessions: {
        active: aggregatedSessionCount,
        ...totalAdmissionSnapshot ? { admissionInFlight: totalAdmissionSnapshot.inFlight } : {}
      },
      permissions: {
        pending: aggregatedPendingPermissionCount,
        policy: bridgeSnapshot.permissionPolicy
      },
      channel: { live: aggregatedChannelLive },
      channelWorker,
      ...channelWorkers && channelWorkers.length > 0 ? { channelWorkers } : {},
      transport: {
        restSseActive: input.getRestSseActive(),
        acp: {
          enabled: acpSnapshot !== void 0,
          connections: acpAggregate?.connectionCount ?? 0,
          connectionStreams: acpAggregate?.connectionStreams ?? 0,
          sessionStreams: acpAggregate?.sessionStreams ?? 0,
          sseStreams: acpAggregate?.sseStreams ?? 0,
          wsStreams: acpAggregate?.wsStreams ?? 0,
          pendingClientRequests: acpAggregate?.pendingClientRequests ?? 0,
          preAttach: {
            bufferedConnectionFrames: acpAggregate?.bufferedConnectionFrames ?? 0,
            bufferedSessionFrames: acpAggregate?.bufferedSessionFrames ?? 0,
            pendingDeliveryFrames: acpAggregate?.pendingDeliveryFrames ?? 0,
            usedFrames: acpAggregate?.preAttach.usedFrames ?? 0,
            usedBytes: acpAggregate?.preAttach.usedBytes ?? 0,
            highWaterFrames: acpAggregate?.preAttach.highWaterFrames ?? 0,
            highWaterBytes: acpAggregate?.preAttach.highWaterBytes ?? 0,
            guardFailures: acpAggregate?.preAttach.guardFailures ?? 0
          }
        }
      },
      rateLimit: {
        enabled: input.opts.rateLimit === true,
        rejectedSinceStart: rateLimitHits
      },
      ...input.getPerfSnapshot ? { perf: input.getPerfSnapshot() } : {},
      ...input.getMetricsSeries ? { metrics: { series: input.getMetricsSeries() } } : {},
      activity: {
        activePrompts: aggregateRuntimes?.reduce(
          (sum, runtime) => sum + (runtime.bridge.activePromptCount ?? 0),
          0
        ) ?? input.bridge.activePromptCount ?? 0,
        pendingPrompts,
        queuedPrompts,
        lastActivityAt: aggregatedLastActivity !== null ? new Date(aggregatedLastActivity).toISOString() : null,
        idleSinceMs: aggregatedLastActivity !== null ? Date.now() - aggregatedLastActivity : null
      },
      ...runtimeMemory ? { memory: runtimeMemory } : {},
      process: process.memoryUsage()
    },
    ...full ? { full } : {}
  };
}
__name(buildDaemonStatusResponse, "buildDaemonStatusResponse");
function cloneStartup(startup) {
  return {
    processStartedAt: startup.processStartedAt,
    ...startup.listenerReadyAt ? { listenerReadyAt: startup.listenerReadyAt } : {},
    ...startup.processToListenMs !== void 0 ? { processToListenMs: startup.processToListenMs } : {},
    ...startup.runQwenServeToListenMs !== void 0 ? { runQwenServeToListenMs: startup.runQwenServeToListenMs } : {},
    preheat: {
      status: startup.preheat.status,
      ...startup.preheat.durationMs !== void 0 ? { durationMs: startup.preheat.durationMs } : {},
      ...startup.preheat.error ? { error: startup.preheat.error } : {}
    }
  };
}
__name(cloneStartup, "cloneStartup");
async function buildFullStatus(input, acpSnapshot, sessions) {
  const ctx = {
    route: "GET /daemon/status",
    workspaceCwd: input.boundWorkspace
  };
  const [mcp, skills, tools, providers, env, preflight, hooks, extensions] = await Promise.all([
    collectSection(
      "workspace.mcp",
      () => input.workspace.getWorkspaceMcpStatus(ctx)
    ),
    collectSection(
      "workspace.skills",
      () => input.workspace.getWorkspaceSkillsStatus(ctx)
    ),
    collectSection(
      "workspace.tools",
      () => input.bridge.getWorkspaceToolsStatus()
    ),
    collectSection(
      "workspace.providers",
      () => input.workspace.getWorkspaceProvidersStatus(ctx)
    ),
    collectSection(
      "workspace.env",
      () => input.workspace.getWorkspaceEnvStatus(ctx)
    ),
    collectSection(
      "workspace.preflight",
      () => input.workspace.getWorkspacePreflightStatus(ctx)
    ),
    collectSection(
      "workspace.hooks",
      () => input.workspace.getWorkspaceHooksStatus(ctx)
    ),
    collectSection(
      "workspace.extensions",
      () => input.workspace.getWorkspaceExtensionsStatus(ctx)
    )
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
      extensions
    },
    auth: {
      supportedDeviceFlowProviders: [...input.supportedDeviceFlowProviders],
      pendingDeviceFlowCount: input.deviceFlowRegistry.listPending().length
    }
  };
}
__name(buildFullStatus, "buildFullStatus");
async function collectSection(name, read) {
  const startMs = Date.now();
  try {
    const data = await withTimeout(read(), name, SECTION_TIMEOUT_MS);
    return {
      status: inferSectionStatus(data),
      durationMs: Date.now() - startMs,
      summary: summarizeStatusData(data),
      data
    };
  } catch (err) {
    return {
      status: "unavailable",
      durationMs: Date.now() - startMs,
      error: {
        kind: err instanceof SectionTimeoutError ? "timeout" : "error",
        message: err instanceof Error ? err.message : String(err)
      }
    };
  }
}
__name(collectSection, "collectSection");
async function withTimeout(promise, section, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SectionTimeoutError(section, timeoutMs)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
__name(withTimeout, "withTimeout");
function pushRuntimeIssues(issues, acpSnapshot, acpAggregate, rateLimitHits, input, channelWorker, channelWorkers, totalAdmissionSnapshot, workspaceSnapshots) {
  for (const { workspaceCwd, internal, snapshot } of workspaceSnapshots) {
    if (snapshot.limits.maxSessions !== null && snapshot.limits.maxSessions > 0 && snapshot.sessionCount / snapshot.limits.maxSessions >= CAPACITY_WARNING_RATIO) {
      issues.push({
        code: "session_capacity_high",
        severity: "warning",
        message: workspaceSnapshots.length > 1 ? internal ? `An internal runtime's active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.` : `Workspace ${workspaceCwd} active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.` : `Active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.`
      });
    }
  }
  const maxTotalSessions = positiveFiniteOrNull(input.opts.maxTotalSessions);
  if (maxTotalSessions !== null) {
    const fallbackLiveCount = workspaceSnapshots.reduce(
      (sum, item) => sum + item.snapshot.sessionCount,
      0
    );
    const totalActive = (totalAdmissionSnapshot?.liveCount ?? fallbackLiveCount) + (totalAdmissionSnapshot?.inFlight ?? 0);
    if (totalActive / maxTotalSessions >= CAPACITY_WARNING_RATIO) {
      issues.push({
        code: "total_session_capacity_high",
        severity: "warning",
        message: `Total active and in-flight sessions are at ${totalActive}/${maxTotalSessions}.`
      });
    }
  }
  if (acpSnapshot !== void 0 && acpSnapshot.connectionCap !== null && acpSnapshot.connectionCap > 0) {
    const cap = acpSnapshot.connectionCap;
    const busiest = (acpAggregate?.mounts ?? []).reduce(
      (max, m) => Math.max(max, m.connectionCount),
      acpSnapshot.connectionCount
    );
    if (busiest / cap >= CAPACITY_WARNING_RATIO) {
      issues.push({
        code: "connection_capacity_high",
        severity: "warning",
        message: `ACP connections are at ${busiest}/${cap} on the busiest workspace mount.`
      });
    }
  }
  const pendingPermissionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.pendingPermissionCount,
    0
  );
  if (pendingPermissionCount > 0) {
    issues.push({
      code: "pending_permissions",
      severity: "warning",
      message: `${pendingPermissionCount} permission request(s) are pending.`
    });
  }
  const downWorkspaces = workspaceSnapshots.filter(
    (item) => item.snapshot.sessionCount > 0 && !item.snapshot.channelLive
  );
  if (downWorkspaces.length > 0) {
    issues.push({
      code: "acp_channel_down",
      severity: "error",
      message: downWorkspaces.length === 1 ? downWorkspaces[0].internal ? "Active sessions exist but the ACP channel is not live for an internal runtime." : `Active sessions exist but the ACP channel is not live for ${downWorkspaces[0].workspaceCwd}.` : `Active sessions exist but the ACP channel is not live for ${downWorkspaces.length} workspace(s).`
    });
  }
  if (input.opts.rateLimit === true && sumRateHits(rateLimitHits) > 0) {
    issues.push({
      code: "rate_limit_hits",
      severity: "warning",
      message: `${sumRateHits(rateLimitHits)} request(s) have been rejected by rate limiting since start.`
    });
  }
  const groupedWorkers = channelWorkers && channelWorkers.length > 0 ? channelWorkers : void 0;
  const workers = groupedWorkers ?? [channelWorker];
  for (const worker of workers) {
    pushChannelWorkerIssues(issues, worker, groupedWorkers !== void 0);
  }
}
__name(pushRuntimeIssues, "pushRuntimeIssues");
function pushChannelWorkerIssues(issues, channelWorker, grouped) {
  const workspace = "workspaceCwd" in channelWorker ? ` for workspace ${channelWorker.workspaceCwd}` : "";
  const section = grouped ? "runtime.channelWorkers" : "runtime.channelWorker";
  if (channelWorker.enabled && (channelWorker.state === "exited" || channelWorker.state === "failed")) {
    const detailParts = [
      channelWorker.pid !== void 0 ? `pid=${channelWorker.pid}` : void 0,
      channelWorker.exitCode !== void 0 ? `code=${channelWorker.exitCode ?? "null"}` : void 0,
      channelWorker.signal ? `signal=${channelWorker.signal}` : void 0,
      channelWorker.restartCount !== void 0 ? `restarts=${channelWorker.restartCount}` : void 0,
      channelWorker.lastExitAt ? `lastExitAt=${channelWorker.lastExitAt}` : void 0,
      channelWorker.lastRestartAt ? `lastRestartAt=${channelWorker.lastRestartAt}` : void 0,
      channelWorker.nextRestartAt ? `nextRestartAt=${channelWorker.nextRestartAt}` : void 0,
      channelWorker.lastHeartbeatAt ? `lastHeartbeatAt=${channelWorker.lastHeartbeatAt}` : void 0,
      channelWorker.staleHeartbeatAt ? `staleHeartbeatAt=${channelWorker.staleHeartbeatAt}` : void 0
    ].filter(Boolean);
    const details = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
    const error = channelWorker.error ? `: ${channelWorker.error}` : "";
    const isPermanentFailure = channelWorker.state === "failed" && !channelWorker.nextRestartAt;
    issues.push({
      code: "channel_worker_exited",
      severity: isPermanentFailure ? "error" : "warning",
      message: `Channel worker${workspace} is ${channelWorker.state}${details}${error}.`,
      section
    });
  }
  if (channelWorker.enabled && channelWorker.state === "running" && channelWorker.requestedChannels !== void 0) {
    const connected = new Set(channelWorker.channels);
    const failed = channelWorker.requestedChannels.filter(
      (channel) => !connected.has(channel)
    );
    if (failed.length > 0) {
      issues.push({
        code: "channel_worker_partial_connect",
        severity: "warning",
        message: `Channel worker${workspace} connected ${channelWorker.channels.length}/${channelWorker.requestedChannels.length} channel(s). Failed: ${failed.join(", ")}.`,
        section
      });
    }
  }
}
__name(pushChannelWorkerIssues, "pushChannelWorkerIssues");
function pushFullIssues(issues, full) {
  for (const [name, section] of Object.entries(full.workspace)) {
    if (section.status === "unavailable") {
      issues.push({
        code: "workspace_status_unavailable",
        severity: "warning",
        section: name,
        message: `${name} status is unavailable.`
      });
    }
  }
  const preflight = full.workspace["preflight"];
  if (preflight && sectionHasStatus(preflight, "error")) {
    issues.push({
      code: "preflight_error",
      severity: "error",
      section: "preflight",
      message: "Workspace preflight reports an error."
    });
  }
  const mcp = full.workspace["mcp"];
  const mcpBudget = mcp ? inspectMcpBudget(mcp) : void 0;
  if (mcpBudget === "exhausted") {
    issues.push({
      code: "mcp_budget_exhausted",
      severity: "error",
      section: "mcp",
      message: "MCP client budget is exhausted."
    });
  } else if (mcpBudget === "warning") {
    issues.push({
      code: "mcp_budget_warning",
      severity: "warning",
      section: "mcp",
      message: "MCP client budget is near capacity."
    });
  }
}
__name(pushFullIssues, "pushFullIssues");
function inferSectionStatus(data) {
  const statuses = collectStatuses(data);
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warning")) return "warning";
  return "ok";
}
__name(inferSectionStatus, "inferSectionStatus");
function summarizeStatusData(data) {
  const summary = {};
  if (!isRecord(data)) return summary;
  copyBoolean(data, summary, "initialized");
  copyBoolean(data, summary, "acpChannelLive");
  copyString(data, summary, "discoveryState");
  copyString(data, summary, "budgetMode");
  copyNumber(data, summary, "clientCount");
  copyNumber(data, summary, "clientBudget");
  for (const key of [
    "cells",
    "errors",
    "servers",
    "budgets",
    "skills",
    "tools",
    "providers",
    "hooks",
    "extensions"
  ]) {
    const value = data[key];
    if (Array.isArray(value)) {
      summary[`${key}Count`] = value.length;
    }
  }
  summarizeMcpServers(data, summary);
  return summary;
}
__name(summarizeStatusData, "summarizeStatusData");
function summarizeMcpServers(data, summary) {
  const servers = data["servers"];
  if (!Array.isArray(servers)) return;
  let connected = 0;
  let errored = 0;
  let disabled = 0;
  for (const server of servers) {
    if (!isRecord(server)) continue;
    if (server["disabled"] === true) {
      disabled++;
    } else if (server["status"] === "error") {
      errored++;
    } else if (server["mcpStatus"] === "connected") {
      connected++;
    }
  }
  summary["serversConnected"] = connected;
  summary["serversErrored"] = errored;
  summary["serversDisabled"] = disabled;
}
__name(summarizeMcpServers, "summarizeMcpServers");
function collectStatuses(data) {
  const statuses = [];
  visitStatusContainers(data, (record) => {
    const status = record["status"];
    if (typeof status === "string") statuses.push(status);
  });
  return statuses;
}
__name(collectStatuses, "collectStatuses");
function sectionHasStatus(section, status) {
  return collectStatuses(section.data).includes(status);
}
__name(sectionHasStatus, "sectionHasStatus");
function inspectMcpBudget(section) {
  const data = section.data;
  if (!isRecord(data)) return void 0;
  const budgetIssue = inspectBudgetContainers(data);
  if (budgetIssue) return budgetIssue;
  const clientCount = numberValue(data["clientCount"]);
  const clientBudget = numberValue(data["clientBudget"]);
  if (clientCount !== void 0 && clientBudget !== void 0 && clientBudget > 0) {
    const ratio = clientCount / clientBudget;
    if (ratio >= 1) return "exhausted";
    if (ratio >= 0.75) return "warning";
  }
  return void 0;
}
__name(inspectMcpBudget, "inspectMcpBudget");
function inspectBudgetContainers(data) {
  let result;
  visitStatusContainers(data, (record) => {
    if (result === "exhausted") return;
    const errorKind = record["errorKind"];
    const disabledReason = record["disabledReason"];
    const status = record["status"];
    const kind = record["kind"];
    const refusedCount = numberValue(record["refusedCount"]);
    if (errorKind === "budget_exhausted" || disabledReason === "budget" || kind === "mcp_budget" && status === "error" || refusedCount !== void 0 && refusedCount > 0) {
      result = "exhausted";
      return;
    }
    if (kind === "mcp_budget" && status === "warning") {
      result = "warning";
    }
  });
  return result;
}
__name(inspectBudgetContainers, "inspectBudgetContainers");
function visitStatusContainers(data, visit) {
  if (!isRecord(data)) return;
  visit(data);
  for (const key of [
    "cells",
    "errors",
    "servers",
    "budgets",
    "skills",
    "tools",
    "providers",
    "hooks",
    "extensions"
  ]) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) visitStatusContainers(item, visit);
  }
}
__name(visitStatusContainers, "visitStatusContainers");
function rollupStatus(issues) {
  if (issues.some((issue) => issue.severity === "error")) return "error";
  if (issues.length > 0) return "warning";
  return "ok";
}
__name(rollupStatus, "rollupStatus");
function allowOriginMode(allowOrigins) {
  if (!allowOrigins || allowOrigins.length === 0) return "none";
  return allowOrigins.includes("*") ? "any" : "specific";
}
__name(allowOriginMode, "allowOriginMode");
function listenerMaxConnections(value) {
  if (value === void 0) return DEFAULT_LISTENER_MAX_CONNECTIONS;
  if (value === 0 || value === Infinity) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}
__name(listenerMaxConnections, "listenerMaxConnections");
function positiveFiniteOrNull(value) {
  return value !== void 0 && Number.isFinite(value) && value > 0 ? value : null;
}
__name(positiveFiniteOrNull, "positiveFiniteOrNull");
function zeroRateHits() {
  return { prompt: 0, mutation: 0, read: 0 };
}
__name(zeroRateHits, "zeroRateHits");
function sumRateHits(hits) {
  return hits.prompt + hits.mutation + hits.read;
}
__name(sumRateHits, "sumRateHits");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
__name(numberValue, "numberValue");
function copyBoolean(from, to, key) {
  const value = from[key];
  if (typeof value === "boolean") to[key] = value;
}
__name(copyBoolean, "copyBoolean");
function copyString(from, to, key) {
  const value = from[key];
  if (typeof value === "string") to[key] = value;
}
__name(copyString, "copyString");
function copyNumber(from, to, key) {
  const value = numberValue(from[key]);
  if (value !== void 0) to[key] = value;
}
__name(copyNumber, "copyNumber");

// packages/cli/src/serve/cdp-mcp-command.ts
init_esbuild_shims();
var QWEN_CDP_MCP_COMMAND_ENV = "QWEN_CDP_MCP_COMMAND";
function resolveCdpMcpCommand(env) {
  const command = env[QWEN_CDP_MCP_COMMAND_ENV]?.trim();
  return command ? command : void 0;
}
__name(resolveCdpMcpCommand, "resolveCdpMcpCommand");
function isBrowserAutomationMcpAvailable(opts, env) {
  return opts.cdpTunnelOverWs === true && !opts.token && resolveAcpHttpEnabled(env) && resolveCdpMcpCommand(env) !== void 0;
}
__name(isBrowserAutomationMcpAvailable, "isBrowserAutomationMcpAvailable");

// packages/cli/src/serve/voice/workspace-voice-coordinator.ts
init_esbuild_shims();
var MAX_CONCURRENT_VOICE_SESSIONS = 8;
var DISPOSE_WAIT_MS = 5e3;
var VoiceLeaseAbortError = class extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.name = "VoiceLeaseAbortError";
  }
  static {
    __name(this, "VoiceLeaseAbortError");
  }
};
var Lease = class {
  constructor(onRelease) {
    this.onRelease = onRelease;
  }
  static {
    __name(this, "Lease");
  }
  controller = new AbortController();
  signal = this.controller.signal;
  released = false;
  release() {
    if (this.released) return;
    this.released = true;
    this.onRelease(this);
  }
  abort(reason) {
    if (!this.signal.aborted) this.controller.abort(reason);
  }
};
var WorkspaceVoiceCoordinator = class {
  static {
    __name(this, "WorkspaceVoiceCoordinator");
  }
  states = /* @__PURE__ */ new Map();
  disposed = /* @__PURE__ */ new WeakSet();
  active = 0;
  acquire(runtime) {
    if (this.disposed.has(runtime)) {
      return { kind: "rejected", reason: "draining" };
    }
    const state = this.stateFor(runtime);
    if (state.draining) return { kind: "rejected", reason: "draining" };
    if (this.active >= MAX_CONCURRENT_VOICE_SESSIONS) {
      return { kind: "rejected", reason: "capacity" };
    }
    const lease = new Lease((current) => this.release(runtime, current));
    state.leases.add(lease);
    this.active++;
    return { kind: "admitted", lease };
  }
  beginWorkspaceDrain(runtime) {
    this.stateFor(runtime).draining = true;
  }
  cancelWorkspaceDrain(runtime) {
    const state = this.states.get(runtime);
    if (!state || state.completed) return;
    state.draining = false;
    if (state.leases.size === 0) this.states.delete(runtime);
  }
  completeWorkspaceDrain(runtime) {
    this.disposed.add(runtime);
    const state = this.states.get(runtime);
    if (!state) return;
    state.draining = true;
    state.completed = true;
    const abortReason = new VoiceLeaseAbortError(
      "workspace_removed",
      "Workspace drain completed"
    );
    for (const lease of state.leases) lease.abort(abortReason);
    this.deleteIfIdle(runtime, state);
  }
  getWorkspaceActivity(runtime) {
    return this.states.get(runtime)?.leases.size ?? 0;
  }
  async disposeRuntime(runtime, reason) {
    this.disposed.add(runtime);
    const state = this.states.get(runtime);
    if (!state) return;
    state.draining = true;
    state.completed = true;
    const abortReason = new VoiceLeaseAbortError(
      reason,
      reason === "daemon_shutdown" ? "Daemon is shutting down" : reason === "workspace_removed" ? "Workspace runtime was removed" : "Workspace trust was reconfigured"
    );
    for (const lease of state.leases) lease.abort(abortReason);
    if (state.leases.size === 0) {
      this.deleteIfIdle(runtime, state);
      return;
    }
    let resolveIdle;
    const idle = new Promise((resolve2) => {
      resolveIdle = resolve2;
      state.idleWaiters.add(resolve2);
    });
    let timeout;
    let timedOut = false;
    try {
      await Promise.race([
        idle,
        new Promise((resolve2) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve2();
          }, DISPOSE_WAIT_MS);
          timeout.unref?.();
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (resolveIdle) state.idleWaiters.delete(resolveIdle);
    }
    if (timedOut && state.leases.size > 0) {
      process.stderr.write(
        `qwen serve: Voice runtime disposal timed out with ${state.leases.size} active lease(s).
`
      );
    }
  }
  stateFor(runtime) {
    let state = this.states.get(runtime);
    if (!state) {
      state = {
        draining: false,
        completed: false,
        leases: /* @__PURE__ */ new Set(),
        idleWaiters: /* @__PURE__ */ new Set()
      };
      this.states.set(runtime, state);
    }
    return state;
  }
  release(runtime, lease) {
    const state = this.states.get(runtime);
    if (!state || !state.leases.delete(lease)) return;
    this.active--;
    if (state.leases.size === 0) {
      for (const resolve2 of state.idleWaiters) resolve2();
      state.idleWaiters.clear();
    }
    this.deleteIfIdle(runtime, state);
  }
  deleteIfIdle(runtime, state) {
    if (state.completed && state.leases.size === 0) this.states.delete(runtime);
  }
};

// packages/cli/src/serve/local-control/lan-interfaces.ts
init_esbuild_shims();
import { networkInterfaces } from "node:os";
function isLanIpv4(address) {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o))) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
__name(isLanIpv4, "isLanIpv4");
function isSoftwareNetwork(interfaceName) {
  if (/vpn/i.test(interfaceName)) return true;
  return /(^|[\s_.-])(utun|tun|tap|ppp|ipsec|wg|wireguard|tailscale|zerotier|zt[a-z0-9]*|hamachi|nordlynx|proton|wintun|docker|veth[0-9a-f]+|vmnet|vboxnet|vethernet|virtualbox|host[- ]only|podman|cni|lxcbr|lxdbr|flannel|virbr|br-[0-9a-f]+|bridge\d|anyconnect|globalprotect|pulse[\s-]secure|forticlient|fortinet|ivanti|cisco[\s_-]secure|citrix|sonicwall|cloudflare)(\d|[\s_.-]|$)/i.test(
    interfaceName
  );
}
__name(isSoftwareNetwork, "isSoftwareNetwork");
function listLanCandidates(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const [interfaceName, addresses] of Object.entries(interfaces).sort()) {
    if (isSoftwareNetwork(interfaceName)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (!isLanIpv4(address.address)) continue;
      candidates.push({ interfaceName, address: address.address });
    }
  }
  return candidates;
}
__name(listLanCandidates, "listLanCandidates");
var NoLanInterfaceError = class extends Error {
  static {
    __name(this, "NoLanInterfaceError");
  }
  code = "no_lan_interface";
  constructor() {
    super(
      "No private IPv4 address is available. Local Control needs the host to be on a local network (Wi-Fi or Ethernet)."
    );
    this.name = "NoLanInterfaceError";
  }
};
var AmbiguousLanInterfaceError = class extends Error {
  static {
    __name(this, "AmbiguousLanInterfaceError");
  }
  code = "ambiguous_lan_interface";
  candidates;
  constructor(candidates) {
    super(
      "Multiple local networks are available; choose which one to expose: " + candidates.map((c) => `${c.interfaceName} (${c.address})`).join(", ")
    );
    this.name = "AmbiguousLanInterfaceError";
    this.candidates = candidates;
  }
};
var UnknownLanInterfaceError = class extends Error {
  static {
    __name(this, "UnknownLanInterfaceError");
  }
  code = "unknown_lan_interface";
  constructor(requested) {
    super(
      `${requested} is not a private IPv4 address on this host right now. The network may have changed since the list was fetched.`
    );
    this.name = "UnknownLanInterfaceError";
  }
};
function selectLanAddress(preferredAddress, interfaces = networkInterfaces()) {
  const candidates = listLanCandidates(interfaces);
  if (candidates.length === 0) throw new NoLanInterfaceError();
  if (preferredAddress !== void 0) {
    const match = candidates.find((c) => c.address === preferredAddress);
    if (!match) throw new UnknownLanInterfaceError(preferredAddress);
    return match;
  }
  if (candidates.length > 1) throw new AmbiguousLanInterfaceError(candidates);
  return candidates[0];
}
__name(selectLanAddress, "selectLanAddress");

export {
  sanitizeForStderr,
  brandSecret,
  unsafeRevealSecret,
  UnsupportedDeviceFlowProviderError,
  TooManyActiveDeviceFlowsError,
  UpstreamDeviceFlowError,
  setDeviceFlowRegistry,
  getDeviceFlowRegistry,
  DeviceFlowRegistry,
  createBridgeFileSystemAdapter,
  PathMutexRegistry,
  isDeepHealthQuery,
  CredentialStore,
  singleTokenCredentials,
  tagListener,
  listenerIdentityOf,
  listenerIdentityOfSocket,
  daemonTelemetryResponseContext,
  daemonInboundTraceIdContext,
  ACCESS_LOG_CONTROLLER_LOCAL,
  installAccessLogMiddleware,
  denyBrowserOriginCors,
  parseAllowOriginPatterns,
  findNonLoopbackHttpOrigin,
  MutableOriginAllowlist,
  allowOriginCors,
  hostAllowlist,
  bearerAuth,
  isTrustedLoopbackMode,
  requestHasOperatorAuthority,
  createMutationGate,
  installRemoteSelfOriginMiddleware,
  installSelfOriginStripMiddleware,
  isSoftwareNetwork,
  listLanCandidates,
  NoLanInterfaceError,
  AmbiguousLanInterfaceError,
  UnknownLanInterfaceError,
  selectLanAddress,
  acpChildExtraArgs,
  ClientMcpSenderRegistry,
  createClientMcpServerProvider,
  SERVE_CAPABILITY_REGISTRY,
  getAdvertisedServeFeatures,
  getServeProtocolVersions,
  NativeDirectoryPickerUnavailableError,
  isNativeDirectoryPickerAvailable,
  pickNativeDirectory,
  LocalPathOpenUnavailableError,
  isLocalPathOpenAvailable,
  isLocalTerminalAvailable,
  openPathLocally,
  openTerminalLocally,
  CAPABILITIES_SCHEMA_VERSION,
  isManagedScratchChild,
  isScratchRootCompatible,
  prepareManagedScratchRoot,
  createManagedScratchDirectory,
  ServeAppLifecycleController,
  installServeAppLifecycle,
  createRateLimiter,
  setRateLimiter,
  getRateLimiter,
  resolveAcpHttpEnabled,
  ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM,
  ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION,
  ACP_PRE_ATTACH_MAX_FRAMES_GLOBAL,
  ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION,
  ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_GLOBAL,
  AcpPreAttachBudget,
  toDaemonStatusMemoryLimits,
  parseDaemonStatusDetail,
  buildDaemonStatusResponse,
  allowOriginMode,
  listenerMaxConnections,
  positiveFiniteOrNull,
  QWEN_CDP_MCP_COMMAND_ENV,
  resolveCdpMcpCommand,
  isBrowserAutomationMcpAvailable,
  MAX_CONCURRENT_VOICE_SESSIONS,
  VoiceLeaseAbortError,
  WorkspaceVoiceCoordinator
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
