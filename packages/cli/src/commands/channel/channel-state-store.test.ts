import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalizeWorkspacePath } from '@qwen-code/channel-base';
import { hashDaemonWorkspace } from '@qwen-code/qwen-code-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unique per-run home (a fixed shared path interleaves concurrent runs of
// this file on one host); created lazily because the mock factory is hoisted
// above any module-body initialization.
let stateHome: string | undefined;
const testDirs: string[] = [];

function getStateHome(): string {
  if (!stateHome) {
    stateHome = mkdtempSync(join(tmpdir(), 'qwen-state-home-'));
    testDirs.push(stateHome);
  }
  return stateHome;
}

// Delegates to the real implementation by default; individual tests can
// simulate a mid-write failure (ENOSPC and friends) that a read-side
// obstacle cannot reach.
const mockAtomicWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  mockAtomicWriteFileSync.mockImplementation(actual.atomicWriteFileSync);
  return {
    ...actual,
    Storage: {
      getGlobalQwenDir: () => getStateHome(),
    },
    atomicWriteFileSync: mockAtomicWriteFileSync,
  };
});

import {
  adoptLegacyChannelState,
  ChannelStateStore,
  channelRuntimeStatePath,
  selectActiveChannels,
} from './channel-state-store.js';

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  stateHome = undefined;
});

