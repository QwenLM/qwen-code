/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Content } from '@google/genai';

export interface ManagedGatewayConversationSnapshot {
  readonly sessionId: string;
  readonly messageId: string;
  readonly history: readonly Content[];
  readonly committedAt: number;
}

interface ConversationRecord {
  readonly v: 1;
  readonly type: 'managed.gateway.conversation.committed';
  readonly sessionId: string;
  readonly messageId: string;
  readonly history: Content[];
  readonly committedAt: number;
}

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 256;
const MAX_ID_BYTES = 512;

function nonEmptyText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES
  ) {
    throw new Error(`${field} must be a non-empty bounded string.`);
  }
  return value;
}

function parseHistory(value: unknown): Content[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_ENTRIES) {
    throw new Error(
      `history must contain at most ${MAX_HISTORY_ENTRIES} entries.`,
    );
  }
  for (const content of value) {
    if (
      !content ||
      typeof content !== 'object' ||
      Array.isArray(content) ||
      ((content as { role?: unknown }).role !== 'user' &&
        (content as { role?: unknown }).role !== 'model') ||
      !Array.isArray((content as { parts?: unknown }).parts)
    ) {
      throw new Error('history contains an invalid Content entry.');
    }
  }
  return structuredClone(value as Content[]);
}

function parseRecord(line: string, lineNumber: number): ConversationRecord {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value['v'] !== 1 ||
      value['type'] !== 'managed.gateway.conversation.committed' ||
      !Number.isSafeInteger(value['committedAt']) ||
      (value['committedAt'] as number) < 0
    ) {
      throw new Error('record shape is invalid.');
    }
    return {
      v: 1,
      type: 'managed.gateway.conversation.committed',
      sessionId: nonEmptyText(value['sessionId'], 'sessionId'),
      messageId: nonEmptyText(value['messageId'], 'messageId'),
      history: parseHistory(value['history']),
      committedAt: value['committedAt'] as number,
    };
  } catch (error) {
    throw new Error(
      `Invalid Managed Gateway conversation record at line ${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function snapshot(
  record: ConversationRecord,
): ManagedGatewayConversationSnapshot {
  return structuredClone({
    sessionId: record.sessionId,
    messageId: record.messageId,
    history: record.history,
    committedAt: record.committedAt,
  });
}

export class FileManagedGatewayConversationStore {
  private readonly latest = new Map<string, ConversationRecord>();
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  static async open(
    filePath: string,
  ): Promise<FileManagedGatewayConversationStore> {
    const store = new FileManagedGatewayConversationStore(filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw error;
    }
    const text = bytes.toString('utf8');
    const completeLength = text.endsWith('\n')
      ? text.length
      : Math.max(0, text.lastIndexOf('\n') + 1);
    if (completeLength !== text.length) {
      await truncate(
        filePath,
        Buffer.byteLength(text.slice(0, completeLength)),
      );
    }
    const lines = text.slice(0, completeLength).split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
        throw new Error(
          `Managed Gateway conversation record at line ${index + 1} exceeds ${MAX_RECORD_BYTES} bytes.`,
        );
      }
      const record = parseRecord(line, index + 1);
      const existing = store.latest.get(record.sessionId);
      if (
        existing?.messageId === record.messageId &&
        !isDeepStrictEqual(existing.history, record.history)
      ) {
        throw new Error(
          `Managed Gateway conversation message '${record.messageId}' has conflicting durable history.`,
        );
      }
      store.latest.set(record.sessionId, record);
    }
    return store;
  }

  get(sessionId: string): ManagedGatewayConversationSnapshot | undefined {
    const record = this.latest.get(sessionId);
    return record ? snapshot(record) : undefined;
  }

  commit(
    sessionId: string,
    messageId: string,
    history: readonly Content[],
  ): Promise<ManagedGatewayConversationSnapshot> {
    const operation = async () => {
      const record: ConversationRecord = {
        v: 1,
        type: 'managed.gateway.conversation.committed',
        sessionId: nonEmptyText(sessionId, 'sessionId'),
        messageId: nonEmptyText(messageId, 'messageId'),
        history: parseHistory(history),
        committedAt: Date.now(),
      };
      const serialized = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
        throw new Error(
          `Managed Gateway conversation record exceeds ${MAX_RECORD_BYTES} bytes.`,
        );
      }
      const existing = this.latest.get(sessionId);
      if (existing?.messageId === messageId) {
        if (!isDeepStrictEqual(existing.history, record.history)) {
          throw new Error(
            `Managed Gateway conversation message '${messageId}' was reused with different history.`,
          );
        }
        return snapshot(existing);
      }
      await appendFile(this.filePath, serialized, {
        encoding: 'utf8',
        flush: true,
        mode: 0o600,
      });
      this.latest.set(sessionId, record);
      return snapshot(record);
    };
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
