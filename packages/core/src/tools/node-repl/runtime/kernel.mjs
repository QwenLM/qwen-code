/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import fs from 'node:fs';
import process from 'node:process';
import v8 from 'node:v8';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';
import {
  setTimeout as hostSetTimeout,
  setInterval as hostSetInterval,
  clearTimeout as hostClearTimeout,
  clearInterval as hostClearInterval,
} from 'node:timers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createModuleLoader } from './module-loader.mjs';

const protocolOutput = fs.createWriteStream(null, { fd: 3 });
const protocolInput = fs.createReadStream(null, { fd: 4 });
const asyncContext = new AsyncLocalStorage();

const MAX_TEXT_EVENT_CHARS = 8 * 1024 * 1024;
const MAX_RAW_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_RAW_TEXT_EVENTS = 128 * 1024;
const MAX_ERROR_CHARS = 256 * 1024;
const MAX_RESPONSE_META_CHARS = 512 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_PERCENT_ENCODED_IMAGE_CHARS = MAX_IMAGE_BYTES * 3;
const MAX_RAW_IMAGES = 64;
const MAX_RAW_IMAGE_CHARS = 128 * 1024 * 1024;
const MAX_REQUEST_META_ENTRIES = 1024;
const MAX_PENDING_CAPABILITIES = 4096;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
).get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
).get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
).get;

let config = null;
let generation = 0;
let capabilityToken = '';
let untrustedContext = null;
let trustedContext = null;
let untrustedControls = null;
let loader = null;
let bindings = new Map();
let activeExec = null;
let operationChain = Promise.resolve();
let shuttingDown = false;

const requestMetadata = new Map();
const pendingCapabilities = new Map();
const timers = new Map();
let nextTimerId = 1;

function send(frame) {
  if (shuttingDown && frame.type !== 'fatal') return;
  try {
    protocolOutput.write(`${JSON.stringify(frame)}\n`);
  } catch {
    process.exit(0);
  }
}

