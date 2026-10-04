/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_MESSAGE_CHUNKS_KIND,
  MANAGED_MESSAGE_KIND,
  MANAGED_MESSAGE_PART_BYTES,
  MANAGED_MESSAGE_PART_KIND,
  managedMessageChunkParts,
  publishManagedMessageBody,
  readManagedMessageBody,
} from './managed-message-chunks.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

class MemoryResourceStore {
  readonly resources = new Map<
    string,
    { kind: string; bytes: Buffer; ref: ManagedSessionDurableRef }
  >();

  async publish(
    kind: string,
    bytes: Buffer,
  ): Promise<ManagedSessionDurableRef> {
    const copy = Buffer.from(bytes);
    const ref: ManagedSessionDurableRef = {
      resourceId: randomUUID(),
      kind,
      schemaVersion: 1,
      byteLength: copy.byteLength,
      digest: createHash('sha256').update(copy).digest('hex'),
    };
    this.resources.set(ref.resourceId, { kind, bytes: copy, ref });
    return ref;
  }

  async read(ref: ManagedSessionDurableRef): Promise<Buffer> {
    const stored = this.resources.get(ref.resourceId);
    if (
      stored === undefined ||
      stored.ref.kind !== ref.kind ||
      stored.ref.digest !== ref.digest ||
      stored.ref.byteLength !== ref.byteLength
    ) {
      throw new Error('resource missing or conflicting');
    }
    return Buffer.from(stored.bytes);
  }
}

describe('managed message chunks', () => {
  it('publishes a small body as one inline message resource', async () => {
    const store = new MemoryResourceStore();
    const body = Buffer.from(JSON.stringify({ text: 'short answer' }), 'utf8');
    const ref = await publishManagedMessageBody(store, body);
    expect(ref.kind).toBe(MANAGED_MESSAGE_KIND);
    expect(store.resources.size).toBe(1);
    await expect(
      readManagedMessageBody((r) => store.read(r), ref),
    ).resolves.toEqual(body);
  });

  it('splits an oversized body into bounded parts behind a manifest', async () => {
    const store = new MemoryResourceStore();
    // Multi-byte characters straddle part boundaries; reassembly is by bytes.
    const body = Buffer.from(
      JSON.stringify({ text: '回答😀'.repeat(40_000) }),
      'utf8',
    );
    expect(body.byteLength).toBeGreaterThan(MANAGED_MESSAGE_PART_BYTES);

    const ref = await publishManagedMessageBody(store, body);
    expect(ref.kind).toBe(MANAGED_MESSAGE_CHUNKS_KIND);

    const manifest = store.resources.get(ref.resourceId)!;
    const parts = (
      JSON.parse(manifest.bytes.toString('utf8')) as {
        parts: ManagedSessionDurableRef[];
      }
    ).parts;
    expect(parts.length).toBe(
      Math.ceil(body.byteLength / MANAGED_MESSAGE_PART_BYTES),
    );
    for (const part of parts) {
      expect(part.kind).toBe(MANAGED_MESSAGE_PART_KIND);
      expect(part.byteLength).toBeLessThanOrEqual(MANAGED_MESSAGE_PART_BYTES);
    }
    expect(managedMessageChunkParts(ref.kind, manifest.bytes)).toEqual(parts);
    expect(managedMessageChunkParts(MANAGED_MESSAGE_KIND, body)).toEqual([]);

    await expect(
      readManagedMessageBody((r) => store.read(r), ref),
    ).resolves.toEqual(body);
  });

  it('reassembles in part order even when parts resolve out of order', async () => {
    const store = new MemoryResourceStore();
    const body = Buffer.from(
      JSON.stringify({ text: '块'.repeat(50_000) }),
      'utf8',
    );
    const ref = await publishManagedMessageBody(store, body);
    const parts = managedMessageChunkParts(
      ref.kind,
      store.resources.get(ref.resourceId)!.bytes,
    );
    // Earlier parts resolve later: a completion-order merge would scramble
    // the document; the result must follow manifest order instead.
    const read = (part: ManagedSessionDurableRef) =>
      new Promise<Buffer>((resolve) =>
        setTimeout(
          () => resolve(store.read(part)),
          (parts.length - parts.indexOf(part)) * 5,
        ),
      );
    await expect(readManagedMessageBody(read, ref)).resolves.toEqual(body);
  });

  it('refuses a manifest that does not reference message parts', async () => {
    const store = new MemoryResourceStore();
    const notAPart = await store.publish(
      MANAGED_MESSAGE_KIND,
      Buffer.from('{}', 'utf8'),
    );
    const manifest = await store.publish(
      MANAGED_MESSAGE_CHUNKS_KIND,
      Buffer.from(JSON.stringify({ parts: [notAPart] }), 'utf8'),
    );
    await expect(
      readManagedMessageBody((r) => store.read(r), manifest),
    ).rejects.toThrow(/must reference message parts/);
  });

  it('refuses a manifest without parts', async () => {
    const store = new MemoryResourceStore();
    const manifest = await store.publish(
      MANAGED_MESSAGE_CHUNKS_KIND,
      Buffer.from(JSON.stringify({ parts: [] }), 'utf8'),
    );
    await expect(
      readManagedMessageBody((r) => store.read(r), manifest),
    ).rejects.toThrow(/must carry parts/);
  });
});
