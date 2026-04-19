/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { FileIndexCore } from './fileIndexCore.js';
import type { FileSearchOptions, SearchOptions } from './fileSearch.js';
import { AbortError } from './fileSearch.js';

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

type ServiceState = 'crawling' | 'ready' | 'error';

/**
 * Abstraction over the transport between `FileIndexService` and the file
 * index engine. The default backend spawns a Node.js worker thread; tests
 * and environments where worker spawning is problematic (e.g. vitest with
 * TypeScript sources) use an in-process backend that executes `FileIndexCore`
 * on the main thread behind the same message interface.
 */
interface IndexTransport {
  post(msg: WorkerRequest): void;
  onMessage(cb: (msg: WorkerResponse) => void): () => void;
  onExit(cb: (code: number) => void): () => void;
  terminate(): Promise<void>;
}

function createWorkerTransport(options: FileSearchOptions): IndexTransport {
  const worker = new Worker(new URL('./fileIndexWorker.js', import.meta.url), {
    workerData: { options },
  });
  return {
    post: (msg) => worker.postMessage(msg),
    onMessage: (cb) => {
      const listener = (m: WorkerResponse) => cb(m);
      worker.on('message', listener);
      return () => worker.off('message', listener);
    },
    onExit: (cb) => {
      const listener = (code: number) => cb(code);
      worker.on('exit', listener);
      return () => worker.off('exit', listener);
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}

function createInProcessTransport(options: FileSearchOptions): IndexTransport {
  const core = new FileIndexCore(options);
  const listeners = new Set<(msg: WorkerResponse) => void>();
  const exitListeners = new Set<(code: number) => void>();
  const inflight = new Map<string, AbortController>();
  let started = false;
  let disposed = false;

  const emit = (msg: WorkerResponse) => {
    // Deliver asynchronously so subscribers resemble the real worker timing.
    setImmediate(() => {
      if (disposed) return;
      listeners.forEach((cb) => cb(msg));
    });
  };

  return {
    post: (msg) => {
      if (disposed) return;
      switch (msg.type) {
        case 'start': {
          if (started) return;
          started = true;
          (async () => {
            try {
              await core.startCrawl((chunk) =>
                emit({ type: 'partial', chunk }),
              );
              core.buildFzfIndex();
              emit({ type: 'ready', total: core.snapshotSize });
            } catch (e) {
              emit({
                type: 'crawlError',
                error: e instanceof Error ? e.message : String(e),
              });
            }
          })();
          return;
        }
        case 'search': {
          const controller = new AbortController();
          inflight.set(msg.reqId, controller);
          (async () => {
            try {
              const results = await core.search(msg.pattern, {
                signal: controller.signal,
                maxResults: msg.maxResults,
              });
              emit({ type: 'searchResult', reqId: msg.reqId, results });
            } catch (e) {
              const error = e instanceof Error ? e : new Error(String(e));
              emit({
                type: 'searchError',
                reqId: msg.reqId,
                error: error.message,
                name: error.name,
              });
            } finally {
              inflight.delete(msg.reqId);
            }
          })();
          return;
        }
        case 'abort':
          inflight.get(msg.reqId)?.abort();
          return;
        case 'dispose':
          disposed = true;
          inflight.forEach((c) => c.abort());
          inflight.clear();
          exitListeners.forEach((cb) => cb(0));
          return;
        default:
          return;
      }
    },
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    terminate: async () => {
      disposed = true;
      inflight.forEach((c) => c.abort());
      inflight.clear();
      exitListeners.forEach((cb) => cb(0));
    },
  };
}

let transportFactory: (options: FileSearchOptions) => IndexTransport = process
  .env['VITEST']
  ? createInProcessTransport
  : createWorkerTransport;

/**
 * Override the transport factory. Intended for tests that need to exercise
 * the in-process backend or inject a fake. Returns a restore function.
 */
export function __setIndexTransportFactory(
  factory: (options: FileSearchOptions) => IndexTransport,
): () => void {
  const prev = transportFactory;
  transportFactory = factory;
  return () => {
    transportFactory = prev;
  };
}

export interface FileIndexServiceState {
  state: ServiceState;
  snapshotSize: number;
}

const INSTANCES = new Map<string, FileIndexService>();

function optionsKey(options: FileSearchOptions): string {
  const serializable = {
    projectRoot: options.projectRoot,
    ignoreDirs: [...options.ignoreDirs].sort(),
    useGitignore: options.useGitignore,
    useQwenignore: options.useQwenignore,
    enableFuzzySearch: options.enableFuzzySearch,
    enableRecursiveFileSearch: options.enableRecursiveFileSearch,
    maxDepth: options.maxDepth ?? null,
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(serializable))
    .digest('hex');
}

/**
 * Owns the file index worker for a given project. Callers obtain a singleton
 * instance per unique options hash via `FileIndexService.for(...)`. The
 * instance spins up immediately and begins crawling; `search()` can be
 * invoked at any time and will be served against whatever snapshot has been
 * streamed in so far.
 */
export class FileIndexService {
  static for(options: FileSearchOptions): FileIndexService {
    const key = optionsKey(options);
    const existing = INSTANCES.get(key);
    if (existing && !existing.disposed) return existing;
    const instance = new FileIndexService(options, key);
    INSTANCES.set(key, instance);
    return instance;
  }

  /** For tests: drop all cached singletons and dispose them. */
  static async __resetForTests(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const inst of INSTANCES.values()) pending.push(inst.dispose());
    INSTANCES.clear();
    await Promise.all(pending);
  }

  private transport: IndexTransport;
  private _state: ServiceState = 'crawling';
  private _snapshotSize = 0;
  private pending = new Map<
    string,
    { resolve: (r: string[]) => void; reject: (e: Error) => void }
  >();
  private partialSubs = new Set<(snapshotSize: number) => void>();
  private readySubs = new Set<() => void>();
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private nextReqId = 0;
  private disposed = false;
  private unsubscribeMessage: () => void;
  private unsubscribeExit: () => void;

  private constructor(
    options: FileSearchOptions,
    private readonly key: string,
  ) {
    this.transport = transportFactory(options);
    this.unsubscribeMessage = this.transport.onMessage(this.handleMessage);
    this.unsubscribeExit = this.transport.onExit(this.handleExit);
    this.transport.post({ type: 'start' });
  }

  get state(): ServiceState {
    return this._state;
  }

  get snapshotSize(): number {
    return this._snapshotSize;
  }

  /**
   * Subscribe to partial snapshot growth. The callback fires on every
   * streamed chunk (with the running total) and once more when the crawl
   * completes. Returns an unsubscribe function.
   */
  onPartial(cb: (snapshotSize: number) => void): () => void {
    this.partialSubs.add(cb);
    return () => {
      this.partialSubs.delete(cb);
    };
  }

  /** Subscribe to the single "crawl done" event. */
  onReady(cb: () => void): () => void {
    if (this._state === 'ready') {
      setImmediate(cb);
      return () => {};
    }
    this.readySubs.add(cb);
    return () => {
      this.readySubs.delete(cb);
    };
  }

  /**
   * Resolves once the initial crawl has finished (or rejects if the worker
   * errored or exited). Used by the `FileSearch` proxy to preserve its
   * original "initialize awaits full readiness" contract.
   */
  whenReady(): Promise<void> {
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'error')
      return Promise.reject(new Error('File index worker errored'));
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  async search(
    pattern: string,
    options: SearchOptions = {},
  ): Promise<string[]> {
    if (this.disposed) throw new Error('FileIndexService has been disposed');

    const reqId = `r${this.nextReqId++}`;
    return new Promise<string[]>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });

      if (options.signal) {
        if (options.signal.aborted) {
          this.pending.delete(reqId);
          const e = new Error('Search aborted');
          e.name = 'AbortError';
          reject(e);
          return;
        }
        const onAbort = () => {
          this.transport.post({ type: 'abort', reqId });
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        // Clean up the abort listener once the request settles.
        const entry = this.pending.get(reqId)!;
        const origResolve = entry.resolve;
        const origReject = entry.reject;
        entry.resolve = (r) => {
          options.signal?.removeEventListener('abort', onAbort);
          origResolve(r);
        };
        entry.reject = (e) => {
          options.signal?.removeEventListener('abort', onAbort);
          origReject(e);
        };
      }

      this.transport.post({
        type: 'search',
        reqId,
        pattern,
        maxResults: options.maxResults,
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    INSTANCES.delete(this.key);
    this.transport.post({ type: 'dispose' });
    this.unsubscribeMessage();
    this.unsubscribeExit();
    await this.transport.terminate();
    const err = new Error('FileIndexService disposed');
    err.name = 'AbortError';
    this.pending.forEach(({ reject }) => reject(err));
    this.pending.clear();
  }

  private handleMessage = (msg: WorkerResponse) => {
    switch (msg.type) {
      case 'partial':
        this._snapshotSize += msg.chunk.length;
        this.partialSubs.forEach((cb) => cb(this._snapshotSize));
        return;
      case 'ready': {
        this._state = 'ready';
        this._snapshotSize = msg.total;
        this.partialSubs.forEach((cb) => cb(msg.total));
        this.readySubs.forEach((cb) => cb());
        this.readySubs.clear();
        const waiters = this.readyWaiters.splice(0);
        waiters.forEach((w) => w.resolve());
        return;
      }
      case 'crawlError': {
        this._state = 'error';
        const err = new Error(msg.error);
        const rejectees = this.readyWaiters.splice(0);
        rejectees.forEach((w) => w.reject(err));
        return;
      }
      case 'searchResult': {
        const pend = this.pending.get(msg.reqId);
        if (!pend) return;
        this.pending.delete(msg.reqId);
        pend.resolve(msg.results);
        return;
      }
      case 'searchError': {
        const pend = this.pending.get(msg.reqId);
        if (!pend) return;
        this.pending.delete(msg.reqId);
        // Preserve AbortError class identity so callers can use `instanceof`.
        // Other errors fall back to a plain Error with the original name.
        let e: Error;
        if (msg.name === 'AbortError') {
          e = new AbortError(msg.error);
        } else {
          e = new Error(msg.error);
          e.name = msg.name || 'Error';
        }
        pend.reject(e);
        return;
      }
      default:
        return;
    }
  };

  private handleExit = (_code: number) => {
    // Worker died; fail outstanding requests so callers don't hang.
    const err = new Error('File index worker exited');
    err.name = 'Error';
    this.pending.forEach(({ reject }) => reject(err));
    this.pending.clear();
    const waiters = this.readyWaiters.splice(0);
    waiters.forEach((w) => w.reject(err));
    INSTANCES.delete(this.key);
    this.disposed = true;
  };
}
