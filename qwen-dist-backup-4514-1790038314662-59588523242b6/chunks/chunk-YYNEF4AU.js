// Force strict mode and setup for ESM
"use strict";
import {
  detectAvailableMemoryMb
} from "./chunk-LYD3T3H7.js";
import {
  MissingCliEntryError
} from "./chunk-SIUR4U2P.js";
import {
  AcpChildCapacityExceededError
} from "./chunk-YXHY6BKS.js";
import {
  redactLogCredentials
} from "./chunk-M5GB774H.js";
import {
  EXTERNAL_TOOL_GUARD_TOKEN_ENV
} from "./chunk-3VUENPWF.js";
import {
  CLIENT_METHODS,
  zCreateTerminalRequest,
  zKillTerminalCommandRequest,
  zReadTextFileRequest,
  zReleaseTerminalRequest,
  zRequestPermissionRequest,
  zSessionNotification,
  zTerminalOutputRequest,
  zWaitForTerminalExitRequest,
  zWriteTextFileRequest
} from "./chunk-IJOS26LH.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/spawnChannel.ts
init_esbuild_shims();
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { getHeapStatistics } from "node:v8";

// packages/acp-bridge/src/child-env-forwarding.ts
init_esbuild_shims();
var forwardingFactories = /* @__PURE__ */ new WeakSet();
function markChannelFactoryForwardsChildEnv(factory) {
  forwardingFactories.add(factory);
}
__name(markChannelFactoryForwardsChildEnv, "markChannelFactoryForwardsChildEnv");
function channelFactoryForwardsChildEnv(factory) {
  return forwardingFactories.has(factory);
}
__name(channelFactoryForwardsChildEnv, "channelFactoryForwardsChildEnv");

