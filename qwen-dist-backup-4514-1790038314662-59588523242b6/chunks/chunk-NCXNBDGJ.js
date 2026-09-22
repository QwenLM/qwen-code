// Force strict mode and setup for ESM
"use strict";
import {
  DashScopeUploader
} from "./chunk-V2XJJTAB.js";
import {
  OmniDegradationCache,
  OmniTransportGuardError,
  assertWithinByteLimit,
  assertWithinDurationLimit,
  assertWithinTokenLimit,
  effectiveMaxUploadFileBytes,
  effectiveOmniStorageMaxTotalBytes,
  estimateRawResourceTokens,
  runFixedPolicies,
  runOmniGcOnce
} from "./chunk-DB5RX7EU.js";
import {
  MEDIA_DETECTOR_VERSION,
  MediaMemoryService
} from "./chunk-SLHYLVRW.js";
import {
  runStartupRecoveryOnce
} from "./chunk-RSFNJ6UU.js";
import {
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
  OmniUploadCache
} from "./chunk-JYGESWZM.js";
import {
  OmniObjectStore,
  prepareOmniDownloadsDir
} from "./chunk-FTKXJMQV.js";
import {
  extensionForMime,
  hashFileSha256,
  recognizeMediaFile,
  sniffMediaType
} from "./chunk-S5BHLTHK.js";
import {
  isFfmpegAvailable,
  isFfprobeAvailable
} from "./chunk-KSEKRQJO.js";
import {
  resolveNetworkTarget
} from "./chunk-6C3D7BKK.js";
import {
  isOmniDeliveryActive
} from "./chunk-ZAQM5T2X.js";
import {
  requireEffectiveOmniUploadConfig
} from "./chunk-SATGWSS6.js";
import {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  OMNI_RESOURCE_HANDLE_TEXT_PREFIX,
  OMNI_RESOURCE_PATH_TEXT_PREFIX,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
  formatDisclosureText,
  formatOmissionText,
  formatResourceHandleText,
  formatTranscriptText,
  harnessPathAnnotationPart,
  isHarnessAnnotationPart,
  parseResourceHandleText,
  parseResourcePathText,
  splitAnnotationBody,
  unescapeAnnotationName
} from "./chunk-BKVPLSEI.js";
import {
  isPermittedRedirect,
  isPrivateHost
} from "./chunk-KKPIFWTZ.js";
import {
  detectRuntime,
  loadUndici
} from "./chunk-SBP43AO6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  isAbortError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/index.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import path4 from "node:path";
import fs4 from "node:fs/promises";

// packages/core/src/omni/policy/session-context.ts
init_esbuild_shims();
function buildSessionConditionNamespace(config, reservedOutputTokens) {
  const session = {
    reservedOutputTokens
  };
  const windowSize = config.getContentGeneratorConfig?.()?.contextWindowSize;
  const contextWindowTokens = typeof windowSize === "number" && Number.isFinite(windowSize) && windowSize > 0 ? windowSize : void 0;
  if (contextWindowTokens !== void 0) {
    session.contextWindowTokens = contextWindowTokens;
  }
  let promptTokenCount;
  try {
    const count = config.getGeminiClient?.()?.getChat?.()?.getLastPromptTokenCount();
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      promptTokenCount = count;
    }
  } catch {
  }
  if (promptTokenCount !== void 0) {
    session.promptTokenCount = promptTokenCount;
  }
  if (contextWindowTokens !== void 0 && promptTokenCount !== void 0) {
    session.availableContextTokens = Math.max(
      0,
      contextWindowTokens - promptTokenCount - reservedOutputTokens
    );
  }
  return session;
}
__name(buildSessionConditionNamespace, "buildSessionConditionNamespace");

