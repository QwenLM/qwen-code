/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmniObjectStore, prepareOmniDownloadsDir } from './storage.js';

describe('OmniObjectStore', () => {
  let qwenDir: string;
  let store: OmniObjectStore;

  beforeEach(async () => {
    qwenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-store-'));
    store = new OmniObjectStore(qwenDir);
  });

  afterEach(async () => {
    await fs.rm(qwenDir, { recursive: true, force: true });
  });

  async function makeSource(content: string): Promise<{
    sourcePath: string;
    sha256: string;
  }> {
    const sourcePath = path.join(qwenDir, `src-${Math.random()}.mp4`);
    await fs.writeFile(sourcePath, content);
    return {
      sourcePath,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  it('stores a file under its content hash', async () => {
    const { sourcePath, sha256 } = await makeSource('video-bytes');
    const result = await store.putFile(sourcePath, sha256, '.mp4');
    expect(result.deduped).toBe(false);
    expect(result.objectPath).toBe(
      path.join(
        qwenDir,
        'omni',
        'objects',
        'sha256',
        sha256.slice(0, 2),
        `${sha256}.mp4`,
      ),
    );
    await expect(fs.readFile(result.objectPath, 'utf8')).resolves.toBe(
      'video-bytes',
    );
  });

  it('dedups identical content from different sources', async () => {
    const a = await makeSource('same-bytes');
    const b = await makeSource('same-bytes');
    expect(a.sha256).toBe(b.sha256);

    const first = await store.putFile(a.sourcePath, a.sha256, '.mp4');
    const second = await store.putFile(b.sourcePath, b.sha256, '.mp4');
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.objectPath).toBe(first.objectPath);

    const objectFiles = await fs.readdir(path.dirname(first.objectPath));
    expect(objectFiles).toEqual([path.basename(first.objectPath)]);
  });

  it('a dedup hit refreshes the object mtime (touch-on-reference)', async () => {
    // Every new memory reference is preceded by a putFile of the same
    // bytes; the dedup touch re-arms the GC retention grace so a
    // concurrent sweep whose snapshot predates the commit cannot delete
    // freshly re-referenced old bytes on age.
    const a = await makeSource('old-bytes');
    const { objectPath } = await store.putFile(a.sourcePath, a.sha256, '.bin');
    const old = new Date(Date.now() - 30 * 24 * 3600_000);
    await fs.utimes(objectPath, old, old);

    const second = await store.putFile(a.sourcePath, a.sha256, '.bin');

    expect(second.deduped).toBe(true);
    const st = await fs.lstat(objectPath);
    expect(st.mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it('writes a self-ignoring .gitignore once', async () => {
    const { sourcePath, sha256 } = await makeSource('x');
    await store.putFile(sourcePath, sha256, '.mp4');
    const gitignorePath = path.join(qwenDir, 'omni', '.gitignore');
    await expect(fs.readFile(gitignorePath, 'utf8')).resolves.toBe('*\n');
    // Second put must not fail on the existing .gitignore.
    const other = await makeSource('y');
    await expect(
      store.putFile(other.sourcePath, other.sha256, '.mp4'),
    ).resolves.toBeDefined();
  });

  it('leaves no .tmp files behind after a successful put', async () => {
    const { sourcePath, sha256 } = await makeSource('clean');
    const { objectPath } = await store.putFile(sourcePath, sha256, '.mp4');
    const entries = await fs.readdir(path.dirname(objectPath));
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toEqual([]);
  });

  it('rejects malformed sha256 keys', async () => {
    const { sourcePath } = await makeSource('z');
    await expect(
      store.putFile(sourcePath, '../../escape', '.mp4'),
    ).rejects.toThrow(/Invalid sha256/);
    await expect(store.putFile(sourcePath, 'ABCDEF', '.mp4')).rejects.toThrow(
      /Invalid sha256/,
    );
  });

  describe('objectPathFor validates cache-sourced components (path traversal)', () => {
    const sha256 = 'a'.repeat(64);

    it.each([
      [
        'traversal hash',
        '../../../../etc/passwd',
        '.mp4',
        /invalid object hash/,
      ],
      ['uppercase hash', 'A'.repeat(64), '.mp4', /invalid object hash/],
      ['short hash', 'abc123', '.mp4', /invalid object hash/],
      [
        'traversal extension',
        sha256,
        '/../../../../tmp/evil',
        /invalid object extension/,
      ],
      [
        'multi-segment extension',
        sha256,
        '.jpg/../x',
        /invalid object extension/,
      ],
      ['dotless extension', sha256, 'jpg', /invalid object extension/],
      ['double-dot extension', sha256, '..', /invalid object extension/],
      ['overlong extension', sha256, '.abcdefghi', /invalid object extension/],
    ])('throws on %s', (_label, hash, ext, message) => {
      expect(() => store.objectPathFor(hash, ext)).toThrow(message);
    });

    it('accepts every extension recognition can emit', () => {
      for (const ext of ['.mp4', '.webp', '.m4a', '.bin', '.jpg']) {
        const p = store.objectPathFor(sha256, ext);
        expect(p).toBe(
          path.join(store.getObjectsDir(), 'aa', `${sha256}${ext}`),
        );
      }
    });
  });

  it('propagates copy failures without leaving temp files', async () => {
    const missing = path.join(qwenDir, 'does-not-exist.mp4');
    const sha256 = createHash('sha256').update('missing').digest('hex');
    await expect(store.putFile(missing, sha256, '.mp4')).rejects.toThrow();
    const shard = path.join(
      qwenDir,
      'omni',
      'objects',
      'sha256',
      sha256.slice(0, 2),
    );
    // Shard dir may exist, but must contain no .tmp remnants.
    const entries = await fs.readdir(shard).catch(() => []);
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toEqual([]);
  });

  it('fails closed when the source content does not match the claimed hash (TOCTOU)', async () => {
    const { sourcePath } = await makeSource('actual-bytes');
    const staleHash = createHash('sha256')
      .update('bytes-from-before-the-file-changed')
      .digest('hex');
    await expect(store.putFile(sourcePath, staleHash, '.mp4')).rejects.toThrow(
      /content changed while storing/,
    );
    // Nothing may be stored under the stale hash.
    await expect(
      fs.access(store.objectPathFor(staleHash, '.mp4')),
    ).rejects.toThrow();
  });

  it('heals a planted object whose bytes do not match its hash name', async () => {
    const { sourcePath, sha256 } = await makeSource('real-video-bytes');
    const objectPath = store.objectPathFor(sha256, '.mp4');
    // Plant different bytes at the content-addressed path (e.g. shipped
    // inside a cloned repo before the .gitignore applied).
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, 'planted-malicious-bytes');

    const result = await store.putFile(sourcePath, sha256, '.mp4');
    expect(result.deduped).toBe(false);
    await expect(fs.readFile(result.objectPath, 'utf8')).resolves.toBe(
      'real-video-bytes',
    );
  });

  it('refuses a symlinked store root', async () => {
    const outside = path.join(qwenDir, 'outside-target');
    await fs.mkdir(outside);
    const linkedQwen = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-link-'));
    try {
      await fs.symlink(outside, path.join(linkedQwen, 'omni'));
      const linkedStore = new OmniObjectStore(linkedQwen);
      const { sourcePath, sha256 } = await makeSource('x');
      await expect(
        linkedStore.putFile(sourcePath, sha256, '.mp4'),
      ).rejects.toThrow(/not a real directory/);
    } finally {
      await fs.rm(linkedQwen, { recursive: true, force: true });
    }
  });

  describe('staging and quarantine areas', () => {
    const INVOCATION_ID = '0123456789abcdef';

    it('ensureLayout creates staging/ and quarantine/ with 0o700', async () => {
      await store.ensureLayout();
      for (const dir of [store.getStagingDir(), store.getQuarantineDir()]) {
        const st = await fs.stat(dir);
        expect(st.isDirectory()).toBe(true);
        if (process.platform !== 'win32') {
          expect(st.mode & 0o777).toBe(0o700);
        }
      }
      expect(store.getStagingDir()).toBe(path.join(qwenDir, 'omni', 'staging'));
      expect(store.getQuarantineDir()).toBe(
        path.join(qwenDir, 'omni', 'quarantine'),
      );
    });

    it('creates an exclusive per-invocation staging directory', async () => {
      const dir = await store.createStagingDir(INVOCATION_ID);
      expect(dir).toBe(path.join(store.getStagingDir(), INVOCATION_ID));
      const st = await fs.stat(dir);
      expect(st.isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(st.mode & 0o777).toBe(0o700);
      }
      // A second create with the same id must fail, never silently reuse.
      await expect(store.createStagingDir(INVOCATION_ID)).rejects.toThrow();
    });

    it.each([
      ['path traversal', '../../escape00'],
      ['uppercase hex', '0123456789ABCDEF'],
      ['wrong length', '0123456789abcde'],
      ['separator smuggling', '0123456789abcde/'],
    ])('rejects an invalid invocation id: %s', async (_label, id) => {
      await expect(store.createStagingDir(id)).rejects.toThrow(
        /Invalid omni policy invocation id/,
      );
      await expect(store.removeStagingDir(id)).rejects.toThrow(
        /Invalid omni policy invocation id/,
      );
      await expect(
        store.quarantineInvocation(id, {
          policyId: 'p',
          toolName: 't',
          reason: 'r',
        }),
      ).rejects.toThrow(/Invalid omni policy invocation id/);
    });

    it('removeStagingDir deletes the invocation directory recursively', async () => {
      const dir = await store.createStagingDir(INVOCATION_ID);
      await fs.mkdir(path.join(dir, 'nested'));
      await fs.writeFile(path.join(dir, 'nested', 'artifact.webp'), 'bytes');
      await store.removeStagingDir(INVOCATION_ID);
      await expect(fs.lstat(dir)).rejects.toThrow();
      // Idempotent on a missing directory.
      await expect(
        store.removeStagingDir(INVOCATION_ID),
      ).resolves.toBeUndefined();
    });

    it('quarantineInvocation moves artifacts and writes reason.json', async () => {
      const dir = await store.createStagingDir(INVOCATION_ID);
      await fs.writeFile(path.join(dir, 'partial.mp4'), 'half-transcoded');
      const quarantineDir = await store.quarantineInvocation(INVOCATION_ID, {
        policyId: 'video-downscale-v1',
        toolName: 'omni_downscale_video',
        reason: 'required output missing',
      });

      expect(quarantineDir).toBe(
        path.join(store.getQuarantineDir(), INVOCATION_ID),
      );
      // Staging entry is gone; artifacts moved with original names.
      await expect(fs.lstat(dir)).rejects.toThrow();
      await expect(
        fs.readFile(path.join(quarantineDir, 'partial.mp4'), 'utf8'),
      ).resolves.toBe('half-transcoded');
      const reason = JSON.parse(
        await fs.readFile(path.join(quarantineDir, 'reason.json'), 'utf8'),
      );
      expect(reason).toMatchObject({
        policyId: 'video-downscale-v1',
        toolName: 'omni_downscale_video',
        reason: 'required output missing',
      });
      expect(new Date(reason.failedAt).getTime()).not.toBeNaN();
    });

    it('quarantineInvocation fails when the staging directory is missing', async () => {
      await store.ensureLayout();
      await expect(
        store.quarantineInvocation(INVOCATION_ID, {
          policyId: 'p',
          toolName: 't',
          reason: 'r',
        }),
      ).rejects.toThrow();
    });

    it('quarantineInvocation refuses a symlinked staging entry', async () => {
      await store.ensureLayout();
      const outside = path.join(qwenDir, 'outside-staging');
      await fs.mkdir(outside);
      await fs.symlink(
        outside,
        path.join(store.getStagingDir(), INVOCATION_ID),
      );
      await expect(
        store.quarantineInvocation(INVOCATION_ID, {
          policyId: 'p',
          toolName: 't',
          reason: 'r',
        }),
      ).rejects.toThrow(/not a real directory/);
      // Nothing was written through the link.
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    });
  });
});

describe('prepareOmniDownloadsDir', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-dl-prep-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a missing downloads dir with 0o700 and returns its path', async () => {
    const dir = path.join(root, 'omni', 'downloads');
    await expect(prepareOmniDownloadsDir(dir)).resolves.toBe(dir);
    const st = await fs.stat(dir);
    expect(st.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o700);
    }
  });

  it('is idempotent over an existing real directory', async () => {
    const dir = path.join(root, 'downloads');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'keep.part'), 'x');
    await expect(prepareOmniDownloadsDir(dir)).resolves.toBe(dir);
    // Existing contents survive — prepare never wipes the staging area.
    await expect(
      fs.readFile(path.join(dir, 'keep.part'), 'utf8'),
    ).resolves.toBe('x');
  });

  it('refuses a symlink planted at the downloads path (mkdir succeeds silently on it)', async () => {
    const outside = path.join(root, 'outside-target');
    await fs.mkdir(outside);
    const dir = path.join(root, 'downloads');
    await fs.symlink(outside, dir);
    await expect(prepareOmniDownloadsDir(dir)).rejects.toThrow(
      /not a real directory/,
    );
    // Nothing was created through the link.
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it('refuses a regular file planted at the downloads path', async () => {
    const dir = path.join(root, 'downloads');
    await fs.writeFile(dir, 'not a directory');
    // mkdir itself fails with EEXIST/ENOTDIR here — either way it must throw.
    await expect(prepareOmniDownloadsDir(dir)).rejects.toThrow();
  });
});
