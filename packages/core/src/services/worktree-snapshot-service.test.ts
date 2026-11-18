/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  captureWorktreeSnapshot,
  readWorktreeSnapshotMeta,
  restoreWorktreeSnapshot,
  buildWorktreeSnapshotMeta,
  WORKTREE_SNAPSHOT_SCHEMA_VERSION,
} from './worktree-snapshot-service.js';
import { WORKTREE_SESSION_FILE } from './gitWorktreeService.js';

// R5-1: record the output file's mode at the moment node-tar is invoked. A
// post-write chmod ends at the same 0600 mode (the P2 cell below) but leaves
// the archive world-readable for the whole capture; only a pre-created 0600
// temp file is private from the first byte. -1 means the file did not exist
// when tar was called (node-tar would create it at 0666 & ~umask).
const tarCreateEntryModes = vi.hoisted(() => [] as number[]);
vi.mock('tar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tar')>();
  const { statSync } = await import('node:fs');
  // The service only ever calls create(options-with-file, entries); narrow
  // the overloaded command to that shape for the delegating call.
  const createFile = actual.create as (
    options: { file: string },
    entries: string[],
  ) => Promise<void>;
  const create = Object.assign(
    (options: { file: string }, entries: string[]) => {
      try {
        tarCreateEntryModes.push(statSync(options.file).mode & 0o777);
      } catch {
        tarCreateEntryModes.push(-1);
      }
      return createFile(options, entries);
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

  it('rejects a capture from a worktree path that does not exist', async () => {
    await expect(
      captureWorktreeSnapshot({
        worktreePath: path.join(root, 'missing'),
        snapshotDir,
        meta: meta(),
      }),
    ).rejects.toThrow();
    // A failed capture must not leave a final archive behind.
    await expect(
      fs.access(
        path.join(snapshotDir, 'session-snap.worktree-snapshot.tar.gz'),
      ),
    ).rejects.toThrow();
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
    await fs.mkdir(path.join(worktree, 'committed.txt'));
    await fs.writeFile(
      path.join(worktree, 'committed.txt', 'inner.txt'),
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
      fs.readFile(path.join(restored, 'committed.txt', 'inner.txt'), 'utf8'),
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
    await expect(
      fs.access(
        path.join(snapshotDir, 'session-snap.worktree-snapshot.tar.gz'),
      ),
    ).rejects.toThrow();
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
});
