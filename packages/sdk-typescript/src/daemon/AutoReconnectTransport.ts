/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from './types.js';
import type {
  DaemonTransport,
  DaemonTransportFetchOptions,
  DaemonTransportSubscribeOptions,
  DaemonTransportType,
} from './DaemonTransport.js';
import { DaemonTransportClosedError } from './DaemonTransport.js';
import { RestSseTransport } from './RestSseTransport.js';

/**
 * Factory function that creates a transport given the type hint.
 * The caller supplies this to `AutoReconnectTransport` so the
 * reconnect logic can recreate the preferred transport without
 * importing every concrete class itself.
 */
export type TransportFactory = (
  type: DaemonTransportType,
) => DaemonTransport | Promise<DaemonTransport>;

/**
 * Optional wrapper transport that handles reconnection on
 * `DaemonTransportClosedError`.
 *
 * On a transport-closed error:
 *   1. Attempt to recreate the preferred transport via `factory`.
 *   2. If that fails, fall back to a `RestSseTransport` (always works
 *      against a daemon that's still running).
 *   3. Re-initialize the new transport and retry the failed call.
 *
 * **Session-level recovery** (re-attaching the ACP session) is NOT
 * handled here — the caller must `session/load` after the transport
 * layer reconnects. This transport only provides transport-level
 * reconnection.
 */
export class AutoReconnectTransport implements DaemonTransport {
  private inner: DaemonTransport;
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly preferredType: DaemonTransportType;
  private readonly factory?: TransportFactory;
  private _disposed = false;

  /** Mutex: only one reconnect attempt at a time. */
  private reconnecting: Promise<void> | undefined;

  readonly supportsReplay: boolean;

  constructor(opts: {
    baseUrl: string;
    token?: string;
    fetch?: typeof globalThis.fetch;
    preferredType?: DaemonTransportType;
    factory?: TransportFactory;
    initial?: DaemonTransport;
  }) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.preferredType = opts.preferredType ?? 'rest';
    this.factory = opts.factory;
    this.inner =
      opts.initial ??
      new RestSseTransport(this.baseUrl, this.token, this.fetchFn);
    this.supportsReplay = this.inner.supportsReplay;
  }

  get type(): DaemonTransportType {
    return this.inner.type;
  }

  get connected(): boolean {
    return !this._disposed && this.inner.connected;
  }

  async fetch(
    url: string,
    init: RequestInit,
    opts?: DaemonTransportFetchOptions,
  ): Promise<Response> {
    if (this._disposed) throw new DaemonTransportClosedError();

    try {
      return await this.inner.fetch(url, init, opts);
    } catch (err) {
      if (err instanceof DaemonTransportClosedError && !this._disposed) {
        await this.reconnect();
        return this.inner.fetch(url, init, opts);
      }
      throw err;
    }
  }

  async *subscribeEvents(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    if (this._disposed) throw new DaemonTransportClosedError();

    try {
      yield* this.inner.subscribeEvents(sessionId, opts);
    } catch (err) {
      if (err instanceof DaemonTransportClosedError && !this._disposed) {
        await this.reconnect();
        yield* this.inner.subscribeEvents(sessionId, opts);
      } else {
        throw err;
      }
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.inner.dispose();
  }

  // -- Internal ----------------------------------------------------------

  private async reconnect(): Promise<void> {
    // Mutex: if a reconnect is already in progress, wait for it
    // instead of starting a concurrent attempt (reconnect storm).
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = this._doReconnect().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  private async _doReconnect(): Promise<void> {
    // Dispose the old transport.
    try {
      this.inner.dispose();
    } catch {
      /* already disposed */
    }

    // Try preferred transport via factory.
    if (this.factory) {
      try {
        this.inner = await this.factory(this.preferredType);
        return;
      } catch {
        // Factory failed — fall back to REST.
      }
    }

    // Fallback: create a fresh RestSseTransport.
    this.inner = new RestSseTransport(this.baseUrl, this.token, this.fetchFn);
  }
}
