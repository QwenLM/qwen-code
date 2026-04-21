/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads';
import { FileIndexCore } from './fileIndexCore.js';
import type { FileSearchOptions } from './fileSearch.js';
import type { WorkerRequest, WorkerResponse } from './fileIndexProtocol.js';

if (!parentPort) {
  throw new Error('fileIndexWorker must be launched as a Worker thread.');
}

const send = (msg: WorkerResponse) => parentPort!.postMessage(msg);

// Constructing the core can throw (e.g. a projectRoot with a NUL byte causes
// loadIgnoreRules → fs.existsSync to fault). Surface such failures via the
// normal `crawlError` channel instead of letting the worker die with an
// uncaught exception before its message handler is even attached — the
// main-thread service then treats it identically to a crawl-time failure.
let core: FileIndexCore | undefined;
let initError: string | undefined;
try {
  core = new FileIndexCore(workerData.options as FileSearchOptions);
} catch (e) {
  initError = e instanceof Error ? e.message : String(e);
}

const inflightAborts = new Map<string, AbortController>();
let started = false;

parentPort.on('message', (msg: WorkerRequest) => {
  if (initError || !core) {
    // Every message before the main thread sees the crawlError would otherwise
    // hang or produce confusing behaviour; reply with crawlError / searchError
    // as appropriate and ignore abort/dispose (nothing to clean up).
    if (msg?.type === 'start') {
      send({ type: 'crawlError', error: initError ?? 'core init failed' });
    } else if (msg?.type === 'search' && typeof msg.reqId === 'string') {
      send({
        type: 'searchError',
        reqId: msg.reqId,
        error: initError ?? 'core init failed',
        name: 'Error',
      });
    }
    return;
  }
  switch (msg.type) {
    case 'start': {
      if (started) return;
      started = true;
      (async () => {
        try {
          await core!.startCrawl((chunk) => send({ type: 'partial', chunk }));
          core!.buildFzfIndex();
          send({ type: 'ready', total: core!.snapshotSize });
        } catch (e) {
          send({
            type: 'crawlError',
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return;
    }
    case 'search': {
      const { reqId, pattern, maxResults } = msg;
      // Defensive: reject malformed IPC shape instead of crashing the worker.
      // In the current protocol reqId/pattern are always strings, but a
      // future caller could desynchronise and we'd rather fail one request
      // than all of them.
      if (typeof reqId !== 'string') return;
      if (typeof pattern !== 'string') {
        send({
          type: 'searchError',
          reqId,
          error: 'pattern must be a string',
          name: 'TypeError',
        });
        return;
      }
      const controller = new AbortController();
      inflightAborts.set(reqId, controller);
      (async () => {
        try {
          const results = await core!.search(pattern, {
            signal: controller.signal,
            maxResults,
          });
          send({ type: 'searchResult', reqId, results });
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          send({
            type: 'searchError',
            reqId,
            error: error.message,
            name: error.name,
          });
        } finally {
          inflightAborts.delete(reqId);
        }
      })();
      return;
    }
    case 'abort': {
      if (typeof msg.reqId === 'string') {
        inflightAborts.get(msg.reqId)?.abort();
      }
      return;
    }
    case 'dispose': {
      // Abort any in-flight searches so their message handlers can finish
      // posting their `searchError` reply before we tear down the channel.
      inflightAborts.forEach((c) => c.abort());
      inflightAborts.clear();
      // Closing the message port lets Node drain any pending
      // `postMessage` calls (searchError/searchResult replies queued in the
      // current tick) before the worker actually exits. Using
      // `process.exit(0)` would race those sends and occasionally drop them.
      parentPort!.close();
      return;
    }
    default: {
      // Unknown message; ignore. Keeps worker forward-compatible.
      return;
    }
  }
});
