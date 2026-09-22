// Force strict mode and setup for ESM
"use strict";
import {
  escapeAnsiCtrlCodes
} from "./chunk-47ECGEJC.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  wrapper_default
} from "./chunk-J5TTWBZK.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/voice/voice-stream-session.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var CONNECT_TIMEOUT_MS = 8e3;
var FINISH_TIMEOUT_MS = 6e4;
var MAX_BUFFERED_AUDIO_BYTES = 1024 * 1024;
var MAX_SERVER_ERROR_MESSAGE_LENGTH = 200;
var debugLogger = createDebugLogger("VOICE_STREAM_SESSION");
function deriveWebSocketBase(baseUrl) {
  const url = new URL(baseUrl);
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  let prefix = url.pathname.replace(/\/+$/, "");
  if (prefix.endsWith("/compatible-mode/v1")) {
    prefix = prefix.slice(0, -"/compatible-mode/v1".length);
  } else if (prefix.endsWith("/v1")) {
    prefix = prefix.slice(0, -"/v1".length);
  }
  return `${wsScheme}//${url.host}${prefix}`;
}
__name(deriveWebSocketBase, "deriveWebSocketBase");
function deriveStreamUrl(baseUrl) {
  return `${deriveWebSocketBase(baseUrl)}/api-ws/v1/inference`;
}
__name(deriveStreamUrl, "deriveStreamUrl");
function formatServerErrorMessage(raw) {
  const text = typeof raw === "string" ? raw : "unknown";
  return escapeAnsiCtrlCodes(text).slice(0, MAX_SERVER_ERROR_MESSAGE_LENGTH);
}
__name(formatServerErrorMessage, "formatServerErrorMessage");
function openVoiceStream(config, callbacks = {}, deps = {}) {
  const createWebSocket = deps.createWebSocket ?? ((url, options) => new wrapper_default(url, {
    headers: options.headers
  }));
  return new Promise((resolve, reject) => {
    if (deps.abortSignal?.aborted) {
      reject(new Error("Voice stream opening was aborted."));
      return;
    }
    const streamUrl = deriveStreamUrl(config.baseUrl);
    const ws = createWebSocket(streamUrl, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
    });
    const taskId = randomUUID();
    let started = false;
    let settled = false;
    let committed = "";
    let finishPromise = null;
    let finishResolve = null;
    let finishReject = null;
    let finishTimer = null;
    let connectTimer = null;
    let terminalError = null;
    let finishedTranscript = null;
    let backpressureWarned = false;
    let onAbort;
    const removeAbortListener = /* @__PURE__ */ __name(() => {
      if (!onAbort) return;
      deps.abortSignal?.removeEventListener("abort", onAbort);
      onAbort = void 0;
    }, "removeAbortListener");
    const clearFinishTimer = /* @__PURE__ */ __name(() => {
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
    }, "clearFinishTimer");
    const clearConnectTimer = /* @__PURE__ */ __name(() => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    }, "clearConnectTimer");
    const fail = /* @__PURE__ */ __name((error) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      const normalized = error instanceof Error ? error : new Error(String(error));
      clearConnectTimer();
      clearFinishTimer();
      try {
        ws.close();
      } catch {
      }
      if (finishReject) {
        finishReject(normalized);
        finishResolve = null;
        finishReject = null;
      } else {
        terminalError = normalized;
        if (!started) {
          reject(normalized);
        } else {
          callbacks.onError?.(normalized);
        }
      }
    }, "fail");
    if (deps.abortSignal) {
      onAbort = /* @__PURE__ */ __name(() => fail(new Error("Voice stream opening was aborted.")), "onAbort");
      if (deps.abortSignal.aborted) {
        onAbort();
        return;
      }
      deps.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    connectTimer = setTimeout(() => {
      if (!started) fail(new Error("Voice stream connection timed out."));
    }, CONNECT_TIMEOUT_MS);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: config.model,
            parameters: {
              format: "pcm",
              sample_rate: 16e3,
              ...config.language ? { language_hints: [config.language] } : {}
            },
            input: {}
          }
        })
      );
    });
    ws.on("message", (...args) => {
      const data = args[0];
      const isBinary = args[1] === true;
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch (error) {
        debugLogger.warn("[voice] failed to parse stream message:", error);
        return;
      }
      const event = msg.header?.event;
      if (event === "task-started") {
        started = true;
        clearConnectTimer();
        resolve({
          pushAudio: /* @__PURE__ */ __name((pcm) => {
            if (ws.readyState === ws.OPEN && pcm.length > 0 && (ws.bufferedAmount ?? 0) <= MAX_BUFFERED_AUDIO_BYTES) {
              backpressureWarned = false;
              ws.send(pcm);
            } else if (pcm.length > 0 && !backpressureWarned) {
              backpressureWarned = true;
              debugLogger.warn(
                "[voice] dropping DashScope audio due to socket backpressure"
              );
            }
          }, "pushAudio"),
          finish: /* @__PURE__ */ __name(() => {
            if (finishPromise) return finishPromise;
            finishPromise = new Promise((res, rej) => {
              if (finishedTranscript !== null) {
                res(finishedTranscript);
                return;
              }
              if (terminalError) {
                rej(terminalError);
                return;
              }
              finishResolve = res;
              finishReject = rej;
              finishTimer = setTimeout(() => {
                fail(new Error("Voice stream finish timed out."));
              }, FINISH_TIMEOUT_MS);
              try {
                ws.send(
                  JSON.stringify({
                    header: {
                      action: "finish-task",
                      task_id: taskId,
                      streaming: "duplex"
                    },
                    payload: { input: {} }
                  })
                );
              } catch (error) {
                fail(error);
              }
            });
            return finishPromise;
          }, "finish"),
          abort: /* @__PURE__ */ __name(() => {
            try {
              ws.close();
            } catch {
            }
          }, "abort")
        });
      } else if (event === "result-generated") {
        const sentence = msg.payload?.output?.sentence;
        if (sentence && !sentence.heartbeat && typeof sentence.text === "string") {
          if (sentence.sentence_end) {
            committed = committed ? `${committed} ${sentence.text}` : sentence.text;
            callbacks.onInterim?.(committed);
          } else {
            const running = committed ? `${committed} ${sentence.text}` : sentence.text;
            callbacks.onInterim?.(running);
          }
        }
      } else if (event === "task-finished") {
        if (!started) {
          fail(new Error("Voice stream finished before it started."));
          return;
        }
        finishedTranscript = committed.trim();
        settled = true;
        removeAbortListener();
        clearConnectTimer();
        clearFinishTimer();
        try {
          ws.close();
        } catch {
        }
        finishResolve?.(finishedTranscript);
        finishResolve = null;
        finishReject = null;
      } else if (event === "task-failed") {
        clearConnectTimer();
        fail(
          new Error(
            `Voice stream failed at ${streamUrl} task ${taskId} (${msg.header?.error_code ?? "error"}): ${formatServerErrorMessage(
              msg.header?.error_message
            )}`
          )
        );
      }
    });
    ws.on("error", (...args) => {
      clearConnectTimer();
      const error = args[0];
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    ws.on("close", () => {
      removeAbortListener();
      clearConnectTimer();
      clearFinishTimer();
      if (settled) return;
      if (started && finishReject) {
        settled = true;
        finishReject(
          new Error(
            "Voice stream connection closed unexpectedly. Transcript may be incomplete."
          )
        );
        finishResolve = null;
        finishReject = null;
      } else if (!started) {
        fail(new Error("Voice stream closed before it started."));
      } else {
        const err = new Error(
          "Voice stream connection closed unexpectedly. Transcript may be incomplete."
        );
        terminalError ??= err;
        callbacks.onError?.(err);
      }
    });
  });
}
__name(openVoiceStream, "openVoiceStream");

