// Force strict mode and setup for ESM
"use strict";
import {
  resolvePolicyToolSettings
} from "./chunk-UXEI7POA.js";
import {
  MEDIA_MEMORY_FILE_NAME
} from "./chunk-SLHYLVRW.js";
import {
  DEFAULT_OMNI_PROCESSING_LIMITS,
  conditionUsesNamespace,
  evaluateFixedPolicyCondition
} from "./chunk-RSFNJ6UU.js";
import {
  OmniJsonCacheFile
} from "./chunk-TFDCK56Y.js";
import {
  OBJECT_EXTENSION_RE
} from "./chunk-FTKXJMQV.js";
import {
  extensionForMime,
  hashFileSha256,
  recognizeMediaFile
} from "./chunk-S5BHLTHK.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/estimation.ts
init_esbuild_shims();
var AUDIO_TOKENS_PER_SECOND = 7;
var VISUAL_PIXELS_PER_TOKEN = 32 * 32 * 2;
function usable(value) {
  return value !== void 0 && Number.isFinite(value) && value > 0;
}
__name(usable, "usable");
function estimateRawResourceTokens(media) {
  const unavailable = {
    estimatedTokenCount: 0,
    method: "raw-resource-v1",
    status: "unavailable"
  };
  switch (media.modality) {
    case "audio": {
      const durationMs = media.metadata.durationMs;
      if (!usable(durationMs)) return unavailable;
      return {
        estimatedTokenCount: Math.ceil(
          durationMs / 1e3 * AUDIO_TOKENS_PER_SECOND
        ),
        method: "raw-resource-v1",
        status: "ok"
      };
    }
    case "image": {
      const { width, height, frameCount } = media.metadata;
      if (!usable(width) || !usable(height)) return unavailable;
      const frames = usable(frameCount) ? frameCount : 1;
      return {
        estimatedTokenCount: Math.ceil(
          width * height * frames / VISUAL_PIXELS_PER_TOKEN
        ),
        method: "raw-resource-v1",
        status: "ok"
      };
    }
    case "video": {
      const { width, height, durationMs, frameRate } = media.metadata;
      if (!usable(width) || !usable(height) || !usable(durationMs) || !usable(frameRate)) {
        return unavailable;
      }
      const frameCount = Math.ceil(durationMs / 1e3 * frameRate);
      return {
        estimatedTokenCount: Math.ceil(
          width * height * frameCount / VISUAL_PIXELS_PER_TOKEN
        ),
        method: "raw-resource-v1",
        status: "ok"
      };
    }
    default:
      return unavailable;
  }
}
__name(estimateRawResourceTokens, "estimateRawResourceTokens");

// packages/core/src/omni/policy/degradation-cache.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import path from "node:path";
var MAX_CACHED_DISCLOSURE_LENGTH = 2048;
var FINGERPRINT_EXCLUDED_KEYS = /* @__PURE__ */ new Set([
  "inputPath",
  "outputDir",
  "resourceId"
]);
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value;
    const body = Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}
