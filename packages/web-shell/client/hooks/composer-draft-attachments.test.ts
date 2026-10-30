import { describe, expect, it, vi } from 'vitest';
import {
  createComposerDraftAttachmentStore,
  mergeDraftAttachments,
  type ComposerDraftAttachments,
} from './composer-draft-attachments';
import { createFakeIndexedDB } from '../test/fake-indexeddb';

const DRAFT_KEY = 'qwen-web-shell-session-draft:session-a';

const attachments: ComposerDraftAttachments = {
  images: [{ data: 'aGVsbG8=', media_type: 'image/png' }],
  files: [
    { name: 'notes.txt', media_type: 'text/plain', text: 'hello', size: 5 },
  ],
};

describe('createComposerDraftAttachmentStore', () => {
  it('round-trips images and pasted files under one draft key', async () => {
    const { factory } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;

    expect(await store.save(DRAFT_KEY, attachments)).toBe(true);
    expect(await store.load(DRAFT_KEY)).toEqual(attachments);
  });

  it('keeps a File payload from a pasted file', async () => {
    const { factory } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;
    const file = new File(['png'], 'photo.png', { type: 'image/png' });

    await store.save(DRAFT_KEY, {
      images: [],
      files: [{ name: file.name, media_type: file.type, data: file, size: 3 }],
    });
    const restored = await store.load(DRAFT_KEY);

    expect(restored?.files).toHaveLength(1);
    expect(restored?.files[0]).toMatchObject({
      name: 'photo.png',
      media_type: 'image/png',
      size: 3,
    });
    // The fake stores by reference, so this proves the store did not reshape
    // the payload; a browser would hand back a structured clone instead.
    expect(restored?.files[0]?.data).toBe(file);
  });

  it('keeps each draft isolated', async () => {
    const { factory } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;
    const other: ComposerDraftAttachments = {
      images: [{ data: 'b3RoZXI=', media_type: 'image/webp' }],
      files: [],
    };
    await store.save(DRAFT_KEY, attachments);
    await store.save('qwen-web-shell-session-draft:session-b', other);

    expect(await store.load(DRAFT_KEY)).toEqual(attachments);
    expect(await store.load('qwen-web-shell-session-draft:session-b')).toEqual(
      other,
    );
  });

  it('treats a missing record as undefined', async () => {
    const { factory } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;
    expect(await store.load(DRAFT_KEY)).toBeUndefined();
  });

  it('deletes the stored record', async () => {
    const { factory } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;
    await store.save(DRAFT_KEY, attachments);
    expect(await store.load(DRAFT_KEY)).toEqual(attachments);

    expect(await store.delete(DRAFT_KEY)).toBe(true);
    expect(await store.load(DRAFT_KEY)).toBeUndefined();
  });

  it('creates its object store and closes the connection per operation', async () => {
    const { factory, db } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;

    await store.save(DRAFT_KEY, attachments);
    expect(db.objectStoreNames.contains('attachments')).toBe(true);
    const close = vi.spyOn(db, 'close');
    await store.load(DRAFT_KEY);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores a record that does not look like attachments', async () => {
    const { factory, db } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;
    db.seed('attachments', DRAFT_KEY, 'stale');

    expect(await store.load(DRAFT_KEY)).toBeUndefined();
  });

  it('drops individual entries that do not match the payload shape', async () => {
    const { factory, db } = createFakeIndexedDB();
    const store = createComposerDraftAttachmentStore(factory)!;
    db.seed('attachments', DRAFT_KEY, {
      images: [{ data: 1, media_type: 'image/png' }],
      files: [{ name: 'ok.txt', media_type: 'text/plain' }, 5],
    });

    expect(await store.load(DRAFT_KEY)).toEqual({
      images: [],
      files: [{ name: 'ok.txt', media_type: 'text/plain' }],
    });
  });

  it('fails soft when IndexedDB cannot be opened', async () => {
    const { factory } = createFakeIndexedDB({ failOpen: true });
    const store = createComposerDraftAttachmentStore(factory)!;

    // Attachments are an optimization: an unavailable store means the draft
    // keeps only its text, never an error the composer has to surface.
    expect(await store.save(DRAFT_KEY, attachments)).toBe(false);
    expect(await store.load(DRAFT_KEY)).toBeUndefined();
    expect(await store.delete(DRAFT_KEY)).toBe(false);
  });

  it('fails soft when a request fails, including delete', async () => {
    const { factory, db } = createFakeIndexedDB({ failRequests: true });
    const close = vi.spyOn(db, 'close');
    const store = createComposerDraftAttachmentStore(factory)!;

    expect(await store.save(DRAFT_KEY, attachments)).toBe(false);
    expect(await store.load(DRAFT_KEY)).toBeUndefined();
    expect(await store.delete(DRAFT_KEY)).toBe(false);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('closes a connection whose open succeeds after being blocked', async () => {
    const { factory, db } = createFakeIndexedDB({ blockedThenSuccess: true });
    const store = createComposerDraftAttachmentStore(factory)!;

    // The blocked event rejects the open (fail-soft); the success that can
    // still follow must close the fresh connection instead of leaking it.
    expect(await store.load(DRAFT_KEY)).toBeUndefined();
    expect(db.closed).toBe(true);
  });

  it('reports an unavailable store as null', () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      expect(createComposerDraftAttachmentStore()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('mergeDraftAttachments', () => {
  const current: ComposerDraftAttachments = {
    images: [{ data: 'Y3VycmVudA==', media_type: 'image/png' }],
    files: [{ name: 'current.txt', media_type: 'text/plain', text: 'now' }],
  };
  const stored: ComposerDraftAttachments = {
    images: [
      { data: 'c3RvcmVk', media_type: 'image/png' },
      { data: 'Y3VycmVudA==', media_type: 'image/png' },
    ],
    files: [
      { name: 'stored.txt', media_type: 'text/plain', text: 'old' },
      { name: 'current.txt', media_type: 'text/plain', text: 'older' },
    ],
  };

  it('merges images and preserves different files with colliding names', () => {
    expect(mergeDraftAttachments(current, stored)).toEqual({
      images: [
        { data: 'Y3VycmVudA==', media_type: 'image/png' },
        { data: 'c3RvcmVk', media_type: 'image/png' },
      ],
      files: [
        { name: 'current.txt', media_type: 'text/plain', text: 'now' },
        { name: 'stored.txt', media_type: 'text/plain', text: 'old' },
        { name: 'current (1).txt', media_type: 'text/plain', text: 'older' },
      ],
    });
  });

  it('returns the composer set unchanged when the store adds nothing', () => {
    expect(
      mergeDraftAttachments(current, {
        images: [current.images[0]!],
        files: [],
      }),
    ).toBe(current);
  });
  it('merges identical text payloads without duplicating their cards', () => {
    expect(
      mergeDraftAttachments(current, {
        images: [],
        files: [{ ...current.files[0]! }],
      }),
    ).toBe(current);
  });

  it('preserves repeated payloads within either snapshot', () => {
    const image = current.images[0]!;
    const file = current.files[0]!;
    const repeated = { images: [image, image], files: [file, file] };
    expect(mergeDraftAttachments(repeated, repeated)).toBe(repeated);
    expect(
      mergeDraftAttachments({ images: [image], files: [file] }, repeated),
    ).toEqual({
      images: [image, image],
      files: [file, { ...file, name: 'current (1).txt' }],
    });
    expect(mergeDraftAttachments({ images: [], files: [] }, repeated)).toEqual({
      images: [image, image],
      files: [file, { ...file, name: 'current (1).txt' }],
    });
  });
  it('preserves binary files with matching names and metadata', () => {
    const older = new File(['old'], 'notes.bin', {
      type: 'application/octet-stream',
    });
    const newer = new File(['new'], 'notes.bin', {
      type: 'application/octet-stream',
    });
    const merged = mergeDraftAttachments(
      {
        images: [],
        files: [{ name: newer.name, media_type: newer.type, data: newer }],
      },
      {
        images: [],
        files: [{ name: older.name, media_type: older.type, data: older }],
      },
    );
    expect(merged.files.map((file) => file.name)).toEqual([
      'notes.bin',
      'notes (1).bin',
    ]);
    expect(merged.files[0]?.data).toBe(newer);
    expect(merged.files[1]?.data).toBe(older);
  });
});
