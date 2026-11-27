/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import {
  captureWorktreeSnapshot,
  readWorktreeSnapshotMeta,
  restoreWorktreeSnapshot,
  selectWorktreeSnapshot,
  verifyRestoredWorktreeSnapshot,
  buildWorktreeSnapshotMeta,
  WORKTREE_SNAPSHOT_SCHEMA_VERSION,
  type WorktreeSnapshotMeta,
} from './worktree-snapshot-service.js';
import {
  WORKTREE_SESSION_FILE,
  worktreeHasWork,
} from './gitWorktreeService.js';

// R5-1: record the output file's mode at the moment node-tar is invoked. A
// post-write chmod ends at the same 0600 mode (the P2 cell below) but leaves
// the archive world-readable for the whole capture; only a pre-created 0600
// temp file is private from the first byte. -1 means the file did not exist
// when tar was called (node-tar would create it at 0666 & ~umask).
const tarCreateEntryModes = vi.hoisted(() => [] as number[]);
const lsFilesProbeBuffers = vi.hoisted(() => [] as Array<number | undefined>);
const captureTiming = vi.hoisted(() => ({
  afterRead: undefined as undefined | ((relativePath: string) => void),
  beforeCreate: undefined as undefined | (() => void),
  afterCreate: undefined as undefined | (() => Promise<unknown>),
}));
vi.mock('../utils/git-branches.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/git-branches.js')>();
  return {
    ...actual,
    runGit: (...args: Parameters<typeof actual.runGit>) => {
      if (args[1].includes('ls-files') && args[1].includes('-v')) {
        lsFilesProbeBuffers.push(args[3]);
      }
      return actual.runGit(...args);
    },
  };
});
vi.mock('tar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tar')>();
  const { statSync } = await import('node:fs');
  const onRead = Object.getOwnPropertySymbols(actual.WriteEntry.prototype).find(
    (symbol) => symbol.description === 'onread',
  );
  if (!onRead) throw new Error('Missing WriteEntry onread probe');
  const descriptor = Object.getOwnPropertyDescriptor(
    actual.WriteEntry.prototype,
    onRead,
  );
  if (typeof descriptor?.value !== 'function') {
    throw new Error('WriteEntry onread is not a function');
  }
  const originalRead = descriptor.value as (
    this: { absolute?: string },
    bytesRead: number,
  ) => void;
  const nodePath = await import('node:path');
  const readWrapper = function (
    this: { absolute?: string },
    bytesRead: number,
  ): void {
    if (this.absolute) {
      captureTiming.afterRead?.(nodePath.basename(this.absolute));
    }
    return originalRead.call(this, bytesRead);
  };
  Object.defineProperty(actual.WriteEntry.prototype, onRead, {
    ...descriptor,
    value: readWrapper,
  });
  // The service only ever calls create(options-with-file, entries); narrow
  // the overloaded command to that shape for the delegating call.
  const createFile = actual.create as (
    options: { file: string; maxReadSize?: number },
    entries: string[],
  ) => Promise<void>;
  const create = Object.assign(
    (options: { file: string; maxReadSize?: number }, entries: string[]) => {
      try {
        tarCreateEntryModes.push(statSync(options.file).mode & 0o777);
      } catch {
        tarCreateEntryModes.push(-1);
      }
      captureTiming.beforeCreate?.();
      const completed = createFile(
        captureTiming.afterRead
          ? { ...options, maxReadSize: 4 * 1024 * 1024 }
          : options,
        entries,
      );
      return captureTiming.afterCreate
        ? completed.then(async () => captureTiming.afterCreate?.())
        : completed;
    },
    {
      syncFile: actual.create.syncFile,
      asyncFile: actual.create.asyncFile,
      syncNoFile: actual.create.syncNoFile,
      asyncNoFile: actual.create.asyncNoFile,
    },
  ) as unknown as typeof actual.create;
  return { ...actual, create };
});

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  }).trim();
}

