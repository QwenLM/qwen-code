/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import type { InputValues, UiEvent, UiPatch } from './runtime-contract.js';

const MAX_BATCH_SIZE = 16_000;
const MAX_INPUT_VALUE = 2048;
const VALID_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

// This closure never exports its dispatcher or mutable state to generated code.
// Serialize primitive strings directly: guest toJSON hooks must not reach host data.
const BRIDGE = `(() => {
  'use strict';
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const create = Object.create;
  const freeze = Object.freeze;
  const apply = Reflect.apply;
  const charCodeAt = String.prototype.charCodeAt;
  const hasOwn = Object.prototype.hasOwnProperty;
  const ErrorType = Error;
  const then = Promise.prototype.then;
  const resolve = Promise.resolve;
  const PromiseType = Promise;
  const handlers = create(null);
  let registrations = 0;
  let inputs = create(null);
  let output = '[';
  let outputBytes = 2;
  let count = 0;
  let failed = false;
  function fail() {
    failed = true;
    throw new ErrorType('Invalid UI operation or output limit exceeded.');
  }
  function codeAt(value, index) {
    return apply(charCodeAt, value, [index]);
  }
  function validId(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
    for (let i = 0; i < id.length; i++) {
      const code = codeAt(id, i);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) continue;
      if (i > 0 && ((code >= 48 && code <= 57) || code === 45 || code === 95)) continue;
      return false;
    }
    return true;
  }
  function byteLength(value) {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const code = codeAt(value, i);
      if (code < 128) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length &&
          codeAt(value, i + 1) >= 0xdc00 && codeAt(value, i + 1) <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
    return bytes;
  }
  function patch(kind, id, value) {
    if (failed || !validId(id) || typeof value !== 'string' ||
        value.length > ${MAX_BATCH_SIZE} || count >= 64 ||
        (kind === 'value' && value.length > ${MAX_INPUT_VALUE})) fail();
    const entry = (count ? ',' : '') + '{"kind":' + stringify(kind) +
      ',"id":' + stringify(id) + ',"value":' + stringify(value) + '}';
    const bytes = byteLength(entry);
    if (output.length + entry.length + 1 > ${MAX_BATCH_SIZE} ||
        outputBytes + bytes > ${MAX_BATCH_SIZE}) fail();
    output += entry;
    outputBytes += bytes;
    count++;
  }
  const ui = create(null);
  ui.on = function(id, type, handler) {
    if (failed || !validId(id) ||
        (type !== 'input' && type !== 'change' && type !== 'click') ||
        typeof handler !== 'function') fail();
    const key = id + ':' + type;
    if (!handlers[key] && ++registrations > 192) fail();
    handlers[key] = handler;
  };
  ui.input = function(id) {
    if (failed || !validId(id)) fail();
    const input = inputs[id];
    return freeze({value: input ? input.value : '', checked: input ? input.checked : false});
  };
  ui.text = function(id, value) { patch('text', id, value); };
  ui.html = function(id, value) { patch('html', id, value); };
  ui.value = function(id, value) {
    patch('value', id, value);
    if (inputs[id]) inputs[id].value = value;
    else inputs[id] = {value: value, checked: false};
  };
  Object.defineProperty(globalThis, 'ui', {value: freeze(ui)});
  return function(command, payload) {
    if (failed) fail();
    if (command === 'inputs') {
      const parsed = parse(payload);
      inputs = create(null);
      for (const id in parsed) {
        if (apply(hasOwn, parsed, [id])) inputs[id] = parsed[id];
      }
    } else if (command === 'event') {
      const event = parse(payload);
      const handler = handlers[event.id + ':' + event.type];
      if (handler) {
        const result = handler(freeze(event));
        if (result !== undefined) {
          apply(then, apply(resolve, PromiseType, [result]), [undefined, fail]);
        }
        return true;
      }
      return false;
    } else {
      const result = output + ']';
      output = '[';
      outputBytes = 2;
      count = 0;
      return result;
    }
  };
})()`;

