/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort } from 'node:worker_threads';
import releaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSDeferredPromise,
  type QuickJSSyncVariant,
} from 'quickjs-emscripten-core';

interface StartMessage {
  type: 'start';
  source: string;
  deadlineMs: number;
  tools: Array<{ name: string; originalName: string }>;
  allTools: Array<{ name: string; description: string }>;
}

interface ToolResultMessage {
  type: 'tool-result';
  id: string;
  result?: unknown;
  error?: string;
}

const port = parentPort;
if (!port) throw new Error('Code mode worker requires a parent port.');
const workerPort = port;
const variant = releaseVariant as unknown as QuickJSSyncVariant;

async function loadQuickJS() {
  try {
    const module = (await import(
      '@jitl/quickjs-wasmfile-release-sync/wasm?binary' as string
    )) as { default: Uint8Array };
    const bytes = module.default;
    const binary = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return newQuickJSWASMModuleFromVariant(
      newVariant(variant, { wasmBinary: binary }),
    );
  } catch {
    return newQuickJSWASMModuleFromVariant(variant);
  }
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return String((value as { message: unknown }).message);
  }
  return String(value);
}

async function run(message: StartMessage): Promise<void> {
  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + message.deadlineMs),
  );
  const context = runtime.newContext();
  const deferred = new Map<string, QuickJSDeferredPromise>();
  let nextId = 0;

  const pump = () => {
    context.unwrapResult(runtime.executePendingJobs());
  };

  const hostCall = context.newFunction(
    '__qwen_call_tool',
    (nameHandle, argsHandle) => {
      const name = context.getString(nameHandle);
      const argsJson = context.getString(argsHandle);
      const call = context.newPromise();
      const id = String(++nextId);
      deferred.set(id, call);
      workerPort.postMessage({ type: 'tool-call', id, name, argsJson });
      return call.handle;
    },
  );
  context.setProp(context.global, '__qwen_call_tool', hostCall);
  hostCall.dispose();

  const onMessage = (incoming: ToolResultMessage) => {
    if (incoming.type !== 'tool-result') return;
    const call = deferred.get(incoming.id);
    if (!call) return;
    deferred.delete(incoming.id);
    if (incoming.error !== undefined) {
      const error = context.newError(incoming.error);
      call.reject(error);
      error.dispose();
    } else {
      const value = context.newString(JSON.stringify(incoming.result));
      call.resolve(value);
      value.dispose();
    }
    pump();
  };
  workerPort.on('message', onMessage);

  const bindings = message.tools
    .map(
      ({ name, originalName }) =>
        `[${JSON.stringify(name)}]: Object.freeze((args) => {
          if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            return Promise.reject(new TypeError('Tool arguments must be an object.'));
          }
          return __qwen_call_tool(${JSON.stringify(originalName)}, JSON.stringify(args)).then(JSON.parse);
        })`,
    )
    .join(',\n');
  const program = `
    (() => {
      'use strict';
      const __outputs = [];
      const __exit = Object.freeze({ __qwen_exit: true });
      Object.defineProperty(globalThis, 'tools', {
        value: Object.freeze({ ${bindings} }), writable: false, configurable: false
      });
      Object.defineProperty(globalThis, 'ALL_TOOLS', {
        value: Object.freeze(${JSON.stringify(message.allTools)}.map(Object.freeze)), writable: false, configurable: false
      });
      Object.defineProperty(globalThis, 'text', {
        value: (value) => {
          if (typeof value === 'string') __outputs.push(value);
          else {
            const encoded = JSON.stringify(value);
            __outputs.push(encoded === undefined ? String(value) : encoded);
          }
        }, writable: false, configurable: false
      });
      Object.defineProperty(globalThis, 'exit', {
        value: (value) => { throw { marker: __exit, value }; }, writable: false, configurable: false
      });
      for (const name of ['process', 'require', 'Buffer', 'console', 'Atomics', 'SharedArrayBuffer', 'WebAssembly', 'fetch', 'XMLHttpRequest', 'WebSocket']) {
        Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
      }
      return (async () => {
        try {
          const value = await (async () => { ${message.source}\n })();
          if (value !== undefined) text(value);
        } catch (error) {
          if (error && error.marker === __exit) {
            if (error.value !== undefined) text(error.value);
          } else {
            throw error;
          }
        }
        return JSON.stringify(__outputs);
      })();
    })()
  `;

  try {
    const evaluated = context.evalCode(program, 'code-mode.js');
    const promiseHandle = context.unwrapResult(evaluated);
    const settled = context.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    pump();
    const result = context.unwrapResult(await settled);
    const outputJson = context.getString(result);
    result.dispose();
    workerPort.postMessage({
      type: 'completed',
      outputs: JSON.parse(outputJson) as unknown[],
    });
  } catch (error) {
    workerPort.postMessage({ type: 'failed', error: errorMessage(error) });
  } finally {
    workerPort.off('message', onMessage);
    for (const call of deferred.values()) call.dispose();
    deferred.clear();
    context.dispose();
    runtime.dispose();
  }
}

workerPort.once('message', (message: StartMessage) => {
  void run(message).finally(() => workerPort.close());
});
