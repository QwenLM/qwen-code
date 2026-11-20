/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import process from 'node:process';
import type {
  CLIControlRequest,
  CLIControlResponse,
  CLIMessage,
  ControlCancelRequest,
} from '../types.js';

export type StreamJsonInputMessage =
  | CLIMessage
  | CLIControlRequest
  | CLIControlResponse
  | ControlCancelRequest;

export class StreamJsonParseError extends Error {}

export class StreamJsonInputReader {
  private readonly input: Readable;
  private active: Interface | null = null;
  private closed = false;

  constructor(input: Readable = process.stdin) {
    this.input = input;
  }

  async *read(): AsyncGenerator<StreamJsonInputMessage> {
    if (this.closed) {
      return;
    }
    const rl = createInterface({
      input: this.input,
      crlfDelay: Number.POSITIVE_INFINITY,
      terminal: false,
    });
    this.active = rl;

    try {
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        yield this.parse(line);
      }
    } finally {
      this.active = null;
      rl.close();
    }
  }

  /**
   * End {@link read} as if the input had reached EOF, so a shutdown signal can
   * stop a session that is idle waiting for the next message.
   */
  close(): void {
    this.closed = true;
    this.active?.close();
  }

  private parse(line: string): StreamJsonInputMessage {
    try {
      const parsed = JSON.parse(line) as StreamJsonInputMessage;
      if (!parsed || typeof parsed !== 'object') {
        throw new StreamJsonParseError('Parsed value is not an object');
      }
      if (!('type' in parsed) || typeof parsed.type !== 'string') {
        throw new StreamJsonParseError('Missing required "type" field');
      }
      return parsed;
    } catch (error) {
      if (error instanceof StreamJsonParseError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new StreamJsonParseError(
        `Failed to parse stream-json line: ${reason}`,
      );
    }
  }
}
