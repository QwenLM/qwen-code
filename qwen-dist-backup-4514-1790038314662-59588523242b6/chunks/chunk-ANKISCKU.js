// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/transcript-records.ts
init_esbuild_shims();
var USER_PROMPT_SUBMIT_CONTEXT_OPEN = "<qwen:user-prompt-submit-context>";
var USER_PROMPT_SUBMIT_CONTEXT_CLOSE = "</qwen:user-prompt-submit-context>";
var TranscriptRecordPreparationError = class extends TypeError {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "TranscriptRecordPreparationError";
  }
  static {
    __name(this, "TranscriptRecordPreparationError");
  }
};
var RECORD_TYPES = /* @__PURE__ */ new Set([
  "user",
  "assistant",
  "tool_result",
  "system"
]);
var ARTIFACT_RECORD_SUBTYPES = /* @__PURE__ */ new Set([
  "session_artifact_event",
  "session_artifact_snapshot"
]);
var KNOWN_RECORD_SUBTYPES = /* @__PURE__ */ new Set([
  "chat_compression",
  "slash_command",
  "ui_telemetry",
  "at_command",
  "attribution_snapshot",
  "notification",
  "background_task_completed",
  "cron",
  "mid_turn_user_message",
  "realtime_message",
  "custom_title",
  "parent_session",
  "rewind",
  "agent_bootstrap",
  "agent_launch_prompt",
  "agent_retry",
  "agent_session_ready",
  "file_history_snapshot",
  "session_source",
  "session_model",
  "omni_recall",
  "session_sources_snapshot",
  "branch_checkpoint",
  "goal_state",
  "goal_runtime",
  "goal_turn_end",
  "turn_result",
  ...ARTIFACT_RECORD_SUBTYPES
]);
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isObjectRecord, "isObjectRecord");
function stripGeneratedAttachmentTokens(displayText, systemPayload) {
  const payload = isObjectRecord(systemPayload) ? systemPayload : void 0;
  const references = payload?.["attachmentReferences"];
  if (!Array.isArray(references)) return displayText;
  const tokens = references.flatMap((reference) => {
    if (!isObjectRecord(reference) || reference["type"] !== "resource" || typeof reference["attachmentId"] !== "string") {
      return [];
    }
    return [`@attachment:///${encodeURIComponent(reference["attachmentId"])}`];
  });
  if (tokens.length === 0) return displayText;
  const tokenText = tokens.join("\n");
  if (displayText === tokenText) return "";
  const suffix = `

${tokenText}`;
  return displayText.endsWith(suffix) ? displayText.slice(0, -suffix.length) : displayText;
}
__name(stripGeneratedAttachmentTokens, "stripGeneratedAttachmentTokens");
function wrapUserPromptSubmitContext(context) {
  return `${USER_PROMPT_SUBMIT_CONTEXT_OPEN}
${context}
${USER_PROMPT_SUBMIT_CONTEXT_CLOSE}`;
}
__name(wrapUserPromptSubmitContext, "wrapUserPromptSubmitContext");
function isUserPromptSubmitContextPartText(text) {
  const trimmed = text.trim();
  const prefix = `${USER_PROMPT_SUBMIT_CONTEXT_OPEN}
`;
  const suffix = `
${USER_PROMPT_SUBMIT_CONTEXT_CLOSE}`;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(suffix)) {
    return false;
  }
  const body = trimmed.slice(prefix.length, -suffix.length);
  return !body.includes(USER_PROMPT_SUBMIT_CONTEXT_OPEN) && !body.includes(USER_PROMPT_SUBMIT_CONTEXT_CLOSE);
}
__name(isUserPromptSubmitContextPartText, "isUserPromptSubmitContextPartText");
function isUserPromptSubmitContextPart(part) {
  return isObjectRecord(part) && typeof part["text"] === "string" && isUserPromptSubmitContextPartText(part["text"]);
}
__name(isUserPromptSubmitContextPart, "isUserPromptSubmitContextPart");
function projectUserTranscriptForDisplay(record) {
  const parts = record.message?.parts ?? [];
  const hasFinalHookContextPart = parts.length > 1 && isUserPromptSubmitContextPart(parts[parts.length - 1]);
  const payload = isObjectRecord(record.systemPayload) ? record.systemPayload : void 0;
  const isUserPromptPayload = payload && (typeof payload["hookContext"] === "string" || hasFinalHookContextPart);
  const displayText = isUserPromptPayload && typeof payload["displayText"] === "string" ? payload["displayText"] : void 0;
  if (displayText !== void 0) {
    const visibleParts = parts.filter(
      (part) => !isObjectRecord(part) || typeof part["text"] !== "string"
    );
    return { displayText, parts: visibleParts };
  }
  if (payload === void 0 && hasFinalHookContextPart) {
    return { displayText: void 0, parts: parts.slice(0, -1) };
  }
  return { displayText: void 0, parts };
}
__name(projectUserTranscriptForDisplay, "projectUserTranscriptForDisplay");
function diagnostic(code, message, affectsCompleteness, fields = {}, severity = affectsCompleteness ? "warning" : "info") {
  return {
    code,
    severity,
    message,
    affectsCompleteness,
    ...fields
  };
}
__name(diagnostic, "diagnostic");
function isTranscriptConversationRecord(record) {
  return !isTranscriptArtifactRecord(record) && !(record.type === "system" && record.subtype === "session_sources_snapshot");
}
__name(isTranscriptConversationRecord, "isTranscriptConversationRecord");
function isTranscriptArtifactRecord(record) {
  return record.type === "system" && typeof record.subtype === "string" && ARTIFACT_RECORD_SUBTYPES.has(record.subtype);
}
__name(isTranscriptArtifactRecord, "isTranscriptArtifactRecord");
function validateTranscriptRecord(value, recordIndex) {
  const diagnostics = [];
  if (!isObjectRecord(value)) {
    diagnostics.push(
      diagnostic(
        "invalid_record",
        "Skipped a transcript record that is not an object.",
        true,
        { recordIndex }
      )
    );
    return { diagnostics };
  }
  const uuid = value["uuid"];
  const parentUuid = value["parentUuid"];
  const sessionId = value["sessionId"];
  const type = value["type"];
  const recordId = typeof uuid === "string" ? uuid : void 0;
  if (typeof uuid !== "string" || uuid.length === 0 || typeof parentUuid !== "string" && parentUuid !== null || typeof sessionId !== "string" || sessionId.length === 0) {
    diagnostics.push(
      diagnostic(
        "invalid_record",
        "Skipped a transcript record with invalid identity fields.",
        true,
        { recordIndex, recordId }
      )
    );
    return { diagnostics };
  }
  if (typeof type !== "string" || !RECORD_TYPES.has(type)) {
    diagnostics.push(
      diagnostic(
        "unknown_record_or_part",
        "Skipped a transcript record with an unknown record type.",
        true,
        { recordIndex, recordId }
      )
    );
    return { diagnostics };
  }
  const timestamp = value["timestamp"];
  if (timestamp !== void 0 && (typeof timestamp !== "string" || !Number.isFinite(new Date(timestamp).getTime()))) {
    diagnostics.push(
      diagnostic(
        "invalid_timestamp",
        "Ignored an invalid transcript record timestamp.",
        false,
        { recordIndex, recordId, path: "timestamp" }
      )
    );
  }
  const subtype = value["subtype"];
  if (subtype !== void 0 && (typeof subtype !== "string" || !KNOWN_RECORD_SUBTYPES.has(subtype))) {
    diagnostics.push(
      diagnostic(
        "unknown_record_or_part",
        "The transcript record has an unknown subtype.",
        true,
        { recordIndex, recordId, path: "subtype" }
      )
    );
  }
  let message;
  if (value["message"] !== void 0) {
    if (!isObjectRecord(value["message"])) {
      diagnostics.push(
        diagnostic(
          "malformed_part",
          "Ignored a malformed transcript message payload.",
          true,
          { recordIndex, recordId, path: "message" }
        )
      );
    } else {
      const parts = value["message"]["parts"];
      if (parts !== void 0 && !Array.isArray(parts)) {
        diagnostics.push(
          diagnostic(
            "malformed_part",
            "Ignored malformed transcript message parts.",
            true,
            { recordIndex, recordId, path: "message.parts" }
          )
        );
      }
      message = {
        ...typeof value["message"]["role"] === "string" ? { role: value["message"]["role"] } : {},
        ...Array.isArray(parts) ? { parts } : {}
      };
    }
  }
  return {
    record: {
      ...value,
      uuid,
      parentUuid,
      sessionId,
      daemonPromptId: typeof value["daemonPromptId"] === "string" && value["daemonPromptId"].trim().length > 0 ? value["daemonPromptId"] : void 0,
      type,
      ...typeof subtype === "string" ? { subtype } : { subtype: void 0 },
      ...typeof timestamp === "string" && Number.isFinite(new Date(timestamp).getTime()) ? { timestamp } : { timestamp: void 0 },
      ...message ? { message } : { message: void 0 }
    },
    diagnostics
  };
}
__name(validateTranscriptRecord, "validateTranscriptRecord");
function selectTranscriptLeaf(records, leafUuid) {
  if (leafUuid !== void 0) {
    return records.some(
      (record) => record.uuid === leafUuid && isTranscriptConversationRecord(record)
    ) ? leafUuid : void 0;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && isTranscriptConversationRecord(record)) return record.uuid;
  }
  return void 0;
}
__name(selectTranscriptLeaf, "selectTranscriptLeaf");
function walkTranscriptUuidChain(leafUuid, lookup) {
  const uuids = [];
  const gaps = [];
  const visited = /* @__PURE__ */ new Set();
  let currentUuid = leafUuid;
  let cycleUuid;
  while (currentUuid) {
    if (visited.has(currentUuid)) {
      cycleUuid = currentUuid;
      break;
    }
    visited.add(currentUuid);
    const record = lookup(currentUuid);
    if (!record) break;
    uuids.push(currentUuid);
    if (!record.parentUuid) break;
    if (!lookup(record.parentUuid)) {
      gaps.push({
        childUuid: currentUuid,
        missingParentUuid: record.parentUuid
      });
      break;
    }
    currentUuid = record.parentUuid;
  }
  uuids.reverse();
  return { uuids, gaps, ...cycleUuid ? { cycleUuid } : {} };
}
__name(walkTranscriptUuidChain, "walkTranscriptUuidChain");
function aggregateTranscriptRecordFragments(records) {
  const first = records[0];
  if (!first) {
    throw new Error("Cannot aggregate empty transcript record array");
  }
  const base = { ...first };
  let message = first.message ? { ...first.message, parts: [...first.message.parts ?? []] } : void 0;
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    if (record.message !== void 0) {
      message = message ? {
        role: message.role,
        parts: [...message.parts ?? [], ...record.message.parts ?? []]
      } : { ...record.message, parts: [...record.message.parts ?? []] };
    }
    if (record.usageMetadata) base["usageMetadata"] = record.usageMetadata;
    if (record.toolCallResult && !base["toolCallResult"]) {
      base["toolCallResult"] = record.toolCallResult;
    }
    if (record.model && !base["model"]) base["model"] = record.model;
    if (record.timestamp && (!base["timestamp"] || record.timestamp > String(base["timestamp"]))) {
      base["timestamp"] = record.timestamp;
    }
  }
  base["message"] = message;
  return base;
}
__name(aggregateTranscriptRecordFragments, "aggregateTranscriptRecordFragments");
function prepareTranscriptRecords(values, options = {}) {
  if (!Array.isArray(values)) {
    throw new TranscriptRecordPreparationError(
      "invalid_records",
      "Transcript records must be an array."
    );
  }
  const diagnostics = [];
  const records = [];
  const sourceIndexByRecord = /* @__PURE__ */ new Map();
  for (let index = 0; index < values.length; index += 1) {
    const validated = validateTranscriptRecord(values[index], index);
    diagnostics.push(...validated.diagnostics);
    if (validated.record) {
      records.push(validated.record);
      sourceIndexByRecord.set(validated.record, index);
    }
  }
  const sessionIds = new Set(records.map((record) => record.sessionId));
  if (sessionIds.size > 1) {
    throw new TranscriptRecordPreparationError(
      "mixed_session_ids",
      "Transcript records contain multiple session ids."
    );
  }
  const leafUuid = selectTranscriptLeaf(records, options.leafUuid);
  if (options.leafUuid !== void 0 && leafUuid === void 0) {
    throw new TranscriptRecordPreparationError(
      "leaf_not_found",
      "The requested transcript leaf was not found."
    );
  }
  if (!leafUuid) {
    if (records.length > 0) {
      diagnostics.push(
        diagnostic(
          "artifact_only",
          "The input contains no conversation records.",
          false
        )
      );
    }
    return {
      ...sessionIds.size === 1 ? { sessionId: records[0].sessionId } : {},
      records: [],
      gaps: [],
      diagnostics
    };
  }
  const fragmentsByUuid = /* @__PURE__ */ new Map();
  const firstByUuid = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (!isTranscriptConversationRecord(record)) continue;
    const fragments = fragmentsByUuid.get(record.uuid);
    if (fragments) {
      if (fragments[0].parentUuid !== record.parentUuid) {
        diagnostics.push(
          diagnostic(
            "conflicting_parent_uuid",
            "Duplicate transcript record fragments disagree on parentUuid.",
            true,
            {
              recordIndex: sourceIndexByRecord.get(record),
              recordId: record.uuid,
              path: "parentUuid"
            }
          )
        );
      }
      fragments.push(record);
    } else {
      fragmentsByUuid.set(record.uuid, [record]);
      firstByUuid.set(record.uuid, record);
    }
  }
  const chain = walkTranscriptUuidChain(
    leafUuid,
    (uuid) => firstByUuid.get(uuid)
  );
  for (const gap of chain.gaps) {
    diagnostics.push(
      diagnostic(
        "history_gap",
        "The active transcript chain is missing a parent record.",
        true,
        { recordId: gap.childUuid }
      )
    );
  }
  if (chain.cycleUuid) {
    diagnostics.push(
      diagnostic(
        "parent_cycle",
        "The active transcript chain contains a parent cycle.",
        true,
        { recordId: chain.cycleUuid }
      )
    );
  }
  return {
    ...sessionIds.size === 1 ? { sessionId: records[0].sessionId } : {},
    records: chain.uuids.map(
      (uuid) => aggregateTranscriptRecordFragments(fragmentsByUuid.get(uuid) ?? [])
    ),
    gaps: chain.gaps,
    diagnostics
  };
}
__name(prepareTranscriptRecords, "prepareTranscriptRecords");

