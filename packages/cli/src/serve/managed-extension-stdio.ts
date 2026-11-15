/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ManagedExtensionProcessOwners } from './managed-extension-process.js';

export class ManagedExtensionStdioTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private child?: ChildProcess;
  private ownerId?: string;
  private closed = false;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly owners: ManagedExtensionProcessOwners,
    private readonly spec: Parameters<
      ManagedExtensionProcessOwners['start']
    >[0],
  ) {}

  get processOwnerId(): string | undefined {
    return this.ownerId;
  }

  async start(): Promise<void> {
    if (this.child)
      throw new Error('Extension stdio transport already started.');
    const owner = await this.owners.start(this.spec);
    this.ownerId = owner.ownerId;
    this.child = owner.child;
    this.child.stderr?.on('data', () => undefined);
    this.child.on('error', (error) => this.onerror?.(error));
    this.child.stdin?.on('error', (error) => this.onerror?.(error));
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      try {
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null)
          this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error('Invalid MCP message.'),
        );
      }
    });
    this.child.on('exit', () => {
      void this.close().catch((error: unknown) =>
        this.onerror?.(
          error instanceof Error
            ? error
            : new Error('Extension process stop is unknown.'),
        ),
      );
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin;
    if (!input || this.closed)
      throw new Error('Extension stdio transport is closed.');
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.ownerId)
      throw new Error('Extension process owner is unavailable.');
    this.child?.stdin?.end();
    const receipt = await this.owners.stop(this.ownerId);
    if (receipt.state !== 'stopped')
      throw new Error('Extension process stop outcome is unknown.');
    this.closed = true;
    this.onclose?.();
  }
}
