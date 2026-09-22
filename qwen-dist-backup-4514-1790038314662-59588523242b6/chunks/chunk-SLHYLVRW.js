// Force strict mode and setup for ESM
"use strict";
import {
  serializeFileOperation
} from "./chunk-TFDCK56Y.js";
import {
  resolveMediaReference
} from "./chunk-MNU36NGH.js";
import {
  atomicWriteFile
} from "./chunk-CA63HYHU.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/media-memory/service.ts
init_esbuild_shims();
import { createHash } from "node:crypto";

// packages/core/src/services/media-memory/store.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var debugLogger = createDebugLogger("omni:memory");
var MAX_CORRUPT_BACKUPS = 2;
var MEDIA_MEMORY_FILE_NAME = "memory.json";
function emptySnapshot() {
  return {
    schemaVersion: 1,
    files: {},
    versions: {},
    executions: {},
    entries: {}
  };
}
__name(emptySnapshot, "emptySnapshot");
function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainRecord, "isPlainRecord");
function pruneMalformedRecords(snapshot) {
  const dropped = [];
  for (const collection of [
    "files",
    "versions",
    "executions",
    "entries"
  ]) {
    const records = snapshot[collection];
    for (const [key, value] of Object.entries(records)) {
      if (!isPlainRecord(value)) {
        delete records[key];
        dropped.push(`${collection}/${key}`);
      }
    }
  }
  if (dropped.length > 0) {
    debugLogger.debug(
      `dropped ${dropped.length} malformed memory record${dropped.length === 1 ? "" : "s"}: ${dropped.join(", ")}`
    );
  }
}
__name(pruneMalformedRecords, "pruneMalformedRecords");
var MediaMemoryStore = class {
  static {
    __name(this, "MediaMemoryStore");
  }
  filePath;
  omniRootDir;
  constructor(omniRootDir) {
    this.omniRootDir = omniRootDir;
    this.filePath = path.join(omniRootDir, MEDIA_MEMORY_FILE_NAME);
  }
  /**
   * Prefix (with trailing separator) under which the omni object store
   * keeps its content-addressed copies. A version whose `fileRef` starts
   * with this prefix anchors its only persistent bytes in the store —
   * the GC root collection matches on it.
   */
  omniObjectsPrefix() {
    return path.join(this.omniRootDir, "objects") + path.sep;
  }
  /**
   * Run one serialized operation against the snapshot. `fn` returns the
   * operation result plus whether it mutated the snapshot (triggering an
   * atomic save). When the document exists but cannot be read,
   * `unreadableResult` is returned and nothing is saved.
   */
  async transact(unreadableResult, fn) {
    return serializeFileOperation(this.filePath, async () => {
      const snapshot = await this.load();
      if (!snapshot) return unreadableResult;
      const { result, changed } = await fn(snapshot);
      if (changed) await this.save(snapshot);
      return result;
    });
  }
  /** Read-only view over the snapshot (recall, queries). */
  async read(unreadableResult, fn) {
    return this.transact(unreadableResult, async (snapshot) => ({
      result: await fn(snapshot)
    }));
  }
  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT" || code === "ENOTDIR") return emptySnapshot();
      debugLogger.debug(
        `memory read failed, operation skipped: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (isPlainRecord(parsed) && parsed.schemaVersion === 1 && isPlainRecord(parsed.files) && isPlainRecord(parsed.versions) && isPlainRecord(parsed.executions) && isPlainRecord(parsed.entries)) {
        pruneMalformedRecords(parsed);
        return parsed;
      }
      throw new Error("unexpected shape");
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup).catch(() => {
      });
      await this.pruneCorruptBackups();
      debugLogger.debug(`corrupt memory document backed up to ${backup}`);
      return emptySnapshot();
    }
  }
  async pruneCorruptBackups() {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.corrupt-`;
    try {
      const backups = (await fs.readdir(dir)).filter((n) => n.startsWith(prefix)).sort().reverse();
      for (const name of backups.slice(MAX_CORRUPT_BACKUPS)) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {
        });
      }
    } catch {
    }
  }
  async save(snapshot) {
    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 448
    });
    await atomicWriteFile(this.filePath, JSON.stringify(snapshot, null, 1), {
      mode: 384,
      forceMode: true,
      noFollow: true
    });
  }
};