// packages/core/src/omni/download.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
var debugLogger = createDebugLogger("omni:download");
var OmniDownloadError = class extends Error {
  static {
    __name(this, "OmniDownloadError");
  }
  constructor(message, options) {
    super(message, options);
    this.name = "OmniDownloadError";
  }
};
var RESOLVE_TIMEOUT_MS = 3e4;
var HEADER_TIMEOUT_MS = 3e4;
var IDLE_TIMEOUT_MS = 6e4;
var MAX_REDIRECTS = 5;
function parseHttpUrlRef(pathName) {
  if (!/^https?:\/\//i.test(pathName)) return null;
  try {
    return new URL(pathName);
  } catch {
    return null;
  }
}
__name(parseHttpUrlRef, "parseHttpUrlRef");
function scrubPathsFromMessage(message) {
  return message.replace(
    /(?:[A-Za-z]:)?(?:[\\/][^\s'"`\\/]+){2,}[\\/]?/g,
    (match) => path.basename(match)
  );
}
__name(scrubPathsFromMessage, "scrubPathsFromMessage");
function formatCauseChain(err) {
  const parts = [];
  let cause = err instanceof Error ? err.cause : void 0;
  for (let depth = 0; cause != null && depth < 4; depth++) {
    const code = cause.code;
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : void 0;
    if (typeof code === "string" && message && !message.includes(code)) {
      parts.push(`${code}: ${message}`);
    } else if (message) {
      parts.push(message);
    } else if (typeof code === "string") {
      parts.push(code);
    }
    cause = cause instanceof Error ? cause.cause : void 0;
  }
  return parts.length > 0 ? scrubPathsFromMessage(parts.join("; ")) : void 0;
}
__name(formatCauseChain, "formatCauseChain");
function detectConfiguredProxy(undici) {
  for (const key of [
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY"
  ]) {
    if (process.env[key]) return true;
  }
  try {
    return undici.getGlobalDispatcher() instanceof undici.EnvHttpProxyAgent;
  } catch {
    return false;
  }
}
__name(detectConfiguredProxy, "detectConfiguredProxy");
async function downloadMediaUrl(params) {
  const {
    url,
    downloadsDir,
    maxBytes,
    signal,
    resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
    headerTimeoutMs = HEADER_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS
  } = params;
  const resolveTarget = params.resolveTarget ?? ((target) => resolveNetworkTarget(target, "public", signal));
  if (isPrivateHost(url)) {
    throw new OmniDownloadError(
      `URL host is not publicly routable (refused for safety): ${new URL(url).hostname}`
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new OmniDownloadError("URL media ref is not a valid URL (refused).");
  }
  if (parsed.protocol !== "https:") {
    throw new OmniDownloadError(
      `URL media must be https (refused for safety): ${parsed.protocol}//${parsed.hostname}`
    );
  }
  if (parsed.username || parsed.password) {
    throw new OmniDownloadError(
      `URL media must not embed credentials (refused for safety): ${parsed.hostname}`
    );
  }
  const runtime = detectRuntime();
  if (runtime !== "node") {
    throw new OmniDownloadError(
      `URL media requires the Node runtime to verify the connection target (refused for safety on ${runtime}): use a local file path instead of a URL, or run under Node.`
    );
  }
  const undici = await loadUndici();
  const proxied = params.detectProxy ? params.detectProxy() : detectConfiguredProxy(undici);
  if (proxied) {
    throw new OmniDownloadError(
      `URL media fetching is not supported behind a proxy yet (refused): the connection pinning that enforces SSRF protection cannot be applied through a proxy. Download the file manually and use a local path instead.`
    );
  }
  try {
    await prepareOmniDownloadsDir(downloadsDir);
  } catch (err) {
    throw new OmniDownloadError(
      `Could not prepare the downloads directory for URL media: ${err instanceof Error ? scrubPathsFromMessage(err.message) : String(err)}`,
      { cause: err }
    );
  }
  const partPath = path.join(
    downloadsDir,
    `${randomBytes(8).toString("hex")}.part`
  );
  let currentUrl = url;
  let dispatcher;
  try {
    for (let redirects = 0; ; redirects++) {
      let target;
      const resolveAbort = new AbortController();
      const resolveTimer = setTimeout(
        () => resolveAbort.abort(new Error("resolve timeout")),
        resolveTimeoutMs
      );
      try {
        const pending = resolveTarget(currentUrl);
        pending.catch(() => {
        });
        target = await Promise.race([
          pending,
          new Promise((_, reject) => {
            resolveAbort.signal.addEventListener(
              "abort",
              () => reject(resolveAbort.signal.reason),
              { once: true }
            );
          })
        ]);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (resolveAbort.signal.aborted) {
          throw new OmniDownloadError(
            `Download timed out resolving ${new URL(currentUrl).hostname} (${resolveTimeoutMs / 1e3}s)`
          );
        }
        const text = err instanceof Error ? err.message : String(err);
        const reason = /blocked address/i.test(text) ? "resolved to a non-public address" : /did not resolve/i.test(text) ? "did not resolve" : "could not be verified";
        throw new OmniDownloadError(
          `URL host ${reason} (refused for safety): ${new URL(currentUrl).hostname}`,
          { cause: err }
        );
      } finally {
        clearTimeout(resolveTimer);
      }
      if (!target.lookup) {
        throw new OmniDownloadError(
          `URL host cannot be safely bound to a verified address (refused for safety): ${new URL(currentUrl).hostname}`
        );
      }
      const fetchFn = params.fetchFn ?? undici.fetch;
      const previousDispatcher = dispatcher;
      dispatcher = new undici.Agent({ connect: { lookup: target.lookup } });
      await previousDispatcher?.close().catch(() => {
      });
      const headerAbort = new AbortController();
      const headerTimer = setTimeout(
        () => headerAbort.abort(new Error("header timeout")),
        headerTimeoutMs
      );
      const combined = AbortSignal.any(
        signal ? [signal, headerAbort.signal] : [headerAbort.signal]
      );
      let res;
      try {
        res = await fetchFn(currentUrl, {
          redirect: "manual",
          signal: combined,
          // Not in the DOM RequestInit type; undici reads it (same cast as
          // services/image-generation-service.ts).
          dispatcher
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (headerAbort.signal.aborted) {
          throw new OmniDownloadError(
            `Download timed out waiting for response headers from ${new URL(currentUrl).hostname} (${headerTimeoutMs / 1e3}s)`
          );
        }
        const detail = err instanceof Error ? scrubPathsFromMessage(err.message) : String(err);
        const causeDetail = formatCauseChain(err);
        throw new OmniDownloadError(
          `Download request failed for ${new URL(currentUrl).hostname}: ${detail}${causeDetail ? ` (${causeDetail})` : ""}`,
          { cause: err }
        );
      } finally {
        clearTimeout(headerTimer);
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {
        });
        const location = res.headers.get("location");
        if (!location || redirects >= MAX_REDIRECTS) {
          throw new OmniDownloadError(
            `Too many or invalid redirects downloading from ${new URL(currentUrl).hostname}`
          );
        }
        let redirectUrl;
        try {
          redirectUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new OmniDownloadError(
            `Redirect with a malformed Location header from ${new URL(currentUrl).hostname}`
          );
        }
        if (!isPermittedRedirect(currentUrl, redirectUrl)) {
          throw new OmniDownloadError(
            `Cross-origin redirect refused: ${new URL(currentUrl).hostname} \u2192 ${new URL(redirectUrl).hostname}`
          );
        }
        currentUrl = redirectUrl;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {
        });
        throw new OmniDownloadError(
          `Download failed: HTTP ${res.status} from ${new URL(currentUrl).hostname}`
        );
      }
      const contentLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await res.body?.cancel().catch(() => {
        });
        throw new OmniDownloadError(
          `Download exceeds the omni media limit: Content-Length ${contentLength} > ${maxBytes} bytes.`
        );
      }
      if (!res.body) {
        throw new OmniDownloadError("Download response had no body.");
      }
      let written = 0;
      const idleAbort = new AbortController();
      let idleTimer = setTimeout(
        () => idleAbort.abort(new Error("idle timeout")),
        idleTimeoutMs
      );
      const streamSignal = AbortSignal.any(
        signal ? [signal, idleAbort.signal] : [idleAbort.signal]
      );
      try {
        const source = Readable.fromWeb(
          res.body,
          { signal: streamSignal }
        );
        const counter = /* @__PURE__ */ __name(async function* (src) {
          for await (const chunk of src) {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => idleAbort.abort(new Error("idle timeout")),
              idleTimeoutMs
            );
            written += chunk.length;
            if (written > maxBytes) {
              throw new OmniDownloadError(
                `Download exceeds the omni media limit: >${maxBytes} bytes received.`
              );
            }
            yield chunk;
          }
        }, "counter");
        const destination = createWriteStream(partPath, { mode: 384 });
        await once(destination, "open");
        await pipeline(source, counter, destination);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof OmniDownloadError) throw err;
        if (idleAbort.signal.aborted) {
          throw new OmniDownloadError(
            `Download stalled from ${new URL(currentUrl).hostname}: no data for ${idleTimeoutMs / 1e3}s`
          );
        }
        throw new OmniDownloadError(
          `Download interrupted from ${new URL(currentUrl).hostname}: ${err instanceof Error ? scrubPathsFromMessage(err.message) : String(err)}`,
          { cause: err }
        );
      } finally {
        clearTimeout(idleTimer);
      }
      debugLogger.debug(
        `downloaded ${written} bytes from ${new URL(currentUrl).hostname}`
      );
      return { partPath };
    }
  } catch (err) {
    await fs.rm(partPath, { force: true });
    throw err;
  } finally {
    await dispatcher?.close().catch(() => {
    });
  }
}
__name(downloadMediaUrl, "downloadMediaUrl");

// packages/core/src/omni/tool-result-media.ts
init_esbuild_shims();
import { randomBytes as randomBytes2 } from "node:crypto";
import fs2 from "node:fs/promises";
import path2 from "node:path";
var debugLogger2 = createDebugLogger("omni:tool-result");
var MAX_UPLOADS_PER_TOOL_RESULT = 8;
var MAX_UPLOAD_BYTES_PER_TOOL_RESULT = 128 * 1024 * 1024;
async function processToolResultOmniMedia(responseParts, config, signal) {
  if (!isOmniDeliveryActive(config)) return responseParts;
  const modalities = config.getContentGeneratorConfig?.()?.modalities ?? {};
  let changed = false;
  let uploadsRemaining = MAX_UPLOADS_PER_TOOL_RESULT;
  let uploadBytesRemaining = MAX_UPLOAD_BYTES_PER_TOOL_RESULT;
  const convertPart = /* @__PURE__ */ __name(async (part) => {
    const inline = part.inlineData;
    if (!inline?.data || !inline.mimeType) return [part];
    const top = inline.mimeType.split("/")[0];
    if (top !== "image" && top !== "audio" && top !== "video") return [part];
    const bytes = Buffer.from(inline.data, "base64");
    const sniffed = sniffMediaType(bytes.subarray(0, 4096));
    if (!sniffed) return [part];
    if (!modalities[sniffed.modality]) return [part];
    if (uploadsRemaining <= 0 || bytes.length > uploadBytesRemaining) {
      debugLogger2.debug(
        `tool-result media budget exhausted; keeping part inline (${bytes.length} bytes)`
      );
      return [part];
    }
    const store = new OmniObjectStore(config.storage.getQwenDir());
    let tempPath;
    const displayName = inline.displayName ?? `tool-media.${top}`;
    try {
      const stagingDir = await prepareOmniDownloadsDir(
        path2.join(store.getOmniRootDir(), "downloads")
      );
      tempPath = path2.join(
        stagingDir,
        `${randomBytes2(8).toString("hex")}.part`
      );
      await fs2.writeFile(tempPath, bytes, { mode: 384 });
      const delivery = await processMediaForOmniDelivery(tempPath, config, {
        expectedModality: sniffed.modality,
        signal,
        displayName,
        origin: "tool"
      });
      const transcriptParts = buildTranscriptParts(
        displayName,
        delivery.transcripts
      );
      const additionalParts = buildAdditionalMediaParts(
        displayName,
        delivery.additionalMedia
      );
      uploadsRemaining -= delivery.additionalMedia?.filter((e) => !e.omission).length ?? 0;
      const handleParts = delivery.resourceId ? [
        {
          text: formatResourceHandleText(displayName, delivery.resourceId)
        }
      ] : [];
      if (delivery.omission) {
        changed = true;
        return [
          ...handleParts,
          { text: formatOmissionText(displayName, delivery.omission.reason) },
          ...additionalParts,
          ...transcriptParts
        ];
      }
      if (!delivery.fileUri && transcriptParts.length > 0) {
        changed = true;
        return delivery.disclosure ? [
          ...handleParts,
          { text: formatDisclosureText(displayName, delivery.disclosure) },
          ...additionalParts,
          ...transcriptParts
        ] : [...handleParts, ...additionalParts, ...transcriptParts];
      }
      changed = true;
      uploadsRemaining--;
      uploadBytesRemaining -= bytes.length;
      const fileDataPart = {
        fileData: {
          fileUri: delivery.fileUri,
          mimeType: delivery.mimeType,
          displayName
        }
      };
      return delivery.disclosure ? [
        ...handleParts,
        { text: formatDisclosureText(displayName, delivery.disclosure) },
        fileDataPart,
        ...additionalParts,
        ...transcriptParts
      ] : [
        ...handleParts,
        fileDataPart,
        ...additionalParts,
        ...transcriptParts
      ];
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof OmniTransportGuardError) {
        changed = true;
        return [
          ...err.sessionResourceId ? [
            {
              text: formatResourceHandleText(
                displayName,
                err.sessionResourceId
              )
            }
          ] : [],
          {
            text: `[Tool media part withheld by the omni transport guard: ${err.message}]`
          }
        ];
      }
      debugLogger2.debug(
        `tool-result media upload failed, keeping inline: ${err instanceof Error ? err.message : String(err)}`
      );
      return [part];
    } finally {
      if (tempPath !== void 0) {
        await fs2.rm(tempPath, { force: true }).catch(() => {
        });
      }
    }
  }, "convertPart");
  const result = [];
  for (const part of responseParts) {
    const nested = part.functionResponse?.parts;
    if (Array.isArray(nested) && nested.length > 0) {
      const convertedNested = [];
      let nestedChanged = false;
      for (const nestedPart of nested) {
        const converted = await convertPart(nestedPart);
        if (converted.length !== 1 || converted[0] !== nestedPart) {
          nestedChanged = true;
        }
        convertedNested.push(...converted);
      }
      if (nestedChanged) {
        result.push({
          ...part,
          functionResponse: {
            ...part.functionResponse,
            parts: convertedNested
          }
        });
        changed = true;
      } else {
        result.push(part);
      }
      continue;
    }
    result.push(...await convertPart(part));
  }
  return changed ? result : responseParts;
}
__name(processToolResultOmniMedia, "processToolResultOmniMedia");

