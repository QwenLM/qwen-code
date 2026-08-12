/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';

export const SESSION_MEDIA_MAX_ITEM_BYTES = 8 * 1024 * 1024;
export const SESSION_MEDIA_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const SESSION_MEDIA_MAX_ITEMS = 256;

export class SessionMediaReferenceError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_session_media_reference' | 'session_media_gone',
  ) {
    super(message);
    this.name = 'SessionMediaReferenceError';
  }
}

export interface SessionMediaReference {
  type: 'image';
  mediaId: string;
  mimeType: string;
  size: number;
}

interface StoredSessionMedia extends SessionMediaReference {
  filePath: string;
}

export function isSessionMediaReference(
  value: unknown,
): value is SessionMediaReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record['type'] === 'image' &&
    typeof record['mediaId'] === 'string' &&
    record['mediaId'].length > 0 &&
    typeof record['mimeType'] === 'string' &&
    record['mimeType'].startsWith(`${record['type']}/`) &&
    typeof record['size'] === 'number' &&
    Number.isSafeInteger(record['size']) &&
    record['size'] > 0
  );
}

export class SessionMediaStore {
  private readonly records = new Map<string, StoredSessionMedia>();
  private directoryPromise?: Promise<string>;
  private totalBytes = 0;
  private pendingItems = 0;
  private closed = false;

  async put(
    data: Uint8Array,
    mimeType: string,
  ): Promise<SessionMediaReference> {
    if (this.closed) throw new Error('Session media store is closed');
    const type = 'image' as const;
    if (!mimeType.startsWith('image/')) {
      throw new TypeError('Session media must be image/*');
    }
    if (
      data.byteLength === 0 ||
      data.byteLength > SESSION_MEDIA_MAX_ITEM_BYTES
    ) {
      throw new RangeError(
        `Session media must be between 1 and ${SESSION_MEDIA_MAX_ITEM_BYTES} bytes`,
      );
    }
    if (this.totalBytes + data.byteLength > SESSION_MEDIA_MAX_TOTAL_BYTES) {
      throw new RangeError(
        `Session media exceeds the ${SESSION_MEDIA_MAX_TOTAL_BYTES}-byte session limit`,
      );
    }
    if (this.records.size + this.pendingItems >= SESSION_MEDIA_MAX_ITEMS) {
      throw new RangeError(
        `Session media exceeds the ${SESSION_MEDIA_MAX_ITEMS}-item session limit`,
      );
    }

    const mediaId = randomUUID();
    let filePath: string | undefined;
    this.totalBytes += data.byteLength;
    this.pendingItems += 1;
    try {
      const directory = await this.directory();
      filePath = path.join(directory, mediaId);
      await fs.writeFile(filePath, data, { flag: 'wx' });
      if (this.closed) {
        throw new Error('Session media store is closed');
      }
      const record: StoredSessionMedia = {
        type,
        mediaId,
        mimeType,
        size: data.byteLength,
        filePath,
      };
      this.records.set(mediaId, record);
      return { type, mediaId, mimeType, size: data.byteLength };
    } catch (error) {
      if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
      if (!this.closed) this.totalBytes -= data.byteLength;
      throw error;
    } finally {
      if (!this.closed) this.pendingItems -= 1;
    }
  }

  assertReferences(content: readonly unknown[]): void {
    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        Array.isArray(block) ||
        !('mediaId' in block)
      ) {
        continue;
      }
      if (!isSessionMediaReference(block)) {
        throw new SessionMediaReferenceError(
          'Invalid session media reference',
          'invalid_session_media_reference',
        );
      }
      const stored = this.records.get(block.mediaId);
      if (
        !stored ||
        stored.type !== block.type ||
        stored.mimeType !== block.mimeType ||
        stored.size !== block.size
      ) {
        throw new SessionMediaReferenceError(
          `Unknown or unavailable session media: ${block.mediaId}`,
          'session_media_gone',
        );
      }
    }
  }

  async resolveContent(
    content: ReadonlyArray<ContentBlock | SessionMediaReference>,
  ): Promise<ContentBlock[]> {
    return await Promise.all(
      content.map(async (block) =>
        isSessionMediaReference(block) ? await this.resolve(block) : block,
      ),
    );
  }

  async read(
    mediaId: string,
  ): Promise<{ data: Buffer; mimeType: string } | undefined> {
    const record = this.records.get(mediaId);
    if (!record) return undefined;
    try {
      return {
        data: await fs.readFile(record.filePath),
        mimeType: record.mimeType,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.records.delete(mediaId)) this.totalBytes -= record.size;
        return undefined;
      }
      throw error;
    }
  }

  async remove(mediaId: string): Promise<boolean> {
    const record = this.records.get(mediaId);
    if (!record) return false;
    this.records.delete(mediaId);
    this.totalBytes -= record.size;
    await fs.rm(record.filePath, { force: true });
    return true;
  }

  get sizeBytes(): number {
    return this.totalBytes;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
    this.totalBytes = 0;
    this.pendingItems = 0;
    if (!this.directoryPromise) return;
    const directory = await this.directoryPromise.catch(() => undefined);
    if (!directory) return;
    await fs.rm(directory, { recursive: true, force: true });
  }

  private async resolve(
    reference: SessionMediaReference,
  ): Promise<ContentBlock> {
    const media = await this.read(reference.mediaId);
    if (!media || media.mimeType !== reference.mimeType) {
      throw new SessionMediaReferenceError(
        `Unknown or unavailable session media: ${reference.mediaId}`,
        'session_media_gone',
      );
    }
    return {
      type: reference.type,
      data: media.data.toString('base64'),
      mimeType: media.mimeType,
    } as ContentBlock;
  }

  private async directory(): Promise<string> {
    if (!this.directoryPromise) {
      const pending = fs.mkdtemp(path.join(tmpdir(), 'qwen-session-media-'));
      this.directoryPromise = pending;
      void pending.catch(() => {
        if (this.directoryPromise === pending)
          this.directoryPromise = undefined;
      });
    }
    return await this.directoryPromise;
  }
}
