/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

export const WEB_BRIDGE_FRAME_TYPES = {
  call: 'webbridge_call',
  result: 'webbridge_result',
  resultChunk: 'webbridge_result_chunk',
} as const;

export interface WebBridgeCallFrame {
  type: 'webbridge_call';
  requestId: string;
  payload: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface WebBridgeResultFrame {
  type: 'webbridge_result';
  responseToRequestId: string;
  payload?: {
    data?: unknown;
    error?: string;
    timeout?: true;
    chunked?: boolean;
    encoding?: 'json';
  };
}

export interface WebBridgeEndpoint {
  connectionId: string;
  extensionId?: string;
  version?: string;
  send(frame: WebBridgeCallFrame): void;
}

interface PendingCall {
  connectionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  chunks: string[];
  chunkLength: number;
}

const MAX_RESULT_CHARS = 32 * 1024 * 1024;

export class WebBridgeUnavailableError extends Error {
  constructor(message = 'Qwen WebBridge extension is not connected') {
    super(message);
    this.name = 'WebBridgeUnavailableError';
  }
}

export class WebBridgeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebBridgeTimeoutError';
  }
}

export function isWebBridgeInboundFrameType(type: unknown): boolean {
  return (
    type === WEB_BRIDGE_FRAME_TYPES.result ||
    type === WEB_BRIDGE_FRAME_TYPES.resultChunk
  );
}

export class WebBridgeRegistry {
  private active: WebBridgeEndpoint | undefined;
  private readonly endpoints = new Map<string, WebBridgeEndpoint>();
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly timeoutMs = 60_000) {}

  register(endpoint: WebBridgeEndpoint): () => void {
    this.endpoints.delete(endpoint.connectionId);
    this.endpoints.set(endpoint.connectionId, endpoint);
    this.active = endpoint;
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      if (this.endpoints.get(endpoint.connectionId) !== endpoint) return;
      this.endpoints.delete(endpoint.connectionId);
      if (this.active === endpoint) {
        this.active = [...this.endpoints.values()].at(-1);
      }
      this.rejectConnection(
        endpoint.connectionId,
        new WebBridgeUnavailableError('Qwen WebBridge extension disconnected'),
      );
    };
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const endpoint = this.active;
    if (!endpoint) throw new WebBridgeUnavailableError();
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new WebBridgeTimeoutError(
            `Qwen WebBridge action '${name}' timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        connectionId: endpoint.connectionId,
        resolve,
        reject,
        timer,
        chunks: [],
        chunkLength: 0,
      });
      try {
        endpoint.send({
          type: WEB_BRIDGE_FRAME_TYPES.call,
          requestId,
          payload: { name, args },
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  routeInbound(connectionId: string, frame: Record<string, unknown>): boolean {
    if (!isWebBridgeInboundFrameType(frame['type'])) return false;
    const requestId = frame['responseToRequestId'];
    if (typeof requestId !== 'string') return true;
    const pending = this.pending.get(requestId);
    if (!pending || pending.connectionId !== connectionId) return true;
    const payload = frame['payload'];
    if (frame['type'] === WEB_BRIDGE_FRAME_TYPES.resultChunk) {
      const chunk = isRecord(payload) ? payload['chunk'] : undefined;
      if (
        typeof chunk !== 'string' ||
        pending.chunkLength + chunk.length > MAX_RESULT_CHARS
      ) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new Error('Malformed or oversized WebBridge result'));
        return true;
      }
      pending.chunks.push(chunk);
      pending.chunkLength += chunk.length;
      return true;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (!isRecord(payload)) {
      pending.reject(new Error('Malformed Qwen WebBridge result'));
      return true;
    }
    if (typeof payload['error'] === 'string') {
      pending.reject(
        payload['timeout'] === true
          ? new WebBridgeTimeoutError(payload['error'])
          : new Error(payload['error']),
      );
    } else {
      const data = payload['data'];
      if (payload['chunked'] !== true) {
        pending.resolve(data);
      } else if (payload['encoding'] === 'json') {
        try {
          pending.resolve(JSON.parse(pending.chunks.join('')));
        } catch {
          pending.reject(new Error('Malformed chunked WebBridge JSON result'));
        }
      } else if (isRecord(data)) {
        pending.resolve({ ...data, data: pending.chunks.join('') });
      } else {
        pending.reject(new Error('Malformed chunked WebBridge result'));
      }
    }
    return true;
  }

  status(): {
    extensionConnected: boolean;
    extensionId?: string;
    version?: string;
  } {
    return {
      extensionConnected: this.active !== undefined,
      extensionId: this.active?.extensionId,
      version: this.active?.version,
    };
  }

  private rejectConnection(connectionId: string, error: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.connectionId !== connectionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
