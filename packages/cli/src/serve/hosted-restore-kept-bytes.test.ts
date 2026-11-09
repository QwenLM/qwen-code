/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MANAGED_MESSAGE_BODY_ENTRY_BYTES } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-projection.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedRestoreKeptBytes,
  readerWithVerified,
} from './hosted-restore-kept-bytes.js';

function resource(
  resourceId: string,
  text: string,
  kind = 'managed-message',
): { ref: ManagedSessionDurableRef; bytes: Buffer } {
  const bytes = Buffer.alloc(Buffer.byteLength(text));
  bytes.write(text);
  return {
    bytes,
    ref: {
      resourceId,
      kind,
      schemaVersion: 1,
      byteLength: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

/** The same resource id with one identity field changed at a time. */
function variants(ref: ManagedSessionDurableRef): ManagedSessionDurableRef[] {
  return [
    { ...ref, kind: 'managed-tool-result-manifest' },
    { ...ref, schemaVersion: 2 },
    { ...ref, byteLength: ref.byteLength + 1 },
    { ...ref, digest: 'f'.repeat(64) },
  ];
}

describe('HostedRestoreKeptBytes', () => {
  it('serves kept bytes only for the identical reference', () => {
    const kept = new HostedRestoreKeptBytes();
    const { ref, bytes } = resource('a', 'body a');
    expect(kept.keep(ref, bytes)).toBe(true);
    expect(kept.get(ref)).toBe(bytes);
    expect(kept.get({ ...ref })).toBe(bytes);
    for (const other of [...variants(ref), { ...ref, resourceId: 'b' }])
      expect(kept.get(other)).toBeUndefined();
  });

  it('keeps one entry per resource and none whose length is wrong', () => {
    const kept = new HostedRestoreKeptBytes(1024, 0);
    const first = resource('a', 'body a');
    const second = resource('a', 'other body');
    expect(kept.keep(first.ref, first.bytes)).toBe(true);
    expect(kept.keep(second.ref, second.bytes)).toBe(false);
    expect(kept.get(first.ref)).toBe(first.bytes);
    expect(kept.get(second.ref)).toBeUndefined();
    const short = resource('c', 'body c');
    expect(kept.keep(short.ref, short.bytes.subarray(1))).toBe(false);
    expect(kept.bytes).toBe(first.bytes.byteLength);
  });

  it('keeps entries up to the budget and refuses the rest', () => {
    const kept = new HostedRestoreKeptBytes(10, 0);
    const fits = resource('a', 'x'.repeat(6));
    const over = resource('b', 'y'.repeat(6));
    const exact = resource('c', 'z'.repeat(4));
    expect(kept.keep(fits.ref, fits.bytes)).toBe(true);
    expect(kept.keep(over.ref, over.bytes)).toBe(false);
    expect(kept.keep(exact.ref, exact.bytes)).toBe(true);
    expect(kept.bytes).toBe(10);
    expect(kept.get(over.ref)).toBeUndefined();
    const none = new HostedRestoreKeptBytes(0, 0);
    expect(none.keep(fits.ref, fits.bytes)).toBe(false);
  });

  it('charges every entry a fixed overhead by default', () => {
    const entry = 6 + MANAGED_MESSAGE_BODY_ENTRY_BYTES;
    const kept = new HostedRestoreKeptBytes(2 * entry);
    for (const id of ['a', 'b']) {
      const { ref, bytes } = resource(id, 'x'.repeat(6));
      expect(kept.keep(ref, bytes)).toBe(true);
    }
    expect(kept.bytes).toBe(2 * entry);
    const { ref, bytes } = resource('c', 'x');
    expect(kept.keep(ref, bytes)).toBe(false);
  });

  it('keeps a slice of a larger buffer in a buffer of its own', () => {
    const kept = new HostedRestoreKeptBytes();
    const { ref } = resource('a', 'body a');
    const pool = Buffer.alloc(4096, 'x');
    pool.write('body a', 64);
    const slice = pool.subarray(64, 64 + ref.byteLength);
    expect(kept.keep(ref, slice)).toBe(true);
    const held = kept.get(ref)!;
    expect(held).not.toBe(slice);
    expect(held.buffer.byteLength).toBe(ref.byteLength);
    expect(held).toEqual(Buffer.from('body a'));
  });

  it('lists its entries in the order they were kept until cleared', () => {
    const kept = new HostedRestoreKeptBytes();
    for (const [id, text] of [
      ['m2', 'second message'],
      ['m1', 'first message'],
    ] as const) {
      const { ref, bytes } = resource(id, text);
      kept.keep(ref, bytes);
    }
    expect([...kept.entries()].map(({ ref }) => ref.resourceId)).toEqual([
      'm2',
      'm1',
    ]);
    kept.clear();
    expect([...kept.entries()]).toEqual([]);
    expect(kept.bytes).toBe(0);
    const { ref, bytes } = resource('m2', 'second message');
    expect(kept.keep(ref, bytes)).toBe(true);
  });
});

describe('readerWithVerified', () => {
  it('serves the bytes read for exactly that reference', async () => {
    const { ref, bytes } = resource('root', 'checkpoint', 'managed-checkpoint');
    const page = resource('page', 'history page', 'managed-checkpoint-history');
    const read = vi.fn(async (part: ManagedSessionDurableRef) =>
      Buffer.from(`store ${part.resourceId}`),
    );
    const reader = readerWithVerified({ read }, ref, bytes);
    await expect(reader.read({ ...ref })).resolves.toBe(bytes);
    expect(read).not.toHaveBeenCalled();
    await expect(reader.read(page.ref)).resolves.toEqual(
      Buffer.from('store page'),
    );
    for (const other of variants(ref)) await reader.read(other);
    expect(read.mock.calls.map(([part]) => part)).toEqual([
      page.ref,
      ...variants(ref),
    ]);
  });
});
