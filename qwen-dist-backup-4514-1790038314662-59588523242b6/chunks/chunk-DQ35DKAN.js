// Force strict mode and setup for ESM
"use strict";
import {
  SessionService,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
  buildSessionHistoryFromConversation,
  detectTurnInterruption
} from "./chunk-MRTRBONQ.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/prompt-terminal-ledger.ts
init_esbuild_shims();
import { closeSync as closeSync2, openSync as openSync2, readSync as readSync2, statSync as statSync2 } from "node:fs";

// packages/acp-bridge/dist/prompt-ledger.js
init_esbuild_shims();
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
function isPromptLedgerTerminalRecord(record) {
  return "terminal" in record;
}
__name(isPromptLedgerTerminalRecord, "isPromptLedgerTerminalRecord");
function appendPromptLedgerRecord(filePath, record) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  sealTornTailSync(filePath);
  appendFileSync(filePath, `${JSON.stringify(record)}
`, {
    encoding: "utf8",
    mode: 384
  });
}
__name(appendPromptLedgerRecord, "appendPromptLedgerRecord");
function sealTornTailSync(filePath) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    throw error;
  }
  if (stats.size === 0)
    return;
  const fd = openSync(filePath, "r");
  try {
    const lastByte = Buffer.alloc(1);
    const bytesRead = readSync(fd, lastByte, 0, 1, stats.size - 1);
    if (bytesRead === 1 && lastByte[0] !== 10) {
      appendFileSync(filePath, "\n", "utf8");
    }
  } finally {
    closeSync(fd);
  }
}
__name(sealTornTailSync, "sealTornTailSync");
function coercePromptLedgerRecord(value) {
  if (typeof value !== "object" || value === null)
    return void 0;
  const record = value;
  const promptId = record["promptId"];
  const at = record["at"];
  if (record["v"] !== 1 || typeof promptId !== "string")
    return void 0;
  if (typeof at !== "number" || !Number.isFinite(at))
    return void 0;
  if (record["state"] === "in_flight") {
    const tailUuid = record["tailUuid"];
    return {
      v: 1,
      promptId,
      state: "in_flight",
      ...typeof tailUuid === "string" && tailUuid.length > 0 ? { tailUuid } : {},
      at
    };
  }
  const terminal = record["terminal"];
  if (terminal !== "completed" && terminal !== "cancelled" && terminal !== "error" && terminal !== "interrupted") {
    return void 0;
  }
  const code = record["code"];
  const stopReason = record["stopReason"];
  return {
    v: 1,
    promptId,
    terminal,
    ...typeof code === "string" ? { code } : {},
    ...typeof stopReason === "string" ? { stopReason } : {},
    at
  };
}
__name(coercePromptLedgerRecord, "coercePromptLedgerRecord");
function readPromptLedgerRecords(filePath, options) {
  let contents;
  let dropFirstLine = false;
  try {
    const tailBytes = options?.tailBytes;
    if (tailBytes === void 0) {
      contents = readFileSync(filePath, "utf8");
    } else {
      const size = statSync(filePath).size;
      if (size <= tailBytes) {
        contents = readFileSync(filePath, "utf8");
      } else {
        const fd = openSync(filePath, "r");
        try {
          const buffer = Buffer.alloc(tailBytes);
          const bytesRead = readSync(fd, buffer, 0, tailBytes, size - tailBytes);
          contents = buffer.subarray(0, bytesRead).toString("utf8");
          dropFirstLine = true;
        } finally {
          closeSync(fd);
        }
      }
    }
  } catch (error) {
    if (error.code === "ENOENT")
      return [];
    throw error;
  }
  const records = [];
  const lines = contents.split("\n");
  for (let i = dropFirstLine ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === void 0 || line.length === 0)
      continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = coercePromptLedgerRecord(parsed);
    if (record !== void 0)
      records.push(record);
  }
  return records;
}
__name(readPromptLedgerRecords, "readPromptLedgerRecords");
function danglingInFlightPromptIds(records) {
  const latest = /* @__PURE__ */ new Map();
  for (const record of records) {
    latest.set(record.promptId, record);
  }
  const dangling = [];
  for (const [promptId, record] of latest) {
    if (!isPromptLedgerTerminalRecord(record))
      dangling.push(promptId);
  }
  return dangling;
}
__name(danglingInFlightPromptIds, "danglingInFlightPromptIds");
var PROMPT_TERMINALS_RESPONSE_LIMIT = 64;
function recentPromptTerminalRecords(records) {
  const terminals = records.filter(isPromptLedgerTerminalRecord);
  return terminals.length <= PROMPT_TERMINALS_RESPONSE_LIMIT ? terminals : terminals.slice(-PROMPT_TERMINALS_RESPONSE_LIMIT);
}
__name(recentPromptTerminalRecords, "recentPromptTerminalRecords");

