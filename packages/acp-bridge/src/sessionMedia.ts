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

// Text the degrade paths substitute for media the model will not receive. The
// SDK's DaemonSessionClient.hydrateBlock and the web shell's degradation
// detection carry their own copies; keep the wording in sync.
export const SESSION_MEDIA_UNAVAILABLE_TEXT =
  '[Attached media is no longer available]';

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

// Append the unavailable marker to the last text block (or as a new text
// block) so a partially degraded prompt keeps its surviving blocks instead of
// collapsing into one wholesale placeholder.
export function withMediaDegradationMarker<
  T extends ContentBlock | SessionMediaReference,
>(blocks: readonly T[]): T[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === 'text') {
      if (block.text.endsWith(SESSION_MEDIA_UNAVAILABLE_TEXT)) {
        return [...blocks];
      }
      const next = [...blocks];
      next[i] = {
        type: 'text',
        text: `${block.text}\n${SESSION_MEDIA_UNAVAILABLE_TEXT}`,
      } as T;
      return next;
    }
  }
  return [
    ...blocks,
    { type: 'text', text: SESSION_MEDIA_UNAVAILABLE_TEXT } as T,
  ];
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

  // Validate one block against the store. Blocks without a `mediaId` (inline
  // media, text) pass through untouched, matching `assertReferences`.
  assertReference(block: unknown): void {
    if (
      !block ||
      typeof block !== 'object' ||
      Array.isArray(block) ||
      !('mediaId' in block)
    ) {
      return;
    }
    if (!isSessionMediaReference(block)) {
      throw new SessionMediaReferenceError(
        'Invalid session media reference',
        'invalid_session_media_reference',
      );
    }
    this.assertStored(block);
  }

  assertReferences(content: readonly unknown[]): void {
    // One occurrence per mediaId: the serializer expands every reference at
    // dispatch, so repeated occurrences of one stored blob amplify the
    // outbound payload without bound even though only one read is needed.
    const seenMediaIds = new Set<string>();
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
      if (seenMediaIds.has(block.mediaId)) {
        throw new SessionMediaReferenceError(
          `Session media referenced more than once: ${block.mediaId}`,
          'invalid_session_media_reference',
        );
      }
      seenMediaIds.add(block.mediaId);
      this.assertStored(block);
    }
  }

  async resolveContent(
    content: ReadonlyArray<ContentBlock | SessionMediaReference>,
    memo?: Map<string, Promise<ContentBlock>>,
  ): Promise<ContentBlock[]> {
    // Resolve each distinct mediaId once: duplicate references share the read
    // and base64 encode instead of amplifying heap per occurrence. Callers
    // resolving several messages in one batch can pass a shared `memo` so a
    // mediaId referenced from different messages is also read only once.
    const pendingByMediaId = memo ?? new Map<string, Promise<ContentBlock>>();
    return await Promise.all(
      content.map(async (block) => {
        if (!isSessionMediaReference(block)) return block;
        let pending = pendingByMediaId.get(block.mediaId);
        if (!pending) {
          const created = this.resolve(block);
          pendingByMediaId.set(block.mediaId, created);
          // A transient read failure must not poison later resolutions of the
          // same mediaId: a cached rejection would hand every sibling message
          // (and every later lookup) the failure although the store still
          // holds the bytes. Evict it so the next lookup reads again.
          void created.catch(() => {
            if (pendingByMediaId.get(block.mediaId) === created) {
              pendingByMediaId.delete(block.mediaId);
            }
          });
          pending = created;
        }
        return await pending;
      }),
    );
  }

  // Per-block variant of `resolveContent` for degrade paths: one unresolvable
  // reference drops only itself, keeping the sibling blocks a wholesale
  // fallback would discard. Non-media errors still propagate.
  async resolveContentDegrading(
    content: ReadonlyArray<ContentBlock | SessionMediaReference>,
    memo?: Map<string, Promise<ContentBlock>>,
  ): Promise<{
    retainedBlocks: Array<ContentBlock | SessionMediaReference>;
    resolvedBlocks: ContentBlock[];
    degraded: number;
  }> {
    const retainedBlocks: Array<ContentBlock | SessionMediaReference> = [];
    const resolvedBlocks: ContentBlock[] = [];
    let degraded = 0;
    for (const block of content) {
      if (!isSessionMediaReference(block)) {
        retainedBlocks.push(block);
        resolvedBlocks.push(block);
        continue;
      }
      try {
        const [resolved] = await this.resolveContent([block], memo);
        if (resolved) resolvedBlocks.push(resolved);
        retainedBlocks.push(block);
      } catch (error) {
        if (!(error instanceof SessionMediaReferenceError)) throw error;
        degraded += 1;
      }
    }
    return { retainedBlocks, resolvedBlocks, degraded };
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

  private assertStored(reference: SessionMediaReference): void {
    const stored = this.records.get(reference.mediaId);
    if (
      !stored ||
      stored.type !== reference.type ||
      stored.mimeType !== reference.mimeType ||
      stored.size !== reference.size
    ) {
      throw new SessionMediaReferenceError(
        `Unknown or unavailable session media: ${reference.mediaId}`,
        'session_media_gone',
      );
    }
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