function rawTarMember(
  name: string,
  type: '0' | '1' | '2' | '5' = '0',
  linkpath = '',
  contents?: Buffer,
): Buffer[] {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(
    `${(contents?.length ?? 0).toString(8).padStart(11, '0')}\0`,
    124,
  );
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkpath, 157);
  header.write('ustar', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  const chunks: Buffer[] = [header];
  if (contents) {
    chunks.push(contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  return chunks;
}

describe('worktreeSnapshotService (P6 U1)', () => {
  let root: string;
  let worktree: string;
  let snapshotDir: string;

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-snap-')),
    );
    worktree = path.join(root, 'wt');
    snapshotDir = path.join(root, 'snapshots');
    await fs.mkdir(worktree);
    git(worktree, 'init', '-q', '-b', 'main');
    git(worktree, 'config', 'user.email', 't@e.com');
    git(worktree, 'config', 'user.name', 't');
    git(worktree, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'base\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'init', '--no-verify');
  });

  afterEach(async () => {
    captureTiming.afterRead = undefined;
    captureTiming.beforeCreate = undefined;
    captureTiming.afterCreate = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  const meta = () => ({
    sessionId: 'session-snap',
    slug: 'snap',
    baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    headCommit: git(worktree, 'rev-parse', 'HEAD'),
    branch: 'main',
    dirty: { tracked: 1, untracked: 1, deleted: [] as string[] },
  });

  // Recreate a checkout at the recorded HEAD the way U5 restore will, then
  // lay the archive over it and re-apply deletions.
  async function restoreOverHead(
    snapshotPath: string,
    metaPath: string,
    name: string,
  ): Promise<string> {
    const restored = path.join(root, name);
    git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
    const m = await readWorktreeSnapshotMeta(metaPath);
    await restoreWorktreeSnapshot(snapshotPath, restored, m);
    return restored;
  }

  it('captures work and excludes ignored regenerable dirs, .git, and the marker', async () => {
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'dirty-tracked\n');
    await fs.writeFile(
      path.join(worktree, 'untracked.txt'),
      'dirty-untracked\n',
    );
    await fs.writeFile(path.join(worktree, '.gitignore'), 'node_modules/\n');
    await fs.mkdir(path.join(worktree, 'node_modules', 'x'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(worktree, 'node_modules', 'x', 'i.js'),
      '//\n',
    );
    await fs.writeFile(path.join(worktree, WORKTREE_SESSION_FILE), 'marker\n');

    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });

    const restored = await restoreOverHead(snapshotPath, metaPath, 'restored');
    await expect(
      fs.readFile(path.join(restored, 'committed.txt'), 'utf8'),
    ).resolves.toBe('dirty-tracked\n');
    await expect(
      fs.readFile(path.join(restored, 'untracked.txt'), 'utf8'),
    ).resolves.toBe('dirty-untracked\n');
    await expect(
      fs.access(path.join(restored, 'node_modules', 'x', 'i.js')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(restored, '.git')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(restored, WORKTREE_SESSION_FILE)),
    ).rejects.toThrow();
    await expect(fs.access(metaPath)).resolves.toBeUndefined();
  });

  it('excludes the checkout’s own managed worktree directory and regenerable .qwen caches only', async () => {
    // The reported production archive was 93% nested `.qwen/` content: this
    // checkout's own managed worktrees (other checkouts) and its scratch tmp
    // tree. Both are excluded; a stated `.qwen/` subject stays archived so the
    // fix does not silently drop a workspace's skills/commands.
    await fs.writeFile(path.join(worktree, '.gitignore'), '.qwen/\n');
    const nestedWorktree = path.join(
      worktree,
      '.qwen',
      'worktrees',
      'inner',
      'src',
    );
    await fs.mkdir(nestedWorktree, { recursive: true });
    await fs.writeFile(path.join(nestedWorktree, 'inner.ts'), 'export {};\n');
    const tmp = path.join(worktree, '.qwen', 'tmp', 'blobs');
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, 'scratch.bin'), 'tmp\n');
    const logs = path.join(worktree, '.qwen', 'logs');
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(path.join(logs, 'hook.log'), 'log\n');
    const skill = path.join(worktree, '.qwen', 'skills', 'demo');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), '# demo\n');

    const { snapshotPath, metaPath, checkoutMatchesCapture } =
      await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: meta(),
      });

    expect(checkoutMatchesCapture).toBe(true);
    const members: string[] = [];
    await tar.t({
      file: snapshotPath,
      onReadEntry: (entry) => {
        members.push(entry.path);
      },
    });
    expect(
      members.filter((member) => member.startsWith('./.qwen/worktrees/')),
    ).toEqual([]);
    expect(
      members.filter((member) => member.startsWith('./.qwen/tmp/')),
    ).toEqual([]);
    expect(
      members.filter((member) => member.startsWith('./.qwen/logs/')),
    ).toEqual([]);
    expect(members).toEqual(
      expect.arrayContaining(['./.qwen/skills/demo/SKILL.md']),
    );

    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-bounded',
    );
    await expect(
      fs.access(path.join(restored, '.qwen', 'skills', 'demo', 'SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(restored, '.qwen', 'worktrees', 'inner', 'src', 'inner.ts'),
      ),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(restored, '.qwen', 'tmp', 'blobs', 'scratch.bin')),
    ).rejects.toThrow();
  });

  it('verifies a large capture without an O(N^2) synchronous membership scan', async () => {
    // The post-capture check used `regularFiles.includes(entry.path)` per
    // entry: O(N^2) inside one microtask with no yield point, which froze the
    // daemon event loop for minutes on a 300k-file checkout. Keep one timer
    // ticking across the capture and require it to run while the membership
    // check is pending; a linear scan of N entries would starve it.
    const bulk = path.join(worktree, 'bulk');
    await fs.mkdir(bulk);
    const FILES = 3000;
    for (let i = 0; i < FILES; i += 250) {
      await Promise.all(
        Array.from({ length: Math.min(250, FILES - i) }, (_, offset) =>
          fs.writeFile(path.join(bulk, `f${i + offset}`), 'x'),
        ),
      );
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      const result = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: meta(),
      });
      expect(result.checkoutMatchesCapture).toBe(true);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32').each([
    { committedMode: 0o644, capturedMode: 0o755 },
    { committedMode: 0o755, capturedMode: 0o644 },
  ])(
    'restores the captured mode when the committed file is $committedMode and the captured file is $capturedMode',
    async ({ committedMode, capturedMode }) => {
      const tracked = path.join(worktree, 'committed.txt');
      await fs.chmod(tracked, committedMode);
      git(
        worktree,
        'update-index',
        `--chmod=${committedMode === 0o755 ? '+x' : '-x'}`,
        'committed.txt',
      );
      git(
        worktree,
        'commit',
        '--allow-empty',
        '-qm',
        'initial mode',
        '--no-verify',
      );

      await fs.writeFile(tracked, 'captured mode\n');
      await fs.chmod(tracked, capturedMode);
      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: meta(),
      });

      const restored = await restoreOverHead(
        snapshotPath,
        metaPath,
        'restored-mode',
      );
      expect(
        (await fs.stat(path.join(restored, 'committed.txt'))).mode & 0o777,
      ).toBe(capturedMode);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'verifies force-added ignored bytes without adopting ignored extra files',
    async () => {
      await fs.writeFile(
        path.join(worktree, '.gitignore'),
        'dist/\ncoverage/\n',
      );
      await fs.mkdir(path.join(worktree, 'dist'));
      await fs.writeFile(
        path.join(worktree, 'dist', 'forced.txt'),
        'captured ignored bytes\n',
      );
      git(worktree, 'add', '-f', 'dist/forced.txt');
      await fs.mkdir(path.join(worktree, 'coverage'));
      await fs.writeFile(
        path.join(worktree, 'coverage', 'extra.txt'),
        'not captured\n',
      );

      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: meta(),
      });
      const restored = await restoreOverHead(
        snapshotPath,
        metaPath,
        'restored-ignored',
      );
      const verificationMeta = {
        ...(await readWorktreeSnapshotMeta(metaPath)),
        branch: git(restored, 'branch', '--show-current'),
      };
      await expect(
        fs.readFile(path.join(restored, 'dist', 'forced.txt'), 'utf8'),
      ).resolves.toBe('captured ignored bytes\n');
      await expect(
        verifyRestoredWorktreeSnapshot({
          worktreePath: restored,
          snapshotPath,
          meta: verificationMeta,
        }),
      ).resolves.toBe(true);

      execFileSync('mkfifo', [path.join(restored, 'dist', 'late-pipe')]);
      await expect(
        verifyRestoredWorktreeSnapshot({
          worktreePath: restored,
          snapshotPath,
          meta: verificationMeta,
        }),
      ).rejects.toThrow('non-regular filesystem entry');
      await fs.rm(path.join(restored, 'dist', 'late-pipe'));

      await fs.rm(path.join(restored, 'coverage'), {
        recursive: true,
        force: true,
      });
      await expect(
        verifyRestoredWorktreeSnapshot({
          worktreePath: restored,
          snapshotPath,
          meta: verificationMeta,
        }),
      ).resolves.toBe(true);
      await fs.writeFile(
        path.join(restored, 'dist', 'forced.txt'),
        'late change\n',
      );
      await expect(
        verifyRestoredWorktreeSnapshot({
          worktreePath: restored,
          snapshotPath,
          meta: verificationMeta,
        }),
      ).resolves.toBe(false);
    },
  );

  it('verifies missing and newly added empty directories', async () => {
    await fs.mkdir(path.join(worktree, 'empty', 'nested'), {
      recursive: true,
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-empty-dirs',
    );
    const verificationMeta = {
      ...(await readWorktreeSnapshotMeta(metaPath)),
      branch: git(restored, 'branch', '--show-current'),
    };
    const verify = () =>
      verifyRestoredWorktreeSnapshot({
        worktreePath: restored,
        snapshotPath,
        meta: verificationMeta,
      });

    await expect(verify()).resolves.toBe(true);
    await fs.rmdir(path.join(restored, 'empty', 'nested'));
    await expect(verify()).resolves.toBe(false);
    await fs.mkdir(path.join(restored, 'empty', 'nested'));
    await expect(verify()).resolves.toBe(true);
    await fs.mkdir(path.join(restored, 'late-empty'));
    await expect(verify()).resolves.toBe(false);
    await fs.rmdir(path.join(restored, 'late-empty'));
    await expect(verify()).resolves.toBe(true);
  });

  it('selects the newest pair by header time, mtime, then full path', async () => {
    const writePair = async (
      stem: string,
      createdAt: number,
      overrides: Record<string, unknown> = {},
    ) => {
      await fs.mkdir(snapshotDir, { recursive: true });
      const snapshotPath = path.join(
        snapshotDir,
        `session-snap.${stem}.worktree-snapshot.tar.gz`,
      );
      const metaPath = path.join(
        snapshotDir,
        `session-snap.${stem}.worktree-snapshot.json`,
      );
      await fs.writeFile(snapshotPath, 'selector-test-bytes');
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          ...meta(),
          version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
          baseCommit: 'a'.repeat(40),
          headCommit: 'b'.repeat(40),
          createdAt,
          ...overrides,
        }),
      );
      return { snapshotPath, metaPath };
    };
    const older = await writePair('older', 1);
    const newer = await writePair('newer', 2);
    await fs.utimes(newer.snapshotPath, 1, 1);
    await fs.utimes(older.snapshotPath, 2, 2);
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
      }),
    ).resolves.toMatchObject({ snapshotPath: newer.snapshotPath });

    const tiedA = await writePair('a', 3);
    const tiedB = await writePair('b', 3);
    await fs.utimes(tiedA.snapshotPath, 1, 1);
    await fs.utimes(tiedB.snapshotPath, 2, 2);
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
      }),
    ).resolves.toMatchObject({ snapshotPath: tiedB.snapshotPath });
    await fs.utimes(tiedB.snapshotPath, 1, 1);
    const tied = await selectWorktreeSnapshot({
      directory: snapshotDir,
      sessionId: 'session-snap',
      slug: 'snap',
    });
    expect(tied?.snapshotPath).toBe(tiedA.snapshotPath);
    expect(typeof tied?.mtimeNs).toBe('bigint');

    await writePair('bad', 4, {
      version: WORKTREE_SNAPSHOT_SCHEMA_VERSION + 1,
    });
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
      }),
    ).rejects.toThrow(/Unsupported worktree snapshot version/);
  });

  it('selects only the exact archive key and rejects missing or foreign pairs', async () => {
    for (let index = 0; index < 2; index++) {
      await fs.writeFile(path.join(worktree, 'committed.txt'), `edit-${index}`);
      await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: { ...meta(), dirty: { tracked: 1, untracked: 1, deleted: [] } },
      });
    }
    const files = (await fs.readdir(snapshotDir))
      .filter((file) => file.endsWith('.tar.gz'))
      .sort();
    expect(files).toHaveLength(2);
    const first = files[0]!;
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
        archiveKey: first,
      }),
    ).resolves.toMatchObject({
      snapshotPath: path.join(snapshotDir, first!),
    });
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
        archiveKey: '../escape.worktree-snapshot.tar.gz',
      }),
    ).rejects.toThrow(/archive key/);
    await fs.writeFile(
      path.join(snapshotDir, 'session-snap.alone.worktree-snapshot.json'),
      '{}',
    );
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
      }),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
        archiveKey: first,
      }),
    ).resolves.toMatchObject({
      snapshotPath: path.join(snapshotDir, first),
    });
    await fs.rm(
      path.join(snapshotDir, 'session-snap.alone.worktree-snapshot.json'),
    );
    const malformed = path.join(
      snapshotDir,
      'session-snap.000-malformed.worktree-snapshot',
    );
    await fs.writeFile(`${malformed}.tar.gz`, 'unrelated-bytes');
    await fs.writeFile(`${malformed}.json`, '{not-json');
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
        archiveKey: first,
      }),
    ).resolves.toMatchObject({
      snapshotPath: path.join(snapshotDir, first),
    });
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
      }),
    ).rejects.toThrow();
    await fs.rm(`${malformed}.tar.gz`);
    await fs.rm(`${malformed}.json`);
    const wrongSlug = path.join(
      snapshotDir,
      'session-snap.wrong.worktree-snapshot',
    );
    await fs.copyFile(path.join(snapshotDir, first), `${wrongSlug}.tar.gz`);
    const header = JSON.parse(
      await fs.readFile(
        path.join(snapshotDir, first.replace(/\.tar\.gz$/, '.json')),
        'utf8',
      ),
    );
    header.slug = 'another-slug';
    await fs.writeFile(`${wrongSlug}.json`, JSON.stringify(header));
    const otherOwnedPair = files.find((file) => file !== first)!;
    await fs.rm(path.join(snapshotDir, otherOwnedPair));
    await fs.rm(
      path.join(snapshotDir, otherOwnedPair.replace(/\.tar\.gz$/, '.json')),
    );
    const key = path.basename(`${wrongSlug}.tar.gz`);
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
        archiveKey: key,
      }),
    ).rejects.toThrow(/identity mismatch/);
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
      }),
    ).resolves.toMatchObject({
      snapshotPath: path.join(snapshotDir, first),
    });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects linked snapshot pair inputs',
    async () => {
      await fs.mkdir(snapshotDir, { recursive: true });
      const archive = path.join(
        snapshotDir,
        'session-snap.linked.worktree-snapshot.tar.gz',
      );
      const metaPath = path.join(
        snapshotDir,
        'session-snap.linked.worktree-snapshot.json',
      );
      const outside = path.join(root, 'outside.json');
      await fs.writeFile(archive, 'bytes');
      await fs.writeFile(outside, '{}');
      await fs.symlink(outside, metaPath);
      await expect(
        selectWorktreeSnapshot({
          directory: snapshotDir,
          sessionId: 'session-snap',
          slug: 'snap',
        }),
      ).rejects.toThrow(/owned regular file/);
    },
  );

  it('verifies restored content and accepts an intentional detached branch', async () => {
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'draft\n');
    await fs.writeFile(path.join(worktree, 'untracked.txt'), 'new.txt\n');
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const header = await readWorktreeSnapshotMeta(metaPath);
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-verification',
    );
    expect(
      await verifyRestoredWorktreeSnapshot({
        worktreePath: restored,
        snapshotPath,
        meta: { ...header, branch: '' },
      }),
    ).toBe(true);
    await fs.writeFile(path.join(restored, 'committed.txt'), 'late-edit\n');
    expect(
      await verifyRestoredWorktreeSnapshot({
        worktreePath: restored,
        snapshotPath,
        meta: { ...header, branch: '' },
      }),
    ).toBe(false);
  });

  it('captures and restores hardlinked file pairs correctly', async () => {
    const left = path.join(worktree, 'left-hardlink.bin');
    const right = path.join(worktree, 'right-hardlink.bin');
    const payload = randomBytes(8 * 1024 * 1024);
    await fs.writeFile(left, payload);
    await fs.link(left, right);
    expect((await fs.stat(left)).ino).toBe((await fs.stat(right)).ino);

    const result = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: {
        ...meta(),
        dirty: { tracked: 0, untracked: 2, deleted: [] },
      },
    });
    expect(result.checkoutMatchesCapture).toBe(true);
    const members = new Map<string, { type: string; linkpath?: string }>();
    await tar.t({
      file: result.snapshotPath,
      onReadEntry: (entry) => {
        if (entry.path.includes('hardlink.bin')) {
          members.set(path.posix.normalize(entry.path), {
            type: entry.type,
            linkpath: entry.linkpath,
          });
        }
      },
    });
    expect(members.size).toBe(2);
    const fileName =
      members.get('left-hardlink.bin')?.type === 'File'
        ? 'left-hardlink.bin'
        : 'right-hardlink.bin';
    const linkName =
      fileName === 'left-hardlink.bin'
        ? 'right-hardlink.bin'
        : 'left-hardlink.bin';
    expect(members.get(fileName)?.type).toBe('File');
    expect(members.get(linkName)?.type).toBe('Link');
    expect(path.posix.normalize(members.get(linkName)?.linkpath ?? '')).toBe(
      fileName,
    );

    const restored = await restoreOverHead(
      result.snapshotPath,
      result.metaPath,
      'restored-hardlinks',
    );
    for (const name of ['left-hardlink.bin', 'right-hardlink.bin']) {
      expect(
        (await fs.readFile(path.join(restored, name))).equals(payload),
      ).toBe(true);
    }
    expect((await fs.stat(path.join(restored, 'left-hardlink.bin'))).ino).toBe(
      (await fs.stat(path.join(restored, 'right-hardlink.bin'))).ino,
    );
  });

  it.each(['HEAD', 'branch'] as const)(
    'does not certify a late %s change',
    async (scenario) => {
      const before = meta();
      captureTiming.afterCreate = async () => {
        if (scenario === 'HEAD') {
          git(worktree, 'commit', '--allow-empty', '-qm', 'move head');
        } else {
          git(worktree, 'checkout', '-q', '-b', 'after-snapshot');
        }
      };
      const result = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: before,
      });

      const head = git(worktree, 'rev-parse', 'HEAD');
      const branch = git(worktree, 'branch', '--show-current');
      if (scenario === 'HEAD') {
        expect(head).not.toBe(before.headCommit);
        expect(branch).toBe(before.branch);
      } else {
        expect(head).toBe(before.headCommit);
        expect(branch).toBe('after-snapshot');
      }
      expect(result.checkoutMatchesCapture).toBe(false);
    },
  );

  it('captures symlinks and rejects a later target change', async (ctx) => {
    const alias = path.join(worktree, 'alias.txt');
    const alternate = path.join(worktree, 'alternate.txt');
    await fs.writeFile(alternate, 'alternate\n');
    try {
      await fs.symlink('committed.txt', alias);
    } catch (error) {
      if (process.platform === 'win32') ctx.skip();
      throw error;
    }
    const metadata = {
      ...meta(),
      dirty: { tracked: 0, untracked: 2, deleted: [] },
    };
    const original = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: metadata,
    });
    expect(original.checkoutMatchesCapture).toBe(true);

    captureTiming.afterCreate = async () => {
      await fs.unlink(alias);
      await fs.symlink('alternate.txt', alias);
    };
    const changed = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: metadata,
    });
    expect(await fs.readlink(alias)).toBe('alternate.txt');
    expect(changed.checkoutMatchesCapture).toBe(false);
  });

  it.each(['1', '2'] as const)(
    'does not treat a type-%s link with a directory suffix as a directory',
    async (type) => {
      await fs.mkdir(path.join(worktree, 'ghost'));
      await fs.mkdir(snapshotDir, { recursive: true });
      const archive = path.join(snapshotDir, 'link-geometry.tar.gz');
      await fs.writeFile(
        archive,
        gzipSync(
          Buffer.concat([
            ...rawTarMember('committed.txt', '0', '', Buffer.from('base\n')),
            ...rawTarMember('ghost/', type, 'committed.txt'),
            Buffer.alloc(1024),
          ]),
        ),
      );

      await expect(
        verifyRestoredWorktreeSnapshot({
          worktreePath: worktree,
          snapshotPath: archive,
          meta: meta(),
        }),
      ).resolves.toBe(false);
    },
  );

  it('does not let a directory alias hide a link with the same logical path', async () => {
    await fs.mkdir(path.join(worktree, 'ghost'));
    await fs.mkdir(snapshotDir, { recursive: true });
    const archive = path.join(snapshotDir, 'link-directory-alias.tar.gz');
    const base = rawTarMember('committed.txt', '0', '', Buffer.from('base\n'));
    await fs.writeFile(
      archive,
      gzipSync(
        Buffer.concat([
          ...base,
          ...rawTarMember('ghost/', '2', 'committed.txt'),
          ...rawTarMember('ghost', '5'),
          Buffer.alloc(1024),
        ]),
      ),
    );
    await expect(
      verifyRestoredWorktreeSnapshot({
        worktreePath: worktree,
        snapshotPath: archive,
        meta: meta(),
      }),
    ).resolves.toBe(false);

    await fs.writeFile(
      archive,
      gzipSync(
        Buffer.concat([
          ...base,
          ...rawTarMember('ghost/', '5'),
          Buffer.alloc(1024),
        ]),
      ),
    );
    await expect(
      verifyRestoredWorktreeSnapshot({
        worktreePath: worktree,
        snapshotPath: archive,
        meta: meta(),
      }),
    ).resolves.toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a non-UTF-8 symlink target before archiving',
    async () => {
      const alias = path.join(worktree, 'alias.txt');
      const rawTarget = Buffer.from('outside-\u00FF', 'latin1');
      await fs.symlink(rawTarget, alias);

      await expect(
        captureWorktreeSnapshot({
          worktreePath: worktree,
          snapshotDir,
          meta: meta(),
        }),
      ).rejects.toThrow('symlink target cannot be preserved byte-for-byte');
      await expect(fs.readlink(alias, { encoding: 'buffer' })).resolves.toEqual(
        rawTarget,
      );
      await expect(fs.readdir(snapshotDir)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a non-UTF-8 symlink target introduced after capture',
    async () => {
      const alias = path.join(worktree, 'late-alias.txt');
      captureTiming.afterCreate = async () => {
        await fs.symlink(Buffer.from('outside-\u00FF', 'latin1'), alias);
      };

      await expect(
        captureWorktreeSnapshot({
          worktreePath: worktree,
          snapshotDir,
          meta: meta(),
        }),
      ).rejects.toThrow('symlink target cannot be preserved byte-for-byte');
      await expect(fs.readlink(alias)).resolves.toBe('outside-\uFFFD');
      await expect(fs.readdir(snapshotDir)).resolves.toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not certify a changed owner-exec bit',
    async () => {
      const target = path.join(worktree, 'payload.txt');
      await fs.writeFile(target, 'mode-only\n');
      await fs.chmod(target, 0o755);
      expect((await fs.stat(target)).mode & 0o100).toBe(0o100);
      captureTiming.afterCreate = async () => {
        await fs.chmod(target, 0o644);
      };

      const result = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: {
          ...meta(),
          dirty: { tracked: 0, untracked: 1, deleted: [] },
        },
      });

      expect((await fs.stat(target)).mode & 0o100).toBe(0);
      expect(result.checkoutMatchesCapture).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO rather than silently omitting it from the archive',
    async () => {
      await fs.writeFile(path.join(worktree, 'untracked.txt'), 'real work\n');
      execFileSync('mkfifo', [path.join(worktree, 'session-pipe')]);
      await expect(
        captureWorktreeSnapshot({
          worktreePath: worktree,
          snapshotDir,
          meta: meta(),
        }),
      ).rejects.toThrow('non-regular filesystem entry');
      await expect(fs.readdir(snapshotDir)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO and cleans the archive created before its arrival',
    async () => {
      captureTiming.afterCreate = async () => {
        await expect(fs.readdir(snapshotDir)).resolves.toHaveLength(1);
        execFileSync('mkfifo', [path.join(worktree, 'late-pipe')]);
      };
      await expect(
        captureWorktreeSnapshot({
          worktreePath: worktree,
          snapshotDir,
          meta: meta(),
        }),
      ).rejects.toThrow('non-regular filesystem entry');
      await expect(fs.readdir(snapshotDir)).resolves.toEqual([]);
    },
  );

  it('detects when tar captures an intermediate ABA file version', async () => {
    const target = path.join(worktree, '000-target.txt');
    const original = randomBytes(20 * 1024 * 1024);
    const intermediate = randomBytes(20 * 1024 * 1024);
    await fs.writeFile(target, original);
    await fs.writeFile(path.join(worktree, '.gitignore'), 'node_modules\n');
    await fs.mkdir(path.join(worktree, 'node_modules'));
    await fs.writeFile(
      path.join(worktree, 'node_modules', 'ignored.txt'),
      'ignored\n',
    );
    await fs.writeFile(
      path.join(worktree, 'zzz-payload.txt'),
      Buffer.alloc(1024 * 1024, 0x78),
    );
    const targetVersions: string[] = [];
    captureTiming.afterRead = (relativePath) => {
      if (relativePath !== '000-target.txt') return;
      targetVersions.push(readFileSync(target).subarray(0, 6).toString('hex'));
      if (targetVersions.length === 1) {
        writeFileSync(target, intermediate);
      } else if (targetVersions.length === 5) {
        writeFileSync(target, original);
      }
    };
    const result = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    expect(targetVersions).toEqual([
      original.subarray(0, 6).toString('hex'),
      intermediate.subarray(0, 6).toString('hex'),
      intermediate.subarray(0, 6).toString('hex'),
      intermediate.subarray(0, 6).toString('hex'),
      intermediate.subarray(0, 6).toString('hex'),
    ]);
    expect(readFileSync(target).equals(original)).toBe(true);
    const chunks: Buffer[] = [];
    await tar.t({
      file: result.snapshotPath,
      strict: true,
      onReadEntry: (entry) => {
        if (entry.path.replace(/^\.\//, '') === '000-target.txt') {
          entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        }
      },
    });
    const captured = Buffer.concat(chunks);
    expect(chunks.length).toBeGreaterThan(0);
    expect(captured.length).toBe(original.length);
    expect(captured.equals(original)).toBe(false);
    expect(captured.subarray(-6).equals(intermediate.subarray(-6))).toBe(true);
    expect(result.checkoutMatchesCapture).toBe(false);
  });

  it('does not let a late protected path escape through an archive callback', async (ctx) => {
    const upperGit = path.join(worktree, '.GIT');
    const aliasExists = await fs.lstat(upperGit).then(
      () => true,
      () => false,
    );
    if (aliasExists) ctx.skip();
    captureTiming.beforeCreate = () => {
      writeFileSync(upperGit, 'late protected path\n');
    };
    const result = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    expect(result.checkoutMatchesCapture).toBe(false);
  });

  it('does not return an archive that exceeds the bounded restore ratio', async () => {
    await fs.writeFile(
      path.join(worktree, 'zeros.bin'),
      Buffer.alloc(20 * 1024 * 1024),
    );
    await expect(
      captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: meta(),
      }),
    ).rejects.toThrow(/ratio|decompress/i);
    await expect(fs.readdir(snapshotDir)).resolves.toEqual([]);
    await expect(
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
      }),
    ).resolves.toBeUndefined();
  });

  it('captures and restores a large file within bounded decompression limits', async () => {
    const payload = randomBytes(20 * 1024 * 1024);
    await fs.writeFile(path.join(worktree, 'large.bin'), payload);
    const result = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    expect(result.checkoutMatchesCapture).toBe(true);
    const restored = await restoreOverHead(
      result.snapshotPath,
      result.metaPath,
      'restored-large-bounded',
    );
    expect(
      (await fs.readFile(path.join(restored, 'large.bin'))).equals(payload),
    ).toBe(true);
    const header = await readWorktreeSnapshotMeta(result.metaPath);
    await expect(
      verifyRestoredWorktreeSnapshot({
        worktreePath: restored,
        snapshotPath: result.snapshotPath,
        meta: { ...header, branch: '' },
      }),
    ).resolves.toBe(true);
  });

  it('rejects oversized metadata before creating an archive', async () => {
    const files = Array.from(
      { length: 900 },
      (_, index) =>
        `vendor/${'p'.repeat(64)}/component-${index.toString().padStart(3, '0')}.txt`,
    );
    for (const relativePath of files) {
      const file = path.join(worktree, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'delete me\n');
    }
    git(worktree, 'add', '--', 'vendor');
    git(worktree, 'commit', '-qm', 'mass-delete', '--no-verify');
    for (const relativePath of files) {
      await fs.unlink(path.join(worktree, relativePath));
    }
    const capturedMeta = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'large-deletion-set',
      slug: 'large-deletion-set',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(capturedMeta.dirty.deleted).toHaveLength(900);
    await fs.mkdir(snapshotDir, { recursive: true });

    await expect(
      captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: capturedMeta,
      }),
    ).rejects.toThrow('Worktree snapshot metadata exceeds 64 KiB');
    await expect(fs.readdir(snapshotDir)).resolves.toEqual([]);
    await expect(
      fs.readFile(path.join(worktree, 'committed.txt'), 'utf8'),
    ).resolves.toBe('base\n');
  });

  it('returns undefined for an explicitly requested missing pair', async () => {
    const archiveKey = 'session-snap.1.1.worktree-snapshot.tar.gz';
    await fs.mkdir(snapshotDir, { recursive: true });
    const select = () =>
      selectWorktreeSnapshot({
        directory: snapshotDir,
        sessionId: 'session-snap',
        slug: 'snap',
        archiveKey,
      });
    await expect(select()).resolves.toBeUndefined();
    await fs.writeFile(path.join(snapshotDir, archiveKey), '', 'utf-8');
    await expect(select()).resolves.toBeUndefined();
  });

  it('matches an unchanged sha256 repository', async () => {
    const shaRepo = path.join(root, 'sha256-repo');
    await fs.mkdir(shaRepo);
    git(shaRepo, 'init', '-q', '-b', 'main', '--object-format=sha256');
    git(shaRepo, 'config', 'user.email', 't@e.com');
    git(shaRepo, 'config', 'user.name', 't');
    git(shaRepo, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(shaRepo, 'committed.txt'), 'base\n');
    git(shaRepo, 'add', '.');
    git(shaRepo, 'commit', '-qm', 'init', '--no-verify');
    await fs.appendFile(path.join(shaRepo, 'committed.txt'), 'dirty\n');
    const head = git(shaRepo, 'rev-parse', 'HEAD');
    expect(git(shaRepo, 'rev-parse', '--show-object-format')).toBe('sha256');
    const result = await captureWorktreeSnapshot({
      worktreePath: shaRepo,
      snapshotDir,
      meta: {
        ...meta(),
        baseCommit: head,
        headCommit: head,
        dirty: { tracked: 1, untracked: 0, deleted: [] },
      },
    });
    expect(result.checkoutMatchesCapture).toBe(true);
  });

  it('captures the checkout when only the daemon marker is untracked (R8-7 control)', async () => {
    await fs.writeFile(path.join(worktree, WORKTREE_SESSION_FILE), 'marker\n');
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: {
        ...meta(),
        dirty: { tracked: 0, untracked: 0, deleted: [] },
      },
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-marker-control',
    );
    await expect(
      fs.access(path.join(restored, WORKTREE_SESSION_FILE)),
    ).rejects.toThrow();
  });

  it('round-trips the metadata header with the current schema version', async () => {
    const m = meta();
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const read = await readWorktreeSnapshotMeta(metaPath);
    expect(read.version).toBe(WORKTREE_SNAPSHOT_SCHEMA_VERSION);
    expect(read.sessionId).toBe(m.sessionId);
    expect(read.slug).toBe(m.slug);
    expect(read.baseCommit).toBe(m.baseCommit);
    expect(read.branch).toBe('main');
    expect(read.dirty).toEqual({ tracked: 1, untracked: 1, deleted: [] });
    expect(typeof read.createdAt).toBe('number');
  });

  it('refuses an unknown schema version', async () => {
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    parsed.version = WORKTREE_SNAPSHOT_SCHEMA_VERSION + 99;
    await fs.writeFile(metaPath, JSON.stringify(parsed), 'utf8');
    await expect(readWorktreeSnapshotMeta(metaPath)).rejects.toThrow(
      /Unsupported worktree snapshot version/,
    );
  });

  it('refuses a version 1 header (cannot faithfully restore deletions)', async () => {
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    parsed.version = 1;
    delete parsed.dirty.deleted;
    await fs.writeFile(metaPath, JSON.stringify(parsed), 'utf8');
    await expect(readWorktreeSnapshotMeta(metaPath)).rejects.toThrow(
      /Unsupported worktree snapshot version/,
    );
  });

  it('refuses a header with a traversal path in dirty.deleted', async () => {
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    parsed.dirty.deleted = ['../escape.txt'];
    await fs.writeFile(metaPath, JSON.stringify(parsed), 'utf8');
    await expect(readWorktreeSnapshotMeta(metaPath)).rejects.toThrow(
      /malformed/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to extract a file through a pre-existing parent symlink (audit security)',
    async () => {
      const source = path.join(root, 'symlink-archive-source');
      const archive = path.join(root, 'symlink-archive.tar.gz');
      const outside = path.join(root, 'outside-target');
      const restored = path.join(root, 'restore-parent-link');
      await fs.mkdir(path.join(source, 'link'), { recursive: true });
      await fs.mkdir(outside);
      await fs.mkdir(restored);
      await fs.writeFile(path.join(source, 'link', 'victim.txt'), 'attacker\n');
      await fs.writeFile(path.join(outside, 'victim.txt'), 'outside-safe\n');
      await fs.symlink(outside, path.join(restored, 'link'), 'dir');
      await tar.create({ cwd: source, file: archive, gzip: true }, [
        'link/victim.txt',
      ]);
      const names: string[] = [];
      await tar.t({
        file: archive,
        onReadEntry: (entry) => names.push(entry.path),
      });
      expect(names).toContain('link/victim.txt');
      expect(names).not.toContain('link/');
      await expect(
        restoreWorktreeSnapshot(archive, restored, {
          ...meta(),
          version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
          createdAt: Date.now(),
        }),
      ).rejects.toThrow(/outside worktree root/);
      await expect(
        fs.readFile(path.join(outside, 'victim.txt'), 'utf8'),
      ).resolves.toBe('outside-safe\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to write through an archive-created parent symlink (audit security)',
    async () => {
      const archive = path.join(root, 'created-link-archive.tar');
      const outside = path.join(root, 'outside-created-link');
      const restored = path.join(root, 'restore-created-link');
      await fs.mkdir(restored, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'victim.txt'), 'outside-safe\n');
      await fs.writeFile(
        archive,
        Buffer.concat([
          ...rawTarMember('link', '2', '../outside-created-link'),
          ...rawTarMember(
            'link/victim.txt',
            '0',
            '',
            Buffer.from('attacker\n'),
          ),
          Buffer.alloc(1024),
        ]),
      );
      await expect(
        restoreWorktreeSnapshot(archive, restored, {
          ...meta(),
          version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
          createdAt: Date.now(),
        }),
      ).rejects.toThrow();
      await expect(
        fs.readFile(path.join(outside, 'victim.txt'), 'utf8'),
      ).resolves.toBe('outside-safe\n');
    },
  );

  it('refuses a directory-only traversal member before extraction (audit security)', async () => {
    const source = path.join(root, 'directory-archive-source');
    const outside = path.join(root, 'outside-directory');
    const archive = path.join(root, 'directory-archive.tar.gz');
    const restored = path.join(root, 'restore-directory-traversal');
    await fs.mkdir(source);
    await fs.mkdir(outside);
    await fs.mkdir(restored);
    await tar.create({ cwd: source, file: archive, gzip: true }, [
      '../outside-directory',
    ]);
    const names: string[] = [];
    await tar.t({
      file: archive,
      onReadEntry: (entry) => names.push(entry.path),
    });
    expect(names.some((name) => name.startsWith('..'))).toBe(true);
    await expect(
      restoreWorktreeSnapshot(archive, restored, {
        ...meta(),
        version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
        createdAt: Date.now(),
      }),
    ).rejects.toThrow(/Unsafe path/);
    await expect(fs.readdir(restored)).resolves.toEqual([]);
  });

  it('refuses a hardlink target escaping the restore root (audit security)', async () => {
    const archive = path.join(root, 'hardlink-escape.tar');
    const outsideTarget = path.join(root, 'outside-link-target');
    await fs.writeFile(outsideTarget, 'outside-bytes\n');
    await fs.writeFile(
      archive,
      Buffer.concat([
        ...rawTarMember('member', '1', '../outside-link-target'),
        Buffer.alloc(1024),
      ]),
    );
    await expect(
      restoreWorktreeSnapshot(archive, path.join(root, 'hardlink-restore'), {
        ...meta(),
        version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
        createdAt: Date.now(),
      }),
    ).rejects.toThrow(/Unsafe path/);
    await expect(fs.readFile(outsideTarget, 'utf8')).resolves.toBe(
      'outside-bytes\n',
    );
  });

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
    'refuses a clean tracked protected path case-variant before capture (audit security)',
    async () => {
      // The marker is protected case-folded on restore but can be tracked in
      // a real Git tree, so a clean variant reaches tar without any status row.
      await fs.writeFile(
        path.join(worktree, '.QWEN-SESSION'),
        'tracked variant\n',
      );
      git(worktree, 'add', '.QWEN-SESSION');
      git(worktree, 'commit', '-qm', 'track protected variant', '--no-verify');
      expect(git(worktree, 'status', '--porcelain')).toBe('');
      await fs.writeFile(path.join(worktree, 'unique-work.txt'), 'unique\n');
      await expect(
        captureWorktreeSnapshot({
          worktreePath: worktree,
          snapshotDir,
          meta: meta(),
        }),
      ).rejects.toThrow(/case-variant protected path/);
      await expect(
        fs.readFile(path.join(worktree, 'unique-work.txt'), 'utf8'),
      ).resolves.toBe('unique\n');
      await expect(fs.readdir(snapshotDir)).rejects.toThrow();
    },
  );

  it('rejects a capture from a worktree path that does not exist', async () => {
    await expect(
      captureWorktreeSnapshot({
        worktreePath: path.join(root, 'missing'),
        snapshotDir,
        meta: meta(),
      }),
    ).rejects.toThrow();
    // A failed capture must not leave a final archive behind, whatever its
    // unique per-capture suffix is.
    await expect(fs.readdir(snapshotDir)).rejects.toThrow();
  });

  it('restores a clean committed tree faithfully', async () => {
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-clean',
    );
    await expect(
      fs.readFile(path.join(restored, 'committed.txt'), 'utf8'),
    ).resolves.toBe('base\n');
  });

  it('builds a meta header from HEAD and dirty counts, excluding the marker (P6 U3)', async () => {
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'dirty\n');
    await fs.writeFile(path.join(worktree, 'untracked.txt'), 'new\n');
    await fs.writeFile(path.join(worktree, WORKTREE_SESSION_FILE), 'marker\n');
    const head = git(worktree, 'rev-parse', 'HEAD');

    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-meta',
      slug: 'meta',
      baseCommit: head,
    });

    expect(m.headCommit).toBe(head);
    expect(m.baseCommit).toBe(head);
    expect(m.branch).toBe('main');
    // One tracked edit + one untracked file; the marker is not counted.
    expect(m.dirty).toEqual({ tracked: 1, untracked: 1, deleted: [] });
  });

  // F2: an uncommitted tracked deletion must survive restore — extraction
  // over a recreated HEAD would otherwise resurrect the deleted file.
  it('records and re-applies an unstaged tracked deletion on restore', async () => {
    await fs.rm(path.join(worktree, 'committed.txt'));
    await fs.writeFile(path.join(worktree, 'keep.txt'), 'kept\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-del',
      slug: 'del',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['committed.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-del',
    );
    await expect(
      fs.access(path.join(restored, 'committed.txt')),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(restored, 'keep.txt'), 'utf8'),
    ).resolves.toBe('kept\n');
  });

  it('removes only empty, unarchived ancestors of tracked deletions on restore', async () => {
    await fs.mkdir(path.join(worktree, 'deletion-dir', 'nested'), {
      recursive: true,
    });
    await fs.mkdir(path.join(worktree, 'preserved-empty'));
    await fs.mkdir(path.join(worktree, 'keep-dir'));
    await fs.writeFile(
      path.join(worktree, 'deletion-dir', 'nested', 'to-delete.txt'),
      'deleted\n',
    );
    await fs.writeFile(path.join(worktree, 'keep-dir', 'keep.txt'), 'keep\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'deleted parent fixture', '--no-verify');
    await fs.rm(path.join(worktree, 'deletion-dir'), {
      recursive: true,
      force: true,
    });
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-delete-parent',
      slug: 'delete-parent',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['deletion-dir/nested/to-delete.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });

    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-delete-parent',
    );

    await expect(
      fs.access(path.join(restored, 'deletion-dir')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(restored, 'preserved-empty')),
    ).resolves.toBe(undefined);
    await expect(
      fs.readFile(path.join(restored, 'keep-dir', 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep\n');
    await expect(
      verifyRestoredWorktreeSnapshot({
        worktreePath: restored,
        snapshotPath,
        meta: {
          ...(await readWorktreeSnapshotMeta(metaPath)),
          branch: git(restored, 'branch', '--show-current'),
        },
      }),
    ).resolves.toBe(true);
  });

  it('records a staged tracked deletion on restore', async () => {
    await fs.rm(path.join(worktree, 'committed.txt'));
    git(worktree, 'add', 'committed.txt');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-staged-del',
      slug: 'staged-del',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['committed.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-staged-del',
    );
    await expect(
      fs.access(path.join(restored, 'committed.txt')),
    ).rejects.toThrow();
  });

  it('records a rename source as a deletion so restore does not resurrect it', async () => {
    git(worktree, 'mv', 'committed.txt', 'renamed.txt');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-rename',
      slug: 'rename',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['committed.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-rename',
    );
    await expect(
      fs.access(path.join(restored, 'committed.txt')),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(restored, 'renamed.txt'), 'utf8'),
    ).resolves.toBe('base\n');
  });

  it('preserves archived content when a deleted tracked path became a directory', async () => {
    // file→directory replacement: the tracked file is deleted and a folder of
    // the same name holds new untracked work. Restore must not delete the
    // folder while re-applying the recorded deletion.
    await fs.rm(path.join(worktree, 'committed.txt'));
    await fs.mkdir(path.join(worktree, 'committed.txt', 'drafts'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(worktree, 'committed.txt', 'drafts', 'one.txt'),
      'folder-work\n',
    );
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-filedir',
      slug: 'filedir',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['committed.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-filedir',
    );
    await expect(
      fs.readFile(
        path.join(restored, 'committed.txt', 'drafts', 'one.txt'),
        'utf8',
      ),
    ).resolves.toBe('folder-work\n');
  });

  it('keeps session content when a deleted tracked path was recreated', async () => {
    // git rm stages the deletion; writing the path again creates untracked
    // content at the same name. The recorded deletion must not remove the
    // archive's new content on restore.
    git(worktree, 'rm', '-q', 'committed.txt');
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'session-new\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-recreate',
      slug: 'recreate',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['committed.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-recreate',
    );
    await expect(
      fs.readFile(path.join(restored, 'committed.txt'), 'utf8'),
    ).resolves.toBe('session-new\n');
  });

  it('restores a file that replaced a tracked directory (dir→file)', async () => {
    await fs.mkdir(path.join(worktree, 'dir'));
    await fs.writeFile(path.join(worktree, 'dir', 'a.txt'), 'base\n');
    git(worktree, 'add', 'dir/a.txt');
    git(worktree, 'commit', '-qm', 'add dir', '--no-verify');
    await fs.rm(path.join(worktree, 'dir'), { recursive: true, force: true });
    await fs.writeFile(path.join(worktree, 'dir'), 'session-file\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-dirfile',
      slug: 'dirfile',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['dir/a.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-dirfile',
    );
    await expect(fs.readFile(path.join(restored, 'dir'), 'utf8')).resolves.toBe(
      'session-file\n',
    );
  });

  it('restores a file that replaced a nested tracked directory (deep dir→file)', async () => {
    await fs.mkdir(path.join(worktree, 'deep', 'nested'), { recursive: true });
    await fs.writeFile(
      path.join(worktree, 'deep', 'nested', 'leaf.txt'),
      'base\n',
    );
    git(worktree, 'add', 'deep/nested/leaf.txt');
    git(worktree, 'commit', '-qm', 'add nested dir', '--no-verify');
    await fs.rm(path.join(worktree, 'deep'), { recursive: true, force: true });
    await fs.writeFile(path.join(worktree, 'deep'), 'replaced-with-file\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-deep-dirfile',
      slug: 'deep-dirfile',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toEqual(['deep/nested/leaf.txt']);
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-deep-dirfile',
    );
    await expect(
      fs.readFile(path.join(restored, 'deep'), 'utf8'),
    ).resolves.toBe('replaced-with-file\n');
    await expect(
      verifyRestoredWorktreeSnapshot({
        worktreePath: restored,
        snapshotPath,
        meta: {
          ...(await readWorktreeSnapshotMeta(metaPath)),
          branch: git(restored, 'branch', '--show-current'),
        },
      }),
    ).resolves.toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'restores a symlink replacing a nested tracked directory without pruning target subdirectories',
    async () => {
      await fs.mkdir(path.join(worktree, 'deep', 'nested'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(worktree, 'deep', 'nested', 'leaf.txt'),
        'base\n',
      );
      git(worktree, 'add', 'deep/nested/leaf.txt');
      git(worktree, 'commit', '-qm', 'add nested dir for link', '--no-verify');
      await fs.rm(path.join(worktree, 'deep'), {
        recursive: true,
        force: true,
      });
      await fs.mkdir(path.join(worktree, 'other', 'nested'), {
        recursive: true,
      });
      await fs.symlink('other', path.join(worktree, 'deep'));
      const m = await buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-deep-dirlink',
        slug: 'deep-dirlink',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      });
      expect(m.dirty.deleted).toEqual(['deep/nested/leaf.txt']);
      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: m,
      });
      const restored = await restoreOverHead(
        snapshotPath,
        metaPath,
        'restored-deep-dirlink',
      );
      await expect(fs.readlink(path.join(restored, 'deep'))).resolves.toBe(
        'other',
      );
      expect(
        (await fs.lstat(path.join(restored, 'other', 'nested'))).isDirectory(),
      ).toBe(true);
      await expect(
        verifyRestoredWorktreeSnapshot({
          worktreePath: restored,
          snapshotPath,
          meta: {
            ...(await readWorktreeSnapshotMeta(metaPath)),
            branch: git(restored, 'branch', '--show-current'),
          },
        }),
      ).resolves.toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'restores a directory that replaced an in-root committed symlink (file target and directory target)',
    async () => {
      await fs.mkdir(path.join(worktree, 'target-dir', 'sub'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(worktree, 'target-dir', 'sub', 'keep.txt'),
        'inside-target-intact\n',
      );
      await fs.symlink('committed.txt', path.join(worktree, 'link-file'));
      await fs.symlink('target-dir', path.join(worktree, 'link-dir'));
      git(worktree, 'add', 'target-dir/sub/keep.txt', 'link-file', 'link-dir');
      git(worktree, 'commit', '-qm', 'add committed symlinks', '--no-verify');

      for (const name of ['link-file', 'link-dir']) {
        await fs.unlink(path.join(worktree, name));
        await fs.mkdir(path.join(worktree, name, 'sub'), { recursive: true });
        await fs.writeFile(
          path.join(worktree, name, 'sub', 'note.txt'),
          `replaced-${name}\n`,
        );
      }

      const m = await buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-symlink-to-dir',
        slug: 'symlink-to-dir',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      });
      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: m,
      });
      const restored = await restoreOverHead(
        snapshotPath,
        metaPath,
        'restored-symlink-to-dir',
      );

      for (const name of ['link-file', 'link-dir']) {
        expect((await fs.lstat(path.join(restored, name))).isDirectory()).toBe(
          true,
        );
        await expect(
          fs.readFile(path.join(restored, name, 'sub', 'note.txt'), 'utf8'),
        ).resolves.toBe(`replaced-${name}\n`);
      }
      // The in-repo target directory was not traversed or modified.
      await expect(
        fs.readFile(
          path.join(restored, 'target-dir', 'sub', 'keep.txt'),
          'utf8',
        ),
      ).resolves.toBe('inside-target-intact\n');
      await expect(
        fs.access(path.join(restored, 'target-dir', 'sub', 'note.txt')),
      ).rejects.toThrow();
      await expect(
        verifyRestoredWorktreeSnapshot({
          worktreePath: restored,
          snapshotPath,
          meta: {
            ...(await readWorktreeSnapshotMeta(metaPath)),
            branch: git(restored, 'branch', '--show-current'),
          },
        }),
      ).resolves.toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'restores a directory that replaced a recursive symlink alias',
    async () => {
      await fs.symlink('.', path.join(worktree, 'link'));
      git(worktree, 'add', 'link');
      git(worktree, 'commit', '-qm', 'directory alias', '--no-verify');
      await fs.unlink(path.join(worktree, 'link'));
      await fs.mkdir(path.join(worktree, 'link'));
      await fs.writeFile(
        path.join(worktree, 'link', 'draft.txt'),
        'nested-draft\n',
      );
      const m = await buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-alias-file',
        slug: 'alias-file',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      });
      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: m,
      });
      const restored = await restoreOverHead(
        snapshotPath,
        metaPath,
        'restored-alias-file',
      );
      await expect(
        fs.readFile(path.join(restored, 'link', 'draft.txt'), 'utf8'),
      ).resolves.toBe('nested-draft\n');
      expect((await fs.lstat(path.join(restored, 'link'))).isDirectory()).toBe(
        true,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a directory alias that targets the worktree gitfile',
    async () => {
      await fs.symlink('.', path.join(worktree, 'link'));
      git(worktree, 'add', 'link');
      git(worktree, 'commit', '-qm', 'symlink to worktree root', '--no-verify');
      await fs.unlink(path.join(worktree, 'link'));
      await fs.mkdir(path.join(worktree, 'link'));
      git(path.join(worktree, 'link'), 'init', '-q');
      await fs.writeFile(
        path.join(worktree, 'link', 'draft.txt'),
        'nested-repository-work\n',
      );
      const m = await buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-directory-alias',
        slug: 'directory-alias',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      });
      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: m,
      });
      const members: string[] = [];
      await tar.t({
        file: snapshotPath,
        onReadEntry: (entry) => {
          members.push(entry.path);
        },
      });
      expect(
        members.some(
          (name) =>
            path.posix.normalize(name).replace(/\/$/, '') === 'link/.git',
        ),
      ).toBe(true);
      const restored = path.join(root, 'restored-directory-alias');
      git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
      const originalGitfile = await fs.readFile(
        path.join(restored, '.git'),
        'utf8',
      );
      expect(
        (await fs.lstat(path.join(restored, 'link'))).isSymbolicLink(),
      ).toBe(true);
      const metadata = await readWorktreeSnapshotMeta(metaPath);
      let resultError: unknown;
      await restoreWorktreeSnapshot(snapshotPath, restored, metadata).catch(
        (error) => {
          resultError = error;
        },
      );
      await expect(
        fs.readFile(path.join(restored, '.git'), 'utf8'),
      ).resolves.toBe(originalGitfile);
      expect(resultError instanceof Error && resultError.message).toMatch(
        /protected path/,
      );
      expect(
        (await fs.lstat(path.join(restored, 'link'))).isSymbolicLink(),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a file archive member or tracked deletion that targets .git through a committed symlink',
    async () => {
      await fs.symlink('.', path.join(worktree, 'link'));
      git(worktree, 'add', 'link');
      git(worktree, 'commit', '-qm', 'add root alias symlink', '--no-verify');
      const restored = path.join(root, 'restored-symlink-git-bypass');
      git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
      const originalGitfile = await fs.readFile(
        path.join(restored, '.git'),
        'utf8',
      );
      const headCommit = git(restored, 'rev-parse', 'HEAD');
      const baseMeta: WorktreeSnapshotMeta = {
        version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
        createdAt: Date.now(),
        sessionId: 'session-symlink-git-bypass',
        slug: 'symlink-git-bypass',
        baseCommit: headCommit,
        branch: '',
        headCommit,
        dirty: { tracked: 0, untracked: 0, deleted: [] },
      };

      // 1) A crafted archive containing a regular File member at link/.git.
      await fs.mkdir(snapshotDir, { recursive: true });
      const staging = path.join(root, 'staging-symlink-git-bypass');
      await fs.mkdir(path.join(staging, 'link'), { recursive: true });
      await fs.writeFile(path.join(staging, 'link', '.git'), 'pwned-gitfile\n');
      const fileTar = path.join(snapshotDir, 'crafted-link-git-file.tar.gz');
      await tar.c({ file: fileTar, cwd: staging, gzip: true }, ['link/.git']);
      await expect(
        restoreWorktreeSnapshot(fileTar, restored, baseMeta),
      ).rejects.toThrow(/protected path/);
      await expect(
        fs.readFile(path.join(restored, '.git'), 'utf8'),
      ).resolves.toBe(originalGitfile);

      // 2) A clean archive whose meta.dirty.deleted names link/.git.
      const emptyStaging = path.join(root, 'staging-empty-bypass');
      await fs.mkdir(emptyStaging, { recursive: true });
      const emptyTar = path.join(snapshotDir, 'crafted-link-git-delete.tar.gz');
      await tar.c({ file: emptyTar, cwd: emptyStaging, gzip: true }, ['.']);
      await expect(
        restoreWorktreeSnapshot(emptyTar, restored, {
          ...baseMeta,
          dirty: { tracked: 0, untracked: 0, deleted: ['link/.git'] },
        }),
      ).rejects.toThrow(/protected path/);
      await expect(
        fs.readFile(path.join(restored, '.git'), 'utf8'),
      ).resolves.toBe(originalGitfile);
    },
  );

  it('refuses a crafted archive with an absolute root "/" directory entry before extraction', async () => {
    await fs.mkdir(snapshotDir, { recursive: true });
    const restored = path.join(root, 'restored-root-slash-entry');
    git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
    const craftedTar = path.join(snapshotDir, 'crafted-root-slash.tar.gz');
    const payload = Buffer.concat([
      ...rawTarMember('/', '5'),
      Buffer.alloc(1024),
    ]);
    await fs.writeFile(craftedTar, gzipSync(payload));
    const headCommit = git(restored, 'rev-parse', 'HEAD');
    const baseMeta: WorktreeSnapshotMeta = {
      version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
      createdAt: Date.now(),
      sessionId: 'session-root-slash',
      slug: 'root-slash',
      baseCommit: headCommit,
      branch: '',
      headCommit,
      dirty: { tracked: 0, untracked: 0, deleted: [] },
    };

    await expect(
      restoreWorktreeSnapshot(craftedTar, restored, baseMeta),
    ).rejects.toThrow(/Unsafe path in snapshot archive/);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses capture when a deleted path is not valid UTF-8',
    async (ctx) => {
      const badName = Buffer.from('bad-\xff.txt', 'latin1');
      const badPath = Buffer.concat([
        Buffer.from(`${worktree}${path.sep}`),
        badName,
      ]);
      // Some filesystems (e.g. APFS) reject non-UTF-8 names with EILSEQ before
      // the snapshot code runs; that is an unsupported fixture, not a failure
      // of the guard. Skip there, keep the rejection assertion where the
      // fixture can be created (P2 macOS).
      try {
        await fs.writeFile(badPath, 'x\n');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EILSEQ' || code === 'EINVAL' || code === 'ENOTSUP') {
          ctx.skip();
        }
        throw error;
      }
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-qm', 'bad name', '--no-verify');
      await fs.rm(badPath);
      await expect(
        buildWorktreeSnapshotMeta(worktree, {
          sessionId: 'session-badutf8',
          slug: 'badutf8',
          baseCommit: git(worktree, 'rev-parse', 'HEAD'),
        }),
      ).rejects.toThrow(/not valid UTF-8/);
    },
  );

  it('refuses capture when staged content differs from the worktree (N1)', async () => {
    // git add stages A, then the worktree is edited to B (status MM). The tar
    // would hold only B; the staged A lives only in the index, so the capture
    // must refuse and let the caller preserve the checkout.
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'staged-A\n');
    git(worktree, 'add', 'committed.txt');
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'worktree-B\n');
    await expect(
      buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-mm',
        slug: 'mm',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      }),
    ).rejects.toThrow(/staged content differs/);
  });

  it('excludes nested ignored disposable output from the archive (R2-1)', async () => {
    await fs.writeFile(path.join(worktree, '.gitignore'), 'node_modules/\n');
    git(worktree, 'add', '.gitignore');
    git(worktree, 'commit', '-qm', 'ignore', '--no-verify');
    await fs.mkdir(
      path.join(worktree, 'packages', 'app', 'node_modules', 'x'),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(worktree, 'packages', 'app', 'node_modules', 'x', 'y.js'),
      '//\n',
    );
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-nested',
      slug: 'nested',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-nested',
    );
    await expect(
      fs.access(
        path.join(restored, 'packages', 'app', 'node_modules', 'x', 'y.js'),
      ),
    ).rejects.toThrow();
  });

  it('refuses restore deletion paths naming .git, the marker, or escaping the root (R2-4)', async () => {
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-confine',
      slug: 'confine',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = path.join(root, 'restored-confine');
    git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
    for (const bad of [
      '.git',
      '.git/config',
      WORKTREE_SESSION_FILE,
      '../escape.txt',
    ]) {
      const meta = {
        ...m,
        version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
        createdAt: Date.now(),
        dirty: { tracked: 0, untracked: 0, deleted: [bad] },
      };
      await expect(
        restoreWorktreeSnapshot(snapshotPath, restored, meta),
      ).rejects.toThrow();
    }
  });

  it('refuses a deletion that resolves outside the root via a committed symlink (R3-1)', async () => {
    // A committed symlink points outside the worktree; a deletion path under
    // it is lexically inside but resolves outside. The guard must refuse and
    // the outside file must survive (fs.rm would otherwise follow the link).
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'victim.txt'), 'PRECIOUS\n');
    await fs.symlink(outside, path.join(worktree, 'link'));
    git(worktree, 'add', 'link');
    git(worktree, 'commit', '-qm', 'symlink', '--no-verify');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-symlink',
      slug: 'symlink',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = path.join(root, 'restored-symlink');
    git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
    const meta = {
      ...m,
      version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
      createdAt: Date.now(),
      dirty: { tracked: 0, untracked: 0, deleted: ['link/victim.txt'] },
    };
    await expect(
      restoreWorktreeSnapshot(snapshotPath, restored, meta),
    ).rejects.toThrow(/via symlink/);
    await expect(
      fs.readFile(path.join(outside, 'victim.txt'), 'utf8'),
    ).resolves.toBe('PRECIOUS\n');
  });

  it('refuses ./-prefixed protected deletion paths (F4-0)', async () => {
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-dotgit',
      slug: 'dotgit',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = path.join(root, 'restored-dotgit');
    git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
    for (const bad of ['./.git/config', '././.git/config', './.git']) {
      const meta = {
        ...m,
        version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
        createdAt: Date.now(),
        dirty: { tracked: 0, untracked: 0, deleted: [bad] },
      };
      await expect(
        restoreWorktreeSnapshot(snapshotPath, restored, meta),
      ).rejects.toThrow(/protected/);
    }
    // The worktree's .git link survives (no deletion detached the checkout).
    await expect(
      fs.access(path.join(restored, '.git')),
    ).resolves.toBeUndefined();
  });

  it('refuses capture when an index flag hides a second file version (P1)', async () => {
    // Stage a draft, set assume-unchanged, then edit again: status hides the
    // worktree column, so the tar + header cannot represent the staged draft.
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'staged-draft\n');
    git(worktree, 'add', 'committed.txt');
    git(worktree, 'update-index', '--assume-unchanged', 'committed.txt');
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'later-edit\n');
    await expect(
      buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-hiddenver',
        slug: 'hiddenver',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      }),
    ).rejects.toThrow(/index flag hides/);
  });

  it('refuses archive-clearing that resolves outside the root via a symlink (R4-2)', async () => {
    // link -> outside (which holds a directory x). The session replaces link
    // with a real directory containing a FILE x; the archive carries link/x as
    // a File. The conflict-clearing loop lstat follows the intermediate symlink
    // and sees outside/x as a directory — it must refuse, not rm outside/x.
    const outside = path.join(root, 'outside-conflict');
    await fs.mkdir(path.join(outside, 'x'), { recursive: true });
    await fs.writeFile(path.join(outside, 'x', 'inner.txt'), 'OUTSIDE\n');
    await fs.symlink(outside, path.join(worktree, 'link'));
    git(worktree, 'add', 'link');
    git(worktree, 'commit', '-qm', 'link', '--no-verify');
    await fs.rm(path.join(worktree, 'link'));
    await fs.mkdir(path.join(worktree, 'link'));
    await fs.writeFile(path.join(worktree, 'link', 'x'), 'SESSION\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-conflict',
      slug: 'conflict',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = path.join(root, 'restored-conflict');
    git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
    const fullMeta = {
      ...m,
      version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };
    await expect(
      restoreWorktreeSnapshot(snapshotPath, restored, fullMeta),
    ).rejects.toThrow(/via symlink/);
    await expect(
      fs.readFile(path.join(outside, 'x', 'inner.txt'), 'utf8'),
    ).resolves.toBe('OUTSIDE\n');
  });

  it.skipIf(process.platform === 'win32')(
    'creates snapshot files owner-only regardless of umask (P2)',
    async () => {
      await fs.writeFile(path.join(worktree, 'secret.txt'), 'private\n');
      await fs.chmod(path.join(worktree, 'secret.txt'), 0o600);
      const m = await buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-perms',
        slug: 'perms',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      });
      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: m,
      });
      expect((await fs.stat(snapshotPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(metaPath)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'the archive is owner-only before the first byte is written (R5-1)',
    async () => {
      await fs.writeFile(path.join(worktree, 'secret.txt'), 'private\n');
      tarCreateEntryModes.length = 0;
      const m = await buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-precreate',
        slug: 'precreate',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      });
      await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: m,
      });
      // The temp archive must already exist at 0600 when tar opens it; a
      // chmod only after the write would record -1 (or a umask-derived mode)
      // here while still ending at 0600.
      expect(tarCreateEntryModes.length).toBeGreaterThan(0);
      expect(tarCreateEntryModes.every((mode) => mode === 0o600)).toBe(true);
    },
  );

  it('archives ignored content the gate counts as work under a contents-matching rule (R6-1)', async () => {
    // `packages/app/node_modules/**` ignores the CONTENTS: the gate's
    // status --ignored=matching collapses at .../node_modules/x/ (last
    // segment 'x' is not disposable → work), while ls-files --directory
    // would collapse at .../node_modules/ (disposable → excluded). The
    // capture must use the gate's own geometry or it drops the very content
    // that made the gate say "work", and the checkout is then deleted.
    await fs.writeFile(
      path.join(worktree, '.gitignore'),
      'packages/app/node_modules/**\n',
    );
    git(worktree, 'add', '.gitignore');
    git(worktree, 'commit', '-qm', 'ignore contents', '--no-verify');
    await fs.mkdir(
      path.join(worktree, 'packages', 'app', 'node_modules', 'x'),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(worktree, 'packages', 'app', 'node_modules', 'x', 'y.js'),
      '// work\n',
    );
    await expect(worktreeHasWork(worktree)).resolves.toBe(true);
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-r61',
      slug: 'r61',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-r61',
    );
    await expect(
      fs.readFile(
        path.join(restored, 'packages', 'app', 'node_modules', 'x', 'y.js'),
        'utf8',
      ),
    ).resolves.toBe('// work\n');
  });

  it('refuses case-variant protected deletion paths (round-6 containment)', async () => {
    // On APFS/NTFS '.GIT/config' aliases '.git/config'; the reader and the
    // restore confine must refuse it case-insensitively so a restore cannot
    // remove the git link through a case variant.
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-case',
      slug: 'case',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const full = {
      ...m,
      version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
      createdAt: Date.now(),
      dirty: { tracked: 0, untracked: 0, deleted: ['.GIT/config'] },
    };
    await fs.writeFile(metaPath, `${JSON.stringify(full, null, 2)}\n`);
    await expect(readWorktreeSnapshotMeta(metaPath)).rejects.toThrow();
    const restored = path.join(root, 'restored-case');
    git(worktree, 'worktree', 'add', '--detach', restored, 'HEAD');
    await expect(
      restoreWorktreeSnapshot(snapshotPath, restored, full),
    ).rejects.toThrow(/protected/);
  });

  it('never records a protected rename source in the header (round-6 witness)', async () => {
    // A tracked marker renamed away: the source is a deletion, but recording
    // it would make the reader refuse the whole header (protected path).
    await fs.writeFile(path.join(worktree, WORKTREE_SESSION_FILE), 'marker\n');
    git(worktree, 'add', WORKTREE_SESSION_FILE);
    git(worktree, 'commit', '-qm', 'track marker', '--no-verify');
    git(worktree, 'mv', WORKTREE_SESSION_FILE, 'renamed-marker');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-rensrc',
      slug: 'rensrc',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).not.toContain(WORKTREE_SESSION_FILE);
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    await expect(readWorktreeSnapshotMeta(metaPath)).resolves.toBeTruthy();
  });

  it('never records a protected case-variant deletion in the header (round-7)', async () => {
    // A tracked case-variant of the marker, deleted: the reader refuses
    // protected deletions case-insensitively, so the writer must apply the
    // same policy or it produces a header its own reader rejects.
    await fs.writeFile(
      path.join(worktree, '.QWEN-SESSION'),
      'tracked-marker\n',
    );
    git(worktree, 'add', '.QWEN-SESSION');
    git(worktree, 'commit', '-qm', 'track marker variant', '--no-verify');
    await fs.rm(path.join(worktree, '.QWEN-SESSION'));
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-variant',
      slug: 'variant',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).not.toContain('.QWEN-SESSION');
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    await expect(readWorktreeSnapshotMeta(metaPath)).resolves.toBeTruthy();
  });

  it('gives the hidden-index ls-files probe a 64 MiB capture buffer (R8-8)', async () => {
    lsFilesProbeBuffers.length = 0;
    await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-buffer',
      slug: 'buffer',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(lsFilesProbeBuffers).toEqual([64 * 1024 * 1024]);
  });

  it('refuses a staged edit hidden on a skip-worktree path (P1 sparse cone)', async () => {
    await fs.mkdir(path.join(worktree, 'one'));
    await fs.mkdir(path.join(worktree, 'two'));
    await fs.writeFile(path.join(worktree, 'one', 'note'), 'original\n');
    await fs.writeFile(path.join(worktree, 'two', 'b.txt'), 'two\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'span', '--no-verify');
    await fs.writeFile(path.join(worktree, 'one', 'note'), 'staged design\n');
    git(worktree, 'add', 'one/note');
    git(worktree, 'sparse-checkout', 'init', '--cone');
    git(worktree, 'sparse-checkout', 'set', 'two');
    // The sparse worktree never materialized the edit: Y=' ' cannot prove
    // the index matches the disk, so the capture must refuse (P1).
    expect(git(worktree, 'status', '--porcelain')).toContain('M  one/note');
    await expect(
      buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-sparse',
        slug: 'sparse',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      }),
    ).rejects.toThrow(/skip-worktree/);
    // A clean sparse worktree with nothing staged stays collectible.
    git(worktree, 'reset', '--hard', 'HEAD');
    git(worktree, 'clean', '-fdx');
    await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: {
        sessionId: 'session-sparse-clean',
        slug: 'sparse-clean',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
        headCommit: git(worktree, 'rev-parse', 'HEAD'),
        branch: 'main',
        dirty: { tracked: 0, untracked: 0, deleted: [] },
      },
    });
  });

  it('refuses a staged addition hidden on a skip-worktree path (R8-3)', async () => {
    await fs.mkdir(path.join(worktree, 'two'));
    await fs.writeFile(path.join(worktree, 'two', 'b.txt'), 'two\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'span', '--no-verify');
    git(worktree, 'sparse-checkout', 'init', '--cone');
    git(worktree, 'sparse-checkout', 'set', 'two');
    await fs.mkdir(path.join(worktree, 'one'));
    await fs.writeFile(path.join(worktree, 'one', 'new.txt'), 'outside cone\n');
    git(worktree, 'add', '--sparse', 'one/new.txt');
    git(worktree, 'sparse-checkout', 'reapply');
    expect(git(worktree, 'status', '--porcelain')).toContain('A  one/new.txt');
    await expect(
      buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-sparse-add',
        slug: 'sparse-add',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      }),
    ).rejects.toThrow(/skip-worktree/);
    // Removing the staged addition must preserve the clean-sparse carve-out:
    // the same skip-worktree set is not itself a reason to refuse collection.
    git(worktree, 'reset', '--hard', 'HEAD');
    await expect(
      buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-sparse-add-clean',
        slug: 'sparse-add-clean',
        baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      }),
    ).resolves.toMatchObject({ dirty: { tracked: 0, untracked: 0 } });
  });

  it.skipIf(process.platform === 'win32')(
    'preserves absolute and parent-relative symlink targets on restore (R8-5)',
    async () => {
      const absoluteTarget = path.join(root, 'absolute-target');
      await fs.writeFile(absoluteTarget, 'outside\n');
      await fs.symlink(absoluteTarget, path.join(worktree, 'absolute-link'));
      await fs.symlink(
        '../relative-target',
        path.join(worktree, 'parent-link'),
      );
      const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: {
          ...meta(),
          dirty: { tracked: 0, untracked: 2, deleted: [] },
        },
      });
      const restored = await restoreOverHead(
        snapshotPath,
        metaPath,
        'restored-link-targets',
      );
      for (const [name, target] of [
        ['absolute-link', absoluteTarget],
        ['parent-link', '../relative-target'],
      ] as const) {
        const link = path.join(restored, name);
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(link)).toBe(target);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
    'refuses to archive a case-variant protected path (R8-7)',
    async () => {
      await fs.writeFile(path.join(worktree, '.GIT'), 'real user content\n');
      await expect(
        captureWorktreeSnapshot({
          worktreePath: worktree,
          snapshotDir,
          meta: {
            ...meta(),
            dirty: { tracked: 0, untracked: 1, deleted: [] },
          },
        }),
      ).rejects.toThrow(/case-variant protected path/);
      await expect(
        fs.readFile(path.join(worktree, '.GIT'), 'utf8'),
      ).resolves.toBe('real user content\n');
    },
  );

  it('keeps both archives when a session UUID is reused (P1 collision)', async () => {
    await fs.writeFile(path.join(worktree, 'first.txt'), 'first\n');
    const m1 = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-reused',
      slug: 'reused',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m1,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await fs.writeFile(path.join(worktree, 'second.txt'), 'second\n');
    const m2 = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-reused',
      slug: 'reused',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m2,
    });
    const archives = (await fs.readdir(snapshotDir)).filter(
      (n) => n.startsWith('session-reused.') && n.endsWith('.tar.gz'),
    );
    // Never overwrite an earlier archive pair of the same sessionId.
    expect(archives.length).toBe(2);
    const firstContents: string[] = [];
    for (const name of archives) {
      const restored = await restoreOverHead(
        path.join(snapshotDir, name),
        path.join(snapshotDir, name.replace(/\.tar\.gz$/, '.json')),
        name.replace(/\.tar\.gz$/, ''),
      );
      firstContents.push(...(await fs.readdir(restored)));
    }
    expect(firstContents).toContain('first.txt');
    expect(firstContents).toContain('second.txt');
  });

  it('does not let a Y=R bare source inject disposable exclusions (audit capture)', async () => {
    await fs.mkdir(path.join(worktree, '!! node_modules'));
    await fs.mkdir(path.join(worktree, 'node_modules'));
    await fs.writeFile(
      path.join(worktree, '!! node_modules', 'source.txt'),
      'rename-me\n',
    );
    await fs.writeFile(
      path.join(worktree, 'node_modules', 'source.txt'),
      'base\n',
    );
    git(
      worktree,
      'add',
      '--',
      '!! node_modules/source.txt',
      'node_modules/source.txt',
    );
    git(worktree, 'commit', '-qm', 'rename sources', '--no-verify');
    await fs.writeFile(
      path.join(worktree, 'node_modules', 'source.txt'),
      'edited\n',
    );
    await fs.rename(
      path.join(worktree, '!! node_modules', 'source.txt'),
      path.join(worktree, 'renamed.txt'),
    );
    git(worktree, 'add', '-N', 'renamed.txt');
    expect(
      execFileSync('git', ['status', '--porcelain', '-z'], {
        cwd: worktree,
        encoding: 'utf8',
        env: gitEnv,
      }),
    ).toContain(' R renamed.txt\0!! node_modules/source.txt\0');
    const snapshotMeta = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-source-injection',
      slug: 'source-injection',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: snapshotMeta,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-source-injection',
    );
    await expect(
      fs.readFile(path.join(restored, 'node_modules', 'source.txt'), 'utf8'),
    ).resolves.toBe('edited\n');
    await expect(
      fs.readFile(path.join(restored, 'renamed.txt'), 'utf8'),
    ).resolves.toBe('rename-me\n');
  });

  it('records a worktree-side rename source so restore does not resurrect it', async () => {
    // `mv` + `git add -N` yields Y='R' with a source record, not X='R': the
    // parser must consume both forms or the old name is resurrected (P1).
    await fs.rename(
      path.join(worktree, 'committed.txt'),
      path.join(worktree, 'renamed.txt'),
    );
    git(worktree, 'add', '-N', 'renamed.txt');
    // Pin the worktree-side R/C arm itself; a plain D plus ?? pair would
    // exercise the ordinary deletion path instead (round-8 deferred witness).
    expect(
      execFileSync('git', ['status', '--porcelain', '-z'], {
        cwd: worktree,
        encoding: 'utf8',
        env: gitEnv,
      }),
    ).toContain(' R renamed.txt\0committed.txt\0');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-rename-wt',
      slug: 'rename-wt',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.dirty.deleted).toContain('committed.txt');
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-rename-wt',
    );
    expect(await fs.readdir(restored)).toContain('renamed.txt');
    expect(await fs.readdir(restored)).not.toContain('committed.txt');
  });

  it('refuses capture when the worktree .git is gone (F4 direct)', async () => {
    // Without its own .git, git's upward discovery would answer about the
    // enclosing repository; the capture must refuse rather than archive a
    // tree it cannot describe (the reaper then preserves the checkout).
    // Build the enclosing repository so the guard is witnessed against the
    // actual discovery hazard, not a bare directory.
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    git(root, 'commit', '-qm', 'enclosing', '--allow-empty', '--no-verify');
    await fs.rm(path.join(worktree, '.git'), { recursive: true, force: true });
    await expect(
      captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: {
          sessionId: 'session-nogit',
          slug: 'nogit',
          baseCommit: 'a'.repeat(40),
          headCommit: 'a'.repeat(40),
          branch: '',
          dirty: { tracked: 0, untracked: 0, deleted: [] },
        },
      }),
    ).rejects.toThrow();
  });

  it('records the branch actually checked out at capture (P2)', async () => {
    // A session created detached may `git switch -c` later; the header must
    // record the real branch even though the sidecar still says detached ('').
    git(worktree, 'switch', '-c', 'real-branch');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-branch',
      slug: 'branch',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(m.branch).toBe('real-branch');
  });

  // F3: the exclusion must match the gate's ignored-only geometry — a
  // tracked or non-ignored file under a regenerable directory name is work
  // and must be archived, not silently dropped.
  it('archives a tracked edit under dist/ instead of dropping it', async () => {
    await fs.mkdir(path.join(worktree, 'dist'));
    await fs.writeFile(path.join(worktree, 'dist', 'tracked.js'), 'base\n');
    git(worktree, 'add', 'dist/tracked.js');
    git(worktree, 'commit', '-qm', 'track dist', '--no-verify');
    await fs.writeFile(path.join(worktree, 'dist', 'tracked.js'), 'edited\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-dist',
      slug: 'dist',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-dist',
    );
    await expect(
      fs.readFile(path.join(restored, 'dist', 'tracked.js'), 'utf8'),
    ).resolves.toBe('edited\n');
  });

  it('archives a non-ignored untracked file under dist/', async () => {
    await fs.mkdir(path.join(worktree, 'dist'));
    await fs.writeFile(path.join(worktree, 'dist', 'work.js'), 'mine\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-dist-untracked',
      slug: 'dist-untracked',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-dist-untracked',
    );
    await expect(
      fs.readFile(path.join(restored, 'dist', 'work.js'), 'utf8'),
    ).resolves.toBe('mine\n');
  });

  it('archives ignored non-disposable work but excludes ignored disposable output', async () => {
    await fs.writeFile(
      path.join(worktree, '.gitignore'),
      'node_modules/\n*.secret\n',
    );
    await fs.mkdir(path.join(worktree, 'node_modules'), { recursive: true });
    await fs.writeFile(
      path.join(worktree, 'node_modules', 'dep.js'),
      'regenerable\n',
    );
    await fs.writeFile(path.join(worktree, 'token.secret'), 'keep-me\n');
    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-ignored',
      slug: 'ignored',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const restored = await restoreOverHead(
      snapshotPath,
      metaPath,
      'restored-ignored',
    );
    await expect(
      fs.readFile(path.join(restored, 'token.secret'), 'utf8'),
    ).resolves.toBe('keep-me\n');
    await expect(
      fs.access(path.join(restored, 'node_modules', 'dep.js')),
    ).rejects.toThrow();
  });

  // F4: a worktree whose own .git is gone must reject capture. An enclosing
  // repository is present so that, without the .git pin, git would discover
  // it and capture would proceed about the wrong repo — the refusal must come
  // from the pin itself, not from git simply failing to find any repository.
  it('rejects capture and meta build when the worktree .git is missing', async () => {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@e.com');
    git(root, 'config', 'user.name', 't');
    await fs.writeFile(path.join(root, 'enclosing.txt'), 'outer\n');
    git(root, 'add', 'enclosing.txt');
    git(root, 'commit', '-qm', 'outer', '--no-verify');
    await fs.writeFile(path.join(worktree, 'work.txt'), 'mine\n');
    await fs.rm(path.join(worktree, '.git'), { recursive: true, force: true });
    await expect(
      buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-nogit',
        slug: 'nogit',
        baseCommit: 'x',
      }),
    ).rejects.toThrow();
    await expect(
      captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir,
        meta: {
          sessionId: 'session-snap',
          slug: 'snap',
          baseCommit: 'x',
          headCommit: 'x',
          branch: 'main',
          dirty: { tracked: 0, untracked: 0, deleted: [] },
        },
      }),
    ).rejects.toThrow();
    await expect(fs.readdir(snapshotDir)).rejects.toThrow();
  });

  // F5: the meta builder must not execute a repository-configured fsmonitor
  // hook (NO_EXEC_CONFIG hardening), unlike a plain `git status`.
  it('does not execute a core.fsmonitor hook when building meta', async () => {
    const canary = path.join(root, 'PWNED');
    const helper = path.join(root, 'plant.sh');
    await fs.writeFile(helper, `#!/bin/sh\ntouch '${canary}'\nexit 1\n`);
    await fs.chmod(helper, 0o755);
    git(worktree, 'config', 'core.fsmonitor', helper);
    // Positive control: a plain status refreshes the index and runs the hook.
    git(worktree, 'status');
    await expect(fs.access(canary)).resolves.toBeUndefined();
    await fs.rm(canary, { force: true });

    await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-fsmonitor',
      slug: 'fsmonitor',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    });
    await expect(fs.access(canary)).rejects.toThrow();
  });

  it('refuses an archive member nested under the protected session marker path', async () => {
    const stage = path.join(root, 'marker-subdir-stage');
    await fs.mkdir(path.join(stage, WORKTREE_SESSION_FILE), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(stage, WORKTREE_SESSION_FILE, 'evil.txt'),
      'nope\n',
    );
    await fs.mkdir(snapshotDir, { recursive: true });
    const archivePath = path.join(snapshotDir, 'marker-subdir.tar.gz');
    await tar.create({ gzip: true, cwd: stage, file: archivePath }, [
      `${WORKTREE_SESSION_FILE}/evil.txt`,
    ]);
    const meta: WorktreeSnapshotMeta = {
      version: 1,
      createdAt: Date.now(),
      sessionId: 'session-marker-subdir',
      slug: 'marker-subdir',
      baseCommit: git(worktree, 'rev-parse', 'HEAD'),
      headCommit: git(worktree, 'rev-parse', 'HEAD'),
      branch: '',
      dirty: { tracked: 0, untracked: 1, deleted: [] },
    };

    await expect(
      restoreWorktreeSnapshot(archivePath, worktree, meta),
    ).rejects.toThrow(/protected/i);
    await expect(
      fs.lstat(path.join(worktree, WORKTREE_SESSION_FILE)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses tar Link entries targeting committed relative symlinks or non-archived files', async () => {
    await fs.mkdir(path.join(worktree, 'a', 'b', 'c'), { recursive: true });
    await fs.symlink('../../..', path.join(worktree, 'a', 'b', 'c', 'rel'));
    await fs.mkdir(path.join(worktree, 'sub'), { recursive: true });
    await fs.symlink('.', path.join(worktree, 'sub', 'self'));
    git(worktree, 'add', 'a/b/c/rel', 'sub/self');
    git(worktree, 'commit', '-qm', 'add relative symlinks', '--no-verify');

    const head = git(worktree, 'rev-parse', 'HEAD');
    const meta: WorktreeSnapshotMeta = {
      version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
      createdAt: Date.now(),
      sessionId: 'session-hardlink-symlink-escape',
      slug: 'hardlink-symlink-escape',
      baseCommit: head,
      headCommit: head,
      branch: '',
      dirty: { tracked: 0, untracked: 2, deleted: [] },
    };

    const escapeTar = path.join(root, 'hardlink-escape-rel.tar');
    await fs.writeFile(
      escapeTar,
      Buffer.concat([
        ...rawTarMember('escape', '1', 'a/b/c/rel'),
        ...rawTarMember('escape/pwned.txt', '0', '', Buffer.from('OWNED\n')),
        Buffer.alloc(1024),
      ]),
    );
    await expect(
      restoreWorktreeSnapshot(escapeTar, worktree, meta),
    ).rejects.toThrow(/not an archived regular file/i);
    await expect(
      fs.lstat(path.join(path.dirname(worktree), 'pwned.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const gitOverwriteTar = path.join(root, 'hardlink-overwrite-git.tar');
    await fs.writeFile(
      gitOverwriteTar,
      Buffer.concat([
        ...rawTarMember('escape', '1', 'sub/self'),
        ...rawTarMember(
          `escape/${WORKTREE_SESSION_FILE}`,
          '0',
          '',
          Buffer.from('hijacked-session\n'),
        ),
        Buffer.alloc(1024),
      ]),
    );
    await expect(
      restoreWorktreeSnapshot(gitOverwriteTar, worktree, meta),
    ).rejects.toThrow(/not an archived regular file/i);
    await expect(
      fs.lstat(path.join(worktree, WORKTREE_SESSION_FILE)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(path.join(worktree, '.git'))).isDirectory()).toBe(
      true,
    );
  });

  it('refuses archive members containing internal dot segments', async () => {
    const head = git(worktree, 'rev-parse', 'HEAD');
    const meta: WorktreeSnapshotMeta = {
      version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
      createdAt: Date.now(),
      sessionId: 'session-dot-segment',
      slug: 'dot-segment',
      baseCommit: head,
      headCommit: head,
      branch: '',
      dirty: { tracked: 0, untracked: 1, deleted: [] },
    };
    const dotTar = path.join(root, 'internal-dot.tar');
    await fs.writeFile(
      dotTar,
      Buffer.concat([
        ...rawTarMember('sub/file.txt', '0', '', Buffer.from('first\n')),
        ...rawTarMember('sub/./file.txt', '0', '', Buffer.from('second\n')),
        Buffer.alloc(1024),
      ]),
    );
    await expect(
      restoreWorktreeSnapshot(dotTar, worktree, meta),
    ).rejects.toThrow(/Unsafe path/i);
  });

  it('rejects invalid or empty baseCommit before writing any snapshot files', async () => {
    await expect(
      buildWorktreeSnapshotMeta(worktree, {
        sessionId: 'session-empty-base',
        slug: 'empty-base',
        baseCommit: '',
      }),
    ).rejects.toThrow(/invalid baseCommit/i);

    const head = git(worktree, 'rev-parse', 'HEAD');
    const emptySnapDir = path.join(root, 'empty-commit-snaps');
    await expect(
      captureWorktreeSnapshot({
        worktreePath: worktree,
        snapshotDir: emptySnapDir,
        meta: {
          sessionId: 'session-empty-base',
          slug: 'empty-base',
          baseCommit: '',
          headCommit: head,
          branch: '',
          dirty: { tracked: 0, untracked: 0, deleted: [] },
        },
      }),
    ).rejects.toThrow(/invalid commit id/i);
    await expect(fs.lstat(emptySnapDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
