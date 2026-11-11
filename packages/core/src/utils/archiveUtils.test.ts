/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertContainedSymlinks,
  extractArchiveSafely,
} from './archiveUtils.js';

const cleanupDirs: string[] = [];

async function makeArchive(
  files: Record<
    string,
    | {
        content: string;
        symlink?: boolean;
        mode?: number;
        createFolders?: boolean;
      }
    | string
  >,
): Promise<{ archivePath: string; destDir: string }> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'test-archive-test-'),
  );
  cleanupDirs.push(tempDir);
  const archivePath = path.join(tempDir, 'plugin.zip');
  const destDir = path.join(tempDir, 'extracted');
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) {
    const entry = typeof value === 'string' ? { content: value } : value;
    zip.file(name, entry.content, {
      createFolders: entry.createFolders ?? true,
      unixPermissions: entry.symlink ? 0o120777 : (entry.mode ?? 0o100644),
    });
  }
  await fs.writeFile(
    archivePath,
    await zip.generateAsync({
      type: 'nodebuffer',
      platform: 'UNIX',
      compression: 'DEFLATE',
    }),
  );
  return { archivePath, destDir };
}

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('extractArchiveSafely', () => {
  it('extracts regular files and empty directories', async () => {
    const { archivePath, destDir } = await makeArchive({
      'plugin/bin/run': { content: '#!/bin/sh\necho ok\n', mode: 0o100755 },
      'plugin/empty/': '',
    });
    await extractArchiveSafely(archivePath, destDir);
    expect(
      await fs.readFile(path.join(destDir, 'plugin/bin/run'), 'utf8'),
    ).toBe('#!/bin/sh\necho ok\n');
    expect(
      (await fs.stat(path.join(destDir, 'plugin/empty'))).isDirectory(),
    ).toBe(true);
    if (process.platform !== 'win32') {
      expect(
        (await fs.stat(path.join(destDir, 'plugin/bin/run'))).mode & 0o111,
      ).toBe(0o111);
    }
  });

  it('rejects entry paths outside the extraction root', async () => {
    const { archivePath, destDir } = await makeArchive({
      '../outside.txt': 'unsafe',
    });
    await expect(extractArchiveSafely(archivePath, destDir)).rejects.toThrow();
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces the entry count limit before extraction', async () => {
    const { archivePath, destDir } = await makeArchive(
      Object.fromEntries(
        Array.from({ length: 5001 }, (_, i) => [`file-${i}`, '']),
      ),
    );
    await expect(extractArchiveSafely(archivePath, destDir)).rejects.toThrow(
      'too many entries',
    );
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces the total uncompressed size limit before extraction', async () => {
    const { archivePath, destDir } = await makeArchive({
      'large.txt': 'small',
    });
    const archive = await fs.readFile(archivePath);
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(251 * 1024 * 1024, central + 24);
    await fs.writeFile(archivePath, archive);
    await expect(extractArchiveSafely(archivePath, destDir)).rejects.toThrow(
      'too large when decompressed',
    );
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects oversized symlink targets before extraction', async () => {
    const { archivePath, destDir } = await makeArchive({
      link: { content: 'a'.repeat(4097), symlink: true },
    });
    await expect(
      extractArchiveSafely(archivePath, destDir, {
        symlinkPolicy: 'allow-contained',
      }),
    ).rejects.toThrow('symlink target is too large');
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a compressed entry that expands beyond its declared size', async () => {
    const { archivePath, destDir } = await makeArchive({
      'file.txt': 'a'.repeat(4096),
    });
    const archive = await fs.readFile(archivePath);
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(1, central + 24);
    await fs.writeFile(archivePath, archive);
    await expect(extractArchiveSafely(archivePath, destDir)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'keeps internal file link chains and directory links regardless of entry order',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'plugin/second': { content: 'first', symlink: true },
        'plugin/first': { content: 'assets/file.txt', symlink: true },
        'plugin/static': { content: 'assets', symlink: true },
        'plugin/assets/file.txt': 'safe',
      });
      await extractArchiveSafely(archivePath, destDir, {
        symlinkPolicy: 'allow-contained',
      });
      expect(
        await fs.readFile(path.join(destDir, 'plugin/second'), 'utf8'),
      ).toBe('safe');
      expect(
        await fs.readFile(path.join(destDir, 'plugin/static/file.txt'), 'utf8'),
      ).toBe('safe');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a target that escapes only after resolving an intermediate link',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'other/file.txt': 'safe',
        'plugin/deep/a': { content: '../../other', symlink: true },
        'plugin/deep/b': { content: 'a/../../outside.txt', symlink: true },
      });
      const outside = path.join(path.dirname(destDir), 'outside.txt');
      await fs.writeFile(outside, 'original');
      await expect(
        extractArchiveSafely(archivePath, destDir, {
          symlinkPolicy: 'allow-contained',
        }),
      ).rejects.toThrow('outside the containment root');
      await expect(
        fs.lstat(path.join(destDir, 'plugin/deep/b')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(outside, 'utf8')).toBe('original');
    },
  );

  it('does not write archive files through a directory symlink', async () => {
    const { archivePath, destDir } = await makeArchive({
      'plugin/alias': { content: 'real', symlink: true },
      'plugin/real/keep.txt': 'original',
      'plugin/alias/file.txt': { content: 'unsafe', createFolders: false },
    });
    await expect(
      extractArchiveSafely(archivePath, destDir, {
        symlinkPolicy: 'allow-contained',
      }),
    ).rejects.toThrow();
    expect(
      await fs.readFile(path.join(destDir, 'plugin/real/keep.txt'), 'utf8'),
    ).toBe('original');
    await expect(
      fs.stat(path.join(destDir, 'plugin/real/file.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'does not create directories through a pre-existing destination directory link',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'nested/new/file.txt': 'unsafe',
      });
      const outsideDir = path.join(path.dirname(destDir), 'outside');
      await fs.mkdir(outsideDir);
      await fs.mkdir(destDir);
      await fs.symlink(outsideDir, path.join(destDir, 'nested'));
      await expect(extractArchiveSafely(archivePath, destDir)).rejects.toThrow(
        'not a real directory',
      );
      expect(await fs.readdir(outsideDir)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not overwrite an outside file through a duplicate symlink entry',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'plugin/a': { content: '.', symlink: true },
        'plugin/b': { content: 'a/../../outside.txt', symlink: true },
        'plugin/c': 'overwritten',
      });
      // JSZip replaces duplicate names. Rename the last entry in both ZIP
      // headers to exercise a file written through an earlier symlink.
      const archive = await fs.readFile(archivePath);
      for (
        let offset = archive.indexOf('plugin/c');
        offset !== -1;
        offset = archive.indexOf('plugin/c', offset + 1)
      ) {
        archive.write('plugin/b', offset);
      }
      await fs.writeFile(archivePath, archive);
      const outside = path.join(path.dirname(destDir), 'outside.txt');
      await fs.writeFile(outside, 'original');

      await expect(
        extractArchiveSafely(archivePath, destDir, {
          symlinkPolicy: 'allow-contained',
        }),
      ).rejects.toThrow();
      expect(await fs.readFile(outside, 'utf8')).toBe('original');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not write through a pre-existing destination symlink',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'file.txt': 'overwritten',
      });
      const outside = path.join(path.dirname(destDir), 'outside.txt');
      await fs.writeFile(outside, 'original');
      await fs.mkdir(destDir);
      await fs.symlink(outside, path.join(destDir, 'file.txt'));

      await expect(
        extractArchiveSafely(archivePath, destDir),
      ).rejects.toThrow();
      expect(await fs.readFile(outside, 'utf8')).toBe('original');
    },
  );

  it('rejects symlinks by default before extracting anything', async () => {
    const { archivePath, destDir } = await makeArchive({
      'plugin/CLAUDE.md': '# Instructions',
      'plugin/AGENTS.md': { content: 'CLAUDE.md', symlink: true },
    });

    await expect(extractArchiveSafely(archivePath, destDir)).rejects.toThrow(
      'archive contains a symlink (plugin/AGENTS.md)',
    );
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a valid internal relative symlink when explicitly allowed',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'plugin/CLAUDE.md': '# Instructions',
        'plugin/AGENTS.md': { content: 'CLAUDE.md', symlink: true },
      });

      await extractArchiveSafely(archivePath, destDir, {
        symlinkPolicy: 'allow-contained',
      });

      const linkPath = path.join(destDir, 'plugin', 'AGENTS.md');
      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(linkPath)).toBe('CLAUDE.md');
      expect(await fs.readFile(linkPath, 'utf8')).toBe('# Instructions');
    },
  );

  it.each([
    ['relative traversal', '../../../outside'],
    ['POSIX absolute path', '/etc/passwd'],
    ['Windows absolute path', 'C:\\Windows\\system.ini'],
    ['Windows drive-relative path', 'C:outside'],
    ['Windows UNC path', '\\\\server\\share\\outside'],
    ['Windows relative traversal', '..\\..\\..\\outside'],
  ])('rejects a %s symlink before extraction', async (_label, target) => {
    const { archivePath, destDir } = await makeArchive({
      'plugin/skills/link': { content: target, symlink: true },
    });

    await expect(
      extractArchiveSafely(archivePath, destDir, {
        symlinkPolicy: 'allow-contained',
      }),
    ).rejects.toThrow('symlink points outside the archive');
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a broken internal symlink after extraction',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'plugin/AGENTS.md': { content: 'missing.md', symlink: true },
      });

      await expect(
        extractArchiveSafely(archivePath, destDir, {
          symlinkPolicy: 'allow-contained',
        }),
      ).rejects.toThrow('broken or cyclic symlink');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a directory symlink that recurses into its ancestor',
    async () => {
      const { archivePath, destDir } = await makeArchive({
        'plugin/skills/hello.md': '# Hello',
        'plugin/skills/back': { content: '..', symlink: true },
      });

      await expect(
        extractArchiveSafely(archivePath, destDir, {
          symlinkPolicy: 'allow-contained',
        }),
      ).rejects.toThrow('cyclic directory symlink');
    },
  );
});

describe.skipIf(process.platform === 'win32')('assertContainedSymlinks', () => {
  it('rejects links that escape a resolved plugin wrapper root', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'test-plugin-root-test-'),
    );
    cleanupDirs.push(tempDir);
    const pluginRoot = path.join(tempDir, 'plugin');
    await fs.mkdir(pluginRoot);
    await fs.writeFile(path.join(tempDir, 'sibling.md'), 'outside plugin');
    await fs.symlink('../sibling.md', path.join(pluginRoot, 'AGENTS.md'));

    await expect(assertContainedSymlinks(pluginRoot)).rejects.toThrow(
      'symlink points outside the containment root',
    );
  });
});