function capText(value, limit = MAX_TEXT_EVENT_CHARS) {
  const text = String(value);
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n… [node_repl event truncated ${text.length - limit} characters]`
  );
}

function currentExecId() {
  const store = asyncContext.getStore();
  return store && typeof store.execId === 'string' ? store.execId : null;
}

function rememberRequestMeta(execId, metadata) {
  requestMetadata.set(execId, { ...metadata });
  while (requestMetadata.size > MAX_REQUEST_META_ENTRIES) {
    const oldest = requestMetadata.keys().next().value;
    requestMetadata.delete(oldest);
  }
}

function describeThrown(error) {
  if (error && typeof error === 'object') {
    let name = 'Error';
    let message = '';
    let stack;
    try {
      if (typeof error.name === 'string') name = error.name;
    } catch {
      // Keep the default name.
    }
    try {
      message =
        typeof error.message === 'string' ? error.message : String(error);
    } catch {
      message = '[unreadable thrown value]';
    }
    try {
      if (typeof error.stack === 'string') stack = error.stack;
    } catch {
      // Stack is optional.
    }
    return {
      name: capText(name, 1024),
      message: capText(message, MAX_ERROR_CHARS),
      stack: stack ? capText(stack, MAX_ERROR_CHARS) : undefined,
    };
  }
  return {
    name: 'Error',
    message: capText(
      `Thrown non-Error value: ${String(error)}`,
      MAX_ERROR_CHARS,
    ),
  };
}

function emitText(kind, level, text) {
  const execId = currentExecId();
  if (!activeExec || activeExec.execId !== execId) return;
  if (
    activeExec.textEventCount >= MAX_RAW_TEXT_EVENTS ||
    activeExec.rawTextBytes >= MAX_RAW_TEXT_BYTES
  ) {
    activeExec.rawTextTruncated = true;
    return;
  }
  const original = String(text);
  let kept = capText(original);
  if (original.length > MAX_TEXT_EVENT_CHARS) {
    activeExec.rawTextTruncated = true;
  }
  const remaining = MAX_RAW_TEXT_BYTES - activeExec.rawTextBytes;
  const bytes = Buffer.byteLength(kept, 'utf8');
  if (bytes > remaining) {
    kept = new StringDecoder('utf8').write(
      Buffer.from(kept, 'utf8').subarray(0, remaining),
    );
    activeExec.rawTextTruncated = true;
  }
  activeExec.textEventCount += 1;
  activeExec.rawTextBytes += Buffer.byteLength(kept, 'utf8');
  send({
    type: 'output',
    execId,
    kind,
    ...(level ? { level } : {}),
    text: kept,
  });
}

function isUnder(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function sameCanonicalPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function resolveReadableFile(filePath) {
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  const allowed = config.readableRoots.some((root) => {
    try {
      const currentRoot = fs.realpathSync(root);
      return sameCanonicalPath(root, currentRoot) && isUnder(real, currentRoot);
    } catch {
      return false;
    }
  });
  return allowed ? real : null;
}

function sniffImageMime(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function resolveImagePayload(payload) {
  let buffer;
  let declaredMime = null;
  if (payload && payload.kind === 'bytes') {
    const bytes = payload.bytes;
    if (!utilTypes.isUint8Array(bytes)) {
      throw new Error('emitImage bytes must be a Uint8Array');
    }
    const arrayBuffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, bytes, []);
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, bytes, []);
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, bytes, []);
    buffer = Buffer.from(arrayBuffer, byteOffset, byteLength);
    declaredMime =
      typeof payload.mimeType === 'string' ? payload.mimeType : null;
  } else if (payload && payload.kind === 'url') {
    const value = String(payload.url);
    if (value.startsWith('data:')) {
      if (value.length > MAX_PERCENT_ENCODED_IMAGE_CHARS + 128) {
        throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
      }
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value);
      if (!match) throw new Error('malformed data URL');
      if (match[2] && match[3].length > MAX_BASE64_IMAGE_CHARS) {
        throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
      }
      declaredMime = match[1].toLowerCase();
      buffer = match[2]
        ? Buffer.from(match[3], 'base64')
        : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    } else if (value.startsWith('file:')) {
      let filePath;
      try {
        filePath = fileURLToPath(new URL(value));
      } catch {
        throw new Error('malformed file URL');
      }
      const readableFile = resolveReadableFile(filePath);
      if (!readableFile) {
        throw new Error(
          'emitImage file URLs are restricted to the workspace and session temp directory',
        );
      }
      const stat = fs.statSync(readableFile);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `image exceeds ${MAX_IMAGE_BYTES} bytes or is not a file`,
        );
      }
      buffer = fs.readFileSync(readableFile);
    } else {
      throw new Error('emitImage URL must use the data: or file: scheme');
    }
  } else {
    throw new Error('unsupported emitImage payload');
  }

  if (buffer.length === 0) throw new Error('emitImage received empty bytes');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) throw new Error('emitImage supports PNG, JPEG, and WebP only');
  if (declaredMime) {
    if (!IMAGE_MIME_TYPES.has(declaredMime)) {
      throw new Error(`unsupported declared image MIME: ${declaredMime}`);
    }
    if (declaredMime !== sniffed) {
      throw new Error(
        `image bytes are ${sniffed} but the payload declares ${declaredMime}`,
      );
    }
  }
  return { data: buffer.toString('base64'), mimeType: sniffed };
}

function rejectCapabilitiesForExec(execId, message) {
  for (const [requestId, pending] of pendingCapabilities) {
    if (pending.execId !== execId) continue;
    pendingCapabilities.delete(requestId);
    pending.reject(new Error(message));
  }
}

function rejectAllCapabilities(message) {
  for (const pending of pendingCapabilities.values()) {
    pending.reject(new Error(message));
  }
  pendingCapabilities.clear();
}

function callHostCapability(operation, argsJson) {
  const execId = currentExecId();
  if (!execId || !activeExec || activeExec.execId !== execId) {
    return Promise.reject(
      new Error('host capabilities require a live node_repl execution'),
    );
  }
  if (pendingCapabilities.size >= MAX_PENDING_CAPABILITIES) {
    return Promise.reject(
      new Error('too many concurrent host capability requests'),
    );
  }
  const capabilityRequestId = randomUUID();
  return new Promise((resolve, reject) => {
    pendingCapabilities.set(capabilityRequestId, { execId, resolve, reject });
    send({
      type: 'capabilityRequest',
      capabilityToken,
      generation,
      execId,
      capabilityRequestId,
      operation: String(operation),
      argsJson: String(argsJson),
    });
  });
}

function scheduleTimer(callback, delay, repeat) {
  const execId = currentExecId();
  const timerId = nextTimerId++;
  const numericDelay =
    typeof delay === 'number' && Number.isFinite(delay) ? delay : 0;
  const safeDelay = Math.max(0, Math.min(numericDelay, 2 ** 31 - 1));
  const invoke = () => {
    if (!repeat) timers.delete(timerId);
    asyncContext.run({ execId }, () => {
      try {
        callback();
      } catch (error) {
        emitText('console', 'error', describeThrown(error).message);
      }
    });
  };
  const handle = repeat
    ? hostSetInterval(invoke, safeDelay)
    : hostSetTimeout(invoke, safeDelay);
  timers.set(timerId, { handle, repeat });
  return timerId;
}

function cancelTimer(timerId) {
  if (typeof timerId !== 'number' || !Number.isSafeInteger(timerId)) return;
  const record = timers.get(timerId);
  if (!record) return;
  timers.delete(timerId);
  if (record.repeat) hostClearInterval(record.handle);
  else hostClearTimeout(record.handle);
}

function clearAllTimers() {
  for (const [timerId] of timers) cancelTimer(timerId);
}

function heapStatus() {
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return {
    pid: process.pid,
    generation,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    heapLimitBytes: heap.heap_size_limit,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

const BOOTSTRAP_SOURCE = String.raw`
'use strict';

const intrinsicObject = Object;
const intrinsicArrayBuffer = ArrayBuffer;
const intrinsicError = Error;
const intrinsicUint8Array = Uint8Array;
const intrinsicWeakSet = WeakSet;
const intrinsicString = String;
const intrinsicNumber = Number;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectDefineProperties = Object.defineProperties;
const intrinsicArrayBufferIsView = ArrayBuffer.isView;
const intrinsicJSONStringify = JSON.stringify;
const intrinsicJSONParse = JSON.parse;
const intrinsicReflectApply = Reflect.apply;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const intrinsicWeakSetAdd = WeakSet.prototype.add;

function bridgeError(error) {
  let message = 'host bridge failed';
  try {
    message = intrinsicString(error && error.message ? error.message : error);
  } catch {}
  return new intrinsicError(message);
}

function deepFreeze(value, seen) {
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    if (!seen) seen = new intrinsicWeakSet();
    if (intrinsicReflectApply(intrinsicWeakSetHas, seen, [value])) return value;
    intrinsicReflectApply(intrinsicWeakSetAdd, seen, [value]);
    const keys = intrinsicObjectGetOwnPropertyNames(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
    }
    intrinsicObjectFreeze(value);
  }
  return value;
}

