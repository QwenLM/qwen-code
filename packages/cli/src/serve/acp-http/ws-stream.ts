/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocket } from 'ws';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { TransportStream } from './transport-stream.js';

export class WsStream implements TransportStream {
  readonly kind = 'ws' as const;

  private writeChain: Promise<void> = Promise.resolve();
  private _closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly onClose?: () => void,
    private readonly onHeartbeat?: () => void,
  ) {
    ws.on('close', () => this.close());
    ws.on('error', (err) => {
      writeStderrLine(
        `qwen serve: /acp WS error: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.close();
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

  send(message: unknown): Promise<void> {
    const data = JSON.stringify(message);
    const next = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this._closed) {
            resolve();
            return;
          }
          this.ws.send(data, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    );
    this.writeChain = next.catch((err: unknown) => {
      if (!this._closed) {
        writeStderrLine(
          `qwen serve: /acp WS write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.close();
      }
    });
    return this.writeChain;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000);
    } catch {
      /* socket gone */
    }
    try {
      this.onClose?.();
    } catch (err) {
      writeStderrLine(
        `qwen serve: /acp WS onClose threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
