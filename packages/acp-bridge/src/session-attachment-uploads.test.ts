/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionAttachmentUploads,
  SESSION_ATTACHMENT_CHUNK_BYTES as CHUNK,
} from './session-attachment-uploads.js';

const stores: SessionAttachmentUploads[] = [];
const metadata = (size = CHUNK + 3) => ({
  name: 'test.bin',
  mimeType: 'application/octet-stream',
  size,
});
const reference = {
  type: 'resource' as const,
  attachmentId: 'test.bin',
  mimeType: 'application/octet-stream',
  size: CHUNK + 3,
};
function store() {
  const value = new SessionAttachmentUploads();
  stores.push(value);
  return value;
}
afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  vi.useRealTimers();
});

describe('session attachment uploads', () => {
  it('assembles exact bytes and accepts only an identical immediate retry', async () => {
    const uploads = store();
    const { uploadId: id } = uploads.create(metadata());
    const first = Buffer.alloc(CHUNK, 0xa3);
    expect(uploads.append(id, 0, first)).toEqual({ offset: CHUNK });
    expect(uploads.append(id, 0, first)).toEqual({ offset: CHUNK });
    expect(() => uploads.append(id, 0, Buffer.alloc(CHUNK, 0xb1))).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => uploads.append(id, CHUNK + 1, Buffer.from([1, 2]))).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => uploads.append(id, CHUNK, Buffer.from([1]))).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => uploads.complete(id, undefined, vi.fn())).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    uploads.append(id, CHUNK, Buffer.from([1, 2, 3]));
    expect(() => uploads.append(id, 0, first)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    const commit = vi.fn(async (data: Buffer) => {
      expect(data).toEqual(Buffer.concat([first, Buffer.from([1, 2, 3])]));
      return reference;
    });
    const firstCompletion = uploads.complete(id, undefined, commit);
    expect(uploads.complete(id, undefined, commit)).toBe(firstCompletion);
    await expect(firstCompletion).resolves.toEqual(reference);
    await expect(uploads.complete(id, undefined, commit)).resolves.toEqual(
      reference,
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(() => uploads.cancel(id)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('binds IDs to store and exact creator including omitted identity', () => {
    const a = store();
    const b = store();
    const { uploadId: id } = a.create(metadata(1), 'client-a');
    for (const action of [
      () => a.append(id, 0, Buffer.from([1])),
      () => a.append(id, 0, Buffer.from([1]), 'client-b'),
      () => b.append(id, 0, Buffer.from([1]), 'client-a'),
    ]) {
      expect(action).toThrow(expect.objectContaining({ status: 404 }));
    }
    a.cancel(id, 'client-b');
    a.append(id, 0, Buffer.from([1]), 'client-a');
    a.cancelClient('client-a');
    expect(() => a.append(id, 0, Buffer.from([1]), 'client-a')).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('expires receiving records without extending their lifetime on append', () => {
    vi.useFakeTimers();
    const uploads = store();
    const { uploadId: id } = uploads.create(metadata());
    vi.setSystemTime(Date.now() + 299_999);
    uploads.append(id, 0, Buffer.alloc(CHUNK));
    vi.setSystemTime(Date.now() + 1);
    expect(() => uploads.append(id, CHUNK, Buffer.alloc(3))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => uploads.cancel(id)).not.toThrow();
  });

  it('expires receipts on DELETE before the sweep', async () => {
    vi.useFakeTimers();
    const uploads = store();
    const { uploadId: id } = uploads.create(metadata(0));
    await uploads.complete(id, undefined, async () => ({
      ...reference,
      size: 0,
    }));
    vi.setSystemTime(Date.now() + 300_000);
    expect(() => uploads.cancel(id)).not.toThrow();
    expect(() => uploads.complete(id, undefined, vi.fn())).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('bounds reservations process-wide and releases them on cancel', () => {
    const all = [store(), store(), store()];
    const ids = all.slice(0, 2).flatMap((uploads) =>
      Array.from({ length: 8 }, () => ({
        uploads,
        ...uploads.create(metadata(8 * 1024 * 1024)),
      })),
    );
    expect(() => all[2]!.create(metadata(1))).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    ids[0]!.uploads.cancel(ids[0]!.uploadId);
    expect(all[2]!.create(metadata(8 * 1024 * 1024)).uploadId).toBeTruthy();
  });

  it('enforces session and process counts even for empty files', () => {
    const all = Array.from({ length: 5 }, store);
    for (const uploads of all.slice(0, 4)) {
      for (let i = 0; i < 8; i++) uploads.create(metadata(0));
      expect(() => uploads.create(metadata(0))).toThrow(
        expect.objectContaining({ status: 429 }),
      );
    }
    expect(() => all[4]!.create(metadata(0))).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    all[0]!.close();
    expect(all[4]!.create(metadata(0)).uploadId).toBeTruthy();
  });

  it('holds reservations through invalidated completion and releases once settled', async () => {
    const all = [store(), store(), store()];
    const first = all[0]!;
    const { uploadId: id } = first.create(metadata(8 * 1024 * 1024));
    for (let offset = 0; offset < 8 * 1024 * 1024; offset += CHUNK)
      first.append(id, offset, Buffer.alloc(CHUNK));
    for (let i = 0; i < 7; i++) first.create(metadata(8 * 1024 * 1024));
    for (let i = 0; i < 8; i++) all[1]!.create(metadata(8 * 1024 * 1024));
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const completing = first.complete(
      id,
      undefined,
      async (_data, _meta, assertActive) => {
        await gate;
        assertActive();
        return reference;
      },
    );
    await Promise.resolve();
    expect(() => first.cancel(id)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    first.close();
    for (let i = 0; i < 7; i++) all[2]!.create(metadata(8 * 1024 * 1024));
    expect(() => all[2]!.create(metadata(8 * 1024 * 1024))).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    settle();
    await expect(completing).rejects.toMatchObject({ status: 404 });
    expect(all[2]!.create(metadata(8 * 1024 * 1024)).uploadId).toBeTruthy();
  });

  it('retains terminal failure and never invokes a second writer', async () => {
    const uploads = store();
    const { uploadId: id } = uploads.create(metadata(0));
    const error = new Error('disk unavailable');
    const commit = vi.fn(async () => {
      throw error;
    });
    await expect(uploads.complete(id, undefined, commit)).rejects.toBe(error);
    await expect(uploads.complete(id, undefined, commit)).rejects.toBe(error);
    expect(commit).toHaveBeenCalledTimes(1);
    uploads.cancel(id);
    expect(() => uploads.complete(id, undefined, commit)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('rejects excess, zero and malformed chunks without advancing', () => {
    const uploads = store();
    const { uploadId: id } = uploads.create(metadata(1));
    for (const [offset, data, status] of [
      [0, Buffer.alloc(2), 413],
      [0, Buffer.alloc(CHUNK + 1), 413],
      [0, Buffer.alloc(0), 400],
      [-1, Buffer.alloc(1), 400],
      [0.5, Buffer.alloc(1), 400],
    ] as const) {
      expect(() => uploads.append(id, offset, data)).toThrow(
        expect.objectContaining({ status }),
      );
    }
    expect(uploads.append(id, 0, Buffer.from([1]))).toEqual({ offset: 1 });
  });

  it('evicts the oldest settled receipt at the process bound', async () => {
    const uploads = store();
    let first = '';
    for (let i = 0; i < 1025; i++) {
      const { uploadId: id } = uploads.create(metadata(0));
      first ||= id;
      await uploads.complete(id, undefined, async () => ({
        ...reference,
        size: 0,
      }));
    }
    expect(() => uploads.complete(first, undefined, vi.fn())).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});
