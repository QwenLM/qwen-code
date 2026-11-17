/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_MESSAGE_CHUNKS_KIND,
  MANAGED_MESSAGE_INLINE_BYTES,
  MANAGED_MESSAGE_KIND,
  MANAGED_MESSAGE_PART_BYTES,
  MANAGED_MESSAGE_PART_KIND,
  managedMessageChunkParts,
  publishManagedMessageBody,
  readManagedMessageBody,
} from './managed-message-chunks.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from './http-managed-session-store.js';
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
  it('keeps the inline threshold aligned with the store contract', () => {
    expect(MANAGED_MESSAGE_INLINE_BYTES).toBe(
      HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes,
    );
    expect(MANAGED_MESSAGE_PART_BYTES).toBeLessThanOrEqual(
      HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes,
    );
  });
  it('publishes a small body as one inline message resource', async () => {
    const store = new MemoryResourceStore();
    const body = Buffer.from(JSON.stringify({ text: 'short answer' }), 'utf8');
    const ref = await publishManagedMessageBody(store, body);
    expect(ref.kind).toBe(MANAGED_MESSAGE_KIND);
    expect(store.resources.size).toBe(1);
    const restored = await readManagedMessageBody((r) => store.read(r), ref);
    expect(restored.equals(body)).toBe(true);
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

    const restored = await readManagedMessageBody((r) => store.read(r), ref);
    expect(restored.equals(body)).toBe(true);
  });

  it.each([65_535, 65_536, 65_537, 224 * 1024, 3 * 1024 * 1024])(
    'round-trips a %i-byte serialized record at the inline boundary',
    async (byteLength) => {
      const store = new MemoryResourceStore();
      const body = Buffer.from(
        JSON.stringify({ text: 'x'.repeat(byteLength - 11) }),
      );
      expect(body.byteLength).toBe(byteLength);
      const ref = await publishManagedMessageBody(store, body);
      expect(ref.kind).toBe(
        byteLength <= 65_536
          ? MANAGED_MESSAGE_KIND
          : MANAGED_MESSAGE_CHUNKS_KIND,
      );
      const restored = await readManagedMessageBody((r) => store.read(r), ref);
      expect(restored.equals(body)).toBe(true);
    },
  );

  it('reads parts in order through a single-flight reader', async () => {
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
    let busy = false;
    const seen: string[] = [];
    const read = async (part: ManagedSessionDurableRef) => {
      if (busy) throw new Error('concurrent_recovery_request');
      busy = true;
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        seen.push(part.resourceId);
        return await store.read(part);
      } finally {
        busy = false;
      }
    };
    const restored = await readManagedMessageBody(read, ref);
    expect(restored.equals(body)).toBe(true);
    expect(seen).toEqual([ref, ...parts].map((part) => part.resourceId));
  });

  it('fails instead of returning a partial body when a part is missing', async () => {
    const store = new MemoryResourceStore();
    const ref = await publishManagedMessageBody(
      store,
      Buffer.alloc(224 * 1024),
    );
    const parts = managedMessageChunkParts(
      ref.kind,
      store.resources.get(ref.resourceId)!.bytes,
    );
    store.resources.delete(parts[1].resourceId);
    await expect(
      readManagedMessageBody((r) => store.read(r), ref),
    ).rejects.toThrow('resource missing or conflicting');
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
