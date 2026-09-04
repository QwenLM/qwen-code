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
import { webcrypto } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';
import {
  inspect,
  TextDecoder,
  TextEncoder,
  types as utilTypes,
} from 'node:util';
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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_PERCENT_ENCODED_IMAGE_CHARS = MAX_IMAGE_BYTES * 3;
const MAX_RAW_IMAGES = 64;
const MAX_RAW_IMAGE_CHARS = 128 * 1024 * 1024;
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
let untrustedContext = null;
let loader = null;
let bindings = new Map();
let activeExec = null;
let operationChain = Promise.resolve();
let shuttingDown = false;
let pendingCancelExecId = null;

const timers = new Map();
/** Upper bound on concurrently live sandbox timers (see scheduleTimer). */
const MAX_LIVE_TIMERS = 1024;
/** Unhandled rejections that surfaced between cells, reported on the next one. */
const lateRejections = [];
const MAX_LATE_REJECTIONS = 32;
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

class CellCancelledError extends Error {
  constructor() {
    super('Execution was cancelled.');
    this.name = 'AbortError';
  }
}

function formatValue(value) {
  if (typeof value === 'string') return value;
  if (utilTypes.isNativeError(value)) {
    let name = 'Error';
    let message = '';
    try {
      if (typeof value.name === 'string' && value.name) name = value.name;
    } catch {
      // Keep the default name.
    }
    try {
      message = typeof value.message === 'string' ? value.message : '';
    } catch {
      message = '[unreadable]';
    }
    return `${name}: ${message}`;
  }
  try {
    return inspect(value, {
      colors: false,
      compact: true,
      breakLength: Infinity,
      customInspect: false,
      getters: false,
    });
  } catch (error) {
    return `[Uninspectable: ${describeThrown(error).message}]`;
  }
}