// packages/core/src/services/media-memory/service.ts
var debugLogger2 = createDebugLogger("omni:memory");
var DEFAULT_MAX_INLINE_TEXT_BYTES = 65536;
var MEDIA_DETECTOR_VERSION = "omni-sniff-ffprobe/1";
function hashId(prefix, material) {
  return prefix + createHash("sha256").update(material).digest("hex").slice(0, 24);
}
__name(hashId, "hashId");
function fileIdFor(fileRef) {
  return hashId("f", fileRef);
}
__name(fileIdFor, "fileIdFor");
function derivedFileIdFor(objectPath, rootFileId) {
  return hashId("f", `${rootFileId}|${objectPath}`);
}
__name(derivedFileIdFor, "derivedFileIdFor");
function versionIdFor(fileId, sha256) {
  return hashId("v", `${fileId}|${sha256}`);
}
__name(versionIdFor, "versionIdFor");
function channelsFor(mediaType, role) {
  if (role === "transcript") return ["speech_text"];
  if (role === "ocr") return ["onscreen_text"];
  switch (mediaType) {
    case "image":
      return ["visual"];
    case "audio":
      return ["acoustic"];
    case "video":
      return ["visual", "acoustic"];
    default:
      return [];
  }
}
__name(channelsFor, "channelsFor");
function coverageFor(role) {
  if (role === "keyframe") return { mode: "sampled", scope: {} };
  if (role === "clip") return { mode: "partial", scope: {} };
  return { mode: "complete", scope: {} };
}
__name(coverageFor, "coverageFor");
function truncateUtf8(text, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let result = "";
  let bytes = 0;
  for (const ch of text) {
    const chBytes = encoder.encode(ch).byteLength;
    if (bytes + chBytes > maxBytes) break;
    result += ch;
    bytes += chBytes;
  }
  return result;
}
__name(truncateUtf8, "truncateUtf8");
var MediaMemoryService = class {
  static {
    __name(this, "MediaMemoryService");
  }
  store;
  maxInlineTextBytes;
  constructor(omniRootDir, options) {
    this.store = new MediaMemoryStore(omniRootDir);
    this.maxInlineTextBytes = options?.maxInlineTextBytes ?? DEFAULT_MAX_INLINE_TEXT_BYTES;
  }
  /**
   * Collection trigger 1 — FileRecognized (M §6.1). Preconditions are the
   * caller's contract: mediaType decided, FULL sha256 computed, metadata
   * and a definite probeStatus in hand. Idempotent upsert: same fileRef +
   * same content is a no-op; new content at a known fileRef creates a new
   * immutable version and moves CURRENT_VERSION.
   *
   * Returns undefined when persistence failed (logged, never thrown).
   */
  async recordFileRecognized(event) {
    try {
      return await this.store.transact(void 0, (snapshot) => {
        const commit = upsertRecognizedFile(snapshot, event, this.now());
        return { result: commit, changed: commit.changed };
      });
    } catch (err) {
      debugLogger2.debug(
        `recordFileRecognized failed for ${event.source.locator}: ${err instanceof Error ? err.message : err}`
      );
      return void 0;
    }
  }
  /**
   * Collection trigger 2 — OmniPolicySucceeded (M §6.4). One atomic
   * transaction commits the execution record, a file+version per derived
   * media output (DERIVED_FROM / PRODUCED_BY edges), and one entry per
   * output (HAS_OUTPUT edges). The executionId is deterministic in the
   * content-identity reuse key (source sha256 ⊕ omniConfigHash, M §11),
   * so degradation-cache hits and invocation replays converge on the
   * same execution node instead of duplicating it.
   *
   * Returns undefined when persistence failed (logged, never thrown) —
   * the delivery proceeds regardless.
   */
  async commitPolicySucceeded(input) {
    try {
      return await this.store.transact(void 0, (snapshot) => {
        const result = commitExecution(
          snapshot,
          input,
          this.maxInlineTextBytes,
          this.now()
        );
        return { result: result.commit, changed: result.changed };
      });
    } catch (err) {
      debugLogger2.debug(
        `commitPolicySucceeded failed for ${input.toolName} (invocation ${input.invocationId}): ${err instanceof Error ? err.message : err}`
      );
      return void 0;
    }
  }
  /**
   * Recorded outputs of a prior execution that already performed THIS
   * computation on THESE bytes (content-identity reuse key, M §11.3) —
   * the read side of «同文件同 settings 二次触发同一 policy：直接复用，
   * 无重复执行». Covers every output shape, so multi-output tools and text
   * products (transcripts) are reusable too, unlike the S4 degradation
   * cache which maps one input to a single media derivative.
   *
   * Returns locators and recorded provenance only: the caller must verify
   * the bytes still exist and still hash to `sha256` before reusing them
   * (memory.json is project-local and hand-editable — the same stance the
   * degradation-cache hit path takes). Undefined when nothing matches or
   * the store is unreadable (logged, never thrown).
   */
  async findReusableOutputs(sourceSha256, omniConfigHash) {
    try {
      return await this.store.read(void 0, (snapshot) => {
        const match = findReusableExecution(
          snapshot,
          `${sourceSha256}|${omniConfigHash}`,
          ""
        );
        if (!match) return void 0;
        const outputs = [];
        for (const entryId of match.outputRefs) {
          const entry = snapshot.entries[entryId];
          if (!entry?.artifactRef) return void 0;
          const managedId = entry.artifactRef.managedId;
          const sha256 = managedId?.startsWith("sha256/") ? managedId.slice("sha256/".length) : void 0;
          if (sha256 === void 0) return void 0;
          const version = entry.derivedVersionId ? snapshot.versions[entry.derivedVersionId] : void 0;
          const objectPath = version ? snapshot.files[version.fileId]?.fileRef : void 0;
          outputs.push({
            kind: entry.kind === "derived_media" ? "media" : "text",
            sha256,
            ...objectPath !== void 0 ? { objectPath } : {},
            mimeType: entry.artifactRef.mimeType,
            sizeBytes: entry.artifactRef.sizeBytes,
            ...entry.role !== void 0 ? { role: entry.role } : {},
            ...entry.disclosure !== void 0 ? { disclosure: entry.disclosure } : {}
          });
        }
        if (outputs.length === 0) return void 0;
        return { executionId: match.executionId, outputs };
      });
    } catch (err) {
      debugLogger2.debug(
        `findReusableOutputs failed: ${err instanceof Error ? err.message : err}`
      );
      return void 0;
    }
  }
  /**
   * The `memory.*` fixed-policy condition namespace (policy design
   * §4.1/4.4): the set of output ROLES recorded anywhere in the
   * subgraph rooted at the binding's version — the version itself plus
   * every version derived from it (DERIVED_FROM child edges), bounded to
   * the binding's root graph. This is what lets a `when` condition ask
   * "does memory already hold a transcript/OCR/caption for this file"
   * before deciding to run a policy — e.g. the §4.1 chain parents the
   * transcript entry to the EXTRACTED-AUDIO version, a child of the
   * video version being matched, so a same-version-only lookup would
   * never see it.
   *
   * Returns an EMPTY set when the version is unknown (nothing recorded
   * yet — a determinate "no roles"), and undefined only when the store
   * itself is unreadable (the caller maps that to condition
   * `unavailable`, never silently false). Persistence errors are logged,
   * never thrown (same failure stance as the rest of the facade).
   */
  async collectVersionOutputRoles(binding) {
    try {
      return await this.store.read(void 0, (snapshot) => {
        const start = snapshot.versions[binding.fileVersionId];
        if (!start) return /* @__PURE__ */ new Set();
        const roles = /* @__PURE__ */ new Set();
        const visited = /* @__PURE__ */ new Set();
        const queue = [start.fileVersionId];
        while (queue.length > 0) {
          const versionId = queue.shift();
          if (visited.has(versionId)) continue;
          visited.add(versionId);
          const version = snapshot.versions[versionId];
          if (!version) continue;
          const file = snapshot.files[version.fileId];
          if (!file || file.rootFileId !== binding.rootFileId) continue;
          for (const entry of Object.values(snapshot.entries)) {
            if (entry.parentVersionId === versionId && entry.role) {
              roles.add(entry.role);
            }
          }
          for (const child of Object.values(snapshot.versions)) {
            if (child.parentVersionId === versionId) {
              queue.push(child.fileVersionId);
            }
          }
        }
        return roles;
      });
    } catch (err) {
      debugLogger2.debug(
        `collectVersionOutputRoles failed: ${err instanceof Error ? err.message : err}`
      );
      return void 0;
    }
  }
  /**
   * Read-side lookup by LOCATOR, for the harness only (design M §9.2.1:
   * path/hash lookup is a harness capability; the model is confined to
   * session handles). Returns the CURRENT version of the File recorded at
   * this locator, whether or not the bytes are still on disk — which is
   * the point: it lets a remembered-but-missing file be re-anchored into a
   * session so its memory stays reachable.
   */
  async findBindingByFileRef(fileRef) {
    try {
      return await this.store.read(void 0, (snapshot) => {
        for (const file of Object.values(snapshot.files)) {
          if (file.fileRef !== fileRef) continue;
          const version = snapshot.versions[file.currentVersionId];
          if (!version) return void 0;
          return {
            binding: {
              fileId: file.fileId,
              fileVersionId: version.fileVersionId,
              rootFileId: file.rootFileId
            },
            mediaType: version.mediaType,
            sha256: version.sha256
          };
        }
        return void 0;
      });
    } catch (err) {
      debugLogger2.debug(
        `findBindingByFileRef failed: ${err instanceof Error ? err.message : err}`
      );
      return void 0;
    }
  }
  /**
   * The GC root set (storage design §6.2): every object hash any memory
   * record still references. Three distinct reference kinds exist and ALL
   * count — `entries[].artifactRef.managedId` (policy outputs),
   * managed-protocol `versions[].source.locator` (tool media anchor
   * their file identity in the object store), and versions of files
   * whose `fileRef` points INTO the object store while their source
   * keeps a different protocol (URL media: `source.locator` is the
   * original URL, but the staging download is deleted the turn it
   * lands, so the store copy named by the file's `fileRef` is the only
   * persistent bytes). The last kind is rooted by content hash: each
   * such version's bytes live in the store under its own sha256.
   *
   * Returns null when the store exists but cannot be read — the caller
   * must treat that as "roots unknown" and delete NOTHING (fail-closed:
   * an unreadable ledger must never read as an empty one). A store that
   * has never been written returns an empty set: nothing was ever
   * recorded, so nothing is referenced.
   */
  async collectManagedRefs() {
    const UNREADABLE = null;
    const objectsPrefix = this.store.omniObjectsPrefix();
    try {
      return await this.store.read(
        UNREADABLE,
        (snapshot) => {
          const refs = /* @__PURE__ */ new Set();
          const add = /* @__PURE__ */ __name((locator) => {
            if (locator?.startsWith("sha256/")) {
              refs.add(locator.slice("sha256/".length));
            }
          }, "add");
          for (const entry of Object.values(snapshot.entries)) {
            if (entry.artifactRef?.storage === "managed") {
              add(entry.artifactRef.managedId);
            }
          }
          for (const version of Object.values(snapshot.versions)) {
            if (version.source.protocol === "managed") {
              add(version.source.locator);
            }
            const file = snapshot.files[version.fileId];
            if (file?.fileRef.startsWith(objectsPrefix)) {
              refs.add(version.sha256);
            }
          }
          return refs;
        }
      );
    } catch (err) {
      debugLogger2.debug(
        `collectManagedRefs failed: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }
  /**
   * Read-side lookup for callers that hold bytes but no identity (the
   * reactive degradation ladder re-recognizes a stored object without
   * knowing which memory version it is). Returns the binding of the
   * newest version whose content hash matches, or undefined when memory
   * has never seen the content (or the store is unreadable — logged,
   * never thrown).
   */
  async findBindingBySha256(sha256) {
    try {
      return await this.store.read(void 0, (snapshot) => {
        let found = null;
        for (const version of Object.values(snapshot.versions)) {
          if (version.sha256 !== sha256) continue;
          const file = snapshot.files[version.fileId];
          if (!file) continue;
          if (found && found.createdAt >= version.createdAt) continue;
          found = {
            binding: {
              fileId: version.fileId,
              fileVersionId: version.fileVersionId,
              rootFileId: file.rootFileId
            },
            createdAt: version.createdAt
          };
        }
        return found?.binding;
      });
    } catch (err) {
      debugLogger2.debug(
        `findBindingBySha256 failed: ${err instanceof Error ? err.message : err}`
      );
      return void 0;
    }
  }
  /** Injectable for tests via subclassing; records are stamped once per
   * commit so all records of a transaction share one timestamp. */
  now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
};
function upsertRecognizedFile(snapshot, event, now) {
  const fileId = event.origin === "policy" && event.rootFileId !== void 0 ? derivedFileIdFor(event.fileRef, event.rootFileId) : fileIdFor(event.fileRef);
  const fileVersionId = versionIdFor(fileId, event.sha256);
  let changed = false;
  let file = snapshot.files[fileId];
  if (!file) {
    file = {
      fileId,
      rootFileId: event.rootFileId ?? fileId,
      fileRef: event.fileRef,
      origin: event.origin,
      currentVersionId: fileVersionId,
      createdAt: now
    };
    snapshot.files[fileId] = file;
    changed = true;
  }
  let version = snapshot.versions[fileVersionId];
  const created = !version;
  if (!version) {
    version = {
      fileVersionId,
      fileId,
      sha256: event.sha256,
      mediaType: event.mediaType,
      metadata: event.metadata,
      sizeBytes: event.sizeBytes,
      mimeType: event.mimeType,
      source: event.source,
      recognition: event.recognition,
      ...event.parentVersionId !== void 0 ? { parentVersionId: event.parentVersionId } : {},
      createdAt: now
    };
    snapshot.versions[fileVersionId] = version;
    changed = true;
  }
  if (file.currentVersionId !== fileVersionId) {
    file.currentVersionId = fileVersionId;
    changed = true;
  }
  return {
    fileId,
    fileVersionId,
    rootFileId: file.rootFileId,
    created,
    changed
  };
}
__name(upsertRecognizedFile, "upsertRecognizedFile");
function reuseKeyOf(snapshot, execution) {
  const sha = snapshot.versions[execution.sourceVersionId]?.sha256;
  return sha === void 0 ? void 0 : `${sha}|${execution.omniConfigHash}`;
}
__name(reuseKeyOf, "reuseKeyOf");
function findReusableExecution(snapshot, reuseKey, selfExecutionId) {
  let best;
  for (const candidate of Object.values(snapshot.executions)) {
    if (candidate.executionId === selfExecutionId) continue;
    if (candidate.reusedExecutionId !== void 0) continue;
    if (reuseKeyOf(snapshot, candidate) !== reuseKey) continue;
    if (!best || candidate.completedAt < best.completedAt || candidate.completedAt === best.completedAt && candidate.executionId < best.executionId) {
      best = candidate;
    }
  }
  return best;
}
__name(findReusableExecution, "findReusableExecution");
function commitExecution(snapshot, input, maxInlineTextBytes, now) {
  const sourceVersion = snapshot.versions[input.source.fileVersionId];
  const sourceSha = sourceVersion?.sha256 ?? input.source.fileVersionId;
  const executionId = hashId(
    "x",
    `${input.source.fileVersionId}|${input.omniConfigHash}`
  );
  const reuseKey = `${sourceSha}|${input.omniConfigHash}`;
  const mediaBindings = /* @__PURE__ */ new Map();
  const existing = snapshot.executions[executionId];
  if (existing) {
    for (const entryId of existing.outputRefs) {
      const entry = snapshot.entries[entryId];
      if (!entry?.derivedVersionId) continue;
      const version = snapshot.versions[entry.derivedVersionId];
      if (!version) continue;
      mediaBindings.set(version.sha256, {
        fileId: version.fileId,
        fileVersionId: version.fileVersionId,
        rootFileId: snapshot.files[version.fileId]?.rootFileId ?? input.source.rootFileId
      });
    }
    return {
      commit: { executionId, mediaBindings, created: false },
      changed: false
    };
  }
  const reused = findReusableExecution(snapshot, reuseKey, executionId);
  const outputRefs = [];
  for (const [index, output] of input.outputs.entries()) {
    const entryId = hashId("e", `${executionId}|${index}|${output.sha256}`);
    outputRefs.push(entryId);
    let derivedVersionId;
    if (output.kind === "media") {
      const commit = upsertRecognizedFile(
        snapshot,
        {
          fileRef: output.objectPath,
          sha256: output.sha256,
          mediaType: output.mediaType,
          metadata: output.metadata,
          sizeBytes: output.sizeBytes,
          mimeType: output.mimeType,
          origin: "policy",
          rootFileId: input.source.rootFileId,
          parentVersionId: input.source.fileVersionId,
          source: {
            protocol: "managed",
            locator: `sha256/${output.sha256}`
          },
          recognition: {
            ingestionConfigHash: input.omniConfigHash,
            detectorVersion: MEDIA_DETECTOR_VERSION,
            probeStatus: "complete"
          }
        },
        now
      );
      derivedVersionId = commit.fileVersionId;
      if (commit.created) {
        snapshot.versions[commit.fileVersionId].producedByExecutionId = executionId;
      }
      mediaBindings.set(output.sha256, {
        fileId: commit.fileId,
        fileVersionId: commit.fileVersionId,
        rootFileId: commit.rootFileId
      });
    }
    const entry = {
      outputId: entryId,
      kind: output.kind === "media" ? "derived_media" : "policy_result",
      ...output.role !== void 0 ? { role: output.role } : {},
      artifactRef: {
        storage: "managed",
        managedId: `sha256/${output.sha256}`,
        mimeType: output.mimeType,
        sizeBytes: output.sizeBytes
      },
      ...output.kind === "text" ? { inlineText: truncateUtf8(output.text, maxInlineTextBytes) } : {},
      ...output.disclosure !== void 0 ? { disclosure: output.disclosure } : {},
      scope: {},
      channels: channelsFor(
        output.kind === "media" ? output.mediaType : output.role === "caption" || output.role === "summary" ? sourceVersion?.mediaType : void 0,
        output.role
      ),
      coverage: coverageFor(output.role),
      parentVersionId: input.source.fileVersionId,
      producedByExecutionId: executionId,
      ...derivedVersionId !== void 0 ? { derivedVersionId } : {},
      createdAt: now
    };
    snapshot.entries[entryId] = entry;
  }
  const execution = {
    executionId,
    invocationId: input.invocationId,
    sourceVersionId: input.source.fileVersionId,
    rootFileId: input.source.rootFileId,
    executionOrigin: input.executionOrigin,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    finalArguments: input.finalArguments,
    inputScope: {},
    omniConfigHash: input.omniConfigHash,
    outputRefs,
    ...reused !== void 0 ? { reusedExecutionId: reused.executionId } : {},
    startedAt: input.startedAt,
    completedAt: input.completedAt
  };
  snapshot.executions[executionId] = execution;
  return {
    commit: { executionId, mediaBindings, created: true },
    changed: true
  };
}
__name(commitExecution, "commitExecution");

// packages/core/src/services/media-memory/recall.ts
init_esbuild_shims();
import fs2 from "node:fs/promises";
var debugLogger3 = createDebugLogger("omni:memory");
var CANDIDATE_DESCRIPTION_MAX_CHARS = 200;
var MediaMemoryRecallRejection = class extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
    this.name = "MediaMemoryRecallRejection";
  }
  static {
    __name(this, "MediaMemoryRecallRejection");
  }
};
function truncateChars(text, maxChars) {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 55296 && last <= 56319) cut = cut.slice(0, -1);
  return cut;
}
__name(truncateChars, "truncateChars");
function expectedChannels(mediaType) {
  switch (mediaType) {
    case "image":
      return ["visual"];
    case "audio":
      return ["acoustic", "speech_text"];
    case "video":
      return ["visual", "acoustic", "speech_text"];
    default:
      return [];
  }
}
__name(expectedChannels, "expectedChannels");
var UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
var SEGMENT_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
function tokenize(query) {
  const tokens = /* @__PURE__ */ new Set();
  for (const run of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    for (const segment of run.match(SEGMENT_RUN) ?? []) {
      if (!UNSEGMENTED.test(segment)) {
        if (segment.length > 1) tokens.add(segment);
        continue;
      }
      const chars = [...segment];
      if (chars.length === 1) {
        tokens.add(segment);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i++) {
        tokens.add(chars[i] + chars[i + 1]);
      }
    }
  }
  return [...tokens];
}
__name(tokenize, "tokenize");
function scopeMatches(requested, entryScope) {
  const want = requested?.temporal;
  const have = entryScope.temporal;
  if (!want || !have) return true;
  return have.startMs < want.endMs && have.endMs > want.startMs;
}
__name(scopeMatches, "scopeMatches");
function orderCandidates(candidates) {
  return [...candidates].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.entry.entryId.localeCompare(b.entry.entryId)
  );
}
__name(orderCandidates, "orderCandidates");
function indexSnapshot(snapshot) {
  const childrenByParent = /* @__PURE__ */ new Map();
  const versionsByFile = /* @__PURE__ */ new Map();
  for (const version of Object.values(snapshot.versions)) {
    if (version.parentVersionId) {
      const list = childrenByParent.get(version.parentVersionId) ?? [];
      list.push(version);
      childrenByParent.set(version.parentVersionId, list);
    }
    const byFile = versionsByFile.get(version.fileId) ?? [];
    byFile.push(version);
    versionsByFile.set(version.fileId, byFile);
  }
  const entriesByParent = /* @__PURE__ */ new Map();
  for (const entry of Object.values(snapshot.entries)) {
    const list = entriesByParent.get(entry.parentVersionId) ?? [];
    list.push(entry);
    entriesByParent.set(entry.parentVersionId, list);
  }
  const executionsBySource = /* @__PURE__ */ new Map();
  for (const execution of Object.values(snapshot.executions)) {
    const list = executionsBySource.get(execution.sourceVersionId) ?? [];
    list.push(execution);
    executionsBySource.set(execution.sourceVersionId, list);
  }
  return {
    childrenByParent,
    entriesByParent,
    executionsBySource,
    versionsByFile
  };
}
__name(indexSnapshot, "indexSnapshot");
function derivedSubgraph(snapshot, indexes, start, rootFileId) {
  const result = [];
  const visited = /* @__PURE__ */ new Set();
  const queue = [start];
  while (queue.length > 0) {
    const version = queue.shift();
    if (visited.has(version.fileVersionId)) continue;
    visited.add(version.fileVersionId);
    const file = snapshot.files[version.fileId];
    if (!file || file.rootFileId !== rootFileId) continue;
    result.push(version);
    for (const child of indexes.childrenByParent.get(version.fileVersionId) ?? []) {
      queue.push(child);
    }
  }
  return result;
}
__name(derivedSubgraph, "derivedSubgraph");
function provenanceOf(execution) {
  if (!execution) return { omniConfigHash: "" };
  const origin = execution.executionOrigin;
  return {
    toolName: execution.toolName,
    ...execution.toolVersion !== void 0 ? { toolVersion: execution.toolVersion } : {},
    ...origin.kind === "fixed_policy" ? { policyId: origin.policyId, stage: origin.stage } : {},
    omniConfigHash: execution.omniConfigHash
  };
}
__name(provenanceOf, "provenanceOf");
var MediaMemoryRecallService = class {
  constructor(omniRootDir, config, registry, options) {
    this.config = config;
    this.registry = registry;
    this.options = options;
    this.store = new MediaMemoryStore(omniRootDir);
  }
  static {
    __name(this, "MediaMemoryRecallService");
  }
  store;
  /**
   * Execute one recall request. Throws {@link MediaMemoryRecallRejection}
   * when the request itself is invalid (empty, or referencing a handle
   * this session never issued); an unreadable store degrades to a plain
   * miss — recall is an enhancement and must never break the caller.
   */
  async recall(request) {
    const bindings = this.resolveBindings(request.resourceIds);
    const miss = {
      status: "miss",
      files: [],
      entries: [],
      gaps: []
    };
    try {
      return await this.store.read(
        miss,
        (snapshot) => this.recallFromSnapshot(snapshot, request, bindings)
      );
    } catch (err) {
      debugLogger3.debug(
        `recall failed: ${err instanceof Error ? err.message : err}`
      );
      return miss;
    }
  }
  /**
   * Bounded candidate manifest for the sideQuery selector (M §9.3): every
   * entry reachable from the named resources — same root-bounded walk as
   * {@link recall}, configured kinds, current-version-first — summarized
   * without full text/paths and capped at `sideQuery.maxCandidateEntries`
   * (newest first; deterministic tiebreak). Rejections propagate like
   * {@link recall}; an unreadable store degrades to an empty manifest.
   */
  async candidateSummaries(resourceIds) {
    const bindings = this.resolveBindings(resourceIds);
    const request = { resourceIds, query: "" };
    return await this.store.read(
      [],
      async (snapshot) => {
        const { candidates } = await this.collectFromSnapshot(
          snapshot,
          request,
          bindings
        );
        return orderCandidates([...candidates.values()]).slice(0, this.config.sideQuery.maxCandidateEntries).map((candidate) => ({
          entryId: candidate.entry.entryId,
          kind: candidate.entry.kind,
          ...candidate.entry.role !== void 0 ? { role: candidate.entry.role } : {},
          scope: candidate.entry.scope,
          channels: candidate.entry.channels,
          coverage: candidate.entry.coverage,
          ...candidate.entry.content !== void 0 ? {
            description: truncateChars(
              candidate.entry.content,
              CANDIDATE_DESCRIPTION_MAX_CHARS
            )
          } : {},
          ...candidate.entry.provenance.toolName !== void 0 ? { producer: candidate.entry.provenance.toolName } : {}
        }));
      }
    );
  }
  /**
   * Materialize a selector's picks by the unified protocol (M §9.3): the
   * selection must be a subset of the manifest {@link candidateSummaries}
   * would produce for the same resources and within
   * `sideQuery.maxSelectedEntries` — anything else (unknown id, cross-root
   * id, over budget) rejects the WHOLE selection with `invalid_selection`,
   * never a partial fulfilment.
   */
  async recallSelection(resourceIds, entryIds) {
    const bindings = this.resolveBindings(resourceIds);
    const selectedIds = [...new Set(entryIds)];
    if (selectedIds.length > this.config.sideQuery.maxSelectedEntries) {
      throw new MediaMemoryRecallRejection(
        "invalid_selection",
        `selector returned ${selectedIds.length} entryIds; at most ${this.config.sideQuery.maxSelectedEntries} may be selected`
      );
    }
    const request = { resourceIds, query: "" };
    return await this.store.read(
      {
        status: "miss",
        files: [],
        entries: [],
        gaps: []
      },
      async (snapshot) => {
        const collected = await this.collectFromSnapshot(
          snapshot,
          request,
          bindings
        );
        const manifest = new Map(
          orderCandidates([...collected.candidates.values()]).slice(0, this.config.sideQuery.maxCandidateEntries).map((candidate) => [candidate.entry.entryId, candidate])
        );
        const selected = [];
        for (const entryId of selectedIds) {
          const candidate = manifest.get(entryId);
          if (!candidate) {
            throw new MediaMemoryRecallRejection(
              "invalid_selection",
              `selector returned entryId ${entryId} that is not in the candidate manifest`
            );
          }
          selected.push(candidate);
        }
        return this.finishResult(snapshot, selected, collected);
      }
    );
  }
  /** Shared request validation (M §9.2): every identifier must resolve to a
   * binding THIS session issued; an empty list or an unresolvable identifier
   * rejects the whole request.
   *
   * A model-visible local source is annotated with its ABSOLUTE PATH rather
   * than a handle, and the model passes that path here. `resolveMediaReference`
   * resolves each identifier as a handle first (the common case), then as a
   * session-bound fileRef — the path form rides VERBATIM (never escaped), so a
   * native Windows path or a `：`-bearing name matches the raw `fileRef` the
   * registry stores byte-for-byte. So the displayed path recalls exactly as
   * the handle would. An identifier that is neither still rejects the whole
   * request. */
  resolveBindings(resourceIds) {
    if (resourceIds.length === 0) {
      throw new MediaMemoryRecallRejection(
        "empty_request",
        "recall request must name at least one resourceId"
      );
    }
    const seen = /* @__PURE__ */ new Set();
    const bindings = [];
    for (const resourceId of resourceIds) {
      const binding = resolveMediaReference(this.registry, resourceId);
      if (!binding) {
        throw new MediaMemoryRecallRejection(
          "unknown_resource",
          `reference ${resourceId} matches no media delivered this session (neither a session handle nor the path of a file read this session)`
        );
      }
      if (seen.has(binding.resourceId)) continue;
      seen.add(binding.resourceId);
      bindings.push(binding);
    }
    return bindings;
  }
  async recallFromSnapshot(snapshot, request, bindings) {
    const collected = await this.collectFromSnapshot(
      snapshot,
      request,
      bindings
    );
    const limit = Math.min(
      request.limit ?? this.config.maxEntries,
      this.config.maxEntries
    );
    const entries = rankAndSlice(
      [...collected.candidates.values()],
      request.query,
      limit
    );
    return this.finishResult(snapshot, entries, collected);
  }
  /** The shared walk both recall shapes sit on: resolve each binding to
   * its file, list consulted versions (current-first §9.5), collect
   * candidate entries across the root-bounded derivation subgraph, and
   * derive the CURRENT version's honest gaps. */
  async collectFromSnapshot(snapshot, request, bindings) {
    const indexes = indexSnapshot(snapshot);
    const kinds = this.effectiveKinds(request);
    const includeHistorical = request.includeHistoricalVersions ?? this.config.includeHistoricalVersions;
    const files = /* @__PURE__ */ new Map();
    const candidates = /* @__PURE__ */ new Map();
    const gaps = [];
    for (const binding of bindings) {
      if (!binding) continue;
      const boundVersion = snapshot.versions[binding.fileVersionId];
      const file = boundVersion ? snapshot.files[boundVersion.fileId] : void 0;
      if (!boundVersion || !file) {
        gaps.push({
          scope: {},
          channels: expectedChannels(binding.mediaType),
          reason: "artifact_unavailable",
          forResourceId: binding.resourceId,
          mediaType: binding.mediaType
        });
        continue;
      }
      const fileVersions = indexes.versionsByFile.get(file.fileId) ?? [];
      const currentVersion = snapshot.versions[file.currentVersionId];
      const consulted = includeHistorical ? [...fileVersions].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt)
      ) : currentVersion ? [currentVersion] : [];
      for (const version of consulted) {
        files.set(version.fileVersionId, {
          fileId: file.fileId,
          fileVersionId: version.fileVersionId,
          current: version.fileVersionId === file.currentVersionId,
          mediaType: version.mediaType
        });
      }
      if (!files.has(binding.fileVersionId)) {
        files.set(binding.fileVersionId, {
          fileId: file.fileId,
          fileVersionId: binding.fileVersionId,
          current: false,
          mediaType: boundVersion.mediaType
        });
      }
      for (const version of consulted) {
        await this.collectVersion(
          snapshot,
          indexes,
          binding.resourceId,
          binding.rootFileId,
          version,
          kinds,
          request,
          candidates
        );
      }
      if (currentVersion) {
        gaps.push(
          ...await this.gapsForVersion(
            snapshot,
            indexes,
            binding.resourceId,
            binding.rootFileId,
            file.fileRef,
            currentVersion
          )
        );
      }
    }
    return { files, candidates, gaps };
  }
  /** Availability pass + assembly shared by both recall shapes: bind a
   * session handle for each returned derived artifact still on disk,
   * degrade the lost ones to gaps, derive advisor suggestions and the
   * hit/partial/miss verdict. */
  async finishResult(snapshot, entries, collected) {
    const { files, gaps } = collected;
    for (const candidate of entries) {
      const derived = candidate.derived;
      if (!derived) continue;
      if (await pathExists(derived.fileRef)) {
        candidate.entry.resourceId = this.registry.bind({
          fileId: derived.fileId,
          fileVersionId: derived.versionId,
          rootFileId: snapshot.files[derived.fileId]?.rootFileId ?? derived.fileId,
          fileRef: derived.fileRef,
          mediaType: derived.mediaType
        }).resourceId;
      } else {
        gaps.push({
          scope: candidate.entry.scope,
          channels: candidate.entry.channels,
          reason: "artifact_unavailable",
          forResourceId: candidate.forResourceId,
          mediaType: derived.mediaType
        });
      }
    }
    const resultEntries = entries.map((c) => c.entry);
    const resultGaps = gaps.map(
      ({ scope, channels, reason }) => ({ scope, channels, reason })
    );
    const nextPolicyActions = this.options?.advise ? gaps.flatMap(
      (gap) => this.options.advise({
        resourceId: gap.forResourceId,
        mediaType: gap.mediaType,
        gap: {
          scope: gap.scope,
          channels: gap.channels,
          reason: gap.reason
        }
      })
    ) : [];
    const status = resultEntries.length === 0 ? "miss" : resultGaps.length > 0 ? "partial" : "hit";
    const matched = collected.candidates.size;
    return {
      status,
      files: [...files.values()],
      entries: resultEntries,
      gaps: resultGaps,
      ...nextPolicyActions.length > 0 ? { nextPolicyActions } : {},
      ...matched > resultEntries.length ? { matchedEntries: matched } : {}
    };
  }
  /** Request kinds narrowed to what configuration allows; an absent
   * request filter means "everything configured". */
  effectiveKinds(request) {
    const allowed = new Set(this.config.kinds);
    if (!request.kinds) return allowed;
    return new Set(request.kinds.filter((k) => allowed.has(k)));
  }
  /** Collect every matching entry reachable from one consulted version:
   * synthesized metadata for the version itself, then policy outputs and
   * executions across its whole derivation subgraph (the transcript of an
   * extracted audio track parents on the AUDIO version — only the
   * subgraph walk surfaces it for the movie's handle). */
  async collectVersion(snapshot, indexes, forResourceId, rootFileId, version, kinds, request, out) {
    const rolesFilter = request.roles;
    if (kinds.has("metadata") && !rolesFilter) {
      const entryId = `metadata:${version.fileVersionId}`;
      out.set(entryId, {
        entry: {
          entryId,
          kind: "metadata",
          content: truncateChars(
            JSON.stringify({
              mediaType: version.mediaType,
              mimeType: version.mimeType,
              sizeBytes: version.sizeBytes,
              source: version.source,
              ...version.metadata
            }),
            this.config.maxTextChars
          ),
          scope: {},
          channels: ["technical_metadata"],
          coverage: { mode: "complete", scope: {} },
          evidenceRefs: [{ fileVersionId: version.fileVersionId }],
          provenance: {
            omniConfigHash: version.recognition.ingestionConfigHash
          }
        },
        createdAt: version.createdAt,
        forResourceId
      });
    }
    for (const node of derivedSubgraph(
      snapshot,
      indexes,
      version,
      rootFileId
    )) {
      if (kinds.has("derived_media") || kinds.has("policy_result")) {
        for (const entry of indexes.entriesByParent.get(node.fileVersionId) ?? []) {
          if (!kinds.has(entry.kind)) continue;
          if (rolesFilter && (!entry.role || !rolesFilter.includes(entry.role)))
            continue;
          if (!scopeMatches(request.scope, entry.scope)) continue;
          const execution = snapshot.executions[entry.producedByExecutionId];
          const derivedVersion = entry.derivedVersionId ? snapshot.versions[entry.derivedVersionId] : void 0;
          out.set(entry.outputId, {
            entry: {
              entryId: entry.outputId,
              kind: entry.kind,
              ...entry.role !== void 0 ? { role: entry.role } : {},
              ...entry.inlineText !== void 0 ? {
                content: truncateChars(
                  entry.inlineText,
                  this.config.maxTextChars
                ),
                // Say so when the payload is a prefix: coverage speaks
                // for what was processed, so it stays `complete` and
                // no gap is raised — the flag is the only signal that
                // the model is not holding the whole text.
                ...entry.inlineText.length > this.config.maxTextChars ? { contentTruncated: true } : {}
              } : {},
              ...entry.disclosure !== void 0 ? { disclosure: entry.disclosure } : {},
              scope: entry.scope,
              channels: entry.channels,
              coverage: entry.coverage,
              evidenceRefs: [
                {
                  fileVersionId: entry.parentVersionId,
                  executionId: entry.producedByExecutionId
                }
              ],
              provenance: provenanceOf(execution)
            },
            createdAt: entry.createdAt,
            forResourceId,
            ...derivedVersion ? {
              derived: {
                versionId: derivedVersion.fileVersionId,
                fileId: derivedVersion.fileId,
                fileRef: snapshot.files[derivedVersion.fileId]?.fileRef ?? "",
                mediaType: derivedVersion.mediaType
              }
            } : {}
          });
        }
      }
      if (kinds.has("execution") && !rolesFilter) {
        for (const execution of indexes.executionsBySource.get(
          node.fileVersionId
        ) ?? []) {
          if (!scopeMatches(request.scope, execution.inputScope)) continue;
          const entryId = `execution:${execution.executionId}`;
          out.set(entryId, {
            entry: {
              entryId,
              kind: "execution",
              content: truncateChars(
                JSON.stringify({
                  toolName: execution.toolName,
                  ...execution.toolVersion !== void 0 ? { toolVersion: execution.toolVersion } : {},
                  finalArguments: execution.finalArguments,
                  completedAt: execution.completedAt,
                  outputCount: execution.outputRefs.length
                }),
                this.config.maxTextChars
              ),
              scope: execution.inputScope,
              channels: [],
              coverage: { mode: "complete", scope: execution.inputScope },
              evidenceRefs: [
                {
                  fileVersionId: execution.sourceVersionId,
                  executionId: execution.executionId
                }
              ],
              provenance: provenanceOf(execution)
            },
            createdAt: execution.completedAt,
            forResourceId
          });
        }
      }
    }
  }
  /** Honest-gaps derivation (§9.4) for one CURRENT version: which of the
   * modality's expected channels have no evidence (not_processed), only
   * sampled/partial evidence (partial_coverage), and whether the source
   * bytes themselves are still on disk (artifact_unavailable, D5). Gap
   * truth is computed from the FULL subgraph, unfiltered — what the
   * request chose to see never changes what was processed. */
  async gapsForVersion(snapshot, indexes, forResourceId, rootFileId, fileRef, version) {
    const gaps = [];
    if (!await pathExists(fileRef)) {
      return [
        {
          scope: {},
          channels: expectedChannels(version.mediaType),
          reason: "artifact_unavailable",
          forResourceId,
          mediaType: version.mediaType
        }
      ];
    }
    const complete = /* @__PURE__ */ new Set();
    const partial = /* @__PURE__ */ new Set();
    for (const node of derivedSubgraph(
      snapshot,
      indexes,
      version,
      rootFileId
    )) {
      for (const entry of indexes.entriesByParent.get(node.fileVersionId) ?? []) {
        const full = entry.coverage.mode === "complete" || entry.coverage.mode === "continuous";
        for (const channel of entry.channels) {
          (full ? complete : partial).add(channel);
        }
      }
    }
    const notProcessed = [];
    const partialOnly = [];
    for (const channel of expectedChannels(version.mediaType)) {
      if (complete.has(channel)) continue;
      (partial.has(channel) ? partialOnly : notProcessed).push(channel);
    }
    if (notProcessed.length > 0) {
      gaps.push({
        scope: {},
        channels: notProcessed,
        reason: "not_processed",
        forResourceId,
        mediaType: version.mediaType
      });
    }
    if (partialOnly.length > 0) {
      gaps.push({
        scope: {},
        channels: partialOnly,
        reason: "partial_coverage",
        forResourceId,
        mediaType: version.mediaType
      });
    }
    return gaps;
  }
};
async function pathExists(fileRef) {
  if (!fileRef) return false;
  try {
    await fs2.access(fileRef);
    return true;
  } catch {
    return false;
  }
}
__name(pathExists, "pathExists");
function rankAndSlice(candidates, query, limit) {
  const tokens = tokenize(query);
  const scored = candidates.map((candidate) => {
    const haystack = [
      candidate.entry.role ?? "",
      candidate.entry.content ?? "",
      candidate.entry.provenance.toolName ?? ""
    ].join(" ").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 1;
    }
    return { candidate, score };
  });
  scored.sort(
    (a, b) => b.score - a.score || b.candidate.createdAt.localeCompare(a.candidate.createdAt) || a.candidate.entry.entryId.localeCompare(b.candidate.entry.entryId)
  );
  return scored.slice(0, Math.max(0, limit)).map((s) => s.candidate);
}
__name(rankAndSlice, "rankAndSlice");

// packages/core/src/services/media-memory/index.ts
init_esbuild_shims();

export {
  MEDIA_MEMORY_FILE_NAME,
  MEDIA_DETECTOR_VERSION,
  MediaMemoryService,
  MediaMemoryRecallRejection,
  MediaMemoryRecallService
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
