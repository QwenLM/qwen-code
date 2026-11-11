/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SCRIPT_IMAGE_TYPES, STORE_LIMITS } from './types.js';

/** Evaluated only inside QuickJS. The returned API is held by the Worker. */
export const PRELUDE_SOURCE = String.raw`
(bridge, namesJSON, directNamesJSON, catalogJSON, storeJSON, storeError, namespacesJSON) => {
  'use strict';
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const create = Object.create;
  const freeze = Object.freeze;
  const define = Object.defineProperty;
  const hasOwn = Object.hasOwn;
  const PromiseClass = Promise;
  const ErrorClass = Error;
  const StringClass = String;
  const ProxyClass = Proxy;
  const pending = create(null);
  const rejections = new Map();
  const tools = create(null);
  let sequence = 0;
  const format = value => {
    if (typeof value === 'string') return value;
    return stringify(value, (_key, item) => item instanceof ErrorClass ? {
      name: item.name, message: item.message,
      ...(item.kind === undefined ? {} : {kind: item.kind}),
      ...(item.toolName === undefined ? {} : {toolName: item.toolName}),
      ...(item.callId === undefined ? {} : {callId: item.callId})
    } : item);
  };
  const text = value => {
    const rendered = format(value);
    bridge('output', rendered ?? StringClass(value));
  };
  const names = parse(namesJSON);
  const direct = create(null);
  for (const name of parse(directNamesJSON)) direct[name] = true;
  const request = (kind, prepare) => {
    // Count attempts before serialization, even when the caller catches an error.
    const id = ++sequence;
    return new PromiseClass((resolve, reject) => {
      bridge('attempt', id);
      const payload = prepare();
      pending[id] = { resolve, reject };
      try {
        bridge(kind, id, ...payload);
      } catch (error) {
        delete pending[id];
        reject(error);
      }
    });
  };
  const invoke = (name, args) => request('call', () => {
    const encoded = stringify(args);
    if (encoded === undefined) throw new ErrorClass('Tool arguments must be a JSON object');
    return [name, encoded];
  });
  for (const name of names) define(tools, name, { value: freeze(args => invoke(name, args)), enumerable: true });
  const descriptions = create(null);
  for (const entry of parse(catalogJSON)) {
    if (hasOwn(tools, entry.name)) descriptions[entry.name] = entry.description;
  }
  const allTools = [];
  const toolEntries = create(null);
  for (const name of names) {
    if (!hasOwn(tools, name)) continue;
    toolEntries[name] = freeze({ name, description: descriptions[name] ?? '' });
    allTools.push(toolEntries[name]);
  }
  define(globalThis, 'ALL_TOOLS', { value: freeze(allTools) });
  define(globalThis, 'describeTool', { value: freeze(async name => {
    if (typeof name !== 'string') throw new ErrorClass('describeTool(name) expects a tool name');
    return hasOwn(tools, name) ? descriptions[name] ?? '' : undefined;
  }) });
  // Server names may be written as "docs", "mcp__docs" or with - and _ swapped.
  const namespaceKey = name => StringClass(name).replace(/^mcp__/, '').toLowerCase().replace(/-/g, '_');
  const namespaces = new Map();
  for (const entry of parse(namespacesJSON)) namespaces.set(namespaceKey(entry.name), entry);
  define(globalThis, 'describeNamespace', { value: freeze(async name => {
    if (typeof name !== 'string') throw new ErrorClass('describeNamespace(name) expects a server name');
    const entry = namespaces.get(namespaceKey(name));
    if (!entry) return undefined;
    return {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.instructions ? { instructions: entry.instructions } : {}),
      tools: entry.tools.filter(tool => hasOwn(tools, tool)),
    };
  }) });
  const isSafeInteger = Number.isSafeInteger;
  const searches = create(null);
  let searchSequence = 0;
  define(globalThis, 'searchTools', { value: freeze(async (query, options = {}) => {
    if (typeof query !== 'string') throw new ErrorClass('searchTools(query) expects a string');
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new ErrorClass('searchTools options must be an object with optional limit and namespace');
    const limit = options.limit ?? 8;
    if (!isSafeInteger(limit) || limit < 1) throw new ErrorClass('searchTools limit must be a positive integer');
    if (options.namespace !== undefined && typeof options.namespace !== 'string')
      throw new ErrorClass('searchTools namespace must be a server name');
    // The host ranks with the index it shares with mcp_list and keeps between scripts.
    const id = ++searchSequence;
    const found = await new PromiseClass((resolve, reject) => {
      searches[id] = resolve;
      try {
        bridge('search', id, stringify({ query, limit, namespace: options.namespace }));
      } catch (error) {
        delete searches[id];
        reject(error);
      }
    });
    return found.filter(name => hasOwn(toolEntries, name)).map(name => toolEntries[name]);
  }) });
  const imageTypes = ${JSON.stringify(SCRIPT_IMAGE_TYPES)};
  const imageUsage = 'image() expects an image block {type: "image", data, mimeType}, a base64 data: URL, or {path} to a local image file';
  // A file read is a Read call: it takes a call id, so settle() resolves it like any tool call.
  const showFile = path => request('imageFile', () => {
    if (!path) throw new ErrorClass('image() path must be a non-empty file path');
    return [path];
  });
  define(globalThis, 'image', { value: freeze(value => {
    let mimeType;
    let data;
    if (value && typeof value === 'object' && typeof value.path === 'string')
      return showFile(value.path);
    if (typeof value === 'string') {
      const match = /^data:([^;,]+);base64,/.exec(value);
      if (!match) throw new ErrorClass(imageUsage);
      mimeType = match[1];
      data = value.slice(match[0].length);
    } else if (value && typeof value === 'object' && value.type === 'image' &&
               typeof value.data === 'string' && typeof value.mimeType === 'string') {
      mimeType = value.mimeType;
      data = value.data;
    } else throw new ErrorClass(imageUsage);
    mimeType = mimeType.toLowerCase();
    if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
    if (!imageTypes.includes(mimeType)) throw new ErrorClass('image() supports PNG, JPEG, GIF and WebP, not ' + mimeType);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new ErrorClass('image() data must be base64 without whitespace; to show a file, await image({path})');
    bridge('image', mimeType, data);
  }) });
  const assert = (condition, message) => {
    if (!condition) throw new ErrorClass(message === undefined ? 'Assertion failed' : StringClass(message));
  };
  define(globalThis, 'assert', { value: freeze(assert) });
  const storeLimits = ${JSON.stringify(STORE_LIMITS)};
  const state = new Map(Object.entries(parse(storeJSON)).map(([key, value]) => [key, stringify(value)]));
  const initialState = new Map(state);
  const bytes = value => {
    let size = 0;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length &&
               value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        size += 4; i++;
      } else size += 3;
    }
    return size;
  };
  let stateBytes = 0;
  for (const [key, value] of state) stateBytes += bytes(key) + bytes(value);
  const checkKey = key => {
    if (storeError) {
      const error = new ErrorClass(storeError);
      error.name = 'StoreRestoreError';
      throw error;
    }
    if (typeof key !== 'string' || !key || key.length > storeLimits.keyChars)
      throw new ErrorClass('store key must be a non-empty string of at most ' + storeLimits.keyChars + ' characters');
  };
  const validateJSON = (value, seen = new Set()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value) ||
        (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
      throw new ErrorClass('store requires a JSON value; await promises before storing them');
    seen.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value)) validateJSON(item, seen);
    seen.delete(value);
  };
  define(globalThis, 'load', { value: freeze(key => {
    checkKey(key);
    return state.has(key) ? parse(state.get(key)) : undefined;
  }) });
  define(globalThis, 'store', { value: freeze((key, value) => {
    checkKey(key);
    if (value !== undefined) validateJSON(value);
    const encoded = value === undefined ? undefined : stringify(value);
    const previous = state.get(key);
    const size = stateBytes - (previous === undefined ? 0 : bytes(key) + bytes(previous)) +
      (encoded === undefined ? 0 : bytes(key) + bytes(encoded));
    if (encoded !== undefined && previous === undefined && state.size >= storeLimits.keys)
      throw new ErrorClass('store holds at most ' + storeLimits.keys + ' keys');
    if (size > storeLimits.totalBytes) throw new ErrorClass('store size limit exceeded; delete unused keys first');
    if (encoded === undefined) state.delete(key);
    else state.set(key, encoded);
    stateBytes = size;
  }) });
  const console = create(null);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    define(console, method, { value: (...values) => {
      let rendered = '';
      for (let i = 0; i < values.length; i++) {
        if (i) rendered += ' ';
        rendered += format(values[i]) ?? StringClass(values[i]);
      }
      text(rendered);
    }, enumerable: true });
  }
  const toolAccess = new ProxyClass(freeze(tools), {
    get(target, name) {
      if (hasOwn(target, name)) return target[name];
      // Promise assimilation and JSON formatting may probe these properties.
      if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
      const distance = candidate => {
        const a = name.toLowerCase(), b = candidate.toLowerCase();
        let row = Array.from({length: b.length + 1}, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
          const next = [i];
          for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
          row = next;
        }
        return row[b.length];
      };
      const suggestions = name.length <= 100 ? allTools.map(entry => ({name: entry.name, distance: distance(entry.name)}))
        .filter(entry => entry.distance <= Math.max(2, Math.min(3, Math.floor(name.length / 3))))
        .sort((a, b) => a.distance - b.distance).slice(0, 3).map(entry => entry.name) : [];
      const error = new ErrorClass('Tool ' + name + ' is not available inside CodeMode. ' +
        (hasOwn(direct, name)
          ? 'Call ' + name + ' directly outside CodeMode.'
          : 'Use ALL_TOOLS or await searchTools(query) to find callable tools; check name in tools before calling.') +
        (suggestions.length ? ' Similar callable tools: ' + suggestions.join(', ') + '.' : ''));
      error.name = 'ToolCallError';
      error.kind = 'unavailable';
      error.toolName = name;
      throw error;
    }
  });
  define(globalThis, 'tools', { value: toolAccess });
  define(globalThis, 'text', { value: freeze(text) });
  define(globalThis, 'console', { value: freeze(console) });
  return {
    format,
    trackRejection(promise, reason, handled) {
      if (handled) rejections.delete(promise);
      else rejections.set(promise, reason);
    },
    rejection() { return rejections.size ? {reason: rejections.values().next().value} : undefined; },
    storeWrites() {
      const writes = [];
      for (const key of new Set([...initialState.keys(), ...state.keys()])) {
        if (initialState.get(key) === state.get(key)) continue;
        writes.push(state.has(key) ? {key, value: parse(state.get(key))} : {key});
      }
      return stringify(writes);
    },
    settleSearch(id, payload) {
      if (!hasOwn(searches, id)) return;
      const resolve = searches[id];
      delete searches[id];
      resolve(parse(payload));
    },
    settle(id, ok, payload) {
      if (!hasOwn(pending, id)) return;
      const waiter = pending[id];
      delete pending[id];
      const value = parse(payload);
      if (ok) waiter.resolve(value);
      else {
        const error = new ErrorClass(value.message);
        error.name = 'ToolCallError';
        error.kind = value.kind;
        error.toolName = value.toolName;
        error.callId = value.callId;
        waiter.reject(error);
      }
    }
  };
}`;
