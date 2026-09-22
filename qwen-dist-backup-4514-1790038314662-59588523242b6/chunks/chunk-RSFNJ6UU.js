// Force strict mode and setup for ESM
"use strict";
import {
  isPlainRecord
} from "./chunk-BQMSZSG6.js";
import {
  SchemaValidator,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/config.ts
init_esbuild_shims();

// packages/core/src/omni/recovery.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
var debugLogger = createDebugLogger("omni:recovery");
var PART_RETENTION_MS = 48 * 36e5;
var SAMPLE_VERIFY_LIMIT = 3;
var SAMPLE_VERIFY_MAX_BYTES = 64 * 1024 * 1024;
var TMP_GRACE_MS = 36e5;
var STAGING_GRACE_MS = 36e5;
var QUARANTINE_RETENTION_DAYS = 7;
var QUARANTINE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
var recoveryOnce = /* @__PURE__ */ new Map();
function resetRecoveryLatchForTests() {
  recoveryOnce.clear();
}
__name(resetRecoveryLatchForTests, "resetRecoveryLatchForTests");
async function isRealDirectory(p) {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}
__name(isRealDirectory, "isRealDirectory");
async function sweepDownloads(downloadsDir) {
  if (!await isRealDirectory(downloadsDir)) return;
  let names;
  try {
    names = await fs.readdir(downloadsDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - PART_RETENTION_MS;
  for (const name of names) {
    if (!name.endsWith(".part")) continue;
    const p = path.join(downloadsDir, name);
    try {
      const st = await fs.lstat(p);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        await fs.rm(p, { force: true });
        debugLogger.debug(`recovery: removed expired download ${name}`);
      }
    } catch {
    }
  }
}
__name(sweepDownloads, "sweepDownloads");
async function sweepStaging(stagingDir) {
  if (!await isRealDirectory(stagingDir)) return;
  let names;
  try {
    names = await fs.readdir(stagingDir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(stagingDir, name);
    try {
      const st = await fs.lstat(p);
      if (!st.isSymbolicLink() && Date.now() - st.mtimeMs < STAGING_GRACE_MS) {
        continue;
      }
      await fs.rm(p, { recursive: true, force: true });
      debugLogger.debug(`recovery: removed uncommitted staging ${name}`);
    } catch {
    }
  }
}
__name(sweepStaging, "sweepStaging");
async function directorySizeBytes(dir) {
  let total = 0;
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return total;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fs.lstat(p);
      if (st.isFile()) {
        total += st.size;
      } else if (st.isDirectory()) {
        total += await directorySizeBytes(p);
      }
    } catch {
    }
  }
  return total;
}
__name(directorySizeBytes, "directorySizeBytes");
async function sweepQuarantine(quarantineDir, retentionMs, maxBytes) {
  if (!await isRealDirectory(quarantineDir)) return;
  let names;
  try {
    names = await fs.readdir(quarantineDir);
  } catch {
    return;
  }
  const entries = [];
  const cutoff = Date.now() - retentionMs;
  for (const name of names) {
    const p = path.join(quarantineDir, name);
    if (!await isRealDirectory(p)) continue;
    try {
      const st = await fs.lstat(p);
      if (st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true });
        debugLogger.debug(`recovery: removed expired quarantine ${name}`);
        continue;
      }
      entries.push({
        name,
        mtimeMs: st.mtimeMs,
        sizeBytes: await directorySizeBytes(p)
      });
    } catch {
    }
  }
  let total = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  if (total <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    try {
      await fs.rm(path.join(quarantineDir, entry.name), {
        recursive: true,
        force: true
      });
      total -= entry.sizeBytes;
      debugLogger.debug(
        `recovery: removed quarantine ${entry.name} (over size budget)`
      );
    } catch {
    }
  }
}
__name(sweepQuarantine, "sweepQuarantine");
async function sweepTmpFiles(objectsDir) {
  if (!await isRealDirectory(objectsDir)) return;
  let shards;
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return;
  }
  for (const shard of shards) {
    const shardDir = path.join(objectsDir, shard);
    if (!await isRealDirectory(shardDir)) continue;
    let names;
    try {
      names = await fs.readdir(shardDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(".tmp-")) continue;
      const p = path.join(shardDir, name);
      try {
        const st = await fs.lstat(p);
        if (Date.now() - st.mtimeMs < TMP_GRACE_MS) continue;
        await fs.rm(p, { force: true });
        debugLogger.debug(`recovery: removed orphan temp ${shard}/${name}`);
      } catch {
      }
    }
  }
}
__name(sweepTmpFiles, "sweepTmpFiles");
async function sampleVerifyObjects(objectsDir, uploadCache, degradationCache, limit, maxBytes) {
  const candidates = [];
  if (!await isRealDirectory(objectsDir)) return;
  let shards;
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return;
  }
  for (const shard of shards) {
    if (!await isRealDirectory(path.join(objectsDir, shard))) continue;
    let names = [];
    try {
      names = await fs.readdir(path.join(objectsDir, shard));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(".")) candidates.push(path.join(shard, name));
    }
  }
  if (candidates.length === 0 || limit <= 0) return;
  candidates.sort();
  const n = candidates.length;
  const stride = Math.max(1, Math.floor(n / limit));
  const seed = Math.floor(Date.now() / 864e5) % n;
  const picked = /* @__PURE__ */ new Set();
  for (let k = 0; k < limit && picked.size < n; k++) {
    picked.add((seed + k * stride) % n);
  }
  for (const i of picked) {
    const rel = candidates[i];
    const full = path.join(objectsDir, rel);
    const expected = path.basename(rel).split(".")[0];
    try {
      const st = await fs.lstat(full);
      if (!st.isFile()) continue;
      if (st.size > maxBytes) continue;
      const hash = createHash("sha256");
      await pipeline(createReadStream(full), hash);
      if (hash.digest("hex") !== expected) {
        await fs.rm(full, { force: true });
        await uploadCache?.removeBySha256(expected);
        await degradationCache?.removeByOriginalSha256(expected);
        await degradationCache?.removeByDegradedSha256(expected);
        debugLogger.debug(
          `recovery: removed corrupt object ${rel} (hash mismatch)`
        );
      }
    } catch {
    }
  }
}
__name(sampleVerifyObjects, "sampleVerifyObjects");
function runStartupRecoveryOnce(store, uploadCache, options) {
  let root;
  try {
    root = store.getOmniRootDir();
  } catch (err) {
    debugLogger.debug(
      `recovery scan failed (ignored): ${err instanceof Error ? err.message : err}`
    );
    return Promise.resolve();
  }
  let scan = recoveryOnce.get(root);
  if (!scan) {
    scan = (async () => {
      if (!await isRealDirectory(root)) return;
      await sweepStaging(path.join(root, "staging"));
      await sweepDownloads(path.join(root, "downloads"));
      await sweepQuarantine(
        path.join(root, "quarantine"),
        (options?.quarantineRetentionDays ?? QUARANTINE_RETENTION_DAYS) * 864e5,
        options?.quarantineMaxBytes ?? QUARANTINE_MAX_BYTES
      );
      if (!await isRealDirectory(path.join(root, "objects"))) return;
      await sweepTmpFiles(store.getObjectsDir());
      await sampleVerifyObjects(
        store.getObjectsDir(),
        uploadCache,
        options?.degradationCache,
        options?.sampleVerifyLimit ?? SAMPLE_VERIFY_LIMIT,
        options?.sampleVerifyMaxBytes ?? SAMPLE_VERIFY_MAX_BYTES
      );
    })().catch((err) => {
      debugLogger.debug(
        `recovery scan failed (ignored): ${err instanceof Error ? err.message : err}`
      );
    });
    recoveryOnce.set(root, scan);
  }
  return scan;
}
__name(runStartupRecoveryOnce, "runStartupRecoveryOnce");

