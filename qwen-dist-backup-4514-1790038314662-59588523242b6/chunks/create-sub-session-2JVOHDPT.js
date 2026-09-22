// Force strict mode and setup for ESM
"use strict";
import {
  isReservedStandaloneSessionSourceType,
  isScheduledTaskRunSource
} from "./chunk-N4QWUPDM.js";
import {
  createSessionOrganizationService
} from "./chunk-UH6N3LO7.js";
import {
  ACTIVE_WORK_CLOSE_TIMEOUT_MS
} from "./chunk-RN6A53UJ.js";
import {
  SessionNotFoundError
} from "./chunk-YXHY6BKS.js";
import "./chunk-6PLDPT2C.js";
import "./chunk-47GVX3K4.js";
import "./chunk-GELRJXE2.js";
import "./chunk-32CM56LO.js";
import "./chunk-MC2RYJMU.js";
import "./chunk-LJZSMWOH.js";
import "./chunk-DJLCK66M.js";
import "./chunk-M5YIHMXP.js";
import "./chunk-7MEBNX4M.js";
import "./chunk-PWRMILYW.js";
import "./chunk-LAE6RY3L.js";
import "./chunk-FHWIBVQQ.js";
import "./chunk-FXPP7VLM.js";
import "./chunk-7PQ65Z5F.js";
import "./chunk-ZPJWUGCS.js";
import "./chunk-O4A2B6V2.js";
import "./chunk-CAAUC2LP.js";
import "./chunk-SQRZJD25.js";
import "./chunk-NCXNBDGJ.js";
import "./chunk-DJYHML3Y.js";
import "./chunk-HQI463JG.js";
import "./chunk-V2XJJTAB.js";
import "./chunk-DB5RX7EU.js";
import "./chunk-UXEI7POA.js";
import "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import "./chunk-PU756QJZ.js";
import "./chunk-RSFNJ6UU.js";
import "./chunk-JYGESWZM.js";
import "./chunk-TFDCK56Y.js";
import "./chunk-FTKXJMQV.js";
import "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import {
  SessionService
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import {
  stripTerminalControlSequences
} from "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-VNOVK4I7.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import {
  escapeXml
} from "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-6DB6UHY3.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import "./chunk-VPGRGNNH.js";
import "./chunk-ERIBG3BX.js";
import {
  Storage,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/create-sub-session.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var log = createDebugLogger("SUB_SESSION");
var MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER = 16;
var MAX_CONCURRENT_SUB_SESSIONS_TOTAL = 24;
var FIRST_TURN_TIMEOUT_MS = 5 * 6e4;
var SENT_MODE_DRAIN_TIMEOUT_MS = 30 * 6e4;
var RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS = 30 * 6e4;
var SENT_COMPLETION_DELIVERY_RETRY_MS = 100;
var SENT_COMPLETION_DELIVERY_MAX_RETRY_MS = 3e4;
var ROLLBACK_CLOSE_WATCHDOG_SLACK_MS = 5e3;
var MAX_RESULT_CHARS = 32e3;
var MAX_SENT_COMPLETION_MODEL_TEXT_CHARS = 32768;
var SENT_COMPLETION_RESULT_TRUNCATION_MARKER = "\n[\u2026result truncated]";
var MAX_NAME_LENGTH = 60;
var MAX_TRACKED_SPAWNED_SESSIONS = 1024;
var BIDI_CONTROL_MARKS = new RegExp(
  "[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "g"
);
function subSessionName(label, includeThreadGlyph = true) {
  const cleaned = stripTerminalControlSequences(label).replace(BIDI_CONTROL_MARKS, "").trim().replace(/\s+/g, " ");
  let short = cleaned;
  if (cleaned.length > MAX_NAME_LENGTH) {
    let cut = MAX_NAME_LENGTH - 1;
    const boundary = cleaned.charCodeAt(cut - 1);
    if (boundary >= 55296 && boundary <= 56319) cut -= 1;
    short = `${cleaned.slice(0, cut)}\u2026`;
  }
  return includeThreadGlyph ? `\u{1F9F5} ${short}` : short;
}
__name(subSessionName, "subSessionName");
function sentCompletionStatus(stopReason) {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled" || stopReason === "shutdown") {
    return "cancelled";
  }
  return "failed";
}
__name(sentCompletionStatus, "sentCompletionStatus");
function truncateCodePoints(value, max) {
  const codePoints = Array.from(value);
  if (codePoints.length <= max) return value;
  return `${codePoints.slice(0, Math.max(0, max - 1)).join("")}\u2026`;
}
__name(truncateCodePoints, "truncateCodePoints");
function escapeXmlWithinBudget(value, budget) {
  if (budget <= 0) return "";
  const escapedCodePoints = [];
  let length = 0;
  let truncated = false;
  for (const codePoint of value) {
    const escaped = escapeXml(codePoint);
    if (length + escaped.length > budget) {
      truncated = true;
      break;
    }
    escapedCodePoints.push(escaped);
    length += escaped.length;
  }
  if (!truncated) return escapedCodePoints.join("");
  while (escapedCodePoints.length > 0 && length + SENT_COMPLETION_RESULT_TRUNCATION_MARKER.length > budget) {
    length -= escapedCodePoints.pop().length;
  }
  return `${escapedCodePoints.join("")}${SENT_COMPLETION_RESULT_TRUNCATION_MARKER.length <= budget - length ? SENT_COMPLETION_RESULT_TRUNCATION_MARKER : ""}`;
}
__name(escapeXmlWithinBudget, "escapeXmlWithinBudget");
function buildSentCompletionNotification(sessionId, label, result, stopReason) {
  const status = sentCompletionStatus(stopReason);
  const boundedStopReason = truncateCodePoints(stopReason, 128);
  const statusText = status === "completed" ? "completed" : status === "cancelled" ? "was cancelled" : `failed (${boundedStopReason})`;
  const sessionLink = `[\u{1F9F5} ${sessionId.slice(0, 8)}](qwen-session://${sessionId})`;
  const safeResult = result.trim() || `No text output (stopReason: ${stopReason}).`;
  const modelSessionId = truncateCodePoints(sessionId, 256);
  const modelLabel = truncateCodePoints(label, 256);
  const modelTextPrefix = [
    "<task-notification>",
    `<task-id>${escapeXml(modelSessionId)}</task-id>`,
    `<status>${status}</status>`,
    `<summary>Sub-session &quot;${escapeXml(modelLabel)}&quot; ${escapeXml(statusText)}.</summary>`,
    `<session-link>qwen-session://${escapeXml(modelSessionId)}</session-link>`,
    "<result>"
  ].join("");
  const modelTextSuffix = "</result></task-notification>";
  const resultBudget = Math.max(
    0,
    MAX_SENT_COMPLETION_MODEL_TEXT_CHARS - modelTextPrefix.length - modelTextSuffix.length
  );
  const modelText = `${modelTextPrefix}${escapeXmlWithinBudget(
    safeResult,
    resultBudget
  )}${modelTextSuffix}`;
  return {
    displayText: `Sub-session ${sessionLink} ${statusText}.`,
    modelText,
    taskId: sessionId,
    status,
    kind: "agent",
    // `subSessionName` strips bidi and control marks and trims, so a name that
    // was only those characters leaves an empty label -- which the receiving
    // gate rejects as invalid params. The acceptance wait treats that as
    // retryable and gives up 30 minutes later, so the parent's completion turn
    // never runs. An absent label is valid; an empty one is not.
    ...modelLabel.trim() ? { label: modelLabel } : {}
  };
}
__name(buildSentCompletionNotification, "buildSentCompletionNotification");
function isBackgroundNotificationForTask(event, taskId) {
  if (event.type !== "session_update") return false;
  const update = event.data?.update;
  return update?._meta?.source === "background_notification" && update._meta.backgroundTask?.taskId === taskId;
}
__name(isBackgroundNotificationForTask, "isBackgroundNotificationForTask");
async function awaitRecoveredParentNotification(bridge, sessionId, notification, lastEventId, eventEpoch, stopSignal) {
  const timeoutAc = new AbortController();
  const timer = setTimeout(
    () => timeoutAc.abort(),
    RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS
  );
  if (typeof timer.unref === "function") timer.unref();
  const signal = AbortSignal.any([stopSignal, timeoutAc.signal]);
  let observedOwnNotification = false;
  try {
    for await (const event of bridge.subscribeEvents(sessionId, {
      lastEventId,
      epoch: eventEpoch,
      signal
    })) {
      if (isBackgroundNotificationForTask(event, notification.taskId)) {
        observedOwnNotification = true;
      } else if (observedOwnNotification && event.type === "background_notification_turn_complete") {
        return true;
      }
    }
  } finally {
    clearTimeout(timer);
    timeoutAc.abort();
  }
  return false;
}
__name(awaitRecoveredParentNotification, "awaitRecoveredParentNotification");
async function waitForSentCompletionRetry(signal, attempt) {
  if (signal.aborted) throw signal.reason;
  const delay = Math.min(
    SENT_COMPLETION_DELIVERY_RETRY_MS * 2 ** attempt,
    SENT_COMPLETION_DELIVERY_MAX_RETRY_MS
  );
  await new Promise((resolve, reject) => {
    const onAbort = /* @__PURE__ */ __name(() => {
      clearTimeout(timer);
      reject(signal.reason);
    }, "onAbort");
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
__name(waitForSentCompletionRetry, "waitForSentCompletionRetry");
async function awaitSentCompletionAcceptance(bridge, parentSessionId, notification, stopSignal, deadline) {
  let lastError;
  let attempt = 0;
  while (!stopSignal.aborted) {
    try {
      const acknowledgement = await bridge.enqueueBackgroundNotification(
        parentSessionId,
        notification
      );
      if (acknowledgement.accepted) return "accepted";
    } catch (error) {
      if (error instanceof SessionNotFoundError) return "missing";
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Parent ${parentSessionId} did not durably accept completion for sub-session ${notification.taskId}.`,
        lastError === void 0 ? void 0 : { cause: lastError }
      );
    }
    await waitForSentCompletionRetry(stopSignal, attempt);
    attempt += 1;
  }
  throw stopSignal.reason;
}
__name(awaitSentCompletionAcceptance, "awaitSentCompletionAcceptance");
async function deliverSentCompletion(bridge, boundWorkspace, parentSessionId, notification, stopSignal, isolatedWorkspace, standaloneService) {
  const deadline = Date.now() + RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS;
  const initialDelivery = await awaitSentCompletionAcceptance(
    bridge,
    parentSessionId,
    notification,
    stopSignal,
    deadline
  );
  if (initialDelivery === "accepted") return;
  if (standaloneService) {
    await standaloneService.resume(parentSessionId);
    let ownerBridge;
    let ownerSessionId = "";
    let lastEventId = 0;
    let eventEpoch = "";
    const recoveredDelivery = await standaloneService.continueSession(
      parentSessionId,
      async (runtime, canonicalSessionId) => {
        ownerBridge = runtime.bridge;
        ownerSessionId = canonicalSessionId;
        lastEventId = runtime.bridge.getSessionLastEventId(canonicalSessionId);
        eventEpoch = runtime.bridge.getSessionEventEpoch(canonicalSessionId);
        return awaitSentCompletionAcceptance(
          runtime.bridge,
          canonicalSessionId,
          notification,
          stopSignal,
          deadline
        );
      }
    );
    if (recoveredDelivery === "missing" || !ownerBridge || !ownerSessionId) {
      throw new SessionNotFoundError(parentSessionId);
    }
    void awaitRecoveredParentNotification(
      ownerBridge,
      ownerSessionId,
      notification,
      lastEventId,
      eventEpoch,
      stopSignal
    ).then(
      (continuationCompleted) => {
        if (!continuationCompleted && !stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion for sub-session ${notification.taskId}, but its automatic continuation did not reach an end-turn boundary; leaving recovery attachment for the idle reaper`
          );
        }
      },
      (error) => {
        if (!stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion for sub-session ${notification.taskId}, but its automatic continuation could not be observed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    );
    return;
  }
  let restoredParent;
  const isolatedCwd = isolatedWorkspace ? await isolatedWorkspace.materializeDirectory(parentSessionId) : void 0;
  let materializedDirectoryUnused = isolatedCwd !== void 0;
  try {
    restoredParent = await bridge.resumeSession({
      sessionId: parentSessionId,
      workspaceCwd: boundWorkspace
    });
    if (isolatedCwd !== void 0) {
      if (restoredParent.hasActivePrompt === true && restoredParent.currentCwd !== isolatedCwd) {
        throw new Error(
          "Active restored parent is outside its isolated conversation directory."
        );
      }
      if (restoredParent.hasActivePrompt === true) {
        materializedDirectoryUnused = false;
      }
      if (restoredParent.hasActivePrompt !== true) {
        materializedDirectoryUnused = false;
        const changed = await bridge.changeSessionCwd(parentSessionId, {
          path: isolatedCwd,
          allowedRoots: [boundWorkspace],
          managedRelocation: "live-conversation"
        });
        if (changed.newCwd !== isolatedCwd) {
          materializedDirectoryUnused = true;
          throw new Error(
            "Restored parent workspace directory relocation was rejected."
          );
        }
        restoredParent.currentCwd = changed.newCwd;
      }
    }
    const lastEventId = bridge.getSessionLastEventId(parentSessionId);
    const eventEpoch = bridge.getSessionEventEpoch(parentSessionId);
    const recoveredDelivery = await awaitSentCompletionAcceptance(
      bridge,
      parentSessionId,
      notification,
      stopSignal,
      deadline
    );
    if (recoveredDelivery === "missing") {
      throw new SessionNotFoundError(parentSessionId);
    }
    void awaitRecoveredParentNotification(
      bridge,
      parentSessionId,
      notification,
      lastEventId,
      eventEpoch,
      stopSignal
    ).then(
      (continuationCompleted) => {
        if (!continuationCompleted && !stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion for sub-session ${notification.taskId}, but its automatic continuation did not reach an end-turn boundary; leaving recovery attachment for the idle reaper`
          );
        }
      },
      (error) => {
        if (!stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion for sub-session ${notification.taskId}, but its automatic continuation could not be observed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    );
  } catch (error) {
    let recoveredParentClosed = false;
    if (restoredParent !== void 0) {
      try {
        if (restoredParent.hasActivePrompt === true) {
          if (restoredParent.clientId) {
            await bridge.detachClient(
              restoredParent.sessionId,
              restoredParent.clientId
            );
          }
        } else if (restoredParent.attached) {
          if (restoredParent.clientId) {
            await bridge.detachClient(
              restoredParent.sessionId,
              restoredParent.clientId
            );
          }
        } else {
          recoveredParentClosed = await bridge.killSession(
            restoredParent.sessionId,
            { requireZeroAttaches: true }
          );
        }
      } catch {
        recoveredParentClosed = false;
      }
    }
    if (isolatedWorkspace && isolatedCwd !== void 0 && (recoveredParentClosed || materializedDirectoryUnused)) {
      await isolatedWorkspace.discardEmptyDirectory(parentSessionId).catch(() => {
      });
    }
    throw error;
  }
}
__name(deliverSentCompletion, "deliverSentCompletion");
async function awaitFirstTurn(bridge, sessionId, promptId, lastEventId, timeoutMs, stopSignal) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const composed = stopSignal ? AbortSignal.any([ac.signal, stopSignal]) : ac.signal;
  let acc = "";
  let truncated = false;
  let stopReason;
  const appendChunk = /* @__PURE__ */ __name((text) => {
    if (truncated) return;
    if (acc.length + text.length > MAX_RESULT_CHARS) {
      let cut = Math.max(0, MAX_RESULT_CHARS - acc.length);
      if (cut > 0) {
        const code = text.charCodeAt(cut - 1);
        if (code >= 55296 && code <= 56319) cut -= 1;
      }
      acc += text.slice(0, cut);
      truncated = true;
    } else {
      acc += text;
    }
  }, "appendChunk");
  try {
    for await (const e of bridge.subscribeEvents(sessionId, {
      lastEventId,
      signal: composed
    })) {
      if (e.type === "session_update") {
        const d = e.data;
        if (d?.update?.sessionUpdate === "agent_message_chunk" && typeof d.update.content?.text === "string" && (e.promptId === void 0 || e.promptId === promptId) && d.update._meta?.source !== "background_task_completed" && d.update._meta?.source !== "background_notification" && d.update._meta?.source !== "background_notification_turn_started") {
          appendChunk(d.update.content.text);
        }
      } else if (e.type === "turn_complete") {
        const d = e.data;
        if (d?.promptId === promptId) {
          stopReason = d.stopReason ?? "end_turn";
          break;
        }
      } else if (e.type === "turn_error") {
        const d = e.data;
        if (d?.promptId === promptId) {
          stopReason = "error";
          if (d.message && !truncated) {
            const suffix = `${acc ? "\n" : ""}[turn error] ${d.message}`;
            if (acc.length + suffix.length <= MAX_RESULT_CHARS) {
              acc += suffix;
            } else {
              truncated = true;
            }
          }
          break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  if (stopReason === void 0) {
    stopReason = stopSignal?.aborted ? "shutdown" : timedOut ? "timeout" : "incomplete";
  }
  if (truncated) acc += "\n[\u2026output truncated]";
  return { result: acc, stopReason };
}
__name(awaitFirstTurn, "awaitFirstTurn");
function createSubSessionLauncher(opts) {
  const {
    getBridge,
    getStandaloneSessionService,
    boundWorkspace,
    runtimeBaseDir,
    notifySentCompletion = false,
    isolatedWorkspace
  } = opts;
  const firstTurnTimeoutMs = opts.firstTurnTimeoutMs ?? FIRST_TURN_TIMEOUT_MS;
  const sentModeDrainTimeoutMs = opts.sentModeDrainTimeoutMs ?? SENT_MODE_DRAIN_TIMEOUT_MS;
  const maxConcurrentPerCaller = opts.maxConcurrentPerCaller ?? MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER;
  const maxConcurrentTotal = Math.min(
    opts.maxConcurrentTotal ?? MAX_CONCURRENT_SUB_SESSIONS_TOTAL,
    MAX_TRACKED_SPAWNED_SESSIONS
  );
  const inflight = /* @__PURE__ */ new Map();
  const spawnedSessionIds = /* @__PURE__ */ new Set();
  const stopAc = new AbortController();
  let inflightTotal = 0;
  const release = /* @__PURE__ */ __name((key) => {
    const n = (inflight.get(key) ?? 1) - 1;
    if (n <= 0) inflight.delete(key);
    else inflight.set(key, n);
    inflightTotal = Math.max(0, inflightTotal - 1);
  }, "release");
  const rememberSpawned = /* @__PURE__ */ __name((sessionId) => {
    spawnedSessionIds.add(sessionId);
    while (spawnedSessionIds.size > MAX_TRACKED_SPAWNED_SESSIONS) {
      const oldest = spawnedSessionIds.values().next().value;
      if (oldest === void 0) break;
      spawnedSessionIds.delete(oldest);
    }
  }, "rememberSpawned");
  const launch = /* @__PURE__ */ __name(async (info) => {
    if (stopAc.signal.aborted) {
      throw new Error(
        "The daemon is shutting down; cannot create a sub-session."
      );
    }
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Session bridge is not available.");
    }
    const caller = bridge.getSessionSummary(info.callerSessionId);
    const standalone = isReservedStandaloneSessionSourceType(caller.sourceType);
    const standaloneService = standalone ? getStandaloneSessionService?.() : void 0;
    if (standalone && !standaloneService) {
      throw new Error("Standalone session service is unavailable.");
    }
    if (spawnedSessionIds.has(info.callerSessionId) || caller.parentSessionId !== void 0) {
      throw new Error(
        "A sub-session cannot create further sub-sessions (nesting is capped at one level)."
      );
    }
    const key = info.callerSessionId;
    const current = inflight.get(key) ?? 0;
    if (current >= maxConcurrentPerCaller) {
      throw new Error(
        `Too many concurrent sub-sessions for this session (cap ${maxConcurrentPerCaller}); wait for one to finish.`
      );
    }
    if (inflightTotal >= maxConcurrentTotal) {
      throw new Error(
        `Too many concurrent sub-sessions in this workspace (cap ${maxConcurrentTotal}); wait for one to finish.`
      );
    }
    inflight.set(key, current + 1);
    inflightTotal += 1;
    let released = false;
    const releaseOnce = /* @__PURE__ */ __name(() => {
      if (released) return;
      released = true;
      release(key);
    }, "releaseOnce");
    let spawnedSession;
    let promptAdmitted = false;
    try {
      const promptId = randomUUID();
      let lastEventId;
      let turn;
      let promptAdmission;
      let sub;
      if (standalone) {
        const created = await standaloneService.createChildWithInitialPrompt(
          {
            sessionId: randomUUID(),
            parentSessionId: info.callerSessionId,
            promptId,
            ...info.sourceType ? { sourceType: info.sourceType } : {},
            ...info.sourceId ? { sourceId: info.sourceId } : {},
            ...info.model ? { modelServiceId: info.model } : {}
          },
          info.prompt
        );
        sub = created.session;
        lastEventId = created.initialPrompt.lastEventId;
        turn = created.initialPrompt.turn;
      } else {
        sub = await bridge.spawnOrAttach({
          workspaceCwd: boundWorkspace,
          sessionScope: "thread",
          // force a fresh top-level session, never attach
          // Record the caller as the sub-session's parent so the UI can link it
          // back. Persisted into the sub-session's transcript at spawn time.
          parentSessionId: info.callerSessionId,
          ...info.sourceType ? { sourceType: info.sourceType } : {},
          ...info.sourceId ? { sourceId: info.sourceId } : {},
          ...info.model ? { modelServiceId: info.model } : {}
        });
      }
      spawnedSession = sub;
      const sessionId = sub.sessionId;
      if (!standalone && isScheduledTaskRunSource(info) && info.model && sub.modelApplied === false) {
        throw new Error(`sub-session model selection failed: ${info.model}`);
      }
      if (isolatedWorkspace && !standalone) {
        const isolatedCwd = await isolatedWorkspace.materializeDirectory(sessionId);
        const changed = await bridge.changeSessionCwd(sessionId, {
          path: isolatedCwd,
          allowedRoots: [boundWorkspace],
          managedRelocation: "live-conversation"
        });
        if (changed.newCwd !== isolatedCwd) {
          throw new Error(
            "Sub-session workspace directory relocation was rejected."
          );
        }
      }
      rememberSpawned(sessionId);
      try {
        bridge.updateSessionMetadata(sessionId, {
          // A per-run scheduled task child is titled like its manual-run
          // sibling (see the scheduled-task route): flat, no thread glyph.
          displayName: subSessionName(
            info.name ?? info.prompt,
            !isScheduledTaskRunSource(info)
          ),
          titleSource: "auto"
        });
      } catch (err) {
        log.debug("sub-session: updateSessionMetadata failed", sessionId, err);
      }
      if (!standalone) {
        lastEventId = bridge.getSessionLastEventId(sessionId);
        let markPromptAdmitted;
        promptAdmission = new Promise((resolve) => {
          markPromptAdmitted = resolve;
        });
        const onPromptAdmitted = /* @__PURE__ */ __name(() => {
          promptAdmitted = true;
          markPromptAdmitted();
        }, "onPromptAdmitted");
        turn = bridge.sendPrompt(
          sessionId,
          {
            sessionId,
            prompt: [{ type: "text", text: info.prompt }]
          },
          void 0,
          { promptId, onPromptAdmitted }
        );
      }
      void turn.catch((err) => {
        log.debug("sub-session: sendPrompt rejected", sessionId, String(err));
      });
      if (isScheduledTaskRunSource(info) && promptAdmission) {
        await Promise.race([
          promptAdmission,
          turn.then(
            () => void 0,
            (err) => Promise.reject(
              new Error(
                `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`
              )
            )
          )
        ]);
      }
      if (info.groupId) {
        try {
          const assign = /* @__PURE__ */ __name(() => createSessionOrganizationService(
            boundWorkspace
          ).updateSessionOrganization(sessionId, {
            groupId: info.groupId,
            color: null
          }), "assign");
          if (runtimeBaseDir) {
            await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, assign);
          } else {
            await assign();
          }
          bridge.markSessionCatalogChanged();
        } catch (error) {
          writeStderrLine(
            `qwen serve: scheduled-task session ${sessionId} could not be assigned to group ${info.groupId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      if (info.completion === "sent") {
        const drainAc = new AbortController();
        const drainSignal = AbortSignal.any([stopAc.signal, drainAc.signal]);
        void (async () => {
          try {
            let notification;
            try {
              const turnError = turn.then(
                () => new Promise(() => {
                }),
                (err) => Promise.reject(
                  new Error(
                    `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`
                  )
                )
              );
              const completion = await Promise.race([
                awaitFirstTurn(
                  bridge,
                  sessionId,
                  promptId,
                  lastEventId,
                  sentModeDrainTimeoutMs,
                  drainSignal
                ),
                turnError
              ]);
              if (stopAc.signal.aborted) return;
              if (completion.stopReason === "timeout") {
                writeStderrLine(
                  `qwen serve: sub-session ${sessionId} drain timed out after ${Math.round(sentModeDrainTimeoutMs / 6e4)}min; releasing its concurrency slot (the sub-session may still be running)`
                );
              }
              if (notifySentCompletion) {
                notification = buildSentCompletionNotification(
                  sessionId,
                  subSessionName(info.name ?? info.prompt, false),
                  completion.result,
                  completion.stopReason
                );
              }
            } catch (err) {
              if (stopAc.signal.aborted) return;
              if (!notifySentCompletion) return;
              const message = err instanceof Error ? err.message : String(err);
              notification = buildSentCompletionNotification(
                sessionId,
                subSessionName(info.name ?? info.prompt, false),
                message,
                "error"
              );
            }
            if (!notification) return;
            try {
              await deliverSentCompletion(
                bridge,
                boundWorkspace,
                info.callerSessionId,
                notification,
                stopAc.signal,
                isolatedWorkspace,
                standaloneService
              );
            } catch (notificationError) {
              if (!stopAc.signal.aborted) {
                writeStderrLine(
                  `qwen serve: sub-session ${sessionId} completion could not be returned to parent ${info.callerSessionId}: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`
                );
              }
            }
          } finally {
            drainAc.abort();
            releaseOnce();
          }
        })();
        return {
          sessionId,
          ...sub.parentSessionPersisted !== void 0 ? { parentSessionPersisted: sub.parentSessionPersisted } : {}
        };
      }
      try {
        const turnError = turn.then(
          () => new Promise(() => {
          }),
          // never resolves on success
          (err) => Promise.reject(
            new Error(
              `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
        );
        const firstTurn = awaitFirstTurn(
          bridge,
          sessionId,
          promptId,
          lastEventId,
          firstTurnTimeoutMs,
          stopAc.signal
        );
        const { result, stopReason } = await Promise.race([
          firstTurn,
          turnError
        ]);
        return {
          sessionId,
          result,
          stopReason,
          ...sub.parentSessionPersisted !== void 0 ? { parentSessionPersisted: sub.parentSessionPersisted } : {}
        };
      } finally {
        releaseOnce();
      }
    } catch (err) {
      releaseOnce();
      if (spawnedSession !== void 0 && isolatedWorkspace && !standalone) {
        const sessionId = spawnedSession.sessionId;
        let sessionClosed = false;
        try {
          if (spawnedSession.attached) {
            if (spawnedSession.clientId) {
              await bridge.detachClient(sessionId, spawnedSession.clientId);
            }
          } else {
            sessionClosed = await bridge.killSession(sessionId, {
              requireZeroAttaches: true
            });
          }
        } catch (cleanupError) {
          log.debug(
            "sub-session: isolated session rollback failed",
            sessionId,
            cleanupError
          );
        }
        if (sessionClosed) {
          if (!promptAdmitted) {
            try {
              const removeTranscript = /* @__PURE__ */ __name(() => new SessionService(boundWorkspace).removeSession(sessionId), "removeTranscript");
              const transcriptRemoved = runtimeBaseDir ? await Storage.runWithResolvedRuntimeBaseDir(
                runtimeBaseDir,
                removeTranscript
              ) : await removeTranscript();
              if (transcriptRemoved) bridge.markSessionCatalogChanged();
            } catch (cleanupError) {
              log.debug(
                "sub-session: isolated transcript cleanup failed",
                sessionId,
                cleanupError
              );
            }
          }
          try {
            await isolatedWorkspace.discardEmptyDirectory(sessionId);
          } catch (cleanupError) {
            log.debug(
              "sub-session: isolated workspace cleanup failed",
              sessionId,
              cleanupError
            );
          }
        }
      } else if (spawnedSession !== void 0 && !standalone) {
        const sessionId = spawnedSession.sessionId;
        let sessionClosed = false;
        let closeTimer;
        try {
          await Promise.race([
            bridge.closeSession(sessionId, void 0, {
              reason: "sub_session_rollback",
              agentCloseTimeoutMs: ACTIVE_WORK_CLOSE_TIMEOUT_MS
            }),
            new Promise((_, reject) => {
              closeTimer = setTimeout(
                () => reject(
                  new Error(
                    `Timed out closing rolled-back sub-session ${sessionId}`
                  )
                ),
                ACTIVE_WORK_CLOSE_TIMEOUT_MS + ROLLBACK_CLOSE_WATCHDOG_SLACK_MS
              );
              if (typeof closeTimer.unref === "function") closeTimer.unref();
            })
          ]);
          sessionClosed = true;
        } catch (closeErr) {
          log.debug("sub-session: closeSession threw", sessionId, closeErr);
        } finally {
          if (closeTimer !== void 0) clearTimeout(closeTimer);
        }
        if (!sessionClosed) {
          try {
            sessionClosed = await bridge.killSession(sessionId, {
              requireZeroAttaches: true
            });
          } catch (killErr) {
            log.debug("sub-session: killSession threw", sessionId, killErr);
          }
        }
        if (sessionClosed && !promptAdmitted) {
          try {
            const removeTranscript = /* @__PURE__ */ __name(() => new SessionService(boundWorkspace).removeSession(sessionId), "removeTranscript");
            const transcriptRemoved = runtimeBaseDir ? await Storage.runWithResolvedRuntimeBaseDir(
              runtimeBaseDir,
              removeTranscript
            ) : await removeTranscript();
            if (transcriptRemoved) bridge.markSessionCatalogChanged();
          } catch (cleanupError) {
            log.debug(
              "sub-session: transcript cleanup failed",
              sessionId,
              cleanupError
            );
          }
        }
      }
      writeStderrLine(
        `qwen serve: create_sub_session failed: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }, "launch");
  return {
    launch,
    stop: /* @__PURE__ */ __name(() => {
      stopAc.abort();
    }, "stop")
  };
}
__name(createSubSessionLauncher, "createSubSessionLauncher");
export {
  MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER,
  MAX_CONCURRENT_SUB_SESSIONS_TOTAL,
  MAX_TRACKED_SPAWNED_SESSIONS,
  createSubSessionLauncher
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