// packages/acp-bridge/src/ndJsonStream.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
var NDJSON_QUEUE_SATURATION_GRACE_MS = 5e3;
var NdJsonFrameTooLargeError = class extends Error {
  constructor(direction, limitBytes, observedBytes) {
    super(
      `NDJSON ${direction} frame exceeds ${limitBytes} bytes (observed ${observedBytes} bytes)`
    );
    this.direction = direction;
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
    this.name = "NdJsonFrameTooLargeError";
  }
  static {
    __name(this, "NdJsonFrameTooLargeError");
  }
  code = "ndjson_frame_too_large";
};
var NdJsonQueueLimitError = class extends Error {
  constructor(budget, maxQueuedMessages, maxQueuedBytes, requiredBytes, availableBytes) {
    super(
      `NDJSON ${budget} queue limit exceeded (required ${requiredBytes} bytes, available ${availableBytes} bytes)`
    );
    this.budget = budget;
    this.maxQueuedMessages = maxQueuedMessages;
    this.maxQueuedBytes = maxQueuedBytes;
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
    this.name = "NdJsonQueueLimitError";
  }
  static {
    __name(this, "NdJsonQueueLimitError");
  }
  code = "ndjson_queue_limit_exceeded";
};
var NdJsonIncompleteFrameError = class extends Error {
  constructor(observedBytes) {
    super(`NDJSON input ended with an incomplete ${observedBytes}-byte frame`);
    this.observedBytes = observedBytes;
    this.name = "NdJsonIncompleteFrameError";
  }
  static {
    __name(this, "NdJsonIncompleteFrameError");
  }
  code = "ndjson_incomplete_frame";
};
var NdJsonUnexpectedEofError = class extends Error {
  static {
    __name(this, "NdJsonUnexpectedEofError");
  }
  code = "ndjson_unexpected_eof";
  constructor() {
    super("NDJSON input ended while the bounded transport was active");
    this.name = "NdJsonUnexpectedEofError";
  }
};
var NdJsonInvalidMessageError = class extends Error {
  constructor(code, observedBytes) {
    super(`NDJSON input contains an invalid ${observedBytes}-byte message`);
    this.code = code;
    this.observedBytes = observedBytes;
    this.name = "NdJsonInvalidMessageError";
  }
  static {
    __name(this, "NdJsonInvalidMessageError");
  }
};
var MAX_JSON_RPC_METHOD_BYTES = 1024;
var MAX_JSON_RPC_ID_BYTES = 256;
var MAX_JSON_RPC_ERROR_MESSAGE_BYTES = 1024;
var MAX_JSON_DEPTH = 64;
var MAX_JSON_NODES = 1e4;
var MAX_JSON_ARRAY_LENGTH = 4096;
function ndJsonStream(output, input, hooks, limits, validateInboundMessage, fatalCleanEof = false) {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  if (limits) validateNdJsonStreamLimits(limits);
  const outboundRequests = limits ? new BoundedOutstandingRequestLedger(limits) : void 0;
  const inboundRequests = limits ? new BoundedInboundRequestLedger(limits) : void 0;
  const readable = limits ? createBoundedReadable(
    input,
    textDecoder,
    hooks,
    limits,
    outboundRequests,
    inboundRequests,
    validateInboundMessage,
    fatalCleanEof
  ) : createLegacyReadable(input, textDecoder, hooks);
  const writable = new WritableStream({
    async write(message) {
      let writer;
      let expectedResponseId;
      try {
        const content = JSON.stringify(message);
        const payload = textEncoder.encode(content);
        const frameBytes = payload.byteLength + 1;
        if (limits && frameBytes > limits.maxFrameBytes) {
          throw new NdJsonFrameTooLargeError(
            "sent",
            limits.maxFrameBytes,
            frameBytes
          );
        }
        const frame = new Uint8Array(frameBytes);
        frame.set(payload);
        frame[payload.byteLength] = 10;
        if (outboundRequests && isJsonRpcRequestMessage(message)) {
          outboundRequests.admit(message.id, frameBytes);
          expectedResponseId = message.id;
        }
        writer = output.getWriter();
        await writer.write(frame);
        inboundRequests?.release(message);
        callHook(hooks?.onMessageSent, payload.byteLength);
        callHook(hooks?.onMessageObserved, {
          direction: "sent",
          bytes: payload.byteLength,
          message
        });
      } catch (error) {
        if (expectedResponseId !== void 0) {
          outboundRequests?.discard(expectedResponseId);
        }
        if (limits) callHook(hooks?.onTransportError, error);
        throw error;
      } finally {
        writer?.releaseLock();
      }
    }
  });
  return { readable, writable };
}
__name(ndJsonStream, "ndJsonStream");
function createLegacyReadable(input, textDecoder, hooks) {
  return new ReadableStream({
    async start(controller) {
      const pending = [];
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          readLegacyChunk(value, pending, controller, textDecoder, hooks);
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    }
  });
}
__name(createLegacyReadable, "createLegacyReadable");
function createBoundedReadable(input, textDecoder, hooks, limits, outboundRequests, inboundRequests, validateInboundMessage, fatalCleanEof) {
  const pending = new BoundedFrameBuffer(limits.maxFrameBytes);
  const minimumQueueCharge = Math.ceil(
    limits.maxQueuedBytes / limits.maxQueuedMessages
  );
  const graceMs = limits.queueSaturationGraceMs ?? NDJSON_QUEUE_SATURATION_GRACE_MS;
  let nextQueueCharge = minimumQueueCharge;
  let reader;
  let canceled = false;
  let saturationWarned = false;
  let wakeQueueWaiter;
  const waitForQueueSpace = /* @__PURE__ */ __name((timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(
      finish,
      // Node clamps delays above 2^31-1 ms to 1 ms (and warns), which would
      // spin the wait loop; cap so a long grace waits instead.
      Math.min(Math.max(0, timeoutMs), 2147483647)
    );
    function finish() {
      clearTimeout(timer);
      wakeQueueWaiter = void 0;
      resolve();
    }
    __name(finish, "finish");
    wakeQueueWaiter = finish;
  }), "waitForQueueSpace");
  const ensureQueueSpace = /* @__PURE__ */ __name(async (controller, queueCharge) => {
    const queueLimitError = /* @__PURE__ */ __name((available) => new NdJsonQueueLimitError(
      "decoded",
      limits.maxQueuedMessages,
      limits.maxQueuedBytes,
      queueCharge,
      Math.max(0, available)
    ), "queueLimitError");
    let availableBytes = controller.desiredSize;
    if (availableBytes === null) throw queueLimitError(0);
    if (availableBytes === limits.maxQueuedBytes) saturationWarned = false;
    if (queueCharge <= availableBytes) return;
    if (queueCharge > limits.maxQueuedBytes) {
      throw queueLimitError(availableBytes);
    }
    if (!saturationWarned) {
      saturationWarned = true;
      callHook(hooks?.onQueueSaturated, {
        requiredBytes: queueCharge,
        availableBytes: Math.max(0, availableBytes),
        maxQueuedMessages: limits.maxQueuedMessages,
        maxQueuedBytes: limits.maxQueuedBytes,
        graceMs
      });
    }
    const deadline = performance.now() + graceMs;
    while (queueCharge > availableBytes) {
      if (canceled) return;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw queueLimitError(availableBytes);
      await waitForQueueSpace(remainingMs);
      if (canceled) return;
      const nextAvailableBytes = controller.desiredSize;
      if (nextAvailableBytes === null) throw queueLimitError(0);
      availableBytes = nextAvailableBytes;
    }
  }, "ensureQueueSpace");
  return new ReadableStream(
    {
      start(controller) {
        reader = input.getReader();
        void pumpBoundedInput(
          reader,
          pending,
          controller,
          textDecoder,
          hooks,
          limits,
          outboundRequests,
          inboundRequests,
          validateInboundMessage,
          fatalCleanEof,
          minimumQueueCharge,
          ensureQueueSpace,
          (charge) => {
            nextQueueCharge = charge;
          },
          () => canceled
        );
      },
      pull() {
        wakeQueueWaiter?.();
      },
      async cancel(reason) {
        canceled = true;
        pending.clear();
        wakeQueueWaiter?.();
        if (reader) await cancelReader(reader, reason);
      }
    },
    {
      highWaterMark: limits.maxQueuedBytes,
      size: /* @__PURE__ */ __name(() => nextQueueCharge, "size")
    }
  );
}
__name(createBoundedReadable, "createBoundedReadable");
async function pumpBoundedInput(reader, pending, controller, textDecoder, hooks, limits, outboundRequests, inboundRequests, validateInboundMessage, fatalCleanEof, minimumQueueCharge, ensureQueueSpace, setNextQueueCharge, isCanceled) {
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        if (isCanceled()) return;
        if (pending.byteLength > 0) {
          throw new NdJsonIncompleteFrameError(pending.byteLength);
        }
        if (fatalCleanEof) throw new NdJsonUnexpectedEofError();
        controller.close();
        return;
      }
      if (!result.value) continue;
      await readBoundedChunk(
        result.value,
        pending,
        controller,
        textDecoder,
        hooks,
        limits,
        outboundRequests,
        inboundRequests,
        validateInboundMessage,
        minimumQueueCharge,
        ensureQueueSpace,
        setNextQueueCharge,
        isCanceled
      );
      if (isCanceled()) return;
    }
  } catch (error) {
    if (isCanceled()) return;
    pending.clear();
    callHook(hooks?.onTransportError, error);
    await cancelReader(reader, error);
    if (!isCanceled()) controller.close();
  } finally {
    pending.clear();
    outboundRequests.clear();
    inboundRequests.clear();
    reader.releaseLock();
  }
}
__name(pumpBoundedInput, "pumpBoundedInput");
function readLegacyChunk(chunk, pending, controller, textDecoder, hooks) {
  let start = 0;
  let newline = chunk.indexOf(10, start);
  while (newline !== -1) {
    const lineBytes = takeLegacyLineBytes(
      pending,
      chunk.subarray(start, newline)
    );
    handleLegacyLine(lineBytes, controller, textDecoder, hooks);
    start = newline + 1;
    newline = chunk.indexOf(10, start);
  }
  if (start < chunk.length) {
    pending.push(chunk.subarray(start));
  }
}
__name(readLegacyChunk, "readLegacyChunk");
async function readBoundedChunk(chunk, pending, controller, textDecoder, hooks, limits, outboundRequests, inboundRequests, validateInboundMessage, minimumQueueCharge, ensureQueueSpace, setNextQueueCharge, isCanceled) {
  let start = 0;
  let newline = chunk.indexOf(10, start);
  while (newline !== -1) {
    const current = chunk.subarray(start, newline);
    const frameBytes = pending.byteLength + current.byteLength + 1;
    assertFrameSize("received", limits.maxFrameBytes, frameBytes);
    if (pending.isJsonWhitespaceLine(current)) {
      pending.clear();
      start = newline + 1;
      newline = chunk.indexOf(10, start);
      continue;
    }
    const queueCharge = Math.max(frameBytes, minimumQueueCharge);
    await ensureQueueSpace(controller, queueCharge);
    if (isCanceled()) return;
    setNextQueueCharge(queueCharge);
    handleBoundedLine(
      pending.take(current),
      controller,
      textDecoder,
      hooks,
      outboundRequests,
      inboundRequests,
      validateInboundMessage
    );
    start = newline + 1;
    newline = chunk.indexOf(10, start);
  }
  if (start < chunk.length) pending.append(chunk.subarray(start));
}
__name(readBoundedChunk, "readBoundedChunk");
function takeLegacyLineBytes(pending, current) {
  if (pending.length === 0) return current;
  const totalLength = pending.reduce((sum, part) => sum + part.byteLength, 0) + current.byteLength;
  const line = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of pending) {
    line.set(part, offset);
    offset += part.byteLength;
  }
  line.set(current, offset);
  pending.length = 0;
  return line;
}
__name(takeLegacyLineBytes, "takeLegacyLineBytes");
function handleLegacyLine(lineBytes, controller, textDecoder, hooks) {
  const line = textDecoder.decode(lineBytes);
  const trimmedLine = line.trim();
  if (!trimmedLine) return;
  try {
    const message = JSON.parse(trimmedLine);
    controller.enqueue(message);
    reportReceivedMessage(lineBytes, message, hooks);
  } catch (err) {
    console.error("Failed to parse JSON message:", trimmedLine, err);
  }
}
__name(handleLegacyLine, "handleLegacyLine");
function handleBoundedLine(lineBytes, controller, textDecoder, hooks, outboundRequests, inboundRequests, validateInboundMessage) {
  const line = textDecoder.decode(lineBytes);
  const trimmedLine = line.trim();
  if (!trimmedLine) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmedLine);
  } catch {
    throw logBoundedInvalidMessage("ndjson_parse_error", lineBytes);
  }
  if (!isJsonRpcMessage(parsed)) {
    throw logBoundedInvalidMessage("ndjson_invalid_message", lineBytes);
  }
  const isResponse = isJsonRpcResponseMessage(parsed);
  if (!isResponse && !hasBoundedJsonStructure(parsed) || validateInboundMessage && !validateInboundMessage(parsed)) {
    throw logBoundedInvalidMessage("ndjson_invalid_message", lineBytes);
  }
  if (isJsonRpcResponseMessage(parsed) && !outboundRequests?.consumeResponse(parsed.id)) {
    throw logBoundedInvalidMessage("ndjson_invalid_message", lineBytes);
  }
  inboundRequests?.admit(parsed, lineBytes.byteLength + 1);
  const message = installBoundedLogRedaction(parsed);
  controller.enqueue(message);
  reportReceivedMessage(lineBytes, message, hooks);
}
__name(handleBoundedLine, "handleBoundedLine");
function installBoundedLogRedaction(message) {
  Object.defineProperty(message, inspect.custom, {
    configurable: false,
    enumerable: false,
    value: inspectBoundedJsonRpcMessage,
    writable: false
  });
  return message;
}
__name(installBoundedLogRedaction, "installBoundedLogRedaction");
function inspectBoundedJsonRpcMessage() {
  return {
    jsonrpc: "2.0",
    messageType: "method" in this ? "id" in this ? "request" : "notification" : "response",
    payloadOmitted: true
  };
}
__name(inspectBoundedJsonRpcMessage, "inspectBoundedJsonRpcMessage");
function isJsonRpcMessage(value) {
  if (!isRecord(value) || value["jsonrpc"] !== "2.0") return false;
  const hasMethod = Object.hasOwn(value, "method");
  const hasId = Object.hasOwn(value, "id");
  if (hasMethod) {
    return typeof value["method"] === "string" && Buffer.byteLength(value["method"]) <= MAX_JSON_RPC_METHOD_BYTES && (!hasId || isJsonRpcId(value["id"]));
  }
  if (!hasId || !isJsonRpcId(value["id"])) return false;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  const error = value["error"];
  return isRecord(error) && typeof error["code"] === "number" && Number.isFinite(error["code"]) && typeof error["message"] === "string" && Buffer.byteLength(error["message"]) <= MAX_JSON_RPC_ERROR_MESSAGE_BYTES;
}
__name(isJsonRpcMessage, "isJsonRpcMessage");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function hasBoundedJsonStructure(value) {
  const stack = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes++;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_ARRAY_LENGTH) return false;
      for (let index = current.value.length - 1; index >= 0; index--) {
        if (nodes + stack.length >= MAX_JSON_NODES || current.depth + 1 > MAX_JSON_DEPTH) {
          return false;
        }
        stack.push({
          value: current.value[index],
          depth: current.depth + 1
        });
      }
    } else if (isRecord(current.value)) {
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) continue;
        if (nodes + stack.length >= MAX_JSON_NODES || current.depth + 1 > MAX_JSON_DEPTH) {
          return false;
        }
        stack.push({
          value: current.value[key],
          depth: current.depth + 1
        });
      }
    }
  }
  return true;
}
__name(hasBoundedJsonStructure, "hasBoundedJsonStructure");
function isJsonRpcId(value) {
  return value === null || typeof value === "string" && Buffer.byteLength(value) <= MAX_JSON_RPC_ID_BYTES || typeof value === "number" && Number.isFinite(value);
}
__name(isJsonRpcId, "isJsonRpcId");
function isJsonRpcRequestMessage(value) {
  return "method" in value && "id" in value && typeof value.method === "string" && isJsonRpcId(value.id);
}
__name(isJsonRpcRequestMessage, "isJsonRpcRequestMessage");
function isJsonRpcResponseMessage(value) {
  return !("method" in value) && "id" in value;
}
__name(isJsonRpcResponseMessage, "isJsonRpcResponseMessage");
var BoundedInboundRequestLedger = class {
  constructor(limits) {
    this.limits = limits;
  }
  static {
    __name(this, "BoundedInboundRequestLedger");
  }
  requests = /* @__PURE__ */ new Map();
  retainedBytes = 0;
  admit(message, frameBytes) {
    if (!isJsonRpcRequestMessage(message)) return;
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes
    );
    if (this.requests.has(message.id) || this.requests.size >= this.limits.maxQueuedMessages || frameBytes > availableBytes) {
      throw new NdJsonQueueLimitError(
        "inbound_request",
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        frameBytes,
        this.requests.has(message.id) ? 0 : availableBytes
      );
    }
    this.requests.set(message.id, frameBytes);
    this.retainedBytes += frameBytes;
  }
  release(message) {
    if (!isJsonRpcResponseMessage(message)) return;
    const frameBytes = this.requests.get(message.id);
    if (frameBytes === void 0) return;
    this.requests.delete(message.id);
    this.retainedBytes -= frameBytes;
  }
  clear() {
    this.requests.clear();
    this.retainedBytes = 0;
  }
};
var BoundedOutstandingRequestLedger = class {
  constructor(limits) {
    this.limits = limits;
  }
  static {
    __name(this, "BoundedOutstandingRequestLedger");
  }
  requests = /* @__PURE__ */ new Map();
  retainedBytes = 0;
  admit(id, frameBytes) {
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes
    );
    if (this.requests.has(id) || this.requests.size >= this.limits.maxQueuedMessages || frameBytes > availableBytes) {
      throw new NdJsonQueueLimitError(
        "outbound_request",
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        frameBytes,
        this.requests.has(id) ? 0 : availableBytes
      );
    }
    this.requests.set(id, frameBytes);
    this.retainedBytes += frameBytes;
  }
  consumeResponse(id) {
    return this.discard(id);
  }
  discard(id) {
    const frameBytes = this.requests.get(id);
    if (frameBytes === void 0) return false;
    this.requests.delete(id);
    this.retainedBytes -= frameBytes;
    return true;
  }
  clear() {
    this.requests.clear();
    this.retainedBytes = 0;
  }
};
function logBoundedInvalidMessage(errorKind, lineBytes) {
  const bytes = jsonPayloadByteLength(lineBytes);
  const digest = createHash("sha256").update(lineBytes.subarray(0, bytes)).digest("hex");
  console.error("Failed to parse JSON message:", {
    errorKind,
    bytes,
    sha256: digest,
    payloadOmitted: true
  });
  return new NdJsonInvalidMessageError(errorKind, bytes);
}
__name(logBoundedInvalidMessage, "logBoundedInvalidMessage");
function reportReceivedMessage(lineBytes, message, hooks) {
  const bytes = jsonPayloadByteLength(lineBytes);
  callHook(hooks?.onMessageReceived, bytes);
  callHook(hooks?.onMessageObserved, {
    direction: "received",
    bytes,
    message
  });
}
__name(reportReceivedMessage, "reportReceivedMessage");
function jsonPayloadByteLength(lineBytes) {
  return lineBytes[lineBytes.byteLength - 1] === 13 ? lineBytes.byteLength - 1 : lineBytes.byteLength;
}
__name(jsonPayloadByteLength, "jsonPayloadByteLength");
function validateNdJsonStreamLimits(limits) {
  const values = [
    ["maxFrameBytes", limits.maxFrameBytes],
    ["maxQueuedMessages", limits.maxQueuedMessages],
    ["maxQueuedBytes", limits.maxQueuedBytes],
    ...limits.queueSaturationGraceMs !== void 0 ? [["queueSaturationGraceMs", limits.queueSaturationGraceMs]] : []
  ];
  for (const [name, value] of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}
__name(validateNdJsonStreamLimits, "validateNdJsonStreamLimits");
function assertFrameSize(direction, limitBytes, observedBytes) {
  if (observedBytes > limitBytes) {
    throw new NdJsonFrameTooLargeError(direction, limitBytes, observedBytes);
  }
}
__name(assertFrameSize, "assertFrameSize");
async function cancelReader(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch {
  }
}
__name(cancelReader, "cancelReader");
function callHook(hook, value) {
  try {
    hook?.(value);
  } catch {
  }
}
__name(callHook, "callHook");
var BoundedFrameBuffer = class {
  constructor(maxFrameBytes) {
    this.maxFrameBytes = maxFrameBytes;
  }
  static {
    __name(this, "BoundedFrameBuffer");
  }
  buffer;
  length = 0;
  get byteLength() {
    return this.length;
  }
  append(bytes) {
    const requiredBytes = this.length + bytes.byteLength;
    assertFrameSize("received", this.maxFrameBytes, requiredBytes);
    if (requiredBytes === 0) return;
    if (!this.buffer || this.buffer.byteLength < requiredBytes) {
      const doubledCapacity = Math.min(
        this.maxFrameBytes,
        Math.max(1024, (this.buffer?.byteLength ?? 0) * 2)
      );
      const next = new Uint8Array(Math.max(requiredBytes, doubledCapacity));
      if (this.buffer) next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(bytes, this.length);
    this.length = requiredBytes;
  }
  take(current) {
    if (this.length === 0) return current;
    const line = new Uint8Array(this.length + current.byteLength);
    line.set(this.buffer.subarray(0, this.length));
    line.set(current, this.length);
    this.clear();
    return line;
  }
  isJsonWhitespaceLine(current) {
    if (this.buffer) {
      for (let index = 0; index < this.length; index++) {
        if (!isJsonWhitespaceByte(this.buffer[index])) return false;
      }
    }
    for (const byte of current) {
      if (!isJsonWhitespaceByte(byte)) return false;
    }
    return true;
  }
  clear() {
    this.buffer = void 0;
    this.length = 0;
  }
};
function isJsonWhitespaceByte(byte) {
  return byte === 32 || byte === 9 || byte === 13;
}
__name(isJsonWhitespaceByte, "isJsonWhitespaceByte");

// packages/acp-bridge/src/process-registry.ts
init_esbuild_shims();
import {
  execFile,
  spawnSync
} from "node:child_process";
var TERM_GRACE_MS = 5e3;
var EXIT_DEADLINE_MS = 1e4;
var PROCESS_QUERY_TIMEOUT_MS = 2e3;
var PROCESS_QUERY_MAX_BUFFER = 8 * 1024 * 1024;
var PROCESS_POLL_MS = 50;
var PROCESS_STATE_POLL_MS = 250;
var MAX_OWNED_PROCESSES = 256;
var MAX_OWNERSHIP_DEPTH = 8;
var POSIX_PS = "/bin/ps";
var WINDOWS_TASKKILL = `${process.env["SystemRoot"] || "C:\\Windows"}\\System32\\taskkill.exe`;
var STRING_EXEC_OPTIONS = {
  encoding: "utf8",
  maxBuffer: PROCESS_QUERY_MAX_BUFFER,
  timeout: PROCESS_QUERY_TIMEOUT_MS,
  windowsHide: true
};
var ProcessRegistry = class {
  static {
    __name(this, "ProcessRegistry");
  }
  reservations = /* @__PURE__ */ new Set();
  children = /* @__PURE__ */ new Set();
  draining = false;
  shutdownPromise;
  reserve() {
    if (this.draining) {
      throw new Error("ACP process registry is draining");
    }
    const token = Symbol("acp-child");
    this.reservations.add(token);
    let settled = false;
    return {
      attach: /* @__PURE__ */ __name((child, options) => {
        if (settled || !this.reservations.delete(token)) {
          throw new Error("ACP process reservation is no longer active");
        }
        settled = true;
        const tracked = new TrackedChild(
          child,
          options?.ownsProcessTree === true,
          () => {
            this.children.delete(tracked);
          }
        );
        this.children.add(tracked);
        if (this.draining) void tracked.terminate().catch(() => {
        });
        return tracked;
      }, "attach"),
      cancel: /* @__PURE__ */ __name(() => {
        if (settled) return;
        settled = true;
        this.reservations.delete(token);
      }, "cancel")
    };
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    this.shutdownPromise = Promise.allSettled(
      [...this.children].map((child) => child.terminate())
    ).then((results) => {
      const failures = results.flatMap(
        (result) => result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "ACP child process shutdown failed");
      }
    });
    return this.shutdownPromise;
  }
  killAllSync() {
    this.draining = true;
    let processTable;
    if (process.platform !== "win32" && [...this.children].some((child) => child.needsProcessTreeSnapshot)) {
      try {
        processTable = parseProcessTable(queryProcessTableSync());
      } catch {
        processTable = null;
      }
    }
    for (const child of this.children) child.killSync(processTable);
  }
  get activeProcessCount() {
    return this.children.size;
  }
  /**
   * Children this registry has committed to: attached ones plus reservations
   * that have not attached yet. Larger than {@link activeProcessCount}, and
   * the right figure for admission — `reserve()` inserts its token
   * synchronously before `spawn()`, so two racing spawns each see the other
   * here, while neither is visible in `activeProcessCount` until its child is
   * attached.
   *
   * A direct child leaves this count when its root exits. A tree-owned child
   * under explicit teardown remains committed until its known tree is gone,
   * so a channel swap includes memory still held by descendants.
   */
  get committedProcessCount() {
    return this.children.size + this.reservations.size;
  }
};
var TrackedChild = class {
  constructor(child, ownsProcessTree, onRelease) {
    this.child = child;
    this.ownsProcessTree = ownsProcessTree;
    this.onRelease = onRelease;
    this.rememberRoot();
    this.exited = new Promise((resolve) => {
      const finish = /* @__PURE__ */ __name((info) => {
        if (this.exitedSettled) return;
        this.exitedSettled = true;
        this.exitInfo = info;
        resolve(info);
        this.handleRootExit();
      }, "finish");
      child.once("exit", (exitCode, signalCode) => {
        finish({ exitCode, signalCode });
      });
      child.once("spawn", () => {
        this.spawnConfirmed = true;
        this.rememberRoot();
      });
      child.once("error", () => {
        if (!this.spawnConfirmed) finish(void 0);
      });
    });
  }
  static {
    __name(this, "TrackedChild");
  }
  exited;
  knownGroups = /* @__PURE__ */ new Set();
  cleanupProofError;
  exitInfo;
  exitedSettled = false;
  forceKillRequested = false;
  released = false;
  releasePollTimer;
  releaseStateCheckInFlight = false;
  spawnConfirmed = false;
  terminatePromise;
  terminating = false;
  terminationSettled = false;
  terminate() {
    if (this.terminatePromise) return this.terminatePromise;
    this.terminating = true;
    if (this.releasePollTimer) {
      clearTimeout(this.releasePollTimer);
      this.releasePollTimer = void 0;
    }
    const termination = this.ownsProcessTree ? this.terminateTree() : this.terminateDirectChild();
    this.terminatePromise = termination.finally(() => {
      this.terminationSettled = true;
      if (this.ownsProcessTree && this.exitedSettled && !this.released) {
        this.releaseWhenGroupsExit();
      }
    });
    return this.terminatePromise;
  }
  get needsProcessTreeSnapshot() {
    return this.ownsProcessTree && !this.forceKillRequested && !this.rootHasExited && !this.released;
  }
  killSync(processTable) {
    if (!this.ownsProcessTree) {
      this.killDirectChildSync();
      return;
    }
    if (this.released) return;
    const firstForceKill = !this.forceKillRequested;
    this.forceKillRequested = true;
    const rootPid = this.rootPid;
    if (!rootPid) {
      this.killDirectChildSync();
      return;
    }
    if (process.platform === "win32") {
      if (!firstForceKill) return;
      if (!taskkillSync(rootPid)) this.killDirectChildSync();
      return;
    }
    if (firstForceKill && !this.rootHasExited) {
      if (processTable === void 0) this.mergeSynchronousSnapshot();
      else if (processTable !== null) {
        this.mergeSnapshot(collectOwnership(processTable, rootPid));
      }
    }
    const rootSignalled = this.signalKnownGroups("SIGKILL");
    this.signalDirectRootIfNeeded("SIGKILL", rootSignalled);
    if (this.exitedSettled && this.survivingGroups().length === 0) {
      this.release();
    }
  }
  get rootPid() {
    const pid = this.child.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : void 0;
  }
  get rootHasExited() {
    return this.exitedSettled || this.child.exitCode !== null || this.child.signalCode !== null;
  }
  rememberRoot() {
    if (!this.ownsProcessTree) return;
    const rootPid = this.rootPid;
    if (!rootPid) return;
    if (process.platform !== "win32") this.knownGroups.add(rootPid);
  }
  handleRootExit() {
    if (!this.ownsProcessTree) {
      this.release();
      return;
    }
    if (this.terminating && !this.terminationSettled) return;
    if (process.platform !== "win32") {
      this.forceKillRequested = true;
      this.signalKnownGroups("SIGKILL");
      this.releaseWhenGroupsExit();
      return;
    }
    this.release();
  }
  release() {
    if (this.released) return;
    this.released = true;
    if (this.releasePollTimer) clearTimeout(this.releasePollTimer);
    this.onRelease();
  }
  killDirectChildSync() {
    if (this.exitedSettled) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
    }
  }
  signalDirectRootIfNeeded(signal, rootGroupSignalled) {
    const rootPid = this.rootPid;
    if (!rootPid || this.exitedSettled || rootGroupSignalled) return;
    try {
      this.child.kill(signal);
    } catch {
    }
  }
  async terminateDirectChild() {
    if (this.exitedSettled) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      if (this.exitedSettled) return;
    }
    let hardKillTimer;
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      hardKillTimer = setTimeout(
        () => this.killDirectChildSync(),
        TERM_GRACE_MS
      );
      hardKillTimer.unref();
      deadlineTimer = setTimeout(() => {
        reject(
          new Error(
            `ACP child pid=${this.child.pid ?? "unknown"} did not exit within ${EXIT_DEADLINE_MS}ms`
          )
        );
      }, EXIT_DEADLINE_MS);
      deadlineTimer.unref();
    });
    try {
      const exitInfo = await Promise.race([this.exited, deadline]);
      this.throwForUncleanExit(exitInfo);
    } finally {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }
  async terminateTree() {
    if (this.exitedSettled && (process.platform === "win32" || this.released)) {
      return;
    }
    const rootPid = this.rootPid;
    if (!rootPid) {
      await this.terminateDirectChild();
      return;
    }
    if (process.platform === "win32") {
      await this.terminateWindowsTree(rootPid);
      return;
    }
    await this.terminatePosixTree(rootPid);
  }
  async terminatePosixTree(rootPid) {
    const startedAt = Date.now();
    if (!this.rootHasExited) {
      await this.mergeAsynchronousSnapshot(rootPid, true);
    }
    let escalated = this.forceKillRequested;
    let rootSignalled = this.signalKnownGroups(
      escalated ? "SIGKILL" : "SIGTERM"
    );
    this.signalDirectRootIfNeeded(
      escalated ? "SIGKILL" : "SIGTERM",
      rootSignalled
    );
    const graceDeadline = Math.min(
      startedAt + EXIT_DEADLINE_MS,
      Date.now() + TERM_GRACE_MS
    );
    const exitDeadline = startedAt + EXIT_DEADLINE_MS;
    let nextStateCheckAt = 0;
    while (true) {
      let survivingGroups = this.survivingGroups();
      let now = Date.now();
      if (this.exitedSettled && escalated && survivingGroups.length > 0 && now < exitDeadline && now >= nextStateCheckAt) {
        await this.pruneTerminalGroups(survivingGroups, exitDeadline - now);
        nextStateCheckAt = Date.now() + PROCESS_STATE_POLL_MS;
        survivingGroups = this.survivingGroups();
        now = Date.now();
      }
      if (this.exitedSettled && survivingGroups.length === 0) {
        this.release();
        if (this.cleanupProofError) throw this.cleanupProofError;
        this.throwForUncleanExit(this.exitInfo);
        return;
      }
      if (!escalated && (this.forceKillRequested || now >= graceDeadline)) {
        if (!this.rootHasExited && this.knownGroups.has(rootPid)) {
          await this.mergeAsynchronousSnapshot(rootPid, false);
        }
        escalated = true;
        rootSignalled = this.signalKnownGroups("SIGKILL");
        this.signalDirectRootIfNeeded("SIGKILL", rootSignalled);
        continue;
      }
      if (now >= exitDeadline) {
        const groups = survivingGroups.join(",") || "none";
        const proof = this.cleanupProofError ? `; ${this.cleanupProofError.message}` : "";
        throw new Error(
          `ACP child pid=${rootPid} did not exit with its owned process groups within ${EXIT_DEADLINE_MS}ms (surviving pgids=${groups})${proof}`
        );
      }
      await delay(
        Math.min(
          PROCESS_POLL_MS,
          (escalated ? exitDeadline : graceDeadline) - now
        )
      );
      if (this.forceKillRequested) escalated = true;
    }
  }
  async terminateWindowsTree(rootPid) {
    const startedAt = Date.now();
    let treeKillError;
    try {
      await taskkill(rootPid);
    } catch (error) {
      treeKillError = toError(error);
      this.killDirectChildSync();
    }
    const remainingMs = Math.max(
      1,
      EXIT_DEADLINE_MS - (Date.now() - startedAt)
    );
    const exitInfo = await waitForPromise(this.exited, remainingMs).catch(
      () => {
        throw new Error(
          `ACP child pid=${rootPid} did not exit within ${EXIT_DEADLINE_MS}ms` + (treeKillError ? `; ${treeKillError.message}` : "")
        );
      }
    );
    this.release();
    if (treeKillError) {
      throw new Error(
        `ACP child pid=${rootPid} process-tree cleanup failed: ${treeKillError.message}`
      );
    }
    this.throwForUncleanExit(exitInfo);
  }
  async mergeAsynchronousSnapshot(rootPid, initial) {
    try {
      const table = parseProcessTable(await queryProcessTable());
      if (this.rootHasExited) {
        if (initial && !this.forceKillRequested) {
          this.recordCleanupProofError(
            `ACP child pid=${rootPid} exited before its initial process-tree snapshot completed`
          );
        }
        return;
      }
      const snapshot = collectOwnership(table, rootPid);
      this.mergeSnapshot(snapshot);
      if (snapshot.truncated) {
        this.recordCleanupProofError(
          `ACP child pid=${rootPid} process-tree snapshot exceeded ${MAX_OWNED_PROCESSES} processes or depth ${MAX_OWNERSHIP_DEPTH}`
        );
      }
      if (initial && !snapshot.rootSeen) {
        this.recordCleanupProofError(
          `ACP child pid=${rootPid} was absent from the initial process-tree snapshot`
        );
      } else if (initial && !snapshot.rootIsGroupLeader) {
        this.recordCleanupProofError(
          `ACP child pid=${rootPid} was not an isolated process-group leader`
        );
      }
    } catch (error) {
      this.recordCleanupProofError(
        `ACP child pid=${rootPid} process-tree snapshot failed: ${toError(error).message}`
      );
    }
  }
  mergeSynchronousSnapshot() {
    const rootPid = this.rootPid;
    if (!rootPid || process.platform === "win32" || this.rootHasExited) return;
    try {
      const table = parseProcessTable(queryProcessTableSync());
      this.mergeSnapshot(collectOwnership(table, rootPid));
    } catch {
    }
  }
  mergeSnapshot(snapshot) {
    if (!snapshot.rootIsGroupLeader) {
      const rootPid = this.rootPid;
      if (snapshot.rootSeen && rootPid) this.knownGroups.delete(rootPid);
      return;
    }
    for (const group of snapshot.groups) this.knownGroups.add(group);
  }
  signalKnownGroups(signal) {
    const rootPid = this.rootPid;
    let rootSignalled = false;
    const groups = [...this.knownGroups].sort((left, right) => {
      if (left === rootPid) return 1;
      if (right === rootPid) return -1;
      return right - left;
    });
    for (const group of groups) {
      try {
        process.kill(-group, signal);
        if (group === rootPid) rootSignalled = true;
      } catch (error) {
        if (isErrno(error, "ESRCH")) {
          this.knownGroups.delete(group);
          continue;
        }
        this.recordCleanupProofError(
          `ACP child pid=${rootPid ?? "unknown"} could not send ${signal} to pgid=${group}: ${toError(error).message}`
        );
      }
    }
    return rootSignalled;
  }
  survivingGroups() {
    const surviving = [];
    for (const group of this.knownGroups) {
      try {
        process.kill(-group, 0);
        surviving.push(group);
      } catch (error) {
        if (isErrno(error, "ESRCH")) {
          this.knownGroups.delete(group);
          continue;
        }
        surviving.push(group);
        if (!isErrno(error, "EPERM")) {
          this.recordCleanupProofError(
            `ACP child pid=${this.rootPid ?? "unknown"} could not inspect pgid=${group}: ${toError(error).message}`
          );
        }
      }
    }
    return surviving;
  }
  recordCleanupProofError(message) {
    this.cleanupProofError ??= new Error(message);
  }
  async pruneTerminalGroups(groups, timeoutMs = PROCESS_QUERY_TIMEOUT_MS) {
    try {
      const table = parseProcessTable(await queryProcessTable(timeoutMs));
      const targets = new Set(groups);
      const terminalGroups = /* @__PURE__ */ new Set();
      const liveGroups = /* @__PURE__ */ new Set();
      for (const row of table.rowsByPid.values()) {
        if (!targets.has(row.pgid)) continue;
        if (row.terminal) terminalGroups.add(row.pgid);
        else liveGroups.add(row.pgid);
      }
      for (const group of terminalGroups) {
        if (!liveGroups.has(group)) this.knownGroups.delete(group);
      }
    } catch {
    }
  }
  releaseWhenGroupsExit() {
    if (this.released || this.releasePollTimer || this.releaseStateCheckInFlight || this.terminating && !this.terminationSettled) {
      return;
    }
    const survivingGroups = this.survivingGroups();
    if (survivingGroups.length === 0) {
      this.release();
      return;
    }
    this.releaseStateCheckInFlight = true;
    void this.pruneTerminalGroups(survivingGroups).finally(() => {
      this.releaseStateCheckInFlight = false;
      if (this.released) return;
      if (this.terminating && !this.terminationSettled) return;
      if (this.survivingGroups().length === 0) {
        this.release();
        return;
      }
      this.releasePollTimer = setTimeout(() => {
        this.releasePollTimer = void 0;
        this.releaseWhenGroupsExit();
      }, PROCESS_STATE_POLL_MS);
      this.releasePollTimer.unref();
    });
  }
  throwForUncleanExit(exitInfo) {
    if (exitInfo && (exitInfo.exitCode !== 0 || exitInfo.signalCode !== null)) {
      throw new Error(
        `ACP child pid=${this.child.pid ?? "unknown"} exited uncleanly during shutdown (code=${exitInfo.exitCode ?? "none"}, signal=${exitInfo.signalCode ?? "none"})`
      );
    }
  }
};
function parseProcessTable(stdout) {
  const rowsByPid = /* @__PURE__ */ new Map();
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s+(\S+)(?:\s+(\d+))?)?$/u);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const pgid = Number.parseInt(match[3], 10);
    const state = match[4];
    const threadCount = match[5] ? Number.parseInt(match[5], 10) : void 0;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || pid <= 0 || ppid < 0 || pgid <= 0) {
      continue;
    }
    const terminal = state?.startsWith("X") === true || state?.startsWith("Z") === true && (process.platform !== "linux" || threadCount === 1);
    rowsByPid.set(pid, { pgid, terminal });
    const children = childrenByParent.get(ppid);
    if (children) children.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }
  if (rowsByPid.size === 0) {
    throw new Error("process-table query returned no parseable rows");
  }
  return { childrenByParent, rowsByPid };
}
__name(parseProcessTable, "parseProcessTable");
function collectOwnership(table, rootPid) {
  const groups = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const queue = [{ depth: 0, pid: rootPid }];
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.pid)) continue;
    if (visited.size >= MAX_OWNED_PROCESSES) {
      truncated = true;
      break;
    }
    visited.add(current.pid);
    const row = table.rowsByPid.get(current.pid);
    if (row) groups.add(row.pgid);
    const children = table.childrenByParent.get(current.pid) ?? [];
    if (current.depth >= MAX_OWNERSHIP_DEPTH) {
      if (children.length > 0) truncated = true;
      continue;
    }
    for (const pid of children) {
      queue.push({ depth: current.depth + 1, pid });
    }
  }
  const root = table.rowsByPid.get(rootPid);
  return {
    groups,
    rootIsGroupLeader: root?.pgid === rootPid,
    rootSeen: root !== void 0,
    truncated
  };
}
__name(collectOwnership, "collectOwnership");
function queryProcessTable(timeoutMs = PROCESS_QUERY_TIMEOUT_MS) {
  let timer;
  const query = new Promise((resolve, reject) => {
    const child = execFile(
      POSIX_PS,
      posixPsArgs(),
      { ...STRING_EXEC_OPTIONS, timeout: 0 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
    timer = setTimeout(
      () => {
        try {
          child.kill("SIGTERM");
        } catch (error) {
          reject(error);
        }
      },
      Math.max(1, Math.min(PROCESS_QUERY_TIMEOUT_MS, timeoutMs))
    );
  });
  return query.finally(() => {
    if (timer) clearTimeout(timer);
  });
}
__name(queryProcessTable, "queryProcessTable");
function queryProcessTableSync() {
  const result = spawnSync(POSIX_PS, posixPsArgs(), STRING_EXEC_OPTIONS);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ps exited with status ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}
__name(queryProcessTableSync, "queryProcessTableSync");
function posixPsArgs() {
  const columns = process.platform === "linux" ? "pid=,ppid=,pgid=,state=,nlwp=" : "pid=,ppid=,pgid=,state=";
  return ["-A", "-o", columns];
}
__name(posixPsArgs, "posixPsArgs");
function taskkill(rootPid) {
  return runExecFile(
    WINDOWS_TASKKILL,
    ["/f", "/t", "/pid", String(rootPid)],
    STRING_EXEC_OPTIONS
  );
}
__name(taskkill, "taskkill");
function taskkillSync(rootPid) {
  try {
    const result = spawnSync(
      WINDOWS_TASKKILL,
      ["/f", "/t", "/pid", String(rootPid)],
      STRING_EXEC_OPTIONS
    );
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}
__name(taskkillSync, "taskkillSync");
function runExecFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
__name(runExecFile, "runExecFile");
function waitForPromise(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
__name(waitForPromise, "waitForPromise");
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
__name(delay, "delay");
function isErrno(error, code) {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
__name(isErrno, "isErrno");
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
__name(toError, "toError");

// packages/acp-bridge/src/json-string-bytes.ts
init_esbuild_shims();
function estimateJsonStringBytes(value, limitBytes) {
  const unescapedBytes = Buffer.byteLength(value, "utf8") + 2;
  if (unescapedBytes > limitBytes) return limitBytes + 1;
  if (!/["\\]|[^ -\ud7ff\ue000-\uffff]/u.test(value)) {
    return unescapedBytes;
  }
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) {
      bytes += 2;
    } else if (code <= 31) {
      bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    } else if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (code >= 56320 && code <= 57343) {
      bytes += 6;
    } else if (code <= 127) {
      bytes++;
    } else if (code <= 2047) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > limitBytes) return limitBytes + 1;
  }
  return bytes;
}
__name(estimateJsonStringBytes, "estimateJsonStringBytes");

// packages/acp-bridge/src/spawnChannel.ts
var cachedMemoryArgs;
var DAEMON_ACP_NDJSON_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024 * 1024,
  maxQueuedMessages: 256,
  maxQueuedBytes: 64 * 1024 * 1024
});
var daemonClientParamValidators = /* @__PURE__ */ new Map([
  [CLIENT_METHODS.fs_read_text_file, zReadTextFileRequest],
  [CLIENT_METHODS.fs_write_text_file, zWriteTextFileRequest],
  [CLIENT_METHODS.session_request_permission, zRequestPermissionRequest],
  [CLIENT_METHODS.session_update, zSessionNotification],
  [CLIENT_METHODS.terminal_create, zCreateTerminalRequest],
  [CLIENT_METHODS.terminal_kill, zKillTerminalCommandRequest],
  [CLIENT_METHODS.terminal_output, zTerminalOutputRequest],
  [CLIENT_METHODS.terminal_release, zReleaseTerminalRequest],
  [CLIENT_METHODS.terminal_wait_for_exit, zWaitForTerminalExitRequest]
]);
function validateDaemonInboundMessage(message) {
  if (!("method" in message)) return true;
  const validator = daemonClientParamValidators.get(message.method);
  return !validator || validator.safeParse(message.params).success;
}
__name(validateDaemonInboundMessage, "validateDaemonInboundMessage");
var PreparedResponseBudget = class {
  constructor(limits) {
    this.limits = limits;
  }
  static {
    __name(this, "PreparedResponseBudget");
  }
  objectCharges = /* @__PURE__ */ new WeakMap();
  primitiveCharges = /* @__PURE__ */ new Map();
  retainedCount = 0;
  retainedBytes = 0;
  closed = false;
  reserve(value) {
    if (this.closed) return;
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes
    );
    const envelopeBytes = Math.min(2048, this.limits.maxQueuedBytes);
    const charge = envelopeBytes + estimatePreparedResponseBytes(
      value,
      Math.max(0, availableBytes - envelopeBytes)
    );
    if (this.retainedCount >= this.limits.maxQueuedMessages || charge > availableBytes) {
      throw new NdJsonQueueLimitError(
        "prepared_response",
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        charge,
        availableBytes
      );
    }
    const charges = this.getCharges(value, true);
    charges.push(charge);
    this.retainedCount++;
    this.retainedBytes += charge;
  }
  releaseMessage(message) {
    if (!isPlainRecord(message) || Object.hasOwn(message, "method") || !Object.hasOwn(message, "id")) {
      return;
    }
    const value = Object.hasOwn(message, "result") ? message["result"] : message["error"];
    const charges = this.getCharges(value, false);
    if (!charges) return;
    const charge = charges.shift();
    if (charge === void 0) return;
    if (charges.length === 0 && !isObjectValue(value)) {
      this.primitiveCharges.delete(value);
    }
    this.retainedCount--;
    this.retainedBytes -= charge;
  }
  close() {
    this.closed = true;
    this.objectCharges = /* @__PURE__ */ new WeakMap();
    this.primitiveCharges.clear();
    this.retainedCount = 0;
    this.retainedBytes = 0;
  }
  getCharges(value, create) {
    const charges = isObjectValue(value) ? this.objectCharges.get(value) : this.primitiveCharges.get(value);
    if (charges || !create) return charges;
    const created = [];
    if (isObjectValue(value)) {
      this.objectCharges.set(value, created);
    } else {
      this.primitiveCharges.set(value, created);
    }
    return created;
  }
};
var OutboundOperationBudget = class {
  constructor(limits) {
    this.limits = limits;
  }
  static {
    __name(this, "OutboundOperationBudget");
  }
  retainedCount = 0;
  retainedBytes = 0;
  generation = 0;
  closed = false;
  reserve(value) {
    if (this.closed) return () => {
    };
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes
    );
    const envelopeBytes = Math.min(2048, this.limits.maxQueuedBytes);
    const charge = envelopeBytes + estimatePreparedResponseBytes(
      value,
      Math.max(0, availableBytes - envelopeBytes)
    );
    if (this.retainedCount >= this.limits.maxQueuedMessages || charge > availableBytes) {
      throw new NdJsonQueueLimitError(
        "outbound_operation",
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        charge,
        availableBytes
      );
    }
    this.retainedCount++;
    this.retainedBytes += charge;
    const generation = this.generation;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.closed || this.generation !== generation) return;
      this.retainedCount--;
      this.retainedBytes -= charge;
    };
  }
  close() {
    this.closed = true;
    this.generation++;
    this.retainedCount = 0;
    this.retainedBytes = 0;
  }
};
function* enumerableOwnKeys(value) {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield key;
  }
}
__name(enumerableOwnKeys, "enumerableOwnKeys");
function estimatePreparedResponseBytes(value, limitBytes) {
  let bytes = 0;
  const stack = [{ kind: "value", value }];
  const seen = /* @__PURE__ */ new WeakSet();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) continue;
      if (frame.index > 0) bytes++;
      if (bytes > limitBytes) return limitBytes + 1;
      const descriptor = Object.getOwnPropertyDescriptor(
        frame.value,
        String(frame.index)
      );
      if (descriptor?.get || descriptor?.set) return limitBytes + 1;
      stack.push({ ...frame, index: frame.index + 1 });
      stack.push({ kind: "value", value: descriptor?.value });
      continue;
    }
    if (frame.kind === "record") {
      const next = frame.keys.next();
      if (next.done) continue;
      const descriptor = Object.getOwnPropertyDescriptor(
        frame.value,
        next.value
      );
      if (!descriptor || descriptor.get || descriptor.set) {
        return limitBytes + 1;
      }
      bytes += (frame.first ? 0 : 1) + estimateJsonStringBytes(next.value, Math.max(0, limitBytes - bytes)) + 1;
      if (bytes > limitBytes) return limitBytes + 1;
      stack.push({ ...frame, first: false });
      stack.push({ kind: "value", value: descriptor.value });
      continue;
    }
    const current = frame.value;
    if (current === null) {
      bytes += 4;
    } else if (current === void 0) {
      bytes += 4;
    } else if (typeof current === "string") {
      bytes += estimateJsonStringBytes(
        current,
        Math.max(0, limitBytes - bytes)
      );
    } else if (typeof current === "number") {
      bytes += 24;
    } else if (typeof current === "boolean") {
      bytes += 5;
    } else if (Array.isArray(current)) {
      if (seen.has(current) || Object.hasOwn(current, "toJSON")) {
        return limitBytes + 1;
      }
      seen.add(current);
      bytes += 2;
      stack.push({ kind: "array", value: current, index: 0 });
    } else if (isPlainRecord(current)) {
      if (seen.has(current) || Object.hasOwn(current, "toJSON")) {
        return limitBytes + 1;
      }
      seen.add(current);
      bytes += 2;
      stack.push({
        kind: "record",
        value: current,
        keys: enumerableOwnKeys(current),
        first: true
      });
    } else {
      return limitBytes + 1;
    }
    if (bytes > limitBytes) return limitBytes + 1;
  }
  return Math.max(1, bytes);
}
__name(estimatePreparedResponseBytes, "estimatePreparedResponseBytes");
function isObjectValue(value) {
  return typeof value === "object" && value !== null;
}
__name(isObjectValue, "isObjectValue");
function isPlainRecord(value) {
  if (!isObjectValue(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
__name(isPlainRecord, "isPlainRecord");
function getAcpMemoryArgs() {
  if (cachedMemoryArgs) return cachedMemoryArgs;
  const { memoryMb } = detectAvailableMemoryMb();
  const targetMB = Math.min(Math.floor(memoryMb * 0.5), 16384);
  const currentLimitMB = Math.floor(
    getHeapStatistics().heap_size_limit / (1024 * 1024)
  );
  cachedMemoryArgs = [
    ...targetMB > currentLimitMB ? [`--max-old-space-size=${targetMB}`] : [],
    "--expose-gc"
  ];
  return cachedMemoryArgs;
}
__name(getAcpMemoryArgs, "getAcpMemoryArgs");
function createStderrForwarder(opts) {
  const { prefix, onDiagnosticLine } = opts;
  const STDERR_LINE_CAP_CHARS = 64 * 1024;
  let buf = "";
  const flush = /* @__PURE__ */ __name((line) => {
    if (line.length > 0) {
      const safe = redactLogCredentials(line);
      process.stderr.write(prefix + safe + "\n");
      if (onDiagnosticLine) onDiagnosticLine(prefix + safe, "warn");
    }
  }, "flush");
  return {
    onData(chunk) {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        flush(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      while (buf.length > STDERR_LINE_CAP_CHARS) {
        const truncated = redactLogCredentials(buf.slice(0, STDERR_LINE_CAP_CHARS)) + " [truncated]";
        process.stderr.write(prefix + truncated + "\n");
        if (onDiagnosticLine) onDiagnosticLine(prefix + truncated, "warn");
        buf = buf.slice(STDERR_LINE_CAP_CHARS);
      }
    },
    onEnd() {
      if (buf.length > 0) flush(buf);
    }
  };
}
__name(createStderrForwarder, "createStderrForwarder");
function createSpawnChannelFactory(options = {}) {
  if (options.pipeLimits) validateNdJsonStreamLimits(options.pipeLimits);
  if (!options.processRegistry && options.childHeapPolicy?.snapshot().mode === "admit") {
    throw new TypeError(
      "ACP admission requires an explicit shared process registry."
    );
  }
  const processRegistry = options.processRegistry ?? new ProcessRegistry();
  const factory = /* @__PURE__ */ __name(async (workspaceCwd, childEnvOverrides, signal, startup) => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("ACP channel spawn was aborted");
    }
    const sourceEnv = options.sourceEnv ?? process.env;
    const cliEntry = sourceEnv["QWEN_CLI_ENTRY"] || process.argv[1];
    if (!cliEntry) {
      throw new MissingCliEntryError();
    }
    const childEnv = scrubChildEnv(
      sourceEnv,
      SCRUBBED_CHILD_ENV_KEYS,
      childEnvOverrides
    );
    childEnv["QWEN_CODE_NO_RELAUNCH"] = "true";
    childEnv["QWEN_CODE_SERVE"] = "1";
    const execArgs = process.execArgv.filter(
      (a) => !/^--inspect(-brk)?($|=)/.test(a)
    );
    let reservation = processRegistry.reserve();
    let child;
    try {
      let decision = options.childHeapPolicy?.decide(
        processRegistry.committedProcessCount
      );
      if (decision?.refuse && options.childHeapPolicy?.snapshot().mode === "admit" && options.reclaimIdleChild) {
        reservation.cancel();
        if (startup) {
          startup.getTimeoutError = () => new AcpChildCapacityExceededError(
            options.childHeapPolicy.snapshot().maxConcurrentChildren,
            processRegistry.committedProcessCount
          );
        }
        try {
          await options.reclaimIdleChild(signal);
        } catch (error) {
          options.onDiagnosticLine?.(
            `Idle ACP reclamation failed: ${String(error)}`,
            "warn"
          );
        } finally {
          if (startup) delete startup.getTimeoutError;
        }
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("ACP channel spawn was aborted");
        }
        const limit = options.childHeapPolicy.snapshot().maxConcurrentChildren;
        if (processRegistry.committedProcessCount >= limit) {
          throw new AcpChildCapacityExceededError(
            limit,
            processRegistry.committedProcessCount
          );
        }
        reservation = processRegistry.reserve();
        decision = options.childHeapPolicy.decide(
          processRegistry.committedProcessCount
        );
      }
      if (decision?.refuse) {
        const policy = options.childHeapPolicy.snapshot();
        if (policy.mode === "admit") {
          throw new AcpChildCapacityExceededError(
            policy.maxConcurrentChildren,
            processRegistry.committedProcessCount - 1
          );
        }
      }
      const memoryArgs = getAcpMemoryArgs();
      child = spawn(
        process.execPath,
        [
          ...execArgs,
          ...memoryArgs,
          cliEntry,
          "--acp",
          ...options.extraArgs ?? []
        ],
        {
          cwd: workspaceCwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
          env: childEnv
        }
      );
    } catch (error) {
      reservation.cancel();
      throw error;
    }
    const trackedChild = reservation.attach(child, { ownsProcessTree: true });
    const abortSpawn = /* @__PURE__ */ __name(() => {
      try {
        trackedChild.killSync();
      } catch {
      }
    }, "abortSpawn");
    signal?.addEventListener("abort", abortSpawn, { once: true });
    void trackedChild.exited.then(
      () => signal?.removeEventListener("abort", abortSpawn),
      () => signal?.removeEventListener("abort", abortSpawn)
    );
    if (signal?.aborted) {
      abortSpawn();
      throw signal.reason instanceof Error ? signal.reason : new Error("ACP channel spawn was aborted");
    }
    if (child.stderr) {
      const prefix = `[serve pid=${child.pid} cwd=${workspaceCwd}] `;
      const forwarder = createStderrForwarder({
        prefix,
        onDiagnosticLine: options.onDiagnosticLine
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", forwarder.onData);
      child.stderr.on("end", forwarder.onEnd);
      child.stderr.on("error", () => {
      });
    }
    if (!child.stdin || !child.stdout) {
      trackedChild.killSync();
      throw new Error(
        "Spawned ACP child has no stdin/stdout \u2014 cannot establish NDJSON channel."
      );
    }
    const writable = Writable.toWeb(child.stdin);
    const readable = Readable.toWeb(child.stdout);
    const preparedResponses = options.pipeLimits ? new PreparedResponseBudget(options.pipeLimits) : void 0;
    const outboundOperations = options.pipeLimits ? new OutboundOperationBudget(options.pipeLimits) : void 0;
    let reportTransportFailure;
    let transportFailureReported = false;
    const transportFailed = options.pipeLimits ? new Promise((resolve) => {
      reportTransportFailure = resolve;
    }) : void 0;
    const failTransport = options.pipeLimits ? (error) => {
      if (transportFailureReported) return;
      transportFailureReported = true;
      reportTransportFailure?.(error);
      reportTransportFailure = void 0;
      preparedResponses?.close();
      outboundOperations?.close();
      child.stdout?.destroy();
      child.stdin?.destroy();
      void trackedChild.terminate().catch(() => {
      });
      options.pipeHooks?.onTransportError?.(error);
    } : void 0;
    const pipeHooks = options.pipeLimits ? {
      ...options.pipeHooks,
      onMessageObserved: /* @__PURE__ */ __name((observation) => {
        if (observation.direction === "sent") {
          preparedResponses?.releaseMessage(observation.message);
        }
        options.pipeHooks?.onMessageObserved?.(observation);
      }, "onMessageObserved"),
      onTransportError: failTransport
    } : options.pipeHooks;
    const stream = ndJsonStream(
      writable,
      readable,
      pipeHooks,
      options.pipeLimits,
      options.pipeLimits ? validateDaemonInboundMessage : void 0,
      options.pipeLimits !== void 0
    );
    return {
      stream,
      ...transportFailed ? { transportFailed } : {},
      ...failTransport && options.pipeLimits ? {
        transportGuard: {
          maxActiveHandlers: options.pipeLimits.maxQueuedMessages,
          maxActiveHandlerBytes: options.pipeLimits.maxQueuedBytes,
          reserveOutboundOperation: /* @__PURE__ */ __name((value) => {
            try {
              return outboundOperations?.reserve(value) ?? (() => {
              });
            } catch (error) {
              failTransport(error);
              throw error;
            }
          }, "reserveOutboundOperation"),
          reservePreparedResponse: /* @__PURE__ */ __name((value) => {
            try {
              preparedResponses?.reserve(value);
            } catch (error) {
              failTransport(error);
              throw error;
            }
          }, "reservePreparedResponse"),
          fail: failTransport
        }
      } : {},
      kill: /* @__PURE__ */ __name(() => trackedChild.terminate(), "kill"),
      killSync: /* @__PURE__ */ __name(() => trackedChild.killSync(), "killSync"),
      exited: trackedChild.exited
    };
  }, "factory");
  markChannelFactoryForwardsChildEnv(factory);
  return factory;
}
__name(createSpawnChannelFactory, "createSpawnChannelFactory");
var defaultSpawnChannelFactory = createSpawnChannelFactory();
var SCRUBBED_CHILD_ENV_KEYS = /* @__PURE__ */ new Set([
  "QWEN_SERVER_TOKEN",
  "QWEN_CODE_SIMPLE",
  EXTERNAL_TOOL_GUARD_TOKEN_ENV
]);
function scrubChildEnv(source, scrubbed, overrides) {
  const childEnv = { ...source };
  for (const key of scrubbed) {
    delete childEnv[key];
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (scrubbed.has(key)) continue;
      if (value === void 0) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }
  }
  return childEnv;
}
__name(scrubChildEnv, "scrubChildEnv");

export {
  channelFactoryForwardsChildEnv,
  ndJsonStream,
  DAEMON_ACP_NDJSON_LIMITS,
  getAcpMemoryArgs,
  createStderrForwarder,
  createSpawnChannelFactory,
  defaultSpawnChannelFactory,
  scrubChildEnv
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