// packages/core/src/omni/policy/conditions.ts
init_esbuild_shims();
var RESOURCE_CONDITION_FIELDS = [
  "sizeBytes",
  "durationMs",
  "width",
  "height",
  "maxWidth",
  "maxHeight",
  "frameRate",
  "frameCount",
  "bitRate",
  "sampleRateHz",
  "channels",
  "estimatedTokenCount"
];
var REQUEST_CONDITION_FIELDS = ["totalEstimatedMediaTokens"];
var SESSION_CONDITION_FIELDS = [
  "contextWindowTokens",
  "promptTokenCount",
  "reservedOutputTokens",
  "availableContextTokens"
];
var MEMORY_CONDITION_FIELDS = [
  "hasTranscript",
  "hasOcr",
  "hasCaption",
  "hasSummary",
  "hasKeyframes",
  "hasClip"
];
var MATCH = { outcome: "match" };
var NO_MATCH = { outcome: "no_match" };
function unavailable(missingFields) {
  return { outcome: "unavailable", missingFields: [...new Set(missingFields)] };
}
__name(unavailable, "unavailable");
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
__name(isPlainObject, "isPlainObject");
var COMPARISON_OPERATORS = [
  ">",
  ">=",
  "<",
  "<=",
  "==",
  "!="
];
function isComparisonOperator(v) {
  return COMPARISON_OPERATORS.includes(v);
}
__name(isComparisonOperator, "isComparisonOperator");
var KNOWN_FIELDS = /* @__PURE__ */ new Set([
  ...RESOURCE_CONDITION_FIELDS.map((f) => `resource.${f}`),
  ...REQUEST_CONDITION_FIELDS.map((f) => `request.${f}`),
  ...SESSION_CONDITION_FIELDS.map((f) => `session.${f}`),
  ...MEMORY_CONDITION_FIELDS.map((f) => `memory.${f}`)
]);
function conditionUsesNamespace(condition, namespace) {
  const node = condition;
  if (!Array.isArray(node)) return false;
  const prefix = `${namespace}.`;
  for (const operand of node) {
    if (!Array.isArray(operand)) continue;
    if (operand.length === 2 && operand[0] === "field" && typeof operand[1] === "string") {
      if (operand[1].startsWith(prefix)) return true;
      continue;
    }
    if (conditionUsesNamespace(operand, namespace)) {
      return true;
    }
  }
  return false;
}
__name(conditionUsesNamespace, "conditionUsesNamespace");
function resolveOperand(operand, context) {
  if (Array.isArray(operand)) {
    if (operand.length !== 2 || operand[0] !== "field" || typeof operand[1] !== "string") {
      return { ok: false, missing: "<malformed operand>" };
    }
    const field = operand[1];
    if (!KNOWN_FIELDS.has(field)) {
      return { ok: false, missing: field };
    }
    const [namespace, name] = field.split(".");
    const value = context[namespace]?.[name];
    if (typeof value !== "number" || Number.isNaN(value)) {
      return { ok: false, missing: field };
    }
    return { ok: true, value, describe: field };
  }
  if (typeof operand === "number" || typeof operand === "string" || typeof operand === "boolean") {
    return { ok: true, value: operand, describe: "value" };
  }
  return { ok: false, missing: "<malformed operand>" };
}
__name(resolveOperand, "resolveOperand");
function evaluateComparison(operator, leftRaw, rightRaw, context) {
  const left = resolveOperand(leftRaw, context);
  const right = resolveOperand(rightRaw, context);
  if (!left.ok || !right.ok) {
    const missing = [];
    if (!left.ok) missing.push(left.missing);
    if (!right.ok) missing.push(right.missing);
    return unavailable(missing);
  }
  if (operator === "==" || operator === "!=") {
    const equal = left.value === right.value;
    return equal === (operator === "==") ? MATCH : NO_MATCH;
  }
  if (typeof left.value !== "number" || typeof right.value !== "number" || !Number.isFinite(left.value) || !Number.isFinite(right.value)) {
    const missing = [];
    if (typeof left.value !== "number" || !Number.isFinite(left.value)) {
      missing.push(`${left.describe} (not orderable)`);
    }
    if (typeof right.value !== "number" || !Number.isFinite(right.value)) {
      missing.push(`${right.describe} (not orderable)`);
    }
    return unavailable(missing);
  }
  switch (operator) {
    case ">":
      return left.value > right.value ? MATCH : NO_MATCH;
    case ">=":
      return left.value >= right.value ? MATCH : NO_MATCH;
    case "<":
      return left.value < right.value ? MATCH : NO_MATCH;
    case "<=":
      return left.value <= right.value ? MATCH : NO_MATCH;
    default: {
      const exhaustive = operator;
      return unavailable([`unknown operator ${String(exhaustive)}`]);
    }
  }
}
__name(evaluateComparison, "evaluateComparison");
function evaluateFixedPolicyCondition(condition, context) {
  const node = condition;
  if (!Array.isArray(node) || node.length === 0) {
    return unavailable(["<malformed condition>"]);
  }
  const head = node[0];
  if (head === "all" || head === "any") {
    const isAll = head === "all";
    const missing = [];
    let sawUnavailable = false;
    for (let i = 1; i < node.length; i++) {
      const result = evaluateFixedPolicyCondition(
        node[i],
        context
      );
      if (result.outcome === "unavailable") {
        sawUnavailable = true;
        missing.push(...result.missingFields);
        continue;
      }
      if (isAll && result.outcome === "no_match") return NO_MATCH;
      if (!isAll && result.outcome === "match") return MATCH;
    }
    if (sawUnavailable) return unavailable(missing);
    return isAll ? MATCH : NO_MATCH;
  }
  if (head === "!") {
    if (node.length !== 2) {
      return unavailable(["<malformed condition>"]);
    }
    const result = evaluateFixedPolicyCondition(
      node[1],
      context
    );
    if (result.outcome === "unavailable") return result;
    return result.outcome === "match" ? NO_MATCH : MATCH;
  }
  if (isComparisonOperator(head) && node.length === 3) {
    return evaluateComparison(head, node[1], node[2], context);
  }
  return unavailable(["<malformed condition>"]);
}
__name(evaluateFixedPolicyCondition, "evaluateFixedPolicyCondition");
function validateOperand(raw, operator, where, errors) {
  if (Array.isArray(raw)) {
    if (raw.length !== 2 || raw[0] !== "field") {
      errors.push(
        `${where}: field reference must be ["field", "<namespace.field>"]`
      );
      return;
    }
    if (typeof raw[1] !== "string" || !KNOWN_FIELDS.has(raw[1])) {
      errors.push(`${where}: unknown field ${JSON.stringify(raw[1])}`);
    }
    return;
  }
  if (typeof raw !== "number" && typeof raw !== "string" && typeof raw !== "boolean") {
    errors.push(`${where}: literal must be a number, string, or boolean`);
    return;
  }
  if (operator !== "==" && operator !== "!=") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(
        `${where}: operator "${operator}" requires a finite numeric literal`
      );
    }
  }
}
__name(validateOperand, "validateOperand");
function validateFixedPolicyCondition(raw, where = "when") {
  const errors = [];
  if (isPlainObject(raw)) {
    errors.push(
      `${where}: condition must be an expression array like [">", ["field", "resource.width"], 3000] or ["all", <expr>, ...] (the {left, operator, right} object form is no longer supported)`
    );
    return errors;
  }
  if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== "string") {
    errors.push(
      `${where}: condition must be an expression array [operator, ...operands]`
    );
    return errors;
  }
  const head = raw[0];
  if (head === "all" || head === "any") {
    if (raw.length < 2) {
      errors.push(
        `${where}: "${head}" requires at least one operand condition`
      );
      return errors;
    }
    for (let i = 1; i < raw.length; i++) {
      errors.push(...validateFixedPolicyCondition(raw[i], `${where}[${i}]`));
    }
    return errors;
  }
  if (head === "!") {
    if (raw.length !== 2) {
      errors.push(`${where}: "!" takes exactly one operand condition`);
      return errors;
    }
    errors.push(...validateFixedPolicyCondition(raw[1], `${where}[1]`));
    return errors;
  }
  if (!isComparisonOperator(head)) {
    errors.push(
      `${where}[0]: unknown operator ${JSON.stringify(head)} (expected one of ${COMPARISON_OPERATORS.join(", ")}, all, any, !)`
    );
    return errors;
  }
  if (raw.length !== 3) {
    errors.push(`${where}: comparison "${head}" takes exactly two operands`);
    return errors;
  }
  validateOperand(raw[1], head, `${where}[1]`, errors);
  validateOperand(raw[2], head, `${where}[2]`, errors);
  return errors;
}
__name(validateFixedPolicyCondition, "validateFixedPolicyCondition");