// packages/core/src/services/session-artifact-persistence.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
var SESSION_ARTIFACT_PERSISTENCE_VERSION = 2;
var CONTENT_ID_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{16}$/;
var WORKSPACE_CONTENT_SHA256_METADATA_KEY = "qwen.workspace.sha256";
var WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY = "qwen.workspace.mtimeMs";
var WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY = "qwen.workspace.sizeBytes";
var PUBLISHED_CONTENT_SHA256_METADATA_KEY = "qwen.published.sha256";
var MAX_PERSISTED_ARTIFACTS = 500;
var MAX_PERSISTED_EVENT_CHANGES = 800;
var MAX_PERSISTED_IDS = 500;
var MAX_PERSISTED_MARKER_ARTIFACTS = MAX_PERSISTED_IDS * 2;
var MAX_PERSISTED_ID_CHARS = 200;
var MAX_PERSISTED_TITLE_CHARS = 200;
var MAX_PERSISTED_DESCRIPTION_CHARS = 1e3;
var MAX_PERSISTED_PATH_CHARS = 500;
var MAX_PERSISTED_URL_CHARS = 2048;
var MAX_PERSISTED_MIME_CHARS = 120;
var MAX_PERSISTED_FIELD_CHARS = 200;
var MAX_PERSISTED_TIMESTAMP_CHARS = 64;
var SECRET_TOKEN_VALUE_PATTERN = /(?:^|\s)(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,}|[a-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})(?:$|\s)/i;
function getWebPreviewSnapshotId(artifact) {
  const id = /^preview-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
    artifact.managedId ?? ""
  )?.[1];
  const sha256 = artifact.metadata?.[PUBLISHED_CONTENT_SHA256_METADATA_KEY];
  if (!id || artifact.kind !== "html" || artifact.storage !== "published" || artifact.metadata?.["artifactType"] !== "web_preview_snapshot" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || artifact.source !== void 0 && (artifact.source !== "tool" || artifact.toolName?.toLowerCase() !== "artifact") || artifact.toolName !== void 0 && artifact.toolName.toLowerCase() !== "artifact")
    return void 0;
  try {
    const url = new URL(artifact.url ?? "");
    if (url.protocol === "file:" && !url.host && !url.search && !url.hash && url.pathname.endsWith(`/artifacts/snapshots/${id}/index.html`))
      return id;
  } catch {
    return void 0;
  }
  return void 0;
}
__name(getWebPreviewSnapshotId, "getWebPreviewSnapshotId");
function isSessionArtifactRecord(record) {
  return isTranscriptArtifactRecord(record);
}
__name(isSessionArtifactRecord, "isSessionArtifactRecord");
function selectActiveSideArtifactRecordUuids(records, activeRecordUuids) {
  const activeUuids = new Set(activeRecordUuids);
  const firstActiveUuid = activeRecordUuids[0];
  const firstActiveIndex = firstActiveUuid === void 0 ? -1 : records.findIndex((record) => record.uuid === firstActiveUuid);
  const nextActiveUuidByIndex = /* @__PURE__ */ new Map();
  const nextBlockingUuidByIndex = /* @__PURE__ */ new Map();
  let nextActiveUuid;
  let nextBlockingUuid;
  for (let index = records.length - 1; index >= 0; index--) {
    if (nextActiveUuid !== void 0) {
      nextActiveUuidByIndex.set(index, nextActiveUuid);
    }
    if (nextBlockingUuid !== void 0) {
      nextBlockingUuidByIndex.set(index, nextBlockingUuid);
    }
    const record = records[index];
    if (activeUuids.has(record.uuid)) {
      nextActiveUuid = record.uuid;
      nextBlockingUuid = void 0;
    } else if (!isSessionArtifactRecord(record) && !(record.type === "system" && (record.subtype === "custom_title" || record.subtype === "session_sources_snapshot"))) {
      nextBlockingUuid = record.uuid;
    }
  }
  const selected = [];
  const includedSideArtifactUuids = /* @__PURE__ */ new Set();
  let previousActiveUuid;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (activeUuids.has(record.uuid)) {
      previousActiveUuid = record.uuid;
      continue;
    }
    if (!isSessionArtifactRecord(record)) continue;
    const nextUuid = nextActiveUuidByIndex.get(index);
    const isInActiveSegment = !nextBlockingUuidByIndex.has(index) && (nextUuid !== void 0 ? activeUuids.has(nextUuid) : previousActiveUuid !== void 0 && activeUuids.has(previousActiveUuid));
    if (record.parentUuid !== null && (activeUuids.has(record.parentUuid) || includedSideArtifactUuids.has(record.parentUuid)) && isInActiveSegment && (record.parentUuid === previousActiveUuid || includedSideArtifactUuids.has(record.parentUuid))) {
      selected.push(record.uuid);
      includedSideArtifactUuids.add(record.uuid);
    } else if (record.parentUuid === null && index < firstActiveIndex && isInActiveSegment) {
      selected.push(record.uuid);
      includedSideArtifactUuids.add(record.uuid);
    }
  }
  return selected;
}
__name(selectActiveSideArtifactRecordUuids, "selectActiveSideArtifactRecordUuids");
function stableSessionArtifactId(sessionId, identityKey) {
  return createHash("sha256").update(`${sessionId}:${identityKey}`).digest("hex").slice(0, 16);
}
__name(stableSessionArtifactId, "stableSessionArtifactId");
function sessionArtifactIdentityKey(artifact) {
  if (artifact.workspacePath) return `workspace:${artifact.workspacePath}`;
  if (artifact.managedId) return `managed:${artifact.managedId}`;
  if (artifact.url) return `url:${artifact.url}`;
  return void 0;
}
__name(sessionArtifactIdentityKey, "sessionArtifactIdentityKey");
var SessionArtifactSnapshotAccumulator = class {
  static {
    __name(this, "SessionArtifactSnapshotAccumulator");
  }
  artifacts = /* @__PURE__ */ new Map();
  tombstonedIds = /* @__PURE__ */ new Set();
  stickyEphemeralIds = /* @__PURE__ */ new Set();
  markerArtifacts = /* @__PURE__ */ new Map();
  warnings = [];
  sequence = 0;
  lastSnapshotSequence = 0;
  sessionId;
  sawRecord = false;
  constructor(fallbackSessionId) {
    this.sessionId = fallbackSessionId;
  }
  add(record) {
    if (!isSessionArtifactRecord(record)) return;
    if (record.subtype === "session_artifact_snapshot") {
      const payload2 = normalizeSnapshotPayload(
        record.systemPayload,
        this.warnings
      );
      if (!payload2) return;
      this.sawRecord = true;
      this.sessionId = payload2.sessionId;
      this.sequence = Math.max(this.sequence, payload2.sequence);
      this.lastSnapshotSequence = payload2.sequence;
      this.artifacts.clear();
      this.tombstonedIds.clear();
      this.stickyEphemeralIds.clear();
      this.markerArtifacts.clear();
      for (const id of payload2.tombstonedIds ?? []) this.tombstonedIds.add(id);
      for (const id of payload2.stickyEphemeralIds ?? []) {
        this.stickyEphemeralIds.add(id);
      }
      const markerIds = /* @__PURE__ */ new Set([
        ...this.tombstonedIds,
        ...this.stickyEphemeralIds
      ]);
      for (const artifact of payload2.markerArtifacts ?? []) {
        if (markerIds.has(artifact.id)) {
          this.markerArtifacts.set(artifact.id, artifact);
        }
      }
      for (const artifact of payload2.artifacts) {
        if (artifact.retention === "ephemeral") continue;
        this.artifacts.set(artifact.id, artifact);
        this.markerArtifacts.delete(artifact.id);
      }
      return;
    }
    const payload = normalizeEventPayload(record.systemPayload, this.warnings);
    if (!payload) return;
    this.sawRecord = true;
    this.sessionId = payload.sessionId;
    if (payload.sequence <= this.lastSnapshotSequence) {
      this.warnings.push(
        `skipped stale event sequence ${payload.sequence} at or before snapshot sequence ${this.lastSnapshotSequence}`
      );
      return;
    }
    this.sequence = Math.max(this.sequence, payload.sequence);
    for (const change of payload.changes) {
      if (change.action === "removed") {
        this.artifacts.delete(change.artifactId);
        if (change.reason === "explicit") {
          this.tombstonedIds.add(change.artifactId);
          this.stickyEphemeralIds.delete(change.artifactId);
          if (change.artifact) {
            this.markerArtifacts.set(change.artifactId, change.artifact);
          }
        }
        if (change.reason === "eviction") {
          this.stickyEphemeralIds.delete(change.artifactId);
          this.markerArtifacts.delete(change.artifactId);
        }
        if (change.reason === "unpin_to_ephemeral") {
          this.stickyEphemeralIds.add(change.artifactId);
          if (change.artifact) {
            this.markerArtifacts.set(change.artifactId, change.artifact);
          }
        }
        continue;
      }
      if (!change.artifact || change.artifact.retention === "ephemeral") {
        continue;
      }
      this.artifacts.set(change.artifact.id, change.artifact);
      this.tombstonedIds.delete(change.artifact.id);
      this.stickyEphemeralIds.delete(change.artifact.id);
      this.markerArtifacts.delete(change.artifact.id);
    }
  }
  finish() {
    if (!this.sawRecord || !this.sessionId) return void 0;
    return {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: this.sessionId,
      sequence: this.sequence,
      artifacts: Array.from(this.artifacts.values()),
      tombstonedIds: Array.from(this.tombstonedIds),
      stickyEphemeralIds: Array.from(this.stickyEphemeralIds),
      ...this.markerArtifacts.size > 0 ? { markerArtifacts: Array.from(this.markerArtifacts.values()) } : {},
      warnings: this.warnings
    };
  }
};
function rebuildSessionArtifactSnapshot(records, fallbackSessionId) {
  const accumulator = new SessionArtifactSnapshotAccumulator(fallbackSessionId);
  for (const record of records) accumulator.add(record);
  return accumulator.finish();
}
__name(rebuildSessionArtifactSnapshot, "rebuildSessionArtifactSnapshot");
function remapSessionArtifactPayloadForFork(payload, sourceSessionId, newSessionId, remappedArtifactIds = /* @__PURE__ */ new Map()) {
  const snapshot = normalizeSnapshotPayload(payload, []);
  if (snapshot) {
    const {
      markerArtifacts: snapshotMarkerArtifacts,
      ...snapshotWithoutMarkers
    } = snapshot;
    const artifacts = [];
    for (const artifact of snapshot.artifacts) {
      const remapped = remapForkSafeSessionArtifactForFork(
        artifact,
        sourceSessionId,
        newSessionId
      );
      if (!remapped) {
        seedForkArtifactIdRemap(artifact, newSessionId, remappedArtifactIds);
        continue;
      }
      remappedArtifactIds.set(artifact.id, remapped.id);
      artifacts.push(remapped);
    }
    const markerIds = /* @__PURE__ */ new Set([
      ...snapshot.tombstonedIds ?? [],
      ...snapshot.stickyEphemeralIds ?? []
    ]);
    const markerArtifacts = (snapshotMarkerArtifacts ?? []).filter((artifact) => markerIds.has(artifact.id)).map((artifact) => {
      const remapped = remapForkSafeSessionArtifactForFork(
        artifact,
        sourceSessionId,
        newSessionId
      );
      if (!remapped) {
        seedForkArtifactIdRemap(artifact, newSessionId, remappedArtifactIds);
        return void 0;
      }
      remappedArtifactIds.set(artifact.id, remapped.id);
      return remapped;
    }).filter((artifact) => artifact !== void 0);
    return {
      ...snapshotWithoutMarkers,
      sessionId: newSessionId,
      artifacts,
      ...markerArtifacts.length > 0 ? { markerArtifacts } : {},
      tombstonedIds: (snapshot.tombstonedIds ?? []).map(
        (artifactId) => remapArtifactIdForFork(
          artifactId,
          sourceSessionId,
          newSessionId,
          remappedArtifactIds
        )
      ),
      stickyEphemeralIds: (snapshot.stickyEphemeralIds ?? []).map(
        (artifactId) => remapArtifactIdForFork(
          artifactId,
          sourceSessionId,
          newSessionId,
          remappedArtifactIds
        )
      )
    };
  }
  const event = normalizeEventPayload(payload, []);
  if (!event) return payload;
  return {
    ...event,
    sessionId: newSessionId,
    changes: event.changes.map((change) => {
      if (change.artifact) {
        const artifact = remapForkSafeSessionArtifactForFork(
          change.artifact,
          sourceSessionId,
          newSessionId
        );
        if (!artifact) {
          if (change.action !== "removed") return void 0;
          seedForkArtifactIdRemap(
            change.artifact,
            newSessionId,
            remappedArtifactIds
          );
          const { artifact: _unsafeArtifact, ...changeWithoutArtifact } = change;
          return {
            ...changeWithoutArtifact,
            artifactId: remapArtifactIdForFork(
              change.artifactId,
              sourceSessionId,
              newSessionId,
              remappedArtifactIds
            )
          };
        }
        remappedArtifactIds.set(change.artifactId, artifact.id);
        return {
          ...change,
          artifactId: artifact.id,
          artifact
        };
      }
      if (change.action === "removed") {
        return {
          ...change,
          artifactId: remapArtifactIdForFork(
            change.artifactId,
            sourceSessionId,
            newSessionId,
            remappedArtifactIds
          )
        };
      }
      return {
        ...change,
        artifactId: remapArtifactIdForFork(
          change.artifactId,
          sourceSessionId,
          newSessionId,
          remappedArtifactIds
        )
      };
    }).filter((change) => change !== void 0)
  };
}
__name(remapSessionArtifactPayloadForFork, "remapSessionArtifactPayloadForFork");
function remapForkSafeSessionArtifactForFork(artifact, sourceSessionId, newSessionId) {
  if (!isForkSafeArtifact(artifact)) return void 0;
  return remapSessionArtifactForFork(artifact, sourceSessionId, newSessionId);
}
__name(remapForkSafeSessionArtifactForFork, "remapForkSafeSessionArtifactForFork");
function seedForkArtifactIdRemap(artifact, newSessionId, remappedArtifactIds) {
  const identityKey = forkSafeSessionArtifactIdentityKey(artifact);
  if (!identityKey) return;
  remappedArtifactIds.set(
    artifact.id,
    stableSessionArtifactId(newSessionId, identityKey)
  );
}
__name(seedForkArtifactIdRemap, "seedForkArtifactIdRemap");
function forkSafeSessionArtifactIdentityKey(artifact) {
  if (artifact.workspacePath) return `workspace:${artifact.workspacePath}`;
  if (artifact.managedId) return `managed:${artifact.managedId}`;
  if (artifact.url && !hasRestoreUnsafeUrl(artifact.url)) {
    return `url:${artifact.url}`;
  }
  return void 0;
}
__name(forkSafeSessionArtifactIdentityKey, "forkSafeSessionArtifactIdentityKey");
function remapArtifactIdForFork(artifactId, sourceSessionId, newSessionId, remappedArtifactIds) {
  return remappedArtifactIds.get(artifactId) ?? stableSessionArtifactId(
    newSessionId,
    `fork:${sourceSessionId}:${artifactId}`
  );
}
__name(remapArtifactIdForFork, "remapArtifactIdForFork");
function remapSessionArtifactForFork(artifact, sourceSessionId, newSessionId) {
  const identityKey = sessionArtifactIdentityKey(artifact);
  const id = identityKey ? stableSessionArtifactId(newSessionId, identityKey) : stableSessionArtifactId(
    newSessionId,
    `fork:${sourceSessionId}:${artifact.id}`
  );
  const next = {
    ...artifact,
    id,
    retention: artifact.retention === "pinned" ? "restorable" : artifact.retention
  };
  delete next.contentRef;
  delete next.expiresAt;
  delete next.clientId;
  return next;
}
__name(remapSessionArtifactForFork, "remapSessionArtifactForFork");
function isForkSafeArtifact(artifact) {
  if (artifact.metadata && hasRestoreUnsafeMetadata(artifact.metadata)) {
    return false;
  }
  if (artifact.url && hasRestoreUnsafeUrl(artifact.url) && !getWebPreviewSnapshotId(artifact)) {
    return false;
  }
  return true;
}
__name(isForkSafeArtifact, "isForkSafeArtifact");
function hasRestoreUnsafeMetadata(metadata) {
  for (const [key, value] of Object.entries(metadata)) {
    if (!key || isSecretLikeText(key)) {
      return true;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return true;
    }
    if (typeof value === "string" && !isReservedWorkspaceMetadataKey(key) && isSecretLikeMetadataValue(value)) {
      return true;
    }
  }
  return false;
}
__name(hasRestoreUnsafeMetadata, "hasRestoreUnsafeMetadata");
function hasRestoreUnsafeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }
  if (parsed.username || parsed.password) {
    return true;
  }
  for (const [key, urlValue] of parsed.searchParams) {
    if (isSecretLikeText(key) || isSecretLikeUrlValue(urlValue)) {
      return true;
    }
  }
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    let decodedSegment = segment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
    }
    if (isSecretLikeUrlValue(decodedSegment)) {
      return true;
    }
  }
  const fragment = parsed.hash.slice(1);
  return hasSecretLikeUrlFragment(fragment);
}
__name(hasRestoreUnsafeUrl, "hasRestoreUnsafeUrl");
function hasSecretLikeUrlFragment(fragment) {
  if (!fragment) return false;
  const candidates = /* @__PURE__ */ new Set([fragment]);
  try {
    candidates.add(decodeURIComponent(fragment));
  } catch {
  }
  for (const candidate of candidates) {
    if (isSecretLikeText(candidate) || isSecretLikeUrlValue(candidate)) {
      return true;
    }
    for (const [key, value] of new URLSearchParams(candidate)) {
      if (isSecretLikeText(key) || isSecretLikeUrlValue(value)) {
        return true;
      }
    }
  }
  return false;
}
__name(hasSecretLikeUrlFragment, "hasSecretLikeUrlFragment");
function isSecretLikeText(value) {
  const normalized = value.replace(/([a-z])([A-Z])/g, "$1-$2");
  return /(?:^|[-_.])(token|secret|password|passwd|pwd|cookie|authorization|credential|signature|sig|api[-_]?key|access[-_]?key)(?:$|[-_.=&#])/i.test(
    normalized
  );
}
__name(isSecretLikeText, "isSecretLikeText");
function isSecretLikeUrlValue(value) {
  return SECRET_TOKEN_VALUE_PATTERN.test(value.trim());
}
__name(isSecretLikeUrlValue, "isSecretLikeUrlValue");
function isSecretLikeMetadataValue(value) {
  return /^(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,})$/i.test(
    value.trim()
  );
}
__name(isSecretLikeMetadataValue, "isSecretLikeMetadataValue");
function normalizeSnapshotPayload(value, warnings) {
  if (!isRecord(value)) {
    warnings.push("skipped malformed snapshot record");
    return void 0;
  }
  if (value["v"] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    warnings.push(
      `skipped v${String(value["v"])} snapshot record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`
    );
    return void 0;
  }
  if (!Array.isArray(value["artifacts"])) {
    warnings.push("skipped snapshot record without artifacts array");
    return void 0;
  }
  const sessionId = getString(value, "sessionId");
  if (!sessionId) {
    warnings.push("skipped snapshot record without sessionId");
    return void 0;
  }
  const rawArtifacts = value["artifacts"];
  if (rawArtifacts.length > MAX_PERSISTED_ARTIFACTS) {
    warnings.push(
      `snapshot artifact list truncated to ${MAX_PERSISTED_ARTIFACTS}`
    );
  }
  const rawMarkerArtifacts = Array.isArray(value["markerArtifacts"]) ? value["markerArtifacts"] : [];
  if (rawMarkerArtifacts.length > MAX_PERSISTED_MARKER_ARTIFACTS) {
    warnings.push(
      `snapshot marker artifact list truncated to ${MAX_PERSISTED_MARKER_ARTIFACTS}`
    );
  }
  const artifacts = rawArtifacts.slice(0, MAX_PERSISTED_ARTIFACTS).map((artifact) => normalizePersistedArtifact(artifact, warnings)).filter((artifact) => artifact !== void 0);
  const markerArtifacts = rawMarkerArtifacts.slice(0, MAX_PERSISTED_MARKER_ARTIFACTS).map((artifact) => normalizePersistedArtifact(artifact, warnings)).filter((artifact) => artifact !== void 0);
  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence: getNonNegativeInteger(value, "sequence") ?? 0,
    recordedAt: getString(value, "recordedAt", MAX_PERSISTED_TIMESTAMP_CHARS) ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    artifacts,
    ...markerArtifacts.length > 0 ? { markerArtifacts } : {},
    tombstonedIds: getStringArray(value, "tombstonedIds", MAX_PERSISTED_IDS),
    stickyEphemeralIds: getStringArray(
      value,
      "stickyEphemeralIds",
      MAX_PERSISTED_IDS
    )
  };
}
__name(normalizeSnapshotPayload, "normalizeSnapshotPayload");
function normalizeEventPayload(value, warnings) {
  if (!isRecord(value)) {
    warnings.push("skipped malformed event record");
    return void 0;
  }
  if (value["v"] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    warnings.push(
      `skipped v${String(value["v"])} event record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`
    );
    return void 0;
  }
  if (!Array.isArray(value["changes"])) {
    warnings.push("skipped event record without changes array");
    return void 0;
  }
  const sessionId = getString(value, "sessionId", MAX_PERSISTED_ID_CHARS);
  if (!sessionId) {
    warnings.push("skipped event record without sessionId");
    return void 0;
  }
  const rawChanges = value["changes"];
  if (rawChanges.length > MAX_PERSISTED_EVENT_CHANGES) {
    warnings.push(
      `event change list truncated to ${MAX_PERSISTED_EVENT_CHANGES}`
    );
  }
  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence: getNonNegativeInteger(value, "sequence") ?? 0,
    recordedAt: getString(value, "recordedAt", MAX_PERSISTED_TIMESTAMP_CHARS) ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    changes: rawChanges.slice(0, MAX_PERSISTED_EVENT_CHANGES).map((change) => normalizePersistedChange(change, warnings)).filter((change) => change !== void 0)
  };
}
__name(normalizeEventPayload, "normalizeEventPayload");
function normalizePersistedChange(value, warnings) {
  if (!isRecord(value)) {
    warnings.push("skipped malformed artifact change");
    return void 0;
  }
  const action = value["action"];
  if (action !== "created" && action !== "updated" && action !== "removed") {
    warnings.push("skipped artifact change with invalid action");
    return void 0;
  }
  const artifact = normalizePersistedArtifact(value["artifact"], warnings);
  const artifactId = getString(value, "artifactId", MAX_PERSISTED_ID_CHARS) ?? artifact?.id;
  if (!artifactId) {
    warnings.push("skipped artifact change without artifactId");
    return void 0;
  }
  const reason = value["reason"];
  return {
    action,
    artifactId,
    ...artifact ? { artifact } : {},
    ...reason === "explicit" || reason === "eviction" || reason === "unpin_to_ephemeral" ? { reason } : {}
  };
}
__name(normalizePersistedChange, "normalizePersistedChange");
function normalizePersistedArtifact(value, warnings) {
  if (!isRecord(value)) return void 0;
  const id = getString(value, "id", MAX_PERSISTED_ID_CHARS);
  const title = getString(value, "title", MAX_PERSISTED_TITLE_CHARS);
  if (!id || !title) {
    warnings.push("skipped artifact without id/title");
    return void 0;
  }
  const kind = normalizeLiteral(value["kind"], [
    "file",
    "link",
    "html",
    "image",
    "video",
    "audio",
    "pdf",
    "notebook",
    "document",
    "other"
  ]);
  const storage = normalizeLiteral(
    value["storage"],
    ["workspace", "external_url", "managed", "published"]
  );
  const source = normalizeLiteral(
    value["source"],
    ["tool", "hook", "client"]
  );
  const status = normalizeLiteral(value["status"], [
    "available",
    "missing",
    "changed"
  ]) ?? "missing";
  const retention = normalizeLiteral(value["retention"], [
    "ephemeral",
    "restorable",
    "pinned"
  ]) ?? "restorable";
  if (!kind || !storage || !source) {
    warnings.push(`skipped malformed artifact ${id}`);
    return void 0;
  }
  const metadata = normalizeMetadata(value["metadata"], warnings, id);
  const description = getString(
    value,
    "description",
    MAX_PERSISTED_DESCRIPTION_CHARS
  );
  const workspacePath = getString(
    value,
    "workspacePath",
    MAX_PERSISTED_PATH_CHARS
  );
  const managedId = getString(value, "managedId", MAX_PERSISTED_FIELD_CHARS);
  const url = getString(value, "url", MAX_PERSISTED_URL_CHARS);
  const mimeType = getString(value, "mimeType", MAX_PERSISTED_MIME_CHARS);
  const sizeBytes = getNonNegativeInteger(value, "sizeBytes");
  const persistedAt = getString(
    value,
    "persistedAt",
    MAX_PERSISTED_TIMESTAMP_CHARS
  );
  const expiresAt = getString(
    value,
    "expiresAt",
    MAX_PERSISTED_TIMESTAMP_CHARS
  );
  const contentRef = normalizeContentRef(value["contentRef"]);
  const toolCallId = getString(value, "toolCallId", MAX_PERSISTED_FIELD_CHARS);
  const toolName = getString(value, "toolName", MAX_PERSISTED_FIELD_CHARS);
  const hookEventName = getString(
    value,
    "hookEventName",
    MAX_PERSISTED_FIELD_CHARS
  );
  const clientId = getString(value, "clientId", MAX_PERSISTED_FIELD_CHARS);
  return {
    id,
    kind,
    storage,
    source,
    status,
    title,
    ...description ? { description } : {},
    ...workspacePath ? { workspacePath } : {},
    ...managedId ? { managedId } : {},
    ...url ? { url } : {},
    ...mimeType ? { mimeType } : {},
    ...sizeBytes !== void 0 ? { sizeBytes } : {},
    ...metadata ? { metadata } : {},
    retention,
    clientRetained: value["clientRetained"] === true,
    createdAt: getString(value, "createdAt", MAX_PERSISTED_TIMESTAMP_CHARS) ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    updatedAt: getString(value, "updatedAt", MAX_PERSISTED_TIMESTAMP_CHARS) ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    ...persistedAt ? { persistedAt } : {},
    ...expiresAt ? { expiresAt } : {},
    ...contentRef ? { contentRef } : {},
    ...toolCallId ? { toolCallId } : {},
    ...toolName ? { toolName } : {},
    ...hookEventName ? { hookEventName } : {},
    ...clientId ? { clientId } : {}
  };
}
__name(normalizePersistedArtifact, "normalizePersistedArtifact");
function normalizeContentRef(value) {
  if (!isRecord(value) || value["kind"] !== "managed_copy") return void 0;
  const contentId = getString(value, "contentId", MAX_PERSISTED_FIELD_CHARS);
  const sha256 = getString(value, "sha256", 64);
  const sizeBytes = getNonNegativeInteger(value, "sizeBytes");
  const createdAt = getString(
    value,
    "createdAt",
    MAX_PERSISTED_TIMESTAMP_CHARS
  );
  if (!contentId || !CONTENT_ID_PATTERN.test(contentId) || !sha256 || !/^[0-9a-f]{64}$/.test(sha256) || sizeBytes === void 0 || !createdAt) {
    return void 0;
  }
  return { kind: "managed_copy", contentId, sha256, sizeBytes, createdAt };
}
__name(normalizeContentRef, "normalizeContentRef");
function normalizeMetadata(value, warnings, artifactId) {
  if (!isRecord(value)) return void 0;
  const normalized = {};
  for (const [key, item] of Object.entries(value)) {
    if (isPrototypeMetadataKey(key)) continue;
    if (key.length > 120) continue;
    if (hasControlCharacter(key) || hasUnsafeDisplayPayload(key)) continue;
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      if (isAdoptableContentFingerprintKey(key) && !isContentFingerprintMetadataEntry(key, item)) {
        continue;
      }
      if (typeof item === "string" && (hasControlCharacter(item) || hasUnsafeDisplayPayload(item))) {
        continue;
      }
      normalized[key] = item;
    }
  }
  if (Object.keys(normalized).length === 0) return void 0;
  if (metadataBudgetBytes(normalized) > 4096) {
    warnings.push(`skipped oversized metadata for artifact ${artifactId}`);
    return void 0;
  }
  return normalized;
}
__name(normalizeMetadata, "normalizeMetadata");
function isPrototypeMetadataKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}
__name(isPrototypeMetadataKey, "isPrototypeMetadataKey");
function isReservedWorkspaceMetadataKey(key) {
  return key === WORKSPACE_CONTENT_SHA256_METADATA_KEY || key === WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY || key === WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY;
}
__name(isReservedWorkspaceMetadataKey, "isReservedWorkspaceMetadataKey");
function isAdoptableContentFingerprintKey(key) {
  return isReservedWorkspaceMetadataKey(key) || key === PUBLISHED_CONTENT_SHA256_METADATA_KEY;
}
__name(isAdoptableContentFingerprintKey, "isAdoptableContentFingerprintKey");
function hasControlCharacter(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127 || code >= 8203 && code <= 8207 || code === 8232 || code === 8233 || code >= 8234 && code <= 8238 || code >= 8294 && code <= 8297 || code === 65279) {
      return true;
    }
  }
  return false;
}
__name(hasControlCharacter, "hasControlCharacter");
function hasUnsafeDisplayPayload(value) {
  return /<\s*\/?[a-z!]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|javascript\s*:|data\s*:\s*(?:text\/(?:html|javascript)|application\/javascript|image\/svg\+xml)/i.test(
    value
  ) || /(?:^|[\s"'`<])on[a-z][a-z0-9-]*\s*=/i.test(value);
}
__name(hasUnsafeDisplayPayload, "hasUnsafeDisplayPayload");
function metadataBudgetBytes(metadata, budget = "persisted") {
  if (budget === "user") {
    return Buffer.byteLength(JSON.stringify(metadata), "utf8");
  }
  const userMetadata = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) => !isContentFingerprintMetadataEntry(key, value)
    )
  );
  return Buffer.byteLength(JSON.stringify(userMetadata), "utf8");
}
__name(metadataBudgetBytes, "metadataBudgetBytes");
function isWorkspaceContentMetadataEntry(key, value) {
  if (key === WORKSPACE_CONTENT_SHA256_METADATA_KEY) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  }
  if (key === WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY) {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (key === WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }
  return false;
}
__name(isWorkspaceContentMetadataEntry, "isWorkspaceContentMetadataEntry");
function isContentFingerprintMetadataEntry(key, value) {
  if (isWorkspaceContentMetadataEntry(key, value)) {
    return true;
  }
  return key === PUBLISHED_CONTENT_SHA256_METADATA_KEY && typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
__name(isContentFingerprintMetadataEntry, "isContentFingerprintMetadataEntry");
function normalizeLiteral(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : void 0;
}
__name(normalizeLiteral, "normalizeLiteral");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function getString(record, key, maxLength = MAX_PERSISTED_FIELD_CHARS) {
  const value = record[key];
  if (typeof value !== "string" || value.length > maxLength) {
    return void 0;
  }
  return value;
}
__name(getString, "getString");
function getStringArray(record, key, maxItems = MAX_PERSISTED_IDS, maxLength = MAX_PERSISTED_ID_CHARS) {
  const value = record[key];
  if (!Array.isArray(value)) return void 0;
  const items = value.filter(
    (item) => typeof item === "string" && item.length <= maxLength
  ).slice(-maxItems);
  return items.length > 0 ? items : void 0;
}
__name(getStringArray, "getStringArray");
function getNonNegativeInteger(record, key) {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
__name(getNonNegativeInteger, "getNonNegativeInteger");

// packages/core/src/tools/artifact/html.ts
init_esbuild_shims();
var MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
var CSS_RESET = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:1.5rem;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1a1a1a;background:#fff}
img,svg,video,canvas{max-width:100%;height:auto}
pre,table{max-width:100%;overflow-x:auto}
:where(a){color:#0969da}`;
var DEFAULT_TITLE = "Artifact";
function sanitizeArtifactTitle(raw) {
  const cleaned = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || DEFAULT_TITLE;
}
__name(sanitizeArtifactTitle, "sanitizeArtifactTitle");
function escapeForTitle(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escapeForTitle, "escapeForTitle");
function validateSelfContained(fragment) {
  if (!fragment.trim()) {
    return "Artifact file is empty \u2014 write the page content (a body-only HTML fragment) first.";
  }
  const scan = normalizeAttributeQuotes(fragment);
  const head = fragment.replace(/^\s+/, "").replace(/^(?:<!--[\s\S]*?-->\s*)+/, "");
  const wrapperTag = /^(?:<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>])/i.exec(
    head
  );
  if (wrapperTag) {
    return `Write a body-only fragment \u2014 it starts with a full-document tag (${wrapperTag[0].trim()}). Omit <!doctype>, <html>, <head>, and <body>; they are added at publish time.`;
  }
  const extResource = /\b(?:src|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(scan) ?? /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(scan);
  if (extResource) {
    return `Artifact must be self-contained \u2014 found an external reference (${truncate(extResource[0])}). Inline scripts/styles and embed assets as data: URIs.`;
  }
  const jsUri = /\b(?:href|src)\s*=\s*["']?\s*javascript\s*:/i.exec(scan);
  if (jsUri) {
    return `Artifact must be self-contained \u2014 found a javascript: URI (${truncate(jsUri[0])}). Use inline <script> blocks instead.`;
  }
  const extScript = /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(\s*["']\s*(?:https?|wss?):\/\//i.exec(
    scan
  ) ?? /\bimport\s*\(\s*["'](?:https?:)?\/\//i.exec(scan) ?? /\bwindow\.open\s*\(/i.exec(scan) ?? /\blocation\.\w+\s*[=(]/i.exec(scan) ?? /\bnavigator\.sendBeacon\s*\(\s*["']\s*(?:https?:)?\/\//i.exec(scan);
  if (extScript) {
    return `Artifact must be self-contained \u2014 found browser network egress (${truncate(extScript[0])}). Embed data in the artifact instead of fetching it at runtime.`;
  }
  const metaRefresh = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\burl\s*=\s*(?:https?:)?\/\//i.exec(
    scan
  );
  if (metaRefresh) {
    return `Artifact must be self-contained \u2014 found a meta refresh redirect (${truncate(metaRefresh[0])}).`;
  }
  const extCss = /(?:@import\s+(?:url\()?|url\()\s*["']?\s*(?:https?:)?\/\//i.exec(scan);
  if (extCss) {
    return `Artifact must be self-contained \u2014 found an external CSS reference (${truncate(extCss[0])}). Inline CSS and embed fonts/images as data: URIs.`;
  }
  return null;
}
__name(validateSelfContained, "validateSelfContained");
function normalizeAttributeQuotes(s) {
  return s.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&apos;|&#39;|&#x27;/gi, "'");
}
__name(normalizeAttributeQuotes, "normalizeAttributeQuotes");
function truncate(s, max = 60) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}\u2026` : t;
}
__name(truncate, "truncate");
function wrapArtifactHtml(bodyFragment, title) {
  const safeTitle = escapeForTitle(sanitizeArtifactTitle(title));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-scripts;">
<title>${safeTitle}</title>
<style>${CSS_RESET}</style>
</head>
<body>
${bodyFragment}
</body>
</html>
`;
}
__name(wrapArtifactHtml, "wrapArtifactHtml");
function byteLength(s) {
  return Buffer.byteLength(s, "utf8");
}
__name(byteLength, "byteLength");

// packages/core/src/tools/artifact/artifact-snapshots.ts
init_esbuild_shims();
import { createHash as createHash2, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
var SNAPSHOT_REFERENCES_METADATA_KEY = "qwen.snapshot.references";
async function saveArtifactSnapshot(html, title, publishedUrl, sessionId, runtimeBaseDir) {
  const id = randomUUID();
  const root = path.join(runtimeBaseDir, "artifacts", "snapshots");
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(root, id);
  await fs.mkdir(dir);
  const file = path.join(dir, "index.html");
  try {
    const references = path.join(dir, "references");
    await fs.mkdir(references);
    await fs.writeFile(
      path.join(references, snapshotReference(sessionId)),
      "",
      {
        flag: "wx",
        mode: 384,
        flush: true
      }
    );
    await fs.writeFile(file, html, {
      encoding: "utf8",
      flag: "wx",
      mode: 384,
      flush: true
    });
    await syncSnapshotDirectory(references);
    await syncSnapshotDirectory(dir);
    await syncSnapshotDirectory(root);
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => void 0);
    throw error;
  }
  return {
    kind: "html",
    storage: "published",
    title,
    url: pathToFileURL(file).href,
    managedId: `preview-${id}`,
    mimeType: "text/html",
    sizeBytes: Buffer.byteLength(html, "utf8"),
    metadata: {
      artifactType: "web_preview_snapshot",
      [SNAPSHOT_REFERENCES_METADATA_KEY]: 1,
      publishedUrl,
      [PUBLISHED_CONTENT_SHA256_METADATA_KEY]: createHash2("sha256").update(html).digest("hex")
    }
  };
}
__name(saveArtifactSnapshot, "saveArtifactSnapshot");
async function readArtifactSnapshot(artifact, runtimeBaseDir) {
  const id = getWebPreviewSnapshotId(artifact);
  const sha256 = artifact.metadata?.[PUBLISHED_CONTENT_SHA256_METADATA_KEY];
  const unavailable = /* @__PURE__ */ __name(() => new Error("Saved webpage version is unavailable."), "unavailable");
  if (!id) throw unavailable();
  const root = path.join(runtimeBaseDir, "artifacts", "snapshots");
  const file = path.join(root, id, "index.html");
  if (artifact.url !== pathToFileURL(file).href) throw unavailable();
  const realRoot = await fs.realpath(root);
  if (await fs.realpath(file) !== path.join(realRoot, id, "index.html")) {
    throw unavailable();
  }
  const handle = await fs.open(
    file,
    // O_NOFOLLOW refuses a symlink swapped in after the realpath check, and
    // O_NONBLOCK keeps a FIFO swapped into the same window from blocking the
    // open: the path is only proven to be a regular file by the fstat below.
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw unavailable();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const content = bytes.subarray(0, length);
    if (length !== stat.size || createHash2("sha256").update(content).digest("hex") !== sha256) {
      throw unavailable();
    }
    return content.toString("utf8");
  } finally {
    await handle.close();
  }
}
__name(readArtifactSnapshot, "readArtifactSnapshot");
function snapshotReference(sessionId, operationId) {
  const owner = createHash2("sha256").update(sessionId).digest("hex");
  return operationId ? `${owner}-${createHash2("sha256").update(operationId).digest("hex")}` : owner;
}
__name(snapshotReference, "snapshotReference");
async function syncSnapshotDirectory(directory) {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
__name(syncSnapshotDirectory, "syncSnapshotDirectory");
async function snapshotDirectory(artifact, runtimeBaseDir) {
  const id = getWebPreviewSnapshotId(artifact);
  if (!id) return void 0;
  const root = path.join(runtimeBaseDir, "artifacts", "snapshots");
  const dir = path.join(root, id);
  if (artifact.url !== pathToFileURL(path.join(dir, "index.html")).href) {
    return void 0;
  }
  if (artifact.metadata?.[SNAPSHOT_REFERENCES_METADATA_KEY] !== 1)
    return void 0;
  const realRoot = await fs.realpath(root);
  if (await fs.realpath(dir) !== path.join(realRoot, id)) return void 0;
  if (await fs.realpath(path.join(dir, "index.html")) !== path.join(realRoot, id, "index.html"))
    return void 0;
  if (await fs.realpath(path.join(dir, "references")) !== path.join(realRoot, id, "references")) {
    return void 0;
  }
  return dir;
}
__name(snapshotDirectory, "snapshotDirectory");
async function retainArtifactSnapshot(artifact, runtimeBaseDir, sessionId, operationId) {
  try {
    const dir = await snapshotDirectory(artifact, runtimeBaseDir);
    if (!dir) return;
    const references = path.join(dir, "references");
    const owner = snapshotReference(sessionId);
    const entries = await fs.readdir(references);
    if (!operationId && entries.some((entry) => entry === owner || entry.startsWith(`${owner}-`)))
      return;
    await fs.writeFile(
      path.join(references, snapshotReference(sessionId, operationId)),
      "",
      { flag: "wx", mode: 384, flush: true }
    );
    await syncSnapshotDirectory(references);
  } catch (error) {
    const code = error.code;
    if (code !== "EEXIST" && !(code === "ENOENT" && !operationId)) throw error;
  }
}
__name(retainArtifactSnapshot, "retainArtifactSnapshot");
async function deleteArtifactSnapshot(artifact, runtimeBaseDir, sessionId, operationId, assertCleanupOwned) {
  try {
    const dir = await snapshotDirectory(artifact, runtimeBaseDir);
    if (!dir) return;
    await releaseSnapshotDirectory(
      dir,
      sessionId,
      operationId,
      assertCleanupOwned
    );
  } catch {
    assertCleanupOwned?.();
  }
}
__name(deleteArtifactSnapshot, "deleteArtifactSnapshot");
async function releaseSnapshotDirectory(dir, sessionId, operationId, assertCleanupOwned) {
  const references = path.join(dir, "references");
  const owner = snapshotReference(sessionId, operationId);
  let released = false;
  for (const reference of await fs.readdir(references)) {
    if (reference === owner || !operationId && reference.startsWith(`${owner}-`)) {
      assertCleanupOwned?.();
      await fs.unlink(path.join(references, reference));
      released = true;
    }
  }
  if (!released) return;
  try {
    assertCleanupOwned?.();
    await fs.rmdir(references);
  } catch (error) {
    if (error.code === "ENOTEMPTY") return;
    throw error;
  }
  const file = path.join(dir, "index.html");
  assertCleanupOwned?.();
  await fs.unlink(file);
  assertCleanupOwned?.();
  await fs.rmdir(dir);
}
__name(releaseSnapshotDirectory, "releaseSnapshotDirectory");

export {
  TranscriptRecordPreparationError,
  stripGeneratedAttachmentTokens,
  wrapUserPromptSubmitContext,
  isUserPromptSubmitContextPartText,
  projectUserTranscriptForDisplay,
  isTranscriptConversationRecord,
  validateTranscriptRecord,
  selectTranscriptLeaf,
  walkTranscriptUuidChain,
  aggregateTranscriptRecordFragments,
  prepareTranscriptRecords,
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  WORKSPACE_CONTENT_SHA256_METADATA_KEY,
  WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY,
  WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY,
  PUBLISHED_CONTENT_SHA256_METADATA_KEY,
  getWebPreviewSnapshotId,
  isSessionArtifactRecord,
  selectActiveSideArtifactRecordUuids,
  stableSessionArtifactId,
  SessionArtifactSnapshotAccumulator,
  rebuildSessionArtifactSnapshot,
  remapSessionArtifactPayloadForFork,
  normalizeSnapshotPayload,
  normalizeEventPayload,
  isPrototypeMetadataKey,
  isReservedWorkspaceMetadataKey,
  isAdoptableContentFingerprintKey,
  metadataBudgetBytes,
  MAX_ARTIFACT_BYTES,
  sanitizeArtifactTitle,
  validateSelfContained,
  wrapArtifactHtml,
  byteLength,
  saveArtifactSnapshot,
  readArtifactSnapshot,
  retainArtifactSnapshot,
  deleteArtifactSnapshot
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
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
