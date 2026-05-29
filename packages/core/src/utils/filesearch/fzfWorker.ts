/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worker entry that owns an AsyncFzf instance.
 *
 * `new AsyncFzf(allFiles, ...)` is misleadingly named — its constructor is
 * synchronous and dominates the main-thread cost on large workspaces (>20k
 * files), freezing the Ink render loop while the @-picker initializes. By
 * hosting the instance in a worker thread the construction work happens off
 * the main thread; only completed find() results cross the message channel.
 *
 * Protocol (one round per message; no streaming or backpressure):
 *
 *   main → worker:  { type: 'init', files, options }            (once)
 *   worker → main:  { type: 'ready' }                           (after init OK)
 *   worker → main:  { type: 'init-error', message }             (init threw)
 *   main → worker:  { type: 'find', reqId, pattern }
 *   worker → main:  { type: 'result', reqId, items }
 *   worker → main:  { type: 'find-error', reqId, message }
 *   main → worker:  { type: 'dispose' }                         (closes port)
 */

import { parentPort } from 'node:worker_threads';
import { AsyncFzf, type FzfResultItem } from 'fzf';

interface InitMessage {
  type: 'init';
  files: string[];
  options: { fuzzy: 'v1' | 'v2' | false };
}

interface FindMessage {
  type: 'find';
  reqId: number;
  pattern: string;
}

interface DisposeMessage {
  type: 'dispose';
}

type IncomingMessage = InitMessage | FindMessage | DisposeMessage;

if (!parentPort) {
  throw new Error('fzfWorker.ts must be loaded as a worker_threads worker');
}

const port = parentPort;

let fzf: AsyncFzf<string[]> | null = null;

port.on('message', (msg: IncomingMessage) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    try {
      fzf = new AsyncFzf<string[]>(msg.files, msg.options);
      port.postMessage({ type: 'ready' });
    } catch (err) {
      port.postMessage({
        type: 'init-error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === 'find') {
    if (!fzf) {
      port.postMessage({
        type: 'find-error',
        reqId: msg.reqId,
        message: 'fzf not initialized',
      });
      return;
    }
    fzf
      .find(msg.pattern)
      .then((items: Array<FzfResultItem<string>>) => {
        // Strip the heavy `positions` Set from each item before sending —
        // structuredClone serialises Sets but the @-picker only needs the
        // ranked `item` strings. Keeps IPC payloads small on big result sets.
        const trimmed = items.map((entry) => ({ item: entry.item }));
        port.postMessage({ type: 'result', reqId: msg.reqId, items: trimmed });
      })
      .catch((err: unknown) => {
        port.postMessage({
          type: 'find-error',
          reqId: msg.reqId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return;
  }

  if (msg.type === 'dispose') {
    fzf = null;
    port.close();
    return;
  }
});
