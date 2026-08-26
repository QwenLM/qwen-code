/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_PATH_BYTES,
  assertDirectorySymlinksAreSafe,
  assertTarArchiveLinksAreSafe,
} from './archive-safety.js';

// Passthrough wrapper around `fs.createReadStream` that tests can hook to
// observe how much of the archive the scan actually reads.
const streamProbe = vi.hoisted(() => ({
  onReadStream: undefined as
    | ((
        filePath: unknown,
        options: unknown,
        original: (
          filePath: unknown,
          options: unknown,
        ) => NodeJS.ReadableStream,
      ) => NodeJS.ReadableStream)
    | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (filePath: unknown, options: unknown) => {
      const original = (
        actual.createReadStream as (
          filePath: unknown,
          options: unknown,
        ) => NodeJS.ReadableStream
      ).bind(actual);
      if (streamProbe.onReadStream) {
        return streamProbe.onReadStream(filePath, options, original);
      }
      return original(filePath, options);
    },
  };
});

// Builds a ustar header for a zero-content regular file. `tar.t` parses
// headers via `onReadEntry` without requiring entry content, so these
// crafted headers are enough to exercise the entry-count and expanded-size
// limits without writing gigabytes of data or hundreds of thousands of
// files to disk.
function createTarFileHeader(
  name: string,
  size: number,
  type = '0',
  linkPath?: string,
): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8); // mode
  header.write('0000000\0', 108, 8); // uid
  header.write('0000000\0', 116, 8); // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write('14763423360\0', 136, 12); // mtime
  header.write('        ', 148, 8); // checksum placeholder (spaces)
  header.write(type, 156, 1);
  if (linkPath) header.write(linkPath, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

const TAR_TRAILER = Buffer.alloc(1024);

async function writeCraftedTar(
  archive: string,
  headers: Buffer[],
): Promise<void> {
  await fs.writeFile(archive, Buffer.concat([...headers, TAR_TRAILER]));
}

describe('assertTarArchiveLinksAreSafe', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tar-safety-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a large link set without throwing outside the promise',
    async () => {
      const links = Array.from({ length: 101 }, (_, index) => `link-${index}`);
      await Promise.all(
        links.map(async (link) => {
          await fs.symlink('missing-target', path.join(root, link));
        }),
      );
      const archive = path.join(root, 'links.tar');
      await tar.c({ cwd: root, file: archive }, links);

      await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
        'more than 100 unsupported link entries',
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'stops reading the archive as soon as validation fails',
    async () => {
      const links = Array.from({ length: 101 }, (_, index) => `link-${index}`);
      await Promise.all(
        links.map(async (link) => {
          await fs.symlink('missing-target', path.join(root, link));
        }),
      );
      // A large trailing entry that a scan-to-end implementation would still
      // consume after the link limit trips; an early abort never reaches it.
      const tailBytes = 20 * 1024 * 1024;
      await fs.writeFile(path.join(root, 'tail.bin'), randomBytes(tailBytes));
      const archive = path.join(root, 'abort-links.tar');
      await tar.c({ cwd: root, file: archive }, [...links, 'tail.bin']);

      let bytesRead = 0;
      streamProbe.onReadStream = (filePath, options, original) => {
        const stream = original(filePath, options);
        stream.on('data', (chunk) => {
          bytesRead += chunk.length;
        });
        return stream;
      };

      try {
        await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
          'more than 100 unsupported link entries',
        );
      } finally {
        streamProbe.onReadStream = undefined;
      }

      // Without the early abort the scan would read the whole ~20 MB tail.
      expect(bytesRead).toBeLessThan(tailBytes / 2);
    },
  );

  it('rejects a pre-aborted signal without opening the archive stream', async () => {
    const controller = new AbortController();
    const abortReason = new Error('install cancelled');
    controller.abort(abortReason);
    let createReadStreamCalls = 0;
    streamProbe.onReadStream = (filePath, options, original) => {
      createReadStreamCalls += 1;
      const stream = original(filePath, options);
      // If the regression returns, the abandoned stream would emit an
      // unhandled ENOENT 'error' event; swallow it so the assertion below
      // fails the test cleanly instead of crashing the worker.
      stream.on('error', () => {});
      return stream;
    };

    try {
      await expect(
        assertTarArchiveLinksAreSafe(
          path.join(root, 'missing.tar'),
          controller.signal,
        ),
      ).rejects.toBe(abortReason);
    } finally {
      streamProbe.onReadStream = undefined;
    }

    expect(createReadStreamCalls).toBe(0);
  });

  const resourceLimits = { enforceResourceLimits: true };

  it('accepts an archive with exactly the entry-count limit', async () => {
    const archive = path.join(root, 'exact-entries.tar');
    const header = createTarFileHeader('file', 0);
    await writeCraftedTar(
      archive,
      Array.from({ length: MAX_ARCHIVE_ENTRIES }, () => header),
    );

    await expect(
      assertTarArchiveLinksAreSafe(archive, undefined, resourceLimits),
    ).resolves.toBeUndefined();
  });

  it('rejects an archive just over the entry-count limit', async () => {
    const archive = path.join(root, 'too-many-entries.tar');
    const header = createTarFileHeader('file', 0);
    await writeCraftedTar(
      archive,
      Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, () => header),
    );

    await expect(
      assertTarArchiveLinksAreSafe(archive, undefined, resourceLimits),
    ).rejects.toThrow(
      `Tar archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`,
    );
  });

  it('bounds retained archive path metadata', async () => {
    const archive = path.join(root, 'too-many-path-bytes.tar');
    const suffix = 'x'.repeat(90);
    const pathLength = 97;
    await writeCraftedTar(
      archive,
      Array.from(
        { length: Math.ceil(MAX_ARCHIVE_PATH_BYTES / pathLength) + 1 },
        (_, index) =>
          createTarFileHeader(
            `${index.toString().padStart(6, '0')}-${suffix}`,
            0,
          ),
      ),
    );

    await expect(
      assertTarArchiveLinksAreSafe(archive, undefined, {
        allowContainedSymlinks: true,
      }),
    ).rejects.toThrow(
      `Tar archive path metadata exceeds ${MAX_ARCHIVE_PATH_BYTES} bytes.`,
    );
  });

  it('skips resource limits for trusted archives by default', async () => {
    const archive = path.join(root, 'huge-but-trusted.tar');
    await fs.writeFile(
      archive,
      Buffer.concat([
        createTarFileHeader('big.bin', MAX_ARCHIVE_EXPANDED_BYTES + 1),
        TAR_TRAILER,
      ]),
    );

    await expect(
      assertTarArchiveLinksAreSafe(archive),
    ).resolves.toBeUndefined();
  });

  // The parser skips `size` content bytes after each header, so every entry
  // except the last must carry its (padded) content; the final entry declares
  // a huge size without backing bytes, which `tar.t` tolerates as a trailing
  // truncation. The first entry's real content makes the two-entry sum an
  // actual accumulation check.
  async function writeByteLimitTar(
    archive: string,
    secondEntrySize: number,
  ): Promise<void> {
    const firstContent = Buffer.alloc(512);
    await fs.writeFile(
      archive,
      Buffer.concat([
        createTarFileHeader('first.bin', firstContent.length),
        firstContent,
        createTarFileHeader('second.bin', secondEntrySize),
        TAR_TRAILER,
      ]),
    );
  }

  it('accepts an archive whose declared sizes sum exactly to the byte limit', async () => {
    const archive = path.join(root, 'exact-bytes.tar');
    await writeByteLimitTar(archive, MAX_ARCHIVE_EXPANDED_BYTES - 512);

    await expect(
      assertTarArchiveLinksAreSafe(archive, undefined, resourceLimits),
    ).resolves.toBeUndefined();
  });

  it('rejects an archive whose declared sizes sum just over the byte limit', async () => {
    const archive = path.join(root, 'too-many-bytes.tar');
    await writeByteLimitTar(archive, MAX_ARCHIVE_EXPANDED_BYTES - 512 + 1);

    await expect(
      assertTarArchiveLinksAreSafe(archive, undefined, resourceLimits),
    ).rejects.toThrow(
      `Tar archive expands beyond ${MAX_ARCHIVE_EXPANDED_BYTES} bytes.`,
    );
  });

  // Issue #9724: the older-Git public archive fallback has to install public
  // repositories that carry in-repo symlinks (the reported repro,
  // `obra/superpowers`, ships a root `AGENTS.md -> CLAUDE.md`). Containment is
  // decided from the archive's own paths, never from the extracted tree, so a
  // hostile entry is refused before anything is written to disk.
  describe('contained symlinks', () => {
    const allowLinks = { allowContainedSymlinks: true } as const;
    const symlinkHeader = (name: string, linkPath: string) =>
      createTarFileHeader(name, 0, '2', linkPath);

    it.runIf(process.platform !== 'win32')(
      'accepts a root-level symlink to a sibling file',
      async () => {
        await fs.writeFile(path.join(root, 'CLAUDE.md'), '# guide\n');
        await fs.symlink('CLAUDE.md', path.join(root, 'AGENTS.md'));
        const archive = path.join(root, 'superpowers.tar');
        await tar.c({ cwd: root, file: archive }, ['CLAUDE.md', 'AGENTS.md']);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).resolves.toBeUndefined();
      },
    );

    it('rejects a dot-relative duplicate of an already-seen entry path', async () => {
      const archive = path.join(root, 'duplicate-entry.tar');
      await writeCraftedTar(archive, [
        createTarFileHeader('foo', 0),
        createTarFileHeader('./foo', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('duplicate entry path');
    });

    it('accepts a symlink declared before its target', async () => {
      const archive = path.join(root, 'target-after-link.tar');
      await writeCraftedTar(archive, [
        symlinkHeader('AGENTS.md', 'CLAUDE.md'),
        createTarFileHeader('CLAUDE.md', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).resolves.toBeUndefined();
    });

    it.runIf(process.platform !== 'win32')(
      'accepts a nested symlink that stays inside the archive root',
      async () => {
        await fs.mkdir(path.join(root, 'docs'));
        await fs.writeFile(path.join(root, 'real.md'), 'x\n');
        await fs.symlink('../real.md', path.join(root, 'docs', 'link.md'));
        const archive = path.join(root, 'nested.tar');
        await tar.c({ cwd: root, file: archive }, ['real.md', 'docs']);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).resolves.toBeUndefined();
      },
    );

    it.runIf(process.platform !== 'win32')(
      'rejects a symlink whose target escapes the archive root',
      async () => {
        await fs.symlink('../../etc/hosts', path.join(root, 'escape'));
        const archive = path.join(root, 'escape.tar');
        await tar.c({ cwd: root, file: archive }, ['escape']);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).rejects.toThrow('unsupported link entry');
      },
    );

    it('rejects a symlink whose normalized target is exactly the archive parent', async () => {
      const archive = path.join(root, 'parent.tar');
      await writeCraftedTar(archive, [symlinkHeader('escape', '..')]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it('rejects a backslash-separated traversal target', async () => {
      const archive = path.join(root, 'backslash.tar');
      await writeCraftedTar(archive, [
        symlinkHeader('escape', '..\\..\\outside'),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it.runIf(process.platform !== 'win32')(
      'rejects an ambiguous literal-backslash target',
      async () => {
        const archive = path.join(root, 'literal-backslash.tar');
        await writeCraftedTar(archive, [
          createTarFileHeader('dir/file', 0),
          createTarFileHeader('dir\\file', 0),
          symlinkHeader('alias', 'dir\\file'),
        ]);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).rejects.toThrow('unsupported link entry');
      },
    );

    it('rejects a UNC target without requiring Windows symlink support', async () => {
      const archive = path.join(root, 'unc-target.tar');
      await writeCraftedTar(archive, [
        symlinkHeader('escape', '\\\\server\\share\\file'),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it('rejects a symlink with an absolute entry path', async () => {
      const archive = path.join(root, 'absolute-entry.tar');
      await writeCraftedTar(archive, [
        symlinkHeader('/absolute-link', 'target'),
        createTarFileHeader('target', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it('rejects a symlink with a Windows-absolute entry path', async () => {
      // Distinct from the target-side check exercised by "rejects a
      // symlink with a Windows-absolute target": this crafts the drive
      // letter into the *entry* path so only `WINDOWS_ABSOLUTE_PATH.test(
      // entryPath)` can reject it (the target, 'target', is unremarkable).
      const archive = path.join(root, 'windows-entry-path.tar');
      await writeCraftedTar(archive, [
        symlinkHeader('C:\\pwn', 'target'),
        createTarFileHeader('target', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it('rejects a symlink whose entry path normalizes to the archive root', async () => {
      const archive = path.join(root, 'root-entry.tar');
      await writeCraftedTar(archive, [
        symlinkHeader('nested/..', 'target'),
        createTarFileHeader('target', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it('rejects a symlink whose target resolves to its own entry path', async () => {
      // dirname('link') + 'link' normalizes back to 'link' itself. This
      // does NOT discriminate the `normalizedEntry === resolved`
      // self-reference clause the way the sibling ancestor-entry test
      // discriminates its own clause: onReadEntry always records the
      // symlink itself in `archiveEntries` (typed SymbolicLink) before
      // this check runs, so even with the clause removed, the post-loop
      // "target must be a distinct regular-file entry" scan independently
      // rejects a link that names itself. Kept as a plain regression test;
      // deleting the self-reference clause does not fail it.
      const archive = path.join(root, 'self-reference.tar');
      await writeCraftedTar(archive, [symlinkHeader('link', 'link')]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it('rejects a symlink whose target resolves to an ancestor entry', async () => {
      // dirname('a/b/link') + '..' normalizes to 'a', an ancestor of the
      // entry itself (not '.' or '..'), so this is rejected by the
      // `normalizedEntry.startsWith(`${resolved}/`)` ancestor clause
      // specifically (unlike `symlinkHeader('sub/loop', '..')`, whose
      // resolved target is exactly '.' and never reaches this clause).
      const archive = path.join(root, 'ancestor-entry.tar');
      await writeCraftedTar(archive, [
        createTarFileHeader('a', 0),
        symlinkHeader('a/b/link', '..'),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it('rejects link chains and dangling or directory targets', async () => {
      const archive = path.join(root, 'indirect-targets.tar');
      await writeCraftedTar(archive, [
        createTarFileHeader('target', 0),
        symlinkHeader('first', 'target'),
        symlinkHeader('second', 'first'),
        symlinkHeader('dangling', 'missing'),
        createTarFileHeader('directory/', 0, '5'),
        symlinkHeader('directory-link', 'directory'),
        symlinkHeader('path-link', 'target'),
        createTarFileHeader('path-link/child', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('4 unsupported link entries');
    });

    it('rejects descendants of a trailing-separator symlink entry', async () => {
      const archive = path.join(root, 'trailing-separator-link.tar');
      await writeCraftedTar(archive, [
        createTarFileHeader('target', 0),
        symlinkHeader('alias/', 'target'),
        createTarFileHeader('alias/child', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    });

    it.runIf(process.platform !== 'win32')(
      'rejects unsafe symlinks in a restructured extracted tree',
      async () => {
        const directoryCase = path.join(root, 'directory-case');
        await fs.mkdir(path.join(directoryCase, 'target'), { recursive: true });
        await fs.symlink('target', path.join(directoryCase, 'link'));
        await expect(
          assertDirectorySymlinksAreSafe(directoryCase),
        ).rejects.toThrow('unsupported link entry');

        const danglingCase = path.join(root, 'dangling-case');
        await fs.mkdir(danglingCase);
        await fs.symlink('missing', path.join(danglingCase, 'link'));
        await expect(
          assertDirectorySymlinksAreSafe(danglingCase),
        ).rejects.toThrow('unsupported link entry');

        const cycleCase = path.join(root, 'cycle-case');
        await fs.mkdir(cycleCase);
        await fs.symlink('b', path.join(cycleCase, 'a'));
        await fs.symlink('a', path.join(cycleCase, 'b'));
        await expect(assertDirectorySymlinksAreSafe(cycleCase)).rejects.toThrow(
          'unsupported link entry',
        );

        const chainCase = path.join(root, 'chain-case');
        await fs.mkdir(chainCase);
        await fs.writeFile(path.join(chainCase, 'target'), 'content');
        await fs.symlink('target', path.join(chainCase, 'middle'));
        await fs.symlink('middle', path.join(chainCase, 'link'));
        await expect(assertDirectorySymlinksAreSafe(chainCase)).rejects.toThrow(
          'unsupported link entry',
        );

        const absoluteCase = path.join(root, 'absolute-case');
        await fs.mkdir(absoluteCase);
        const absoluteTarget = path.join(absoluteCase, 'target');
        await fs.writeFile(absoluteTarget, 'content');
        await fs.symlink(absoluteTarget, path.join(absoluteCase, 'link'));
        await expect(
          assertDirectorySymlinksAreSafe(absoluteCase),
        ).rejects.toThrow('unsupported link entry');

        const noncanonicalCase = path.join(root, 'noncanonical-case');
        await fs.mkdir(noncanonicalCase);
        await fs.writeFile(path.join(noncanonicalCase, 'target'), 'content');
        await fs.symlink(
          'missing/../target',
          path.join(noncanonicalCase, 'link'),
        );
        await expect(
          assertDirectorySymlinksAreSafe(noncanonicalCase),
        ).rejects.toThrow('unsupported link entry');
      },
    );

    it('honors cancellation before scanning the extracted tree', async () => {
      const controller = new AbortController();
      const reason = new Error('install cancelled');
      controller.abort(reason);

      await expect(
        assertDirectorySymlinksAreSafe(root, controller.signal),
      ).rejects.toBe(reason);
    });

    it.runIf(process.platform !== 'win32')(
      'preserves cancellation when final target resolution fails',
      async () => {
        const target = path.join(root, 'target');
        const link = path.join(root, 'link');
        await fs.writeFile(target, 'content');
        await fs.symlink('target', link);
        const controller = new AbortController();
        const reason = new Error('install cancelled');
        const realpath = fs.realpath.bind(fs);
        const realpathSpy = vi
          .spyOn(fs, 'realpath')
          .mockImplementation(async (value) => {
            if (value === link) {
              controller.abort(reason);
              throw new Error('filesystem race');
            }
            return realpath(value);
          });

        try {
          await expect(
            assertDirectorySymlinksAreSafe(root, controller.signal),
          ).rejects.toBe(reason);
        } finally {
          realpathSpy.mockRestore();
        }
      },
    );

    it.runIf(process.platform !== 'win32')(
      'counts the actual target of a backslash-named symlink',
      async () => {
        const source = path.join(root, 'backslash-source');
        await fs.mkdir(path.join(source, 'dir'), { recursive: true });
        await fs.writeFile(path.join(source, 'target'), 'large');
        await fs.writeFile(path.join(source, 'dir', 'target'), '');
        await fs.symlink('target', path.join(source, 'dir\\copy'));
        const archive = path.join(root, 'backslash-entry-size.tar');
        await tar.c({ cwd: source, file: archive }, [
          'target',
          'dir',
          'dir\\copy',
        ]);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).resolves.toBeUndefined();

        await expect(
          assertDirectorySymlinksAreSafe(source, undefined, {
            maxExpandedBytes: 9,
          }),
        ).rejects.toThrow('Tar archive expands beyond 9 bytes.');
      },
    );

    it('excludes the compressed archive from final size accounting', async () => {
      const archive = path.join(root, 'download.tar.gz');
      await fs.writeFile(path.join(root, 'extension.txt'), 'large');
      await fs.writeFile(archive, 'large');

      await expect(
        assertDirectorySymlinksAreSafe(root, undefined, {
          maxExpandedBytes: 5,
          excludePath: archive,
        }),
      ).resolves.toBeUndefined();
    });

    it('classifies final-layout entries with lstat', async () => {
      const file = path.join(root, 'extension.txt');
      await fs.writeFile(file, 'content');
      const readdirSpy = vi.spyOn(fs, 'readdir');
      const lstatSpy = vi.spyOn(fs, 'lstat');

      await assertDirectorySymlinksAreSafe(root);

      expect(readdirSpy).toHaveBeenCalledWith(root);
      expect(lstatSpy).toHaveBeenCalledWith(file);
    });

    it('counts accepted symlinks toward the link-entry limit', async () => {
      const archive = path.join(root, 'accepted-link-limit.tar');
      await writeCraftedTar(archive, [
        ...Array.from({ length: 101 }, (_, index) =>
          symlinkHeader(`link-${index}`, 'target'),
        ),
        createTarFileHeader('target', 0),
      ]);

      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('more than 100 link entries');
    });

    it.runIf(process.platform !== 'win32')(
      'rejects a symlink with an absolute target',
      async () => {
        await fs.symlink('/etc/passwd', path.join(root, 'absolute'));
        const archive = path.join(root, 'absolute.tar');
        await tar.c({ cwd: root, file: archive }, ['absolute']);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).rejects.toThrow('unsupported link entry');
      },
    );

    it.runIf(process.platform !== 'win32')(
      'rejects a symlink with a Windows-absolute target',
      async () => {
        await fs.symlink('C:\\Windows\\system32', path.join(root, 'drive'));
        const archive = path.join(root, 'drive.tar');
        await tar.c({ cwd: root, file: archive }, ['drive']);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).rejects.toThrow('unsupported link entry');
      },
    );

    it.runIf(process.platform !== 'win32')(
      'rejects a hard link even when it points inside the archive root',
      async () => {
        await fs.writeFile(path.join(root, 'original.txt'), 'y\n');
        await fs.link(
          path.join(root, 'original.txt'),
          path.join(root, 'hard.txt'),
        );
        const archive = path.join(root, 'hard.tar');
        await tar.c({ cwd: root, file: archive }, ['original.txt', 'hard.txt']);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).rejects.toThrow('unsupported link entry');
      },
    );

    it.runIf(process.platform !== 'win32')(
      'still rejects a contained symlink when the option is off',
      async () => {
        await fs.writeFile(path.join(root, 'CLAUDE.md'), '# guide\n');
        await fs.symlink('CLAUDE.md', path.join(root, 'AGENTS.md'));
        const archive = path.join(root, 'default.tar');
        await tar.c({ cwd: root, file: archive }, ['CLAUDE.md', 'AGENTS.md']);

        await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
          'unsupported link entry',
        );
      },
    );
  });
});
