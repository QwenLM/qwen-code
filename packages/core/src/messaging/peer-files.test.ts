/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_PRODUCT_HOME } from '../config/brand.js';
import {
  MAX_PEER_FILES,
  getInboundUploadDir,
  describePeerFiles,
  discardPeerFiles,
  injectPeerFilePrefix,
  isPeerFileRef,
  materializePeerFiles,
} from './peer-files.js';

let workDir: string;
let previousHome: string | undefined;

async function makeFile(name: string, contents = 'hello'): Promise<string> {
  const file = path.join(workDir, name);
  await fs.writeFile(file, contents);
  return file;
}

describe('peer files', () => {
  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-peer-files-'));
    previousHome = process.env[ENV_PRODUCT_HOME];
    process.env[ENV_PRODUCT_HOME] = path.join(workDir, 'home');
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env[ENV_PRODUCT_HOME];
    else process.env[ENV_PRODUCT_HOME] = previousHome;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  describe('describePeerFiles', () => {
    it('accepts a readable absolute path', async () => {
      const file = await makeFile('a.txt');
      const result = await describePeerFiles([file]);
      expect(result.files).toEqual([
        { path: file, name: 'a.txt', bytes: 5 },
      ]);
      expect(result.rejected).toHaveLength(0);
    });

    it('rejects a relative path', async () => {
      const result = await describePeerFiles(['relative.txt']);
      expect(result.files).toHaveLength(0);
      expect(result.rejected[0]).toContain('not an absolute path');
    });

    it('rejects a directory', async () => {
      const result = await describePeerFiles([workDir]);
      expect(result.rejected[0]).toContain('not a regular file');
    });

    it('rejects a missing file', async () => {
      const result = await describePeerFiles([path.join(workDir, 'nope.txt')]);
      expect(result.rejected[0]).toContain('unreadable');
    });

    it('caps the number of attachments and says so', async () => {
      const files = await Promise.all(
        Array.from({ length: MAX_PEER_FILES + 2 }, (_, i) =>
          makeFile(`f${i}.txt`),
        ),
      );
      const result = await describePeerFiles(files);
      expect(result.files).toHaveLength(MAX_PEER_FILES);
      expect(result.rejected.at(-1)).toContain('beyond the limit');
    });
  });

  describe('isPeerFileRef', () => {
    it('accepts a well-formed reference', () => {
      expect(isPeerFileRef({ path: '/a', name: 'a', bytes: 1 })).toBe(true);
    });

    it('rejects malformed values', () => {
      expect(isPeerFileRef(null)).toBe(false);
      expect(isPeerFileRef({ path: '/a' })).toBe(false);
      expect(isPeerFileRef({ path: '', name: 'a', bytes: 1 })).toBe(false);
    });
  });

  describe('materializePeerFiles', () => {
    it('copies into the receiver uploads directory', async () => {
      const source = await makeFile('report.txt', 'payload');
      const result = await materializePeerFiles(
        [{ path: source, name: 'report.txt', bytes: 7 }],
        'session-abc',
      );

      expect(result.received).toBe(1);
      const copied = result.paths[0];
      expect(copied.startsWith(getInboundUploadDir('session-abc'))).toBe(true);
      await expect(fs.readFile(copied, 'utf8')).resolves.toBe('payload');
    });

    it('leaves the sender original in place', async () => {
      const source = await makeFile('keep.txt');
      await materializePeerFiles(
        [{ path: source, name: 'keep.txt', bytes: 5 }],
        'session-abc',
      );
      await expect(fs.stat(source)).resolves.toBeDefined();
    });

    it('sanitizes a traversal-style name', async () => {
      const source = await makeFile('safe.txt');
      const result = await materializePeerFiles(
        [{ path: source, name: '../../escape.txt', bytes: 5 }],
        'session-abc',
      );
      const copied = result.paths[0];
      expect(copied.startsWith(getInboundUploadDir('session-abc'))).toBe(true);
      expect(copied).not.toContain('..');
    });

    it('records an unreadable attachment as rejected', async () => {
      const result = await materializePeerFiles(
        [{ path: path.join(workDir, 'ghost.txt'), name: 'ghost.txt', bytes: 1 }],
        'session-abc',
      );
      expect(result.received).toBe(0);
      expect(result.rejected).toEqual(['ghost.txt']);
    });

    it('ignores entries that are not references', async () => {
      const result = await materializePeerFiles([null, 42], 'session-abc');
      expect(result.received).toBe(0);
    });

    // [RA4] The sender rejects a relative path, but a peer is free not to be
    // our sender. Unchecked, `fs.stat`/`fs.copyFile` resolved it against the
    // *receiver's* cwd, so a crafted frame reached a path the sender could not
    // even name.
    it('[RA4] rejects a reference that is not an absolute path', async () => {
      await makeFile('secret.txt', 'private');
      const result = await materializePeerFiles(
        [
          { path: 'secret.txt', name: 'secret.txt', bytes: 7 },
          { path: '../../etc/hosts', name: 'hosts', bytes: 1 },
          { path: `${workDir}/nul${String.fromCharCode(0)}.txt`, name: 'nul.txt', bytes: 1 },
        ],
        'session-abc',
      );
      expect(result.received).toBe(0);
      expect(result.rejected).toEqual(['secret.txt', 'hosts', 'nul.txt']);
    });

    // [RA4] Rejected names are read by a human in the message body, so they are
    // display-sanitized rather than filename-sanitized: the latter replaces
    // every non-ASCII character and would report `报告.pdf` as `___.pdf`.
    it('[RA4] keeps a non-ASCII name legible when reporting it as rejected', async () => {
      const result = await materializePeerFiles(
        [
          { path: path.join(workDir, 'gone.txt'), name: '报告 final.pdf', bytes: 1 },
          {
            path: path.join(workDir, 'gone2.txt'),
            // Spelled out rather than embedded: an invisible control byte in a
            // source file is unreadable in a diff.
            name: `esc${String.fromCharCode(27)}[2Jape`,
            bytes: 1,
          },
        ],
        'session-abc',
      );
      expect(result.rejected).toEqual(['报告 final.pdf', 'esc[2Jape']);
    });

    // [RA5] Two messages are copied serially but can land in the same
    // millisecond, and the per-message index restarts at 0. Keyed on those
    // alone, the second copy took the first's path — so the first message's
    // recorded attachment silently pointed at the second message's bytes.
    it('[RA5] does not let one message overwrite another message attachment', async () => {
      // Same `name`, different sources: the destination basename comes from
      // the name, which is what collided.
      const first = await makeFile('first-source.md', 'first');
      const second = await makeFile('second-source.md', 'second');

      const [one, two] = await Promise.all([
        materializePeerFiles([{ path: first, name: 'notes.md', bytes: 5 }], 'session-abc'),
        materializePeerFiles([{ path: second, name: 'notes.md', bytes: 6 }], 'session-abc'),
      ]);

      expect(one.paths[0]).not.toBe(two.paths[0]);
      await expect(fs.readFile(one.paths[0], 'utf8')).resolves.toBe('first');
      await expect(fs.readFile(two.paths[0], 'utf8')).resolves.toBe('second');
    });
  });

  describe('injectPeerFilePrefix', () => {
    it('prefixes mention refs', () => {
      const text = injectPeerFilePrefix('look at this', {
        received: 1,
        paths: ['/uploads/a.txt'],
        rejected: [],
      });
      expect(text).toBe('@"/uploads/a.txt" look at this');
    });

    it('names rejected attachments instead of hiding them', () => {
      const text = injectPeerFilePrefix('look', {
        received: 0,
        paths: [],
        rejected: ['big.bin'],
      });
      expect(text).toContain('Attachments not delivered: big.bin');
    });

    it('leaves the text alone when there is nothing to say', () => {
      expect(
        injectPeerFilePrefix('plain', { received: 0, paths: [], rejected: [] }),
      ).toBe('plain');
    });
  });
  describe('discardPeerFiles', () => {
    // [AC16] A held message's files are written on arrival, so a message that
    // is never accepted has to clean up after itself.
    it('removes files it copied into the uploads directory', async () => {
      const source = await makeFile('doc.txt');
      const materialized = await materializePeerFiles(
        [{ path: source, name: 'doc.txt', bytes: 5 }],
        'session-1',
      );
      const [copied] = materialized.paths;
      await expect(fs.stat(copied)).resolves.toBeDefined();

      expect(await discardPeerFiles(materialized.paths, 'session-1')).toBe(1);
      await expect(fs.stat(copied)).rejects.toThrow();
    });

    // [AC16] Confined to the uploads directory, so a forged entry cannot turn a
    // denial into an arbitrary unlink.
    it('ignores a path outside the uploads directory', async () => {
      const outside = await makeFile('precious.txt');
      expect(await discardPeerFiles([outside], 'session-1')).toBe(0);
      await expect(fs.stat(outside)).resolves.toBeDefined();
    });

    it('ignores a traversal that escapes the uploads directory', async () => {
      const outside = await makeFile('escape.txt');
      const traversal = path.join(
        getInboundUploadDir('session-1'),
        '..',
        '..',
        '..',
        path.relative('/', outside),
      );
      expect(await discardPeerFiles([traversal], 'session-1')).toBe(0);
      await expect(fs.stat(outside)).resolves.toBeDefined();
    });

    // Best-effort: a leftover file in our own uploads directory is untidy, not
    // unsafe, and is not worth failing a denial over.
    it('survives a file that is already gone', async () => {
      const missing = path.join(getInboundUploadDir('session-1'), 'ghost.txt');
      await expect(discardPeerFiles([missing], 'session-1')).resolves.toBe(0);
    });

    it('does nothing for an empty list', async () => {
      expect(await discardPeerFiles([], 'session-1')).toBe(0);
    });
  });
});
