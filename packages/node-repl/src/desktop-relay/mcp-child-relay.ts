/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MAX_RELAYED_REPLY_BYTES } from './constants.js';

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** The node_repl child as the relay sees it: JSON-RPC messages both ways. */
export interface ChildChannel {
  send(message: JsonRpcMessage): void;
  /** Sets the one consumer of what the child writes. */
  onMessage(listener: (message: unknown) => void): void;
  /** Adds a listener for the child's exit; listeners accumulate. */
  onExit(listener: (reason: string) => void): void;
  close(): void;
}

export function errorReply(
  id: JsonRpcId | null,
  code: number,
  message: string,
): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function asMessage(input: unknown): JsonRpcMessage | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as JsonRpcMessage)
    : undefined;
}

function isRequestId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

interface Pending {
  originalId: JsonRpcId;
  resolve: (reply: JsonRpcMessage) => void;
}

/**
 * Serves one node_repl child to several MCP clients.
 *
 * The daemon opens one MCP client per live session plus one for discovery over
 * a single registration, and each numbers its requests from 0; node_repl is a
 * stdio server built for exactly one client. So this class forwards the first
 * `initialize` and answers later ones from its result, forwards
 * `notifications/initialized` once, rewrites request ids to relay-owned ones
 * and restores them on the reply, and turns a reply the daemon's frame cap
 * would drop into an error the model can act on.
 */
export class McpChildRelay {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private initialize: Promise<JsonRpcMessage> | undefined;
  private initializedForwarded = false;
  private exitReason: string | undefined;

  constructor(
    private readonly child: ChildChannel,
    private readonly maxReplyBytes = MAX_RELAYED_REPLY_BYTES,
  ) {
    child.onMessage((message) => this.fromChild(message));
    child.onExit((reason) => this.onChildExit(reason));
  }

  /** Resolves to the reply for a request, or undefined for anything else. */
  async handle(input: unknown): Promise<JsonRpcMessage | undefined> {
    const message = asMessage(input);
    // A response here would answer a request from the child, and the child is
    // never allowed to make one (see fromChild).
    if (message === undefined || typeof message.method !== 'string') {
      return undefined;
    }
    const id = message.id;
    if (!isRequestId(id)) {
      this.notify(message);
      return undefined;
    }
    if (this.exitReason !== undefined) {
      return errorReply(
        id,
        -32000,
        `node_repl is not running (${this.exitReason})`,
      );
    }
    if (message.method !== 'initialize') return this.forward(message, id);
    if (this.initialize === undefined) {
      const first = this.forward(message, id);
      this.initialize = first;
      const reply = await first;
      // A failed handshake is retried by the next client, not inherited.
      if (reply.error !== undefined) this.initialize = undefined;
      return reply;
    }
    const first = await this.initialize;
    return first.error !== undefined
      ? { jsonrpc: '2.0', id, error: first.error }
      : { jsonrpc: '2.0', id, result: first.result };
  }

  close(): void {
    this.child.close();
  }

  private notify(message: JsonRpcMessage): void {
    if (this.exitReason !== undefined) return;
    if (message.method === 'notifications/initialized') {
      if (this.initializedForwarded) return;
      this.initializedForwarded = true;
    } else if (message.method === 'notifications/cancelled') {
      // The reverse channel does not identify which multiplexed MCP client sent
      // a notification, and clients reuse request ids. Forward only when one
      // pending request carries the id: stopping a turn must stop the cell
      // that is driving the screen.
      const params = message.params as { requestId?: unknown } | undefined;
      const relayId = this.soleRelayId(params?.requestId);
      if (relayId === undefined) return;
      this.child.send({
        ...message,
        params: { ...params, requestId: relayId },
      });
      return;
    }
    this.child.send(message);
  }

  private soleRelayId(originalId: unknown): number | undefined {
    let found: number | undefined;
    for (const [relayId, entry] of this.pending) {
      if (entry.originalId !== originalId) continue;
      if (found !== undefined) return undefined;
      found = relayId;
    }
    return found;
  }

  private forward(
    message: JsonRpcMessage,
    originalId: JsonRpcId,
  ): Promise<JsonRpcMessage> {
    const relayId = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(relayId, { originalId, resolve });
      try {
        this.child.send({ ...message, id: relayId });
      } catch (error) {
        this.settle(
          relayId,
          errorReply(
            originalId,
            -32000,
            `node_repl rejected the request: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  private fromChild(input: unknown): void {
    const message = asMessage(input);
    if (message === undefined) return;
    if (typeof message.method === 'string') {
      // The reverse channel only carries requests from the daemon, so one the
      // child starts cannot be answered; refuse it rather than leave the child
      // waiting. Its notifications have nowhere to go.
      if (isRequestId(message.id)) {
        this.child.send(
          errorReply(
            message.id,
            -32601,
            `${message.method} is not available over the desktop relay`,
          ),
        );
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.settle(
      message.id,
      this.fitToFrame({ ...message, id: entry.originalId }),
    );
  }

  private settle(relayId: number, reply: JsonRpcMessage): void {
    const entry = this.pending.get(relayId);
    if (entry === undefined) return;
    this.pending.delete(relayId);
    entry.resolve(reply);
  }

  private fitToFrame(reply: JsonRpcMessage): JsonRpcMessage {
    const bytes = Buffer.byteLength(JSON.stringify(reply));
    if (bytes <= this.maxReplyBytes) return reply;
    return errorReply(
      reply.id ?? null,
      -32000,
      `The node_repl result is ${bytes} bytes, above the ${this.maxReplyBytes}-byte limit of the remote channel. Return less output, for example a smaller screenshot.`,
    );
  }

  private onChildExit(reason: string): void {
    this.exitReason = reason;
    for (const [relayId, entry] of [...this.pending]) {
      this.settle(
        relayId,
        errorReply(entry.originalId, -32000, `node_repl exited (${reason})`),
      );
    }
  }
}
