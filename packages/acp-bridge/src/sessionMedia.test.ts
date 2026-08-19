/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_MEDIA_UNAVAILABLE_TEXT,
  SESSION_MEDIA_MAX_ITEM_BYTES,
  SESSION_MEDIA_MAX_ITEMS,
  SESSION_MEDIA_MAX_TOTAL_BYTES,
  SessionMediaStore,
  withMediaDegradationMarker,
} from './sessionMedia.js';

describe('SessionMediaStore', () => {
  it('does not append the media degradation marker twice', () => {
    const once = withMediaDegradationMarker([
      { type: 'text', text: 'look at this' },
    ]);

    expect(withMediaDegradationMarker(once)).toEqual([
      {
        type: 'text',
        text: `look at this\n${SESSION_MEDIA_UNAVAILABLE_TEXT}`,
      },
    ]);
  });

  it('stores bytes by reference and resolves them only at dispatch', async () => {
    const store = new SessionMediaStore();
    try {
      const reference = await store.put(
        Uint8Array.from([1, 2, 3]),
        'image/png',
      );

      expect(reference).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        size: 3,
      });
      expect(await store.resolveContent([reference])).toEqual([
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ]);
      expect(await store.read(reference.mediaId)).toEqual({
        data: Buffer.from([1, 2, 3]),
        mimeType: 'image/png',
      });
    } finally {
      await store.close();
    }
  });

  it('resolves duplicate references with a single read', async () => {
    // Duplicate references to one stored item must not multiply the disk
    // reads and base64 encodes at dispatch — that amplification let one
    // small request pin gigabytes of heap.
    const store = new SessionMediaStore();
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      const reference = await store.put(
        Uint8Array.from([1, 2, 3]),
        'image/png',
      );
      readFile.mockClear();

      const resolved = await store.resolveContent([
        reference,
        { ...reference },
        { ...reference },
      ]);

      expect(resolved).toEqual([
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ]);
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      readFile.mockRestore();
      await store.close();
    }
  });

  it('shares reads across resolveContent calls via a caller-supplied memo', async () => {
    const store = new SessionMediaStore();
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      const reference = await store.put(
        Uint8Array.from([1, 2, 3]),
        'image/png',
      );
      readFile.mockClear();

      const memo = new Map<string, Promise<ContentBlock>>();
      const block = {
        type: 'image',
        data: 'AQID',
        mimeType: 'image/png',
      };
      expect(await store.resolveContent([reference], memo)).toEqual([block]);
      expect(await store.resolveContent([reference], memo)).toEqual([block]);
      expect(readFile).toHaveBeenCalledTimes(1);

      // Omitting the memo keeps the per-call default: a fresh map, so the
      // blob is read again.
      expect(await store.resolveContent([reference])).toEqual([block]);
      expect(readFile).toHaveBeenCalledTimes(2);
    } finally {
      readFile.mockRestore();
      await store.close();
    }
  });
  it('keeps media for the lifetime of the store', async () => {
    const store = new SessionMediaStore();
    try {
      const reference = await store.put(Uint8Array.of(1), 'image/png');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));

      expect(await store.read(reference.mediaId)).toBeDefined();
    } finally {
      vi.useRealTimers();
      await store.close();
    }
  });

  it('rejects non-image uploads', async () => {
    const store = new SessionMediaStore();
    try {
      await expect(store.put(Uint8Array.of(1), 'audio/wav')).rejects.toThrow(
        'Session media must be image/*',
      );
    } finally {
      await store.close();
    }
  });

  it('rejects empty and oversized uploads', async () => {
    const store = new SessionMediaStore();
    try {
      await expect(store.put(new Uint8Array(), 'image/png')).rejects.toThrow(
        /between 1 and/,
      );
      await expect(
        store.put(
          new Uint8Array(SESSION_MEDIA_MAX_ITEM_BYTES + 1),
          'image/png',
        ),
      ).rejects.toThrow(/between 1 and/);
    } finally {
      await store.close();
    }
  });

  it('retries directory creation after a transient failure', async () => {
    const mkdir = vi
      .spyOn(fs, 'mkdtemp')
      .mockRejectedValueOnce(
        Object.assign(new Error('full'), { code: 'ENOSPC' }),
      );
    const store = new SessionMediaStore();
    try {
      await expect(store.put(Uint8Array.of(1), 'image/png')).rejects.toThrow(
        'full',
      );
      mkdir.mockRestore();
      await expect(
        store.put(Uint8Array.of(1), 'image/png'),
      ).resolves.toMatchObject({ size: 1 });
    } finally {
      mkdir.mockRestore();
      await store.close();
    }
  });

  it('removes a partial file after writing fails', async () => {
    const write = vi
      .spyOn(fs, 'writeFile')
      .mockRejectedValueOnce(
        Object.assign(new Error('full'), { code: 'ENOSPC' }),
      );
    const remove = vi.spyOn(fs, 'rm');
    const store = new SessionMediaStore();
    try {
      await expect(store.put(Uint8Array.of(1), 'image/png')).rejects.toThrow(
        'full',
      );
      expect(remove).toHaveBeenCalledWith(expect.any(String), { force: true });
      expect(store.sizeBytes).toBe(0);
    } finally {
      write.mockRestore();
      remove.mockRestore();
      await store.close();
    }
  });

  it('closes cleanly after directory creation fails', async () => {
    const mkdir = vi
      .spyOn(fs, 'mkdtemp')
      .mockRejectedValueOnce(
        Object.assign(new Error('full'), { code: 'ENOSPC' }),
      );
    const store = new SessionMediaStore();
    try {
      await expect(store.put(Uint8Array.of(1), 'image/png')).rejects.toThrow(
        'full',
      );
      await expect(store.close()).resolves.toBeUndefined();
    } finally {
      mkdir.mockRestore();
      await store.close();
    }
  });

  it('removes stored media and releases its byte accounting', async () => {
    const store = new SessionMediaStore();
    try {
      const reference = await store.put(Uint8Array.of(1, 2), 'image/png');
      expect(store.sizeBytes).toBe(2);
      await expect(store.remove(reference.mediaId)).resolves.toBe(true);
      expect(store.sizeBytes).toBe(0);
      await expect(store.read(reference.mediaId)).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('forgets media whose backing file disappeared', async () => {
    const store = new SessionMediaStore();
    try {
      const reference = await store.put(Uint8Array.of(1, 2), 'image/png');
      const read = vi
        .spyOn(fs, 'readFile')
        .mockRejectedValueOnce(
          Object.assign(new Error('gone'), { code: 'ENOENT' }),
        );
      try {
        await expect(store.read(reference.mediaId)).resolves.toBeUndefined();
        expect(store.sizeBytes).toBe(0);
        expect(() => store.assertReferences([reference])).toThrow(
          'Unknown or unavailable session media',
        );
      } finally {
        read.mockRestore();
      }
    } finally {
      await store.close();
    }
  });

  it('rejects duplicate references to one mediaId in a single message', async () => {
    // A block count cap alone does not bound the resolved payload: the same
    // mediaId repeated N times passes admission and expands per occurrence at
    // dispatch, so one small upload can serialize into gigabytes. Reject the
    // duplicate occurrences at admission.
    const store = new SessionMediaStore();
    try {
      const reference = await store.put(Uint8Array.of(1, 2, 3), 'image/png');
      expect(() =>
        store.assertReferences([reference, { ...reference }]),
      ).toThrow(/more than once/);
      // A single occurrence is still valid.
      expect(() => store.assertReferences([reference])).not.toThrow();
    } finally {
      await store.close();
    }
  });

  it('rejects references from another session store', async () => {
    const first = new SessionMediaStore();
    const second = new SessionMediaStore();
    try {
      const reference = await first.put(Uint8Array.of(1), 'image/png');
      expect(() => second.assertReferences([reference])).toThrow(
        'Unknown or unavailable session media',
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('bounds the number of stored objects', async () => {
    const store = new SessionMediaStore();
    try {
      await Promise.all(
        Array.from({ length: SESSION_MEDIA_MAX_ITEMS }, async () =>
          store.put(Uint8Array.of(1), 'image/png'),
        ),
      );
      await expect(store.put(Uint8Array.of(1), 'image/png')).rejects.toThrow(
        `${SESSION_MEDIA_MAX_ITEMS}-item session limit`,
      );
    } finally {
      await store.close();
    }
  });

  it('bounds the total bytes stored by one session', async () => {
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    const store = new SessionMediaStore();
    try {
      const item = new Uint8Array(SESSION_MEDIA_MAX_ITEM_BYTES);
      const accepted = Math.floor(
        SESSION_MEDIA_MAX_TOTAL_BYTES / SESSION_MEDIA_MAX_ITEM_BYTES,
      );
      for (let index = 0; index < accepted; index += 1) {
        await store.put(item, 'image/png');
      }

      await expect(store.put(item, 'image/png')).rejects.toThrow(
        /session limit/,
      );
      expect(store.sizeBytes).toBe(accepted * item.byteLength);
    } finally {
      write.mockRestore();
      await store.close();
    }
  });

  it('evicts a rejected memo entry so siblings and retries read again', async () => {
    // A transient non-ENOENT read failure must not be cached in a shared
    // memo: every message referencing the same mediaId would otherwise await
    // the cached rejection although the store still holds the bytes.
    const store = new SessionMediaStore();
    const readFile = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(
        Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
      );
    try {
      const reference = await store.put(Uint8Array.of(9, 9), 'image/png');
      const memo = new Map<string, Promise<ContentBlock>>();

      await expect(store.resolveContent([reference], memo)).rejects.toThrow(
        'too many open files',
      );
      // The failed entry must not stay cached: the next resolution re-reads
      // from disk and succeeds.
      await expect(store.resolveContent([reference], memo)).resolves.toEqual([
        { type: 'image', data: 'CQk=', mimeType: 'image/png' },
      ]);
      expect(readFile).toHaveBeenCalledTimes(2);
    } finally {
      readFile.mockRestore();
      await store.close();
    }
  });

  it('resolveContentDegrading drops only the unresolvable reference', async () => {
    const store = new SessionMediaStore();
    try {
      const live = await store.put(Uint8Array.of(1, 2), 'image/png');
      const gone = await store.put(Uint8Array.of(3, 4), 'image/png');
      await store.remove(gone.mediaId);
      const text = { type: 'text', text: 'both' } as ContentBlock;

      const result = await store.resolveContentDegrading([text, gone, live]);

      expect(result.degraded).toBe(1);
      expect(result.retainedBlocks).toEqual([text, live]);
      expect(result.resolvedBlocks).toEqual([
        text,
        { type: 'image', data: 'AQI=', mimeType: 'image/png' },
      ]);
    } finally {
      await store.close();
    }
  });

  it('does not make byte accounting negative when close races put', async () => {
    let finishWrite: (() => void) | undefined;
    const write = vi.spyOn(fs, 'writeFile').mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const store = new SessionMediaStore();
    try {
      const pending = store.put(Uint8Array.of(1), 'image/png');
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      await store.close();
      finishWrite?.();
      await expect(pending).rejects.toThrow('Session media store is closed');
      expect((store as unknown as { totalBytes: number }).totalBytes).toBe(0);
    } finally {
      write.mockRestore();
      await store.close();
    }
  });
});
