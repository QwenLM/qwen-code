/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonClient } from '@qwen-code/sdk/daemon';
import type {
  DaemonCapabilities,
  DaemonClientOptions,
  DaemonTransport,
} from '@qwen-code/sdk/daemon';

export type DaemonAvailabilityState =
  | 'available'
  | 'unavailable'
  | 'auth-required';

export class DaemonUnavailableError extends Error {
  constructor() {
    super('The daemon is unavailable. Automatic refresh is paused.');
    this.name = 'DaemonUnavailableError';
  }
}

export function isDaemonUnavailableError(error: unknown): boolean {
  return error instanceof DaemonUnavailableError;
}

const connections = new Map<
  string,
  Set<{ availability: DaemonAvailability }>
>();
const clientConnections = new WeakMap<DaemonClient, DaemonAvailability>();
const keyOf = (baseUrl: string, token?: string) => {
  const resolved =
    typeof window === 'undefined'
      ? baseUrl
      : new URL(baseUrl || '/', window.location.origin).href;
  return JSON.stringify([resolved.replace(/\/+$/, ''), token ?? '']);
};

export function findDaemonAvailability(
  baseUrl: string,
  token?: string,
  client?: DaemonClient,
) {
  const owner = client && clientConnections.get(client);
  if (owner) return owner;
  const entries = connections.get(keyOf(baseUrl, token));
  return entries ? [...entries].at(-1)?.availability : undefined;
}

export function registerDaemonAvailability(
  baseUrl: string,
  token: string | undefined,
  availability: DaemonAvailability,
): () => void {
  const key = keyOf(baseUrl, token);
  const entry = { availability };
  const entries = connections.get(key) ?? new Set<typeof entry>();
  entries.add(entry);
  connections.set(key, entries);
  return () => {
    if (entries.delete(entry) && entries.size === 0) connections.delete(key);
  };
}

const PROBE_TIMEOUT_MS = 5_000;
// A front proxy or rate limiter may ask for minutes; parking the shell past
// operator patience is worse than re-probing a little early.
const MAX_RETRY_AFTER_MS = 30_000;

function retryAfterMsFrom(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  const requested = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(requested)) return undefined;
  return Math.max(0, Math.min(requested, MAX_RETRY_AFTER_MS));
}

/** One recovery loop for all requests owned by an active daemon connection. */
export class DaemonAvailability {
  private state: DaemonAvailabilityState = 'available';
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private probe?: Promise<void>;
  private controller?: AbortController;
  private attempt = 0;
  private generation = 0;
  private disposed = false;
  recoveredCapabilities?: DaemonCapabilities;

  constructor(
    private baseUrl: string,
    private token?: string,
    private nativeFetch: typeof globalThis.fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  getSnapshot = (): DaemonAvailabilityState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(state: DaemonAvailabilityState) {
    // Successful diagnostics also publish fresh capabilities without an outage.
    if (this.disposed || (this.state === state && state !== 'available'))
      return;
    if (this.state === 'available' && state !== 'available') this.generation++;
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  assertAvailable() {
    if (this.disposed || this.state !== 'available') {
      throw new DaemonUnavailableError();
    }
  }

  waitUntilAvailable(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.disposed) return Promise.reject(new DaemonUnavailableError());
    if (this.state === 'available') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener('abort', aborted);
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason);
      };
      const unsubscribe = this.subscribe(() => {
        if (this.state === 'available' || this.disposed) {
          cleanup();
          if (this.disposed) reject(new DaemonUnavailableError());
          else resolve();
        }
      });
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  getGeneration(): number {
    return this.generation;
  }

  reportFailure(
    error: unknown,
    signal?: AbortSignal,
    generation = this.generation,
    source: 'fetch' | 'consumer' = 'consumer',
  ) {
    if (
      this.disposed ||
      generation !== this.generation ||
      isDaemonUnavailableError(error)
    )
      return;
    const failure = (signal?.aborted ? signal.reason : error) as {
      name?: string;
      status?: number;
      message?: string;
    };
    if (
      signal?.aborted &&
      (signal.reason as { name?: string } | undefined)?.name !== 'TimeoutError'
    ) {
      return;
    }
    if (
      (source === 'fetch' && failure?.name === 'TypeError') ||
      failure?.name === 'DaemonTransportClosedError' ||
      failure?.message?.endsWith(': network request failed')
    ) {
      if (this.state === 'available') {
        this.publish('unavailable');
        void this.check();
      }
    } else if (
      failure?.name === 'TypeError' ||
      failure?.name === 'TimeoutError' ||
      [401, 502, 503, 504].includes(failure?.status ?? 0)
    ) {
      if (this.state === 'available') void this.check();
    }
  }

  wrapFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => {
      const generation = this.generation;
      this.assertAvailable();
      try {
        const response = await fetch(input, init);
        this.reportFailure(
          { status: response.status },
          init?.signal ?? undefined,
          generation,
        );
        return response;
      } catch (error) {
        this.reportFailure(
          error,
          init?.signal ?? undefined,
          generation,
          'fetch',
        );
        throw error;
      }
    };
  }

  wrapTransport(transport: DaemonTransport): DaemonTransport {
    const waitUntilAvailable = this.waitUntilAvailable.bind(this);
    const reportFailure = this.reportFailure.bind(this);
    const getGeneration = this.getGeneration.bind(this);
    const assertAvailable = this.assertAvailable.bind(this);
    return {
      type: transport.type,
      supportsReplay: transport.supportsReplay,
      get connected() {
        return transport.connected;
      },
      restFetch: this.wrapFetch(transport.restFetch ?? this.nativeFetch),
      fetch: async (url, init, opts) => {
        const generation = this.generation;
        this.assertAvailable();
        try {
          const response = await transport.fetch(url, init, opts);
          this.reportFailure(
            { status: response.status },
            init.signal ?? undefined,
            generation,
          );
          return response;
        } catch (error) {
          this.reportFailure(
            error,
            init.signal ?? undefined,
            generation,
            'fetch',
          );
          throw error;
        }
      },
      async *subscribeEvents(sessionId, opts) {
        await waitUntilAvailable(opts.signal);
        assertAvailable();
        const generation = getGeneration();
        try {
          yield* transport.subscribeEvents(sessionId, opts);
        } catch (error) {
          reportFailure(error, opts.signal, generation);
          throw error;
        }
      },
      dispose: () => transport.dispose(),
    };
  }

  check = (immediate = false): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.probe) return this.probe;
    if (
      !immediate &&
      (this.timer !== undefined || this.state === 'auth-required')
    ) {
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.probe = Promise.resolve().then(() => this.runProbe());
    return this.probe;
  };

  private async runProbe() {
    if (this.disposed) return;
    const generation = this.generation;
    let superseded = false;
    const isCurrent = () => {
      if (this.disposed) return false;
      superseded = generation !== this.generation;
      return !superseded;
    };
    // Each leg gets its own deadline: a slow /health must not consume the
    // budget /capabilities needs to answer a cold-starting runtime.
    const probeFetch = async (url: string): Promise<Response> => {
      const controller = new AbortController();
      this.controller = controller;
      const timeout = setTimeout(
        () => controller.abort(new DOMException('timeout', 'TimeoutError')),
        PROBE_TIMEOUT_MS,
      );
      try {
        return await this.nativeFetch(url, {
          headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
          cache: 'no-store' as const,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        if (this.controller === controller) this.controller = undefined;
      }
    };
    let authenticated = true;
    let retryAfterMs: number | undefined;
    try {
      const health = await probeFetch(`${this.baseUrl}/health`);
      authenticated = health.status !== 401 && health.status !== 403;
      if (!health.ok) {
        retryAfterMs = retryAfterMsFrom(health);
        throw new Error('Daemon health check failed');
      }
      if ((await health.json()).status !== 'ok') {
        throw new Error('Daemon health check failed');
      }
      if (!isCurrent()) return;
      const response = await probeFetch(`${this.baseUrl}/capabilities`);
      authenticated = response.status !== 401 && response.status !== 403;
      if (!response.ok) {
        retryAfterMs = retryAfterMsFrom(response);
        throw new Error('Daemon capabilities check failed');
      }
      const capabilities = (await response.json()) as DaemonCapabilities;
      if (!Array.isArray(capabilities.features)) {
        throw new Error('Invalid daemon capabilities');
      }
      if (!isCurrent()) return;
      this.recoveredCapabilities = capabilities;
      this.attempt = 0;
      this.publish('available');
      superseded = generation !== this.generation;
    } catch {
      if (!isCurrent()) return;
      if (!authenticated) {
        this.publish('auth-required');
      } else {
        this.publish('unavailable');
        const delay =
          retryAfterMs ?? [5_000, 15_000, 30_000][Math.min(this.attempt++, 2)];
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.check();
        }, delay);
      }
    } finally {
      this.probe = undefined;
      // A diagnostic probe started before a new outage cannot reopen traffic.
      if (superseded && !this.disposed) void this.check();
    }
  }

  dispose() {
    this.disposed = true;
    this.state = 'unavailable';
    clearTimeout(this.timer);
    this.controller?.abort();
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

export function createDaemonClient(
  options: DaemonClientOptions,
  availability = findDaemonAvailability(options.baseUrl, options.token),
): DaemonClient {
  if (!availability) return new DaemonClient(options);
  const client = new DaemonClient({
    ...options,
    fetch: availability.wrapFetch(
      options.fetch ??
        options.transport?.restFetch ??
        globalThis.fetch.bind(globalThis),
    ),
    ...(options.transport
      ? { transport: availability.wrapTransport(options.transport) }
      : {}),
  });
  clientConnections.set(client, availability);
  return client;
}
