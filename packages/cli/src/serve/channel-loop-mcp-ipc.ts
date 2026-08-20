/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { DaemonChannelLoopMcpHost } from '@qwen-code/channel-base';

export const CHANNEL_LOOP_MCP_IPC_TIMEOUT_MS = 30_000;
export const MAX_CHANNEL_LOOP_MCP_IN_FLIGHT = 64;
const MAX_IPC_ID_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_ERROR_LENGTH = 512;

type JsonRpcMessage = Record<string, unknown>;

export interface ChannelLoopMcpRegisterMessage {
  type: 'channel_loop_mcp_register';
  id: string;
  sessionId: string;
}

export interface ChannelLoopMcpUnregisterMessage {
  type: 'channel_loop_mcp_unregister';
  id: string;
  sessionId: string;
}

export interface ChannelLoopMcpControlResultMessage {
  type: 'channel_loop_mcp_control_result';
  id: string;
  ok: boolean;
  error?: string;
}

export interface ChannelLoopMcpRequestMessage {
  type: 'channel_loop_mcp_message';
  id: string;
  sessionId: string;
  payload: JsonRpcMessage;
}

export interface ChannelLoopMcpResultMessage {
  type: 'channel_loop_mcp_result';
  id: string;
  ok: boolean;
  payload?: JsonRpcMessage;
  error?: string;
}

export type ChannelLoopMcpControlMessage =
  | ChannelLoopMcpRegisterMessage
  | ChannelLoopMcpUnregisterMessage;

export type ChannelLoopMcpIpcSend = (
  message: unknown,
  callback?: (error: Error | null) => void,
) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

function isBaseMessage(
  value: unknown,
): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && isBoundedString(value['id'], MAX_IPC_ID_LENGTH);
}

export function isChannelLoopMcpControlMessage(
  value: unknown,
): value is ChannelLoopMcpControlMessage {
  return (
    isBaseMessage(value) &&
    (value['type'] === 'channel_loop_mcp_register' ||
      value['type'] === 'channel_loop_mcp_unregister') &&
    isBoundedString(value['sessionId'], MAX_SESSION_ID_LENGTH)
  );
}

export function isChannelLoopMcpControlResultMessage(
  value: unknown,
): value is ChannelLoopMcpControlResultMessage {
  return (
    isBaseMessage(value) &&
    value['type'] === 'channel_loop_mcp_control_result' &&
    typeof value['ok'] === 'boolean' &&
    (value['error'] === undefined ||
      isBoundedString(value['error'], MAX_ERROR_LENGTH))
  );
}

export function isChannelLoopMcpRequestMessage(
  value: unknown,
): value is ChannelLoopMcpRequestMessage {
  return (
    isBaseMessage(value) &&
    value['type'] === 'channel_loop_mcp_message' &&
    isBoundedString(value['sessionId'], MAX_SESSION_ID_LENGTH) &&
    isRecord(value['payload'])
  );
}

export function isChannelLoopMcpResultMessage(
  value: unknown,
): value is ChannelLoopMcpResultMessage {
  return (
    isBaseMessage(value) &&
    value['type'] === 'channel_loop_mcp_result' &&
    typeof value['ok'] === 'boolean' &&
    (value['payload'] === undefined || isRecord(value['payload'])) &&
    (value['error'] === undefined ||
      isBoundedString(value['error'], MAX_ERROR_LENGTH))
  );
}

export function createChannelLoopMcpRequest(
  sessionId: string,
  payload: unknown,
): ChannelLoopMcpRequestMessage {
  if (!isBoundedString(sessionId, MAX_SESSION_ID_LENGTH)) {
    throw new Error('Invalid channel loop MCP session id.');
  }
  if (!isRecord(payload)) {
    throw new Error('Invalid channel loop MCP payload.');
  }
  return {
    type: 'channel_loop_mcp_message',
    id: randomUUID(),
    sessionId,
    payload,
  };
}

export class ChannelLoopMcpWorkerHost implements DaemonChannelLoopMcpHost {
  private readonly handlers = new Map<
    string,
    (message: JsonRpcMessage) => Promise<JsonRpcMessage | undefined>
  >();
  private readonly pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private disposed = false;

  constructor(private readonly send: ChannelLoopMcpIpcSend) {}

  async register(
    sessionId: string,
    handler: (message: JsonRpcMessage) => Promise<JsonRpcMessage | undefined>,
  ): Promise<void> {
    this.handlers.set(sessionId, handler);
    try {
      await this.sendControl('channel_loop_mcp_register', sessionId);
    } catch (error) {
      if (this.handlers.get(sessionId) === handler) {
        this.handlers.delete(sessionId);
      }
      throw error;
    }
  }

  async unregister(sessionId: string): Promise<void> {
    this.handlers.delete(sessionId);
    await this.sendControl('channel_loop_mcp_unregister', sessionId);
  }

  handleMessage(value: unknown): boolean {
    if (isChannelLoopMcpControlResultMessage(value)) {
      const pending = this.pending.get(value.id);
      if (!pending) return true;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.ok) pending.resolve();
      else pending.reject(new Error(value.error ?? 'Channel loop MCP failed.'));
      return true;
    }
    if (!isChannelLoopMcpRequestMessage(value)) return false;
    void this.handleRequest(value);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handlers.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel loop MCP IPC closed.'));
    }
    this.pending.clear();
  }

  private sendControl(
    type: ChannelLoopMcpControlMessage['type'],
    sessionId: string,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Channel loop MCP IPC is closed.'));
    }
    if (!isBoundedString(sessionId, MAX_SESSION_ID_LENGTH)) {
      return Promise.reject(new Error('Invalid channel loop MCP session id.'));
    }
    if (this.pending.size >= MAX_CHANNEL_LOOP_MCP_IN_FLIGHT) {
      return Promise.reject(new Error('Channel loop MCP IPC queue is full.'));
    }
    const id = randomUUID();
    const message: ChannelLoopMcpControlMessage = { type, id, sessionId };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Channel loop MCP IPC timed out.'));
      }, CHANNEL_LOOP_MCP_IPC_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(message, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new Error('Channel loop MCP IPC send failed.'));
        });
      } catch {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error('Channel loop MCP IPC send failed.'));
      }
    });
  }

  private async handleRequest(
    message: ChannelLoopMcpRequestMessage,
  ): Promise<void> {
    const handler = this.handlers.get(message.sessionId);
    if (!handler) {
      this.sendResult(message.id, {
        ok: false,
        error: 'No channel loop MCP handler for this session.',
      });
      return;
    }
    try {
      const payload = await handler(message.payload);
      this.sendResult(message.id, {
        ok: true,
        payload: payload ?? { jsonrpc: '2.0', id: 0, result: {} },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message.slice(0, MAX_ERROR_LENGTH)
          : 'Channel loop MCP request failed.';
      this.sendResult(message.id, {
        ok: false,
        error: errorMessage || 'Channel loop MCP request failed.',
      });
    }
  }

  private sendResult(
    id: string,
    result:
      | { ok: true; payload: JsonRpcMessage }
      | { ok: false; error: string },
  ): void {
    try {
      this.send({
        type: 'channel_loop_mcp_result',
        id,
        ...result,
      } satisfies ChannelLoopMcpResultMessage);
    } catch {
      // The parent request owns the timeout when IPC is already closed.
    }
  }
}
