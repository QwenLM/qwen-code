/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { UiRuntime } from './runtime.js';
import type { UiWorkerRequest, UiWorkerResponse } from './runtime-contract.js';

let runtime: UiRuntime | undefined;
let started = false;
let stopped = false;
let busy = false;

self.onmessage = async (message: MessageEvent<UiWorkerRequest>) => {
  if (stopped) return;
  const request = message.data;
  const sequence = Number.isSafeInteger(request?.sequence)
    ? request.sequence
    : -1;
  const respond = (response: UiWorkerResponse) => self.postMessage(response);
  try {
    if (busy || sequence < 0) throw new Error('Invalid UI runtime request.');
    busy = true;
    if (request.type === 'init' && !started) {
      started = true;
      const module = await newQuickJSWASMModuleFromVariant(variant);
      if (stopped) return;
      runtime = new UiRuntime(module);
      respond({
        sequence,
        patches: runtime.initialize(request.javascript, request.inputs),
      });
    } else if (request.type === 'event' && runtime) {
      respond({
        sequence,
        patches: runtime.dispatch(request.event, request.inputs),
      });
    } else {
      throw new Error('UI runtime requires one initialization.');
    }
  } catch (error) {
    stopped = true;
    try {
      runtime?.dispose();
    } finally {
      respond({
        sequence,
        error:
          error instanceof Error
            ? error.message.slice(0, 200)
            : 'Generated JavaScript failed.',
      });
      self.close();
    }
  } finally {
    busy = false;
  }
};
