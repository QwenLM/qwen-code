/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads';
import { FileIndexCore } from './fileIndexCore.js';
import type { FileSearchOptions } from './fileSearch.js';

type WorkerRequest =
  | { type: 'start' }
  | {
      type: 'search';
      reqId: string;
      pattern: string;
      maxResults?: number;
    }
  | { type: 'abort'; reqId: string }
  | { type: 'dispose' };

type WorkerResponse =
  | { type: 'partial'; chunk: string[] }
  | { type: 'ready'; total: number }
  | { type: 'crawlError'; error: string }
  | { type: 'searchResult'; reqId: string; results: string[] }
  | { type: 'searchError'; reqId: string; error: string; name: string };

if (!parentPort) {
  throw new Error('fileIndexWorker must be launched as a Worker thread.');
}

const options = workerData.options as FileSearchOptions;
const core = new FileIndexCore(options);
const inflightAborts = new Map<string, AbortController>();
let started = false;

const send = (msg: WorkerResponse) => parentPort!.postMessage(msg);

parentPort.on('message', (msg: WorkerRequest) => {
  switch (msg.type) {
    case 'start': {
      if (started) return;
      started = true;
      (async () => {
        try {
          await core.startCrawl((chunk) => send({ type: 'partial', chunk }));
          core.buildFzfIndex();
          send({ type: 'ready', total: core.snapshotSize });
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
      const controller = new AbortController();
      inflightAborts.set(reqId, controller);
      (async () => {
        try {
          const results = await core.search(pattern, {
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
      inflightAborts.get(msg.reqId)?.abort();
      return;
    }
    case 'dispose': {
      inflightAborts.forEach((c) => c.abort());
      inflightAborts.clear();
      // Allow pending messages to flush, then exit.
      setImmediate(() => process.exit(0));
      return;
    }
    default: {
      // Unknown message; ignore. Keeps worker forward-compatible.
      return;
    }
  }
});