function serializeOne(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return intrinsicString(value) + 'n';
  if (typeof value === 'function') {
    let name = 'anonymous';
    try {
      if (typeof value.name === 'string' && value.name) name = value.name;
    } catch {}
    return '[function ' + name + ']';
  }
  if (typeof value === 'symbol') return intrinsicString(value);
  if (value === undefined) return 'undefined';
  try {
    if (value instanceof intrinsicError) {
      let name = 'Error';
      let message = '';
      try { if (typeof value.name === 'string' && value.name) name = value.name; } catch {}
      try { message = intrinsicString(value.message); } catch { message = '[unreadable]'; }
      return name + ': ' + message;
    }
  } catch {}
  const seen = new intrinsicWeakSet();
  try {
    const json = intrinsicJSONStringify(value, function (_key, item) {
      if (typeof item === 'bigint') return intrinsicString(item) + 'n';
      if (typeof item === 'function') {
        return '[function ' + (item.name || 'anonymous') + ']';
      }
      if (typeof item === 'symbol') return intrinsicString(item);
      if (item instanceof intrinsicError) {
        return { name: item.name, message: item.message };
      }
      if (item && typeof item === 'object') {
        if (intrinsicReflectApply(intrinsicWeakSetHas, seen, [item])) return '[Circular]';
        intrinsicReflectApply(intrinsicWeakSetAdd, seen, [item]);
      }
      return item;
    });
    return json === undefined ? intrinsicString(value) : json;
  } catch (error) {
    let message = 'unknown serialization error';
    try { message = intrinsicString(error && error.message ? error.message : error); } catch {}
    return '[Unserializable: ' + message + ']';
  }
}