__name(stableStringify, "stableStringify");
function computePolicyFingerprint(toolName, args, toolVersion = "1") {
  const tunables = {};
  for (const [k, v] of Object.entries(args)) {
    if (!FINGERPRINT_EXCLUDED_KEYS.has(k) && v !== void 0) {
      tunables[k] = v;
    }
  }
  return createHash("sha256").update(`${toolName}
${stableStringify(tunables)}
${toolVersion}`).digest("hex");
}
__name(computePolicyFingerprint, "computePolicyFingerprint");
var OmniDegradationCache = class {
  static {
    __name(this, "OmniDegradationCache");
  }
  file;
  constructor(omniRootDir) {
    this.file = new OmniJsonCacheFile(
      path.join(omniRootDir, "policy-cache.json"),
      "omni:policy-cache"
    );
  }
  key(originalSha256, policyFingerprint) {
    return `${originalSha256}|${policyFingerprint}`;
  }
  async get(originalSha256, policyFingerprint) {
    return this.file.access(null, (entries) => {
      const key = this.key(originalSha256, policyFingerprint);
      const entry = entries[key];
      if (!entry) return { result: null };
      if (!/^[0-9a-f]{64}$/.test(entry.degradedSha256) || typeof entry.extension !== "string" || !OBJECT_EXTENSION_RE.test(entry.extension) || typeof entry.disclosure !== "string" || entry.disclosure.length === 0 || entry.disclosure.length > MAX_CACHED_DISCLOSURE_LENGTH || typeof entry.mimeType !== "string" || entry.mimeType.length === 0 || entry.role !== void 0 && (typeof entry.role !== "string" || entry.role.length === 0)) {
        delete entries[key];
        return { result: null, changed: true };
      }
      return { result: entry };
    });
  }
  async put(originalSha256, policyFingerprint, entry) {
    return this.file.access(void 0, (entries) => {
      entries[this.key(originalSha256, policyFingerprint)] = {
        ...entry,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return { result: void 0, changed: true };
    });
  }
  /** Drop every policy result derived FROM the object (source object
   * gone/corrupt — GC cascade). */
  async removeByOriginalSha256(originalSha256) {
    return this.file.access(void 0, (entries) => {
      const prefix = `${originalSha256}|`;
      let changed = false;
      for (const k of Object.keys(entries)) {
        if (k.startsWith(prefix)) {
          delete entries[k];
          changed = true;
        }
      }
      return { result: void 0, changed };
    });
  }
  /** Drop every entry POINTING AT the derived object (derivative
   * gone/corrupt — the next run must re-transcode, not chase a missing
   * object). */
  async removeByDegradedSha256(degradedSha256) {
    return this.file.access(void 0, (entries) => {
      let changed = false;
      for (const [k, v] of Object.entries(entries)) {
        if (v.degradedSha256 === degradedSha256) {
          delete entries[k];
          changed = true;
        }
      }
      return { result: void 0, changed };
    });
  }
};

// packages/core/src/omni/guard.ts
init_esbuild_shims();
var DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
var OmniTransportGuardError = class extends Error {
  static {
    __name(this, "OmniTransportGuardError");
  }
  /**
   * Session handle for the SOURCE, when delivery had already bound one
   * before the guard's verdict (memory design M §5.2). A rejection is the
   * case where recall matters most — the model never sees the media, so
   * this handle is its only remaining route to the content — and every
   * throw site sits downstream of the bind, so dropping it would strand
   * the resource for the rest of the session.
   */
  sessionResourceId;
  constructor(message, options) {
    super(message, options);
    this.name = "OmniTransportGuardError";
  }
};
function effectiveMaxUploadFileBytes(config) {
  const configured = config.getOmniMaxUploadFileBytes?.();
  return configured !== void 0 && configured > 0 ? configured : DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES;
}
__name(effectiveMaxUploadFileBytes, "effectiveMaxUploadFileBytes");
function assertWithinByteLimit(config, sizeBytes, displayName) {
  const maxBytes = effectiveMaxUploadFileBytes(config);
  if (sizeBytes > maxBytes) {
    throw new OmniTransportGuardError(
      `${displayName} exceeds the omni upload limit: ${sizeBytes} bytes > ${maxBytes} bytes (omni.processing.transportGuard.maxUploadFileBytes). Reduce the file size before retrying.`
    );
  }
}
__name(assertWithinByteLimit, "assertWithinByteLimit");
function assertWithinDurationLimit(config, media, displayName) {
  const maxSeconds = config.getOmniMaxDurationSeconds?.();
  if (maxSeconds === void 0 || maxSeconds <= 0) return;
  const durationMs = media.metadata.durationMs;
  if (durationMs === void 0 || !Number.isFinite(durationMs)) return;
  const seconds = durationMs / 1e3;
  if (seconds > maxSeconds) {
    throw new OmniTransportGuardError(
      `${displayName} exceeds the omni duration limit: ${Math.round(seconds)}s > ${maxSeconds}s (omni.processing.transportGuard.maxDurationSeconds). Clip a shorter span \u2014 downscaling cannot bring a long file within a duration limit.`
    );
  }
}
__name(assertWithinDurationLimit, "assertWithinDurationLimit");
function assertWithinTokenLimit(config, media, displayName) {
  const estimate = estimateRawResourceTokens(media);
  const maxTokens = config.getOmniMaxEstimatedTokens?.();
  if (maxTokens === void 0 || maxTokens <= 0) return estimate;
  if (estimate.status !== "ok") return estimate;
  if (estimate.estimatedTokenCount > maxTokens) {
    throw new OmniTransportGuardError(
      `${displayName} exceeds the omni estimated-token limit: ~${estimate.estimatedTokenCount} tokens (${estimate.method}) > ${maxTokens} (omni.processing.transportGuard.maxEstimatedTokens). Reduce duration/resolution or raise the limit.`
    );
  }
  return estimate;
}
__name(assertWithinTokenLimit, "assertWithinTokenLimit");

// packages/core/src/omni/gc.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path2 from "node:path";
var debugLogger = createDebugLogger("omni:gc");
var OBJECT_NAME_RE = /^([0-9a-f]{64})\.[A-Za-z0-9][A-Za-z0-9.]*$/;
var SKIPPED = {
  ran: false,
  deletedObjects: 0,
  deletedBytes: 0,
  remainingBytes: 0,
  derivationsSuspended: false
};
var gcOnce = /* @__PURE__ */ new Map();
var suspendedRoots = /* @__PURE__ */ new Set();
function effectiveOmniStorageMaxTotalBytes(config) {
  const configured = config.getOmniStorageMaxTotalBytes();
  const floor = 10 * effectiveMaxUploadFileBytes(config);
  if (configured < floor) {
    debugLogger.warn(
      `omni.storage.maxTotalBytes (${configured}) is below 10\xD7 the transport guard's single-media limit; using ${floor} bytes instead (the budget must hold at least ten normal uploads).`
    );
    return floor;
  }
  return configured;
}
__name(effectiveOmniStorageMaxTotalBytes, "effectiveOmniStorageMaxTotalBytes");
function isOmniDerivationSuspended(omniRootDir) {
  return suspendedRoots.has(path2.resolve(omniRootDir));
}
__name(isOmniDerivationSuspended, "isOmniDerivationSuspended");
async function settleOmniGc(omniRootDir) {
  const existing = gcOnce.get(path2.resolve(omniRootDir));
  if (existing) await existing;
}
__name(settleOmniGc, "settleOmniGc");
async function isRealDirectory(p) {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}
__name(isRealDirectory, "isRealDirectory");
async function listObjects(objectsDir) {
  const out = [];
  if (!await isRealDirectory(objectsDir)) return out;
  let shards;
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return out;
  }
  for (const shard of shards) {
    const shardDir = path2.join(objectsDir, shard);
    if (!await isRealDirectory(shardDir)) continue;
    let names;
    try {
      names = await fs.readdir(shardDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = OBJECT_NAME_RE.exec(name);
      if (!match) continue;
      const filePath = path2.join(shardDir, name);
      try {
        const st = await fs.lstat(filePath);
        if (!st.isFile()) continue;
        out.push({
          sha256: match[1],
          filePath,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size
        });
      } catch {
      }
    }
  }
  return out;
}
__name(listObjects, "listObjects");
async function deleteObject(object, options) {
  try {
    await fs.rm(object.filePath, { force: true });
  } catch (err) {
    debugLogger.debug(
      `gc: failed to delete ${object.sha256}: ${err instanceof Error ? err.message : err}`
    );
    return false;
  }
  try {
    await options.uploadCache?.removeBySha256(object.sha256);
  } catch {
  }
  try {
    await options.degradationCache?.removeByOriginalSha256(object.sha256);
    await options.degradationCache?.removeByDegradedSha256(object.sha256);
  } catch {
  }
  debugLogger.debug(
    `gc: deleted unreferenced object ${object.sha256} (${object.sizeBytes} bytes)`
  );
  return true;
}
__name(deleteObject, "deleteObject");
function runOmniGcOnce(options) {
  const rootKey = path2.resolve(options.store.getOmniRootDir());
  const existing = gcOnce.get(rootKey);
  if (existing) return existing;
  const run = sweep(options, rootKey).catch((err) => {
    debugLogger.debug(
      `gc: run failed, skipped: ${err instanceof Error ? err.message : err}`
    );
    return SKIPPED;
  });
  gcOnce.set(rootKey, run);
  return run;
}
__name(runOmniGcOnce, "runOmniGcOnce");
async function recentlyRecoveredFromCorruption(omniRootDir, retentionDays, nowMs) {
  const prefix = `${MEDIA_MEMORY_FILE_NAME}.corrupt-`;
  let names;
  try {
    names = await fs.readdir(omniRootDir);
  } catch {
    return false;
  }
  const cutoff = nowMs - retentionDays * 24 * 36e5;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const stamp = Number(name.slice(prefix.length));
    if (Number.isFinite(stamp) && stamp >= cutoff) return true;
    try {
      const st = await fs.lstat(path2.join(omniRootDir, name));
      if (st.mtimeMs >= cutoff) return true;
    } catch {
      return true;
    }
  }
  return false;
}
__name(recentlyRecoveredFromCorruption, "recentlyRecoveredFromCorruption");
async function sweep(options, rootKey) {
  const nowMsForGuard = options.nowMs ?? Date.now();
  const refs = await options.memoryService.collectManagedRefs();
  if (refs === null) {
    debugLogger.debug("gc: memory snapshot unreadable, skipping run");
    return SKIPPED;
  }
  if (await recentlyRecoveredFromCorruption(
    options.store.getOmniRootDir(),
    options.retentionDays,
    nowMsForGuard
  )) {
    debugLogger.debug(
      "gc: memory ledger recently recovered from corruption, skipping run"
    );
    return SKIPPED;
  }
  const objectsDir = options.store.getObjectsDir();
  for (const fileRef of options.registry?.activeFileRefs() ?? []) {
    const name = path2.basename(fileRef);
    const match = OBJECT_NAME_RE.exec(name);
    if (match && fileRef.startsWith(objectsDir)) refs.add(match[1]);
  }
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionDays * 24 * 36e5;
  const objects = await listObjects(objectsDir);
  let deletedObjects = 0;
  let deletedBytes = 0;
  const survivors = [];
  const touchedSinceListing = /* @__PURE__ */ __name(async (object, freshCutoffMs) => {
    try {
      return (await fs.lstat(object.filePath)).mtimeMs >= freshCutoffMs;
    } catch {
      return true;
    }
  }, "touchedSinceListing");
  for (const object of objects) {
    if (refs.has(object.sha256) || object.mtimeMs >= cutoffMs) {
      survivors.push(object);
      continue;
    }
    if (await touchedSinceListing(object, cutoffMs)) {
      survivors.push(object);
      continue;
    }
    if (await deleteObject(object, options)) {
      deletedObjects += 1;
      deletedBytes += object.sizeBytes;
    } else {
      survivors.push(object);
    }
  }
  let remainingBytes = survivors.reduce((sum, o) => sum + o.sizeBytes, 0);
  if (remainingBytes > options.maxTotalBytes) {
    const freshRefs = await options.memoryService.collectManagedRefs();
    if (freshRefs === null) {
      debugLogger.debug(
        "gc: ledger unreadable at budget pass, skipping budget deletions"
      );
    } else {
      const unreferenced = survivors.filter((o) => !refs.has(o.sha256) && !freshRefs.has(o.sha256)).sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const object of unreferenced) {
        if (remainingBytes <= options.maxTotalBytes) break;
        if (await touchedSinceListing(object, nowMs)) continue;
        if (await deleteObject(object, options)) {
          deletedObjects += 1;
          deletedBytes += object.sizeBytes;
          remainingBytes -= object.sizeBytes;
        }
      }
    }
  }
  const derivationsSuspended = remainingBytes > options.maxTotalBytes;
  if (derivationsSuspended) {
    suspendedRoots.add(rootKey);
    debugLogger.warn(
      `omni object store over budget with only referenced objects left (${remainingBytes} > ${options.maxTotalBytes} bytes); new policy derivations are suspended for this session. Raise omni.storage.maxTotalBytes or delete memory records you no longer need \u2014 either change takes effect at the next session start (the GC runs once per process).`
    );
  } else {
    suspendedRoots.delete(rootKey);
  }
  if (deletedObjects > 0) {
    debugLogger.debug(
      `gc: removed ${deletedObjects} object(s) / ${deletedBytes} bytes; ${remainingBytes} bytes remain`
    );
  }
  return {
    ran: true,
    deletedObjects,
    deletedBytes,
    remainingBytes,
    derivationsSuspended
  };
}
__name(sweep, "sweep");

