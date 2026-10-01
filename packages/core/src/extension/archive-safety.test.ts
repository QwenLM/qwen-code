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
  type TarArchiveSafetyOptions,
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
// headers via `onReadEntry` without needing content, so crafted headers
// exercise the entry-count and expanded-size limits without writing gigabytes
// of data or hundreds of thousands of files to disk.
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
    streamProbe.onReadStream = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Writes crafted `headers` to an archive under `root` and scans it. */
  const scanCrafted = async (
    headers: Buffer[],
    options?: TarArchiveSafetyOptions,
  ) => {
    const archive = path.join(root, 'crafted.tar');
    await writeCraftedTar(archive, headers);
    return assertTarArchiveLinksAreSafe(archive, undefined, options);
  };

  /** Packs `entries` (relative to `cwd`) into an archive under `root`. */
  const pack = async (entries: string[], cwd = root) => {
    const archive = path.join(root, 'packed.tar');
    await tar.c({ cwd, file: archive }, entries);
    return archive;
  };

  /** Packs 101 dangling symlinks, one past the unsupported-link cap. */
  const symlinkLinks = async () => {
    const links = Array.from({ length: 101 }, (_, index) => `link-${index}`);
    await Promise.all(
      links.map(async (link) => {
        await fs.symlink('missing-target', path.join(root, link));
      }),
    );
    return links;
  };

  it.runIf(process.platform !== 'win32')(
    'rejects a large link set without throwing outside the promise',
    async () => {
      const archive = await pack(await symlinkLinks());

      await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
        'more than 100 unsupported link entries',
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'stops reading the archive as soon as validation fails',
    async () => {
      const links = await symlinkLinks();
      // A large trailing entry that a scan-to-end implementation would still
      // consume after the link limit trips; an early abort never reaches it.
      const tailBytes = 20 * 1024 * 1024;
      await fs.writeFile(path.join(root, 'tail.bin'), randomBytes(tailBytes));
      const archive = await pack([...links, 'tail.bin']);

      let bytesRead = 0;
      streamProbe.onReadStream = (filePath, options, original) => {
        const stream = original(filePath, options);
        stream.on('data', (chunk) => {
          bytesRead += chunk.length;
        });
        return stream;
      };

      await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
        'more than 100 unsupported link entries',
      );

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

    await expect(
      assertTarArchiveLinksAreSafe(
        path.join(root, 'missing.tar'),
        controller.signal,
      ),
    ).rejects.toBe(abortReason);

    expect(createReadStreamCalls).toBe(0);
  });

  const resourceLimits = { enforceResourceLimits: true };
  const fileHeaders = (count: number) =>
    new Array<Buffer>(count).fill(createTarFileHeader('file', 0));

  it('accepts an archive with exactly the entry-count limit', async () => {
    await expect(
      scanCrafted(fileHeaders(MAX_ARCHIVE_ENTRIES), resourceLimits),
    ).resolves.toBeUndefined();
  });

  it('rejects an archive just over the entry-count limit', async () => {
    await expect(
      scanCrafted(fileHeaders(MAX_ARCHIVE_ENTRIES + 1), resourceLimits),
    ).rejects.toThrow(
      `Tar archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`,
    );
  });

  it('bounds retained archive path metadata', async () => {
    const suffix = 'x'.repeat(90);
    const pathLength = 97;
    const headers = Array.from(
      { length: Math.ceil(MAX_ARCHIVE_PATH_BYTES / pathLength) + 1 },
      (_, index) =>
        createTarFileHeader(
          `${index.toString().padStart(6, '0')}-${suffix}`,
          0,
        ),
    );

    await expect(
      scanCrafted(headers, { allowContainedSymlinks: true }),
    ).rejects.toThrow(
      `Tar archive path metadata exceeds ${MAX_ARCHIVE_PATH_BYTES} bytes.`,
    );
  });

  it('skips resource limits for trusted archives by default', async () => {
    await expect(
      scanCrafted([
        createTarFileHeader('big.bin', MAX_ARCHIVE_EXPANDED_BYTES + 1),
      ]),
    ).resolves.toBeUndefined();
  });

  // The parser skips `size` content bytes after each header, so every entry but
  // the last must carry its (padded) content; the last declares a huge size
  // with no backing bytes, which `tar.t` tolerates as trailing truncation. The
  // first entry's real content makes the two-entry sum a real accumulation.
  const scanByteLimitTar = (secondEntrySize: number) => {
    const firstContent = Buffer.alloc(512);
    return scanCrafted(
      [
        createTarFileHeader('first.bin', firstContent.length),
        firstContent,
        createTarFileHeader('second.bin', secondEntrySize),
      ],
      resourceLimits,
    );
  };

  it('accepts an archive whose declared sizes sum exactly to the byte limit', async () => {
    await expect(
      scanByteLimitTar(MAX_ARCHIVE_EXPANDED_BYTES - 512),
    ).resolves.toBeUndefined();
  });

  it('rejects an archive whose declared sizes sum just over the byte limit', async () => {
    await expect(
      scanByteLimitTar(MAX_ARCHIVE_EXPANDED_BYTES - 512 + 1),
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
    const expectCraftedRejected = (
      headers: Buffer[],
      message = 'unsupported link entry',
    ) => expect(scanCrafted(headers, allowLinks)).rejects.toThrow(message);
    /** Packs the #9724 repro: a root `AGENTS.md -> CLAUDE.md` symlink. */
    const packAgentsLink = async () => {
      await fs.writeFile(path.join(root, 'CLAUDE.md'), '# guide\n');
      await fs.symlink('CLAUDE.md', path.join(root, 'AGENTS.md'));
      return pack(['CLAUDE.md', 'AGENTS.md']);
    };
    /** Packs a lone root symlink `<name> -> <target>`; the scan must refuse. */
    const expectPackedSymlinkRejected = async (
      target: string,
      name: string,
    ) => {
      await fs.symlink(target, path.join(root, name));
      const archive = await pack([name]);
      await expect(
        assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
      ).rejects.toThrow('unsupported link entry');
    };

    it.runIf(process.platform !== 'win32')(
      'accepts a root-level symlink to a sibling file',
      async () => {
        const archive = await packAgentsLink();

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).resolves.toBeUndefined();
      },
    );

    it('rejects a dot-relative duplicate of an already-seen entry path', () =>
      expectCraftedRejected(
        [createTarFileHeader('foo', 0), createTarFileHeader('./foo', 0)],
        'duplicate entry path',
      ));

    it('accepts a symlink declared before its target', async () => {
      await expect(
        scanCrafted(
          [
            symlinkHeader('AGENTS.md', 'CLAUDE.md'),
            createTarFileHeader('CLAUDE.md', 0),
          ],
          allowLinks,
        ),
      ).resolves.toBeUndefined();
    });

    it.runIf(process.platform !== 'win32')(
      'accepts a nested symlink that stays inside the archive root',
      async () => {
        await fs.mkdir(path.join(root, 'docs'));
        await fs.writeFile(path.join(root, 'real.md'), 'x\n');
        await fs.symlink('../real.md', path.join(root, 'docs', 'link.md'));
        const archive = await pack(['real.md', 'docs']);

        await expect(
          assertTarArchiveLinksAreSafe(archive, undefined, allowLinks),
        ).resolves.toBeUndefined();
      },
    );

    it.runIf(process.platform !== 'win32')(
      'rejects a symlink whose target escapes the archive root',
      () => expectPackedSymlinkRejected('../../etc/hosts', 'escape'),
    );

    it('rejects a symlink whose normalized target is exactly the archive parent', () =>
      expectCraftedRejected([symlinkHeader('escape', '..')]));

    it('rejects a backslash-separated traversal target', () =>
      expectCraftedRejected([symlinkHeader('escape', '..\\..\\outside')]));

    it.runIf(process.platform !== 'win32')(
      'rejects an ambiguous literal-backslash target',
      () =>
        expectCraftedRejected([
          createTarFileHeader('dir/file', 0),
          createTarFileHeader('dir\\file', 0),
          symlinkHeader('alias', 'dir\\file'),
        ]),
    );

    it('rejects a UNC target without requiring Windows symlink support', () =>
      expectCraftedRejected([
        symlinkHeader('escape', '\\\\server\\share\\file'),
      ]));

    it('rejects a symlink with an absolute entry path', () =>
      expectCraftedRejected([
        symlinkHeader('/absolute-link', 'target'),
        createTarFileHeader('target', 0),
      ]));

    // Unlike "rejects a symlink with a Windows-absolute target", the drive
    // letter is in the *entry* path, so only
    // `WINDOWS_ABSOLUTE_PATH.test(entryPath)` can reject it (the target,
    // 'target', is unremarkable).
    it('rejects a symlink with a Windows-absolute entry path', () =>
      expectCraftedRejected([
        symlinkHeader('C:\\pwn', 'target'),
        createTarFileHeader('target', 0),
      ]));

    it('rejects a symlink whose entry path normalizes to the archive root', () =>
      expectCraftedRejected([
        symlinkHeader('nested/..', 'target'),
        createTarFileHeader('target', 0),
      ]));

    // dirname('link') + 'link' normalizes back to 'link'. Unlike the
    // ancestor-entry sibling, this does NOT discriminate its clause
    // (`normalizedEntry === resolved`): onReadEntry records the link in
    // `archiveEntries` (as SymbolicLink) before the check, so the post-loop
    // "target must be a distinct regular-file entry" scan rejects it anyway.
    // A plain regression test; deleting the self-reference clause passes it.
    it('rejects a symlink whose target resolves to its own entry path', () =>
      expectCraftedRejected([symlinkHeader('link', 'link')]));

    // dirname('a/b/link') + '..' normalizes to 'a', an ancestor of the entry
    // (not '.' or '..'), so only the ancestor clause
    // `normalizedEntry.startsWith(`${resolved}/`)` rejects it (unlike
    // `symlinkHeader('sub/loop', '..')`, whose target resolves to exactly '.'
    // and never reaches that clause).
    it('rejects a symlink whose target resolves to an ancestor entry', () =>
      expectCraftedRejected([
        createTarFileHeader('a', 0),
        symlinkHeader('a/b/link', '..'),
      ]));

    it('rejects link chains and dangling or directory targets', () =>
      expectCraftedRejected(
        [
          createTarFileHeader('target', 0),
          symlinkHeader('first', 'target'),
          symlinkHeader('second', 'first'),
          symlinkHeader('dangling', 'missing'),
          createTarFileHeader('directory/', 0, '5'),
          symlinkHeader('directory-link', 'directory'),
          symlinkHeader('path-link', 'target'),
          createTarFileHeader('path-link/child', 0),
        ],
        '4 unsupported link entries',
      ));

    it('rejects descendants of a trailing-separator symlink entry', () =>
      expectCraftedRejected([
        createTarFileHeader('target', 0),
        symlinkHeader('alias/', 'target'),
        createTarFileHeader('alias/child', 0),
      ]));

    it.runIf(process.platform !== 'win32')(
      'rejects unsafe symlinks in a restructured extracted tree',
      async () => {
        const expectTreeRejected = (dir: string) =>
          expect(assertDirectorySymlinksAreSafe(dir)).rejects.toThrow(
            'unsupported link entry',
          );
        /** `<root>/<name>`, optionally holding a regular file `target`. */
        const caseDir = async (name: string, withTarget = false) => {
          const dir = path.join(root, name);
          await fs.mkdir(dir);
          if (withTarget)
            await fs.writeFile(path.join(dir, 'target'), 'content');
          return dir;
        };

        const directoryCase = await caseDir('directory-case');
        await fs.mkdir(path.join(directoryCase, 'target'));
        await fs.symlink('target', path.join(directoryCase, 'link'));
        await expectTreeRejected(directoryCase);

        const danglingCase = await caseDir('dangling-case');
        await fs.symlink('missing', path.join(danglingCase, 'link'));
        await expectTreeRejected(danglingCase);

        const cycleCase = await caseDir('cycle-case');
        await fs.symlink('b', path.join(cycleCase, 'a'));
        await fs.symlink('a', path.join(cycleCase, 'b'));
        await expectTreeRejected(cycleCase);

        const chainCase = await caseDir('chain-case', true);
        await fs.symlink('target', path.join(chainCase, 'middle'));
        await fs.symlink('middle', path.join(chainCase, 'link'));
        await expectTreeRejected(chainCase);

        const absoluteCase = await caseDir('absolute-case', true);
        const absoluteTarget = path.join(absoluteCase, 'target');
        await fs.symlink(absoluteTarget, path.join(absoluteCase, 'link'));
        await expectTreeRejected(absoluteCase);

        const noncanonicalCase = await caseDir('noncanonical-case', true);
        await fs.symlink(
          'missing/../target',
          path.join(noncanonicalCase, 'link'),
        );
        await expectTreeRejected(noncanonicalCase);
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
        const archive = await pack(['target', 'dir', 'dir\\copy'], source);

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

    it('counts accepted symlinks toward the link-entry limit', () =>
      expectCraftedRejected(
        [
          ...Array.from({ length: 101 }, (_, index) =>
            symlinkHeader(`link-${index}`, 'target'),
          ),
          createTarFileHeader('target', 0),
        ],
        'more than 100 link entries',
      ));

    it.runIf(process.platform !== 'win32')(
      'rejects a symlink with an absolute target',
      () => expectPackedSymlinkRejected('/etc/passwd', 'absolute'),
    );

    it.runIf(process.platform !== 'win32')(
      'rejects a symlink with a Windows-absolute target',
      () => expectPackedSymlinkRejected('C:\\Windows\\system32', 'drive'),
    );

    // Crafted, not packed with `tar.c`, on purpose: a hard link is the one
    // fixture that drives tar's PENDINGLINKS path ([JOBDONE] re-processes the
    // pending job and re-enters [PROCESS]). Under CPU contention that second
    // pass can finalize after the pack ended, and minipass throws an unawaited
    // `Error: write after end`. With `dangerouslyIgnoreUnhandledErrors` false
    // on Linux, that uncaught exception exits the suite non-zero with every
    // test green and no FAIL line (release run 33576013293: 211 files, 9480
    // tests passed, exit 1; locally 3 in 28 runs with cores saturated). These
    // are exactly the bytes tar writes for a hard link (typeflag '1', linkname
    // -> original): a real-world shape without a pack the test must outlive.
    it('rejects a hard link even when it points inside the archive root', () =>
      expectCraftedRejected([
        createTarFileHeader('original.txt', 0),
        createTarFileHeader('hard.txt', 0, '1', 'original.txt'),
      ]));

    it.runIf(process.platform !== 'win32')(
      'still rejects a contained symlink when the option is off',
      async () => {
        const archive = await packAgentsLink();

        await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
          'unsupported link entry',
        );
      },
    );
  });
});
