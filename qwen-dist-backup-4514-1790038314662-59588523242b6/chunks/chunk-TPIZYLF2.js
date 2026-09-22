// Force strict mode and setup for ESM
"use strict";
import {
  formatHistoryGapNotice
} from "./chunk-SSFOFDNL.js";
import {
  sanitizeTerminalText
} from "./chunk-47ECGEJC.js";
import {
  ok
} from "./chunk-VFFQAOPR.js";
import {
  loadUndici
} from "./chunk-TXASDT2M.js";
import {
  LOAD_REPLAY_META_KEY,
  parseBackgroundNotificationTurn
} from "./chunk-RN6A53UJ.js";
import {
  DAEMON_ERROR_KINDS,
  createDaemonTranscriptState,
  finalizeOfflineDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents
} from "./chunk-RO7OJQS2.js";
import {
  isGoalCheckpointBookkeepingRecord,
  projectGoalStateToLegacy
} from "./chunk-47GVX3K4.js";
import {
  observeToolResultBoundary,
  toolResultBoundaryArtifact
} from "./chunk-MRTRBONQ.js";
import {
  TranscriptRecordPreparationError,
  prepareTranscriptRecords,
  projectUserTranscriptForDisplay,
  stripGeneratedAttachmentTokens
} from "./chunk-ANKISCKU.js";
import {
  GOAL_PAUSE_REASON_COMMAND,
  parseGoalSnapshotV2,
  parseGoalStateCause,
  parseGoalStateRecordPayloadV2
} from "./chunk-IMV5DBIP.js";
import {
  formatVisionBridgeNoticeDisplay,
  isVisionBridgeNoticeDisplay
} from "./chunk-KKGSJZWK.js";
import {
  SchemaValidator,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine,
  writeStderrLineSafe
} from "./chunk-7FA2II6K.js";
import {
  require_extend
} from "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __export,
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/nonInteractive/tool-result-boundary-diagnostics.ts
init_esbuild_shims();
var acpUpdateArtifacts = /* @__PURE__ */ new WeakMap();
var projectedAcpUpdates = /* @__PURE__ */ new WeakMap();
var projectedHeadlessMessages = /* @__PURE__ */ new WeakMap();
function associateAcpToolResultArtifact(update, artifact) {
  if (isObject(update)) acpUpdateArtifacts.set(update, artifact);
}
__name(associateAcpToolResultArtifact, "associateAcpToolResultArtifact");
function observeAcpToolResultProjection(input, output, sessionId, wireUpdate = output) {
  try {
    if (isObject(wireUpdate) && projectedAcpUpdates.has(wireUpdate)) return;
    const mutated = input !== output;
    const artifact = acpUpdateArtifacts.get(input) ?? {
      state: "undecided",
      kinds: []
    };
    const common = { sessionId, toolCallId: toolCallId(input) };
    const inputEligible = observeToolResultBoundary({
      stage: "acp_projection_input",
      ...common,
      mutated,
      artifacts: [artifact],
      values: /* @__PURE__ */ __name(() => acpToolResultValues(input), "values")
    });
    const outputEligible = observeToolResultBoundary({
      stage: "acp_projection_output",
      ...common,
      mutated,
      artifacts: [artifact],
      values: /* @__PURE__ */ __name(() => acpToolResultValues(output), "values")
    });
    if ((inputEligible || outputEligible) && isObject(wireUpdate)) {
      projectedAcpUpdates.set(wireUpdate, { mutated, artifact, sessionId });
    }
  } catch {
  }
}
__name(observeAcpToolResultProjection, "observeAcpToolResultProjection");
function observeAcpToolResultWire(message, payloadUtf8Bytes) {
  try {
    const record = asRecord(message);
    if (!record) return;
    const updates = acpWireUpdates(record).flatMap((update) => {
      const projection = projectedAcpUpdates.get(update);
      return projection ? [{ update, projection }] : [];
    });
    if (updates.length === 0) return;
    const params = asRecord(record["params"]);
    const projectionSessionIds = new Set(
      updates.map(({ projection }) => projection.sessionId)
    );
    const toolCallIds = updates.flatMap(({ update }) => {
      const id = toolCallId(update);
      return id === void 0 ? [] : [id];
    });
    observeToolResultBoundary({
      stage: "acp_wire",
      sessionId: typeof params?.["sessionId"] === "string" ? params["sessionId"] : projectionSessionIds.size === 1 ? projectionSessionIds.values().next().value : void 0,
      toolCallId: updates.length === 1 ? toolCallId(updates[0].update) : void 0,
      ...updates.length > 1 ? { toolCallIds } : {},
      wireUtf8Bytes: payloadUtf8Bytes + 1,
      mutated: updates.some(({ projection }) => projection.mutated),
      artifacts: updates.map(({ projection }) => projection.artifact),
      values: /* @__PURE__ */ __name(() => updates.flatMap(
        ({ update }) => acpToolResultValues(update)
      ), "values")
    });
    for (const { update } of updates) projectedAcpUpdates.delete(update);
  } catch {
  }
}
__name(observeAcpToolResultWire, "observeAcpToolResultWire");
function observeHeadlessToolResultProjection(message, inputContent, outputContent, toolCallId2, artifact) {
  try {
    const mutated = inputContent !== outputContent;
    const inputEligible = observeToolResultBoundary({
      stage: "headless_projection_input",
      sessionId: message.session_id,
      toolCallId: toolCallId2,
      mutated,
      artifacts: [artifact],
      values: [{ representation: "headless_content", value: inputContent }]
    });
    const outputEligible = observeToolResultBoundary({
      stage: "headless_projection_output",
      sessionId: message.session_id,
      toolCallId: toolCallId2,
      mutated,
      artifacts: [artifact],
      values: [{ representation: "headless_content", value: outputContent }]
    });
    if (inputEligible || outputEligible) {
      projectedHeadlessMessages.set(message, {
        mutated,
        artifact,
        sessionId: message.session_id
      });
    }
  } catch {
  }
}
__name(observeHeadlessToolResultProjection, "observeHeadlessToolResultProjection");
function observeHeadlessToolResultWire(message, frame) {
  try {
    if (!projectedHeadlessMessages.has(message)) return;
    const projection = projectedHeadlessMessages.get(message);
    const toolResults = headlessToolResults(message);
    const values = toolResults.flatMap(toolResultValues);
    observeToolResultBoundary({
      stage: "headless_wire",
      sessionId: message.session_id,
      toolCallId: toolResults.length === 1 && typeof toolResults[0].tool_use_id === "string" ? toolResults[0].tool_use_id : void 0,
      ...toolResults.length > 1 ? {
        toolCallIds: toolResults.map(
          (toolResult) => toolResult.tool_use_id
        )
      } : {},
      wireUtf8Bytes: Buffer.byteLength(frame, "utf8"),
      mutated: projection.mutated,
      artifacts: [projection.artifact],
      values
    });
    projectedHeadlessMessages.delete(message);
  } catch {
  }
}
__name(observeHeadlessToolResultWire, "observeHeadlessToolResultWire");
function observeHeadlessJsonToolResultWire(messages, frame) {
  try {
    const observedMessages = messages.filter(
      (message) => projectedHeadlessMessages.has(message)
    );
    if (observedMessages.length === 0) return;
    const toolResults = observedMessages.flatMap(headlessToolResults);
    const values = toolResults.flatMap(toolResultValues);
    observeToolResultBoundary({
      stage: "headless_wire",
      sessionId: new Set(observedMessages.map((message) => message.session_id)).size === 1 ? observedMessages[0].session_id : void 0,
      toolCallId: toolResults.length === 1 ? toolResults[0].tool_use_id : void 0,
      ...toolResults.length > 1 ? {
        toolCallIds: toolResults.map(
          (toolResult) => toolResult.tool_use_id
        )
      } : {},
      wireUtf8Bytes: Buffer.byteLength(frame, "utf8"),
      mutated: observedMessages.some(
        (message) => projectedHeadlessMessages.get(message)?.mutated === true
      ),
      artifacts: observedMessages.map(
        (message) => projectedHeadlessMessages.get(message).artifact
      ),
      values
    });
    for (const message of observedMessages) {
      projectedHeadlessMessages.delete(message);
    }
  } catch {
  }
}
__name(observeHeadlessJsonToolResultWire, "observeHeadlessJsonToolResultWire");
function acpToolResultValues(update) {
  const record = update;
  if (record["sessionUpdate"] !== "tool_call_update") return [];
  const values = [];
  const content3 = record["content"];
  if (Array.isArray(content3)) {
    for (const block of content3) {
      const text5 = asRecord(asRecord(block)?.["content"])?.["text"];
      if (typeof text5 === "string") {
        values.push({ representation: "acp_content", value: text5 });
      }
    }
  }
  if (typeof record["rawOutput"] === "string") {
    values.push({
      representation: "acp_raw_output",
      value: record["rawOutput"]
    });
  }
  return values;
}
__name(acpToolResultValues, "acpToolResultValues");
function toolCallId(value) {
  const id = asRecord(value)?.["toolCallId"];
  return typeof id === "string" ? id : void 0;
}
__name(toolCallId, "toolCallId");
function acpWireUpdates(message) {
  if (message["method"] === "session/update") {
    const update = asRecord(asRecord(message["params"])?.["update"]);
    return update ? [update] : [];
  }
  const result = asRecord(message["result"]);
  const replay = asRecord(asRecord(result?.["_meta"])?.[LOAD_REPLAY_META_KEY]);
  const candidates = replay?.["updates"] ?? result?.["updates"];
  if (Array.isArray(candidates)) return candidates.filter(isObject);
  const events = result?.["events"];
  return Array.isArray(events) ? events.flatMap((event) => {
    const update = asRecord(event)?.["data"];
    return isObject(update) ? [update] : [];
  }) : [];
}
__name(acpWireUpdates, "acpWireUpdates");
function headlessToolResults(message) {
  if (message.type !== "user" || !Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content.flatMap(
    (block) => block.type === "tool_result" ? [block] : []
  );
}
__name(headlessToolResults, "headlessToolResults");
function toolResultValues(toolResult) {
  return typeof toolResult.content === "string" ? [{ representation: "headless_content", value: toolResult.content }] : [];
}
__name(toolResultValues, "toolResultValues");
function asRecord(value) {
  return isObject(value) ? value : void 0;
}
__name(asRecord, "asRecord");
function isObject(value) {
  return typeof value === "object" && value !== null;
}
__name(isObject, "isObject");

// packages/cli/src/acp-integration/session/history-replayer.ts
init_esbuild_shims();

// packages/acp-bridge/src/transcript-replay.ts
init_esbuild_shims();

// packages/core/src/goals/goal-wire.ts
init_esbuild_shims();

// packages/acp-bridge/src/transcript-replay.ts
var MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE = "Tool result missing from saved history; the previous run likely ended before this tool completed.";
var MAX_RESULT_PREVIEW_TEXT_LENGTH = 1e5;
var TRANSCRIPT_GOAL_STATUS_KINDS = /* @__PURE__ */ new Set([
  "set",
  "achieved",
  "cleared",
  "failed",
  "aborted",
  // A paused goal is not running, and dropping the card here is not neutral:
  // the replay stream is what feeds the goal renderer, so the older `set` card
  // stays newest and every surface keeps claiming autonomous work is under way.
  // Kept in step with `GOAL_STATUS_KINDS`, which the daemon-side reader
  // (`parseGoalStatusItem`) validates the same on-disk cards against.
  "paused",
  "checking"
]);
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isObjectRecord, "isObjectRecord");
function replaceTextPartsForDisplay(parts, displayText) {
  const projected = [];
  let replacedText = false;
  for (const part of parts ?? []) {
    if (isObjectRecord(part) && typeof part["text"] === "string") {
      if (!replacedText && displayText.length > 0) {
        projected.push({ text: displayText });
      }
      replacedText = true;
    } else {
      projected.push(part);
    }
  }
  if (!replacedText && displayText.length > 0) {
    projected.push({ text: displayText });
  }
  return projected;
}
__name(replaceTextPartsForDisplay, "replaceTextPartsForDisplay");
function toTranscriptEpochMs(timestamp) {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : void 0;
  }
  if (typeof timestamp !== "string") return void 0;
  const epochMs = new Date(timestamp).getTime();
  return Number.isFinite(epochMs) ? epochMs : void 0;
}
__name(toTranscriptEpochMs, "toTranscriptEpochMs");
function buildUpdateMeta(options) {
  const timestamp = toTranscriptEpochMs(options.timestamp);
  const sourceRecordIds = dedupeStrings(options.sourceRecordIds ?? []);
  const qwenTranscript = {
    ...sourceRecordIds.length > 0 ? { sourceRecordIds } : {},
    ...options.planToolCallId ? { planToolCallId: options.planToolCallId } : {},
    ...options.resultPreviewText ? { resultPreviewText: options.resultPreviewText } : {}
  };
  const meta = {
    ...options.extra ?? {},
    ...timestamp !== void 0 ? { timestamp } : {},
    ...Object.keys(qwenTranscript).length > 0 ? { qwenTranscript } : {}
  };
  return Object.keys(meta).length > 0 ? meta : void 0;
}
__name(buildUpdateMeta, "buildUpdateMeta");
function createTranscriptMessageUpdate(options) {
  const meta = buildUpdateMeta(options);
  return {
    sessionUpdate: options.role === "user" ? "user_message_chunk" : options.thought ? "agent_thought_chunk" : "agent_message_chunk",
    content: { type: "text", text: options.text },
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptMessageUpdate, "createTranscriptMessageUpdate");
function createTranscriptImageUpdate(options) {
  const meta = buildUpdateMeta(options);
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "image", data: options.data, mimeType: options.mimeType },
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptImageUpdate, "createTranscriptImageUpdate");
function createTranscriptAttachmentReferenceUpdate(reference, options) {
  if (reference["type"] !== "image" && reference["type"] !== "resource" || typeof reference["attachmentId"] !== "string" || typeof reference["mimeType"] !== "string" || typeof reference["size"] !== "number") {
    return void 0;
  }
  const meta = buildUpdateMeta(options);
  return {
    sessionUpdate: "user_message_chunk",
    content: {
      type: reference["type"],
      attachmentId: reference["attachmentId"],
      mimeType: reference["mimeType"],
      size: reference["size"]
    },
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptAttachmentReferenceUpdate, "createTranscriptAttachmentReferenceUpdate");
function createTranscriptUsageUpdate(usageMetadata, options = {}) {
  const usage = {
    inputTokens: finiteNumber(usageMetadata.promptTokenCount) ?? 0,
    outputTokens: finiteNumber(usageMetadata.candidatesTokenCount) ?? 0,
    totalTokens: finiteNumber(usageMetadata.totalTokenCount) ?? 0,
    ...finiteNumber(usageMetadata.thoughtsTokenCount) !== void 0 ? { thoughtTokens: finiteNumber(usageMetadata.thoughtsTokenCount) } : {},
    ...finiteNumber(usageMetadata.cachedContentTokenCount) !== void 0 ? {
      cachedReadTokens: finiteNumber(usageMetadata.cachedContentTokenCount)
    } : {}
  };
  const meta = buildUpdateMeta({
    ...options,
    extra: { usage, ...options.extra ?? {} }
  });
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: options.text ?? "" },
    _meta: meta
  };
}
__name(createTranscriptUsageUpdate, "createTranscriptUsageUpdate");
function createTranscriptToolCallStartUpdate(options) {
  const provenance = resolveToolProvenance(options.toolName);
  return {
    sessionUpdate: options.asUpdate ? "tool_call_update" : "tool_call",
    toolCallId: options.callId,
    status: options.status ?? "pending",
    title: options.metadata.title,
    content: [],
    locations: [...options.metadata.locations],
    kind: options.metadata.kind,
    rawInput: options.args ?? {},
    _meta: buildUpdateMeta({
      ...options,
      extra: {
        toolName: options.toolName,
        provenance: provenance.provenance,
        ...provenance.serverId ? { serverId: provenance.serverId } : {},
        ...options.extra ?? {}
      }
    })
  };
}
__name(createTranscriptToolCallStartUpdate, "createTranscriptToolCallStartUpdate");
function createTranscriptToolCallResultUpdate(options) {
  const provenance = resolveToolProvenance(options.toolName);
  const content3 = buildToolResultContent(options);
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: options.callId,
    status: options.success ? "completed" : "failed",
    content: content3,
    _meta: buildUpdateMeta({
      ...options,
      resultPreviewText: getToolContentText(options.contentPrefix),
      extra: {
        toolName: options.toolName,
        provenance: provenance.provenance,
        ...provenance.serverId ? { serverId: provenance.serverId } : {},
        ...options.artifacts && options.artifacts.length > 0 ? { artifacts: options.artifacts } : {},
        ...options.extra ?? {}
      }
    })
  };
  const rawOutput = getReplayRawOutput(options.resultDisplay);
  if (rawOutput !== void 0) update["rawOutput"] = rawOutput;
  return update;
}
__name(createTranscriptToolCallResultUpdate, "createTranscriptToolCallResultUpdate");
function getToolContentText(content3) {
  let text5 = "";
  for (const entry of content3 ?? []) {
    if (entry.type !== "content" || entry.content.type !== "text") continue;
    const next = entry.content.text;
    if (text5.length + (text5 ? 1 : 0) + next.length > MAX_RESULT_PREVIEW_TEXT_LENGTH) {
      return void 0;
    }
    text5 += `${text5 ? "\n" : ""}${next}`;
  }
  return text5 || void 0;
}
__name(getToolContentText, "getToolContentText");
function getReplayRawOutput(resultDisplay) {
  if (!isTruncatedSessionDiffDisplay(resultDisplay)) return resultDisplay;
  if (resultDisplay["fileDiffTruncated"] === true || typeof resultDisplay["fileDiff"] !== "string") {
    return void 0;
  }
  return {
    fileName: resultDisplay["fileName"],
    fileDiff: resultDisplay["fileDiff"]
  };
}
__name(getReplayRawOutput, "getReplayRawOutput");
function createTranscriptPlanUpdate(todos, cumulativeUsage, options = {}) {
  const meta = buildUpdateMeta({
    ...options,
    extra: {
      ...cumulativeUsage ? { stats: { ...cumulativeUsage } } : {},
      ...options.todoPlanId ? { qwenTodoPlan: { id: options.todoPlanId } } : {},
      ...options.extra ?? {}
    }
  });
  return {
    sessionUpdate: "plan",
    entries: todos.map((todo) => ({
      content: todo.content,
      priority: "medium",
      status: todo.status,
      ...todo.id || todo.blockedBy ? {
        _meta: {
          qwenTodo: {
            ...todo.id ? { id: todo.id } : {},
            ...todo.blockedBy ? { blockedBy: [...todo.blockedBy] } : {}
          }
        }
      } : {}
    })),
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptPlanUpdate, "createTranscriptPlanUpdate");
function extractTranscriptTodoPlan(resultDisplay, args) {
  const fromDisplay = extractTodoPlanFromDisplay(resultDisplay);
  if (fromDisplay) return fromDisplay;
  if (resultDisplay !== null && resultDisplay !== void 0) return null;
  return args && Array.isArray(args["todos"]) ? { todos: normalizeTodos(args["todos"]) } : null;
}
__name(extractTranscriptTodoPlan, "extractTranscriptTodoPlan");
function createTranscriptReplayMachine(options = {}) {
  return new DefaultTranscriptReplayMachine(options);
}
__name(createTranscriptReplayMachine, "createTranscriptReplayMachine");
var DefaultTranscriptReplayMachine = class {
  constructor(options) {
    this.options = options;
    const initialState = parseInitialState(
      options.initialState,
      options.onDiagnostic
    );
    this.usage = { ...initialState.cumulativeUsage };
    this.goalState = initialState.goalState;
    this.goalCause = initialState.goalCause;
    for (const pending of initialState.pendingToolCalls) {
      this.pendingToolCalls.set(pending.callId, pending);
      this.usedToolCallIds.add(pending.callId);
    }
    for (const gap of options.gaps ?? []) {
      if (!this.gapByChild.has(gap.childUuid)) {
        this.gapByChild.set(gap.childUuid, gap);
      }
    }
  }
  static {
    __name(this, "DefaultTranscriptReplayMachine");
  }
  pendingToolCalls = /* @__PURE__ */ new Map();
  usedToolCallIds = /* @__PURE__ */ new Set();
  gapByChild = /* @__PURE__ */ new Map();
  usage;
  finalized = false;
  goalState;
  goalCause;
  *project(record) {
    if (this.finalized) {
      throw new Error(
        "Cannot project records after transcript replay finalize."
      );
    }
    let ordinal = 0;
    let activeSegmentLane;
    let activeSegmentId;
    const backgroundTurn = parseBackgroundNotificationTurn(
      record.subtype === "background_task_completed" ? void 0 : record["backgroundTurn"]
    );
    const emit = /* @__PURE__ */ __name((update) => {
      if (backgroundTurn)
        update = { ...update, _meta: { ...update._meta, backgroundTurn } };
      const emissionOrdinal = ordinal++;
      const lane = transcriptSegmentLane(update);
      if (lane && (lane !== activeSegmentLane || !activeSegmentId)) {
        activeSegmentLane = lane;
        activeSegmentId = `${record.uuid}:${emissionOrdinal}`;
      } else if (!lane && isTranscriptSegmentBoundary(update)) {
        activeSegmentLane = void 0;
        activeSegmentId = void 0;
      }
      const projectedUpdate = lane && activeSegmentId ? withTranscriptSegmentId(update, activeSegmentId) : update;
      if (isTranscriptDiscreteMessage(update)) {
        activeSegmentLane = void 0;
        activeSegmentId = void 0;
      }
      return {
        sourceRecordId: record.uuid,
        ...record.timestamp ? { sourceTimestamp: record.timestamp } : {},
        emissionOrdinal,
        update: projectedUpdate
      };
    }, "emit");
    const meta = {
      timestamp: record.timestamp,
      sourceRecordIds: [record.uuid],
      ...record.subtype === "realtime_message" ? {
        extra: {
          source: "realtime_voice",
          qwenDiscreteMessage: true
        }
      } : {}
    };
    const gap = this.gapByChild.get(record.uuid);
    if (gap) {
      yield emit(
        createTranscriptMessageUpdate({
          role: "assistant",
          text: this.formatGap(gap),
          ...meta,
          extra: { qwenDiscreteMessage: true }
        })
      );
    }
    switch (record.type) {
      case "user":
        yield* this.projectUserRecord(record, emit, meta);
        break;
      case "assistant":
        yield* this.projectAssistantRecord(record, emit, meta);
        break;
      case "tool_result":
        yield* this.projectToolResult(record, emit, meta);
        break;
      case "system":
        yield* this.projectSystemRecord(record, emit, meta);
        break;
      default:
        this.report(
          "unknown_record_or_part",
          "Skipped an unknown transcript record type.",
          record.uuid
        );
    }
  }
  *finalize() {
    if (this.finalized) return;
    this.finalized = true;
    const skip = this.options.skipFinalizeCallIds;
    let ordinal = 0;
    for (const pending of [...this.pendingToolCalls.values()]) {
      if (skip && (skip.has(pending.callId) || pending.rawCallId !== void 0 && skip.has(pending.rawCallId)))
        continue;
      this.pendingToolCalls.delete(pending.callId);
      this.report(
        "missing_tool_result",
        "A transcript tool call has no persisted result.",
        pending.sourceRecordId
      );
      yield {
        sourceRecordId: pending.sourceRecordId,
        ...pending.sourceTimestamp ? { sourceTimestamp: pending.sourceTimestamp } : {},
        emissionOrdinal: ordinal++,
        update: createTranscriptToolCallResultUpdate({
          toolName: pending.toolName,
          callId: pending.callId,
          success: false,
          errorMessage: MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
          timestamp: pending.sourceTimestamp,
          sourceRecordIds: [pending.sourceRecordId]
        })
      };
    }
  }
  snapshot() {
    return {
      v: 1,
      pendingToolCalls: [...this.pendingToolCalls.values()].map((pending) => ({
        ...pending
      })),
      cumulativeUsage: { ...this.usage },
      ...this.goalState ? { goalState: this.goalState } : {},
      ...this.goalCause ? { goalCause: this.goalCause } : {}
    };
  }
  *projectUserRecord(record, emit, meta) {
    const userMeta = typeof record.daemonPromptId === "string" && record.daemonPromptId.trim().length > 0 ? { ...meta, extra: { ...meta.extra, promptId: record.daemonPromptId } } : meta;
    const payload = isObjectRecord(record.systemPayload) ? record.systemPayload : void 0;
    const replayMeta = record.subtype === "mid_turn_user_message" ? {
      ...userMeta,
      extra: {
        ...userMeta.extra,
        source: "mid_turn_message_injected",
        qwenDiscreteMessage: true
      }
    } : userMeta;
    if (record.subtype === "goal_runtime" || record.subtype === "notification" || record.subtype === "cron" || record.subtype === "mid_turn_user_message") {
      const displayText = payload && typeof payload["displayText"] === "string" ? stripGeneratedAttachmentTokens(payload["displayText"], payload) : void 0;
      if (record.subtype === "mid_turn_user_message" && displayText === "") {
        const media = [
          ...this.projectUserAttachmentReferences(payload, emit, replayMeta)
        ];
        if (media.length > 0) {
          yield* media;
          return;
        }
      }
      if (displayText) {
        const isNotification = record.subtype === "notification";
        const backgroundTask = payload && isObjectRecord(payload["backgroundTask"]) ? payload["backgroundTask"] : void 0;
        yield emit(
          createTranscriptMessageUpdate({
            role: "user",
            text: displayText,
            ...replayMeta,
            ...isNotification ? {
              extra: {
                source: "background_notification",
                qwenDiscreteMessage: true,
                ...backgroundTask ? { backgroundTask } : {}
              }
            } : record.subtype === "cron" ? { extra: { source: "cron" } } : {}
          })
        );
        yield* this.projectUserAttachmentReferences(payload, emit, replayMeta);
        return;
      }
      if (record.subtype !== "mid_turn_user_message") return;
    }
    const projection = projectUserTranscriptForDisplay(record);
    if (projection.displayText !== void 0) {
      const displayText = stripGeneratedAttachmentTokens(
        projection.displayText,
        payload
      );
      yield* this.projectMessageParts(
        record,
        "user",
        emit,
        replayMeta,
        void 0,
        replaceTextPartsForDisplay(record.message?.parts, displayText)
      );
      yield* this.projectUserAttachmentReferences(payload, emit, replayMeta);
      return;
    }
    yield* this.projectMessageParts(
      record,
      "user",
      emit,
      replayMeta,
      void 0,
      projection.parts
    );
    yield* this.projectUserAttachmentReferences(payload, emit, replayMeta);
  }
  *projectUserAttachmentReferences(payload, emit, meta) {
    const references = payload?.["attachmentReferences"];
    for (const reference of Array.isArray(references) ? references : []) {
      if (!isObjectRecord(reference)) continue;
      const update = createTranscriptAttachmentReferenceUpdate(reference, meta);
      if (update) yield emit(update);
    }
    const resourceLinks = payload?.["resourceLinks"];
    for (const link2 of Array.isArray(resourceLinks) ? resourceLinks : []) {
      if (!isObjectRecord(link2) || link2["type"] !== "resource_link" || typeof link2["uri"] !== "string" || link2["uri"].length === 0 || typeof link2["name"] !== "string") {
        continue;
      }
      const updateMeta = buildUpdateMeta(meta);
      yield emit({
        sessionUpdate: "user_message_chunk",
        content: structuredClone(link2),
        ...updateMeta ? { _meta: updateMeta } : {}
      });
    }
  }
  *projectAssistantRecord(record, emit, meta) {
    const usageMetadata = isObjectRecord(record.usageMetadata) ? record.usageMetadata : void 0;
    let usageEmitted = false;
    const takeUsageUpdate = /* @__PURE__ */ __name(() => {
      if (!usageMetadata || usageEmitted) return void 0;
      usageEmitted = true;
      this.addUsage(usageMetadata);
      return createTranscriptUsageUpdate(usageMetadata, meta);
    }, "takeUsageUpdate");
    yield* this.projectMessageParts(
      record,
      "assistant",
      emit,
      meta,
      takeUsageUpdate
    );
    const trailingUsage = takeUsageUpdate();
    if (trailingUsage) yield emit(trailingUsage);
  }
  *projectMessageParts(record, role, emit, meta, beforeToolCall, partsOverride) {
    const parts = partsOverride ?? record.message?.parts;
    if (!parts) return;
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if (!isObjectRecord(part)) {
        this.report(
          "malformed_part",
          "Skipped a malformed transcript message part.",
          record.uuid,
          `message.parts[${partIndex}]`
        );
        continue;
      }
      let recognized = false;
      if (typeof part["text"] === "string" && part["text"].length > 0) {
        recognized = true;
        yield emit(
          createTranscriptMessageUpdate({
            role,
            text: part["text"],
            thought: role === "assistant" && part["thought"] === true,
            ...meta
          })
        );
      }
      const inlineData = isObjectRecord(part["inlineData"]) ? part["inlineData"] : void 0;
      if (inlineData) {
        recognized = true;
        const data = inlineData["data"];
        const mimeType = inlineData["mimeType"];
        if (role === "user" && typeof data === "string" && typeof mimeType === "string" && mimeType.startsWith("image/")) {
          yield emit(createTranscriptImageUpdate({ data, mimeType, ...meta }));
        } else {
          this.report(
            "malformed_part",
            "Skipped an unsupported or malformed inline transcript part.",
            record.uuid,
            `message.parts[${partIndex}].inlineData`
          );
        }
      }
      const functionCall = isObjectRecord(part["functionCall"]) ? part["functionCall"] : void 0;
      if (functionCall) {
        recognized = true;
        const toolName = typeof functionCall["name"] === "string" ? functionCall["name"] : "";
        const args = isObjectRecord(functionCall["args"]) ? functionCall["args"] : {};
        if (!toolName) {
          this.report(
            "malformed_part",
            "Skipped a tool call without a tool name.",
            record.uuid,
            `message.parts[${partIndex}].functionCall`
          );
          continue;
        }
        const preToolUpdate = beforeToolCall?.();
        if (preToolUpdate) yield emit(preToolUpdate);
        if (toolName === "todo_write") continue;
        const explicitId = typeof functionCall["id"] === "string" && functionCall["id"].length > 0 ? functionCall["id"] : void 0;
        const callId = this.allocateToolCallId(
          explicitId ?? `qwen-replay-tool:${record.uuid}:${partIndex}`
        );
        const update = createTranscriptToolCallStartUpdate({
          toolName,
          callId,
          args,
          status: "in_progress",
          metadata: this.resolveToolMetadata(toolName, args, record.uuid),
          ...meta
        });
        yield emit(update);
        if (role === "assistant") {
          this.pendingToolCalls.set(callId, {
            callId,
            toolName,
            sourceRecordId: record.uuid,
            ...record.timestamp ? { sourceTimestamp: record.timestamp } : {},
            ...explicitId !== void 0 && explicitId !== callId ? { rawCallId: explicitId } : {}
          });
        }
      }
      if (!recognized && !("functionResponse" in part)) {
        this.report(
          "unknown_record_or_part",
          "Skipped an unknown transcript message part.",
          record.uuid,
          `message.parts[${partIndex}]`
        );
      }
    }
  }
  *projectToolResult(record, emit, meta) {
    const result = isObjectRecord(record.toolCallResult) ? record.toolCallResult : void 0;
    const toolName = extractToolName(record);
    if (!toolName) {
      this.report(
        "malformed_part",
        "A transcript tool result has no tool name.",
        record.uuid,
        "message.parts"
      );
    }
    const explicitCallId = extractToolResultCallId(record, result);
    const callId = explicitCallId ? this.allocateToolCallId(explicitCallId, true) : this.correlateResultCallId(toolName, record.uuid);
    this.pendingToolCalls.delete(callId);
    const resultDisplay = result?.["resultDisplay"];
    if (toolName === "todo_write") {
      const plan = extractTranscriptTodoPlan(resultDisplay);
      if (plan) {
        yield emit(
          createTranscriptPlanUpdate(plan.todos, this.usage, {
            ...meta,
            planToolCallId: callId,
            todoPlanId: plan.planId,
            ...plan.sessionWorkflow ? {
              extra: {
                ...meta.extra,
                qwenSessionWorkflow: true
              }
            } : {}
          })
        );
      }
      return;
    }
    yield emit(
      createTranscriptToolCallResultUpdate({
        toolName,
        callId,
        success: result?.["status"] === void 0 ? !result?.["error"] : result["status"] === "success" && !result["error"],
        errorMessage: extractErrorMessage(result?.["error"]),
        message: record.message?.parts,
        resultDisplay,
        artifacts: Array.isArray(result?.["artifacts"]) ? result["artifacts"] : void 0,
        contentPrefix: this.buildToolResultContentPrefix(
          resultDisplay,
          record.uuid
        ),
        ...meta
      })
    );
    if (isTaskExecutionDisplay(resultDisplay)) {
      const usage = usageFromTaskExecution(resultDisplay);
      if (Object.keys(usage).length > 0) {
        this.addUsage(usage);
        yield emit(
          createTranscriptUsageUpdate(usage, {
            ...meta,
            extra: { ...meta.extra, parentToolCallId: callId }
          })
        );
      }
    }
  }
  *projectSystemRecord(record, emit, meta) {
    if (record.subtype === "turn_result") {
      const payload2 = isObjectRecord(record.systemPayload) ? record.systemPayload : void 0;
      const cancelledAt = finiteNumber(payload2?.["cancelledAt"]);
      const startedAt = finiteNumber(payload2?.["startedAt"]);
      const promptId = payload2?.["promptId"];
      if (payload2?.["state"] !== "cancelled" || cancelledAt === void 0 || typeof promptId !== "string" || !promptId || payload2["startedAt"] !== void 0 && startedAt === void 0)
        return;
      const elapsedMs = Math.max(0, cancelledAt - (startedAt ?? cancelledAt));
      if (!Number.isFinite(elapsedMs)) return;
      yield emit(
        createTranscriptMessageUpdate({
          role: "assistant",
          text: "",
          ...meta,
          extra: {
            qwenDiscreteMessage: true,
            promptCancelled: { promptId, cancelledAt, elapsedMs }
          }
        })
      );
      return;
    }
    if (record.subtype === "background_task_completed") {
      const payload2 = isObjectRecord(record.systemPayload) ? record.systemPayload : void 0;
      if (!payload2 || typeof payload2["displayText"] !== "string") return;
      yield emit(
        createTranscriptMessageUpdate({
          role: "assistant",
          text: payload2["displayText"],
          ...meta,
          extra: {
            source: "background_task_completed",
            qwenDiscreteMessage: true,
            ...isObjectRecord(payload2["backgroundTask"]) ? { backgroundTask: payload2["backgroundTask"] } : {}
          }
        })
      );
      return;
    }
    if (record.subtype === "agent_session_ready") {
      const payload2 = isObjectRecord(record.systemPayload) ? record.systemPayload : void 0;
      if (typeof payload2?.["callId"] !== "string" || payload2["callId"].length === 0 || typeof payload2["subagentSessionReady"] !== "boolean") {
        this.report(
          "malformed_agent_session_ready",
          "Skipped a malformed subagent session readiness record.",
          record.uuid,
          "systemPayload"
        );
        return;
      }
      const callId = payload2["callId"];
      if (!this.pendingToolCalls.has(callId)) {
        this.report(
          "orphan_agent_session_ready",
          "Skipped subagent readiness without a matching pending tool call.",
          record.uuid,
          "systemPayload.callId"
        );
        return;
      }
      yield emit({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        _meta: buildUpdateMeta({
          ...meta,
          extra: {
            subagentSessionReady: payload2["subagentSessionReady"]
          }
        })
      });
      return;
    }
    if (record.subtype === "goal_state") {
      const payload2 = parseGoalStateRecordPayloadV2(record.systemPayload);
      if (!payload2) {
        this.report(
          "malformed_goal_state",
          "Skipped a malformed Goal state transcript record.",
          record.uuid,
          "systemPayload"
        );
        return;
      }
      const bookkeepingOnly = isGoalCheckpointBookkeepingRecord({
        cause: payload2.cause,
        previousCause: this.goalCause,
        previous: this.goalState,
        next: payload2.snapshot
      });
      const projection = projectGoalStateToLegacy(
        payload2,
        this.goalState?.goal ?? null
      );
      const goalControlCommand = projectGoalControlCommand(
        payload2.cause,
        payload2.snapshot
      );
      this.goalState = payload2.snapshot;
      this.goalCause = payload2.cause;
      if (bookkeepingOnly) return;
      if (goalControlCommand) {
        yield emit(
          createTranscriptMessageUpdate({
            role: "user",
            text: goalControlCommand,
            ...meta,
            extra: {
              source: "goal_control",
              "qwen.session.recordId": record.uuid
            }
          })
        );
      }
      const { type: _type, ...goalStatus } = projection.goalStatus;
      yield emit(
        createTranscriptMessageUpdate({
          role: "assistant",
          text: "",
          ...meta,
          extra: {
            goalState: payload2.snapshot,
            goalStatus,
            ...projection.goalTerminal ? { goalTerminal: projection.goalTerminal } : {},
            "qwen.session.recordId": record.uuid
          }
        })
      );
      return;
    }
    if (record.subtype !== "slash_command") return;
    const payload = isObjectRecord(record.systemPayload) ? record.systemPayload : void 0;
    if (payload?.["phase"] !== "result") return;
    const items = Array.isArray(payload["outputHistoryItems"]) ? payload["outputHistoryItems"] : [];
    for (const item of items) {
      const goalStatus = parseTranscriptGoalStatus(item);
      if (goalStatus) {
        if (goalStatus.condition.length === 0) {
          this.report(
            "malformed_part",
            "Skipped replay of a goal card whose condition is empty.",
            record.uuid,
            "systemPayload.outputHistoryItems.goalStatus.condition"
          );
        } else if (goalStatus.kind !== "checking") {
          yield emit(
            createTranscriptMessageUpdate({
              role: "assistant",
              text: "",
              ...meta,
              extra: { goalStatus }
            })
          );
        }
        continue;
      }
      if (!isObjectRecord(item) || typeof item["text"] !== "string") continue;
      yield emit(
        createTranscriptMessageUpdate({
          role: "assistant",
          text: item["text"].replace(/\n/g, "  \n"),
          ...meta,
          extra: { source: "slash_command" }
        })
      );
    }
  }
  addUsage(metadata) {
    this.usage.promptTokens += finiteNumber(metadata["promptTokenCount"]) ?? 0;
    this.usage.candidateTokens += finiteNumber(metadata["candidatesTokenCount"]) ?? 0;
    this.usage.cachedTokens += finiteNumber(metadata["cachedContentTokenCount"]) ?? 0;
  }
  correlateResultCallId(toolName, recordId) {
    const candidates = [...this.pendingToolCalls.values()].filter(
      (pending) => pending.toolName === toolName
    );
    if (candidates.length === 1) return candidates[0].callId;
    this.report(
      "ambiguous_tool_call_correlation",
      "A tool result could not be matched to exactly one pending tool call.",
      recordId
    );
    return this.allocateToolCallId(`qwen-replay-tool:${recordId}:result`);
  }
  allocateToolCallId(candidate, reuse = false) {
    if (reuse && this.pendingToolCalls.has(candidate)) {
      this.usedToolCallIds.add(candidate);
      return candidate;
    }
    if (!this.usedToolCallIds.has(candidate)) {
      this.usedToolCallIds.add(candidate);
      return candidate;
    }
    let occurrence = 2;
    while (this.usedToolCallIds.has(`${candidate}:${occurrence}`)) {
      occurrence += 1;
    }
    const id = `${candidate}:${occurrence}`;
    this.usedToolCallIds.add(id);
    return id;
  }
  resolveToolMetadata(toolName, args, recordId) {
    try {
      return this.options.presentation?.resolveToolMetadata(toolName, args) ?? fallbackToolMetadata(toolName, args);
    } catch {
      this.report(
        "presentation_fallback",
        "Tool presentation metadata fell back to deterministic defaults.",
        recordId,
        void 0,
        false
      );
      return fallbackToolMetadata(toolName, args);
    }
  }
  formatGap(gap) {
    try {
      return this.options.presentation?.formatHistoryGap(gap) ?? "Some earlier messages are unavailable because the saved history is incomplete.";
    } catch {
      this.report(
        "presentation_fallback",
        "History gap presentation fell back to deterministic defaults.",
        gap.childUuid,
        void 0,
        false
      );
      return "Some earlier messages are unavailable because the saved history is incomplete.";
    }
  }
  buildToolResultContentPrefix(resultDisplay, recordId) {
    try {
      return this.options.presentation?.buildToolResultContentPrefix?.(
        resultDisplay
      ) ?? defaultToolResultContentPrefix(resultDisplay);
    } catch {
      this.report(
        "presentation_fallback",
        "Tool result content presentation fell back to deterministic defaults.",
        recordId,
        void 0,
        false
      );
      return defaultToolResultContentPrefix(resultDisplay);
    }
  }
  report(code3, message, recordId, path3, affectsCompleteness = true) {
    this.options.onDiagnostic?.({
      code: code3,
      severity: affectsCompleteness ? "warning" : "info",
      message,
      affectsCompleteness,
      ...recordId ? { recordId } : {},
      ...path3 ? { path: path3 } : {}
    });
  }
};
function withTranscriptSegmentId(update, segmentId) {
  const record = update;
  const meta = isObjectRecord(record["_meta"]) ? record["_meta"] : void 0;
  const transcript = meta && isObjectRecord(meta["qwenTranscript"]) ? meta["qwenTranscript"] : void 0;
  return {
    ...record,
    _meta: {
      ...meta ?? {},
      qwenTranscript: {
        ...transcript ?? {},
        segmentId
      }
    }
  };
}
__name(withTranscriptSegmentId, "withTranscriptSegmentId");
function transcriptSegmentLane(update) {
  const record = update;
  const kind = record["sessionUpdate"];
  const meta = isObjectRecord(record["_meta"]) ? record["_meta"] : void 0;
  const parentToolCallId = typeof meta?.["parentToolCallId"] === "string" ? meta["parentToolCallId"] : "root";
  if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content3 = isObjectRecord(record["content"]) ? record["content"] : void 0;
    const contentType = typeof content3?.["type"] === "string" ? content3["type"] : void 0;
    if (!contentType) return void 0;
    if (contentType === "text" && (typeof content3?.["text"] !== "string" || content3["text"].length === 0)) {
      return void 0;
    }
    return `${String(kind)}:${contentType}:${parentToolCallId}`;
  }
  if (kind === "shell_output" || kind === "tool_output") {
    const source = typeof meta?.["source"] === "string" ? meta["source"] : "";
    const stream = typeof record["stream"] === "string" ? record["stream"] : "";
    return `${String(kind)}:${source}:${stream}`;
  }
  return void 0;
}
__name(transcriptSegmentLane, "transcriptSegmentLane");
function isTranscriptSegmentBoundary(update) {
  const record = update;
  const kind = record["sessionUpdate"];
  return typeof kind === "string" && kind !== "agent_message_chunk" && kind !== "agent_thought_chunk" && kind !== "user_message_chunk";
}
__name(isTranscriptSegmentBoundary, "isTranscriptSegmentBoundary");
function isTranscriptDiscreteMessage(update) {
  const record = update;
  const meta = isObjectRecord(record["_meta"]) ? record["_meta"] : void 0;
  return meta?.["qwenDiscreteMessage"] === true;
}
__name(isTranscriptDiscreteMessage, "isTranscriptDiscreteMessage");
function projectGoalControlCommand(cause, snapshot) {
  switch (cause) {
    case "create":
    case "replace":
      return snapshot.goal ? `/goal ${snapshot.goal.objective}` : void 0;
    case "edit":
      return snapshot.goal ? `/goal edit ${snapshot.goal.objective}` : void 0;
    case "pause":
      return snapshot.goal?.lastReason === void 0 || snapshot.goal.lastReason === GOAL_PAUSE_REASON_COMMAND ? `/goal ${cause}` : void 0;
    case "resume":
    case "clear":
      return `/goal ${cause}`;
    case "turn_finished":
    case "checkpoint":
    case "verifier_accept":
    case "verifier_reject":
    case "complete":
    case "blocked":
    case "usage_limited":
    case "migrated":
      return void 0;
    default:
      return assertNever(cause);
  }
}
__name(projectGoalControlCommand, "projectGoalControlCommand");
function assertNever(value) {
  throw new Error(`Unsupported Goal state cause: ${String(value)}`);
}
__name(assertNever, "assertNever");
function parseTranscriptGoalStatus(value) {
  if (!isObjectRecord(value) || value["type"] !== "goal_status") {
    return void 0;
  }
  const kind = value["kind"];
  const condition = value["condition"];
  if (typeof kind !== "string" || !TRANSCRIPT_GOAL_STATUS_KINDS.has(kind) || typeof condition !== "string") {
    return void 0;
  }
  const iterations = finiteNumber(value["iterations"]);
  const setAt = finiteNumber(value["setAt"]);
  const durationMs = finiteNumber(value["durationMs"]);
  const lastReason = typeof value["lastReason"] === "string" ? value["lastReason"] : void 0;
  return {
    kind,
    condition,
    ...iterations !== void 0 ? { iterations } : {},
    ...setAt !== void 0 ? { setAt } : {},
    ...durationMs !== void 0 ? { durationMs } : {},
    ...lastReason !== void 0 ? { lastReason } : {}
  };
}
__name(parseTranscriptGoalStatus, "parseTranscriptGoalStatus");
function defaultToolResultContentPrefix(resultDisplay) {
  if (!isObjectRecord(resultDisplay) || resultDisplay["type"] !== "vision_bridge_notice" || typeof resultDisplay["summary"] !== "string" || typeof resultDisplay["notice"] !== "string") {
    return [];
  }
  return [
    {
      type: "content",
      content: {
        type: "text",
        text: `${resultDisplay["summary"]}
${resultDisplay["notice"]}`
      }
    }
  ];
}
__name(defaultToolResultContentPrefix, "defaultToolResultContentPrefix");
function parseInitialState(value, onDiagnostic) {
  const empty2 = {
    v: 1,
    pendingToolCalls: [],
    cumulativeUsage: emptyUsage()
  };
  if (value === void 0) return empty2;
  if (!isObjectRecord(value)) {
    throw new TypeError("Invalid transcript replay state.");
  }
  if ("v" in value && value["v"] !== 1) {
    throw new TypeError("Unsupported transcript replay state version.");
  }
  const rawPending = Array.isArray(value["pendingToolCalls"]) ? value["pendingToolCalls"] : [];
  const pendingToolCalls = rawPending.flatMap(
    (pending) => {
      if (!isObjectRecord(pending) || typeof pending["callId"] !== "string" || typeof pending["toolName"] !== "string" || typeof pending["sourceRecordId"] !== "string") {
        onDiagnostic?.({
          code: "invalid_replay_state",
          severity: "warning",
          message: "Dropped a malformed pending tool call from replay state.",
          affectsCompleteness: true
        });
        return [];
      }
      return [
        {
          callId: pending["callId"],
          toolName: pending["toolName"],
          sourceRecordId: pending["sourceRecordId"],
          ...typeof pending["sourceTimestamp"] === "string" ? { sourceTimestamp: pending["sourceTimestamp"] } : {}
        }
      ];
    }
  );
  const rawUsage = value.cumulativeUsage;
  const usage = isObjectRecord(rawUsage) ? rawUsage : {};
  const validUsage = finiteNumber(usage["promptTokens"]) !== void 0 && finiteNumber(usage["cachedTokens"]) !== void 0 && finiteNumber(usage["candidateTokens"]) !== void 0 && finiteNumber(usage["apiTimeMs"]) !== void 0;
  if (!validUsage) {
    onDiagnostic?.({
      code: "invalid_replay_state",
      severity: "warning",
      message: "Reset invalid cumulative usage in transcript replay state.",
      affectsCompleteness: true
    });
  }
  const rawGoalState = value["goalState"];
  const goalState = rawGoalState === void 0 ? void 0 : parseGoalSnapshotV2(rawGoalState);
  if (rawGoalState !== void 0 && !goalState) {
    onDiagnostic?.({
      code: "invalid_replay_state",
      severity: "warning",
      message: "Dropped a malformed Goal state from replay state.",
      affectsCompleteness: true
    });
  }
  const rawGoalCause = value["goalCause"];
  const goalCause = rawGoalCause === void 0 ? void 0 : parseGoalStateCause(rawGoalCause);
  if (rawGoalCause !== void 0 && !goalCause) {
    onDiagnostic?.({
      code: "invalid_replay_state",
      severity: "warning",
      message: "Dropped a malformed Goal cause from replay state.",
      affectsCompleteness: true
    });
  }
  return {
    v: 1,
    pendingToolCalls,
    cumulativeUsage: validUsage ? {
      promptTokens: usage["promptTokens"],
      cachedTokens: usage["cachedTokens"],
      candidateTokens: usage["candidateTokens"],
      apiTimeMs: usage["apiTimeMs"]
    } : emptyUsage(),
    ...goalState ? { goalState } : {},
    ...goalCause ? { goalCause } : {}
  };
}
__name(parseInitialState, "parseInitialState");
function emptyUsage() {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    candidateTokens: 0,
    apiTimeMs: 0
  };
}
__name(emptyUsage, "emptyUsage");
function fallbackToolMetadata(toolName, args) {
  const description = typeof args["description"] === "string" ? args["description"].trim() : "";
  return {
    title: description ? `${toolName}: ${description}` : toolName,
    locations: [],
    kind: "other"
  };
}
__name(fallbackToolMetadata, "fallbackToolMetadata");
function resolveToolProvenance(toolName) {
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    if (parts.length >= 3 && parts[1]) {
      return { provenance: "mcp", serverId: parts[1] };
    }
  }
  return { provenance: "builtin" };
}
__name(resolveToolProvenance, "resolveToolProvenance");
function buildToolResultContent(options) {
  const prefix = [...options.contentPrefix ?? []];
  const diff = extractDiffContent(options.resultDisplay);
  if (diff) return [...prefix, diff];
  if (options.errorMessage) {
    return [
      ...prefix,
      {
        type: "content",
        content: { type: "text", text: options.errorMessage }
      }
    ];
  }
  const content3 = [...prefix];
  for (const part of options.message ?? []) {
    if (!isObjectRecord(part)) continue;
    if (typeof part["text"] === "string" && part["text"]) {
      content3.push({
        type: "content",
        content: { type: "text", text: part["text"] }
      });
    }
    const response = isObjectRecord(part["functionResponse"]) ? part["functionResponse"] : void 0;
    const payload = response && isObjectRecord(response["response"]) ? response["response"] : void 0;
    if (!payload) continue;
    try {
      const output = payload["output"];
      const error = payload["error"];
      const text5 = typeof output === "string" ? output : typeof error === "string" ? error : JSON.stringify(payload);
      content3.push({
        type: "content",
        content: { type: "text", text: text5 }
      });
    } catch {
    }
  }
  return content3;
}
__name(buildToolResultContent, "buildToolResultContent");
function extractDiffContent(resultDisplay) {
  if (!isObjectRecord(resultDisplay)) return null;
  if (!("fileName" in resultDisplay) || !("newContent" in resultDisplay)) {
    return null;
  }
  if (isTruncatedSessionDiffDisplay(resultDisplay)) {
    return {
      type: "content",
      content: {
        type: "text",
        text: buildTruncatedDiffPreviewText(resultDisplay)
      }
    };
  }
  return {
    type: "diff",
    path: typeof resultDisplay["filePath"] === "string" ? resultDisplay["filePath"] : typeof resultDisplay["fileName"] === "string" ? resultDisplay["fileName"] : "",
    oldText: typeof resultDisplay["originalContent"] === "string" ? resultDisplay["originalContent"] : "",
    newText: typeof resultDisplay["newContent"] === "string" ? resultDisplay["newContent"] : ""
  };
}
__name(extractDiffContent, "extractDiffContent");
function isTruncatedSessionDiffDisplay(value) {
  return isObjectRecord(value) && value["truncatedForSession"] === true && "fileName" in value && "newContent" in value;
}
__name(isTruncatedSessionDiffDisplay, "isTruncatedSessionDiffDisplay");
function buildTruncatedDiffPreviewText(display) {
  const fileName = typeof display["fileName"] === "string" ? display["fileName"] : "the edited file";
  const fileDiffLength = typeof display["fileDiffLength"] === "number" ? ` Original fileDiff length: ${display["fileDiffLength"]} chars.` : "";
  return display["fileDiffTruncated"] === true ? `Full diff omitted from saved session history for ${fileName}.${fileDiffLength}` : `Saved session preview only for ${fileName}; full original and new file contents are unavailable.`;
}
__name(buildTruncatedDiffPreviewText, "buildTruncatedDiffPreviewText");
function extractToolName(record) {
  for (const part of record.message?.parts ?? []) {
    if (!isObjectRecord(part) || !isObjectRecord(part["functionResponse"])) {
      continue;
    }
    const name = part["functionResponse"]["name"];
    if (typeof name === "string") return name;
  }
  return "";
}
__name(extractToolName, "extractToolName");
function extractToolResultCallId(record, result) {
  if (typeof result?.["callId"] === "string" && result["callId"].length > 0) {
    return result["callId"];
  }
  for (const part of record.message?.parts ?? []) {
    if (!isObjectRecord(part) || !isObjectRecord(part["functionResponse"])) {
      continue;
    }
    const id = part["functionResponse"]["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return void 0;
}
__name(extractToolResultCallId, "extractToolResultCallId");
function extractTodoPlanFromDisplay(value) {
  if (isObjectRecord(value) && value["type"] === "todo_list") {
    return Array.isArray(value["todos"]) ? {
      ...typeof value["planId"] === "string" ? { planId: value["planId"] } : {},
      ...value["sessionWorkflow"] === true ? { sessionWorkflow: true } : {},
      todos: normalizeTodos(value["todos"])
    } : null;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isObjectRecord(parsed) && parsed["type"] === "todo_list" && Array.isArray(parsed["todos"]) ? {
      ...typeof parsed["planId"] === "string" ? { planId: parsed["planId"] } : {},
      ...parsed["sessionWorkflow"] === true ? { sessionWorkflow: true } : {},
      todos: normalizeTodos(parsed["todos"])
    } : null;
  } catch {
    return null;
  }
}
__name(extractTodoPlanFromDisplay, "extractTodoPlanFromDisplay");
function normalizeTodos(values) {
  return values.flatMap((value) => {
    if (!isObjectRecord(value) || typeof value["content"] !== "string")
      return [];
    const status = value["status"];
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      return [];
    }
    return [
      {
        ...typeof value["id"] === "string" ? { id: value["id"] } : {},
        content: value["content"],
        status,
        ...Array.isArray(value["blockedBy"]) && value["blockedBy"].every((dependency) => typeof dependency === "string") ? { blockedBy: value["blockedBy"] } : {}
      }
    ];
  });
}
__name(normalizeTodos, "normalizeTodos");
function isTaskExecutionDisplay(value) {
  return isObjectRecord(value) && value["type"] === "task_execution";
}
__name(isTaskExecutionDisplay, "isTaskExecutionDisplay");
function usageFromTaskExecution(display) {
  const summary = isObjectRecord(display["executionSummary"]) ? display["executionSummary"] : void 0;
  if (!summary) return {};
  return {
    ...finiteNumber(summary["inputTokens"]) !== void 0 ? { promptTokenCount: summary["inputTokens"] } : {},
    ...finiteNumber(summary["outputTokens"]) !== void 0 ? { candidatesTokenCount: summary["outputTokens"] } : {},
    ...finiteNumber(summary["thoughtTokens"]) !== void 0 ? { thoughtsTokenCount: summary["thoughtTokens"] } : {},
    ...finiteNumber(summary["cachedTokens"]) !== void 0 ? { cachedContentTokenCount: summary["cachedTokens"] } : {},
    ...finiteNumber(summary["totalTokens"]) !== void 0 ? { totalTokenCount: summary["totalTokens"] } : {}
  };
}
__name(usageFromTaskExecution, "usageFromTaskExecution");
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
__name(finiteNumber, "finiteNumber");
function extractErrorMessage(value) {
  if (value instanceof Error) return value.message;
  if (!isObjectRecord(value)) return void 0;
  return typeof value["message"] === "string" ? value["message"] : void 0;
}
__name(extractErrorMessage, "extractErrorMessage");
function dedupeStrings(values) {
  return [...new Set(values.filter((value) => value.length > 0))];
}
__name(dedupeStrings, "dedupeStrings");

// packages/cli/src/acp-integration/session/emitters/tool-call-emitter.ts
init_esbuild_shims();

// packages/cli/src/acp-integration/session/emitters/base-emitter.ts
init_esbuild_shims();
var BaseEmitter = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  static {
    __name(this, "BaseEmitter");
  }
  /**
   * Converts an ISO timestamp string or epoch ms to epoch ms number.
   * Returns undefined if the input is not a valid timestamp.
   */
  static toEpochMs(ts) {
    if (typeof ts === "number") {
      return Number.isFinite(ts) ? ts : void 0;
    }
    if (typeof ts === "string") {
      const ms = new Date(ts).getTime();
      return Number.isFinite(ms) ? ms : void 0;
    }
    return void 0;
  }
  /**
   * Sends a session update to the ACP client.
   * If a message rewriter is configured, updates pass through it first
   * (original messages are sent as-is, rewritten versions are appended).
   */
  async sendUpdate(update) {
    if (this.ctx.messageRewriter) {
      return this.ctx.messageRewriter.interceptUpdate(update);
    }
    return this.ctx.sendUpdate(update);
  }
  /**
   * Gets the session ID.
   */
  get sessionId() {
    return this.ctx.sessionId;
  }
};

// packages/cli/src/acp-integration/session/emitters/PlanEmitter.ts
init_esbuild_shims();
var PlanEmitter = class extends BaseEmitter {
  static {
    __name(this, "PlanEmitter");
  }
  /**
   * Emits a plan update with the given todo items.
   *
   * @param plan - Plan identity and todo items to send as plan entries
   */
  async emitPlan(plan, sourceCallId) {
    const cumulative = this.ctx.cumulativeUsage;
    await this.sendUpdate(
      createTranscriptPlanUpdate(plan.todos, cumulative, {
        planToolCallId: sourceCallId,
        todoPlanId: plan.planId,
        ...plan.sessionWorkflow ? { extra: { qwenSessionWorkflow: true } } : {}
      })
    );
  }
  /**
   * Extracts todos from tool result display or args.
   * Tries multiple sources in priority order:
   * 1. Result display object with type 'todo_list'
   * 2. Result display as JSON string
   * 3. Args with 'todos' array when no result display is available
   *
   * @param resultDisplay - The tool result display (object, string, or undefined)
   * @param args - The tool call arguments (fallback source)
   * @returns Plan snapshot if found, null otherwise
   */
  extractPlan(resultDisplay, args) {
    const plan = extractTranscriptTodoPlan(resultDisplay, args);
    if (!plan) return null;
    return {
      ...plan.planId ? { planId: plan.planId } : {},
      ...plan.sessionWorkflow ? { sessionWorkflow: true } : {},
      todos: plan.todos.map((todo, index2) => ({
        id: todo.id ?? String(index2),
        content: todo.content,
        status: todo.status,
        ...todo.blockedBy ? { blockedBy: [...todo.blockedBy] } : {}
      }))
    };
  }
};

// packages/cli/src/acp-integration/session/types.ts
init_esbuild_shims();
function hasFullSessionContext(context) {
  return "config" in context;
}
__name(hasFullSessionContext, "hasFullSessionContext");

// packages/cli/src/acp-integration/session/emitters/tool-call-emitter.ts
var KIND_MAP = {
  ["read" /* Read */]: "read",
  ["edit" /* Edit */]: "edit",
  ["delete" /* Delete */]: "delete",
  ["move" /* Move */]: "move",
  ["search" /* Search */]: "search",
  ["execute" /* Execute */]: "execute",
  ["think" /* Think */]: "think",
  ["fetch" /* Fetch */]: "fetch",
  // ACP defines no 'agent' ToolKind (verified through @agentclientprotocol/sdk
  // 0.25.1). The daemon's ClientSideConnection Zod-validates every session/update
  // and session/request_permission from the `qwen --acp` child before fanning out
  // to SSE clients, so emitting 'agent' is rejected at that hop and the frame is
  // dropped. Map the internal Kind.Agent to 'other' on the wire to stay
  // protocol-valid; dedicated agent UI is delivered out-of-band (via _meta.toolName)
  // in a follow-up rather than via a kind the protocol can't carry.
  ["agent" /* Agent */]: "other",
  ["other" /* Other */]: "other"
};
function stripBoundaryArtifactsFromRawOutput(resultDisplay) {
  if (typeof resultDisplay !== "object" || resultDisplay === null || !("type" in resultDisplay) || resultDisplay.type !== "task_execution" || !("toolCalls" in resultDisplay) || !Array.isArray(resultDisplay.toolCalls)) {
    return resultDisplay;
  }
  let changed = false;
  const toolCalls = resultDisplay.toolCalls.map((toolCall) => {
    if (typeof toolCall !== "object" || toolCall === null || !("boundaryArtifact" in toolCall)) {
      return toolCall;
    }
    const rawOutputToolCall = { ...toolCall };
    delete rawOutputToolCall["boundaryArtifact"];
    changed = true;
    return rawOutputToolCall;
  });
  return changed ? { ...resultDisplay, toolCalls } : resultDisplay;
}
__name(stripBoundaryArtifactsFromRawOutput, "stripBoundaryArtifactsFromRawOutput");
var ToolCallEmitter = class _ToolCallEmitter extends BaseEmitter {
  static {
    __name(this, "ToolCallEmitter");
  }
  planEmitter;
  preparedCallIds = /* @__PURE__ */ new Set();
  constructor(ctx) {
    super(ctx);
    this.planEmitter = new PlanEmitter(ctx);
  }
  /**
   * Emits a tool call start event.
   *
   * @param params - Tool call start parameters
   * @returns true if event was emitted, false if skipped (e.g., TodoWriteTool)
   */
  async emitStart(params) {
    if (this.isTodoWriteTool(params.toolName)) {
      return false;
    }
    if (params.phase === "preparing" && this.preparedCallIds.has(params.callId)) {
      return false;
    }
    const { title, locations, kind } = this.resolveToolMetadata(
      params.toolName,
      params.args
    );
    const provenance = _ToolCallEmitter.resolveToolProvenance(
      params.toolName,
      params.subagentMeta
    );
    const updatesPreparedCall = params.phase !== "preparing" && this.preparedCallIds.delete(params.callId);
    await this.sendUpdate(
      createTranscriptToolCallStartUpdate({
        toolName: params.toolName,
        callId: params.callId,
        status: params.status || "pending",
        args: params.args,
        metadata: { title, locations, kind },
        timestamp: params.timestamp,
        asUpdate: updatesPreparedCall,
        extra: {
          ...params.phase ? { phase: params.phase } : {},
          ...params.toolName === ToolNames.AGENT && !params.subagentMeta ? { subagentSessionReady: false } : {},
          ...params.subagentMeta,
          provenance: provenance.provenance,
          ...provenance.serverId ? { serverId: provenance.serverId } : {}
        }
      })
    );
    if (params.phase === "preparing") {
      this.preparedCallIds.add(params.callId);
    }
    return true;
  }
  /**
   * Emits a terminal frame when a prepared tool call is discarded before
   * execution. TodoWrite remains represented exclusively by plan updates.
   *
   * @param callId - ID of the prepared tool call
   * @param toolName - Name of the prepared tool
   */
  async emitPreparationDiscarded(callId, toolName) {
    if (this.isTodoWriteTool(toolName)) return;
    this.preparedCallIds.delete(callId);
    const provenance = _ToolCallEmitter.resolveToolProvenance(toolName);
    await this.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: "failed",
      content: [],
      _meta: {
        toolName,
        phase: "preparing",
        preparationDiscarded: true,
        provenance: provenance.provenance,
        ...provenance.serverId ? { serverId: provenance.serverId } : {}
      }
    });
  }
  /**
   * Emits a tool call result event.
   * Handles TodoWriteTool specially by routing to plan updates.
   *
   * @param params - Tool call result parameters
   */
  async emitResult(params) {
    if (this.isTodoWriteTool(params.toolName)) {
      if (params.subagentMeta) return;
      if (!params.success) return;
      const plan = this.planEmitter.extractPlan(
        params.resultDisplay,
        params.args
      );
      if (plan && (plan.todos.length > 0 || params.args && Array.isArray(params.args["todos"]))) {
        await this.planEmitter.emitPlan(plan, params.callId);
      }
      return;
    }
    this.preparedCallIds.delete(params.callId);
    const provenance = _ToolCallEmitter.resolveToolProvenance(
      params.toolName,
      params.subagentMeta
    );
    const update = createTranscriptToolCallResultUpdate({
      toolName: params.toolName,
      callId: params.callId,
      success: params.success,
      message: params.message,
      resultDisplay: stripBoundaryArtifactsFromRawOutput(params.resultDisplay),
      errorMessage: params.error?.message,
      artifacts: params.artifacts,
      contentPrefix: buildToolResultContentPrefix(params.resultDisplay),
      timestamp: params.timestamp,
      extra: {
        ...params.subagentMeta,
        provenance: provenance.provenance,
        ...provenance.serverId ? { serverId: provenance.serverId } : {}
      }
    });
    associateAcpToolResultArtifact(
      update,
      params.boundaryArtifact ?? toolResultBoundaryArtifact(
        params.persistedOutputFiles,
        params.artifacts
      )
    );
    await this.sendUpdate(update);
  }
  /**
   * Emits a tool call error event.
   * Use this for explicit error handling when not using emitResult.
   *
   * @param callId - The tool call ID
   * @param toolName - The tool name
   * @param error - The error that occurred
   * @param subagentMeta - Optional subagent metadata
   */
  async emitError(callId, toolName, error, subagentMeta) {
    this.preparedCallIds.delete(callId);
    const provenance = _ToolCallEmitter.resolveToolProvenance(
      toolName,
      subagentMeta
    );
    await this.sendUpdate(
      createTranscriptToolCallResultUpdate({
        toolName,
        callId,
        success: false,
        errorMessage: error.message,
        extra: {
          ...subagentMeta,
          provenance: provenance.provenance,
          ...provenance.serverId ? { serverId: provenance.serverId } : {}
        }
      })
    );
  }
  /**
   * Emits a progress update for a parent tool call (e.g., subagent execution).
   * This allows standard ACP clients to show live progress inside the parent tool card,
   * bridging the gap for clients that do not support nested tool calls.
   *
   * @param parentToolCallId - The tool call ID of the parent (e.g., Agent tool)
   * @param subagentType - The type of subagent
   * @param message - Progress message to display
   */
  async emitProgressUpdate(parentToolCallId, subagentType, message, toolName) {
    if (toolName && this.isTodoWriteTool(toolName)) return;
    await this.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: parentToolCallId,
      status: "in_progress",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: sanitizeTerminalText(message)
          }
        }
      ],
      _meta: {
        subagentType,
        provenance: "subagent",
        subagentProgress: true
      }
    });
  }
  /**
   * Resolve a tool's provenance for UI dispatch on tool_call events.
   * The SDK reads `_meta.
   * provenance` + `_meta.serverId` to render builtin / MCP-server-badge /
   * subagent-block differently. Without this stamping, the SDK falls
   * back to string-matching the toolName which can't reliably
   * distinguish builtin from subagent.
   *
   * Resolution rules:
   *   - `subagentMeta` present → `'subagent'` (a Task tool / Codex
   *     subagent / etc. wrapping its own tool calls)
   *   - toolName matches `mcp__<server>__<tool>` → `'mcp'` with
   *     `serverId: <server>`. Naming convention from
   *     `packages/core/src/tools/mcp-tool.ts` in the
   *     `@qwen-code/qwen-code-core` package — mirrors the SDK's same
   *     heuristic fallback so SDK consumers stay consistent with
   *     daemon classification.
   *   - everything else → `'builtin'`
   *
   * Static + pure so it can be unit-tested without an emitter
   * instance. Exported via `ToolCallEmitter.resolveToolProvenance`.
   */
  static resolveToolProvenance(toolName, subagentMeta) {
    if (subagentMeta !== void 0) {
      return { provenance: "subagent" };
    }
    if (toolName.startsWith("mcp__")) {
      const parts = toolName.split("__");
      if (parts.length >= 3 && parts[1] && parts[1].length > 0) {
        return { provenance: "mcp", serverId: parts[1] };
      }
    }
    return { provenance: "builtin" };
  }
  // ==================== Public Utilities ====================
  /**
   * Checks if a tool name is the TodoWriteTool.
   * Exposed for external use in components that need to check this.
   */
  isTodoWriteTool(toolName) {
    return toolName === ToolNames.TODO_WRITE;
  }
  /**
   * Checks if a tool name is the ExitPlanModeTool.
   */
  isExitPlanModeTool(toolName) {
    return toolName === ToolNames.EXIT_PLAN_MODE;
  }
  /**
   * Checks if a tool name is the EnterPlanModeTool.
   */
  isEnterPlanModeTool(toolName) {
    return toolName === ToolNames.ENTER_PLAN_MODE;
  }
  /**
   * Resolves tool metadata from the registry.
   * Falls back to defaults if tool not found or build fails.
   *
   * @param toolName - Name of the tool
   * @param args - Tool call arguments (used to build invocation)
   */
  resolveToolMetadata(toolName, args) {
    if (!hasFullSessionContext(this.ctx)) {
      const description = typeof args?.["description"] === "string" ? args["description"].trim() : "";
      return {
        title: description ? `${toolName}: ${description}` : toolName,
        locations: [],
        kind: "other"
      };
    }
    const toolRegistry = this.ctx.config.getToolRegistry();
    const tool = toolRegistry.getTool(toolName);
    let title = tool?.displayName ?? toolName;
    let locations = [];
    let kind = "other";
    if (tool && args) {
      try {
        const invocation = tool.build(args);
        title = `${title}: ${invocation.getDescription()}`;
        locations = invocation.toolLocations().map((loc) => ({
          path: loc.path,
          line: loc.line ?? null
        }));
        kind = this.mapToolKind(tool.kind, toolName);
      } catch {
        if (typeof args["description"] === "string") {
          title = `${title}: ${args["description"]}`;
        }
        if (tool.kind) {
          kind = this.mapToolKind(tool.kind, toolName);
        }
      }
    }
    return { title, locations, kind };
  }
  /**
   * Maps core Tool Kind enum to ACP ToolKind string literals.
   *
   * @param kind - The core Kind enum value
   * @param toolName - Optional tool name to handle special cases like exit_plan_mode
   */
  mapToolKind(kind, toolName) {
    if (toolName && (this.isExitPlanModeTool(toolName) || this.isEnterPlanModeTool(toolName))) {
      return "switch_mode";
    }
    return KIND_MAP[kind] ?? "other";
  }
};
function buildToolResultContentPrefix(resultDisplay) {
  if (!isVisionBridgeNoticeDisplay(resultDisplay)) return [];
  return [
    {
      type: "content",
      content: {
        type: "text",
        text: sanitizeTerminalText(
          formatVisionBridgeNoticeDisplay(resultDisplay)
        )
      }
    }
  ];
}
__name(buildToolResultContentPrefix, "buildToolResultContentPrefix");

// packages/cli/src/acp-integration/session/history-replayer.ts
var HistoryReplayer = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.toolCallEmitter = new ToolCallEmitter(ctx);
    this.machine = this.createMachine();
  }
  static {
    __name(this, "HistoryReplayer");
  }
  toolCallEmitter;
  machine;
  async replay(records, gaps, options = {}) {
    try {
      if (options.goalBootstrap) {
        const update = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
          _meta: {
            ...options.goalBootstrap.goalState ? { goalState: options.goalBootstrap.goalState } : {},
            goalStatus: options.goalBootstrap.goalStatus
          }
        };
        await this.sendUpdate(update);
      }
      await this.replayPage(records, {
        finalizeDangling: options.finalizeDangling ?? true,
        gaps,
        ...options.skipFinalizeCallIds ? { skipFinalizeCallIds: options.skipFinalizeCallIds } : {},
        ...options.initialGoalState ? { goalState: options.initialGoalState } : {},
        ...options.initialGoalCause ? { goalCause: options.initialGoalCause } : {}
      });
    } finally {
      this.setActiveRecordId(null);
    }
  }
  static v2GoalBootstrap(rawGoalState, rawGoalCause) {
    const goalState = parseGoalSnapshotV2(rawGoalState);
    const goalCause = parseGoalStateCause(rawGoalCause);
    if (!goalState?.goal || goalState.goal.status !== "active" || !goalCause) {
      return void 0;
    }
    const projection = projectGoalStateToLegacy({
      v: 2,
      cause: goalCause,
      snapshot: goalState
    });
    const { type: _type, kind, ...goalStatus } = projection.goalStatus;
    if (kind !== "set" && kind !== "checking") {
      return void 0;
    }
    return { goalStatus: { ...goalStatus, kind }, goalState };
  }
  async replayPage(records, options = {}) {
    this.machine = this.createMachine(options);
    let replayError;
    try {
      for (const record of records) {
        for (const emission of this.machine.project(record)) {
          this.setActiveRecordId(
            emission.sourceRecordId,
            emission.sourceTimestamp
          );
          await this.sendUpdate(emission.update);
        }
      }
    } catch (error) {
      replayError = error;
    }
    let danglingError;
    if (options.finalizeDangling === true) {
      for (const emission of this.machine.finalize()) {
        this.setActiveRecordId(
          emission.sourceRecordId,
          emission.sourceTimestamp
        );
        try {
          await this.sendUpdate(emission.update);
        } catch (error) {
          danglingError ??= error;
        }
      }
    }
    const replay = this.machine.snapshot();
    this.copyCumulativeUsage(replay);
    const state = {
      pendingToolCalls: replay.pendingToolCalls.map(toLegacyPendingToolCall),
      replay
    };
    this.setActiveRecordId(null);
    if (replayError && danglingError) {
      throw new AggregateError(
        [replayError, danglingError],
        "Replay and dangling-cleanup both failed"
      );
    }
    if (replayError) throw replayError;
    if (danglingError) throw danglingError;
    return state;
  }
  getPendingToolCalls() {
    return this.machine.snapshot().pendingToolCalls.map(toLegacyPendingToolCall);
  }
  getReplayState() {
    return this.machine.snapshot();
  }
  createMachine(options = {}) {
    const cumulative = this.ctx.cumulativeUsage;
    const initialState = {
      v: 1,
      pendingToolCalls: (options.pendingToolCalls ?? []).map(
        toPendingTranscriptToolCall
      ),
      cumulativeUsage: cumulative ? { ...cumulative } : {
        promptTokens: 0,
        cachedTokens: 0,
        candidateTokens: 0,
        apiTimeMs: 0
      },
      ...options.goalState ? { goalState: options.goalState } : {},
      ...options.goalCause ? { goalCause: options.goalCause } : {}
    };
    return createTranscriptReplayMachine({
      initialState,
      gaps: options.gaps,
      presentation: this.presentationAdapter(),
      ...options.skipFinalizeCallIds ? { skipFinalizeCallIds: options.skipFinalizeCallIds } : {},
      onDiagnostic: /* @__PURE__ */ __name((diagnostic) => {
        if (diagnostic.code === "malformed_part" && diagnostic.path === "systemPayload.outputHistoryItems.goalStatus.condition") {
          writeStderrLineSafe(`qwen: ${diagnostic.message}`);
        }
      }, "onDiagnostic")
    });
  }
  presentationAdapter() {
    return {
      resolveToolMetadata: /* @__PURE__ */ __name((toolName, args) => this.toolCallEmitter.resolveToolMetadata(toolName, { ...args }), "resolveToolMetadata"),
      formatHistoryGap: /* @__PURE__ */ __name((gap) => formatHistoryGapNotice(gap), "formatHistoryGap"),
      buildToolResultContentPrefix
    };
  }
  async sendUpdate(update) {
    if (this.ctx.messageRewriter) {
      await this.ctx.messageRewriter.interceptUpdate(update);
      return;
    }
    await this.ctx.sendUpdate(update);
  }
  copyCumulativeUsage(state) {
    const cumulative = this.ctx.cumulativeUsage;
    if (!cumulative) return;
    cumulative.promptTokens = state.cumulativeUsage.promptTokens;
    cumulative.cachedTokens = state.cumulativeUsage.cachedTokens;
    cumulative.candidateTokens = state.cumulativeUsage.candidateTokens;
    cumulative.apiTimeMs = state.cumulativeUsage.apiTimeMs;
  }
  setActiveRecordId(recordId, timestamp) {
    this.ctx.setActiveRecordId?.(recordId, timestamp);
  }
};
function toPendingTranscriptToolCall(pending) {
  return {
    callId: pending.callId,
    toolName: pending.toolName,
    sourceRecordId: pending.recordId,
    ...pending.timestamp ? { sourceTimestamp: pending.timestamp } : {}
  };
}
__name(toPendingTranscriptToolCall, "toPendingTranscriptToolCall");
function toLegacyPendingToolCall(pending) {
  return {
    callId: pending.callId,
    toolName: pending.toolName,
    recordId: pending.sourceRecordId,
    ...pending.sourceTimestamp ? { timestamp: pending.sourceTimestamp } : {}
  };
}
__name(toLegacyPendingToolCall, "toLegacyPendingToolCall");

// packages/cli/src/services/setup-github.ts
init_esbuild_shims();
import { promises as fsp } from "node:fs";
import * as path from "node:path";

// packages/cli/src/utils/gitUtils.ts
init_esbuild_shims();
import * as childProcess from "node:child_process";
var debugLogger = createDebugLogger("GIT");
async function runGit(args, opts = {}) {
  return await new Promise((resolve2, reject) => {
    childProcess.execFile(
      "git",
      args,
      {
        encoding: "utf-8",
        ...opts.cwd ? { cwd: opts.cwd } : {}
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve2(String(stdout ?? "").trim());
      }
    );
  });
}
__name(runGit, "runGit");
var isGitHubRepositoryAsync = /* @__PURE__ */ __name(async (opts = {}) => {
  try {
    const remotes = await runGit(["remote", "-v"], opts);
    return remotes.split("\n").some((line) => {
      const remoteUrl = line.trim().split(/\s+/)[1];
      return remoteUrl ? isGitHubRemoteUrl(remoteUrl) : false;
    });
  } catch (_error) {
    debugLogger.debug(`Failed to get git remote:`, _error);
    return false;
  }
}, "isGitHubRepositoryAsync");
function isGitHubRemoteUrl(remoteUrl) {
  if (remoteUrl.startsWith("git@github.com:")) {
    return true;
  }
  if (remoteUrl.startsWith("git@")) {
    return false;
  }
  try {
    return new URL(remoteUrl).hostname === "github.com";
  } catch {
    return false;
  }
}
__name(isGitHubRemoteUrl, "isGitHubRemoteUrl");
var getGitRepoRootAsync = /* @__PURE__ */ __name(async (opts = {}) => {
  const gitRepoRoot = await runGit(["rev-parse", "--show-toplevel"], opts);
  if (!gitRepoRoot) {
    throw new Error(`Git repo returned empty value`);
  }
  return gitRepoRoot;
}, "getGitRepoRootAsync");
var getLatestGitHubRelease = /* @__PURE__ */ __name(async (proxy) => {
  try {
    const controller = new AbortController();
    const endpoint = `https://api.github.com/repos/QwenLM/qwen-code-action/releases/latest`;
    const dispatcher = proxy ? new (await loadUndici()).ProxyAgent(proxy) : void 0;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      dispatcher,
      signal: AbortSignal.any([AbortSignal.timeout(3e4), controller.signal])
    });
    if (!response.ok) {
      throw new Error(
        `Invalid response code: ${response.status} - ${response.statusText}`
      );
    }
    const releaseTag = (await response.json()).tag_name;
    if (!releaseTag) {
      throw new Error(`Response did not include tag_name field`);
    }
    return releaseTag;
  } catch (_error) {
    debugLogger.debug(
      `Failed to determine latest qwen-code-action release:`,
      _error
    );
    throw new Error(
      `Unable to determine the latest qwen-code-action release on GitHub.`
    );
  }
}, "getLatestGitHubRelease");
async function getGitHubRepoInfoAsync(opts = {}) {
  return parseGitHubRepoInfo(
    await runGit(["remote", "get-url", "origin"], opts)
  );
}
__name(getGitHubRepoInfoAsync, "getGitHubRepoInfoAsync");
function parseGitHubRepoInfo(remoteUrl) {
  let urlToParse = remoteUrl;
  if (remoteUrl.startsWith("git@github.com:")) {
    urlToParse = remoteUrl.replace("git@github.com:", "");
  } else if (remoteUrl.startsWith("git@")) {
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`
    );
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(urlToParse, "https://github.com");
  } catch {
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`
    );
  }
  if (parsedUrl.hostname !== "github.com") {
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`
    );
  }
  const parts = parsedUrl.pathname.split("/").filter((part) => part !== "");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`
    );
  }
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}
__name(parseGitHubRepoInfo, "parseGitHubRepoInfo");

// packages/cli/src/services/setup-github.ts
var debugLogger2 = createDebugLogger("SETUP_GITHUB");
var GITHUB_WORKFLOW_PATHS = [
  "qwen-dispatch/qwen-dispatch.yml",
  "qwen-assistant/qwen-invoke.yml",
  "issue-triage/qwen-triage.yml",
  "issue-triage/qwen-scheduled-triage.yml",
  "pr-review/qwen-review.yml"
];
var GITIGNORE_ENTRIES = [".qwen/", "gha-creds-*.json"];
var MAX_WORKFLOW_DOWNLOAD_BYTES = 5 * 1024 * 1024;
var SetupGithubError = class extends Error {
  static {
    __name(this, "SetupGithubError");
  }
  code;
  status;
  partial;
  partialResult;
  constructor(code3, message, status, partialResult) {
    super(message);
    this.name = "SetupGithubError";
    this.code = code3;
    this.status = status;
    this.partial = partialResult !== void 0;
    this.partialResult = partialResult;
  }
};
function isWorkspaceGenerationClosed(error) {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "workspace_generation_closed"
  );
}
__name(isWorkspaceGenerationClosed, "isWorkspaceGenerationClosed");
var nodeFileOps = {
  assertCanWrite() {
  },
  async ensureWorkflowDirectory(gitRepoRoot) {
    await fsp.mkdir(path.join(gitRepoRoot, ".github", "workflows"), {
      recursive: true
    });
  },
  async writeTextFile(gitRepoRoot, relativePath, content3) {
    const target = path.join(gitRepoRoot, relativePath);
    await fsp.writeFile(target, content3, { mode: 420 });
    return { sizeBytes: Buffer.byteLength(content3, "utf8") };
  },
  async readTextFile(gitRepoRoot, relativePath) {
    try {
      return await fsp.readFile(path.join(gitRepoRoot, relativePath), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return void 0;
      }
      throw error;
    }
  }
};
async function setupGithub(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const fileOps = options.fileOps ?? nodeFileOps;
  if (!await isGitHubRepositoryAsync({ cwd })) {
    throw new SetupGithubError(
      "github_repository_not_found",
      "Unable to determine the GitHub repository. /setup-github must be run from a git repository.",
      400
    );
  }
  let gitRepoRoot;
  try {
    gitRepoRoot = await getGitRepoRootAsync({ cwd });
  } catch (error) {
    debugLogger2.debug("Failed to get git repo root:", error);
    throw new SetupGithubError(
      "github_repository_not_found",
      "Unable to determine the GitHub repository. /setup-github must be run from a git repository.",
      400
    );
  }
  if (options.workspaceRoot) {
    const [gitRootReal, workspaceReal] = await Promise.all([
      realpathOrResolve(gitRepoRoot),
      realpathOrResolve(options.workspaceRoot)
    ]);
    if (gitRootReal !== workspaceReal) {
      throw new SetupGithubError(
        "github_git_root_mismatch",
        "The Git repository root must match the daemon workspace root.",
        400
      );
    }
  }
  fileOps.assertCanWrite?.();
  let releaseTag;
  try {
    releaseTag = await getLatestGitHubRelease(options.proxy);
  } catch (error) {
    writeStderrLine(
      `qwen setup-github: failed to determine latest qwen-code-action release: ${error instanceof Error ? error.message : String(error)}`
    );
    debugLogger2.debug(
      "Failed to determine latest qwen-code-action release:",
      error
    );
    throw new SetupGithubError(
      "github_release_lookup_failed",
      "Unable to determine the latest qwen-code-action release on GitHub.",
      502
    );
  }
  const readmeUrl = `https://github.com/QwenLM/qwen-code-action/blob/${releaseTag}/README.md#quick-start`;
  const secretsUrl = await resolveSecretsUrl(cwd);
  const downloads = await downloadWorkflows({
    releaseTag,
    proxy: options.proxy,
    abortSignal: options.abortSignal,
    fetchImpl: options.fetchImpl ?? fetch
  });
  const result = {
    kind: "github_setup",
    workspaceCwd: options.workspaceRoot ?? gitRepoRoot,
    gitRepoRoot,
    releaseTag,
    readmeUrl,
    ...secretsUrl ? { secretsUrl } : {},
    workflows: [],
    gitignore: { path: ".gitignore", status: "skipped" },
    warnings: []
  };
  result.gitignore = await updateGitignore(gitRepoRoot, fileOps);
  if (result.gitignore.status === "failed") {
    result.warnings.push("Failed to update .gitignore.");
  }
  try {
    await fileOps.ensureWorkflowDirectory(gitRepoRoot);
    for (const workflow of downloads) {
      const relativePath = path.posix.join(
        ".github",
        "workflows",
        path.posix.basename(workflow.sourcePath)
      );
      try {
        const write = await fileOps.writeTextFile(
          gitRepoRoot,
          relativePath,
          workflow.content
        );
        result.workflows.push({
          sourcePath: workflow.sourcePath,
          path: relativePath,
          status: "written",
          sizeBytes: write.sizeBytes
        });
      } catch (error) {
        if (isWorkspaceGenerationClosed(error)) throw error;
        result.partial = true;
        result.workflows.push({
          sourcePath: workflow.sourcePath,
          path: relativePath,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
        throw new SetupGithubError(
          "github_workflow_write_failed",
          `Unable to write ${relativePath}.`,
          500,
          result
        );
      }
    }
  } catch (error) {
    if (isWorkspaceGenerationClosed(error)) throw error;
    if (error instanceof SetupGithubError) throw error;
    throw new SetupGithubError(
      "github_workflow_write_failed",
      "Unable to create .github/workflows.",
      500,
      result
    );
  }
  return result;
}
__name(setupGithub, "setupGithub");
async function updateGitignore(gitRepoRoot, fileOps = nodeFileOps) {
  try {
    const existingContent = await fileOps.readTextFile(
      gitRepoRoot,
      ".gitignore"
    );
    if (existingContent === void 0) {
      const content3 = GITIGNORE_ENTRIES.join("\n") + "\n";
      await fileOps.writeTextFile(gitRepoRoot, ".gitignore", content3);
      return {
        path: ".gitignore",
        status: "created",
        added: [...GITIGNORE_ENTRIES]
      };
    }
    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingContent.split(/\r?\n/).some((line) => line.split("#")[0].trim() === entry)
    );
    if (missingEntries.length === 0) {
      return { path: ".gitignore", status: "unchanged" };
    }
    const nextContent = existingContent + "\n" + missingEntries.join("\n") + "\n";
    await fileOps.writeTextFile(gitRepoRoot, ".gitignore", nextContent);
    return {
      path: ".gitignore",
      status: "updated",
      added: missingEntries
    };
  } catch (error) {
    if (isWorkspaceGenerationClosed(error)) throw error;
    debugLogger2.debug("Failed to update .gitignore:", error);
    return {
      path: ".gitignore",
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
__name(updateGitignore, "updateGitignore");
async function downloadWorkflows(options) {
  const internalAbort = new AbortController();
  try {
    const dispatcher = options.proxy ? new (await loadUndici()).ProxyAgent(options.proxy) : void 0;
    return await Promise.all(
      GITHUB_WORKFLOW_PATHS.map(async (workflow) => {
        const endpoint = `https://raw.githubusercontent.com/QwenLM/qwen-code-action/refs/tags/${options.releaseTag}/examples/workflows/${workflow}`;
        const response = await options.fetchImpl(endpoint, {
          method: "GET",
          dispatcher,
          signal: AbortSignal.any([
            AbortSignal.timeout(3e4),
            internalAbort.signal,
            ...options.abortSignal ? [options.abortSignal] : []
          ])
        });
        if (!response.ok) {
          throw new Error(
            `Invalid response code downloading ${endpoint}: ${response.status} - ${response.statusText}`
          );
        }
        return {
          sourcePath: workflow,
          content: await readResponseTextWithLimit(response, workflow)
        };
      })
    );
  } catch (error) {
    internalAbort.abort();
    const message = error instanceof Error ? error.message : String(error);
    debugLogger2.debug("Failed to download qwen-code-action workflows:", error);
    throw new SetupGithubError(
      "github_workflow_download_failed",
      `Unable to download qwen-code-action workflows from GitHub. ${message}`,
      502
    );
  }
}
__name(downloadWorkflows, "downloadWorkflows");
async function readResponseTextWithLimit(response, sourcePath) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_WORKFLOW_DOWNLOAD_BYTES) {
      throw new Error(
        `${sourcePath} exceeds download limit of ${MAX_WORKFLOW_DOWNLOAD_BYTES} bytes`
      );
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WORKFLOW_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => {
        });
        throw new Error(
          `${sourcePath} exceeds download limit of ${MAX_WORKFLOW_DOWNLOAD_BYTES} bytes`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
__name(readResponseTextWithLimit, "readResponseTextWithLimit");
async function resolveSecretsUrl(cwd) {
  try {
    const repoInfo = await getGitHubRepoInfoAsync({ cwd });
    return `https://github.com/${repoInfo.owner}/${repoInfo.repo}/settings/secrets/actions`;
  } catch {
    return void 0;
  }
}
__name(resolveSecretsUrl, "resolveSecretsUrl");
async function realpathOrResolve(input) {
  try {
    return await fsp.realpath(input);
  } catch {
    return path.resolve(input);
  }
}
__name(realpathOrResolve, "realpathOrResolve");

// packages/cli/src/ui/utils/export/collect.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";

// packages/cli/src/utils/chat-record-tool-call-id.ts
init_esbuild_shims();
function getToolResultCallId(record) {
  return getExplicitToolResultCallId(record) ?? record.uuid;
}
__name(getToolResultCallId, "getToolResultCallId");
function getExplicitToolResultCallId(record) {
  const resultCallId = record.toolCallResult?.callId;
  if (typeof resultCallId === "string" && resultCallId.length > 0) {
    return resultCallId;
  }
  return extractFunctionResponseId(record);
}
__name(getExplicitToolResultCallId, "getExplicitToolResultCallId");
function extractFunctionResponseId(record) {
  if (!record.message?.parts) {
    return void 0;
  }
  for (const part of record.message.parts) {
    const id = "functionResponse" in part ? part.functionResponse?.id : void 0;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return void 0;
}
__name(extractFunctionResponseId, "extractFunctionResponseId");

// packages/cli/src/ui/utils/export/collect.ts
function extractToolNameFromRecord(record) {
  if (!record.message?.parts) {
    return void 0;
  }
  for (const part of record.message.parts) {
    if ("functionResponse" in part && part.functionResponse?.name) {
      return part.functionResponse.name;
    }
  }
  return void 0;
}
__name(extractToolNameFromRecord, "extractToolNameFromRecord");
function normalizeFunctionCallArgs(args) {
  if (args && typeof args === "object") {
    return args;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
    }
  }
  return void 0;
}
__name(normalizeFunctionCallArgs, "normalizeFunctionCallArgs");
function buildToolCallArgsIndex(records) {
  const byId = /* @__PURE__ */ new Map();
  const byName = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (record.type !== "assistant" || !record.message?.parts) continue;
    for (const part of record.message.parts) {
      if (!("functionCall" in part) || !part.functionCall?.name) continue;
      const normalizedArgs = normalizeFunctionCallArgs(part.functionCall.args);
      if (!normalizedArgs) continue;
      const toolName = part.functionCall.name;
      const callId = typeof part.functionCall.id === "string" ? part.functionCall.id : null;
      if (callId) {
        byId.set(callId, normalizedArgs);
      }
      const queue = byName.get(toolName) ?? [];
      queue.push(normalizedArgs);
      byName.set(toolName, queue);
    }
  }
  return { byId, byName };
}
__name(buildToolCallArgsIndex, "buildToolCallArgsIndex");
function calculateFileStats(records) {
  const argsIndex = buildToolCallArgsIndex(records);
  const byNameCursor = /* @__PURE__ */ new Map();
  const stats = {
    filesWritten: 0,
    linesAdded: 0,
    linesRemoved: 0,
    writtenFilePaths: /* @__PURE__ */ new Set()
  };
  for (const record of records) {
    if (record.type !== "tool_result" || !record.toolCallResult) continue;
    const toolName = extractToolNameFromRecord(record);
    const callId = getExplicitToolResultCallId(record);
    const argsFromId = callId && argsIndex.byId.has(callId) ? argsIndex.byId.get(callId) : void 0;
    let args = argsFromId;
    if (!args && toolName) {
      const queue = argsIndex.byName.get(toolName);
      if (queue && queue.length > 0) {
        const cursor = byNameCursor.get(toolName) ?? 0;
        args = queue[cursor];
        byNameCursor.set(toolName, cursor + 1);
      }
    }
    const { resultDisplay } = record.toolCallResult;
    if (resultDisplay && typeof resultDisplay === "object" && "fileName" in resultDisplay) {
      const display = resultDisplay;
      const hasOriginalContent = "originalContent" in display;
      const hasNewContent = "newContent" in display;
      let filePath;
      if (typeof display.fileName === "string") {
        filePath = args?.["file_path"] || display.fileName;
      } else {
        filePath = "unknown";
      }
      if (hasOriginalContent || hasNewContent) {
        stats.filesWritten++;
        stats.writtenFilePaths.add(filePath);
        if (display.diffStat) {
          stats.linesAdded += display.diffStat.model_added_lines ?? 0;
          stats.linesRemoved += display.diffStat.model_removed_lines ?? 0;
        } else if (!display.truncatedForSession) {
          const oldText = String(display.originalContent ?? "");
          const newText = String(display.newContent ?? "");
          const oldLines = oldText.split("\n").filter((line) => line.length > 0).length;
          const newLines = newText.split("\n").filter((line) => line.length > 0).length;
          stats.linesAdded += newLines;
          stats.linesRemoved += oldLines;
        }
      }
    }
  }
  return stats;
}
__name(calculateFileStats, "calculateFileStats");
function extractTaskToolTokens(record) {
  if (record.type !== "tool_result" || !record.toolCallResult?.resultDisplay) {
    return 0;
  }
  const { resultDisplay } = record.toolCallResult;
  if (typeof resultDisplay === "object" && "type" in resultDisplay && resultDisplay.type === "task_execution" && "executionSummary" in resultDisplay) {
    const summary = resultDisplay.executionSummary;
    if (typeof summary.totalTokens === "number") {
      return summary.totalTokens;
    }
    return (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0) + (summary.thoughtTokens ?? 0) + (summary.cachedTokens ?? 0);
  }
  return 0;
}
__name(extractTaskToolTokens, "extractTaskToolTokens");
function calculateTokenStats(records) {
  let totalTokens = 0;
  let lastValidRecord = null;
  for (const record of records) {
    if (record.type === "assistant") {
      if (record.usageMetadata) {
        totalTokens += record.usageMetadata.totalTokenCount ?? 0;
      }
      if (record.usageMetadata?.totalTokenCount !== void 0 && record.contextWindowSize !== void 0) {
        lastValidRecord = {
          totalTokenCount: record.usageMetadata.totalTokenCount,
          contextWindowSize: record.contextWindowSize
        };
      }
    }
    const taskTokens = extractTaskToolTokens(record);
    if (taskTokens > 0) {
      totalTokens += taskTokens;
    }
  }
  if (lastValidRecord) {
    const percent = lastValidRecord.totalTokenCount / lastValidRecord.contextWindowSize * 100;
    return {
      totalTokens,
      contextUsagePercent: Math.round(percent * 10) / 10,
      contextWindowSize: lastValidRecord.contextWindowSize
    };
  }
  const lastAssistantRecord = [...records].reverse().find((r) => r.type === "assistant" && r.contextWindowSize !== void 0);
  return {
    totalTokens,
    contextWindowSize: lastAssistantRecord?.contextWindowSize
  };
}
__name(calculateTokenStats, "calculateTokenStats");
function createExportSessionConfig(config) {
  const supportedConfig = {
    ...config,
    getToolRegistry: /* @__PURE__ */ __name(() => {
      const registry = config.getToolRegistry?.();
      return {
        getTool: /* @__PURE__ */ __name((toolName) => registry?.getTool?.(toolName) ?? null, "getTool")
      };
    }, "getToolRegistry")
  };
  return new Proxy(supportedConfig, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === "symbol") {
        return void 0;
      }
      throw new Error(
        `Export session replay config does not implement ${prop}`
      );
    }
  });
}
__name(createExportSessionConfig, "createExportSessionConfig");
async function collectSessionMetadata(conversation, config) {
  const { sessionId, startTime, messages } = conversation;
  const firstRecord = messages[0];
  const cwd = firstRecord?.cwd ?? "";
  const gitBranch = firstRecord?.gitBranch;
  let gitRepo;
  if (cwd) {
    const { getGitRepoName } = await import("./deferred-core-runtime-2IG4SLGP.js");
    gitRepo = getGitRepoName(cwd);
  }
  let model;
  for (const record of messages) {
    if (record.type === "assistant" && record.model) {
      model = record.model;
      break;
    }
  }
  const channel = config.getChannel?.();
  const promptCount = messages.filter((m) => m.type === "user").length;
  const fileStats = calculateFileStats(messages);
  const tokenStats = calculateTokenStats(messages);
  return {
    sessionId,
    startTime,
    exportTime: (/* @__PURE__ */ new Date()).toISOString(),
    cwd,
    gitRepo,
    gitBranch,
    model,
    channel,
    promptCount,
    contextUsagePercent: tokenStats.contextUsagePercent,
    contextWindowSize: tokenStats.contextWindowSize,
    totalTokens: tokenStats.totalTokens,
    filesWritten: fileStats.writtenFilePaths.size,
    linesAdded: fileStats.linesAdded,
    linesRemoved: fileStats.linesRemoved,
    uniqueFiles: Array.from(fileStats.writtenFilePaths)
  };
}
__name(collectSessionMetadata, "collectSessionMetadata");
function indexGoalStateRecords(records) {
  const positions = /* @__PURE__ */ new Map();
  const goalStates = [];
  records.forEach((record, index2) => {
    positions.set(record.uuid, index2);
    if (record.type !== "system" || record.subtype !== "goal_state") return;
    const payload = parseGoalStateRecordPayloadV2(record.systemPayload);
    if (!payload) return;
    goalStates.push({
      index: index2,
      uuid: record.uuid,
      timestamp: record.timestamp,
      payload
    });
  });
  return { positions, goalStates };
}
__name(indexGoalStateRecords, "indexGoalStateRecords");
function describeGoalState(payload) {
  const goal = payload.snapshot.goal;
  if (!goal) return `Goal ${payload.cause}`;
  const reason = goal.lastReason ? `: ${goal.lastReason}` : "";
  return `Goal ${payload.cause} (${goal.status}, turn ${goal.turnCount})${reason}`;
}
__name(describeGoalState, "describeGoalState");
var ExportSessionContext = class {
  static {
    __name(this, "ExportSessionContext");
  }
  sessionId;
  config;
  messages = [];
  currentMessage = null;
  activeRecordId = null;
  activeRecordTimestamp = null;
  toolCallMap = /* @__PURE__ */ new Map();
  recordPositions;
  pendingGoalStates;
  constructor(sessionId, config, records) {
    this.sessionId = sessionId;
    this.config = createExportSessionConfig(config);
    const { positions, goalStates } = indexGoalStateRecords(records);
    this.recordPositions = positions;
    this.pendingGoalStates = goalStates;
  }
  async sendUpdate(update) {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        this.handleMessageChunk("user", update.content);
        break;
      case "agent_message_chunk": {
        const usageMeta = update._meta;
        const usageMetadata = usageMeta?.usage ? {
          promptTokenCount: usageMeta.usage.inputTokens,
          candidatesTokenCount: usageMeta.usage.outputTokens,
          totalTokenCount: usageMeta.usage.totalTokens,
          thoughtsTokenCount: usageMeta.usage.thoughtTokens,
          cachedContentTokenCount: usageMeta.usage.cachedReadTokens
        } : void 0;
        this.handleMessageChunk(
          "assistant",
          update.content,
          "assistant",
          usageMetadata
        );
        break;
      }
      case "agent_thought_chunk":
        this.handleMessageChunk("assistant", update.content, "thinking");
        break;
      case "tool_call":
        this.flushCurrentMessage();
        this.handleToolCallStart(update);
        break;
      case "tool_call_update":
        this.handleToolCallUpdate(update);
        break;
      case "plan":
        this.flushCurrentMessage();
        this.handlePlanUpdate(update);
        break;
      default:
        break;
    }
  }
  setActiveRecordId(recordId, timestamp) {
    const position2 = recordId === null ? void 0 : this.recordPositions.get(recordId);
    if (position2 !== void 0) this.emitGoalStatesBefore(position2);
    this.activeRecordId = recordId;
    this.activeRecordTimestamp = timestamp ?? null;
  }
  /**
   * Writes the Goal transitions journaled before `position`. A transition
   * waits for the next record so the `/goal …` line replayed from its own
   * record lands ahead of it; whatever is buffered came from an earlier
   * record, so it is flushed first.
   */
  emitGoalStatesBefore(position2) {
    while (this.pendingGoalStates.length > 0 && this.pendingGoalStates[0].index < position2) {
      const { uuid, timestamp, payload } = this.pendingGoalStates.shift();
      this.flushCurrentMessage(this.activeRecordId === uuid);
      this.messages.push({
        uuid,
        sessionId: this.sessionId,
        timestamp,
        type: "system",
        message: {
          role: "system",
          parts: [{ text: describeGoalState(payload) }]
        },
        goalState: payload
      });
    }
  }
  getMessageTimestamp() {
    return this.activeRecordTimestamp ?? (/* @__PURE__ */ new Date()).toISOString();
  }
  getMessageUuid() {
    return this.activeRecordId ?? randomUUID();
  }
  handleMessageChunk(role, content3, messageRole = role, usageMetadata) {
    if (content3.type !== "text" || !content3.text) return;
    if (this.currentMessage && (this.currentMessage.type !== role || this.currentMessage.role !== messageRole)) {
      this.flushCurrentMessage();
    }
    if (this.currentMessage && this.currentMessage.type === role && this.currentMessage.role === messageRole) {
      this.currentMessage.parts.push({ text: content3.text });
      if (usageMetadata && role === "assistant") {
        this.currentMessage.usageMetadata = usageMetadata;
      }
    } else {
      this.currentMessage = {
        type: role,
        role: messageRole,
        parts: [{ text: content3.text }],
        timestamp: Date.now(),
        ...usageMetadata && role === "assistant" ? { usageMetadata } : {}
      };
    }
  }
  handleToolCallStart(update) {
    const toolCall = {
      toolCallId: update.toolCallId,
      kind: update.kind || "other",
      title: typeof update.title === "string" ? update.title : update.title || "",
      status: update.status || "pending",
      rawInput: update.rawInput,
      locations: update.locations,
      timestamp: Date.now()
    };
    this.toolCallMap.set(update.toolCallId, toolCall);
    const uuid = this.getMessageUuid();
    this.messages.push({
      uuid,
      sessionId: this.sessionId,
      timestamp: this.getMessageTimestamp(),
      type: "tool_call",
      toolCall
    });
  }
  handleToolCallUpdate(update) {
    const toolCall = this.toolCallMap.get(update.toolCallId);
    if (toolCall) {
      if (update.status) toolCall.status = update.status;
      if (update.content) toolCall.content = update.content;
      if (update.title)
        toolCall.title = typeof update.title === "string" ? update.title : "";
    }
  }
  handlePlanUpdate(update) {
    const uuid = this.getMessageUuid();
    const timestamp = this.getMessageTimestamp();
    const todoText = update.entries.map((entry) => {
      const checkbox = entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[-]" : "[ ]";
      return `- ${checkbox} ${entry.content}`;
    }).join("\n");
    const todoContent = [
      {
        type: "content",
        content: {
          type: "text",
          text: todoText
        }
      }
    ];
    this.messages.push({
      uuid,
      sessionId: this.sessionId,
      timestamp,
      type: "tool_call",
      toolCall: {
        toolCallId: uuid,
        // Use the same uuid as toolCallId for plan updates
        kind: "todowrite",
        title: "TodoList",
        status: "completed",
        content: todoContent,
        timestamp: Date.parse(timestamp)
      }
    });
  }
  flushCurrentMessage(freshUuid = false) {
    if (!this.currentMessage) return;
    const uuid = freshUuid ? randomUUID() : this.getMessageUuid();
    const exportMessage = {
      uuid,
      sessionId: this.sessionId,
      timestamp: this.getMessageTimestamp(),
      type: this.currentMessage.type,
      message: {
        role: this.currentMessage.role,
        parts: this.currentMessage.parts
      }
    };
    if (this.currentMessage.type === "assistant" && this.currentMessage.usageMetadata) {
      exportMessage.usageMetadata = this.currentMessage.usageMetadata;
    }
    this.messages.push(exportMessage);
    this.currentMessage = null;
  }
  flushMessages() {
    this.flushCurrentMessage();
    this.emitGoalStatesBefore(Number.POSITIVE_INFINITY);
  }
  getMessages() {
    return this.messages;
  }
};
async function collectSessionData(conversation, config) {
  const exportContext = new ExportSessionContext(
    conversation.sessionId,
    config,
    conversation.messages
  );
  const replayer = new HistoryReplayer(exportContext);
  await replayer.replay(conversation.messages);
  exportContext.flushMessages();
  const messages = exportContext.getMessages();
  const metadata = await collectSessionMetadata(conversation, config);
  return {
    sessionId: conversation.sessionId,
    startTime: conversation.startTime,
    messages,
    metadata
  };
}
__name(collectSessionData, "collectSessionData");

// packages/cli/src/ui/utils/export/normalize.ts
init_esbuild_shims();

// packages/cli/src/utils/truncatedDiffPreview.ts
init_esbuild_shims();
function buildTruncatedDiffPreviewText2(display) {
  const fileName = typeof display["fileName"] === "string" ? display["fileName"] : "the edited file";
  const fileDiffLength = typeof display["fileDiffLength"] === "number" ? ` Original fileDiff length: ${display["fileDiffLength"]} chars.` : "";
  if (display["fileDiffTruncated"] === true) {
    return `Full diff omitted from saved session history for ${fileName}.${fileDiffLength}`;
  }
  return `Saved session preview only for ${fileName}; full original and new file contents are unavailable.`;
}
__name(buildTruncatedDiffPreviewText2, "buildTruncatedDiffPreviewText");

// packages/cli/src/ui/utils/export/normalize.ts
function normalizeSessionData(sessionData, originalRecords, config) {
  const normalized = [...sessionData.messages];
  const toolCallIndexById = /* @__PURE__ */ new Map();
  normalized.forEach((message, index2) => {
    if (message.type === "tool_call" && message.toolCall?.toolCallId) {
      toolCallIndexById.set(message.toolCall.toolCallId, index2);
    }
  });
  const assistantMessageIndexByUuid = /* @__PURE__ */ new Map();
  normalized.forEach((message, index2) => {
    if (message.type === "assistant") {
      assistantMessageIndexByUuid.set(message.uuid, index2);
    }
  });
  for (const record of originalRecords) {
    if (record.type !== "tool_result") continue;
    const toolCallMessage = buildToolCallMessageFromResult(record, config);
    if (!toolCallMessage?.toolCall) continue;
    const existingIndex = toolCallIndexById.get(
      toolCallMessage.toolCall.toolCallId
    );
    if (existingIndex === void 0) {
      toolCallIndexById.set(
        toolCallMessage.toolCall.toolCallId,
        normalized.length
      );
      normalized.push(toolCallMessage);
      continue;
    }
    const existingMessage = normalized[existingIndex];
    if (existingMessage.type !== "tool_call" || !existingMessage.toolCall) {
      continue;
    }
    mergeToolCallData(existingMessage.toolCall, toolCallMessage.toolCall);
  }
  for (const record of originalRecords) {
    if (record.type !== "assistant") continue;
    if (!record.usageMetadata) continue;
    const existingIndex = assistantMessageIndexByUuid.get(record.uuid);
    if (existingIndex !== void 0) {
      if (!normalized[existingIndex].usageMetadata) {
        normalized[existingIndex].usageMetadata = record.usageMetadata;
      }
    }
  }
  return {
    ...sessionData,
    messages: normalized
  };
}
__name(normalizeSessionData, "normalizeSessionData");
function mergeToolCallData(existing, incoming) {
  if (!existing.content || existing.content.length === 0) {
    existing.content = incoming.content;
  }
  if (existing.status === "pending" || existing.status === "in_progress") {
    existing.status = incoming.status;
  }
  if (!existing.rawInput && incoming.rawInput) {
    existing.rawInput = incoming.rawInput;
  }
  if (!existing.kind || existing.kind === "other") {
    existing.kind = incoming.kind;
  }
  if ((!existing.title || existing.title === "") && incoming.title) {
    existing.title = incoming.title;
  }
  if ((!existing.locations || existing.locations.length === 0) && incoming.locations && incoming.locations.length > 0) {
    existing.locations = incoming.locations;
  }
}
__name(mergeToolCallData, "mergeToolCallData");
function buildToolCallMessageFromResult(record, config) {
  const toolCallResult = record.toolCallResult;
  const toolName = extractToolNameFromRecord2(record);
  if (toolName === ToolNames.TODO_WRITE) {
    return null;
  }
  const toolCallId2 = getToolResultCallId(record);
  const functionCallArgs = extractFunctionCallArgs(record);
  const { kind, title, locations } = resolveToolMetadata(
    config,
    toolName,
    functionCallArgs ?? toolCallResult?.args
  );
  const rawInput = normalizeRawInput(
    functionCallArgs ?? toolCallResult?.args
  );
  const resultContent = extractDiffContent2(toolCallResult?.resultDisplay) ?? transformPartsToToolCallContent(record.message?.parts ?? []);
  const content3 = isVisionBridgeNoticeDisplay(toolCallResult?.resultDisplay) ? [
    {
      type: "content",
      content: {
        type: "text",
        text: sanitizeTerminalText(
          formatVisionBridgeNoticeDisplay(toolCallResult.resultDisplay)
        )
      }
    },
    ...resultContent
  ] : resultContent;
  return {
    uuid: record.uuid,
    parentUuid: record.parentUuid,
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    type: "tool_call",
    toolCall: {
      toolCallId: toolCallId2,
      kind,
      title,
      status: toolCallResult?.error ? "failed" : "completed",
      rawInput,
      content: content3,
      locations,
      timestamp: Date.parse(record.timestamp)
    }
  };
}
__name(buildToolCallMessageFromResult, "buildToolCallMessageFromResult");
function extractToolNameFromRecord2(record) {
  if (!record.message?.parts) {
    return "";
  }
  for (const part of record.message.parts) {
    if ("functionResponse" in part && part.functionResponse?.name) {
      return part.functionResponse.name;
    }
  }
  return "";
}
__name(extractToolNameFromRecord2, "extractToolNameFromRecord");
function extractFunctionCallArgs(record) {
  if (!record.message?.parts) {
    return void 0;
  }
  for (const part of record.message.parts) {
    if ("functionCall" in part && part.functionCall?.args) {
      return part.functionCall.args;
    }
  }
  return void 0;
}
__name(extractFunctionCallArgs, "extractFunctionCallArgs");
function resolveToolMetadata(config, toolName, args) {
  const toolRegistry = config.getToolRegistry?.();
  const tool = toolName ? toolRegistry?.getTool?.(toolName) : void 0;
  let title = tool?.displayName ?? toolName ?? "tool_call";
  let locations;
  const kind = mapToolKind(tool?.kind, toolName);
  if (tool?.build && args) {
    try {
      const invocation = tool.build(args);
      title = `${title}: ${invocation.getDescription()}`;
      locations = invocation.toolLocations().map((loc) => ({
        path: loc.path,
        line: loc.line ?? null
      }));
    } catch {
    }
  }
  return { kind, title, locations };
}
__name(resolveToolMetadata, "resolveToolMetadata");
function mapToolKind(kind, toolName) {
  if (toolName && (toolName === ToolNames.EXIT_PLAN_MODE || toolName === ToolNames.ENTER_PLAN_MODE)) {
    return "switch_mode";
  }
  if (toolName && toolName === ToolNames.TODO_WRITE) {
    return "todowrite";
  }
  const allowedKinds = /* @__PURE__ */ new Set([
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "other"
  ]);
  if (kind && allowedKinds.has(kind)) {
    return kind;
  }
  return "other";
}
__name(mapToolKind, "mapToolKind");
function extractDiffContent2(resultDisplay) {
  if (!resultDisplay || typeof resultDisplay !== "object") {
    return null;
  }
  const display = resultDisplay;
  if ("fileName" in display && "newContent" in display) {
    if (display["truncatedForSession"] === true) {
      return [
        {
          type: "content",
          content: {
            type: "text",
            text: buildTruncatedDiffPreviewText2(display)
          }
        }
      ];
    }
    return [
      {
        type: "diff",
        path: typeof display["filePath"] === "string" ? display["filePath"] : display["fileName"],
        oldText: display["originalContent"] ?? "",
        newText: display["newContent"]
      }
    ];
  }
  return null;
}
__name(extractDiffContent2, "extractDiffContent");
function normalizeRawInput(value) {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return value;
  return void 0;
}
__name(normalizeRawInput, "normalizeRawInput");
function transformPartsToToolCallContent(parts) {
  const content3 = [];
  for (const part of parts) {
    if ("text" in part && part.text) {
      content3.push({
        type: "content",
        content: { type: "text", text: part.text }
      });
      continue;
    }
    if ("functionResponse" in part && part.functionResponse) {
      const response = part.functionResponse.response;
      const outputField = response?.["output"];
      const errorField = response?.["error"];
      const responseText = typeof outputField === "string" ? outputField : typeof errorField === "string" ? errorField : JSON.stringify(response);
      content3.push({
        type: "content",
        content: { type: "text", text: responseText }
      });
    }
  }
  return content3;
}
__name(transformPartsToToolCallContent, "transformPartsToToolCallContent");

// packages/cli/src/ui/utils/export/formatters/markdown.ts
init_esbuild_shims();
function toMarkdown(sessionData) {
  const lines = [];
  const metadata = sessionData.metadata;
  lines.push("# Chat Session Export\n");
  lines.push(`- **Session ID**: \`${sanitizeText(sessionData.sessionId)}\``);
  lines.push(`- **Start Time**: ${sanitizeText(sessionData.startTime)}`);
  lines.push(
    `- **Exported**: ${sanitizeText(metadata?.exportTime ?? (/* @__PURE__ */ new Date()).toISOString())}`
  );
  lines.push("");
  if (metadata?.cwd) {
    lines.push(`- **Working Directory**: \`${sanitizeText(metadata.cwd)}\``);
  }
  if (metadata?.gitRepo) {
    lines.push(`- **Git Repository**: ${sanitizeText(metadata.gitRepo)}`);
  }
  if (metadata?.gitBranch) {
    lines.push(`- **Git Branch**: \`${sanitizeText(metadata.gitBranch)}\``);
  }
  lines.push("");
  if (metadata?.model) {
    lines.push(`- **Model**: ${sanitizeText(metadata.model)}`);
  }
  if (metadata?.channel) {
    lines.push(`- **Channel**: ${sanitizeText(metadata.channel)}`);
  }
  if (metadata?.promptCount !== void 0) {
    lines.push(`- **Prompt Count**: ${metadata.promptCount}`);
  }
  lines.push("");
  if (metadata?.totalTokens !== void 0) {
    lines.push(`- **Total Tokens**: ${metadata.totalTokens}`);
  }
  if (metadata?.contextWindowSize !== void 0) {
    lines.push(`- **Context Window Size**: ${metadata.contextWindowSize}`);
  }
  if (metadata?.contextUsagePercent !== void 0) {
    lines.push(`- **Context Usage**: ${metadata.contextUsagePercent}%`);
  }
  lines.push("");
  if (metadata?.filesWritten !== void 0) {
    lines.push(`- **Files Written**: ${metadata.filesWritten}`);
  }
  if (metadata?.linesAdded !== void 0) {
    lines.push(`- **Lines Added**: ${metadata.linesAdded}`);
  }
  if (metadata?.linesRemoved !== void 0) {
    lines.push(`- **Lines Removed**: ${metadata.linesRemoved}`);
  }
  if (metadata?.uniqueFiles && metadata.uniqueFiles.length > 0) {
    lines.push("");
    lines.push("<details>");
    lines.push(
      `<summary><strong>Unique Files Referenced (${metadata.uniqueFiles.length})</strong></summary>`
    );
    lines.push("");
    for (const file of metadata.uniqueFiles) {
      lines.push(`- \`${sanitizeText(file)}\``);
    }
    lines.push("</details>");
  }
  lines.push("\n---\n");
  for (const message of sessionData.messages) {
    if (message.type === "user") {
      lines.push("## User\n");
      lines.push(formatMessageContent(message));
    } else if (message.type === "assistant") {
      lines.push("## Assistant\n");
      lines.push(formatMessageContent(message));
    } else if (message.type === "tool_call") {
      lines.push(formatToolCall(message));
    } else if (message.type === "system") {
      lines.push("### System\n");
      const text5 = formatMessageContent(message);
      lines.push(`> ${text5.replace(/\n/g, "\n> ")}`);
    }
    lines.push("\n");
  }
  return lines.join("\n");
}
__name(toMarkdown, "toMarkdown");
function formatMessageContent(message) {
  const text5 = extractTextFromMessage(message);
  const processedText = text5.replace(
    /--- Content from referenced files ---\n([\s\S]*?)\n--- End of content ---/g,
    (match, content3) => `
> **Referenced Files:**

${createCodeBlock(content3)}
`
  );
  return processedText;
}
__name(formatMessageContent, "formatMessageContent");
function formatToolCall(message) {
  if (!message.toolCall) return "";
  const lines = [];
  const { title, status, rawInput, content: content3, locations } = message.toolCall;
  const titleStr = typeof title === "string" ? title : JSON.stringify(title);
  lines.push(`### Tool: ${sanitizeText(titleStr)}`);
  lines.push(`**Status**: ${sanitizeText(status)}
`);
  if (rawInput) {
    lines.push("**Input:**");
    const inputStr = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
    lines.push(createCodeBlock(inputStr, "json"));
    lines.push("");
  }
  if (locations && locations.length > 0) {
    lines.push("**Affected Files:**");
    for (const loc of locations) {
      const lineSuffix = loc.line ? `:${loc.line}` : "";
      lines.push(`- \`${sanitizeText(loc.path)}${lineSuffix}\``);
    }
    lines.push("");
  }
  if (content3 && content3.length > 0) {
    lines.push("**Output:**");
    for (const item of content3) {
      if (item.type === "content" && item["content"]) {
        const contentData = item["content"];
        if (contentData.type === "text" && contentData.text) {
          let language = "";
          if (locations && locations.length === 1 && locations[0].path) {
            language = getLanguageFromPath(locations[0].path);
          }
          lines.push(createCodeBlock(contentData.text, language));
        }
      } else if (item.type === "diff") {
        const path3 = item["path"];
        const diffText = item["newText"];
        lines.push(`
*Diff for \`${sanitizeText(path3)}\`:*`);
        lines.push(createCodeBlock(diffText, "diff"));
      }
    }
  }
  return lines.join("\n");
}
__name(formatToolCall, "formatToolCall");
function extractTextFromMessage(message) {
  if (!message.message?.parts) return "";
  const textParts = [];
  for (const part of message.message.parts) {
    if ("text" in part) {
      textParts.push(part.text);
    }
  }
  return textParts.join("\n");
}
__name(extractTextFromMessage, "extractTextFromMessage");
function createCodeBlock(content3, language = "") {
  const fence = buildFence(content3);
  return `${fence}${language}
${content3}
${fence}`;
}
__name(createCodeBlock, "createCodeBlock");
function sanitizeText(value) {
  return (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
__name(sanitizeText, "sanitizeText");
function buildFence(value) {
  const matches = (value ?? "").match(/`+/g);
  const maxRun = matches ? Math.max(...matches.map((match) => match.length)) : 0;
  const fenceLength = Math.max(3, maxRun + 1);
  return "`".repeat(fenceLength);
}
__name(buildFence, "buildFence");
function getLanguageFromPath(path3) {
  const ext = path3.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "rb":
      return "ruby";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "c":
    case "cpp":
    case "h":
    case "hpp":
      return "cpp";
    case "cs":
      return "csharp";
    case "html":
      return "html";
    case "css":
      return "css";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "yaml":
    case "yml":
      return "yaml";
    case "xml":
      return "xml";
    case "sql":
      return "sql";
    default:
      return "";
  }
}
__name(getLanguageFromPath, "getLanguageFromPath");

// packages/cli/src/ui/utils/export/formatters/html.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";

// packages/web-templates/src/index.ts
init_esbuild_shims();

// packages/web-templates/src/generated/insightTemplate.ts
init_esbuild_shims();
var INSIGHT_JS = '(function(e,O){"use strict";function J({data:t}){const{totalMessages:n=0,totalLinesAdded:l=0,totalLinesRemoved:r=0,totalFiles:a=0}=t,s=Object.keys(t.heatmap||{});let o=0;if(s.length>0){const c=s.map(x=>new Date(x)).map(x=>x.getTime()),d=new Date(Math.min(...c)),g=new Date(Math.max(...c)),E=Math.abs(g.getTime()-d.getTime());o=Math.ceil(E/(1e3*60*60*24))+1}const i=o>0?Math.round(n/o):0;return e.createElement("div",{className:"stats-row"},e.createElement("div",{className:"stat"},e.createElement("div",{className:"stat-value"},n),e.createElement("div",{className:"stat-label"},"Messages")),e.createElement("div",{className:"stat"},e.createElement("div",{className:"stat-value"},"+",l,"/-",r),e.createElement("div",{className:"stat-label"},"Lines")),e.createElement("div",{className:"stat"},e.createElement("div",{className:"stat-value"},a),e.createElement("div",{className:"stat-label"},"Files")),e.createElement("div",{className:"stat"},e.createElement("div",{className:"stat-value"},o),e.createElement("div",{className:"stat-label"},"Days")),e.createElement("div",{className:"stat"},e.createElement("div",{className:"stat-value"},i),e.createElement("div",{className:"stat-label"},"Msgs/Day")))}/**\n * @license\n * Copyright 2026 Qwen Team\n * SPDX-License-Identifier: Apache-2.0\n */function D(t){const n=t.getFullYear(),l=String(t.getMonth()+1).padStart(2,"0"),r=String(t.getDate()).padStart(2,"0");return`${n}-${l}-${r}`}function Y(t){const[n,l,r]=t.split("-").map(Number);return new Date(n,l-1,r)}function V({insights:t}){return e.createElement("div",{className:"grid gap-4 md:grid-cols-2 md:gap-6"},e.createElement(X,{activeHours:t.activeHours,cardClass:"glass-card p-6",sectionTitleClass:"text-lg font-semibold tracking-tight text-slate-900"}))}function X({activeHours:t,cardClass:n,sectionTitleClass:l}){const a=[{label:"Morning",time:"06:00 - 12:00",hours:[6,7,8,9,10,11],color:"#fbbf24"},{label:"Afternoon",time:"12:00 - 18:00",hours:[12,13,14,15,16,17],color:"#0ea5e9"},{label:"Evening",time:"18:00 - 22:00",hours:[18,19,20,21],color:"#6366f1"},{label:"Night",time:"22:00 - 06:00",hours:[22,23,0,1,2,3,4,5],color:"#475569"}].map(o=>{const i=o.hours.reduce((m,c)=>m+(t[c]||0),0);return{...o,total:i}}),s=Math.max(...a.map(o=>o.total));return e.createElement("div",{className:`${n} h-full flex flex-col min-h-[320px]`},e.createElement("div",{className:"flex items-center justify-between mb-4"},e.createElement("h3",{className:l},"Active Hours")),e.createElement("div",{className:"flex-1 flex flex-col justify-center gap-4"},a.map(o=>e.createElement("div",{key:o.label,className:"space-y-2"},e.createElement("div",{className:"flex justify-between items-center text-sm"},e.createElement("div",{className:"flex items-center gap-2"},e.createElement("span",{className:"rounded-full",style:{width:"12px",height:"12px",backgroundColor:o.color}}),e.createElement("span",{className:"font-medium text-slate-700"},o.label),e.createElement("span",{className:"text-xs text-slate-400 hidden xl:inline"},o.time)),e.createElement("span",{className:"font-semibold text-slate-900"},o.total)),e.createElement("div",{className:"w-full rounded-full overflow-hidden",style:{height:"12px",backgroundColor:"#e2e8f0"}},e.createElement("div",{className:"h-full rounded-full",style:{width:`${s>0?o.total/s*100:0}%`,backgroundColor:o.color}}))))))}function Z({heatmap:t}){return e.createElement("div",{className:"glass-card p-6 mt-4 md:mt-6"},e.createElement("div",{className:"mb-3"},e.createElement("h3",{className:"text-lg font-semibold tracking-tight text-slate-900"},"Activity Heatmap"),e.createElement("p",{className:"text-xs text-slate-500"},"Showing past year of activity")),e.createElement("div",{className:"heatmap-container"},e.createElement("div",{className:"min-w-[720px] rounded-xl bg-white/70"},e.createElement(R,{heatmapData:t}))),e.createElement(ee,null))}function R({heatmapData:t}){const s=new Date,o=new Date(s);o.setFullYear(s.getFullYear()-1);const i=[],m=new Date(o);for(;m<=s;)i.push(new Date(m)),m.setDate(m.getDate()+1);const c=[0,2,4,10,20],d=["#ebedf0","#9be9a8","#40c463","#30a14e","#216e39"];function g(u){if(u===0)return d[0];for(let f=c.length-1;f>=1;f--)if(u>=c[f])return d[f];return d[1]}const E=50,x=20,A=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],w=o.getDay(),j=[];let h=-1,T=-100;return i.forEach((u,f)=>{const C=f+w,_=Math.floor(C/7),v=E+_*16,N=u.getMonth();N!==h&&(v-T>30&&(j.push({x:v,text:A[N]}),T=v),h=N)}),e.createElement("svg",{className:"heatmap-svg",width:1e3,height:130,viewBox:"0 0 1000 130"},i.map((u,f)=>{const C=f+w,_=Math.floor(C/7),v=u.getDay(),N=E+_*16,q=x+v*16,k=D(u),S=t[k]||0,I=g(S);return e.createElement("rect",{key:k,className:"heatmap-day",x:N,y:q,width:14,height:14,rx:"2",fill:I,"data-date":k,"data-count":S},e.createElement("title",null,k,": ",S," activities"))}),j.map((u,f)=>e.createElement("text",{key:f,x:u.x,y:"15",fontSize:"12",fill:"#64748b"},u.text)))}function ee(){const t=["#ebedf0","#9be9a8","#40c463","#30a14e","#216e39"];return e.createElement("div",{className:"flex items-center gap-2 mt-4"},e.createElement("span",{className:"text-xs text-slate-500"},"Less"),t.map((n,l)=>e.createElement("span",{key:l,className:"inline-block rounded",style:{width:"10px",height:"10px",backgroundColor:n}})),e.createElement("span",{className:"text-xs text-slate-500"},"More"))}function p({children:t}){if(!t||typeof t!="string")return t;const n=t.split(/(\\*\\*.*?\\*\\*)/g);return e.createElement(e.Fragment,null,n.map((l,r)=>l.startsWith("**")&&l.endsWith("**")&&l.length>=4?e.createElement("strong",{key:r},l.slice(2,-2)):l))}function H({text:t,label:n="Copy"}){const[l,r]=e.useState(!1),a=()=>{navigator.clipboard.writeText(t).then(()=>{r(!0),setTimeout(()=>r(!1),2e3)})};return e.createElement("button",{className:"copy-btn",onClick:a},l?"Copied!":n)}function te(t){return typeof t=="string"&&t.trim().length>0}function ne({qualitative:t,targetSections:n}){const{atAGlance:l}=t;if(!l)return null;const r=[{key:"wins",label:"What\'s working:",body:l.whats_working,href:"#section-wins",link:"Impressive Things You Did \u2192",showLink:n.wins},{key:"friction",label:"What\'s hindering you:",body:l.whats_hindering,href:"#section-friction",link:"Where Things Go Wrong \u2192",showLink:n.friction},{key:"features",label:"Quick wins to try:",body:l.quick_wins,href:"#section-features",link:"Features to Try \u2192",showLink:n.features},{key:"horizon",label:"Ambitious workflows:",body:l.ambitious_workflows,href:"#section-horizon",link:"On the Horizon \u2192",showLink:n.horizon}].filter(a=>te(a.body));return r.length===0?null:e.createElement("div",{className:"at-a-glance"},e.createElement("div",{className:"glance-title"},"At a Glance"),e.createElement("div",{className:"glance-sections"},r.map(a=>e.createElement("div",{key:a.key,className:"glance-section"},e.createElement("strong",null,a.label)," ",e.createElement(p,null,a.body),a.showLink&&e.createElement("a",{href:a.href,className:"see-more"},a.link)))))}function le({sections:t}){return t.length===0?null:e.createElement("nav",{className:"nav-toc"},t.map(n=>e.createElement("a",{key:n.href,href:n.href},n.label)))}function re({qualitative:t,topGoals:n,topTools:l}){const{projectAreas:r}=t,a=Array.isArray(l)?Object.fromEntries(l):l;return e.createElement(e.Fragment,null,e.createElement("h2",{id:"section-work",className:"text-xl font-semibold text-slate-900 mt-8 mb-4"},"What You Work On"),Array.isArray(r==null?void 0:r.areas)&&r.areas.length>0&&e.createElement("div",{className:"project-areas mb-6"},r.areas.map((s,o)=>e.createElement("div",{key:o,className:"project-area"},e.createElement("div",{className:"area-header"},e.createElement("span",{className:"area-name"},s.name),e.createElement("span",{className:"area-count"},"~",s.session_count," sessions")),e.createElement("div",{className:"area-desc"},e.createElement(p,null,s.description))))),e.createElement("div",{style:{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:"24px",marginBottom:"24px"}},n&&Object.keys(n).length>0&&e.createElement(M,{data:n,title:"What You Wanted",color:"#0ea5e9"}),a&&Object.keys(a).length>0&&e.createElement(M,{data:a,title:"Top Tools Used",color:"#6366f1"})))}function ae({qualitative:t,insights:n}){const{interactionStyle:l}=t;return l?e.createElement(e.Fragment,null,e.createElement("h2",{id:"section-usage",className:"text-xl font-semibold text-slate-900 mt-8 mb-4"},"How You Use Qwen Code"),e.createElement("div",{className:"narrative"},e.createElement("p",null,e.createElement(p,null,l.narrative)),l.key_pattern&&e.createElement("div",{className:"key-insight"},e.createElement("strong",null,"Key pattern:")," ",e.createElement(p,null,l.key_pattern))),e.createElement(V,{insights:n}),e.createElement(Z,{heatmap:n.heatmap})):null}function se({qualitative:t,primarySuccess:n,outcomes:l}){const r=t==null?void 0:t.impressiveWorkflows;return e.createElement(e.Fragment,null,e.createElement("h2",{id:"section-wins",className:"text-xl font-semibold text-slate-900 mt-8 mb-4"},"Impressive Things You Did"),(r==null?void 0:r.intro)&&e.createElement("p",{className:"section-intro"},e.createElement(p,null,r.intro)),r&&e.createElement("div",{className:"big-wins"},Array.isArray(r.impressive_workflows)&&r.impressive_workflows.map((a,s)=>e.createElement("div",{key:s,className:"big-win"},e.createElement("div",{className:"big-win-title"},a.title),e.createElement("div",{className:"big-win-desc"},e.createElement(p,null,a.description))))),e.createElement("div",{style:{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:"24px",marginTop:"24px",marginBottom:"24px"}},n&&Object.keys(n).length>0&&e.createElement(M,{data:n,title:"What Helped Most (Qwen\'s Capabilities)",color:"#3b82f6",allowedKeys:["fast_accurate_search","correct_code_edits","good_explanations","proactive_help","multi_file_changes","good_debugging"]}),l&&Object.keys(l).length>0&&e.createElement(M,{data:l,title:"Outcomes",color:"#8b5cf6",allowedKeys:["fully_achieved","mostly_achieved","partially_achieved","not_achieved","unclear_from_transcript"]})))}function oe(t){return t==="unclear_from_transcript"?"Unclear":t.split("_").map(n=>n.charAt(0).toUpperCase()+n.slice(1)).join(" ")}function M({data:t,title:n,color:l="#3b82f6",allowedKeys:r=null}){if(!t||Object.keys(t).length===0)return null;let a=Object.entries(t).filter(([,o])=>Number.isFinite(o)&&o!==0);if(r&&(a=a.filter(([o])=>r.includes(o))),a.sort((o,i)=>i[1]-o[1]),a=a.slice(0,10),a.length===0)return null;const s=Math.max(...a.map(([,o])=>o));return e.createElement("div",{className:"bar-chart-card",style:{flex:1,minWidth:0,backgroundColor:"#ffffff",borderRadius:"12px",padding:"20px",boxShadow:"0 1px 3px rgba(0, 0, 0, 0.08)",border:"1px solid #e2e8f0"}},e.createElement("h3",{style:{fontSize:"13px",fontWeight:700,color:"#64748b",marginTop:0,marginBottom:"16px",textTransform:"uppercase",letterSpacing:"0.5px"}},n),e.createElement("div",{className:"bar-chart",style:{display:"flex",flexDirection:"column",gap:"10px"}},a.map(([o,i])=>{const m=s>0?i/s*100:0;return e.createElement("div",{key:o,className:"bar-row",style:{display:"flex",alignItems:"center",gap:"12px"}},e.createElement("div",{className:"bar-label",style:{width:"130px",fontSize:"13px",color:"#475569",textAlign:"left",flexShrink:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}},oe(o)),e.createElement("div",{className:"bar-wrapper",style:{flex:1,display:"flex",alignItems:"center",gap:"10px",minWidth:0}},e.createElement("div",{className:"bar-bg",style:{flex:1,height:"8px",backgroundColor:"#f1f5f9",borderRadius:"4px",overflow:"hidden"}},e.createElement("div",{className:"bar-fill",style:{width:`${m}%`,height:"100%",backgroundColor:l,borderRadius:"4px",transition:"width 0.3s ease"}})),e.createElement("span",{className:"bar-value",style:{fontSize:"13px",fontWeight:600,color:"#475569",minWidth:"24px",textAlign:"right"}},i)))})))}function ie({qualitative:t,satisfaction:n,friction:l}){const r=t==null?void 0:t.frictionPoints;return e.createElement(e.Fragment,null,e.createElement("h2",{id:"section-friction",className:"text-xl font-semibold text-slate-900 mt-8 mb-4"},"Where Things Go Wrong"),(r==null?void 0:r.intro)&&e.createElement("p",{className:"section-intro"},e.createElement(p,null,r.intro)),r&&e.createElement("div",{className:"friction-categories"},Array.isArray(r.categories)&&r.categories.map((a,s)=>e.createElement("div",{key:s,className:"friction-category"},e.createElement("div",{className:"friction-title"},a.category),e.createElement("div",{className:"friction-desc"},e.createElement(p,null,a.description)),Array.isArray(a.examples)&&a.examples.length>0&&e.createElement("ul",{className:"friction-examples"},a.examples.map((o,i)=>e.createElement("li",{key:i},e.createElement(p,null,o))))))),e.createElement("div",{style:{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:"24px",marginTop:"24px",marginBottom:"24px"}},l&&Object.keys(l).length>0&&e.createElement(M,{data:l,title:"Primary Friction Types",color:"#ef4444",allowedKeys:["misunderstood_request","wrong_approach","buggy_code","user_rejected_action","excessive_changes"]}),n&&Object.keys(n).length>0&&e.createElement(M,{data:n,title:"Inferred Satisfaction (model-estimated)",color:"#10b981",allowedKeys:["happy","satisfied","likely_satisfied","dissatisfied","frustrated"]})))}function me({additions:t}){const[n,l]=e.useState(new Array(t.length).fill(!0)),[r,a]=e.useState(!1),s=m=>{const c=n.map((d,g)=>g===m?!d:d);l(c)},o=()=>{const m=t.filter((c,d)=>n[d]).map(c=>c.addition).join(`\n\n`);m&&navigator.clipboard.writeText(m).then(()=>{a(!0),setTimeout(()=>a(!1),2e3)})},i=n.filter(Boolean).length;return e.createElement("div",{className:"qwen-md-section"},e.createElement("h3",null,"Suggested QWEN.md Additions"),e.createElement("p",{className:"text-xs text-slate-500 mb-3"},"Just copy this into Qwen Code to add it to your QWEN.md."),e.createElement("div",{className:"qwen-md-actions",style:{marginBottom:"12px"}},e.createElement("button",{className:`copy-all-btn ${r?"copied":""}`,onClick:o,disabled:i===0},r?"Copied All!":`Copy All Checked (${i})`)),t.map((m,c)=>e.createElement("div",{key:c,className:"qwen-md-item"},e.createElement("input",{type:"checkbox",checked:n[c],onChange:()=>s(c),className:"cmd-checkbox"}),e.createElement("div",{style:{flex:1}},e.createElement("code",{className:"cmd-code"},m.addition),e.createElement("div",{className:"cmd-why"},e.createElement(p,null,m.why))),e.createElement(H,{text:m.addition}))))}function ce({qualitative:t}){const{improvements:n}=t;if(!n)return null;const l=Array.isArray(n.Qwen_md_additions)&&n.Qwen_md_additions.length>0||Array.isArray(n.features_to_try)&&n.features_to_try.length>0,r=Array.isArray(n.usage_patterns)&&n.usage_patterns.length>0;return!l&&!r?null:e.createElement(e.Fragment,null,l&&e.createElement(e.Fragment,null,e.createElement("h2",{id:"section-features",className:"text-xl font-semibold text-slate-900 mt-8 mb-4"},"Existing Qwen Code Features to Try"),Array.isArray(n.Qwen_md_additions)&&n.Qwen_md_additions.length>0&&e.createElement(me,{additions:n.Qwen_md_additions}),e.createElement("p",{className:"text-xs text-slate-500 mb-3"},"Just copy this into Qwen Code and it\'ll set it up for you."),e.createElement("div",{className:"features-section"},Array.isArray(n.features_to_try)&&n.features_to_try.map((a,s)=>e.createElement("div",{key:s,className:"feature-card"},e.createElement("div",{className:"feature-title"},a.feature),e.createElement("div",{className:"feature-oneliner"},e.createElement(p,null,a.one_liner)),e.createElement("div",{className:"feature-why"},e.createElement("strong",null,"Why for you:")," ",e.createElement(p,null,a.why_for_you)),e.createElement("div",{className:"feature-examples"},e.createElement("div",{className:"feature-example"},e.createElement("div",{className:"example-code-row"},e.createElement("code",{className:"example-code"},a.example_code),e.createElement(H,{text:a.example_code})))))))),r&&e.createElement(e.Fragment,null,e.createElement("h2",{id:"section-patterns",className:"text-xl font-semibold text-slate-900 mt-8 mb-4"},"New Ways to Use Qwen Code"),e.createElement("p",{className:"text-xs text-slate-500 mb-3"},"Just copy this into Qwen Code and it\'ll walk you through it."),e.createElement("div",{className:"patterns-section"},Array.isArray(n.usage_patterns)&&n.usage_patterns.map((a,s)=>e.createElement("div",{key:s,className:"pattern-card"},e.createElement("div",{className:"pattern-title"},a.title),e.createElement("div",{className:"pattern-summary"},e.createElement(p,null,a.suggestion)),e.createElement("div",{className:"pattern-detail"},e.createElement(p,null,a.detail)),e.createElement("div",{className:"copyable-prompt-section"},e.createElement("div",{className:"prompt-label"},"Paste into Qwen Code:"),e.createElement("div",{className:"copyable-prompt-row"},e.createElement("code",{className:"copyable-prompt"},a.copyable_prompt),e.createElement(H,{text:a.copyable_prompt}))))))))}function de({qualitative:t}){const{futureOpportunities:n}=t;return n?e.createElement(e.Fragment,null,e.createElement("h2",{id:"section-horizon",className:"text-xl font-semibold text-slate-900 mt-8 mb-4"},"On the Horizon"),n.intro&&e.createElement("p",{className:"section-intro"},e.createElement(p,null,n.intro)),e.createElement("div",{className:"horizon-section"},Array.isArray(n.opportunities)&&n.opportunities.map((l,r)=>e.createElement("div",{key:r,className:"horizon-card"},e.createElement("div",{className:"horizon-title"},l.title),e.createElement("div",{className:"horizon-possible"},e.createElement(p,null,l.whats_possible)),e.createElement("div",{className:"horizon-tip"},e.createElement("strong",null,"Getting started:")," ",e.createElement(p,null,l.how_to_try)),e.createElement("div",{className:"pattern-prompt"},e.createElement("div",{className:"prompt-label"},"Paste into Qwen Code:"),e.createElement("div",{style:{display:"flex",alignItems:"flex-start",gap:"8px"}},e.createElement("code",{style:{flex:1}},l.copyable_prompt),e.createElement(H,{text:l.copyable_prompt}))))))):null}function pe({qualitative:t}){const{memorableMoment:n}=t;return n?e.createElement("div",{className:"fun-ending"},e.createElement("div",{className:"fun-headline"},\'"\',n.headline,\'"\'),e.createElement("div",{className:"fun-detail"},e.createElement(p,null,n.detail))):null}const ue={light:{background:"linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",textPrimary:"#0f172a",textSecondary:"#475569",textMuted:"#64748b",cardBackground:"rgba(255,255,255,0.7)",cardBackgroundSecondary:"rgba(255,255,255,0.5)",borderColor:"#e2e8f0",heatmapColors:["#9be9a8","#40c463","#30a14e","#216e39"],heatmapEmpty:"#ebedf0"},dark:{background:"linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",textPrimary:"#f8fafc",textSecondary:"#e2e8f0",textMuted:"#94a3b8",cardBackground:"rgba(255,255,255,0.05)",cardBackgroundSecondary:"rgba(255,255,255,0.04)",borderColor:"rgba(255,255,255,0.08)",heatmapColors:["#0e4429","#006d32","#26a641","#39d353"],heatmapEmpty:"#2d333b"}};function fe({data:t,theme:n="light"}){var h,T,u,f,C,_;const l=ue[n],{totalMessages:r=0,totalSessions:a=0,totalLinesAdded:s=0,totalLinesRemoved:o=0,totalFiles:i=0,currentStreak:m=0,longestStreak:c=0,activeHours:d={}}=t,g=Object.keys(t.heatmap||{});let E=0,x="";if(g.length>0){E=g.length;const v=g.map(S=>Y(S).getTime()),N=new Date(Math.min(...v)),q=new Date(Math.max(...v)),k=S=>D(S);x=`${k(N)} \u2014 ${k(q)}`}const A=(u=(T=(h=t.qualitative)==null?void 0:h.interactionStyle)==null?void 0:T.key_pattern)!=null?u:null,w=(_=(C=(f=t.qualitative)==null?void 0:f.memorableMoment)==null?void 0:C.headline)!=null?_:null,j=ge(t.heatmap||{},l);return e.createElement("div",{id:"share-card",style:{width:"1200px",background:l.background,color:l.textPrimary,fontFamily:\'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"\',display:"flex",flexDirection:"column",padding:"48px 56px",position:"absolute",left:"-9999px",top:"-9999px",overflow:"hidden",boxSizing:"border-box"}},e.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"32px"}},e.createElement("div",null,e.createElement("div",{style:{fontSize:"32px",fontWeight:700,letterSpacing:"-0.02em",lineHeight:1.2}},"Qwen Code Insights"),e.createElement("div",{style:{fontSize:"14px",color:l.textMuted,marginTop:"6px"}},x)),e.createElement("div",{style:{fontSize:"11px",color:l.textMuted,textTransform:"uppercase",letterSpacing:"0.15em",paddingTop:"8px"}},"qwen.ai")),e.createElement("div",{style:{display:"grid",gridTemplateColumns:"repeat(6, 1fr)",gap:"16px",marginBottom:"32px"}},e.createElement(z,{value:String(r),label:"Messages",theme:l}),e.createElement(z,{value:String(a),label:"Sessions",theme:l}),e.createElement(z,{value:`+${s}/-${o}`,label:"Lines Changed",small:!0,theme:l}),e.createElement(z,{value:String(i),label:"Files",theme:l}),e.createElement(z,{value:`${m}d`,label:"Streak",theme:l}),e.createElement(z,{value:`${c}d`,label:"Best Streak",theme:l})),e.createElement("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"24px",marginBottom:"16px"}},e.createElement("div",{style:{background:l.cardBackground,borderRadius:"12px",padding:"20px",display:"flex",flexDirection:"column"}},e.createElement("div",{style:{fontSize:"12px",fontWeight:600,color:l.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:"12px"}},"Activity \xB7 ",E," active days"),e.createElement("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}},e.createElement(xe,{cells:j})),e.createElement(Ee,{theme:l})),e.createElement("div",{style:{display:"flex",flexDirection:"column",gap:"16px"}},e.createElement("div",{style:{background:l.cardBackground,borderRadius:"12px",padding:"20px",display:"flex",flexDirection:"column"}},e.createElement("div",{style:{fontSize:"12px",fontWeight:600,color:l.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:"12px"}},"Active Hours"),e.createElement("div",{style:{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",gap:"10px"}},e.createElement(he,{activeHours:d,theme:l}))),e.createElement("div",{style:{background:l.cardBackgroundSecondary,borderRadius:"12px",padding:"16px 16px",position:"relative"}},e.createElement("div",{style:{position:"absolute",left:"12px",fontSize:"64px",fontWeight:700,color:n==="light"?"rgba(99,102,241,0.15)":"rgba(99,102,241,0.2)",lineHeight:1,fontFamily:\'Georgia, "Times New Roman", serif\',userSelect:"none",pointerEvents:"none"}},"\u201C"),e.createElement("div",{style:{paddingLeft:"40px",position:"relative"}},A&&e.createElement("div",{style:{fontSize:"13px",color:l.textSecondary,lineHeight:1.6,marginBottom:w?"8px":0}},A),w&&e.createElement("div",{style:{fontSize:"12px",color:l.textMuted,lineHeight:1.5,fontStyle:"italic"}},w))))),e.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:"auto",paddingTop:"24px",borderTop:`1px solid ${l.borderColor}`,flexShrink:0}},e.createElement("div",{style:{fontSize:"12px",color:l.textMuted}},"Generated by Qwen Code \xB7 ",D(new Date)),e.createElement("div",{style:{fontSize:"12px",color:l.textMuted}},"github.com/QwenLM/qwen-code")))}function z({value:t,label:n,small:l,theme:r}){return e.createElement("div",{style:{textAlign:"center"}},e.createElement("div",{style:{fontSize:l?"18px":"28px",fontWeight:700,color:r.textPrimary,lineHeight:1.2}},t),e.createElement("div",{style:{fontSize:"11px",color:r.textMuted,textTransform:"uppercase",letterSpacing:"0.05em",marginTop:"4px"}},n))}function he({activeHours:t,theme:n}){const r=[{label:"Morning",time:"06\u201312",hours:[6,7,8,9,10,11],color:"#fbbf24"},{label:"Afternoon",time:"12\u201318",hours:[12,13,14,15,16,17],color:"#0ea5e9"},{label:"Evening",time:"18\u201322",hours:[18,19,20,21],color:"#6366f1"},{label:"Night",time:"22\u201306",hours:[22,23,0,1,2,3,4,5],color:"#475569"}].map(s=>({...s,total:s.hours.reduce((o,i)=>o+(t[i]||0),0)})),a=Math.max(...r.map(s=>s.total),1);return e.createElement(e.Fragment,null,r.map(s=>{const o=a>0?s.total/a*100:0;return e.createElement("div",{key:s.label},e.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:"12px",marginBottom:"4px"}},e.createElement("div",{style:{display:"flex",alignItems:"center",gap:"6px"}},e.createElement("span",{style:{width:"8px",height:"8px",borderRadius:"50%",backgroundColor:s.color,display:"inline-block",flexShrink:0}}),e.createElement("span",{style:{color:n.textSecondary,fontWeight:500}},s.label),e.createElement("span",{style:{color:n.textMuted,fontSize:"11px"}},s.time)),e.createElement("span",{style:{color:n.textMuted,fontWeight:600}},s.total)),e.createElement("div",{style:{height:"6px",background:n.borderColor,borderRadius:"3px",overflow:"hidden"}},e.createElement("div",{style:{width:`${o}%`,height:"100%",backgroundColor:s.color,borderRadius:"3px"}})))}))}function ge(t,n){const l=new Date,a=26*7,s=new Date(l);s.setDate(s.getDate()-a+1),s.setDate(s.getDate()-s.getDay());const o=[],i=new Date(l);i.setDate(i.getDate()+(6-i.getDay()));const m=new Date(s);for(;m<=i;){const c=D(m),d=t[c]||0;o.push({color:ye(d,n)}),m.setDate(m.getDate()+1)}return o}function ye(t,n){return t===0?n.heatmapEmpty:t<2?n.heatmapColors[0]:t<4?n.heatmapColors[1]:t<10?n.heatmapColors[2]:n.heatmapColors[3]}function xe({cells:t}){const l=Math.ceil(t.length/7),r=14,a=3,s=l*(r+a),o=7*(r+a);return e.createElement("svg",{width:s,height:o,viewBox:`0 0 ${s} ${o}`},t.map((i,m)=>{const c=Math.floor(m/7),d=m%7;return e.createElement("rect",{key:m,x:c*(r+a),y:d*(r+a),width:r,height:r,rx:2,fill:i.color})}))}function Ee({theme:t}){return e.createElement("div",{style:{display:"flex",alignItems:"center",gap:"8px",marginTop:"12px"}},e.createElement("span",{style:{fontSize:"11px",color:t.textMuted}},"Less"),[t.heatmapEmpty,t.heatmapColors[0],t.heatmapColors[1],t.heatmapColors[2],t.heatmapColors[3]].map((n,l)=>e.createElement("span",{key:l,style:{width:"10px",height:"10px",borderRadius:"2px",backgroundColor:n,display:"inline-block"}})),e.createElement("span",{style:{fontSize:"11px",color:t.textMuted}},"More"))}function b(t){return typeof t=="string"?t.trim().length>0:typeof t=="number"?Number.isFinite(t)&&t!==0:typeof t=="boolean"?t:Array.isArray(t)?t.some(n=>b(n)):t&&typeof t=="object"?Object.values(t).some(n=>b(n)):!1}function W(t){return Array.isArray(t)?t.some(([,n])=>Number.isFinite(n)&&n!==0):!!t&&Object.values(t).some(n=>Number.isFinite(n)&&n!==0)}function $(t){return Array.isArray(t)&&t.some(n=>b(n))}function ve({data:t}){var u,f,C,_,v,N,q,k,S,I,K,U;const[n,l]=e.useState("dark"),r=e.useRef(!1),a=async()=>{const F=document.getElementById("share-card");if(!F||!window.html2canvas){alert("Export functionality is not available.");return}try{const y=F.cloneNode(!0);y.style.position="fixed",y.style.left="-9999px",y.style.top="0",y.style.pointerEvents="none",document.body.appendChild(y);const P=await window.html2canvas(y,{scale:2,useCORS:!0,logging:!1,width:1200,height:y.scrollHeight});document.body.removeChild(y);const G=P.toDataURL("image/png"),L=document.createElement("a");L.href=G,L.download=`qwen-insights-card-${D(new Date)}.png`,L.click()}catch(y){console.error("Export card error:",y),alert("Failed to export card. Please try again.")}};e.useEffect(()=>{r.current&&(r.current=!1,a())},[n]);const s=F=>{F===n?a():(r.current=!0,l(F))};if(!t)return e.createElement("div",{className:"text-center text-slate-600"},"No insight data available");const o=Object.keys(t.heatmap||{});let i="";if(o.length>0){const y=o.map(B=>Y(B)).map(B=>B.getTime()),P=new Date(Math.min(...y)),G=new Date(Math.max(...y)),L=B=>D(B);i=`${L(P)} to ${L(G)}`}const m=b((u=t.qualitative)==null?void 0:u.atAGlance),c=!!t.qualitative&&(b(t.qualitative.projectAreas)||W(t.topGoals)||W(t.topTools)),d=b((f=t.qualitative)==null?void 0:f.interactionStyle),g=!!t.qualitative&&(b(t.qualitative.impressiveWorkflows)||W(t.primarySuccess)||W(t.outcomes)),E=!!t.qualitative&&(b(t.qualitative.frictionPoints)||W(t.satisfaction)||W(t.friction)),x=!!t.qualitative&&($((C=t.qualitative.improvements)==null?void 0:C.Qwen_md_additions)||$((_=t.qualitative.improvements)==null?void 0:_.features_to_try)),A=!!t.qualitative&&$((v=t.qualitative.improvements)==null?void 0:v.usage_patterns),w=b((N=t.qualitative)==null?void 0:N.futureOpportunities),j=b((q=t.qualitative)==null?void 0:q.memorableMoment),h=[];c&&h.push({href:"#section-work",label:"What You Work On"}),d&&h.push({href:"#section-usage",label:"How You Use Qwen Code"}),g&&h.push({href:"#section-wins",label:"Impressive Things"}),E&&h.push({href:"#section-friction",label:"Where Things Go Wrong"}),x&&h.push({href:"#section-features",label:"Features to Try"}),A&&h.push({href:"#section-patterns",label:"New Usage Patterns"}),w&&h.push({href:"#section-horizon",label:"On the Horizon"});const T={wins:g,friction:E,features:x,horizon:w};return e.createElement("div",null,e.createElement("header",{className:"insights-header"},e.createElement("div",{className:"header-content"},e.createElement("div",{className:"header-title-section"},e.createElement("h1",{className:"header-title"},"Qwen Code Insights"),e.createElement("p",{className:"header-subtitle"},t.totalMessages?`${t.totalMessages.toLocaleString()} messages across ${(k=t.totalSessions)==null?void 0:k.toLocaleString()} sessions`:"Your personalized coding journey and patterns",i&&` \xB7 ${i}`)),e.createElement(be,{onExport:s}))),m&&t.qualitative&&e.createElement(ne,{qualitative:t.qualitative,targetSections:T}),h.length>0&&e.createElement(le,{sections:h}),e.createElement(J,{data:t}),c&&t.qualitative&&e.createElement(re,{qualitative:t.qualitative,topGoals:t.topGoals,topTools:t.topTools}),d&&t.qualitative&&e.createElement(ae,{qualitative:t.qualitative,insights:t}),g&&e.createElement(se,{qualitative:t.qualitative,primarySuccess:(S=t.primarySuccess)!=null?S:{},outcomes:(I=t.outcomes)!=null?I:{}}),E&&e.createElement(ie,{qualitative:t.qualitative,satisfaction:(K=t.satisfaction)!=null?K:{},friction:(U=t.friction)!=null?U:{}}),(x||A)&&t.qualitative&&e.createElement(ce,{qualitative:t.qualitative}),w&&t.qualitative&&e.createElement(de,{qualitative:t.qualitative}),j&&t.qualitative&&e.createElement(pe,{qualitative:t.qualitative}),e.createElement(fe,{data:t,theme:n}))}function be({onExport:t}){const[n,l]=e.useState(!1),r=e.useRef(null);e.useEffect(()=>{if(!n)return;const s=o=>{r.current&&!r.current.contains(o.target)&&l(!1)};return document.addEventListener("mousedown",s),()=>document.removeEventListener("mousedown",s)},[n]);const a=s=>{l(!1),t(s)};return e.createElement("div",{className:"export-dropdown-wrapper",ref:r},e.createElement("button",{className:"export-card-btn",onClick:()=>l(!n)},e.createElement("svg",{width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"},e.createElement("path",{d:"M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"}),e.createElement("polyline",{points:"16 6 12 2 8 6"}),e.createElement("line",{x1:"12",y1:"2",x2:"12",y2:"15"})),e.createElement("span",null,"Export Card"),e.createElement("svg",{width:"12",height:"12",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",className:`export-chevron ${n?"open":""}`},e.createElement("polyline",{points:"6 9 12 15 18 9"}))),n&&e.createElement("div",{className:"export-dropdown"},e.createElement("button",{className:"export-dropdown-item",onClick:()=>a("light")},e.createElement("svg",{width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"},e.createElement("circle",{cx:"12",cy:"12",r:"5"}),e.createElement("line",{x1:"12",y1:"1",x2:"12",y2:"3"}),e.createElement("line",{x1:"12",y1:"21",x2:"12",y2:"23"}),e.createElement("line",{x1:"4.22",y1:"4.22",x2:"5.64",y2:"5.64"}),e.createElement("line",{x1:"18.36",y1:"18.36",x2:"19.78",y2:"19.78"}),e.createElement("line",{x1:"1",y1:"12",x2:"3",y2:"12"}),e.createElement("line",{x1:"21",y1:"12",x2:"23",y2:"12"}),e.createElement("line",{x1:"4.22",y1:"19.78",x2:"5.64",y2:"18.36"}),e.createElement("line",{x1:"18.36",y1:"5.64",x2:"19.78",y2:"4.22"})),e.createElement("span",null,"Light Theme")),e.createElement("button",{className:"export-dropdown-item",onClick:()=>a("dark")},e.createElement("svg",{width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"},e.createElement("path",{d:"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"})),e.createElement("span",null,"Dark Theme"))))}const Q=document.getElementById("react-root");Q&&window.INSIGHT_DATA&&O?O.createRoot(Q).render(e.createElement(ve,{data:window.INSIGHT_DATA})):console.error("Failed to mount React app:",{container:!!Q,data:!!window.INSIGHT_DATA,ReactDOM:!!O})})(React,ReactDOM);';
var INSIGHT_CSS = '*,:before,:after,::backdrop{--tw-border-spacing-x: 0;--tw-border-spacing-y: 0;--tw-translate-x: 0;--tw-translate-y: 0;--tw-rotate: 0;--tw-skew-x: 0;--tw-skew-y: 0;--tw-scale-x: 1;--tw-scale-y: 1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness: proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width: 0px;--tw-ring-offset-color: #fff;--tw-ring-color: #3b82f680;--tw-ring-offset-shadow: 0 0 #0000;--tw-ring-shadow: 0 0 #0000;--tw-shadow: 0 0 #0000;--tw-shadow-colored: 0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }*,:before,:after{box-sizing:border-box;border:0 solid #e5e7eb}:before,:after{--tw-content: ""}html,:host{-webkit-text-size-adjust:100%;-moz-tab-size:4;-o-tab-size:4;tab-size:4;font-feature-settings:normal;font-variation-settings:normal;-webkit-tap-highlight-color:transparent;font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji",Segoe UI Symbol,"Noto Color Emoji";line-height:1.5}body{line-height:inherit;margin:0;background-image:linear-gradient(to bottom right,var(--tw-gradient-stops));--tw-gradient-from: #f8fafc var(--tw-gradient-from-position);--tw-gradient-to: #f1f5f9 var(--tw-gradient-to-position);--tw-gradient-stops: var(--tw-gradient-from), #fff var(--tw-gradient-via-position), var(--tw-gradient-to);--tw-text-opacity: 1;min-height:100vh;color:rgb(15 23 42 / var(--tw-text-opacity, 1));-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.glass-card{--tw-border-opacity: 1;border-width:1px;border-color:rgb(226 232 240 / var(--tw-border-opacity, 1));--tw-shadow: 0 10px 40px #0f172a14;--tw-shadow-colored: 0 10px 40px var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow);--tw-backdrop-blur: blur(8px);backdrop-filter:var(--tw-backdrop-blur) var(--tw-backdrop-brightness) var(--tw-backdrop-contrast) var(--tw-backdrop-grayscale) var(--tw-backdrop-hue-rotate) var(--tw-backdrop-invert) var(--tw-backdrop-opacity) var(--tw-backdrop-saturate) var(--tw-backdrop-sepia);background-color:#fff9;border-radius:1rem}.col-span-2{grid-column:span 2 / span 2}.mx-auto{margin-left:auto;margin-right:auto}.mb-8{margin-bottom:2rem}.ml-2{margin-left:.5rem}.mt-1{margin-top:.25rem}.mt-2{margin-top:.5rem}.mt-4{margin-top:1rem}.mt-6{margin-top:1.5rem}.block{display:block}.flex{display:flex}.inline-flex{display:inline-flex}.grid{display:grid}.h-56{height:14rem}.h-full{height:100%}.min-h-screen{min-height:100vh}.w-full{width:100%}.min-w-\\[720px\\]{min-width:720px}.max-w-6xl{max-width:72rem}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.flex-col{flex-direction:column}.items-start{align-items:flex-start}.items-center{align-items:center}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-1{gap:.25rem}.gap-2{gap:.5rem}.gap-3{gap:.75rem}.gap-4{gap:1rem}.space-y-3>:not([hidden])~:not([hidden]){--tw-space-y-reverse: 0;margin-top:calc(.75rem * calc(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.75rem * var(--tw-space-y-reverse))}.space-y-4>:not([hidden])~:not([hidden]){--tw-space-y-reverse: 0;margin-top:calc(1rem * calc(1 - var(--tw-space-y-reverse)));margin-bottom:calc(1rem * var(--tw-space-y-reverse))}.divide-y>:not([hidden])~:not([hidden]){--tw-divide-y-reverse: 0;border-top-width:calc(1px * calc(1 - var(--tw-divide-y-reverse)));border-bottom-width:calc(1px * var(--tw-divide-y-reverse))}.divide-slate-200>:not([hidden])~:not([hidden]){--tw-divide-opacity: 1;border-color:rgb(226 232 240 / var(--tw-divide-opacity, 1))}.overflow-x-auto{overflow-x:auto}.rounded-full{border-radius:9999px}.rounded-xl{border-radius:1.25rem}.border{border-width:1px}.border-slate-100{--tw-border-opacity: 1;border-color:rgb(241 245 249 / var(--tw-border-opacity, 1))}.bg-emerald-50{--tw-bg-opacity: 1;background-color:rgb(236 253 245 / var(--tw-bg-opacity, 1))}.bg-slate-100{--tw-bg-opacity: 1;background-color:rgb(241 245 249 / var(--tw-bg-opacity, 1))}.bg-slate-50{--tw-bg-opacity: 1;background-color:rgb(248 250 252 / var(--tw-bg-opacity, 1))}.bg-slate-900{--tw-bg-opacity: 1;background-color:rgb(15 23 42 / var(--tw-bg-opacity, 1))}.bg-white\\/70{background-color:#ffffff73}.bg-gradient-to-br{background-image:linear-gradient(to bottom right,var(--tw-gradient-stops))}.from-slate-50{--tw-gradient-from: #f8fafc var(--tw-gradient-from-position);--tw-gradient-to: #f8fafc00 var(--tw-gradient-to-position);--tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to)}.via-white{--tw-gradient-to: #ffffff00 var(--tw-gradient-to-position);--tw-gradient-stops: var(--tw-gradient-from), #ffffff var(--tw-gradient-via-position), var(--tw-gradient-to)}.to-slate-100{--tw-gradient-to: #f1f5f9 var(--tw-gradient-to-position)}.p-4{padding:1rem}.p-6{padding:1.5rem}.px-3{padding-left:.75rem;padding-right:.75rem}.px-4{padding-left:1rem;padding-right:1rem}.px-5{padding-left:1.25rem;padding-right:1.25rem}.px-6{padding-left:1.5rem;padding-right:1.5rem}.px-8{padding-left:2rem;padding-right:2rem}.py-1{padding-top:.25rem;padding-bottom:.25rem}.py-10{padding-top:2.5rem;padding-bottom:2.5rem}.py-2{padding-top:.5rem;padding-bottom:.5rem}.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-6{padding-top:1.5rem;padding-bottom:1.5rem}.text-left{text-align:left}.text-center{text-align:center}.text-2xl{font-size:1.5rem;line-height:2rem}.text-3xl{font-size:1.875rem;line-height:2.25rem}.text-4xl{font-size:2.25rem;line-height:2.5rem}.text-base{font-size:1rem;line-height:1.5rem}.text-lg{font-size:1.125rem;line-height:1.75rem}.text-sm{font-size:.875rem;line-height:1.25rem}.text-xl{font-size:1.25rem;line-height:1.75rem}.text-xs{font-size:.75rem;line-height:1rem}.font-bold{font-weight:700}.font-medium{font-weight:500}.font-semibold{font-weight:600}.uppercase{text-transform:uppercase}.tracking-\\[0\\.2em\\]{letter-spacing:.2em}.tracking-tight{letter-spacing:-.025em}.tracking-wide{letter-spacing:.025em}.text-emerald-700{--tw-text-opacity: 1;color:rgb(4 120 87 / var(--tw-text-opacity, 1))}.text-rose-700{--tw-text-opacity: 1;color:rgb(190 18 60 / var(--tw-text-opacity, 1))}.text-slate-200{--tw-text-opacity: 1;color:rgb(226 232 240 / var(--tw-text-opacity, 1))}.text-slate-400{--tw-text-opacity: 1;color:rgb(148 163 184 / var(--tw-text-opacity, 1))}.text-slate-500{--tw-text-opacity: 1;color:rgb(100 116 139 / var(--tw-text-opacity, 1))}.text-slate-600{--tw-text-opacity: 1;color:rgb(71 85 105 / var(--tw-text-opacity, 1))}.text-slate-700{--tw-text-opacity: 1;color:rgb(51 65 85 / var(--tw-text-opacity, 1))}.text-slate-900{--tw-text-opacity: 1;color:rgb(15 23 42 / var(--tw-text-opacity, 1))}.text-white{--tw-text-opacity: 1;color:rgb(255 255 255 / var(--tw-text-opacity, 1))}.shadow-inner{--tw-shadow: inset 0 2px 4px 0 #0000000d;--tw-shadow-colored: inset 0 2px 4px 0 var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow)}.shadow-soft{--tw-shadow: 0 10px 40px #0f172a14;--tw-shadow-colored: 0 10px 40px var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow)}.shadow-slate-100{--tw-shadow-color: #f1f5f9;--tw-shadow: var(--tw-shadow-colored)}.transition{transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter;transition-duration:.15s;transition-timing-function:cubic-bezier(.4,0,.2,1)}.hover\\:-translate-y-\\[1px\\]:hover{--tw-translate-y: -1px;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.hover\\:shadow-lg:hover{--tw-shadow: 0 10px 15px -3px #0000001a, 0 4px 6px -4px #0000001a;--tw-shadow-colored: 0 10px 15px -3px var(--tw-shadow-color), 0 4px 6px -4px var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow)}.focus-visible\\:outline:focus-visible{outline-style:solid}.focus-visible\\:outline-2:focus-visible{outline-width:2px}.focus-visible\\:outline-offset-2:focus-visible{outline-offset:2px}.focus-visible\\:outline-slate-400:focus-visible{outline-color:#94a3b8}.active\\:translate-y-\\[1px\\]:active{--tw-translate-y: 1px;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.group:hover .group-hover\\:translate-x-0\\.5{--tw-translate-x: .125rem;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}@media (min-width: 768px){.md\\:mt-6{margin-top:1.5rem}.md\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.md\\:gap-6{gap:1.5rem}.md\\:py-12{padding-top:3rem;padding-bottom:3rem}.md\\:text-4xl{font-size:2.25rem;line-height:2.5rem}}.heatmap-container{width:100%;overflow-x:auto}.heatmap-svg{min-width:720px}.heatmap-day{cursor:pointer}.heatmap-day:hover{stroke:#00000024;stroke-width:1px}.heatmap-legend{display:flex;align-items:center;gap:4px;font-size:12px;color:#64748b;margin-top:8px}.heatmap-legend-item{width:10px;height:10px;border-radius:2px}.nav-toc{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 32px;padding:16px;background:#fff;border-radius:8px;border:1px solid #e2e8f0}.nav-toc a{font-size:12px;color:#64748b;text-decoration:none;padding:6px 12px;border-radius:6px;background:#f1f5f9;transition:all .15s}.nav-toc a:hover{background:#e2e8f0;color:#334155}.at-a-glance{background:linear-gradient(135deg,#fef3c7,#fde68a);border:1px solid #f59e0b;border-radius:12px;padding:20px 24px;margin-bottom:32px}.glance-title{font-size:16px;font-weight:700;color:#92400e;margin-bottom:16px}.glance-sections{display:flex;flex-direction:column;gap:12px}.glance-section{font-size:14px;color:#78350f;line-height:1.6}.glance-section strong{color:#92400e;font-weight:700}.see-more{color:#b45309;text-decoration:none;font-size:13px;white-space:nowrap;margin-left:4px}.see-more:hover{text-decoration:underline}.project-areas{display:flex;flex-direction:column;gap:12px;margin-bottom:32px}.project-area{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px}.area-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.area-name{font-weight:600;font-size:15px;color:#0f172a}.area-count{font-size:12px;color:#64748b;background:#f1f5f9;padding:2px 8px;border-radius:4px}.area-desc{font-size:14px;color:#475569;line-height:1.5}.narrative{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px}.narrative p{margin-top:0;margin-bottom:12px;font-size:14px;color:#475569;line-height:1.7}.key-insight{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin-top:12px;font-size:14px;color:#166534}.section-intro{font-size:14px;color:#64748b;margin-bottom:16px}.big-wins{display:flex;flex-direction:column;gap:12px;margin-bottom:24px}.big-win{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px}.big-win-title{font-weight:600;font-size:15px;color:#166534;margin-bottom:8px}.big-win-desc{font-size:14px;color:#15803d;line-height:1.5}.friction-categories{display:flex;flex-direction:column;gap:16px;margin-bottom:24px}.friction-category{background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px}.friction-title{font-weight:600;font-size:15px;color:#991b1b;margin-bottom:6px}.friction-desc{font-size:13px;color:#7f1d1d;margin-bottom:10px}.friction-examples{margin:0 0 0 10px;padding:0;font-size:13px;color:#334155;list-style-type:disc}.friction-examples li{margin-bottom:4px}.qwen-md-section{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;margin-bottom:20px}.qwen-md-section h3{font-size:13px;font-weight:600;color:#1e40af;margin:0 0 8px}.qwen-md-actions{margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #dbeafe}.copy-all-btn{background:#2563eb;color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer;font-weight:500;transition:all .2s}.copy-all-btn:hover{background:#1d4ed8}.copy-all-btn.copied{background:#16a34a}.qwen-md-item{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid #dbeafe}.qwen-md-item:last-child{border-bottom:none}.cmd-checkbox{margin-top:2px}.cmd-code{background:#fff;padding:6px 10px;border-radius:4px;font-size:11px;color:#1e40af;border:1px solid #bfdbfe;font-family:monospace;display:block;white-space:pre-wrap;word-break:break-word;flex:1}.cmd-why{font-size:11px;color:#64748b;width:100%;padding-left:20px;margin-top:4px}.features-section,.patterns-section{display:flex;flex-direction:column;gap:12px;margin:16px 0}.feature-card{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px}.pattern-card{background:#f0f9ff;border:1px solid #7dd3fc;border-radius:8px;padding:16px}.feature-title,.pattern-title{font-weight:600;font-size:15px;color:#0f172a;margin-bottom:6px}.feature-oneliner,.pattern-summary{font-size:14px;color:#475569;margin-bottom:8px}.feature-why,.pattern-detail{font-size:13px;color:#334155;line-height:1.5}.feature-examples{margin-top:12px}.feature-example{padding:8px 0;border-top:1px solid #d1fae5}.feature-example:first-child{border-top:none}.example-code-row,.copyable-prompt-row{display:flex;align-items:flex-start;gap:8px}.example-code{flex:1;background:#f1f5f9;padding:8px 12px;border-radius:4px;font-family:monospace;font-size:12px;color:#334155;overflow-x:auto;white-space:pre-wrap}.copyable-prompt-section{margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0}.copyable-prompt{flex:1;background:#f8fafc;padding:10px 12px;border-radius:4px;font-family:monospace;font-size:12px;color:#334155;border:1px solid #e2e8f0;white-space:pre-wrap;line-height:1.5}.prompt-label{font-size:11px;font-weight:600;text-transform:uppercase;color:#64748b;margin-bottom:6px}.copy-btn{background:#e2e8f0;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;color:#475569;flex-shrink:0;transition:all .2s}.copy-btn:hover{background:#cbd5e1}.horizon-section{display:flex;flex-direction:column;gap:16px}.horizon-card{background:linear-gradient(135deg,#faf5ff,#f5f3ff);border:1px solid #c4b5fd;border-radius:8px;padding:16px}.horizon-title{font-weight:600;font-size:15px;color:#5b21b6;margin-bottom:8px}.horizon-possible{font-size:14px;color:#334155;margin-bottom:10px;line-height:1.5}.horizon-tip{font-size:13px;color:#6b21a8;background:#fff9;padding:8px 12px;border-radius:4px}.pattern-prompt{background:#f8fafc;padding:12px;border-radius:6px;margin-top:12px;border:1px solid #e2e8f0;display:flex;flex-direction:column;gap:8px}.pattern-prompt code{font-family:monospace;font-size:12px;color:#334155;display:block;white-space:pre-wrap}.fun-ending{background:linear-gradient(135deg,#fef3c7,#fde68a);border:1px solid #fbbf24;border-radius:12px;padding:24px;margin-top:40px;text-align:center}.fun-headline{font-size:18px;font-weight:600;color:#78350f;margin-bottom:8px}.fun-detail{font-size:14px;color:#92400e}.stats-row{display:flex;gap:24px;margin-bottom:40px;padding:20px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}.stat{text-align:center}.stat-value{font-size:24px;font-weight:700;color:#0f172a}.stat-label{font-size:11px;color:#64748b;text-transform:uppercase}@media (max-width: 640px){.stats-row{justify-content:center}}.header-with-action{position:relative}.insights-header{margin-bottom:2rem;padding:1.5rem 0;border-bottom:1px solid #e2e8f0}.header-content{display:flex;justify-content:space-between;align-items:center;gap:1.5rem;flex-wrap:wrap}.header-title-section{flex:1;min-width:0}.header-title{font-size:1.75rem;font-weight:700;color:#0f172a;letter-spacing:-.02em;margin:0 0 .375rem;line-height:1.2}.header-subtitle{font-size:.875rem;color:#64748b;margin:0;font-weight:400}.export-dropdown-wrapper{position:relative}.export-card-btn{display:inline-flex;align-items:center;gap:.5rem;height:36px;padding:0 .875rem;border:1px solid #e2e8f0;border-radius:8px;background:#fff;color:#334155;font-size:.8125rem;font-weight:500;cursor:pointer;transition:all .15s ease}.export-card-btn:hover{background:#f8fafc;border-color:#cbd5e1}.export-card-btn:active{background:#f1f5f9}.export-chevron{transition:transform .15s ease;opacity:.5}.export-chevron.open{transform:rotate(180deg)}.export-dropdown{position:absolute;top:calc(100% + 4px);right:0;min-width:160px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 4px 16px #00000014;padding:4px;z-index:50}.export-dropdown-item{display:flex;align-items:center;gap:.5rem;width:100%;padding:.5rem .75rem;border:none;border-radius:6px;background:none;color:#334155;font-size:.8125rem;font-weight:400;cursor:pointer;transition:background .1s ease}.export-dropdown-item:hover{background:#f1f5f9}.export-dropdown-item:active{background:#e2e8f0}@media (max-width: 640px){.header-content{flex-direction:column;align-items:flex-start;gap:1rem}.header-title{font-size:1.5rem}}';

// packages/web-templates/src/generated/exportTranscriptDocumentTemplate.ts
init_esbuild_shims();
var DOCUMENT_HTML_TEMPLATE = `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-__EXPORT_NONCE__'; style-src-elem 'nonce-__EXPORT_NONCE__'; style-src-attr 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; media-src 'none'; font-src data:; base-uri 'none'; form-action 'none'"
    />
    <link
      rel="icon"
      type="image/svg+xml"
      href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20141.38%20140%22%3E%0A%20%20%3Cpath%0A%20%20%20%20fill%3D%22%23000000%22%0A%20%20%20%20d%3D%22m140.93%2085-16.35-28.33-1.93-3.34%208.66-15a3.323%203.323%200%200%200%200-3.34l-9.62-16.67c-.3-.51-.72-.93-1.22-1.22s-1.07-.45-1.67-.45H82.23l-8.66-15a3.33%203.33%200%200%200-2.89-1.67H51.43c-.59%200-1.17.16-1.66.45-.5.29-.92.71-1.22%201.22L32.19%2029.98l-1.92%203.33H12.96c-.59%200-1.17.16-1.66.45-.5.29-.93.71-1.22%201.22L.45%2051.66a3.323%203.323%200%200%200%200%203.34l18.28%2031.67-8.66%2015a3.32%203.32%200%200%200%200%203.34l9.62%2016.67c.3.51.72.93%201.22%201.22s1.07.45%201.67.45h36.56l8.66%2015a3.35%203.35%200%200%200%202.89%201.67h19.25a3.34%203.34%200%200%200%202.89-1.67l18.28-31.67h17.32c.6%200%201.17-.16%201.67-.45s.92-.71%201.22-1.22l9.62-16.67a3.323%203.323%200%200%200%200-3.34ZM51.44%203.33%2061.07%2020l-9.63%2016.66h76.98l-9.62%2016.66H45.67l-11.54-20zM57.21%20120H22.58l9.63-16.67h19.25l-38.5-66.67h19.25l9.62%2016.67L68.78%20100l-11.55%2020Zm61.59-33.34-9.62-16.67-38.49%2066.67-9.63-16.67%209.63-16.66%2026.94-46.67h23.1l17.32%2030z%22%0A%20%20%2F%3E%0A%3C%2Fsvg%3E"
    />
    <title>Qwen Code Chat Export</title>
    <style nonce="__EXPORT_NONCE__">
      :root{color-scheme:light;--document-bg: #ffffff;--document-panel-bg: #f8fafc;--document-text: #111827;--document-muted: #6b7280;--document-border: #d1d5db;--document-button-bg: #ffffff}:root.dark{color-scheme:dark;--document-bg: #09090b;--document-panel-bg: #18181b;--document-text: #f4f4f5;--document-muted: #a1a1aa;--document-border: #3f3f46;--document-button-bg: #27272a}html,body{margin:0;min-height:100%;background:var(--document-bg);color:var(--document-text)}.document-shell{min-height:100vh}.document-header{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:24px;width:min(1320px,100%);margin:0 auto;padding:24px 20px 8px;font-family:ui-sans-serif,system-ui,sans-serif}.document-header h1{margin:0;font-size:20px}.document-header p{margin:6px 0 0;color:var(--document-muted);font-size:12px}.document-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-left:auto}.document-actions button{border:1px solid var(--document-border);border-radius:8px;padding:6px 10px;background:var(--document-button-bg);color:var(--document-text);font:inherit;font-size:12px;cursor:pointer}.document-actions button:disabled{cursor:default;opacity:.45}.document-content{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:20px;width:min(1320px,100%);margin:0 auto;padding:0 20px 24px}.document-transcript{min-width:0}.document-metadata{align-self:start;position:sticky;top:16px;display:flex;flex-direction:column;gap:18px;border:1px solid var(--document-border);border-radius:12px;padding:16px;background:var(--document-panel-bg);font-family:ui-sans-serif,system-ui,sans-serif}.document-metadata section,.document-metadata dl{display:flex;flex-direction:column;gap:8px;margin:0}.document-metadata h2{margin:0;border-bottom:1px solid var(--document-border);padding-bottom:5px;color:var(--document-muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}.document-metadata-item{min-width:0}.document-metadata-item dt{color:var(--document-muted);font-size:10px}.document-metadata-item dd{margin:2px 0 0;overflow-wrap:anywhere;font-size:12px}.document-warning{border:1px solid #f59e0b;border-radius:999px;padding:4px 10px;color:#92400e;font-size:12px;white-space:nowrap}.document-error{box-sizing:border-box;width:min(640px,calc(100% - 40px));margin:80px auto;border:1px solid var(--document-border);border-radius:12px;padding:24px;font-family:ui-sans-serif,system-ui,sans-serif}.document-error h1{margin:0;font-size:20px}.document-error p{margin:8px 0 0;color:var(--document-muted)}@media (max-width: 800px){.document-header{align-items:flex-start;flex-wrap:wrap}.document-actions{width:100%;justify-content:flex-start;margin-left:0}.document-content{grid-template-columns:minmax(0,1fr)}.document-metadata{position:static;order:-1}}@media print{.document-header{position:static}.document-actions{display:none}.document-content{display:block}.document-metadata{position:static;margin-bottom:16px;break-inside:avoid}}
    </style>
    <!--
      Latches a stylesheet failure before the <link> is parsed: Chromium
      parser-blocks the body script on a pending stylesheet, so a CSS failure
      that settles first would otherwise reach no listener. Records only \u2014
      document.body does not exist yet here, so the body script acts on it.
    -->
    <script nonce="__EXPORT_NONCE__">
      window.addEventListener(
        'error',
        function (event) {
          if (event.target && event.target.id === 'transcript-stylesheet') {
            window.__transcriptStyleFailed = true;
          }
        },
        true,
      );
    </script>
    <link
      rel="stylesheet"
      nonce="__EXPORT_NONCE__"
      id="transcript-stylesheet"
      integrity="sha384-chfuqgBOvc0FPuVSA81iD1B1qLfXhqKxPmEhPZuyrxWeBUeVcq5yIhWYpVXsASzI"
      crossorigin="anonymous"
      href="https://unpkg.com/@qwen-code/qwen-code@0.24.0/export-transcript-document.css"
    />
  </head>
  <body>
    <div id="app"></div>
    <script
      nonce="__EXPORT_NONCE__"
      id="transcript-document"
      type="application/json"
    ></script>
    <script nonce="__EXPORT_NONCE__">
      (function () {
        var showLoadError = function () {
          if (document.body.dataset.renderComplete) return;
          document.body.dataset.renderComplete = 'error';
          var app = document.getElementById('app');
          app.setAttribute('role', 'alert');
          app.textContent =
            'Unable to load this chat export. This Qwen Code build may not have a published renderer or stylesheet yet; also check your network connection.';
        };
        var createElement = document.createElement.bind(document);
        document.createElement = function (name, options) {
          var element = createElement(name, options);
          if (String(name).toLowerCase() === 'style') {
            element.setAttribute('nonce', '__EXPORT_NONCE__');
          }
          return element;
        };
        window.addEventListener(
          'error',
          function (event) {
            if (
              event.target === window ||
              (event.target &&
                (event.target.id === 'transcript-renderer' ||
                  event.target.id === 'transcript-stylesheet'))
            ) {
              showLoadError();
            }
          },
          true,
        );
        window.addEventListener('unhandledrejection', showLoadError);
        // A stylesheet failure that settles while the parser is still blocked on
        // the <link> is dispatched before the listener above exists, so the
        // <head> latch is the only record of it.
        if (window.__transcriptStyleFailed) {
          showLoadError();
        }
      })();
    </script>
    <script
      nonce="__EXPORT_NONCE__"
      id="transcript-renderer"
      integrity="sha384-KPM9XEqlUwJhJZqYO8njOjQ0e3ahyyp4nZAP4eWq5TQmAnElhZwIw1K053UHOCWI"
      crossorigin="anonymous"
      src="https://unpkg.com/@qwen-code/qwen-code@0.24.0/export-transcript-document.js"
    ></script>
  </body>
</html>
`;
var EXPORT_TRANSCRIPT_RENDERER_VERSION = "0.24.0+a0c1f8f3220b79b6";
var EXPORT_TRANSCRIPT_RENDERER_LIMITS = Object.freeze({
  maxBlocks: 1e3,
  maxEnvelopeBytes: 33554432
});

// packages/cli/src/ui/utils/export/export-transcript-document.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/transcript.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/ui/chat-record-transcript.ts
init_esbuild_shims();

// packages/acp-bridge/dist/transcript-replay.js
init_esbuild_shims();

// packages/acp-bridge/dist/bridgeTypes.js
init_esbuild_shims();
function parseBackgroundNotificationTurn2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return void 0;
  const record = value;
  const { turnId, taskId, kind, startedAt } = record;
  if (typeof turnId !== "string" || !turnId || turnId.length > 256 || typeof taskId !== "string" || !taskId || taskId.length > 256 || kind !== "agent" && kind !== "monitor" && kind !== "shell" && kind !== "workflow" || typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0)
    return void 0;
  for (const key of ["toolUseId", "sourceTurnId", "label"]) {
    if (record[key] !== void 0 && (typeof record[key] !== "string" || record[key].length > 4096))
      return void 0;
  }
  return {
    turnId,
    taskId,
    kind,
    startedAt,
    ...record["toolUseId"] !== void 0 ? { toolUseId: record["toolUseId"] } : {},
    ...record["sourceTurnId"] !== void 0 ? { sourceTurnId: record["sourceTurnId"] } : {},
    ...record["label"] !== void 0 ? { label: record["label"] } : {}
  };
}
__name(parseBackgroundNotificationTurn2, "parseBackgroundNotificationTurn");
var LOAD_REPLAY_MAX_BYTES = 32 * 1024 * 1024;
var MAX_TRUSTED_MODEL_PROMPT_CHARS = 64 * 1024;

// packages/acp-bridge/dist/transcript-replay.js
var MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE2 = "Tool result missing from saved history; the previous run likely ended before this tool completed.";
var MAX_RESULT_PREVIEW_TEXT_LENGTH2 = 1e5;
var TRANSCRIPT_GOAL_STATUS_KINDS2 = /* @__PURE__ */ new Set([
  "set",
  "achieved",
  "cleared",
  "failed",
  "aborted",
  // A paused goal is not running, and dropping the card here is not neutral:
  // the replay stream is what feeds the goal renderer, so the older `set` card
  // stays newest and every surface keeps claiming autonomous work is under way.
  // Kept in step with `GOAL_STATUS_KINDS`, which the daemon-side reader
  // (`parseGoalStatusItem`) validates the same on-disk cards against.
  "paused",
  "checking"
]);
function isObjectRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isObjectRecord2, "isObjectRecord");
function replaceTextPartsForDisplay2(parts, displayText) {
  const projected = [];
  let replacedText = false;
  for (const part of parts ?? []) {
    if (isObjectRecord2(part) && typeof part["text"] === "string") {
      if (!replacedText && displayText.length > 0) {
        projected.push({ text: displayText });
      }
      replacedText = true;
    } else {
      projected.push(part);
    }
  }
  if (!replacedText && displayText.length > 0) {
    projected.push({ text: displayText });
  }
  return projected;
}
__name(replaceTextPartsForDisplay2, "replaceTextPartsForDisplay");
function toTranscriptEpochMs2(timestamp) {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : void 0;
  }
  if (typeof timestamp !== "string")
    return void 0;
  const epochMs = new Date(timestamp).getTime();
  return Number.isFinite(epochMs) ? epochMs : void 0;
}
__name(toTranscriptEpochMs2, "toTranscriptEpochMs");
function buildUpdateMeta2(options) {
  const timestamp = toTranscriptEpochMs2(options.timestamp);
  const sourceRecordIds = dedupeStrings2(options.sourceRecordIds ?? []);
  const qwenTranscript = {
    ...sourceRecordIds.length > 0 ? { sourceRecordIds } : {},
    ...options.planToolCallId ? { planToolCallId: options.planToolCallId } : {},
    ...options.resultPreviewText ? { resultPreviewText: options.resultPreviewText } : {}
  };
  const meta = {
    ...options.extra ?? {},
    ...timestamp !== void 0 ? { timestamp } : {},
    ...Object.keys(qwenTranscript).length > 0 ? { qwenTranscript } : {}
  };
  return Object.keys(meta).length > 0 ? meta : void 0;
}
__name(buildUpdateMeta2, "buildUpdateMeta");
function createTranscriptMessageUpdate2(options) {
  const meta = buildUpdateMeta2(options);
  return {
    sessionUpdate: options.role === "user" ? "user_message_chunk" : options.thought ? "agent_thought_chunk" : "agent_message_chunk",
    content: { type: "text", text: options.text },
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptMessageUpdate2, "createTranscriptMessageUpdate");
function createTranscriptImageUpdate2(options) {
  const meta = buildUpdateMeta2(options);
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "image", data: options.data, mimeType: options.mimeType },
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptImageUpdate2, "createTranscriptImageUpdate");
function createTranscriptAttachmentReferenceUpdate2(reference, options) {
  if (reference["type"] !== "image" && reference["type"] !== "resource" || typeof reference["attachmentId"] !== "string" || typeof reference["mimeType"] !== "string" || typeof reference["size"] !== "number") {
    return void 0;
  }
  const meta = buildUpdateMeta2(options);
  return {
    sessionUpdate: "user_message_chunk",
    content: {
      type: reference["type"],
      attachmentId: reference["attachmentId"],
      mimeType: reference["mimeType"],
      size: reference["size"]
    },
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptAttachmentReferenceUpdate2, "createTranscriptAttachmentReferenceUpdate");
function createTranscriptUsageUpdate2(usageMetadata, options = {}) {
  const usage = {
    inputTokens: finiteNumber2(usageMetadata.promptTokenCount) ?? 0,
    outputTokens: finiteNumber2(usageMetadata.candidatesTokenCount) ?? 0,
    totalTokens: finiteNumber2(usageMetadata.totalTokenCount) ?? 0,
    ...finiteNumber2(usageMetadata.thoughtsTokenCount) !== void 0 ? { thoughtTokens: finiteNumber2(usageMetadata.thoughtsTokenCount) } : {},
    ...finiteNumber2(usageMetadata.cachedContentTokenCount) !== void 0 ? {
      cachedReadTokens: finiteNumber2(usageMetadata.cachedContentTokenCount)
    } : {}
  };
  const meta = buildUpdateMeta2({
    ...options,
    extra: { usage, ...options.extra ?? {} }
  });
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: options.text ?? "" },
    _meta: meta
  };
}
__name(createTranscriptUsageUpdate2, "createTranscriptUsageUpdate");
function createTranscriptToolCallStartUpdate2(options) {
  const provenance = resolveToolProvenance2(options.toolName);
  return {
    sessionUpdate: options.asUpdate ? "tool_call_update" : "tool_call",
    toolCallId: options.callId,
    status: options.status ?? "pending",
    title: options.metadata.title,
    content: [],
    locations: [...options.metadata.locations],
    kind: options.metadata.kind,
    rawInput: options.args ?? {},
    _meta: buildUpdateMeta2({
      ...options,
      extra: {
        toolName: options.toolName,
        provenance: provenance.provenance,
        ...provenance.serverId ? { serverId: provenance.serverId } : {},
        ...options.extra ?? {}
      }
    })
  };
}
__name(createTranscriptToolCallStartUpdate2, "createTranscriptToolCallStartUpdate");
function createTranscriptToolCallResultUpdate2(options) {
  const provenance = resolveToolProvenance2(options.toolName);
  const content3 = buildToolResultContent2(options);
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: options.callId,
    status: options.success ? "completed" : "failed",
    content: content3,
    _meta: buildUpdateMeta2({
      ...options,
      resultPreviewText: getToolContentText2(options.contentPrefix),
      extra: {
        toolName: options.toolName,
        provenance: provenance.provenance,
        ...provenance.serverId ? { serverId: provenance.serverId } : {},
        ...options.artifacts && options.artifacts.length > 0 ? { artifacts: options.artifacts } : {},
        ...options.extra ?? {}
      }
    })
  };
  const rawOutput = getReplayRawOutput2(options.resultDisplay);
  if (rawOutput !== void 0)
    update["rawOutput"] = rawOutput;
  return update;
}
__name(createTranscriptToolCallResultUpdate2, "createTranscriptToolCallResultUpdate");
function getToolContentText2(content3) {
  let text5 = "";
  for (const entry of content3 ?? []) {
    if (entry.type !== "content" || entry.content.type !== "text")
      continue;
    const next = entry.content.text;
    if (text5.length + (text5 ? 1 : 0) + next.length > MAX_RESULT_PREVIEW_TEXT_LENGTH2) {
      return void 0;
    }
    text5 += `${text5 ? "\n" : ""}${next}`;
  }
  return text5 || void 0;
}
__name(getToolContentText2, "getToolContentText");
function getReplayRawOutput2(resultDisplay) {
  if (!isTruncatedSessionDiffDisplay2(resultDisplay))
    return resultDisplay;
  if (resultDisplay["fileDiffTruncated"] === true || typeof resultDisplay["fileDiff"] !== "string") {
    return void 0;
  }
  return {
    fileName: resultDisplay["fileName"],
    fileDiff: resultDisplay["fileDiff"]
  };
}
__name(getReplayRawOutput2, "getReplayRawOutput");
function createTranscriptPlanUpdate2(todos, cumulativeUsage, options = {}) {
  const meta = buildUpdateMeta2({
    ...options,
    extra: {
      ...cumulativeUsage ? { stats: { ...cumulativeUsage } } : {},
      ...options.todoPlanId ? { qwenTodoPlan: { id: options.todoPlanId } } : {},
      ...options.extra ?? {}
    }
  });
  return {
    sessionUpdate: "plan",
    entries: todos.map((todo) => ({
      content: todo.content,
      priority: "medium",
      status: todo.status,
      ...todo.id || todo.blockedBy ? {
        _meta: {
          qwenTodo: {
            ...todo.id ? { id: todo.id } : {},
            ...todo.blockedBy ? { blockedBy: [...todo.blockedBy] } : {}
          }
        }
      } : {}
    })),
    ...meta ? { _meta: meta } : {}
  };
}
__name(createTranscriptPlanUpdate2, "createTranscriptPlanUpdate");
function extractTranscriptTodoPlan2(resultDisplay, args) {
  const fromDisplay = extractTodoPlanFromDisplay2(resultDisplay);
  if (fromDisplay)
    return fromDisplay;
  if (resultDisplay !== null && resultDisplay !== void 0)
    return null;
  return args && Array.isArray(args["todos"]) ? { todos: normalizeTodos2(args["todos"]) } : null;
}
__name(extractTranscriptTodoPlan2, "extractTranscriptTodoPlan");
function createTranscriptReplayMachine2(options = {}) {
  return new DefaultTranscriptReplayMachine2(options);
}
__name(createTranscriptReplayMachine2, "createTranscriptReplayMachine");
var DefaultTranscriptReplayMachine2 = class {
  static {
    __name(this, "DefaultTranscriptReplayMachine");
  }
  options;
  pendingToolCalls = /* @__PURE__ */ new Map();
  usedToolCallIds = /* @__PURE__ */ new Set();
  gapByChild = /* @__PURE__ */ new Map();
  usage;
  finalized = false;
  goalState;
  goalCause;
  constructor(options) {
    this.options = options;
    const initialState = parseInitialState2(options.initialState, options.onDiagnostic);
    this.usage = { ...initialState.cumulativeUsage };
    this.goalState = initialState.goalState;
    this.goalCause = initialState.goalCause;
    for (const pending of initialState.pendingToolCalls) {
      this.pendingToolCalls.set(pending.callId, pending);
      this.usedToolCallIds.add(pending.callId);
    }
    for (const gap of options.gaps ?? []) {
      if (!this.gapByChild.has(gap.childUuid)) {
        this.gapByChild.set(gap.childUuid, gap);
      }
    }
  }
  *project(record) {
    if (this.finalized) {
      throw new Error("Cannot project records after transcript replay finalize.");
    }
    let ordinal = 0;
    let activeSegmentLane;
    let activeSegmentId;
    const backgroundTurn = parseBackgroundNotificationTurn2(record.subtype === "background_task_completed" ? void 0 : record["backgroundTurn"]);
    const emit = /* @__PURE__ */ __name((update) => {
      if (backgroundTurn)
        update = { ...update, _meta: { ...update._meta, backgroundTurn } };
      const emissionOrdinal = ordinal++;
      const lane = transcriptSegmentLane2(update);
      if (lane && (lane !== activeSegmentLane || !activeSegmentId)) {
        activeSegmentLane = lane;
        activeSegmentId = `${record.uuid}:${emissionOrdinal}`;
      } else if (!lane && isTranscriptSegmentBoundary2(update)) {
        activeSegmentLane = void 0;
        activeSegmentId = void 0;
      }
      const projectedUpdate = lane && activeSegmentId ? withTranscriptSegmentId2(update, activeSegmentId) : update;
      if (isTranscriptDiscreteMessage2(update)) {
        activeSegmentLane = void 0;
        activeSegmentId = void 0;
      }
      return {
        sourceRecordId: record.uuid,
        ...record.timestamp ? { sourceTimestamp: record.timestamp } : {},
        emissionOrdinal,
        update: projectedUpdate
      };
    }, "emit");
    const meta = {
      timestamp: record.timestamp,
      sourceRecordIds: [record.uuid],
      ...record.subtype === "realtime_message" ? {
        extra: {
          source: "realtime_voice",
          qwenDiscreteMessage: true
        }
      } : {}
    };
    const gap = this.gapByChild.get(record.uuid);
    if (gap) {
      yield emit(createTranscriptMessageUpdate2({
        role: "assistant",
        text: this.formatGap(gap),
        ...meta,
        extra: { qwenDiscreteMessage: true }
      }));
    }
    switch (record.type) {
      case "user":
        yield* this.projectUserRecord(record, emit, meta);
        break;
      case "assistant":
        yield* this.projectAssistantRecord(record, emit, meta);
        break;
      case "tool_result":
        yield* this.projectToolResult(record, emit, meta);
        break;
      case "system":
        yield* this.projectSystemRecord(record, emit, meta);
        break;
      default:
        this.report("unknown_record_or_part", "Skipped an unknown transcript record type.", record.uuid);
    }
  }
  *finalize() {
    if (this.finalized)
      return;
    this.finalized = true;
    const skip = this.options.skipFinalizeCallIds;
    let ordinal = 0;
    for (const pending of [...this.pendingToolCalls.values()]) {
      if (skip && (skip.has(pending.callId) || pending.rawCallId !== void 0 && skip.has(pending.rawCallId)))
        continue;
      this.pendingToolCalls.delete(pending.callId);
      this.report("missing_tool_result", "A transcript tool call has no persisted result.", pending.sourceRecordId);
      yield {
        sourceRecordId: pending.sourceRecordId,
        ...pending.sourceTimestamp ? { sourceTimestamp: pending.sourceTimestamp } : {},
        emissionOrdinal: ordinal++,
        update: createTranscriptToolCallResultUpdate2({
          toolName: pending.toolName,
          callId: pending.callId,
          success: false,
          errorMessage: MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE2,
          timestamp: pending.sourceTimestamp,
          sourceRecordIds: [pending.sourceRecordId]
        })
      };
    }
  }
  snapshot() {
    return {
      v: 1,
      pendingToolCalls: [...this.pendingToolCalls.values()].map((pending) => ({
        ...pending
      })),
      cumulativeUsage: { ...this.usage },
      ...this.goalState ? { goalState: this.goalState } : {},
      ...this.goalCause ? { goalCause: this.goalCause } : {}
    };
  }
  *projectUserRecord(record, emit, meta) {
    const userMeta = typeof record.daemonPromptId === "string" && record.daemonPromptId.trim().length > 0 ? { ...meta, extra: { ...meta.extra, promptId: record.daemonPromptId } } : meta;
    const payload = isObjectRecord2(record.systemPayload) ? record.systemPayload : void 0;
    const replayMeta = record.subtype === "mid_turn_user_message" ? {
      ...userMeta,
      extra: {
        ...userMeta.extra,
        source: "mid_turn_message_injected",
        qwenDiscreteMessage: true
      }
    } : userMeta;
    if (record.subtype === "goal_runtime" || record.subtype === "notification" || record.subtype === "cron" || record.subtype === "mid_turn_user_message") {
      const displayText = payload && typeof payload["displayText"] === "string" ? stripGeneratedAttachmentTokens(payload["displayText"], payload) : void 0;
      if (record.subtype === "mid_turn_user_message" && displayText === "") {
        const media = [
          ...this.projectUserAttachmentReferences(payload, emit, replayMeta)
        ];
        if (media.length > 0) {
          yield* media;
          return;
        }
      }
      if (displayText) {
        const isNotification = record.subtype === "notification";
        const backgroundTask = payload && isObjectRecord2(payload["backgroundTask"]) ? payload["backgroundTask"] : void 0;
        yield emit(createTranscriptMessageUpdate2({
          role: "user",
          text: displayText,
          ...replayMeta,
          ...isNotification ? {
            extra: {
              source: "background_notification",
              qwenDiscreteMessage: true,
              ...backgroundTask ? { backgroundTask } : {}
            }
          } : record.subtype === "cron" ? { extra: { source: "cron" } } : {}
        }));
        yield* this.projectUserAttachmentReferences(payload, emit, replayMeta);
        return;
      }
      if (record.subtype !== "mid_turn_user_message")
        return;
    }
    const projection = projectUserTranscriptForDisplay(record);
    if (projection.displayText !== void 0) {
      const displayText = stripGeneratedAttachmentTokens(projection.displayText, payload);
      yield* this.projectMessageParts(record, "user", emit, replayMeta, void 0, replaceTextPartsForDisplay2(record.message?.parts, displayText));
      yield* this.projectUserAttachmentReferences(payload, emit, replayMeta);
      return;
    }
    yield* this.projectMessageParts(record, "user", emit, replayMeta, void 0, projection.parts);
    yield* this.projectUserAttachmentReferences(payload, emit, replayMeta);
  }
  *projectUserAttachmentReferences(payload, emit, meta) {
    const references = payload?.["attachmentReferences"];
    for (const reference of Array.isArray(references) ? references : []) {
      if (!isObjectRecord2(reference))
        continue;
      const update = createTranscriptAttachmentReferenceUpdate2(reference, meta);
      if (update)
        yield emit(update);
    }
    const resourceLinks = payload?.["resourceLinks"];
    for (const link2 of Array.isArray(resourceLinks) ? resourceLinks : []) {
      if (!isObjectRecord2(link2) || link2["type"] !== "resource_link" || typeof link2["uri"] !== "string" || link2["uri"].length === 0 || typeof link2["name"] !== "string") {
        continue;
      }
      const updateMeta = buildUpdateMeta2(meta);
      yield emit({
        sessionUpdate: "user_message_chunk",
        content: structuredClone(link2),
        ...updateMeta ? { _meta: updateMeta } : {}
      });
    }
  }
  *projectAssistantRecord(record, emit, meta) {
    const usageMetadata = isObjectRecord2(record.usageMetadata) ? record.usageMetadata : void 0;
    let usageEmitted = false;
    const takeUsageUpdate = /* @__PURE__ */ __name(() => {
      if (!usageMetadata || usageEmitted)
        return void 0;
      usageEmitted = true;
      this.addUsage(usageMetadata);
      return createTranscriptUsageUpdate2(usageMetadata, meta);
    }, "takeUsageUpdate");
    yield* this.projectMessageParts(record, "assistant", emit, meta, takeUsageUpdate);
    const trailingUsage = takeUsageUpdate();
    if (trailingUsage)
      yield emit(trailingUsage);
  }
  *projectMessageParts(record, role, emit, meta, beforeToolCall, partsOverride) {
    const parts = partsOverride ?? record.message?.parts;
    if (!parts)
      return;
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if (!isObjectRecord2(part)) {
        this.report("malformed_part", "Skipped a malformed transcript message part.", record.uuid, `message.parts[${partIndex}]`);
        continue;
      }
      let recognized = false;
      if (typeof part["text"] === "string" && part["text"].length > 0) {
        recognized = true;
        yield emit(createTranscriptMessageUpdate2({
          role,
          text: part["text"],
          thought: role === "assistant" && part["thought"] === true,
          ...meta
        }));
      }
      const inlineData = isObjectRecord2(part["inlineData"]) ? part["inlineData"] : void 0;
      if (inlineData) {
        recognized = true;
        const data = inlineData["data"];
        const mimeType = inlineData["mimeType"];
        if (role === "user" && typeof data === "string" && typeof mimeType === "string" && mimeType.startsWith("image/")) {
          yield emit(createTranscriptImageUpdate2({ data, mimeType, ...meta }));
        } else {
          this.report("malformed_part", "Skipped an unsupported or malformed inline transcript part.", record.uuid, `message.parts[${partIndex}].inlineData`);
        }
      }
      const functionCall = isObjectRecord2(part["functionCall"]) ? part["functionCall"] : void 0;
      if (functionCall) {
        recognized = true;
        const toolName = typeof functionCall["name"] === "string" ? functionCall["name"] : "";
        const args = isObjectRecord2(functionCall["args"]) ? functionCall["args"] : {};
        if (!toolName) {
          this.report("malformed_part", "Skipped a tool call without a tool name.", record.uuid, `message.parts[${partIndex}].functionCall`);
          continue;
        }
        const preToolUpdate = beforeToolCall?.();
        if (preToolUpdate)
          yield emit(preToolUpdate);
        if (toolName === "todo_write")
          continue;
        const explicitId = typeof functionCall["id"] === "string" && functionCall["id"].length > 0 ? functionCall["id"] : void 0;
        const callId = this.allocateToolCallId(explicitId ?? `qwen-replay-tool:${record.uuid}:${partIndex}`);
        const update = createTranscriptToolCallStartUpdate2({
          toolName,
          callId,
          args,
          status: "in_progress",
          metadata: this.resolveToolMetadata(toolName, args, record.uuid),
          ...meta
        });
        yield emit(update);
        if (role === "assistant") {
          this.pendingToolCalls.set(callId, {
            callId,
            toolName,
            sourceRecordId: record.uuid,
            ...record.timestamp ? { sourceTimestamp: record.timestamp } : {},
            ...explicitId !== void 0 && explicitId !== callId ? { rawCallId: explicitId } : {}
          });
        }
      }
      if (!recognized && !("functionResponse" in part)) {
        this.report("unknown_record_or_part", "Skipped an unknown transcript message part.", record.uuid, `message.parts[${partIndex}]`);
      }
    }
  }
  *projectToolResult(record, emit, meta) {
    const result = isObjectRecord2(record.toolCallResult) ? record.toolCallResult : void 0;
    const toolName = extractToolName2(record);
    if (!toolName) {
      this.report("malformed_part", "A transcript tool result has no tool name.", record.uuid, "message.parts");
    }
    const explicitCallId = extractToolResultCallId2(record, result);
    const callId = explicitCallId ? this.allocateToolCallId(explicitCallId, true) : this.correlateResultCallId(toolName, record.uuid);
    this.pendingToolCalls.delete(callId);
    const resultDisplay = result?.["resultDisplay"];
    if (toolName === "todo_write") {
      const plan = extractTranscriptTodoPlan2(resultDisplay);
      if (plan) {
        yield emit(createTranscriptPlanUpdate2(plan.todos, this.usage, {
          ...meta,
          planToolCallId: callId,
          todoPlanId: plan.planId,
          ...plan.sessionWorkflow ? {
            extra: {
              ...meta.extra,
              qwenSessionWorkflow: true
            }
          } : {}
        }));
      }
      return;
    }
    yield emit(createTranscriptToolCallResultUpdate2({
      toolName,
      callId,
      success: result?.["status"] === void 0 ? !result?.["error"] : result["status"] === "success" && !result["error"],
      errorMessage: extractErrorMessage2(result?.["error"]),
      message: record.message?.parts,
      resultDisplay,
      artifacts: Array.isArray(result?.["artifacts"]) ? result["artifacts"] : void 0,
      contentPrefix: this.buildToolResultContentPrefix(resultDisplay, record.uuid),
      ...meta
    }));
    if (isTaskExecutionDisplay2(resultDisplay)) {
      const usage = usageFromTaskExecution2(resultDisplay);
      if (Object.keys(usage).length > 0) {
        this.addUsage(usage);
        yield emit(createTranscriptUsageUpdate2(usage, {
          ...meta,
          extra: { ...meta.extra, parentToolCallId: callId }
        }));
      }
    }
  }
  *projectSystemRecord(record, emit, meta) {
    if (record.subtype === "turn_result") {
      const payload2 = isObjectRecord2(record.systemPayload) ? record.systemPayload : void 0;
      const cancelledAt = finiteNumber2(payload2?.["cancelledAt"]);
      const startedAt = finiteNumber2(payload2?.["startedAt"]);
      const promptId = payload2?.["promptId"];
      if (payload2?.["state"] !== "cancelled" || cancelledAt === void 0 || typeof promptId !== "string" || !promptId || payload2["startedAt"] !== void 0 && startedAt === void 0)
        return;
      const elapsedMs = Math.max(0, cancelledAt - (startedAt ?? cancelledAt));
      if (!Number.isFinite(elapsedMs))
        return;
      yield emit(createTranscriptMessageUpdate2({
        role: "assistant",
        text: "",
        ...meta,
        extra: {
          qwenDiscreteMessage: true,
          promptCancelled: { promptId, cancelledAt, elapsedMs }
        }
      }));
      return;
    }
    if (record.subtype === "background_task_completed") {
      const payload2 = isObjectRecord2(record.systemPayload) ? record.systemPayload : void 0;
      if (!payload2 || typeof payload2["displayText"] !== "string")
        return;
      yield emit(createTranscriptMessageUpdate2({
        role: "assistant",
        text: payload2["displayText"],
        ...meta,
        extra: {
          source: "background_task_completed",
          qwenDiscreteMessage: true,
          ...isObjectRecord2(payload2["backgroundTask"]) ? { backgroundTask: payload2["backgroundTask"] } : {}
        }
      }));
      return;
    }
    if (record.subtype === "agent_session_ready") {
      const payload2 = isObjectRecord2(record.systemPayload) ? record.systemPayload : void 0;
      if (typeof payload2?.["callId"] !== "string" || payload2["callId"].length === 0 || typeof payload2["subagentSessionReady"] !== "boolean") {
        this.report("malformed_agent_session_ready", "Skipped a malformed subagent session readiness record.", record.uuid, "systemPayload");
        return;
      }
      const callId = payload2["callId"];
      if (!this.pendingToolCalls.has(callId)) {
        this.report("orphan_agent_session_ready", "Skipped subagent readiness without a matching pending tool call.", record.uuid, "systemPayload.callId");
        return;
      }
      yield emit({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        _meta: buildUpdateMeta2({
          ...meta,
          extra: {
            subagentSessionReady: payload2["subagentSessionReady"]
          }
        })
      });
      return;
    }
    if (record.subtype === "goal_state") {
      const payload2 = parseGoalStateRecordPayloadV2(record.systemPayload);
      if (!payload2) {
        this.report("malformed_goal_state", "Skipped a malformed Goal state transcript record.", record.uuid, "systemPayload");
        return;
      }
      const bookkeepingOnly = isGoalCheckpointBookkeepingRecord({
        cause: payload2.cause,
        previousCause: this.goalCause,
        previous: this.goalState,
        next: payload2.snapshot
      });
      const projection = projectGoalStateToLegacy(payload2, this.goalState?.goal ?? null);
      const goalControlCommand = projectGoalControlCommand2(payload2.cause, payload2.snapshot);
      this.goalState = payload2.snapshot;
      this.goalCause = payload2.cause;
      if (bookkeepingOnly)
        return;
      if (goalControlCommand) {
        yield emit(createTranscriptMessageUpdate2({
          role: "user",
          text: goalControlCommand,
          ...meta,
          extra: {
            source: "goal_control",
            "qwen.session.recordId": record.uuid
          }
        }));
      }
      const { type: _type, ...goalStatus } = projection.goalStatus;
      yield emit(createTranscriptMessageUpdate2({
        role: "assistant",
        text: "",
        ...meta,
        extra: {
          goalState: payload2.snapshot,
          goalStatus,
          ...projection.goalTerminal ? { goalTerminal: projection.goalTerminal } : {},
          "qwen.session.recordId": record.uuid
        }
      }));
      return;
    }
    if (record.subtype !== "slash_command")
      return;
    const payload = isObjectRecord2(record.systemPayload) ? record.systemPayload : void 0;
    if (payload?.["phase"] !== "result")
      return;
    const items = Array.isArray(payload["outputHistoryItems"]) ? payload["outputHistoryItems"] : [];
    for (const item of items) {
      const goalStatus = parseTranscriptGoalStatus2(item);
      if (goalStatus) {
        if (goalStatus.condition.length === 0) {
          this.report("malformed_part", "Skipped replay of a goal card whose condition is empty.", record.uuid, "systemPayload.outputHistoryItems.goalStatus.condition");
        } else if (goalStatus.kind !== "checking") {
          yield emit(createTranscriptMessageUpdate2({
            role: "assistant",
            text: "",
            ...meta,
            extra: { goalStatus }
          }));
        }
        continue;
      }
      if (!isObjectRecord2(item) || typeof item["text"] !== "string")
        continue;
      yield emit(createTranscriptMessageUpdate2({
        role: "assistant",
        text: item["text"].replace(/\n/g, "  \n"),
        ...meta,
        extra: { source: "slash_command" }
      }));
    }
  }
  addUsage(metadata) {
    this.usage.promptTokens += finiteNumber2(metadata["promptTokenCount"]) ?? 0;
    this.usage.candidateTokens += finiteNumber2(metadata["candidatesTokenCount"]) ?? 0;
    this.usage.cachedTokens += finiteNumber2(metadata["cachedContentTokenCount"]) ?? 0;
  }
  correlateResultCallId(toolName, recordId) {
    const candidates = [...this.pendingToolCalls.values()].filter((pending) => pending.toolName === toolName);
    if (candidates.length === 1)
      return candidates[0].callId;
    this.report("ambiguous_tool_call_correlation", "A tool result could not be matched to exactly one pending tool call.", recordId);
    return this.allocateToolCallId(`qwen-replay-tool:${recordId}:result`);
  }
  allocateToolCallId(candidate, reuse = false) {
    if (reuse && this.pendingToolCalls.has(candidate)) {
      this.usedToolCallIds.add(candidate);
      return candidate;
    }
    if (!this.usedToolCallIds.has(candidate)) {
      this.usedToolCallIds.add(candidate);
      return candidate;
    }
    let occurrence = 2;
    while (this.usedToolCallIds.has(`${candidate}:${occurrence}`)) {
      occurrence += 1;
    }
    const id = `${candidate}:${occurrence}`;
    this.usedToolCallIds.add(id);
    return id;
  }
  resolveToolMetadata(toolName, args, recordId) {
    try {
      return this.options.presentation?.resolveToolMetadata(toolName, args) ?? fallbackToolMetadata2(toolName, args);
    } catch {
      this.report("presentation_fallback", "Tool presentation metadata fell back to deterministic defaults.", recordId, void 0, false);
      return fallbackToolMetadata2(toolName, args);
    }
  }
  formatGap(gap) {
    try {
      return this.options.presentation?.formatHistoryGap(gap) ?? "Some earlier messages are unavailable because the saved history is incomplete.";
    } catch {
      this.report("presentation_fallback", "History gap presentation fell back to deterministic defaults.", gap.childUuid, void 0, false);
      return "Some earlier messages are unavailable because the saved history is incomplete.";
    }
  }
  buildToolResultContentPrefix(resultDisplay, recordId) {
    try {
      return this.options.presentation?.buildToolResultContentPrefix?.(resultDisplay) ?? defaultToolResultContentPrefix2(resultDisplay);
    } catch {
      this.report("presentation_fallback", "Tool result content presentation fell back to deterministic defaults.", recordId, void 0, false);
      return defaultToolResultContentPrefix2(resultDisplay);
    }
  }
  report(code3, message, recordId, path3, affectsCompleteness = true) {
    this.options.onDiagnostic?.({
      code: code3,
      severity: affectsCompleteness ? "warning" : "info",
      message,
      affectsCompleteness,
      ...recordId ? { recordId } : {},
      ...path3 ? { path: path3 } : {}
    });
  }
};
function withTranscriptSegmentId2(update, segmentId) {
  const record = update;
  const meta = isObjectRecord2(record["_meta"]) ? record["_meta"] : void 0;
  const transcript = meta && isObjectRecord2(meta["qwenTranscript"]) ? meta["qwenTranscript"] : void 0;
  return {
    ...record,
    _meta: {
      ...meta ?? {},
      qwenTranscript: {
        ...transcript ?? {},
        segmentId
      }
    }
  };
}
__name(withTranscriptSegmentId2, "withTranscriptSegmentId");
function transcriptSegmentLane2(update) {
  const record = update;
  const kind = record["sessionUpdate"];
  const meta = isObjectRecord2(record["_meta"]) ? record["_meta"] : void 0;
  const parentToolCallId = typeof meta?.["parentToolCallId"] === "string" ? meta["parentToolCallId"] : "root";
  if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content3 = isObjectRecord2(record["content"]) ? record["content"] : void 0;
    const contentType = typeof content3?.["type"] === "string" ? content3["type"] : void 0;
    if (!contentType)
      return void 0;
    if (contentType === "text" && (typeof content3?.["text"] !== "string" || content3["text"].length === 0)) {
      return void 0;
    }
    return `${String(kind)}:${contentType}:${parentToolCallId}`;
  }
  if (kind === "shell_output" || kind === "tool_output") {
    const source = typeof meta?.["source"] === "string" ? meta["source"] : "";
    const stream = typeof record["stream"] === "string" ? record["stream"] : "";
    return `${String(kind)}:${source}:${stream}`;
  }
  return void 0;
}
__name(transcriptSegmentLane2, "transcriptSegmentLane");
function isTranscriptSegmentBoundary2(update) {
  const record = update;
  const kind = record["sessionUpdate"];
  return typeof kind === "string" && kind !== "agent_message_chunk" && kind !== "agent_thought_chunk" && kind !== "user_message_chunk";
}
__name(isTranscriptSegmentBoundary2, "isTranscriptSegmentBoundary");
function isTranscriptDiscreteMessage2(update) {
  const record = update;
  const meta = isObjectRecord2(record["_meta"]) ? record["_meta"] : void 0;
  return meta?.["qwenDiscreteMessage"] === true;
}
__name(isTranscriptDiscreteMessage2, "isTranscriptDiscreteMessage");
function projectGoalControlCommand2(cause, snapshot) {
  switch (cause) {
    case "create":
    case "replace":
      return snapshot.goal ? `/goal ${snapshot.goal.objective}` : void 0;
    case "edit":
      return snapshot.goal ? `/goal edit ${snapshot.goal.objective}` : void 0;
    case "pause":
      return snapshot.goal?.lastReason === void 0 || snapshot.goal.lastReason === GOAL_PAUSE_REASON_COMMAND ? `/goal ${cause}` : void 0;
    case "resume":
    case "clear":
      return `/goal ${cause}`;
    case "turn_finished":
    case "checkpoint":
    case "verifier_accept":
    case "verifier_reject":
    case "complete":
    case "blocked":
    case "usage_limited":
    case "migrated":
      return void 0;
    default:
      return assertNever2(cause);
  }
}
__name(projectGoalControlCommand2, "projectGoalControlCommand");
function assertNever2(value) {
  throw new Error(`Unsupported Goal state cause: ${String(value)}`);
}
__name(assertNever2, "assertNever");
function parseTranscriptGoalStatus2(value) {
  if (!isObjectRecord2(value) || value["type"] !== "goal_status") {
    return void 0;
  }
  const kind = value["kind"];
  const condition = value["condition"];
  if (typeof kind !== "string" || !TRANSCRIPT_GOAL_STATUS_KINDS2.has(kind) || typeof condition !== "string") {
    return void 0;
  }
  const iterations = finiteNumber2(value["iterations"]);
  const setAt = finiteNumber2(value["setAt"]);
  const durationMs = finiteNumber2(value["durationMs"]);
  const lastReason = typeof value["lastReason"] === "string" ? value["lastReason"] : void 0;
  return {
    kind,
    condition,
    ...iterations !== void 0 ? { iterations } : {},
    ...setAt !== void 0 ? { setAt } : {},
    ...durationMs !== void 0 ? { durationMs } : {},
    ...lastReason !== void 0 ? { lastReason } : {}
  };
}
__name(parseTranscriptGoalStatus2, "parseTranscriptGoalStatus");
function defaultToolResultContentPrefix2(resultDisplay) {
  if (!isObjectRecord2(resultDisplay) || resultDisplay["type"] !== "vision_bridge_notice" || typeof resultDisplay["summary"] !== "string" || typeof resultDisplay["notice"] !== "string") {
    return [];
  }
  return [
    {
      type: "content",
      content: {
        type: "text",
        text: `${resultDisplay["summary"]}
${resultDisplay["notice"]}`
      }
    }
  ];
}
__name(defaultToolResultContentPrefix2, "defaultToolResultContentPrefix");
function parseInitialState2(value, onDiagnostic) {
  const empty2 = {
    v: 1,
    pendingToolCalls: [],
    cumulativeUsage: emptyUsage2()
  };
  if (value === void 0)
    return empty2;
  if (!isObjectRecord2(value)) {
    throw new TypeError("Invalid transcript replay state.");
  }
  if ("v" in value && value["v"] !== 1) {
    throw new TypeError("Unsupported transcript replay state version.");
  }
  const rawPending = Array.isArray(value["pendingToolCalls"]) ? value["pendingToolCalls"] : [];
  const pendingToolCalls = rawPending.flatMap((pending) => {
    if (!isObjectRecord2(pending) || typeof pending["callId"] !== "string" || typeof pending["toolName"] !== "string" || typeof pending["sourceRecordId"] !== "string") {
      onDiagnostic?.({
        code: "invalid_replay_state",
        severity: "warning",
        message: "Dropped a malformed pending tool call from replay state.",
        affectsCompleteness: true
      });
      return [];
    }
    return [
      {
        callId: pending["callId"],
        toolName: pending["toolName"],
        sourceRecordId: pending["sourceRecordId"],
        ...typeof pending["sourceTimestamp"] === "string" ? { sourceTimestamp: pending["sourceTimestamp"] } : {}
      }
    ];
  });
  const rawUsage = value.cumulativeUsage;
  const usage = isObjectRecord2(rawUsage) ? rawUsage : {};
  const validUsage = finiteNumber2(usage["promptTokens"]) !== void 0 && finiteNumber2(usage["cachedTokens"]) !== void 0 && finiteNumber2(usage["candidateTokens"]) !== void 0 && finiteNumber2(usage["apiTimeMs"]) !== void 0;
  if (!validUsage) {
    onDiagnostic?.({
      code: "invalid_replay_state",
      severity: "warning",
      message: "Reset invalid cumulative usage in transcript replay state.",
      affectsCompleteness: true
    });
  }
  const rawGoalState = value["goalState"];
  const goalState = rawGoalState === void 0 ? void 0 : parseGoalSnapshotV2(rawGoalState);
  if (rawGoalState !== void 0 && !goalState) {
    onDiagnostic?.({
      code: "invalid_replay_state",
      severity: "warning",
      message: "Dropped a malformed Goal state from replay state.",
      affectsCompleteness: true
    });
  }
  const rawGoalCause = value["goalCause"];
  const goalCause = rawGoalCause === void 0 ? void 0 : parseGoalStateCause(rawGoalCause);
  if (rawGoalCause !== void 0 && !goalCause) {
    onDiagnostic?.({
      code: "invalid_replay_state",
      severity: "warning",
      message: "Dropped a malformed Goal cause from replay state.",
      affectsCompleteness: true
    });
  }
  return {
    v: 1,
    pendingToolCalls,
    cumulativeUsage: validUsage ? {
      promptTokens: usage["promptTokens"],
      cachedTokens: usage["cachedTokens"],
      candidateTokens: usage["candidateTokens"],
      apiTimeMs: usage["apiTimeMs"]
    } : emptyUsage2(),
    ...goalState ? { goalState } : {},
    ...goalCause ? { goalCause } : {}
  };
}
__name(parseInitialState2, "parseInitialState");
function emptyUsage2() {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    candidateTokens: 0,
    apiTimeMs: 0
  };
}
__name(emptyUsage2, "emptyUsage");
function fallbackToolMetadata2(toolName, args) {
  const description = typeof args["description"] === "string" ? args["description"].trim() : "";
  return {
    title: description ? `${toolName}: ${description}` : toolName,
    locations: [],
    kind: "other"
  };
}
__name(fallbackToolMetadata2, "fallbackToolMetadata");
function resolveToolProvenance2(toolName) {
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    if (parts.length >= 3 && parts[1]) {
      return { provenance: "mcp", serverId: parts[1] };
    }
  }
  return { provenance: "builtin" };
}
__name(resolveToolProvenance2, "resolveToolProvenance");
function buildToolResultContent2(options) {
  const prefix = [...options.contentPrefix ?? []];
  const diff = extractDiffContent3(options.resultDisplay);
  if (diff)
    return [...prefix, diff];
  if (options.errorMessage) {
    return [
      ...prefix,
      {
        type: "content",
        content: { type: "text", text: options.errorMessage }
      }
    ];
  }
  const content3 = [...prefix];
  for (const part of options.message ?? []) {
    if (!isObjectRecord2(part))
      continue;
    if (typeof part["text"] === "string" && part["text"]) {
      content3.push({
        type: "content",
        content: { type: "text", text: part["text"] }
      });
    }
    const response = isObjectRecord2(part["functionResponse"]) ? part["functionResponse"] : void 0;
    const payload = response && isObjectRecord2(response["response"]) ? response["response"] : void 0;
    if (!payload)
      continue;
    try {
      const output = payload["output"];
      const error = payload["error"];
      const text5 = typeof output === "string" ? output : typeof error === "string" ? error : JSON.stringify(payload);
      content3.push({
        type: "content",
        content: { type: "text", text: text5 }
      });
    } catch {
    }
  }
  return content3;
}
__name(buildToolResultContent2, "buildToolResultContent");
function extractDiffContent3(resultDisplay) {
  if (!isObjectRecord2(resultDisplay))
    return null;
  if (!("fileName" in resultDisplay) || !("newContent" in resultDisplay)) {
    return null;
  }
  if (isTruncatedSessionDiffDisplay2(resultDisplay)) {
    return {
      type: "content",
      content: {
        type: "text",
        text: buildTruncatedDiffPreviewText3(resultDisplay)
      }
    };
  }
  return {
    type: "diff",
    path: typeof resultDisplay["filePath"] === "string" ? resultDisplay["filePath"] : typeof resultDisplay["fileName"] === "string" ? resultDisplay["fileName"] : "",
    oldText: typeof resultDisplay["originalContent"] === "string" ? resultDisplay["originalContent"] : "",
    newText: typeof resultDisplay["newContent"] === "string" ? resultDisplay["newContent"] : ""
  };
}
__name(extractDiffContent3, "extractDiffContent");
function isTruncatedSessionDiffDisplay2(value) {
  return isObjectRecord2(value) && value["truncatedForSession"] === true && "fileName" in value && "newContent" in value;
}
__name(isTruncatedSessionDiffDisplay2, "isTruncatedSessionDiffDisplay");
function buildTruncatedDiffPreviewText3(display) {
  const fileName = typeof display["fileName"] === "string" ? display["fileName"] : "the edited file";
  const fileDiffLength = typeof display["fileDiffLength"] === "number" ? ` Original fileDiff length: ${display["fileDiffLength"]} chars.` : "";
  return display["fileDiffTruncated"] === true ? `Full diff omitted from saved session history for ${fileName}.${fileDiffLength}` : `Saved session preview only for ${fileName}; full original and new file contents are unavailable.`;
}
__name(buildTruncatedDiffPreviewText3, "buildTruncatedDiffPreviewText");
function extractToolName2(record) {
  for (const part of record.message?.parts ?? []) {
    if (!isObjectRecord2(part) || !isObjectRecord2(part["functionResponse"])) {
      continue;
    }
    const name = part["functionResponse"]["name"];
    if (typeof name === "string")
      return name;
  }
  return "";
}
__name(extractToolName2, "extractToolName");
function extractToolResultCallId2(record, result) {
  if (typeof result?.["callId"] === "string" && result["callId"].length > 0) {
    return result["callId"];
  }
  for (const part of record.message?.parts ?? []) {
    if (!isObjectRecord2(part) || !isObjectRecord2(part["functionResponse"])) {
      continue;
    }
    const id = part["functionResponse"]["id"];
    if (typeof id === "string" && id.length > 0)
      return id;
  }
  return void 0;
}
__name(extractToolResultCallId2, "extractToolResultCallId");
function extractTodoPlanFromDisplay2(value) {
  if (isObjectRecord2(value) && value["type"] === "todo_list") {
    return Array.isArray(value["todos"]) ? {
      ...typeof value["planId"] === "string" ? { planId: value["planId"] } : {},
      ...value["sessionWorkflow"] === true ? { sessionWorkflow: true } : {},
      todos: normalizeTodos2(value["todos"])
    } : null;
  }
  if (typeof value !== "string")
    return null;
  try {
    const parsed = JSON.parse(value);
    return isObjectRecord2(parsed) && parsed["type"] === "todo_list" && Array.isArray(parsed["todos"]) ? {
      ...typeof parsed["planId"] === "string" ? { planId: parsed["planId"] } : {},
      ...parsed["sessionWorkflow"] === true ? { sessionWorkflow: true } : {},
      todos: normalizeTodos2(parsed["todos"])
    } : null;
  } catch {
    return null;
  }
}
__name(extractTodoPlanFromDisplay2, "extractTodoPlanFromDisplay");
function normalizeTodos2(values) {
  return values.flatMap((value) => {
    if (!isObjectRecord2(value) || typeof value["content"] !== "string")
      return [];
    const status = value["status"];
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      return [];
    }
    return [
      {
        ...typeof value["id"] === "string" ? { id: value["id"] } : {},
        content: value["content"],
        status,
        ...Array.isArray(value["blockedBy"]) && value["blockedBy"].every((dependency) => typeof dependency === "string") ? { blockedBy: value["blockedBy"] } : {}
      }
    ];
  });
}
__name(normalizeTodos2, "normalizeTodos");
function isTaskExecutionDisplay2(value) {
  return isObjectRecord2(value) && value["type"] === "task_execution";
}
__name(isTaskExecutionDisplay2, "isTaskExecutionDisplay");
function usageFromTaskExecution2(display) {
  const summary = isObjectRecord2(display["executionSummary"]) ? display["executionSummary"] : void 0;
  if (!summary)
    return {};
  return {
    ...finiteNumber2(summary["inputTokens"]) !== void 0 ? { promptTokenCount: summary["inputTokens"] } : {},
    ...finiteNumber2(summary["outputTokens"]) !== void 0 ? { candidatesTokenCount: summary["outputTokens"] } : {},
    ...finiteNumber2(summary["thoughtTokens"]) !== void 0 ? { thoughtsTokenCount: summary["thoughtTokens"] } : {},
    ...finiteNumber2(summary["cachedTokens"]) !== void 0 ? { cachedContentTokenCount: summary["cachedTokens"] } : {},
    ...finiteNumber2(summary["totalTokens"]) !== void 0 ? { totalTokenCount: summary["totalTokens"] } : {}
  };
}
__name(usageFromTaskExecution2, "usageFromTaskExecution");
function finiteNumber2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
__name(finiteNumber2, "finiteNumber");
function extractErrorMessage2(value) {
  if (value instanceof Error)
    return value.message;
  if (!isObjectRecord2(value))
    return void 0;
  return typeof value["message"] === "string" ? value["message"] : void 0;
}
__name(extractErrorMessage2, "extractErrorMessage");
function dedupeStrings2(values) {
  return [...new Set(values.filter((value) => value.length > 0))];
}
__name(dedupeStrings2, "dedupeStrings");

// packages/sdk-typescript/src/daemon/ui/chat-record-transcript.ts
var TranscriptProjectionInputError = class extends TypeError {
  constructor(code3, message) {
    super(message);
    this.code = code3;
    this.name = "TranscriptProjectionInputError";
  }
  static {
    __name(this, "TranscriptProjectionInputError");
  }
};
function projectChatRecordsToDaemonTranscript(records, options = {}) {
  if (!Array.isArray(records)) {
    throw new TranscriptProjectionInputError(
      "invalid_records",
      "Transcript records must be an array."
    );
  }
  if (options.maxBlocks !== void 0 && (!Number.isSafeInteger(options.maxBlocks) || options.maxBlocks <= 0)) {
    throw new TranscriptProjectionInputError(
      "invalid_max_blocks",
      "maxBlocks must be a positive safe integer."
    );
  }
  let prepared;
  try {
    prepared = prepareTranscriptRecords(records, {
      ...options.leafUuid !== void 0 ? { leafUuid: options.leafUuid } : {}
    });
  } catch (error) {
    if (error instanceof TranscriptRecordPreparationError) {
      throw new TranscriptProjectionInputError(error.code, error.message);
    }
    throw error;
  }
  const diagnostics = [
    ...prepared.diagnostics
  ];
  const diagnosticKeys = new Set(
    diagnostics.map((item) => diagnosticKey(item))
  );
  const addDiagnostic = /* @__PURE__ */ __name((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push(diagnostic);
  }, "addDiagnostic");
  const maxBlocks = options.maxBlocks ?? Number.MAX_SAFE_INTEGER;
  let truncated = false;
  let state = createDaemonTranscriptState({
    maxBlocks,
    // Trim-free by bytes: this offline/export projection's only documented
    // truncation knob is `maxBlocks`. The retention byte budget exists for
    // the LIVE session window; applying it here would silently evict older
    // blocks from rendered/exported transcripts whose `maxBlocks` never
    // limited them, and the truncation diagnostic would misname maxBlocks as
    // the cause.
    maxRetainedBytes: Number.POSITIVE_INFINITY,
    now: 0,
    onTruncation: /* @__PURE__ */ __name((detail) => {
      truncated = true;
      addDiagnostic({
        code: detail.kind === "blocks" ? "transcript_blocks_truncated" : "transcript_text_truncated",
        severity: "warning",
        message: detail.kind === "blocks" ? "Older transcript blocks were removed by maxBlocks." : "A transcript text block exceeded the safe character limit.",
        affectsCompleteness: true,
        ...detail.sourceRecordIds?.[0] ? { recordId: detail.sourceRecordIds[0] } : {},
        ...detail.blockId ? { path: `blocks.${detail.blockId}` } : {}
      });
    }, "onTruncation")
  });
  const machine = createTranscriptReplayMachine2({
    gaps: prepared.gaps,
    onDiagnostic: addDiagnostic
  });
  const consume = /* @__PURE__ */ __name((emissions) => {
    for (const emission of emissions) {
      const event = {
        v: 1,
        type: "session_update",
        data: { update: emission.update }
      };
      const uiEvents = normalizeDaemonEvent(event);
      state = reduceDaemonTranscriptEvents(state, uiEvents, {
        maxBlocks,
        now: 0
      });
    }
  }, "consume");
  for (const record of prepared.records) consume(machine.project(record));
  consume(machine.finalize());
  state = finalizeOfflineDaemonTranscriptState(state);
  const complete = !truncated && !diagnostics.some((diagnostic) => diagnostic.affectsCompleteness);
  return {
    blocks: state.blocks,
    diagnostics,
    complete,
    truncated
  };
}
__name(projectChatRecordsToDaemonTranscript, "projectChatRecordsToDaemonTranscript");
function diagnosticKey(diagnostic) {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.recordIndex,
    diagnostic.recordId,
    diagnostic.path
  ]);
}
__name(diagnosticKey, "diagnosticKey");

// packages/cli/src/ui/utils/export/export-transcript-document-v1.schema.json
var export_transcript_document_v1_schema_default = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://qwen-code.invalid/export-transcript-document-v1.schema.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "rendererVersion",
    "blocks",
    "diagnostics",
    "metadata"
  ],
  properties: {
    schemaVersion: { const: 1 },
    rendererVersion: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^([0-9a-f]{64}|(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$"
    },
    blocks: {
      type: "array",
      maxItems: 1e3,
      items: { $ref: "#/$defs/block" }
    },
    diagnostics: {
      type: "array",
      maxItems: 1e3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "count"],
        properties: {
          code: {
            type: "string",
            minLength: 1,
            maxLength: 128
          },
          severity: { enum: ["info", "warning", "error"] },
          count: {
            type: "integer",
            minimum: 0,
            maximum: 9007199254740991
          }
        }
      }
    },
    metadata: { $ref: "#/$defs/metadata" }
  },
  $defs: {
    block: {
      oneOf: [
        { $ref: "#/$defs/userBlock" },
        { $ref: "#/$defs/assistantBlock" },
        { $ref: "#/$defs/thoughtBlock" },
        { $ref: "#/$defs/toolBlock" },
        { $ref: "#/$defs/shellBlock" },
        { $ref: "#/$defs/userShellBlock" },
        { $ref: "#/$defs/permissionBlock" },
        { $ref: "#/$defs/statusBlock" },
        { $ref: "#/$defs/errorBlock" },
        { $ref: "#/$defs/promptCancelledBlock" }
      ]
    },
    userBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "text"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "user" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        text: { type: "string", maxLength: 409600 },
        streaming: { const: false },
        collapsed: { type: "boolean" },
        parentToolCallId: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        images: {
          type: "array",
          maxItems: 1e3,
          items: { $ref: "#/$defs/rasterImage" }
        }
      }
    },
    assistantBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "text"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "assistant" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        text: { type: "string", maxLength: 409600 },
        streaming: { const: false },
        collapsed: { type: "boolean" },
        parentToolCallId: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        images: {
          type: "array",
          maxItems: 1e3,
          items: { $ref: "#/$defs/rasterImage" }
        },
        usage: { $ref: "#/$defs/usage" }
      }
    },
    thoughtBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "text"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "thought" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        text: { type: "string", maxLength: 409600 },
        streaming: { const: false },
        collapsed: { type: "boolean" },
        parentToolCallId: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        images: {
          type: "array",
          maxItems: 1e3,
          items: { $ref: "#/$defs/rasterImage" }
        }
      }
    },
    toolBlock: {
      type: "object",
      additionalProperties: false,
      allOf: [
        {
          if: {
            properties: {
              status: { enum: ["completed", "failed"] }
            },
            required: ["status"]
          },
          then: { required: ["resultPreview"] }
        }
      ],
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "toolCallId",
        "title",
        "status",
        "preview"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "tool" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        toolCallId: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", maxLength: 409600 },
        status: {
          enum: ["completed", "failed", "cancelled", "canceled"]
        },
        background: { type: "boolean" },
        toolName: { type: "string", minLength: 1, maxLength: 200 },
        toolKind: { type: "string", minLength: 1, maxLength: 200 },
        preview: { $ref: "#/$defs/toolPreview" },
        resultPreview: { $ref: "#/$defs/toolResultPreview" },
        parentToolCallId: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        parentBlockId: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        subagentType: {
          type: "string",
          minLength: 1,
          maxLength: 200
        }
      }
    },
    shellBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "text"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "shell" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        text: { type: "string", maxLength: 409600 },
        stream: { enum: ["stdout", "stderr"] }
      }
    },
    userShellBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "text",
        "command"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "user_shell" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        text: { type: "string", maxLength: 409600 },
        command: { type: "string", maxLength: 409600 },
        cwd: { type: "string", maxLength: 400 },
        stream: { enum: ["stdout", "stderr"] }
      }
    },
    permissionBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "requestId",
        "title",
        "options",
        "preview"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "permission" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        requestId: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        title: { type: "string", maxLength: 409600 },
        options: {
          type: "array",
          maxItems: 1e3,
          items: { $ref: "#/$defs/permissionOption" }
        },
        preview: { $ref: "#/$defs/toolPreview" },
        toolCallId: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        toolName: { type: "string", minLength: 1, maxLength: 200 },
        toolKind: { type: "string", minLength: 1, maxLength: 200 },
        resolved: {
          enum: ["approved", "rejected", "cancelled", "expired", "resolved"]
        }
      }
    },
    statusBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "text"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "status" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        text: { type: "string", maxLength: 409600 },
        code: { type: "string", minLength: 1, maxLength: 128 },
        errorKind: {
          enum: [
            "missing_binary",
            "blocked_egress",
            "auth_env_error",
            "init_timeout",
            "restore_timeout",
            "protocol_error",
            "missing_file",
            "parse_error",
            "budget_exhausted",
            "mcp_budget_would_exceed",
            "mcp_server_spawn_failed",
            "invalid_config",
            "prompt_deadline_exceeded",
            "writer_idle_timeout",
            "model_stream_interrupted",
            "loop_detected"
          ]
        },
        source: { type: "string", minLength: 1, maxLength: 128 }
      }
    },
    errorBlock: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "kind",
        "clientReceivedAt",
        "createdAt",
        "updatedAt",
        "text"
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "error" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        text: { type: "string", maxLength: 409600 },
        code: { type: "string", minLength: 1, maxLength: 128 },
        errorKind: {
          enum: [
            "missing_binary",
            "blocked_egress",
            "auth_env_error",
            "init_timeout",
            "restore_timeout",
            "protocol_error",
            "missing_file",
            "parse_error",
            "budget_exhausted",
            "mcp_budget_would_exceed",
            "mcp_server_spawn_failed",
            "invalid_config",
            "prompt_deadline_exceeded",
            "writer_idle_timeout",
            "model_stream_interrupted",
            "loop_detected"
          ]
        },
        source: { type: "string", minLength: 1, maxLength: 128 }
      }
    },
    promptCancelledBlock: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "clientReceivedAt", "createdAt", "updatedAt"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { const: "prompt_cancelled" },
        clientReceivedAt: { const: 0 },
        createdAt: { const: 0 },
        updatedAt: { const: 0 },
        reason: { type: "string", maxLength: 409600 }
      }
    },
    rasterImage: {
      type: "object",
      additionalProperties: false,
      required: ["data", "mimeType"],
      properties: {
        data: {
          type: "string",
          maxLength: 11184812,
          pattern: "^[A-Za-z0-9+/]*={0,2}$"
        },
        mimeType: {
          enum: ["image/png", "image/jpeg", "image/gif", "image/webp"]
        }
      }
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["inputTokens", "outputTokens"],
      properties: {
        inputTokens: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        },
        outputTokens: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        },
        cachedTokens: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        }
      }
    },
    permissionOption: {
      type: "object",
      additionalProperties: false,
      required: ["optionId", "label", "raw"],
      properties: {
        optionId: { type: "string", minLength: 1, maxLength: 200 },
        label: { type: "string", maxLength: 409600 },
        description: { type: "string", maxLength: 409600 },
        raw: { const: null }
      }
    },
    questionOption: {
      type: "object",
      additionalProperties: false,
      required: ["label", "raw"],
      properties: {
        label: { type: "string", maxLength: 409600 },
        description: { type: "string", maxLength: 409600 },
        raw: { const: null }
      }
    },
    question: {
      type: "object",
      additionalProperties: false,
      required: ["question", "options", "raw"],
      properties: {
        header: { type: "string", minLength: 1, maxLength: 200 },
        question: { type: "string", maxLength: 409600 },
        options: {
          type: "array",
          maxItems: 1e3,
          items: { $ref: "#/$defs/questionOption" }
        },
        raw: { const: null }
      }
    },
    todoEntry: {
      type: "object",
      additionalProperties: false,
      required: ["id", "content", "status"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        content: { type: "string", maxLength: 409600 },
        status: { enum: ["pending", "in_progress", "completed"] },
        priority: { enum: ["high", "medium", "low"] },
        blockedBy: {
          type: "array",
          maxItems: 1e3,
          items: { type: "string", minLength: 1, maxLength: 128 }
        }
      }
    },
    todoPreview: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "entries"],
      properties: {
        kind: { const: "todo_list" },
        entries: {
          type: "array",
          maxItems: 1e3,
          items: { $ref: "#/$defs/todoEntry" }
        },
        truncated: { type: "boolean" },
        planId: { type: "string", minLength: 1, maxLength: 128 },
        revision: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        }
      }
    },
    toolPreview: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "questions"],
          properties: {
            kind: { const: "ask_user_question" },
            questions: {
              type: "array",
              maxItems: 1e3,
              items: { $ref: "#/$defs/question" }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "command"],
          properties: {
            kind: { const: "command" },
            command: { type: "string", maxLength: 409600 },
            cwd: { type: "string", maxLength: 400 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path"],
          properties: {
            kind: { const: "file_diff" },
            path: { type: "string", maxLength: 400 },
            oldText: { type: "string", maxLength: 409600 },
            newText: { type: "string", maxLength: 409600 },
            patch: { type: "string", maxLength: 409600 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path"],
          properties: {
            kind: { const: "file_read" },
            path: { type: "string", maxLength: 400 },
            range: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: {
                type: "integer",
                minimum: 0,
                maximum: 9007199254740991
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "url"],
          properties: {
            kind: { const: "web_fetch" },
            url: { type: "string", maxLength: 409600 },
            method: { type: "string", minLength: 1, maxLength: 16 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "serverId", "toolName"],
          properties: {
            kind: { const: "mcp_invocation" },
            serverId: { type: "string", maxLength: 128 },
            toolName: { type: "string", maxLength: 128 },
            argsSummary: { type: "string", maxLength: 409600 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "code"],
          properties: {
            kind: { const: "code_block" },
            language: {
              type: "string",
              minLength: 1,
              maxLength: 64
            },
            code: { type: "string", maxLength: 409600 },
            origin: { type: "string", minLength: 1, maxLength: 400 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "query"],
          properties: {
            kind: { const: "search" },
            query: { type: "string", maxLength: 409600 },
            resultCount: {
              type: "integer",
              minimum: 0,
              maximum: 9007199254740991
            },
            top: {
              type: "array",
              maxItems: 1e3,
              items: { type: "string", maxLength: 409600 }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "columns", "rows"],
          properties: {
            kind: { const: "tabular" },
            columns: {
              type: "array",
              maxItems: 1e3,
              items: { type: "string", maxLength: 409600 }
            },
            rows: {
              type: "array",
              maxItems: 1e3,
              items: {
                type: "array",
                maxItems: 1e3,
                items: { type: "string", maxLength: 409600 }
              }
            },
            totalRows: {
              type: "integer",
              minimum: 0,
              maximum: 9007199254740991
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "prompt"],
          properties: {
            kind: { const: "image_generation" },
            prompt: { type: "string", maxLength: 409600 },
            thumbnailUrl: {
              type: "string",
              maxLength: 11184835,
              pattern: "^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$"
            },
            model: { type: "string", minLength: 1, maxLength: 128 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "agentName", "task"],
          properties: {
            kind: { const: "subagent_delegation" },
            agentName: { type: "string", maxLength: 128 },
            task: { type: "string", maxLength: 409600 },
            parentDelegationId: {
              type: "string",
              minLength: 1,
              maxLength: 128
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "rows"],
          properties: {
            kind: { const: "key_value" },
            rows: {
              type: "array",
              maxItems: 1e3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "value"],
                properties: {
                  label: { type: "string", maxLength: 409600 },
                  value: { type: "string", maxLength: 409600 }
                }
              }
            }
          }
        },
        { $ref: "#/$defs/todoPreview" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { const: "generic" },
            summary: { type: "string", maxLength: 409600 }
          }
        }
      ]
    },
    toolResultPreview: {
      oneOf: [
        { $ref: "#/$defs/todoPreview" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text", "answers"],
          properties: {
            kind: { const: "question_answers" },
            text: { type: "string", maxLength: 409600 },
            answers: {
              type: "array",
              maxItems: 1e3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["question", "answer"],
                properties: {
                  question: { type: "string", maxLength: 409600 },
                  answer: { type: "string", maxLength: 409600 }
                }
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text"],
          properties: {
            kind: { const: "text" },
            text: { type: "string", maxLength: 409600 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "summary"],
          properties: {
            kind: { const: "generic" },
            summary: {
              type: "string",
              minLength: 1,
              maxLength: 409600,
              pattern: "\\S"
            }
          }
        }
      ]
    },
    metadata: {
      type: "object",
      additionalProperties: false,
      allOf: [
        {
          if: {
            properties: { complete: { const: true } },
            required: ["complete"]
          },
          then: {
            properties: { truncated: { const: false } }
          }
        }
      ],
      required: ["exportedAt", "complete", "truncated"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        startedAt: {
          type: "string",
          format: "date-time",
          maxLength: 32
        },
        exportedAt: {
          type: "string",
          format: "date-time",
          maxLength: 32
        },
        complete: { type: "boolean" },
        truncated: { type: "boolean" },
        projectName: {
          type: "string",
          minLength: 1,
          maxLength: 400
        },
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        gitBranch: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        model: { type: "string", minLength: 1, maxLength: 200 },
        channel: { type: "string", minLength: 1, maxLength: 100 },
        promptCount: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        },
        contextUsagePercent: {
          type: "integer",
          minimum: 0,
          maximum: 100
        },
        contextWindowSize: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        },
        totalTokens: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        },
        filesWritten: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        },
        linesAdded: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        },
        linesRemoved: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991
        }
      }
    }
  }
};

// packages/cli/src/ui/utils/export/html-script-data.ts
init_esbuild_shims();
function escapeJsonForHtmlScriptData(json) {
  return json.replace(/<\/script/gi, "<\\/script").replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
__name(escapeJsonForHtmlScriptData, "escapeJsonForHtmlScriptData");

// packages/cli/src/ui/utils/export/markdown-document-policy.ts
init_esbuild_shims();

// node_modules/unified/index.js
init_esbuild_shims();

// node_modules/unified/lib/index.js
init_esbuild_shims();

// node_modules/bail/index.js
init_esbuild_shims();
function bail(error) {
  if (error) {
    throw error;
  }
}
__name(bail, "bail");

// node_modules/unified/lib/index.js
var import_extend = __toESM(require_extend(), 1);

// node_modules/is-plain-obj/index.js
init_esbuild_shims();
function isPlainObject(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);
}
__name(isPlainObject, "isPlainObject");

// node_modules/trough/index.js
init_esbuild_shims();

// node_modules/trough/lib/index.js
init_esbuild_shims();
function trough() {
  const fns = [];
  const pipeline = { run, use };
  return pipeline;
  function run(...values) {
    let middlewareIndex = -1;
    const callback = values.pop();
    if (typeof callback !== "function") {
      throw new TypeError("Expected function as last argument, not " + callback);
    }
    next(null, ...values);
    function next(error, ...output) {
      const fn = fns[++middlewareIndex];
      let index2 = -1;
      if (error) {
        callback(error);
        return;
      }
      while (++index2 < values.length) {
        if (output[index2] === null || output[index2] === void 0) {
          output[index2] = values[index2];
        }
      }
      values = output;
      if (fn) {
        wrap(fn, next)(...output);
      } else {
        callback(null, ...output);
      }
    }
    __name(next, "next");
  }
  __name(run, "run");
  function use(middelware) {
    if (typeof middelware !== "function") {
      throw new TypeError(
        "Expected `middelware` to be a function, not " + middelware
      );
    }
    fns.push(middelware);
    return pipeline;
  }
  __name(use, "use");
}
__name(trough, "trough");
function wrap(middleware, callback) {
  let called;
  return wrapped;
  function wrapped(...parameters) {
    const fnExpectsCallback = middleware.length > parameters.length;
    let result;
    if (fnExpectsCallback) {
      parameters.push(done);
    }
    try {
      result = middleware.apply(this, parameters);
    } catch (error) {
      const exception = (
        /** @type {Error} */
        error
      );
      if (fnExpectsCallback && called) {
        throw exception;
      }
      return done(exception);
    }
    if (!fnExpectsCallback) {
      if (result && result.then && typeof result.then === "function") {
        result.then(then, done);
      } else if (result instanceof Error) {
        done(result);
      } else {
        then(result);
      }
    }
  }
  __name(wrapped, "wrapped");
  function done(error, ...output) {
    if (!called) {
      called = true;
      callback(error, ...output);
    }
  }
  __name(done, "done");
  function then(value) {
    done(null, value);
  }
  __name(then, "then");
}
__name(wrap, "wrap");

// node_modules/vfile/index.js
init_esbuild_shims();

// node_modules/vfile/lib/index.js
init_esbuild_shims();

// node_modules/vfile-message/index.js
init_esbuild_shims();

// node_modules/vfile-message/lib/index.js
init_esbuild_shims();

// node_modules/unist-util-stringify-position/index.js
init_esbuild_shims();

// node_modules/unist-util-stringify-position/lib/index.js
init_esbuild_shims();
function stringifyPosition(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if ("position" in value || "type" in value) {
    return position(value.position);
  }
  if ("start" in value || "end" in value) {
    return position(value);
  }
  if ("line" in value || "column" in value) {
    return point(value);
  }
  return "";
}
__name(stringifyPosition, "stringifyPosition");
function point(point3) {
  return index(point3 && point3.line) + ":" + index(point3 && point3.column);
}
__name(point, "point");
function position(pos) {
  return point(pos && pos.start) + "-" + point(pos && pos.end);
}
__name(position, "position");
function index(value) {
  return value && typeof value === "number" ? value : 1;
}
__name(index, "index");

// node_modules/vfile-message/lib/index.js
var VFileMessage = class extends Error {
  static {
    __name(this, "VFileMessage");
  }
  /**
   * Create a message for `reason`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   * @param {Options | null | undefined} [options]
   * @returns
   *
   * @overload
   * @param {string} reason
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns
   *
   * @overload
   * @param {string} reason
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns
   *
   * @overload
   * @param {string} reason
   * @param {string | null | undefined} [origin]
   * @returns
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {string | null | undefined} [origin]
   * @returns
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | Options | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns
   *   Instance of `VFileMessage`.
   */
  // eslint-disable-next-line complexity
  constructor(causeOrReason, optionsOrParentOrPlace, origin) {
    super();
    if (typeof optionsOrParentOrPlace === "string") {
      origin = optionsOrParentOrPlace;
      optionsOrParentOrPlace = void 0;
    }
    let reason = "";
    let options = {};
    let legacyCause = false;
    if (optionsOrParentOrPlace) {
      if ("line" in optionsOrParentOrPlace && "column" in optionsOrParentOrPlace) {
        options = { place: optionsOrParentOrPlace };
      } else if ("start" in optionsOrParentOrPlace && "end" in optionsOrParentOrPlace) {
        options = { place: optionsOrParentOrPlace };
      } else if ("type" in optionsOrParentOrPlace) {
        options = {
          ancestors: [optionsOrParentOrPlace],
          place: optionsOrParentOrPlace.position
        };
      } else {
        options = { ...optionsOrParentOrPlace };
      }
    }
    if (typeof causeOrReason === "string") {
      reason = causeOrReason;
    } else if (!options.cause && causeOrReason) {
      legacyCause = true;
      reason = causeOrReason.message;
      options.cause = causeOrReason;
    }
    if (!options.ruleId && !options.source && typeof origin === "string") {
      const index2 = origin.indexOf(":");
      if (index2 === -1) {
        options.ruleId = origin;
      } else {
        options.source = origin.slice(0, index2);
        options.ruleId = origin.slice(index2 + 1);
      }
    }
    if (!options.place && options.ancestors && options.ancestors) {
      const parent = options.ancestors[options.ancestors.length - 1];
      if (parent) {
        options.place = parent.position;
      }
    }
    const start = options.place && "start" in options.place ? options.place.start : options.place;
    this.ancestors = options.ancestors || void 0;
    this.cause = options.cause || void 0;
    this.column = start ? start.column : void 0;
    this.fatal = void 0;
    this.file = "";
    this.message = reason;
    this.line = start ? start.line : void 0;
    this.name = stringifyPosition(options.place) || "1:1";
    this.place = options.place || void 0;
    this.reason = this.message;
    this.ruleId = options.ruleId || void 0;
    this.source = options.source || void 0;
    this.stack = legacyCause && options.cause && typeof options.cause.stack === "string" ? options.cause.stack : "";
    this.actual = void 0;
    this.expected = void 0;
    this.note = void 0;
    this.url = void 0;
  }
};
VFileMessage.prototype.file = "";
VFileMessage.prototype.name = "";
VFileMessage.prototype.reason = "";
VFileMessage.prototype.message = "";
VFileMessage.prototype.stack = "";
VFileMessage.prototype.column = void 0;
VFileMessage.prototype.line = void 0;
VFileMessage.prototype.ancestors = void 0;
VFileMessage.prototype.cause = void 0;
VFileMessage.prototype.fatal = void 0;
VFileMessage.prototype.place = void 0;
VFileMessage.prototype.ruleId = void 0;
VFileMessage.prototype.source = void 0;

// node_modules/vfile/lib/minpath.js
init_esbuild_shims();
import { default as default2 } from "node:path";

// node_modules/vfile/lib/minproc.js
init_esbuild_shims();
import { default as default3 } from "node:process";

// node_modules/vfile/lib/minurl.js
init_esbuild_shims();
import { fileURLToPath } from "node:url";

// node_modules/vfile/lib/minurl.shared.js
init_esbuild_shims();
function isUrl(fileUrlOrPath) {
  return Boolean(
    fileUrlOrPath !== null && typeof fileUrlOrPath === "object" && "href" in fileUrlOrPath && fileUrlOrPath.href && "protocol" in fileUrlOrPath && fileUrlOrPath.protocol && // @ts-expect-error: indexing is fine.
    fileUrlOrPath.auth === void 0
  );
}
__name(isUrl, "isUrl");

// node_modules/vfile/lib/index.js
var order = (
  /** @type {const} */
  [
    "history",
    "path",
    "basename",
    "stem",
    "extname",
    "dirname"
  ]
);
var VFile = class {
  static {
    __name(this, "VFile");
  }
  /**
   * Create a new virtual file.
   *
   * `options` is treated as:
   *
   * *   `string` or `Uint8Array` — `{value: options}`
   * *   `URL` — `{path: options}`
   * *   `VFile` — shallow copies its data over to the new file
   * *   `object` — all fields are shallow copied over to the new file
   *
   * Path related fields are set in the following order (least specific to
   * most specific): `history`, `path`, `basename`, `stem`, `extname`,
   * `dirname`.
   *
   * You cannot set `dirname` or `extname` without setting either `history`,
   * `path`, `basename`, or `stem` too.
   *
   * @param {Compatible | null | undefined} [value]
   *   File value.
   * @returns
   *   New instance.
   */
  constructor(value) {
    let options;
    if (!value) {
      options = {};
    } else if (isUrl(value)) {
      options = { path: value };
    } else if (typeof value === "string" || isUint8Array(value)) {
      options = { value };
    } else {
      options = value;
    }
    this.cwd = "cwd" in options ? "" : default3.cwd();
    this.data = {};
    this.history = [];
    this.messages = [];
    this.value;
    this.map;
    this.result;
    this.stored;
    let index2 = -1;
    while (++index2 < order.length) {
      const field2 = order[index2];
      if (field2 in options && options[field2] !== void 0 && options[field2] !== null) {
        this[field2] = field2 === "history" ? [...options[field2]] : options[field2];
      }
    }
    let field;
    for (field in options) {
      if (!order.includes(field)) {
        this[field] = options[field];
      }
    }
  }
  /**
   * Get the basename (including extname) (example: `'index.min.js'`).
   *
   * @returns {string | undefined}
   *   Basename.
   */
  get basename() {
    return typeof this.path === "string" ? default2.basename(this.path) : void 0;
  }
  /**
   * Set basename (including extname) (`'index.min.js'`).
   *
   * Cannot contain path separators (`'/'` on unix, macOS, and browsers, `'\'`
   * on windows).
   * Cannot be nullified (use `file.path = file.dirname` instead).
   *
   * @param {string} basename
   *   Basename.
   * @returns {undefined}
   *   Nothing.
   */
  set basename(basename) {
    assertNonEmpty(basename, "basename");
    assertPart(basename, "basename");
    this.path = default2.join(this.dirname || "", basename);
  }
  /**
   * Get the parent path (example: `'~'`).
   *
   * @returns {string | undefined}
   *   Dirname.
   */
  get dirname() {
    return typeof this.path === "string" ? default2.dirname(this.path) : void 0;
  }
  /**
   * Set the parent path (example: `'~'`).
   *
   * Cannot be set if there’s no `path` yet.
   *
   * @param {string | undefined} dirname
   *   Dirname.
   * @returns {undefined}
   *   Nothing.
   */
  set dirname(dirname) {
    assertPath(this.basename, "dirname");
    this.path = default2.join(dirname || "", this.basename);
  }
  /**
   * Get the extname (including dot) (example: `'.js'`).
   *
   * @returns {string | undefined}
   *   Extname.
   */
  get extname() {
    return typeof this.path === "string" ? default2.extname(this.path) : void 0;
  }
  /**
   * Set the extname (including dot) (example: `'.js'`).
   *
   * Cannot contain path separators (`'/'` on unix, macOS, and browsers, `'\'`
   * on windows).
   * Cannot be set if there’s no `path` yet.
   *
   * @param {string | undefined} extname
   *   Extname.
   * @returns {undefined}
   *   Nothing.
   */
  set extname(extname) {
    assertPart(extname, "extname");
    assertPath(this.dirname, "extname");
    if (extname) {
      if (extname.codePointAt(0) !== 46) {
        throw new Error("`extname` must start with `.`");
      }
      if (extname.includes(".", 1)) {
        throw new Error("`extname` cannot contain multiple dots");
      }
    }
    this.path = default2.join(this.dirname, this.stem + (extname || ""));
  }
  /**
   * Get the full path (example: `'~/index.min.js'`).
   *
   * @returns {string}
   *   Path.
   */
  get path() {
    return this.history[this.history.length - 1];
  }
  /**
   * Set the full path (example: `'~/index.min.js'`).
   *
   * Cannot be nullified.
   * You can set a file URL (a `URL` object with a `file:` protocol) which will
   * be turned into a path with `url.fileURLToPath`.
   *
   * @param {URL | string} path
   *   Path.
   * @returns {undefined}
   *   Nothing.
   */
  set path(path3) {
    if (isUrl(path3)) {
      path3 = fileURLToPath(path3);
    }
    assertNonEmpty(path3, "path");
    if (this.path !== path3) {
      this.history.push(path3);
    }
  }
  /**
   * Get the stem (basename w/o extname) (example: `'index.min'`).
   *
   * @returns {string | undefined}
   *   Stem.
   */
  get stem() {
    return typeof this.path === "string" ? default2.basename(this.path, this.extname) : void 0;
  }
  /**
   * Set the stem (basename w/o extname) (example: `'index.min'`).
   *
   * Cannot contain path separators (`'/'` on unix, macOS, and browsers, `'\'`
   * on windows).
   * Cannot be nullified (use `file.path = file.dirname` instead).
   *
   * @param {string} stem
   *   Stem.
   * @returns {undefined}
   *   Nothing.
   */
  set stem(stem) {
    assertNonEmpty(stem, "stem");
    assertPart(stem, "stem");
    this.path = default2.join(this.dirname || "", stem + (this.extname || ""));
  }
  // Normal prototypal methods.
  /**
   * Create a fatal message for `reason` associated with the file.
   *
   * The `fatal` field of the message is set to `true` (error; file not usable)
   * and the `file` field is set to the current file path.
   * The message is added to the `messages` field on `file`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   * @param {MessageOptions | null | undefined} [options]
   * @returns {never}
   *
   * @overload
   * @param {string} reason
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {string} reason
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {string} reason
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | MessageOptions | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns {never}
   *   Never.
   * @throws {VFileMessage}
   *   Message.
   */
  fail(causeOrReason, optionsOrParentOrPlace, origin) {
    const message = this.message(causeOrReason, optionsOrParentOrPlace, origin);
    message.fatal = true;
    throw message;
  }
  /**
   * Create an info message for `reason` associated with the file.
   *
   * The `fatal` field of the message is set to `undefined` (info; change
   * likely not needed) and the `file` field is set to the current file path.
   * The message is added to the `messages` field on `file`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   * @param {MessageOptions | null | undefined} [options]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | MessageOptions | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns {VFileMessage}
   *   Message.
   */
  info(causeOrReason, optionsOrParentOrPlace, origin) {
    const message = this.message(causeOrReason, optionsOrParentOrPlace, origin);
    message.fatal = void 0;
    return message;
  }
  /**
   * Create a message for `reason` associated with the file.
   *
   * The `fatal` field of the message is set to `false` (warning; change may be
   * needed) and the `file` field is set to the current file path.
   * The message is added to the `messages` field on `file`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   * @param {MessageOptions | null | undefined} [options]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | MessageOptions | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns {VFileMessage}
   *   Message.
   */
  message(causeOrReason, optionsOrParentOrPlace, origin) {
    const message = new VFileMessage(
      // @ts-expect-error: the overloads are fine.
      causeOrReason,
      optionsOrParentOrPlace,
      origin
    );
    if (this.path) {
      message.name = this.path + ":" + message.name;
      message.file = this.path;
    }
    message.fatal = false;
    this.messages.push(message);
    return message;
  }
  /**
   * Serialize the file.
   *
   * > **Note**: which encodings are supported depends on the engine.
   * > For info on Node.js, see:
   * > <https://nodejs.org/api/util.html#whatwg-supported-encodings>.
   *
   * @param {string | null | undefined} [encoding='utf8']
   *   Character encoding to understand `value` as when it’s a `Uint8Array`
   *   (default: `'utf-8'`).
   * @returns {string}
   *   Serialized file.
   */
  toString(encoding) {
    if (this.value === void 0) {
      return "";
    }
    if (typeof this.value === "string") {
      return this.value;
    }
    const decoder = new TextDecoder(encoding || void 0);
    return decoder.decode(this.value);
  }
};
function assertPart(part, name) {
  if (part && part.includes(default2.sep)) {
    throw new Error(
      "`" + name + "` cannot be a path: did not expect `" + default2.sep + "`"
    );
  }
}
__name(assertPart, "assertPart");
function assertNonEmpty(part, name) {
  if (!part) {
    throw new Error("`" + name + "` cannot be empty");
  }
}
__name(assertNonEmpty, "assertNonEmpty");
function assertPath(path3, name) {
  if (!path3) {
    throw new Error("Setting `" + name + "` requires `path` to be set too");
  }
}
__name(assertPath, "assertPath");
function isUint8Array(value) {
  return Boolean(
    value && typeof value === "object" && "byteLength" in value && "byteOffset" in value
  );
}
__name(isUint8Array, "isUint8Array");

// node_modules/unified/lib/callable-instance.js
init_esbuild_shims();
var CallableInstance = (
  /**
   * @type {new <Parameters extends Array<unknown>, Result>(property: string | symbol) => (...parameters: Parameters) => Result}
   */
  /** @type {unknown} */
  /**
   * @this {Function}
   * @param {string | symbol} property
   * @returns {(...parameters: Array<unknown>) => unknown}
   */
  /* @__PURE__ */ __name(function(property) {
    const self = this;
    const constr = self.constructor;
    const proto = (
      /** @type {Record<string | symbol, Function>} */
      // Prototypes do exist.
      // type-coverage:ignore-next-line
      constr.prototype
    );
    const value = proto[property];
    const apply = /* @__PURE__ */ __name(function() {
      return value.apply(apply, arguments);
    }, "apply");
    Object.setPrototypeOf(apply, proto);
    return apply;
  }, "CallableInstance")
);

// node_modules/unified/lib/index.js
var own = {}.hasOwnProperty;
var Processor = class _Processor extends CallableInstance {
  static {
    __name(this, "Processor");
  }
  /**
   * Create a processor.
   */
  constructor() {
    super("copy");
    this.Compiler = void 0;
    this.Parser = void 0;
    this.attachers = [];
    this.compiler = void 0;
    this.freezeIndex = -1;
    this.frozen = void 0;
    this.namespace = {};
    this.parser = void 0;
    this.transformers = trough();
  }
  /**
   * Copy a processor.
   *
   * @deprecated
   *   This is a private internal method and should not be used.
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *   New *unfrozen* processor ({@linkcode Processor}) that is
   *   configured to work the same as its ancestor.
   *   When the descendant processor is configured in the future it does not
   *   affect the ancestral processor.
   */
  copy() {
    const destination = (
      /** @type {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>} */
      new _Processor()
    );
    let index2 = -1;
    while (++index2 < this.attachers.length) {
      const attacher = this.attachers[index2];
      destination.use(...attacher);
    }
    destination.data((0, import_extend.default)(true, {}, this.namespace));
    return destination;
  }
  /**
   * Configure the processor with info available to all plugins.
   * Information is stored in an object.
   *
   * Typically, options can be given to a specific plugin, but sometimes it
   * makes sense to have information shared with several plugins.
   * For example, a list of HTML elements that are self-closing, which is
   * needed during all phases.
   *
   * > **Note**: setting information cannot occur on *frozen* processors.
   * > Call the processor first to create a new unfrozen processor.
   *
   * > **Note**: to register custom data in TypeScript, augment the
   * > {@linkcode Data} interface.
   *
   * @example
   *   This example show how to get and set info:
   *
   *   ```js
   *   import {unified} from 'unified'
   *
   *   const processor = unified().data('alpha', 'bravo')
   *
   *   processor.data('alpha') // => 'bravo'
   *
   *   processor.data() // => {alpha: 'bravo'}
   *
   *   processor.data({charlie: 'delta'})
   *
   *   processor.data() // => {charlie: 'delta'}
   *   ```
   *
   * @template {keyof Data} Key
   *
   * @overload
   * @returns {Data}
   *
   * @overload
   * @param {Data} dataset
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @overload
   * @param {Key} key
   * @returns {Data[Key]}
   *
   * @overload
   * @param {Key} key
   * @param {Data[Key]} value
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @param {Data | Key} [key]
   *   Key to get or set, or entire dataset to set, or nothing to get the
   *   entire dataset (optional).
   * @param {Data[Key]} [value]
   *   Value to set (optional).
   * @returns {unknown}
   *   The current processor when setting, the value at `key` when getting, or
   *   the entire dataset when getting without key.
   */
  data(key, value) {
    if (typeof key === "string") {
      if (arguments.length === 2) {
        assertUnfrozen("data", this.frozen);
        this.namespace[key] = value;
        return this;
      }
      return own.call(this.namespace, key) && this.namespace[key] || void 0;
    }
    if (key) {
      assertUnfrozen("data", this.frozen);
      this.namespace = key;
      return this;
    }
    return this.namespace;
  }
  /**
   * Freeze a processor.
   *
   * Frozen processors are meant to be extended and not to be configured
   * directly.
   *
   * When a processor is frozen it cannot be unfrozen.
   * New processors working the same way can be created by calling the
   * processor.
   *
   * It’s possible to freeze processors explicitly by calling `.freeze()`.
   * Processors freeze automatically when `.parse()`, `.run()`, `.runSync()`,
   * `.stringify()`, `.process()`, or `.processSync()` are called.
   *
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *   The current processor.
   */
  freeze() {
    if (this.frozen) {
      return this;
    }
    const self = (
      /** @type {Processor} */
      /** @type {unknown} */
      this
    );
    while (++this.freezeIndex < this.attachers.length) {
      const [attacher, ...options] = this.attachers[this.freezeIndex];
      if (options[0] === false) {
        continue;
      }
      if (options[0] === true) {
        options[0] = void 0;
      }
      const transformer = attacher.call(self, ...options);
      if (typeof transformer === "function") {
        this.transformers.use(transformer);
      }
    }
    this.frozen = true;
    this.freezeIndex = Number.POSITIVE_INFINITY;
    return this;
  }
  /**
   * Parse text to a syntax tree.
   *
   * > **Note**: `parse` freezes the processor if not already *frozen*.
   *
   * > **Note**: `parse` performs the parse phase, not the run phase or other
   * > phases.
   *
   * @param {Compatible | undefined} [file]
   *   file to parse (optional); typically `string` or `VFile`; any value
   *   accepted as `x` in `new VFile(x)`.
   * @returns {ParseTree extends undefined ? Node : ParseTree}
   *   Syntax tree representing `file`.
   */
  parse(file) {
    this.freeze();
    const realFile = vfile(file);
    const parser = this.parser || this.Parser;
    assertParser("parse", parser);
    return parser(String(realFile), realFile);
  }
  /**
   * Process the given file as configured on the processor.
   *
   * > **Note**: `process` freezes the processor if not already *frozen*.
   *
   * > **Note**: `process` performs the parse, run, and stringify phases.
   *
   * @overload
   * @param {Compatible | undefined} file
   * @param {ProcessCallback<VFileWithOutput<CompileResult>>} done
   * @returns {undefined}
   *
   * @overload
   * @param {Compatible | undefined} [file]
   * @returns {Promise<VFileWithOutput<CompileResult>>}
   *
   * @param {Compatible | undefined} [file]
   *   File (optional); typically `string` or `VFile`]; any value accepted as
   *   `x` in `new VFile(x)`.
   * @param {ProcessCallback<VFileWithOutput<CompileResult>> | undefined} [done]
   *   Callback (optional).
   * @returns {Promise<VFile> | undefined}
   *   Nothing if `done` is given.
   *   Otherwise a promise, rejected with a fatal error or resolved with the
   *   processed file.
   *
   *   The parsed, transformed, and compiled value is available at
   *   `file.value` (see note).
   *
   *   > **Note**: unified typically compiles by serializing: most
   *   > compilers return `string` (or `Uint8Array`).
   *   > Some compilers, such as the one configured with
   *   > [`rehype-react`][rehype-react], return other values (in this case, a
   *   > React tree).
   *   > If you’re using a compiler that doesn’t serialize, expect different
   *   > result values.
   *   >
   *   > To register custom results in TypeScript, add them to
   *   > {@linkcode CompileResultMap}.
   *
   *   [rehype-react]: https://github.com/rehypejs/rehype-react
   */
  process(file, done) {
    const self = this;
    this.freeze();
    assertParser("process", this.parser || this.Parser);
    assertCompiler("process", this.compiler || this.Compiler);
    return done ? executor(void 0, done) : new Promise(executor);
    function executor(resolve2, reject) {
      const realFile = vfile(file);
      const parseTree = (
        /** @type {HeadTree extends undefined ? Node : HeadTree} */
        /** @type {unknown} */
        self.parse(realFile)
      );
      self.run(parseTree, realFile, function(error, tree, file2) {
        if (error || !tree || !file2) {
          return realDone(error);
        }
        const compileTree = (
          /** @type {CompileTree extends undefined ? Node : CompileTree} */
          /** @type {unknown} */
          tree
        );
        const compileResult = self.stringify(compileTree, file2);
        if (looksLikeAValue(compileResult)) {
          file2.value = compileResult;
        } else {
          file2.result = compileResult;
        }
        realDone(
          error,
          /** @type {VFileWithOutput<CompileResult>} */
          file2
        );
      });
      function realDone(error, file2) {
        if (error || !file2) {
          reject(error);
        } else if (resolve2) {
          resolve2(file2);
        } else {
          ok(done, "`done` is defined if `resolve` is not");
          done(void 0, file2);
        }
      }
      __name(realDone, "realDone");
    }
    __name(executor, "executor");
  }
  /**
   * Process the given file as configured on the processor.
   *
   * An error is thrown if asynchronous transforms are configured.
   *
   * > **Note**: `processSync` freezes the processor if not already *frozen*.
   *
   * > **Note**: `processSync` performs the parse, run, and stringify phases.
   *
   * @param {Compatible | undefined} [file]
   *   File (optional); typically `string` or `VFile`; any value accepted as
   *   `x` in `new VFile(x)`.
   * @returns {VFileWithOutput<CompileResult>}
   *   The processed file.
   *
   *   The parsed, transformed, and compiled value is available at
   *   `file.value` (see note).
   *
   *   > **Note**: unified typically compiles by serializing: most
   *   > compilers return `string` (or `Uint8Array`).
   *   > Some compilers, such as the one configured with
   *   > [`rehype-react`][rehype-react], return other values (in this case, a
   *   > React tree).
   *   > If you’re using a compiler that doesn’t serialize, expect different
   *   > result values.
   *   >
   *   > To register custom results in TypeScript, add them to
   *   > {@linkcode CompileResultMap}.
   *
   *   [rehype-react]: https://github.com/rehypejs/rehype-react
   */
  processSync(file) {
    let complete = false;
    let result;
    this.freeze();
    assertParser("processSync", this.parser || this.Parser);
    assertCompiler("processSync", this.compiler || this.Compiler);
    this.process(file, realDone);
    assertDone("processSync", "process", complete);
    ok(result, "we either bailed on an error or have a tree");
    return result;
    function realDone(error, file2) {
      complete = true;
      bail(error);
      result = file2;
    }
    __name(realDone, "realDone");
  }
  /**
   * Run *transformers* on a syntax tree.
   *
   * > **Note**: `run` freezes the processor if not already *frozen*.
   *
   * > **Note**: `run` performs the run phase, not other phases.
   *
   * @overload
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   * @param {RunCallback<TailTree extends undefined ? Node : TailTree>} done
   * @returns {undefined}
   *
   * @overload
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   * @param {Compatible | undefined} file
   * @param {RunCallback<TailTree extends undefined ? Node : TailTree>} done
   * @returns {undefined}
   *
   * @overload
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   * @param {Compatible | undefined} [file]
   * @returns {Promise<TailTree extends undefined ? Node : TailTree>}
   *
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   *   Tree to transform and inspect.
   * @param {(
   *   RunCallback<TailTree extends undefined ? Node : TailTree> |
   *   Compatible
   * )} [file]
   *   File associated with `node` (optional); any value accepted as `x` in
   *   `new VFile(x)`.
   * @param {RunCallback<TailTree extends undefined ? Node : TailTree>} [done]
   *   Callback (optional).
   * @returns {Promise<TailTree extends undefined ? Node : TailTree> | undefined}
   *   Nothing if `done` is given.
   *   Otherwise, a promise rejected with a fatal error or resolved with the
   *   transformed tree.
   */
  run(tree, file, done) {
    assertNode(tree);
    this.freeze();
    const transformers = this.transformers;
    if (!done && typeof file === "function") {
      done = file;
      file = void 0;
    }
    return done ? executor(void 0, done) : new Promise(executor);
    function executor(resolve2, reject) {
      ok(
        typeof file !== "function",
        "`file` can\u2019t be a `done` anymore, we checked"
      );
      const realFile = vfile(file);
      transformers.run(tree, realFile, realDone);
      function realDone(error, outputTree, file2) {
        const resultingTree = (
          /** @type {TailTree extends undefined ? Node : TailTree} */
          outputTree || tree
        );
        if (error) {
          reject(error);
        } else if (resolve2) {
          resolve2(resultingTree);
        } else {
          ok(done, "`done` is defined if `resolve` is not");
          done(void 0, resultingTree, file2);
        }
      }
      __name(realDone, "realDone");
    }
    __name(executor, "executor");
  }
  /**
   * Run *transformers* on a syntax tree.
   *
   * An error is thrown if asynchronous transforms are configured.
   *
   * > **Note**: `runSync` freezes the processor if not already *frozen*.
   *
   * > **Note**: `runSync` performs the run phase, not other phases.
   *
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   *   Tree to transform and inspect.
   * @param {Compatible | undefined} [file]
   *   File associated with `node` (optional); any value accepted as `x` in
   *   `new VFile(x)`.
   * @returns {TailTree extends undefined ? Node : TailTree}
   *   Transformed tree.
   */
  runSync(tree, file) {
    let complete = false;
    let result;
    this.run(tree, file, realDone);
    assertDone("runSync", "run", complete);
    ok(result, "we either bailed on an error or have a tree");
    return result;
    function realDone(error, tree2) {
      bail(error);
      result = tree2;
      complete = true;
    }
    __name(realDone, "realDone");
  }
  /**
   * Compile a syntax tree.
   *
   * > **Note**: `stringify` freezes the processor if not already *frozen*.
   *
   * > **Note**: `stringify` performs the stringify phase, not the run phase
   * > or other phases.
   *
   * @param {CompileTree extends undefined ? Node : CompileTree} tree
   *   Tree to compile.
   * @param {Compatible | undefined} [file]
   *   File associated with `node` (optional); any value accepted as `x` in
   *   `new VFile(x)`.
   * @returns {CompileResult extends undefined ? Value : CompileResult}
   *   Textual representation of the tree (see note).
   *
   *   > **Note**: unified typically compiles by serializing: most compilers
   *   > return `string` (or `Uint8Array`).
   *   > Some compilers, such as the one configured with
   *   > [`rehype-react`][rehype-react], return other values (in this case, a
   *   > React tree).
   *   > If you’re using a compiler that doesn’t serialize, expect different
   *   > result values.
   *   >
   *   > To register custom results in TypeScript, add them to
   *   > {@linkcode CompileResultMap}.
   *
   *   [rehype-react]: https://github.com/rehypejs/rehype-react
   */
  stringify(tree, file) {
    this.freeze();
    const realFile = vfile(file);
    const compiler2 = this.compiler || this.Compiler;
    assertCompiler("stringify", compiler2);
    assertNode(tree);
    return compiler2(tree, realFile);
  }
  /**
   * Configure the processor to use a plugin, a list of usable values, or a
   * preset.
   *
   * If the processor is already using a plugin, the previous plugin
   * configuration is changed based on the options that are passed in.
   * In other words, the plugin is not added a second time.
   *
   * > **Note**: `use` cannot be called on *frozen* processors.
   * > Call the processor first to create a new unfrozen processor.
   *
   * @example
   *   There are many ways to pass plugins to `.use()`.
   *   This example gives an overview:
   *
   *   ```js
   *   import {unified} from 'unified'
   *
   *   unified()
   *     // Plugin with options:
   *     .use(pluginA, {x: true, y: true})
   *     // Passing the same plugin again merges configuration (to `{x: true, y: false, z: true}`):
   *     .use(pluginA, {y: false, z: true})
   *     // Plugins:
   *     .use([pluginB, pluginC])
   *     // Two plugins, the second with options:
   *     .use([pluginD, [pluginE, {}]])
   *     // Preset with plugins and settings:
   *     .use({plugins: [pluginF, [pluginG, {}]], settings: {position: false}})
   *     // Settings only:
   *     .use({settings: {position: false}})
   *   ```
   *
   * @template {Array<unknown>} [Parameters=[]]
   * @template {Node | string | undefined} [Input=undefined]
   * @template [Output=Input]
   *
   * @overload
   * @param {Preset | null | undefined} [preset]
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @overload
   * @param {PluggableList} list
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @overload
   * @param {Plugin<Parameters, Input, Output>} plugin
   * @param {...(Parameters | [boolean])} parameters
   * @returns {UsePlugin<ParseTree, HeadTree, TailTree, CompileTree, CompileResult, Input, Output>}
   *
   * @param {PluggableList | Plugin | Preset | null | undefined} value
   *   Usable value.
   * @param {...unknown} parameters
   *   Parameters, when a plugin is given as a usable value.
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *   Current processor.
   */
  use(value, ...parameters) {
    const attachers = this.attachers;
    const namespace = this.namespace;
    assertUnfrozen("use", this.frozen);
    if (value === null || value === void 0) {
    } else if (typeof value === "function") {
      addPlugin(value, parameters);
    } else if (typeof value === "object") {
      if (Array.isArray(value)) {
        addList(value);
      } else {
        addPreset(value);
      }
    } else {
      throw new TypeError("Expected usable value, not `" + value + "`");
    }
    return this;
    function add(value2) {
      if (typeof value2 === "function") {
        addPlugin(value2, []);
      } else if (typeof value2 === "object") {
        if (Array.isArray(value2)) {
          const [plugin, ...parameters2] = (
            /** @type {PluginTuple<Array<unknown>>} */
            value2
          );
          addPlugin(plugin, parameters2);
        } else {
          addPreset(value2);
        }
      } else {
        throw new TypeError("Expected usable value, not `" + value2 + "`");
      }
    }
    __name(add, "add");
    function addPreset(result) {
      if (!("plugins" in result) && !("settings" in result)) {
        throw new Error(
          "Expected usable value but received an empty preset, which is probably a mistake: presets typically come with `plugins` and sometimes with `settings`, but this has neither"
        );
      }
      addList(result.plugins);
      if (result.settings) {
        namespace.settings = (0, import_extend.default)(true, namespace.settings, result.settings);
      }
    }
    __name(addPreset, "addPreset");
    function addList(plugins) {
      let index2 = -1;
      if (plugins === null || plugins === void 0) {
      } else if (Array.isArray(plugins)) {
        while (++index2 < plugins.length) {
          const thing = plugins[index2];
          add(thing);
        }
      } else {
        throw new TypeError("Expected a list of plugins, not `" + plugins + "`");
      }
    }
    __name(addList, "addList");
    function addPlugin(plugin, parameters2) {
      let index2 = -1;
      let entryIndex = -1;
      while (++index2 < attachers.length) {
        if (attachers[index2][0] === plugin) {
          entryIndex = index2;
          break;
        }
      }
      if (entryIndex === -1) {
        attachers.push([plugin, ...parameters2]);
      } else if (parameters2.length > 0) {
        let [primary, ...rest] = parameters2;
        const currentPrimary = attachers[entryIndex][1];
        if (isPlainObject(currentPrimary) && isPlainObject(primary)) {
          primary = (0, import_extend.default)(true, currentPrimary, primary);
        }
        attachers[entryIndex] = [plugin, primary, ...rest];
      }
    }
    __name(addPlugin, "addPlugin");
  }
};
var unified = new Processor().freeze();
function assertParser(name, value) {
  if (typeof value !== "function") {
    throw new TypeError("Cannot `" + name + "` without `parser`");
  }
}
__name(assertParser, "assertParser");
function assertCompiler(name, value) {
  if (typeof value !== "function") {
    throw new TypeError("Cannot `" + name + "` without `compiler`");
  }
}
__name(assertCompiler, "assertCompiler");
function assertUnfrozen(name, frozen) {
  if (frozen) {
    throw new Error(
      "Cannot call `" + name + "` on a frozen processor.\nCreate a new processor first, by calling it: use `processor()` instead of `processor`."
    );
  }
}
__name(assertUnfrozen, "assertUnfrozen");
function assertNode(node2) {
  if (!isPlainObject(node2) || typeof node2.type !== "string") {
    throw new TypeError("Expected node, got `" + node2 + "`");
  }
}
__name(assertNode, "assertNode");
function assertDone(name, asyncName, complete) {
  if (!complete) {
    throw new Error(
      "`" + name + "` finished async. Use `" + asyncName + "` instead"
    );
  }
}
__name(assertDone, "assertDone");
function vfile(value) {
  return looksLikeAVFile(value) ? value : new VFile(value);
}
__name(vfile, "vfile");
function looksLikeAVFile(value) {
  return Boolean(
    value && typeof value === "object" && "message" in value && "messages" in value
  );
}
__name(looksLikeAVFile, "looksLikeAVFile");
function looksLikeAValue(value) {
  return typeof value === "string" || isUint8Array2(value);
}
__name(looksLikeAValue, "looksLikeAValue");
function isUint8Array2(value) {
  return Boolean(
    value && typeof value === "object" && "byteLength" in value && "byteOffset" in value
  );
}
__name(isUint8Array2, "isUint8Array");

// node_modules/remark-gfm/index.js
init_esbuild_shims();

// node_modules/remark-gfm/lib/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm/lib/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm-autolink-literal/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm-autolink-literal/lib/index.js
init_esbuild_shims();

// node_modules/ccount/index.js
init_esbuild_shims();
function ccount(value, character) {
  const source = String(value);
  if (typeof character !== "string") {
    throw new TypeError("Expected character");
  }
  let count = 0;
  let index2 = source.indexOf(character);
  while (index2 !== -1) {
    count++;
    index2 = source.indexOf(character, index2 + character.length);
  }
  return count;
}
__name(ccount, "ccount");

// node_modules/micromark-util-character/index.js
init_esbuild_shims();
var asciiAlpha = regexCheck(/[A-Za-z]/);
var asciiAlphanumeric = regexCheck(/[\dA-Za-z]/);
var asciiAtext = regexCheck(/[#-'*+\--9=?A-Z^-~]/);
function asciiControl(code3) {
  return (
    // Special whitespace codes (which have negative values), C0 and Control
    // character DEL
    code3 !== null && (code3 < 32 || code3 === 127)
  );
}
__name(asciiControl, "asciiControl");
var asciiDigit = regexCheck(/\d/);
var asciiHexDigit = regexCheck(/[\dA-Fa-f]/);
var asciiPunctuation = regexCheck(/[!-/:-@[-`{-~]/);
function markdownLineEnding(code3) {
  return code3 !== null && code3 < -2;
}
__name(markdownLineEnding, "markdownLineEnding");
function markdownLineEndingOrSpace(code3) {
  return code3 !== null && (code3 < 0 || code3 === 32);
}
__name(markdownLineEndingOrSpace, "markdownLineEndingOrSpace");
function markdownSpace(code3) {
  return code3 === -2 || code3 === -1 || code3 === 32;
}
__name(markdownSpace, "markdownSpace");
var unicodePunctuation = regexCheck(new RegExp("\\p{P}|\\p{S}", "u"));
var unicodeWhitespace = regexCheck(/\s/);
function regexCheck(regex) {
  return check;
  function check(code3) {
    return code3 !== null && code3 > -1 && regex.test(String.fromCharCode(code3));
  }
  __name(check, "check");
}
__name(regexCheck, "regexCheck");

// node_modules/mdast-util-find-and-replace/index.js
init_esbuild_shims();

// node_modules/mdast-util-find-and-replace/lib/index.js
init_esbuild_shims();

// node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp/index.js
init_esbuild_shims();
function escapeStringRegexp(string3) {
  if (typeof string3 !== "string") {
    throw new TypeError("Expected a string");
  }
  return string3.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}
__name(escapeStringRegexp, "escapeStringRegexp");

// node_modules/unist-util-visit-parents/index.js
init_esbuild_shims();

// node_modules/unist-util-visit-parents/lib/index.js
init_esbuild_shims();

// node_modules/unist-util-is/index.js
init_esbuild_shims();

// node_modules/unist-util-is/lib/index.js
init_esbuild_shims();
var convert = (
  // Note: overloads in JSDoc can’t yet use different `@template`s.
  /**
   * @type {(
   *   (<Condition extends string>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & {type: Condition}) &
   *   (<Condition extends Props>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & Condition) &
   *   (<Condition extends TestFunction>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & Predicate<Condition, Node>) &
   *   ((test?: null | undefined) => (node?: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node) &
   *   ((test?: Test) => Check)
   * )}
   */
  /**
   * @param {Test} [test]
   * @returns {Check}
   */
  /* @__PURE__ */ __name(function(test) {
    if (test === null || test === void 0) {
      return ok2;
    }
    if (typeof test === "function") {
      return castFactory(test);
    }
    if (typeof test === "object") {
      return Array.isArray(test) ? anyFactory(test) : (
        // Cast because `ReadonlyArray` goes into the above but `isArray`
        // narrows to `Array`.
        propertiesFactory(
          /** @type {Props} */
          test
        )
      );
    }
    if (typeof test === "string") {
      return typeFactory(test);
    }
    throw new Error("Expected function, string, or object as test");
  }, "convert")
);
function anyFactory(tests) {
  const checks = [];
  let index2 = -1;
  while (++index2 < tests.length) {
    checks[index2] = convert(tests[index2]);
  }
  return castFactory(any);
  function any(...parameters) {
    let index3 = -1;
    while (++index3 < checks.length) {
      if (checks[index3].apply(this, parameters)) return true;
    }
    return false;
  }
  __name(any, "any");
}
__name(anyFactory, "anyFactory");
function propertiesFactory(check) {
  const checkAsRecord = (
    /** @type {Record<string, unknown>} */
    check
  );
  return castFactory(all2);
  function all2(node2) {
    const nodeAsRecord = (
      /** @type {Record<string, unknown>} */
      /** @type {unknown} */
      node2
    );
    let key;
    for (key in check) {
      if (nodeAsRecord[key] !== checkAsRecord[key]) return false;
    }
    return true;
  }
  __name(all2, "all");
}
__name(propertiesFactory, "propertiesFactory");
function typeFactory(check) {
  return castFactory(type);
  function type(node2) {
    return node2 && node2.type === check;
  }
  __name(type, "type");
}
__name(typeFactory, "typeFactory");
function castFactory(testFunction) {
  return check;
  function check(value, index2, parent) {
    return Boolean(
      looksLikeANode(value) && testFunction.call(
        this,
        value,
        typeof index2 === "number" ? index2 : void 0,
        parent || void 0
      )
    );
  }
  __name(check, "check");
}
__name(castFactory, "castFactory");
function ok2() {
  return true;
}
__name(ok2, "ok");
function looksLikeANode(value) {
  return value !== null && typeof value === "object" && "type" in value;
}
__name(looksLikeANode, "looksLikeANode");

// node_modules/unist-util-visit-parents/lib/color.node.js
init_esbuild_shims();
function color(d) {
  return "\x1B[33m" + d + "\x1B[39m";
}
__name(color, "color");

// node_modules/unist-util-visit-parents/lib/index.js
var empty = [];
var CONTINUE = true;
var EXIT = false;
var SKIP = "skip";
function visitParents(tree, test, visitor, reverse) {
  let check;
  if (typeof test === "function" && typeof visitor !== "function") {
    reverse = visitor;
    visitor = test;
  } else {
    check = test;
  }
  const is2 = convert(check);
  const step = reverse ? -1 : 1;
  factory(tree, void 0, [])();
  function factory(node2, index2, parents) {
    const value = (
      /** @type {Record<string, unknown>} */
      node2 && typeof node2 === "object" ? node2 : {}
    );
    if (typeof value.type === "string") {
      const name = (
        // `hast`
        typeof value.tagName === "string" ? value.tagName : (
          // `xast`
          typeof value.name === "string" ? value.name : void 0
        )
      );
      Object.defineProperty(visit2, "name", {
        value: "node (" + color(node2.type + (name ? "<" + name + ">" : "")) + ")"
      });
    }
    return visit2;
    function visit2() {
      let result = empty;
      let subresult;
      let offset;
      let grandparents;
      if (!test || is2(node2, index2, parents[parents.length - 1] || void 0)) {
        result = toResult(visitor(node2, parents));
        if (result[0] === EXIT) {
          return result;
        }
      }
      if ("children" in node2 && node2.children) {
        const nodeAsParent = (
          /** @type {UnistParent} */
          node2
        );
        if (nodeAsParent.children && result[0] !== SKIP) {
          offset = (reverse ? nodeAsParent.children.length : -1) + step;
          grandparents = parents.concat(nodeAsParent);
          while (offset > -1 && offset < nodeAsParent.children.length) {
            const child = nodeAsParent.children[offset];
            subresult = factory(child, offset, grandparents)();
            if (subresult[0] === EXIT) {
              return subresult;
            }
            offset = typeof subresult[1] === "number" ? subresult[1] : offset + step;
          }
        }
      }
      return result;
    }
    __name(visit2, "visit");
  }
  __name(factory, "factory");
}
__name(visitParents, "visitParents");
function toResult(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "number") {
    return [CONTINUE, value];
  }
  return value === null || value === void 0 ? empty : [value];
}
__name(toResult, "toResult");

// node_modules/mdast-util-find-and-replace/lib/index.js
function findAndReplace(tree, list3, options) {
  const settings = options || {};
  const ignored = convert(settings.ignore || []);
  const pairs = toPairs(list3);
  let pairIndex = -1;
  while (++pairIndex < pairs.length) {
    visitParents(tree, "text", visitor);
  }
  function visitor(node2, parents) {
    let index2 = -1;
    let grandparent;
    while (++index2 < parents.length) {
      const parent = parents[index2];
      const siblings = grandparent ? grandparent.children : void 0;
      if (ignored(
        parent,
        siblings ? siblings.indexOf(parent) : void 0,
        grandparent
      )) {
        return;
      }
      grandparent = parent;
    }
    if (grandparent) {
      return handler(node2, parents);
    }
  }
  __name(visitor, "visitor");
  function handler(node2, parents) {
    const parent = parents[parents.length - 1];
    const find = pairs[pairIndex][0];
    const replace2 = pairs[pairIndex][1];
    let start = 0;
    const siblings = parent.children;
    const index2 = siblings.indexOf(node2);
    let change = false;
    let nodes = [];
    find.lastIndex = 0;
    let match = find.exec(node2.value);
    while (match) {
      const position2 = match.index;
      const matchObject = {
        index: match.index,
        input: match.input,
        stack: [...parents, node2]
      };
      let value = replace2(...match, matchObject);
      if (typeof value === "string") {
        value = value.length > 0 ? { type: "text", value } : void 0;
      }
      if (value === false) {
        find.lastIndex = position2 + 1;
      } else {
        if (start !== position2) {
          nodes.push({
            type: "text",
            value: node2.value.slice(start, position2)
          });
        }
        if (Array.isArray(value)) {
          nodes.push(...value);
        } else if (value) {
          nodes.push(value);
        }
        start = position2 + match[0].length;
        change = true;
      }
      if (!find.global) {
        break;
      }
      match = find.exec(node2.value);
    }
    if (change) {
      if (start < node2.value.length) {
        nodes.push({ type: "text", value: node2.value.slice(start) });
      }
      parent.children.splice(index2, 1, ...nodes);
    } else {
      nodes = [node2];
    }
    return index2 + nodes.length;
  }
  __name(handler, "handler");
}
__name(findAndReplace, "findAndReplace");
function toPairs(tupleOrList) {
  const result = [];
  if (!Array.isArray(tupleOrList)) {
    throw new TypeError("Expected find and replace tuple or list of tuples");
  }
  const list3 = !tupleOrList[0] || Array.isArray(tupleOrList[0]) ? tupleOrList : [tupleOrList];
  let index2 = -1;
  while (++index2 < list3.length) {
    const tuple = list3[index2];
    result.push([toExpression(tuple[0]), toFunction(tuple[1])]);
  }
  return result;
}
__name(toPairs, "toPairs");
function toExpression(find) {
  return typeof find === "string" ? new RegExp(escapeStringRegexp(find), "g") : find;
}
__name(toExpression, "toExpression");
function toFunction(replace2) {
  return typeof replace2 === "function" ? replace2 : function() {
    return replace2;
  };
}
__name(toFunction, "toFunction");

// node_modules/mdast-util-gfm-autolink-literal/lib/index.js
var inConstruct = "phrasing";
var notInConstruct = ["autolink", "link", "image", "label"];
function gfmAutolinkLiteralFromMarkdown() {
  return {
    transforms: [transformGfmAutolinkLiterals],
    enter: {
      literalAutolink: enterLiteralAutolink,
      literalAutolinkEmail: enterLiteralAutolinkValue,
      literalAutolinkHttp: enterLiteralAutolinkValue,
      literalAutolinkWww: enterLiteralAutolinkValue
    },
    exit: {
      literalAutolink: exitLiteralAutolink,
      literalAutolinkEmail: exitLiteralAutolinkEmail,
      literalAutolinkHttp: exitLiteralAutolinkHttp,
      literalAutolinkWww: exitLiteralAutolinkWww
    }
  };
}
__name(gfmAutolinkLiteralFromMarkdown, "gfmAutolinkLiteralFromMarkdown");
function gfmAutolinkLiteralToMarkdown() {
  return {
    unsafe: [
      {
        character: "@",
        before: "[+\\-.\\w]",
        after: "[\\-.\\w]",
        inConstruct,
        notInConstruct
      },
      {
        character: ".",
        before: "[Ww]",
        after: "[\\-.\\w]",
        inConstruct,
        notInConstruct
      },
      {
        character: ":",
        before: "[ps]",
        after: "\\/",
        inConstruct,
        notInConstruct
      }
    ]
  };
}
__name(gfmAutolinkLiteralToMarkdown, "gfmAutolinkLiteralToMarkdown");
function enterLiteralAutolink(token) {
  this.enter({ type: "link", title: null, url: "", children: [] }, token);
}
__name(enterLiteralAutolink, "enterLiteralAutolink");
function enterLiteralAutolinkValue(token) {
  this.config.enter.autolinkProtocol.call(this, token);
}
__name(enterLiteralAutolinkValue, "enterLiteralAutolinkValue");
function exitLiteralAutolinkHttp(token) {
  this.config.exit.autolinkProtocol.call(this, token);
}
__name(exitLiteralAutolinkHttp, "exitLiteralAutolinkHttp");
function exitLiteralAutolinkWww(token) {
  this.config.exit.data.call(this, token);
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "link");
  node2.url = "http://" + this.sliceSerialize(token);
}
__name(exitLiteralAutolinkWww, "exitLiteralAutolinkWww");
function exitLiteralAutolinkEmail(token) {
  this.config.exit.autolinkEmail.call(this, token);
}
__name(exitLiteralAutolinkEmail, "exitLiteralAutolinkEmail");
function exitLiteralAutolink(token) {
  this.exit(token);
}
__name(exitLiteralAutolink, "exitLiteralAutolink");
function transformGfmAutolinkLiterals(tree) {
  findAndReplace(
    tree,
    [
      [/(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi, findUrl],
      [new RegExp("(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)", "gu"), findEmail]
    ],
    { ignore: ["link", "linkReference"] }
  );
}
__name(transformGfmAutolinkLiterals, "transformGfmAutolinkLiterals");
function findUrl(_, protocol, domain2, path3, match) {
  let prefix = "";
  if (!previous(match)) {
    return false;
  }
  if (/^w/i.test(protocol)) {
    domain2 = protocol + domain2;
    protocol = "";
    prefix = "http://";
  }
  if (!isCorrectDomain(domain2)) {
    return false;
  }
  const parts = splitUrl(domain2 + path3);
  if (!parts[0]) return false;
  const result = {
    type: "link",
    title: null,
    url: prefix + protocol + parts[0],
    children: [{ type: "text", value: protocol + parts[0] }]
  };
  if (parts[1]) {
    return [result, { type: "text", value: parts[1] }];
  }
  return result;
}
__name(findUrl, "findUrl");
function findEmail(_, atext, label, match) {
  if (
    // Not an expected previous character.
    !previous(match, true) || // Label ends in not allowed character.
    /[-\d_]$/.test(label)
  ) {
    return false;
  }
  return {
    type: "link",
    title: null,
    url: "mailto:" + atext + "@" + label,
    children: [{ type: "text", value: atext + "@" + label }]
  };
}
__name(findEmail, "findEmail");
function isCorrectDomain(domain2) {
  const parts = domain2.split(".");
  if (parts.length < 2 || parts[parts.length - 1] && (/_/.test(parts[parts.length - 1]) || !/[a-zA-Z\d]/.test(parts[parts.length - 1])) || parts[parts.length - 2] && (/_/.test(parts[parts.length - 2]) || !/[a-zA-Z\d]/.test(parts[parts.length - 2]))) {
    return false;
  }
  return true;
}
__name(isCorrectDomain, "isCorrectDomain");
function splitUrl(url) {
  const trailExec = /[!"&'),.:;<>?\]}]+$/.exec(url);
  if (!trailExec) {
    return [url, void 0];
  }
  url = url.slice(0, trailExec.index);
  let trail2 = trailExec[0];
  let closingParenIndex = trail2.indexOf(")");
  const openingParens = ccount(url, "(");
  let closingParens = ccount(url, ")");
  while (closingParenIndex !== -1 && openingParens > closingParens) {
    url += trail2.slice(0, closingParenIndex + 1);
    trail2 = trail2.slice(closingParenIndex + 1);
    closingParenIndex = trail2.indexOf(")");
    closingParens++;
  }
  return [url, trail2];
}
__name(splitUrl, "splitUrl");
function previous(match, email) {
  const code3 = match.input.charCodeAt(match.index - 1);
  return (match.index === 0 || unicodeWhitespace(code3) || unicodePunctuation(code3)) && // If it’s an email, the previous character should not be a slash.
  (!email || code3 !== 47);
}
__name(previous, "previous");

// node_modules/mdast-util-gfm-footnote/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm-footnote/lib/index.js
init_esbuild_shims();

// node_modules/micromark-util-normalize-identifier/index.js
init_esbuild_shims();
function normalizeIdentifier(value) {
  return value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}
__name(normalizeIdentifier, "normalizeIdentifier");

// node_modules/mdast-util-gfm-footnote/lib/index.js
footnoteReference.peek = footnoteReferencePeek;
function enterFootnoteCallString() {
  this.buffer();
}
__name(enterFootnoteCallString, "enterFootnoteCallString");
function enterFootnoteCall(token) {
  this.enter({ type: "footnoteReference", identifier: "", label: "" }, token);
}
__name(enterFootnoteCall, "enterFootnoteCall");
function enterFootnoteDefinitionLabelString() {
  this.buffer();
}
__name(enterFootnoteDefinitionLabelString, "enterFootnoteDefinitionLabelString");
function enterFootnoteDefinition(token) {
  this.enter(
    { type: "footnoteDefinition", identifier: "", label: "", children: [] },
    token
  );
}
__name(enterFootnoteDefinition, "enterFootnoteDefinition");
function exitFootnoteCallString(token) {
  const label = this.resume();
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "footnoteReference");
  node2.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  node2.label = label;
}
__name(exitFootnoteCallString, "exitFootnoteCallString");
function exitFootnoteCall(token) {
  this.exit(token);
}
__name(exitFootnoteCall, "exitFootnoteCall");
function exitFootnoteDefinitionLabelString(token) {
  const label = this.resume();
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "footnoteDefinition");
  node2.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  node2.label = label;
}
__name(exitFootnoteDefinitionLabelString, "exitFootnoteDefinitionLabelString");
function exitFootnoteDefinition(token) {
  this.exit(token);
}
__name(exitFootnoteDefinition, "exitFootnoteDefinition");
function footnoteReferencePeek() {
  return "[";
}
__name(footnoteReferencePeek, "footnoteReferencePeek");
function footnoteReference(node2, _, state, info) {
  const tracker = state.createTracker(info);
  let value = tracker.move("[^");
  const exit3 = state.enter("footnoteReference");
  const subexit = state.enter("reference");
  value += tracker.move(
    state.safe(state.associationId(node2), { after: "]", before: value })
  );
  subexit();
  exit3();
  value += tracker.move("]");
  return value;
}
__name(footnoteReference, "footnoteReference");
function gfmFootnoteFromMarkdown() {
  return {
    enter: {
      gfmFootnoteCallString: enterFootnoteCallString,
      gfmFootnoteCall: enterFootnoteCall,
      gfmFootnoteDefinitionLabelString: enterFootnoteDefinitionLabelString,
      gfmFootnoteDefinition: enterFootnoteDefinition
    },
    exit: {
      gfmFootnoteCallString: exitFootnoteCallString,
      gfmFootnoteCall: exitFootnoteCall,
      gfmFootnoteDefinitionLabelString: exitFootnoteDefinitionLabelString,
      gfmFootnoteDefinition: exitFootnoteDefinition
    }
  };
}
__name(gfmFootnoteFromMarkdown, "gfmFootnoteFromMarkdown");
function gfmFootnoteToMarkdown(options) {
  let firstLineBlank = false;
  if (options && options.firstLineBlank) {
    firstLineBlank = true;
  }
  return {
    handlers: { footnoteDefinition, footnoteReference },
    // This is on by default already.
    unsafe: [{ character: "[", inConstruct: ["label", "phrasing", "reference"] }]
  };
  function footnoteDefinition(node2, _, state, info) {
    const tracker = state.createTracker(info);
    let value = tracker.move("[^");
    const exit3 = state.enter("footnoteDefinition");
    const subexit = state.enter("label");
    value += tracker.move(
      state.safe(state.associationId(node2), { before: value, after: "]" })
    );
    subexit();
    value += tracker.move("]:");
    if (node2.children && node2.children.length > 0) {
      tracker.shift(4);
      value += tracker.move(
        (firstLineBlank ? "\n" : " ") + state.indentLines(
          state.containerFlow(node2, tracker.current()),
          firstLineBlank ? mapAll : mapExceptFirst
        )
      );
    }
    exit3();
    return value;
  }
  __name(footnoteDefinition, "footnoteDefinition");
}
__name(gfmFootnoteToMarkdown, "gfmFootnoteToMarkdown");
function mapExceptFirst(line, index2, blank) {
  return index2 === 0 ? line : mapAll(line, index2, blank);
}
__name(mapExceptFirst, "mapExceptFirst");
function mapAll(line, index2, blank) {
  return (blank ? "" : "    ") + line;
}
__name(mapAll, "mapAll");

// node_modules/mdast-util-gfm-strikethrough/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm-strikethrough/lib/index.js
init_esbuild_shims();
var constructsWithoutStrikethrough = [
  "autolink",
  "destinationLiteral",
  "destinationRaw",
  "reference",
  "titleQuote",
  "titleApostrophe"
];
handleDelete.peek = peekDelete;
function gfmStrikethroughFromMarkdown() {
  return {
    canContainEols: ["delete"],
    enter: { strikethrough: enterStrikethrough },
    exit: { strikethrough: exitStrikethrough }
  };
}
__name(gfmStrikethroughFromMarkdown, "gfmStrikethroughFromMarkdown");
function gfmStrikethroughToMarkdown() {
  return {
    unsafe: [
      {
        character: "~",
        inConstruct: "phrasing",
        notInConstruct: constructsWithoutStrikethrough
      }
    ],
    handlers: { delete: handleDelete }
  };
}
__name(gfmStrikethroughToMarkdown, "gfmStrikethroughToMarkdown");
function enterStrikethrough(token) {
  this.enter({ type: "delete", children: [] }, token);
}
__name(enterStrikethrough, "enterStrikethrough");
function exitStrikethrough(token) {
  this.exit(token);
}
__name(exitStrikethrough, "exitStrikethrough");
function handleDelete(node2, _, state, info) {
  const tracker = state.createTracker(info);
  const exit3 = state.enter("strikethrough");
  let value = tracker.move("~~");
  value += state.containerPhrasing(node2, {
    ...tracker.current(),
    before: value,
    after: "~"
  });
  value += tracker.move("~~");
  exit3();
  return value;
}
__name(handleDelete, "handleDelete");
function peekDelete() {
  return "~";
}
__name(peekDelete, "peekDelete");

// node_modules/mdast-util-gfm-table/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm-table/lib/index.js
init_esbuild_shims();

// node_modules/markdown-table/index.js
init_esbuild_shims();
function defaultStringLength(value) {
  return value.length;
}
__name(defaultStringLength, "defaultStringLength");
function markdownTable(table, options) {
  const settings = options || {};
  const align = (settings.align || []).concat();
  const stringLength = settings.stringLength || defaultStringLength;
  const alignments = [];
  const cellMatrix = [];
  const sizeMatrix = [];
  const longestCellByColumn = [];
  let mostCellsPerRow = 0;
  let rowIndex = -1;
  while (++rowIndex < table.length) {
    const row2 = [];
    const sizes2 = [];
    let columnIndex2 = -1;
    if (table[rowIndex].length > mostCellsPerRow) {
      mostCellsPerRow = table[rowIndex].length;
    }
    while (++columnIndex2 < table[rowIndex].length) {
      const cell = serialize(table[rowIndex][columnIndex2]);
      if (settings.alignDelimiters !== false) {
        const size = stringLength(cell);
        sizes2[columnIndex2] = size;
        if (longestCellByColumn[columnIndex2] === void 0 || size > longestCellByColumn[columnIndex2]) {
          longestCellByColumn[columnIndex2] = size;
        }
      }
      row2.push(cell);
    }
    cellMatrix[rowIndex] = row2;
    sizeMatrix[rowIndex] = sizes2;
  }
  let columnIndex = -1;
  if (typeof align === "object" && "length" in align) {
    while (++columnIndex < mostCellsPerRow) {
      alignments[columnIndex] = toAlignment(align[columnIndex]);
    }
  } else {
    const code3 = toAlignment(align);
    while (++columnIndex < mostCellsPerRow) {
      alignments[columnIndex] = code3;
    }
  }
  columnIndex = -1;
  const row = [];
  const sizes = [];
  while (++columnIndex < mostCellsPerRow) {
    const code3 = alignments[columnIndex];
    let before = "";
    let after = "";
    if (code3 === 99) {
      before = ":";
      after = ":";
    } else if (code3 === 108) {
      before = ":";
    } else if (code3 === 114) {
      after = ":";
    }
    let size = settings.alignDelimiters === false ? 1 : Math.max(
      1,
      longestCellByColumn[columnIndex] - before.length - after.length
    );
    const cell = before + "-".repeat(size) + after;
    if (settings.alignDelimiters !== false) {
      size = before.length + size + after.length;
      if (size > longestCellByColumn[columnIndex]) {
        longestCellByColumn[columnIndex] = size;
      }
      sizes[columnIndex] = size;
    }
    row[columnIndex] = cell;
  }
  cellMatrix.splice(1, 0, row);
  sizeMatrix.splice(1, 0, sizes);
  rowIndex = -1;
  const lines = [];
  while (++rowIndex < cellMatrix.length) {
    const row2 = cellMatrix[rowIndex];
    const sizes2 = sizeMatrix[rowIndex];
    columnIndex = -1;
    const line = [];
    while (++columnIndex < mostCellsPerRow) {
      const cell = row2[columnIndex] || "";
      let before = "";
      let after = "";
      if (settings.alignDelimiters !== false) {
        const size = longestCellByColumn[columnIndex] - (sizes2[columnIndex] || 0);
        const code3 = alignments[columnIndex];
        if (code3 === 114) {
          before = " ".repeat(size);
        } else if (code3 === 99) {
          if (size % 2) {
            before = " ".repeat(size / 2 + 0.5);
            after = " ".repeat(size / 2 - 0.5);
          } else {
            before = " ".repeat(size / 2);
            after = before;
          }
        } else {
          after = " ".repeat(size);
        }
      }
      if (settings.delimiterStart !== false && !columnIndex) {
        line.push("|");
      }
      if (settings.padding !== false && // Don’t add the opening space if we’re not aligning and the cell is
      // empty: there will be a closing space.
      !(settings.alignDelimiters === false && cell === "") && (settings.delimiterStart !== false || columnIndex)) {
        line.push(" ");
      }
      if (settings.alignDelimiters !== false) {
        line.push(before);
      }
      line.push(cell);
      if (settings.alignDelimiters !== false) {
        line.push(after);
      }
      if (settings.padding !== false) {
        line.push(" ");
      }
      if (settings.delimiterEnd !== false || columnIndex !== mostCellsPerRow - 1) {
        line.push("|");
      }
    }
    lines.push(
      settings.delimiterEnd === false ? line.join("").replace(/ +$/, "") : line.join("")
    );
  }
  return lines.join("\n");
}
__name(markdownTable, "markdownTable");
function serialize(value) {
  return value === null || value === void 0 ? "" : String(value);
}
__name(serialize, "serialize");
function toAlignment(value) {
  const code3 = typeof value === "string" ? value.codePointAt(0) : 0;
  return code3 === 67 || code3 === 99 ? 99 : code3 === 76 || code3 === 108 ? 108 : code3 === 82 || code3 === 114 ? 114 : 0;
}
__name(toAlignment, "toAlignment");

// node_modules/mdast-util-to-markdown/index.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/handle/index.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/handle/blockquote.js
init_esbuild_shims();
function blockquote(node2, _, state, info) {
  const exit3 = state.enter("blockquote");
  const tracker = state.createTracker(info);
  tracker.move("> ");
  tracker.shift(2);
  const value = state.indentLines(
    state.containerFlow(node2, tracker.current()),
    map
  );
  exit3();
  return value;
}
__name(blockquote, "blockquote");
function map(line, _, blank) {
  return ">" + (blank ? "" : " ") + line;
}
__name(map, "map");

// node_modules/mdast-util-to-markdown/lib/handle/break.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/pattern-in-scope.js
init_esbuild_shims();
function patternInScope(stack, pattern) {
  return listInScope(stack, pattern.inConstruct, true) && !listInScope(stack, pattern.notInConstruct, false);
}
__name(patternInScope, "patternInScope");
function listInScope(stack, list3, none) {
  if (typeof list3 === "string") {
    list3 = [list3];
  }
  if (!list3 || list3.length === 0) {
    return none;
  }
  let index2 = -1;
  while (++index2 < list3.length) {
    if (stack.includes(list3[index2])) {
      return true;
    }
  }
  return false;
}
__name(listInScope, "listInScope");

// node_modules/mdast-util-to-markdown/lib/handle/break.js
function hardBreak(_, _1, state, info) {
  let index2 = -1;
  while (++index2 < state.unsafe.length) {
    if (state.unsafe[index2].character === "\n" && patternInScope(state.stack, state.unsafe[index2])) {
      return /[ \t]/.test(info.before) ? "" : " ";
    }
  }
  return "\\\n";
}
__name(hardBreak, "hardBreak");

// node_modules/mdast-util-to-markdown/lib/handle/code.js
init_esbuild_shims();

// node_modules/longest-streak/index.js
init_esbuild_shims();
function longestStreak(value, substring) {
  const source = String(value);
  let index2 = source.indexOf(substring);
  let expected = index2;
  let count = 0;
  let max = 0;
  if (typeof substring !== "string") {
    throw new TypeError("Expected substring");
  }
  while (index2 !== -1) {
    if (index2 === expected) {
      if (++count > max) {
        max = count;
      }
    } else {
      count = 1;
    }
    expected = index2 + substring.length;
    index2 = source.indexOf(substring, expected);
  }
  return max;
}
__name(longestStreak, "longestStreak");

// node_modules/mdast-util-to-markdown/lib/util/format-code-as-indented.js
init_esbuild_shims();
function formatCodeAsIndented(node2, state) {
  return Boolean(
    state.options.fences === false && node2.value && // If there’s no info…
    !node2.lang && // And there’s a non-whitespace character…
    /[^ \r\n]/.test(node2.value) && // And the value doesn’t start or end in a blank…
    !/^[\t ]*(?:[\r\n]|$)|(?:^|[\r\n])[\t ]*$/.test(node2.value)
  );
}
__name(formatCodeAsIndented, "formatCodeAsIndented");

// node_modules/mdast-util-to-markdown/lib/util/check-fence.js
init_esbuild_shims();
function checkFence(state) {
  const marker = state.options.fence || "`";
  if (marker !== "`" && marker !== "~") {
    throw new Error(
      "Cannot serialize code with `" + marker + "` for `options.fence`, expected `` ` `` or `~`"
    );
  }
  return marker;
}
__name(checkFence, "checkFence");

// node_modules/mdast-util-to-markdown/lib/handle/code.js
function code(node2, _, state, info) {
  const marker = checkFence(state);
  const raw = node2.value || "";
  const suffix = marker === "`" ? "GraveAccent" : "Tilde";
  if (formatCodeAsIndented(node2, state)) {
    const exit4 = state.enter("codeIndented");
    const value2 = state.indentLines(raw, map2);
    exit4();
    return value2;
  }
  const tracker = state.createTracker(info);
  const sequence = marker.repeat(Math.max(longestStreak(raw, marker) + 1, 3));
  const exit3 = state.enter("codeFenced");
  let value = tracker.move(sequence);
  if (node2.lang) {
    const subexit = state.enter(`codeFencedLang${suffix}`);
    value += tracker.move(
      state.safe(node2.lang, {
        before: value,
        after: " ",
        encode: ["`"],
        ...tracker.current()
      })
    );
    subexit();
  }
  if (node2.lang && node2.meta) {
    const subexit = state.enter(`codeFencedMeta${suffix}`);
    value += tracker.move(" ");
    value += tracker.move(
      state.safe(node2.meta, {
        before: value,
        after: "\n",
        encode: ["`"],
        ...tracker.current()
      })
    );
    subexit();
  }
  value += tracker.move("\n");
  if (raw) {
    value += tracker.move(raw + "\n");
  }
  value += tracker.move(sequence);
  exit3();
  return value;
}
__name(code, "code");
function map2(line, _, blank) {
  return (blank ? "" : "    ") + line;
}
__name(map2, "map");

// node_modules/mdast-util-to-markdown/lib/handle/definition.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/check-quote.js
init_esbuild_shims();
function checkQuote(state) {
  const marker = state.options.quote || '"';
  if (marker !== '"' && marker !== "'") {
    throw new Error(
      "Cannot serialize title with `" + marker + "` for `options.quote`, expected `\"`, or `'`"
    );
  }
  return marker;
}
__name(checkQuote, "checkQuote");

// node_modules/mdast-util-to-markdown/lib/handle/definition.js
function definition(node2, _, state, info) {
  const quote = checkQuote(state);
  const suffix = quote === '"' ? "Quote" : "Apostrophe";
  const exit3 = state.enter("definition");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("[");
  value += tracker.move(
    state.safe(state.associationId(node2), {
      before: value,
      after: "]",
      ...tracker.current()
    })
  );
  value += tracker.move("]: ");
  subexit();
  if (
    // If there’s no url, or…
    !node2.url || // If there are control characters or whitespace.
    /[\0- \u007F]/.test(node2.url)
  ) {
    subexit = state.enter("destinationLiteral");
    value += tracker.move("<");
    value += tracker.move(
      state.safe(node2.url, { before: value, after: ">", ...tracker.current() })
    );
    value += tracker.move(">");
  } else {
    subexit = state.enter("destinationRaw");
    value += tracker.move(
      state.safe(node2.url, {
        before: value,
        after: node2.title ? " " : "\n",
        ...tracker.current()
      })
    );
  }
  subexit();
  if (node2.title) {
    subexit = state.enter(`title${suffix}`);
    value += tracker.move(" " + quote);
    value += tracker.move(
      state.safe(node2.title, {
        before: value,
        after: quote,
        ...tracker.current()
      })
    );
    value += tracker.move(quote);
    subexit();
  }
  exit3();
  return value;
}
__name(definition, "definition");

// node_modules/mdast-util-to-markdown/lib/handle/emphasis.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/check-emphasis.js
init_esbuild_shims();
function checkEmphasis(state) {
  const marker = state.options.emphasis || "*";
  if (marker !== "*" && marker !== "_") {
    throw new Error(
      "Cannot serialize emphasis with `" + marker + "` for `options.emphasis`, expected `*`, or `_`"
    );
  }
  return marker;
}
__name(checkEmphasis, "checkEmphasis");

// node_modules/mdast-util-to-markdown/lib/util/encode-character-reference.js
init_esbuild_shims();
function encodeCharacterReference(code3) {
  return "&#x" + code3.toString(16).toUpperCase() + ";";
}
__name(encodeCharacterReference, "encodeCharacterReference");

// node_modules/mdast-util-to-markdown/lib/util/encode-info.js
init_esbuild_shims();

// node_modules/micromark-util-classify-character/index.js
init_esbuild_shims();
function classifyCharacter(code3) {
  if (code3 === null || markdownLineEndingOrSpace(code3) || unicodeWhitespace(code3)) {
    return 1;
  }
  if (unicodePunctuation(code3)) {
    return 2;
  }
}
__name(classifyCharacter, "classifyCharacter");

// node_modules/mdast-util-to-markdown/lib/util/encode-info.js
function encodeInfo(outside, inside, marker) {
  const outsideKind = classifyCharacter(outside);
  const insideKind = classifyCharacter(inside);
  if (outsideKind === void 0) {
    return insideKind === void 0 ? (
      // Letter inside:
      // we have to encode *both* letters for `_` as it is looser.
      // it already forms for `*` (and GFMs `~`).
      marker === "_" ? { inside: true, outside: true } : { inside: false, outside: false }
    ) : insideKind === 1 ? (
      // Whitespace inside: encode both (letter, whitespace).
      { inside: true, outside: true }
    ) : (
      // Punctuation inside: encode outer (letter)
      { inside: false, outside: true }
    );
  }
  if (outsideKind === 1) {
    return insideKind === void 0 ? (
      // Letter inside: already forms.
      { inside: false, outside: false }
    ) : insideKind === 1 ? (
      // Whitespace inside: encode both (whitespace).
      { inside: true, outside: true }
    ) : (
      // Punctuation inside: already forms.
      { inside: false, outside: false }
    );
  }
  return insideKind === void 0 ? (
    // Letter inside: already forms.
    { inside: false, outside: false }
  ) : insideKind === 1 ? (
    // Whitespace inside: encode inner (whitespace).
    { inside: true, outside: false }
  ) : (
    // Punctuation inside: already forms.
    { inside: false, outside: false }
  );
}
__name(encodeInfo, "encodeInfo");

// node_modules/mdast-util-to-markdown/lib/handle/emphasis.js
emphasis.peek = emphasisPeek;
function emphasis(node2, _, state, info) {
  const marker = checkEmphasis(state);
  const exit3 = state.enter("emphasis");
  const tracker = state.createTracker(info);
  const before = tracker.move(marker);
  let between = tracker.move(
    state.containerPhrasing(node2, {
      after: marker,
      before,
      ...tracker.current()
    })
  );
  const betweenHead = between.charCodeAt(0);
  const open = encodeInfo(
    info.before.charCodeAt(info.before.length - 1),
    betweenHead,
    marker
  );
  if (open.inside) {
    between = encodeCharacterReference(betweenHead) + between.slice(1);
  }
  const betweenTail = between.charCodeAt(between.length - 1);
  const close = encodeInfo(info.after.charCodeAt(0), betweenTail, marker);
  if (close.inside) {
    between = between.slice(0, -1) + encodeCharacterReference(betweenTail);
  }
  const after = tracker.move(marker);
  exit3();
  state.attentionEncodeSurroundingInfo = {
    after: close.outside,
    before: open.outside
  };
  return before + between + after;
}
__name(emphasis, "emphasis");
function emphasisPeek(_, _1, state) {
  return state.options.emphasis || "*";
}
__name(emphasisPeek, "emphasisPeek");

// node_modules/mdast-util-to-markdown/lib/handle/heading.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/format-heading-as-setext.js
init_esbuild_shims();

// node_modules/unist-util-visit/index.js
init_esbuild_shims();

// node_modules/unist-util-visit/lib/index.js
init_esbuild_shims();
function visit(tree, testOrVisitor, visitorOrReverse, maybeReverse) {
  let reverse;
  let test;
  let visitor;
  if (typeof testOrVisitor === "function" && typeof visitorOrReverse !== "function") {
    test = void 0;
    visitor = testOrVisitor;
    reverse = visitorOrReverse;
  } else {
    test = testOrVisitor;
    visitor = visitorOrReverse;
    reverse = maybeReverse;
  }
  visitParents(tree, test, overload, reverse);
  function overload(node2, parents) {
    const parent = parents[parents.length - 1];
    const index2 = parent ? parent.children.indexOf(node2) : void 0;
    return visitor(node2, index2, parent);
  }
  __name(overload, "overload");
}
__name(visit, "visit");

// node_modules/mdast-util-to-string/index.js
init_esbuild_shims();

// node_modules/mdast-util-to-string/lib/index.js
init_esbuild_shims();
var emptyOptions = {};
function toString(value, options) {
  const settings = options || emptyOptions;
  const includeImageAlt = typeof settings.includeImageAlt === "boolean" ? settings.includeImageAlt : true;
  const includeHtml = typeof settings.includeHtml === "boolean" ? settings.includeHtml : true;
  return one(value, includeImageAlt, includeHtml);
}
__name(toString, "toString");
function one(value, includeImageAlt, includeHtml) {
  if (node(value)) {
    if ("value" in value) {
      return value.type === "html" && !includeHtml ? "" : value.value;
    }
    if (includeImageAlt && "alt" in value && value.alt) {
      return value.alt;
    }
    if ("children" in value) {
      return all(value.children, includeImageAlt, includeHtml);
    }
  }
  if (Array.isArray(value)) {
    return all(value, includeImageAlt, includeHtml);
  }
  return "";
}
__name(one, "one");
function all(values, includeImageAlt, includeHtml) {
  const result = [];
  let index2 = -1;
  while (++index2 < values.length) {
    result[index2] = one(values[index2], includeImageAlt, includeHtml);
  }
  return result.join("");
}
__name(all, "all");
function node(value) {
  return Boolean(value && typeof value === "object");
}
__name(node, "node");

// node_modules/mdast-util-to-markdown/lib/util/format-heading-as-setext.js
function formatHeadingAsSetext(node2, state) {
  let literalWithBreak = false;
  visit(node2, function(node3) {
    if ("value" in node3 && /\r?\n|\r/.test(node3.value) || node3.type === "break") {
      literalWithBreak = true;
      return EXIT;
    }
  });
  return Boolean(
    (!node2.depth || node2.depth < 3) && toString(node2) && (state.options.setext || literalWithBreak)
  );
}
__name(formatHeadingAsSetext, "formatHeadingAsSetext");

// node_modules/mdast-util-to-markdown/lib/handle/heading.js
function heading(node2, _, state, info) {
  const rank = Math.max(Math.min(6, node2.depth || 1), 1);
  const tracker = state.createTracker(info);
  if (formatHeadingAsSetext(node2, state)) {
    const exit4 = state.enter("headingSetext");
    const subexit2 = state.enter("phrasing");
    const value2 = state.containerPhrasing(node2, {
      ...tracker.current(),
      before: "\n",
      after: "\n"
    });
    subexit2();
    exit4();
    return value2 + "\n" + (rank === 1 ? "=" : "-").repeat(
      // The whole size…
      value2.length - // Minus the position of the character after the last EOL (or
      // 0 if there is none)…
      (Math.max(value2.lastIndexOf("\r"), value2.lastIndexOf("\n")) + 1)
    );
  }
  const sequence = "#".repeat(rank);
  const exit3 = state.enter("headingAtx");
  const subexit = state.enter("phrasing");
  tracker.move(sequence + " ");
  let value = state.containerPhrasing(node2, {
    before: "# ",
    after: "\n",
    ...tracker.current()
  });
  if (/^[\t ]/.test(value)) {
    value = encodeCharacterReference(value.charCodeAt(0)) + value.slice(1);
  }
  value = value ? sequence + " " + value : sequence;
  if (state.options.closeAtx) {
    value += " " + sequence;
  }
  subexit();
  exit3();
  return value;
}
__name(heading, "heading");

// node_modules/mdast-util-to-markdown/lib/handle/html.js
init_esbuild_shims();
html.peek = htmlPeek;
function html(node2) {
  return node2.value || "";
}
__name(html, "html");
function htmlPeek() {
  return "<";
}
__name(htmlPeek, "htmlPeek");

// node_modules/mdast-util-to-markdown/lib/handle/image.js
init_esbuild_shims();
image.peek = imagePeek;
function image(node2, _, state, info) {
  const quote = checkQuote(state);
  const suffix = quote === '"' ? "Quote" : "Apostrophe";
  const exit3 = state.enter("image");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("![");
  value += tracker.move(
    state.safe(node2.alt, { before: value, after: "]", ...tracker.current() })
  );
  value += tracker.move("](");
  subexit();
  if (
    // If there’s no url but there is a title…
    !node2.url && node2.title || // If there are control characters or whitespace.
    /[\0- \u007F]/.test(node2.url)
  ) {
    subexit = state.enter("destinationLiteral");
    value += tracker.move("<");
    value += tracker.move(
      state.safe(node2.url, { before: value, after: ">", ...tracker.current() })
    );
    value += tracker.move(">");
  } else {
    subexit = state.enter("destinationRaw");
    value += tracker.move(
      state.safe(node2.url, {
        before: value,
        after: node2.title ? " " : ")",
        ...tracker.current()
      })
    );
  }
  subexit();
  if (node2.title) {
    subexit = state.enter(`title${suffix}`);
    value += tracker.move(" " + quote);
    value += tracker.move(
      state.safe(node2.title, {
        before: value,
        after: quote,
        ...tracker.current()
      })
    );
    value += tracker.move(quote);
    subexit();
  }
  value += tracker.move(")");
  exit3();
  return value;
}
__name(image, "image");
function imagePeek() {
  return "!";
}
__name(imagePeek, "imagePeek");

// node_modules/mdast-util-to-markdown/lib/handle/image-reference.js
init_esbuild_shims();
imageReference.peek = imageReferencePeek;
function imageReference(node2, _, state, info) {
  const type = node2.referenceType;
  const exit3 = state.enter("imageReference");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("![");
  const alt = state.safe(node2.alt, {
    before: value,
    after: "]",
    ...tracker.current()
  });
  value += tracker.move(alt + "][");
  subexit();
  const stack = state.stack;
  state.stack = [];
  subexit = state.enter("reference");
  const reference = state.safe(state.associationId(node2), {
    before: value,
    after: "]",
    ...tracker.current()
  });
  subexit();
  state.stack = stack;
  exit3();
  if (type === "full" || !alt || alt !== reference) {
    value += tracker.move(reference + "]");
  } else if (type === "shortcut") {
    value = value.slice(0, -1);
  } else {
    value += tracker.move("]");
  }
  return value;
}
__name(imageReference, "imageReference");
function imageReferencePeek() {
  return "!";
}
__name(imageReferencePeek, "imageReferencePeek");

// node_modules/mdast-util-to-markdown/lib/handle/inline-code.js
init_esbuild_shims();
inlineCode.peek = inlineCodePeek;
function inlineCode(node2, _, state) {
  let value = node2.value || "";
  let sequence = "`";
  let index2 = -1;
  while (new RegExp("(^|[^`])" + sequence + "([^`]|$)").test(value)) {
    sequence += "`";
  }
  if (/[^ \r\n]/.test(value) && (/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value) || /^`|`$/.test(value))) {
    value = " " + value + " ";
  }
  while (++index2 < state.unsafe.length) {
    const pattern = state.unsafe[index2];
    const expression = state.compilePattern(pattern);
    let match;
    if (!pattern.atBreak) continue;
    while (match = expression.exec(value)) {
      let position2 = match.index;
      if (value.charCodeAt(position2) === 10 && value.charCodeAt(position2 - 1) === 13) {
        position2--;
      }
      value = value.slice(0, position2) + " " + value.slice(match.index + 1);
    }
  }
  return sequence + value + sequence;
}
__name(inlineCode, "inlineCode");
function inlineCodePeek() {
  return "`";
}
__name(inlineCodePeek, "inlineCodePeek");

// node_modules/mdast-util-to-markdown/lib/handle/link.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/format-link-as-autolink.js
init_esbuild_shims();
function formatLinkAsAutolink(node2, state) {
  const raw = toString(node2);
  return Boolean(
    !state.options.resourceLink && // If there’s a url…
    node2.url && // And there’s a no title…
    !node2.title && // And the content of `node` is a single text node…
    node2.children && node2.children.length === 1 && node2.children[0].type === "text" && // And if the url is the same as the content…
    (raw === node2.url || "mailto:" + raw === node2.url) && // And that starts w/ a protocol…
    /^[a-z][a-z+.-]+:/i.test(node2.url) && // And that doesn’t contain ASCII control codes (character escapes and
    // references don’t work), space, or angle brackets…
    !/[\0- <>\u007F]/.test(node2.url)
  );
}
__name(formatLinkAsAutolink, "formatLinkAsAutolink");

// node_modules/mdast-util-to-markdown/lib/handle/link.js
link.peek = linkPeek;
function link(node2, _, state, info) {
  const quote = checkQuote(state);
  const suffix = quote === '"' ? "Quote" : "Apostrophe";
  const tracker = state.createTracker(info);
  let exit3;
  let subexit;
  if (formatLinkAsAutolink(node2, state)) {
    const stack = state.stack;
    state.stack = [];
    exit3 = state.enter("autolink");
    let value2 = tracker.move("<");
    value2 += tracker.move(
      state.containerPhrasing(node2, {
        before: value2,
        after: ">",
        ...tracker.current()
      })
    );
    value2 += tracker.move(">");
    exit3();
    state.stack = stack;
    return value2;
  }
  exit3 = state.enter("link");
  subexit = state.enter("label");
  let value = tracker.move("[");
  value += tracker.move(
    state.containerPhrasing(node2, {
      before: value,
      after: "](",
      ...tracker.current()
    })
  );
  value += tracker.move("](");
  subexit();
  if (
    // If there’s no url but there is a title…
    !node2.url && node2.title || // If there are control characters or whitespace.
    /[\0- \u007F]/.test(node2.url)
  ) {
    subexit = state.enter("destinationLiteral");
    value += tracker.move("<");
    value += tracker.move(
      state.safe(node2.url, { before: value, after: ">", ...tracker.current() })
    );
    value += tracker.move(">");
  } else {
    subexit = state.enter("destinationRaw");
    value += tracker.move(
      state.safe(node2.url, {
        before: value,
        after: node2.title ? " " : ")",
        ...tracker.current()
      })
    );
  }
  subexit();
  if (node2.title) {
    subexit = state.enter(`title${suffix}`);
    value += tracker.move(" " + quote);
    value += tracker.move(
      state.safe(node2.title, {
        before: value,
        after: quote,
        ...tracker.current()
      })
    );
    value += tracker.move(quote);
    subexit();
  }
  value += tracker.move(")");
  exit3();
  return value;
}
__name(link, "link");
function linkPeek(node2, _, state) {
  return formatLinkAsAutolink(node2, state) ? "<" : "[";
}
__name(linkPeek, "linkPeek");

// node_modules/mdast-util-to-markdown/lib/handle/link-reference.js
init_esbuild_shims();
linkReference.peek = linkReferencePeek;
function linkReference(node2, _, state, info) {
  const type = node2.referenceType;
  const exit3 = state.enter("linkReference");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("[");
  const text5 = state.containerPhrasing(node2, {
    before: value,
    after: "]",
    ...tracker.current()
  });
  value += tracker.move(text5 + "][");
  subexit();
  const stack = state.stack;
  state.stack = [];
  subexit = state.enter("reference");
  const reference = state.safe(state.associationId(node2), {
    before: value,
    after: "]",
    ...tracker.current()
  });
  subexit();
  state.stack = stack;
  exit3();
  if (type === "full" || !text5 || text5 !== reference) {
    value += tracker.move(reference + "]");
  } else if (type === "shortcut") {
    value = value.slice(0, -1);
  } else {
    value += tracker.move("]");
  }
  return value;
}
__name(linkReference, "linkReference");
function linkReferencePeek() {
  return "[";
}
__name(linkReferencePeek, "linkReferencePeek");

// node_modules/mdast-util-to-markdown/lib/handle/list.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/check-bullet.js
init_esbuild_shims();
function checkBullet(state) {
  const marker = state.options.bullet || "*";
  if (marker !== "*" && marker !== "+" && marker !== "-") {
    throw new Error(
      "Cannot serialize items with `" + marker + "` for `options.bullet`, expected `*`, `+`, or `-`"
    );
  }
  return marker;
}
__name(checkBullet, "checkBullet");

// node_modules/mdast-util-to-markdown/lib/util/check-bullet-other.js
init_esbuild_shims();
function checkBulletOther(state) {
  const bullet = checkBullet(state);
  const bulletOther = state.options.bulletOther;
  if (!bulletOther) {
    return bullet === "*" ? "-" : "*";
  }
  if (bulletOther !== "*" && bulletOther !== "+" && bulletOther !== "-") {
    throw new Error(
      "Cannot serialize items with `" + bulletOther + "` for `options.bulletOther`, expected `*`, `+`, or `-`"
    );
  }
  if (bulletOther === bullet) {
    throw new Error(
      "Expected `bullet` (`" + bullet + "`) and `bulletOther` (`" + bulletOther + "`) to be different"
    );
  }
  return bulletOther;
}
__name(checkBulletOther, "checkBulletOther");

// node_modules/mdast-util-to-markdown/lib/util/check-bullet-ordered.js
init_esbuild_shims();
function checkBulletOrdered(state) {
  const marker = state.options.bulletOrdered || ".";
  if (marker !== "." && marker !== ")") {
    throw new Error(
      "Cannot serialize items with `" + marker + "` for `options.bulletOrdered`, expected `.` or `)`"
    );
  }
  return marker;
}
__name(checkBulletOrdered, "checkBulletOrdered");

// node_modules/mdast-util-to-markdown/lib/util/check-rule.js
init_esbuild_shims();
function checkRule(state) {
  const marker = state.options.rule || "*";
  if (marker !== "*" && marker !== "-" && marker !== "_") {
    throw new Error(
      "Cannot serialize rules with `" + marker + "` for `options.rule`, expected `*`, `-`, or `_`"
    );
  }
  return marker;
}
__name(checkRule, "checkRule");

// node_modules/mdast-util-to-markdown/lib/handle/list.js
function list(node2, parent, state, info) {
  const exit3 = state.enter("list");
  const bulletCurrent = state.bulletCurrent;
  let bullet = node2.ordered ? checkBulletOrdered(state) : checkBullet(state);
  const bulletOther = node2.ordered ? bullet === "." ? ")" : "." : checkBulletOther(state);
  let useDifferentMarker = parent && state.bulletLastUsed ? bullet === state.bulletLastUsed : false;
  if (!node2.ordered) {
    const firstListItem = node2.children ? node2.children[0] : void 0;
    if (
      // Bullet could be used as a thematic break marker:
      (bullet === "*" || bullet === "-") && // Empty first list item:
      firstListItem && (!firstListItem.children || !firstListItem.children[0]) && // Directly in two other list items:
      state.stack[state.stack.length - 1] === "list" && state.stack[state.stack.length - 2] === "listItem" && state.stack[state.stack.length - 3] === "list" && state.stack[state.stack.length - 4] === "listItem" && // That are each the first child.
      state.indexStack[state.indexStack.length - 1] === 0 && state.indexStack[state.indexStack.length - 2] === 0 && state.indexStack[state.indexStack.length - 3] === 0
    ) {
      useDifferentMarker = true;
    }
    if (checkRule(state) === bullet && firstListItem) {
      let index2 = -1;
      while (++index2 < node2.children.length) {
        const item = node2.children[index2];
        if (item && item.type === "listItem" && item.children && item.children[0] && item.children[0].type === "thematicBreak") {
          useDifferentMarker = true;
          break;
        }
      }
    }
  }
  if (useDifferentMarker) {
    bullet = bulletOther;
  }
  state.bulletCurrent = bullet;
  const value = state.containerFlow(node2, info);
  state.bulletLastUsed = bullet;
  state.bulletCurrent = bulletCurrent;
  exit3();
  return value;
}
__name(list, "list");

// node_modules/mdast-util-to-markdown/lib/handle/list-item.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/check-list-item-indent.js
init_esbuild_shims();
function checkListItemIndent(state) {
  const style = state.options.listItemIndent || "one";
  if (style !== "tab" && style !== "one" && style !== "mixed") {
    throw new Error(
      "Cannot serialize items with `" + style + "` for `options.listItemIndent`, expected `tab`, `one`, or `mixed`"
    );
  }
  return style;
}
__name(checkListItemIndent, "checkListItemIndent");

// node_modules/mdast-util-to-markdown/lib/handle/list-item.js
function listItem(node2, parent, state, info) {
  const listItemIndent = checkListItemIndent(state);
  let bullet = state.bulletCurrent || checkBullet(state);
  if (parent && parent.type === "list" && parent.ordered) {
    bullet = (typeof parent.start === "number" && parent.start > -1 ? parent.start : 1) + (state.options.incrementListMarker === false ? 0 : parent.children.indexOf(node2)) + bullet;
  }
  let size = bullet.length + 1;
  if (listItemIndent === "tab" || listItemIndent === "mixed" && (parent && parent.type === "list" && parent.spread || node2.spread)) {
    size = Math.ceil(size / 4) * 4;
  }
  const tracker = state.createTracker(info);
  tracker.move(bullet + " ".repeat(size - bullet.length));
  tracker.shift(size);
  const exit3 = state.enter("listItem");
  const value = state.indentLines(
    state.containerFlow(node2, tracker.current()),
    map3
  );
  exit3();
  return value;
  function map3(line, index2, blank) {
    if (index2) {
      return (blank ? "" : " ".repeat(size)) + line;
    }
    return (blank ? bullet : bullet + " ".repeat(size - bullet.length)) + line;
  }
  __name(map3, "map");
}
__name(listItem, "listItem");

// node_modules/mdast-util-to-markdown/lib/handle/paragraph.js
init_esbuild_shims();
function paragraph(node2, _, state, info) {
  const exit3 = state.enter("paragraph");
  const subexit = state.enter("phrasing");
  const value = state.containerPhrasing(node2, info);
  subexit();
  exit3();
  return value;
}
__name(paragraph, "paragraph");

// node_modules/mdast-util-to-markdown/lib/handle/root.js
init_esbuild_shims();

// node_modules/mdast-util-phrasing/index.js
init_esbuild_shims();

// node_modules/mdast-util-phrasing/lib/index.js
init_esbuild_shims();
var phrasing = (
  /** @type {(node?: unknown) => node is Exclude<PhrasingContent, Html>} */
  convert([
    "break",
    "delete",
    "emphasis",
    // To do: next major: removed since footnotes were added to GFM.
    "footnote",
    "footnoteReference",
    "image",
    "imageReference",
    "inlineCode",
    // Enabled by `mdast-util-math`:
    "inlineMath",
    "link",
    "linkReference",
    // Enabled by `mdast-util-mdx`:
    "mdxJsxTextElement",
    // Enabled by `mdast-util-mdx`:
    "mdxTextExpression",
    "strong",
    "text",
    // Enabled by `mdast-util-directive`:
    "textDirective"
  ])
);

// node_modules/mdast-util-to-markdown/lib/handle/root.js
function root(node2, _, state, info) {
  const hasPhrasing = node2.children.some(function(d) {
    return phrasing(d);
  });
  const container = hasPhrasing ? state.containerPhrasing : state.containerFlow;
  return container.call(state, node2, info);
}
__name(root, "root");

// node_modules/mdast-util-to-markdown/lib/handle/strong.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/check-strong.js
init_esbuild_shims();
function checkStrong(state) {
  const marker = state.options.strong || "*";
  if (marker !== "*" && marker !== "_") {
    throw new Error(
      "Cannot serialize strong with `" + marker + "` for `options.strong`, expected `*`, or `_`"
    );
  }
  return marker;
}
__name(checkStrong, "checkStrong");

// node_modules/mdast-util-to-markdown/lib/handle/strong.js
strong.peek = strongPeek;
function strong(node2, _, state, info) {
  const marker = checkStrong(state);
  const exit3 = state.enter("strong");
  const tracker = state.createTracker(info);
  const before = tracker.move(marker + marker);
  let between = tracker.move(
    state.containerPhrasing(node2, {
      after: marker,
      before,
      ...tracker.current()
    })
  );
  const betweenHead = between.charCodeAt(0);
  const open = encodeInfo(
    info.before.charCodeAt(info.before.length - 1),
    betweenHead,
    marker
  );
  if (open.inside) {
    between = encodeCharacterReference(betweenHead) + between.slice(1);
  }
  const betweenTail = between.charCodeAt(between.length - 1);
  const close = encodeInfo(info.after.charCodeAt(0), betweenTail, marker);
  if (close.inside) {
    between = between.slice(0, -1) + encodeCharacterReference(betweenTail);
  }
  const after = tracker.move(marker + marker);
  exit3();
  state.attentionEncodeSurroundingInfo = {
    after: close.outside,
    before: open.outside
  };
  return before + between + after;
}
__name(strong, "strong");
function strongPeek(_, _1, state) {
  return state.options.strong || "*";
}
__name(strongPeek, "strongPeek");

// node_modules/mdast-util-to-markdown/lib/handle/text.js
init_esbuild_shims();
function text(node2, _, state, info) {
  return state.safe(node2.value, info);
}
__name(text, "text");

// node_modules/mdast-util-to-markdown/lib/handle/thematic-break.js
init_esbuild_shims();

// node_modules/mdast-util-to-markdown/lib/util/check-rule-repetition.js
init_esbuild_shims();
function checkRuleRepetition(state) {
  const repetition = state.options.ruleRepetition || 3;
  if (repetition < 3) {
    throw new Error(
      "Cannot serialize rules with repetition `" + repetition + "` for `options.ruleRepetition`, expected `3` or more"
    );
  }
  return repetition;
}
__name(checkRuleRepetition, "checkRuleRepetition");

// node_modules/mdast-util-to-markdown/lib/handle/thematic-break.js
function thematicBreak(_, _1, state) {
  const value = (checkRule(state) + (state.options.ruleSpaces ? " " : "")).repeat(checkRuleRepetition(state));
  return state.options.ruleSpaces ? value.slice(0, -1) : value;
}
__name(thematicBreak, "thematicBreak");

// node_modules/mdast-util-to-markdown/lib/handle/index.js
var handle = {
  blockquote,
  break: hardBreak,
  code,
  definition,
  emphasis,
  hardBreak,
  heading,
  html,
  image,
  imageReference,
  inlineCode,
  link,
  linkReference,
  list,
  listItem,
  paragraph,
  root,
  strong,
  text,
  thematicBreak
};

// node_modules/micromark-util-decode-string/index.js
init_esbuild_shims();

// node_modules/decode-named-character-reference/index.js
init_esbuild_shims();

// node_modules/character-entities/index.js
init_esbuild_shims();
var characterEntities = {
  AElig: "\xC6",
  AMP: "&",
  Aacute: "\xC1",
  Abreve: "\u0102",
  Acirc: "\xC2",
  Acy: "\u0410",
  Afr: "\u{1D504}",
  Agrave: "\xC0",
  Alpha: "\u0391",
  Amacr: "\u0100",
  And: "\u2A53",
  Aogon: "\u0104",
  Aopf: "\u{1D538}",
  ApplyFunction: "\u2061",
  Aring: "\xC5",
  Ascr: "\u{1D49C}",
  Assign: "\u2254",
  Atilde: "\xC3",
  Auml: "\xC4",
  Backslash: "\u2216",
  Barv: "\u2AE7",
  Barwed: "\u2306",
  Bcy: "\u0411",
  Because: "\u2235",
  Bernoullis: "\u212C",
  Beta: "\u0392",
  Bfr: "\u{1D505}",
  Bopf: "\u{1D539}",
  Breve: "\u02D8",
  Bscr: "\u212C",
  Bumpeq: "\u224E",
  CHcy: "\u0427",
  COPY: "\xA9",
  Cacute: "\u0106",
  Cap: "\u22D2",
  CapitalDifferentialD: "\u2145",
  Cayleys: "\u212D",
  Ccaron: "\u010C",
  Ccedil: "\xC7",
  Ccirc: "\u0108",
  Cconint: "\u2230",
  Cdot: "\u010A",
  Cedilla: "\xB8",
  CenterDot: "\xB7",
  Cfr: "\u212D",
  Chi: "\u03A7",
  CircleDot: "\u2299",
  CircleMinus: "\u2296",
  CirclePlus: "\u2295",
  CircleTimes: "\u2297",
  ClockwiseContourIntegral: "\u2232",
  CloseCurlyDoubleQuote: "\u201D",
  CloseCurlyQuote: "\u2019",
  Colon: "\u2237",
  Colone: "\u2A74",
  Congruent: "\u2261",
  Conint: "\u222F",
  ContourIntegral: "\u222E",
  Copf: "\u2102",
  Coproduct: "\u2210",
  CounterClockwiseContourIntegral: "\u2233",
  Cross: "\u2A2F",
  Cscr: "\u{1D49E}",
  Cup: "\u22D3",
  CupCap: "\u224D",
  DD: "\u2145",
  DDotrahd: "\u2911",
  DJcy: "\u0402",
  DScy: "\u0405",
  DZcy: "\u040F",
  Dagger: "\u2021",
  Darr: "\u21A1",
  Dashv: "\u2AE4",
  Dcaron: "\u010E",
  Dcy: "\u0414",
  Del: "\u2207",
  Delta: "\u0394",
  Dfr: "\u{1D507}",
  DiacriticalAcute: "\xB4",
  DiacriticalDot: "\u02D9",
  DiacriticalDoubleAcute: "\u02DD",
  DiacriticalGrave: "`",
  DiacriticalTilde: "\u02DC",
  Diamond: "\u22C4",
  DifferentialD: "\u2146",
  Dopf: "\u{1D53B}",
  Dot: "\xA8",
  DotDot: "\u20DC",
  DotEqual: "\u2250",
  DoubleContourIntegral: "\u222F",
  DoubleDot: "\xA8",
  DoubleDownArrow: "\u21D3",
  DoubleLeftArrow: "\u21D0",
  DoubleLeftRightArrow: "\u21D4",
  DoubleLeftTee: "\u2AE4",
  DoubleLongLeftArrow: "\u27F8",
  DoubleLongLeftRightArrow: "\u27FA",
  DoubleLongRightArrow: "\u27F9",
  DoubleRightArrow: "\u21D2",
  DoubleRightTee: "\u22A8",
  DoubleUpArrow: "\u21D1",
  DoubleUpDownArrow: "\u21D5",
  DoubleVerticalBar: "\u2225",
  DownArrow: "\u2193",
  DownArrowBar: "\u2913",
  DownArrowUpArrow: "\u21F5",
  DownBreve: "\u0311",
  DownLeftRightVector: "\u2950",
  DownLeftTeeVector: "\u295E",
  DownLeftVector: "\u21BD",
  DownLeftVectorBar: "\u2956",
  DownRightTeeVector: "\u295F",
  DownRightVector: "\u21C1",
  DownRightVectorBar: "\u2957",
  DownTee: "\u22A4",
  DownTeeArrow: "\u21A7",
  Downarrow: "\u21D3",
  Dscr: "\u{1D49F}",
  Dstrok: "\u0110",
  ENG: "\u014A",
  ETH: "\xD0",
  Eacute: "\xC9",
  Ecaron: "\u011A",
  Ecirc: "\xCA",
  Ecy: "\u042D",
  Edot: "\u0116",
  Efr: "\u{1D508}",
  Egrave: "\xC8",
  Element: "\u2208",
  Emacr: "\u0112",
  EmptySmallSquare: "\u25FB",
  EmptyVerySmallSquare: "\u25AB",
  Eogon: "\u0118",
  Eopf: "\u{1D53C}",
  Epsilon: "\u0395",
  Equal: "\u2A75",
  EqualTilde: "\u2242",
  Equilibrium: "\u21CC",
  Escr: "\u2130",
  Esim: "\u2A73",
  Eta: "\u0397",
  Euml: "\xCB",
  Exists: "\u2203",
  ExponentialE: "\u2147",
  Fcy: "\u0424",
  Ffr: "\u{1D509}",
  FilledSmallSquare: "\u25FC",
  FilledVerySmallSquare: "\u25AA",
  Fopf: "\u{1D53D}",
  ForAll: "\u2200",
  Fouriertrf: "\u2131",
  Fscr: "\u2131",
  GJcy: "\u0403",
  GT: ">",
  Gamma: "\u0393",
  Gammad: "\u03DC",
  Gbreve: "\u011E",
  Gcedil: "\u0122",
  Gcirc: "\u011C",
  Gcy: "\u0413",
  Gdot: "\u0120",
  Gfr: "\u{1D50A}",
  Gg: "\u22D9",
  Gopf: "\u{1D53E}",
  GreaterEqual: "\u2265",
  GreaterEqualLess: "\u22DB",
  GreaterFullEqual: "\u2267",
  GreaterGreater: "\u2AA2",
  GreaterLess: "\u2277",
  GreaterSlantEqual: "\u2A7E",
  GreaterTilde: "\u2273",
  Gscr: "\u{1D4A2}",
  Gt: "\u226B",
  HARDcy: "\u042A",
  Hacek: "\u02C7",
  Hat: "^",
  Hcirc: "\u0124",
  Hfr: "\u210C",
  HilbertSpace: "\u210B",
  Hopf: "\u210D",
  HorizontalLine: "\u2500",
  Hscr: "\u210B",
  Hstrok: "\u0126",
  HumpDownHump: "\u224E",
  HumpEqual: "\u224F",
  IEcy: "\u0415",
  IJlig: "\u0132",
  IOcy: "\u0401",
  Iacute: "\xCD",
  Icirc: "\xCE",
  Icy: "\u0418",
  Idot: "\u0130",
  Ifr: "\u2111",
  Igrave: "\xCC",
  Im: "\u2111",
  Imacr: "\u012A",
  ImaginaryI: "\u2148",
  Implies: "\u21D2",
  Int: "\u222C",
  Integral: "\u222B",
  Intersection: "\u22C2",
  InvisibleComma: "\u2063",
  InvisibleTimes: "\u2062",
  Iogon: "\u012E",
  Iopf: "\u{1D540}",
  Iota: "\u0399",
  Iscr: "\u2110",
  Itilde: "\u0128",
  Iukcy: "\u0406",
  Iuml: "\xCF",
  Jcirc: "\u0134",
  Jcy: "\u0419",
  Jfr: "\u{1D50D}",
  Jopf: "\u{1D541}",
  Jscr: "\u{1D4A5}",
  Jsercy: "\u0408",
  Jukcy: "\u0404",
  KHcy: "\u0425",
  KJcy: "\u040C",
  Kappa: "\u039A",
  Kcedil: "\u0136",
  Kcy: "\u041A",
  Kfr: "\u{1D50E}",
  Kopf: "\u{1D542}",
  Kscr: "\u{1D4A6}",
  LJcy: "\u0409",
  LT: "<",
  Lacute: "\u0139",
  Lambda: "\u039B",
  Lang: "\u27EA",
  Laplacetrf: "\u2112",
  Larr: "\u219E",
  Lcaron: "\u013D",
  Lcedil: "\u013B",
  Lcy: "\u041B",
  LeftAngleBracket: "\u27E8",
  LeftArrow: "\u2190",
  LeftArrowBar: "\u21E4",
  LeftArrowRightArrow: "\u21C6",
  LeftCeiling: "\u2308",
  LeftDoubleBracket: "\u27E6",
  LeftDownTeeVector: "\u2961",
  LeftDownVector: "\u21C3",
  LeftDownVectorBar: "\u2959",
  LeftFloor: "\u230A",
  LeftRightArrow: "\u2194",
  LeftRightVector: "\u294E",
  LeftTee: "\u22A3",
  LeftTeeArrow: "\u21A4",
  LeftTeeVector: "\u295A",
  LeftTriangle: "\u22B2",
  LeftTriangleBar: "\u29CF",
  LeftTriangleEqual: "\u22B4",
  LeftUpDownVector: "\u2951",
  LeftUpTeeVector: "\u2960",
  LeftUpVector: "\u21BF",
  LeftUpVectorBar: "\u2958",
  LeftVector: "\u21BC",
  LeftVectorBar: "\u2952",
  Leftarrow: "\u21D0",
  Leftrightarrow: "\u21D4",
  LessEqualGreater: "\u22DA",
  LessFullEqual: "\u2266",
  LessGreater: "\u2276",
  LessLess: "\u2AA1",
  LessSlantEqual: "\u2A7D",
  LessTilde: "\u2272",
  Lfr: "\u{1D50F}",
  Ll: "\u22D8",
  Lleftarrow: "\u21DA",
  Lmidot: "\u013F",
  LongLeftArrow: "\u27F5",
  LongLeftRightArrow: "\u27F7",
  LongRightArrow: "\u27F6",
  Longleftarrow: "\u27F8",
  Longleftrightarrow: "\u27FA",
  Longrightarrow: "\u27F9",
  Lopf: "\u{1D543}",
  LowerLeftArrow: "\u2199",
  LowerRightArrow: "\u2198",
  Lscr: "\u2112",
  Lsh: "\u21B0",
  Lstrok: "\u0141",
  Lt: "\u226A",
  Map: "\u2905",
  Mcy: "\u041C",
  MediumSpace: "\u205F",
  Mellintrf: "\u2133",
  Mfr: "\u{1D510}",
  MinusPlus: "\u2213",
  Mopf: "\u{1D544}",
  Mscr: "\u2133",
  Mu: "\u039C",
  NJcy: "\u040A",
  Nacute: "\u0143",
  Ncaron: "\u0147",
  Ncedil: "\u0145",
  Ncy: "\u041D",
  NegativeMediumSpace: "\u200B",
  NegativeThickSpace: "\u200B",
  NegativeThinSpace: "\u200B",
  NegativeVeryThinSpace: "\u200B",
  NestedGreaterGreater: "\u226B",
  NestedLessLess: "\u226A",
  NewLine: "\n",
  Nfr: "\u{1D511}",
  NoBreak: "\u2060",
  NonBreakingSpace: "\xA0",
  Nopf: "\u2115",
  Not: "\u2AEC",
  NotCongruent: "\u2262",
  NotCupCap: "\u226D",
  NotDoubleVerticalBar: "\u2226",
  NotElement: "\u2209",
  NotEqual: "\u2260",
  NotEqualTilde: "\u2242\u0338",
  NotExists: "\u2204",
  NotGreater: "\u226F",
  NotGreaterEqual: "\u2271",
  NotGreaterFullEqual: "\u2267\u0338",
  NotGreaterGreater: "\u226B\u0338",
  NotGreaterLess: "\u2279",
  NotGreaterSlantEqual: "\u2A7E\u0338",
  NotGreaterTilde: "\u2275",
  NotHumpDownHump: "\u224E\u0338",
  NotHumpEqual: "\u224F\u0338",
  NotLeftTriangle: "\u22EA",
  NotLeftTriangleBar: "\u29CF\u0338",
  NotLeftTriangleEqual: "\u22EC",
  NotLess: "\u226E",
  NotLessEqual: "\u2270",
  NotLessGreater: "\u2278",
  NotLessLess: "\u226A\u0338",
  NotLessSlantEqual: "\u2A7D\u0338",
  NotLessTilde: "\u2274",
  NotNestedGreaterGreater: "\u2AA2\u0338",
  NotNestedLessLess: "\u2AA1\u0338",
  NotPrecedes: "\u2280",
  NotPrecedesEqual: "\u2AAF\u0338",
  NotPrecedesSlantEqual: "\u22E0",
  NotReverseElement: "\u220C",
  NotRightTriangle: "\u22EB",
  NotRightTriangleBar: "\u29D0\u0338",
  NotRightTriangleEqual: "\u22ED",
  NotSquareSubset: "\u228F\u0338",
  NotSquareSubsetEqual: "\u22E2",
  NotSquareSuperset: "\u2290\u0338",
  NotSquareSupersetEqual: "\u22E3",
  NotSubset: "\u2282\u20D2",
  NotSubsetEqual: "\u2288",
  NotSucceeds: "\u2281",
  NotSucceedsEqual: "\u2AB0\u0338",
  NotSucceedsSlantEqual: "\u22E1",
  NotSucceedsTilde: "\u227F\u0338",
  NotSuperset: "\u2283\u20D2",
  NotSupersetEqual: "\u2289",
  NotTilde: "\u2241",
  NotTildeEqual: "\u2244",
  NotTildeFullEqual: "\u2247",
  NotTildeTilde: "\u2249",
  NotVerticalBar: "\u2224",
  Nscr: "\u{1D4A9}",
  Ntilde: "\xD1",
  Nu: "\u039D",
  OElig: "\u0152",
  Oacute: "\xD3",
  Ocirc: "\xD4",
  Ocy: "\u041E",
  Odblac: "\u0150",
  Ofr: "\u{1D512}",
  Ograve: "\xD2",
  Omacr: "\u014C",
  Omega: "\u03A9",
  Omicron: "\u039F",
  Oopf: "\u{1D546}",
  OpenCurlyDoubleQuote: "\u201C",
  OpenCurlyQuote: "\u2018",
  Or: "\u2A54",
  Oscr: "\u{1D4AA}",
  Oslash: "\xD8",
  Otilde: "\xD5",
  Otimes: "\u2A37",
  Ouml: "\xD6",
  OverBar: "\u203E",
  OverBrace: "\u23DE",
  OverBracket: "\u23B4",
  OverParenthesis: "\u23DC",
  PartialD: "\u2202",
  Pcy: "\u041F",
  Pfr: "\u{1D513}",
  Phi: "\u03A6",
  Pi: "\u03A0",
  PlusMinus: "\xB1",
  Poincareplane: "\u210C",
  Popf: "\u2119",
  Pr: "\u2ABB",
  Precedes: "\u227A",
  PrecedesEqual: "\u2AAF",
  PrecedesSlantEqual: "\u227C",
  PrecedesTilde: "\u227E",
  Prime: "\u2033",
  Product: "\u220F",
  Proportion: "\u2237",
  Proportional: "\u221D",
  Pscr: "\u{1D4AB}",
  Psi: "\u03A8",
  QUOT: '"',
  Qfr: "\u{1D514}",
  Qopf: "\u211A",
  Qscr: "\u{1D4AC}",
  RBarr: "\u2910",
  REG: "\xAE",
  Racute: "\u0154",
  Rang: "\u27EB",
  Rarr: "\u21A0",
  Rarrtl: "\u2916",
  Rcaron: "\u0158",
  Rcedil: "\u0156",
  Rcy: "\u0420",
  Re: "\u211C",
  ReverseElement: "\u220B",
  ReverseEquilibrium: "\u21CB",
  ReverseUpEquilibrium: "\u296F",
  Rfr: "\u211C",
  Rho: "\u03A1",
  RightAngleBracket: "\u27E9",
  RightArrow: "\u2192",
  RightArrowBar: "\u21E5",
  RightArrowLeftArrow: "\u21C4",
  RightCeiling: "\u2309",
  RightDoubleBracket: "\u27E7",
  RightDownTeeVector: "\u295D",
  RightDownVector: "\u21C2",
  RightDownVectorBar: "\u2955",
  RightFloor: "\u230B",
  RightTee: "\u22A2",
  RightTeeArrow: "\u21A6",
  RightTeeVector: "\u295B",
  RightTriangle: "\u22B3",
  RightTriangleBar: "\u29D0",
  RightTriangleEqual: "\u22B5",
  RightUpDownVector: "\u294F",
  RightUpTeeVector: "\u295C",
  RightUpVector: "\u21BE",
  RightUpVectorBar: "\u2954",
  RightVector: "\u21C0",
  RightVectorBar: "\u2953",
  Rightarrow: "\u21D2",
  Ropf: "\u211D",
  RoundImplies: "\u2970",
  Rrightarrow: "\u21DB",
  Rscr: "\u211B",
  Rsh: "\u21B1",
  RuleDelayed: "\u29F4",
  SHCHcy: "\u0429",
  SHcy: "\u0428",
  SOFTcy: "\u042C",
  Sacute: "\u015A",
  Sc: "\u2ABC",
  Scaron: "\u0160",
  Scedil: "\u015E",
  Scirc: "\u015C",
  Scy: "\u0421",
  Sfr: "\u{1D516}",
  ShortDownArrow: "\u2193",
  ShortLeftArrow: "\u2190",
  ShortRightArrow: "\u2192",
  ShortUpArrow: "\u2191",
  Sigma: "\u03A3",
  SmallCircle: "\u2218",
  Sopf: "\u{1D54A}",
  Sqrt: "\u221A",
  Square: "\u25A1",
  SquareIntersection: "\u2293",
  SquareSubset: "\u228F",
  SquareSubsetEqual: "\u2291",
  SquareSuperset: "\u2290",
  SquareSupersetEqual: "\u2292",
  SquareUnion: "\u2294",
  Sscr: "\u{1D4AE}",
  Star: "\u22C6",
  Sub: "\u22D0",
  Subset: "\u22D0",
  SubsetEqual: "\u2286",
  Succeeds: "\u227B",
  SucceedsEqual: "\u2AB0",
  SucceedsSlantEqual: "\u227D",
  SucceedsTilde: "\u227F",
  SuchThat: "\u220B",
  Sum: "\u2211",
  Sup: "\u22D1",
  Superset: "\u2283",
  SupersetEqual: "\u2287",
  Supset: "\u22D1",
  THORN: "\xDE",
  TRADE: "\u2122",
  TSHcy: "\u040B",
  TScy: "\u0426",
  Tab: "	",
  Tau: "\u03A4",
  Tcaron: "\u0164",
  Tcedil: "\u0162",
  Tcy: "\u0422",
  Tfr: "\u{1D517}",
  Therefore: "\u2234",
  Theta: "\u0398",
  ThickSpace: "\u205F\u200A",
  ThinSpace: "\u2009",
  Tilde: "\u223C",
  TildeEqual: "\u2243",
  TildeFullEqual: "\u2245",
  TildeTilde: "\u2248",
  Topf: "\u{1D54B}",
  TripleDot: "\u20DB",
  Tscr: "\u{1D4AF}",
  Tstrok: "\u0166",
  Uacute: "\xDA",
  Uarr: "\u219F",
  Uarrocir: "\u2949",
  Ubrcy: "\u040E",
  Ubreve: "\u016C",
  Ucirc: "\xDB",
  Ucy: "\u0423",
  Udblac: "\u0170",
  Ufr: "\u{1D518}",
  Ugrave: "\xD9",
  Umacr: "\u016A",
  UnderBar: "_",
  UnderBrace: "\u23DF",
  UnderBracket: "\u23B5",
  UnderParenthesis: "\u23DD",
  Union: "\u22C3",
  UnionPlus: "\u228E",
  Uogon: "\u0172",
  Uopf: "\u{1D54C}",
  UpArrow: "\u2191",
  UpArrowBar: "\u2912",
  UpArrowDownArrow: "\u21C5",
  UpDownArrow: "\u2195",
  UpEquilibrium: "\u296E",
  UpTee: "\u22A5",
  UpTeeArrow: "\u21A5",
  Uparrow: "\u21D1",
  Updownarrow: "\u21D5",
  UpperLeftArrow: "\u2196",
  UpperRightArrow: "\u2197",
  Upsi: "\u03D2",
  Upsilon: "\u03A5",
  Uring: "\u016E",
  Uscr: "\u{1D4B0}",
  Utilde: "\u0168",
  Uuml: "\xDC",
  VDash: "\u22AB",
  Vbar: "\u2AEB",
  Vcy: "\u0412",
  Vdash: "\u22A9",
  Vdashl: "\u2AE6",
  Vee: "\u22C1",
  Verbar: "\u2016",
  Vert: "\u2016",
  VerticalBar: "\u2223",
  VerticalLine: "|",
  VerticalSeparator: "\u2758",
  VerticalTilde: "\u2240",
  VeryThinSpace: "\u200A",
  Vfr: "\u{1D519}",
  Vopf: "\u{1D54D}",
  Vscr: "\u{1D4B1}",
  Vvdash: "\u22AA",
  Wcirc: "\u0174",
  Wedge: "\u22C0",
  Wfr: "\u{1D51A}",
  Wopf: "\u{1D54E}",
  Wscr: "\u{1D4B2}",
  Xfr: "\u{1D51B}",
  Xi: "\u039E",
  Xopf: "\u{1D54F}",
  Xscr: "\u{1D4B3}",
  YAcy: "\u042F",
  YIcy: "\u0407",
  YUcy: "\u042E",
  Yacute: "\xDD",
  Ycirc: "\u0176",
  Ycy: "\u042B",
  Yfr: "\u{1D51C}",
  Yopf: "\u{1D550}",
  Yscr: "\u{1D4B4}",
  Yuml: "\u0178",
  ZHcy: "\u0416",
  Zacute: "\u0179",
  Zcaron: "\u017D",
  Zcy: "\u0417",
  Zdot: "\u017B",
  ZeroWidthSpace: "\u200B",
  Zeta: "\u0396",
  Zfr: "\u2128",
  Zopf: "\u2124",
  Zscr: "\u{1D4B5}",
  aacute: "\xE1",
  abreve: "\u0103",
  ac: "\u223E",
  acE: "\u223E\u0333",
  acd: "\u223F",
  acirc: "\xE2",
  acute: "\xB4",
  acy: "\u0430",
  aelig: "\xE6",
  af: "\u2061",
  afr: "\u{1D51E}",
  agrave: "\xE0",
  alefsym: "\u2135",
  aleph: "\u2135",
  alpha: "\u03B1",
  amacr: "\u0101",
  amalg: "\u2A3F",
  amp: "&",
  and: "\u2227",
  andand: "\u2A55",
  andd: "\u2A5C",
  andslope: "\u2A58",
  andv: "\u2A5A",
  ang: "\u2220",
  ange: "\u29A4",
  angle: "\u2220",
  angmsd: "\u2221",
  angmsdaa: "\u29A8",
  angmsdab: "\u29A9",
  angmsdac: "\u29AA",
  angmsdad: "\u29AB",
  angmsdae: "\u29AC",
  angmsdaf: "\u29AD",
  angmsdag: "\u29AE",
  angmsdah: "\u29AF",
  angrt: "\u221F",
  angrtvb: "\u22BE",
  angrtvbd: "\u299D",
  angsph: "\u2222",
  angst: "\xC5",
  angzarr: "\u237C",
  aogon: "\u0105",
  aopf: "\u{1D552}",
  ap: "\u2248",
  apE: "\u2A70",
  apacir: "\u2A6F",
  ape: "\u224A",
  apid: "\u224B",
  apos: "'",
  approx: "\u2248",
  approxeq: "\u224A",
  aring: "\xE5",
  ascr: "\u{1D4B6}",
  ast: "*",
  asymp: "\u2248",
  asympeq: "\u224D",
  atilde: "\xE3",
  auml: "\xE4",
  awconint: "\u2233",
  awint: "\u2A11",
  bNot: "\u2AED",
  backcong: "\u224C",
  backepsilon: "\u03F6",
  backprime: "\u2035",
  backsim: "\u223D",
  backsimeq: "\u22CD",
  barvee: "\u22BD",
  barwed: "\u2305",
  barwedge: "\u2305",
  bbrk: "\u23B5",
  bbrktbrk: "\u23B6",
  bcong: "\u224C",
  bcy: "\u0431",
  bdquo: "\u201E",
  becaus: "\u2235",
  because: "\u2235",
  bemptyv: "\u29B0",
  bepsi: "\u03F6",
  bernou: "\u212C",
  beta: "\u03B2",
  beth: "\u2136",
  between: "\u226C",
  bfr: "\u{1D51F}",
  bigcap: "\u22C2",
  bigcirc: "\u25EF",
  bigcup: "\u22C3",
  bigodot: "\u2A00",
  bigoplus: "\u2A01",
  bigotimes: "\u2A02",
  bigsqcup: "\u2A06",
  bigstar: "\u2605",
  bigtriangledown: "\u25BD",
  bigtriangleup: "\u25B3",
  biguplus: "\u2A04",
  bigvee: "\u22C1",
  bigwedge: "\u22C0",
  bkarow: "\u290D",
  blacklozenge: "\u29EB",
  blacksquare: "\u25AA",
  blacktriangle: "\u25B4",
  blacktriangledown: "\u25BE",
  blacktriangleleft: "\u25C2",
  blacktriangleright: "\u25B8",
  blank: "\u2423",
  blk12: "\u2592",
  blk14: "\u2591",
  blk34: "\u2593",
  block: "\u2588",
  bne: "=\u20E5",
  bnequiv: "\u2261\u20E5",
  bnot: "\u2310",
  bopf: "\u{1D553}",
  bot: "\u22A5",
  bottom: "\u22A5",
  bowtie: "\u22C8",
  boxDL: "\u2557",
  boxDR: "\u2554",
  boxDl: "\u2556",
  boxDr: "\u2553",
  boxH: "\u2550",
  boxHD: "\u2566",
  boxHU: "\u2569",
  boxHd: "\u2564",
  boxHu: "\u2567",
  boxUL: "\u255D",
  boxUR: "\u255A",
  boxUl: "\u255C",
  boxUr: "\u2559",
  boxV: "\u2551",
  boxVH: "\u256C",
  boxVL: "\u2563",
  boxVR: "\u2560",
  boxVh: "\u256B",
  boxVl: "\u2562",
  boxVr: "\u255F",
  boxbox: "\u29C9",
  boxdL: "\u2555",
  boxdR: "\u2552",
  boxdl: "\u2510",
  boxdr: "\u250C",
  boxh: "\u2500",
  boxhD: "\u2565",
  boxhU: "\u2568",
  boxhd: "\u252C",
  boxhu: "\u2534",
  boxminus: "\u229F",
  boxplus: "\u229E",
  boxtimes: "\u22A0",
  boxuL: "\u255B",
  boxuR: "\u2558",
  boxul: "\u2518",
  boxur: "\u2514",
  boxv: "\u2502",
  boxvH: "\u256A",
  boxvL: "\u2561",
  boxvR: "\u255E",
  boxvh: "\u253C",
  boxvl: "\u2524",
  boxvr: "\u251C",
  bprime: "\u2035",
  breve: "\u02D8",
  brvbar: "\xA6",
  bscr: "\u{1D4B7}",
  bsemi: "\u204F",
  bsim: "\u223D",
  bsime: "\u22CD",
  bsol: "\\",
  bsolb: "\u29C5",
  bsolhsub: "\u27C8",
  bull: "\u2022",
  bullet: "\u2022",
  bump: "\u224E",
  bumpE: "\u2AAE",
  bumpe: "\u224F",
  bumpeq: "\u224F",
  cacute: "\u0107",
  cap: "\u2229",
  capand: "\u2A44",
  capbrcup: "\u2A49",
  capcap: "\u2A4B",
  capcup: "\u2A47",
  capdot: "\u2A40",
  caps: "\u2229\uFE00",
  caret: "\u2041",
  caron: "\u02C7",
  ccaps: "\u2A4D",
  ccaron: "\u010D",
  ccedil: "\xE7",
  ccirc: "\u0109",
  ccups: "\u2A4C",
  ccupssm: "\u2A50",
  cdot: "\u010B",
  cedil: "\xB8",
  cemptyv: "\u29B2",
  cent: "\xA2",
  centerdot: "\xB7",
  cfr: "\u{1D520}",
  chcy: "\u0447",
  check: "\u2713",
  checkmark: "\u2713",
  chi: "\u03C7",
  cir: "\u25CB",
  cirE: "\u29C3",
  circ: "\u02C6",
  circeq: "\u2257",
  circlearrowleft: "\u21BA",
  circlearrowright: "\u21BB",
  circledR: "\xAE",
  circledS: "\u24C8",
  circledast: "\u229B",
  circledcirc: "\u229A",
  circleddash: "\u229D",
  cire: "\u2257",
  cirfnint: "\u2A10",
  cirmid: "\u2AEF",
  cirscir: "\u29C2",
  clubs: "\u2663",
  clubsuit: "\u2663",
  colon: ":",
  colone: "\u2254",
  coloneq: "\u2254",
  comma: ",",
  commat: "@",
  comp: "\u2201",
  compfn: "\u2218",
  complement: "\u2201",
  complexes: "\u2102",
  cong: "\u2245",
  congdot: "\u2A6D",
  conint: "\u222E",
  copf: "\u{1D554}",
  coprod: "\u2210",
  copy: "\xA9",
  copysr: "\u2117",
  crarr: "\u21B5",
  cross: "\u2717",
  cscr: "\u{1D4B8}",
  csub: "\u2ACF",
  csube: "\u2AD1",
  csup: "\u2AD0",
  csupe: "\u2AD2",
  ctdot: "\u22EF",
  cudarrl: "\u2938",
  cudarrr: "\u2935",
  cuepr: "\u22DE",
  cuesc: "\u22DF",
  cularr: "\u21B6",
  cularrp: "\u293D",
  cup: "\u222A",
  cupbrcap: "\u2A48",
  cupcap: "\u2A46",
  cupcup: "\u2A4A",
  cupdot: "\u228D",
  cupor: "\u2A45",
  cups: "\u222A\uFE00",
  curarr: "\u21B7",
  curarrm: "\u293C",
  curlyeqprec: "\u22DE",
  curlyeqsucc: "\u22DF",
  curlyvee: "\u22CE",
  curlywedge: "\u22CF",
  curren: "\xA4",
  curvearrowleft: "\u21B6",
  curvearrowright: "\u21B7",
  cuvee: "\u22CE",
  cuwed: "\u22CF",
  cwconint: "\u2232",
  cwint: "\u2231",
  cylcty: "\u232D",
  dArr: "\u21D3",
  dHar: "\u2965",
  dagger: "\u2020",
  daleth: "\u2138",
  darr: "\u2193",
  dash: "\u2010",
  dashv: "\u22A3",
  dbkarow: "\u290F",
  dblac: "\u02DD",
  dcaron: "\u010F",
  dcy: "\u0434",
  dd: "\u2146",
  ddagger: "\u2021",
  ddarr: "\u21CA",
  ddotseq: "\u2A77",
  deg: "\xB0",
  delta: "\u03B4",
  demptyv: "\u29B1",
  dfisht: "\u297F",
  dfr: "\u{1D521}",
  dharl: "\u21C3",
  dharr: "\u21C2",
  diam: "\u22C4",
  diamond: "\u22C4",
  diamondsuit: "\u2666",
  diams: "\u2666",
  die: "\xA8",
  digamma: "\u03DD",
  disin: "\u22F2",
  div: "\xF7",
  divide: "\xF7",
  divideontimes: "\u22C7",
  divonx: "\u22C7",
  djcy: "\u0452",
  dlcorn: "\u231E",
  dlcrop: "\u230D",
  dollar: "$",
  dopf: "\u{1D555}",
  dot: "\u02D9",
  doteq: "\u2250",
  doteqdot: "\u2251",
  dotminus: "\u2238",
  dotplus: "\u2214",
  dotsquare: "\u22A1",
  doublebarwedge: "\u2306",
  downarrow: "\u2193",
  downdownarrows: "\u21CA",
  downharpoonleft: "\u21C3",
  downharpoonright: "\u21C2",
  drbkarow: "\u2910",
  drcorn: "\u231F",
  drcrop: "\u230C",
  dscr: "\u{1D4B9}",
  dscy: "\u0455",
  dsol: "\u29F6",
  dstrok: "\u0111",
  dtdot: "\u22F1",
  dtri: "\u25BF",
  dtrif: "\u25BE",
  duarr: "\u21F5",
  duhar: "\u296F",
  dwangle: "\u29A6",
  dzcy: "\u045F",
  dzigrarr: "\u27FF",
  eDDot: "\u2A77",
  eDot: "\u2251",
  eacute: "\xE9",
  easter: "\u2A6E",
  ecaron: "\u011B",
  ecir: "\u2256",
  ecirc: "\xEA",
  ecolon: "\u2255",
  ecy: "\u044D",
  edot: "\u0117",
  ee: "\u2147",
  efDot: "\u2252",
  efr: "\u{1D522}",
  eg: "\u2A9A",
  egrave: "\xE8",
  egs: "\u2A96",
  egsdot: "\u2A98",
  el: "\u2A99",
  elinters: "\u23E7",
  ell: "\u2113",
  els: "\u2A95",
  elsdot: "\u2A97",
  emacr: "\u0113",
  empty: "\u2205",
  emptyset: "\u2205",
  emptyv: "\u2205",
  emsp13: "\u2004",
  emsp14: "\u2005",
  emsp: "\u2003",
  eng: "\u014B",
  ensp: "\u2002",
  eogon: "\u0119",
  eopf: "\u{1D556}",
  epar: "\u22D5",
  eparsl: "\u29E3",
  eplus: "\u2A71",
  epsi: "\u03B5",
  epsilon: "\u03B5",
  epsiv: "\u03F5",
  eqcirc: "\u2256",
  eqcolon: "\u2255",
  eqsim: "\u2242",
  eqslantgtr: "\u2A96",
  eqslantless: "\u2A95",
  equals: "=",
  equest: "\u225F",
  equiv: "\u2261",
  equivDD: "\u2A78",
  eqvparsl: "\u29E5",
  erDot: "\u2253",
  erarr: "\u2971",
  escr: "\u212F",
  esdot: "\u2250",
  esim: "\u2242",
  eta: "\u03B7",
  eth: "\xF0",
  euml: "\xEB",
  euro: "\u20AC",
  excl: "!",
  exist: "\u2203",
  expectation: "\u2130",
  exponentiale: "\u2147",
  fallingdotseq: "\u2252",
  fcy: "\u0444",
  female: "\u2640",
  ffilig: "\uFB03",
  fflig: "\uFB00",
  ffllig: "\uFB04",
  ffr: "\u{1D523}",
  filig: "\uFB01",
  fjlig: "fj",
  flat: "\u266D",
  fllig: "\uFB02",
  fltns: "\u25B1",
  fnof: "\u0192",
  fopf: "\u{1D557}",
  forall: "\u2200",
  fork: "\u22D4",
  forkv: "\u2AD9",
  fpartint: "\u2A0D",
  frac12: "\xBD",
  frac13: "\u2153",
  frac14: "\xBC",
  frac15: "\u2155",
  frac16: "\u2159",
  frac18: "\u215B",
  frac23: "\u2154",
  frac25: "\u2156",
  frac34: "\xBE",
  frac35: "\u2157",
  frac38: "\u215C",
  frac45: "\u2158",
  frac56: "\u215A",
  frac58: "\u215D",
  frac78: "\u215E",
  frasl: "\u2044",
  frown: "\u2322",
  fscr: "\u{1D4BB}",
  gE: "\u2267",
  gEl: "\u2A8C",
  gacute: "\u01F5",
  gamma: "\u03B3",
  gammad: "\u03DD",
  gap: "\u2A86",
  gbreve: "\u011F",
  gcirc: "\u011D",
  gcy: "\u0433",
  gdot: "\u0121",
  ge: "\u2265",
  gel: "\u22DB",
  geq: "\u2265",
  geqq: "\u2267",
  geqslant: "\u2A7E",
  ges: "\u2A7E",
  gescc: "\u2AA9",
  gesdot: "\u2A80",
  gesdoto: "\u2A82",
  gesdotol: "\u2A84",
  gesl: "\u22DB\uFE00",
  gesles: "\u2A94",
  gfr: "\u{1D524}",
  gg: "\u226B",
  ggg: "\u22D9",
  gimel: "\u2137",
  gjcy: "\u0453",
  gl: "\u2277",
  glE: "\u2A92",
  gla: "\u2AA5",
  glj: "\u2AA4",
  gnE: "\u2269",
  gnap: "\u2A8A",
  gnapprox: "\u2A8A",
  gne: "\u2A88",
  gneq: "\u2A88",
  gneqq: "\u2269",
  gnsim: "\u22E7",
  gopf: "\u{1D558}",
  grave: "`",
  gscr: "\u210A",
  gsim: "\u2273",
  gsime: "\u2A8E",
  gsiml: "\u2A90",
  gt: ">",
  gtcc: "\u2AA7",
  gtcir: "\u2A7A",
  gtdot: "\u22D7",
  gtlPar: "\u2995",
  gtquest: "\u2A7C",
  gtrapprox: "\u2A86",
  gtrarr: "\u2978",
  gtrdot: "\u22D7",
  gtreqless: "\u22DB",
  gtreqqless: "\u2A8C",
  gtrless: "\u2277",
  gtrsim: "\u2273",
  gvertneqq: "\u2269\uFE00",
  gvnE: "\u2269\uFE00",
  hArr: "\u21D4",
  hairsp: "\u200A",
  half: "\xBD",
  hamilt: "\u210B",
  hardcy: "\u044A",
  harr: "\u2194",
  harrcir: "\u2948",
  harrw: "\u21AD",
  hbar: "\u210F",
  hcirc: "\u0125",
  hearts: "\u2665",
  heartsuit: "\u2665",
  hellip: "\u2026",
  hercon: "\u22B9",
  hfr: "\u{1D525}",
  hksearow: "\u2925",
  hkswarow: "\u2926",
  hoarr: "\u21FF",
  homtht: "\u223B",
  hookleftarrow: "\u21A9",
  hookrightarrow: "\u21AA",
  hopf: "\u{1D559}",
  horbar: "\u2015",
  hscr: "\u{1D4BD}",
  hslash: "\u210F",
  hstrok: "\u0127",
  hybull: "\u2043",
  hyphen: "\u2010",
  iacute: "\xED",
  ic: "\u2063",
  icirc: "\xEE",
  icy: "\u0438",
  iecy: "\u0435",
  iexcl: "\xA1",
  iff: "\u21D4",
  ifr: "\u{1D526}",
  igrave: "\xEC",
  ii: "\u2148",
  iiiint: "\u2A0C",
  iiint: "\u222D",
  iinfin: "\u29DC",
  iiota: "\u2129",
  ijlig: "\u0133",
  imacr: "\u012B",
  image: "\u2111",
  imagline: "\u2110",
  imagpart: "\u2111",
  imath: "\u0131",
  imof: "\u22B7",
  imped: "\u01B5",
  in: "\u2208",
  incare: "\u2105",
  infin: "\u221E",
  infintie: "\u29DD",
  inodot: "\u0131",
  int: "\u222B",
  intcal: "\u22BA",
  integers: "\u2124",
  intercal: "\u22BA",
  intlarhk: "\u2A17",
  intprod: "\u2A3C",
  iocy: "\u0451",
  iogon: "\u012F",
  iopf: "\u{1D55A}",
  iota: "\u03B9",
  iprod: "\u2A3C",
  iquest: "\xBF",
  iscr: "\u{1D4BE}",
  isin: "\u2208",
  isinE: "\u22F9",
  isindot: "\u22F5",
  isins: "\u22F4",
  isinsv: "\u22F3",
  isinv: "\u2208",
  it: "\u2062",
  itilde: "\u0129",
  iukcy: "\u0456",
  iuml: "\xEF",
  jcirc: "\u0135",
  jcy: "\u0439",
  jfr: "\u{1D527}",
  jmath: "\u0237",
  jopf: "\u{1D55B}",
  jscr: "\u{1D4BF}",
  jsercy: "\u0458",
  jukcy: "\u0454",
  kappa: "\u03BA",
  kappav: "\u03F0",
  kcedil: "\u0137",
  kcy: "\u043A",
  kfr: "\u{1D528}",
  kgreen: "\u0138",
  khcy: "\u0445",
  kjcy: "\u045C",
  kopf: "\u{1D55C}",
  kscr: "\u{1D4C0}",
  lAarr: "\u21DA",
  lArr: "\u21D0",
  lAtail: "\u291B",
  lBarr: "\u290E",
  lE: "\u2266",
  lEg: "\u2A8B",
  lHar: "\u2962",
  lacute: "\u013A",
  laemptyv: "\u29B4",
  lagran: "\u2112",
  lambda: "\u03BB",
  lang: "\u27E8",
  langd: "\u2991",
  langle: "\u27E8",
  lap: "\u2A85",
  laquo: "\xAB",
  larr: "\u2190",
  larrb: "\u21E4",
  larrbfs: "\u291F",
  larrfs: "\u291D",
  larrhk: "\u21A9",
  larrlp: "\u21AB",
  larrpl: "\u2939",
  larrsim: "\u2973",
  larrtl: "\u21A2",
  lat: "\u2AAB",
  latail: "\u2919",
  late: "\u2AAD",
  lates: "\u2AAD\uFE00",
  lbarr: "\u290C",
  lbbrk: "\u2772",
  lbrace: "{",
  lbrack: "[",
  lbrke: "\u298B",
  lbrksld: "\u298F",
  lbrkslu: "\u298D",
  lcaron: "\u013E",
  lcedil: "\u013C",
  lceil: "\u2308",
  lcub: "{",
  lcy: "\u043B",
  ldca: "\u2936",
  ldquo: "\u201C",
  ldquor: "\u201E",
  ldrdhar: "\u2967",
  ldrushar: "\u294B",
  ldsh: "\u21B2",
  le: "\u2264",
  leftarrow: "\u2190",
  leftarrowtail: "\u21A2",
  leftharpoondown: "\u21BD",
  leftharpoonup: "\u21BC",
  leftleftarrows: "\u21C7",
  leftrightarrow: "\u2194",
  leftrightarrows: "\u21C6",
  leftrightharpoons: "\u21CB",
  leftrightsquigarrow: "\u21AD",
  leftthreetimes: "\u22CB",
  leg: "\u22DA",
  leq: "\u2264",
  leqq: "\u2266",
  leqslant: "\u2A7D",
  les: "\u2A7D",
  lescc: "\u2AA8",
  lesdot: "\u2A7F",
  lesdoto: "\u2A81",
  lesdotor: "\u2A83",
  lesg: "\u22DA\uFE00",
  lesges: "\u2A93",
  lessapprox: "\u2A85",
  lessdot: "\u22D6",
  lesseqgtr: "\u22DA",
  lesseqqgtr: "\u2A8B",
  lessgtr: "\u2276",
  lesssim: "\u2272",
  lfisht: "\u297C",
  lfloor: "\u230A",
  lfr: "\u{1D529}",
  lg: "\u2276",
  lgE: "\u2A91",
  lhard: "\u21BD",
  lharu: "\u21BC",
  lharul: "\u296A",
  lhblk: "\u2584",
  ljcy: "\u0459",
  ll: "\u226A",
  llarr: "\u21C7",
  llcorner: "\u231E",
  llhard: "\u296B",
  lltri: "\u25FA",
  lmidot: "\u0140",
  lmoust: "\u23B0",
  lmoustache: "\u23B0",
  lnE: "\u2268",
  lnap: "\u2A89",
  lnapprox: "\u2A89",
  lne: "\u2A87",
  lneq: "\u2A87",
  lneqq: "\u2268",
  lnsim: "\u22E6",
  loang: "\u27EC",
  loarr: "\u21FD",
  lobrk: "\u27E6",
  longleftarrow: "\u27F5",
  longleftrightarrow: "\u27F7",
  longmapsto: "\u27FC",
  longrightarrow: "\u27F6",
  looparrowleft: "\u21AB",
  looparrowright: "\u21AC",
  lopar: "\u2985",
  lopf: "\u{1D55D}",
  loplus: "\u2A2D",
  lotimes: "\u2A34",
  lowast: "\u2217",
  lowbar: "_",
  loz: "\u25CA",
  lozenge: "\u25CA",
  lozf: "\u29EB",
  lpar: "(",
  lparlt: "\u2993",
  lrarr: "\u21C6",
  lrcorner: "\u231F",
  lrhar: "\u21CB",
  lrhard: "\u296D",
  lrm: "\u200E",
  lrtri: "\u22BF",
  lsaquo: "\u2039",
  lscr: "\u{1D4C1}",
  lsh: "\u21B0",
  lsim: "\u2272",
  lsime: "\u2A8D",
  lsimg: "\u2A8F",
  lsqb: "[",
  lsquo: "\u2018",
  lsquor: "\u201A",
  lstrok: "\u0142",
  lt: "<",
  ltcc: "\u2AA6",
  ltcir: "\u2A79",
  ltdot: "\u22D6",
  lthree: "\u22CB",
  ltimes: "\u22C9",
  ltlarr: "\u2976",
  ltquest: "\u2A7B",
  ltrPar: "\u2996",
  ltri: "\u25C3",
  ltrie: "\u22B4",
  ltrif: "\u25C2",
  lurdshar: "\u294A",
  luruhar: "\u2966",
  lvertneqq: "\u2268\uFE00",
  lvnE: "\u2268\uFE00",
  mDDot: "\u223A",
  macr: "\xAF",
  male: "\u2642",
  malt: "\u2720",
  maltese: "\u2720",
  map: "\u21A6",
  mapsto: "\u21A6",
  mapstodown: "\u21A7",
  mapstoleft: "\u21A4",
  mapstoup: "\u21A5",
  marker: "\u25AE",
  mcomma: "\u2A29",
  mcy: "\u043C",
  mdash: "\u2014",
  measuredangle: "\u2221",
  mfr: "\u{1D52A}",
  mho: "\u2127",
  micro: "\xB5",
  mid: "\u2223",
  midast: "*",
  midcir: "\u2AF0",
  middot: "\xB7",
  minus: "\u2212",
  minusb: "\u229F",
  minusd: "\u2238",
  minusdu: "\u2A2A",
  mlcp: "\u2ADB",
  mldr: "\u2026",
  mnplus: "\u2213",
  models: "\u22A7",
  mopf: "\u{1D55E}",
  mp: "\u2213",
  mscr: "\u{1D4C2}",
  mstpos: "\u223E",
  mu: "\u03BC",
  multimap: "\u22B8",
  mumap: "\u22B8",
  nGg: "\u22D9\u0338",
  nGt: "\u226B\u20D2",
  nGtv: "\u226B\u0338",
  nLeftarrow: "\u21CD",
  nLeftrightarrow: "\u21CE",
  nLl: "\u22D8\u0338",
  nLt: "\u226A\u20D2",
  nLtv: "\u226A\u0338",
  nRightarrow: "\u21CF",
  nVDash: "\u22AF",
  nVdash: "\u22AE",
  nabla: "\u2207",
  nacute: "\u0144",
  nang: "\u2220\u20D2",
  nap: "\u2249",
  napE: "\u2A70\u0338",
  napid: "\u224B\u0338",
  napos: "\u0149",
  napprox: "\u2249",
  natur: "\u266E",
  natural: "\u266E",
  naturals: "\u2115",
  nbsp: "\xA0",
  nbump: "\u224E\u0338",
  nbumpe: "\u224F\u0338",
  ncap: "\u2A43",
  ncaron: "\u0148",
  ncedil: "\u0146",
  ncong: "\u2247",
  ncongdot: "\u2A6D\u0338",
  ncup: "\u2A42",
  ncy: "\u043D",
  ndash: "\u2013",
  ne: "\u2260",
  neArr: "\u21D7",
  nearhk: "\u2924",
  nearr: "\u2197",
  nearrow: "\u2197",
  nedot: "\u2250\u0338",
  nequiv: "\u2262",
  nesear: "\u2928",
  nesim: "\u2242\u0338",
  nexist: "\u2204",
  nexists: "\u2204",
  nfr: "\u{1D52B}",
  ngE: "\u2267\u0338",
  nge: "\u2271",
  ngeq: "\u2271",
  ngeqq: "\u2267\u0338",
  ngeqslant: "\u2A7E\u0338",
  nges: "\u2A7E\u0338",
  ngsim: "\u2275",
  ngt: "\u226F",
  ngtr: "\u226F",
  nhArr: "\u21CE",
  nharr: "\u21AE",
  nhpar: "\u2AF2",
  ni: "\u220B",
  nis: "\u22FC",
  nisd: "\u22FA",
  niv: "\u220B",
  njcy: "\u045A",
  nlArr: "\u21CD",
  nlE: "\u2266\u0338",
  nlarr: "\u219A",
  nldr: "\u2025",
  nle: "\u2270",
  nleftarrow: "\u219A",
  nleftrightarrow: "\u21AE",
  nleq: "\u2270",
  nleqq: "\u2266\u0338",
  nleqslant: "\u2A7D\u0338",
  nles: "\u2A7D\u0338",
  nless: "\u226E",
  nlsim: "\u2274",
  nlt: "\u226E",
  nltri: "\u22EA",
  nltrie: "\u22EC",
  nmid: "\u2224",
  nopf: "\u{1D55F}",
  not: "\xAC",
  notin: "\u2209",
  notinE: "\u22F9\u0338",
  notindot: "\u22F5\u0338",
  notinva: "\u2209",
  notinvb: "\u22F7",
  notinvc: "\u22F6",
  notni: "\u220C",
  notniva: "\u220C",
  notnivb: "\u22FE",
  notnivc: "\u22FD",
  npar: "\u2226",
  nparallel: "\u2226",
  nparsl: "\u2AFD\u20E5",
  npart: "\u2202\u0338",
  npolint: "\u2A14",
  npr: "\u2280",
  nprcue: "\u22E0",
  npre: "\u2AAF\u0338",
  nprec: "\u2280",
  npreceq: "\u2AAF\u0338",
  nrArr: "\u21CF",
  nrarr: "\u219B",
  nrarrc: "\u2933\u0338",
  nrarrw: "\u219D\u0338",
  nrightarrow: "\u219B",
  nrtri: "\u22EB",
  nrtrie: "\u22ED",
  nsc: "\u2281",
  nsccue: "\u22E1",
  nsce: "\u2AB0\u0338",
  nscr: "\u{1D4C3}",
  nshortmid: "\u2224",
  nshortparallel: "\u2226",
  nsim: "\u2241",
  nsime: "\u2244",
  nsimeq: "\u2244",
  nsmid: "\u2224",
  nspar: "\u2226",
  nsqsube: "\u22E2",
  nsqsupe: "\u22E3",
  nsub: "\u2284",
  nsubE: "\u2AC5\u0338",
  nsube: "\u2288",
  nsubset: "\u2282\u20D2",
  nsubseteq: "\u2288",
  nsubseteqq: "\u2AC5\u0338",
  nsucc: "\u2281",
  nsucceq: "\u2AB0\u0338",
  nsup: "\u2285",
  nsupE: "\u2AC6\u0338",
  nsupe: "\u2289",
  nsupset: "\u2283\u20D2",
  nsupseteq: "\u2289",
  nsupseteqq: "\u2AC6\u0338",
  ntgl: "\u2279",
  ntilde: "\xF1",
  ntlg: "\u2278",
  ntriangleleft: "\u22EA",
  ntrianglelefteq: "\u22EC",
  ntriangleright: "\u22EB",
  ntrianglerighteq: "\u22ED",
  nu: "\u03BD",
  num: "#",
  numero: "\u2116",
  numsp: "\u2007",
  nvDash: "\u22AD",
  nvHarr: "\u2904",
  nvap: "\u224D\u20D2",
  nvdash: "\u22AC",
  nvge: "\u2265\u20D2",
  nvgt: ">\u20D2",
  nvinfin: "\u29DE",
  nvlArr: "\u2902",
  nvle: "\u2264\u20D2",
  nvlt: "<\u20D2",
  nvltrie: "\u22B4\u20D2",
  nvrArr: "\u2903",
  nvrtrie: "\u22B5\u20D2",
  nvsim: "\u223C\u20D2",
  nwArr: "\u21D6",
  nwarhk: "\u2923",
  nwarr: "\u2196",
  nwarrow: "\u2196",
  nwnear: "\u2927",
  oS: "\u24C8",
  oacute: "\xF3",
  oast: "\u229B",
  ocir: "\u229A",
  ocirc: "\xF4",
  ocy: "\u043E",
  odash: "\u229D",
  odblac: "\u0151",
  odiv: "\u2A38",
  odot: "\u2299",
  odsold: "\u29BC",
  oelig: "\u0153",
  ofcir: "\u29BF",
  ofr: "\u{1D52C}",
  ogon: "\u02DB",
  ograve: "\xF2",
  ogt: "\u29C1",
  ohbar: "\u29B5",
  ohm: "\u03A9",
  oint: "\u222E",
  olarr: "\u21BA",
  olcir: "\u29BE",
  olcross: "\u29BB",
  oline: "\u203E",
  olt: "\u29C0",
  omacr: "\u014D",
  omega: "\u03C9",
  omicron: "\u03BF",
  omid: "\u29B6",
  ominus: "\u2296",
  oopf: "\u{1D560}",
  opar: "\u29B7",
  operp: "\u29B9",
  oplus: "\u2295",
  or: "\u2228",
  orarr: "\u21BB",
  ord: "\u2A5D",
  order: "\u2134",
  orderof: "\u2134",
  ordf: "\xAA",
  ordm: "\xBA",
  origof: "\u22B6",
  oror: "\u2A56",
  orslope: "\u2A57",
  orv: "\u2A5B",
  oscr: "\u2134",
  oslash: "\xF8",
  osol: "\u2298",
  otilde: "\xF5",
  otimes: "\u2297",
  otimesas: "\u2A36",
  ouml: "\xF6",
  ovbar: "\u233D",
  par: "\u2225",
  para: "\xB6",
  parallel: "\u2225",
  parsim: "\u2AF3",
  parsl: "\u2AFD",
  part: "\u2202",
  pcy: "\u043F",
  percnt: "%",
  period: ".",
  permil: "\u2030",
  perp: "\u22A5",
  pertenk: "\u2031",
  pfr: "\u{1D52D}",
  phi: "\u03C6",
  phiv: "\u03D5",
  phmmat: "\u2133",
  phone: "\u260E",
  pi: "\u03C0",
  pitchfork: "\u22D4",
  piv: "\u03D6",
  planck: "\u210F",
  planckh: "\u210E",
  plankv: "\u210F",
  plus: "+",
  plusacir: "\u2A23",
  plusb: "\u229E",
  pluscir: "\u2A22",
  plusdo: "\u2214",
  plusdu: "\u2A25",
  pluse: "\u2A72",
  plusmn: "\xB1",
  plussim: "\u2A26",
  plustwo: "\u2A27",
  pm: "\xB1",
  pointint: "\u2A15",
  popf: "\u{1D561}",
  pound: "\xA3",
  pr: "\u227A",
  prE: "\u2AB3",
  prap: "\u2AB7",
  prcue: "\u227C",
  pre: "\u2AAF",
  prec: "\u227A",
  precapprox: "\u2AB7",
  preccurlyeq: "\u227C",
  preceq: "\u2AAF",
  precnapprox: "\u2AB9",
  precneqq: "\u2AB5",
  precnsim: "\u22E8",
  precsim: "\u227E",
  prime: "\u2032",
  primes: "\u2119",
  prnE: "\u2AB5",
  prnap: "\u2AB9",
  prnsim: "\u22E8",
  prod: "\u220F",
  profalar: "\u232E",
  profline: "\u2312",
  profsurf: "\u2313",
  prop: "\u221D",
  propto: "\u221D",
  prsim: "\u227E",
  prurel: "\u22B0",
  pscr: "\u{1D4C5}",
  psi: "\u03C8",
  puncsp: "\u2008",
  qfr: "\u{1D52E}",
  qint: "\u2A0C",
  qopf: "\u{1D562}",
  qprime: "\u2057",
  qscr: "\u{1D4C6}",
  quaternions: "\u210D",
  quatint: "\u2A16",
  quest: "?",
  questeq: "\u225F",
  quot: '"',
  rAarr: "\u21DB",
  rArr: "\u21D2",
  rAtail: "\u291C",
  rBarr: "\u290F",
  rHar: "\u2964",
  race: "\u223D\u0331",
  racute: "\u0155",
  radic: "\u221A",
  raemptyv: "\u29B3",
  rang: "\u27E9",
  rangd: "\u2992",
  range: "\u29A5",
  rangle: "\u27E9",
  raquo: "\xBB",
  rarr: "\u2192",
  rarrap: "\u2975",
  rarrb: "\u21E5",
  rarrbfs: "\u2920",
  rarrc: "\u2933",
  rarrfs: "\u291E",
  rarrhk: "\u21AA",
  rarrlp: "\u21AC",
  rarrpl: "\u2945",
  rarrsim: "\u2974",
  rarrtl: "\u21A3",
  rarrw: "\u219D",
  ratail: "\u291A",
  ratio: "\u2236",
  rationals: "\u211A",
  rbarr: "\u290D",
  rbbrk: "\u2773",
  rbrace: "}",
  rbrack: "]",
  rbrke: "\u298C",
  rbrksld: "\u298E",
  rbrkslu: "\u2990",
  rcaron: "\u0159",
  rcedil: "\u0157",
  rceil: "\u2309",
  rcub: "}",
  rcy: "\u0440",
  rdca: "\u2937",
  rdldhar: "\u2969",
  rdquo: "\u201D",
  rdquor: "\u201D",
  rdsh: "\u21B3",
  real: "\u211C",
  realine: "\u211B",
  realpart: "\u211C",
  reals: "\u211D",
  rect: "\u25AD",
  reg: "\xAE",
  rfisht: "\u297D",
  rfloor: "\u230B",
  rfr: "\u{1D52F}",
  rhard: "\u21C1",
  rharu: "\u21C0",
  rharul: "\u296C",
  rho: "\u03C1",
  rhov: "\u03F1",
  rightarrow: "\u2192",
  rightarrowtail: "\u21A3",
  rightharpoondown: "\u21C1",
  rightharpoonup: "\u21C0",
  rightleftarrows: "\u21C4",
  rightleftharpoons: "\u21CC",
  rightrightarrows: "\u21C9",
  rightsquigarrow: "\u219D",
  rightthreetimes: "\u22CC",
  ring: "\u02DA",
  risingdotseq: "\u2253",
  rlarr: "\u21C4",
  rlhar: "\u21CC",
  rlm: "\u200F",
  rmoust: "\u23B1",
  rmoustache: "\u23B1",
  rnmid: "\u2AEE",
  roang: "\u27ED",
  roarr: "\u21FE",
  robrk: "\u27E7",
  ropar: "\u2986",
  ropf: "\u{1D563}",
  roplus: "\u2A2E",
  rotimes: "\u2A35",
  rpar: ")",
  rpargt: "\u2994",
  rppolint: "\u2A12",
  rrarr: "\u21C9",
  rsaquo: "\u203A",
  rscr: "\u{1D4C7}",
  rsh: "\u21B1",
  rsqb: "]",
  rsquo: "\u2019",
  rsquor: "\u2019",
  rthree: "\u22CC",
  rtimes: "\u22CA",
  rtri: "\u25B9",
  rtrie: "\u22B5",
  rtrif: "\u25B8",
  rtriltri: "\u29CE",
  ruluhar: "\u2968",
  rx: "\u211E",
  sacute: "\u015B",
  sbquo: "\u201A",
  sc: "\u227B",
  scE: "\u2AB4",
  scap: "\u2AB8",
  scaron: "\u0161",
  sccue: "\u227D",
  sce: "\u2AB0",
  scedil: "\u015F",
  scirc: "\u015D",
  scnE: "\u2AB6",
  scnap: "\u2ABA",
  scnsim: "\u22E9",
  scpolint: "\u2A13",
  scsim: "\u227F",
  scy: "\u0441",
  sdot: "\u22C5",
  sdotb: "\u22A1",
  sdote: "\u2A66",
  seArr: "\u21D8",
  searhk: "\u2925",
  searr: "\u2198",
  searrow: "\u2198",
  sect: "\xA7",
  semi: ";",
  seswar: "\u2929",
  setminus: "\u2216",
  setmn: "\u2216",
  sext: "\u2736",
  sfr: "\u{1D530}",
  sfrown: "\u2322",
  sharp: "\u266F",
  shchcy: "\u0449",
  shcy: "\u0448",
  shortmid: "\u2223",
  shortparallel: "\u2225",
  shy: "\xAD",
  sigma: "\u03C3",
  sigmaf: "\u03C2",
  sigmav: "\u03C2",
  sim: "\u223C",
  simdot: "\u2A6A",
  sime: "\u2243",
  simeq: "\u2243",
  simg: "\u2A9E",
  simgE: "\u2AA0",
  siml: "\u2A9D",
  simlE: "\u2A9F",
  simne: "\u2246",
  simplus: "\u2A24",
  simrarr: "\u2972",
  slarr: "\u2190",
  smallsetminus: "\u2216",
  smashp: "\u2A33",
  smeparsl: "\u29E4",
  smid: "\u2223",
  smile: "\u2323",
  smt: "\u2AAA",
  smte: "\u2AAC",
  smtes: "\u2AAC\uFE00",
  softcy: "\u044C",
  sol: "/",
  solb: "\u29C4",
  solbar: "\u233F",
  sopf: "\u{1D564}",
  spades: "\u2660",
  spadesuit: "\u2660",
  spar: "\u2225",
  sqcap: "\u2293",
  sqcaps: "\u2293\uFE00",
  sqcup: "\u2294",
  sqcups: "\u2294\uFE00",
  sqsub: "\u228F",
  sqsube: "\u2291",
  sqsubset: "\u228F",
  sqsubseteq: "\u2291",
  sqsup: "\u2290",
  sqsupe: "\u2292",
  sqsupset: "\u2290",
  sqsupseteq: "\u2292",
  squ: "\u25A1",
  square: "\u25A1",
  squarf: "\u25AA",
  squf: "\u25AA",
  srarr: "\u2192",
  sscr: "\u{1D4C8}",
  ssetmn: "\u2216",
  ssmile: "\u2323",
  sstarf: "\u22C6",
  star: "\u2606",
  starf: "\u2605",
  straightepsilon: "\u03F5",
  straightphi: "\u03D5",
  strns: "\xAF",
  sub: "\u2282",
  subE: "\u2AC5",
  subdot: "\u2ABD",
  sube: "\u2286",
  subedot: "\u2AC3",
  submult: "\u2AC1",
  subnE: "\u2ACB",
  subne: "\u228A",
  subplus: "\u2ABF",
  subrarr: "\u2979",
  subset: "\u2282",
  subseteq: "\u2286",
  subseteqq: "\u2AC5",
  subsetneq: "\u228A",
  subsetneqq: "\u2ACB",
  subsim: "\u2AC7",
  subsub: "\u2AD5",
  subsup: "\u2AD3",
  succ: "\u227B",
  succapprox: "\u2AB8",
  succcurlyeq: "\u227D",
  succeq: "\u2AB0",
  succnapprox: "\u2ABA",
  succneqq: "\u2AB6",
  succnsim: "\u22E9",
  succsim: "\u227F",
  sum: "\u2211",
  sung: "\u266A",
  sup1: "\xB9",
  sup2: "\xB2",
  sup3: "\xB3",
  sup: "\u2283",
  supE: "\u2AC6",
  supdot: "\u2ABE",
  supdsub: "\u2AD8",
  supe: "\u2287",
  supedot: "\u2AC4",
  suphsol: "\u27C9",
  suphsub: "\u2AD7",
  suplarr: "\u297B",
  supmult: "\u2AC2",
  supnE: "\u2ACC",
  supne: "\u228B",
  supplus: "\u2AC0",
  supset: "\u2283",
  supseteq: "\u2287",
  supseteqq: "\u2AC6",
  supsetneq: "\u228B",
  supsetneqq: "\u2ACC",
  supsim: "\u2AC8",
  supsub: "\u2AD4",
  supsup: "\u2AD6",
  swArr: "\u21D9",
  swarhk: "\u2926",
  swarr: "\u2199",
  swarrow: "\u2199",
  swnwar: "\u292A",
  szlig: "\xDF",
  target: "\u2316",
  tau: "\u03C4",
  tbrk: "\u23B4",
  tcaron: "\u0165",
  tcedil: "\u0163",
  tcy: "\u0442",
  tdot: "\u20DB",
  telrec: "\u2315",
  tfr: "\u{1D531}",
  there4: "\u2234",
  therefore: "\u2234",
  theta: "\u03B8",
  thetasym: "\u03D1",
  thetav: "\u03D1",
  thickapprox: "\u2248",
  thicksim: "\u223C",
  thinsp: "\u2009",
  thkap: "\u2248",
  thksim: "\u223C",
  thorn: "\xFE",
  tilde: "\u02DC",
  times: "\xD7",
  timesb: "\u22A0",
  timesbar: "\u2A31",
  timesd: "\u2A30",
  tint: "\u222D",
  toea: "\u2928",
  top: "\u22A4",
  topbot: "\u2336",
  topcir: "\u2AF1",
  topf: "\u{1D565}",
  topfork: "\u2ADA",
  tosa: "\u2929",
  tprime: "\u2034",
  trade: "\u2122",
  triangle: "\u25B5",
  triangledown: "\u25BF",
  triangleleft: "\u25C3",
  trianglelefteq: "\u22B4",
  triangleq: "\u225C",
  triangleright: "\u25B9",
  trianglerighteq: "\u22B5",
  tridot: "\u25EC",
  trie: "\u225C",
  triminus: "\u2A3A",
  triplus: "\u2A39",
  trisb: "\u29CD",
  tritime: "\u2A3B",
  trpezium: "\u23E2",
  tscr: "\u{1D4C9}",
  tscy: "\u0446",
  tshcy: "\u045B",
  tstrok: "\u0167",
  twixt: "\u226C",
  twoheadleftarrow: "\u219E",
  twoheadrightarrow: "\u21A0",
  uArr: "\u21D1",
  uHar: "\u2963",
  uacute: "\xFA",
  uarr: "\u2191",
  ubrcy: "\u045E",
  ubreve: "\u016D",
  ucirc: "\xFB",
  ucy: "\u0443",
  udarr: "\u21C5",
  udblac: "\u0171",
  udhar: "\u296E",
  ufisht: "\u297E",
  ufr: "\u{1D532}",
  ugrave: "\xF9",
  uharl: "\u21BF",
  uharr: "\u21BE",
  uhblk: "\u2580",
  ulcorn: "\u231C",
  ulcorner: "\u231C",
  ulcrop: "\u230F",
  ultri: "\u25F8",
  umacr: "\u016B",
  uml: "\xA8",
  uogon: "\u0173",
  uopf: "\u{1D566}",
  uparrow: "\u2191",
  updownarrow: "\u2195",
  upharpoonleft: "\u21BF",
  upharpoonright: "\u21BE",
  uplus: "\u228E",
  upsi: "\u03C5",
  upsih: "\u03D2",
  upsilon: "\u03C5",
  upuparrows: "\u21C8",
  urcorn: "\u231D",
  urcorner: "\u231D",
  urcrop: "\u230E",
  uring: "\u016F",
  urtri: "\u25F9",
  uscr: "\u{1D4CA}",
  utdot: "\u22F0",
  utilde: "\u0169",
  utri: "\u25B5",
  utrif: "\u25B4",
  uuarr: "\u21C8",
  uuml: "\xFC",
  uwangle: "\u29A7",
  vArr: "\u21D5",
  vBar: "\u2AE8",
  vBarv: "\u2AE9",
  vDash: "\u22A8",
  vangrt: "\u299C",
  varepsilon: "\u03F5",
  varkappa: "\u03F0",
  varnothing: "\u2205",
  varphi: "\u03D5",
  varpi: "\u03D6",
  varpropto: "\u221D",
  varr: "\u2195",
  varrho: "\u03F1",
  varsigma: "\u03C2",
  varsubsetneq: "\u228A\uFE00",
  varsubsetneqq: "\u2ACB\uFE00",
  varsupsetneq: "\u228B\uFE00",
  varsupsetneqq: "\u2ACC\uFE00",
  vartheta: "\u03D1",
  vartriangleleft: "\u22B2",
  vartriangleright: "\u22B3",
  vcy: "\u0432",
  vdash: "\u22A2",
  vee: "\u2228",
  veebar: "\u22BB",
  veeeq: "\u225A",
  vellip: "\u22EE",
  verbar: "|",
  vert: "|",
  vfr: "\u{1D533}",
  vltri: "\u22B2",
  vnsub: "\u2282\u20D2",
  vnsup: "\u2283\u20D2",
  vopf: "\u{1D567}",
  vprop: "\u221D",
  vrtri: "\u22B3",
  vscr: "\u{1D4CB}",
  vsubnE: "\u2ACB\uFE00",
  vsubne: "\u228A\uFE00",
  vsupnE: "\u2ACC\uFE00",
  vsupne: "\u228B\uFE00",
  vzigzag: "\u299A",
  wcirc: "\u0175",
  wedbar: "\u2A5F",
  wedge: "\u2227",
  wedgeq: "\u2259",
  weierp: "\u2118",
  wfr: "\u{1D534}",
  wopf: "\u{1D568}",
  wp: "\u2118",
  wr: "\u2240",
  wreath: "\u2240",
  wscr: "\u{1D4CC}",
  xcap: "\u22C2",
  xcirc: "\u25EF",
  xcup: "\u22C3",
  xdtri: "\u25BD",
  xfr: "\u{1D535}",
  xhArr: "\u27FA",
  xharr: "\u27F7",
  xi: "\u03BE",
  xlArr: "\u27F8",
  xlarr: "\u27F5",
  xmap: "\u27FC",
  xnis: "\u22FB",
  xodot: "\u2A00",
  xopf: "\u{1D569}",
  xoplus: "\u2A01",
  xotime: "\u2A02",
  xrArr: "\u27F9",
  xrarr: "\u27F6",
  xscr: "\u{1D4CD}",
  xsqcup: "\u2A06",
  xuplus: "\u2A04",
  xutri: "\u25B3",
  xvee: "\u22C1",
  xwedge: "\u22C0",
  yacute: "\xFD",
  yacy: "\u044F",
  ycirc: "\u0177",
  ycy: "\u044B",
  yen: "\xA5",
  yfr: "\u{1D536}",
  yicy: "\u0457",
  yopf: "\u{1D56A}",
  yscr: "\u{1D4CE}",
  yucy: "\u044E",
  yuml: "\xFF",
  zacute: "\u017A",
  zcaron: "\u017E",
  zcy: "\u0437",
  zdot: "\u017C",
  zeetrf: "\u2128",
  zeta: "\u03B6",
  zfr: "\u{1D537}",
  zhcy: "\u0436",
  zigrarr: "\u21DD",
  zopf: "\u{1D56B}",
  zscr: "\u{1D4CF}",
  zwj: "\u200D",
  zwnj: "\u200C"
};

// node_modules/decode-named-character-reference/index.js
var own2 = {}.hasOwnProperty;
function decodeNamedCharacterReference(value) {
  return own2.call(characterEntities, value) ? characterEntities[value] : false;
}
__name(decodeNamedCharacterReference, "decodeNamedCharacterReference");

// node_modules/micromark-util-decode-numeric-character-reference/index.js
init_esbuild_shims();
function decodeNumericCharacterReference(value, base) {
  const code3 = Number.parseInt(value, base);
  if (
    // C0 except for HT, LF, FF, CR, space.
    code3 < 9 || code3 === 11 || code3 > 13 && code3 < 32 || // Control character (DEL) of C0, and C1 controls.
    code3 > 126 && code3 < 160 || // Lone high surrogates and low surrogates.
    code3 > 55295 && code3 < 57344 || // Noncharacters.
    code3 > 64975 && code3 < 65008 || /* eslint-disable no-bitwise */
    (code3 & 65535) === 65535 || (code3 & 65535) === 65534 || /* eslint-enable no-bitwise */
    // Out of range
    code3 > 1114111
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code3);
}
__name(decodeNumericCharacterReference, "decodeNumericCharacterReference");

// node_modules/micromark-util-decode-string/index.js
var characterEscapeOrReference = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
function decodeString(value) {
  return value.replace(characterEscapeOrReference, decode);
}
__name(decodeString, "decodeString");
function decode($0, $1, $2) {
  if ($1) {
    return $1;
  }
  const head = $2.charCodeAt(0);
  if (head === 35) {
    const head2 = $2.charCodeAt(1);
    const hex = head2 === 120 || head2 === 88;
    return decodeNumericCharacterReference($2.slice(hex ? 2 : 1), hex ? 16 : 10);
  }
  return decodeNamedCharacterReference($2) || $0;
}
__name(decode, "decode");

// node_modules/mdast-util-gfm-table/lib/index.js
function gfmTableFromMarkdown() {
  return {
    enter: {
      table: enterTable,
      tableData: enterCell,
      tableHeader: enterCell,
      tableRow: enterRow
    },
    exit: {
      codeText: exitCodeText,
      table: exitTable,
      tableData: exit,
      tableHeader: exit,
      tableRow: exit
    }
  };
}
__name(gfmTableFromMarkdown, "gfmTableFromMarkdown");
function enterTable(token) {
  const align = token._align;
  ok(align, "expected `_align` on table");
  this.enter(
    {
      type: "table",
      align: align.map(function(d) {
        return d === "none" ? null : d;
      }),
      children: []
    },
    token
  );
  this.data.inTable = true;
}
__name(enterTable, "enterTable");
function exitTable(token) {
  this.exit(token);
  this.data.inTable = void 0;
}
__name(exitTable, "exitTable");
function enterRow(token) {
  this.enter({ type: "tableRow", children: [] }, token);
}
__name(enterRow, "enterRow");
function exit(token) {
  this.exit(token);
}
__name(exit, "exit");
function enterCell(token) {
  this.enter({ type: "tableCell", children: [] }, token);
}
__name(enterCell, "enterCell");
function exitCodeText(token) {
  let value = this.resume();
  if (this.data.inTable) {
    value = value.replace(/\\([\\|])/g, replace);
  }
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "inlineCode");
  node2.value = value;
  this.exit(token);
}
__name(exitCodeText, "exitCodeText");
function replace($0, $1) {
  return $1 === "|" ? $1 : $0;
}
__name(replace, "replace");
function gfmTableToMarkdown(options) {
  const settings = options || {};
  const padding = settings.tableCellPadding;
  const alignDelimiters = settings.tablePipeAlign;
  const stringLength = settings.stringLength;
  const around = padding ? " " : "|";
  return {
    unsafe: [
      { character: "\r", inConstruct: "tableCell" },
      { character: "\n", inConstruct: "tableCell" },
      // A pipe, when followed by a tab or space (padding), or a dash or colon
      // (unpadded delimiter row), could result in a table.
      { atBreak: true, character: "|", after: "[	 :-]" },
      // A pipe in a cell must be encoded.
      { character: "|", inConstruct: "tableCell" },
      // A colon must be followed by a dash, in which case it could start a
      // delimiter row.
      { atBreak: true, character: ":", after: "-" },
      // A delimiter row can also start with a dash, when followed by more
      // dashes, a colon, or a pipe.
      // This is a stricter version than the built in check for lists, thematic
      // breaks, and setex heading underlines though:
      // <https://github.com/syntax-tree/mdast-util-to-markdown/blob/51a2038/lib/unsafe.js#L57>
      { atBreak: true, character: "-", after: "[:|-]" }
    ],
    handlers: {
      inlineCode: inlineCodeWithTable,
      table: handleTable,
      tableCell: handleTableCell,
      tableRow: handleTableRow
    }
  };
  function handleTable(node2, _, state, info) {
    return serializeData(handleTableAsData(node2, state, info), node2.align);
  }
  __name(handleTable, "handleTable");
  function handleTableRow(node2, _, state, info) {
    const row = handleTableRowAsData(node2, state, info);
    const value = serializeData([row]);
    return value.slice(0, value.indexOf("\n"));
  }
  __name(handleTableRow, "handleTableRow");
  function handleTableCell(node2, _, state, info) {
    const exit3 = state.enter("tableCell");
    const subexit = state.enter("phrasing");
    const value = state.containerPhrasing(node2, {
      ...info,
      before: around,
      after: around
    });
    subexit();
    exit3();
    return value;
  }
  __name(handleTableCell, "handleTableCell");
  function serializeData(matrix, align) {
    return markdownTable(matrix, {
      align,
      // @ts-expect-error: `markdown-table` types should support `null`.
      alignDelimiters,
      // @ts-expect-error: `markdown-table` types should support `null`.
      padding,
      // @ts-expect-error: `markdown-table` types should support `null`.
      stringLength
    });
  }
  __name(serializeData, "serializeData");
  function handleTableAsData(node2, state, info) {
    const children = node2.children;
    let index2 = -1;
    const result = [];
    const subexit = state.enter("table");
    while (++index2 < children.length) {
      result[index2] = handleTableRowAsData(children[index2], state, info);
    }
    subexit();
    return result;
  }
  __name(handleTableAsData, "handleTableAsData");
  function handleTableRowAsData(node2, state, info) {
    const children = node2.children;
    let index2 = -1;
    const result = [];
    const subexit = state.enter("tableRow");
    while (++index2 < children.length) {
      result[index2] = handleTableCell(children[index2], node2, state, info);
    }
    subexit();
    return result;
  }
  __name(handleTableRowAsData, "handleTableRowAsData");
  function inlineCodeWithTable(node2, parent, state) {
    let value = handle.inlineCode(node2, parent, state);
    if (state.stack.includes("tableCell")) {
      value = value.replace(/\|/g, "\\$&");
    }
    return value;
  }
  __name(inlineCodeWithTable, "inlineCodeWithTable");
}
__name(gfmTableToMarkdown, "gfmTableToMarkdown");

// node_modules/mdast-util-gfm-task-list-item/index.js
init_esbuild_shims();

// node_modules/mdast-util-gfm-task-list-item/lib/index.js
init_esbuild_shims();
function gfmTaskListItemFromMarkdown() {
  return {
    exit: {
      taskListCheckValueChecked: exitCheck,
      taskListCheckValueUnchecked: exitCheck,
      paragraph: exitParagraphWithTaskListItem
    }
  };
}
__name(gfmTaskListItemFromMarkdown, "gfmTaskListItemFromMarkdown");
function gfmTaskListItemToMarkdown() {
  return {
    unsafe: [{ atBreak: true, character: "-", after: "[:|-]" }],
    handlers: { listItem: listItemWithTaskListItem }
  };
}
__name(gfmTaskListItemToMarkdown, "gfmTaskListItemToMarkdown");
function exitCheck(token) {
  const node2 = this.stack[this.stack.length - 2];
  ok(node2.type === "listItem");
  node2.checked = token.type === "taskListCheckValueChecked";
}
__name(exitCheck, "exitCheck");
function exitParagraphWithTaskListItem(token) {
  const parent = this.stack[this.stack.length - 2];
  if (parent && parent.type === "listItem" && typeof parent.checked === "boolean") {
    const node2 = this.stack[this.stack.length - 1];
    ok(node2.type === "paragraph");
    const head = node2.children[0];
    if (head && head.type === "text") {
      const siblings = parent.children;
      let index2 = -1;
      let firstParaghraph;
      while (++index2 < siblings.length) {
        const sibling = siblings[index2];
        if (sibling.type === "paragraph") {
          firstParaghraph = sibling;
          break;
        }
      }
      if (firstParaghraph === node2) {
        head.value = head.value.slice(1);
        if (head.value.length === 0) {
          node2.children.shift();
        } else if (node2.position && head.position && typeof head.position.start.offset === "number") {
          head.position.start.column++;
          head.position.start.offset++;
          node2.position.start = Object.assign({}, head.position.start);
        }
      }
    }
  }
  this.exit(token);
}
__name(exitParagraphWithTaskListItem, "exitParagraphWithTaskListItem");
function listItemWithTaskListItem(node2, parent, state, info) {
  const head = node2.children[0];
  const checkable = typeof node2.checked === "boolean" && head && head.type === "paragraph";
  const checkbox = "[" + (node2.checked ? "x" : " ") + "] ";
  const tracker = state.createTracker(info);
  if (checkable) {
    tracker.move(checkbox);
  }
  let value = handle.listItem(node2, parent, state, {
    ...info,
    ...tracker.current()
  });
  if (checkable) {
    value = value.replace(/^(?:[*+-]|\d+\.)([\r\n]| {1,3})/, check);
  }
  return value;
  function check($0) {
    return $0 + checkbox;
  }
  __name(check, "check");
}
__name(listItemWithTaskListItem, "listItemWithTaskListItem");

// node_modules/mdast-util-gfm/lib/index.js
function gfmFromMarkdown() {
  return [
    gfmAutolinkLiteralFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown()
  ];
}
__name(gfmFromMarkdown, "gfmFromMarkdown");
function gfmToMarkdown(options) {
  return {
    extensions: [
      gfmAutolinkLiteralToMarkdown(),
      gfmFootnoteToMarkdown(options),
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown(options),
      gfmTaskListItemToMarkdown()
    ]
  };
}
__name(gfmToMarkdown, "gfmToMarkdown");

// node_modules/micromark-extension-gfm/index.js
init_esbuild_shims();

// node_modules/micromark-util-combine-extensions/index.js
init_esbuild_shims();

// node_modules/micromark-util-chunked/index.js
init_esbuild_shims();
function splice(list3, start, remove, items) {
  const end = list3.length;
  let chunkStart = 0;
  let parameters;
  if (start < 0) {
    start = -start > end ? 0 : end + start;
  } else {
    start = start > end ? end : start;
  }
  remove = remove > 0 ? remove : 0;
  if (items.length < 1e4) {
    parameters = Array.from(items);
    parameters.unshift(start, remove);
    list3.splice(...parameters);
  } else {
    if (remove) list3.splice(start, remove);
    while (chunkStart < items.length) {
      parameters = items.slice(chunkStart, chunkStart + 1e4);
      parameters.unshift(start, 0);
      list3.splice(...parameters);
      chunkStart += 1e4;
      start += 1e4;
    }
  }
}
__name(splice, "splice");
function push(list3, items) {
  if (list3.length > 0) {
    splice(list3, list3.length, 0, items);
    return list3;
  }
  return items;
}
__name(push, "push");

// node_modules/micromark-util-combine-extensions/index.js
var hasOwnProperty = {}.hasOwnProperty;
function combineExtensions(extensions) {
  const all2 = {};
  let index2 = -1;
  while (++index2 < extensions.length) {
    syntaxExtension(all2, extensions[index2]);
  }
  return all2;
}
__name(combineExtensions, "combineExtensions");
function syntaxExtension(all2, extension2) {
  let hook;
  for (hook in extension2) {
    const maybe = hasOwnProperty.call(all2, hook) ? all2[hook] : void 0;
    const left = maybe || (all2[hook] = {});
    const right = extension2[hook];
    let code3;
    if (right) {
      for (code3 in right) {
        if (!hasOwnProperty.call(left, code3)) left[code3] = [];
        const value = right[code3];
        constructs(
          // @ts-expect-error Looks like a list.
          left[code3],
          Array.isArray(value) ? value : value ? [value] : []
        );
      }
    }
  }
}
__name(syntaxExtension, "syntaxExtension");
function constructs(existing, list3) {
  let index2 = -1;
  const before = [];
  while (++index2 < list3.length) {
    ;
    (list3[index2].add === "after" ? existing : before).push(list3[index2]);
  }
  splice(existing, 0, 0, before);
}
__name(constructs, "constructs");

// node_modules/micromark-extension-gfm-autolink-literal/index.js
init_esbuild_shims();

// node_modules/micromark-extension-gfm-autolink-literal/lib/syntax.js
init_esbuild_shims();
var wwwPrefix = {
  tokenize: tokenizeWwwPrefix,
  partial: true
};
var domain = {
  tokenize: tokenizeDomain,
  partial: true
};
var path2 = {
  tokenize: tokenizePath,
  partial: true
};
var trail = {
  tokenize: tokenizeTrail,
  partial: true
};
var emailDomainDotTrail = {
  tokenize: tokenizeEmailDomainDotTrail,
  partial: true
};
var wwwAutolink = {
  name: "wwwAutolink",
  tokenize: tokenizeWwwAutolink,
  previous: previousWww
};
var protocolAutolink = {
  name: "protocolAutolink",
  tokenize: tokenizeProtocolAutolink,
  previous: previousProtocol
};
var emailAutolink = {
  name: "emailAutolink",
  tokenize: tokenizeEmailAutolink,
  previous: previousEmail
};
var text2 = {};
function gfmAutolinkLiteral() {
  return {
    text: text2
  };
}
__name(gfmAutolinkLiteral, "gfmAutolinkLiteral");
var code2 = 48;
while (code2 < 123) {
  text2[code2] = emailAutolink;
  code2++;
  if (code2 === 58) code2 = 65;
  else if (code2 === 91) code2 = 97;
}
text2[43] = emailAutolink;
text2[45] = emailAutolink;
text2[46] = emailAutolink;
text2[95] = emailAutolink;
text2[72] = [emailAutolink, protocolAutolink];
text2[104] = [emailAutolink, protocolAutolink];
text2[87] = [emailAutolink, wwwAutolink];
text2[119] = [emailAutolink, wwwAutolink];
function tokenizeEmailAutolink(effects, ok3, nok) {
  const self = this;
  let dot;
  let data;
  return start;
  function start(code3) {
    if (!gfmAtext(code3) || !previousEmail.call(self, self.previous) || previousUnbalanced(self.events)) {
      return nok(code3);
    }
    effects.enter("literalAutolink");
    effects.enter("literalAutolinkEmail");
    return atext(code3);
  }
  __name(start, "start");
  function atext(code3) {
    if (gfmAtext(code3)) {
      effects.consume(code3);
      return atext;
    }
    if (code3 === 64) {
      effects.consume(code3);
      return emailDomain;
    }
    return nok(code3);
  }
  __name(atext, "atext");
  function emailDomain(code3) {
    if (code3 === 46) {
      return effects.check(emailDomainDotTrail, emailDomainAfter, emailDomainDot)(code3);
    }
    if (code3 === 45 || code3 === 95 || asciiAlphanumeric(code3)) {
      data = true;
      effects.consume(code3);
      return emailDomain;
    }
    return emailDomainAfter(code3);
  }
  __name(emailDomain, "emailDomain");
  function emailDomainDot(code3) {
    effects.consume(code3);
    dot = true;
    return emailDomain;
  }
  __name(emailDomainDot, "emailDomainDot");
  function emailDomainAfter(code3) {
    if (data && dot && asciiAlpha(self.previous)) {
      effects.exit("literalAutolinkEmail");
      effects.exit("literalAutolink");
      return ok3(code3);
    }
    return nok(code3);
  }
  __name(emailDomainAfter, "emailDomainAfter");
}
__name(tokenizeEmailAutolink, "tokenizeEmailAutolink");
function tokenizeWwwAutolink(effects, ok3, nok) {
  const self = this;
  return wwwStart;
  function wwwStart(code3) {
    if (code3 !== 87 && code3 !== 119 || !previousWww.call(self, self.previous) || previousUnbalanced(self.events)) {
      return nok(code3);
    }
    effects.enter("literalAutolink");
    effects.enter("literalAutolinkWww");
    return effects.check(wwwPrefix, effects.attempt(domain, effects.attempt(path2, wwwAfter), nok), nok)(code3);
  }
  __name(wwwStart, "wwwStart");
  function wwwAfter(code3) {
    effects.exit("literalAutolinkWww");
    effects.exit("literalAutolink");
    return ok3(code3);
  }
  __name(wwwAfter, "wwwAfter");
}
__name(tokenizeWwwAutolink, "tokenizeWwwAutolink");
function tokenizeProtocolAutolink(effects, ok3, nok) {
  const self = this;
  let buffer = "";
  let seen = false;
  return protocolStart;
  function protocolStart(code3) {
    if ((code3 === 72 || code3 === 104) && previousProtocol.call(self, self.previous) && !previousUnbalanced(self.events)) {
      effects.enter("literalAutolink");
      effects.enter("literalAutolinkHttp");
      buffer += String.fromCodePoint(code3);
      effects.consume(code3);
      return protocolPrefixInside;
    }
    return nok(code3);
  }
  __name(protocolStart, "protocolStart");
  function protocolPrefixInside(code3) {
    if (asciiAlpha(code3) && buffer.length < 5) {
      buffer += String.fromCodePoint(code3);
      effects.consume(code3);
      return protocolPrefixInside;
    }
    if (code3 === 58) {
      const protocol = buffer.toLowerCase();
      if (protocol === "http" || protocol === "https") {
        effects.consume(code3);
        return protocolSlashesInside;
      }
    }
    return nok(code3);
  }
  __name(protocolPrefixInside, "protocolPrefixInside");
  function protocolSlashesInside(code3) {
    if (code3 === 47) {
      effects.consume(code3);
      if (seen) {
        return afterProtocol;
      }
      seen = true;
      return protocolSlashesInside;
    }
    return nok(code3);
  }
  __name(protocolSlashesInside, "protocolSlashesInside");
  function afterProtocol(code3) {
    return code3 === null || asciiControl(code3) || markdownLineEndingOrSpace(code3) || unicodeWhitespace(code3) || unicodePunctuation(code3) ? nok(code3) : effects.attempt(domain, effects.attempt(path2, protocolAfter), nok)(code3);
  }
  __name(afterProtocol, "afterProtocol");
  function protocolAfter(code3) {
    effects.exit("literalAutolinkHttp");
    effects.exit("literalAutolink");
    return ok3(code3);
  }
  __name(protocolAfter, "protocolAfter");
}
__name(tokenizeProtocolAutolink, "tokenizeProtocolAutolink");
function tokenizeWwwPrefix(effects, ok3, nok) {
  let size = 0;
  return wwwPrefixInside;
  function wwwPrefixInside(code3) {
    if ((code3 === 87 || code3 === 119) && size < 3) {
      size++;
      effects.consume(code3);
      return wwwPrefixInside;
    }
    if (code3 === 46 && size === 3) {
      effects.consume(code3);
      return wwwPrefixAfter;
    }
    return nok(code3);
  }
  __name(wwwPrefixInside, "wwwPrefixInside");
  function wwwPrefixAfter(code3) {
    return code3 === null ? nok(code3) : ok3(code3);
  }
  __name(wwwPrefixAfter, "wwwPrefixAfter");
}
__name(tokenizeWwwPrefix, "tokenizeWwwPrefix");
function tokenizeDomain(effects, ok3, nok) {
  let underscoreInLastSegment;
  let underscoreInLastLastSegment;
  let seen;
  return domainInside;
  function domainInside(code3) {
    if (code3 === 46 || code3 === 95) {
      return effects.check(trail, domainAfter, domainAtPunctuation)(code3);
    }
    if (code3 === null || markdownLineEndingOrSpace(code3) || unicodeWhitespace(code3) || code3 !== 45 && unicodePunctuation(code3)) {
      return domainAfter(code3);
    }
    seen = true;
    effects.consume(code3);
    return domainInside;
  }
  __name(domainInside, "domainInside");
  function domainAtPunctuation(code3) {
    if (code3 === 95) {
      underscoreInLastSegment = true;
    } else {
      underscoreInLastLastSegment = underscoreInLastSegment;
      underscoreInLastSegment = void 0;
    }
    effects.consume(code3);
    return domainInside;
  }
  __name(domainAtPunctuation, "domainAtPunctuation");
  function domainAfter(code3) {
    if (underscoreInLastLastSegment || underscoreInLastSegment || !seen) {
      return nok(code3);
    }
    return ok3(code3);
  }
  __name(domainAfter, "domainAfter");
}
__name(tokenizeDomain, "tokenizeDomain");
function tokenizePath(effects, ok3) {
  let sizeOpen = 0;
  let sizeClose = 0;
  return pathInside;
  function pathInside(code3) {
    if (code3 === 40) {
      sizeOpen++;
      effects.consume(code3);
      return pathInside;
    }
    if (code3 === 41 && sizeClose < sizeOpen) {
      return pathAtPunctuation(code3);
    }
    if (code3 === 33 || code3 === 34 || code3 === 38 || code3 === 39 || code3 === 41 || code3 === 42 || code3 === 44 || code3 === 46 || code3 === 58 || code3 === 59 || code3 === 60 || code3 === 63 || code3 === 93 || code3 === 95 || code3 === 126) {
      return effects.check(trail, ok3, pathAtPunctuation)(code3);
    }
    if (code3 === null || markdownLineEndingOrSpace(code3) || unicodeWhitespace(code3)) {
      return ok3(code3);
    }
    effects.consume(code3);
    return pathInside;
  }
  __name(pathInside, "pathInside");
  function pathAtPunctuation(code3) {
    if (code3 === 41) {
      sizeClose++;
    }
    effects.consume(code3);
    return pathInside;
  }
  __name(pathAtPunctuation, "pathAtPunctuation");
}
__name(tokenizePath, "tokenizePath");
function tokenizeTrail(effects, ok3, nok) {
  return trail2;
  function trail2(code3) {
    if (code3 === 33 || code3 === 34 || code3 === 39 || code3 === 41 || code3 === 42 || code3 === 44 || code3 === 46 || code3 === 58 || code3 === 59 || code3 === 63 || code3 === 95 || code3 === 126) {
      effects.consume(code3);
      return trail2;
    }
    if (code3 === 38) {
      effects.consume(code3);
      return trailCharacterReferenceStart;
    }
    if (code3 === 93) {
      effects.consume(code3);
      return trailBracketAfter;
    }
    if (
      // `<` is an end.
      code3 === 60 || // So is whitespace.
      code3 === null || markdownLineEndingOrSpace(code3) || unicodeWhitespace(code3)
    ) {
      return ok3(code3);
    }
    return nok(code3);
  }
  __name(trail2, "trail");
  function trailBracketAfter(code3) {
    if (code3 === null || code3 === 40 || code3 === 91 || markdownLineEndingOrSpace(code3) || unicodeWhitespace(code3)) {
      return ok3(code3);
    }
    return trail2(code3);
  }
  __name(trailBracketAfter, "trailBracketAfter");
  function trailCharacterReferenceStart(code3) {
    return asciiAlpha(code3) ? trailCharacterReferenceInside(code3) : nok(code3);
  }
  __name(trailCharacterReferenceStart, "trailCharacterReferenceStart");
  function trailCharacterReferenceInside(code3) {
    if (code3 === 59) {
      effects.consume(code3);
      return trail2;
    }
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      return trailCharacterReferenceInside;
    }
    return nok(code3);
  }
  __name(trailCharacterReferenceInside, "trailCharacterReferenceInside");
}
__name(tokenizeTrail, "tokenizeTrail");
function tokenizeEmailDomainDotTrail(effects, ok3, nok) {
  return start;
  function start(code3) {
    effects.consume(code3);
    return after;
  }
  __name(start, "start");
  function after(code3) {
    return asciiAlphanumeric(code3) ? nok(code3) : ok3(code3);
  }
  __name(after, "after");
}
__name(tokenizeEmailDomainDotTrail, "tokenizeEmailDomainDotTrail");
function previousWww(code3) {
  return code3 === null || code3 === 40 || code3 === 42 || code3 === 95 || code3 === 91 || code3 === 93 || code3 === 126 || markdownLineEndingOrSpace(code3);
}
__name(previousWww, "previousWww");
function previousProtocol(code3) {
  return !asciiAlpha(code3);
}
__name(previousProtocol, "previousProtocol");
function previousEmail(code3) {
  return !(code3 === 47 || gfmAtext(code3));
}
__name(previousEmail, "previousEmail");
function gfmAtext(code3) {
  return code3 === 43 || code3 === 45 || code3 === 46 || code3 === 95 || asciiAlphanumeric(code3);
}
__name(gfmAtext, "gfmAtext");
function previousUnbalanced(events) {
  let index2 = events.length;
  let result = false;
  while (index2--) {
    const token = events[index2][1];
    if ((token.type === "labelLink" || token.type === "labelImage") && !token._balanced) {
      result = true;
      break;
    }
    if (token._gfmAutolinkLiteralWalkedInto) {
      result = false;
      break;
    }
  }
  if (events.length > 0 && !result) {
    events[events.length - 1][1]._gfmAutolinkLiteralWalkedInto = true;
  }
  return result;
}
__name(previousUnbalanced, "previousUnbalanced");

// node_modules/micromark-extension-gfm-footnote/index.js
init_esbuild_shims();

// node_modules/micromark-extension-gfm-footnote/lib/syntax.js
init_esbuild_shims();

// node_modules/micromark-core-commonmark/index.js
init_esbuild_shims();

// node_modules/micromark-core-commonmark/lib/attention.js
init_esbuild_shims();

// node_modules/micromark-util-resolve-all/index.js
init_esbuild_shims();
function resolveAll(constructs2, events, context) {
  const called = [];
  let index2 = -1;
  while (++index2 < constructs2.length) {
    const resolve2 = constructs2[index2].resolveAll;
    if (resolve2 && !called.includes(resolve2)) {
      events = resolve2(events, context);
      called.push(resolve2);
    }
  }
  return events;
}
__name(resolveAll, "resolveAll");

// node_modules/micromark-core-commonmark/lib/attention.js
var attention = {
  name: "attention",
  resolveAll: resolveAllAttention,
  tokenize: tokenizeAttention
};
function resolveAllAttention(events, context) {
  let index2 = -1;
  let open;
  let group;
  let text5;
  let openingSequence;
  let closingSequence;
  let use;
  let nextEvents;
  let offset;
  while (++index2 < events.length) {
    if (events[index2][0] === "enter" && events[index2][1].type === "attentionSequence" && events[index2][1]._close) {
      open = index2;
      while (open--) {
        if (events[open][0] === "exit" && events[open][1].type === "attentionSequence" && events[open][1]._open && // If the markers are the same:
        context.sliceSerialize(events[open][1]).charCodeAt(0) === context.sliceSerialize(events[index2][1]).charCodeAt(0)) {
          if ((events[open][1]._close || events[index2][1]._open) && (events[index2][1].end.offset - events[index2][1].start.offset) % 3 && !((events[open][1].end.offset - events[open][1].start.offset + events[index2][1].end.offset - events[index2][1].start.offset) % 3)) {
            continue;
          }
          use = events[open][1].end.offset - events[open][1].start.offset > 1 && events[index2][1].end.offset - events[index2][1].start.offset > 1 ? 2 : 1;
          const start = {
            ...events[open][1].end
          };
          const end = {
            ...events[index2][1].start
          };
          movePoint(start, -use);
          movePoint(end, use);
          openingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start,
            end: {
              ...events[open][1].end
            }
          };
          closingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: {
              ...events[index2][1].start
            },
            end
          };
          text5 = {
            type: use > 1 ? "strongText" : "emphasisText",
            start: {
              ...events[open][1].end
            },
            end: {
              ...events[index2][1].start
            }
          };
          group = {
            type: use > 1 ? "strong" : "emphasis",
            start: {
              ...openingSequence.start
            },
            end: {
              ...closingSequence.end
            }
          };
          events[open][1].end = {
            ...openingSequence.start
          };
          events[index2][1].start = {
            ...closingSequence.end
          };
          nextEvents = [];
          if (events[open][1].end.offset - events[open][1].start.offset) {
            nextEvents = push(nextEvents, [["enter", events[open][1], context], ["exit", events[open][1], context]]);
          }
          nextEvents = push(nextEvents, [["enter", group, context], ["enter", openingSequence, context], ["exit", openingSequence, context], ["enter", text5, context]]);
          nextEvents = push(nextEvents, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + 1, index2), context));
          nextEvents = push(nextEvents, [["exit", text5, context], ["enter", closingSequence, context], ["exit", closingSequence, context], ["exit", group, context]]);
          if (events[index2][1].end.offset - events[index2][1].start.offset) {
            offset = 2;
            nextEvents = push(nextEvents, [["enter", events[index2][1], context], ["exit", events[index2][1], context]]);
          } else {
            offset = 0;
          }
          splice(events, open - 1, index2 - open + 3, nextEvents);
          index2 = open + nextEvents.length - offset - 2;
          break;
        }
      }
    }
  }
  index2 = -1;
  while (++index2 < events.length) {
    if (events[index2][1].type === "attentionSequence") {
      events[index2][1].type = "data";
    }
  }
  return events;
}
__name(resolveAllAttention, "resolveAllAttention");
function tokenizeAttention(effects, ok3) {
  const attentionMarkers2 = this.parser.constructs.attentionMarkers.null;
  const previous4 = this.previous;
  const before = classifyCharacter(previous4);
  let marker;
  return start;
  function start(code3) {
    marker = code3;
    effects.enter("attentionSequence");
    return inside(code3);
  }
  __name(start, "start");
  function inside(code3) {
    if (code3 === marker) {
      effects.consume(code3);
      return inside;
    }
    const token = effects.exit("attentionSequence");
    const after = classifyCharacter(code3);
    const open = !after || after === 2 && before || attentionMarkers2.includes(code3);
    const close = !before || before === 2 && after || attentionMarkers2.includes(previous4);
    token._open = Boolean(marker === 42 ? open : open && (before || !close));
    token._close = Boolean(marker === 42 ? close : close && (after || !open));
    return ok3(code3);
  }
  __name(inside, "inside");
}
__name(tokenizeAttention, "tokenizeAttention");
function movePoint(point3, offset) {
  point3.column += offset;
  point3.offset += offset;
  point3._bufferIndex += offset;
}
__name(movePoint, "movePoint");

// node_modules/micromark-core-commonmark/lib/autolink.js
init_esbuild_shims();
var autolink = {
  name: "autolink",
  tokenize: tokenizeAutolink
};
function tokenizeAutolink(effects, ok3, nok) {
  let size = 0;
  return start;
  function start(code3) {
    effects.enter("autolink");
    effects.enter("autolinkMarker");
    effects.consume(code3);
    effects.exit("autolinkMarker");
    effects.enter("autolinkProtocol");
    return open;
  }
  __name(start, "start");
  function open(code3) {
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      return schemeOrEmailAtext;
    }
    if (code3 === 64) {
      return nok(code3);
    }
    return emailAtext(code3);
  }
  __name(open, "open");
  function schemeOrEmailAtext(code3) {
    if (code3 === 43 || code3 === 45 || code3 === 46 || asciiAlphanumeric(code3)) {
      size = 1;
      return schemeInsideOrEmailAtext(code3);
    }
    return emailAtext(code3);
  }
  __name(schemeOrEmailAtext, "schemeOrEmailAtext");
  function schemeInsideOrEmailAtext(code3) {
    if (code3 === 58) {
      effects.consume(code3);
      size = 0;
      return urlInside;
    }
    if ((code3 === 43 || code3 === 45 || code3 === 46 || asciiAlphanumeric(code3)) && size++ < 32) {
      effects.consume(code3);
      return schemeInsideOrEmailAtext;
    }
    size = 0;
    return emailAtext(code3);
  }
  __name(schemeInsideOrEmailAtext, "schemeInsideOrEmailAtext");
  function urlInside(code3) {
    if (code3 === 62) {
      effects.exit("autolinkProtocol");
      effects.enter("autolinkMarker");
      effects.consume(code3);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok3;
    }
    if (code3 === null || code3 === 32 || code3 === 60 || asciiControl(code3)) {
      return nok(code3);
    }
    effects.consume(code3);
    return urlInside;
  }
  __name(urlInside, "urlInside");
  function emailAtext(code3) {
    if (code3 === 64) {
      effects.consume(code3);
      return emailAtSignOrDot;
    }
    if (asciiAtext(code3)) {
      effects.consume(code3);
      return emailAtext;
    }
    return nok(code3);
  }
  __name(emailAtext, "emailAtext");
  function emailAtSignOrDot(code3) {
    return asciiAlphanumeric(code3) ? emailLabel(code3) : nok(code3);
  }
  __name(emailAtSignOrDot, "emailAtSignOrDot");
  function emailLabel(code3) {
    if (code3 === 46) {
      effects.consume(code3);
      size = 0;
      return emailAtSignOrDot;
    }
    if (code3 === 62) {
      effects.exit("autolinkProtocol").type = "autolinkEmail";
      effects.enter("autolinkMarker");
      effects.consume(code3);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok3;
    }
    return emailValue(code3);
  }
  __name(emailLabel, "emailLabel");
  function emailValue(code3) {
    if ((code3 === 45 || asciiAlphanumeric(code3)) && size++ < 63) {
      const next = code3 === 45 ? emailValue : emailLabel;
      effects.consume(code3);
      return next;
    }
    return nok(code3);
  }
  __name(emailValue, "emailValue");
}
__name(tokenizeAutolink, "tokenizeAutolink");

// node_modules/micromark-core-commonmark/lib/blank-line.js
init_esbuild_shims();

// node_modules/micromark-factory-space/index.js
init_esbuild_shims();
function factorySpace(effects, ok3, type, max) {
  const limit = max ? max - 1 : Number.POSITIVE_INFINITY;
  let size = 0;
  return start;
  function start(code3) {
    if (markdownSpace(code3)) {
      effects.enter(type);
      return prefix(code3);
    }
    return ok3(code3);
  }
  __name(start, "start");
  function prefix(code3) {
    if (markdownSpace(code3) && size++ < limit) {
      effects.consume(code3);
      return prefix;
    }
    effects.exit(type);
    return ok3(code3);
  }
  __name(prefix, "prefix");
}
__name(factorySpace, "factorySpace");

// node_modules/micromark-core-commonmark/lib/blank-line.js
var blankLine = {
  partial: true,
  tokenize: tokenizeBlankLine
};
function tokenizeBlankLine(effects, ok3, nok) {
  return start;
  function start(code3) {
    return markdownSpace(code3) ? factorySpace(effects, after, "linePrefix")(code3) : after(code3);
  }
  __name(start, "start");
  function after(code3) {
    return code3 === null || markdownLineEnding(code3) ? ok3(code3) : nok(code3);
  }
  __name(after, "after");
}
__name(tokenizeBlankLine, "tokenizeBlankLine");

// node_modules/micromark-core-commonmark/lib/block-quote.js
init_esbuild_shims();
var blockQuote = {
  continuation: {
    tokenize: tokenizeBlockQuoteContinuation
  },
  exit: exit2,
  name: "blockQuote",
  tokenize: tokenizeBlockQuoteStart
};
function tokenizeBlockQuoteStart(effects, ok3, nok) {
  const self = this;
  return start;
  function start(code3) {
    if (code3 === 62) {
      const state = self.containerState;
      if (!state.open) {
        effects.enter("blockQuote", {
          _container: true
        });
        state.open = true;
      }
      effects.enter("blockQuotePrefix");
      effects.enter("blockQuoteMarker");
      effects.consume(code3);
      effects.exit("blockQuoteMarker");
      return after;
    }
    return nok(code3);
  }
  __name(start, "start");
  function after(code3) {
    if (markdownSpace(code3)) {
      effects.enter("blockQuotePrefixWhitespace");
      effects.consume(code3);
      effects.exit("blockQuotePrefixWhitespace");
      effects.exit("blockQuotePrefix");
      return ok3;
    }
    effects.exit("blockQuotePrefix");
    return ok3(code3);
  }
  __name(after, "after");
}
__name(tokenizeBlockQuoteStart, "tokenizeBlockQuoteStart");
function tokenizeBlockQuoteContinuation(effects, ok3, nok) {
  const self = this;
  return contStart;
  function contStart(code3) {
    if (markdownSpace(code3)) {
      return factorySpace(effects, contBefore, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code3);
    }
    return contBefore(code3);
  }
  __name(contStart, "contStart");
  function contBefore(code3) {
    return effects.attempt(blockQuote, ok3, nok)(code3);
  }
  __name(contBefore, "contBefore");
}
__name(tokenizeBlockQuoteContinuation, "tokenizeBlockQuoteContinuation");
function exit2(effects) {
  effects.exit("blockQuote");
}
__name(exit2, "exit");

// node_modules/micromark-core-commonmark/lib/character-escape.js
init_esbuild_shims();
var characterEscape = {
  name: "characterEscape",
  tokenize: tokenizeCharacterEscape
};
function tokenizeCharacterEscape(effects, ok3, nok) {
  return start;
  function start(code3) {
    effects.enter("characterEscape");
    effects.enter("escapeMarker");
    effects.consume(code3);
    effects.exit("escapeMarker");
    return inside;
  }
  __name(start, "start");
  function inside(code3) {
    if (asciiPunctuation(code3)) {
      effects.enter("characterEscapeValue");
      effects.consume(code3);
      effects.exit("characterEscapeValue");
      effects.exit("characterEscape");
      return ok3;
    }
    return nok(code3);
  }
  __name(inside, "inside");
}
__name(tokenizeCharacterEscape, "tokenizeCharacterEscape");

// node_modules/micromark-core-commonmark/lib/character-reference.js
init_esbuild_shims();
var characterReference = {
  name: "characterReference",
  tokenize: tokenizeCharacterReference
};
function tokenizeCharacterReference(effects, ok3, nok) {
  const self = this;
  let size = 0;
  let max;
  let test;
  return start;
  function start(code3) {
    effects.enter("characterReference");
    effects.enter("characterReferenceMarker");
    effects.consume(code3);
    effects.exit("characterReferenceMarker");
    return open;
  }
  __name(start, "start");
  function open(code3) {
    if (code3 === 35) {
      effects.enter("characterReferenceMarkerNumeric");
      effects.consume(code3);
      effects.exit("characterReferenceMarkerNumeric");
      return numeric;
    }
    effects.enter("characterReferenceValue");
    max = 31;
    test = asciiAlphanumeric;
    return value(code3);
  }
  __name(open, "open");
  function numeric(code3) {
    if (code3 === 88 || code3 === 120) {
      effects.enter("characterReferenceMarkerHexadecimal");
      effects.consume(code3);
      effects.exit("characterReferenceMarkerHexadecimal");
      effects.enter("characterReferenceValue");
      max = 6;
      test = asciiHexDigit;
      return value;
    }
    effects.enter("characterReferenceValue");
    max = 7;
    test = asciiDigit;
    return value(code3);
  }
  __name(numeric, "numeric");
  function value(code3) {
    if (code3 === 59 && size) {
      const token = effects.exit("characterReferenceValue");
      if (test === asciiAlphanumeric && !decodeNamedCharacterReference(self.sliceSerialize(token))) {
        return nok(code3);
      }
      effects.enter("characterReferenceMarker");
      effects.consume(code3);
      effects.exit("characterReferenceMarker");
      effects.exit("characterReference");
      return ok3;
    }
    if (test(code3) && size++ < max) {
      effects.consume(code3);
      return value;
    }
    return nok(code3);
  }
  __name(value, "value");
}
__name(tokenizeCharacterReference, "tokenizeCharacterReference");

// node_modules/micromark-core-commonmark/lib/code-fenced.js
init_esbuild_shims();
var nonLazyContinuation = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation
};
var codeFenced = {
  concrete: true,
  name: "codeFenced",
  tokenize: tokenizeCodeFenced
};
function tokenizeCodeFenced(effects, ok3, nok) {
  const self = this;
  const closeStart = {
    partial: true,
    tokenize: tokenizeCloseStart
  };
  let initialPrefix = 0;
  let sizeOpen = 0;
  let marker;
  return start;
  function start(code3) {
    return beforeSequenceOpen(code3);
  }
  __name(start, "start");
  function beforeSequenceOpen(code3) {
    const tail = self.events[self.events.length - 1];
    initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
    marker = code3;
    effects.enter("codeFenced");
    effects.enter("codeFencedFence");
    effects.enter("codeFencedFenceSequence");
    return sequenceOpen(code3);
  }
  __name(beforeSequenceOpen, "beforeSequenceOpen");
  function sequenceOpen(code3) {
    if (code3 === marker) {
      sizeOpen++;
      effects.consume(code3);
      return sequenceOpen;
    }
    if (sizeOpen < 3) {
      return nok(code3);
    }
    effects.exit("codeFencedFenceSequence");
    return markdownSpace(code3) ? factorySpace(effects, infoBefore, "whitespace")(code3) : infoBefore(code3);
  }
  __name(sequenceOpen, "sequenceOpen");
  function infoBefore(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("codeFencedFence");
      return self.interrupt ? ok3(code3) : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code3);
    }
    effects.enter("codeFencedFenceInfo");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return info(code3);
  }
  __name(infoBefore, "infoBefore");
  function info(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return infoBefore(code3);
    }
    if (markdownSpace(code3)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return factorySpace(effects, metaBefore, "whitespace")(code3);
    }
    if (code3 === 96 && code3 === marker) {
      return nok(code3);
    }
    effects.consume(code3);
    return info;
  }
  __name(info, "info");
  function metaBefore(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      return infoBefore(code3);
    }
    effects.enter("codeFencedFenceMeta");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return meta(code3);
  }
  __name(metaBefore, "metaBefore");
  function meta(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceMeta");
      return infoBefore(code3);
    }
    if (code3 === 96 && code3 === marker) {
      return nok(code3);
    }
    effects.consume(code3);
    return meta;
  }
  __name(meta, "meta");
  function atNonLazyBreak(code3) {
    return effects.attempt(closeStart, after, contentBefore)(code3);
  }
  __name(atNonLazyBreak, "atNonLazyBreak");
  function contentBefore(code3) {
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return contentStart;
  }
  __name(contentBefore, "contentBefore");
  function contentStart(code3) {
    return initialPrefix > 0 && markdownSpace(code3) ? factorySpace(effects, beforeContentChunk, "linePrefix", initialPrefix + 1)(code3) : beforeContentChunk(code3);
  }
  __name(contentStart, "contentStart");
  function beforeContentChunk(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code3);
    }
    effects.enter("codeFlowValue");
    return contentChunk(code3);
  }
  __name(beforeContentChunk, "beforeContentChunk");
  function contentChunk(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("codeFlowValue");
      return beforeContentChunk(code3);
    }
    effects.consume(code3);
    return contentChunk;
  }
  __name(contentChunk, "contentChunk");
  function after(code3) {
    effects.exit("codeFenced");
    return ok3(code3);
  }
  __name(after, "after");
  function tokenizeCloseStart(effects2, ok4, nok2) {
    let size = 0;
    return startBefore;
    function startBefore(code3) {
      effects2.enter("lineEnding");
      effects2.consume(code3);
      effects2.exit("lineEnding");
      return start2;
    }
    __name(startBefore, "startBefore");
    function start2(code3) {
      effects2.enter("codeFencedFence");
      return markdownSpace(code3) ? factorySpace(effects2, beforeSequenceClose, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code3) : beforeSequenceClose(code3);
    }
    __name(start2, "start");
    function beforeSequenceClose(code3) {
      if (code3 === marker) {
        effects2.enter("codeFencedFenceSequence");
        return sequenceClose(code3);
      }
      return nok2(code3);
    }
    __name(beforeSequenceClose, "beforeSequenceClose");
    function sequenceClose(code3) {
      if (code3 === marker) {
        size++;
        effects2.consume(code3);
        return sequenceClose;
      }
      if (size >= sizeOpen) {
        effects2.exit("codeFencedFenceSequence");
        return markdownSpace(code3) ? factorySpace(effects2, sequenceCloseAfter, "whitespace")(code3) : sequenceCloseAfter(code3);
      }
      return nok2(code3);
    }
    __name(sequenceClose, "sequenceClose");
    function sequenceCloseAfter(code3) {
      if (code3 === null || markdownLineEnding(code3)) {
        effects2.exit("codeFencedFence");
        return ok4(code3);
      }
      return nok2(code3);
    }
    __name(sequenceCloseAfter, "sequenceCloseAfter");
  }
  __name(tokenizeCloseStart, "tokenizeCloseStart");
}
__name(tokenizeCodeFenced, "tokenizeCodeFenced");
function tokenizeNonLazyContinuation(effects, ok3, nok) {
  const self = this;
  return start;
  function start(code3) {
    if (code3 === null) {
      return nok(code3);
    }
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return lineStart;
  }
  __name(start, "start");
  function lineStart(code3) {
    return self.parser.lazy[self.now().line] ? nok(code3) : ok3(code3);
  }
  __name(lineStart, "lineStart");
}
__name(tokenizeNonLazyContinuation, "tokenizeNonLazyContinuation");

// node_modules/micromark-core-commonmark/lib/code-indented.js
init_esbuild_shims();
var codeIndented = {
  name: "codeIndented",
  tokenize: tokenizeCodeIndented
};
var furtherStart = {
  partial: true,
  tokenize: tokenizeFurtherStart
};
function tokenizeCodeIndented(effects, ok3, nok) {
  const self = this;
  return start;
  function start(code3) {
    effects.enter("codeIndented");
    return factorySpace(effects, afterPrefix, "linePrefix", 4 + 1)(code3);
  }
  __name(start, "start");
  function afterPrefix(code3) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4 ? atBreak(code3) : nok(code3);
  }
  __name(afterPrefix, "afterPrefix");
  function atBreak(code3) {
    if (code3 === null) {
      return after(code3);
    }
    if (markdownLineEnding(code3)) {
      return effects.attempt(furtherStart, atBreak, after)(code3);
    }
    effects.enter("codeFlowValue");
    return inside(code3);
  }
  __name(atBreak, "atBreak");
  function inside(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("codeFlowValue");
      return atBreak(code3);
    }
    effects.consume(code3);
    return inside;
  }
  __name(inside, "inside");
  function after(code3) {
    effects.exit("codeIndented");
    return ok3(code3);
  }
  __name(after, "after");
}
__name(tokenizeCodeIndented, "tokenizeCodeIndented");
function tokenizeFurtherStart(effects, ok3, nok) {
  const self = this;
  return furtherStart2;
  function furtherStart2(code3) {
    if (self.parser.lazy[self.now().line]) {
      return nok(code3);
    }
    if (markdownLineEnding(code3)) {
      effects.enter("lineEnding");
      effects.consume(code3);
      effects.exit("lineEnding");
      return furtherStart2;
    }
    return factorySpace(effects, afterPrefix, "linePrefix", 4 + 1)(code3);
  }
  __name(furtherStart2, "furtherStart");
  function afterPrefix(code3) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4 ? ok3(code3) : markdownLineEnding(code3) ? furtherStart2(code3) : nok(code3);
  }
  __name(afterPrefix, "afterPrefix");
}
__name(tokenizeFurtherStart, "tokenizeFurtherStart");

// node_modules/micromark-core-commonmark/lib/code-text.js
init_esbuild_shims();
var codeText = {
  name: "codeText",
  previous: previous2,
  resolve: resolveCodeText,
  tokenize: tokenizeCodeText
};
function resolveCodeText(events) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index2;
  let enter;
  if ((events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") && (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")) {
    index2 = headEnterIndex;
    while (++index2 < tailExitIndex) {
      if (events[index2][1].type === "codeTextData") {
        events[headEnterIndex][1].type = "codeTextPadding";
        events[tailExitIndex][1].type = "codeTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }
  index2 = headEnterIndex - 1;
  tailExitIndex++;
  while (++index2 <= tailExitIndex) {
    if (enter === void 0) {
      if (index2 !== tailExitIndex && events[index2][1].type !== "lineEnding") {
        enter = index2;
      }
    } else if (index2 === tailExitIndex || events[index2][1].type === "lineEnding") {
      events[enter][1].type = "codeTextData";
      if (index2 !== enter + 2) {
        events[enter][1].end = events[index2 - 1][1].end;
        events.splice(enter + 2, index2 - enter - 2);
        tailExitIndex -= index2 - enter - 2;
        index2 = enter + 2;
      }
      enter = void 0;
    }
  }
  return events;
}
__name(resolveCodeText, "resolveCodeText");
function previous2(code3) {
  return code3 !== 96 || this.events[this.events.length - 1][1].type === "characterEscape";
}
__name(previous2, "previous");
function tokenizeCodeText(effects, ok3, nok) {
  const self = this;
  let sizeOpen = 0;
  let size;
  let token;
  return start;
  function start(code3) {
    effects.enter("codeText");
    effects.enter("codeTextSequence");
    return sequenceOpen(code3);
  }
  __name(start, "start");
  function sequenceOpen(code3) {
    if (code3 === 96) {
      effects.consume(code3);
      sizeOpen++;
      return sequenceOpen;
    }
    effects.exit("codeTextSequence");
    return between(code3);
  }
  __name(sequenceOpen, "sequenceOpen");
  function between(code3) {
    if (code3 === null) {
      return nok(code3);
    }
    if (code3 === 32) {
      effects.enter("space");
      effects.consume(code3);
      effects.exit("space");
      return between;
    }
    if (code3 === 96) {
      token = effects.enter("codeTextSequence");
      size = 0;
      return sequenceClose(code3);
    }
    if (markdownLineEnding(code3)) {
      effects.enter("lineEnding");
      effects.consume(code3);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("codeTextData");
    return data(code3);
  }
  __name(between, "between");
  function data(code3) {
    if (code3 === null || code3 === 32 || code3 === 96 || markdownLineEnding(code3)) {
      effects.exit("codeTextData");
      return between(code3);
    }
    effects.consume(code3);
    return data;
  }
  __name(data, "data");
  function sequenceClose(code3) {
    if (code3 === 96) {
      effects.consume(code3);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      effects.exit("codeTextSequence");
      effects.exit("codeText");
      return ok3(code3);
    }
    token.type = "codeTextData";
    return data(code3);
  }
  __name(sequenceClose, "sequenceClose");
}
__name(tokenizeCodeText, "tokenizeCodeText");

// node_modules/micromark-core-commonmark/lib/content.js
init_esbuild_shims();

// node_modules/micromark-util-subtokenize/index.js
init_esbuild_shims();

// node_modules/micromark-util-subtokenize/lib/splice-buffer.js
init_esbuild_shims();
var SpliceBuffer = class {
  static {
    __name(this, "SpliceBuffer");
  }
  /**
   * @param {ReadonlyArray<T> | null | undefined} [initial]
   *   Initial items (optional).
   * @returns
   *   Splice buffer.
   */
  constructor(initial) {
    this.left = initial ? [...initial] : [];
    this.right = [];
  }
  /**
   * Array access;
   * does not move the cursor.
   *
   * @param {number} index
   *   Index.
   * @return {T}
   *   Item.
   */
  get(index2) {
    if (index2 < 0 || index2 >= this.left.length + this.right.length) {
      throw new RangeError("Cannot access index `" + index2 + "` in a splice buffer of size `" + (this.left.length + this.right.length) + "`");
    }
    if (index2 < this.left.length) return this.left[index2];
    return this.right[this.right.length - index2 + this.left.length - 1];
  }
  /**
   * The length of the splice buffer, one greater than the largest index in the
   * array.
   */
  get length() {
    return this.left.length + this.right.length;
  }
  /**
   * Remove and return `list[0]`;
   * moves the cursor to `0`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  shift() {
    this.setCursor(0);
    return this.right.pop();
  }
  /**
   * Slice the buffer to get an array;
   * does not move the cursor.
   *
   * @param {number} start
   *   Start.
   * @param {number | null | undefined} [end]
   *   End (optional).
   * @returns {Array<T>}
   *   Array of items.
   */
  slice(start, end) {
    const stop = end === null || end === void 0 ? Number.POSITIVE_INFINITY : end;
    if (stop < this.left.length) {
      return this.left.slice(start, stop);
    }
    if (start > this.left.length) {
      return this.right.slice(this.right.length - stop + this.left.length, this.right.length - start + this.left.length).reverse();
    }
    return this.left.slice(start).concat(this.right.slice(this.right.length - stop + this.left.length).reverse());
  }
  /**
   * Mimics the behavior of Array.prototype.splice() except for the change of
   * interface necessary to avoid segfaults when patching in very large arrays.
   *
   * This operation moves cursor is moved to `start` and results in the cursor
   * placed after any inserted items.
   *
   * @param {number} start
   *   Start;
   *   zero-based index at which to start changing the array;
   *   negative numbers count backwards from the end of the array and values
   *   that are out-of bounds are clamped to the appropriate end of the array.
   * @param {number | null | undefined} [deleteCount=0]
   *   Delete count (default: `0`);
   *   maximum number of elements to delete, starting from start.
   * @param {Array<T> | null | undefined} [items=[]]
   *   Items to include in place of the deleted items (default: `[]`).
   * @return {Array<T>}
   *   Any removed items.
   */
  splice(start, deleteCount, items) {
    const count = deleteCount || 0;
    this.setCursor(Math.trunc(start));
    const removed = this.right.splice(this.right.length - count, Number.POSITIVE_INFINITY);
    if (items) chunkedPush(this.left, items);
    return removed.reverse();
  }
  /**
   * Remove and return the highest-numbered item in the array, so
   * `list[list.length - 1]`;
   * Moves the cursor to `length`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  pop() {
    this.setCursor(Number.POSITIVE_INFINITY);
    return this.left.pop();
  }
  /**
   * Inserts a single item to the high-numbered side of the array;
   * moves the cursor to `length`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  push(item) {
    this.setCursor(Number.POSITIVE_INFINITY);
    this.left.push(item);
  }
  /**
   * Inserts many items to the high-numbered side of the array.
   * Moves the cursor to `length`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  pushMany(items) {
    this.setCursor(Number.POSITIVE_INFINITY);
    chunkedPush(this.left, items);
  }
  /**
   * Inserts a single item to the low-numbered side of the array;
   * Moves the cursor to `0`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  unshift(item) {
    this.setCursor(0);
    this.right.push(item);
  }
  /**
   * Inserts many items to the low-numbered side of the array;
   * moves the cursor to `0`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  unshiftMany(items) {
    this.setCursor(0);
    chunkedPush(this.right, items.reverse());
  }
  /**
   * Move the cursor to a specific position in the array. Requires
   * time proportional to the distance moved.
   *
   * If `n < 0`, the cursor will end up at the beginning.
   * If `n > length`, the cursor will end up at the end.
   *
   * @param {number} n
   *   Position.
   * @return {undefined}
   *   Nothing.
   */
  setCursor(n) {
    if (n === this.left.length || n > this.left.length && this.right.length === 0 || n < 0 && this.left.length === 0) return;
    if (n < this.left.length) {
      const removed = this.left.splice(n, Number.POSITIVE_INFINITY);
      chunkedPush(this.right, removed.reverse());
    } else {
      const removed = this.right.splice(this.left.length + this.right.length - n, Number.POSITIVE_INFINITY);
      chunkedPush(this.left, removed.reverse());
    }
  }
};
function chunkedPush(list3, right) {
  let chunkStart = 0;
  if (right.length < 1e4) {
    list3.push(...right);
  } else {
    while (chunkStart < right.length) {
      list3.push(...right.slice(chunkStart, chunkStart + 1e4));
      chunkStart += 1e4;
    }
  }
}
__name(chunkedPush, "chunkedPush");

// node_modules/micromark-util-subtokenize/index.js
function subtokenize(eventsArray) {
  const jumps = {};
  let index2 = -1;
  let event;
  let lineIndex;
  let otherIndex;
  let otherEvent;
  let parameters;
  let subevents;
  let more;
  const events = new SpliceBuffer(eventsArray);
  while (++index2 < events.length) {
    while (index2 in jumps) {
      index2 = jumps[index2];
    }
    event = events.get(index2);
    if (index2 && event[1].type === "chunkFlow" && events.get(index2 - 1)[1].type === "listItemPrefix") {
      subevents = event[1]._tokenizer.events;
      otherIndex = 0;
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "lineEndingBlank") {
        otherIndex += 2;
      }
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "content") {
        while (++otherIndex < subevents.length) {
          if (subevents[otherIndex][1].type === "content") {
            break;
          }
          if (subevents[otherIndex][1].type === "chunkText") {
            subevents[otherIndex][1]._isInFirstContentOfListItem = true;
            otherIndex++;
          }
        }
      }
    }
    if (event[0] === "enter") {
      if (event[1].contentType) {
        Object.assign(jumps, subcontent(events, index2));
        index2 = jumps[index2];
        more = true;
      }
    } else if (event[1]._container) {
      otherIndex = index2;
      lineIndex = void 0;
      while (otherIndex--) {
        otherEvent = events.get(otherIndex);
        if (otherEvent[1].type === "lineEnding" || otherEvent[1].type === "lineEndingBlank") {
          if (otherEvent[0] === "enter") {
            if (lineIndex) {
              events.get(lineIndex)[1].type = "lineEndingBlank";
            }
            otherEvent[1].type = "lineEnding";
            lineIndex = otherIndex;
          }
        } else if (otherEvent[1].type === "linePrefix" || otherEvent[1].type === "listItemIndent") {
        } else {
          break;
        }
      }
      if (lineIndex) {
        event[1].end = {
          ...events.get(lineIndex)[1].start
        };
        parameters = events.slice(lineIndex, index2);
        parameters.unshift(event);
        events.splice(lineIndex, index2 - lineIndex + 1, parameters);
      }
    }
  }
  splice(eventsArray, 0, Number.POSITIVE_INFINITY, events.slice(0));
  return !more;
}
__name(subtokenize, "subtokenize");
function subcontent(events, eventIndex) {
  const token = events.get(eventIndex)[1];
  const context = events.get(eventIndex)[2];
  let startPosition = eventIndex - 1;
  const startPositions = [];
  let tokenizer = token._tokenizer;
  if (!tokenizer) {
    tokenizer = context.parser[token.contentType](token.start);
    if (token._contentTypeTextTrailing) {
      tokenizer._contentTypeTextTrailing = true;
    }
  }
  const childEvents = tokenizer.events;
  const jumps = [];
  const gaps = {};
  let stream;
  let previous4;
  let index2 = -1;
  let current = token;
  let adjust = 0;
  let start = 0;
  const breaks = [start];
  while (current) {
    while (events.get(++startPosition)[1] !== current) {
    }
    startPositions.push(startPosition);
    if (!current._tokenizer) {
      stream = context.sliceStream(current);
      if (!current.next) {
        stream.push(null);
      }
      if (previous4) {
        tokenizer.defineSkip(current.start);
      }
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = true;
      }
      tokenizer.write(stream);
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = void 0;
      }
    }
    previous4 = current;
    current = current.next;
  }
  current = token;
  while (++index2 < childEvents.length) {
    if (
      // Find a void token that includes a break.
      childEvents[index2][0] === "exit" && childEvents[index2 - 1][0] === "enter" && childEvents[index2][1].type === childEvents[index2 - 1][1].type && childEvents[index2][1].start.line !== childEvents[index2][1].end.line
    ) {
      start = index2 + 1;
      breaks.push(start);
      current._tokenizer = void 0;
      current.previous = void 0;
      current = current.next;
    }
  }
  tokenizer.events = [];
  if (current) {
    current._tokenizer = void 0;
    current.previous = void 0;
  } else {
    breaks.pop();
  }
  index2 = breaks.length;
  while (index2--) {
    const slice = childEvents.slice(breaks[index2], breaks[index2 + 1]);
    const start2 = startPositions.pop();
    jumps.push([start2, start2 + slice.length - 1]);
    events.splice(start2, 2, slice);
  }
  jumps.reverse();
  index2 = -1;
  while (++index2 < jumps.length) {
    gaps[adjust + jumps[index2][0]] = adjust + jumps[index2][1];
    adjust += jumps[index2][1] - jumps[index2][0] - 1;
  }
  return gaps;
}
__name(subcontent, "subcontent");

// node_modules/micromark-core-commonmark/lib/content.js
var content = {
  resolve: resolveContent,
  tokenize: tokenizeContent
};
var continuationConstruct = {
  partial: true,
  tokenize: tokenizeContinuation
};
function resolveContent(events) {
  subtokenize(events);
  return events;
}
__name(resolveContent, "resolveContent");
function tokenizeContent(effects, ok3) {
  let previous4;
  return chunkStart;
  function chunkStart(code3) {
    effects.enter("content");
    previous4 = effects.enter("chunkContent", {
      contentType: "content"
    });
    return chunkInside(code3);
  }
  __name(chunkStart, "chunkStart");
  function chunkInside(code3) {
    if (code3 === null) {
      return contentEnd(code3);
    }
    if (markdownLineEnding(code3)) {
      return effects.check(continuationConstruct, contentContinue, contentEnd)(code3);
    }
    effects.consume(code3);
    return chunkInside;
  }
  __name(chunkInside, "chunkInside");
  function contentEnd(code3) {
    effects.exit("chunkContent");
    effects.exit("content");
    return ok3(code3);
  }
  __name(contentEnd, "contentEnd");
  function contentContinue(code3) {
    effects.consume(code3);
    effects.exit("chunkContent");
    previous4.next = effects.enter("chunkContent", {
      contentType: "content",
      previous: previous4
    });
    previous4 = previous4.next;
    return chunkInside;
  }
  __name(contentContinue, "contentContinue");
}
__name(tokenizeContent, "tokenizeContent");
function tokenizeContinuation(effects, ok3, nok) {
  const self = this;
  return startLookahead;
  function startLookahead(code3) {
    effects.exit("chunkContent");
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return factorySpace(effects, prefixed, "linePrefix");
  }
  __name(startLookahead, "startLookahead");
  function prefixed(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      return nok(code3);
    }
    const tail = self.events[self.events.length - 1];
    if (!self.parser.constructs.disable.null.includes("codeIndented") && tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4) {
      return ok3(code3);
    }
    return effects.interrupt(self.parser.constructs.flow, nok, ok3)(code3);
  }
  __name(prefixed, "prefixed");
}
__name(tokenizeContinuation, "tokenizeContinuation");

// node_modules/micromark-core-commonmark/lib/definition.js
init_esbuild_shims();

// node_modules/micromark-factory-destination/index.js
init_esbuild_shims();
function factoryDestination(effects, ok3, nok, type, literalType, literalMarkerType, rawType, stringType, max) {
  const limit = max || Number.POSITIVE_INFINITY;
  let balance = 0;
  return start;
  function start(code3) {
    if (code3 === 60) {
      effects.enter(type);
      effects.enter(literalType);
      effects.enter(literalMarkerType);
      effects.consume(code3);
      effects.exit(literalMarkerType);
      return enclosedBefore;
    }
    if (code3 === null || code3 === 32 || code3 === 41 || asciiControl(code3)) {
      return nok(code3);
    }
    effects.enter(type);
    effects.enter(rawType);
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return raw(code3);
  }
  __name(start, "start");
  function enclosedBefore(code3) {
    if (code3 === 62) {
      effects.enter(literalMarkerType);
      effects.consume(code3);
      effects.exit(literalMarkerType);
      effects.exit(literalType);
      effects.exit(type);
      return ok3;
    }
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return enclosed(code3);
  }
  __name(enclosedBefore, "enclosedBefore");
  function enclosed(code3) {
    if (code3 === 62) {
      effects.exit("chunkString");
      effects.exit(stringType);
      return enclosedBefore(code3);
    }
    if (code3 === null || code3 === 60 || markdownLineEnding(code3)) {
      return nok(code3);
    }
    effects.consume(code3);
    return code3 === 92 ? enclosedEscape : enclosed;
  }
  __name(enclosed, "enclosed");
  function enclosedEscape(code3) {
    if (code3 === 60 || code3 === 62 || code3 === 92) {
      effects.consume(code3);
      return enclosed;
    }
    return enclosed(code3);
  }
  __name(enclosedEscape, "enclosedEscape");
  function raw(code3) {
    if (!balance && (code3 === null || code3 === 41 || markdownLineEndingOrSpace(code3))) {
      effects.exit("chunkString");
      effects.exit(stringType);
      effects.exit(rawType);
      effects.exit(type);
      return ok3(code3);
    }
    if (balance < limit && code3 === 40) {
      effects.consume(code3);
      balance++;
      return raw;
    }
    if (code3 === 41) {
      effects.consume(code3);
      balance--;
      return raw;
    }
    if (code3 === null || code3 === 32 || code3 === 40 || asciiControl(code3)) {
      return nok(code3);
    }
    effects.consume(code3);
    return code3 === 92 ? rawEscape : raw;
  }
  __name(raw, "raw");
  function rawEscape(code3) {
    if (code3 === 40 || code3 === 41 || code3 === 92) {
      effects.consume(code3);
      return raw;
    }
    return raw(code3);
  }
  __name(rawEscape, "rawEscape");
}
__name(factoryDestination, "factoryDestination");

// node_modules/micromark-factory-label/index.js
init_esbuild_shims();
function factoryLabel(effects, ok3, nok, type, markerType, stringType) {
  const self = this;
  let size = 0;
  let seen;
  return start;
  function start(code3) {
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code3);
    effects.exit(markerType);
    effects.enter(stringType);
    return atBreak;
  }
  __name(start, "start");
  function atBreak(code3) {
    if (size > 999 || code3 === null || code3 === 91 || code3 === 93 && !seen || // To do: remove in the future once we’ve switched from
    // `micromark-extension-footnote` to `micromark-extension-gfm-footnote`,
    // which doesn’t need this.
    // Hidden footnotes hook.
    /* c8 ignore next 3 */
    code3 === 94 && !size && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code3);
    }
    if (code3 === 93) {
      effects.exit(stringType);
      effects.enter(markerType);
      effects.consume(code3);
      effects.exit(markerType);
      effects.exit(type);
      return ok3;
    }
    if (markdownLineEnding(code3)) {
      effects.enter("lineEnding");
      effects.consume(code3);
      effects.exit("lineEnding");
      return atBreak;
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return labelInside(code3);
  }
  __name(atBreak, "atBreak");
  function labelInside(code3) {
    if (code3 === null || code3 === 91 || code3 === 93 || markdownLineEnding(code3) || size++ > 999) {
      effects.exit("chunkString");
      return atBreak(code3);
    }
    effects.consume(code3);
    if (!seen) seen = !markdownSpace(code3);
    return code3 === 92 ? labelEscape : labelInside;
  }
  __name(labelInside, "labelInside");
  function labelEscape(code3) {
    if (code3 === 91 || code3 === 92 || code3 === 93) {
      effects.consume(code3);
      size++;
      return labelInside;
    }
    return labelInside(code3);
  }
  __name(labelEscape, "labelEscape");
}
__name(factoryLabel, "factoryLabel");

// node_modules/micromark-factory-title/index.js
init_esbuild_shims();
function factoryTitle(effects, ok3, nok, type, markerType, stringType) {
  let marker;
  return start;
  function start(code3) {
    if (code3 === 34 || code3 === 39 || code3 === 40) {
      effects.enter(type);
      effects.enter(markerType);
      effects.consume(code3);
      effects.exit(markerType);
      marker = code3 === 40 ? 41 : code3;
      return begin;
    }
    return nok(code3);
  }
  __name(start, "start");
  function begin(code3) {
    if (code3 === marker) {
      effects.enter(markerType);
      effects.consume(code3);
      effects.exit(markerType);
      effects.exit(type);
      return ok3;
    }
    effects.enter(stringType);
    return atBreak(code3);
  }
  __name(begin, "begin");
  function atBreak(code3) {
    if (code3 === marker) {
      effects.exit(stringType);
      return begin(marker);
    }
    if (code3 === null) {
      return nok(code3);
    }
    if (markdownLineEnding(code3)) {
      effects.enter("lineEnding");
      effects.consume(code3);
      effects.exit("lineEnding");
      return factorySpace(effects, atBreak, "linePrefix");
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return inside(code3);
  }
  __name(atBreak, "atBreak");
  function inside(code3) {
    if (code3 === marker || code3 === null || markdownLineEnding(code3)) {
      effects.exit("chunkString");
      return atBreak(code3);
    }
    effects.consume(code3);
    return code3 === 92 ? escape : inside;
  }
  __name(inside, "inside");
  function escape(code3) {
    if (code3 === marker || code3 === 92) {
      effects.consume(code3);
      return inside;
    }
    return inside(code3);
  }
  __name(escape, "escape");
}
__name(factoryTitle, "factoryTitle");

// node_modules/micromark-factory-whitespace/index.js
init_esbuild_shims();
function factoryWhitespace(effects, ok3) {
  let seen;
  return start;
  function start(code3) {
    if (markdownLineEnding(code3)) {
      effects.enter("lineEnding");
      effects.consume(code3);
      effects.exit("lineEnding");
      seen = true;
      return start;
    }
    if (markdownSpace(code3)) {
      return factorySpace(effects, start, seen ? "linePrefix" : "lineSuffix")(code3);
    }
    return ok3(code3);
  }
  __name(start, "start");
}
__name(factoryWhitespace, "factoryWhitespace");

// node_modules/micromark-core-commonmark/lib/definition.js
var definition2 = {
  name: "definition",
  tokenize: tokenizeDefinition
};
var titleBefore = {
  partial: true,
  tokenize: tokenizeTitleBefore
};
function tokenizeDefinition(effects, ok3, nok) {
  const self = this;
  let identifier;
  return start;
  function start(code3) {
    effects.enter("definition");
    return before(code3);
  }
  __name(start, "start");
  function before(code3) {
    return factoryLabel.call(
      self,
      effects,
      labelAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionLabel",
      "definitionLabelMarker",
      "definitionLabelString"
    )(code3);
  }
  __name(before, "before");
  function labelAfter(code3) {
    identifier = normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1));
    if (code3 === 58) {
      effects.enter("definitionMarker");
      effects.consume(code3);
      effects.exit("definitionMarker");
      return markerAfter;
    }
    return nok(code3);
  }
  __name(labelAfter, "labelAfter");
  function markerAfter(code3) {
    return markdownLineEndingOrSpace(code3) ? factoryWhitespace(effects, destinationBefore)(code3) : destinationBefore(code3);
  }
  __name(markerAfter, "markerAfter");
  function destinationBefore(code3) {
    return factoryDestination(
      effects,
      destinationAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionDestination",
      "definitionDestinationLiteral",
      "definitionDestinationLiteralMarker",
      "definitionDestinationRaw",
      "definitionDestinationString"
    )(code3);
  }
  __name(destinationBefore, "destinationBefore");
  function destinationAfter(code3) {
    return effects.attempt(titleBefore, after, after)(code3);
  }
  __name(destinationAfter, "destinationAfter");
  function after(code3) {
    return markdownSpace(code3) ? factorySpace(effects, afterWhitespace, "whitespace")(code3) : afterWhitespace(code3);
  }
  __name(after, "after");
  function afterWhitespace(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("definition");
      self.parser.defined.push(identifier);
      return ok3(code3);
    }
    return nok(code3);
  }
  __name(afterWhitespace, "afterWhitespace");
}
__name(tokenizeDefinition, "tokenizeDefinition");
function tokenizeTitleBefore(effects, ok3, nok) {
  return titleBefore2;
  function titleBefore2(code3) {
    return markdownLineEndingOrSpace(code3) ? factoryWhitespace(effects, beforeMarker)(code3) : nok(code3);
  }
  __name(titleBefore2, "titleBefore");
  function beforeMarker(code3) {
    return factoryTitle(effects, titleAfter, nok, "definitionTitle", "definitionTitleMarker", "definitionTitleString")(code3);
  }
  __name(beforeMarker, "beforeMarker");
  function titleAfter(code3) {
    return markdownSpace(code3) ? factorySpace(effects, titleAfterOptionalWhitespace, "whitespace")(code3) : titleAfterOptionalWhitespace(code3);
  }
  __name(titleAfter, "titleAfter");
  function titleAfterOptionalWhitespace(code3) {
    return code3 === null || markdownLineEnding(code3) ? ok3(code3) : nok(code3);
  }
  __name(titleAfterOptionalWhitespace, "titleAfterOptionalWhitespace");
}
__name(tokenizeTitleBefore, "tokenizeTitleBefore");

// node_modules/micromark-core-commonmark/lib/hard-break-escape.js
init_esbuild_shims();
var hardBreakEscape = {
  name: "hardBreakEscape",
  tokenize: tokenizeHardBreakEscape
};
function tokenizeHardBreakEscape(effects, ok3, nok) {
  return start;
  function start(code3) {
    effects.enter("hardBreakEscape");
    effects.consume(code3);
    return after;
  }
  __name(start, "start");
  function after(code3) {
    if (markdownLineEnding(code3)) {
      effects.exit("hardBreakEscape");
      return ok3(code3);
    }
    return nok(code3);
  }
  __name(after, "after");
}
__name(tokenizeHardBreakEscape, "tokenizeHardBreakEscape");

// node_modules/micromark-core-commonmark/lib/heading-atx.js
init_esbuild_shims();
var headingAtx = {
  name: "headingAtx",
  resolve: resolveHeadingAtx,
  tokenize: tokenizeHeadingAtx
};
function resolveHeadingAtx(events, context) {
  let contentEnd = events.length - 2;
  let contentStart = 3;
  let content3;
  let text5;
  if (events[contentStart][1].type === "whitespace") {
    contentStart += 2;
  }
  if (contentEnd - 2 > contentStart && events[contentEnd][1].type === "whitespace") {
    contentEnd -= 2;
  }
  if (events[contentEnd][1].type === "atxHeadingSequence" && (contentStart === contentEnd - 1 || contentEnd - 4 > contentStart && events[contentEnd - 2][1].type === "whitespace")) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4;
  }
  if (contentEnd > contentStart) {
    content3 = {
      type: "atxHeadingText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end
    };
    text5 = {
      type: "chunkText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: "text"
    };
    splice(events, contentStart, contentEnd - contentStart + 1, [["enter", content3, context], ["enter", text5, context], ["exit", text5, context], ["exit", content3, context]]);
  }
  return events;
}
__name(resolveHeadingAtx, "resolveHeadingAtx");
function tokenizeHeadingAtx(effects, ok3, nok) {
  let size = 0;
  return start;
  function start(code3) {
    effects.enter("atxHeading");
    return before(code3);
  }
  __name(start, "start");
  function before(code3) {
    effects.enter("atxHeadingSequence");
    return sequenceOpen(code3);
  }
  __name(before, "before");
  function sequenceOpen(code3) {
    if (code3 === 35 && size++ < 6) {
      effects.consume(code3);
      return sequenceOpen;
    }
    if (code3 === null || markdownLineEndingOrSpace(code3)) {
      effects.exit("atxHeadingSequence");
      return atBreak(code3);
    }
    return nok(code3);
  }
  __name(sequenceOpen, "sequenceOpen");
  function atBreak(code3) {
    if (code3 === 35) {
      effects.enter("atxHeadingSequence");
      return sequenceFurther(code3);
    }
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("atxHeading");
      return ok3(code3);
    }
    if (markdownSpace(code3)) {
      return factorySpace(effects, atBreak, "whitespace")(code3);
    }
    effects.enter("atxHeadingText");
    return data(code3);
  }
  __name(atBreak, "atBreak");
  function sequenceFurther(code3) {
    if (code3 === 35) {
      effects.consume(code3);
      return sequenceFurther;
    }
    effects.exit("atxHeadingSequence");
    return atBreak(code3);
  }
  __name(sequenceFurther, "sequenceFurther");
  function data(code3) {
    if (code3 === null || code3 === 35 || markdownLineEndingOrSpace(code3)) {
      effects.exit("atxHeadingText");
      return atBreak(code3);
    }
    effects.consume(code3);
    return data;
  }
  __name(data, "data");
}
__name(tokenizeHeadingAtx, "tokenizeHeadingAtx");

// node_modules/micromark-core-commonmark/lib/html-flow.js
init_esbuild_shims();

// node_modules/micromark-util-html-tag-name/index.js
init_esbuild_shims();
var htmlBlockNames = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
];
var htmlRawNames = ["pre", "script", "style", "textarea"];

// node_modules/micromark-core-commonmark/lib/html-flow.js
var htmlFlow = {
  concrete: true,
  name: "htmlFlow",
  resolveTo: resolveToHtmlFlow,
  tokenize: tokenizeHtmlFlow
};
var blankLineBefore = {
  partial: true,
  tokenize: tokenizeBlankLineBefore
};
var nonLazyContinuationStart = {
  partial: true,
  tokenize: tokenizeNonLazyContinuationStart
};
function resolveToHtmlFlow(events) {
  let index2 = events.length;
  while (index2--) {
    if (events[index2][0] === "enter" && events[index2][1].type === "htmlFlow") {
      break;
    }
  }
  if (index2 > 1 && events[index2 - 2][1].type === "linePrefix") {
    events[index2][1].start = events[index2 - 2][1].start;
    events[index2 + 1][1].start = events[index2 - 2][1].start;
    events.splice(index2 - 2, 2);
  }
  return events;
}
__name(resolveToHtmlFlow, "resolveToHtmlFlow");
function tokenizeHtmlFlow(effects, ok3, nok) {
  const self = this;
  let marker;
  let closingTag;
  let buffer;
  let index2;
  let markerB;
  return start;
  function start(code3) {
    return before(code3);
  }
  __name(start, "start");
  function before(code3) {
    effects.enter("htmlFlow");
    effects.enter("htmlFlowData");
    effects.consume(code3);
    return open;
  }
  __name(before, "before");
  function open(code3) {
    if (code3 === 33) {
      effects.consume(code3);
      return declarationOpen;
    }
    if (code3 === 47) {
      effects.consume(code3);
      closingTag = true;
      return tagCloseStart;
    }
    if (code3 === 63) {
      effects.consume(code3);
      marker = 3;
      return self.interrupt ? ok3 : continuationDeclarationInside;
    }
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      buffer = String.fromCharCode(code3);
      return tagName;
    }
    return nok(code3);
  }
  __name(open, "open");
  function declarationOpen(code3) {
    if (code3 === 45) {
      effects.consume(code3);
      marker = 2;
      return commentOpenInside;
    }
    if (code3 === 91) {
      effects.consume(code3);
      marker = 5;
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      marker = 4;
      return self.interrupt ? ok3 : continuationDeclarationInside;
    }
    return nok(code3);
  }
  __name(declarationOpen, "declarationOpen");
  function commentOpenInside(code3) {
    if (code3 === 45) {
      effects.consume(code3);
      return self.interrupt ? ok3 : continuationDeclarationInside;
    }
    return nok(code3);
  }
  __name(commentOpenInside, "commentOpenInside");
  function cdataOpenInside(code3) {
    const value = "CDATA[";
    if (code3 === value.charCodeAt(index2++)) {
      effects.consume(code3);
      if (index2 === value.length) {
        return self.interrupt ? ok3 : continuation;
      }
      return cdataOpenInside;
    }
    return nok(code3);
  }
  __name(cdataOpenInside, "cdataOpenInside");
  function tagCloseStart(code3) {
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      buffer = String.fromCharCode(code3);
      return tagName;
    }
    return nok(code3);
  }
  __name(tagCloseStart, "tagCloseStart");
  function tagName(code3) {
    if (code3 === null || code3 === 47 || code3 === 62 || markdownLineEndingOrSpace(code3)) {
      const slash = code3 === 47;
      const name = buffer.toLowerCase();
      if (!slash && !closingTag && htmlRawNames.includes(name)) {
        marker = 1;
        return self.interrupt ? ok3(code3) : continuation(code3);
      }
      if (htmlBlockNames.includes(buffer.toLowerCase())) {
        marker = 6;
        if (slash) {
          effects.consume(code3);
          return basicSelfClosing;
        }
        return self.interrupt ? ok3(code3) : continuation(code3);
      }
      marker = 7;
      return self.interrupt && !self.parser.lazy[self.now().line] ? nok(code3) : closingTag ? completeClosingTagAfter(code3) : completeAttributeNameBefore(code3);
    }
    if (code3 === 45 || asciiAlphanumeric(code3)) {
      effects.consume(code3);
      buffer += String.fromCharCode(code3);
      return tagName;
    }
    return nok(code3);
  }
  __name(tagName, "tagName");
  function basicSelfClosing(code3) {
    if (code3 === 62) {
      effects.consume(code3);
      return self.interrupt ? ok3 : continuation;
    }
    return nok(code3);
  }
  __name(basicSelfClosing, "basicSelfClosing");
  function completeClosingTagAfter(code3) {
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return completeClosingTagAfter;
    }
    return completeEnd(code3);
  }
  __name(completeClosingTagAfter, "completeClosingTagAfter");
  function completeAttributeNameBefore(code3) {
    if (code3 === 47) {
      effects.consume(code3);
      return completeEnd;
    }
    if (code3 === 58 || code3 === 95 || asciiAlpha(code3)) {
      effects.consume(code3);
      return completeAttributeName;
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return completeAttributeNameBefore;
    }
    return completeEnd(code3);
  }
  __name(completeAttributeNameBefore, "completeAttributeNameBefore");
  function completeAttributeName(code3) {
    if (code3 === 45 || code3 === 46 || code3 === 58 || code3 === 95 || asciiAlphanumeric(code3)) {
      effects.consume(code3);
      return completeAttributeName;
    }
    return completeAttributeNameAfter(code3);
  }
  __name(completeAttributeName, "completeAttributeName");
  function completeAttributeNameAfter(code3) {
    if (code3 === 61) {
      effects.consume(code3);
      return completeAttributeValueBefore;
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return completeAttributeNameAfter;
    }
    return completeAttributeNameBefore(code3);
  }
  __name(completeAttributeNameAfter, "completeAttributeNameAfter");
  function completeAttributeValueBefore(code3) {
    if (code3 === null || code3 === 60 || code3 === 61 || code3 === 62 || code3 === 96) {
      return nok(code3);
    }
    if (code3 === 34 || code3 === 39) {
      effects.consume(code3);
      markerB = code3;
      return completeAttributeValueQuoted;
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return completeAttributeValueBefore;
    }
    return completeAttributeValueUnquoted(code3);
  }
  __name(completeAttributeValueBefore, "completeAttributeValueBefore");
  function completeAttributeValueQuoted(code3) {
    if (code3 === markerB) {
      effects.consume(code3);
      markerB = null;
      return completeAttributeValueQuotedAfter;
    }
    if (code3 === null || markdownLineEnding(code3)) {
      return nok(code3);
    }
    effects.consume(code3);
    return completeAttributeValueQuoted;
  }
  __name(completeAttributeValueQuoted, "completeAttributeValueQuoted");
  function completeAttributeValueUnquoted(code3) {
    if (code3 === null || code3 === 34 || code3 === 39 || code3 === 47 || code3 === 60 || code3 === 61 || code3 === 62 || code3 === 96 || markdownLineEndingOrSpace(code3)) {
      return completeAttributeNameAfter(code3);
    }
    effects.consume(code3);
    return completeAttributeValueUnquoted;
  }
  __name(completeAttributeValueUnquoted, "completeAttributeValueUnquoted");
  function completeAttributeValueQuotedAfter(code3) {
    if (code3 === 47 || code3 === 62 || markdownSpace(code3)) {
      return completeAttributeNameBefore(code3);
    }
    return nok(code3);
  }
  __name(completeAttributeValueQuotedAfter, "completeAttributeValueQuotedAfter");
  function completeEnd(code3) {
    if (code3 === 62) {
      effects.consume(code3);
      return completeAfter;
    }
    return nok(code3);
  }
  __name(completeEnd, "completeEnd");
  function completeAfter(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      return continuation(code3);
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return completeAfter;
    }
    return nok(code3);
  }
  __name(completeAfter, "completeAfter");
  function continuation(code3) {
    if (code3 === 45 && marker === 2) {
      effects.consume(code3);
      return continuationCommentInside;
    }
    if (code3 === 60 && marker === 1) {
      effects.consume(code3);
      return continuationRawTagOpen;
    }
    if (code3 === 62 && marker === 4) {
      effects.consume(code3);
      return continuationClose;
    }
    if (code3 === 63 && marker === 3) {
      effects.consume(code3);
      return continuationDeclarationInside;
    }
    if (code3 === 93 && marker === 5) {
      effects.consume(code3);
      return continuationCdataInside;
    }
    if (markdownLineEnding(code3) && (marker === 6 || marker === 7)) {
      effects.exit("htmlFlowData");
      return effects.check(blankLineBefore, continuationAfter, continuationStart)(code3);
    }
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("htmlFlowData");
      return continuationStart(code3);
    }
    effects.consume(code3);
    return continuation;
  }
  __name(continuation, "continuation");
  function continuationStart(code3) {
    return effects.check(nonLazyContinuationStart, continuationStartNonLazy, continuationAfter)(code3);
  }
  __name(continuationStart, "continuationStart");
  function continuationStartNonLazy(code3) {
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return continuationBefore;
  }
  __name(continuationStartNonLazy, "continuationStartNonLazy");
  function continuationBefore(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      return continuationStart(code3);
    }
    effects.enter("htmlFlowData");
    return continuation(code3);
  }
  __name(continuationBefore, "continuationBefore");
  function continuationCommentInside(code3) {
    if (code3 === 45) {
      effects.consume(code3);
      return continuationDeclarationInside;
    }
    return continuation(code3);
  }
  __name(continuationCommentInside, "continuationCommentInside");
  function continuationRawTagOpen(code3) {
    if (code3 === 47) {
      effects.consume(code3);
      buffer = "";
      return continuationRawEndTag;
    }
    return continuation(code3);
  }
  __name(continuationRawTagOpen, "continuationRawTagOpen");
  function continuationRawEndTag(code3) {
    if (code3 === 62) {
      const name = buffer.toLowerCase();
      if (htmlRawNames.includes(name)) {
        effects.consume(code3);
        return continuationClose;
      }
      return continuation(code3);
    }
    if (asciiAlpha(code3) && buffer.length < 8) {
      effects.consume(code3);
      buffer += String.fromCharCode(code3);
      return continuationRawEndTag;
    }
    return continuation(code3);
  }
  __name(continuationRawEndTag, "continuationRawEndTag");
  function continuationCdataInside(code3) {
    if (code3 === 93) {
      effects.consume(code3);
      return continuationDeclarationInside;
    }
    return continuation(code3);
  }
  __name(continuationCdataInside, "continuationCdataInside");
  function continuationDeclarationInside(code3) {
    if (code3 === 62) {
      effects.consume(code3);
      return continuationClose;
    }
    if (code3 === 45 && marker === 2) {
      effects.consume(code3);
      return continuationDeclarationInside;
    }
    return continuation(code3);
  }
  __name(continuationDeclarationInside, "continuationDeclarationInside");
  function continuationClose(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("htmlFlowData");
      return continuationAfter(code3);
    }
    effects.consume(code3);
    return continuationClose;
  }
  __name(continuationClose, "continuationClose");
  function continuationAfter(code3) {
    effects.exit("htmlFlow");
    return ok3(code3);
  }
  __name(continuationAfter, "continuationAfter");
}
__name(tokenizeHtmlFlow, "tokenizeHtmlFlow");
function tokenizeNonLazyContinuationStart(effects, ok3, nok) {
  const self = this;
  return start;
  function start(code3) {
    if (markdownLineEnding(code3)) {
      effects.enter("lineEnding");
      effects.consume(code3);
      effects.exit("lineEnding");
      return after;
    }
    return nok(code3);
  }
  __name(start, "start");
  function after(code3) {
    return self.parser.lazy[self.now().line] ? nok(code3) : ok3(code3);
  }
  __name(after, "after");
}
__name(tokenizeNonLazyContinuationStart, "tokenizeNonLazyContinuationStart");
function tokenizeBlankLineBefore(effects, ok3, nok) {
  return start;
  function start(code3) {
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return effects.attempt(blankLine, ok3, nok);
  }
  __name(start, "start");
}
__name(tokenizeBlankLineBefore, "tokenizeBlankLineBefore");

// node_modules/micromark-core-commonmark/lib/html-text.js
init_esbuild_shims();
var htmlText = {
  name: "htmlText",
  tokenize: tokenizeHtmlText
};
function tokenizeHtmlText(effects, ok3, nok) {
  const self = this;
  let marker;
  let index2;
  let returnState;
  return start;
  function start(code3) {
    effects.enter("htmlText");
    effects.enter("htmlTextData");
    effects.consume(code3);
    return open;
  }
  __name(start, "start");
  function open(code3) {
    if (code3 === 33) {
      effects.consume(code3);
      return declarationOpen;
    }
    if (code3 === 47) {
      effects.consume(code3);
      return tagCloseStart;
    }
    if (code3 === 63) {
      effects.consume(code3);
      return instruction;
    }
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      return tagOpen;
    }
    return nok(code3);
  }
  __name(open, "open");
  function declarationOpen(code3) {
    if (code3 === 45) {
      effects.consume(code3);
      return commentOpenInside;
    }
    if (code3 === 91) {
      effects.consume(code3);
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      return declaration;
    }
    return nok(code3);
  }
  __name(declarationOpen, "declarationOpen");
  function commentOpenInside(code3) {
    if (code3 === 45) {
      effects.consume(code3);
      return commentEnd;
    }
    return nok(code3);
  }
  __name(commentOpenInside, "commentOpenInside");
  function comment(code3) {
    if (code3 === null) {
      return nok(code3);
    }
    if (code3 === 45) {
      effects.consume(code3);
      return commentClose;
    }
    if (markdownLineEnding(code3)) {
      returnState = comment;
      return lineEndingBefore(code3);
    }
    effects.consume(code3);
    return comment;
  }
  __name(comment, "comment");
  function commentClose(code3) {
    if (code3 === 45) {
      effects.consume(code3);
      return commentEnd;
    }
    return comment(code3);
  }
  __name(commentClose, "commentClose");
  function commentEnd(code3) {
    return code3 === 62 ? end(code3) : code3 === 45 ? commentClose(code3) : comment(code3);
  }
  __name(commentEnd, "commentEnd");
  function cdataOpenInside(code3) {
    const value = "CDATA[";
    if (code3 === value.charCodeAt(index2++)) {
      effects.consume(code3);
      return index2 === value.length ? cdata : cdataOpenInside;
    }
    return nok(code3);
  }
  __name(cdataOpenInside, "cdataOpenInside");
  function cdata(code3) {
    if (code3 === null) {
      return nok(code3);
    }
    if (code3 === 93) {
      effects.consume(code3);
      return cdataClose;
    }
    if (markdownLineEnding(code3)) {
      returnState = cdata;
      return lineEndingBefore(code3);
    }
    effects.consume(code3);
    return cdata;
  }
  __name(cdata, "cdata");
  function cdataClose(code3) {
    if (code3 === 93) {
      effects.consume(code3);
      return cdataEnd;
    }
    return cdata(code3);
  }
  __name(cdataClose, "cdataClose");
  function cdataEnd(code3) {
    if (code3 === 62) {
      return end(code3);
    }
    if (code3 === 93) {
      effects.consume(code3);
      return cdataEnd;
    }
    return cdata(code3);
  }
  __name(cdataEnd, "cdataEnd");
  function declaration(code3) {
    if (code3 === null || code3 === 62) {
      return end(code3);
    }
    if (markdownLineEnding(code3)) {
      returnState = declaration;
      return lineEndingBefore(code3);
    }
    effects.consume(code3);
    return declaration;
  }
  __name(declaration, "declaration");
  function instruction(code3) {
    if (code3 === null) {
      return nok(code3);
    }
    if (code3 === 63) {
      effects.consume(code3);
      return instructionClose;
    }
    if (markdownLineEnding(code3)) {
      returnState = instruction;
      return lineEndingBefore(code3);
    }
    effects.consume(code3);
    return instruction;
  }
  __name(instruction, "instruction");
  function instructionClose(code3) {
    return code3 === 62 ? end(code3) : instruction(code3);
  }
  __name(instructionClose, "instructionClose");
  function tagCloseStart(code3) {
    if (asciiAlpha(code3)) {
      effects.consume(code3);
      return tagClose;
    }
    return nok(code3);
  }
  __name(tagCloseStart, "tagCloseStart");
  function tagClose(code3) {
    if (code3 === 45 || asciiAlphanumeric(code3)) {
      effects.consume(code3);
      return tagClose;
    }
    return tagCloseBetween(code3);
  }
  __name(tagClose, "tagClose");
  function tagCloseBetween(code3) {
    if (markdownLineEnding(code3)) {
      returnState = tagCloseBetween;
      return lineEndingBefore(code3);
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return tagCloseBetween;
    }
    return end(code3);
  }
  __name(tagCloseBetween, "tagCloseBetween");
  function tagOpen(code3) {
    if (code3 === 45 || asciiAlphanumeric(code3)) {
      effects.consume(code3);
      return tagOpen;
    }
    if (code3 === 47 || code3 === 62 || markdownLineEndingOrSpace(code3)) {
      return tagOpenBetween(code3);
    }
    return nok(code3);
  }
  __name(tagOpen, "tagOpen");
  function tagOpenBetween(code3) {
    if (code3 === 47) {
      effects.consume(code3);
      return end;
    }
    if (code3 === 58 || code3 === 95 || asciiAlpha(code3)) {
      effects.consume(code3);
      return tagOpenAttributeName;
    }
    if (markdownLineEnding(code3)) {
      returnState = tagOpenBetween;
      return lineEndingBefore(code3);
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return tagOpenBetween;
    }
    return end(code3);
  }
  __name(tagOpenBetween, "tagOpenBetween");
  function tagOpenAttributeName(code3) {
    if (code3 === 45 || code3 === 46 || code3 === 58 || code3 === 95 || asciiAlphanumeric(code3)) {
      effects.consume(code3);
      return tagOpenAttributeName;
    }
    return tagOpenAttributeNameAfter(code3);
  }
  __name(tagOpenAttributeName, "tagOpenAttributeName");
  function tagOpenAttributeNameAfter(code3) {
    if (code3 === 61) {
      effects.consume(code3);
      return tagOpenAttributeValueBefore;
    }
    if (markdownLineEnding(code3)) {
      returnState = tagOpenAttributeNameAfter;
      return lineEndingBefore(code3);
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return tagOpenAttributeNameAfter;
    }
    return tagOpenBetween(code3);
  }
  __name(tagOpenAttributeNameAfter, "tagOpenAttributeNameAfter");
  function tagOpenAttributeValueBefore(code3) {
    if (code3 === null || code3 === 60 || code3 === 61 || code3 === 62 || code3 === 96) {
      return nok(code3);
    }
    if (code3 === 34 || code3 === 39) {
      effects.consume(code3);
      marker = code3;
      return tagOpenAttributeValueQuoted;
    }
    if (markdownLineEnding(code3)) {
      returnState = tagOpenAttributeValueBefore;
      return lineEndingBefore(code3);
    }
    if (markdownSpace(code3)) {
      effects.consume(code3);
      return tagOpenAttributeValueBefore;
    }
    effects.consume(code3);
    return tagOpenAttributeValueUnquoted;
  }
  __name(tagOpenAttributeValueBefore, "tagOpenAttributeValueBefore");
  function tagOpenAttributeValueQuoted(code3) {
    if (code3 === marker) {
      effects.consume(code3);
      marker = void 0;
      return tagOpenAttributeValueQuotedAfter;
    }
    if (code3 === null) {
      return nok(code3);
    }
    if (markdownLineEnding(code3)) {
      returnState = tagOpenAttributeValueQuoted;
      return lineEndingBefore(code3);
    }
    effects.consume(code3);
    return tagOpenAttributeValueQuoted;
  }
  __name(tagOpenAttributeValueQuoted, "tagOpenAttributeValueQuoted");
  function tagOpenAttributeValueUnquoted(code3) {
    if (code3 === null || code3 === 34 || code3 === 39 || code3 === 60 || code3 === 61 || code3 === 96) {
      return nok(code3);
    }
    if (code3 === 47 || code3 === 62 || markdownLineEndingOrSpace(code3)) {
      return tagOpenBetween(code3);
    }
    effects.consume(code3);
    return tagOpenAttributeValueUnquoted;
  }
  __name(tagOpenAttributeValueUnquoted, "tagOpenAttributeValueUnquoted");
  function tagOpenAttributeValueQuotedAfter(code3) {
    if (code3 === 47 || code3 === 62 || markdownLineEndingOrSpace(code3)) {
      return tagOpenBetween(code3);
    }
    return nok(code3);
  }
  __name(tagOpenAttributeValueQuotedAfter, "tagOpenAttributeValueQuotedAfter");
  function end(code3) {
    if (code3 === 62) {
      effects.consume(code3);
      effects.exit("htmlTextData");
      effects.exit("htmlText");
      return ok3;
    }
    return nok(code3);
  }
  __name(end, "end");
  function lineEndingBefore(code3) {
    effects.exit("htmlTextData");
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return lineEndingAfter;
  }
  __name(lineEndingBefore, "lineEndingBefore");
  function lineEndingAfter(code3) {
    return markdownSpace(code3) ? factorySpace(effects, lineEndingAfterPrefix, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code3) : lineEndingAfterPrefix(code3);
  }
  __name(lineEndingAfter, "lineEndingAfter");
  function lineEndingAfterPrefix(code3) {
    effects.enter("htmlTextData");
    return returnState(code3);
  }
  __name(lineEndingAfterPrefix, "lineEndingAfterPrefix");
}
__name(tokenizeHtmlText, "tokenizeHtmlText");

// node_modules/micromark-core-commonmark/lib/label-end.js
init_esbuild_shims();
var labelEnd = {
  name: "labelEnd",
  resolveAll: resolveAllLabelEnd,
  resolveTo: resolveToLabelEnd,
  tokenize: tokenizeLabelEnd
};
var resourceConstruct = {
  tokenize: tokenizeResource
};
var referenceFullConstruct = {
  tokenize: tokenizeReferenceFull
};
var referenceCollapsedConstruct = {
  tokenize: tokenizeReferenceCollapsed
};
function resolveAllLabelEnd(events) {
  let index2 = -1;
  const newEvents = [];
  while (++index2 < events.length) {
    const token = events[index2][1];
    newEvents.push(events[index2]);
    if (token.type === "labelImage" || token.type === "labelLink" || token.type === "labelEnd") {
      const offset = token.type === "labelImage" ? 4 : 2;
      token.type = "data";
      index2 += offset;
    }
  }
  if (events.length !== newEvents.length) {
    splice(events, 0, events.length, newEvents);
  }
  return events;
}
__name(resolveAllLabelEnd, "resolveAllLabelEnd");
function resolveToLabelEnd(events, context) {
  let index2 = events.length;
  let offset = 0;
  let token;
  let open;
  let close;
  let media;
  while (index2--) {
    token = events[index2][1];
    if (open) {
      if (token.type === "link" || token.type === "labelLink" && token._inactive) {
        break;
      }
      if (events[index2][0] === "enter" && token.type === "labelLink") {
        token._inactive = true;
      }
    } else if (close) {
      if (events[index2][0] === "enter" && (token.type === "labelImage" || token.type === "labelLink") && !token._balanced) {
        open = index2;
        if (token.type !== "labelLink") {
          offset = 2;
          break;
        }
      }
    } else if (token.type === "labelEnd") {
      close = index2;
    }
  }
  const group = {
    type: events[open][1].type === "labelLink" ? "link" : "image",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  const label = {
    type: "label",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[close][1].end
    }
  };
  const text5 = {
    type: "labelText",
    start: {
      ...events[open + offset + 2][1].end
    },
    end: {
      ...events[close - 2][1].start
    }
  };
  media = [["enter", group, context], ["enter", label, context]];
  media = push(media, events.slice(open + 1, open + offset + 3));
  media = push(media, [["enter", text5, context]]);
  media = push(media, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + offset + 4, close - 3), context));
  media = push(media, [["exit", text5, context], events[close - 2], events[close - 1], ["exit", label, context]]);
  media = push(media, events.slice(close + 1));
  media = push(media, [["exit", group, context]]);
  splice(events, open, events.length, media);
  return events;
}
__name(resolveToLabelEnd, "resolveToLabelEnd");
function tokenizeLabelEnd(effects, ok3, nok) {
  const self = this;
  let index2 = self.events.length;
  let labelStart;
  let defined;
  while (index2--) {
    if ((self.events[index2][1].type === "labelImage" || self.events[index2][1].type === "labelLink") && !self.events[index2][1]._balanced) {
      labelStart = self.events[index2][1];
      break;
    }
  }
  return start;
  function start(code3) {
    if (!labelStart) {
      return nok(code3);
    }
    if (labelStart._inactive) {
      return labelEndNok(code3);
    }
    defined = self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize({
      start: labelStart.end,
      end: self.now()
    })));
    effects.enter("labelEnd");
    effects.enter("labelMarker");
    effects.consume(code3);
    effects.exit("labelMarker");
    effects.exit("labelEnd");
    return after;
  }
  __name(start, "start");
  function after(code3) {
    if (code3 === 40) {
      return effects.attempt(resourceConstruct, labelEndOk, defined ? labelEndOk : labelEndNok)(code3);
    }
    if (code3 === 91) {
      return effects.attempt(referenceFullConstruct, labelEndOk, defined ? referenceNotFull : labelEndNok)(code3);
    }
    return defined ? labelEndOk(code3) : labelEndNok(code3);
  }
  __name(after, "after");
  function referenceNotFull(code3) {
    return effects.attempt(referenceCollapsedConstruct, labelEndOk, labelEndNok)(code3);
  }
  __name(referenceNotFull, "referenceNotFull");
  function labelEndOk(code3) {
    return ok3(code3);
  }
  __name(labelEndOk, "labelEndOk");
  function labelEndNok(code3) {
    labelStart._balanced = true;
    return nok(code3);
  }
  __name(labelEndNok, "labelEndNok");
}
__name(tokenizeLabelEnd, "tokenizeLabelEnd");
function tokenizeResource(effects, ok3, nok) {
  return resourceStart;
  function resourceStart(code3) {
    effects.enter("resource");
    effects.enter("resourceMarker");
    effects.consume(code3);
    effects.exit("resourceMarker");
    return resourceBefore;
  }
  __name(resourceStart, "resourceStart");
  function resourceBefore(code3) {
    return markdownLineEndingOrSpace(code3) ? factoryWhitespace(effects, resourceOpen)(code3) : resourceOpen(code3);
  }
  __name(resourceBefore, "resourceBefore");
  function resourceOpen(code3) {
    if (code3 === 41) {
      return resourceEnd(code3);
    }
    return factoryDestination(effects, resourceDestinationAfter, resourceDestinationMissing, "resourceDestination", "resourceDestinationLiteral", "resourceDestinationLiteralMarker", "resourceDestinationRaw", "resourceDestinationString", 32)(code3);
  }
  __name(resourceOpen, "resourceOpen");
  function resourceDestinationAfter(code3) {
    return markdownLineEndingOrSpace(code3) ? factoryWhitespace(effects, resourceBetween)(code3) : resourceEnd(code3);
  }
  __name(resourceDestinationAfter, "resourceDestinationAfter");
  function resourceDestinationMissing(code3) {
    return nok(code3);
  }
  __name(resourceDestinationMissing, "resourceDestinationMissing");
  function resourceBetween(code3) {
    if (code3 === 34 || code3 === 39 || code3 === 40) {
      return factoryTitle(effects, resourceTitleAfter, nok, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(code3);
    }
    return resourceEnd(code3);
  }
  __name(resourceBetween, "resourceBetween");
  function resourceTitleAfter(code3) {
    return markdownLineEndingOrSpace(code3) ? factoryWhitespace(effects, resourceEnd)(code3) : resourceEnd(code3);
  }
  __name(resourceTitleAfter, "resourceTitleAfter");
  function resourceEnd(code3) {
    if (code3 === 41) {
      effects.enter("resourceMarker");
      effects.consume(code3);
      effects.exit("resourceMarker");
      effects.exit("resource");
      return ok3;
    }
    return nok(code3);
  }
  __name(resourceEnd, "resourceEnd");
}
__name(tokenizeResource, "tokenizeResource");
function tokenizeReferenceFull(effects, ok3, nok) {
  const self = this;
  return referenceFull;
  function referenceFull(code3) {
    return factoryLabel.call(self, effects, referenceFullAfter, referenceFullMissing, "reference", "referenceMarker", "referenceString")(code3);
  }
  __name(referenceFull, "referenceFull");
  function referenceFullAfter(code3) {
    return self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1))) ? ok3(code3) : nok(code3);
  }
  __name(referenceFullAfter, "referenceFullAfter");
  function referenceFullMissing(code3) {
    return nok(code3);
  }
  __name(referenceFullMissing, "referenceFullMissing");
}
__name(tokenizeReferenceFull, "tokenizeReferenceFull");
function tokenizeReferenceCollapsed(effects, ok3, nok) {
  return referenceCollapsedStart;
  function referenceCollapsedStart(code3) {
    effects.enter("reference");
    effects.enter("referenceMarker");
    effects.consume(code3);
    effects.exit("referenceMarker");
    return referenceCollapsedOpen;
  }
  __name(referenceCollapsedStart, "referenceCollapsedStart");
  function referenceCollapsedOpen(code3) {
    if (code3 === 93) {
      effects.enter("referenceMarker");
      effects.consume(code3);
      effects.exit("referenceMarker");
      effects.exit("reference");
      return ok3;
    }
    return nok(code3);
  }
  __name(referenceCollapsedOpen, "referenceCollapsedOpen");
}
__name(tokenizeReferenceCollapsed, "tokenizeReferenceCollapsed");

// node_modules/micromark-core-commonmark/lib/label-start-image.js
init_esbuild_shims();
var labelStartImage = {
  name: "labelStartImage",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartImage
};
function tokenizeLabelStartImage(effects, ok3, nok) {
  const self = this;
  return start;
  function start(code3) {
    effects.enter("labelImage");
    effects.enter("labelImageMarker");
    effects.consume(code3);
    effects.exit("labelImageMarker");
    return open;
  }
  __name(start, "start");
  function open(code3) {
    if (code3 === 91) {
      effects.enter("labelMarker");
      effects.consume(code3);
      effects.exit("labelMarker");
      effects.exit("labelImage");
      return after;
    }
    return nok(code3);
  }
  __name(open, "open");
  function after(code3) {
    return code3 === 94 && "_hiddenFootnoteSupport" in self.parser.constructs ? nok(code3) : ok3(code3);
  }
  __name(after, "after");
}
__name(tokenizeLabelStartImage, "tokenizeLabelStartImage");

// node_modules/micromark-core-commonmark/lib/label-start-link.js
init_esbuild_shims();
var labelStartLink = {
  name: "labelStartLink",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartLink
};
function tokenizeLabelStartLink(effects, ok3, nok) {
  const self = this;
  return start;
  function start(code3) {
    effects.enter("labelLink");
    effects.enter("labelMarker");
    effects.consume(code3);
    effects.exit("labelMarker");
    effects.exit("labelLink");
    return after;
  }
  __name(start, "start");
  function after(code3) {
    return code3 === 94 && "_hiddenFootnoteSupport" in self.parser.constructs ? nok(code3) : ok3(code3);
  }
  __name(after, "after");
}
__name(tokenizeLabelStartLink, "tokenizeLabelStartLink");

// node_modules/micromark-core-commonmark/lib/line-ending.js
init_esbuild_shims();
var lineEnding = {
  name: "lineEnding",
  tokenize: tokenizeLineEnding
};
function tokenizeLineEnding(effects, ok3) {
  return start;
  function start(code3) {
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return factorySpace(effects, ok3, "linePrefix");
  }
  __name(start, "start");
}
__name(tokenizeLineEnding, "tokenizeLineEnding");

// node_modules/micromark-core-commonmark/lib/list.js
init_esbuild_shims();

// node_modules/micromark-core-commonmark/lib/thematic-break.js
init_esbuild_shims();
var thematicBreak2 = {
  name: "thematicBreak",
  tokenize: tokenizeThematicBreak
};
function tokenizeThematicBreak(effects, ok3, nok) {
  let size = 0;
  let marker;
  return start;
  function start(code3) {
    effects.enter("thematicBreak");
    return before(code3);
  }
  __name(start, "start");
  function before(code3) {
    marker = code3;
    return atBreak(code3);
  }
  __name(before, "before");
  function atBreak(code3) {
    if (code3 === marker) {
      effects.enter("thematicBreakSequence");
      return sequence(code3);
    }
    if (size >= 3 && (code3 === null || markdownLineEnding(code3))) {
      effects.exit("thematicBreak");
      return ok3(code3);
    }
    return nok(code3);
  }
  __name(atBreak, "atBreak");
  function sequence(code3) {
    if (code3 === marker) {
      effects.consume(code3);
      size++;
      return sequence;
    }
    effects.exit("thematicBreakSequence");
    return markdownSpace(code3) ? factorySpace(effects, atBreak, "whitespace")(code3) : atBreak(code3);
  }
  __name(sequence, "sequence");
}
__name(tokenizeThematicBreak, "tokenizeThematicBreak");

// node_modules/micromark-core-commonmark/lib/list.js
var list2 = {
  continuation: {
    tokenize: tokenizeListContinuation
  },
  exit: tokenizeListEnd,
  name: "list",
  tokenize: tokenizeListStart
};
var listItemPrefixWhitespaceConstruct = {
  partial: true,
  tokenize: tokenizeListItemPrefixWhitespace
};
var indentConstruct = {
  partial: true,
  tokenize: tokenizeIndent
};
function tokenizeListStart(effects, ok3, nok) {
  const self = this;
  const tail = self.events[self.events.length - 1];
  let initialSize = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let size = 0;
  return start;
  function start(code3) {
    const kind = self.containerState.type || (code3 === 42 || code3 === 43 || code3 === 45 ? "listUnordered" : "listOrdered");
    if (kind === "listUnordered" ? !self.containerState.marker || code3 === self.containerState.marker : asciiDigit(code3)) {
      if (!self.containerState.type) {
        self.containerState.type = kind;
        effects.enter(kind, {
          _container: true
        });
      }
      if (kind === "listUnordered") {
        effects.enter("listItemPrefix");
        return code3 === 42 || code3 === 45 ? effects.check(thematicBreak2, nok, atMarker)(code3) : atMarker(code3);
      }
      if (!self.interrupt || code3 === 49) {
        effects.enter("listItemPrefix");
        effects.enter("listItemValue");
        return inside(code3);
      }
    }
    return nok(code3);
  }
  __name(start, "start");
  function inside(code3) {
    if (asciiDigit(code3) && ++size < 10) {
      effects.consume(code3);
      return inside;
    }
    if ((!self.interrupt || size < 2) && (self.containerState.marker ? code3 === self.containerState.marker : code3 === 41 || code3 === 46)) {
      effects.exit("listItemValue");
      return atMarker(code3);
    }
    return nok(code3);
  }
  __name(inside, "inside");
  function atMarker(code3) {
    effects.enter("listItemMarker");
    effects.consume(code3);
    effects.exit("listItemMarker");
    self.containerState.marker = self.containerState.marker || code3;
    return effects.check(
      blankLine,
      // Can’t be empty when interrupting.
      self.interrupt ? nok : onBlank,
      effects.attempt(listItemPrefixWhitespaceConstruct, endOfPrefix, otherPrefix)
    );
  }
  __name(atMarker, "atMarker");
  function onBlank(code3) {
    self.containerState.initialBlankLine = true;
    initialSize++;
    return endOfPrefix(code3);
  }
  __name(onBlank, "onBlank");
  function otherPrefix(code3) {
    if (markdownSpace(code3)) {
      effects.enter("listItemPrefixWhitespace");
      effects.consume(code3);
      effects.exit("listItemPrefixWhitespace");
      return endOfPrefix;
    }
    return nok(code3);
  }
  __name(otherPrefix, "otherPrefix");
  function endOfPrefix(code3) {
    self.containerState.size = initialSize + self.sliceSerialize(effects.exit("listItemPrefix"), true).length;
    return ok3(code3);
  }
  __name(endOfPrefix, "endOfPrefix");
}
__name(tokenizeListStart, "tokenizeListStart");
function tokenizeListContinuation(effects, ok3, nok) {
  const self = this;
  self.containerState._closeFlow = void 0;
  return effects.check(blankLine, onBlank, notBlank);
  function onBlank(code3) {
    self.containerState.furtherBlankLines = self.containerState.furtherBlankLines || self.containerState.initialBlankLine;
    return factorySpace(effects, ok3, "listItemIndent", self.containerState.size + 1)(code3);
  }
  __name(onBlank, "onBlank");
  function notBlank(code3) {
    if (self.containerState.furtherBlankLines || !markdownSpace(code3)) {
      self.containerState.furtherBlankLines = void 0;
      self.containerState.initialBlankLine = void 0;
      return notInCurrentItem(code3);
    }
    self.containerState.furtherBlankLines = void 0;
    self.containerState.initialBlankLine = void 0;
    return effects.attempt(indentConstruct, ok3, notInCurrentItem)(code3);
  }
  __name(notBlank, "notBlank");
  function notInCurrentItem(code3) {
    self.containerState._closeFlow = true;
    self.interrupt = void 0;
    return factorySpace(effects, effects.attempt(list2, ok3, nok), "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code3);
  }
  __name(notInCurrentItem, "notInCurrentItem");
}
__name(tokenizeListContinuation, "tokenizeListContinuation");
function tokenizeIndent(effects, ok3, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemIndent", self.containerState.size + 1);
  function afterPrefix(code3) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "listItemIndent" && tail[2].sliceSerialize(tail[1], true).length === self.containerState.size ? ok3(code3) : nok(code3);
  }
  __name(afterPrefix, "afterPrefix");
}
__name(tokenizeIndent, "tokenizeIndent");
function tokenizeListEnd(effects) {
  effects.exit(this.containerState.type);
}
__name(tokenizeListEnd, "tokenizeListEnd");
function tokenizeListItemPrefixWhitespace(effects, ok3, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemPrefixWhitespace", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4 + 1);
  function afterPrefix(code3) {
    const tail = self.events[self.events.length - 1];
    return !markdownSpace(code3) && tail && tail[1].type === "listItemPrefixWhitespace" ? ok3(code3) : nok(code3);
  }
  __name(afterPrefix, "afterPrefix");
}
__name(tokenizeListItemPrefixWhitespace, "tokenizeListItemPrefixWhitespace");

// node_modules/micromark-core-commonmark/lib/setext-underline.js
init_esbuild_shims();
var setextUnderline = {
  name: "setextUnderline",
  resolveTo: resolveToSetextUnderline,
  tokenize: tokenizeSetextUnderline
};
function resolveToSetextUnderline(events, context) {
  let index2 = events.length;
  let content3;
  let text5;
  let definition3;
  while (index2--) {
    if (events[index2][0] === "enter") {
      if (events[index2][1].type === "content") {
        content3 = index2;
        break;
      }
      if (events[index2][1].type === "paragraph") {
        text5 = index2;
      }
    } else {
      if (events[index2][1].type === "content") {
        events.splice(index2, 1);
      }
      if (!definition3 && events[index2][1].type === "definition") {
        definition3 = index2;
      }
    }
  }
  const heading2 = {
    type: "setextHeading",
    start: {
      ...events[content3][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  events[text5][1].type = "setextHeadingText";
  if (definition3) {
    events.splice(text5, 0, ["enter", heading2, context]);
    events.splice(definition3 + 1, 0, ["exit", events[content3][1], context]);
    events[content3][1].end = {
      ...events[definition3][1].end
    };
  } else {
    events[content3][1] = heading2;
  }
  events.push(["exit", heading2, context]);
  return events;
}
__name(resolveToSetextUnderline, "resolveToSetextUnderline");
function tokenizeSetextUnderline(effects, ok3, nok) {
  const self = this;
  let marker;
  return start;
  function start(code3) {
    let index2 = self.events.length;
    let paragraph2;
    while (index2--) {
      if (self.events[index2][1].type !== "lineEnding" && self.events[index2][1].type !== "linePrefix" && self.events[index2][1].type !== "content") {
        paragraph2 = self.events[index2][1].type === "paragraph";
        break;
      }
    }
    if (!self.parser.lazy[self.now().line] && (self.interrupt || paragraph2)) {
      effects.enter("setextHeadingLine");
      marker = code3;
      return before(code3);
    }
    return nok(code3);
  }
  __name(start, "start");
  function before(code3) {
    effects.enter("setextHeadingLineSequence");
    return inside(code3);
  }
  __name(before, "before");
  function inside(code3) {
    if (code3 === marker) {
      effects.consume(code3);
      return inside;
    }
    effects.exit("setextHeadingLineSequence");
    return markdownSpace(code3) ? factorySpace(effects, after, "lineSuffix")(code3) : after(code3);
  }
  __name(inside, "inside");
  function after(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("setextHeadingLine");
      return ok3(code3);
    }
    return nok(code3);
  }
  __name(after, "after");
}
__name(tokenizeSetextUnderline, "tokenizeSetextUnderline");

// node_modules/micromark-extension-gfm-footnote/lib/syntax.js
var indent = {
  tokenize: tokenizeIndent2,
  partial: true
};
function gfmFootnote() {
  return {
    document: {
      [91]: {
        name: "gfmFootnoteDefinition",
        tokenize: tokenizeDefinitionStart,
        continuation: {
          tokenize: tokenizeDefinitionContinuation
        },
        exit: gfmFootnoteDefinitionEnd
      }
    },
    text: {
      [91]: {
        name: "gfmFootnoteCall",
        tokenize: tokenizeGfmFootnoteCall
      },
      [93]: {
        name: "gfmPotentialFootnoteCall",
        add: "after",
        tokenize: tokenizePotentialGfmFootnoteCall,
        resolveTo: resolveToPotentialGfmFootnoteCall
      }
    }
  };
}
__name(gfmFootnote, "gfmFootnote");
function tokenizePotentialGfmFootnoteCall(effects, ok3, nok) {
  const self = this;
  let index2 = self.events.length;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let labelStart;
  while (index2--) {
    const token = self.events[index2][1];
    if (token.type === "labelImage") {
      labelStart = token;
      break;
    }
    if (token.type === "gfmFootnoteCall" || token.type === "labelLink" || token.type === "label" || token.type === "image" || token.type === "link") {
      break;
    }
  }
  return start;
  function start(code3) {
    if (!labelStart || !labelStart._balanced) {
      return nok(code3);
    }
    const id = normalizeIdentifier(self.sliceSerialize({
      start: labelStart.end,
      end: self.now()
    }));
    if (id.codePointAt(0) !== 94 || !defined.includes(id.slice(1))) {
      return nok(code3);
    }
    effects.enter("gfmFootnoteCallLabelMarker");
    effects.consume(code3);
    effects.exit("gfmFootnoteCallLabelMarker");
    return ok3(code3);
  }
  __name(start, "start");
}
__name(tokenizePotentialGfmFootnoteCall, "tokenizePotentialGfmFootnoteCall");
function resolveToPotentialGfmFootnoteCall(events, context) {
  let index2 = events.length;
  let labelStart;
  while (index2--) {
    if (events[index2][1].type === "labelImage" && events[index2][0] === "enter") {
      labelStart = events[index2][1];
      break;
    }
  }
  events[index2 + 1][1].type = "data";
  events[index2 + 3][1].type = "gfmFootnoteCallLabelMarker";
  const call = {
    type: "gfmFootnoteCall",
    start: Object.assign({}, events[index2 + 3][1].start),
    end: Object.assign({}, events[events.length - 1][1].end)
  };
  const marker = {
    type: "gfmFootnoteCallMarker",
    start: Object.assign({}, events[index2 + 3][1].end),
    end: Object.assign({}, events[index2 + 3][1].end)
  };
  marker.end.column++;
  marker.end.offset++;
  marker.end._bufferIndex++;
  const string3 = {
    type: "gfmFootnoteCallString",
    start: Object.assign({}, marker.end),
    end: Object.assign({}, events[events.length - 1][1].start)
  };
  const chunk = {
    type: "chunkString",
    contentType: "string",
    start: Object.assign({}, string3.start),
    end: Object.assign({}, string3.end)
  };
  const replacement = [
    // Take the `labelImageMarker` (now `data`, the `!`)
    events[index2 + 1],
    events[index2 + 2],
    ["enter", call, context],
    // The `[`
    events[index2 + 3],
    events[index2 + 4],
    // The `^`.
    ["enter", marker, context],
    ["exit", marker, context],
    // Everything in between.
    ["enter", string3, context],
    ["enter", chunk, context],
    ["exit", chunk, context],
    ["exit", string3, context],
    // The ending (`]`, properly parsed and labelled).
    events[events.length - 2],
    events[events.length - 1],
    ["exit", call, context]
  ];
  events.splice(index2, events.length - index2 + 1, ...replacement);
  return events;
}
__name(resolveToPotentialGfmFootnoteCall, "resolveToPotentialGfmFootnoteCall");
function tokenizeGfmFootnoteCall(effects, ok3, nok) {
  const self = this;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let size = 0;
  let data;
  return start;
  function start(code3) {
    effects.enter("gfmFootnoteCall");
    effects.enter("gfmFootnoteCallLabelMarker");
    effects.consume(code3);
    effects.exit("gfmFootnoteCallLabelMarker");
    return callStart;
  }
  __name(start, "start");
  function callStart(code3) {
    if (code3 !== 94) return nok(code3);
    effects.enter("gfmFootnoteCallMarker");
    effects.consume(code3);
    effects.exit("gfmFootnoteCallMarker");
    effects.enter("gfmFootnoteCallString");
    effects.enter("chunkString").contentType = "string";
    return callData;
  }
  __name(callStart, "callStart");
  function callData(code3) {
    if (
      // Too long.
      size > 999 || // Closing brace with nothing.
      code3 === 93 && !data || // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code3 === null || code3 === 91 || markdownLineEndingOrSpace(code3)
    ) {
      return nok(code3);
    }
    if (code3 === 93) {
      effects.exit("chunkString");
      const token = effects.exit("gfmFootnoteCallString");
      if (!defined.includes(normalizeIdentifier(self.sliceSerialize(token)))) {
        return nok(code3);
      }
      effects.enter("gfmFootnoteCallLabelMarker");
      effects.consume(code3);
      effects.exit("gfmFootnoteCallLabelMarker");
      effects.exit("gfmFootnoteCall");
      return ok3;
    }
    if (!markdownLineEndingOrSpace(code3)) {
      data = true;
    }
    size++;
    effects.consume(code3);
    return code3 === 92 ? callEscape : callData;
  }
  __name(callData, "callData");
  function callEscape(code3) {
    if (code3 === 91 || code3 === 92 || code3 === 93) {
      effects.consume(code3);
      size++;
      return callData;
    }
    return callData(code3);
  }
  __name(callEscape, "callEscape");
}
__name(tokenizeGfmFootnoteCall, "tokenizeGfmFootnoteCall");
function tokenizeDefinitionStart(effects, ok3, nok) {
  const self = this;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let identifier;
  let size = 0;
  let data;
  return start;
  function start(code3) {
    effects.enter("gfmFootnoteDefinition")._container = true;
    effects.enter("gfmFootnoteDefinitionLabel");
    effects.enter("gfmFootnoteDefinitionLabelMarker");
    effects.consume(code3);
    effects.exit("gfmFootnoteDefinitionLabelMarker");
    return labelAtMarker;
  }
  __name(start, "start");
  function labelAtMarker(code3) {
    if (code3 === 94) {
      effects.enter("gfmFootnoteDefinitionMarker");
      effects.consume(code3);
      effects.exit("gfmFootnoteDefinitionMarker");
      effects.enter("gfmFootnoteDefinitionLabelString");
      effects.enter("chunkString").contentType = "string";
      return labelInside;
    }
    return nok(code3);
  }
  __name(labelAtMarker, "labelAtMarker");
  function labelInside(code3) {
    if (
      // Too long.
      size > 999 || // Closing brace with nothing.
      code3 === 93 && !data || // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code3 === null || code3 === 91 || markdownLineEndingOrSpace(code3)
    ) {
      return nok(code3);
    }
    if (code3 === 93) {
      effects.exit("chunkString");
      const token = effects.exit("gfmFootnoteDefinitionLabelString");
      identifier = normalizeIdentifier(self.sliceSerialize(token));
      effects.enter("gfmFootnoteDefinitionLabelMarker");
      effects.consume(code3);
      effects.exit("gfmFootnoteDefinitionLabelMarker");
      effects.exit("gfmFootnoteDefinitionLabel");
      return labelAfter;
    }
    if (!markdownLineEndingOrSpace(code3)) {
      data = true;
    }
    size++;
    effects.consume(code3);
    return code3 === 92 ? labelEscape : labelInside;
  }
  __name(labelInside, "labelInside");
  function labelEscape(code3) {
    if (code3 === 91 || code3 === 92 || code3 === 93) {
      effects.consume(code3);
      size++;
      return labelInside;
    }
    return labelInside(code3);
  }
  __name(labelEscape, "labelEscape");
  function labelAfter(code3) {
    if (code3 === 58) {
      effects.enter("definitionMarker");
      effects.consume(code3);
      effects.exit("definitionMarker");
      if (!defined.includes(identifier)) {
        defined.push(identifier);
      }
      return factorySpace(effects, whitespaceAfter, "gfmFootnoteDefinitionWhitespace");
    }
    return nok(code3);
  }
  __name(labelAfter, "labelAfter");
  function whitespaceAfter(code3) {
    return ok3(code3);
  }
  __name(whitespaceAfter, "whitespaceAfter");
}
__name(tokenizeDefinitionStart, "tokenizeDefinitionStart");
function tokenizeDefinitionContinuation(effects, ok3, nok) {
  return effects.check(blankLine, ok3, effects.attempt(indent, ok3, nok));
}
__name(tokenizeDefinitionContinuation, "tokenizeDefinitionContinuation");
function gfmFootnoteDefinitionEnd(effects) {
  effects.exit("gfmFootnoteDefinition");
}
__name(gfmFootnoteDefinitionEnd, "gfmFootnoteDefinitionEnd");
function tokenizeIndent2(effects, ok3, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "gfmFootnoteDefinitionIndent", 4 + 1);
  function afterPrefix(code3) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "gfmFootnoteDefinitionIndent" && tail[2].sliceSerialize(tail[1], true).length === 4 ? ok3(code3) : nok(code3);
  }
  __name(afterPrefix, "afterPrefix");
}
__name(tokenizeIndent2, "tokenizeIndent");

// node_modules/micromark-extension-gfm-strikethrough/index.js
init_esbuild_shims();

// node_modules/micromark-extension-gfm-strikethrough/lib/syntax.js
init_esbuild_shims();
function gfmStrikethrough(options) {
  const options_ = options || {};
  let single = options_.singleTilde;
  const tokenizer = {
    name: "strikethrough",
    tokenize: tokenizeStrikethrough,
    resolveAll: resolveAllStrikethrough
  };
  if (single === null || single === void 0) {
    single = true;
  }
  return {
    text: {
      [126]: tokenizer
    },
    insideSpan: {
      null: [tokenizer]
    },
    attentionMarkers: {
      null: [126]
    }
  };
  function resolveAllStrikethrough(events, context) {
    let index2 = -1;
    while (++index2 < events.length) {
      if (events[index2][0] === "enter" && events[index2][1].type === "strikethroughSequenceTemporary" && events[index2][1]._close) {
        let open = index2;
        while (open--) {
          if (events[open][0] === "exit" && events[open][1].type === "strikethroughSequenceTemporary" && events[open][1]._open && // If the sizes are the same:
          events[index2][1].end.offset - events[index2][1].start.offset === events[open][1].end.offset - events[open][1].start.offset) {
            events[index2][1].type = "strikethroughSequence";
            events[open][1].type = "strikethroughSequence";
            const strikethrough = {
              type: "strikethrough",
              start: Object.assign({}, events[open][1].start),
              end: Object.assign({}, events[index2][1].end)
            };
            const text5 = {
              type: "strikethroughText",
              start: Object.assign({}, events[open][1].end),
              end: Object.assign({}, events[index2][1].start)
            };
            const nextEvents = [["enter", strikethrough, context], ["enter", events[open][1], context], ["exit", events[open][1], context], ["enter", text5, context]];
            const insideSpan2 = context.parser.constructs.insideSpan.null;
            if (insideSpan2) {
              splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan2, events.slice(open + 1, index2), context));
            }
            splice(nextEvents, nextEvents.length, 0, [["exit", text5, context], ["enter", events[index2][1], context], ["exit", events[index2][1], context], ["exit", strikethrough, context]]);
            splice(events, open - 1, index2 - open + 3, nextEvents);
            index2 = open + nextEvents.length - 2;
            break;
          }
        }
      }
    }
    index2 = -1;
    while (++index2 < events.length) {
      if (events[index2][1].type === "strikethroughSequenceTemporary") {
        events[index2][1].type = "data";
      }
    }
    return events;
  }
  __name(resolveAllStrikethrough, "resolveAllStrikethrough");
  function tokenizeStrikethrough(effects, ok3, nok) {
    const previous4 = this.previous;
    const events = this.events;
    let size = 0;
    return start;
    function start(code3) {
      if (previous4 === 126 && events[events.length - 1][1].type !== "characterEscape") {
        return nok(code3);
      }
      effects.enter("strikethroughSequenceTemporary");
      return more(code3);
    }
    __name(start, "start");
    function more(code3) {
      const before = classifyCharacter(previous4);
      if (code3 === 126) {
        if (size > 1) return nok(code3);
        effects.consume(code3);
        size++;
        return more;
      }
      if (size < 2 && !single) return nok(code3);
      const token = effects.exit("strikethroughSequenceTemporary");
      const after = classifyCharacter(code3);
      token._open = !after || after === 2 && Boolean(before);
      token._close = !before || before === 2 && Boolean(after);
      return ok3(code3);
    }
    __name(more, "more");
  }
  __name(tokenizeStrikethrough, "tokenizeStrikethrough");
}
__name(gfmStrikethrough, "gfmStrikethrough");

// node_modules/micromark-extension-gfm-table/index.js
init_esbuild_shims();

// node_modules/micromark-extension-gfm-table/lib/syntax.js
init_esbuild_shims();

// node_modules/micromark-extension-gfm-table/lib/edit-map.js
init_esbuild_shims();
var EditMap = class {
  static {
    __name(this, "EditMap");
  }
  /**
   * Create a new edit map.
   */
  constructor() {
    this.map = [];
  }
  /**
   * Create an edit: a remove and/or add at a certain place.
   *
   * @param {number} index
   * @param {number} remove
   * @param {Array<Event>} add
   * @returns {undefined}
   */
  add(index2, remove, add) {
    addImplementation(this, index2, remove, add);
  }
  // To do: add this when moving to `micromark`.
  // /**
  //  * Create an edit: but insert `add` before existing additions.
  //  *
  //  * @param {number} index
  //  * @param {number} remove
  //  * @param {Array<Event>} add
  //  * @returns {undefined}
  //  */
  // addBefore(index, remove, add) {
  //   addImplementation(this, index, remove, add, true)
  // }
  /**
   * Done, change the events.
   *
   * @param {Array<Event>} events
   * @returns {undefined}
   */
  consume(events) {
    this.map.sort(function(a, b) {
      return a[0] - b[0];
    });
    if (this.map.length === 0) {
      return;
    }
    let index2 = this.map.length;
    const vecs = [];
    while (index2 > 0) {
      index2 -= 1;
      vecs.push(events.slice(this.map[index2][0] + this.map[index2][1]), this.map[index2][2]);
      events.length = this.map[index2][0];
    }
    vecs.push(events.slice());
    events.length = 0;
    let slice = vecs.pop();
    while (slice) {
      for (const element of slice) {
        events.push(element);
      }
      slice = vecs.pop();
    }
    this.map.length = 0;
  }
};
function addImplementation(editMap, at, remove, add) {
  let index2 = 0;
  if (remove === 0 && add.length === 0) {
    return;
  }
  while (index2 < editMap.map.length) {
    if (editMap.map[index2][0] === at) {
      editMap.map[index2][1] += remove;
      editMap.map[index2][2].push(...add);
      return;
    }
    index2 += 1;
  }
  editMap.map.push([at, remove, add]);
}
__name(addImplementation, "addImplementation");

// node_modules/micromark-extension-gfm-table/lib/infer.js
init_esbuild_shims();
function gfmTableAlign(events, index2) {
  let inDelimiterRow = false;
  const align = [];
  while (index2 < events.length) {
    const event = events[index2];
    if (inDelimiterRow) {
      if (event[0] === "enter") {
        if (event[1].type === "tableContent") {
          align.push(events[index2 + 1][1].type === "tableDelimiterMarker" ? "left" : "none");
        }
      } else if (event[1].type === "tableContent") {
        if (events[index2 - 1][1].type === "tableDelimiterMarker") {
          const alignIndex = align.length - 1;
          align[alignIndex] = align[alignIndex] === "left" ? "center" : "right";
        }
      } else if (event[1].type === "tableDelimiterRow") {
        break;
      }
    } else if (event[0] === "enter" && event[1].type === "tableDelimiterRow") {
      inDelimiterRow = true;
    }
    index2 += 1;
  }
  return align;
}
__name(gfmTableAlign, "gfmTableAlign");

// node_modules/micromark-extension-gfm-table/lib/syntax.js
function gfmTable() {
  return {
    flow: {
      null: {
        name: "table",
        tokenize: tokenizeTable,
        resolveAll: resolveTable
      }
    }
  };
}
__name(gfmTable, "gfmTable");
function tokenizeTable(effects, ok3, nok) {
  const self = this;
  let size = 0;
  let sizeB = 0;
  let seen;
  return start;
  function start(code3) {
    let index2 = self.events.length - 1;
    while (index2 > -1) {
      const type = self.events[index2][1].type;
      if (type === "lineEnding" || // Note: markdown-rs uses `whitespace` instead of `linePrefix`
      type === "linePrefix") index2--;
      else break;
    }
    const tail = index2 > -1 ? self.events[index2][1].type : null;
    const next = tail === "tableHead" || tail === "tableRow" ? bodyRowStart : headRowBefore;
    if (next === bodyRowStart && self.parser.lazy[self.now().line]) {
      return nok(code3);
    }
    return next(code3);
  }
  __name(start, "start");
  function headRowBefore(code3) {
    effects.enter("tableHead");
    effects.enter("tableRow");
    return headRowStart(code3);
  }
  __name(headRowBefore, "headRowBefore");
  function headRowStart(code3) {
    if (code3 === 124) {
      return headRowBreak(code3);
    }
    seen = true;
    sizeB += 1;
    return headRowBreak(code3);
  }
  __name(headRowStart, "headRowStart");
  function headRowBreak(code3) {
    if (code3 === null) {
      return nok(code3);
    }
    if (markdownLineEnding(code3)) {
      if (sizeB > 1) {
        sizeB = 0;
        self.interrupt = true;
        effects.exit("tableRow");
        effects.enter("lineEnding");
        effects.consume(code3);
        effects.exit("lineEnding");
        return headDelimiterStart;
      }
      return nok(code3);
    }
    if (markdownSpace(code3)) {
      return factorySpace(effects, headRowBreak, "whitespace")(code3);
    }
    sizeB += 1;
    if (seen) {
      seen = false;
      size += 1;
    }
    if (code3 === 124) {
      effects.enter("tableCellDivider");
      effects.consume(code3);
      effects.exit("tableCellDivider");
      seen = true;
      return headRowBreak;
    }
    effects.enter("data");
    return headRowData(code3);
  }
  __name(headRowBreak, "headRowBreak");
  function headRowData(code3) {
    if (code3 === null || code3 === 124 || markdownLineEndingOrSpace(code3)) {
      effects.exit("data");
      return headRowBreak(code3);
    }
    effects.consume(code3);
    return code3 === 92 ? headRowEscape : headRowData;
  }
  __name(headRowData, "headRowData");
  function headRowEscape(code3) {
    if (code3 === 92 || code3 === 124) {
      effects.consume(code3);
      return headRowData;
    }
    return headRowData(code3);
  }
  __name(headRowEscape, "headRowEscape");
  function headDelimiterStart(code3) {
    self.interrupt = false;
    if (self.parser.lazy[self.now().line]) {
      return nok(code3);
    }
    effects.enter("tableDelimiterRow");
    seen = false;
    if (markdownSpace(code3)) {
      return factorySpace(effects, headDelimiterBefore, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code3);
    }
    return headDelimiterBefore(code3);
  }
  __name(headDelimiterStart, "headDelimiterStart");
  function headDelimiterBefore(code3) {
    if (code3 === 45 || code3 === 58) {
      return headDelimiterValueBefore(code3);
    }
    if (code3 === 124) {
      seen = true;
      effects.enter("tableCellDivider");
      effects.consume(code3);
      effects.exit("tableCellDivider");
      return headDelimiterCellBefore;
    }
    return headDelimiterNok(code3);
  }
  __name(headDelimiterBefore, "headDelimiterBefore");
  function headDelimiterCellBefore(code3) {
    if (markdownSpace(code3)) {
      return factorySpace(effects, headDelimiterValueBefore, "whitespace")(code3);
    }
    return headDelimiterValueBefore(code3);
  }
  __name(headDelimiterCellBefore, "headDelimiterCellBefore");
  function headDelimiterValueBefore(code3) {
    if (code3 === 58) {
      sizeB += 1;
      seen = true;
      effects.enter("tableDelimiterMarker");
      effects.consume(code3);
      effects.exit("tableDelimiterMarker");
      return headDelimiterLeftAlignmentAfter;
    }
    if (code3 === 45) {
      sizeB += 1;
      return headDelimiterLeftAlignmentAfter(code3);
    }
    if (code3 === null || markdownLineEnding(code3)) {
      return headDelimiterCellAfter(code3);
    }
    return headDelimiterNok(code3);
  }
  __name(headDelimiterValueBefore, "headDelimiterValueBefore");
  function headDelimiterLeftAlignmentAfter(code3) {
    if (code3 === 45) {
      effects.enter("tableDelimiterFiller");
      return headDelimiterFiller(code3);
    }
    return headDelimiterNok(code3);
  }
  __name(headDelimiterLeftAlignmentAfter, "headDelimiterLeftAlignmentAfter");
  function headDelimiterFiller(code3) {
    if (code3 === 45) {
      effects.consume(code3);
      return headDelimiterFiller;
    }
    if (code3 === 58) {
      seen = true;
      effects.exit("tableDelimiterFiller");
      effects.enter("tableDelimiterMarker");
      effects.consume(code3);
      effects.exit("tableDelimiterMarker");
      return headDelimiterRightAlignmentAfter;
    }
    effects.exit("tableDelimiterFiller");
    return headDelimiterRightAlignmentAfter(code3);
  }
  __name(headDelimiterFiller, "headDelimiterFiller");
  function headDelimiterRightAlignmentAfter(code3) {
    if (markdownSpace(code3)) {
      return factorySpace(effects, headDelimiterCellAfter, "whitespace")(code3);
    }
    return headDelimiterCellAfter(code3);
  }
  __name(headDelimiterRightAlignmentAfter, "headDelimiterRightAlignmentAfter");
  function headDelimiterCellAfter(code3) {
    if (code3 === 124) {
      return headDelimiterBefore(code3);
    }
    if (code3 === null || markdownLineEnding(code3)) {
      if (!seen || size !== sizeB) {
        return headDelimiterNok(code3);
      }
      effects.exit("tableDelimiterRow");
      effects.exit("tableHead");
      return ok3(code3);
    }
    return headDelimiterNok(code3);
  }
  __name(headDelimiterCellAfter, "headDelimiterCellAfter");
  function headDelimiterNok(code3) {
    return nok(code3);
  }
  __name(headDelimiterNok, "headDelimiterNok");
  function bodyRowStart(code3) {
    effects.enter("tableRow");
    return bodyRowBreak(code3);
  }
  __name(bodyRowStart, "bodyRowStart");
  function bodyRowBreak(code3) {
    if (code3 === 124) {
      effects.enter("tableCellDivider");
      effects.consume(code3);
      effects.exit("tableCellDivider");
      return bodyRowBreak;
    }
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("tableRow");
      return ok3(code3);
    }
    if (markdownSpace(code3)) {
      return factorySpace(effects, bodyRowBreak, "whitespace")(code3);
    }
    effects.enter("data");
    return bodyRowData(code3);
  }
  __name(bodyRowBreak, "bodyRowBreak");
  function bodyRowData(code3) {
    if (code3 === null || code3 === 124 || markdownLineEndingOrSpace(code3)) {
      effects.exit("data");
      return bodyRowBreak(code3);
    }
    effects.consume(code3);
    return code3 === 92 ? bodyRowEscape : bodyRowData;
  }
  __name(bodyRowData, "bodyRowData");
  function bodyRowEscape(code3) {
    if (code3 === 92 || code3 === 124) {
      effects.consume(code3);
      return bodyRowData;
    }
    return bodyRowData(code3);
  }
  __name(bodyRowEscape, "bodyRowEscape");
}
__name(tokenizeTable, "tokenizeTable");
function resolveTable(events, context) {
  let index2 = -1;
  let inFirstCellAwaitingPipe = true;
  let rowKind = 0;
  let lastCell = [0, 0, 0, 0];
  let cell = [0, 0, 0, 0];
  let afterHeadAwaitingFirstBodyRow = false;
  let lastTableEnd = 0;
  let currentTable;
  let currentBody;
  let currentCell;
  const map3 = new EditMap();
  while (++index2 < events.length) {
    const event = events[index2];
    const token = event[1];
    if (event[0] === "enter") {
      if (token.type === "tableHead") {
        afterHeadAwaitingFirstBodyRow = false;
        if (lastTableEnd !== 0) {
          flushTableEnd(map3, context, lastTableEnd, currentTable, currentBody);
          currentBody = void 0;
          lastTableEnd = 0;
        }
        currentTable = {
          type: "table",
          start: Object.assign({}, token.start),
          // Note: correct end is set later.
          end: Object.assign({}, token.end)
        };
        map3.add(index2, 0, [["enter", currentTable, context]]);
      } else if (token.type === "tableRow" || token.type === "tableDelimiterRow") {
        inFirstCellAwaitingPipe = true;
        currentCell = void 0;
        lastCell = [0, 0, 0, 0];
        cell = [0, index2 + 1, 0, 0];
        if (afterHeadAwaitingFirstBodyRow) {
          afterHeadAwaitingFirstBodyRow = false;
          currentBody = {
            type: "tableBody",
            start: Object.assign({}, token.start),
            // Note: correct end is set later.
            end: Object.assign({}, token.end)
          };
          map3.add(index2, 0, [["enter", currentBody, context]]);
        }
        rowKind = token.type === "tableDelimiterRow" ? 2 : currentBody ? 3 : 1;
      } else if (rowKind && (token.type === "data" || token.type === "tableDelimiterMarker" || token.type === "tableDelimiterFiller")) {
        inFirstCellAwaitingPipe = false;
        if (cell[2] === 0) {
          if (lastCell[1] !== 0) {
            cell[0] = cell[1];
            currentCell = flushCell(map3, context, lastCell, rowKind, void 0, currentCell);
            lastCell = [0, 0, 0, 0];
          }
          cell[2] = index2;
        }
      } else if (token.type === "tableCellDivider") {
        if (inFirstCellAwaitingPipe) {
          inFirstCellAwaitingPipe = false;
        } else {
          if (lastCell[1] !== 0) {
            cell[0] = cell[1];
            currentCell = flushCell(map3, context, lastCell, rowKind, void 0, currentCell);
          }
          lastCell = cell;
          cell = [lastCell[1], index2, 0, 0];
        }
      }
    } else if (token.type === "tableHead") {
      afterHeadAwaitingFirstBodyRow = true;
      lastTableEnd = index2;
    } else if (token.type === "tableRow" || token.type === "tableDelimiterRow") {
      lastTableEnd = index2;
      if (lastCell[1] !== 0) {
        cell[0] = cell[1];
        currentCell = flushCell(map3, context, lastCell, rowKind, index2, currentCell);
      } else if (cell[1] !== 0) {
        currentCell = flushCell(map3, context, cell, rowKind, index2, currentCell);
      }
      rowKind = 0;
    } else if (rowKind && (token.type === "data" || token.type === "tableDelimiterMarker" || token.type === "tableDelimiterFiller")) {
      cell[3] = index2;
    }
  }
  if (lastTableEnd !== 0) {
    flushTableEnd(map3, context, lastTableEnd, currentTable, currentBody);
  }
  map3.consume(context.events);
  index2 = -1;
  while (++index2 < context.events.length) {
    const event = context.events[index2];
    if (event[0] === "enter" && event[1].type === "table") {
      event[1]._align = gfmTableAlign(context.events, index2);
    }
  }
  return events;
}
__name(resolveTable, "resolveTable");
function flushCell(map3, context, range, rowKind, rowEnd, previousCell) {
  const groupName = rowKind === 1 ? "tableHeader" : rowKind === 2 ? "tableDelimiter" : "tableData";
  const valueName = "tableContent";
  if (range[0] !== 0) {
    previousCell.end = Object.assign({}, getPoint(context.events, range[0]));
    map3.add(range[0], 0, [["exit", previousCell, context]]);
  }
  const now = getPoint(context.events, range[1]);
  previousCell = {
    type: groupName,
    start: Object.assign({}, now),
    // Note: correct end is set later.
    end: Object.assign({}, now)
  };
  map3.add(range[1], 0, [["enter", previousCell, context]]);
  if (range[2] !== 0) {
    const relatedStart = getPoint(context.events, range[2]);
    const relatedEnd = getPoint(context.events, range[3]);
    const valueToken = {
      type: valueName,
      start: Object.assign({}, relatedStart),
      end: Object.assign({}, relatedEnd)
    };
    map3.add(range[2], 0, [["enter", valueToken, context]]);
    if (rowKind !== 2) {
      const start = context.events[range[2]];
      const end = context.events[range[3]];
      start[1].end = Object.assign({}, end[1].end);
      start[1].type = "chunkText";
      start[1].contentType = "text";
      if (range[3] > range[2] + 1) {
        const a = range[2] + 1;
        const b = range[3] - range[2] - 1;
        map3.add(a, b, []);
      }
    }
    map3.add(range[3] + 1, 0, [["exit", valueToken, context]]);
  }
  if (rowEnd !== void 0) {
    previousCell.end = Object.assign({}, getPoint(context.events, rowEnd));
    map3.add(rowEnd, 0, [["exit", previousCell, context]]);
    previousCell = void 0;
  }
  return previousCell;
}
__name(flushCell, "flushCell");
function flushTableEnd(map3, context, index2, table, tableBody) {
  const exits = [];
  const related = getPoint(context.events, index2);
  if (tableBody) {
    tableBody.end = Object.assign({}, related);
    exits.push(["exit", tableBody, context]);
  }
  table.end = Object.assign({}, related);
  exits.push(["exit", table, context]);
  map3.add(index2 + 1, 0, exits);
}
__name(flushTableEnd, "flushTableEnd");
function getPoint(events, index2) {
  const event = events[index2];
  const side = event[0] === "enter" ? "start" : "end";
  return event[1][side];
}
__name(getPoint, "getPoint");

// node_modules/micromark-extension-gfm-task-list-item/index.js
init_esbuild_shims();

// node_modules/micromark-extension-gfm-task-list-item/lib/syntax.js
init_esbuild_shims();
var tasklistCheck = {
  name: "tasklistCheck",
  tokenize: tokenizeTasklistCheck
};
function gfmTaskListItem() {
  return {
    text: {
      [91]: tasklistCheck
    }
  };
}
__name(gfmTaskListItem, "gfmTaskListItem");
function tokenizeTasklistCheck(effects, ok3, nok) {
  const self = this;
  return open;
  function open(code3) {
    if (
      // Exit if there’s stuff before.
      self.previous !== null || // Exit if not in the first content that is the first child of a list
      // item.
      !self._gfmTasklistFirstContentOfListItem
    ) {
      return nok(code3);
    }
    effects.enter("taskListCheck");
    effects.enter("taskListCheckMarker");
    effects.consume(code3);
    effects.exit("taskListCheckMarker");
    return inside;
  }
  __name(open, "open");
  function inside(code3) {
    if (markdownLineEndingOrSpace(code3)) {
      effects.enter("taskListCheckValueUnchecked");
      effects.consume(code3);
      effects.exit("taskListCheckValueUnchecked");
      return close;
    }
    if (code3 === 88 || code3 === 120) {
      effects.enter("taskListCheckValueChecked");
      effects.consume(code3);
      effects.exit("taskListCheckValueChecked");
      return close;
    }
    return nok(code3);
  }
  __name(inside, "inside");
  function close(code3) {
    if (code3 === 93) {
      effects.enter("taskListCheckMarker");
      effects.consume(code3);
      effects.exit("taskListCheckMarker");
      effects.exit("taskListCheck");
      return after;
    }
    return nok(code3);
  }
  __name(close, "close");
  function after(code3) {
    if (markdownLineEnding(code3)) {
      return ok3(code3);
    }
    if (markdownSpace(code3)) {
      return effects.check({
        tokenize: spaceThenNonSpace
      }, ok3, nok)(code3);
    }
    return nok(code3);
  }
  __name(after, "after");
}
__name(tokenizeTasklistCheck, "tokenizeTasklistCheck");
function spaceThenNonSpace(effects, ok3, nok) {
  return factorySpace(effects, after, "whitespace");
  function after(code3) {
    return code3 === null ? nok(code3) : ok3(code3);
  }
  __name(after, "after");
}
__name(spaceThenNonSpace, "spaceThenNonSpace");

// node_modules/micromark-extension-gfm/index.js
function gfm(options) {
  return combineExtensions([
    gfmAutolinkLiteral(),
    gfmFootnote(),
    gfmStrikethrough(options),
    gfmTable(),
    gfmTaskListItem()
  ]);
}
__name(gfm, "gfm");

// node_modules/remark-gfm/lib/index.js
var emptyOptions2 = {};
function remarkGfm(options) {
  const self = (
    /** @type {Processor<Root>} */
    this
  );
  const settings = options || emptyOptions2;
  const data = self.data();
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  micromarkExtensions.push(gfm(settings));
  fromMarkdownExtensions.push(gfmFromMarkdown());
  toMarkdownExtensions.push(gfmToMarkdown(settings));
}
__name(remarkGfm, "remarkGfm");

// node_modules/remark-math/index.js
init_esbuild_shims();

// node_modules/remark-math/lib/index.js
init_esbuild_shims();

// node_modules/mdast-util-math/index.js
init_esbuild_shims();

// node_modules/mdast-util-math/lib/index.js
init_esbuild_shims();
function mathFromMarkdown() {
  return {
    enter: {
      mathFlow: enterMathFlow,
      mathFlowFenceMeta: enterMathFlowMeta,
      mathText: enterMathText
    },
    exit: {
      mathFlow: exitMathFlow,
      mathFlowFence: exitMathFlowFence,
      mathFlowFenceMeta: exitMathFlowMeta,
      mathFlowValue: exitMathData,
      mathText: exitMathText,
      mathTextData: exitMathData
    }
  };
  function enterMathFlow(token) {
    const code3 = {
      type: "element",
      tagName: "code",
      properties: { className: ["language-math", "math-display"] },
      children: []
    };
    this.enter(
      {
        type: "math",
        meta: null,
        value: "",
        data: { hName: "pre", hChildren: [code3] }
      },
      token
    );
  }
  __name(enterMathFlow, "enterMathFlow");
  function enterMathFlowMeta() {
    this.buffer();
  }
  __name(enterMathFlowMeta, "enterMathFlowMeta");
  function exitMathFlowMeta() {
    const data = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    ok(node2.type === "math");
    node2.meta = data;
  }
  __name(exitMathFlowMeta, "exitMathFlowMeta");
  function exitMathFlowFence() {
    if (this.data.mathFlowInside) return;
    this.buffer();
    this.data.mathFlowInside = true;
  }
  __name(exitMathFlowFence, "exitMathFlowFence");
  function exitMathFlow(token) {
    const data = this.resume().replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
    const node2 = this.stack[this.stack.length - 1];
    ok(node2.type === "math");
    this.exit(token);
    node2.value = data;
    const code3 = (
      /** @type {HastElement} */
      node2.data.hChildren[0]
    );
    ok(code3.type === "element");
    ok(code3.tagName === "code");
    code3.children.push({ type: "text", value: data });
    this.data.mathFlowInside = void 0;
  }
  __name(exitMathFlow, "exitMathFlow");
  function enterMathText(token) {
    this.enter(
      {
        type: "inlineMath",
        value: "",
        data: {
          hName: "code",
          hProperties: { className: ["language-math", "math-inline"] },
          hChildren: []
        }
      },
      token
    );
    this.buffer();
  }
  __name(enterMathText, "enterMathText");
  function exitMathText(token) {
    const data = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    ok(node2.type === "inlineMath");
    this.exit(token);
    node2.value = data;
    const children = (
      /** @type {Array<HastElementContent>} */
      // @ts-expect-error: we defined it in `enterMathFlow`.
      node2.data.hChildren
    );
    children.push({ type: "text", value: data });
  }
  __name(exitMathText, "exitMathText");
  function exitMathData(token) {
    this.config.enter.data.call(this, token);
    this.config.exit.data.call(this, token);
  }
  __name(exitMathData, "exitMathData");
}
__name(mathFromMarkdown, "mathFromMarkdown");
function mathToMarkdown(options) {
  let single = (options || {}).singleDollarTextMath;
  if (single === null || single === void 0) {
    single = true;
  }
  inlineMath.peek = inlineMathPeek;
  return {
    unsafe: [
      { character: "\r", inConstruct: "mathFlowMeta" },
      { character: "\n", inConstruct: "mathFlowMeta" },
      {
        character: "$",
        after: single ? void 0 : "\\$",
        inConstruct: "phrasing"
      },
      { character: "$", inConstruct: "mathFlowMeta" },
      { atBreak: true, character: "$", after: "\\$" }
    ],
    handlers: { math: math2, inlineMath }
  };
  function math2(node2, _, state, info) {
    const raw = node2.value || "";
    const tracker = state.createTracker(info);
    const sequence = "$".repeat(Math.max(longestStreak(raw, "$") + 1, 2));
    const exit3 = state.enter("mathFlow");
    let value = tracker.move(sequence);
    if (node2.meta) {
      const subexit = state.enter("mathFlowMeta");
      value += tracker.move(
        state.safe(node2.meta, {
          after: "\n",
          before: value,
          encode: ["$"],
          ...tracker.current()
        })
      );
      subexit();
    }
    value += tracker.move("\n");
    if (raw) {
      value += tracker.move(raw + "\n");
    }
    value += tracker.move(sequence);
    exit3();
    return value;
  }
  __name(math2, "math");
  function inlineMath(node2, _, state) {
    let value = node2.value || "";
    let size = 1;
    if (!single) size++;
    while (new RegExp("(^|[^$])" + "\\$".repeat(size) + "([^$]|$)").test(value)) {
      size++;
    }
    const sequence = "$".repeat(size);
    if (
      // Contains non-space.
      /[^ \r\n]/.test(value) && // Starts with space and ends with space.
      (/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value) || // Starts or ends with dollar.
      /^\$|\$$/.test(value))
    ) {
      value = " " + value + " ";
    }
    let index2 = -1;
    while (++index2 < state.unsafe.length) {
      const pattern = state.unsafe[index2];
      if (!pattern.atBreak) continue;
      const expression = state.compilePattern(pattern);
      let match;
      while (match = expression.exec(value)) {
        let position2 = match.index;
        if (value.codePointAt(position2) === 10 && value.codePointAt(position2 - 1) === 13) {
          position2--;
        }
        value = value.slice(0, position2) + " " + value.slice(match.index + 1);
      }
    }
    return sequence + value + sequence;
  }
  __name(inlineMath, "inlineMath");
  function inlineMathPeek() {
    return "$";
  }
  __name(inlineMathPeek, "inlineMathPeek");
}
__name(mathToMarkdown, "mathToMarkdown");

// node_modules/micromark-extension-math/index.js
init_esbuild_shims();

// node_modules/micromark-extension-math/lib/syntax.js
init_esbuild_shims();

// node_modules/micromark-extension-math/lib/math-flow.js
init_esbuild_shims();
var mathFlow = {
  tokenize: tokenizeMathFenced,
  concrete: true,
  name: "mathFlow"
};
var nonLazyContinuation2 = {
  tokenize: tokenizeNonLazyContinuation2,
  partial: true
};
function tokenizeMathFenced(effects, ok3, nok) {
  const self = this;
  const tail = self.events[self.events.length - 1];
  const initialSize = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let sizeOpen = 0;
  return start;
  function start(code3) {
    effects.enter("mathFlow");
    effects.enter("mathFlowFence");
    effects.enter("mathFlowFenceSequence");
    return sequenceOpen(code3);
  }
  __name(start, "start");
  function sequenceOpen(code3) {
    if (code3 === 36) {
      effects.consume(code3);
      sizeOpen++;
      return sequenceOpen;
    }
    if (sizeOpen < 2) {
      return nok(code3);
    }
    effects.exit("mathFlowFenceSequence");
    return factorySpace(effects, metaBefore, "whitespace")(code3);
  }
  __name(sequenceOpen, "sequenceOpen");
  function metaBefore(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      return metaAfter(code3);
    }
    effects.enter("mathFlowFenceMeta");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return meta(code3);
  }
  __name(metaBefore, "metaBefore");
  function meta(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("chunkString");
      effects.exit("mathFlowFenceMeta");
      return metaAfter(code3);
    }
    if (code3 === 36) {
      return nok(code3);
    }
    effects.consume(code3);
    return meta;
  }
  __name(meta, "meta");
  function metaAfter(code3) {
    effects.exit("mathFlowFence");
    if (self.interrupt) {
      return ok3(code3);
    }
    return effects.attempt(nonLazyContinuation2, beforeNonLazyContinuation, after)(code3);
  }
  __name(metaAfter, "metaAfter");
  function beforeNonLazyContinuation(code3) {
    return effects.attempt({
      tokenize: tokenizeClosingFence,
      partial: true
    }, after, contentStart)(code3);
  }
  __name(beforeNonLazyContinuation, "beforeNonLazyContinuation");
  function contentStart(code3) {
    return (initialSize ? factorySpace(effects, beforeContentChunk, "linePrefix", initialSize + 1) : beforeContentChunk)(code3);
  }
  __name(contentStart, "contentStart");
  function beforeContentChunk(code3) {
    if (code3 === null) {
      return after(code3);
    }
    if (markdownLineEnding(code3)) {
      return effects.attempt(nonLazyContinuation2, beforeNonLazyContinuation, after)(code3);
    }
    effects.enter("mathFlowValue");
    return contentChunk(code3);
  }
  __name(beforeContentChunk, "beforeContentChunk");
  function contentChunk(code3) {
    if (code3 === null || markdownLineEnding(code3)) {
      effects.exit("mathFlowValue");
      return beforeContentChunk(code3);
    }
    effects.consume(code3);
    return contentChunk;
  }
  __name(contentChunk, "contentChunk");
  function after(code3) {
    effects.exit("mathFlow");
    return ok3(code3);
  }
  __name(after, "after");
  function tokenizeClosingFence(effects2, ok4, nok2) {
    let size = 0;
    return factorySpace(effects2, beforeSequenceClose, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
    function beforeSequenceClose(code3) {
      effects2.enter("mathFlowFence");
      effects2.enter("mathFlowFenceSequence");
      return sequenceClose(code3);
    }
    __name(beforeSequenceClose, "beforeSequenceClose");
    function sequenceClose(code3) {
      if (code3 === 36) {
        size++;
        effects2.consume(code3);
        return sequenceClose;
      }
      if (size < sizeOpen) {
        return nok2(code3);
      }
      effects2.exit("mathFlowFenceSequence");
      return factorySpace(effects2, afterSequenceClose, "whitespace")(code3);
    }
    __name(sequenceClose, "sequenceClose");
    function afterSequenceClose(code3) {
      if (code3 === null || markdownLineEnding(code3)) {
        effects2.exit("mathFlowFence");
        return ok4(code3);
      }
      return nok2(code3);
    }
    __name(afterSequenceClose, "afterSequenceClose");
  }
  __name(tokenizeClosingFence, "tokenizeClosingFence");
}
__name(tokenizeMathFenced, "tokenizeMathFenced");
function tokenizeNonLazyContinuation2(effects, ok3, nok) {
  const self = this;
  return start;
  function start(code3) {
    if (code3 === null) {
      return ok3(code3);
    }
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return lineStart;
  }
  __name(start, "start");
  function lineStart(code3) {
    return self.parser.lazy[self.now().line] ? nok(code3) : ok3(code3);
  }
  __name(lineStart, "lineStart");
}
__name(tokenizeNonLazyContinuation2, "tokenizeNonLazyContinuation");

// node_modules/micromark-extension-math/lib/math-text.js
init_esbuild_shims();
function mathText(options) {
  const options_ = options || {};
  let single = options_.singleDollarTextMath;
  if (single === null || single === void 0) {
    single = true;
  }
  return {
    tokenize: tokenizeMathText,
    resolve: resolveMathText,
    previous: previous3,
    name: "mathText"
  };
  function tokenizeMathText(effects, ok3, nok) {
    const self = this;
    let sizeOpen = 0;
    let size;
    let token;
    return start;
    function start(code3) {
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      return sequenceOpen(code3);
    }
    __name(start, "start");
    function sequenceOpen(code3) {
      if (code3 === 36) {
        effects.consume(code3);
        sizeOpen++;
        return sequenceOpen;
      }
      if (sizeOpen < 2 && !single) {
        return nok(code3);
      }
      effects.exit("mathTextSequence");
      return between(code3);
    }
    __name(sequenceOpen, "sequenceOpen");
    function between(code3) {
      if (code3 === null) {
        return nok(code3);
      }
      if (code3 === 36) {
        token = effects.enter("mathTextSequence");
        size = 0;
        return sequenceClose(code3);
      }
      if (code3 === 32) {
        effects.enter("space");
        effects.consume(code3);
        effects.exit("space");
        return between;
      }
      if (markdownLineEnding(code3)) {
        effects.enter("lineEnding");
        effects.consume(code3);
        effects.exit("lineEnding");
        return between;
      }
      effects.enter("mathTextData");
      return data(code3);
    }
    __name(between, "between");
    function data(code3) {
      if (code3 === null || code3 === 32 || code3 === 36 || markdownLineEnding(code3)) {
        effects.exit("mathTextData");
        return between(code3);
      }
      effects.consume(code3);
      return data;
    }
    __name(data, "data");
    function sequenceClose(code3) {
      if (code3 === 36) {
        effects.consume(code3);
        size++;
        return sequenceClose;
      }
      if (size === sizeOpen) {
        effects.exit("mathTextSequence");
        effects.exit("mathText");
        return ok3(code3);
      }
      token.type = "mathTextData";
      return data(code3);
    }
    __name(sequenceClose, "sequenceClose");
  }
  __name(tokenizeMathText, "tokenizeMathText");
}
__name(mathText, "mathText");
function resolveMathText(events) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index2;
  let enter;
  if ((events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") && (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")) {
    index2 = headEnterIndex;
    while (++index2 < tailExitIndex) {
      if (events[index2][1].type === "mathTextData") {
        events[tailExitIndex][1].type = "mathTextPadding";
        events[headEnterIndex][1].type = "mathTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }
  index2 = headEnterIndex - 1;
  tailExitIndex++;
  while (++index2 <= tailExitIndex) {
    if (enter === void 0) {
      if (index2 !== tailExitIndex && events[index2][1].type !== "lineEnding") {
        enter = index2;
      }
    } else if (index2 === tailExitIndex || events[index2][1].type === "lineEnding") {
      events[enter][1].type = "mathTextData";
      if (index2 !== enter + 2) {
        events[enter][1].end = events[index2 - 1][1].end;
        events.splice(enter + 2, index2 - enter - 2);
        tailExitIndex -= index2 - enter - 2;
        index2 = enter + 2;
      }
      enter = void 0;
    }
  }
  return events;
}
__name(resolveMathText, "resolveMathText");
function previous3(code3) {
  return code3 !== 36 || this.events[this.events.length - 1][1].type === "characterEscape";
}
__name(previous3, "previous");

// node_modules/micromark-extension-math/lib/syntax.js
function math(options) {
  return {
    flow: {
      [36]: mathFlow
    },
    text: {
      [36]: mathText(options)
    }
  };
}
__name(math, "math");

// node_modules/remark-math/lib/index.js
var emptyOptions3 = {};
function remarkMath(options) {
  const self = (
    /** @type {Processor} */
    this
  );
  const settings = options || emptyOptions3;
  const data = self.data();
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  micromarkExtensions.push(math(settings));
  fromMarkdownExtensions.push(mathFromMarkdown());
  toMarkdownExtensions.push(mathToMarkdown(settings));
}
__name(remarkMath, "remarkMath");

// node_modules/remark-parse/index.js
init_esbuild_shims();

// node_modules/remark-parse/lib/index.js
init_esbuild_shims();

// node_modules/mdast-util-from-markdown/index.js
init_esbuild_shims();

// node_modules/mdast-util-from-markdown/lib/index.js
init_esbuild_shims();

// node_modules/micromark/index.js
init_esbuild_shims();

// node_modules/micromark/lib/parse.js
init_esbuild_shims();

// node_modules/micromark/lib/initialize/content.js
init_esbuild_shims();
var content2 = {
  tokenize: initializeContent
};
function initializeContent(effects) {
  const contentStart = effects.attempt(this.parser.constructs.contentInitial, afterContentStartConstruct, paragraphInitial);
  let previous4;
  return contentStart;
  function afterContentStartConstruct(code3) {
    if (code3 === null) {
      effects.consume(code3);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    return factorySpace(effects, contentStart, "linePrefix");
  }
  __name(afterContentStartConstruct, "afterContentStartConstruct");
  function paragraphInitial(code3) {
    effects.enter("paragraph");
    return lineStart(code3);
  }
  __name(paragraphInitial, "paragraphInitial");
  function lineStart(code3) {
    const token = effects.enter("chunkText", {
      contentType: "text",
      previous: previous4
    });
    if (previous4) {
      previous4.next = token;
    }
    previous4 = token;
    return data(code3);
  }
  __name(lineStart, "lineStart");
  function data(code3) {
    if (code3 === null) {
      effects.exit("chunkText");
      effects.exit("paragraph");
      effects.consume(code3);
      return;
    }
    if (markdownLineEnding(code3)) {
      effects.consume(code3);
      effects.exit("chunkText");
      return lineStart;
    }
    effects.consume(code3);
    return data;
  }
  __name(data, "data");
}
__name(initializeContent, "initializeContent");

// node_modules/micromark/lib/initialize/document.js
init_esbuild_shims();
var document = {
  tokenize: initializeDocument
};
var containerConstruct = {
  tokenize: tokenizeContainer
};
function initializeDocument(effects) {
  const self = this;
  const stack = [];
  let continued = 0;
  let childFlow;
  let childToken;
  let lineStartOffset;
  return start;
  function start(code3) {
    if (continued < stack.length) {
      const item = stack[continued];
      self.containerState = item[1];
      return effects.attempt(item[0].continuation, documentContinue, checkNewContainers)(code3);
    }
    return checkNewContainers(code3);
  }
  __name(start, "start");
  function documentContinue(code3) {
    continued++;
    if (self.containerState._closeFlow) {
      self.containerState._closeFlow = void 0;
      if (childFlow) {
        closeFlow();
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          point3 = self.events[indexBeforeFlow][1].end;
          break;
        }
      }
      exitContainers(continued);
      let index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      splice(self.events, indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      self.events.length = index2;
      return checkNewContainers(code3);
    }
    return start(code3);
  }
  __name(documentContinue, "documentContinue");
  function checkNewContainers(code3) {
    if (continued === stack.length) {
      if (!childFlow) {
        return documentContinued(code3);
      }
      if (childFlow.currentConstruct && childFlow.currentConstruct.concrete) {
        return flowStart(code3);
      }
      self.interrupt = Boolean(childFlow.currentConstruct && !childFlow._gfmTableDynamicInterruptHack);
    }
    self.containerState = {};
    return effects.check(containerConstruct, thereIsANewContainer, thereIsNoNewContainer)(code3);
  }
  __name(checkNewContainers, "checkNewContainers");
  function thereIsANewContainer(code3) {
    if (childFlow) closeFlow();
    exitContainers(continued);
    return documentContinued(code3);
  }
  __name(thereIsANewContainer, "thereIsANewContainer");
  function thereIsNoNewContainer(code3) {
    self.parser.lazy[self.now().line] = continued !== stack.length;
    lineStartOffset = self.now().offset;
    return flowStart(code3);
  }
  __name(thereIsNoNewContainer, "thereIsNoNewContainer");
  function documentContinued(code3) {
    self.containerState = {};
    return effects.attempt(containerConstruct, containerContinue, flowStart)(code3);
  }
  __name(documentContinued, "documentContinued");
  function containerContinue(code3) {
    continued++;
    stack.push([self.currentConstruct, self.containerState]);
    return documentContinued(code3);
  }
  __name(containerContinue, "containerContinue");
  function flowStart(code3) {
    if (code3 === null) {
      if (childFlow) closeFlow();
      exitContainers(0);
      effects.consume(code3);
      return;
    }
    childFlow = childFlow || self.parser.flow(self.now());
    effects.enter("chunkFlow", {
      _tokenizer: childFlow,
      contentType: "flow",
      previous: childToken
    });
    return flowContinue(code3);
  }
  __name(flowStart, "flowStart");
  function flowContinue(code3) {
    if (code3 === null) {
      writeToChild(effects.exit("chunkFlow"), true);
      exitContainers(0);
      effects.consume(code3);
      return;
    }
    if (markdownLineEnding(code3)) {
      effects.consume(code3);
      writeToChild(effects.exit("chunkFlow"));
      continued = 0;
      self.interrupt = void 0;
      return start;
    }
    effects.consume(code3);
    return flowContinue;
  }
  __name(flowContinue, "flowContinue");
  function writeToChild(token, endOfFile) {
    const stream = self.sliceStream(token);
    if (endOfFile) stream.push(null);
    token.previous = childToken;
    if (childToken) childToken.next = token;
    childToken = token;
    childFlow.defineSkip(token.start);
    childFlow.write(stream);
    if (self.parser.lazy[token.start.line]) {
      let index2 = childFlow.events.length;
      while (index2--) {
        if (
          // The token starts before the line ending…
          childFlow.events[index2][1].start.offset < lineStartOffset && // …and either is not ended yet…
          (!childFlow.events[index2][1].end || // …or ends after it.
          childFlow.events[index2][1].end.offset > lineStartOffset)
        ) {
          return;
        }
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let seen;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          if (seen) {
            point3 = self.events[indexBeforeFlow][1].end;
            break;
          }
          seen = true;
        }
      }
      exitContainers(continued);
      index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      splice(self.events, indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      self.events.length = index2;
    }
  }
  __name(writeToChild, "writeToChild");
  function exitContainers(size) {
    let index2 = stack.length;
    while (index2-- > size) {
      const entry = stack[index2];
      self.containerState = entry[1];
      entry[0].exit.call(self, effects);
    }
    stack.length = size;
  }
  __name(exitContainers, "exitContainers");
  function closeFlow() {
    childFlow.write([null]);
    childToken = void 0;
    childFlow = void 0;
    self.containerState._closeFlow = void 0;
  }
  __name(closeFlow, "closeFlow");
}
__name(initializeDocument, "initializeDocument");
function tokenizeContainer(effects, ok3, nok) {
  return factorySpace(effects, effects.attempt(this.parser.constructs.document, ok3, nok), "linePrefix", this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
}
__name(tokenizeContainer, "tokenizeContainer");

// node_modules/micromark/lib/initialize/flow.js
init_esbuild_shims();
var flow = {
  tokenize: initializeFlow
};
function initializeFlow(effects) {
  const self = this;
  const initial = effects.attempt(
    // Try to parse a blank line.
    blankLine,
    atBlankEnding,
    // Try to parse initial flow (essentially, only code).
    effects.attempt(this.parser.constructs.flowInitial, afterConstruct, factorySpace(effects, effects.attempt(this.parser.constructs.flow, afterConstruct, effects.attempt(content, afterConstruct)), "linePrefix"))
  );
  return initial;
  function atBlankEnding(code3) {
    if (code3 === null) {
      effects.consume(code3);
      return;
    }
    effects.enter("lineEndingBlank");
    effects.consume(code3);
    effects.exit("lineEndingBlank");
    self.currentConstruct = void 0;
    return initial;
  }
  __name(atBlankEnding, "atBlankEnding");
  function afterConstruct(code3) {
    if (code3 === null) {
      effects.consume(code3);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code3);
    effects.exit("lineEnding");
    self.currentConstruct = void 0;
    return initial;
  }
  __name(afterConstruct, "afterConstruct");
}
__name(initializeFlow, "initializeFlow");

// node_modules/micromark/lib/initialize/text.js
init_esbuild_shims();
var resolver = {
  resolveAll: createResolver()
};
var string = initializeFactory("string");
var text3 = initializeFactory("text");
function initializeFactory(field) {
  return {
    resolveAll: createResolver(field === "text" ? resolveAllLineSuffixes : void 0),
    tokenize: initializeText
  };
  function initializeText(effects) {
    const self = this;
    const constructs2 = this.parser.constructs[field];
    const text5 = effects.attempt(constructs2, start, notText);
    return start;
    function start(code3) {
      return atBreak(code3) ? text5(code3) : notText(code3);
    }
    __name(start, "start");
    function notText(code3) {
      if (code3 === null) {
        effects.consume(code3);
        return;
      }
      effects.enter("data");
      effects.consume(code3);
      return data;
    }
    __name(notText, "notText");
    function data(code3) {
      if (atBreak(code3)) {
        effects.exit("data");
        return text5(code3);
      }
      effects.consume(code3);
      return data;
    }
    __name(data, "data");
    function atBreak(code3) {
      if (code3 === null) {
        return true;
      }
      const list3 = constructs2[code3];
      let index2 = -1;
      if (list3) {
        while (++index2 < list3.length) {
          const item = list3[index2];
          if (!item.previous || item.previous.call(self, self.previous)) {
            return true;
          }
        }
      }
      return false;
    }
    __name(atBreak, "atBreak");
  }
  __name(initializeText, "initializeText");
}
__name(initializeFactory, "initializeFactory");
function createResolver(extraResolver) {
  return resolveAllText;
  function resolveAllText(events, context) {
    let index2 = -1;
    let enter;
    while (++index2 <= events.length) {
      if (enter === void 0) {
        if (events[index2] && events[index2][1].type === "data") {
          enter = index2;
          index2++;
        }
      } else if (!events[index2] || events[index2][1].type !== "data") {
        if (index2 !== enter + 2) {
          events[enter][1].end = events[index2 - 1][1].end;
          events.splice(enter + 2, index2 - enter - 2);
          index2 = enter + 2;
        }
        enter = void 0;
      }
    }
    return extraResolver ? extraResolver(events, context) : events;
  }
  __name(resolveAllText, "resolveAllText");
}
__name(createResolver, "createResolver");
function resolveAllLineSuffixes(events, context) {
  let eventIndex = 0;
  while (++eventIndex <= events.length) {
    if ((eventIndex === events.length || events[eventIndex][1].type === "lineEnding") && events[eventIndex - 1][1].type === "data") {
      const data = events[eventIndex - 1][1];
      const chunks = context.sliceStream(data);
      let index2 = chunks.length;
      let bufferIndex = -1;
      let size = 0;
      let tabs;
      while (index2--) {
        const chunk = chunks[index2];
        if (typeof chunk === "string") {
          bufferIndex = chunk.length;
          while (chunk.charCodeAt(bufferIndex - 1) === 32) {
            size++;
            bufferIndex--;
          }
          if (bufferIndex) break;
          bufferIndex = -1;
        } else if (chunk === -2) {
          tabs = true;
          size++;
        } else if (chunk === -1) {
        } else {
          index2++;
          break;
        }
      }
      if (context._contentTypeTextTrailing && eventIndex === events.length) {
        size = 0;
      }
      if (size) {
        const token = {
          type: eventIndex === events.length || tabs || size < 2 ? "lineSuffix" : "hardBreakTrailing",
          start: {
            _bufferIndex: index2 ? bufferIndex : data.start._bufferIndex + bufferIndex,
            _index: data.start._index + index2,
            line: data.end.line,
            column: data.end.column - size,
            offset: data.end.offset - size
          },
          end: {
            ...data.end
          }
        };
        data.end = {
          ...token.start
        };
        if (data.start.offset === data.end.offset) {
          Object.assign(data, token);
        } else {
          events.splice(eventIndex, 0, ["enter", token, context], ["exit", token, context]);
          eventIndex += 2;
        }
      }
      eventIndex++;
    }
  }
  return events;
}
__name(resolveAllLineSuffixes, "resolveAllLineSuffixes");

// node_modules/micromark/lib/constructs.js
var constructs_exports = {};
__export(constructs_exports, {
  attentionMarkers: () => attentionMarkers,
  contentInitial: () => contentInitial,
  disable: () => disable,
  document: () => document2,
  flow: () => flow2,
  flowInitial: () => flowInitial,
  insideSpan: () => insideSpan,
  string: () => string2,
  text: () => text4
});
init_esbuild_shims();
var document2 = {
  [42]: list2,
  [43]: list2,
  [45]: list2,
  [48]: list2,
  [49]: list2,
  [50]: list2,
  [51]: list2,
  [52]: list2,
  [53]: list2,
  [54]: list2,
  [55]: list2,
  [56]: list2,
  [57]: list2,
  [62]: blockQuote
};
var contentInitial = {
  [91]: definition2
};
var flowInitial = {
  [-2]: codeIndented,
  [-1]: codeIndented,
  [32]: codeIndented
};
var flow2 = {
  [35]: headingAtx,
  [42]: thematicBreak2,
  [45]: [setextUnderline, thematicBreak2],
  [60]: htmlFlow,
  [61]: setextUnderline,
  [95]: thematicBreak2,
  [96]: codeFenced,
  [126]: codeFenced
};
var string2 = {
  [38]: characterReference,
  [92]: characterEscape
};
var text4 = {
  [-5]: lineEnding,
  [-4]: lineEnding,
  [-3]: lineEnding,
  [33]: labelStartImage,
  [38]: characterReference,
  [42]: attention,
  [60]: [autolink, htmlText],
  [91]: labelStartLink,
  [92]: [hardBreakEscape, characterEscape],
  [93]: labelEnd,
  [95]: attention,
  [96]: codeText
};
var insideSpan = {
  null: [attention, resolver]
};
var attentionMarkers = {
  null: [42, 95]
};
var disable = {
  null: []
};

// node_modules/micromark/lib/create-tokenizer.js
init_esbuild_shims();
function createTokenizer(parser, initialize, from) {
  let point3 = {
    _bufferIndex: -1,
    _index: 0,
    line: from && from.line || 1,
    column: from && from.column || 1,
    offset: from && from.offset || 0
  };
  const columnStart = {};
  const resolveAllConstructs = [];
  let chunks = [];
  let stack = [];
  let consumed = true;
  const effects = {
    attempt: constructFactory(onsuccessfulconstruct),
    check: constructFactory(onsuccessfulcheck),
    consume,
    enter,
    exit: exit3,
    interrupt: constructFactory(onsuccessfulcheck, {
      interrupt: true
    })
  };
  const context = {
    code: null,
    containerState: {},
    defineSkip,
    events: [],
    now,
    parser,
    previous: null,
    sliceSerialize,
    sliceStream,
    write
  };
  let state = initialize.tokenize.call(context, effects);
  let expectedCode;
  if (initialize.resolveAll) {
    resolveAllConstructs.push(initialize);
  }
  return context;
  function write(slice) {
    chunks = push(chunks, slice);
    main();
    if (chunks[chunks.length - 1] !== null) {
      return [];
    }
    addResult(initialize, 0);
    context.events = resolveAll(resolveAllConstructs, context.events, context);
    return context.events;
  }
  __name(write, "write");
  function sliceSerialize(token, expandTabs) {
    return serializeChunks(sliceStream(token), expandTabs);
  }
  __name(sliceSerialize, "sliceSerialize");
  function sliceStream(token) {
    return sliceChunks(chunks, token);
  }
  __name(sliceStream, "sliceStream");
  function now() {
    const {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    } = point3;
    return {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    };
  }
  __name(now, "now");
  function defineSkip(value) {
    columnStart[value.line] = value.column;
    accountForPotentialSkip();
  }
  __name(defineSkip, "defineSkip");
  function main() {
    let chunkIndex;
    while (point3._index < chunks.length) {
      const chunk = chunks[point3._index];
      if (typeof chunk === "string") {
        chunkIndex = point3._index;
        if (point3._bufferIndex < 0) {
          point3._bufferIndex = 0;
        }
        while (point3._index === chunkIndex && point3._bufferIndex < chunk.length) {
          go(chunk.charCodeAt(point3._bufferIndex));
        }
      } else {
        go(chunk);
      }
    }
  }
  __name(main, "main");
  function go(code3) {
    consumed = void 0;
    expectedCode = code3;
    state = state(code3);
  }
  __name(go, "go");
  function consume(code3) {
    if (markdownLineEnding(code3)) {
      point3.line++;
      point3.column = 1;
      point3.offset += code3 === -3 ? 2 : 1;
      accountForPotentialSkip();
    } else if (code3 !== -1) {
      point3.column++;
      point3.offset++;
    }
    if (point3._bufferIndex < 0) {
      point3._index++;
    } else {
      point3._bufferIndex++;
      if (point3._bufferIndex === // Points w/ non-negative `_bufferIndex` reference
      // strings.
      /** @type {string} */
      chunks[point3._index].length) {
        point3._bufferIndex = -1;
        point3._index++;
      }
    }
    context.previous = code3;
    consumed = true;
  }
  __name(consume, "consume");
  function enter(type, fields) {
    const token = fields || {};
    token.type = type;
    token.start = now();
    context.events.push(["enter", token, context]);
    stack.push(token);
    return token;
  }
  __name(enter, "enter");
  function exit3(type) {
    const token = stack.pop();
    token.end = now();
    context.events.push(["exit", token, context]);
    return token;
  }
  __name(exit3, "exit");
  function onsuccessfulconstruct(construct, info) {
    addResult(construct, info.from);
  }
  __name(onsuccessfulconstruct, "onsuccessfulconstruct");
  function onsuccessfulcheck(_, info) {
    info.restore();
  }
  __name(onsuccessfulcheck, "onsuccessfulcheck");
  function constructFactory(onreturn, fields) {
    return hook;
    function hook(constructs2, returnState, bogusState) {
      let listOfConstructs;
      let constructIndex;
      let currentConstruct;
      let info;
      return Array.isArray(constructs2) ? (
        /* c8 ignore next 1 */
        handleListOfConstructs(constructs2)
      ) : "tokenize" in constructs2 ? (
        // Looks like a construct.
        handleListOfConstructs([
          /** @type {Construct} */
          constructs2
        ])
      ) : handleMapOfConstructs(constructs2);
      function handleMapOfConstructs(map3) {
        return start;
        function start(code3) {
          const left = code3 !== null && map3[code3];
          const all2 = code3 !== null && map3.null;
          const list3 = [
            // To do: add more extension tests.
            /* c8 ignore next 2 */
            ...Array.isArray(left) ? left : left ? [left] : [],
            ...Array.isArray(all2) ? all2 : all2 ? [all2] : []
          ];
          return handleListOfConstructs(list3)(code3);
        }
        __name(start, "start");
      }
      __name(handleMapOfConstructs, "handleMapOfConstructs");
      function handleListOfConstructs(list3) {
        listOfConstructs = list3;
        constructIndex = 0;
        if (list3.length === 0) {
          return bogusState;
        }
        return handleConstruct(list3[constructIndex]);
      }
      __name(handleListOfConstructs, "handleListOfConstructs");
      function handleConstruct(construct) {
        return start;
        function start(code3) {
          info = store();
          currentConstruct = construct;
          if (!construct.partial) {
            context.currentConstruct = construct;
          }
          if (construct.name && context.parser.constructs.disable.null.includes(construct.name)) {
            return nok(code3);
          }
          return construct.tokenize.call(
            // If we do have fields, create an object w/ `context` as its
            // prototype.
            // This allows a “live binding”, which is needed for `interrupt`.
            fields ? Object.assign(Object.create(context), fields) : context,
            effects,
            ok3,
            nok
          )(code3);
        }
        __name(start, "start");
      }
      __name(handleConstruct, "handleConstruct");
      function ok3(code3) {
        consumed = true;
        onreturn(currentConstruct, info);
        return returnState;
      }
      __name(ok3, "ok");
      function nok(code3) {
        consumed = true;
        info.restore();
        if (++constructIndex < listOfConstructs.length) {
          return handleConstruct(listOfConstructs[constructIndex]);
        }
        return bogusState;
      }
      __name(nok, "nok");
    }
    __name(hook, "hook");
  }
  __name(constructFactory, "constructFactory");
  function addResult(construct, from2) {
    if (construct.resolveAll && !resolveAllConstructs.includes(construct)) {
      resolveAllConstructs.push(construct);
    }
    if (construct.resolve) {
      splice(context.events, from2, context.events.length - from2, construct.resolve(context.events.slice(from2), context));
    }
    if (construct.resolveTo) {
      context.events = construct.resolveTo(context.events, context);
    }
  }
  __name(addResult, "addResult");
  function store() {
    const startPoint = now();
    const startPrevious = context.previous;
    const startCurrentConstruct = context.currentConstruct;
    const startEventsIndex = context.events.length;
    const startStack = Array.from(stack);
    return {
      from: startEventsIndex,
      restore
    };
    function restore() {
      point3 = startPoint;
      context.previous = startPrevious;
      context.currentConstruct = startCurrentConstruct;
      context.events.length = startEventsIndex;
      stack = startStack;
      accountForPotentialSkip();
    }
    __name(restore, "restore");
  }
  __name(store, "store");
  function accountForPotentialSkip() {
    if (point3.line in columnStart && point3.column < 2) {
      point3.column = columnStart[point3.line];
      point3.offset += columnStart[point3.line] - 1;
    }
  }
  __name(accountForPotentialSkip, "accountForPotentialSkip");
}
__name(createTokenizer, "createTokenizer");
function sliceChunks(chunks, token) {
  const startIndex = token.start._index;
  const startBufferIndex = token.start._bufferIndex;
  const endIndex = token.end._index;
  const endBufferIndex = token.end._bufferIndex;
  let view;
  if (startIndex === endIndex) {
    view = [chunks[startIndex].slice(startBufferIndex, endBufferIndex)];
  } else {
    view = chunks.slice(startIndex, endIndex);
    if (startBufferIndex > -1) {
      const head = view[0];
      if (typeof head === "string") {
        view[0] = head.slice(startBufferIndex);
      } else {
        view.shift();
      }
    }
    if (endBufferIndex > 0) {
      view.push(chunks[endIndex].slice(0, endBufferIndex));
    }
  }
  return view;
}
__name(sliceChunks, "sliceChunks");
function serializeChunks(chunks, expandTabs) {
  let index2 = -1;
  const result = [];
  let atTab;
  while (++index2 < chunks.length) {
    const chunk = chunks[index2];
    let value;
    if (typeof chunk === "string") {
      value = chunk;
    } else switch (chunk) {
      case -5: {
        value = "\r";
        break;
      }
      case -4: {
        value = "\n";
        break;
      }
      case -3: {
        value = "\r\n";
        break;
      }
      case -2: {
        value = expandTabs ? " " : "	";
        break;
      }
      case -1: {
        if (!expandTabs && atTab) continue;
        value = " ";
        break;
      }
      default: {
        value = String.fromCharCode(chunk);
      }
    }
    atTab = chunk === -2;
    result.push(value);
  }
  return result.join("");
}
__name(serializeChunks, "serializeChunks");

// node_modules/micromark/lib/parse.js
function parse(options) {
  const settings = options || {};
  const constructs2 = (
    /** @type {FullNormalizedExtension} */
    combineExtensions([constructs_exports, ...settings.extensions || []])
  );
  const parser = {
    constructs: constructs2,
    content: create(content2),
    defined: [],
    document: create(document),
    flow: create(flow),
    lazy: {},
    string: create(string),
    text: create(text3)
  };
  return parser;
  function create(initial) {
    return creator;
    function creator(from) {
      return createTokenizer(parser, initial, from);
    }
    __name(creator, "creator");
  }
  __name(create, "create");
}
__name(parse, "parse");

// node_modules/micromark/lib/postprocess.js
init_esbuild_shims();
function postprocess(events) {
  while (!subtokenize(events)) {
  }
  return events;
}
__name(postprocess, "postprocess");

// node_modules/micromark/lib/preprocess.js
init_esbuild_shims();
var search = /[\0\t\n\r]/g;
function preprocess() {
  let column = 1;
  let buffer = "";
  let start = true;
  let atCarriageReturn;
  return preprocessor;
  function preprocessor(value, encoding, end) {
    const chunks = [];
    let match;
    let next;
    let startPosition;
    let endPosition;
    let code3;
    value = buffer + (typeof value === "string" ? value.toString() : new TextDecoder(encoding || void 0).decode(value));
    startPosition = 0;
    buffer = "";
    if (start) {
      if (value.charCodeAt(0) === 65279) {
        startPosition++;
      }
      start = void 0;
    }
    while (startPosition < value.length) {
      search.lastIndex = startPosition;
      match = search.exec(value);
      endPosition = match && match.index !== void 0 ? match.index : value.length;
      code3 = value.charCodeAt(endPosition);
      if (!match) {
        buffer = value.slice(startPosition);
        break;
      }
      if (code3 === 10 && startPosition === endPosition && atCarriageReturn) {
        chunks.push(-3);
        atCarriageReturn = void 0;
      } else {
        if (atCarriageReturn) {
          chunks.push(-5);
          atCarriageReturn = void 0;
        }
        if (startPosition < endPosition) {
          chunks.push(value.slice(startPosition, endPosition));
          column += endPosition - startPosition;
        }
        switch (code3) {
          case 0: {
            chunks.push(65533);
            column++;
            break;
          }
          case 9: {
            next = Math.ceil(column / 4) * 4;
            chunks.push(-2);
            while (column++ < next) chunks.push(-1);
            break;
          }
          case 10: {
            chunks.push(-4);
            column = 1;
            break;
          }
          default: {
            atCarriageReturn = true;
            column = 1;
          }
        }
      }
      startPosition = endPosition + 1;
    }
    if (end) {
      if (atCarriageReturn) chunks.push(-5);
      if (buffer) chunks.push(buffer);
      chunks.push(null);
    }
    return chunks;
  }
  __name(preprocessor, "preprocessor");
}
__name(preprocess, "preprocess");

// node_modules/mdast-util-from-markdown/lib/index.js
var own3 = {}.hasOwnProperty;
function fromMarkdown(value, encoding, options) {
  if (encoding && typeof encoding === "object") {
    options = encoding;
    encoding = void 0;
  }
  return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));
}
__name(fromMarkdown, "fromMarkdown");
function compiler(options) {
  const config = {
    transforms: [],
    canContainEols: ["emphasis", "fragment", "heading", "paragraph", "strong"],
    enter: {
      autolink: opener(link2),
      autolinkProtocol: onenterdata,
      autolinkEmail: onenterdata,
      atxHeading: opener(heading2),
      blockQuote: opener(blockQuote2),
      characterEscape: onenterdata,
      characterReference: onenterdata,
      codeFenced: opener(codeFlow),
      codeFencedFenceInfo: buffer,
      codeFencedFenceMeta: buffer,
      codeIndented: opener(codeFlow, buffer),
      codeText: opener(codeText2, buffer),
      codeTextData: onenterdata,
      data: onenterdata,
      codeFlowValue: onenterdata,
      definition: opener(definition3),
      definitionDestinationString: buffer,
      definitionLabelString: buffer,
      definitionTitleString: buffer,
      emphasis: opener(emphasis2),
      hardBreakEscape: opener(hardBreak2),
      hardBreakTrailing: opener(hardBreak2),
      htmlFlow: opener(html2, buffer),
      htmlFlowData: onenterdata,
      htmlText: opener(html2, buffer),
      htmlTextData: onenterdata,
      image: opener(image2),
      label: buffer,
      link: opener(link2),
      listItem: opener(listItem2),
      listItemValue: onenterlistitemvalue,
      listOrdered: opener(list3, onenterlistordered),
      listUnordered: opener(list3),
      paragraph: opener(paragraph2),
      reference: onenterreference,
      referenceString: buffer,
      resourceDestinationString: buffer,
      resourceTitleString: buffer,
      setextHeading: opener(heading2),
      strong: opener(strong2),
      thematicBreak: opener(thematicBreak3)
    },
    exit: {
      atxHeading: closer(),
      atxHeadingSequence: onexitatxheadingsequence,
      autolink: closer(),
      autolinkEmail: onexitautolinkemail,
      autolinkProtocol: onexitautolinkprotocol,
      blockQuote: closer(),
      characterEscapeValue: onexitdata,
      characterReferenceMarkerHexadecimal: onexitcharacterreferencemarker,
      characterReferenceMarkerNumeric: onexitcharacterreferencemarker,
      characterReferenceValue: onexitcharacterreferencevalue,
      characterReference: onexitcharacterreference,
      codeFenced: closer(onexitcodefenced),
      codeFencedFence: onexitcodefencedfence,
      codeFencedFenceInfo: onexitcodefencedfenceinfo,
      codeFencedFenceMeta: onexitcodefencedfencemeta,
      codeFlowValue: onexitdata,
      codeIndented: closer(onexitcodeindented),
      codeText: closer(onexitcodetext),
      codeTextData: onexitdata,
      data: onexitdata,
      definition: closer(),
      definitionDestinationString: onexitdefinitiondestinationstring,
      definitionLabelString: onexitdefinitionlabelstring,
      definitionTitleString: onexitdefinitiontitlestring,
      emphasis: closer(),
      hardBreakEscape: closer(onexithardbreak),
      hardBreakTrailing: closer(onexithardbreak),
      htmlFlow: closer(onexithtmlflow),
      htmlFlowData: onexitdata,
      htmlText: closer(onexithtmltext),
      htmlTextData: onexitdata,
      image: closer(onexitimage),
      label: onexitlabel,
      labelText: onexitlabeltext,
      lineEnding: onexitlineending,
      link: closer(onexitlink),
      listItem: closer(),
      listOrdered: closer(),
      listUnordered: closer(),
      paragraph: closer(),
      referenceString: onexitreferencestring,
      resourceDestinationString: onexitresourcedestinationstring,
      resourceTitleString: onexitresourcetitlestring,
      resource: onexitresource,
      setextHeading: closer(onexitsetextheading),
      setextHeadingLineSequence: onexitsetextheadinglinesequence,
      setextHeadingText: onexitsetextheadingtext,
      strong: closer(),
      thematicBreak: closer()
    }
  };
  configure(config, (options || {}).mdastExtensions || []);
  const data = {};
  return compile;
  function compile(events) {
    let tree = {
      type: "root",
      children: []
    };
    const context = {
      stack: [tree],
      tokenStack: [],
      config,
      enter,
      exit: exit3,
      buffer,
      resume,
      data
    };
    const listStack = [];
    let index2 = -1;
    while (++index2 < events.length) {
      if (events[index2][1].type === "listOrdered" || events[index2][1].type === "listUnordered") {
        if (events[index2][0] === "enter") {
          listStack.push(index2);
        } else {
          const tail = listStack.pop();
          index2 = prepareList(events, tail, index2);
        }
      }
    }
    index2 = -1;
    while (++index2 < events.length) {
      const handler = config[events[index2][0]];
      if (own3.call(handler, events[index2][1].type)) {
        handler[events[index2][1].type].call(Object.assign({
          sliceSerialize: events[index2][2].sliceSerialize
        }, context), events[index2][1]);
      }
    }
    if (context.tokenStack.length > 0) {
      const tail = context.tokenStack[context.tokenStack.length - 1];
      const handler = tail[1] || defaultOnError;
      handler.call(context, void 0, tail[0]);
    }
    tree.position = {
      start: point2(events.length > 0 ? events[0][1].start : {
        line: 1,
        column: 1,
        offset: 0
      }),
      end: point2(events.length > 0 ? events[events.length - 2][1].end : {
        line: 1,
        column: 1,
        offset: 0
      })
    };
    index2 = -1;
    while (++index2 < config.transforms.length) {
      tree = config.transforms[index2](tree) || tree;
    }
    return tree;
  }
  __name(compile, "compile");
  function prepareList(events, start, length) {
    let index2 = start - 1;
    let containerBalance = -1;
    let listSpread = false;
    let listItem3;
    let lineIndex;
    let firstBlankLineIndex;
    let atMarker;
    while (++index2 <= length) {
      const event = events[index2];
      switch (event[1].type) {
        case "listUnordered":
        case "listOrdered":
        case "blockQuote": {
          if (event[0] === "enter") {
            containerBalance++;
          } else {
            containerBalance--;
          }
          atMarker = void 0;
          break;
        }
        case "lineEndingBlank": {
          if (event[0] === "enter") {
            if (listItem3 && !atMarker && !containerBalance && !firstBlankLineIndex) {
              firstBlankLineIndex = index2;
            }
            atMarker = void 0;
          }
          break;
        }
        case "linePrefix":
        case "listItemValue":
        case "listItemMarker":
        case "listItemPrefix":
        case "listItemPrefixWhitespace": {
          break;
        }
        default: {
          atMarker = void 0;
        }
      }
      if (!containerBalance && event[0] === "enter" && event[1].type === "listItemPrefix" || containerBalance === -1 && event[0] === "exit" && (event[1].type === "listUnordered" || event[1].type === "listOrdered")) {
        if (listItem3) {
          let tailIndex = index2;
          lineIndex = void 0;
          while (tailIndex--) {
            const tailEvent = events[tailIndex];
            if (tailEvent[1].type === "lineEnding" || tailEvent[1].type === "lineEndingBlank") {
              if (tailEvent[0] === "exit") continue;
              if (lineIndex) {
                events[lineIndex][1].type = "lineEndingBlank";
                listSpread = true;
              }
              tailEvent[1].type = "lineEnding";
              lineIndex = tailIndex;
            } else if (tailEvent[1].type === "linePrefix" || tailEvent[1].type === "blockQuotePrefix" || tailEvent[1].type === "blockQuotePrefixWhitespace" || tailEvent[1].type === "blockQuoteMarker" || tailEvent[1].type === "listItemIndent") {
            } else {
              break;
            }
          }
          if (firstBlankLineIndex && (!lineIndex || firstBlankLineIndex < lineIndex)) {
            listItem3._spread = true;
          }
          listItem3.end = Object.assign({}, lineIndex ? events[lineIndex][1].start : event[1].end);
          events.splice(lineIndex || index2, 0, ["exit", listItem3, event[2]]);
          index2++;
          length++;
        }
        if (event[1].type === "listItemPrefix") {
          const item = {
            type: "listItem",
            _spread: false,
            start: Object.assign({}, event[1].start),
            // @ts-expect-error: we’ll add `end` in a second.
            end: void 0
          };
          listItem3 = item;
          events.splice(index2, 0, ["enter", item, event[2]]);
          index2++;
          length++;
          firstBlankLineIndex = void 0;
          atMarker = true;
        }
      }
    }
    events[start][1]._spread = listSpread;
    return length;
  }
  __name(prepareList, "prepareList");
  function opener(create, and) {
    return open;
    function open(token) {
      enter.call(this, create(token), token);
      if (and) and.call(this, token);
    }
    __name(open, "open");
  }
  __name(opener, "opener");
  function buffer() {
    this.stack.push({
      type: "fragment",
      children: []
    });
  }
  __name(buffer, "buffer");
  function enter(node2, token, errorHandler) {
    const parent = this.stack[this.stack.length - 1];
    const siblings = parent.children;
    siblings.push(node2);
    this.stack.push(node2);
    this.tokenStack.push([token, errorHandler || void 0]);
    node2.position = {
      start: point2(token.start),
      // @ts-expect-error: `end` will be patched later.
      end: void 0
    };
  }
  __name(enter, "enter");
  function closer(and) {
    return close;
    function close(token) {
      if (and) and.call(this, token);
      exit3.call(this, token);
    }
    __name(close, "close");
  }
  __name(closer, "closer");
  function exit3(token, onExitError) {
    const node2 = this.stack.pop();
    const open = this.tokenStack.pop();
    if (!open) {
      throw new Error("Cannot close `" + token.type + "` (" + stringifyPosition({
        start: token.start,
        end: token.end
      }) + "): it\u2019s not open");
    } else if (open[0].type !== token.type) {
      if (onExitError) {
        onExitError.call(this, token, open[0]);
      } else {
        const handler = open[1] || defaultOnError;
        handler.call(this, token, open[0]);
      }
    }
    node2.position.end = point2(token.end);
  }
  __name(exit3, "exit");
  function resume() {
    return toString(this.stack.pop());
  }
  __name(resume, "resume");
  function onenterlistordered() {
    this.data.expectingFirstListItemValue = true;
  }
  __name(onenterlistordered, "onenterlistordered");
  function onenterlistitemvalue(token) {
    if (this.data.expectingFirstListItemValue) {
      const ancestor = this.stack[this.stack.length - 2];
      ancestor.start = Number.parseInt(this.sliceSerialize(token), 10);
      this.data.expectingFirstListItemValue = void 0;
    }
  }
  __name(onenterlistitemvalue, "onenterlistitemvalue");
  function onexitcodefencedfenceinfo() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.lang = data2;
  }
  __name(onexitcodefencedfenceinfo, "onexitcodefencedfenceinfo");
  function onexitcodefencedfencemeta() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.meta = data2;
  }
  __name(onexitcodefencedfencemeta, "onexitcodefencedfencemeta");
  function onexitcodefencedfence() {
    if (this.data.flowCodeInside) return;
    this.buffer();
    this.data.flowCodeInside = true;
  }
  __name(onexitcodefencedfence, "onexitcodefencedfence");
  function onexitcodefenced() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
    this.data.flowCodeInside = void 0;
  }
  __name(onexitcodefenced, "onexitcodefenced");
  function onexitcodeindented() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/(\r?\n|\r)$/g, "");
  }
  __name(onexitcodeindented, "onexitcodeindented");
  function onexitdefinitionlabelstring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
  }
  __name(onexitdefinitionlabelstring, "onexitdefinitionlabelstring");
  function onexitdefinitiontitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  __name(onexitdefinitiontitlestring, "onexitdefinitiontitlestring");
  function onexitdefinitiondestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  __name(onexitdefinitiondestinationstring, "onexitdefinitiondestinationstring");
  function onexitatxheadingsequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    if (!node2.depth) {
      const depth = this.sliceSerialize(token).length;
      node2.depth = depth;
    }
  }
  __name(onexitatxheadingsequence, "onexitatxheadingsequence");
  function onexitsetextheadingtext() {
    this.data.setextHeadingSlurpLineEnding = true;
  }
  __name(onexitsetextheadingtext, "onexitsetextheadingtext");
  function onexitsetextheadinglinesequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    node2.depth = this.sliceSerialize(token).codePointAt(0) === 61 ? 1 : 2;
  }
  __name(onexitsetextheadinglinesequence, "onexitsetextheadinglinesequence");
  function onexitsetextheading() {
    this.data.setextHeadingSlurpLineEnding = void 0;
  }
  __name(onexitsetextheading, "onexitsetextheading");
  function onenterdata(token) {
    const node2 = this.stack[this.stack.length - 1];
    const siblings = node2.children;
    let tail = siblings[siblings.length - 1];
    if (!tail || tail.type !== "text") {
      tail = text5();
      tail.position = {
        start: point2(token.start),
        // @ts-expect-error: we’ll add `end` later.
        end: void 0
      };
      siblings.push(tail);
    }
    this.stack.push(tail);
  }
  __name(onenterdata, "onenterdata");
  function onexitdata(token) {
    const tail = this.stack.pop();
    tail.value += this.sliceSerialize(token);
    tail.position.end = point2(token.end);
  }
  __name(onexitdata, "onexitdata");
  function onexitlineending(token) {
    const context = this.stack[this.stack.length - 1];
    if (this.data.atHardBreak) {
      const tail = context.children[context.children.length - 1];
      tail.position.end = point2(token.end);
      this.data.atHardBreak = void 0;
      return;
    }
    if (!this.data.setextHeadingSlurpLineEnding && config.canContainEols.includes(context.type)) {
      onenterdata.call(this, token);
      onexitdata.call(this, token);
    }
  }
  __name(onexitlineending, "onexitlineending");
  function onexithardbreak() {
    this.data.atHardBreak = true;
  }
  __name(onexithardbreak, "onexithardbreak");
  function onexithtmlflow() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  __name(onexithtmlflow, "onexithtmlflow");
  function onexithtmltext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  __name(onexithtmltext, "onexithtmltext");
  function onexitcodetext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  __name(onexitcodetext, "onexitcodetext");
  function onexitlink() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  __name(onexitlink, "onexitlink");
  function onexitimage() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  __name(onexitimage, "onexitimage");
  function onexitlabeltext(token) {
    const string3 = this.sliceSerialize(token);
    const ancestor = this.stack[this.stack.length - 2];
    ancestor.label = decodeString(string3);
    ancestor.identifier = normalizeIdentifier(string3).toLowerCase();
  }
  __name(onexitlabeltext, "onexitlabeltext");
  function onexitlabel() {
    const fragment = this.stack[this.stack.length - 1];
    const value = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    this.data.inReference = true;
    if (node2.type === "link") {
      const children = fragment.children;
      node2.children = children;
    } else {
      node2.alt = value;
    }
  }
  __name(onexitlabel, "onexitlabel");
  function onexitresourcedestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  __name(onexitresourcedestinationstring, "onexitresourcedestinationstring");
  function onexitresourcetitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  __name(onexitresourcetitlestring, "onexitresourcetitlestring");
  function onexitresource() {
    this.data.inReference = void 0;
  }
  __name(onexitresource, "onexitresource");
  function onenterreference() {
    this.data.referenceType = "collapsed";
  }
  __name(onenterreference, "onenterreference");
  function onexitreferencestring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
    this.data.referenceType = "full";
  }
  __name(onexitreferencestring, "onexitreferencestring");
  function onexitcharacterreferencemarker(token) {
    this.data.characterReferenceType = token.type;
  }
  __name(onexitcharacterreferencemarker, "onexitcharacterreferencemarker");
  function onexitcharacterreferencevalue(token) {
    const data2 = this.sliceSerialize(token);
    const type = this.data.characterReferenceType;
    let value;
    if (type) {
      value = decodeNumericCharacterReference(data2, type === "characterReferenceMarkerNumeric" ? 10 : 16);
      this.data.characterReferenceType = void 0;
    } else {
      const result = decodeNamedCharacterReference(data2);
      value = result;
    }
    const tail = this.stack[this.stack.length - 1];
    tail.value += value;
  }
  __name(onexitcharacterreferencevalue, "onexitcharacterreferencevalue");
  function onexitcharacterreference(token) {
    const tail = this.stack.pop();
    tail.position.end = point2(token.end);
  }
  __name(onexitcharacterreference, "onexitcharacterreference");
  function onexitautolinkprotocol(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = this.sliceSerialize(token);
  }
  __name(onexitautolinkprotocol, "onexitautolinkprotocol");
  function onexitautolinkemail(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = "mailto:" + this.sliceSerialize(token);
  }
  __name(onexitautolinkemail, "onexitautolinkemail");
  function blockQuote2() {
    return {
      type: "blockquote",
      children: []
    };
  }
  __name(blockQuote2, "blockQuote");
  function codeFlow() {
    return {
      type: "code",
      lang: null,
      meta: null,
      value: ""
    };
  }
  __name(codeFlow, "codeFlow");
  function codeText2() {
    return {
      type: "inlineCode",
      value: ""
    };
  }
  __name(codeText2, "codeText");
  function definition3() {
    return {
      type: "definition",
      identifier: "",
      label: null,
      title: null,
      url: ""
    };
  }
  __name(definition3, "definition");
  function emphasis2() {
    return {
      type: "emphasis",
      children: []
    };
  }
  __name(emphasis2, "emphasis");
  function heading2() {
    return {
      type: "heading",
      // @ts-expect-error `depth` will be set later.
      depth: 0,
      children: []
    };
  }
  __name(heading2, "heading");
  function hardBreak2() {
    return {
      type: "break"
    };
  }
  __name(hardBreak2, "hardBreak");
  function html2() {
    return {
      type: "html",
      value: ""
    };
  }
  __name(html2, "html");
  function image2() {
    return {
      type: "image",
      title: null,
      url: "",
      alt: null
    };
  }
  __name(image2, "image");
  function link2() {
    return {
      type: "link",
      title: null,
      url: "",
      children: []
    };
  }
  __name(link2, "link");
  function list3(token) {
    return {
      type: "list",
      ordered: token.type === "listOrdered",
      start: null,
      spread: token._spread,
      children: []
    };
  }
  __name(list3, "list");
  function listItem2(token) {
    return {
      type: "listItem",
      spread: token._spread,
      checked: null,
      children: []
    };
  }
  __name(listItem2, "listItem");
  function paragraph2() {
    return {
      type: "paragraph",
      children: []
    };
  }
  __name(paragraph2, "paragraph");
  function strong2() {
    return {
      type: "strong",
      children: []
    };
  }
  __name(strong2, "strong");
  function text5() {
    return {
      type: "text",
      value: ""
    };
  }
  __name(text5, "text");
  function thematicBreak3() {
    return {
      type: "thematicBreak"
    };
  }
  __name(thematicBreak3, "thematicBreak");
}
__name(compiler, "compiler");
function point2(d) {
  return {
    line: d.line,
    column: d.column,
    offset: d.offset
  };
}
__name(point2, "point");
function configure(combined, extensions) {
  let index2 = -1;
  while (++index2 < extensions.length) {
    const value = extensions[index2];
    if (Array.isArray(value)) {
      configure(combined, value);
    } else {
      extension(combined, value);
    }
  }
}
__name(configure, "configure");
function extension(combined, extension2) {
  let key;
  for (key in extension2) {
    if (own3.call(extension2, key)) {
      switch (key) {
        case "canContainEols": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "transforms": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "enter":
        case "exit": {
          const right = extension2[key];
          if (right) {
            Object.assign(combined[key], right);
          }
          break;
        }
      }
    }
  }
}
__name(extension, "extension");
function defaultOnError(left, right) {
  if (left) {
    throw new Error("Cannot close `" + left.type + "` (" + stringifyPosition({
      start: left.start,
      end: left.end
    }) + "): a different token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is open");
  } else {
    throw new Error("Cannot close document, a token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is still open");
  }
}
__name(defaultOnError, "defaultOnError");

// node_modules/remark-parse/lib/index.js
function remarkParse(options) {
  const self = this;
  self.parser = parser;
  function parser(doc) {
    return fromMarkdown(doc, {
      ...self.data("settings"),
      ...options,
      // Note: these options are not in the readme.
      // The goal is for them to be set by plugins on `data` instead of being
      // passed by users.
      extensions: self.data("micromarkExtensions") || [],
      mdastExtensions: self.data("fromMarkdownExtensions") || []
    });
  }
  __name(parser, "parser");
}
__name(remarkParse, "remarkParse");

// packages/cli/src/ui/utils/export/markdown-document-policy.ts
var MARKDOWN_COMPLEXITY_FALLBACK = "[markdown omitted: complexity limit exceeded]";
var MAX_MARKDOWN_SOURCE_CHARACTERS = 400 * 1024;
var MAX_MARKDOWN_INLINE_DELIMITERS = 2048;
var MAX_MARKDOWN_BRACKET_DEPTH = 512;
var MAX_MARKDOWN_BLOCKQUOTE_DEPTH = 512;
var MAX_MARKDOWN_AST_NODES = 2e4;
var MAX_MARKDOWN_AST_DEPTH = 512;
var MAX_MARKDOWN_LEADING_INDENT = 2 * MAX_MARKDOWN_AST_DEPTH;
var markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
function mayContainNavigableMarkdown(value) {
  return value.includes("]") || value.includes("@") || /www\.|(?:https?|mailto|javascript|data):/i.test(value) || value.includes("<") && value.includes(">");
}
__name(mayContainNavigableMarkdown, "mayContainNavigableMarkdown");
function mayContainFencedCode(value) {
  return value.includes("```") || value.includes("~~~");
}
__name(mayContainFencedCode, "mayContainFencedCode");
function parseMarkdown(value) {
  if (!isMarkdownSourceWithinBudget(value)) return void 0;
  try {
    const root2 = markdownParser.parse(value);
    return isMarkdownTreeWithinBudget(root2) ? root2 : void 0;
  } catch {
    return void 0;
  }
}
__name(parseMarkdown, "parseMarkdown");
function isMarkdownSourceWithinBudget(value) {
  if (value.length > MAX_MARKDOWN_SOURCE_CHARACTERS) return false;
  const source = value.replace(/\r\n?/g, "\n");
  let inlineDelimiters = 0;
  let bracketDepth = 0;
  let fence;
  let htmlBlockDepth;
  const blockquoteMarkerPattern = / {0,3}>[ \t]?/y;
  for (const line of source.split("\n")) {
    const blockquoteOffsets = [0];
    let contentOffset = 0;
    let blockquoteDepth = 0;
    while (!fence || blockquoteDepth < fence.blockquoteDepth) {
      blockquoteMarkerPattern.lastIndex = contentOffset;
      const blockquoteMarker = blockquoteMarkerPattern.exec(line);
      if (!blockquoteMarker) break;
      contentOffset = blockquoteMarkerPattern.lastIndex;
      blockquoteDepth += 1;
      blockquoteOffsets.push(contentOffset);
      if (!fence && blockquoteDepth > MAX_MARKDOWN_BLOCKQUOTE_DEPTH) {
        return false;
      }
    }
    const contentLine = line.slice(contentOffset);
    if (fence && blockquoteDepth < fence.blockquoteDepth) fence = void 0;
    const fenceText = (fence ? line.slice(blockquoteOffsets[fence.blockquoteDepth]) : contentLine).replace(/^ {0,3}/, "");
    const fenceRun = /^(`+|~+)/.exec(fenceText)?.[1];
    if (fence) {
      if (fenceRun?.[0] === fence.character && fenceRun.length >= fence.length && fenceText.slice(fenceRun.length).trim() === "") {
        fence = void 0;
      }
      continue;
    }
    if (htmlBlockDepth !== void 0 && (blockquoteDepth < htmlBlockDepth || line.slice(blockquoteOffsets[htmlBlockDepth]).trim() === "")) {
      htmlBlockDepth = void 0;
    }
    if (htmlBlockDepth === void 0 && startsConservativeHtmlBlock(contentLine)) {
      htmlBlockDepth = blockquoteDepth;
    }
    if (htmlBlockDepth === void 0 && fenceRun && fenceRun.length >= 3) {
      const character = fenceRun[0];
      const info = fenceText.slice(fenceRun.length);
      if (character !== "`" || !info.includes("`")) {
        fence = { character, length: fenceRun.length, blockquoteDepth };
        continue;
      }
    }
    let leadingIndent = 0;
    for (const character of contentLine) {
      if (character === " ") leadingIndent += 1;
      else if (character === "	") leadingIndent += 4;
      else break;
      if (leadingIndent > MAX_MARKDOWN_LEADING_INDENT) return false;
    }
    let escaped = false;
    for (const character of contentLine) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "[") {
        bracketDepth += 1;
        if (bracketDepth > MAX_MARKDOWN_BRACKET_DEPTH) return false;
      } else if (character === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (character === "*" || character === "_" || character === "~" || character === "$") {
        inlineDelimiters += 1;
        if (inlineDelimiters > MAX_MARKDOWN_INLINE_DELIMITERS) {
          return false;
        }
      }
    }
  }
  return true;
}
__name(isMarkdownSourceWithinBudget, "isMarkdownSourceWithinBudget");
function startsConservativeHtmlBlock(line) {
  return /^ {0,3}<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>|$)|!--|\?|!\[CDATA\[|![A-Z])/.test(
    line
  );
}
__name(startsConservativeHtmlBlock, "startsConservativeHtmlBlock");
function walkMarkdown(node2, visit2) {
  const stack = [node2];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visit2(current) === false) continue;
    const children = current.children ?? [];
    for (let index2 = children.length - 1; index2 >= 0; index2 -= 1) {
      stack.push(children[index2]);
    }
  }
}
__name(walkMarkdown, "walkMarkdown");
function isMarkdownTreeWithinBudget(root2) {
  const stack = [
    { node: root2, depth: 0 }
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    nodes += 1;
    if (nodes > MAX_MARKDOWN_AST_NODES || current.depth > MAX_MARKDOWN_AST_DEPTH) {
      return false;
    }
    for (const child of current.node.children ?? []) {
      stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return true;
}
__name(isMarkdownTreeWithinBudget, "isMarkdownTreeWithinBudget");
function rangeOf(node2) {
  const start = node2.position?.start.offset;
  const end = node2.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : void 0;
}
__name(rangeOf, "rangeOf");
function applyReplacements(value, replacements) {
  let result = value;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start
  )) {
    if (replacement.end > previousStart) continue;
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
    previousStart = replacement.start;
  }
  return result;
}
__name(applyReplacements, "applyReplacements");
function normalizedIdentifier(node2) {
  return node2.identifier?.trim().toLowerCase();
}
__name(normalizedIdentifier, "normalizedIdentifier");
function markdownText(node2) {
  if (node2.type === "text" || node2.type === "inlineCode") {
    return node2.value ?? "";
  }
  if (node2.type === "image") return node2.alt ?? "";
  return (node2.children ?? []).map(markdownText).join("");
}
__name(markdownText, "markdownText");
function escapeLabel(value) {
  return value.replace(/([\\[\]])/g, "\\$1");
}
__name(escapeLabel, "escapeLabel");
function safeLinkReplacement(original, node2, safe) {
  if (!safe) {
    return original.trimStart().startsWith("[") ? escapeLabel(markdownText(node2)) : "[link omitted]";
  }
  if (!original.trimStart().startsWith("[")) return safe;
  return `[${escapeLabel(markdownText(node2))}](${markdownDestination(safe)})`;
}
__name(safeLinkReplacement, "safeLinkReplacement");
function markdownDestination(value) {
  return `<${value.replaceAll("<", "%3C").replaceAll(">", "%3E")}>`;
}
__name(markdownDestination, "markdownDestination");
function sanitizeMarkdownDocument(value, policy) {
  if (!mayContainNavigableMarkdown(value)) return value;
  const root2 = parseMarkdown(value);
  if (!root2) {
    policy.onComplexityLimit?.();
    return MARKDOWN_COMPLEXITY_FALLBACK;
  }
  const definitions = /* @__PURE__ */ new Map();
  const imageDefinitionIds = /* @__PURE__ */ new Set();
  const linkDefinitionIds = /* @__PURE__ */ new Set();
  walkMarkdown(root2, (node2) => {
    if (node2.type === "definition") {
      const identifier = normalizedIdentifier(node2);
      if (identifier && !definitions.has(identifier)) {
        definitions.set(identifier, node2);
      }
    } else if (node2.type === "imageReference") {
      const identifier = normalizedIdentifier(node2);
      if (identifier) imageDefinitionIds.add(identifier);
    } else if (node2.type === "linkReference") {
      const identifier = normalizedIdentifier(node2);
      if (identifier) linkDefinitionIds.add(identifier);
    }
  });
  const replacements = [];
  walkMarkdown(root2, (node2) => {
    const range = rangeOf(node2);
    if (!range) return;
    if (node2.type === "code" || node2.type === "inlineCode") return false;
    if (node2.type === "image") {
      replacements.push({
        ...range,
        value: policy.replaceImage(node2.alt ?? "", node2.url)
      });
      return false;
    }
    if (node2.type === "imageReference") {
      const definition3 = definitions.get(normalizedIdentifier(node2) ?? "");
      replacements.push({
        ...range,
        value: policy.replaceImage(node2.alt ?? "", definition3?.url)
      });
      return false;
    }
    if (node2.type === "html" && /<img\b/i.test(node2.value ?? "")) {
      replacements.push({
        ...range,
        value: policy.replaceImage("", void 0)
      });
      return false;
    }
    if (node2.type === "definition") {
      const identifier = normalizedIdentifier(node2);
      if (identifier && imageDefinitionIds.has(identifier) && !linkDefinitionIds.has(identifier)) {
        replacements.push({ ...range, value: "" });
        return false;
      }
      const source = node2.url ?? "";
      const safe = policy.normalizeUrl(source);
      if (safe === source) return false;
      policy.onUrlChange(safe ? "url_sanitized" : "url_rejected");
      replacements.push({
        ...range,
        value: safe && identifier ? `[${escapeLabel(identifier)}]: ${markdownDestination(safe)}` : ""
      });
      return false;
    }
    if (node2.type === "link") {
      const source = node2.url ?? "";
      const safe = policy.normalizeUrl(source);
      if (safe === source) return;
      policy.onUrlChange(safe ? "url_sanitized" : "url_rejected");
      replacements.push({
        ...range,
        value: safeLinkReplacement(
          value.slice(range.start, range.end),
          node2,
          safe
        )
      });
      return false;
    }
    return void 0;
  });
  return applyReplacements(value, replacements);
}
__name(sanitizeMarkdownDocument, "sanitizeMarkdownDocument");
function richLanguage(node2) {
  if (node2.type !== "code" || !node2.lang) return void 0;
  const language = node2.lang.trim().toLowerCase();
  return ["text", "plain", "plaintext"].includes(language) ? void 0 : language;
}
__name(richLanguage, "richLanguage");
function demoteFence(value, node2, language) {
  const range = rangeOf(node2);
  if (!range) return void 0;
  const relativeLineEnd = value.slice(range.start, range.end).search(/[\r\n]/);
  const end = relativeLineEnd === -1 ? range.end : range.start + relativeLineEnd;
  const opening = value.slice(range.start, end);
  const match = /^(`{3,}|~{3,})[ \t]*(\S+)(.*)$/.exec(opening);
  if (!match) return void 0;
  return {
    start: range.start,
    end,
    value: `${match[1]}text${match[3]} [source fallback: ${language.slice(0, 32)}]`
  };
}
__name(demoteFence, "demoteFence");
function transformRichMarkdownTasks(value, keepTask, onComplexityLimit) {
  if (!mayContainFencedCode(value)) return value;
  const replacements = [];
  const root2 = parseMarkdown(value);
  if (!root2) {
    onComplexityLimit?.();
    return MARKDOWN_COMPLEXITY_FALLBACK;
  }
  walkMarkdown(root2, (node2) => {
    const language = richLanguage(node2);
    if (!language || keepTask(language)) return;
    const replacement = demoteFence(value, node2, language);
    if (replacement) replacements.push(replacement);
  });
  return applyReplacements(value, replacements);
}
__name(transformRichMarkdownTasks, "transformRichMarkdownTasks");
function countRichMarkdownTasks(value) {
  if (!mayContainFencedCode(value)) return 0;
  let count = 0;
  const root2 = parseMarkdown(value);
  if (!root2) return 0;
  walkMarkdown(root2, (node2) => {
    if (richLanguage(node2)) count += 1;
  });
  return count;
}
__name(countRichMarkdownTasks, "countRichMarkdownTasks");

// packages/cli/src/ui/utils/export/export-transcript-document.ts
var EXPORT_TRANSCRIPT_LIMITS_V1 = Object.freeze({
  maxBlocks: 1e3,
  maxTextBytes: 400 * 1024,
  maxVisibleTextBytes: 8 * 1024 * 1024,
  maxRasterBytes: 8 * 1024 * 1024,
  maxTotalRasterBytes: 16 * 1024 * 1024,
  maxEnvelopeBytes: 32 * 1024 * 1024,
  maxObjectDepth: 16,
  maxObjectProperties: 1e3,
  maxArrayLength: 1e3,
  maxRichRenderTasks: 100
});
var ExportTranscriptDocumentError = class extends Error {
  constructor(code3) {
    super(`Cannot create export transcript document: ${code3}.`);
    this.code = code3;
    this.name = "ExportTranscriptDocumentError";
  }
  static {
    __name(this, "ExportTranscriptDocumentError");
  }
};
function createExportTranscriptDocumentV1(records, sessionData, options) {
  if (!isSafeRendererVersion(options.rendererVersion)) {
    throw new ExportTranscriptDocumentError("invalid_renderer_version");
  }
  if (!isIsoDate(options.exportedAt)) {
    throw new ExportTranscriptDocumentError("invalid_exported_at");
  }
  const diagnostics = new DiagnosticCounter();
  const policy = applyRecordExportPolicy(records, diagnostics);
  const projection = projectChatRecordsToDaemonTranscript(policy.records, {
    maxBlocks: EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks
  });
  for (const item of projection.diagnostics) {
    diagnostics.add(item.code, item.severity, 1, item.affectsCompleteness);
  }
  const budget = new ExportBudget(diagnostics);
  const ids = new OpaqueDocumentIds();
  const visibleBlocks = projection.blocks.filter((block) => {
    const sourceRecordIds = block.sourceRecordIds ?? [];
    return sourceRecordIds.length === 0 || sourceRecordIds.some((recordId) => policy.visibleRecordIds.has(recordId));
  });
  const blocks = [];
  for (const block of visibleBlocks) {
    const checkpoint = budget.checkpoint();
    const safe = sanitizeBlock(block, budget, ids, diagnostics);
    if (budget.cumulativeTextBudgetExceeded) {
      budget.restore(checkpoint);
      break;
    }
    if (safe) blocks.push(safe);
  }
  const initialTruncated = projection.truncated || budget.truncated;
  const metadataPresentation = createMetadataPresentation(
    sessionData,
    options,
    diagnostics,
    budget
  );
  const truncated = initialTruncated || budget.truncated;
  const degraded = !policy.complete || !projection.complete || budget.truncated || diagnostics.hasErrors || diagnostics.hasCompletenessLoss;
  const metadata = {
    ...metadataPresentation,
    complete: !degraded,
    truncated
  };
  let document3 = {
    schemaVersion: 1,
    rendererVersion: options.rendererVersion,
    blocks,
    diagnostics: diagnostics.toArray(),
    metadata
  };
  document3 = fitDocumentToEnvelope(document3, diagnostics);
  assertExportTranscriptDocumentV1(document3);
  return document3;
}
__name(createExportTranscriptDocumentV1, "createExportTranscriptDocumentV1");
function fitDocumentToEnvelope(document3, diagnostics) {
  if (serializedEnvelopeBytes(document3) <= EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
    return document3;
  }
  diagnostics.add("envelope_budget_exceeded", "warning", 1, true);
  const buildCandidate = /* @__PURE__ */ __name((blockCount) => ({
    ...document3,
    blocks: document3.blocks.slice(0, blockCount),
    diagnostics: diagnostics.toArray(),
    metadata: { ...document3.metadata, complete: false, truncated: true }
  }), "buildCandidate");
  let low = 0;
  let high = document3.blocks.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedEnvelopeBytes(buildCandidate(middle)) <= EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const fitted = buildCandidate(low);
  if (serializedEnvelopeBytes(fitted) > EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
    throw new ExportTranscriptDocumentError("envelope_budget_exceeded");
  }
  return fitted;
}
__name(fitDocumentToEnvelope, "fitDocumentToEnvelope");
function assertExportTranscriptDocumentV1(value) {
  assertDepthAndArrayBudgets(value);
  const bytes = serializedEnvelopeBytes(value);
  if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
    throw new ExportTranscriptDocumentError("envelope_budget_exceeded");
  }
  const schemaError = SchemaValidator.validateStrict(
    export_transcript_document_v1_schema_default,
    value
  );
  if (schemaError) {
    throw new ExportTranscriptDocumentError("schema_validation_failed");
  }
  if (!isRecord(value)) {
    throw new ExportTranscriptDocumentError("schema_validation_failed");
  }
  assertSemanticSafety(value);
  assertDocumentConsistency(value);
  assertNoForbiddenFields(value);
  assertResourceBudgets(value);
}
__name(assertExportTranscriptDocumentV1, "assertExportTranscriptDocumentV1");
function applyRecordExportPolicy(records, diagnostics) {
  const projectionRecords = [];
  const visibleRecordIds = /* @__PURE__ */ new Set();
  let complete = true;
  for (const record of records) {
    if (!isRecord(record)) {
      diagnostics.add("record_invalid", "error");
      complete = false;
      continue;
    }
    const type = record["type"];
    const subtype = record["subtype"];
    const acceptedSystemSubtype = type === "system" && typeof subtype === "string" && VISIBLE_SYSTEM_RECORD_SUBTYPES.has(subtype);
    const visible = type === "user" || type === "assistant" || type === "tool_result" || acceptedSystemSubtype;
    if (visible || type === "system") {
      projectionRecords.push(record);
      const uuid = record["uuid"];
      if (visible && typeof uuid === "string") visibleRecordIds.add(uuid);
      if (type === "system" && !acceptedSystemSubtype) {
        diagnostics.add("record_internal_excluded", "info");
      }
      continue;
    }
    diagnostics.add("record_unknown_excluded", "error");
    complete = false;
  }
  return { records: projectionRecords, visibleRecordIds, complete };
}
__name(applyRecordExportPolicy, "applyRecordExportPolicy");
var VISIBLE_SYSTEM_RECORD_SUBTYPES = /* @__PURE__ */ new Set([
  "slash_command",
  "notification",
  "cron",
  "mid_turn_user_message",
  "realtime_message",
  "goal_state",
  "goal_runtime"
]);
function sanitizeBlock(block, budget, ids, diagnostics) {
  const common = {
    id: ids.get("block", block.id),
    kind: block.kind,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0
  };
  switch (block.kind) {
    case "user":
    case "assistant":
    case "thought": {
      const text5 = budget.text(block.text);
      const images = block.images ? budget.array(block.images).flatMap((image2) => {
        const safe = budget.image(image2);
        return safe ? [safe] : [];
      }) : void 0;
      if (block.files && block.files.length > 0) {
        diagnostics.add(
          "file_attachment_excluded",
          "warning",
          block.files.length,
          true
        );
        budget.markContentLoss();
      }
      return {
        ...common,
        kind: block.kind,
        text: text5,
        streaming: false,
        ...block.collapsed ? { collapsed: true } : {},
        ...block.parentToolCallId ? {
          parentToolCallId: ids.get("tool-call", block.parentToolCallId)
        } : {},
        ...images && images.length > 0 ? { images } : {},
        ...block.kind === "assistant" && block.usage ? {
          usage: {
            inputTokens: safeCount(block.usage.inputTokens),
            outputTokens: safeCount(block.usage.outputTokens),
            ...block.usage.cachedTokens !== void 0 ? { cachedTokens: safeCount(block.usage.cachedTokens) } : {}
          }
        } : {}
      };
    }
    case "tool": {
      const status = terminalToolStatus(block.status, diagnostics, budget);
      const toolName = budget.optionalLabel(block.toolName, 128);
      const toolKind = budget.optionalLabel(block.toolKind, 128);
      const subagentType = budget.optionalLabel(block.subagentType, 128);
      let resultPreview = block.resultPreview ? sanitizeResultPreview(block.resultPreview, budget, diagnostics, ids) : void 0;
      if (!resultPreview && block.preview.kind === "file_diff" && status === "completed") {
        resultPreview = {
          kind: "text",
          text: budget.plainText("File change applied")
        };
      }
      if (!resultPreview && (status === "completed" || status === "failed")) {
        diagnostics.add("tool_result_presentation_missing", "error");
        budget.markContentLoss();
        resultPreview = {
          kind: "text",
          text: budget.plainText("[tool result omitted from export]")
        };
      }
      return {
        ...common,
        kind: "tool",
        toolCallId: ids.get("tool-call", block.toolCallId),
        title: budget.plainText(block.title),
        status,
        ...block.background ? { background: true } : {},
        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
        ...resultPreview ? { resultPreview } : {},
        ...toolName ? { toolName } : {},
        ...toolKind ? { toolKind } : {},
        ...block.parentToolCallId ? {
          parentToolCallId: ids.get("tool-call", block.parentToolCallId)
        } : {},
        ...block.parentBlockId ? { parentBlockId: ids.get("block", block.parentBlockId) } : {},
        ...subagentType ? { subagentType } : {}
      };
    }
    case "shell":
      return {
        ...common,
        kind: "shell",
        text: budget.plainText(block.text),
        ...block.stream ? { stream: block.stream } : {}
      };
    case "user_shell":
      return {
        ...common,
        kind: "user_shell",
        text: budget.plainText(block.text),
        command: budget.plainText(
          sanitizeEmbeddedUrls(
            block.command,
            diagnostics,
            () => budget.markContentLoss()
          )
        ),
        ...block.cwd ? { cwd: budget.label(safePath(block.cwd), 400, false) } : {},
        ...block.stream ? { stream: block.stream } : {}
      };
    case "permission": {
      const toolName = budget.optionalLabel(block.toolName, 128);
      const toolKind = budget.optionalLabel(block.toolKind, 128);
      const resolution = block.resolved ? classifyPermissionResolutionForExport(block.resolved, block.options) : void 0;
      if (resolution?.lossy) {
        diagnostics.add("permission_resolution_sanitized", "warning", 1, true);
        budget.markContentLoss();
      }
      return {
        ...common,
        kind: "permission",
        requestId: ids.get("permission", block.requestId),
        title: budget.plainText(block.title),
        options: budget.array(block.options).map((option) => ({
          optionId: ids.get("permission-option", option.optionId),
          label: budget.plainText(option.label),
          ...option.description ? { description: budget.plainText(option.description) } : {},
          raw: null
        })),
        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
        ...block.toolCallId ? { toolCallId: ids.get("tool-call", block.toolCallId) } : {},
        ...toolName ? { toolName } : {},
        ...toolKind ? { toolKind } : {},
        ...resolution ? { resolved: resolution.value } : {}
      };
    }
    case "status":
    case "error": {
      const code3 = budget.optionalLabel(block.code, 128);
      const errorKind = safeExportErrorKind(block.errorKind);
      const source = budget.optionalLabel(block.source, 128);
      return {
        ...common,
        kind: block.kind,
        text: budget.text(block.text),
        ...code3 ? { code: code3 } : {},
        ...errorKind ? { errorKind } : {},
        ...source ? { source } : {}
      };
    }
    case "prompt_cancelled":
      return {
        ...common,
        kind: "prompt_cancelled",
        ...block.reason ? { reason: budget.plainText(block.reason) } : {}
      };
    case "debug":
      diagnostics.add("debug_block_excluded", "info");
      return void 0;
    default:
      return assertNever3(block);
  }
}
__name(sanitizeBlock, "sanitizeBlock");
function sanitizeToolPreview(preview, budget, diagnostics, ids) {
  switch (preview.kind) {
    case "ask_user_question":
      return {
        kind: preview.kind,
        questions: budget.array(preview.questions).map((question) => {
          const header = budget.optionalLabel(question.header, 200);
          return {
            ...header ? { header } : {},
            question: budget.plainText(question.question),
            options: budget.array(question.options).map((option) => ({
              label: budget.plainText(option.label),
              ...option.description ? { description: budget.plainText(option.description) } : {},
              raw: null
            })),
            raw: null
          };
        })
      };
    case "command":
      return {
        kind: preview.kind,
        command: budget.plainText(
          sanitizeEmbeddedUrls(
            preview.command,
            diagnostics,
            () => budget.markContentLoss()
          )
        ),
        ...preview.cwd ? { cwd: budget.label(safePath(preview.cwd), 400, false) } : {}
      };
    case "file_diff":
      return {
        kind: preview.kind,
        path: budget.label(safePath(preview.path), 400, false),
        ...preview.oldText !== void 0 ? { oldText: budget.plainText(preview.oldText) } : {},
        ...preview.newText !== void 0 ? { newText: budget.plainText(preview.newText) } : {},
        ...preview.patch !== void 0 ? { patch: budget.plainText(preview.patch) } : {}
      };
    case "file_read": {
      const range = preview.range ? [safeCount(preview.range[0]), safeCount(preview.range[1])] : void 0;
      return {
        kind: preview.kind,
        path: budget.label(safePath(preview.path), 400, false),
        ...range ? { range } : {}
      };
    }
    case "web_fetch": {
      const method = budget.optionalLabel(preview.method, 16);
      return {
        kind: preview.kind,
        url: budget.plainText(
          safeDisplayUrl(
            preview.url,
            diagnostics,
            () => budget.markContentLoss()
          )
        ),
        ...method ? { method } : {}
      };
    }
    case "mcp_invocation":
      return {
        kind: preview.kind,
        serverId: budget.label(preview.serverId, 128),
        toolName: budget.label(preview.toolName, 128),
        ...preview.argsSummary ? { argsSummary: budget.plainText(preview.argsSummary) } : {}
      };
    case "code_block": {
      const language = budget.optionalLabel(preview.language, 64);
      const origin = preview.origin ? budget.optionalLabel(safePath(preview.origin), 400, false) : void 0;
      return {
        kind: preview.kind,
        code: budget.plainText(preview.code),
        ...language ? { language } : {},
        ...origin ? { origin } : {}
      };
    }
    case "search":
      return {
        kind: preview.kind,
        query: budget.plainText(preview.query),
        ...preview.resultCount !== void 0 ? { resultCount: safeCount(preview.resultCount) } : {},
        ...preview.top ? {
          top: budget.array(preview.top).map((item) => budget.plainText(item))
        } : {}
      };
    case "tabular":
      return {
        kind: preview.kind,
        columns: budget.array(preview.columns).map((item) => budget.plainText(item)),
        rows: budget.array(preview.rows).map(
          (row) => budget.array(row).map((item) => budget.plainText(item))
        ),
        ...preview.totalRows !== void 0 ? { totalRows: safeCount(preview.totalRows) } : {}
      };
    case "image_generation": {
      const model = budget.optionalLabel(preview.model, 128);
      const thumbnailUrl = preview.thumbnailUrl !== void 0 ? budget.dataImageUrl(preview.thumbnailUrl) : void 0;
      return {
        kind: preview.kind,
        prompt: budget.plainText(preview.prompt),
        ...thumbnailUrl ? { thumbnailUrl } : {},
        ...model ? { model } : {}
      };
    }
    case "subagent_delegation":
      return {
        kind: preview.kind,
        agentName: budget.label(preview.agentName, 128),
        task: budget.plainText(preview.task),
        ...preview.parentDelegationId ? {
          parentDelegationId: ids.get(
            "tool-call",
            preview.parentDelegationId
          )
        } : {}
      };
    case "key_value":
      return {
        kind: preview.kind,
        rows: budget.array(preview.rows).map((row) => ({
          label: budget.plainText(row.label),
          value: budget.plainText(row.value)
        }))
      };
    case "todo_list":
      return sanitizeTodoPreview(preview, budget, ids);
    case "generic":
      return {
        kind: preview.kind,
        ...preview.summary ? { summary: budget.plainText(preview.summary) } : {}
      };
    default:
      return assertNever3(preview);
  }
}
__name(sanitizeToolPreview, "sanitizeToolPreview");
function sanitizeResultPreview(preview, budget, _diagnostics, ids) {
  if (preview.kind === "todo_list") {
    return sanitizeTodoPreview(preview, budget, ids);
  }
  if (preview.kind === "text") {
    return { kind: "text", text: budget.text(preview.text) };
  }
  if (preview.kind === "question_answers") {
    return {
      kind: "question_answers",
      text: budget.plainText(preview.text),
      answers: budget.array(preview.answers).map(({ question, answer }) => ({
        question: budget.plainText(question),
        answer: budget.plainText(answer)
      }))
    };
  }
  if (!preview.summary?.trim()) return void 0;
  const summary = budget.text(preview.summary);
  return summary.trim() ? { kind: "generic", summary } : { kind: "text", text: summary };
}
__name(sanitizeResultPreview, "sanitizeResultPreview");
function sanitizeTodoPreview(preview, budget, ids) {
  if (preview.truncated) budget.markTruncated("todo_preview_truncated");
  return {
    kind: "todo_list",
    entries: budget.array(preview.entries).map((entry) => ({
      id: ids.get("todo", entry.id),
      content: budget.plainText(entry.content),
      status: entry.status,
      ...entry.priority ? { priority: entry.priority } : {},
      ...entry.blockedBy ? {
        blockedBy: budget.array(entry.blockedBy).map((item) => ids.get("todo", item))
      } : {}
    })),
    ...preview.truncated ? { truncated: true } : {},
    ...preview.planId ? { planId: ids.get("plan", preview.planId) } : {},
    ...preview.revision !== void 0 ? { revision: safeCount(preview.revision) } : {}
  };
}
__name(sanitizeTodoPreview, "sanitizeTodoPreview");
function terminalToolStatus(status, diagnostics, budget) {
  if (status === "completed" || status === "failed" || status === "cancelled" || status === "canceled") {
    return status;
  }
  diagnostics.add("tool_status_frozen", "warning", 1, true);
  budget.markContentLoss();
  return "cancelled";
}
__name(terminalToolStatus, "terminalToolStatus");
function createMetadataPresentation(sessionData, options, diagnostics, budget) {
  const metadata = sessionData.metadata;
  const title = safeMetadataLabel(
    options.title,
    200,
    "title",
    diagnostics,
    budget
  );
  const gitBranch = safeMetadataLabel(
    metadata?.gitBranch,
    200,
    "git_branch",
    diagnostics,
    budget
  );
  const model = safeMetadataLabel(
    metadata?.model,
    200,
    "model",
    diagnostics,
    budget
  );
  const channel = safeMetadataLabel(
    metadata?.channel,
    100,
    "channel",
    diagnostics,
    budget
  );
  const projectName = metadata?.cwd ? safeMetadataLabel(
    safePath(metadata.cwd),
    400,
    "project_name",
    diagnostics,
    budget,
    false
  ) : void 0;
  const repository = metadata?.gitRepo ? safeRepository(metadata.gitRepo, diagnostics, budget) : void 0;
  return {
    ...title ? { title } : {},
    ...isIsoDate(sessionData.startTime) ? { startedAt: sessionData.startTime } : {},
    exportedAt: options.exportedAt,
    ...projectName ? { projectName } : {},
    ...repository ? { repository } : {},
    ...gitBranch ? { gitBranch } : {},
    ...model ? { model } : {},
    ...channel ? { channel } : {},
    ...metadata ? { promptCount: safeCount(metadata.promptCount) } : {},
    ...metadata?.contextUsagePercent !== void 0 ? {
      contextUsagePercent: Math.min(
        100,
        safeCount(metadata.contextUsagePercent)
      )
    } : {},
    ...metadata?.contextWindowSize !== void 0 ? { contextWindowSize: safeCount(metadata.contextWindowSize) } : {},
    ...metadata?.totalTokens !== void 0 ? { totalTokens: safeCount(metadata.totalTokens) } : {},
    ...metadata?.filesWritten !== void 0 ? { filesWritten: safeCount(metadata.filesWritten) } : {},
    ...metadata?.linesAdded !== void 0 ? { linesAdded: safeCount(metadata.linesAdded) } : {},
    ...metadata?.linesRemoved !== void 0 ? { linesRemoved: safeCount(metadata.linesRemoved) } : {}
  };
}
__name(createMetadataPresentation, "createMetadataPresentation");
var REQUIRED_TEXT_FALLBACK_RESERVE_BYTES = 64 * 1024;
var ExportBudget = class {
  constructor(diagnostics) {
    this.diagnostics = diagnostics;
  }
  static {
    __name(this, "ExportBudget");
  }
  visibleTextBytes = 0;
  totalRasterBytes = 0;
  richRenderTasks = 0;
  truncated = false;
  cumulativeTextBudgetExceeded = false;
  checkpoint() {
    return {
      visibleTextBytes: this.visibleTextBytes,
      totalRasterBytes: this.totalRasterBytes,
      richRenderTasks: this.richRenderTasks
    };
  }
  restore(checkpoint) {
    this.visibleTextBytes = checkpoint.visibleTextBytes;
    this.totalRasterBytes = checkpoint.totalRasterBytes;
    this.richRenderTasks = checkpoint.richRenderTasks;
  }
  array(value) {
    if (value.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength) {
      this.truncated = true;
      this.diagnostics.add("array_budget_exceeded", "warning");
    }
    return value.slice(0, EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength);
  }
  markTruncated(code3) {
    this.truncated = true;
    this.diagnostics.add(code3, "warning");
  }
  markContentLoss() {
    this.truncated = true;
  }
  homeSafeText(value) {
    const redaction = redactHomePaths(value);
    for (const code3 of redaction.omissions) this.markTruncated(code3);
    const redacted = redaction.text;
    if (!containsUnredactedHomePath(redacted, true)) return redacted;
    this.markTruncated("home_path_omitted");
    return "[home path omitted]";
  }
  label(value, maxLength, redact = true) {
    const initiallySafe = safeLabel(value, maxLength);
    const redacted = redact ? this.homeSafeText(initiallySafe) : initiallySafe;
    const safe = safeLabel(redacted, maxLength);
    if (initiallySafe !== value || safe !== redacted) {
      this.markTruncated("label_sanitized");
    }
    return this.applyTextBudgetWithFallback(
      safe,
      safeLabel("[content omitted]", maxLength)
    );
  }
  optionalLabel(value, maxLength, redact = true) {
    if (value === void 0 || value === "") return void 0;
    return this.label(value, maxLength, redact);
  }
  plainText(value) {
    return this.applyTextBudget(this.homeSafeText(value));
  }
  text(value) {
    value = this.homeSafeText(value);
    const onComplexityLimit = /* @__PURE__ */ __name(() => {
      this.truncated = true;
      this.diagnostics.add("markdown_complexity_exceeded", "warning", 1, true);
    }, "onComplexityLimit");
    const replaceImage = /* @__PURE__ */ __name((alt, source) => {
      const safeAlt = safeLabel(alt, 200).replace(/([\\[\]])/g, "\\$1");
      const parsed = source ? parseApprovedImageDataUrl(source) : void 0;
      if (parsed && this.image(parsed)) {
        return `![${safeAlt}](${formatApprovedImageDataUrl(parsed)})`;
      }
      this.truncated = true;
      this.diagnostics.add("markdown_image_rejected", "warning");
      return `[image omitted${safeAlt ? `: ${safeAlt}` : ""}]`;
    }, "replaceImage");
    const resourceSafeValue = sanitizeMarkdownDocument(value, {
      normalizeUrl: normalizeNavigableUrl,
      replaceImage,
      onUrlChange: /* @__PURE__ */ __name((code3) => {
        this.truncated = true;
        this.diagnostics.add(code3, "warning", 1, true);
      }, "onUrlChange"),
      onComplexityLimit
    });
    const richTaskSafeValue = transformRichMarkdownTasks(
      resourceSafeValue,
      () => {
        this.richRenderTasks += 1;
        if (this.richRenderTasks <= EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks) {
          return true;
        }
        this.diagnostics.add("rich_render_budget_exceeded", "warning");
        return false;
      },
      onComplexityLimit
    );
    return this.applyTextBudget(richTaskSafeValue);
  }
  applyTextBudget(value) {
    return this.applyTextBudgetWithFallback(
      value,
      "[content omitted: export text budget exceeded]"
    );
  }
  applyTextBudgetWithFallback(value, fallback) {
    const bytes = utf8Bytes(value);
    const normalTextLimit = EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes - REQUIRED_TEXT_FALLBACK_RESERVE_BYTES;
    const perItemExceeded = bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes;
    const cumulativeExceeded = this.visibleTextBytes + bytes > normalTextLimit;
    if (perItemExceeded || cumulativeExceeded) {
      this.truncated = true;
      if (cumulativeExceeded) this.cumulativeTextBudgetExceeded = true;
      this.diagnostics.add("text_budget_exceeded", "warning");
      const fallbackBytes = utf8Bytes(fallback);
      if (this.visibleTextBytes + fallbackBytes <= EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes) {
        this.visibleTextBytes += fallbackBytes;
        return fallback;
      }
      return "";
    }
    this.visibleTextBytes += bytes;
    return value;
  }
  image(image2) {
    if (!SAFE_RASTER_MIME_TYPES.has(image2.mimeType)) {
      this.truncated = true;
      this.diagnostics.add("image_type_rejected", "warning");
      return void 0;
    }
    const bytes = decodedBase64Bytes(image2.data);
    if (bytes === void 0 || bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes || this.totalRasterBytes + bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTotalRasterBytes || !hasRasterSignature(image2.data, image2.mimeType)) {
      this.truncated = true;
      this.diagnostics.add("image_budget_or_animation_rejected", "warning");
      return void 0;
    }
    this.totalRasterBytes += bytes;
    return { data: image2.data, mimeType: image2.mimeType };
  }
  dataImageUrl(value) {
    const image2 = parseApprovedImageDataUrl(value);
    if (!image2) {
      this.truncated = true;
      this.diagnostics.add("image_type_rejected", "warning");
      return void 0;
    }
    return this.image(image2) ? formatApprovedImageDataUrl(image2) : void 0;
  }
};
var SAFE_RASTER_MIME_TYPES = /* @__PURE__ */ new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);
function parseApprovedImageDataUrl(value) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
    value
  );
  if (!match?.[1] || match[2] === void 0) return void 0;
  return { mimeType: match[1].toLowerCase(), data: match[2] };
}
__name(parseApprovedImageDataUrl, "parseApprovedImageDataUrl");
function formatApprovedImageDataUrl(image2) {
  return `data:${image2.mimeType};base64,${image2.data}`;
}
__name(formatApprovedImageDataUrl, "formatApprovedImageDataUrl");
var DiagnosticCounter = class {
  static {
    __name(this, "DiagnosticCounter");
  }
  entries = /* @__PURE__ */ new Map();
  completenessLost = false;
  add(code3, severity, count = 1, affectsCompleteness = false) {
    if (affectsCompleteness) this.completenessLost = true;
    const current = this.entries.get(code3);
    if (current) {
      current.count += Math.max(1, count);
      if (severityRank(severity) > severityRank(current.severity)) {
        current.severity = severity;
      }
      return;
    }
    this.entries.set(code3, { severity, count: Math.max(1, count) });
  }
  get hasErrors() {
    return [...this.entries.values()].some((item) => item.severity === "error");
  }
  get hasCompletenessLoss() {
    return this.completenessLost;
  }
  toArray() {
    return [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code3, item]) => ({ code: code3, ...item }));
  }
};
var OpaqueDocumentIds = class {
  static {
    __name(this, "OpaqueDocumentIds");
  }
  ids = /* @__PURE__ */ new Map();
  nextOrdinal = 0;
  get(kind, nativeId) {
    const key = `${kind}\0${nativeId}`;
    let id = this.ids.get(key);
    if (!id) {
      id = `${kind}-${this.nextOrdinal}`;
      this.nextOrdinal += 1;
      this.ids.set(key, id);
    }
    return id;
  }
};
var APPROVED_PERMISSION_TOKENS = /* @__PURE__ */ new Set([
  "accept",
  "accepted",
  "allow",
  "allow_always",
  "allow_once",
  "allowed",
  "approve",
  "approved",
  "confirm",
  "confirmed",
  "proceed",
  "proceed_always_project",
  "proceed_always_user",
  "proceed_once",
  "proceed_once_and_switch_to_default",
  "succeeded",
  "success"
]);
var REJECTED_PERMISSION_TOKENS = /* @__PURE__ */ new Set([
  "deny",
  "denied",
  "reject",
  "reject_always",
  "reject_once",
  "rejected"
]);
var CANCELLED_PERMISSION_TOKENS = /* @__PURE__ */ new Set([
  "cancel",
  "canceled",
  "cancelled"
]);
var EXPIRED_PERMISSION_TOKENS = /* @__PURE__ */ new Set([
  "expired",
  "session_closed",
  "timed_out",
  "timeout"
]);
function classifyPermissionResolutionForExport(resolved, options) {
  const separator = resolved.indexOf(":");
  const primary = (separator === -1 ? resolved : resolved.slice(0, separator)).trim().toLowerCase();
  let token = primary;
  if (primary === "selected" && separator !== -1) {
    const optionId = resolved.slice(separator + 1).trim();
    const option = options.find((candidate) => candidate.optionId === optionId);
    if (!option) return { value: "resolved", lossy: true };
    const raw = isRecord(option.raw) ? option.raw : void 0;
    token = (typeof raw?.["kind"] === "string" ? raw["kind"].trim().toLowerCase() : "") || option.optionId.trim().toLowerCase();
  }
  if (APPROVED_PERMISSION_TOKENS.has(token)) {
    return { value: "approved", lossy: false };
  }
  if (REJECTED_PERMISSION_TOKENS.has(token)) {
    return { value: "rejected", lossy: false };
  }
  if (CANCELLED_PERMISSION_TOKENS.has(token)) {
    return { value: "cancelled", lossy: false };
  }
  if (EXPIRED_PERMISSION_TOKENS.has(token)) {
    return { value: "expired", lossy: false };
  }
  if (token === "resolved") return { value: "resolved", lossy: false };
  return { value: "resolved", lossy: true };
}
__name(classifyPermissionResolutionForExport, "classifyPermissionResolutionForExport");
var SAFE_EXPORT_ERROR_KINDS = new Set(DAEMON_ERROR_KINDS);
function safeExportErrorKind(value) {
  return value && SAFE_EXPORT_ERROR_KINDS.has(value) ? value : void 0;
}
__name(safeExportErrorKind, "safeExportErrorKind");
var SAFE_IDENTIFIER_LENGTHS = /* @__PURE__ */ new Map([
  ["id", 200],
  ["toolCallId", 200],
  ["requestId", 200],
  ["optionId", 200],
  ["parentToolCallId", 200],
  ["parentBlockId", 200],
  ["subagentType", 200],
  ["source", 128],
  ["planId", 128],
  ["parentDelegationId", 128],
  ["method", 16],
  ["language", 64]
]);
var SAFE_PRESENTATION_IDENTIFIER_LENGTHS = /* @__PURE__ */ new Map([
  ["toolName", 200],
  ["toolKind", 200],
  ["serverId", 128],
  ["agentName", 128],
  ["header", 200],
  ["model", 200]
]);
function assertSemanticSafety(value) {
  const metadata = value["metadata"];
  const diagnostics = value["diagnostics"];
  if (diagnostics.some((diagnostic) => !isSafeLabel(diagnostic.code, 128))) {
    throw new ExportTranscriptDocumentError("invalid_diagnostic");
  }
  for (const [key, maxLength] of [
    ["title", 200],
    ["gitBranch", 200],
    ["model", 200],
    ["channel", 100]
  ]) {
    const field = metadata[key];
    if (field !== void 0 && !isSafeLabel(field, maxLength)) {
      throw new ExportTranscriptDocumentError("invalid_metadata");
    }
  }
  if (!isIsoDate(metadata.exportedAt)) {
    throw new ExportTranscriptDocumentError("invalid_metadata");
  }
  if (metadata.startedAt !== void 0 && !isIsoDate(metadata.startedAt)) {
    throw new ExportTranscriptDocumentError("invalid_metadata");
  }
  if (metadata.projectName !== void 0 && !isSafeExportPath(metadata.projectName)) {
    throw new ExportTranscriptDocumentError("invalid_metadata");
  }
  if (metadata.repository !== void 0 && !isSafeRepository(metadata.repository)) {
    throw new ExportTranscriptDocumentError("invalid_metadata");
  }
  const visit2 = /* @__PURE__ */ __name((entry, key) => {
    if (typeof entry === "string") {
      const maxLength = key ? SAFE_IDENTIFIER_LENGTHS.get(key) : void 0;
      if (maxLength !== void 0 && !isSafeLabel(entry, maxLength)) {
        throw new ExportTranscriptDocumentError("invalid_block");
      }
      const presentationMaxLength = key ? SAFE_PRESENTATION_IDENTIFIER_LENGTHS.get(key) : void 0;
      if (presentationMaxLength !== void 0 && !isSafePresentationLabel(entry, presentationMaxLength)) {
        throw new ExportTranscriptDocumentError("invalid_block");
      }
      if (key !== void 0 && ["path", "cwd", "origin"].includes(key) && !isSafeExportPath(entry)) {
        throw new ExportTranscriptDocumentError("invalid_block");
      }
      if (key === "url" && !isSafeDisplayUrl(entry)) {
        throw new ExportTranscriptDocumentError("invalid_block");
      }
      return;
    }
    if (Array.isArray(entry)) {
      if (key === "blockedBy" && !entry.every((item) => isSafeLabel(item, 128))) {
        throw new ExportTranscriptDocumentError("invalid_block");
      }
      for (const item of entry) visit2(item, key);
      return;
    }
    if (!isRecord(entry)) return;
    if ((entry["kind"] === "status" || entry["kind"] === "error") && entry["code"] !== void 0 && !isSafeLabel(entry["code"], 128)) {
      throw new ExportTranscriptDocumentError("invalid_block");
    }
    for (const [childKey, child] of Object.entries(entry)) {
      visit2(child, childKey);
    }
  }, "visit");
  visit2(value["blocks"]);
}
__name(assertSemanticSafety, "assertSemanticSafety");
function assertDocumentConsistency(value) {
  const metadata = value["metadata"];
  const diagnostics = value["diagnostics"];
  const blocks = value["blocks"];
  const blockIds = new Set(blocks.map((block) => block.id));
  if (blockIds.size !== blocks.length) {
    throw new ExportTranscriptDocumentError("duplicate_block_id");
  }
  for (const block of blocks) {
    if (block.kind === "tool" && block.parentBlockId !== void 0 && !blockIds.has(block.parentBlockId)) {
      throw new ExportTranscriptDocumentError("invalid_block_reference");
    }
  }
  if (metadata.complete && metadata.truncated) {
    throw new ExportTranscriptDocumentError("invalid_metadata_state");
  }
  const hasError = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error"
  );
  const hasCompletenessDiagnostic = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning" && diagnostic.code !== "rich_render_budget_exceeded"
  );
  const hasTruncationDiagnostic = diagnostics.some(
    (diagnostic) => TRUNCATION_DIAGNOSTIC_CODES.has(diagnostic.code)
  );
  const hasExplicitContentLoss = blocks.some((block) => {
    if (block.kind === "tool" && (block.status === "completed" || block.status === "failed") && block.resultPreview === void 0) {
      return true;
    }
    if (block.kind === "tool") {
      return block.preview.kind === "todo_list" && block.preview.truncated === true || block.resultPreview?.kind === "todo_list" && block.resultPreview.truncated === true;
    }
    if (block.kind === "permission") {
      return block.preview.kind === "todo_list" && block.preview.truncated === true;
    }
    return false;
  });
  if ((hasError || hasCompletenessDiagnostic || hasExplicitContentLoss) && metadata.complete) {
    throw new ExportTranscriptDocumentError("invalid_metadata_state");
  }
  if ((hasExplicitContentLoss || hasTruncationDiagnostic) && !metadata.truncated) {
    throw new ExportTranscriptDocumentError("invalid_metadata_state");
  }
}
__name(assertDocumentConsistency, "assertDocumentConsistency");
var TRUNCATION_DIAGNOSTIC_CODES = /* @__PURE__ */ new Set([
  "envelope_budget_exceeded",
  "array_budget_exceeded",
  "todo_preview_truncated",
  "markdown_image_rejected",
  "markdown_complexity_exceeded",
  "text_budget_exceeded",
  "image_type_rejected",
  "image_budget_or_animation_rejected",
  "tool_status_frozen",
  "url_sanitized",
  "url_rejected",
  "repository_url_rejected",
  "repository_rejected",
  "title_rejected",
  "git_branch_rejected",
  "model_rejected",
  "channel_rejected",
  "project_name_rejected",
  "permission_resolution_sanitized",
  "tool_result_presentation_missing",
  "file_attachment_excluded",
  "home_path_omitted",
  "encoded_content_omitted",
  "url_home_path_omitted",
  "label_sanitized"
]);
function assertNoForbiddenFields(value) {
  const forbidden = /* @__PURE__ */ new Set([
    "rawInput",
    "rawOutput",
    "toolCall",
    "details",
    "locations",
    "meta",
    "sessionId",
    "sourceRecordIds",
    "eventId",
    "serverTimestamp",
    "promptId",
    "branchRecordId",
    "debugReason"
  ]);
  const visit2 = /* @__PURE__ */ __name((entry, key) => {
    if (typeof entry === "string") {
      const safePathField = key !== void 0 && ["path", "cwd", "origin", "projectName", "repository"].includes(key);
      if (key !== "data" && key !== "thumbnailUrl" && containsUnredactedHomePath(entry, !safePathField)) {
        throw new ExportTranscriptDocumentError("home_path_forbidden");
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit2(item, key);
      return;
    }
    if (!isRecord(entry)) return;
    for (const [key2, item] of Object.entries(entry)) {
      if (forbidden.has(key2)) {
        throw new ExportTranscriptDocumentError("forbidden_field");
      }
      visit2(item, key2);
    }
  }, "visit");
  visit2(value);
}
__name(assertNoForbiddenFields, "assertNoForbiddenFields");
function assertDepthAndArrayBudgets(value, depth = 0, ancestors = /* @__PURE__ */ new WeakSet()) {
  if (depth > EXPORT_TRANSCRIPT_LIMITS_V1.maxObjectDepth) {
    throw new ExportTranscriptDocumentError("object_depth_exceeded");
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new ExportTranscriptDocumentError("cyclic_envelope");
    }
    if (value.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength) {
      throw new ExportTranscriptDocumentError("array_budget_exceeded");
    }
    ancestors.add(value);
    for (const item of value) {
      assertDepthAndArrayBudgets(item, depth + 1, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (!isRecord(value)) return;
  if (ancestors.has(value)) {
    throw new ExportTranscriptDocumentError("cyclic_envelope");
  }
  const entries = Object.values(value);
  if (entries.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxObjectProperties) {
    throw new ExportTranscriptDocumentError("object_property_budget_exceeded");
  }
  ancestors.add(value);
  for (const item of entries) {
    assertDepthAndArrayBudgets(item, depth + 1, ancestors);
  }
  ancestors.delete(value);
}
__name(assertDepthAndArrayBudgets, "assertDepthAndArrayBudgets");
function serializedEnvelopeBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === void 0) {
      throw new ExportTranscriptDocumentError("invalid_envelope");
    }
    return utf8Bytes(escapeJsonForHtmlScriptData(serialized));
  } catch (error) {
    if (error instanceof ExportTranscriptDocumentError) throw error;
    throw new ExportTranscriptDocumentError("invalid_envelope");
  }
}
__name(serializedEnvelopeBytes, "serializedEnvelopeBytes");
function assertResourceBudgets(value) {
  let visibleTextBytes = 0;
  let totalRasterBytes = 0;
  let richRenderTasks = 0;
  const visit2 = /* @__PURE__ */ __name((entry, key, parent, path3 = []) => {
    if (typeof entry === "string") {
      if (key === "data") return;
      if (key === "thumbnailUrl") {
        const image2 = parseApprovedImageDataUrl(entry);
        const bytes2 = image2 ? decodedBase64Bytes(image2.data) : void 0;
        const canonical = image2 ? formatApprovedImageDataUrl(image2) : void 0;
        if (bytes2 === void 0 || bytes2 > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes || entry !== canonical || !image2 || !hasRasterSignature(image2.data, image2.mimeType)) {
          throw new ExportTranscriptDocumentError("invalid_thumbnail_image");
        }
        totalRasterBytes += bytes2;
        return;
      }
      const bytes = utf8Bytes(entry);
      if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes) {
        throw new ExportTranscriptDocumentError("text_budget_exceeded");
      }
      const markdownText2 = isMarkdownExportText(key, parent, path3);
      if (key && VISIBLE_EXPORT_TEXT_FIELDS.has(key)) {
        visibleTextBytes += bytes;
      }
      if (markdownText2) {
        richRenderTasks += countRichMarkdownTasks(entry);
        const sanitized = sanitizeMarkdownDocument(entry, {
          normalizeUrl: normalizeNavigableUrl,
          onUrlChange: /* @__PURE__ */ __name(() => {
            throw new ExportTranscriptDocumentError("invalid_markdown_url");
          }, "onUrlChange"),
          onComplexityLimit: /* @__PURE__ */ __name(() => {
            throw new ExportTranscriptDocumentError(
              "markdown_complexity_exceeded"
            );
          }, "onComplexityLimit"),
          replaceImage: /* @__PURE__ */ __name((alt, source) => {
            const image2 = source ? parseApprovedImageDataUrl(source) : void 0;
            const imageBytes = image2 ? decodedBase64Bytes(image2.data) : void 0;
            if (!image2 || imageBytes === void 0 || imageBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes || !hasRasterSignature(image2.data, image2.mimeType)) {
              throw new ExportTranscriptDocumentError("invalid_markdown_image");
            }
            totalRasterBytes += imageBytes;
            const safeAlt = safeLabel(alt, 200).replace(/([\\[\]])/g, "\\$1");
            return `![${safeAlt}](${formatApprovedImageDataUrl(image2)})`;
          }, "replaceImage")
        });
        if (sanitized !== entry) {
          throw new ExportTranscriptDocumentError("invalid_markdown_image");
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit2(item, key, parent, path3);
      return;
    }
    if (!isRecord(entry)) return;
    if (typeof entry["data"] === "string" && typeof entry["mimeType"] === "string") {
      const bytes = decodedBase64Bytes(entry["data"]);
      if (bytes === void 0 || bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes || !SAFE_RASTER_MIME_TYPES.has(entry["mimeType"]) || !hasRasterSignature(entry["data"], entry["mimeType"])) {
        throw new ExportTranscriptDocumentError("raster_budget_exceeded");
      }
      totalRasterBytes += bytes;
    }
    for (const [childKey, item] of Object.entries(entry)) {
      visit2(item, childKey, entry, [...path3, childKey]);
    }
  }, "visit");
  visit2(value);
  if (visibleTextBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes) {
    throw new ExportTranscriptDocumentError("visible_text_budget_exceeded");
  }
  if (totalRasterBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTotalRasterBytes) {
    throw new ExportTranscriptDocumentError("total_raster_budget_exceeded");
  }
  if (richRenderTasks > EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks) {
    throw new ExportTranscriptDocumentError("rich_render_budget_exceeded");
  }
}
__name(assertResourceBudgets, "assertResourceBudgets");
function isMarkdownExportText(key, parent, path3) {
  if (path3.at(-2) === "resultPreview") {
    return parent?.["kind"] !== "question_answers" && (key === "text" || key === "summary");
  }
  return key === "text" && ["user", "assistant", "thought", "status", "error"].includes(
    String(parent?.["kind"])
  );
}
__name(isMarkdownExportText, "isMarkdownExportText");
function normalizeNavigableUrl(value) {
  if (value.startsWith("#")) return value;
  const urlInput = value.trim().replace(/[\t\r\n]/g, "");
  if (/^https?:/i.test(urlInput) && !/^https?:\/\/[^/?#\\]/i.test(urlInput)) {
    return void 0;
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    if (value.includes("\\")) return void 0;
    const queryIndex = value.search(/[?#]/);
    return queryIndex === -1 ? value : value.slice(0, queryIndex);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
      return void 0;
    }
    if (url.username === "" && url.password === "" && url.search === "" && url.hash === "") {
      return value;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return void 0;
  }
}
__name(normalizeNavigableUrl, "normalizeNavigableUrl");
var VISIBLE_EXPORT_TEXT_FIELDS = /* @__PURE__ */ new Set([
  "text",
  "title",
  "label",
  "description",
  "command",
  "cwd",
  "question",
  "answer",
  "path",
  "oldText",
  "newText",
  "patch",
  "url",
  "argsSummary",
  "code",
  "origin",
  "query",
  "top",
  "columns",
  "rows",
  "prompt",
  "task",
  "value",
  "content",
  "summary",
  "reason",
  "projectName",
  "repository",
  "gitBranch",
  "model",
  "channel"
]);
function safeDisplayUrl(raw, diagnostics, onContentLoss) {
  try {
    const safe = normalizeNavigableUrl(raw);
    if (!safe) throw new Error();
    const url = new URL(safe);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
    if (utf8Bytes(safe) > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes) {
      throw new Error();
    }
    if (safe !== raw) {
      diagnostics.add("url_sanitized", "warning", 1, true);
      onContentLoss?.();
    }
    return safe;
  } catch {
    diagnostics.add("url_rejected", "warning", 1, true);
    onContentLoss?.();
    return "[link omitted]";
  }
}
__name(safeDisplayUrl, "safeDisplayUrl");
function sanitizeEmbeddedUrls(raw, diagnostics, onContentLoss) {
  return raw.replace(/https?:\/\/[^\s"'<>\\]+/gi, (match) => {
    const safe = normalizeNavigableUrl(match);
    if (!safe) {
      diagnostics.add("url_rejected", "warning", 1, true);
      onContentLoss?.();
      return "[link omitted]";
    }
    if (safe !== match) {
      diagnostics.add("url_sanitized", "warning", 1, true);
      onContentLoss?.();
    }
    return safe;
  });
}
__name(sanitizeEmbeddedUrls, "sanitizeEmbeddedUrls");
function safeRepository(raw, diagnostics, budget) {
  if (/^https?:/i.test(raw)) {
    const safe2 = safeDisplayUrl(
      raw,
      diagnostics,
      () => budget.markContentLoss()
    );
    if (safe2.length <= 200) return budget.plainText(safe2);
    diagnostics.add("repository_url_rejected", "warning", 1, true);
    budget.markContentLoss();
    return budget.plainText("[link omitted]");
  }
  const safe = safePath(raw).replace(/\.git$/i, "");
  if (isSafeLabel(safe, 200)) return budget.label(safe, 200, false);
  diagnostics.add("repository_rejected", "warning", 1, true);
  budget.markContentLoss();
  return budget.plainText("[link omitted]");
}
__name(safeRepository, "safeRepository");
function safeMetadataLabel(value, maxLength, field, diagnostics, budget, redact = true) {
  if (value === void 0 || value === "") return void 0;
  if (isSafeLabel(value, maxLength)) {
    return budget.label(value, maxLength, redact);
  }
  diagnostics.add(`${field}_rejected`, "warning", 1, true);
  budget.markContentLoss();
  return void 0;
}
__name(safeMetadataLabel, "safeMetadataLabel");
function isSafeDisplayUrl(value) {
  if (value === "[link omitted]" || value === "[content omitted: export text budget exceeded]") {
    return true;
  }
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && normalizeNavigableUrl(value) === value;
  } catch {
    return false;
  }
}
__name(isSafeDisplayUrl, "isSafeDisplayUrl");
function isSafeRepository(value) {
  return typeof value === "string" && !/^https?:/i.test(value) && isSafeLabel(value, 200) && !/[\\/]/.test(value) || isSafeDisplayUrl(value);
}
__name(isSafeRepository, "isSafeRepository");
function safePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^file:\/\/[^/]+\//i, "/").replace(/^file:\/\/\//i, "/").replace(/^file:\//i, "/").replace(/\/+$/, "");
  const components = [];
  for (const component of normalized.split("/").filter(Boolean)) {
    if (component === ".") continue;
    if (component === "..") {
      if (components.length > 0 && !(components.length === 1 && /^[A-Za-z]:$/.test(components[0]))) {
        components.pop();
      }
      continue;
    }
    components.push(component);
  }
  const homeIndex = components.findIndex(
    (component) => /^(?:Users|home)$/i.test(component)
  );
  if (homeIndex !== -1 && components[homeIndex + 1] !== void 0) {
    const homeBasename = components.at(-1);
    if (components.length === homeIndex + 2) return "[home]";
    return homeBasename && homeBasename !== "." && homeBasename !== ".." ? homeBasename : "[path]";
  }
  const basename = components.at(-1);
  return basename && !/^[A-Za-z]:$/.test(basename) ? basename : "[path]";
}
__name(safePath, "safePath");
function isSafeExportPath(value) {
  return isSafePresentationLabel(value, 400) && !/[\\/]/.test(String(value)) && !/^[A-Za-z]:$/.test(String(value));
}
__name(isSafeExportPath, "isSafeExportPath");
var EXPORT_URL_PATTERN = /\b(?:https?:\/\/[^\s<>"\x60]+|data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/gi;
var HOME_USERNAME_SEGMENT_SOURCE = String.raw`(?:[^/\\\t\r\n<>]+(?=[/\\])|[^/\\\s<>]+)`;
var FILE_HOME_PATH_SOURCE = String.raw`file:\/+(?:[^/\s]+\/)?(?:[A-Za-z]:\/)?(?:\.\/|\/)*(?:home|Users)\/(?:\.\/|\/)*${HOME_USERNAME_SEGMENT_SOURCE}`;
var LOCAL_HOME_PATH_SOURCE = String.raw`(?:[A-Za-z]:)?[\\/](?:\.[\\/]|[\\/])*(?:home|Users)[\\/](?:\.[\\/]|[\\/])*${HOME_USERNAME_SEGMENT_SOURCE}`;
var BARE_HOME_ROOT_SOURCE = String.raw`(?:[A-Za-z]:)?[\\/](?:\.[\\/]|[\\/])*(?:home|Users)[\\/](?=$|\s|[<>"'\x60,;:|()](?=\s|$))`;
var RELATIVE_HOME_PATH_SOURCE = String.raw`(^|[\r\n])(?:home|Users)[\\/](?:\.[\\/]|[\\/])*${HOME_USERNAME_SEGMENT_SOURCE}`;
var RELATIVE_HOME_ROOT_SOURCE = String.raw`(^|[\r\n])(?:home|Users)[\\/](?=$|\s|[<>"'\x60,;:|()](?=\s|$))`;
var FILE_HOME_PATH_PATTERN = new RegExp(FILE_HOME_PATH_SOURCE, "gi");
var LOCAL_HOME_PATH_PATTERN = new RegExp(LOCAL_HOME_PATH_SOURCE, "gi");
var BARE_HOME_ROOT_PATTERN = new RegExp(BARE_HOME_ROOT_SOURCE, "gi");
var RELATIVE_HOME_PATH_PATTERN = new RegExp(RELATIVE_HOME_PATH_SOURCE, "gim");
var RELATIVE_HOME_ROOT_PATTERN = new RegExp(RELATIVE_HOME_ROOT_SOURCE, "gim");
var ENCODED_CONTENT_OMITTED = "[encoded content omitted]";
var URL_HOME_PATH_OMITTED = "[link omitted]";
function redactHomePaths(value) {
  return redactHomePathStructures(value);
}
__name(redactHomePaths, "redactHomePaths");
function redactHomePathStructures(value) {
  const urlPattern = EXPORT_URL_PATTERN;
  let result = "";
  let cursor = 0;
  const omissions = [];
  const append = /* @__PURE__ */ __name((redaction) => {
    result += redaction.text;
    omissions.push(...redaction.omissions);
  }, "append");
  for (const match of value.matchAll(urlPattern)) {
    append(redactNonHttpHomePathStructures(value.slice(cursor, match.index)));
    if (match[0].toLowerCase().startsWith("data:image/") && containsNonHttpHomePath(match[0], true)) {
      append(redactNonHttpHomePathStructures(match[0]));
    } else if (shouldOmitHttpUrlToken(match[0])) {
      result += URL_HOME_PATH_OMITTED;
      omissions.push("url_home_path_omitted");
    } else {
      result += match[0];
    }
    cursor = match.index + match[0].length;
  }
  append(redactNonHttpHomePathStructures(value.slice(cursor)));
  return { text: result, omissions };
}
__name(redactHomePathStructures, "redactHomePathStructures");
function shouldOmitHttpUrlToken(value) {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority === void 0) return false;
  const decoded = decodePercentText(value);
  const decodedAuthority = decodePercentText(authority);
  if (decoded === void 0 || decodedAuthority === void 0 || containsRawHomePath(decodedAuthority)) {
    return true;
  }
  return hasAmbiguousUrlHomePath(decoded) || (authority === "" || normalizeNavigableUrl(value) === void 0 || /[(),;|'\\]/.test(authority)) && containsNonHttpHomePath(value, true);
}
__name(shouldOmitHttpUrlToken, "shouldOmitHttpUrlToken");
function hasAmbiguousUrlHomePath(value) {
  let afterDelimiter = false;
  let parenthesisDepth = 0;
  for (let index2 = 0; index2 < value.length; index2 += 1) {
    const character = value[index2];
    if ("?#&,;|'\\".includes(character)) afterDelimiter = true;
    if (character === "(") parenthesisDepth += 1;
    if (character === ")") {
      if (parenthesisDepth > 0) parenthesisDepth -= 1;
      else afterDelimiter = true;
    }
    if (!afterDelimiter || character !== "/" && character !== "\\") {
      continue;
    }
    const component = value.slice(index2 + 1, index2 + 6).toLowerCase();
    const length = component.startsWith("users") ? 5 : component.startsWith("home") ? 4 : 0;
    const separator = value[index2 + length + 1];
    const firstUsernameCharacter = value[index2 + length + 2];
    if (length > 0 && (separator === "/" || separator === "\\") && firstUsernameCharacter !== void 0 && firstUsernameCharacter !== "/" && firstUsernameCharacter !== "\\" && !/\s/.test(firstUsernameCharacter)) {
      return true;
    }
  }
  return false;
}
__name(hasAmbiguousUrlHomePath, "hasAmbiguousUrlHomePath");
function redactNonHttpHomePathStructures(value) {
  const rawRedacted = redactRawHomePathStructures(value);
  const decoded = decodePercentText(rawRedacted);
  if (decoded === void 0) {
    return {
      text: ENCODED_CONTENT_OMITTED,
      omissions: ["encoded_content_omitted"]
    };
  }
  const encodedRedacted = containsRawHomePath(decoded) ? redactRawHomePathStructures(decoded).replace(
    /(?:\[home\]){2,}/g,
    "[home]"
  ) : rawRedacted;
  return {
    text: encodedRedacted.replace(
      /file:\/+(?:[^/\s]+\/)?(?:[A-Za-z]:\/)?\[home\]/gi,
      "file://[home]"
    ),
    omissions: []
  };
}
__name(redactNonHttpHomePathStructures, "redactNonHttpHomePathStructures");
function redactRawHomePathStructures(value) {
  return value.replace(FILE_HOME_PATH_PATTERN, "file://[home]").replace(BARE_HOME_ROOT_PATTERN, "[home]").replace(LOCAL_HOME_PATH_PATTERN, "[home]").replace(RELATIVE_HOME_ROOT_PATTERN, "$1[home]").replace(RELATIVE_HOME_PATH_PATTERN, "$1[home]");
}
__name(redactRawHomePathStructures, "redactRawHomePathStructures");
function containsUnredactedHomePath(value, checkPercentEncoding) {
  const urlPattern = EXPORT_URL_PATTERN;
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    if (shouldOmitHttpUrlToken(match[0])) return true;
    if (match[0].toLowerCase().startsWith("data:image/") && containsNonHttpHomePath(match[0], checkPercentEncoding)) {
      return true;
    }
    if (containsNonHttpHomePath(
      value.slice(cursor, match.index),
      checkPercentEncoding
    )) {
      return true;
    }
    cursor = match.index + match[0].length;
  }
  return containsNonHttpHomePath(value.slice(cursor), checkPercentEncoding);
}
__name(containsUnredactedHomePath, "containsUnredactedHomePath");
function containsNonHttpHomePath(value, checkPercentEncoding) {
  if (containsRawHomePath(value)) return true;
  if (!checkPercentEncoding) return false;
  const decoded = decodePercentText(value);
  return decoded === void 0 || containsRawHomePath(decoded);
}
__name(containsNonHttpHomePath, "containsNonHttpHomePath");
function decodePercentText(value) {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodePrintablePercentEscapes(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decodePrintablePercentEscapes(decoded) === decoded ? decoded : void 0;
}
__name(decodePercentText, "decodePercentText");
function decodePrintablePercentEscapes(value) {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex) => {
    const code3 = Number.parseInt(hex, 16);
    return code3 >= 32 && code3 <= 126 ? String.fromCharCode(code3) : escape;
  });
}
__name(decodePrintablePercentEscapes, "decodePrintablePercentEscapes");
function containsRawHomePath(value) {
  return redactRawHomePathStructures(value) !== value;
}
__name(containsRawHomePath, "containsRawHomePath");
function safeLabel(value, maxLength) {
  if (typeof value !== "string") return "[invalid]";
  let safe = "";
  for (const character of value) {
    if (isControlCharacter(character)) continue;
    if (safe.length + character.length > maxLength) break;
    safe += character;
  }
  return safe;
}
__name(safeLabel, "safeLabel");
function isSafeLabel(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && ![...value].some(isControlCharacter);
}
__name(isSafeLabel, "isSafeLabel");
function isSafePresentationLabel(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength && ![...value].some(isControlCharacter);
}
__name(isSafePresentationLabel, "isSafePresentationLabel");
function isControlCharacter(value) {
  const code3 = value.charCodeAt(0);
  return code3 <= 31 || code3 === 127;
}
__name(isControlCharacter, "isControlCharacter");
function assertNever3(value) {
  void value;
  throw new ExportTranscriptDocumentError("unsupported_value");
}
__name(assertNever3, "assertNever");
function safeCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))) : 0;
}
__name(safeCount, "safeCount");
function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
__name(isIsoDate, "isIsoDate");
function isSafeRendererVersion(value) {
  return isSafeLabel(value, 128) && !String(value).includes("latest") && !/[~^*><=]/.test(String(value));
}
__name(isSafeRendererVersion, "isSafeRendererVersion");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}
__name(utf8Bytes, "utf8Bytes");
function decodedBase64Bytes(value) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return void 0;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}
__name(decodedBase64Bytes, "decodedBase64Bytes");
function hasRasterSignature(data, mimeType) {
  if (mimeType === "image/gif") return !isAnimatedGif(data);
  const header = atob(data.slice(0, 16));
  switch (mimeType) {
    case "image/png":
      return header.startsWith("\x89PNG\r\n\n");
    case "image/jpeg":
      return header.startsWith("\xFF\xD8\xFF");
    case "image/webp":
      return header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
    default:
      return false;
  }
}
__name(hasRasterSignature, "hasRasterSignature");
function isAnimatedGif(value) {
  try {
    const binary = atob(value);
    if (binary.length < 13 || binary.slice(0, 6) !== "GIF87a" && binary.slice(0, 6) !== "GIF89a") {
      return true;
    }
    const logicalScreenPacked = binary.charCodeAt(10);
    let offset = 13;
    if ((logicalScreenPacked & 128) !== 0) {
      offset += 3 * 2 ** ((logicalScreenPacked & 7) + 1);
    }
    let frames = 0;
    while (offset < binary.length) {
      const marker = binary.charCodeAt(offset);
      offset += 1;
      if (marker === 59) return frames !== 1;
      if (marker === 33) {
        if (offset >= binary.length) return true;
        offset += 1;
        const nextOffset2 = skipGifSubBlocks(binary, offset);
        if (nextOffset2 === void 0) return true;
        offset = nextOffset2;
        continue;
      }
      if (marker !== 44 || offset + 9 > binary.length) return true;
      frames += 1;
      if (frames > 1) return true;
      const imagePacked = binary.charCodeAt(offset + 8);
      offset += 9;
      if ((imagePacked & 128) !== 0) {
        offset += 3 * 2 ** ((imagePacked & 7) + 1);
      }
      if (offset >= binary.length) return true;
      offset += 1;
      const nextOffset = skipGifSubBlocks(binary, offset);
      if (nextOffset === void 0) return true;
      offset = nextOffset;
    }
    return true;
  } catch {
    return true;
  }
}
__name(isAnimatedGif, "isAnimatedGif");
function skipGifSubBlocks(binary, startOffset) {
  let offset = startOffset;
  while (offset < binary.length) {
    const size = binary.charCodeAt(offset);
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > binary.length) return void 0;
    offset += size;
  }
  return void 0;
}
__name(skipGifSubBlocks, "skipGifSubBlocks");
function severityRank(value) {
  return value === "error" ? 2 : value === "warning" ? 1 : 0;
}
__name(severityRank, "severityRank");

// packages/cli/src/ui/utils/export/formatters/html.ts
function injectDocumentIntoHtmlTemplate(template, document3) {
  return injectJsonScript(template, "transcript-document", document3);
}
__name(injectDocumentIntoHtmlTemplate, "injectDocumentIntoHtmlTemplate");
function renderExportTranscriptDocumentToHtml(document3) {
  assertExportTranscriptDocumentV1(document3);
  if (document3.rendererVersion !== EXPORT_TRANSCRIPT_RENDERER_VERSION) {
    throw new Error("Export transcript renderer version mismatch.");
  }
  if (EXPORT_TRANSCRIPT_RENDERER_LIMITS.maxBlocks !== EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks || EXPORT_TRANSCRIPT_RENDERER_LIMITS.maxEnvelopeBytes !== EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
    throw new Error("Export transcript renderer limits mismatch.");
  }
  const nonce = randomBytes(16).toString("base64url");
  const template = injectDocumentNonce(DOCUMENT_HTML_TEMPLATE, nonce);
  return injectDocumentIntoHtmlTemplate(template, document3);
}
__name(renderExportTranscriptDocumentToHtml, "renderExportTranscriptDocumentToHtml");
function injectDocumentNonce(template, nonce) {
  if (!template.includes("__EXPORT_NONCE__")) {
    throw new Error("Export HTML template is missing its CSP nonce slot.");
  }
  return template.replaceAll("__EXPORT_NONCE__", nonce);
}
__name(injectDocumentNonce, "injectDocumentNonce");
function injectJsonScript(template, elementId, data) {
  const jsonData = JSON.stringify(data);
  const escapedJsonData = escapeJsonForHtmlScriptData(jsonData);
  const idAttribute = `id="${elementId}"`;
  const idIndex = template.indexOf(idAttribute);
  if (idIndex === -1) {
    throw new Error(`Export HTML template is missing ${elementId}.`);
  }
  const openTagEnd = template.indexOf(">", idIndex);
  if (openTagEnd === -1) {
    throw new Error(`Export HTML template has an invalid ${elementId} tag.`);
  }
  const closeTagStart = template.indexOf("</script>", openTagEnd);
  if (closeTagStart === -1) {
    throw new Error(`Export HTML template has an unclosed ${elementId} tag.`);
  }
  return `${template.slice(0, openTagEnd + 1)}${escapedJsonData}${template.slice(closeTagStart)}`;
}
__name(injectJsonScript, "injectJsonScript");
function toHtml(sessionData, originalRecords) {
  const document3 = createExportTranscriptDocumentV1(
    originalRecords,
    sessionData,
    {
      rendererVersion: EXPORT_TRANSCRIPT_RENDERER_VERSION,
      exportedAt: sessionData.metadata?.exportTime ?? (/* @__PURE__ */ new Date()).toISOString()
    }
  );
  return renderExportTranscriptDocumentToHtml(document3);
}
__name(toHtml, "toHtml");

// packages/cli/src/ui/utils/export/formatters/json.ts
init_esbuild_shims();
function toJson(sessionData) {
  return JSON.stringify(sessionData, null, 2);
}
__name(toJson, "toJson");

// packages/cli/src/ui/utils/export/formatters/jsonl.ts
init_esbuild_shims();
function toJsonl(sessionData) {
  const lines = [];
  const sourceMetadata = sessionData.metadata;
  const metadata = {
    type: "session_metadata",
    sessionId: sessionData.sessionId,
    startTime: sessionData.startTime
  };
  if (sourceMetadata?.exportTime) {
    metadata["exportTime"] = sourceMetadata.exportTime;
  }
  if (sourceMetadata?.cwd) {
    metadata["cwd"] = sourceMetadata.cwd;
  }
  if (sourceMetadata?.gitRepo) {
    metadata["gitRepo"] = sourceMetadata.gitRepo;
  }
  if (sourceMetadata?.gitBranch) {
    metadata["gitBranch"] = sourceMetadata.gitBranch;
  }
  if (sourceMetadata?.model) {
    metadata["model"] = sourceMetadata.model;
  }
  if (sourceMetadata?.channel) {
    metadata["channel"] = sourceMetadata.channel;
  }
  if (sourceMetadata?.promptCount !== void 0) {
    metadata["promptCount"] = sourceMetadata.promptCount;
  }
  if (sourceMetadata?.contextUsagePercent !== void 0) {
    metadata["contextUsagePercent"] = sourceMetadata.contextUsagePercent;
  }
  if (sourceMetadata?.contextWindowSize !== void 0) {
    metadata["contextWindowSize"] = sourceMetadata.contextWindowSize;
  }
  if (sourceMetadata?.totalTokens !== void 0) {
    metadata["totalTokens"] = sourceMetadata.totalTokens;
  }
  if (sourceMetadata?.filesWritten !== void 0) {
    metadata["filesWritten"] = sourceMetadata.filesWritten;
  }
  if (sourceMetadata?.linesAdded !== void 0) {
    metadata["linesAdded"] = sourceMetadata.linesAdded;
  }
  if (sourceMetadata?.linesRemoved !== void 0) {
    metadata["linesRemoved"] = sourceMetadata.linesRemoved;
  }
  if (sourceMetadata?.uniqueFiles && sourceMetadata.uniqueFiles.length > 0) {
    metadata["uniqueFiles"] = sourceMetadata.uniqueFiles;
  }
  lines.push(JSON.stringify(metadata));
  for (const message of sessionData.messages) {
    lines.push(JSON.stringify(message));
  }
  return lines.join("\n");
}
__name(toJsonl, "toJsonl");

// packages/cli/src/ui/utils/export/utils.ts
init_esbuild_shims();
function generateExportFilename(extension2) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  return `qwen-code-export-${timestamp}.${extension2}`;
}
__name(generateExportFilename, "generateExportFilename");

// packages/cli/src/ui/utils/export/index.ts
init_esbuild_shims();

// packages/cli/src/utils/json-string-byte-projection.ts
init_esbuild_shims();
import { Buffer as Buffer2 } from "node:buffer";
var JSON_STRING_DELIMITER_BYTES = 2;
function jsonPayloadBytesAt(value, index2) {
  const code3 = value.charCodeAt(index2);
  if (code3 === 34 || code3 === 92) return 2;
  if (code3 <= 31) {
    return code3 === 8 || code3 === 9 || code3 === 10 || code3 === 12 || code3 === 13 ? 2 : 6;
  }
  if (code3 <= 127) return 1;
  if (code3 <= 2047) return 2;
  if (code3 >= 55296 && code3 <= 56319) {
    const next = value.charCodeAt(index2 + 1);
    return next >= 56320 && next <= 57343 ? 4 : 6;
  }
  if (code3 >= 56320 && code3 <= 57343) return 6;
  return 3;
}
__name(jsonPayloadBytesAt, "jsonPayloadBytesAt");
function jsonPayloadWidthAt(value, index2) {
  const code3 = value.charCodeAt(index2);
  if (code3 < 55296 || code3 > 56319) return 1;
  const next = value.charCodeAt(index2 + 1);
  return next >= 56320 && next <= 57343 ? 2 : 1;
}
__name(jsonPayloadWidthAt, "jsonPayloadWidthAt");
function jsonStringPayloadByteLength(value, stopAfterBytes = Number.POSITIVE_INFINITY) {
  let bytes = 0;
  for (let index2 = 0; index2 < value.length; ) {
    bytes += jsonPayloadBytesAt(value, index2);
    if (bytes > stopAfterBytes) return bytes;
    index2 += jsonPayloadWidthAt(value, index2);
  }
  return bytes;
}
__name(jsonStringPayloadByteLength, "jsonStringPayloadByteLength");
function jsonStringJsonByteLength(value) {
  return JSON_STRING_DELIMITER_BYTES + jsonStringPayloadByteLength(value);
}
__name(jsonStringJsonByteLength, "jsonStringJsonByteLength");
function jsonPayloadWidthBefore(value, end) {
  const last = value.charCodeAt(end - 1);
  if (last >= 56320 && last <= 57343 && end >= 2) {
    const previous4 = value.charCodeAt(end - 2);
    if (previous4 >= 55296 && previous4 <= 56319) return 2;
  }
  return 1;
}
__name(jsonPayloadWidthBefore, "jsonPayloadWidthBefore");
function selectPrefix(value, budget) {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const partBytes = jsonPayloadBytesAt(value, end);
    if (bytes + partBytes > budget) break;
    bytes += partBytes;
    end += jsonPayloadWidthAt(value, end);
  }
  return end;
}
__name(selectPrefix, "selectPrefix");
function selectSuffix(value, budget) {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    const partWidth = jsonPayloadWidthBefore(value, start);
    const partBytes = jsonPayloadBytesAt(value, start - partWidth);
    if (bytes + partBytes > budget) break;
    bytes += partBytes;
    start -= partWidth;
  }
  return start;
}
__name(selectSuffix, "selectSuffix");
function copyString(value) {
  return value.split("").join("");
}
__name(copyString, "copyString");
function truncateJsonStringPayload(value, originalPayloadBytes, payloadBudget, marker) {
  if (originalPayloadBytes <= payloadBudget) return value;
  const markerPayloadBytes = jsonStringPayloadByteLength(marker);
  if (payloadBudget < markerPayloadBytes) {
    return copyString(value.slice(0, selectPrefix(value, payloadBudget)));
  }
  const sourceBudget = payloadBudget - markerPayloadBytes;
  const headBudget = Math.floor(sourceBudget * 0.2);
  const tailBudget = sourceBudget - headBudget;
  const headEnd = selectPrefix(value, headBudget);
  const tailStart = selectSuffix(value, tailBudget);
  return copyString(value.slice(0, headEnd)) + marker + copyString(value.slice(tailStart));
}
__name(truncateJsonStringPayload, "truncateJsonStringPayload");
function projectJsonStringToByteBudget(value, jsonByteBudget, marker) {
  const payloadBudget = Math.max(
    0,
    jsonByteBudget - JSON_STRING_DELIMITER_BYTES
  );
  const payloadBytes = jsonStringPayloadByteLength(value, payloadBudget);
  if (payloadBytes <= payloadBudget) return value;
  const projected = truncateJsonStringPayload(
    value,
    payloadBytes,
    payloadBudget,
    marker
  );
  if (Buffer2.byteLength(JSON.stringify(projected), "utf8") <= jsonByteBudget) {
    return projected;
  }
  const fallback = copyString(
    marker.slice(0, selectPrefix(marker, payloadBudget))
  );
  return Buffer2.byteLength(JSON.stringify(fallback), "utf8") <= jsonByteBudget ? fallback : "";
}
__name(projectJsonStringToByteBudget, "projectJsonStringToByteBudget");

export {
  GITHUB_WORKFLOW_PATHS,
  SetupGithubError,
  setupGithub,
  createTranscriptMessageUpdate,
  createTranscriptUsageUpdate,
  BaseEmitter,
  PlanEmitter,
  hasFullSessionContext,
  observeAcpToolResultProjection,
  observeAcpToolResultWire,
  observeHeadlessToolResultProjection,
  observeHeadlessToolResultWire,
  observeHeadlessJsonToolResultWire,
  ToolCallEmitter,
  HistoryReplayer,
  collectSessionData,
  normalizeSessionData,
  toMarkdown,
  INSIGHT_JS,
  INSIGHT_CSS,
  toHtml,
  toJson,
  toJsonl,
  generateExportFilename,
  JSON_STRING_DELIMITER_BYTES,
  jsonStringPayloadByteLength,
  jsonStringJsonByteLength,
  truncateJsonStringPayload,
  projectJsonStringToByteBudget
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
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This file is code-generated; do not edit manually.
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This HTML template is code-generated; do not edit manually.
 */
