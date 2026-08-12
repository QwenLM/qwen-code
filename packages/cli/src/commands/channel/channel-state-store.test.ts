import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    expect(channelRuntimeStatePath('/workspace/a')).toBe(
      join(
        getStateHome(),
        'channels',
        'standalone',
        hashDaemonWorkspace('/workspace/a'),
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

  it('seeds the workspace file from the legacy global file and removes it', () => {
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(channelRuntimeStatePath(), legacyBody, 'utf-8');

    adoptLegacyChannelState(workspace);

    expect(readFileSync(workspacePath, 'utf-8')).toBe(legacyBody);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
    // Pin the deliberate restrictive permissions on the adopted file and
    // its directory: the legacy file was written by an older release at
    // default umask, and adoption exists to normalize it (#8975).
    expect(statSync(workspacePath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(workspacePath)).mode & 0o777).toBe(0o700);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('keeps an existing workspace file untouched', () => {
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { feishu: 'stopped' } }),
      'utf-8',
    );
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
    // The legacy file is left alone once the workspace file exists.
    expect(existsSync(legacyPath)).toBe(true);
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
      // A failed adoption must leave a diagnostic trail: the existsSync
      // guard can lock adoption out permanently once any later write
      // creates the workspace file, so a resurrection of the legacy stops
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
    // leave no target behind, or the existsSync guard would treat it as a
    // completed adoption and skip adoption forever.
    mkdirSync(legacyPath, { recursive: true });

    expect(() => adoptLegacyChannelState(workspace)).not.toThrow();

    expect(existsSync(workspacePath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);

    // Once the condition clears, adoption proceeds normally.
    rmSync(legacyPath, { recursive: true, force: true });
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(legacyPath, legacyBody, 'utf-8');
    adoptLegacyChannelState(workspace);
    expect(readFileSync(workspacePath, 'utf-8')).toBe(legacyBody);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('leaves no target behind when the atomic write fails mid-copy (#8975)', () => {
    // Simulate the disk failure at the WRITE stage (ENOSPC mid-copy),
    // which a read-side obstacle cannot reach: the legacy file reads fine,
    // then the atomic write itself fails. A non-atomic replacement that
    // creates/truncates the target directly would leave a partial file the
    // existsSync guard mistakes for a completed adoption — orphaning the
    // legacy stops forever.
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
    expect(readFileSync(workspacePath, 'utf-8')).toBe(legacyBody);
    expect(existsSync(legacyPath)).toBe(false);
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

  it.each([
    // The third element is the expected discard-warning count: the warning
    // is the only diagnostic trail of the lost records, so pin it on every
    // discard branch; entry-wise filtering must NOT warn (#8975).
    ['[]', {}, 1],
    ['"stopped"', {}, 1],
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
      const store = new ChannelStateStore(filePath, { onWarning: vi.fn() });

      expect(store.trySet('telegram', 'stopped')).toBe(true);
      expect(store.trySetMany(['feishu', 'slack'], 'active')).toBe(true);

      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
        feishu: 'active',
        slack: 'active',
      });
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

      try {
        // No onWarning override: exercises the default stderr sink.
        expect(new ChannelStateStore(filePath).readAll()).toEqual({});
        // Let the async 'error' event fire; without the guard it would
        // surface as an uncaught exception and fail this test.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        writeSpy.mockRestore();
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
  });

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