// packages/core/src/omni/export.ts
init_esbuild_shims();
import fs3 from "node:fs/promises";
import path3 from "node:path";
var debugLogger3 = createDebugLogger("omni:export");
function textOfPart(part) {
  if (typeof part === "string") return part;
  if (typeof part === "object" && part !== null && "text" in part) {
    const text = part.text;
    return typeof text === "string" ? text : void 0;
  }
  return void 0;
}
__name(textOfPart, "textOfPart");
function functionResponseOfPart(part) {
  if (typeof part !== "object" || part === null) return void 0;
  const response = part.functionResponse;
  if (typeof response !== "object" || response === null) return void 0;
  const { id, parts } = response;
  return { id, ...Array.isArray(parts) ? { parts } : {} };
}
__name(functionResponseOfPart, "functionResponseOfPart");
function isThoughtPart(part) {
  return typeof part === "object" && part !== null && part.thought === true;
}
__name(isThoughtPart, "isThoughtPart");
function functionCallOfPart(part) {
  if (typeof part !== "object" || part === null) return void 0;
  const fc = part.functionCall;
  if (typeof fc !== "object" || fc === null) return void 0;
  const { id, name, args } = fc;
  if (typeof name !== "string") return void 0;
  const cleanArgs = typeof args === "object" && args !== null ? { ...args } : void 0;
  return {
    ...typeof id === "string" ? { callId: id } : {},
    name,
    ...cleanArgs ? { args: cleanArgs } : {}
  };
}
__name(functionCallOfPart, "functionCallOfPart");
function stripSystemReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}
__name(stripSystemReminders, "stripSystemReminders");
function mediaFor(turn, name) {
  let media = turn.media.get(name);
  if (!media) {
    media = { name, disclosures: [], transcripts: [] };
    turn.media.set(name, media);
  }
  return media;
}
__name(mediaFor, "mediaFor");
function consumeAnnotationPart(turn, text, isHarnessAnnotation) {
  if (text.startsWith(OMNI_RESOURCE_HANDLE_TEXT_PREFIX)) {
    const resourceId = parseResourceHandleText(text);
    if (resourceId) {
      const body = text.slice(OMNI_RESOURCE_HANDLE_TEXT_PREFIX.length);
      const name = unescapeAnnotationName(
        body.slice(0, body.length - resourceId.length - 1)
      );
      mediaFor(turn, name).resourceId = resourceId;
      return true;
    }
    return false;
  }
  if (text.startsWith(OMNI_RESOURCE_PATH_TEXT_PREFIX)) {
    if (!isHarnessAnnotation) return false;
    const filePath = parseResourcePathText(text);
    if (filePath) {
      mediaFor(turn, filePath.split(/[\\/]/).pop() ?? filePath);
      return true;
    }
    return false;
  }
  for (const [prefix, apply] of [
    [
      OMNI_DISCLOSURE_TEXT_PREFIX,
      (m, payload) => {
        m.disclosures.push(payload);
      }
    ],
    [
      OMNI_OMISSION_TEXT_PREFIX,
      (m, payload) => {
        m.omitted = payload;
      }
    ],
    [
      OMNI_TRANSCRIPT_TEXT_PREFIX,
      (m, payload) => {
        m.transcripts.push(payload);
      }
    ]
  ]) {
    if (!text.startsWith(prefix)) continue;
    const split = splitAnnotationBody(text.slice(prefix.length));
    if (!split) return false;
    apply(mediaFor(turn, split.name), split.payload);
    return true;
  }
  return false;
}
__name(consumeAnnotationPart, "consumeAnnotationPart");
function consumeRecordParts(turn, record, collectProse) {
  const parts = (record.message?.parts ?? []).flatMap((part) => [
    part,
    ...functionResponseOfPart(part)?.parts ?? []
  ]);
  for (const part of parts) {
    const raw = textOfPart(part);
    if (raw === void 0) continue;
    const withoutReminders = stripSystemReminders(raw);
    const forAnnotation = withoutReminders.replace(/^\s+/, "");
    if (consumeAnnotationPart(turn, forAnnotation, isHarnessAnnotationPart(part)))
      continue;
    const prose = withoutReminders.trim();
    if (!prose) continue;
    if (collectProse) turn.requestTexts.push(prose);
  }
}
__name(consumeRecordParts, "consumeRecordParts");
function finishTurn(turn, sessionId) {
  return {
    kind: "turn",
    sessionId,
    turnIndex: turn.turnIndex,
    ...turn.timestamp !== void 0 ? { timestamp: turn.timestamp } : {},
    request: {
      text: turn.requestTexts.join("\n"),
      media: [...turn.media.values()],
      ...turn.recall !== void 0 ? { recall: turn.recall } : {}
    },
    response: {
      text: turn.responseTexts.join("\n"),
      toolCalls: turn.toolCalls
    }
  };
}
__name(finishTurn, "finishTurn");
function activeChainRecords(records) {
  const byUuid = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (typeof record.uuid === "string") byUuid.set(record.uuid, record);
  }
  if (byUuid.size === 0) return records;
  let leaf;
  for (let i = records.length - 1; i >= 0; i--) {
    if (typeof records[i].uuid === "string") {
      leaf = records[i];
      break;
    }
  }
  if (!leaf) return records;
  const active = /* @__PURE__ */ new Set();
  let current = leaf;
  while (current?.uuid && !active.has(current.uuid)) {
    active.add(current.uuid);
    current = typeof current.parentUuid === "string" ? byUuid.get(current.parentUuid) : void 0;
  }
  return records.filter(
    (r) => typeof r.uuid !== "string" || active.has(r.uuid)
  );
}
__name(activeChainRecords, "activeChainRecords");
function buildTurnRecords(transcriptLines) {
  const turns = [];
  let sessionId = "";
  let current;
  for (const record of activeChainRecords(transcriptLines)) {
    if (typeof record.sessionId === "string" && sessionId === "") {
      sessionId = record.sessionId;
    }
    if (record.type === "user" && record.subtype === void 0) {
      if (current) turns.push(finishTurn(current, sessionId));
      current = {
        turnIndex: turns.length,
        ...record.timestamp !== void 0 ? { timestamp: record.timestamp } : {},
        requestTexts: [],
        media: /* @__PURE__ */ new Map(),
        responseTexts: [],
        toolCalls: []
      };
      consumeRecordParts(current, record, true);
      continue;
    }
    if (!current) continue;
    if (record.type === "system" && record.subtype === "omni_recall") {
      current.recall = record.systemPayload;
      continue;
    }
    if (record.type === "tool_result") {
      consumeRecordParts(current, record, false);
      continue;
    }
    if (record.type === "assistant") {
      for (const part of record.message?.parts ?? []) {
        if (isThoughtPart(part)) continue;
        const text = textOfPart(part);
        if (text !== void 0 && text.trim()) {
          current.responseTexts.push(text);
          continue;
        }
        const call = functionCallOfPart(part);
        if (call) current.toolCalls.push(call);
      }
    }
  }
  if (current) turns.push(finishTurn(current, sessionId));
  return turns;
}
__name(buildTurnRecords, "buildTurnRecords");
async function readSnapshotRaw(omniRootDir) {
  const filePath = path3.join(omniRootDir, "memory.json");
  let raw;
  try {
    raw = await fs3.readFile(filePath, "utf8");
  } catch {
    return void 0;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || [parsed.files, parsed.versions, parsed.executions, parsed.entries].some(
      (c) => typeof c !== "object" || c === null || Array.isArray(c)
    )) {
      throw new Error("unexpected snapshot shape");
    }
    return parsed;
  } catch (err) {
    debugLogger3.debug(
      `trajectory export: memory unreadable, exporting transcript only: ${err instanceof Error ? err.message : err}`
    );
    return void 0;
  }
}
__name(readSnapshotRaw, "readSnapshotRaw");
function buildMemoryRecords(snapshot) {
  const files = [];
  const executions = [];
  for (const version of Object.values(snapshot.versions)) {
    try {
      const file = snapshot.files[version.fileId];
      if (!file) continue;
      files.push({
        kind: "file",
        fileId: version.fileId,
        fileVersionId: version.fileVersionId,
        rootFileId: file.rootFileId,
        sha256: version.sha256,
        mediaType: version.mediaType,
        origin: file.origin,
        sizeBytes: version.sizeBytes,
        mimeType: version.mimeType,
        source: version.source,
        ...version.producedByExecutionId !== void 0 ? { producedByExecutionId: version.producedByExecutionId } : {},
        ...version.parentVersionId !== void 0 ? { parentVersionId: version.parentVersionId } : {},
        createdAt: version.createdAt
      });
    } catch {
    }
  }
  for (const execution of Object.values(snapshot.executions)) {
    try {
      const outputs = execution.outputRefs.flatMap((entryId) => {
        const entry = snapshot.entries[entryId];
        if (!entry) return [];
        return [
          {
            kind: entry.kind,
            ...entry.role !== void 0 ? { role: entry.role } : {},
            ...entry.artifactRef?.managedId?.startsWith("sha256/") ? { sha256: entry.artifactRef.managedId.slice("sha256/".length) } : {},
            ...entry.artifactRef?.mimeType !== void 0 ? { mimeType: entry.artifactRef.mimeType } : {},
            ...entry.artifactRef?.sizeBytes !== void 0 ? { sizeBytes: entry.artifactRef.sizeBytes } : {},
            ...entry.disclosure !== void 0 ? { disclosure: entry.disclosure } : {}
          }
        ];
      });
      executions.push({
        kind: "execution",
        executionId: execution.executionId,
        invocationId: execution.invocationId,
        executionOrigin: execution.executionOrigin,
        toolName: execution.toolName,
        ...execution.toolVersion !== void 0 ? { toolVersion: execution.toolVersion } : {},
        finalArguments: execution.finalArguments,
        omniConfigHash: execution.omniConfigHash,
        sourceVersionId: execution.sourceVersionId,
        rootFileId: execution.rootFileId,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        ...execution.reusedExecutionId !== void 0 ? { reusedExecutionId: execution.reusedExecutionId } : {},
        outputs
      });
    } catch {
    }
  }
  return { files, executions };
}
__name(buildMemoryRecords, "buildMemoryRecords");
function filterToSession(memory, turns, transcriptLines) {
  const callIds = /* @__PURE__ */ new Set();
  for (const record of activeChainRecords(transcriptLines)) {
    if (record.type !== "tool_result") continue;
    for (const part of record.message?.parts ?? []) {
      const id = functionResponseOfPart(part)?.id;
      if (typeof id === "string") callIds.add(id);
    }
  }
  const mediaNames = /* @__PURE__ */ new Set();
  for (const turn of turns) {
    for (const call of turn.response.toolCalls) {
      if (call.callId) callIds.add(call.callId);
    }
    for (const media of turn.request.media) mediaNames.add(media.name);
  }
  const filesByVersion = new Map(memory.files.map((f) => [f.fileVersionId, f]));
  const versionsByFile = /* @__PURE__ */ new Map();
  for (const f of memory.files) {
    const list = versionsByFile.get(f.fileId) ?? [];
    list.push(f);
    versionsByFile.set(f.fileId, list);
  }
  const includedFiles = /* @__PURE__ */ new Set();
  const includedExecutions = /* @__PURE__ */ new Set();
  const includeFile = /* @__PURE__ */ __name((fileId) => {
    if (!fileId || includedFiles.has(fileId)) return false;
    if (!versionsByFile.has(fileId)) return false;
    includedFiles.add(fileId);
    return true;
  }, "includeFile");
  for (const f of memory.files) {
    if (mediaNames.has(f.source.locator)) includeFile(f.fileId);
  }
  for (const e of memory.executions) {
    if (callIds.has(e.invocationId)) includedExecutions.add(e.executionId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of memory.executions) {
      const sourceFile = filesByVersion.get(e.sourceVersionId)?.fileId;
      if (!includedExecutions.has(e.executionId)) {
        if (sourceFile && includedFiles.has(sourceFile)) {
          includedExecutions.add(e.executionId);
          changed = true;
        } else {
          continue;
        }
      }
      if (includeFile(sourceFile)) changed = true;
    }
    for (const f of memory.files) {
      if (includedFiles.has(f.fileId)) continue;
      if (f.producedByExecutionId !== void 0 && includedExecutions.has(f.producedByExecutionId)) {
        includeFile(f.fileId);
        changed = true;
      }
    }
  }
  return {
    files: memory.files.filter((f) => includedFiles.has(f.fileId)),
    executions: memory.executions.filter(
      (e) => includedExecutions.has(e.executionId)
    )
  };
}
__name(filterToSession, "filterToSession");
async function exportOmniTrajectory(options) {
  const raw = await fs3.readFile(options.transcriptPath, "utf8");
  const transcriptLines = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      transcriptLines.push(JSON.parse(line));
    } catch {
    }
  }
  const turns = buildTurnRecords(transcriptLines);
  const records = [...turns];
  const snapshot = await readSnapshotRaw(options.omniRootDir);
  const memoryRecords = snapshot ? filterToSession(buildMemoryRecords(snapshot), turns, transcriptLines) : { files: [], executions: [] };
  records.push(
    ...memoryRecords.files.sort(
      (a, b) => a.fileVersionId.localeCompare(b.fileVersionId)
    ),
    ...memoryRecords.executions.sort(
      (a, b) => a.executionId.localeCompare(b.executionId)
    )
  );
  return records;
}
__name(exportOmniTrajectory, "exportOmniTrajectory");
function serializeOmniTrajectory(records) {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
__name(serializeOmniTrajectory, "serializeOmniTrajectory");
async function writeOmniTrajectoryJsonl(options) {
  const outPath = path3.resolve(options.outPath);
  if (outPath === path3.resolve(options.transcriptPath)) {
    throw new Error("trajectory outPath must differ from the transcript path");
  }
  const records = await exportOmniTrajectory(options);
  await fs3.mkdir(path3.dirname(outPath), { recursive: true });
  await fs3.writeFile(outPath, serializeOmniTrajectory(records), "utf8");
  return { records: records.length };
}
__name(writeOmniTrajectoryJsonl, "writeOmniTrajectoryJsonl");

// packages/core/src/omni/index.ts
var debugLogger4 = createDebugLogger("omni");
function sanitizeErrorMessage(err, knownPaths = []) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const known of knownPaths) {
    if (!known) continue;
    msg = msg.split(known).join(path4.basename(known));
    const segments = known.split(/[\\/]+/).filter(Boolean);
    if (/^[A-Za-z]:$/.test(segments[0] ?? "")) segments.shift();
    if (segments.length >= 2) {
      const spelled = segments.map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]+");
      msg = msg.replace(
        new RegExp(`(?:[A-Za-z]:)?[\\\\/]*${spelled}`, "g"),
        () => path4.basename(known)
      );
    }
  }
  return msg.replace(/(?:\/[^/\s'"]+)+\/([^/\s'"]+)/g, "$1").replace(/(?:[A-Za-z]:)?(?:\\[^\\\s'"]+)+\\([^\\\s'"]+)/g, "$1");
}
__name(sanitizeErrorMessage, "sanitizeErrorMessage");
function buildAdditionalMediaParts(displayName, additionalMedia) {
  const parts = [];
  for (const extra of additionalMedia ?? []) {
    if (extra.disclosure) {
      parts.push({ text: formatDisclosureText(displayName, extra.disclosure) });
    }
    if (extra.omission) {
      parts.push({
        text: formatOmissionText(displayName, extra.omission.reason)
      });
    } else {
      parts.push({
        fileData: {
          fileUri: extra.fileUri,
          mimeType: extra.mimeType,
          displayName
        }
      });
    }
  }
  return parts;
}
__name(buildAdditionalMediaParts, "buildAdditionalMediaParts");
function buildTranscriptParts(displayName, transcripts) {
  const parts = [];
  for (const t of transcripts ?? []) {
    if (t.disclosure) {
      parts.push({ text: formatDisclosureText(displayName, t.disclosure) });
    }
    parts.push({ text: formatTranscriptText(displayName, t.text) });
  }
  return parts;
}
__name(buildTranscriptParts, "buildTranscriptParts");
var OmniDeliveryError = class extends Error {
  static {
    __name(this, "OmniDeliveryError");
  }
  constructor(message, options) {
    super(message, options);
    this.name = "OmniDeliveryError";
  }
};
function evaluateTransportLimits(config, recognized, displayName) {
  try {
    assertWithinByteLimit(config, recognized.sizeBytes, displayName);
    assertWithinDurationLimit(config, recognized, displayName);
    return {
      estimate: assertWithinTokenLimit(config, recognized, displayName)
    };
  } catch (err) {
    if (err instanceof OmniTransportGuardError) {
      return {
        estimate: estimateRawResourceTokens(recognized),
        violation: err.message
      };
    }
    throw err;
  }
}
__name(evaluateTransportLimits, "evaluateTransportLimits");
async function processMediaForOmniDelivery(filePath, config, options) {
  const { expectedModality, signal } = options ?? {};
  const displayName = options?.displayName ?? path4.basename(filePath);
  const [ffmpeg, ffprobe] = await Promise.all([
    isFfmpegAvailable(),
    isFfprobeAvailable()
  ]);
  if (!ffmpeg || !ffprobe) {
    throw new OmniDeliveryError(
      "ffmpeg/ffprobe not available; omni media delivery requires both on PATH."
    );
  }
  await fs4.stat(filePath).catch((err) => {
    throw new OmniDeliveryError(
      `Cannot stat media file ${displayName}: ${sanitizeErrorMessage(err, [filePath])}`,
      { cause: err }
    );
  });
  let recognized;
  try {
    recognized = await recognizeMediaFile(filePath, {
      expectedModality,
      signal
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OmniDeliveryError(
      `Media recognition failed for ${displayName}: ${sanitizeErrorMessage(err, [filePath])}`,
      { cause: err }
    );
  }
  const store = new OmniObjectStore(config.storage.getQwenDir());
  const uploadConfig = requireEffectiveOmniUploadConfig(config);
  const cacheScope = createHash("sha256").update(`${uploadConfig.baseUrl}|${uploadConfig.apiKey}`).digest("hex").slice(0, 16);
  const configuredTtl = config.getOmniUploadUrlTtlHours?.();
  const uploadCache = new OmniUploadCache(
    store.getOmniRootDir(),
    configuredTtl === void 0 ? DEFAULT_UPLOAD_CACHE_TTL_HOURS : configuredTtl,
    cacheScope
  );
  await runStartupRecoveryOnce(store, uploadCache, {
    quarantineRetentionDays: config.getOmniQuarantineRetentionDays?.(),
    quarantineMaxBytes: config.getOmniQuarantineMaxBytes?.(),
    // Corrupt-object deletion must also invalidate degradation-cache
    // entries (as source or derivative) — otherwise policy-cache.json
    // accumulates orphans that can never be served again.
    degradationCache: new OmniDegradationCache(store.getOmniRootDir())
  });
  const processingConfig = config.getOmniProcessingConfig?.();
  const conditionContext = processingConfig ? {
    session: buildSessionConditionNamespace(
      config,
      processingConfig.limits.reservedOutputTokens
    )
  } : void 0;
  const memoryConfig = config.getOmniMemoryConfig?.();
  const memoryService = memoryConfig ? new MediaMemoryService(store.getOmniRootDir(), {
    maxInlineTextBytes: memoryConfig.collection.maxInlineTextBytes
  }) : void 0;
  if (memoryService) {
    void runOmniGcOnce({
      store,
      memoryService,
      registry: config.getOmniMediaResourceRegistry?.(),
      uploadCache,
      degradationCache: new OmniDegradationCache(store.getOmniRootDir()),
      retentionDays: config.getOmniStorageRetentionDays?.() ?? 14,
      // Floor-clamped: a budget below 10× the single-media limit cannot
      // hold normal artifacts and would read as permanent suspension.
      maxTotalBytes: typeof config.getOmniStorageMaxTotalBytes === "function" ? effectiveOmniStorageMaxTotalBytes(config) : 20 * 1024 * 1024 * 1024
    });
  }
  const registry = memoryService ? config.getOmniMediaResourceRegistry?.() : void 0;
  const bindSessionResource = /* @__PURE__ */ __name((item, fileRefOverride) => registry && item.memoryBinding ? registry.bind({
    ...item.memoryBinding,
    fileRef: fileRefOverride ?? item.filePath,
    mediaType: item.recognized.modality
  }) : void 0, "bindSessionResource");
  let sourceSha256;
  let sourceBinding;
  let sourceFileRef = filePath;
  if (memoryService) {
    try {
      sourceSha256 = await hashFileSha256(filePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      debugLogger4.debug(
        `omni memory: hashing ${displayName} failed, skipping collection: ${sanitizeErrorMessage(err, [filePath])}`
      );
    }
    if (sourceSha256) {
      const origin = options?.origin ?? "user";
      const ephemeralSource = origin === "tool" || options?.sourceUrl !== void 0;
      sourceFileRef = ephemeralSource ? store.objectPathFor(
        sourceSha256,
        extensionForMime(recognized.detectedMimeType)
      ) : filePath;
      sourceBinding = await memoryService.recordFileRecognized({
        fileRef: sourceFileRef,
        sha256: sourceSha256,
        mediaType: recognized.modality,
        metadata: recognized.metadata,
        sizeBytes: recognized.sizeBytes,
        mimeType: recognized.detectedMimeType,
        origin,
        source: options?.sourceUrl !== void 0 ? { protocol: "url", locator: options.sourceUrl } : origin === "tool" ? { protocol: "managed", locator: `sha256/${sourceSha256}` } : { protocol: "local", locator: displayName },
        recognition: {
          ingestionConfigHash: "",
          detectorVersion: MEDIA_DETECTOR_VERSION,
          probeStatus: "complete"
        }
      });
    }
  }
  let final = {
    filePath,
    recognized,
    sha256: sourceSha256,
    memoryBinding: sourceBinding
  };
  const sessionResourceId = bindSessionResource(
    final,
    sourceFileRef
  )?.resourceId;
  const guardRejection = /* @__PURE__ */ __name((message, options2) => {
    const err = new OmniTransportGuardError(message, options2);
    if (sessionResourceId !== void 0) {
      err.sessionResourceId = sessionResourceId;
    }
    return err;
  }, "guardRejection");
  let extraDeliveries = [];
  const transcripts = [];
  const collectTranscripts = /* @__PURE__ */ __name((files) => {
    for (const file of files) {
      transcripts.push({ text: file.text, disclosure: file.disclosure });
    }
  }, "collectTranscripts");
  const textOnlyDelivery = /* @__PURE__ */ __name((recognizedFinal, tokenEstimate2, extras) => ({
    fileUri: "",
    mimeType: recognizedFinal.detectedMimeType,
    sha256: "",
    recognized: recognizedFinal,
    tokenEstimate: tokenEstimate2,
    deduped: false,
    uploadCacheHit: false,
    degraded: true,
    transcripts,
    resourceId: sessionResourceId,
    ...extras
  }), "textOnlyDelivery");
  const policies = processingConfig?.fixedPolicies ?? [];
  if (policies.length > 0) {
    let deliveries;
    let fileDeliveries;
    try {
      ({ deliveries, fileDeliveries } = await runFixedPolicies(
        config,
        {
          filePath,
          recognized,
          displayName,
          origin: options?.origin ?? "user",
          sha256: sourceSha256
        },
        {
          store,
          policies,
          signal,
          limits: processingConfig?.limits,
          conditionContext,
          memory: memoryService ? { service: memoryService, sourceBinding } : void 0
        }
      ));
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        `Fixed-policy processing failed for ${displayName}: ${sanitizeErrorMessage(err, [filePath, store.getOmniRootDir()])}`,
        { cause: err }
      );
    }
    collectTranscripts(fileDeliveries);
    if (deliveries.length === 0 && transcripts.length > 0) {
      return textOnlyDelivery(
        recognized,
        evaluateTransportLimits(config, recognized, displayName).estimate
      );
    }
    if (deliveries.length === 0) {
      throw new OmniDeliveryError(
        `Fixed policies produced 0 media deliverables for ${displayName}; exactly one is supported.`
      );
    }
    final = deliveries[0];
    extraDeliveries = deliveries.slice(1);
    for (const delivery of deliveries) bindSessionResource(delivery);
  }
  const uploadModel = uploadConfig.model;
  const uploadResource = /* @__PURE__ */ __name(async (item, estimate) => {
    let sha256;
    try {
      sha256 = item.sha256 ?? await hashFileSha256(item.filePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        `Failed to hash media file ${displayName}: ${sanitizeErrorMessage(err, [item.filePath])}`,
        { cause: err }
      );
    }
    const cachedUrl = await uploadCache.get(sha256, uploadModel);
    if (cachedUrl) {
      debugLogger4.debug(
        `omni upload cache hit: sha256=${sha256.slice(0, 12)}\u2026 model=${uploadModel}`
      );
      return {
        fileUri: cachedUrl,
        sha256,
        deduped: true,
        uploadCacheHit: true
      };
    }
    const extension = extensionForMime(item.recognized.detectedMimeType);
    let objectPath;
    let deduped;
    try {
      const put = await store.putFile(item.filePath, sha256, extension, signal);
      objectPath = put.objectPath;
      deduped = put.deduped;
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        `Failed to store media in the omni object store: ${sanitizeErrorMessage(err, [item.filePath, store.getOmniRootDir()])}`,
        { cause: err }
      );
    }
    const uploader = new DashScopeUploader({
      apiKey: uploadConfig.apiKey,
      baseUrl: uploadConfig.baseUrl
    });
    let fileUri;
    try {
      fileUri = await uploader.uploadFile({
        filePath: objectPath,
        model: uploadModel,
        mimeType: item.recognized.detectedMimeType,
        signal
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        sanitizeErrorMessage(err, [objectPath, store.getOmniRootDir()]),
        { cause: err }
      );
    }
    debugLogger4.debug(
      `omni ${item.recognized.modality} delivered: sha256=${sha256.slice(0, 12)}\u2026 size=${item.recognized.sizeBytes} est=${estimate.estimatedTokenCount}(${estimate.status}) deduped=${deduped} degraded=${item.degraded === true} uri=${fileUri}`
    );
    await uploadCache.put(sha256, uploadModel, fileUri);
    return { fileUri, sha256, deduped, uploadCacheHit: false };
  }, "uploadResource");
  const processAdditionalMedia = /* @__PURE__ */ __name(async () => {
    if (extraDeliveries.length === 0) return void 0;
    return Promise.all(
      extraDeliveries.map(
        async (extra) => {
          const extraGuard = evaluateTransportLimits(
            config,
            extra.recognized,
            displayName
          );
          if (extraGuard.violation) {
            debugLogger4.debug(
              `omni additional ${extra.recognized.modality} explicitly omitted (transport guard): ${extraGuard.violation}`
            );
            return {
              fileUri: "",
              mimeType: extra.recognized.detectedMimeType,
              sha256: extra.sha256 ?? "",
              disclosure: extra.disclosure,
              omission: { reason: extraGuard.violation }
            };
          }
          const uploaded2 = await uploadResource(extra, extraGuard.estimate);
          return {
            fileUri: uploaded2.fileUri,
            mimeType: extra.recognized.detectedMimeType,
            sha256: uploaded2.sha256,
            disclosure: extra.disclosure
          };
        }
      )
    );
  }, "processAdditionalMedia");
  let guard = evaluateTransportLimits(config, final.recognized, displayName);
  if (guard.violation && processingConfig) {
    const maxPasses = processingConfig.limits.maxTransportPasses;
    for (let pass = 0; guard.violation && pass < maxPasses; pass++) {
      const guardPolicies = processingConfig.transportGuardPolicies.filter(
        (p) => p.mediaTypes.includes(final.recognized.modality)
      );
      if (guardPolicies.length === 0) break;
      let deliveries;
      let fileDeliveries;
      try {
        ({ deliveries, fileDeliveries } = await runFixedPolicies(
          config,
          {
            filePath: final.filePath,
            recognized: final.recognized,
            displayName,
            origin: options?.origin ?? "user",
            sha256: final.sha256
          },
          {
            store,
            policies: guardPolicies,
            signal,
            limits: processingConfig.limits,
            conditionContext,
            // The guard pass derives FROM the current final resource, so
            // its memory lineage hangs off that resource's own binding
            // (a derivative's version when preprocessing degraded it).
            memory: memoryService ? { service: memoryService, sourceBinding: final.memoryBinding } : void 0
          }
        ));
      } catch (err) {
        if (signal?.aborted) throw err;
        throw guardRejection(
          `Transport-guard processing failed for ${displayName}: ${sanitizeErrorMessage(err, [final.filePath, store.getOmniRootDir()])}`,
          { cause: err }
        );
      }
      collectTranscripts(fileDeliveries);
      if (deliveries.length === 0 && fileDeliveries.length > 0) {
        return textOnlyDelivery(final.recognized, guard.estimate, {
          disclosure: final.disclosure,
          additionalMedia: await processAdditionalMedia()
        });
      }
      if (deliveries.length !== 1) {
        throw guardRejection(
          `Transport-guard policies produced ${deliveries.length} media deliverables for ${displayName}; exactly one is supported.`
        );
      }
      if (deliveries[0].filePath === final.filePath) {
        break;
      }
      const priorDisclosure = final.disclosure;
      final = deliveries[0];
      if (priorDisclosure && final.disclosure) {
        final = {
          ...final,
          disclosure: `${priorDisclosure}\uFF1B${final.disclosure}`
        };
      } else if (priorDisclosure) {
        final = { ...final, disclosure: priorDisclosure };
      }
      bindSessionResource(final);
      guard = evaluateTransportLimits(config, final.recognized, displayName);
    }
  }
  if (guard.violation) {
    if (!processingConfig) {
      throw guardRejection(guard.violation);
    }
    debugLogger4.debug(
      `omni ${final.recognized.modality} explicitly omitted (transport guard): ${guard.violation}`
    );
    return {
      fileUri: "",
      mimeType: final.recognized.detectedMimeType,
      sha256: final.sha256 ?? "",
      recognized: final.recognized,
      tokenEstimate: guard.estimate,
      deduped: false,
      uploadCacheHit: false,
      disclosure: final.disclosure,
      degraded: final.degraded,
      omission: { reason: guard.violation },
      transcripts: transcripts.length > 0 ? transcripts : void 0,
      additionalMedia: await processAdditionalMedia(),
      resourceId: sessionResourceId
    };
  }
  const tokenEstimate = guard.estimate;
  const uploaded = await uploadResource(final, tokenEstimate);
  return {
    fileUri: uploaded.fileUri,
    mimeType: final.recognized.detectedMimeType,
    sha256: uploaded.sha256,
    recognized: final.recognized,
    tokenEstimate,
    deduped: uploaded.deduped,
    uploadCacheHit: uploaded.uploadCacheHit,
    disclosure: final.disclosure,
    degraded: final.degraded,
    transcripts: transcripts.length > 0 ? transcripts : void 0,
    additionalMedia: await processAdditionalMedia(),
    resourceId: sessionResourceId
  };
}
__name(processMediaForOmniDelivery, "processMediaForOmniDelivery");
async function readMediaViaOmniDelivery(params) {
  const {
    filePath,
    config,
    displayName,
    relativePathForDisplay,
    expectedModality,
    signal
  } = params;
  try {
    const delivery = await processMediaForOmniDelivery(filePath, config, {
      expectedModality,
      signal
    });
    const transcriptParts = buildTranscriptParts(
      displayName,
      delivery.transcripts
    );
    const additionalParts = buildAdditionalMediaParts(
      displayName,
      delivery.additionalMedia
    );
    const handleParts = (() => {
      if (!delivery.resourceId) return [];
      const binding = config.getOmniMediaResourceRegistry?.()?.resolve(delivery.resourceId);
      if (binding && binding.fileRef === filePath && !/[\r\n]/.test(filePath)) {
        return [harnessPathAnnotationPart(filePath)];
      }
      return [
        { text: formatResourceHandleText(displayName, delivery.resourceId) }
      ];
    })();
    if (delivery.omission) {
      const omissionPart = {
        text: formatOmissionText(displayName, delivery.omission.reason)
      };
      return {
        llmContent: transcriptParts.length > 0 || additionalParts.length > 0 || handleParts.length > 0 ? [
          ...handleParts,
          omissionPart,
          ...additionalParts,
          ...transcriptParts
        ] : omissionPart.text,
        returnDisplay: `Media omitted by the omni transport guard: ${relativePathForDisplay}`,
        tokenEstimate: delivery.tokenEstimate
      };
    }
    if (!delivery.fileUri && transcriptParts.length > 0) {
      const disclosureParts = delivery.disclosure ? [{ text: formatDisclosureText(displayName, delivery.disclosure) }] : [];
      return {
        llmContent: [
          ...handleParts,
          ...disclosureParts,
          ...additionalParts,
          ...transcriptParts
        ],
        returnDisplay: `Read ${delivery.recognized.modality} as transcript (omni policy): ${relativePathForDisplay}`,
        tokenEstimate: delivery.tokenEstimate
      };
    }
    const fileDataPart = {
      fileData: {
        fileUri: delivery.fileUri,
        mimeType: delivery.mimeType,
        displayName
      }
    };
    const parts = [
      ...handleParts
    ];
    const { width, height } = delivery.recognized.metadata;
    if (delivery.recognized.modality === "image" && width !== void 0 && height !== void 0) {
      parts.push({
        text: delivery.disclosure ? `Image ${displayName}: delivered at ${width}x${height} px after degradation. Use zoom_image to inspect details \u2014 it reads the original file.` : `Image ${displayName}: full resolution ${width}x${height} px. Use zoom_image for a closer look at details.`
      });
    }
    if (delivery.disclosure) {
      parts.push({
        text: formatDisclosureText(displayName, delivery.disclosure)
      });
    }
    parts.push(fileDataPart);
    parts.push(...additionalParts);
    parts.push(...transcriptParts);
    const llmContent = parts.length === 1 ? fileDataPart : parts;
    return {
      llmContent,
      returnDisplay: `Read ${delivery.recognized.modality} file (omni upload): ${relativePathForDisplay}`,
      tokenEstimate: delivery.tokenEstimate
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    const message = sanitizeErrorMessage(err, [filePath]);
    return {
      llmContent: `[Omni media delivery failed for ${displayName}: ${message}]`,
      returnDisplay: `Failed to deliver media via omni upload: ${relativePathForDisplay}`,
      error: `Omni media delivery failed: ${displayName}: ${message}`,
      errorType: "read_content_failure" /* READ_CONTENT_FAILURE */
    };
  }
}
__name(readMediaViaOmniDelivery, "readMediaViaOmniDelivery");
function effectiveMaxDownloadFileBytes(config) {
  const uploadCap = effectiveMaxUploadFileBytes(config);
  const configured = config.getOmniUrlDownloadMaxFileBytes?.();
  if (configured !== void 0 && configured > 0) {
    return Math.min(configured, uploadCap);
  }
  return uploadCap;
}
__name(effectiveMaxDownloadFileBytes, "effectiveMaxDownloadFileBytes");

export {
  OmniDownloadError,
  parseHttpUrlRef,
  downloadMediaUrl,
  exportOmniTrajectory,
  serializeOmniTrajectory,
  writeOmniTrajectoryJsonl,
  sanitizeErrorMessage,
  buildAdditionalMediaParts,
  buildTranscriptParts,
  OmniDeliveryError,
  processMediaForOmniDelivery,
  readMediaViaOmniDelivery,
  effectiveMaxDownloadFileBytes,
  processToolResultOmniMedia
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
