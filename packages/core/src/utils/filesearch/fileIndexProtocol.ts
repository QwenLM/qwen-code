/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC message shapes shared between the main-thread `FileIndexService` and
 * the worker-thread `fileIndexWorker`. Defined in one place so the two
 * sides cannot silently diverge — a new message variant here becomes a
 * compile error on whichever side forgot to handle it.
 */

export type WorkerRequest =
  | { type: 'start' }
  | {
      type: 'search';
      reqId: string;
      pattern: string;
      maxResults?: number;
    }
  | { type: 'abort'; reqId: string }
  | { type: 'dispose' };

export type WorkerResponse =
  | { type: 'partial'; chunk: string[] }
  | { type: 'ready'; total: number }
  | { type: 'crawlError'; error: string }
  | { type: 'searchResult'; reqId: string; results: string[] }
  | { type: 'searchError'; reqId: string; error: string; name: string };