function serializeArgs(args) {
  let serialized = '';
  for (let index = 0; index < args.length; index++) {
    if (index > 0) serialized += ' ';
    serialized += serializeOne(args[index]);
  }
  return serialized;
}

function parseFrozenRecord(json) {
  const value = intrinsicJSONParse(json);
  if (!value || typeof value !== 'object' || intrinsicArrayBufferIsView(value)) {
    throw new intrinsicError('host bridge returned invalid metadata');
  }
  return deepFreeze(value);
}

const runtime = {
  cwd: intrinsicString(metadata.cwd),
  homeDir: intrinsicString(metadata.homeDir),
  tmpDir: intrinsicString(metadata.tmpDir),
  get requestMeta() {
    try {
      return parseFrozenRecord(bridge.requestMeta());
    } catch (error) {
      throw bridgeError(error);
    }
  },
  write(value) {
    try {
      bridge.emitText('write', null, serializeOne(value));
    } catch (error) {
      throw bridgeError(error);
    }
  },
  async emitImage(image) {
    let payload;
    if (typeof image === 'string') {
      payload = { kind: 'url', url: image };
    } else if (intrinsicArrayBufferIsView(image)) {
      payload = { kind: 'bytes', bytes: image, mimeType: null };
    } else if (image instanceof intrinsicArrayBuffer) {
      payload = {
        kind: 'bytes',
        bytes: new intrinsicUint8Array(image),
        mimeType: null,
      };
    } else if (image && typeof image === 'object' && 'bytes' in image) {
      const bytes = image.bytes;
      payload = {
        kind: 'bytes',
        bytes: intrinsicArrayBufferIsView(bytes)
          ? bytes
          : new intrinsicUint8Array(bytes),
        mimeType: typeof image.mimeType === 'string' ? image.mimeType : null,
      };
    } else {
      throw new TypeError('unsupported emitImage input');
    }
    try {
      await bridge.emitImage(payload);
    } catch (error) {
      throw bridgeError(error);
    }
  },
  setResponseMeta(value) {
    if (!value || typeof value !== 'object' || intrinsicArrayBufferIsView(value)) {
      throw new TypeError('response metadata must be a plain object');
    }
    const prototype = intrinsicObjectGetPrototypeOf(value);
    if (prototype !== intrinsicObjectPrototype && prototype !== null) {
      throw new TypeError('response metadata must be a plain object');
    }
    try {
      bridge.setResponseMeta(intrinsicJSONStringify(value));
    } catch (error) {
      throw bridgeError(error);
    }
  },
  getHeapStatus() {
    let raw;
    try {
      raw = intrinsicJSONParse(bridge.heapStatus());
    } catch (error) {
      throw bridgeError(error);
    }
    return deepFreeze({
      pid: intrinsicNumber(raw.pid),
      generation: intrinsicNumber(raw.generation),
      rssBytes: intrinsicNumber(raw.rssBytes),
      heapUsedBytes: intrinsicNumber(raw.heapUsedBytes),
      heapTotalBytes: intrinsicNumber(raw.heapTotalBytes),
      heapLimitBytes: intrinsicNumber(raw.heapLimitBytes),
      externalBytes: intrinsicNumber(raw.externalBytes),
      arrayBuffersBytes: intrinsicNumber(raw.arrayBuffersBytes),
    });
  },
};

