import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canonicalizeWorkspacePath } from '@qwen-code/channel-base';
import { hashDaemonWorkspace } from '@qwen-code/qwen-code-core';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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

// R15-49: delegates to the real mkdirSync; individual tests can ARM a
// single EEXIST at a specific path to simulate the concurrent-creation
// race between prepareStateDirectory's existsSync and mkdirSync.
//
// The factory must NEVER reference the real `node:fs` module itself
// (R16-3, probe-verified): neither an async `importOriginal` factory
// nor a sync `require` factory gets applied to the store-under-test's
// `node:fs` import in this setup (zero wrapper calls during the SUT),
// which left the race test exercising only the uncontended path and
// pinning the prepareStateDirectory swallow vacuously. A factory that
// only returns its own object IS applied — so every export delegates
// LAZILY through `realNodeFs.current`, populated by the top-level
// beforeAll via vi.importActual. The race test's `armedAfterSut`
// assertion fails red if the injection ever stops reaching the SUT.
const mkdirEexistOnce = vi.hoisted(() => ({ armed: false, target: '' }));
// doudouOUC C3 race injection: one chmodSync on the target throws ENOENT
// after actually deleting the level — the concurrent-deletion shape
// prepareStateDirectory's chmod handling must recover from (recreate the
// level, retry the chmod once).
const chmodEnoentOnce = vi.hoisted(() => ({ armed: false, target: '' }));
const realNodeFs = vi.hoisted(() => ({
  current: undefined as unknown as typeof import('node:fs'),
}));
vi.mock('node:fs', () => {
  const mod: Record<string | symbol, unknown> = {
    mkdirSync: (
      p: Parameters<typeof import('node:fs').mkdirSync>[0],
      opts?: unknown,
    ) => {
      if (mkdirEexistOnce.armed && String(p) === mkdirEexistOnce.target) {
        mkdirEexistOnce.armed = false;
        // Simulate the race WINNER too: in the real race the concurrent
        // creator's mkdir lands between the loser's existsSync and
        // mkdirSync, so the directory EXISTS when the loser continues —
        // without creating it here, the post-swallow write fails ENOENT
        // and the test would pin a failure shape the swallow exists to
        // prevent (R16-3).
        realNodeFs.current.mkdirSync(p as string, { recursive: true });
        const error = new Error(
          `EEXIST: file already exists, mkdir '${p}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return realNodeFs.current.mkdirSync(p as string, opts as never);
    },
    chmodSync: (
      p: Parameters<typeof import('node:fs').chmodSync>[0],
      mode: Parameters<typeof import('node:fs').chmodSync>[1],
    ) => {
      if (chmodEnoentOnce.armed && String(p) === chmodEnoentOnce.target) {
        chmodEnoentOnce.armed = false;
        // Simulate the concurrent deletion faithfully: the level really
        // vanishes, so the SUT's recovery (recreate + retry) must do real
        // filesystem work — a swallow-and-continue mutation would leave
        // the directory missing and fail the post-race write (C3).
        realNodeFs.current.rmSync(p as string, {
          recursive: true,
          force: true,
        });
        const error = new Error(
          `ENOENT: no such file or directory, chmod '${p}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return realNodeFs.current.chmodSync(p as string, mode);
    },
  };
  // CJS/ESM interop: vitest requires the default export on the mock.
  mod['default'] = mod;
  // Every other export delegates lazily to the real module. Consumers
  // capture their named imports at module-init time (before the
  // beforeAll populates the slot), so function exports must be stable
  // callable wrappers from the factory onward — each one forwards to
  // the slot at CALL time and mirrors the real function's own
  // properties live: the `vi.spyOn(fs.realpathSync, 'native')` pins
  // depend on `.native` resolving to the real sub-function (and
  // canonicalizeWorkspacePath calls `realpathSync.native(...)` through
  // its own intercepted binding — the wrapper is shared, so an in-place
  // spy on it is visible there).
  const realValue = (prop: string | symbol): unknown => {
    const real = realNodeFs.current as unknown as
      | Record<string | symbol, unknown>
      | undefined;
    return real ? real[prop] : undefined;
  };
  // Interop probes must not see a callable: vitest awaits the mock
  // module and treats a `then` function as a thenable.
  const INTEROP_BLOCKLIST = new Set(['then']);
  // vitest materializes the mocked namespace from ownKeys AT REGISTRATION
  // time (before the beforeAll populates the slot), so the export list
  // must be static, not derived from the real module. Cover every fs
  // export this file's graph consumes; extras are inert wrappers unless
  // called.
  const FS_EXPORTS = [
    'accessSync',
    'appendFileSync',
    'chmodSync',
    'chownSync',
    'closeSync',
    'constants',
    'copyFileSync',
    'cpSync',
    'createReadStream',
    'createWriteStream',
    'Dir',
    'Dirent',
    'existsSync',
    'fchmodSync',
    'fchownSync',
    'fdatasyncSync',
    'FileHandle',
    'fstatSync',
    'fsyncSync',
    'ftruncateSync',
    'FSWatcher',
    'futimesSync',
    'glob',
    'globSync',
    'lchmodSync',
    'lchownSync',
    'linkSync',
    'lstatSync',
    'lutimesSync',
    'mkdirSync',
    'mkdtempSync',
    'openSync',
    'opendirSync',
    'promises',
    'readSync',
    'readdirSync',
    'readFileSync',
    'readlinkSync',
    'ReadStream',
    'readvSync',
    'realpathSync',
    'renameSync',
    'rmSync',
    'rmdirSync',
    'statSync',
    'statfsSync',
    'Stats',
    'symlinkSync',
    'truncateSync',
    'unlinkSync',
    'unwatchFile',
    'utimesSync',
    'watch',
    'watchFile',
    'writeSync',
    'writeFileSync',
    'WriteStream',
    'writevSync',
  ];
  const lazyFnCache = new Map<string, unknown>();
  const lazyFn = (prop: string): unknown => {
    const cached = lazyFnCache.get(prop);
    if (cached) return cached;
    const forward = (...args: unknown[]): unknown => {
      const real = realValue(prop);
      if (typeof real !== 'function') {
        throw new Error(
          `node:fs mock: "${prop}" used before beforeAll populated the real module`,
        );
      }
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    const wrapped = new Proxy(forward, {
      get(inner, p) {
        const own = Reflect.get(inner, p);
        if (own !== undefined || typeof p === 'symbol') return own;
        const real = realValue(prop) as Record<string | symbol, unknown>;
        return real ? real[p] : undefined;
      },
      // vi.spyOn(fs.realpathSync, 'native') probes existence before
      // replacing; without these traps the sub-property "does not exist".
      has(inner, p) {
        const real = realValue(prop) as Record<string | symbol, unknown>;
        return Reflect.has(inner, p) || (real ? p in real : false);
      },
      getOwnPropertyDescriptor(inner, p) {
        const own = Reflect.getOwnPropertyDescriptor(inner, p);
        if (own) return own;
        const real = realValue(prop) as Record<string | symbol, unknown>;
        if (!real || !(p in real)) return undefined;
        return {
          enumerable: true,
          configurable: true,
          writable: true,
          value: real[p],
        };
      },
    });
    lazyFnCache.set(prop, wrapped);
    return wrapped;
  };
  // Expose every other export as a lazy getter (R16-3): consumers
  // capture their named imports at module-init time, and vitest may
  // materialize the mocked namespace via spread OR descriptors OR live
  // property access depending on the importer — a getter on a plain
  // object is the one shape that behaves under all three. The getter
  // returns the stable callable wrapper for functions (slot empty at
  // init time included) and the real value for non-functions once the
  // slot is populated.
  for (const name of FS_EXPORTS) {
    if (name in mod || INTEROP_BLOCKLIST.has(name)) continue;
    Object.defineProperty(mod, name, {
      enumerable: true,
      configurable: true,
      get: () => {
        const real = realValue(name);
        return real !== undefined && typeof real !== 'function'
          ? real
          : lazyFn(name);
      },
    });
  }
  return mod;
});

import {
  adoptLegacyChannelState,
  ChannelStateStore,
  channelRuntimeStatePath,
  selectActiveChannels,
} from './channel-state-store.js';

// Populate the lazy delegation slot BEFORE any test touches the mocked
// fs exports (R16-3): vi.importActual bypasses the mock, and the
// factory itself must not reference the real module (see the vi.mock
// block above).
beforeAll(async () => {
  realNodeFs.current =
    await vi.importActual<typeof import('node:fs')>('node:fs');
});

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

  // Windows case-insensitivity collapse — the one spelling variant the
  // production comment explicitly names (channel-state-store.ts:
  // "Windows case-insensitivity, symlinks, trailing separators must map
  // to ONE state file, or a stop recorded under one spelling is silently
  // lost … and the next --channel all resurrects the explicitly stopped
  // channels"). Case collapse is delivered solely by
  // fs.realpathSync.native; a swap to plain realpathSync (or a manual
  // lstat-walk) keeps every POSIX test green while case variants of one
  // existing workspace hash to TWO state files. The merge queue runs a
  // Windows job, so this pin actually executes there (R14-23).
  // Case collapse is a property of the FILESYSTEM, not the OS: win32
  // volumes are case-insensitive, and darwin's APFS is by default — but a
  // case-SENSITIVE APFS volume also exists. Gate on both and probe the
  // native filesystem (R15-25): if the swapped spelling does not resolve
  // to the created directory, the volume is case-sensitive and the
  // assertion does not apply there.
  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'collapses case-variant spellings of the same directory (R14-23)',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'qwen-canonical-'));
      testDirs.push(root);
      const realDir = join(root, 'CaseMixedDir');
      mkdirSync(realDir);
      const leaf = basename(realDir);
      const swapped = join(
        root,
        leaf === leaf.toLowerCase() ? leaf.toUpperCase() : leaf.toLowerCase(),
      );
      // Guard probe: on a case-sensitive volume the swapped spelling is a
      // NONEXISTENT path, so the assertion would be meaningless — skip.
      if (!existsSync(swapped)) return;

      expect(channelRuntimeStatePath(swapped)).toBe(
        channelRuntimeStatePath(realDir),
      );
    },
  );

  it('falls back to the resolved spelling when realpath fails with a non-ENOENT error (R15-48)', () => {
    // canonicalizeWorkspacePath catches ALL realpath errors
    // (EACCES/EIO/ELOOP) and falls back to the resolved spelling —
    // deliberately, since the store is a never-fails subsystem. This PR
    // makes that tolerance load-bearing: channelRuntimeStatePath calls it
    // on the standalone stop/start critical path and recordStoppedChannels
    // evaluates it OUTSIDE any try/catch. Narrowing the catch to
    // ENOENT-only must fail here — a transient EACCES realpath failure
    // would otherwise throw, lose the explicit stop record, and the next
    // `--channel all` resurrects the channel (#8975).
    const root = mkdtempSync(join(tmpdir(), 'qwen-canonical-'));
    testDirs.push(root);
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    });
    try {
      expect(() => channelRuntimeStatePath(root)).not.toThrow();
      // The resolved (not realpath) spelling is hashed.
      expect(channelRuntimeStatePath(root)).toBe(
        join(
          getStateHome(),
          'channels',
          'standalone',
          hashDaemonWorkspace(root),
          'channel-state.json',
        ),
      );
    } finally {
      spy.mockRestore();
    }
  });
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

  // The adoption failure paths warn through the real default sink, which
  // attaches the process-wide no-op stderr 'error' guard on first fire and
  // never removes it. The threads pool reuses workers across test files,
  // so a leaked guard swallows genuine async stderr errors in later files
  // AND makes the default-warning-path pins start with listenerCount >= 1,
  // skipping the very attach they document (#8975). Snapshot/restore the
  // listener set around each test.
  let stderrErrorListenersBefore = new Set<unknown>();
  beforeEach(() => {
    stderrErrorListenersBefore = new Set(process.stderr.listeners('error'));
  });
  afterEach(() => {
    for (const listener of process.stderr.listeners('error')) {
      if (!stderrErrorListenersBefore.has(listener)) {
        process.stderr.removeListener(
          'error',
          listener as (...args: unknown[]) => void,
        );
      }
    }
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
    // (R9-3). The legacy generation watermark beside it lets a later sync
    // see an entry-set-unchanged re-stop rewrite (R10-5, R11-14).
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyGeneration: expect.any(Number),
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
      // A clean adoption must write NOTHING to stderr (R11-28): a
      // substring pin scoped to one message lets a differently worded or
      // unconditional warning ship green — a false alarm on every clean
      // startup, the exact thing this test exists to catch.
      expect(writeSpy).not.toHaveBeenCalled();
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

      // Establish the hazard precondition (R15-26): under a RESTRICTIVE
      // umask the mkdirSync({mode:0o700}) alone lands the dirs at 0o600
      // (no traverse bit), so the asserted 0o700 is only reachable via
      // prepareStateDirectory's per-level chmodSync enforcement. Without
      // the umask, any permissive CI umask produces 0o700 from the mode
      // argument alone and the enforcement is untested. process.umask()
      // restores in finally (verified working on this repo's Node).
      const oldUmask = process.umask(0o177);
      try {
        adoptLegacyChannelState(workspace);

        // Pin the deliberate restrictive permissions on the adopted file
        // and its directory: the legacy file was written by an older
        // release at default umask, and adoption exists to normalize it
        // (#8975).
        expect(statSync(workspacePath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(workspacePath)).mode & 0o777).toBe(0o700);
        // Adoption creates the intermediate `standalone` dir AND the leaf
        // hash dir via the recursive mkdirSync: BOTH must land
        // restrictive, not just the leaf — a split mkdir applying the mode
        // only to the leaf would leave ~/.qwen/channels/standalone/
        // world-enumerable (every workspace hash directory) with the pins
        // above green (R9-9).
        expect(statSync(dirname(dirname(workspacePath))).mode & 0o777).toBe(
          0o700,
        );
      } finally {
        process.umask(oldUmask);
      }
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
      adoptedLegacyGeneration: expect.any(Number),
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

  it('starts recording the watermark when a snapshot file predates it (R11-20)', () => {
    // A target holding a snapshot but NO generation watermark predates
    // watermark recording: the skip guard must not fire before the
    // one-shot baseline write that STARTS recording, or entry-set-
    // unchanged re-stops stay invisible on every subsequent sync while
    // the legacy content stays unchanged.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    mkdirSync(dirname(workspacePath), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({
        version: 1,
        channels: { telegram: 'stopped' },
        adoptedLegacy: { telegram: 'stopped' },
      }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    // The baseline write happened and recorded the watermark.
    const recorded = JSON.parse(readFileSync(workspacePath, 'utf-8')) as {
      adoptedLegacyGeneration?: number;
    };
    expect(recorded.adoptedLegacyGeneration).toEqual(expect.any(Number));

    // ...and an entry-set-unchanged re-stop is visible from now on.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    new ChannelStateStore(legacyPath).setMany(['telegram'], 'stopped');
    adoptLegacyChannelState(workspace);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('starts recording the epoch baseline when the target has snapshot+generation but none (R16-44)', () => {
    // Epoch twin of the R11-20 generation-watermark pin: a target holding
    // a snapshot AND a generation watermark but NO epoch baseline predates
    // epoch recording. The skip guard must not fire before the one-shot
    // baseline write that records `adoptedLegacyEntryEpochs`, or
    // per-entry re-stop detection never arms for this workspace
    // (epochsUsable stays false forever, R15-15).
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    mkdirSync(dirname(workspacePath), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({
        version: 1,
        channels: { telegram: 'stopped' },
        adoptedLegacy: { telegram: 'stopped' },
        adoptedLegacyGeneration: 0,
      }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    // The baseline write happened and recorded the epoch map — with
    // nothing merged (content-identical), so the write ran purely to arm
    // the tier.
    const recorded = JSON.parse(readFileSync(workspacePath, 'utf-8')) as {
      channels: Record<string, string>;
      adoptedLegacyEntryEpochs?: Record<string, number>;
    };
    expect(recorded.channels).toEqual({ telegram: 'stopped' });
    expect(recorded.adoptedLegacyEntryEpochs).toEqual({ telegram: 0 });
  });

  it('does not let repeated new-entry writes re-stop an explicitly restarted channel (R16-44)', () => {
    // The false-positive direction the per-entry epoch tier exists to
    // prevent: the tier-3 generation arithmetic inflates when one NEW
    // entry is written repeatedly (each write bumps generation by the
    // entries named), so `delta > added` fires without any re-stop. With
    // the epoch tier dropped, this shape would flip the explicitly
    // restarted channel back to `stopped` (the #8975 regression class)
    // while every existing re-stop test stays green via the arithmetic.
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // An unrelated workspace stops one NEW entry — twice (two separate
    // writes). Generation moves by 2, the entry set by 1.
    new ChannelStateStore(legacyPath).set('feishu', 'stopped');
    new ChannelStateStore(legacyPath).set('feishu', 'stopped');

    adoptLegacyChannelState(workspace);

    // The new stop merges; the snapshot-identical entry survives because
    // ITS OWN epoch did not move past the recorded baseline.
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
      feishu: 'stopped',
    });
  });

  it('honors a re-stop whose entry was stamped after a partial epoch baseline armed (R20-1)', () => {
    // The one-sided-baseline case the epoch tier dropped: a pre-epoch
    // legacy file is adopted with NO epoch baseline; a workspace-less
    // re-stop of ONE entry then arms a PARTIAL baseline (only the written
    // entry gets an epoch — absence is never forged, R15-15) that the
    // skip-write gate never heals. When the OTHER entry is later
    // explicitly re-stopped, its current epoch exists while its adopted
    // baseline is absent — with epochsUsable true the generation
    // arithmetic is off file-wide, so the old comparison returned false
    // and the explicit re-stop was silently dropped (the entry stayed
    // `active`), while a fresh workspace adopting the same legacy file
    // honored it. Treat a missing baseline with a present current epoch
    // as a re-stop: fail-safe (an under-start is one explicit start
    // away) and self-stabilizing — the detected rewrite forces a write
    // that records the entry's epoch baseline, after which normal
    // comparison resumes.
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        channels: { alpha: 'stopped', beta: 'stopped' },
      }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // A workspace-less re-stop of beta stamps ONLY beta (generation 0),
    // arming the partial baseline {beta: 0} on the next sync.
    new ChannelStateStore(legacyPath).set('beta', 'stopped');
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption...
    new ChannelStateStore(workspacePath).set('alpha', 'active');
    // ...then alpha is explicitly re-stopped: the write names alpha and
    // stamps its epoch, keeping beta's.
    new ChannelStateStore(legacyPath).set('alpha', 'stopped');

    adoptLegacyChannelState(workspace);

    // The re-stop is honored over the explicit restart; beta is NOT
    // re-stopped (its own epoch did not move past its baseline).
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      alpha: 'stopped',
      beta: 'stopped',
    });
    // Self-stabilizing: the write completed the partial baseline, so the
    // next sync compares normally.
    const recorded = JSON.parse(readFileSync(workspacePath, 'utf-8')) as {
      adoptedLegacyEntryEpochs?: Record<string, number>;
    };
    expect(recorded.adoptedLegacyEntryEpochs).toEqual({
      alpha: 1,
      beta: 0,
    });
  });

  it('treats a delete/recreate of the legacy file as a lineage break and re-stops (R16-8)', () => {
    // The generationRegressed tier: user cleanup or a backup restore
    // deletes the legacy global file, and a later stop recreates it with
    // the generation counter RESET. A snapshot-identical entry under a
    // LOWER generation is a lineage break — re-stop it fail-safe, or an
    // inverted/deleted comparison resurrects explicitly re-stopped
    // channels on the next `--channel all` (#8975).
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    // Push the watermark up so the recreated file's reset counter lands
    // strictly below it.
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // Delete/recreate: the new file starts its generation over.
    rmSync(legacyPath, { force: true });
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('does nothing when no legacy file exists', () => {
    // The common case for every user who has never recorded a stop must
    // stay silent on stderr: a dropped early-return would let ENOENT fall
    // into the read catch and warn 'recorded stops may not be honored' on
    // every clean `--channel all` start — a false alarm on every clean
    // startup (the R9-10 hazard class).
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      adoptLegacyChannelState(workspace);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
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

  it('tolerates an EEXIST race on the state directory and still adopts (R15-49)', () => {
    // The sole concurrency guard on state-directory creation
    // (prepareStateDirectory's mkdir loop) swallows EEXIST: two concurrent
    // first-writes (parallel first scoped stops, or a stop racing another
    // workspace's first adoption) both pass the existsSync check, and the
    // mkdir loser throws EEXIST. Without the swallow the scoped write
    // fails after the channels already stopped — the durable stop record
    // is lost and the next `--channel all` resurrects them (#8975).
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(legacyPath, legacyBody, 'utf-8');
    // Arm ONE EEXIST at the leaf hash level; the real mkdirSync handles
    // every other level.
    mkdirEexistOnce.armed = true;
    mkdirEexistOnce.target = dirname(workspacePath);
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    let armedAfterSut = false;
    try {
      expect(() => adoptLegacyChannelState(workspace)).not.toThrow();
      armedAfterSut = mkdirEexistOnce.armed;
      // The race must not surface as a failed adoption.
      expect(writeSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('could not adopt legacy channel state'),
      );
    } finally {
      writeSpy.mockRestore();
      mkdirEexistOnce.armed = false;
      mkdirEexistOnce.target = '';
    }
    // The armed EEXIST must have been CONSUMED by the store-under-test:
    // with the injection never reaching the SUT the test exercises only
    // the uncontended path and pins the EEXIST swallow vacuously. Red
    // here means the mock registration does not cover the specifier the
    // store resolves (R16-3).
    expect(armedAfterSut).toBe(false);

    // The target is still seeded from the legacy map.
    expect(existsSync(workspacePath)).toBe(true);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('recovers a concurrently deleted state dir level during chmod and still adopts (doudouOUC C3)', () => {
    // prepareStateDirectory chmods each created level; a concurrent
    // deletion between the mkdir and the chmod used to be swallowed by
    // the bare catch meant for non-POSIX filesystems — hiding a real
    // ENOENT and proceeding to a guaranteed ENOENT state-file write.
    // The recovery must recreate the level and retry the chmod once so
    // the adoption (and any store write) still lands (#8975).
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(legacyPath, legacyBody, 'utf-8');
    // Arm ONE ENOENT at the leaf hash level; the injection deletes the
    // level for real before throwing (see the node:fs mock).
    chmodEnoentOnce.armed = true;
    chmodEnoentOnce.target = dirname(workspacePath);
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    let armedAfterSut = false;
    try {
      expect(() => adoptLegacyChannelState(workspace)).not.toThrow();
      armedAfterSut = chmodEnoentOnce.armed;
      // The race must not surface as a failed adoption.
      expect(writeSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('could not adopt legacy channel state'),
      );
    } finally {
      writeSpy.mockRestore();
      chmodEnoentOnce.armed = false;
      chmodEnoentOnce.target = '';
    }
    // The armed ENOENT must have been CONSUMED by the store-under-test:
    // with the injection never reaching the SUT the test exercises only
    // the uncontended path and pins the recovery vacuously (R16-3 shape).
    expect(armedAfterSut).toBe(false);

    // The target is still seeded from the legacy map, and its directory
    // survived the race at the restrictive mode.
    expect(existsSync(workspacePath)).toBe(true);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
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
      adoptedLegacyGeneration: expect.any(Number),
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
      adoptedLegacyGeneration: expect.any(Number),
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
      // itself must leave a trace (R10-8). Pin the DISTINGUISHING suffix:
      // the skip warning shares the prefix but means the opposite (file
      // untouched, retry next start), so a text swap between the two
      // branches must not ship green (R11-39).
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not read channel state file'),
      );
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('treating all channels as active'),
      );
    } finally {
      writeSpy.mockRestore();
    }
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyGeneration: expect.any(Number),
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
    // ...and it STILL stands — a cleanup of the unreadable target would
    // destroy records whose content is UNKNOWN (not corrupt): the next
    // start would reseed from legacy only and this workspace's own
    // recorded stops would resurrect (#8975).
    expect(existsSync(workspacePath)).toBe(true);
    expect(statSync(workspacePath).isDirectory()).toBe(true);

    // Once the condition clears, adoption proceeds normally.
    rmSync(workspacePath, { recursive: true, force: true });
    adoptLegacyChannelState(workspace);
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyGeneration: expect.any(Number),
    });
  });

  it('warns when the legacy file reads but no longer parses (R10-24)', () => {
    // A legacy file that readFileSync reads successfully but parses to
    // undefined is UNKNOWN content, not empty: seeding the workspace file
    // from an empty view would persist that emptiness as the new
    // adoptedLegacy baseline, destroying any recorded snapshot. The sync
    // warns like every other discard path and skips, mirroring the
    // target-read failure path (#8975, R17-1).
    writeFileSync(legacyPath, '{not json', 'utf-8');
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      expect(() => adoptLegacyChannelState(workspace)).not.toThrow();

      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not parse legacy channel state file'),
      );
      // No target seeded: the sync aborted before any write.
      expect(existsSync(workspacePath)).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }

    // Repair: adoption runs on every start, so the restored stops are
    // adopted on the next one.
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

  it('preserves the recorded baseline when the legacy file reads but no longer parses (R17-1)', () => {
    // The workspace file holds an explicit restart over an adopted stop,
    // with the snapshot recorded. Coercing an unparseable legacy file to
    // empty would stamp adoptedLegacy:{} / generation -1 (baseline gone);
    // restoring the legacy content afterwards would then merge the stale
    // stop over the explicit restart — the exact R9-3 direction the
    // contract keeps closed.
    mkdirSync(dirname(workspacePath), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({
        version: 1,
        channels: { telegram: 'active' },
        adoptedLegacy: { telegram: 'stopped' },
        adoptedLegacyGeneration: 3,
      }),
      'utf-8',
    );
    writeFileSync(legacyPath, '{not json', 'utf-8');
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      adoptLegacyChannelState(workspace);
    } finally {
      writeSpy.mockRestore();
    }

    // The target survives intact: baseline preserved, restart kept.
    expect(JSON.parse(readFileSync(workspacePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'active' },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyGeneration: 3,
    });

    // Restored legacy content does not re-merge the stale stop: the
    // intact snapshot sees a snapshot-identical entry at the recorded
    // generation — no merge, no re-stop.
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        generation: 3,
        channels: { telegram: 'stopped' },
      }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
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

  it('honors an entry-set-unchanged legacy re-stop the content diff cannot see (R10-5)', () => {
    // The no-workspace stop fallback echoes the WHOLE stored map on
    // every stop, so re-stopping an already-stopped channel re-asserts
    // the SAME entries: the snapshot matches, the content diff drops the
    // re-stop and the explicitly stopped channel resurrects. The moved
    // generation beside unchanged entries is the rewrite signal (#8975).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // The no-workspace stop fallback re-stops through the store: same
    // entries, bumped generation (the production write path).
    new ChannelStateStore(legacyPath).setMany(['telegram'], 'stopped');

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

  it('honors a re-stop masked by a concurrent entry-set-changing rewrite (#8975)', () => {
    // The no-workspace stop fallback echoes the WHOLE stored map on every
    // write, so a re-stop rewrite re-asserts the unchanged entries even
    // when a CONCURRENT new stop also changes the entry set. The plain
    // content diff merges only the new stop and drops the re-stop — the
    // re-stopped channel resurrects on the next `--channel all`, the exact
    // #8975 regression. The generation watermark scopes the detection: it
    // moved MORE than the number of entries added since the snapshot,
    // proving a content-preserving rewrite (the re-stop) happened in
    // between. Legacy created through the store so a generation is
    // recorded from the start.
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // Between two syncs: a re-stop of telegram (content-preserving
    // rewrite, generation bumps) AND a new stop of feishu (the entry set
    // changes).
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    new ChannelStateStore(legacyPath).set('feishu', 'stopped');

    adoptLegacyChannelState(workspace);

    // The re-stop survives the concurrent new stop.
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'stopped',
    });
  });

  it('honors a re-stop batched with a new stop in ONE setMany (R13-10)', () => {
    // The production stop shape: `recordStoppedChannels` stops a
    // service's WHOLE channel list in one `setMany` (stop.ts). A re-stop
    // sharing that single write with a new stop used to bump the
    // generation only once, making `delta > addedSinceSnapshot` false —
    // the re-stop dropped and the explicitly re-stopped channel
    // resurrected on the next `--channel all` (the R12-7 escape the
    // round-12 fix's single-entry coverage missed). The per-entry
    // generation bump gives the batched write per-entry identity: the
    // counter moves by BOTH entries, more than the one added (R14).
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // ONE batched stop of the service's whole channel list: the telegram
    // re-stop plus the new feishu stop.
    new ChannelStateStore(legacyPath).setMany(
      ['telegram', 'feishu'],
      'stopped',
    );

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'stopped',
    });
  });

  it('honors a batched re-stop + new stop at the generation-less legacy boundary (R14-21)', () => {
    // Boundary twin of the R13-10 pin for legacy files materialized
    // WITHOUT a generation (externally written; the sole production
    // writer always stamps). Adoption records the watermark -1; the old
    // `-1` branch fell back to a content-only diff, which can only see
    // entry-set-UNCHANGED rewrites — the first stamped batched write
    // changes the entry set, so a re-stop batched with a new stop was
    // dropped and the explicitly re-stopped channel resurrected. The
    // unified watermark arithmetic gives the first stamped write
    // `g - (-1)` = entries written, the same per-entry semantics as the
    // `>= 0` branch.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // ONE batched stop of the service's whole channel list: the telegram
    // re-stop plus the new feishu stop (the production recordStoppedChannels
    // shape), landing as the first stamped write (generation 1).
    new ChannelStateStore(legacyPath).setMany(
      ['telegram', 'feishu'],
      'stopped',
    );

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'stopped',
    });
  });

  it('does not mistake one batched pure-new-stop write for a re-stop (R13-10)', () => {
    // Control twin of the pin above: a single `setMany` of TWO new stops
    // bumps the generation by exactly the two entries added since the
    // snapshot — no re-stop happened, so the snapshot-identical entries
    // must NOT be re-applied over an explicit restart. The comparison
    // cannot relax to `>=` without resurrecting the R9-3 direction.
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    adoptLegacyChannelState(workspace);
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    new ChannelStateStore(legacyPath).setMany(['feishu', 'slack'], 'stopped');

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
      feishu: 'stopped',
      slack: 'stopped',
    });
  });

  it('does not mistake a single new stop for a re-stop rewrite (#8975)', () => {
    // Control twin of the pin above: one rewrite adding exactly one entry
    // moves the generation by exactly the number of entries added since
    // the snapshot — no content-preserving rewrite happened, so the
    // snapshot-identical entries must NOT be re-applied over an explicit
    // restart (the R9-3 direction stays closed).
    new ChannelStateStore(legacyPath).set('telegram', 'stopped');
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');
    // One new stop only: generation delta 1, one entry added.
    new ChannelStateStore(legacyPath).set('feishu', 'stopped');

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
      feishu: 'stopped',
    });
  });

  it('detects a re-stop rewrite even when the mtime does not move (R11-14)', () => {
    // False-negative pole of the old mtime watermark: on coarse-mtime
    // filesystems (exFAT/FAT32 2 s, some NFS/SMB 1 s) a re-stop rewrite
    // can land in the same granularity tick, leaving the mtime unchanged;
    // the mtime signal missed it and the explicitly re-stopped channel
    // resurrected. The generation lives in the content, so pinning the
    // mtime back to the pre-rewrite value cannot hide the rewrite.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    new ChannelStateStore(workspacePath).set('telegram', 'active');

    const staleMtime = statSync(legacyPath).mtime;
    new ChannelStateStore(legacyPath).setMany(['telegram'], 'stopped');
    // Coarse filesystem: the rewrite lands in the same mtime tick.
    utimesSync(legacyPath, staleMtime, staleMtime);

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('does not treat an external mtime bump with unchanged content as a re-stop (R11-14)', () => {
    // False-positive pole of the old mtime watermark: ANY external mtime
    // movement with unchanged bytes (`touch`, a backup/restore or sync
    // tool re-materializing the file) looked like a whole-map
    // re-assertion and re-applied the snapshot's stops over explicit
    // restarts. External tools cannot forge the generation counter.
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    new ChannelStateStore(workspacePath).set('telegram', 'active');

    // Same bytes, moved mtime — the old watermark's forge signal.
    const future = new Date(Date.now() + 5000);
    utimesSync(legacyPath, future, future);

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'active',
    });
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
    // Rewrite with DIFFERENT content through the store: adds telegram,
    // leaves slack's entry unchanged.
    new ChannelStateStore(legacyPath).setMany(['telegram'], 'stopped');

    adoptLegacyChannelState(workspace);

    // telegram merged via the content diff; slack's explicit restart
    // survives the rewrite.
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      slack: 'active',
      telegram: 'stopped',
    });
  });

  it('merges a rewrite that raced the sync on the NEXT start (R11-2)', () => {
    // The generation watermark lives inside the content, so a racing
    // legacy rewrite can no longer split a stat/read pair (the R11-2
    // hazard class is gone with the mtime watermark): the rewrite either
    // lands before the read — then this sync sees it — or after, and the
    // next sync's diff merges it. Pin the latter half (#8975, R11-14).
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );
    adoptLegacyChannelState(workspace);
    // An explicit restart recorded after adoption.
    new ChannelStateStore(workspacePath).set('telegram', 'active');

    // The rewrite lands between two syncs, adding slack while keeping
    // telegram's entry unchanged.
    new ChannelStateStore(legacyPath).setMany(['slack'], 'stopped');

    adoptLegacyChannelState(workspace);

    // slack merges via the content diff; telegram's snapshot-identical
    // entry is NOT re-applied because the rewrite changed the content
    // (R10-5) — the explicit restart survives, exactly what the old
    // fd-pinning test pinned for the racing shape.
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
      generation: expect.any(Number),
      channels: { telegram: 'active' },
      // Per-entry write epoch stamped on the entry the write named
      // (R15-15).
      entryEpochs: { telegram: expect.any(Number) },
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
      adoptedLegacyGeneration: expect.any(Number),
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
    // Not about the default sink: override it, or the discard warning
    // leaks the process-wide stderr 'error' guard into later tests.
    const store = new ChannelStateStore(filePath, { onWarning: vi.fn() });

    expect(store.readAll()).toEqual({});

    store.set('telegram', 'stopped');
    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
    });
    // The corrupt-recovery rewrite must keep `adoptedLegacy` ABSENT
    // (R16-45): the file existed and its read returned `full ===
    // undefined`, the exact branch whose comment names this case
    // ("predates snapshot recording (or was reseeded from a corrupt
    // read)"). Stamping an empty snapshot here would convert the next
    // adoption from the one-shot baseline branch into the full-merge
    // branch, where every stale legacy stop merges unconditionally over
    // explicit restarts recorded after the corruption — the R9-3/#8975
    // stop-over-restart resurrection. Twin of the R11-27 pin for the
    // valid-but-snapshot-less branch.
    const rewritten = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(rewritten).not.toHaveProperty('adoptedLegacy');
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
      adoptedLegacyGeneration: 1234,
    });
    writeFileSync(filePath, before, 'utf-8');
    const readError = new Error('EBUSY') as NodeJS.ErrnoException;
    readError.code = 'EBUSY';
    let failRead = true;
    // Not about the default sink: override it, or the failed-write
    // warning leaks the process-wide stderr 'error' guard into later
    // tests.
    const store = new ChannelStateStore(filePath, {
      onWarning: vi.fn(),
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
      generation: 0,
      channels: { telegram: 'active' },
      // Per-entry write epoch stamped on the entry the write named
      // (R15-15).
      entryEpochs: { telegram: 0 },
      adoptedLegacy: { telegram: 'stopped' },
      adoptedLegacyGeneration: 1234,
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
    // A malformed snapshot field must not taint the WHOLE file
    // (R11-30): the channel records survive entry-wise and only the
    // snapshot is dropped — whole-file discard here would empty readAll()
    // and let the next `--channel all` select every stopped channel.
    [
      '{"channels": {"telegram": "stopped"}, "adoptedLegacy": "garbage"}',
      { telegram: 'stopped' },
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
      generation: 0,
      channels: { telegram: 'stopped' },
      // Per-entry write epoch stamped on the entry the write named
      // (R15-15): generation 0 is this entry's epoch baseline.
      entryEpochs: { telegram: 0 },
      // A writer-created file records an EMPTY adoption snapshot: `{}`
      // marks 'has seen the legacy file' so a first-ever legacy stop
      // later merges instead of baselining into invisibility; ABSENT
      // stays the marker for files predating snapshot recording (R10-6).
      adoptedLegacy: {},
    });

    // The EMPTY marker must survive subsequent rewrites (R11-40):
    // dropping it on a later write converts the next adoption from the
    // merge branch back into the baseline branch — the R10-6 hazard,
    // reachable through the real stop-before-first-start order (R11-27).
    store.set('telegram', 'active');
    const rewritten = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      adoptedLegacy?: Record<string, string>;
      generation?: number;
    };
    expect(rewritten.adoptedLegacy).toEqual({});
    // Every rewrite bumps the generation watermark (R11-14).
    expect(rewritten.generation).toBe(1);
  });

  it('keeps the snapshot ABSENT when rewriting an existing snapshot-less file (R11-27)', () => {
    // A valid file WITHOUT adoptedLegacy predates snapshot recording (a
    // pre-snapshot relic). Rewriting it must preserve the absence:
    // stamping the empty marker would silently convert the NEXT adoption
    // from the baseline branch into the full-merge branch — the
    // order-dependent R9-3 hazard where a workspace-scoped stop BEFORE
    // the first start lets a stale legacy stop override an explicit
    // restart. Only file CREATION stamps the empty marker (R10-6).
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, channels: { telegram: 'active' } }),
      'utf-8',
    );

    new ChannelStateStore(filePath).set('feishu', 'stopped');

    const rewritten = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      channels: Record<string, string>;
      adoptedLegacy?: unknown;
    };
    expect(rewritten.channels).toEqual({
      telegram: 'active',
      feishu: 'stopped',
    });
    expect(rewritten).not.toHaveProperty('adoptedLegacy');
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

      const listenersBefore = new Set(process.stderr.listeners('error'));
      try {
        new ChannelStateStore(filePath).readAll();
        expect(writeSpy).toHaveBeenCalledWith(
          expect.stringContaining('could not read channel state file'),
        );
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
            adoptedLegacyGeneration: 12345,
          },
          null,
          2,
        ),
        'utf-8',
      );

      store.prune(['telegram']);

      expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
        version: 1,
        generation: 0,
        channels: { telegram: 'stopped' },
        adoptedLegacy: snapshot,
        adoptedLegacyGeneration: 12345,
      });
    });

    it('exempts adopted stops from pruning with preserveAdopted (#8975)', () => {
      // An adopted stop was recorded in ANOTHER workspace or an older
      // release — the population the legacy file exists to serve. Pruning
      // it for an unconfigured channel is doubly fatal: the adoption
      // snapshot still equals the legacy entry afterwards, so no later
      // merge ever re-applies the lost stop, and the explicitly stopped
      // channel connects on every start once it is configured.
      // preserveAdopted exempts snapshot names from the prune; locally
      // recorded entries are still pruned, keeping the
      // removed-and-re-added-starts-fresh semantic for this workspace's
      // own stops.
      writeFileSync(
        filePath,
        JSON.stringify(
          {
            version: 1,
            generation: 0,
            channels: { telegram: 'stopped', feishu: 'stopped' },
            adoptedLegacy: { telegram: 'stopped' },
            adoptedLegacyGeneration: 0,
          },
          null,
          2,
        ),
        'utf-8',
      );
      const store = new ChannelStateStore(filePath);

      const states = store.prune(['discord'], { preserveAdopted: true });

      // telegram (adopted, unconfigured) survives; feishu (locally
      // recorded, absent from the snapshot, unconfigured) is pruned.
      expect(states).toEqual({ telegram: 'stopped' });
      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
      });
      // The snapshot survives the prune write, so a later sync can still
      // re-merge the adopted stop (R10-7 shape).
      expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
        version: 1,
        generation: 1,
        channels: { telegram: 'stopped' },
        adoptedLegacy: { telegram: 'stopped' },
        adoptedLegacyGeneration: 0,
      });
    });

    it('prunes stale locally-recorded entries under a writer-created empty marker (R15-50)', () => {
      // The `adoptedLegacy: {}` marker is the shape most workspaces have
      // (most never adopt — every writer-created file carries it). Both
      // preserveAdopted tests above hand-write NON-empty snapshots, so a
      // regression special-casing the empty marker as 'everything
      // adopted/exempt' (`if (Object.keys(adopted).length === 0) return
      // states;`) would disable pruning for exactly the population that
      // never had a legacy file, ship green, and leave stale `stopped`
      // records for channels removed from settings — re-adding such a
      // channel skips it forever, the precise regression prune prevents.
      const store = new ChannelStateStore(filePath);
      // Writer-created file: three locally-recorded stops, empty marker.
      store.setMany(['telegram', 'feishu', 'discord'], 'stopped');
      expect(
        (
          JSON.parse(readFileSync(filePath, 'utf-8')) as {
            adoptedLegacy?: unknown;
          }
        ).adoptedLegacy,
      ).toEqual({});

      const states = store.prune(['discord'], { preserveAdopted: true });

      // Both stale locally-recorded entries are pruned (nothing adopted to
      // exempt); the configured name survives.
      expect(states).toEqual({ discord: 'stopped' });
      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        discord: 'stopped',
      });
      // The empty marker survives the rewrite, keeping the
      // first-ever-legacy-stop merge branch armed (R10-6).
      expect(
        (
          JSON.parse(readFileSync(filePath, 'utf-8')) as {
            adoptedLegacy?: unknown;
          }
        ).adoptedLegacy,
      ).toEqual({});
    });

    it('still deletes adopted entries on the default prune without opts (#8975)', () => {
      // Unchanged legacy behavior for callers that do not opt in: the
      // default prune treats every unconfigured entry alike, adopted or
      // not. Pin both poles so a preserveAdopted change cannot silently
      // flip the default.
      writeFileSync(
        filePath,
        JSON.stringify(
          {
            version: 1,
            generation: 0,
            channels: { telegram: 'stopped', feishu: 'stopped' },
            adoptedLegacy: { telegram: 'stopped' },
            adoptedLegacyGeneration: 0,
          },
          null,
          2,
        ),
        'utf-8',
      );
      const store = new ChannelStateStore(filePath);

      const states = store.prune(['discord']);

      expect(states).toEqual({});
      expect(new ChannelStateStore(filePath).readAll()).toEqual({});
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

    it('throws on a transient READ failure so the caller fallback actually runs (R13-11)', () => {
      // The initial load must be fail-closed: a transient non-ENOENT
      // read failure means the content is UNKNOWN, not empty. Returning
      // `{}` there (the tolerant readAll shape) let prune succeed on an
      // empty view — selectActiveChannels then resurrected every
      // explicitly stopped channel and the post-connect batched `active`
      // write erased the records permanently, while the documented
      // daemon-worker/start fallback catch stayed dead code for the very
      // failure class it exists for. Driven through the store's
      // `_testReadFileSync` seam (the real read-failure shape), not a
      // mocked throw (R14).
      writeFileSync(
        filePath,
        JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
        'utf-8',
      );
      const readError = new Error('EBUSY') as NodeJS.ErrnoException;
      readError.code = 'EBUSY';
      let failRead = true;
      const store = new ChannelStateStore(filePath, {
        onWarning: vi.fn(),
        _testReadFileSync: (p) => {
          if (failRead) throw readError;
          return readFileSync(p, 'utf-8');
        },
      });

      expect(() => store.prune(['telegram', 'feishu'])).toThrow(readError);
      // The tolerant readAll fallback the callers take stays tolerant:
      // it warns and reports the (unknown-as-empty) view instead of
      // throwing, so startup degrades but never fails (#8975).
      expect(store.readAll()).toEqual({});
      failRead = false;
      expect(store.prune(['telegram', 'feishu'])).toEqual({
        telegram: 'stopped',
      });
    });

    it('treats a CORRUPT file as empty in prune without throwing (R13-11)', () => {
      // The never-fails class: a malformed file is discarded (with a
      // warning) and behaves like an empty map — only transient READ
      // failures throw, so prune's fail-closed load must not convert the
      // corrupt-file contract into a startup failure (#8975).
      writeFileSync(filePath, '{"channels": "garbage"', 'utf-8');
      const onWarning = vi.fn();
      const store = new ChannelStateStore(filePath, { onWarning });

      expect(store.prune(['telegram'])).toEqual({});
      expect(onWarning).toHaveBeenCalledWith(
        expect.stringContaining('treating all channels as active'),
      );
    });
  });

  it('bumps the generation by the number of entries a write sets (R14)', () => {
    // The adoption watermark arithmetic relies on per-entry identity:
    // a batched write must move the counter by the entries written, not
    // by 1, or a re-stop sharing one write with a new stop is invisible
    // (R13-10). A delete-only prune rewrite keeps the monotonic bump.
    // (File creation starts the counter at -1, so the first single-entry
    // write lands at 0 — the pre-R14 shape a new file always showed.)
    const store = new ChannelStateStore(filePath);
    store.setMany(['telegram', 'feishu'], 'stopped');
    let file = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      generation?: number;
    };
    expect(file.generation).toBe(1);

    store.set('slack', 'stopped');
    file = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      generation?: number;
    };
    expect(file.generation).toBe(2);

    store.prune(['telegram']);
    file = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      generation?: number;
    };
    expect(file.generation).toBe(3);
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

      // Production never calls set/setMany directly — every production
      // write goes through the best-effort wrappers (stop.ts, start.ts,
      // daemon-worker.ts, workspace-channel-control.ts,
      // channel-management-service.ts), so the permission pin must drive
      // THOSE entry points too, or a softened trySet/trySetMany write
      // path ships green while the state file lands umask-default
      // world-readable (R11-29).
      expect(store.trySet('slack', 'stopped')).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(looseDir).mode & 0o777).toBe(0o700);

      expect(store.trySetMany(['discord'], 'stopped')).toBe(true);
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

  it('adopts a legacy channel literally named __proto__ (#8975)', () => {
    // Adoption sibling of the store round-trip above: the merge
    // accumulator must stay null-prototype — a plain {} drops `__proto__`
    // entries through the Object.prototype.__proto__ setter, so a
    // no-workspace stop of that name never lands in any workspace file
    // and resurrects on the next all-start. `__proto__` is legitimate
    // config (the reserved filter rejects only `all`).
    const legacyPath = channelRuntimeStatePath();
    const protoWorkspacePath = channelRuntimeStatePath('/workspace/proto');
    mkdirSync(dirname(legacyPath), { recursive: true });
    // JSON.parse/stringify round-trips `__proto__` as an own data key
    // (never the prototype setter), seeding the legacy file safely.
    writeFileSync(
      legacyPath,
      JSON.stringify(
        JSON.parse('{"version":1,"channels":{"__proto__":"stopped"}}'),
      ),
      'utf-8',
    );

    adoptLegacyChannelState('/workspace/proto');

    expect(new ChannelStateStore(protoWorkspacePath).readAll()).toEqual({
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
    // Pin the EXACT rendering (R11-41): a newline-only cleanup mutation
    // (`name.replace(/\n/g, ' ')`) kept the old substring/no-newline
    // oracle green while shipping a different escape. sanitizeLogText
    // renders a real newline as the two-char `\n` escape, so the whole
    // payload is locked, not merely de-newlined.
    expect(message).toBe(
      '[Channel] "evil\\n[Channel] "telegram" connected." skipped ' +
        '(stopped before restart)',
    );
  });

  it('strips the full control set, not just newlines, from skip names (R11-41)', () => {
    // The oracle above could be satisfied by a newline-only cleanup; pin
    // the rest of sanitizeLogText's strip set at this call site: a carriage
    // return (line overwrite), an ESC (ANSI/OSC injection) and the C1/
    // Unicode line breaks (NEL U+0085, U+2028/U+2029) must not reach the
    // rendered message, because both production callers write the skip
    // notice straight to stdout — every one of them forges or corrupts a
    // log line (a stripped CR mapped to a real LF is a forgery too).
    const onSkipped = vi.fn();
    const evilName = 'evil\r\u001b[2J';

    selectActiveChannels([evilName], { [evilName]: 'stopped' }, onSkipped);

    expect(onSkipped).toHaveBeenCalledTimes(1);
    const message = onSkipped.mock.calls[0]![0] as string;
    expect(message).not.toContain('\r');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\u001b');
    expect(message).toContain('skipped (stopped before restart)');

    // The C1/Unicode line-break layer: NEL and the line/paragraph
    // separators render as newlines, so a narrower cleanup that handles
    // ASCII controls but passes them re-opens the same forgery (#8975).
    const unicodeName = 'evil\u0085x\u2028y\u2029z';

    selectActiveChannels(
      [unicodeName],
      { [unicodeName]: 'stopped' },
      onSkipped,
    );

    expect(onSkipped).toHaveBeenCalledTimes(2);
    const unicodeMessage = onSkipped.mock.calls[1]![0] as string;
    expect(unicodeMessage).not.toContain('\u0085');
    expect(unicodeMessage).not.toContain('\u2028');
    expect(unicodeMessage).not.toContain('\u2029');
    // Also pin the ABSENCE of a REAL newline (R14-9): a mutation
    // normalizing NEL/U+2028/U+2029 to a real '\n' passes the raw-char
    // negatives above while re-opening stdout line-forgery — both
    // production callers pass the name to writeStdoutLineBestEffort
    // unguarded, so a real CR/LF in the rendered message forges a second
    // log line, the exact forgery this test's comment says it blocks.
    expect(unicodeMessage).not.toContain('\n');
    expect(unicodeMessage).not.toContain('\r');
    expect(unicodeMessage).toContain('skipped (stopped before restart)');
  });

  it('caps the rendered skip name at 128 code points (#8975)', () => {
    // A stopped channel with a >128-code-point settings key (pasted
    // garbage, shared/managed settings) must not be echoed in full to
    // stdout on every `--channel all` start — the unbounded single-line
    // log growth the cap exists to prevent. Pin the cap at THIS call
    // site: both wiring suites mock selectActiveChannels outright.
    const onSkipped = vi.fn();
    const longName = 'x'.repeat(200);

    const selected = selectActiveChannels(
      [longName],
      { [longName]: 'stopped' },
      onSkipped,
    );

    expect(selected).toEqual([]);
    expect(onSkipped).toHaveBeenCalledTimes(1);
    const message = onSkipped.mock.calls[0]![0] as string;
    // Exactly 128 code points of the name survive the cap.
    expect(message).toContain('x'.repeat(128));
    expect(message).not.toContain('x'.repeat(129));
    expect(message).toContain('skipped (stopped before restart)');
  });

  // Edge-case block (doudouOUC S1): dedicated coverage for the shapes the
  // start paths reach with, beyond the sanitization pins above.

  it('returns an empty selection for empty configured names, even with recorded states', () => {
    const onSkipped = vi.fn();

    expect(selectActiveChannels([], {}, onSkipped)).toEqual([]);
    expect(
      selectActiveChannels([], { telegram: 'stopped' }, onSkipped),
    ).toEqual([]);
    // Nothing configured, nothing selected — no skip notices either: a
    // state entry without a configured name is not a skip event.
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('does not require an onSkipped callback when skipping stopped channels', () => {
    expect(() =>
      selectActiveChannels(['telegram'], { telegram: 'stopped' }),
    ).not.toThrow();
    expect(selectActiveChannels(['telegram'], { telegram: 'stopped' })).toEqual(
      [],
    );
  });

  it('ignores recorded states for channels that are not configured', () => {
    const onSkipped = vi.fn();

    const selected = selectActiveChannels(
      ['telegram'],
      { telegram: 'active', removed: 'stopped', other: 'active' },
      onSkipped,
    );

    expect(selected).toEqual(['telegram']);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('treats channels without recorded state as active alongside explicit entries', () => {
    const onSkipped = vi.fn();

    const selected = selectActiveChannels(
      ['telegram', 'feishu', 'slack'],
      { feishu: 'active' },
      onSkipped,
    );

    expect(selected).toEqual(['telegram', 'feishu', 'slack']);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('accepts a null-prototype state map like the store read paths return', () => {
    // ChannelStateStore.readAll / parseStateFile build null-prototype
    // maps (a channel literally named `__proto__` must round-trip); the
    // filter must read them the same way as plain objects.
    const states = Object.create(null) as Record<string, 'active' | 'stopped'>;
    states['__proto__'] = 'stopped';
    states['telegram'] = 'active';
    const onSkipped = vi.fn();

    const selected = selectActiveChannels(
      ['__proto__', 'telegram'],
      states,
      onSkipped,
    );

    expect(selected).toEqual(['telegram']);
    expect(onSkipped).toHaveBeenCalledTimes(1);
  });
});