function formatArgs(args) {
  if (!Array.isArray(args)) return formatValue(args);
  let formatted = '';
  for (let index = 0; index < args.length; index++) {
    if (index > 0) formatted += ' ';
    formatted += formatValue(args[index]);
  }
  return formatted;
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
    // Normalize like the data: URL branch below — MIME types are
    // case-insensitive (RFC 6838), so `Image/PNG` must behave identically here.
    declaredMime =
      typeof payload.mimeType === 'string'
        ? payload.mimeType.toLowerCase()
        : null;
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
      if (match[2]) {
        const encoded = match[3];
        if (
          encoded.length === 0 ||
          encoded.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        ) {
          throw new Error('malformed base64 data URL');
        }
        buffer = Buffer.from(encoded, 'base64');
      } else {
        buffer = Buffer.from(decodeURIComponent(match[3]), 'utf8');
      }
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

function scheduleTimer(callback, delay, repeat) {
  const execId = currentExecId();
  // Timers outlive the cell that armed them (deliberately — polling across
  // cells is useful), so an unbounded count would let one botched loop
  // permanently saturate this session's event loop. Cap the number of LIVE
  // timers; cancelled/fired one-shots free their slot.
  if (timers.size >= MAX_LIVE_TIMERS) {
    throw new Error(
      `node_repl allows at most ${MAX_LIVE_TIMERS} live timers; clear existing timers or call node_repl_reset`,
    );
  }
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
  timers.set(timerId, { handle, repeat, execId });
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

function clearTimersForExec(execId) {
  for (const [timerId, timer] of timers) {
    if (timer.execId === execId) cancelTimer(timerId);
  }
}

function trackCancellationBarrier(exec, value) {
  if (activeExec !== exec) return value;
  const barrier = Promise.resolve(value);
  exec.cancellationBarriers.add(barrier);
  void barrier.then(
    () => exec.cancellationBarriers.delete(barrier),
    () => exec.cancellationBarriers.delete(barrier),
  );
  // The callee must receive the real terminal value so it can classify an
  // already-dispatched operation as committed, refused, or failed. The cell
  // transform independently guards the caller's `await`, preventing user code
  // from continuing after cancellation while the kernel drains this barrier.
  return barrier;
}

function guardCancellationContinuation(exec, value) {
  const awaited = Promise.resolve(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    const settle = (callback, result) => {
      if (settled || cancelled) return;
      settled = true;
      exec.abortController.signal.removeEventListener('abort', onAbort);
      callback(result);
    };
    // Do not reject into user code: a cell could catch that rejection and run
    // catch/finally side effects after the host had reported cancellation.
    // Leaving only this guarded continuation pending makes cancellation
    // uncatchable while the outer execution controller settles the cell.
    const onAbort = () => {
      cancelled = true;
      exec.abortController.signal.removeEventListener('abort', onAbort);
    };
    if (exec.cancelRequested) {
      onAbort();
    } else {
      exec.abortController.signal.addEventListener('abort', onAbort, {
        once: true,
      });
    }
    void awaited.then(
      (result) => settle(resolve, result),
      (error) => settle(reject, error),
    );
  });
}

function guardAsyncIterable(exec, iterable) {
  const asyncFactory = iterable?.[Symbol.asyncIterator];
  const syncFactory = iterable?.[Symbol.iterator];
  const factory = asyncFactory ?? syncFactory;
  if (typeof factory !== 'function') return iterable;
  return {
    [Symbol.asyncIterator]() {
      const iterator = factory.call(iterable);
      const guarded = {
        next: (...args) =>
          guardCancellationContinuation(exec, iterator.next(...args)),
      };
      if (typeof iterator.return === 'function') {
        guarded.return = (...args) =>
          guardCancellationContinuation(exec, iterator.return(...args));
      }
      if (typeof iterator.throw === 'function') {
        guarded.throw = (...args) =>
          guardCancellationContinuation(exec, iterator.throw(...args));
      }
      return guarded;
    },
  };
}

// A successful cell may intentionally leave an async timer callback behind.
// Its transformed `await` still reads nodeRepl.signal after the originating
// cell has finished, when there is no active execution to cancel. Return a
// real, never-aborted signal whose guard helpers are transparent in that
// state, rather than breaking persistent background work with an undefined
// signal. Its properties are immutable just like the per-cell helpers below.
const idleSignal = new globalThis.AbortController().signal;
Object.defineProperty(idleSignal, 'waitUntil', {
  value: (value) => Promise.resolve(value),
});
Object.defineProperty(idleSignal, 'guardAwait', {
  value: (value) => Promise.resolve(value),
});
Object.defineProperty(idleSignal, 'guardAsyncIterable', {
  value: (value) => value,
});
Object.freeze(idleSignal);

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

const intrinsicArrayBuffer = ArrayBuffer;
const intrinsicError = Error;
const intrinsicUint8Array = Uint8Array;
const intrinsicWeakSet = WeakSet;
const intrinsicString = String;
const intrinsicNumber = Number;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectDefineProperties = Object.defineProperties;
const intrinsicArrayBufferIsView = ArrayBuffer.isView;
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

const runtime = {
  cwd: intrinsicString(metadata.cwd),
  homeDir: intrinsicString(metadata.homeDir),
  tmpDir: intrinsicString(metadata.tmpDir),
  write(value) {
    try {
      bridge.emitText('write', null, bridge.formatValue(value));
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
  get signal() {
    return bridge.currentSignal();
  },
};

deepFreeze(runtime);

const consoleObject = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  consoleObject[level] = function (...args) {
    try {
      bridge.emitText('console', level, bridge.formatArgs(args));
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

`;

function createContext(name) {
  const context = vm.createContext(Object.create(null), {
    name,
    codeGeneration: { strings: false, wasm: false },
  });
  context.globalThis = context;
  context.global = context;
  context.Buffer = Buffer;
  context.URL = URL;
  context.URLSearchParams = URLSearchParams;
  context.TextEncoder = TextEncoder;
  context.TextDecoder = TextDecoder;
  context.AbortController = globalThis.AbortController;
  context.AbortSignal = globalThis.AbortSignal;
  context.structuredClone = globalThis.structuredClone;
  context.fetch = globalThis.fetch;
  context.Headers = globalThis.Headers;
  context.Request = globalThis.Request;
  context.Response = globalThis.Response;
  context.performance = performance;
  context.crypto = webcrypto;
  context.queueMicrotask = globalThis.queueMicrotask;
  context.setImmediate = globalThis.setImmediate;
  context.clearImmediate = globalThis.clearImmediate;
  context.atob = (data) => Buffer.from(data, 'base64').toString('binary');
  context.btoa = (data) => Buffer.from(data, 'binary').toString('base64');
  const bridge = Object.freeze({
    emitText,
    formatValue,
    formatArgs,
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
    heapStatus() {
      return JSON.stringify(heapStatus());
    },
    currentSignal() {
      const execId = currentExecId();
      if (!activeExec || activeExec.execId !== execId) return idleSignal;
      return activeExec.abortController.signal;
    },
    scheduleTimer,
    cancelTimer,
  });
  const bootstrap = vm.compileFunction(
    BOOTSTRAP_SOURCE,
    ['bridge', 'metadata'],
    { parsingContext: context, filename: '<node-repl-bootstrap>' },
  );
  bootstrap(bridge, {
    cwd: config.cwd,
    homeDir: config.homeDir,
    tmpDir: config.tmpDir,
  });
  return context;
}

function initialize(message) {
  if (config) throw new Error('kernel was initialized twice');
  if (!Number.isInteger(message.generation) || message.generation < 1) {
    throw new Error('invalid kernel generation');
  }
  generation = message.generation;
  config = {
    cwd: String(message.cwd),
    homeDir: String(message.homeDir),
    tmpDir: String(message.tmpDir),
    moduleRoots: [...message.moduleRoots],
    readableRoots: [...message.readableRoots],
  };
  untrustedContext = createContext('qwen-node-repl-untrusted');
  loader = createModuleLoader({
    untrustedContext,
    cwd: config.cwd,
    moduleRoots: config.moduleRoots,
    readableRoots: config.readableRoots,
  });
  send({ type: 'ready', generation, pid: process.pid });
}

function sortedBindingNames() {
  return [...bindings.keys()].sort();
}

function sortedBindingDescriptors() {
  return [...bindings]
    .map(([name, binding]) => ({ name, kind: binding.kind }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
}

function sameBindings(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every(
    (binding, index) =>
      binding &&
      binding.name === right[index].name &&
      binding.kind === right[index].kind,
  );
}

function bindingKinds(bindingExports) {
  return new Map(
    bindingExports.map(({ bindingName, bindingKind }) => [
      bindingName,
      bindingKind,
    ]),
  );
}

function readPartialSnapshot(module, exportName, kinds) {
  try {
    const snapshot = module.namespace[exportName];
    if (!snapshot || typeof snapshot !== 'object') return null;
    const next = new Map();
    for (const name of Object.keys(snapshot)) {
      const kind = kinds.get(name);
      if (kind) next.set(name, { value: snapshot[name], kind });
    }
    return next;
  } catch {
    return null;
  }
}

function readSuccessfulBindings(module, bindingExports) {
  const next = new Map();
  for (const { bindingName, bindingKind, exportName } of bindingExports) {
    next.set(bindingName, {
      value: module.namespace[exportName],
      kind: bindingKind,
    });
  }
  return next;
}

async function handleExec(message) {
  if (!config || !loader) throw new Error('kernel is not initialized');
  if (activeExec) throw new Error('kernel received overlapping executions');
  if (
    pendingCancelExecId !== null &&
    pendingCancelExecId !== message.execId
  ) {
    pendingCancelExecId = null;
  }
  const expected = sortedBindingDescriptors();
  if (!sameBindings(message.previousBindings, expected)) {
    throw new Error('host and kernel binding snapshots are out of sync');
  }
  const nextBindingKinds = bindingKinds(message.bindingExports);

  const exec = {
    execId: message.execId,
    abortController: new globalThis.AbortController(),
    cancel: null,
    cancelRequested: false,
    cancellationBarriers: new Set(),
    rawTextBytes: 0,
    textEventCount: 0,
    rawTextTruncated: false,
    imageCount: 0,
    imageChars: 0,
    imagesDropped: 0,
  };
  Object.defineProperty(exec.abortController.signal, 'waitUntil', {
    value: (value) => trackCancellationBarrier(exec, value),
  });
  Object.defineProperty(exec.abortController.signal, 'guardAwait', {
    value: (value) => guardCancellationContinuation(exec, value),
  });
  Object.defineProperty(exec.abortController.signal, 'guardAsyncIterable', {
    value: (value) => guardAsyncIterable(exec, value),
  });
  activeExec = exec;
  let cellModule = null;
  try {
    await asyncContext.run({ execId: message.execId }, async () => {
      // Surface any rejection that settled between cells before running this one.
      while (lateRejections.length > 0) {
        emitText('console', 'error', lateRejections.shift());
      }
      const cell = loader.createCell(
        message.source,
        path.join(
          config.cwd,
          `.qwen_node_repl_cell_${generation}_${message.execId}.mjs`,
        ),
        bindings,
      );
      cellModule = cell.module;
      let rejectCancellation;
      const cancellation = new Promise((_, reject) => {
        rejectCancellation = reject;
      });
      activeExec.cancel = () => {
        if (
          activeExec?.execId !== message.execId ||
          activeExec.cancelRequested
        ) {
          return;
        }
        activeExec.cancelRequested = true;
        activeExec.abortController.abort();
        clearTimersForExec(message.execId);
        const barriers = [...activeExec.cancellationBarriers];
        if (barriers.length === 0) {
          rejectCancellation(new CellCancelledError());
          return;
        }
        void Promise.allSettled(barriers).then(() => {
          rejectCancellation(new CellCancelledError());
        });
      };
      if (pendingCancelExecId === message.execId) {
        pendingCancelExecId = null;
        activeExec.cancel();
      }
      const evaluation = cell.evaluate({ timeout: message.timeoutMs });
      void evaluation.catch(() => undefined);
      await Promise.race([evaluation, cancellation]);
      if (activeExec.cancelRequested) throw new CellCancelledError();
      bindings = readSuccessfulBindings(cell.module, message.bindingExports);
    });
    send({
      type: 'execResult',
      execId: message.execId,
      status: 'ok',
      bindingNames: sortedBindingNames(),
      rawTextTruncated: activeExec.rawTextTruncated,
      imagesDropped: activeExec.imagesDropped,
    });
  } catch (error) {
    const status =
      error instanceof CellCancelledError
        ? 'cancelled'
        : error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
          ? 'timeout'
          : 'error';
    if (status === 'cancelled' || status === 'timeout') {
      exec.cancelRequested = true;
      if (!exec.abortController.signal.aborted) exec.abortController.abort();
      clearTimersForExec(message.execId);
      // Cancellable native APIs register their terminal promise through
      // signal.waitUntil. The JavaScript continuation stops immediately, but
      // the cell is not reported terminal until already-dispatched native work
      // has reached a known final state.
      await Promise.allSettled([...exec.cancellationBarriers]);
    }
    if (status === 'error' && cellModule) {
      const partial = readPartialSnapshot(
        cellModule,
        message.snapshotExportName,
        nextBindingKinds,
      );
      if (partial) bindings = partial;
    }
    const described = describeThrown(error);
    send({
      type: 'execResult',
      execId: message.execId,
      status,
      bindingNames: sortedBindingNames(),
      rawTextTruncated: activeExec.rawTextTruncated,
      imagesDropped: activeExec.imagesDropped,
      errorName: described.name,
      errorMessage: described.message,
      ...(described.stack ? { errorStack: described.stack } : {}),
    });
  } finally {
    activeExec = null;
  }
}

function handleCancel(message) {
  if (activeExec?.execId === message.execId) {
    activeExec.cancel?.();
    return;
  }
  pendingCancelExecId = message.execId;
}

function handleAddModuleRoot(message) {
  if (!config) throw new Error('kernel is not initialized');
  const root = {
    path: String(message.root.path),
    canonicalPath: String(message.root.canonicalPath),
  };
  if (
    !config.moduleRoots.some(
      (candidate) => candidate.canonicalPath === root.canonicalPath,
    )
  ) {
    config.moduleRoots.push(root);
  }
  send({
    type: 'addModuleRootResult',
    requestId: message.requestId,
    ok: true,
  });
}

function shutdown(removeSessionTmpDir = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearAllTimers();
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
  if (message.type === 'shutdown') {
    shutdown();
    return;
  }
  if (message.type === 'cancel') {
    handleCancel(message);
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
// Index to start scanning for the next newline. Reset to 0 if a drain is ever
// interrupted, so complete frames left in the buffer are not skipped.
let inputScanFrom = 0;
protocolInput.setEncoding('utf8');
protocolInput.on('data', (chunk) => {
  const searchFrom = inputScanFrom;
  inputBuffer += chunk;
  inputBufferBytes += Buffer.byteLength(chunk, 'utf8');
  let drained = false;
  try {
    let newline = inputBuffer.indexOf('\n', searchFrom);
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
    drained = true;
  } finally {
    inputScanFrom = drained ? inputBuffer.length : 0;
  }
  if (inputBufferBytes > 64 * 1024 * 1024) {
    fatal(new Error('host protocol frame exceeded 67108864 bytes'));
    inputBuffer = '';
    inputBufferBytes = 0;
    inputScanFrom = 0;
  }
});
protocolInput.on('end', () => shutdown(true));
protocolInput.on('error', () => shutdown(true));
protocolOutput.on('error', () => shutdown(true));

process.on('unhandledRejection', (error) => {
  const message = `Uncaught (in promise) ${describeThrown(error).message}`;
  // emitText is gated on the active exec, but rejections routinely settle just
  // AFTER the cell returns (a dangling promise, a timer callback). Reporting
  // them into the current exec when one is active, and otherwise buffering them
  // for the next cell, keeps them visible instead of vanishing silently.
  if (activeExec) {
    asyncContext.run({ execId: activeExec.execId }, () => {
      emitText('console', 'error', message);
    });
    return;
  }
  if (lateRejections.length < MAX_LATE_REJECTIONS) {
    lateRejections.push(message);
  }
});
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
