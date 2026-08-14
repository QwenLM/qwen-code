/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocket } from 'ws';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import type {
  DeliveryResult,
  TransportCloseReason,
  TransportStream,
} from './transport-stream.js';

export class WsStream implements TransportStream {
  readonly kind = 'ws' as const;

  private writeChain: Promise<void> = Promise.resolve();
  private _closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly activeSendClosers = new Set<() => void>();

  constructor(
    private readonly ws: WebSocket,
    private readonly onClose?: () => void,
    private readonly onHeartbeat?: () => void,
  ) {
    ws.on('close', () => this.close());
    ws.on('error', (err) => {
      this.close();
      writeStderrLineSafe(
        `qwen serve: /acp WS error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    this.heartbeat = setInterval(() => {
      if (this._closed) return;
      if (!alive) {
        this.close();
        return;
      }
      alive = false;
      try {
        this.onHeartbeat?.();
      } catch {
        /* swallow — heartbeat callback must not crash the interval */
      }
      try {
        this.ws.ping();
      } catch {
        /* socket may be gone */
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  // `_id` (bus event id) is accepted for `TransportStream` parity but ignored:
  // WebSocket is a stateful connection with no SSE `Last-Event-ID` replay
  // (matches `AcpWsTransport.supportsReplay = false`).
  send(message: unknown, _id?: number): Promise<void> {
    const data = JSON.stringify(message);
    return this.enqueueSend(data).then(() => undefined);
  }

  sendSerialized(data: Buffer, _id?: number): Promise<DeliveryResult> {
    return this.enqueueSend(data, { binary: false });
  }

  private enqueueSend(
    data: string | Buffer,
    options?: { binary: boolean },
  ): Promise<DeliveryResult> {
    const next = this.writeChain
      .then(
        () =>
          new Promise<DeliveryResult>((resolve) => {
            if (this._closed) {
              resolve('closed');
              return;
            }
            let settled = false;
            const settle = (result: DeliveryResult) => {
              if (settled) return;
              settled = true;
              this.activeSendClosers.delete(onSocketClose);
              resolve(result);
            };
            const onSocketClose = () => settle('outcome_unknown');
            const callback = (err?: Error) => {
              settle(err ? 'outcome_unknown' : 'delivered');
              if (err) this.close();
            };
            if (this.ws.readyState !== this.ws.OPEN) {
              settle('closed');
              return;
            }
            this.activeSendClosers.add(onSocketClose);
            try {
              if (options) this.ws.send(data, options, callback);
              else this.ws.send(data, callback);
            } catch {
              settle('failed');
            }
          }),
      )
      .catch(() => 'failed' as const);
    this.writeChain = next.then((result) => {
      if (result === 'failed' && !this._closed) {
        this.close();
        writeStderrLineSafe('qwen serve: /acp WS write failed');
      }
    });
    return next;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  close(closeReason?: TransportCloseReason): void {
    if (this._closed) return;
    this._closed = true;
    for (const settle of this.activeSendClosers) settle();
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close(closeReason?.code ?? 1000, closeReason?.reason);
      }
    } catch {
      /* socket gone */
    }
    try {
      this.onClose?.();
    } catch (err) {
      writeStderrLineSafe(
        `qwen serve: /acp WS onClose threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
