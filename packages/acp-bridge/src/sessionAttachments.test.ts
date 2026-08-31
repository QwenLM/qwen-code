/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
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

  it('retries durable deletion after the attachment parent sync fails', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-durability-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'old.bin',
    );
    const originalOpen = fs.open.bind(fs);
    let failSync = true;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === root) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (failSync) {
            failSync = false;
            throw Object.assign(new Error('directory sync failure'), {
              code: 'EIO',
            });
          }
          await originalSync();
        };
      }
      return handle;
    });

    try {
      await expect(store.delete()).rejects.toMatchObject({ code: 'EIO' });
      await expect(
        fs.stat(path.join(root, 'session-session-a')),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      await expect(store.delete()).resolves.toBeUndefined();
    } finally {
      open.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects attachment parent disappearance after opening it', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-parent-vanished-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    const reference = await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'kept.bin',
    );
    const originalStat = fs.stat.bind(fs);
    const vanished = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    let rejectParentStat = true;
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      if (String(args[0]) === root && rejectParentStat) {
        rejectParentStat = false;
        throw vanished;
      }
      return originalStat(...args);
    });

    try {
      await expect(store.delete()).rejects.toBe(vanished);
      await expect(
        fs.stat(path.join(root, 'session-session-a', reference.attachmentId)),
      ).resolves.toBeDefined();
    } finally {
      stat.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retries a claimed attachment tombstone without deleting a successor', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-tombstone-retry-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'old.bin',
    );
    const directory = path.join(root, 'session-session-a');
    const tombstone = path.join(root, '.session-session-a.deleting');
    const removeError = Object.assign(new Error('remove failed'), {
      code: 'EIO',
    });
    const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(removeError);

    try {
      await expect(store.delete()).rejects.toBe(removeError);
      await expect(fs.stat(tombstone)).resolves.toBeDefined();
      await expect(fs.stat(directory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, 'successor.bin'),
        Uint8Array.of(2),
      );

      const recovery = new SessionAttachmentStore(root, 'session-a');
      await expect(recovery.delete()).resolves.toBeUndefined();

      await expect(fs.stat(tombstone)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        fs.stat(path.join(directory, 'successor.bin')),
      ).resolves.toBeDefined();
    } finally {
      remove.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rechecks the runtime generation after opening the attachment parent', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-parent-fence-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'kept.bin',
    );
    const originalOpen = fs.open.bind(fs);
    let continueOpen: (() => void) | undefined;
    const openPaused = new Promise<void>((resolve) => {
      continueOpen = resolve;
    });
    let parentOpened: (() => void) | undefined;
    const parentOpenStarted = new Promise<void>((resolve) => {
      parentOpened = resolve;
    });
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === root) {
        parentOpened?.();
        await openPaused;
      }
      return originalOpen(...args);
    });
    const rename = vi.spyOn(fs, 'rename');
    const generationClosed = new Error('runtime generation closed');
    let generationCurrent = true;

    try {
      const deleting = store.delete({
        assertCanCommit: () => {
          if (!generationCurrent) throw generationClosed;
        },
      });
      await parentOpenStarted;
      generationCurrent = false;
      continueOpen?.();

      await expect(deleting).rejects.toBe(generationClosed);
      expect(rename).not.toHaveBeenCalled();
      await expect(
        fs.stat(path.join(root, 'session-session-a', 'kept.bin')),
      ).resolves.toBeDefined();
    } finally {
      continueOpen?.();
      open.mockRestore();
      rename.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('deletes attachments when the filesystem does not expose inodes', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-zero-inode-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'old.bin',
    );
    const originalOpen = fs.open.bind(fs);
    const originalStat = fs.stat.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === root) {
        const handleStat = handle.stat.bind(handle);
        handle.stat = (async (...statArgs) => {
          const result = await handleStat(...statArgs);
          Object.defineProperty(result, 'ino', { value: 0 });
          return result;
        }) as typeof handle.stat;
      }
      return handle;
    });
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const result = await originalStat(...args);
      if (String(args[0]) === root) {
        Object.defineProperty(result, 'ino', { value: 0 });
      }
      return result;
    });

    try {
      await expect(store.delete()).resolves.toBeUndefined();
      await expect(
        fs.stat(path.join(root, 'session-session-a')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      open.mockRestore();
      stat.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects deletion when parent inode verifiability changes', async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'qwen-attachment-inode-transition-'),
    );
    const store = new SessionAttachmentStore(root, 'session-a');
    await store.putAttachment(
      Uint8Array.of(1),
      'application/octet-stream',
      'kept.bin',
    );
    const originalOpen = fs.open.bind(fs);
    const originalStat = fs.stat.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === root) {
        const handleStat = handle.stat.bind(handle);
        handle.stat = (async (...statArgs) => {
          const result = await handleStat(...statArgs);
          Object.defineProperty(result, 'ino', { value: 1 });
          return result;
        }) as typeof handle.stat;
      }
      return handle;
    });
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const result = await originalStat(...args);
      if (String(args[0]) === root) {
        Object.defineProperty(result, 'ino', { value: 0 });
      }
      return result;
    });
    const rename = vi.spyOn(fs, 'rename');

    try {
      await expect(store.delete()).rejects.toThrow(
        'Session attachment parent directory changed.',
      );
      expect(rename).not.toHaveBeenCalled();
      await expect(
        fs.stat(path.join(root, 'session-session-a', 'kept.bin')),
      ).resolves.toBeDefined();
    } finally {
      open.mockRestore();
      stat.mockRestore();
      rename.mockRestore();
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
});