describe('channelRuntimeStatePath', () => {
  it('falls back to the legacy global file without a workspace', () => {
    expect(channelRuntimeStatePath()).toBe(
      join(getStateHome(), 'channels', 'channel-state.json'),
    );
  });

  it('scopes the state file per workspace (#8975)', () => {
    // Derive the expected hash exactly like production — canonicalize,
    // then hash. A literal POSIX string hash diverges on Windows, where
    // canonicalizeWorkspacePath resolves to a drive/backslash spelling
    // (different sha256 input), failing the merge-queue Windows job
    // deterministically (R10-39).
    expect(channelRuntimeStatePath('/workspace/a')).toBe(
      join(
        getStateHome(),
        'channels',
        'standalone',
        hashDaemonWorkspace(canonicalizeWorkspacePath('/workspace/a')),
        'channel-state.json',
      ),
    );
    // Different workspaces get different files; the same workspace is stable.
    expect(channelRuntimeStatePath('/workspace/a')).toBe(
      channelRuntimeStatePath('/workspace/a'),
    );
    expect(channelRuntimeStatePath('/workspace/a')).not.toBe(
      channelRuntimeStatePath('/workspace/b'),
    );
  });

  it('collapses spelling variants of a nonexistent directory before hashing (R9-2)', () => {
    // Resolve-level spellings: trailing separators, dot segments and
    // redundant separators must canonicalize identically, matching the
    // daemon-side identity contract (daemon-worker canonicalizes the
    // workspace before deriving its state path). A raw-string hash would
    // silently lose recorded stops when the user re-enters the same
    // directory under another spelling (#8975).
    expect(channelRuntimeStatePath('/workspace/a/')).toBe(
      channelRuntimeStatePath('/workspace/a'),
    );
    expect(channelRuntimeStatePath('/workspace/./a')).toBe(
      channelRuntimeStatePath('/workspace/a'),
    );
    expect(channelRuntimeStatePath('/workspace/b/../a')).toBe(
      channelRuntimeStatePath('/workspace/a'),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'collapses symlinked spellings of the same directory (R9-2)',
    () => {
      // realpath-level spellings: a symlinked entry and its target are
      // one workspace (the macOS /tmp vs /private/tmp shape). win32 skip:
      // dir symlinks need elevated rights there (repo convention: skipIf).
      const root = mkdtempSync(join(tmpdir(), 'qwen-canonical-'));
      testDirs.push(root);
      const realDir = join(root, 'real');
      const linkDir = join(root, 'link');
      mkdirSync(realDir);
      symlinkSync(realDir, linkDir, 'dir');

      expect(channelRuntimeStatePath(linkDir)).toBe(
        channelRuntimeStatePath(realDir),
      );
    },
  );
});

describe('adoptLegacyChannelState (#8975)', () => {
  const workspace = '/workspace/legacy';
  let legacyPath: string;
  let workspacePath: string;
  let channelsDir: string;

  beforeEach(() => {
    legacyPath = channelRuntimeStatePath();
    workspacePath = channelRuntimeStatePath(workspace);
    channelsDir = join(getStateHome(), 'channels');
    rmSync(channelsDir, { recursive: true, force: true });
    mkdirSync(channelsDir, { recursive: true });
  });

  it('seeds the workspace file from the legacy global file and keeps it for later workspaces', () => {
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(channelRuntimeStatePath(), legacyBody, 'utf-8');

    adoptLegacyChannelState(workspace);

    // The seed records the adopted legacy map as its snapshot: a later
    // start diffs the legacy file against it and merges only the entries
    // that changed since, so post-adoption legacy stops are honored
    // without the stale adopted ones ever overriding an explicit restart
    // (R9-3). The legacy mtime watermark beside it lets a later sync see
    // a byte-identical re-stop rewrite (R10-5).
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyMtime: expect.any(Number),
    });
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
    // The legacy file carries no workspace attribution: deleting it after
    // the first adoption would silently lose the recorded stops of every
    // later-starting workspace and resurrect the channels they explicitly
    // stopped (#8975).
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('does not warn on a clean adoption (R9-10)', () => {
    // One-sided warning pin: the adoption failure warning is asserted on
    // the ENOTDIR failure path; a clean adoption must NOT fire it — a
    // false alarm on every clean startup about the exact resurrection
    // #8975 settles.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      adoptLegacyChannelState(workspace);
      expect(writeSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('could not adopt legacy channel state'),
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('lets every later-starting workspace adopt the same legacy stops (#8975)', () => {
    // Multi-workspace upgrade: stops from every workspace landed in the
    // single global file under older releases. The first workspace to
    // start must not consume the shared record — a workspace adopting it
    // later still has to see its stops, or its explicitly stopped
    // channels resurrect on the next `--channel all` (#8975).
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped', feishu: 'stopped' },
    });
    writeFileSync(legacyPath, legacyBody, 'utf-8');

    adoptLegacyChannelState(workspace);
    adoptLegacyChannelState('/workspace/other');

    expect(
      new ChannelStateStore(
        channelRuntimeStatePath('/workspace/other'),
      ).readAll(),
    ).toEqual({ telegram: 'stopped', feishu: 'stopped' });
    expect(existsSync(legacyPath)).toBe(true);
  });

  // POSIX permission bits never surface on Windows (statSync().mode does
  // not carry them and mkdirSync's mode is a no-op), so the mode pins live
  // in their own win32-skipped test — the merge queue's Windows job runs
  // this file and must not fail on them (repo convention: skipIf, e.g.
  // atomicFileWrite.test.ts).
  it.skipIf(process.platform === 'win32')(
    'adopts the legacy file with restrictive permissions (#8975)',
    () => {
      const legacyBody = JSON.stringify({
        version: 1,
        channels: { telegram: 'stopped' },
      });
      writeFileSync(channelRuntimeStatePath(), legacyBody, 'utf-8');

      adoptLegacyChannelState(workspace);

      // Pin the deliberate restrictive permissions on the adopted file and
      // its directory: the legacy file was written by an older release at
      // default umask, and adoption exists to normalize it (#8975).
      expect(statSync(workspacePath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(workspacePath)).mode & 0o777).toBe(0o700);
      // Adoption creates the intermediate `standalone` dir AND the leaf
      // hash dir via the recursive mkdirSync: BOTH must land restrictive,
      // not just the leaf — a split mkdir applying the mode only to the
      // leaf would leave ~/.qwen/channels/standalone/ world-enumerable
      // (every workspace hash directory) with the pins above green
      // (R9-9).
      expect(statSync(dirname(dirname(workspacePath))).mode & 0o777).toBe(
        0o700,
      );
    },
  );

  it('baselines a snapshot-less workspace file without merging the already-adopted legacy map (R9-3)', () => {
    // A workspace file with no adoptedLegacy snapshot predates snapshot
    // recording (or was created directly by a stop). Its legacy entries
    // cannot be diffed against the snapshot, so they are baselined, NOT
    // merged: merging would re-apply the already-adopted (possibly stale)
    // legacy stops over explicit restarts recorded since (R9-3).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { feishu: 'stopped' } }),
      'utf-8',
    );
    mkdirSync(dirname(workspacePath), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { feishu: 'stopped' },
      adoptedLegacyMtime: expect.any(Number),
    });
    expect(existsSync(legacyPath)).toBe(true);

    // From the baseline onward, entries that CHANGE in the legacy file
    // are merged on the next start.
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        channels: { feishu: 'stopped', slack: 'stopped' },
      }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
      slack: 'stopped',
    });
  });

  it('merges stops written to the legacy file AFTER the workspace file existed (R9-3)', () => {
    // Mixed-version machine sharing ~/.qwen: the new-release start creates
    // the workspace file; an older-release service later runs (downgrade /
    // parallel install) producing an old-format pidfile; the next `qwen
    // channel stop` writes `stopped` to the legacy global file (stop.ts
    // legacy fallback). The one-shot existsSync guard used to drop that
    // stop silently, resurrecting the explicitly stopped channel on the
    // next `--channel all` (R9-3).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { slack: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded in the workspace file after adoption.
    new ChannelStateStore(workspacePath).set('slack', 'active');
    // A later no-workspace stop records a NEW channel to the legacy file.
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        channels: { slack: 'stopped', telegram: 'stopped' },
      }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    // The post-adoption telegram stop is merged; the already-adopted
    // slack stop is NOT re-applied over the explicit restart — the
    // legacy file is kept forever, so a blind re-merge would keep
    // stopping channels the user restarted (R9-3).
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      slack: 'active',
      telegram: 'stopped',
    });
  });

  it('does not rewrite an unchanged workspace file on every start (R9-3)', () => {
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    const beforeInode = statSync(workspacePath).ino;

    adoptLegacyChannelState(workspace);

    // Nothing changed in the legacy file: no fsync'd rewrite of an
    // unchanged file on the startup critical path. Byte equality cannot
    // observe a rewrite (the serialization is deterministic), so pin the
    // inode — atomicWriteFileSync replaces via temp+rename.
    expect(statSync(workspacePath).ino).toBe(beforeInode);
  });

  it('does nothing when no legacy file exists', () => {
    adoptLegacyChannelState(workspace);
    expect(existsSync(workspacePath)).toBe(false);
  });

  it('does not throw and keeps the legacy file when the target is blocked', () => {
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(legacyPath, legacyBody, 'utf-8');
    // Block the target: make an intermediate path component (the
    // `standalone` dir) a regular file, so mkdirSync throws ENOTDIR.
    writeFileSync(dirname(dirname(workspacePath)), '', 'utf-8');
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      expect(() => adoptLegacyChannelState(workspace)).not.toThrow();
      // A failed adoption must leave a diagnostic trail: adoption runs on
      // every start and will retry once the obstacle clears, but the stops
      // stay unadopted until then — a resurrection of them in the meantime
      // must be traceable (#8975). (Asserted before mockRestore: vitest's
      // restore clears the recorded calls.)
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not adopt legacy channel state'),
      );
    } finally {
      writeSpy.mockRestore();
    }

    expect(existsSync(workspacePath)).toBe(false);
    expect(readFileSync(legacyPath, 'utf-8')).toBe(legacyBody);
  });

  it('leaves no target behind when the legacy read fails, so the next start retries', () => {
    // A legacy "file" that is really a directory makes readFileSync throw
    // (EISDIR) before the atomic write is reached; the read failure must
    // leave no target behind — adoption runs on EVERY start, so the next
    // start simply retries the sync (a leftover target would be reseeded
    // anyway, but its absence keeps the failure observable).
    mkdirSync(legacyPath, { recursive: true });
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      expect(() => adoptLegacyChannelState(workspace)).not.toThrow();

      expect(existsSync(workspacePath)).toBe(false);
      expect(existsSync(legacyPath)).toBe(true);
      // A legacy read failure aborts the sync with the stops unadopted;
      // the warning is the only trace a later resurrection has (R10-18).
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not read legacy channel state file'),
      );
    } finally {
      writeSpy.mockRestore();
    }

    // Once the condition clears, adoption proceeds normally.
    rmSync(legacyPath, { recursive: true, force: true });
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(legacyPath, legacyBody, 'utf-8');
    adoptLegacyChannelState(workspace);
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyMtime: expect.any(Number),
    });
    // Kept for later-starting workspaces (#8975).
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('leaves no target behind when the atomic write fails mid-copy (#8975)', () => {
    // Simulate the disk failure at the WRITE stage (ENOSPC mid-copy),
    // which a read-side obstacle cannot reach: the legacy file reads fine,
    // then the atomic write itself fails. A non-atomic replacement that
    // creates/truncates the target directly would leave a partial file
    // behind — adoption runs on every start and would reseed it, but the
    // temp+rename atomic write is what guarantees no partial target ever
    // appears, keeping this failure mode observable and retryable.
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(legacyPath, legacyBody, 'utf-8');
    const writeError = new Error('ENOSPC') as NodeJS.ErrnoException;
    writeError.code = 'ENOSPC';
    mockAtomicWriteFileSync.mockImplementationOnce(() => {
      throw writeError;
    });

    expect(() => adoptLegacyChannelState(workspace)).not.toThrow();

    expect(existsSync(workspacePath)).toBe(false);
    expect(readFileSync(legacyPath, 'utf-8')).toBe(legacyBody);

    // Once the disk recovers, the retry adopts the legacy stops.
    adoptLegacyChannelState(workspace);
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyMtime: expect.any(Number),
    });
    // Kept for later-starting workspaces (#8975).
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('reseeds a corrupt workspace file from the legacy map (R9-3)', () => {
    // A corrupt target is treated as empty by the store's design
    // contract; adoption then reseeds it from the whole legacy map and
    // records a fresh snapshot, restoring both the records and the
    // diff baseline in one atomic write.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    mkdirSync(dirname(workspacePath), { recursive: true });
    writeFileSync(workspacePath, '{not json', 'utf-8');
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      adoptLegacyChannelState(workspace);

      // The reseed makes the file valid forever after — no later
      // read/prune can warn about the discarded records, so the discard
      // itself must leave a trace (R10-8).
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not read channel state file'),
      );
    } finally {
      writeSpy.mockRestore();
    }
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyMtime: expect.any(Number),
    });
  });

  it('skips the sync on a transient target read failure instead of reseeding (#8975)', () => {
    // The target-read twin of the store's fail-closed read contract: a
    // readFileSync failure on the EXISTING workspace file (EISDIR here;
    // realistically EBUSY/EPERM/EIO) means its content is UNKNOWN, not
    // corrupt — reseeding from the legacy map would rebuild it from an
    // empty view and permanently destroy this workspace's recorded stops
    // and adoption snapshot. Abort this sync with a trace; adoption runs
    // on every start, so the next one retries (R11-v7).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    mkdirSync(dirname(workspacePath), { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    // The mock's call history spans the whole file; isolate this test.
    mockAtomicWriteFileSync.mockClear();

    try {
      expect(() => adoptLegacyChannelState(workspace)).not.toThrow();

      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('legacy adoption skipped for this start'),
      );
    } finally {
      writeSpy.mockRestore();
    }
    // No write was attempted: the obstacle stands untouched (pin via the
    // mock, since the directory survives an atomic-write failure too).
    expect(mockAtomicWriteFileSync).not.toHaveBeenCalled();

    // Once the condition clears, adoption proceeds normally.
    rmSync(workspacePath, { recursive: true, force: true });
    adoptLegacyChannelState(workspace);
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyMtime: expect.any(Number),
    });
  });

  it('warns when the legacy file reads but no longer parses (R10-24)', () => {
    // A legacy file that readFileSync reads successfully but parses to
    // undefined is coerced to an empty map: the stops it carried are
    // silently lost unless the sync warns like every other discard path.
    writeFileSync(legacyPath, '{not json', 'utf-8');
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      expect(() => adoptLegacyChannelState(workspace)).not.toThrow();

      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not parse legacy channel state file'),
      );
      // Still seeds (empty) and records the snapshot, so the sync after
      // the file is repaired merges the restored stops normally.
      expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
        version: 1,
        channels: {},
        adoptedLegacy: {},
        adoptedLegacyMtime: expect.any(Number),
      });
    } finally {
      writeSpy.mockRestore();
    }

    // Repair: the restored stops are merged on the next start.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('never propagates entries that disappeared from the legacy file (R10-17)', () => {
    // The legacy file carries no workspace attribution: a rewrite with
    // FEWER entries (or a truncation to unparseable — the ENOSPC shape
    // this suite simulates elsewhere) must not destroy this workspace's
    // adopted records, or every explicitly stopped channel resurrects
    // on the next `--channel all`.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);

    // The legacy map shrinks to empty.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: {} }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });

    // The legacy file truncates to unparseable (the ENOSPC shape).
    writeFileSync(legacyPath, '{', 'utf-8');
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      adoptLegacyChannelState(workspace);
    } finally {
      writeSpy.mockRestore();
    }
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('honors a byte-identical legacy re-stop the content diff cannot see (R10-5)', () => {
    // The no-workspace stop fallback echoes the WHOLE stored map on
    // every stop, so re-stopping an already-stopped channel rewrites
    // the SAME bytes: the snapshot matches, the content diff drops the
    // re-stop and the explicitly stopped channel resurrects. The moved
    // mtime beside unchanged content is the rewrite signal (#8975).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // The older release re-stops: same bytes, new mtime. utimesSync
    // advances the mtime deterministically (two writes can land in the
    // same millisecond).
    const rewritten = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(legacyPath, rewritten, 'utf-8');
    const future = new Date(Date.now() + 5000);
    utimesSync(legacyPath, future, future);

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });

    // The watermark advanced with the re-stop: a further sync without a
    // rewrite does not re-detect it (no rewrite of the unchanged file).
    const beforeInode = statSync(workspacePath).ino;
    adoptLegacyChannelState(workspace);
    expect(statSync(workspacePath).ino).toBe(beforeInode);
  });

  it('does not re-apply snapshot-identical entries when the rewrite CHANGES the legacy content (R10-5)', () => {
    // A rewrite that changes the content is handled by the plain content
    // diff; the unchanged entries were not re-asserted, so re-applying
    // them would override an explicit restart (the R9-3 hazard).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { slack: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    new ChannelStateStore(workspacePath).set('slack', 'active');
    // Rewrite with DIFFERENT content and a moved mtime: adds telegram,
    // leaves slack's entry unchanged.
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        channels: { slack: 'stopped', telegram: 'stopped' },
      }),
      'utf-8',
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(legacyPath, future, future);

    adoptLegacyChannelState(workspace);

    // telegram merged via the content diff; slack's explicit restart
    // survives the rewrite.
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      slack: 'active',
      telegram: 'stopped',
    });
  });

  it('keeps the adoption watermark consistent with the content when a rewrite races the sync (R11-2)', () => {
    // The watermark must come from the SAME file version as the adopted
    // content: a path-based stat separated from the read lets a racing
    // legacy rewrite land between the two, recording a stale mtime next
    // to newer content; the next sync then reads moved-mtime +
    // unchanged-content as a byte-identical re-stop rewrite and
    // re-applies the stale snapshot over an explicit restart — the R9-3
    // hazard the watermark exists to prevent. The adoption pins one
    // inode (fstat + read on one open fd), and legacy writers replace
    // via temp + rename, so a racing rewrite swaps the path to a new
    // inode and the pinned pair stays consistent (#8975).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');

    // Simulate the rewrite racing the adoption: it lands the moment the
    // legacy file is opened, as a temp + rename (same as every real
    // writer), adding slack while re-asserting telegram's stop. The
    // openLegacy seam stands in for openSync, so the racing rewrite hits
    // the exact window between the fd pin and the fstat/read pair.
    const racingOpen = (p: string, f: 'r'): number => {
      const fd = openSync(p, f);
      const tmp = `${legacyPath}.race.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          channels: { telegram: 'stopped', slack: 'stopped' },
        }),
        'utf-8',
      );
      renameSync(tmp, legacyPath);
      return fd;
    };
    adoptLegacyChannelState(workspace, { openLegacy: racingOpen });

    // The pinned pair is the PRE-rewrite version, identical to the
    // recorded snapshot: nothing merges and the explicit restart
    // survives (re-applying the snapshot here would be the R9-3 hazard).
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
    });

    // The racing rewrite is picked up by the NEXT sync's content diff:
    // slack merges, and telegram's snapshot-identical entry is NOT
    // re-applied because the rewrite changed the content (R10-5).
    adoptLegacyChannelState(workspace);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
      slack: 'stopped',
    });
  });

  it('merges a legacy stop that appears only AFTER a writer created the workspace file (R10-6)', () => {
    // Writers record `adoptedLegacy: {}` when they create a file, so a
    // first-ever legacy stop merges instead of baselining into
    // permanent invisibility.
    expect(existsSync(legacyPath)).toBe(false);
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'active' },
      adoptedLegacy: {},
    });

    // An older release sharing ~/.qwen records its first stop.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { feishu: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
      feishu: 'stopped',
    });
  });

  it('merges a legacy-diff entry into a channel that already has a record (R10-25)', () => {
    // The mixed-version core case: a no-workspace stop writes the entry
    // to the legacy file for a channel the workspace ALREADY records —
    // the merge must apply over the occupied key, or the explicitly
    // stopped channel keeps running.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { slack: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // Occupied key absent from the snapshot.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        channels: { slack: 'stopped', telegram: 'stopped' },
      }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      slack: 'stopped',
      telegram: 'stopped',
    });
  });

  it('advances the adoptedLegacy snapshot on a merge write (R10-40)', () => {
    // If the merge write kept the PRE-sync snapshot, every merged entry
    // would look new again next sync and re-merge over an explicit
    // restart (the R9-3 resurrection-over-restart regression).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { slack: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    new ChannelStateStore(workspacePath).set('slack', 'active');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        channels: { slack: 'stopped', telegram: 'stopped' },
      }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { slack: 'active', telegram: 'stopped' },
      adoptedLegacy: { slack: 'stopped', telegram: 'stopped' },
      adoptedLegacyMtime: expect.any(Number),
    });
  });
});

describe('ChannelStateStore', () => {
  let filePath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-channel-state-'));
    testDirs.push(dir);
    filePath = join(dir, 'channel-state.json');
  });

  it('returns an empty map when the file is missing', () => {
    const store = new ChannelStateStore(filePath);
    expect(store.readAll()).toEqual({});
  });

  it('persists state across store instances', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');
    store.set('feishu', 'active');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'active',
    });
  });

  it('overwrites earlier state for the same channel', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');
    store.set('telegram', 'active');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'active',
    });
  });

  it('applies setMany to every named channel', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'active');
    store.setMany(['telegram', 'feishu'], 'stopped');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'stopped',
    });
  });

  it('treats a corrupt file as empty and recovers on next write', () => {
    writeFileSync(filePath, '{not json', 'utf-8');
    const store = new ChannelStateStore(filePath);

    expect(store.readAll()).toEqual({});

    store.set('telegram', 'stopped');
    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('warns when an existing state file is discarded (#8975)', () => {
    writeFileSync(filePath, '{not json', 'utf-8');
    const onWarning = vi.fn();
    const store = new ChannelStateStore(filePath, { onWarning });

    store.readAll();

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('could not read channel state file'),
    );
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('treating all channels as active'),
    );
  });

  it('does not warn when the file is simply missing', () => {
    const onWarning = vi.fn();
    new ChannelStateStore(filePath, { onWarning }).readAll();
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('treats an unreadable-but-existing state file as empty and warns once (#8975)', () => {
    // The READ-failure twin of the discard contract: the file exists but
    // readFileSync throws (a directory at the path gives EISDIR on every
    // platform; the realistic trigger is a root-owned 0o600 file read by
    // a non-sudo start). readAll must degrade to the empty map — the
    // prune-catch fallbacks in start/daemon-worker call readAll() again
    // OUTSIDE any try/catch, so a throw here crashes the never-fails
    // store (R10-27).
    mkdirSync(filePath, { recursive: true });
    const onWarning = vi.fn();
    const store = new ChannelStateStore(filePath, { onWarning });

    expect(store.readAll()).toEqual({});

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('could not read channel state file'),
    );
  });

  it('fails closed on a transient read failure instead of rebuilding from empty (#8975)', () => {
    // The WRITE half of the read-failure contract (twin above pins the
    // tolerant READ half). A transient read failure on an existing,
    // still-WRITABLE state file means the content is UNKNOWN, not empty:
    // rebuilding the file from an empty map in applyChange would
    // permanently destroy every recorded stop. trySet must report the
    // persist failure and leave the records intact (R11-v7). The seam
    // fails ONLY the read (not the write): a path obstacle like EISDIR
    // fails the atomic write too, so it cannot distinguish the fixed
    // fail-closed path from the old rebuild-from-empty one.
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, channels: { slack: 'stopped' } }),
      'utf-8',
    );
    const onWarning = vi.fn();
    const readError = new Error('EBUSY') as NodeJS.ErrnoException;
    readError.code = 'EBUSY';
    let failRead = true;
    const store = new ChannelStateStore(filePath, {
      onWarning,
      _testReadFileSync: (p) => {
        if (failRead) throw readError;
        return readFileSync(p, 'utf-8');
      },
    });

    expect(store.trySet('telegram', 'stopped')).toBe(false);
    expect(store.trySetMany(['telegram', 'feishu'], 'stopped')).toBe(false);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('failed to persist channel state'),
    );

    // The records survived the transient condition verbatim — a
    // rebuild-from-empty write would have replaced them while the file
    // was still writable.
    expect(readFileSync(filePath, 'utf-8')).toBe(
      JSON.stringify({ version: 1, channels: { slack: 'stopped' } }),
    );
    // Once the read recovers, writes resume and merge with the intact
    // records.
    failRead = false;
    expect(store.trySet('telegram', 'stopped')).toBe(true);
    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      slack: 'stopped',
      telegram: 'stopped',
    });
  });

  it('preserves the adoption snapshot across a transient read failure (#8975)', () => {
    // Same hazard through the snapshot-preserving path: a store whose
    // file carries adoptedLegacy must not lose the diff baseline when a
    // transient read failure hits the next write — the rebuild would
    // drop it, silently turning every later legacy stop invisible (R11-v7).
    const before = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyMtime: 1234,
    });
    writeFileSync(filePath, before, 'utf-8');
    const readError = new Error('EBUSY') as NodeJS.ErrnoException;
    readError.code = 'EBUSY';
    let failRead = true;
    const store = new ChannelStateStore(filePath, {
      _testReadFileSync: (p) => {
        if (failRead) throw readError;
        return readFileSync(p, 'utf-8');
      },
    });

    expect(store.trySet('telegram', 'active')).toBe(false);

    // Failed write changed nothing: the snapshot and its watermark
    // survive verbatim, and the retry merges with them.
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
    failRead = false;
    expect(store.trySet('telegram', 'active')).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'active' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyMtime: 1234,
    });
  });

  it.each([
    // The third element is the expected discard-warning count: the warning
    // is the only diagnostic trail of the lost records, so pin it on every
    // discard branch; entry-wise filtering must NOT warn (#8975).
    ['[]', {}, 1],
    ['"stopped"', {}, 1],
    // The readAll null guards: without them a literal `null` file passes
    // the remaining shape checks and the `.channels` access throws outside
    // the try/catch, breaking the never-fails contract (#8975).
    ['null', {}, 1],
    ['{"channels": null}', {}, 1],
    ['{"channels": "stopped"}', {}, 1],
    ['{"channels": ["telegram"]}', {}, 1],
    ['{"channels": {"telegram": "running"}}', {}, 0],
    // Unknown states are dropped entry-wise; valid entries survive —
    // including ALONGSIDE an unknown state, so a whole-file-taint refactor
    // of the unknown-state branch cannot ship green.
    [
      '{"channels": {"telegram": "stopped", "feishu": "running"}}',
      { telegram: 'stopped' },
      0,
    ],
    [
      '{"channels": {"": "stopped", "telegram": "active"}}',
      { telegram: 'active' },
      0,
    ],
  ] as Array<[string, Record<string, string>, number]>)(
    'treats wrong-shaped files as empty: %s',
    (content, expected, expectedWarnings) => {
      writeFileSync(filePath, content, 'utf-8');
      const onWarning = vi.fn();
      expect(new ChannelStateStore(filePath, { onWarning }).readAll()).toEqual(
        expected,
      );
      expect(onWarning).toHaveBeenCalledTimes(expectedWarnings);
    },
  );

  it('writes valid JSON with the recorded states', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      // A writer-created file records an EMPTY adoption snapshot: `{}`
      // marks 'has seen the legacy file' so a first-ever legacy stop
      // later merges instead of baselining into invisibility; ABSENT
      // stays the marker for files predating snapshot recording (R10-6).
      adoptedLegacy: {},
    });
  });

  describe('trySet / trySetMany (#8975)', () => {
    /** A path whose parent is a regular file makes mkdirSync (and thus any write) throw. */
    function unwritablePath(): string {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-channel-state-'));
      testDirs.push(dir);
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, '', 'utf-8');
      return join(blocker, 'channel-state.json');
    }

    it('set and setMany still surface write failures', () => {
      const store = new ChannelStateStore(unwritablePath(), {
        onWarning: vi.fn(),
      });
      expect(() => store.set('telegram', 'stopped')).toThrow();
      expect(() => store.setMany(['telegram'], 'stopped')).toThrow();
    });

    it('trySet and trySetMany swallow write failures with a warning', () => {
      const onWarning = vi.fn();
      const store = new ChannelStateStore(unwritablePath(), { onWarning });

      expect(() => store.trySet('telegram', 'stopped')).not.toThrow();
      expect(() =>
        store.trySetMany(['telegram', 'feishu'], 'stopped'),
      ).not.toThrow();

      // The boolean reports that the write did NOT persist, so callers
      // whose success message claims a durable stop can surface it (#8975).
      expect(store.trySet('telegram', 'stopped')).toBe(false);
      expect(store.trySetMany(['telegram', 'feishu'], 'stopped')).toBe(false);

      expect(onWarning).toHaveBeenCalledTimes(4);
      expect(onWarning).toHaveBeenCalledWith(
        expect.stringContaining('failed to persist channel state'),
      );
    });

    it('trySet and trySetMany persist on the success path (#8975)', () => {
      // Production writes channel state only through trySet/trySetMany; a
      // regression breaking success-path persistence (dropped or misrouted
      // delegation, warn-only conversion) must not ship green — so the
      // success path reads the file back through a fresh store.
      const onWarning = vi.fn();
      const store = new ChannelStateStore(filePath, { onWarning });

      expect(store.trySet('telegram', 'stopped')).toBe(true);
      expect(store.trySetMany(['feishu', 'slack'], 'active')).toBe(true);

      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
        feishu: 'active',
        slack: 'active',
      });
      // One-sided warning pin: the write-failure warning is pinned on the
      // failure path above; a successful write must NOT fire it — a false
      // 'failed to persist channel state' on every successful stop/start
      // (R9-11).
      expect(onWarning).not.toHaveBeenCalled();
    });
  });

  describe('default warning path (#8975)', () => {
    it('survives a failing stderr target when warning without an onWarning override', async () => {
      writeFileSync(filePath, '{not json', 'utf-8');
      // A failing stderr target (e.g. ENOSPC on a redirected log) does not
      // throw synchronously — Node delivers the failure as an async 'error'
      // event on process.stderr, which kills the process unless something
      // listens. The default sink must guard that channel.
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((() => {
          setImmediate(() => {
            process.stderr.emit('error', new Error('ENOSPC'));
          });
          return true;
        }) as typeof process.stderr.write);

      const listenersBefore = new Set(process.stderr.listeners('error'));
      try {
        // No onWarning override: exercises the default stderr sink.
        expect(new ChannelStateStore(filePath).readAll()).toEqual({});
        // Let the async 'error' event fire; without the guard it would
        // surface as an uncaught exception and fail this test.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        writeSpy.mockRestore();
        // Drop exactly the guard listener this test attached, so the
        // process-wide stderr state is the same as before the test.
        for (const listener of process.stderr.listeners('error')) {
          if (!listenersBefore.has(listener)) {
            process.stderr.removeListener(
              'error',
              listener as (...args: unknown[]) => void,
            );
          }
        }
      }
    });

    it('attaches the stderr error listener only once across repeated warnings (#8975)', async () => {
      writeFileSync(filePath, '{not json', 'utf-8');
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((() => {
          setImmediate(() => {
            process.stderr.emit('error', new Error('ENOSPC'));
          });
          return true;
        }) as typeof process.stderr.write);

      // Take over the stderr error-listener state for this test: the
      // guard only attaches when NOTHING listens, and a guard listener
      // attached by an earlier test persists on process.stderr (the
      // exact long-lived-service condition this pin models).
      const priorListeners = process.stderr.listeners('error');
      for (const listener of priorListeners) {
        process.stderr.removeListener(
          'error',
          listener as (...args: unknown[]) => void,
        );
      }
      try {
        expect(new ChannelStateStore(filePath).readAll()).toEqual({});
        // A second warning must NOT attach another no-op listener:
        // warnings fire precisely during sustained disk degradation
        // (every failed trySet/trySetMany), and a per-warning attach
        // grows the listener set without bound — MaxListenersExceeded
        // noise after 10 in the long-lived channel service (#8975).
        expect(new ChannelStateStore(filePath).readAll()).toEqual({});
        expect(process.stderr.listenerCount('error')).toBe(1);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        writeSpy.mockRestore();
        for (const listener of process.stderr.listeners('error')) {
          process.stderr.removeListener(
            'error',
            listener as (...args: unknown[]) => void,
          );
        }
        for (const listener of priorListeners) {
          process.stderr.on('error', listener as (...args: unknown[]) => void);
        }
      }
    });

    it('still writes warnings to stderr on the default path', () => {
      writeFileSync(filePath, '{not json', 'utf-8');
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((() => true) as typeof process.stderr.write);

      try {
        new ChannelStateStore(filePath).readAll();
        expect(writeSpy).toHaveBeenCalledWith(
          expect.stringContaining('could not read channel state file'),
        );
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  describe('prune (#8975)', () => {
    it('drops entries for channels that are no longer configured', () => {
      const store = new ChannelStateStore(filePath);
      store.setMany(['telegram', 'feishu'], 'stopped');

      const states = store.prune(['telegram']);

      expect(states).toEqual({ telegram: 'stopped' });
      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
      });
    });

    it('keeps every entry when nothing is stale', () => {
      const store = new ChannelStateStore(filePath);
      store.set('telegram', 'stopped');
      const beforeInode = statSync(filePath).ino;

      const states = store.prune(['telegram', 'feishu']);

      expect(states).toEqual({ telegram: 'stopped' });
      // No stale entries: the file is not rewritten. Byte equality cannot
      // observe a rewrite (the serialization is deterministic), so pin the
      // inode — atomicWriteFileSync replaces the file via temp+rename.
      expect(statSync(filePath).ino).toBe(beforeInode);
    });

    it('treats an empty configured set as a no-op, never a wipe-all (#8975)', () => {
      const store = new ChannelStateStore(filePath);
      store.setMany(['telegram', 'feishu'], 'stopped');
      const beforeInode = statSync(filePath).ino;

      const states = store.prune([]);

      // Zero configured channels is ambiguous (a transient settings read can
      // recover to empty); destroying every recorded stop would resurrect
      // exactly the channels #8975 must keep stopped.
      expect(states).toEqual({ telegram: 'stopped', feishu: 'stopped' });
      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
        feishu: 'stopped',
      });
      expect(statSync(filePath).ino).toBe(beforeInode);
    });

    it('treats setMany([]) and trySetMany([]) as a disk-write-free no-op (R10-26)', () => {
      // Production reaches empty writes (a zero-channel service's stop
      // calls trySetMany([], 'stopped')); the empty guard must not run
      // applyChange — an unguarded empty call creates a workspace file
      // where none existed, converting the next first adoption into the
      // baseline branch. The daemon tests cannot see a guard removal:
      // their mock hard-codes its own copy (R10-26).
      const store = new ChannelStateStore(filePath);

      store.setMany([], 'stopped');
      expect(existsSync(filePath)).toBe(false);
      expect(store.trySetMany([], 'stopped')).toBe(true);
      expect(existsSync(filePath)).toBe(false);

      // With an existing file: no rewrite either.
      store.set('telegram', 'stopped');
      const beforeInode = statSync(filePath).ino;
      store.setMany([], 'stopped');
      expect(store.trySetMany([], 'stopped')).toBe(true);
      expect(statSync(filePath).ino).toBe(beforeInode);
      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
      });
    });

    it('preserves the adoptedLegacy snapshot across a prune write (R10-7)', () => {
      // prune is the hottest production write path (every mode-`all`
      // start): startAll adopts (recording the snapshot), then prunes the
      // SAME file. If prune dropped the snapshot, the next adoption would
      // baseline without merging and silently discard post-adoption
      // legacy stops. Snapshot survival across writes is pinned for `set`
      // via the merge tests; this pins the prune path.
      const store = new ChannelStateStore(filePath);
      const snapshot = { telegram: 'stopped', slack: 'stopped' };
      writeFileSync(
        filePath,
        JSON.stringify(
          {
            version: 1,
            channels: { telegram: 'stopped', feishu: 'stopped' },
            adoptedLegacy: snapshot,
            adoptedLegacyMtime: 12345,
          },
          null,
          2,
        ),
        'utf-8',
      );

      store.prune(['telegram']);

      expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
        version: 1,
        channels: { telegram: 'stopped' },
        adoptedLegacy: snapshot,
        adoptedLegacyMtime: 12345,
      });
    });

    it('throws on write failure so callers can fall back to readAll (#8975)', () => {
      // prune is deliberately NOT throw-safe on writes: both production
      // callers (daemon-worker, start) catch the throw and fall back to
      // readAll(), so a best-effort conversion that swallows the write
      // error would silently drop stale entries from the returned map
      // while they remain on disk (#8975).
      const store = new ChannelStateStore(filePath, { onWarning: vi.fn() });
      store.setMany(['telegram', 'feishu'], 'stopped');
      const writeError = new Error('ENOSPC') as NodeJS.ErrnoException;
      writeError.code = 'ENOSPC';
      mockAtomicWriteFileSync.mockImplementationOnce(() => {
        throw writeError;
      });

      expect(() => store.prune(['telegram'])).toThrow();
      // The file is untouched: a fresh store reads back the pre-prune
      // states, exactly what the callers' readAll() fallback relies on.
      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
        feishu: 'stopped',
      });
    });
  });

  // The restrictive permissions are pinned elsewhere only for the adoption
  // call site; every production write goes through applyChange, so pin the
  // same property on the file/dir it produces (win32 skip: POSIX permission
  // bits never surface on Windows).
  it.skipIf(process.platform === 'win32')(
    'writes 0o600 files and 0o700 dirs on the production write path (#8975)',
    () => {
      // Pre-create the target dir LOOSER than 0o700: mkdirSync's mode only
      // applies to newly created dirs, so here only the explicit chmod in
      // applyChange keeps the dir restrictive. chmodSync ignores the
      // process umask (mkdirSync's mode is masked by it), so it pins the
      // loose precondition even under a restrictive umask — asserted below
      // so a masking environment fails loudly instead of passing the 0o700
      // check vacuously (#8975).
      const looseDir = join(dirname(filePath), 'loose');
      mkdirSync(looseDir, { mode: 0o755 });
      chmodSync(looseDir, 0o755);
      expect(statSync(looseDir).mode & 0o777).toBe(0o755);
      const target = join(looseDir, 'channel-state.json');
      const store = new ChannelStateStore(target);

      store.set('telegram', 'stopped');
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(looseDir).mode & 0o777).toBe(0o700);

      store.setMany(['feishu'], 'stopped');
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(looseDir).mode & 0o777).toBe(0o700);
    },
  );

  it('round-trips a channel literally named __proto__ (#8975)', () => {
    const store = new ChannelStateStore(filePath);
    store.set('__proto__', 'stopped');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      ['__proto__']: 'stopped',
    });
  });
});

describe('selectActiveChannels (#8975)', () => {
  it('selects channels that are not stopped and reports each skip', () => {
    const onSkipped = vi.fn();

    const selected = selectActiveChannels(
      ['telegram', 'feishu', 'slack'],
      { feishu: 'stopped', slack: 'active' },
      onSkipped,
    );

    expect(selected).toEqual(['telegram', 'slack']);
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith(
      '[Channel] "feishu" skipped (stopped before restart)',
    );
  });

  it('sanitizes user-controlled channel names in skip messages', () => {
    const onSkipped = vi.fn();
    const evilName = 'evil\n[Channel] "telegram" connected.';

    selectActiveChannels([evilName], { [evilName]: 'stopped' }, onSkipped);

    expect(onSkipped).toHaveBeenCalledTimes(1);
    const message = onSkipped.mock.calls[0]![0] as string;
    expect(message).toContain('skipped (stopped before restart)');
    expect(message).not.toContain('\n');
  });
});