// Reads a native error's own data properties without invoking guest getters or
// toString hooks; anything else describes as ''. Evaluated before generated
// code runs, so later changes to globals cannot reach these references.
const DESCRIBE = `(() => {
  'use strict';
  const getPrototypeOf = Object.getPrototypeOf;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const natives = [Error.prototype, EvalError.prototype, RangeError.prototype,
    ReferenceError.prototype, SyntaxError.prototype, TypeError.prototype,
    URIError.prototype];
  function isNative(prototype) {
    for (let i = 0; i < natives.length; i++) if (natives[i] === prototype) return true;
    return false;
  }
  function data(object, key) {
    let current = object;
    for (let depth = 0; current !== null && depth < 8; depth++) {
      const descriptor = getOwnPropertyDescriptor(current, key);
      if (descriptor) return typeof descriptor.value === 'string' ? descriptor.value : '';
      if (isNative(current)) return '';
      current = getPrototypeOf(current);
    }
    return '';
  }
  return function (error) {
    if (error === null || typeof error !== 'object') return '';
    let current = getPrototypeOf(error);
    let native = false;
    for (let depth = 0; current !== null && depth < 8; depth++) {
      if (isNative(current)) { native = true; break; }
      current = getPrototypeOf(current);
    }
    if (!native) return '';
    const line = getOwnPropertyDescriptor(error, 'lineNumber');
    return data(error, 'name').slice(0, 40) + '\\n' +
      data(error, 'message').slice(0, 300) + '\\n' +
      data(error, 'stack').slice(0, 300) + '\\n' +
      (line && typeof line.value === 'number' ? String(line.value) : '');
  };
})()`;

const RUNTIME_LIMIT =
  'Generated JavaScript failed or exceeded a runtime limit.';
const SOURCE_NAME = 'generated-ui.js';
const SCRIPT_ERRORS = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/**
 * Formats an error description from DESCRIBE. Only ordinary script errors are
 * named; QuickJS InternalError (stack or memory exhaustion) and thrown
 * non-errors keep the generic runtime-limit message.
 */
export function formatScriptError(description: string): string | undefined {
  const [name = '', message = '', stack = '', line = ''] =
    description.split('\n');
  if (!SCRIPT_ERRORS.has(name)) return undefined;
  const location = /generated-ui\.js:(\d+)(?::(\d+))?/.exec(stack);
  const lineNumber = location?.[1] ?? (/^\d+$/.test(line) ? line : undefined);
  const where = lineNumber
    ? ` (line ${lineNumber}${location?.[2] ? `, column ${location[2]}` : ''})`
    : '';
  let detail = message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  if (detail.length > 160) detail = `${detail.slice(0, 159)}…`;
  detail = detail.replace(/[.。]+$/u, '');
  const label = name === 'Error' ? detail || name : `${name}: ${detail}`;
  return `Script error: ${label.replace(/: $/, '')}${where}.`;
}

function serializeInputs(inputs: InputValues): string {
  if (
    !inputs ||
    typeof inputs !== 'object' ||
    Object.keys(inputs).length > 64
  ) {
    throw new Error('Too many UI inputs.');
  }
  for (const [id, input] of Object.entries(inputs)) {
    if (
      !VALID_ID.test(id) ||
      !input ||
      typeof input.value !== 'string' ||
      input.value.length > MAX_INPUT_VALUE ||
      typeof input.checked !== 'boolean'
    ) {
      throw new Error('Invalid UI input.');
    }
  }
  const json = JSON.stringify(inputs);
  if (
    json.length > MAX_BATCH_SIZE ||
    new TextEncoder().encode(json).length > MAX_BATCH_SIZE
  ) {
    throw new Error('UI input limit exceeded.');
  }
  return json;
}

export class UiRuntime {
  private readonly runtime: QuickJSRuntime;
  private readonly vm: QuickJSContext;
  private bridge?: QuickJSHandle;
  private describer?: QuickJSHandle;
  private deadline = Infinity;
  private interrupted = false;
  private initialized = false;
  private disposed = false;

  constructor(module: QuickJSWASMModule) {
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(32 * 1024 * 1024);
    this.runtime.setMaxStackSize(256 * 1024);
    this.runtime.setInterruptHandler(() => {
      this.interrupted ||= performance.now() >= this.deadline;
      return this.interrupted;
    });
    this.vm = this.runtime.newContext();
    this.describer = this.take(this.vm.evalCode(DESCRIBE, 'ui-describe.js'));
    this.bridge = this.take(this.vm.evalCode(BRIDGE, 'ui-bridge.js'));
  }