// packages/cli/src/serve/prompt-terminal-ledger.ts
function createPromptLedgerSink(workspaceCwd, sessionRuntimeBaseDir) {
  const sessionService = new SessionService(workspaceCwd, {
    runtimeBaseDir: sessionRuntimeBaseDir
  });
  return {
    appendSync(sessionId, record) {
      appendPromptLedgerRecord(
        sessionService.getPromptLedgerPath(sessionId),
        record
      );
    },
    transcriptTailUuid(sessionId) {
      return readTranscriptTailUuid(
        sessionService.getSessionTranscriptPath(sessionId)
      );
    }
  };
}
__name(createPromptLedgerSink, "createPromptLedgerSink");
var TRANSCRIPT_TAIL_BYTES = 64 * 1024;
function readTranscriptTailUuid(transcriptPath) {
  let contents;
  try {
    const size = statSync2(transcriptPath).size;
    if (size === 0) return void 0;
    const windowBytes = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(windowBytes);
    const fd = openSync2(transcriptPath, "r");
    try {
      readSync2(fd, buffer, 0, windowBytes, size - windowBytes);
    } finally {
      closeSync2(fd);
    }
    contents = buffer.toString("utf8");
  } catch {
    return void 0;
  }
  const lines = contents.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === void 0 || line.length === 0) continue;
    try {
      const uuid = JSON.parse(line).uuid;
      return typeof uuid === "string" && uuid.length > 0 ? uuid : void 0;
    } catch {
      return void 0;
    }
  }
  return void 0;
}
__name(readTranscriptTailUuid, "readTranscriptTailUuid");
async function reconcileDanglingPromptTerminals(sessionService, sessionId) {
  const ledgerPath = sessionService.getPromptLedgerPath(sessionId);
  let records;
  try {
    records = readPromptLedgerRecords(ledgerPath);
  } catch {
    return;
  }
  const snapshotLength = records.length;
  const dangling = danglingInFlightPromptIds(records);
  if (dangling.length === 0) return;
  if (dangling.length > 1) return;
  const target = dangling[0];
  if (target === void 0) return;
  const settledPromptIds = new Set(
    records.filter(isPromptLedgerTerminalRecord).map((r) => r.promptId)
  );
  let targetAdmission;
  for (const record2 of records) {
    if (!isPromptLedgerTerminalRecord(record2) && !settledPromptIds.has(record2.promptId)) {
      targetAdmission = record2;
    }
  }
  if (targetAdmission === void 0 || targetAdmission.promptId !== target) {
    return;
  }
  let resumed;
  try {
    resumed = await sessionService.loadSession(sessionId);
  } catch {
    return;
  }
  if (resumed === void 0) return;
  const messages = resumed.conversation.messages;
  const admissionMarker = targetAdmission.tailUuid;
  let markerIndex = -1;
  if (admissionMarker !== void 0) {
    markerIndex = messages.findIndex(
      (record2) => record2.uuid === admissionMarker
    );
    let wroteAfterMarker = false;
    for (let i = markerIndex + 1; i < messages.length; i++) {
      const record2 = messages[i];
      if (record2 === void 0 || record2.type === "system") continue;
      if (!record2.message || record2.subtype === "realtime_message") continue;
      wroteAfterMarker = true;
      break;
    }
    if (markerIndex < 0 || !wroteAfterMarker) return;
  }
  let lastVisibleWriteMs = NaN;
  let compressedAfterAdmission = false;
  for (let idx = 0; idx < messages.length; idx++) {
    const record2 = messages[idx];
    const writeMs = Date.parse(record2.timestamp);
    if (record2.type === "system") {
      if (isCompressionResetRecord(record2)) {
        const afterAdmission = admissionMarker !== void 0 ? idx > markerIndex : Number.isFinite(writeMs) && writeMs >= targetAdmission.at;
        if (afterAdmission) compressedAfterAdmission = true;
      }
      continue;
    }
    if (!record2.message || record2.subtype === "realtime_message") continue;
    if (Number.isFinite(writeMs)) lastVisibleWriteMs = writeMs;
  }
  let lastOtherTerminalAt = 0;
  for (const record2 of records) {
    if (isPromptLedgerTerminalRecord(record2) && record2.promptId !== target) {
      if (record2.code === "prompt_deadline_exceeded") return;
      lastOtherTerminalAt = Math.max(lastOtherTerminalAt, record2.at);
    }
  }
  if (compressedAfterAdmission || !Number.isFinite(lastVisibleWriteMs) || lastVisibleWriteMs <= targetAdmission.at || lastVisibleWriteMs <= lastOtherTerminalAt) {
    return;
  }
  const { apiHistory, completedToolCallIds } = buildSessionHistoryFromConversation(resumed.conversation);
  const historyTail = apiHistory.slice(-TURN_INTERRUPTION_HISTORY_TAIL_COUNT);
  const verdict = detectTurnInterruption(historyTail, completedToolCallIds);
  const interrupted = verdict.kind !== "none" || tailHoldsAnyFunctionCall(historyTail);
  let refetch;
  try {
    refetch = readPromptLedgerRecords(ledgerPath);
  } catch {
    return;
  }
  if (refetch.length !== snapshotLength) return;
  const record = interrupted ? {
    v: 1,
    promptId: target,
    terminal: "interrupted",
    code: "daemon_lost",
    at: Date.now()
  } : {
    v: 1,
    promptId: target,
    terminal: "completed",
    stopReason: "reconstructed_from_transcript",
    at: Date.now()
  };
  try {
    appendPromptLedgerRecord(ledgerPath, record);
  } catch {
  }
}
__name(reconcileDanglingPromptTerminals, "reconcileDanglingPromptTerminals");
function isCompressionResetRecord(record) {
  if (record.type !== "system" || record.subtype !== "chat_compression") {
    return false;
  }
  return Boolean(
    record.systemPayload?.compressedHistory
  );
}
__name(isCompressionResetRecord, "isCompressionResetRecord");
function tailHoldsAnyFunctionCall(history) {
  const last = history[history.length - 1];
  if (last?.role !== "model") return false;
  return (last.parts ?? []).some((part) => part.functionCall !== void 0);
}
__name(tailHoldsAnyFunctionCall, "tailHoldsAnyFunctionCall");
var RECENT_TERMINALS_TAIL_BYTES = 256 * 1024;
function readRecentPromptTerminals(sessionService, sessionId) {
  try {
    const terminals = recentPromptTerminalRecords(
      readPromptLedgerRecords(sessionService.getPromptLedgerPath(sessionId), {
        tailBytes: RECENT_TERMINALS_TAIL_BYTES
      })
    );
    return terminals.length > 0 ? terminals : void 0;
  } catch {
    return void 0;
  }
}
__name(readRecentPromptTerminals, "readRecentPromptTerminals");
function withPromptTerminals(session, terminals) {
  if (terminals === void 0 || terminals.length === 0) return session;
  return { ...session, promptTerminals: [...terminals] };
}
__name(withPromptTerminals, "withPromptTerminals");

export {
  createPromptLedgerSink,
  readTranscriptTailUuid,
  reconcileDanglingPromptTerminals,
  readRecentPromptTerminals,
  withPromptTerminals
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