if (privileged) {
  intrinsicObjectDefineProperty(runtime, 'callHost', {
    enumerable: false,
    value: async function callHost(operation, args) {
      if (typeof operation !== 'string' || operation.length === 0) {
        throw new TypeError('host capability operation must be a non-empty string');
      }
      const argsJson = intrinsicJSONStringify(args === undefined ? null : args);
      let resultJson;
      try {
        resultJson = await bridge.callHost(operation, argsJson);
      } catch (error) {
        throw bridgeError(error);
      }
      return intrinsicJSONParse(resultJson);
    },
  });
}

deepFreeze(runtime);

const consoleObject = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  consoleObject[level] = function (...args) {
    try {
      bridge.emitText('console', level, serializeArgs(args));
    } catch (error) {
      throw bridgeError(error);
    }
  };
}
deepFreeze(consoleObject);

function setTimeoutWrapper(callback, delay, ...args) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  try {
    return bridge.scheduleTimer(function invokeTimerCallback() {
      return intrinsicReflectApply(callback, undefined, args);
    }, intrinsicNumber(delay), false);
  } catch (error) {
    throw bridgeError(error);
  }
}
function setIntervalWrapper(callback, delay, ...args) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  try {
    return bridge.scheduleTimer(function invokeTimerCallback() {
      return intrinsicReflectApply(callback, undefined, args);
    }, intrinsicNumber(delay), true);
  } catch (error) {
    throw bridgeError(error);
  }
}
function clearTimerWrapper(timerId) {
  try {
    bridge.cancelTimer(intrinsicNumber(timerId));
  } catch (error) {
    throw bridgeError(error);
  }
}

intrinsicObjectDefineProperties(globalThis, {
  nodeRepl: { value: runtime, enumerable: true },
  console: { value: consoleObject, enumerable: true },
  setTimeout: { value: setTimeoutWrapper, enumerable: true },
  setInterval: { value: setIntervalWrapper, enumerable: true },
  clearTimeout: { value: clearTimerWrapper, enumerable: true },
  clearInterval: { value: clearTimerWrapper, enumerable: true },
});

if (privileged) {
  const processFacade = deepFreeze({
    pid: intrinsicNumber(metadata.pid),
    platform: intrinsicString(metadata.platform),
    arch: intrinsicString(metadata.arch),
    version: intrinsicString(metadata.version),
    versions: { node: intrinsicString(metadata.nodeVersion) },
    env: {},
    cwd: function cwd() { return intrinsicString(metadata.cwd); },
  });
  intrinsicObjectDefineProperty(globalThis, 'process', {
    value: processFacade,
    enumerable: true,
  });
}