  initialize(javascript: string, inputs: InputValues): UiPatch[] {
    return this.round(() => {
      if (this.initialized)
        throw new Error('UI runtime is already initialized.');
      this.initialized = true;
      if (
        typeof javascript !== 'string' ||
        javascript.length > 24_000 ||
        new TextEncoder().encode(javascript).length > 24_000
      ) {
        throw new Error('Generated JavaScript source limit exceeded.');
      }
      this.call('inputs', serializeInputs(inputs)).dispose();
      this.take(
        this.vm.evalCode(javascript, SOURCE_NAME, { type: 'global' }),
      ).dispose();
    });
  }

  dispatch(
    event: UiEvent,
    inputs: InputValues,
  ): { patches: UiPatch[]; handled: boolean } {
    let handled = false;
    const patches = this.round(() => {
      if (!this.initialized) throw new Error('UI runtime is not initialized.');
      if (
        !event ||
        !VALID_ID.test(event.id) ||
        !['input', 'change', 'click'].includes(event.type) ||
        typeof event.value !== 'string' ||
        event.value.length > MAX_INPUT_VALUE ||
        typeof event.checked !== 'boolean'
      ) {
        throw new Error('Invalid UI event.');
      }
      this.call('inputs', serializeInputs(inputs)).dispose();
      const result = this.call('event', JSON.stringify(event));
      try {
        handled = this.vm.eq(result, this.vm.true);
      } finally {
        result.dispose();
      }
    });
    return { patches, handled };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bridge?.dispose();
    this.describer?.dispose();
    this.vm.dispose();
    this.runtime.dispose();
  }

  private take(result: ReturnType<QuickJSContext['evalCode']>): QuickJSHandle {
    if (result.error) {
      const message = this.describe(result.error) ?? RUNTIME_LIMIT;
      result.error.dispose();
      throw new Error(message);
    }
    return result.value;
  }

  private describe(error: QuickJSHandle): string | undefined {
    if (!this.describer || this.interrupted) return undefined;
    // Describing must not extend a round past its time budget.
    const deadline = this.deadline;
    this.deadline = Math.min(deadline, performance.now() + 50);
    try {
      const result = this.vm.callFunction(
        this.describer,
        this.vm.undefined,
        error,
      );
      if (result.error) {
        result.error.dispose();
        return undefined;
      }
      try {
        return formatScriptError(this.vm.getString(result.value));
      } finally {
        result.value.dispose();
      }
    } catch {
      return undefined;
    } finally {
      this.interrupted = false;
      this.deadline = deadline;
    }
  }

  private call(command: string, payload = ''): QuickJSHandle {
    const commandHandle = this.vm.newString(command);
    const payloadHandle = this.vm.newString(payload);
    try {
      return this.take(
        this.vm.callFunction(
          this.bridge!,
          this.vm.undefined,
          commandHandle,
          payloadHandle,
        ),
      );
    } finally {
      commandHandle.dispose();
      payloadHandle.dispose();
    }
  }

  private round(execute: () => void): UiPatch[] {
    if (this.disposed) throw new Error('UI runtime is stopped.');
    this.deadline = performance.now() + 250;
    this.interrupted = false;
    try {
      execute();
      const jobs = this.runtime.executePendingJobs(256);
      // QuickJS job execution errors are distinct from guest promise rejections.
      if (jobs.error) {
        jobs.error.dispose();
        throw new Error('Generated JavaScript microtask failed.');
      }
      if (this.runtime.hasPendingJob()) {
        throw new Error('Generated JavaScript microtask limit exceeded.');
      }
      const output = this.call('flush');
      let json: string;
      try {
        json = this.vm.getString(output);
      } finally {
        output.dispose();
      }
      if (this.interrupted || performance.now() >= this.deadline) {
        throw new Error('Generated JavaScript execution time limit exceeded.');
      }
      return JSON.parse(json) as UiPatch[];
    } catch (error) {
      const timedOut = this.interrupted || performance.now() >= this.deadline;
      try {
        this.dispose();
      } catch {
        // A WASM trap can also break GC; the failed worker is discarded in full.
      }
      if (timedOut) {
        throw new Error('Generated JavaScript execution time limit exceeded.');
      }
      throw error;
    }
  }
}