// packages/core/src/omni/policy/config.ts
var OmniPolicyConfigError = class extends Error {
  static {
    __name(this, "OmniPolicyConfigError");
  }
  constructor(message) {
    super(message);
    this.name = "OmniPolicyConfigError";
  }
};
var DEFAULT_OMNI_PROCESSING_LIMITS = {
  maxConcurrentResources: 1,
  reservedOutputTokens: 8192,
  maxLineageDepth: 8,
  maxPolicyRunsPerRoot: 64,
  maxArtifactsPerRoot: 256,
  maxDerivedBytesPerRoot: 1024 * 1024 * 1024,
  maxTransportPasses: 3
};
var GIB = 1024 * 1024 * 1024;
var MAX_UPLOAD_FILE_BYTES_CEILING = GIB;
var MAX_URL_TTL_HOURS = 48;
var POLICY_ENTRY_KEYS = /* @__PURE__ */ new Set([
  "priority",
  "mediaTypes",
  "origins",
  "when",
  "onConditionUnavailable",
  "toolName",
  "arguments",
  "maxRunsPerLineage",
  "onFailure",
  "output",
  "description"
]);
var MAX_POLICY_DESCRIPTION_CHARS = 600;
var OUTPUT_KEYS = /* @__PURE__ */ new Set(["reprocessMedia", "source", "artifacts"]);
var ARTIFACT_SELECTOR_KINDS = /* @__PURE__ */ new Set(["image", "video", "audio", "file"]);
var MODALITIES = ["image", "video", "audio"];
var ORIGINS = ["user", "tool", "policy"];
var RESERVED_ARGUMENT_KEYS = ["inputPath", "outputDir", "resourceId"];
var POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function systemDefaultTransportGuardPolicies() {
  return {
    "image-downsample": {
      mediaTypes: ["image"],
      toolName: ToolNames.OMNI_DOWNSAMPLE_IMAGE
    },
    "video-downscale": {
      mediaTypes: ["video"],
      toolName: ToolNames.OMNI_DOWNSCALE_VIDEO
    },
    "audio-downsample": {
      mediaTypes: ["audio"],
      toolName: ToolNames.OMNI_DOWNSAMPLE_AUDIO
    }
  };
}
__name(systemDefaultTransportGuardPolicies, "systemDefaultTransportGuardPolicies");
function fail(message) {
  throw new OmniPolicyConfigError(message);
}
__name(fail, "fail");
function rejectUnknownKeys(record, where, known) {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      fail(`${where}: unknown key "${key}"`);
    }
  }
}
__name(rejectUnknownKeys, "rejectUnknownKeys");
function requirePositiveInteger(value, where, { allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    fail(
      `${where}: must be ${allowZero ? "a non-negative" : "a positive"} integer (got ${JSON.stringify(value)})`
    );
  }
  return value;
}
__name(requirePositiveInteger, "requirePositiveInteger");
function mergePolicyMaps(defaults, raw, where, { allowTombstones }) {
  const merged = Object.assign(
    /* @__PURE__ */ Object.create(null),
    defaults
  );
  if (raw === void 0) {
    return merged;
  }
  if (!isPlainRecord(raw)) {
    fail(`${where}: must be an object map of policy id \u2192 policy`);
  }
  for (const [id, entry] of Object.entries(raw)) {
    if (entry === null) {
      if (!allowTombstones) {
        fail(
          `${where}.${id}: transport guard policies cannot be removed (the guard is mandatory); override the entry instead`
        );
      }
      delete merged[id];
      continue;
    }
    if (!isPlainRecord(entry)) {
      fail(`${where}.${id}: must be an object (or null to remove a default)`);
    }
    merged[id] = entry;
  }
  return merged;
}
__name(mergePolicyMaps, "mergePolicyMaps");
function normalizePolicy(id, entry, stage, where, tools) {
  if (!POLICY_ID_PATTERN.test(id)) {
    fail(
      `${where}.${id}: policy id must match ${POLICY_ID_PATTERN} (letters, digits, ".", "_", "-")`
    );
  }
  for (const key of Object.keys(entry)) {
    if (!POLICY_ENTRY_KEYS.has(key)) {
      fail(`${where}.${id}: unknown key "${key}"`);
    }
  }
  let description;
  if (entry["description"] !== void 0) {
    if (typeof entry["description"] !== "string") {
      fail(`${where}.${id}.description: must be a string`);
    }
    const trimmed = entry["description"].trim();
    if (trimmed.length > MAX_POLICY_DESCRIPTION_CHARS) {
      fail(
        `${where}.${id}.description: must be \u2264 ${MAX_POLICY_DESCRIPTION_CHARS} characters (got ${trimmed.length})`
      );
    }
    if (trimmed.length > 0) description = trimmed;
  }
  const priority = entry["priority"] === void 0 ? 0 : typeof entry["priority"] === "number" && Number.isFinite(entry["priority"]) ? entry["priority"] : fail(`${where}.${id}.priority: must be a finite number`);
  const rawMediaTypes = entry["mediaTypes"];
  if (!Array.isArray(rawMediaTypes) || rawMediaTypes.length === 0) {
    fail(`${where}.${id}.mediaTypes: must be a non-empty array`);
  }
  for (const m of rawMediaTypes) {
    if (!MODALITIES.includes(m)) {
      fail(
        `${where}.${id}.mediaTypes: unknown modality ${JSON.stringify(m)} (expected ${MODALITIES.join(", ")})`
      );
    }
  }
  const mediaTypes = [...new Set(rawMediaTypes)];
  const rawOrigins = entry["origins"] ?? ["user", "tool"];
  if (!Array.isArray(rawOrigins) || rawOrigins.length === 0) {
    fail(`${where}.${id}.origins: must be a non-empty array`);
  }
  for (const o of rawOrigins) {
    if (!ORIGINS.includes(o)) {
      fail(
        `${where}.${id}.origins: unknown origin ${JSON.stringify(o)} (expected ${ORIGINS.join(", ")})`
      );
    }
  }
  const origins = [...new Set(rawOrigins)];
  const onConditionUnavailable = entry["onConditionUnavailable"] ?? "skip";
  if (onConditionUnavailable === "abortTurn") {
    fail(
      `${where}.${id}.onConditionUnavailable: "abortTurn" is not yet supported (design reserves it for a later stage); use "skip" or "run"`
    );
  }
  if (onConditionUnavailable !== "skip" && onConditionUnavailable !== "run") {
    fail(
      `${where}.${id}.onConditionUnavailable: must be "skip" or "run" (got ${JSON.stringify(onConditionUnavailable)})`
    );
  }
  const onFailure = entry["onFailure"] ?? "continue";
  if (onFailure !== "continue" && onFailure !== "abort") {
    fail(
      `${where}.${id}.onFailure: must be "continue" or "abort" (got ${JSON.stringify(onFailure)})`
    );
  }
  const maxRunsPerLineage = entry["maxRunsPerLineage"] === void 0 ? 1 : requirePositiveInteger(
    entry["maxRunsPerLineage"],
    `${where}.${id}.maxRunsPerLineage`
  );
  const rawOutput = entry["output"] ?? {};
  if (!isPlainRecord(rawOutput)) {
    fail(`${where}.${id}.output: must be an object`);
  }
  for (const key of Object.keys(rawOutput)) {
    if (!OUTPUT_KEYS.has(key)) {
      fail(`${where}.${id}.output: unknown key "${key}"`);
    }
  }
  const reprocessMedia = rawOutput["reprocessMedia"] ?? false;
  if (typeof reprocessMedia !== "boolean") {
    fail(`${where}.${id}.output.reprocessMedia: must be a boolean`);
  }
  const source = rawOutput["source"] ?? "omit";
  if (source !== "keep" && source !== "omit") {
    fail(
      `${where}.${id}.output.source: must be "keep" or "omit" (got ${JSON.stringify(source)})`
    );
  }
  if (stage === "transport_guard" && source !== "omit") {
    fail(
      `${where}.${id}.output.source: transport guard policies must use "omit" (the over-limit source cannot stay in the delivery set)`
    );
  }
  const rawArtifacts = rawOutput["artifacts"];
  let artifacts;
  if (rawArtifacts === void 0) {
    artifacts = { "*": "include" };
  } else {
    if (!isPlainRecord(rawArtifacts)) {
      fail(`${where}.${id}.output.artifacts: must be an object`);
    }
    artifacts = {};
    for (const [selector, action] of Object.entries(rawArtifacts)) {
      const at = `${where}.${id}.output.artifacts["${selector}"]`;
      if (action !== "include" && action !== "retain") {
        fail(
          `${at}: must be "include" or "retain" (got ${JSON.stringify(action)})`
        );
      }
      if (selector === "*") {
      } else if (selector.startsWith("kind:")) {
        const kind = selector.slice("kind:".length);
        if (!ARTIFACT_SELECTOR_KINDS.has(kind)) {
          fail(
            `${at}: unknown artifact kind "${kind}" (expected one of ${[...ARTIFACT_SELECTOR_KINDS].join(", ")})`
          );
        }
      } else if (selector.startsWith("role:")) {
        const role = selector.slice("role:".length);
        if (!POLICY_ID_PATTERN.test(role)) {
          fail(`${at}: invalid role token ${JSON.stringify(role)}`);
        }
      } else {
        fail(
          `${at}: unknown selector (expected "*", "kind:<kind>", or "role:<role>")`
        );
      }
      artifacts[selector] = action;
    }
  }
  let when;
  if (entry["when"] !== void 0) {
    if (stage === "transport_guard") {
      fail(
        `${where}.${id}.when: transport guard policies must not declare "when" (they run exactly when transport limits are exceeded)`
      );
    }
    const errors = validateFixedPolicyCondition(
      entry["when"],
      `${where}.${id}.when`
    );
    if (errors.length > 0) {
      fail(errors.join("; "));
    }
    when = entry["when"];
  }
  const toolName = entry["toolName"];
  if (typeof toolName !== "string" || toolName.length === 0) {
    fail(`${where}.${id}.toolName: must be a non-empty string`);
  }
  const tool = tools.getTool(toolName);
  if (!tool) {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" is not registered (unknown name, or excluded by tool filtering)`
    );
  }
  const descriptor = tool.mediaPolicyDescriptor;
  if (!descriptor || descriptor.kind !== "media_policy") {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" is not a media policy tool (no media_policy descriptor)`
    );
  }
  if (!descriptor.outputs.some((o) => o.required)) {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" declares no required output; a fixed policy cannot rely on it producing anything`
    );
  }
  const hasLossyMedia = descriptor.outputs.some(
    (o) => o.kind === "media" && o.lossy
  );
  const hasDisclosure = descriptor.outputs.some(
    (o) => o.kind === "text" && o.role === "disclosure"
  );
  if (hasLossyMedia && !hasDisclosure) {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" declares a lossy media output but no disclosure text output`
    );
  }
  for (const m of mediaTypes) {
    if (!descriptor.inputMediaTypes.includes(m)) {
      fail(
        `${where}.${id}.mediaTypes: tool "${toolName}" does not accept "${m}" input (accepts ${descriptor.inputMediaTypes.join(", ")})`
      );
    }
  }
  {
    const producibleKinds = /* @__PURE__ */ new Set();
    const producibleRoleSpecs = /* @__PURE__ */ new Map();
    for (const o of descriptor.outputs) {
      if (o.kind === "media") {
        for (const mimeType of o.mimeTypes ?? []) {
          producibleKinds.add(mimeType.split("/")[0]);
        }
        if (o.role && !producibleRoleSpecs.has(o.role)) {
          producibleRoleSpecs.set(o.role, o);
        }
      } else if (o.kind === "file") {
        producibleKinds.add("file");
        if (o.role && !producibleRoleSpecs.has(o.role)) {
          producibleRoleSpecs.set(o.role, o);
        }
      }
    }
    for (const selector of Object.keys(artifacts)) {
      const at = `${where}.${id}.output.artifacts["${selector}"]`;
      if (selector === "*") continue;
      if (selector.startsWith("kind:")) {
        const kind = selector.slice("kind:".length);
        if (!producibleKinds.has(kind)) {
          fail(
            `${at}: tool "${toolName}" declares no output of kind "${kind}"`
          );
        }
        continue;
      }
      const role = selector.slice("role:".length);
      const spec = producibleRoleSpecs.get(role);
      if (!spec) {
        fail(
          `${at}: tool "${toolName}" declares no artifact output with role "${role}"`
        );
      }
      if (role === "transcript" && (spec.kind !== "file" || spec.mimeTypes?.length !== 1 || spec.mimeTypes[0] !== "text/plain")) {
        fail(
          `${at}: a transcript selector must point at a bounded UTF-8 text/plain file output, but tool "${toolName}" declares role "transcript" differently`
        );
      }
    }
  }
  const args = entry["arguments"] ?? {};
  if (!isPlainRecord(args)) {
    fail(`${where}.${id}.arguments: must be an object`);
  }
  for (const reserved of RESERVED_ARGUMENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, reserved)) {
      fail(
        `${where}.${id}.arguments: "${reserved}" is injected by the orchestrator per invocation and must not be configured`
      );
    }
  }
  if (descriptor.settingsSchema) {
    const schemaError = SchemaValidator.validate(
      descriptor.settingsSchema,
      args
    );
    if (schemaError) {
      fail(`${where}.${id}.arguments: ${schemaError}`);
    }
  }
  return {
    id,
    priority,
    mediaTypes,
    origins,
    when,
    onConditionUnavailable,
    toolName,
    arguments: args,
    maxRunsPerLineage,
    onFailure,
    output: { reprocessMedia, source, artifacts },
    stage,
    ...description !== void 0 ? { description } : {}
  };
}
__name(normalizePolicy, "normalizePolicy");
function normalizeLimits(raw) {
  if (raw === void 0) {
    return { ...DEFAULT_OMNI_PROCESSING_LIMITS };
  }
  if (!isPlainRecord(raw)) {
    fail("omni.processing.limits: must be an object");
  }
  const limits = { ...DEFAULT_OMNI_PROCESSING_LIMITS };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(limits, key)) {
      fail(`omni.processing.limits: unknown key "${key}"`);
    }
    limits[key] = requirePositiveInteger(value, `omni.processing.limits.${key}`, {
      // Reserving zero output tokens is odd but not incoherent.
      allowZero: key === "reservedOutputTokens"
    });
  }
  return limits;
}
__name(normalizeLimits, "normalizeLimits");
function lowerBoundOf(s) {
  let bound;
  if (typeof s["minimum"] === "number") {
    bound = { value: s["minimum"], exclusive: false };
  }
  if (typeof s["exclusiveMinimum"] === "number") {
    const b = { value: s["exclusiveMinimum"], exclusive: true };
    if (!bound || b.value >= bound.value) bound = b;
  }
  return bound;
}
__name(lowerBoundOf, "lowerBoundOf");
function upperBoundOf(s) {
  let bound;
  if (typeof s["maximum"] === "number") {
    bound = { value: s["maximum"], exclusive: false };
  }
  if (typeof s["exclusiveMaximum"] === "number") {
    const b = { value: s["exclusiveMaximum"], exclusive: true };
    if (!bound || b.value <= bound.value) bound = b;
  }
  return bound;
}
__name(upperBoundOf, "upperBoundOf");
function findProjectionLoosening(native, override) {
  const merged = { ...native, ...override };
  if (typeof native["type"] === "string" && merged["type"] !== native["type"]) {
    if (!(native["type"] === "number" && merged["type"] === "integer")) {
      return `"type" changes the native type (${JSON.stringify(merged["type"])} vs native "${native["type"]}")`;
    }
  }
  if (Array.isArray(native["enum"])) {
    if (!Array.isArray(merged["enum"])) {
      return '"enum" replaces the native enum with a non-array';
    }
    const allowed = new Set(native["enum"].map((v) => JSON.stringify(v)));
    const added = merged["enum"].filter((v) => !allowed.has(JSON.stringify(v)));
    if (added.length > 0) {
      return `"enum" adds values the native enum does not allow (${added.map((v) => JSON.stringify(v)).join(", ")})`;
    }
  }
  const nativeLower = lowerBoundOf(native);
  if (nativeLower) {
    const mergedLower = lowerBoundOf(merged);
    if (!mergedLower || mergedLower.value < nativeLower.value || mergedLower.value === nativeLower.value && nativeLower.exclusive && !mergedLower.exclusive) {
      return `the lower bound loosens the native one (${mergedLower?.value ?? "none"} vs native ${nativeLower.value})`;
    }
  }
  const nativeUpper = upperBoundOf(native);
  if (nativeUpper) {
    const mergedUpper = upperBoundOf(merged);
    if (!mergedUpper || mergedUpper.value > nativeUpper.value || mergedUpper.value === nativeUpper.value && nativeUpper.exclusive && !mergedUpper.exclusive) {
      return `the upper bound loosens the native one (${mergedUpper?.value ?? "none"} vs native ${nativeUpper.value})`;
    }
  }
  for (const key of ["minLength", "minItems"]) {
    const n = native[key];
    if (typeof n !== "number") continue;
    const m = merged[key];
    if (typeof m !== "number" || m < n) {
      return `"${key}" loosens the native constraint (${JSON.stringify(m)} vs native ${n})`;
    }
  }
  for (const key of ["maxLength", "maxItems"]) {
    const n = native[key];
    if (typeof n !== "number") continue;
    const m = merged[key];
    if (typeof m !== "number" || m > n) {
      return `"${key}" loosens the native constraint (${JSON.stringify(m)} vs native ${n})`;
    }
  }
  return void 0;
}
__name(findProjectionLoosening, "findProjectionLoosening");
function validatePolicyTools(policyTools, tools) {
  if (policyTools === void 0) return;
  if (!isPlainRecord(policyTools)) {
    fail("omni.processing.policyTools: must be an object map");
  }
  for (const [toolName, entry] of Object.entries(policyTools)) {
    const where = `omni.processing.policyTools.${toolName}`;
    if (entry === null) continue;
    if (!isPlainRecord(entry)) {
      fail(`${where}: must be an object`);
    }
    const tool = tools.getTool(toolName);
    if (!tool?.mediaPolicyDescriptor) {
      fail(`${where}: "${toolName}" is not a registered media policy tool`);
    }
    const descriptor = tool.mediaPolicyDescriptor;
    rejectUnknownKeys(entry, where, ["settings", "runtime", "modelAccess"]);
    if (entry["settings"] !== void 0) {
      if (!isPlainRecord(entry["settings"])) {
        fail(`${where}.settings: must be an object`);
      }
      if (descriptor.settingsSchema) {
        const error = SchemaValidator.validate(
          descriptor.settingsSchema,
          entry["settings"]
        );
        if (error) {
          fail(`${where}.settings: ${error}`);
        }
      }
    }
    if (entry["runtime"] !== void 0) {
      if (!isPlainRecord(entry["runtime"])) {
        fail(`${where}.runtime: must be an object`);
      }
      rejectUnknownKeys(entry["runtime"], `${where}.runtime`, ["timeoutMs"]);
      const timeoutMs = entry["runtime"]["timeoutMs"];
      if (timeoutMs !== void 0) {
        requirePositiveInteger(timeoutMs, `${where}.runtime.timeoutMs`);
        if (timeoutMs >= STAGING_GRACE_MS) {
          fail(
            `${where}.runtime.timeoutMs: must be below the staging sweep grace window (${STAGING_GRACE_MS}ms) so a live invocation's staging directory is never reclaimed mid-run`
          );
        }
      }
    }
    const modelAccess = entry["modelAccess"];
    if (modelAccess === void 0) continue;
    if (!isPlainRecord(modelAccess)) {
      fail(`${where}.modelAccess: must be an object`);
    }
    rejectUnknownKeys(modelAccess, `${where}.modelAccess`, [
      "enabled",
      "description",
      "defaultArguments",
      "lockedArguments",
      "parameterSchema",
      "output"
    ]);
    const defaults = modelAccess["defaultArguments"];
    const locked = modelAccess["lockedArguments"];
    if (defaults !== void 0 && !isPlainRecord(defaults)) {
      fail(`${where}.modelAccess.defaultArguments: must be an object`);
    }
    if (locked !== void 0 && !isPlainRecord(locked)) {
      fail(`${where}.modelAccess.lockedArguments: must be an object`);
    }
    if (isPlainRecord(defaults) && isPlainRecord(locked)) {
      const conflicts = Object.keys(defaults).filter(
        (k) => Object.prototype.hasOwnProperty.call(locked, k)
      );
      if (conflicts.length > 0) {
        fail(
          `${where}.modelAccess: ${conflicts.map((k) => `"${k}"`).join(", ")} present in both defaultArguments and lockedArguments`
        );
      }
    }
    const nativeSchema = tool.parameterSchema;
    const nativeProperties = isPlainRecord(nativeSchema) && isPlainRecord(nativeSchema["properties"]) ? nativeSchema["properties"] : void 0;
    if (nativeProperties !== void 0) {
      for (const [label, record] of [
        ["defaultArguments", defaults],
        ["lockedArguments", locked]
      ]) {
        if (!isPlainRecord(record)) continue;
        const error = SchemaValidator.validate(
          {
            type: "object",
            properties: nativeProperties,
            additionalProperties: false
          },
          record
        );
        if (error) {
          fail(`${where}.modelAccess.${label}: ${error}`);
        }
      }
    }
    const projection = modelAccess["parameterSchema"];
    if (projection !== void 0) {
      if (!isPlainRecord(projection)) {
        fail(`${where}.modelAccess.parameterSchema: must be an object`);
      }
      const projectionProps = isPlainRecord(projection["properties"]) ? Object.keys(projection["properties"]) : [];
      const nativeProps = nativeProperties !== void 0 ? new Set(Object.keys(nativeProperties)) : /* @__PURE__ */ new Set();
      const introduced = projectionProps.filter((p) => !nativeProps.has(p));
      if (introduced.length > 0) {
        fail(
          `${where}.modelAccess.parameterSchema: ${introduced.map((p) => `"${p}"`).join(", ")} not present in the tool's native schema (projection may only narrow)`
        );
      }
      if (isPlainRecord(projection["properties"]) && nativeProperties !== void 0) {
        for (const [prop, override] of Object.entries(
          projection["properties"]
        )) {
          const native = nativeProperties[prop];
          if (!isPlainRecord(override) || !isPlainRecord(native)) continue;
          const loosening = findProjectionLoosening(native, override);
          if (loosening !== void 0) {
            fail(
              `${where}.modelAccess.parameterSchema.properties.${prop}: ${loosening} (projection may only narrow)`
            );
          }
        }
      }
    }
  }
}
__name(validatePolicyTools, "validatePolicyTools");
function normalizeOmniProcessingConfig(raw, tools) {
  if (raw.maxUploadFileBytes !== void 0) {
    const bytes = requirePositiveInteger(
      raw.maxUploadFileBytes,
      "omni.processing.transportGuard.maxUploadFileBytes"
    );
    if (bytes > MAX_UPLOAD_FILE_BYTES_CEILING) {
      fail(
        `omni.processing.transportGuard.maxUploadFileBytes: ${bytes} exceeds the DashScope per-file upload cap (${MAX_UPLOAD_FILE_BYTES_CEILING})`
      );
    }
  }
  if (raw.maxEstimatedTokens !== void 0) {
    const tokens = raw.maxEstimatedTokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
      fail(
        `omni.processing.transportGuard.maxEstimatedTokens: must be a finite number >= 0, where 0 disables the token guard (got ${JSON.stringify(tokens)})`
      );
    }
  }
  if (raw.urlTtlHours !== void 0) {
    const ttl = raw.urlTtlHours;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0 || ttl > MAX_URL_TTL_HOURS) {
      fail(
        `omni.delivery.upload.urlTtlHours: must be a number between 0 and ${MAX_URL_TTL_HOURS} (got ${JSON.stringify(ttl)})`
      );
    }
  }
  const limits = normalizeLimits(raw.limits);
  validatePolicyTools(raw.policyTools, tools);
  const fixedMap = mergePolicyMaps(
    {},
    raw.fixedPolicies,
    "omni.processing.fixedPolicies",
    { allowTombstones: true }
  );
  const guardMap = mergePolicyMaps(
    systemDefaultTransportGuardPolicies(),
    raw.transportGuardPolicies,
    "omni.processing.transportGuard.policies",
    { allowTombstones: false }
  );
  const fixedPolicies = Object.entries(fixedMap).map(
    ([id, entry]) => normalizePolicy(
      id,
      entry,
      "preprocessing",
      "omni.processing.fixedPolicies",
      tools
    )
  );
  const transportGuardPolicies = Object.entries(guardMap).map(
    ([id, entry]) => normalizePolicy(
      id,
      entry,
      "transport_guard",
      "omni.processing.transportGuard.policies",
      tools
    )
  );
  if (transportGuardPolicies.length === 0) {
    fail(
      "omni.processing.transportGuard.policies: must not be empty (the transport guard is mandatory)"
    );
  }
  const covered = new Set(
    transportGuardPolicies.flatMap((policy) => policy.mediaTypes)
  );
  const uncovered = MODALITIES.filter((m) => !covered.has(m));
  if (uncovered.length > 0) {
    fail(
      `omni.processing.transportGuard.policies: no guard policy covers ${uncovered.join(", ")} \u2014 the merged set must cover image, video, and audio`
    );
  }
  for (const [where, set] of [
    ["omni.processing.fixedPolicies", fixedPolicies],
    ["omni.processing.transportGuard.policies", transportGuardPolicies]
  ]) {
    const inert = set.filter((p) => p.output.reprocessMedia);
    if (inert.length > 0 && !set.some((p) => p.origins.includes("policy"))) {
      fail(
        `${where}: ${inert.map((p) => `"${p.id}"`).join(", ")} sets output.reprocessMedia, but no policy in this set accepts origin "policy" \u2014 derivatives would re-enter matching and never match. Add "policy" to some policy's origins or drop reprocessMedia.`
      );
    }
  }
  return { fixedPolicies, transportGuardPolicies, limits };
}
__name(normalizeOmniProcessingConfig, "normalizeOmniProcessingConfig");

export {
  conditionUsesNamespace,
  evaluateFixedPolicyCondition,
  resetRecoveryLatchForTests,
  runStartupRecoveryOnce,
  OmniPolicyConfigError,
  DEFAULT_OMNI_PROCESSING_LIMITS,
  systemDefaultTransportGuardPolicies,
  normalizeOmniProcessingConfig
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