// packages/core/src/omni/policy/orchestrator.ts
init_esbuild_shims();
import { createHash as createHash2, randomBytes } from "node:crypto";
import fs2 from "node:fs/promises";
import path3 from "node:path";
var debugLogger2 = createDebugLogger("omni:policy");
var MAX_FILE_ARTIFACT_BYTES = 256 * 1024;
var OmniPolicyExecutionError = class extends Error {
  constructor(message, policyId, options) {
    super(message, options);
    this.policyId = policyId;
    this.name = "OmniPolicyExecutionError";
  }
  static {
    __name(this, "OmniPolicyExecutionError");
  }
};
function resolveArtifactSelector(artifacts, kind, role) {
  if (role !== void 0) {
    const byRole = artifacts[`role:${role}`];
    if (byRole) return byRole;
  }
  const byKind = artifacts[`kind:${kind}`];
  if (byKind) return byKind;
  return artifacts["*"] ?? "retain";
}
__name(resolveArtifactSelector, "resolveArtifactSelector");
function resourceConditionContext(recognized, shared) {
  const resource = {};
  const set = /* @__PURE__ */ __name((field, value) => {
    if (typeof value === "number" && !Number.isNaN(value)) {
      resource[field] = value;
    }
  }, "set");
  const m = recognized.metadata;
  set("sizeBytes", recognized.sizeBytes);
  set("durationMs", m.durationMs);
  set("width", m.width);
  set("height", m.height);
  set("maxWidth", m.width);
  set("maxHeight", m.height);
  set("frameRate", m.frameRate);
  set("frameCount", m.frameCount);
  set("bitRate", m.bitRate);
  set("sampleRateHz", m.sampleRateHz);
  set("channels", m.channels);
  const estimate = estimateRawResourceTokens(recognized);
  if (estimate.status === "ok") {
    set("estimatedTokenCount", estimate.estimatedTokenCount);
  }
  return { resource, ...shared };
}
__name(resourceConditionContext, "resourceConditionContext");
var MEMORY_ROLE_FIELDS = {
  transcript: "hasTranscript",
  ocr: "hasOcr",
  caption: "hasCaption",
  summary: "hasSummary",
  keyframe: "hasKeyframes",
  clip: "hasClip"
};
async function memoryConditionNamespace(memory, binding) {
  if (!memory || !binding) return void 0;
  const roles = await memory.service.collectVersionOutputRoles(binding);
  if (!roles) return void 0;
  const namespace = {};
  for (const field of Object.values(MEMORY_ROLE_FIELDS)) {
    namespace[field] = 0;
  }
  for (const role of roles) {
    const field = MEMORY_ROLE_FIELDS[role];
    if (field) namespace[field] = 1;
  }
  return namespace;
}
__name(memoryConditionNamespace, "memoryConditionNamespace");
function requestConditionNamespace(items) {
  let total = 0;
  for (const item of items) {
    if (!item.deliver) continue;
    const estimate = estimateRawResourceTokens(item.recognized);
    if (estimate.status !== "ok") return void 0;
    total += estimate.estimatedTokenCount;
  }
  return { totalEstimatedMediaTokens: total };
}
__name(requestConditionNamespace, "requestConditionNamespace");
function sortPolicies(policies) {
  return [...policies].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id)
  );
}
__name(sortPolicies, "sortPolicies");
var resourceGates = /* @__PURE__ */ new Map();
async function acquireResourceSlot(rootDir, limit) {
  const effectiveLimit = Math.max(1, Math.floor(limit));
  let gate = resourceGates.get(rootDir);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    resourceGates.set(rootDir, gate);
  }
  const heldGate = gate;
  if (heldGate.active >= effectiveLimit) {
    await new Promise((resolve) => heldGate.waiters.push(resolve));
  } else {
    heldGate.active++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = heldGate.waiters.shift();
    if (next) {
      next();
      return;
    }
    heldGate.active--;
    if (heldGate.active === 0 && heldGate.waiters.length === 0) {
      resourceGates.delete(rootDir);
    }
  };
}
__name(acquireResourceSlot, "acquireResourceSlot");
async function runFixedPolicies(config, source, options) {
  const policies = sortPolicies(options.policies);
  const limits = options.limits ?? DEFAULT_OMNI_PROCESSING_LIMITS;
  const releaseSlot = await acquireResourceSlot(
    options.store.getOmniRootDir(),
    limits.maxConcurrentResources
  );
  try {
    return await runFixedPoliciesUnbounded(config, source, options, {
      policies,
      limits
    });
  } finally {
    releaseSlot();
  }
}
__name(runFixedPolicies, "runFixedPolicies");
async function runFixedPoliciesUnbounded(config, source, options, normalized) {
  const { policies, limits } = normalized;
  const cache = options.degradationCache ?? new OmniDegradationCache(options.store.getOmniRootDir());
  const records = [];
  const fileDeliveries = [];
  const items = [
    {
      filePath: source.filePath,
      recognized: source.recognized,
      label: source.displayName,
      origin: source.origin,
      sha256: source.sha256,
      memoryBinding: options.memory?.sourceBinding,
      lineageRuns: /* @__PURE__ */ new Map(),
      depth: 0,
      deliver: true,
      process: true
    }
  ];
  let runsUsed = 0;
  let artifactsProduced = 0;
  let derivedBytesProduced = 0;
  let budgetExhausted = false;
  const stopOnBudget = /* @__PURE__ */ __name((policy, item, reason) => {
    budgetExhausted = true;
    records.push({
      policyId: policy.id,
      toolName: policy.toolName,
      outcome: "budget_exhausted",
      resource: item.label,
      error: reason
    });
    debugLogger2.debug(
      `per-root policy budget exhausted on ${item.label}: ${reason}; no further derivation for this root (committed deliveries stand)`
    );
  }, "stopOnBudget");
  for (let i = 0; i < items.length && !budgetExhausted; i++) {
    const item = items[i];
    if (!item.process) continue;
    if (item.recognized.modality === "image" && (item.recognized.metadata.frameCount ?? 1) > 1) {
      debugLogger2.debug(
        `animated image ${item.label} (${item.recognized.metadata.frameCount} frames) excluded from policy matching (D9)`
      );
      continue;
    }
    const needsMemoryNamespace = policies.some(
      (policy) => policy.when && conditionUsesNamespace(policy.when, "memory")
    );
    const sharedConditionContext = {
      request: options.conditionContext?.request ?? requestConditionNamespace(items),
      session: options.conditionContext?.session,
      memory: needsMemoryNamespace ? await memoryConditionNamespace(options.memory, item.memoryBinding) : void 0
    };
    for (const policy of policies) {
      if (!policy.mediaTypes.includes(item.recognized.modality)) continue;
      if (!policy.origins.includes(item.origin)) continue;
      const runs = item.lineageRuns.get(policy.id) ?? 0;
      if (runs >= policy.maxRunsPerLineage) continue;
      if (policy.when) {
        const evaluation = evaluateFixedPolicyCondition(
          policy.when,
          resourceConditionContext(item.recognized, sharedConditionContext)
        );
        if (evaluation.outcome === "no_match") continue;
        if (evaluation.outcome === "unavailable" && policy.onConditionUnavailable === "skip") {
          records.push({
            policyId: policy.id,
            toolName: policy.toolName,
            outcome: "condition_unavailable",
            resource: item.label,
            missingFields: evaluation.missingFields
          });
          continue;
        }
      }
      if (runsUsed >= limits.maxPolicyRunsPerRoot) {
        stopOnBudget(
          policy,
          item,
          `maxPolicyRunsPerRoot (${limits.maxPolicyRunsPerRoot}) reached`
        );
        break;
      }
      runsUsed++;
      item.lineageRuns.set(policy.id, runs + 1);
      try {
        const execution = await executePolicy(
          config,
          item,
          policy,
          options.store,
          cache,
          options.signal,
          options.memory && item.memoryBinding ? { service: options.memory.service, source: item.memoryBinding } : void 0
        );
        records.push({
          policyId: policy.id,
          toolName: policy.toolName,
          outcome: execution.outcome,
          resource: item.label
        });
        if (execution.outcome === "no_op") continue;
        if (policy.output.source === "omit") item.deliver = false;
        const childDepth = item.depth + 1;
        const depthAllowsReprocess = childDepth < limits.maxLineageDepth;
        if (policy.output.reprocessMedia && !depthAllowsReprocess) {
          debugLogger2.debug(
            `maxLineageDepth (${limits.maxLineageDepth}) reached under ${item.label}; derivatives deliver but do not re-enter policy matching`
          );
        }
        for (const derived of execution.derived) {
          artifactsProduced++;
          derivedBytesProduced += derived.recognized.sizeBytes;
          items.push({
            ...derived,
            label: `${item.label} \u2192 ${policy.id}`,
            origin: "policy",
            lineageRuns: new Map(item.lineageRuns),
            depth: childDepth,
            // `output.artifacts` selector decides delivery (upstream P):
            // an included derivative enters the delivery set, a retained
            // one is only registered in objects/.
            deliver: resolveArtifactSelector(
              policy.output.artifacts,
              derived.recognized.modality,
              derived.role
            ) === "include",
            process: policy.output.reprocessMedia && depthAllowsReprocess
          });
        }
        for (const file of execution.derivedFiles) {
          artifactsProduced++;
          derivedBytesProduced += file.sizeBytes;
          if (resolveArtifactSelector(
            policy.output.artifacts,
            "file",
            file.role
          ) === "include") {
            fileDeliveries.push(file);
          }
        }
        if (artifactsProduced > limits.maxArtifactsPerRoot) {
          stopOnBudget(
            policy,
            item,
            `maxArtifactsPerRoot (${limits.maxArtifactsPerRoot}) exceeded`
          );
          break;
        }
        if (derivedBytesProduced > limits.maxDerivedBytesPerRoot) {
          stopOnBudget(
            policy,
            item,
            `maxDerivedBytesPerRoot (${limits.maxDerivedBytesPerRoot}) exceeded`
          );
          break;
        }
      } catch (err) {
        if (options.signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        records.push({
          policyId: policy.id,
          toolName: policy.toolName,
          outcome: "failed",
          resource: item.label,
          error: message
        });
        debugLogger2.debug(
          `fixed policy ${policy.id} (${policy.toolName}) failed on ${item.label}: ${message}`
        );
        if (policy.onFailure === "abort" || policy.stage === "transport_guard") {
          throw new OmniPolicyExecutionError(
            `Fixed policy ${policy.id} failed: ${message}`,
            policy.id,
            { cause: err }
          );
        }
      }
    }
  }
  return {
    deliveries: items.filter((item) => item.deliver).map((item) => ({
      filePath: item.filePath,
      recognized: item.recognized,
      sha256: item.sha256,
      disclosure: item.disclosure,
      degraded: item.degraded,
      memoryBinding: item.memoryBinding
    })),
    fileDeliveries,
    records
  };
}
__name(runFixedPoliciesUnbounded, "runFixedPoliciesUnbounded");
async function executePolicy(config, item, policy, store, cache, signal, memory) {
  const tool = config.getToolRegistry().getTool(policy.toolName);
  const descriptor = tool?.mediaPolicyDescriptor;
  if (!descriptor) {
    throw new Error(
      `tool ${policy.toolName} is not a registered media-policy tool`
    );
  }
  item.sha256 ??= await hashFileSha256(item.filePath, signal);
  const settingsDefaults = resolvePolicyToolSettings(config, policy.toolName);
  const effectiveArguments = { ...settingsDefaults, ...policy.arguments };
  const fingerprint = computePolicyFingerprint(
    policy.toolName,
    effectiveArguments,
    descriptor.version
  );
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (memory) {
    const reusable = await memory.service.findReusableOutputs(
      item.sha256,
      fingerprint
    );
    const rebuilt = reusable ? await rebuildReusedOutputs(reusable, descriptor, store, signal) : void 0;
    if (rebuilt) {
      debugLogger2.debug(
        `memory reuse hit: policy=${policy.id} sha256=${item.sha256.slice(0, 12)}\u2026 outputs=${rebuilt.outputs.length} (tool not executed)`
      );
      const commit = await memory.service.commitPolicySucceeded({
        invocationId: "memory-reuse",
        source: memory.source,
        executionOrigin: {
          kind: "fixed_policy",
          policyId: policy.id,
          stage: policy.stage
        },
        toolName: policy.toolName,
        toolVersion: descriptor.version,
        finalArguments: effectiveArguments,
        omniConfigHash: fingerprint,
        startedAt,
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        outputs: rebuilt.outputs
      });
      return {
        outcome: "succeeded",
        derived: rebuilt.derived.map((d) => ({
          ...d,
          memoryBinding: commit?.mediaBindings.get(d.sha256)
        })),
        derivedFiles: rebuilt.derivedFiles
      };
    }
  }
  const hit = await cache.get(item.sha256, fingerprint);
  if (hit) {
    try {
      const objectPath = store.objectPathFor(hit.degradedSha256, hit.extension);
      const stat = await fs2.lstat(objectPath).catch(() => void 0);
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        const actualSha256 = await hashFileSha256(objectPath, signal);
        if (actualSha256 === hit.degradedSha256) {
          const recognized = await recognizeMediaFile(objectPath, { signal });
          const declared = descriptor.outputs.some(
            (o) => o.kind === "media" && o.mimeTypes?.includes(recognized.detectedMimeType)
          );
          if (declared) {
            debugLogger2.debug(
              `degradation cache hit: policy=${policy.id} sha256=${item.sha256.slice(0, 12)}\u2026`
            );
            const commit = memory ? await memory.service.commitPolicySucceeded({
              invocationId: "cache-hit",
              source: memory.source,
              executionOrigin: {
                kind: "fixed_policy",
                policyId: policy.id,
                stage: policy.stage
              },
              toolName: policy.toolName,
              toolVersion: descriptor.version,
              finalArguments: effectiveArguments,
              omniConfigHash: fingerprint,
              startedAt,
              completedAt: (/* @__PURE__ */ new Date()).toISOString(),
              outputs: [
                {
                  kind: "media",
                  objectPath,
                  sha256: hit.degradedSha256,
                  mediaType: recognized.modality,
                  metadata: recognized.metadata,
                  sizeBytes: recognized.sizeBytes,
                  mimeType: recognized.detectedMimeType,
                  role: hit.role,
                  disclosure: hit.disclosure
                }
              ]
            }) : void 0;
            return {
              outcome: "cache_hit",
              derived: [
                {
                  filePath: objectPath,
                  recognized,
                  sha256: hit.degradedSha256,
                  disclosure: hit.disclosure,
                  degraded: true,
                  role: hit.role,
                  memoryBinding: commit?.mediaBindings.get(hit.degradedSha256)
                }
              ],
              derivedFiles: []
            };
          }
          debugLogger2.debug(
            `degradation cache hit for policy=${policy.id} recognized as undeclared media type ${recognized.detectedMimeType}; dropping the entry and re-transcoding`
          );
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      debugLogger2.debug(
        `degradation cache hit could not be verified for policy=${policy.id}: ${err instanceof Error ? err.message : String(err)}; dropping the entry and re-transcoding`
      );
    }
    await cache.removeByDegradedSha256(hit.degradedSha256);
  }
  await settleOmniGc(store.getOmniRootDir());
  if (isOmniDerivationSuspended(store.getOmniRootDir())) {
    throw new Error(
      `omni object store is over its byte budget with only memory-referenced objects left; new policy derivations are suspended. Raise omni.storage.maxTotalBytes or delete memory records you no longer need, then start a new session \u2014 the budget is re-evaluated once per process.`
    );
  }
  const invocationId = randomBytes(8).toString("hex");
  const stagingDir = await store.createStagingDir(invocationId);
  let failure;
  try {
    const request = {
      callId: invocationId,
      name: policy.toolName,
      args: {
        ...effectiveArguments,
        inputPath: item.filePath,
        outputDir: stagingDir
      },
      isClientInitiated: true,
      prompt_id: `omni-fixed-policy-${invocationId}`,
      executionOrigin: {
        kind: "fixed_policy",
        policyId: policy.id,
        stage: policy.stage
      }
    };
    const { executeToolCall } = await import("./nonInteractiveToolExecutor-ATKG6KOX.js");
    const response = await executeToolCall(
      config,
      request,
      signal ?? new AbortController().signal,
      { recordToolResult: false }
    );
    if (response.error) {
      throw new Error(response.error.message, { cause: response.error });
    }
    const batch = response.policyArtifacts;
    if (!batch || batch.artifacts.length === 0) {
      throw new Error(
        `tool ${policy.toolName} succeeded but produced no policy artifacts`
      );
    }
    const validated = await Promise.all(
      batch.artifacts.map(
        (artifact) => validateArtifact(artifact, descriptor, stagingDir, signal)
      )
    );
    assertRequiredOutputsPresent(descriptor, validated, policy.toolName);
    if (validated.every((a) => a.sha256 === item.sha256)) {
      return { outcome: "no_op", derived: [], derivedFiles: [] };
    }
    const promoted = await Promise.all(
      validated.map(async (artifact) => {
        const mimeType = artifact.kind === "media" ? artifact.recognized.detectedMimeType : artifact.mimeType;
        const put = await store.putFile(
          artifact.absolutePath,
          artifact.sha256,
          extensionForMime(mimeType),
          signal
        );
        return { artifact, objectPath: put.objectPath };
      })
    );
    const derived = [];
    const derivedFiles = [];
    for (const { artifact, objectPath } of promoted) {
      if (artifact.kind === "media") {
        derived.push({
          filePath: objectPath,
          recognized: artifact.recognized,
          sha256: artifact.sha256,
          disclosure: artifact.disclosure,
          degraded: artifact.lossy,
          role: artifact.role
        });
      } else {
        derivedFiles.push({
          filePath: objectPath,
          role: artifact.role,
          mimeType: artifact.mimeType,
          text: artifact.text,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          disclosure: artifact.disclosure
        });
      }
    }
    if (memory) {
      const outputs = promoted.map(
        ({ artifact, objectPath }) => artifact.kind === "media" ? {
          kind: "media",
          objectPath,
          sha256: artifact.sha256,
          mediaType: artifact.recognized.modality,
          metadata: artifact.recognized.metadata,
          sizeBytes: artifact.recognized.sizeBytes,
          mimeType: artifact.recognized.detectedMimeType,
          role: artifact.role,
          disclosure: artifact.disclosure
        } : {
          kind: "text",
          objectPath,
          sha256: artifact.sha256,
          mimeType: artifact.mimeType,
          text: artifact.text,
          sizeBytes: artifact.sizeBytes,
          role: artifact.role,
          disclosure: artifact.disclosure
        }
      );
      const commit = await memory.service.commitPolicySucceeded({
        invocationId,
        source: memory.source,
        executionOrigin: {
          kind: "fixed_policy",
          policyId: policy.id,
          stage: policy.stage
        },
        toolName: policy.toolName,
        toolVersion: descriptor.version,
        finalArguments: effectiveArguments,
        omniConfigHash: fingerprint,
        startedAt,
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        outputs
      });
      if (commit) {
        for (const entry of derived) {
          entry.memoryBinding = commit.mediaBindings.get(entry.sha256);
        }
      }
    }
    if (validated.length === 1 && validated[0].kind === "media" && validated[0].disclosure) {
      await cache.put(item.sha256, fingerprint, {
        degradedSha256: validated[0].sha256,
        extension: extensionForMime(validated[0].recognized.detectedMimeType),
        disclosure: validated[0].disclosure,
        mimeType: validated[0].recognized.detectedMimeType,
        // Persist the artifact's role so a cache hit reconstructs the SAME
        // derived shape as the fresh derivation above.
        ...validated[0].role !== void 0 ? { role: validated[0].role } : {}
      });
    }
    return { outcome: "succeeded", derived, derivedFiles };
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (failure === void 0 || signal?.aborted) {
      await store.removeStagingDir(invocationId).catch(() => {
      });
    } else {
      try {
        await store.quarantineInvocation(invocationId, {
          policyId: policy.id,
          toolName: policy.toolName,
          reason: failure instanceof Error ? failure.message : String(failure)
        });
      } catch {
        await store.removeStagingDir(invocationId).catch(() => {
        });
      }
    }
  }
}
__name(executePolicy, "executePolicy");
async function rebuildReusedOutputs(reusable, descriptor, store, signal) {
  const outputs = [];
  const derived = [];
  const derivedFiles = [];
  try {
    for (const record of reusable.outputs) {
      const objectPath = record.objectPath ?? store.objectPathFor(record.sha256, extensionForMime(record.mimeType));
      const stat = await fs2.lstat(objectPath).catch(() => void 0);
      if (!stat?.isFile() || stat.isSymbolicLink()) return void 0;
      if (await hashFileSha256(objectPath, signal) !== record.sha256) {
        return void 0;
      }
      if (record.kind === "media") {
        const recognized = await recognizeMediaFile(objectPath, { signal });
        const declared = descriptor.outputs.some(
          (o) => o.kind === "media" && o.mimeTypes?.includes(recognized.detectedMimeType)
        );
        if (!declared) return void 0;
        outputs.push({
          kind: "media",
          objectPath,
          sha256: record.sha256,
          mediaType: recognized.modality,
          metadata: recognized.metadata,
          sizeBytes: recognized.sizeBytes,
          mimeType: recognized.detectedMimeType,
          role: record.role,
          disclosure: record.disclosure
        });
        derived.push({
          filePath: objectPath,
          recognized,
          sha256: record.sha256,
          disclosure: record.disclosure,
          degraded: record.disclosure !== void 0,
          role: record.role
        });
      } else {
        const text = await fs2.readFile(objectPath, "utf8");
        outputs.push({
          kind: "text",
          objectPath,
          sha256: record.sha256,
          mimeType: record.mimeType,
          text,
          sizeBytes: record.sizeBytes,
          role: record.role,
          disclosure: record.disclosure
        });
        derivedFiles.push({
          filePath: objectPath,
          role: record.role,
          mimeType: record.mimeType,
          text,
          sha256: record.sha256,
          sizeBytes: record.sizeBytes,
          disclosure: record.disclosure
        });
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    debugLogger2.debug(
      `memory reuse could not be verified, re-deriving: ${err instanceof Error ? err.message : String(err)}`
    );
    return void 0;
  }
  return { outputs, derived, derivedFiles };
}
__name(rebuildReusedOutputs, "rebuildReusedOutputs");
async function validateArtifact(artifact, descriptor, stagingDir, signal) {
  if (artifact.storage !== "workspace" || !artifact.workspacePath) {
    throw new Error(
      `policy artifact "${artifact.title}" is not a workspace file`
    );
  }
  const absolutePath = path3.resolve(stagingDir, artifact.workspacePath);
  if (!absolutePath.startsWith(stagingDir + path3.sep)) {
    throw new Error(
      `policy artifact "${artifact.title}" escapes the staging directory`
    );
  }
  const stat = await fs2.lstat(absolutePath).catch(() => void 0);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `policy artifact "${artifact.title}" is missing or not a regular file`
    );
  }
  const rawRole = artifact.metadata?.["omniRole"];
  const role = typeof rawRole === "string" && rawRole ? rawRole : void 0;
  const rawDisclosure = artifact.metadata?.["omniDisclosure"];
  const disclosure = typeof rawDisclosure === "string" && rawDisclosure ? rawDisclosure : void 0;
  if (artifact.kind === "file") {
    const spec2 = descriptor.outputs.find(
      (o) => o.kind === "file" && (o.role === void 0 || o.role === role) && artifact.mimeType !== void 0 && o.mimeTypes?.includes(artifact.mimeType)
    );
    if (!spec2) {
      throw new Error(
        `policy artifact "${artifact.title}" (file, role ${role ?? "none"}, ${artifact.mimeType ?? "no mimeType"}) matches no declared file output`
      );
    }
    if (stat.size > MAX_FILE_ARTIFACT_BYTES) {
      throw new Error(
        `policy artifact "${artifact.title}" exceeds the file-artifact size budget (${stat.size} > ${MAX_FILE_ARTIFACT_BYTES} bytes)`
      );
    }
    const bytes = await fs2.readFile(absolutePath);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `policy artifact "${artifact.title}" is not valid UTF-8 text`
      );
    }
    if (spec2.lossy && !disclosure) {
      throw new Error(
        `policy artifact "${artifact.title}" is lossy but carries no omniDisclosure`
      );
    }
    return {
      kind: "file",
      absolutePath,
      mimeType: artifact.mimeType,
      text,
      sizeBytes: bytes.byteLength,
      // The bytes are already in memory for the UTF-8 check — hash them
      // directly instead of streaming the file a second time.
      sha256: createHash2("sha256").update(bytes).digest("hex"),
      disclosure,
      lossy: spec2.lossy === true,
      role
    };
  }
  const recognized = await recognizeMediaFile(absolutePath, { signal });
  const spec = descriptor.outputs.find(
    (o) => o.kind === "media" && o.mimeTypes?.includes(recognized.detectedMimeType)
  );
  if (!spec) {
    throw new Error(
      `policy artifact "${artifact.title}" has undeclared media type ${recognized.detectedMimeType}`
    );
  }
  if (artifact.kind !== recognized.modality) {
    throw new Error(
      `policy artifact "${artifact.title}" declares kind ${String(artifact.kind)} but contains ${recognized.modality} content`
    );
  }
  if (spec.lossy && !disclosure) {
    throw new Error(
      `policy artifact "${artifact.title}" is lossy but carries no omniDisclosure`
    );
  }
  return {
    kind: "media",
    absolutePath,
    recognized,
    sha256: await hashFileSha256(absolutePath, signal),
    disclosure,
    lossy: spec.lossy === true,
    role
  };
}
__name(validateArtifact, "validateArtifact");
function assertRequiredOutputsPresent(descriptor, validated, toolName) {
  for (const spec of descriptor.outputs) {
    if (!spec.required) continue;
    let produced;
    if (spec.kind === "media") {
      produced = validated.some(
        (a) => a.kind === "media" && spec.mimeTypes?.includes(a.recognized.detectedMimeType)
      );
    } else if (spec.kind === "file") {
      produced = validated.some(
        (a) => a.kind === "file" && (spec.role === void 0 || a.role === spec.role) && spec.mimeTypes?.includes(a.mimeType)
      );
    } else {
      continue;
    }
    if (!produced) {
      throw new Error(
        `tool ${toolName} did not produce its required ${spec.kind} ${spec.mimeTypes?.join("/") ?? spec.role ?? ""} output`
      );
    }
  }
}
__name(assertRequiredOutputsPresent, "assertRequiredOutputsPresent");

export {
  estimateRawResourceTokens,
  computePolicyFingerprint,
  OmniDegradationCache,
  DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES,
  OmniTransportGuardError,
  effectiveMaxUploadFileBytes,
  assertWithinByteLimit,
  assertWithinDurationLimit,
  assertWithinTokenLimit,
  effectiveOmniStorageMaxTotalBytes,
  runOmniGcOnce,
  OmniPolicyExecutionError,
  runFixedPolicies,
  validateArtifact,
  assertRequiredOutputsPresent
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
