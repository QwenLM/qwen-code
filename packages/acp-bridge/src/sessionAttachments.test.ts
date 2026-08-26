/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_ATTACHMENT_UNAVAILABLE_TEXT,
  SESSION_ATTACHMENT_MAX_ITEM_BYTES,
  SessionAttachmentStore,
  withAttachmentDegradationMarker,
} from './sessionAttachments.js';

// `node:fs` is a sealed ESM namespace: vi.spyOn cannot redefine `statSync`
// (which the store imports by name). Mock the module and delegate to the real
// implementation by default; only the stat-fault tests override it. Everything
// else (`promises`, the remaining sync exports) stays real via importOriginal.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
  };
});

describe('SessionAttachmentStore', () => {
  it('does not append the attachment degradation marker twice', () => {
    const once = withAttachmentDegradationMarker([
      { type: 'text', text: 'look at this' },
    ]);

    expect(withAttachmentDegradationMarker(once)).toEqual([
      {
        type: 'text',
        text: `look at this\n${SESSION_ATTACHMENT_UNAVAILABLE_TEXT}`,
      },
    ]);
  });

  it('stores bytes by reference and resolves them only at dispatch', async () => {
    const store = new SessionAttachmentStore();
    try {
      const reference = await store.putAttachment(
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
      expect(await store.read(reference.attachmentId)).toEqual({
        data: Buffer.from([1, 2, 3]),
        mimeType: 'image/png',
      });
    } finally {
      await store.close();
    }
  });

  it('stores text attachments under the configured runtime root', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachments-test-'),
    );
    const store = new SessionAttachmentStore(root);
    try {
      const reference = await store.putAttachment(
        new TextEncoder().encode('hello'),
        'text/plain',
        '../notes.txt',
      );

      expect(reference).toMatchObject({
        type: 'resource',
        mimeType: 'text/plain',
        size: 5,
      });
      expect(await store.resolveContent([reference])).toEqual([
        {
          type: 'resource',
          resource: {
            uri: 'attachment:///notes.txt',
            mimeType: 'text/plain',
            text: 'hello',
          },
        },
      ]);
      expect(await fs.readdir(root)).toHaveLength(1);
    } finally {
      await store.close();
      expect(await fs.readdir(root)).toEqual([]);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resolves arbitrary binary files without decoding their bytes', async () => {
    const store = new SessionAttachmentStore();
    try {
      const reference = await store.putAttachment(
        Uint8Array.from([0, 255, 1]),
        'application/pdf',
        'report.pdf',
      );

      expect(reference).toMatchObject({
        type: 'resource',
        mimeType: 'application/pdf',
      });
      expect(await store.resolveContent([reference])).toEqual([
        {
          type: 'resource',
          resource: {
            uri: 'attachment:///report.pdf',
            mimeType: 'application/pdf',
            blob: 'AP8B',
          },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it.each([
    ['app.py', 'application/octet-stream'],
    ['deploy.sh', 'application/octet-stream'],
    ['config.cjs', 'application/node'],
  ])('resolves UTF-8 source %s as text', async (name, mimeType) => {
    const store = new SessionAttachmentStore();
    try {
      const reference = await store.putAttachment(
        new TextEncoder().encode('echo hello\n'),
        mimeType,
        name,
      );

      expect(await store.resolveContent([reference])).toEqual([
        {
          type: 'resource',
          resource: {
            uri: `attachment:///${name}`,
            mimeType,
            text: 'echo hello\n',
          },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it('keeps unknown binary files as blobs', async () => {
    const store = new SessionAttachmentStore();
    try {
      const reference = await store.putAttachment(
        Uint8Array.from([0, 255, 1]),
        'application/octet-stream',
        'payload.unknown',
      );

      expect(await store.resolveContent([reference])).toEqual([
        {
          type: 'resource',
          resource: {
            uri: 'attachment:///payload.unknown',
            mimeType: 'application/octet-stream',
            blob: 'AP8B',
          },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it('stores unsupported image formats as ordinary file resources', async () => {
    const store = new SessionAttachmentStore();
    try {
      const data = new TextEncoder().encode('<svg/>');
      const reference = await store.putAttachment(
        data,
        'image/svg+xml',
        'diagram.svg',
      );

      expect(reference).toMatchObject({
        type: 'resource',
        mimeType: 'image/svg+xml',
      });
      expect(await store.resolveContent([reference])).toEqual([
        {
          type: 'resource',
          resource: {
            uri: 'attachment:///diagram.svg',
            mimeType: 'image/svg+xml',
            text: '<svg/>',
          },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it('resolves duplicate references with a single read', async () => {
    // Duplicate references to one stored item must not multiply the disk
    // reads and base64 encodes at dispatch — that amplification let one
    // small request pin gigabytes of heap.
    const store = new SessionAttachmentStore();
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      const reference = await store.putAttachment(
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
    const store = new SessionAttachmentStore();
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      const reference = await store.putAttachment(
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
  it('keeps attachments for the lifetime of the store', async () => {
    const store = new SessionAttachmentStore();
    try {
      const reference = await store.putAttachment(
        Uint8Array.of(1),
        'image/png',
      );
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));

      expect(await store.read(reference.attachmentId)).toBeDefined();
    } finally {
      vi.useRealTimers();
      await store.close();
    }
  });

  it('requires a file name for non-image uploads', async () => {
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(Uint8Array.of(1), 'audio/wav'),
      ).rejects.toThrow('Session attachment name is invalid');
    } finally {
      await store.close();
    }
  });

  it('rejects unsafe attachment names', async () => {
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(Uint8Array.of(1), 'text/plain', 'bad\0name.txt'),
      ).rejects.toThrow('attachment name is invalid');
    } finally {
      await store.close();
    }
  });

  it('rejects image names whose extension disagrees with Content-Type', async () => {
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(
          new TextEncoder().encode('not an image'),
          'text/plain',
          'screenshot.png',
        ),
      ).rejects.toThrow('Attachment name and Content-Type do not match');
      await expect(
        store.putAttachment(Uint8Array.of(1), 'image/png', 'notes.txt'),
      ).rejects.toThrow('Attachment name and Content-Type do not match');
      await expect(
        store.putAttachment(Uint8Array.of(1), 'image/jpeg', 'photo.png'),
      ).rejects.toThrow('Attachment name and Content-Type do not match');
    } finally {
      await store.close();
    }
  });

  it('allows empty files but rejects empty images and oversized uploads', async () => {
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(new Uint8Array(), 'text/plain', 'empty.txt'),
      ).resolves.toMatchObject({
        type: 'resource',
        attachmentId: 'empty.txt',
        size: 0,
      });
      await expect(
        store.putAttachment(new Uint8Array(), 'image/png'),
      ).rejects.toThrow(/images cannot be empty/);
      await expect(
        store.putAttachment(
          new Uint8Array(SESSION_ATTACHMENT_MAX_ITEM_BYTES + 1),
          'image/png',
        ),
      ).rejects.toThrow(/at most/);
    } finally {
      await store.close();
    }
  });

  it('copies stored files without changing their attachment ids', async () => {
    const source = new SessionAttachmentStore();
    const target = new SessionAttachmentStore();
    try {
      const reference = await source.putAttachment(
        Uint8Array.of(1, 2, 3),
        'application/json',
        'notes.json',
      );
      await target.copyFrom(source);
      await expect(target.read(reference.attachmentId)).resolves.toEqual({
        data: Buffer.from([1, 2, 3]),
        mimeType: 'application/json',
      });
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('keeps deduplicated long names readable', async () => {
    const store = new SessionAttachmentStore();
    const name = `a.${'x'.repeat(248)} y`;
    try {
      await store.putAttachment(
        Uint8Array.of(1),
        'application/octet-stream',
        name,
      );
      const duplicate = await store.putAttachment(
        Uint8Array.of(2),
        'application/octet-stream',
        name,
      );

      expect(Buffer.byteLength(duplicate.attachmentId)).toBeLessThanOrEqual(
        255,
      );
      await expect(store.read(duplicate.attachmentId)).resolves.toMatchObject({
        data: Buffer.from([2]),
      });
    } finally {
      await store.close();
    }
  });

  it('does not delete the original when a long duplicate name is invalid', async () => {
    const store = new SessionAttachmentStore();
    const name = `中.${'a'.repeat(251)}`;
    try {
      const original = await store.putAttachment(
        Uint8Array.of(1),
        'application/octet-stream',
        name,
      );

      await expect(
        store.putAttachment(Uint8Array.of(2), 'application/octet-stream', name),
      ).rejects.toThrow('Session attachment name is invalid');
      await expect(store.read(original.attachmentId)).resolves.toMatchObject({
        data: Buffer.from([1]),
      });
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
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(Uint8Array.of(1), 'image/png'),
      ).rejects.toThrow('full');
      mkdir.mockRestore();
      await expect(
        store.putAttachment(Uint8Array.of(1), 'image/png'),
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
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(Uint8Array.of(1), 'image/png'),
      ).rejects.toThrow('full');
      expect(remove).toHaveBeenCalledWith(expect.any(String), { force: true });
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
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(Uint8Array.of(1), 'image/png'),
      ).rejects.toThrow('full');
      await expect(store.close()).resolves.toBeUndefined();
    } finally {
      mkdir.mockRestore();
      await store.close();
    }
  });

  it('removes stored attachments', async () => {
    const store = new SessionAttachmentStore();
    try {
      const reference = await store.putAttachment(
        Uint8Array.of(1, 2),
        'image/png',
      );
      await expect(store.remove(reference.attachmentId)).resolves.toBe(true);
      await expect(store.read(reference.attachmentId)).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('protects an upload name before directory creation settles', async () => {
    const store = new SessionAttachmentStore();
    try {
      const pending = store.putAttachment(
        Uint8Array.of(1),
        'application/octet-stream',
        'same.bin',
      );

      await expect(store.remove('same.bin')).resolves.toBe(false);
      const reference = await pending;
      await expect(store.read(reference.attachmentId)).resolves.toMatchObject({
        data: Buffer.from([1]),
      });
    } finally {
      await store.close();
    }
  });

  it('allows removal while another attachment is uploading', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'qwen-attachment-race-'));
    const originalWriteFile = fs.writeFile.bind(fs);
    let finishWrite: (() => void) | undefined;
    const write = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('slow.bin')) {
          await new Promise<void>((resolve) => {
            finishWrite = resolve;
          });
        }
        return await originalWriteFile(...args);
      });
    const store = new SessionAttachmentStore(root, 'session-a');
    try {
      const existing = await store.putAttachment(
        Uint8Array.of(1, 2),
        'application/octet-stream',
        'existing.bin',
      );
      const pending = store.putAttachment(
        new Uint8Array(8),
        'application/octet-stream',
        'slow.bin',
      );
      await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));

      await expect(store.remove(existing.attachmentId)).resolves.toBe(true);

      finishWrite?.();
      await expect(pending).resolves.toMatchObject({ size: 8 });
    } finally {
      finishWrite?.();
      write.mockRestore();
      await store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a same-name upload protected while its duplicate retries', async () => {
    const originalWriteFile = fs.writeFile.bind(fs);
    let firstCreated: (() => void) | undefined;
    let finishFirst: (() => void) | undefined;
    const created = new Promise<void>((resolve) => {
      firstCreated = resolve;
    });
    const waitForFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let first = true;
    const write = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args) => {
        if (first && String(args[0]).endsWith('notes.txt')) {
          first = false;
          await originalWriteFile(...args);
          firstCreated?.();
          await waitForFinish;
          return;
        }
        return await originalWriteFile(...args);
      });
    const store = new SessionAttachmentStore();
    try {
      const pending = store.putAttachment(
        new TextEncoder().encode('first'),
        'text/plain',
        'notes.txt',
      );
      await created;
      const duplicate = await store.putAttachment(
        new TextEncoder().encode('second'),
        'text/plain',
        'notes.txt',
      );

      expect(duplicate.attachmentId).toBe('notes (1).txt');
      await expect(store.remove('notes.txt')).resolves.toBe(false);
      finishFirst?.();
      const original = await pending;
      await expect(store.read(original.attachmentId)).resolves.toMatchObject({
        data: Buffer.from('first'),
      });
    } finally {
      finishFirst?.();
      write.mockRestore();
      await store.close();
    }
  });

  it('waits for target uploads before copying files', async () => {
    const source = new SessionAttachmentStore();
    const target = new SessionAttachmentStore();
    const sourceReference = await source.putAttachment(
      Uint8Array.of(1, 2, 3),
      'application/octet-stream',
      'source.bin',
    );
    const originalWriteFile = fs.writeFile.bind(fs);
    let finishWrite: (() => void) | undefined;
    const write = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('target.bin')) {
          await new Promise<void>((resolve) => {
            finishWrite = resolve;
          });
        }
        return await originalWriteFile(...args);
      });
    try {
      const pending = target.putAttachment(
        new Uint8Array(8),
        'application/octet-stream',
        'target.bin',
      );
      await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
      const copying = target.copyFrom(source);
      finishWrite?.();
      await Promise.all([pending, copying]);

      await expect(target.read(sourceReference.attachmentId)).resolves.toEqual({
        data: Buffer.from([1, 2, 3]),
        mimeType: 'application/octet-stream',
      });
    } finally {
      finishWrite?.();
      write.mockRestore();
      await source.close();
      await target.close();
    }
  });

  it('waits for source uploads before copying files', async () => {
    const source = new SessionAttachmentStore();
    const target = new SessionAttachmentStore();
    const originalWriteFile = fs.writeFile.bind(fs);
    let finishWrite: (() => void) | undefined;
    const write = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('source.bin')) {
          await originalWriteFile(...args);
          await new Promise<void>((resolve) => {
            finishWrite = resolve;
          });
          return;
        }
        return await originalWriteFile(...args);
      });
    try {
      const pending = source.putAttachment(
        new Uint8Array(8),
        'application/octet-stream',
        'source.bin',
      );
      await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
      const copying = target.copyFrom(source);
      finishWrite?.();
      const [reference] = await Promise.all([pending, copying]);

      await expect(target.read(reference.attachmentId)).resolves.toEqual({
        data: Buffer.alloc(8),
        mimeType: 'application/octet-stream',
      });
    } finally {
      finishWrite?.();
      write.mockRestore();
      await source.close();
      await target.close();
    }
  });

  it('skips source files removed while copying', async () => {
    const source = new SessionAttachmentStore();
    const target = new SessionAttachmentStore();
    await source.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'gone.bin',
    );
    const originalCopyFile = fs.copyFile.bind(fs);
    const copy = vi
      .spyOn(fs, 'copyFile')
      .mockImplementationOnce(async (...args) => {
        await fs.rm(args[0], { force: true });
        return await originalCopyFile(...args);
      });
    try {
      await expect(target.copyFrom(source)).resolves.toBeUndefined();
    } finally {
      copy.mockRestore();
      await source.close();
      await target.close();
    }
  });

  it.each(['source', 'target'] as const)(
    'waits for copying before deleting the %s store',
    async (storeToDelete) => {
      const source = new SessionAttachmentStore();
      const target = new SessionAttachmentStore();
      await source.putAttachment(
        Uint8Array.of(1),
        'application/octet-stream',
        'copy.bin',
      );
      const originalCopyFile = fs.copyFile.bind(fs);
      let finishCopy: (() => void) | undefined;
      const copy = vi.spyOn(fs, 'copyFile').mockImplementationOnce(
        async (...args) =>
          await new Promise<void>((resolve, reject) => {
            finishCopy = () => {
              void originalCopyFile(...args).then(resolve, reject);
            };
          }),
      );
      try {
        const copying = target.copyFrom(source);
        await vi.waitFor(() => expect(finishCopy).toBeTypeOf('function'));
        let deleted = false;
        const deleting = (storeToDelete === 'source' ? source : target)
          .delete()
          .then(() => {
            deleted = true;
          });
        await Promise.resolve();
        expect(deleted).toBe(false);

        finishCopy?.();
        await Promise.all([copying, deleting]);
        if (storeToDelete === 'source') {
          await expect(target.read('copy.bin')).resolves.toMatchObject({
            data: Buffer.from([1]),
          });
        }
      } finally {
        finishCopy?.();
        copy.mockRestore();
        await source.close();
        await target.close();
      }
    },
  );

  it('blocks a new copy once deletion starts', async () => {
    const source = new SessionAttachmentStore();
    const target = new SessionAttachmentStore();
    try {
      const deleting = source.delete();
      await expect(target.copyFrom(source)).rejects.toThrow(
        'Session attachment store is closed',
      );
      await deleting;
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('checks the runtime generation before deleting persisted attachments', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-fence-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    const reference = await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'kept.bin',
    );
    const generationClosed = new Error('generation closed');

    await expect(
      store.delete({
        assertCanCommit: () => {
          throw generationClosed;
        },
      }),
    ).rejects.toBe(generationClosed);
    await expect(
      fs.stat(path.join(root, 'session-session-a', reference.attachmentId)),
    ).resolves.toBeDefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('deletes a claimed tombstone without touching a successor directory', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-successor-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    const reference = await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'old.bin',
    );
    const directory = path.join(root, 'session-session-a');
    const remove = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementationOnce(async (target) => {
      expect(target).not.toBe(directory);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'new.bin'), Uint8Array.of(2));
      await remove(target, { recursive: true, force: true });
    });

    try {
      await store.delete();
      await expect(
        fs.stat(path.join(directory, 'new.bin')),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(directory, reference.attachmentId)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      rmSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('forgets attachments whose backing file disappeared', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'qwen-attachment-gone-'));
    const store = new SessionAttachmentStore(root, 'session-a');
    try {
      const reference = await store.putAttachment(
        Uint8Array.of(1, 2),
        'image/png',
      );
      await fs.rm(path.join(root, 'session-session-a', reference.attachmentId));

      await expect(store.read(reference.attachmentId)).resolves.toBeUndefined();
      expect(() => store.assertReferences([reference])).toThrow(
        'Unknown or unavailable session attachment',
      );
    } finally {
      await store.delete();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('uses deduplicated file names and restores them after close', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-restart-'),
    );
    const first = new SessionAttachmentStore(root, 'session-a');
    try {
      const original = await first.putAttachment(
        new TextEncoder().encode('first'),
        'application/json',
        'notes.json',
      );
      const duplicate = await first.putAttachment(
        new TextEncoder().encode('second'),
        'application/json',
        'notes.json',
      );
      const typescript = await first.putAttachment(
        new TextEncoder().encode('const value = 1;'),
        'text/plain',
        'example.ts',
      );
      const image = await first.putAttachment(Uint8Array.of(1), 'image/png');
      const duplicateImage = await first.putAttachment(
        Uint8Array.of(2),
        'image/png',
      );
      expect(original).toMatchObject({
        attachmentId: 'notes.json',
      });
      expect(duplicate).toMatchObject({
        attachmentId: 'notes (1).json',
      });
      expect(image.attachmentId).toBe('image.png');
      expect(duplicateImage.attachmentId).toBe('image (1).png');

      await first.close();
      const restored = new SessionAttachmentStore(root, 'session-a');
      try {
        await expect(restored.read(original.attachmentId)).resolves.toEqual({
          data: Buffer.from('first'),
          mimeType: 'application/json',
        });
        await expect(restored.read(duplicate.attachmentId)).resolves.toEqual({
          data: Buffer.from('second'),
          mimeType: 'application/json',
        });
        await expect(restored.resolveContent([typescript])).resolves.toEqual([
          {
            type: 'resource',
            resource: {
              uri: 'attachment:///example.ts',
              mimeType: 'text/plain',
              text: 'const value = 1;',
            },
          },
        ]);
        await expect(
          restored.read(duplicateImage.attachmentId),
        ).resolves.toEqual({
          data: Buffer.from([2]),
          mimeType: 'image/png',
        });
      } finally {
        await restored.delete();
      }
      await expect(fs.readdir(root)).resolves.toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps deduplicated names within the filesystem byte limit', async () => {
    const store = new SessionAttachmentStore();
    const name = `${'a'.repeat(250)}.txt`;
    try {
      await store.putAttachment(Uint8Array.of(1), 'text/plain', name);
      const duplicate = await store.putAttachment(
        Uint8Array.of(2),
        'text/plain',
        name,
      );

      expect(Buffer.byteLength(duplicate.attachmentId)).toBeLessThanOrEqual(
        255,
      );
      expect(duplicate.attachmentId.endsWith(' (1).txt')).toBe(true);
      await expect(store.read(duplicate.attachmentId)).resolves.toMatchObject({
        data: Buffer.from([2]),
      });
    } finally {
      await store.close();
    }
  });

  it.each(['CON', 'nul.txt', 'bad:name.txt'])(
    'rejects non-portable attachment name %s',
    async (name) => {
      const store = new SessionAttachmentStore();
      try {
        await expect(
          store.putAttachment(Uint8Array.of(1), 'text/plain', name),
        ).rejects.toThrow('Session attachment name is invalid');
      } finally {
        await store.close();
      }
    },
  );

  it('rejects duplicate references to one attachmentId in a single message', async () => {
    // A block count cap alone does not bound the resolved payload: the same
    // attachmentId repeated N times passes admission and expands per occurrence at
    // dispatch, so one small upload can serialize into gigabytes. Reject the
    // duplicate occurrences at admission.
    const store = new SessionAttachmentStore();
    try {
      const reference = await store.putAttachment(
        Uint8Array.of(1, 2, 3),
        'image/png',
      );
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
    const first = new SessionAttachmentStore();
    const second = new SessionAttachmentStore();
    try {
      const reference = await first.putAttachment(
        Uint8Array.of(1),
        'image/png',
      );
      expect(() => second.assertReferences([reference])).toThrow(
        'Unknown or unavailable session attachment',
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('does not cap the number of stored objects per session', async () => {
    const store = new SessionAttachmentStore();
    try {
      const references = await Promise.all(
        Array.from({ length: 257 }, async (_, index) =>
          store.putAttachment(
            Uint8Array.of(1),
            'application/octet-stream',
            `file-${index}.bin`,
          ),
        ),
      );
      expect(references).toHaveLength(257);
    } finally {
      await store.close();
    }
  });

  it('does not cap the total bytes stored by one session', async () => {
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    const store = new SessionAttachmentStore();
    try {
      const item = new Uint8Array(SESSION_ATTACHMENT_MAX_ITEM_BYTES);
      for (let index = 0; index < 13; index += 1) {
        await store.putAttachment(item, 'image/png');
      }
    } finally {
      write.mockRestore();
      await store.close();
    }
  });

  it('evicts a rejected memo entry so siblings and retries read again', async () => {
    // A transient non-ENOENT read failure must not be cached in a shared
    // memo: every message referencing the same attachmentId would otherwise await
    // the cached rejection although the store still holds the bytes.
    const store = new SessionAttachmentStore();
    const readFile = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(
        Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
      );
    try {
      const reference = await store.putAttachment(
        Uint8Array.of(9, 9),
        'image/png',
      );
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
    const store = new SessionAttachmentStore();
    try {
      const live = await store.putAttachment(Uint8Array.of(1, 2), 'image/png');
      const gone = await store.putAttachment(Uint8Array.of(3, 4), 'image/png');
      await store.remove(gone.attachmentId);
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

  it('rejects an upload when close races its write', async () => {
    let finishWrite: (() => void) | undefined;
    const write = vi.spyOn(fs, 'writeFile').mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const store = new SessionAttachmentStore();
    try {
      const pending = store.putAttachment(Uint8Array.of(1), 'image/png');
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      await store.close();
      finishWrite?.();
      await expect(pending).rejects.toThrow(
        'Session attachment store is closed',
      );
    } finally {
      write.mockRestore();
      await store.close();
    }
  });

  describe('fallback root', () => {
    const sessionId = 's-1';
    const sessionDir = `session-${encodeURIComponent(sessionId)}`;

    async function createRoots(): Promise<{
      main: string;
      fallback: string;
    }> {
      const main = await fs.mkdtemp(
        path.join(tmpdir(), 'qwen-attachments-main-'),
      );
      const fallback = await fs.mkdtemp(
        path.join(tmpdir(), 'qwen-attachments-fallback-'),
      );
      return { main, fallback };
    }

    async function writeIn(
      root: string,
      name: string,
      data: string,
    ): Promise<void> {
      const directory = path.join(root, sessionDir);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, name), data);
    }

    it('reads from the fallback root when the primary misses', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        await writeIn(fallback, 'notes.txt', 'from fallback');

        expect(await store.read('notes.txt')).toEqual({
          data: Buffer.from('from fallback'),
          mimeType: 'text/plain',
        });
        expect(() =>
          store.assertReference({
            type: 'resource',
            attachmentId: 'notes.txt',
            mimeType: 'text/plain',
            size: 13,
          }),
        ).not.toThrow();
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('reads the fallback when the primary root cannot be created', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        await writeIn(fallback, 'notes.txt', 'legacy bytes');
        // A degraded configured volume must not fail a read that the healthy
        // fallback can serve; the read path must not force-create the
        // primary directory.
        const mkdir = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
          Object.assign(new Error('permission denied'), {
            code: 'EACCES',
          }),
        );
        try {
          expect(await store.read('notes.txt')).toEqual({
            data: Buffer.from('legacy bytes'),
            mimeType: 'text/plain',
          });
          expect(mkdir).not.toHaveBeenCalled();
        } finally {
          mkdir.mockRestore();
        }
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('reads the fallback when an established primary root degrades', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        await store.putAttachment(
          new TextEncoder().encode('current'),
          'text/plain',
          'current.txt',
        );
        await writeIn(fallback, 'notes.txt', 'legacy bytes');
        // A non-ENOENT primary read failure (the volume degraded after boot)
        // must degrade to the fallback instead of rejecting.
        const readFile = vi
          .spyOn(fs, 'readFile')
          .mockRejectedValueOnce(
            Object.assign(new Error('volume degraded'), { code: 'EIO' }),
          );
        try {
          expect(await store.read('notes.txt')).toEqual({
            data: Buffer.from('legacy bytes'),
            mimeType: 'text/plain',
          });
          expect(readFile.mock.calls[0]?.[0]).toBe(
            path.join(main, sessionDir, 'notes.txt'),
          );
        } finally {
          readFile.mockRestore();
        }
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('prefers the primary root over the fallback', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        const reference = await store.putAttachment(
          new TextEncoder().encode('primary'),
          'text/plain',
          'notes.txt',
        );
        await writeIn(fallback, 'notes.txt', 'stale fallback');

        expect(await store.read(reference.attachmentId)).toEqual({
          data: Buffer.from('primary'),
          mimeType: 'text/plain',
        });

        // With both roots holding the name, the authoritative primary
        // reference must validate while the stale fallback size must not.
        expect(() =>
          store.assertReference({
            type: 'resource',
            attachmentId: reference.attachmentId,
            mimeType: 'text/plain',
            size: 7,
          }),
        ).not.toThrow();
        expect(() =>
          store.assertReference({
            type: 'resource',
            attachmentId: reference.attachmentId,
            mimeType: 'text/plain',
            size: 14,
          }),
        ).toThrowError(
          expect.objectContaining({ code: 'session_attachment_gone' }),
        );
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('does not shadow a fallback name with a new upload', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        await writeIn(fallback, 'notes.txt', 'stale fallback');

        const reference = await store.putAttachment(
          new TextEncoder().encode('fresh upload'),
          'text/plain',
          'notes.txt',
        );

        expect(reference.attachmentId).not.toBe('notes.txt');
        expect(await store.read(reference.attachmentId)).toEqual({
          data: Buffer.from('fresh upload'),
          mimeType: 'text/plain',
        });
        // The pre-switch attachment is still reachable under its own ID.
        expect(await store.read('notes.txt')).toEqual({
          data: Buffer.from('stale fallback'),
          mimeType: 'text/plain',
        });
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('surfaces a fallback stat error instead of shadowing the name', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      const stat = vi.mocked(statSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      });
      try {
        await writeIn(fallback, 'notes.txt', 'stale fallback');

        // A temporarily-unreadable fallback must not be treated as "name
        // free": failing the upload is safer than shadowing the old file.
        await expect(
          store.putAttachment(
            new TextEncoder().encode('fresh upload'),
            'text/plain',
            'notes.txt',
          ),
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        stat.mockRestore();
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('still degrades reference validation when the fallback stat fails', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      // Arm the faults per call order: ENOENT for the primary stat, EACCES
      // for the fallback stat the test name targets.
      const stat = vi
        .mocked(statSync)
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        })
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('permission denied'), {
            code: 'EACCES',
          });
        });
      try {
        await writeIn(fallback, 'notes.txt', 'stale fallback');

        // Reference validation must degrade to session_attachment_gone, not
        // surface the raw stat error and abort the prompt. The reference size
        // matches the fallback file, so the throw can only come from the
        // degradation path.
        expect(() =>
          store.assertReference({
            type: 'resource',
            attachmentId: 'notes.txt',
            mimeType: 'text/plain',
            size: 14,
          }),
        ).toThrowError(
          expect.objectContaining({ code: 'session_attachment_gone' }),
        );
        expect(stat.mock.calls[0]?.[0]).toBe(
          path.join(main, sessionDir, 'notes.txt'),
        );
        expect(stat.mock.calls[1]?.[0]).toBe(
          path.join(fallback, sessionDir, 'notes.txt'),
        );
      } finally {
        stat.mockRestore();
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('returns undefined when neither root holds the attachment', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        expect(await store.read('missing.txt')).toBeUndefined();
        expect(await store.remove('missing.txt')).toBe(false);
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('removes a fallback attachment when the primary misses', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        await writeIn(fallback, 'notes.txt', 'from fallback');

        expect(await store.remove('notes.txt')).toBe(true);
        expect(await fs.readdir(path.join(fallback, sessionDir))).toEqual([]);
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('removes a fallback attachment when the primary root cannot be created', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        await writeIn(fallback, 'notes.txt', 'legacy bytes');
        // The removal must not force-create the primary directory: a
        // degraded configured volume must not fail a deletion whose only
        // copy lives in the healthy fallback.
        const mkdir = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
          Object.assign(new Error('permission denied'), {
            code: 'EACCES',
          }),
        );
        try {
          expect(await store.remove('notes.txt')).toBe(true);
          expect(mkdir).not.toHaveBeenCalled();
          expect(await fs.readdir(path.join(fallback, sessionDir))).toEqual([]);
          expect(await fs.readdir(main)).toEqual([]);
        } finally {
          mkdir.mockRestore();
        }
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('removes both copies when both roots hold the same name', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      try {
        await writeIn(main, 'notes.txt', 'from primary');
        await writeIn(fallback, 'notes.txt', 'stale fallback copy');

        expect(await store.remove('notes.txt')).toBe(true);
        expect(await store.read('notes.txt')).toBeUndefined();
        expect(await fs.readdir(path.join(main, sessionDir))).toEqual([]);
        expect(await fs.readdir(path.join(fallback, sessionDir))).toEqual([]);
      } finally {
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('keeps the primary readable when the fallback unlink fails', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      const realUnlink = fs.unlink.bind(fs);
      const unlink = vi
        .spyOn(fs, 'unlink')
        .mockImplementation(async (filePath) => {
          if (String(filePath).startsWith(path.join(fallback, sessionDir))) {
            throw Object.assign(new Error('read-only volume'), {
              code: 'EROFS',
            });
          }
          return realUnlink(filePath);
        });
      try {
        await writeIn(main, 'notes.txt', 'from primary');
        await writeIn(fallback, 'notes.txt', 'stale fallback copy');

        // The fallback copy cannot be removed; remove() must fail cleanly and
        // leave the authoritative primary copy readable instead of deleting it
        // and resurrecting stale fallback bytes on the next read. Rejecting
        // only fallback-targeted unlinks also pins the fallback-first order:
        // a primary-first remove() would really delete the primary copy.
        await expect(store.remove('notes.txt')).rejects.toThrow(
          'read-only volume',
        );
        expect(await store.read('notes.txt')).toEqual({
          data: Buffer.from('from primary'),
          mimeType: 'text/plain',
        });
      } finally {
        unlink.mockRestore();
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('delete clears both the primary and fallback directories', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      await store.putAttachment(
        new TextEncoder().encode('primary'),
        'text/plain',
        'notes.txt',
      );
      await writeIn(fallback, 'old.txt', 'from fallback');

      await store.delete();

      await expect(
        fs.readdir(path.join(main, sessionDir)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.readdir(path.join(fallback, sessionDir)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('delete clears the fallback directory when only it holds data', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      await writeIn(fallback, 'old.txt', 'from fallback');

      await store.delete();

      await expect(
        fs.readdir(path.join(main, sessionDir)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.readdir(path.join(fallback, sessionDir)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the primary directory intact when the fallback removal fails', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      await writeIn(main, 'current.txt', 'primary data');
      await writeIn(fallback, 'legacy.txt', 'legacy data');
      const realRename = fs.rename.bind(fs);
      const rename = vi
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          if (String(from).startsWith(fallback)) {
            throw Object.assign(new Error('read-only volume'), {
              code: 'EROFS',
            });
          }
          return realRename(from, to);
        });
      try {
        // delete() removes the fallback root first so a failure there keeps
        // the authoritative primary copy intact.
        await expect(store.delete()).rejects.toMatchObject({ code: 'EROFS' });
        expect(
          await fs.readFile(path.join(main, sessionDir, 'current.txt'), 'utf8'),
        ).toBe('primary data');
      } finally {
        rename.mockRestore();
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('delete tombstones both roots so a recreated session dir survives', async () => {
      const { main, fallback } = await createRoots();
      const store = new SessionAttachmentStore(main, sessionId, fallback);
      await writeIn(main, 'old.txt', 'from primary');
      await writeIn(fallback, 'old.txt', 'from fallback');
      // For every tombstone rename (primary and fallback), a successor
      // re-creates the session directory at its original path — the tombstone
      // removal must not sweep that fresh directory up.
      const realRename = fs.rename.bind(fs);
      const rename = vi
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          await realRename(from, to);
          await fs.mkdir(String(from), { recursive: true });
          await fs.writeFile(
            path.join(String(from), 'successor.txt'),
            'new owner',
          );
        });
      try {
        await store.delete();
        expect(
          await fs.readFile(
            path.join(main, sessionDir, 'successor.txt'),
            'utf8',
          ),
        ).toBe('new owner');
        expect(
          await fs.readFile(
            path.join(fallback, sessionDir, 'successor.txt'),
            'utf8',
          ),
        ).toBe('new owner');
      } finally {
        rename.mockRestore();
        await store.close();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
      }
    });

    it('copyFrom merges fallback-held attachments with primary winning on conflicts', async () => {
      const { main, fallback } = await createRoots();
      const source = new SessionAttachmentStore(main, sessionId, fallback);
      const targetRoot = await fs.mkdtemp(
        path.join(tmpdir(), 'qwen-attachments-target-'),
      );
      const target = new SessionAttachmentStore(targetRoot, sessionId);
      try {
        await source.putAttachment(
          new TextEncoder().encode('primary file'),
          'text/plain',
          'primary.txt',
        );
        await source.putAttachment(
          new TextEncoder().encode('primary version'),
          'text/plain',
          'conflict.txt',
        );
        await writeIn(fallback, 'legacy.txt', 'legacy');
        await writeIn(fallback, 'conflict.txt', 'fallback version');

        await target.copyFrom(source);

        expect(await target.read('primary.txt')).toEqual({
          data: Buffer.from('primary file'),
          mimeType: 'text/plain',
        });
        expect(await target.read('legacy.txt')).toEqual({
          data: Buffer.from('legacy'),
          mimeType: 'text/plain',
        });
        expect(await target.read('conflict.txt')).toEqual({
          data: Buffer.from('primary version'),
          mimeType: 'text/plain',
        });
      } finally {
        await source.close();
        await target.delete();
        await fs.rm(main, { recursive: true, force: true });
        await fs.rm(fallback, { recursive: true, force: true });
        await fs.rm(targetRoot, { recursive: true, force: true });
      }
    });
  });
});
