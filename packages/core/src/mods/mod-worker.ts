/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort } from 'node:worker_threads';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { MOD_GUEST_FACTORY } from './guest.js';
import {
  MOD_END_TIMEOUT_MS,
  MOD_MAX_BYTES,
  MOD_TIMEOUT_MS,
  type ModReply,
  type ModRequest,
} from './types.js';

const port = parentPort!;
const wasm = await newQuickJSWASMModuleFromVariant(variant);
const runtime = wasm.newRuntime();
runtime.setMemoryLimit(64 * 1024 * 1024);
runtime.setMaxStackSize(1024 * 1024);
runtime.setModuleLoader(() => {
  throw new Error(
    'Mod imports are not supported yet; use a self-contained JS module.',
  );
});
let deadline = Infinity;
runtime.setInterruptHandler(() => Date.now() >= deadline);
const vm = runtime.newContext();
const send = (reply: ModReply) => port.postMessage(reply);
let logChars = 0;
const log = vm.newFunction('modLog', (text, sink) => {
  const value = vm.getString(text);
  const to = vm.getString(sink);
  logChars += value.length + 1;
  if (logChars > 100_000 || (to !== 'debug' && to !== 'transcript')) {
    throw new Error('Mod log budget exceeded.');
  }
  send({ type: 'log', text: value, to });
});
const factory = vm.unwrapResult(vm.evalCode(MOD_GUEST_FACTORY, 'mod-host.js'));
const guest = vm.unwrapResult(vm.callFunction(factory, vm.undefined, log));
factory.dispose();
log.dispose();

async function settle(handle: QuickJSHandle): Promise<QuickJSHandle> {
  const result = vm.resolvePromise(handle);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  while (!settled) {
    const jobs = runtime.executePendingJobs(100);
    if (jobs.error) {
      const message = String(vm.dump(jobs.error));
      jobs.error.dispose();
      throw new Error(message);
    }
    if (jobs.value === 0) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return vm.unwrapResult(await result);
}

let loaded = false;
let busy = false;
port.on('message', async (request: ModRequest) => {
  if (busy) {
    send({
      type: 'error',
      message: 'Concurrent Mod dispatch is not supported.',
    });
    return;
  }
  busy = true;
  logChars = 0;
  deadline =
    Date.now() + (request.type === 'end' ? MOD_END_TIMEOUT_MS : MOD_TIMEOUT_MS);
  try {
    let pending: QuickJSHandle;
    if (request.type === 'load') {
      if (loaded) throw new Error('Mod already loaded.');
      if (Buffer.byteLength(request.source) > MOD_MAX_BYTES)
        throw new Error('Mod source is too large.');
      const evaluation = vm.unwrapResult(
        vm.evalCode(request.source, 'mod.mjs', { type: 'module' }),
      );
      let namespace: QuickJSHandle;
      try {
        namespace = await settle(evaluation);
      } finally {
        evaluation.dispose();
      }
      const register = vm.getProp(namespace, 'register');
      const cwd = vm.newString(request.cwd);
      try {
        pending = vm.unwrapResult(
          vm.callMethod(guest, 'load', [register, cwd]),
        );
      } finally {
        register.dispose();
        cwd.dispose();
        namespace.dispose();
      }
      loaded = true;
    } else {
      if (!loaded) throw new Error('Mod is not loaded.');
      const input = vm.newString(JSON.stringify(request));
      try {
        pending = vm.unwrapResult(vm.callMethod(guest, 'dispatch', [input]));
      } finally {
        input.dispose();
      }
    }
    try {
      const value = await settle(pending);
      try {
        const json = vm.getString(value);
        if (Buffer.byteLength(json) > MOD_MAX_BYTES)
          throw new Error('Mod result is too large.');
        send({ type: 'result', json });
      } finally {
        value.dispose();
      }
    } finally {
      pending.dispose();
    }
  } catch (error) {
    send({ type: 'error', message: String(error).slice(0, 4000) });
  } finally {
    deadline = Infinity;
    busy = false;
  }
});