return intrinsicObjectFreeze({ serialize: serializeOne });
`;

function createContext(name, privileged) {
  const context = vm.createContext(Object.create(null), {
    name,
    codeGeneration: { strings: false, wasm: false },
  });
  const bridge = Object.freeze({
    emitText,
    emitImage(payload) {
      const execId = currentExecId();
      if (!activeExec || activeExec.execId !== execId) return;
      const image = resolveImagePayload(payload);
      if (
        activeExec.imageCount >= MAX_RAW_IMAGES ||
        image.data.length > MAX_RAW_IMAGE_CHARS - activeExec.imageChars
      ) {
        activeExec.imagesDropped += 1;
        return;
      }
      activeExec.imageCount += 1;
      activeExec.imageChars += image.data.length;
      send({ type: 'image', execId, ...image });
    },
    setResponseMeta(json) {
      const execId = currentExecId();
      if (!activeExec || activeExec.execId !== execId) return;
      if (typeof json !== 'string' || json.length > MAX_RESPONSE_META_CHARS) {
        throw new Error('response metadata is too large');
      }
      const value = JSON.parse(json);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('response metadata must be an object');
      }
      const merged = Object.assign(
        Object.create(null),
        activeExec.responseMeta,
        value,
      );
      if (JSON.stringify(merged).length > MAX_RESPONSE_META_CHARS) {
        throw new Error('response metadata is too large');
      }
      activeExec.responseMeta = merged;
    },
    requestMeta() {
      return JSON.stringify(requestMetadata.get(currentExecId()) ?? {});
    },
    heapStatus() {
      return JSON.stringify(heapStatus());
    },
    scheduleTimer,
    cancelTimer,
    callHost: privileged
      ? (operation, argsJson) => callHostCapability(operation, argsJson)
      : undefined,
  });
  const bootstrap = vm.compileFunction(
    BOOTSTRAP_SOURCE,
    ['bridge', 'metadata', 'privileged'],
    { parsingContext: context, filename: '<node-repl-bootstrap>' },
  );
  const controls = bootstrap(
    bridge,
    {
      cwd: config.cwd,
      homeDir: config.homeDir,
      tmpDir: config.tmpDir,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      version: process.version,
      nodeVersion: process.versions.node,
    },
    privileged,
  );
  return { context, controls };
}

function initialize(message) {
  if (config) throw new Error('kernel was initialized twice');
  if (!Number.isInteger(message.generation) || message.generation < 1) {
    throw new Error('invalid kernel generation');
  }
  if (
    typeof message.capabilityToken !== 'string' ||
    message.capabilityToken.length < 32
  ) {
    throw new Error('invalid capability token');
  }
  generation = message.generation;
  capabilityToken = message.capabilityToken;
  config = {
    cwd: String(message.cwd),
    homeDir: String(message.homeDir),
    tmpDir: String(message.tmpDir),
    moduleRoots: [...message.moduleRoots],
    trustedPackages: [...message.trustedPackages],
    readableRoots: [...message.readableRoots],
  };
  const untrusted = createContext('qwen-node-repl-untrusted', false);
  const trusted = createContext('qwen-node-repl-trusted', true);
  untrustedContext = untrusted.context;
  trustedContext = trusted.context;
  untrustedControls = untrusted.controls;
  loader = createModuleLoader({
    untrustedContext,
    trustedContext,
    cwd: config.cwd,
    moduleRoots: config.moduleRoots,
    trustedPackages: config.trustedPackages,
    readableRoots: config.readableRoots,
    onTrustedModuleLoad(details) {
      send({
        type: 'audit',
        event: 'trustedModuleLoaded',
        generation,
        execId: currentExecId(),
        ...details,
      });
    },
  });
  send({ type: 'ready', generation, pid: process.pid });
}

function sortedBindingNames() {
  return [...bindings.keys()].sort();
}

function sameNames(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

function readPartialSnapshot(module, exportName) {
  try {
    const snapshot = module.namespace[exportName];
    if (!snapshot || typeof snapshot !== 'object') return null;
    const next = new Map();
    for (const name of Object.keys(snapshot)) next.set(name, snapshot[name]);
    return next;
  } catch {
    return null;
  }
}

function readSuccessfulBindings(module, bindingExports) {
  const next = new Map();
  for (const { bindingName, exportName } of bindingExports) {
    next.set(bindingName, module.namespace[exportName]);
  }
  return next;
}

async function handleExec(message) {
  if (!config || !loader) throw new Error('kernel is not initialized');
  if (activeExec) throw new Error('kernel received overlapping executions');
  const expected = sortedBindingNames();
  if (!sameNames(message.previousBindingNames, expected)) {
    throw new Error('host and kernel binding snapshots are out of sync');
  }

  activeExec = {
    execId: message.execId,
    responseMeta: Object.create(null),
    rawTextBytes: 0,
    textEventCount: 0,
    rawTextTruncated: false,
    imageCount: 0,
    imageChars: 0,
    imagesDropped: 0,
  };
  rememberRequestMeta(message.execId, message.requestMeta ?? {});
  let cellModule = null;
  try {
    await asyncContext.run({ execId: message.execId }, async () => {
      const cell = loader.createCell(
        message.source,
        `qwen-node-repl:cell:${generation}:${message.execId}`,
        bindings,
      );
      cellModule = cell.module;
      await cell.evaluate();
      bindings = readSuccessfulBindings(cell.module, message.bindingExports);
      if (message.resultExportName) {
        const result = cell.module.namespace[message.resultExportName];
        emitText('result', null, untrustedControls.serialize(result));
      }
    });
    send({
      type: 'execResult',
      execId: message.execId,
      status: 'ok',
      bindingNames: sortedBindingNames(),
      rawTextTruncated: activeExec.rawTextTruncated,
      imagesDropped: activeExec.imagesDropped,
      responseMeta: activeExec.responseMeta,
    });
  } catch (error) {
    if (cellModule) {
      const partial = readPartialSnapshot(
        cellModule,
        message.snapshotExportName,
      );
      if (partial) bindings = partial;
    }
    const described = describeThrown(error);
    send({
      type: 'execResult',
      execId: message.execId,
      status: 'error',
      bindingNames: sortedBindingNames(),
      rawTextTruncated: activeExec.rawTextTruncated,
      imagesDropped: activeExec.imagesDropped,
      errorName: described.name,
      errorMessage: described.message,
      ...(described.stack ? { errorStack: described.stack } : {}),
      responseMeta: activeExec.responseMeta,
    });
  } finally {
    rejectCapabilitiesForExec(
      message.execId,
      'node_repl execution ended before the capability returned',
    );
    activeExec = null;
  }
}

function handleAddModuleRoot(message) {
  if (!config) throw new Error('kernel is not initialized');
  const candidate = String(message.path);
  if (!config.moduleRoots.includes(candidate))
    config.moduleRoots.push(candidate);
  send({
    type: 'addModuleRootResult',
    requestId: message.requestId,
    ok: true,
  });
}

function handleCapabilityResult(message) {
  const pending = pendingCapabilities.get(message.capabilityRequestId);
  if (!pending) return;
  pendingCapabilities.delete(message.capabilityRequestId);
  if (message.ok && typeof message.resultJson === 'string') {
    pending.resolve(message.resultJson);
  } else {
    pending.reject(new Error(message.error || 'host capability failed'));
  }
}

function shutdown(removeSessionTmpDir = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearAllTimers();
  rejectAllCapabilities('node_repl kernel shut down');
  if (removeSessionTmpDir) {
    try {
      if (config?.tmpDir) {
        fs.rmSync(config.tmpDir, { recursive: true, force: true });
      }
    } catch {
      // The orphan is already exiting; cleanup remains best-effort.
    }
  }
  protocolInput.destroy();
  protocolOutput.end(() => process.exit(0));
  hostSetTimeout(() => process.exit(0), 100).unref();
}

function fatal(error) {
  const described = describeThrown(error);
  send({ type: 'fatal', message: described.message });
  hostSetTimeout(() => process.exit(1), 10).unref();
}

function routeMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('protocol message must be an object');
  }
  if (message.type === 'capabilityResult') {
    handleCapabilityResult(message);
    return;
  }
  if (message.type === 'shutdown') {
    shutdown();
    return;
  }
  operationChain = operationChain
    .then(async () => {
      if (message.type === 'init') initialize(message);
      else if (message.type === 'exec') await handleExec(message);
      else if (message.type === 'addModuleRoot') handleAddModuleRoot(message);
      else
        throw new Error(`unknown host message type: ${String(message.type)}`);
    })
    .catch(fatal);
}

let inputBuffer = '';
let inputBufferBytes = 0;
protocolInput.setEncoding('utf8');
protocolInput.on('data', (chunk) => {
  const previousLength = inputBuffer.length;
  inputBuffer += chunk;
  inputBufferBytes += Buffer.byteLength(chunk, 'utf8');
  let newline = inputBuffer.indexOf('\n', previousLength);
  while (newline !== -1) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    inputBufferBytes = Math.max(
      0,
      inputBufferBytes - Buffer.byteLength(line, 'utf8') - 1,
    );
    if (line.trim()) {
      try {
        routeMessage(JSON.parse(line));
      } catch (error) {
        fatal(error);
      }
    }
    newline = inputBuffer.indexOf('\n');
  }
  if (inputBufferBytes > 64 * 1024 * 1024) {
    fatal(new Error('host protocol frame exceeded 67108864 bytes'));
    inputBuffer = '';
    inputBufferBytes = 0;
  }
});
protocolInput.on('end', () => shutdown(true));
protocolInput.on('error', () => shutdown(true));
protocolOutput.on('error', () => shutdown(true));

process.on('unhandledRejection', (error) => {
  emitText('console', 'error', describeThrown(error).message);
});
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