// packages/cli/src/ui/voice/qwen-asr-realtime-session.ts
init_esbuild_shims();
import { randomUUID as randomUUID2 } from "node:crypto";
var CONNECT_TIMEOUT_MS2 = 8e3;
var FINISH_TIMEOUT_MS2 = 6e4;
var MAX_BUFFERED_AUDIO_BYTES2 = 1024 * 1024;
var MAX_SERVER_ERROR_MESSAGE_LENGTH2 = 200;
var debugLogger2 = createDebugLogger("VOICE_QWEN_REALTIME");
function deriveQwenRealtimeUrl(baseUrl, model) {
  return `${deriveWebSocketBase(baseUrl)}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}
__name(deriveQwenRealtimeUrl, "deriveQwenRealtimeUrl");
function appendTranscript(existing, next) {
  const text = next.trim();
  if (!text) return existing;
  return existing ? `${existing} ${text}` : text;
}
__name(appendTranscript, "appendTranscript");
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
__name(toError, "toError");
function formatServerErrorMessage2(raw) {
  const text = typeof raw === "string" ? raw : "Qwen ASR realtime failed.";
  return escapeAnsiCtrlCodes(text).slice(0, MAX_SERVER_ERROR_MESSAGE_LENGTH2);
}
__name(formatServerErrorMessage2, "formatServerErrorMessage");
function openQwenAsrRealtimeStream(config, callbacks = {}, deps = {}) {
  const createWebSocket = deps.createWebSocket ?? ((url, options) => new wrapper_default(url, {
    headers: options.headers
  }));
  return new Promise((resolve, reject) => {
    if (deps.abortSignal?.aborted) {
      reject(new Error("Voice stream opening was aborted."));
      return;
    }
    const ws = createWebSocket(
      deriveQwenRealtimeUrl(config.baseUrl, config.model),
      {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
      }
    );
    let opened = false;
    let openSettled = false;
    let committed = "";
    let finishPromise = null;
    let finishResolve = null;
    let finishReject = null;
    let finishTimer = null;
    let connectTimer = null;
    let finishedTranscript = null;
    let terminalError = null;
    let failed = false;
    let backpressureWarned = false;
    let onAbort;
    const removeAbortListener = /* @__PURE__ */ __name(() => {
      if (!onAbort) return;
      deps.abortSignal?.removeEventListener("abort", onAbort);
      onAbort = void 0;
    }, "removeAbortListener");
    const sendJson = /* @__PURE__ */ __name((body) => {
      ws.send(JSON.stringify({ event_id: randomUUID2(), ...body }));
    }, "sendJson");
    const close = /* @__PURE__ */ __name(() => {
      try {
        ws.close();
      } catch {
      }
    }, "close");
    const clearFinishTimer = /* @__PURE__ */ __name(() => {
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
    }, "clearFinishTimer");
    const clearConnectTimer = /* @__PURE__ */ __name(() => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    }, "clearConnectTimer");
    const fail = /* @__PURE__ */ __name((error) => {
      if (failed) return;
      failed = true;
      removeAbortListener();
      const normalized = toError(error);
      clearConnectTimer();
      clearFinishTimer();
      close();
      if (finishReject) {
        finishReject(normalized);
        finishResolve = null;
        finishReject = null;
        return;
      }
      if (!openSettled) {
        openSettled = true;
        reject(normalized);
        return;
      }
      terminalError = normalized;
      callbacks.onError?.(normalized);
    }, "fail");
    if (deps.abortSignal) {
      onAbort = /* @__PURE__ */ __name(() => fail(new Error("Voice stream opening was aborted.")), "onAbort");
      if (deps.abortSignal.aborted) {
        onAbort();
        return;
      }
      deps.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    connectTimer = setTimeout(() => {
      if (!opened) fail(new Error("Qwen ASR realtime connection timed out."));
    }, CONNECT_TIMEOUT_MS2);
    const sendSessionUpdate = /* @__PURE__ */ __name(() => {
      sendJson({
        type: "session.update",
        session: {
          input_audio_format: "pcm",
          sample_rate: 16e3,
          input_audio_transcription: {
            ...config.language ? { language: config.language } : {},
            ...config.keytermsContext ? { corpus_text: config.keytermsContext } : {}
          },
          turn_detection: null
        }
      });
    }, "sendSessionUpdate");
    ws.on("message", (...args) => {
      const data = args[0];
      const isBinary = args[1] === true;
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch (error) {
        debugLogger2.warn(
          "[voice] failed to parse Qwen ASR realtime message:",
          error
        );
        return;
      }
      switch (msg.type) {
        case "session.created":
          sendSessionUpdate();
          break;
        case "session.updated":
          opened = true;
          openSettled = true;
          clearConnectTimer();
          resolve({
            pushAudio: /* @__PURE__ */ __name((pcm) => {
              if (ws.readyState !== ws.OPEN || pcm.length === 0) return;
              if ((ws.bufferedAmount ?? 0) > MAX_BUFFERED_AUDIO_BYTES2) {
                if (!backpressureWarned) {
                  backpressureWarned = true;
                  debugLogger2.warn(
                    "[voice] dropping Qwen ASR realtime audio due to socket backpressure."
                  );
                }
                return;
              }
              backpressureWarned = false;
              sendJson({
                type: "input_audio_buffer.append",
                audio: Buffer.from(pcm).toString("base64")
              });
            }, "pushAudio"),
            finish: /* @__PURE__ */ __name(() => {
              if (finishPromise) return finishPromise;
              finishPromise = new Promise((res, rej) => {
                if (finishedTranscript !== null) {
                  res(finishedTranscript);
                  return;
                }
                if (terminalError) {
                  rej(terminalError);
                  return;
                }
                finishResolve = res;
                finishReject = rej;
                finishTimer = setTimeout(() => {
                  fail(new Error("Qwen ASR realtime finish timed out."));
                }, FINISH_TIMEOUT_MS2);
                try {
                  sendJson({ type: "input_audio_buffer.commit" });
                  sendJson({ type: "session.finish" });
                } catch (error) {
                  fail(error);
                }
              });
              return finishPromise;
            }, "finish"),
            abort: close
          });
          break;
        case "conversation.item.input_audio_transcription.text": {
          const text = typeof msg.text === "string" ? msg.text : "";
          const stash = typeof msg.stash === "string" ? msg.stash : "";
          const preview = `${text}${stash}`.trim();
          callbacks.onInterim?.([committed, preview].filter(Boolean).join(" "));
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          if (typeof msg.transcript === "string") {
            committed = appendTranscript(committed, msg.transcript);
            callbacks.onInterim?.(committed);
          }
          break;
        case "conversation.item.input_audio_transcription.failed":
          fail(
            new Error(
              formatServerErrorMessage2(
                msg.error?.message ?? msg.error?.code ?? "Qwen ASR realtime transcription failed."
              )
            )
          );
          break;
        case "session.finished":
          if (!openSettled) {
            fail(
              new Error(
                "Qwen ASR realtime session finished before it was ready."
              )
            );
            break;
          }
          failed = true;
          removeAbortListener();
          clearFinishTimer();
          finishedTranscript = committed.trim();
          finishResolve?.(finishedTranscript);
          finishResolve = null;
          finishReject = null;
          close();
          break;
        case "error":
          fail(
            new Error(
              formatServerErrorMessage2(
                msg.error?.message ?? msg.error?.code ?? "Qwen ASR realtime request failed."
              )
            )
          );
          break;
        default:
          break;
      }
    });
    ws.on("error", fail);
    ws.on("close", () => {
      removeAbortListener();
      clearConnectTimer();
      clearFinishTimer();
      if (failed) return;
      if (!openSettled) {
        openSettled = true;
        reject(new Error("Qwen ASR realtime connection closed."));
        return;
      }
      if (finishReject) {
        finishReject(
          new Error(
            "Qwen ASR realtime connection closed unexpectedly. Transcript may be incomplete."
          )
        );
        finishResolve = null;
        finishReject = null;
      } else {
        const error = new Error(
          "Qwen ASR realtime connection closed unexpectedly. Transcript may be incomplete."
        );
        terminalError ??= error;
        callbacks.onError?.(terminalError);
      }
    });
  });
}
__name(openQwenAsrRealtimeStream, "openQwenAsrRealtimeStream");

// packages/cli/src/ui/voice/voice-stream-retry.ts
init_esbuild_shims();
var RETRY_DELAY_MS = 200;
var debugLogger3 = createDebugLogger("VOICE_STREAM");
function delay(ms, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("Voice stream opening was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = /* @__PURE__ */ __name(() => {
      clearTimeout(timer);
      reject(new Error("Voice stream opening was aborted."));
    }, "onAbort");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
__name(delay, "delay");
function isRetryable(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(400|401|403|404|410|422|429)\b|unauthori[sz]ed|forbidden|model_not_supported|rate.?limit/i.test(
    message
  )) {
    return false;
  }
  return true;
}
__name(isRetryable, "isRetryable");
async function openVoiceStreamWithRetry(open, opts = {}) {
  if (opts.abortSignal?.aborted) {
    throw new Error("Voice stream opening was aborted.");
  }
  try {
    return await open();
  } catch (error) {
    if (!isRetryable(error)) {
      throw error;
    }
    debugLogger3.debug("[voice] stream open failed, retrying:", error);
    await delay(RETRY_DELAY_MS, opts.abortSignal);
    if (opts.abortSignal?.aborted) {
      throw new Error("Voice stream opening was aborted.");
    }
    return open();
  }
}
__name(openVoiceStreamWithRetry, "openVoiceStreamWithRetry");

export {
  deriveWebSocketBase,
  openVoiceStream,
  openQwenAsrRealtimeStream,
  openVoiceStreamWithRetry
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
