import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// vi.hoisted runs before vi.mock hoisting, so fsStore is available in the factory
const fsStore = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return store;
});
const fsFds = vi.hoisted(() => {
  const fds = {
    next: 3,
    paths: {} as Record<number, string>,
    flags: {} as Record<number, string | number | undefined>,
    openedFlags: [] as Array<string | number | undefined>,
  };
  return fds;
});
const mockGlobalQwenDir = vi.hoisted(() => '/tmp/qwen-pidfile-test/.qwen');
const fsControls = vi.hoisted(() => ({ failUnlink: false }));

vi.mock('node:fs', () => {
  const mock = {
    existsSync: (p: string) => p in fsStore,
    readFileSync: (p: string | number) => {
      if (typeof p === 'number') {
        const fdPath = fsFds.paths[p];
        if (!fdPath) throw new Error('EBADF');
        return fsStore[fdPath] ?? '';
      }
      if (!(p in fsStore)) throw new Error('ENOENT');
      return fsStore[p];
    },
    writeFileSync: (
      p: string,
      data: string,
      options?: string | { flag?: string },
    ) => {
      const flag = typeof options === 'object' ? options.flag : undefined;
      if (flag === 'wx' && p in fsStore) {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      fsStore[p] = data;
    },
    openSync: (p: string, flags?: string | number) => {
      if (!(p in fsStore)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const fd = fsFds.next++;
      fsFds.paths[fd] = p;
      fsFds.flags[fd] = flags;
      fsFds.openedFlags.push(flags);
      return fd;
    },
    closeSync: (fd: number) => {
      delete fsFds.paths[fd];
      delete fsFds.flags[fd];
    },
    ftruncateSync: (fd: number) => {
      const fdPath = fsFds.paths[fd];
      if (!fdPath) throw new Error('EBADF');
      fsStore[fdPath] = '';
    },
    writeSync: (
      fd: number,
      data: string,
      _position?: number,
      _encoding?: BufferEncoding,
    ) => {
      const fdPath = fsFds.paths[fd];
      if (!fdPath) throw new Error('EBADF');
      fsStore[fdPath] = data;
      return data.length;
    },
    mkdirSync: () => {},
    unlinkSync: (p: string) => {
      if (fsControls.failUnlink) throw new Error('EPERM');
      delete fsStore[p];
    },
    constants: {
      O_RDWR: 2,
      O_NOFOLLOW: 0x20000,
    },
  };
  return { ...mock, default: mock };
});

vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: {
    getGlobalQwenDir: () => mockGlobalQwenDir,
  },
}));

import {
  peekServiceInfo,
  readServiceInfo,
  writeServiceInfo,
  writeServeServiceInfo,
  reserveServeServiceInfo,
  removeServiceInfo,
  removeServeServiceInfo,
  signalService,
  classifyProcessAccess,
  waitForExit,
} from './pidfile.js';

// We need to mock process.kill for isProcessAlive / signalService
const originalKill = process.kill;

// Real Node `process.kill(pid, 0)` rejections carry an errno `.code`; the
// liveness helpers key on `code === 'ESRCH'` to tell a CONFIRMED-dead pid
// apart from an alive-but-unsignalable one (EPERM, #8975). Mirror that.
function errnoError(code: 'ESRCH' | 'EPERM'): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function getPidFilePath() {
  return join(mockGlobalQwenDir, 'channels', 'service.pid');
}

beforeEach(() => {
  for (const k of Object.keys(fsStore)) delete fsStore[k];
  fsFds.next = 3;
  for (const k of Object.keys(fsFds.paths)) delete fsFds.paths[Number(k)];
  for (const k of Object.keys(fsFds.flags)) delete fsFds.flags[Number(k)];
  fsFds.openedFlags.length = 0;
  fsControls.failUnlink = false;
});

afterEach(() => {
  vi.useRealTimers();
  process.kill = originalKill;
});

describe('writeServiceInfo + readServiceInfo', () => {
  it('writes and reads back service info for a live process', () => {
    // Mock process.kill(pid, 0) to indicate alive
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    writeServiceInfo(['telegram', 'dingtalk']);
    const info = readServiceInfo();

    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
    expect(info!.owner).toBe('channel');
    expect(info!.channels).toEqual(['telegram', 'dingtalk']);
    expect(info!.startedAt).toBeTruthy();
  });

  it('treats legacy pidfiles without owner as standalone channel services', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    const info = readServiceInfo();

    expect(info).toMatchObject({
      pid: 1234,
      owner: 'channel',
      channels: ['telegram'],
    });
    expect(info).not.toHaveProperty('workspaceCwd');
  });

  it('round-trips the standalone workspace for per-workspace state (#8975)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    writeServiceInfo(['telegram'], '/workspace/a');

    expect(readServiceInfo()).toMatchObject({
      owner: 'channel',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    // Pin the ON-DISK key itself (T4): a consistent rename in writer +
    // parser keeps the write-then-read round-trip above green while
    // silently changing the pidfile contract the per-workspace stop
    // recording depends on.
    const raw = JSON.parse(fsStore[getPidFilePath()] ?? '') as {
      workspaceCwd?: string;
    };
    expect(raw.workspaceCwd).toBe('/workspace/a');
  });

  it('parses a hand-written pidfile carrying workspaceCwd (#8975)', () => {
    // Pins the parse path directly (not just write-then-read): the field
    // declaration on ServiceInfo is type-only, so without this a refactor
    // dropping it from the parser would ship green.
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      owner: 'channel',
      pid: 1234,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toMatchObject({
      owner: 'channel',
      pid: 1234,
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
  });

  describe('peekServiceInfo (#8975)', () => {
    it('returns parsed info without the liveness check and without unlinking', () => {
      const filePath = getPidFilePath();
      fsStore[filePath] = JSON.stringify({
        owner: 'channel',
        pid: 424242,
        startedAt: new Date().toISOString(),
        channels: ['telegram'],
        workspaceCwd: '/workspace/a',
      });
      // A dead process: readServiceInfo unlinks and returns null, but the
      // peek must still capture the channels for the crashed-service stop.
      const deadPid = (): never => {
        throw errnoError('ESRCH');
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.kill = vi.fn(deadPid) as any;

      expect(peekServiceInfo()).toMatchObject({
        owner: 'channel',
        pid: 424242,
        channels: ['telegram'],
        workspaceCwd: '/workspace/a',
      });
      expect(filePath in fsStore).toBe(true);

      expect(readServiceInfo()).toBeNull();
      expect(filePath in fsStore).toBe(false);
    });

    it('treats an EPERM pid as ALIVE under another user (#8975)', () => {
      // `kill(pid, 0)` throwing EPERM means the process EXISTS but belongs
      // to another user (a shared HOME/QWEN_HOME). The old code lumped it
      // with ESRCH, reported the live service as crashed, and the stop
      // crash-path recorded its RUNNING channels as stopped. readServiceInfo
      // must return the info and keep the pidfile; classifyProcessAccess is
      // the guard that tells the stop it cannot act (R14-8).
      const filePath = getPidFilePath();
      fsStore[filePath] = JSON.stringify({
        owner: 'channel',
        pid: 424242,
        startedAt: new Date().toISOString(),
        channels: ['telegram'],
        workspaceCwd: '/workspace/a',
      });

      process.kill = vi.fn((): never => {
        throw errnoError('EPERM');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      expect(readServiceInfo()).toMatchObject({
        owner: 'channel',
        pid: 424242,
        channels: ['telegram'],
      });
      expect(filePath in fsStore).toBe(true);
      expect(classifyProcessAccess(424242)).toBe('other-user');
    });

    it('returns null for a missing or corrupt pidfile', () => {
      expect(peekServiceInfo()).toBeNull();

      fsStore[getPidFilePath()] = '{not json';
      expect(peekServiceInfo()).toBeNull();
    });
  });

  it.each([
    // Empty string AND non-string values must both be rejected: a pidfile
    // carrying `workspaceCwd: 123` would otherwise flow into
    // channelRuntimeStatePath → hashDaemonWorkspace → createHash().update()
    // and crash `qwen channel stop` with ERR_INVALID_ARG_TYPE outside
    // trySetMany's try/catch (#8975).
    ['empty string', ''],
    ['non-string (number)', 123],
    ['non-string (object)', {}],
  ])('rejects pidfiles with a malformed workspaceCwd: %s', (_label, value) => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      owner: 'channel',
      pid: 1234,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
      workspaceCwd: value,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(peekServiceInfo()).toBeNull();
    expect(readServiceInfo()).toBeNull();
  });

  it('writes and reads serve-owned service info for a live serve process', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    writeServeServiceInfo({
      channels: ['telegram', 'feishu'],
      servePid: 4321,
      workerPid: 8765,
    });
    const info = readServiceInfo();

    expect(info).toMatchObject({
      pid: 4321,
      owner: 'serve',
      servePid: 4321,
      workerPid: 8765,
      channels: ['telegram', 'feishu'],
    });
  });

  it('round-trips multi-workspace worker metadata', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    const workers = [
      {
        workspaceId: 'primary',
        workspaceCwd: '/work/primary',
        channels: ['telegram'],
        workerPid: 8765,
      },
      {
        workspaceId: 'secondary',
        workspaceCwd: '/work/secondary',
        channels: ['feishu'],
      },
    ];

    writeServeServiceInfo({
      channels: ['telegram', 'feishu'],
      servePid: 4321,
      workerPid: 8765,
      workers,
    });

    expect(readServiceInfo()).toMatchObject({ workers });
  });

  it('updates a matching serve-owned reservation with worker metadata', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    reserveServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
    });
    writeServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
      workerPid: 8765,
    });

    expect(readServiceInfo()).toMatchObject({
      owner: 'serve',
      pid: 4321,
      servePid: 4321,
      workerPid: 8765,
      channels: ['telegram'],
    });
    expect(fsFds.openedFlags).toContain(2 | 0x20000);
  });

  it('preserves the serve reservation start time when worker metadata changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T01:00:00.000Z'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    reserveServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
    });
    vi.setSystemTime(new Date('2026-07-01T01:05:00.000Z'));
    writeServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
      workerPid: 8765,
    });

    expect(readServiceInfo()).toMatchObject({
      owner: 'serve',
      pid: 4321,
      servePid: 4321,
      workerPid: 8765,
      channels: ['telegram'],
      startedAt: '2026-07-01T01:00:00.000Z',
    });
  });

  it('does not let serve metadata updates overwrite standalone pidfiles', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    writeServiceInfo(['telegram']);

    expect(() =>
      writeServeServiceInfo({
        channels: ['telegram'],
        servePid: 4321,
        workerPid: 8765,
      }),
    ).toThrow('Channel service pidfile is owned by another process.');
    expect(readServiceInfo()).toMatchObject({
      owner: 'channel',
      pid: process.pid,
      channels: ['telegram'],
    });
  });

  it('does not let one serve process overwrite another serve reservation', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    reserveServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
    });

    expect(() =>
      writeServeServiceInfo({
        channels: ['telegram'],
        servePid: 9999,
        workerPid: 8765,
      }),
    ).toThrow('Channel service pidfile is owned by another process.');
    expect(readServiceInfo()).toMatchObject({
      owner: 'serve',
      pid: 4321,
      servePid: 4321,
      channels: ['telegram'],
    });
  });

  it('does not let serve metadata updates overwrite corrupt pidfiles', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = 'not-json!!!';

    let thrown: NodeJS.ErrnoException | undefined;
    try {
      writeServeServiceInfo({
        channels: ['telegram'],
        servePid: 4321,
        workerPid: 8765,
      });
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe('EEXIST');
    expect(thrown?.message).toBe(
      'Channel service pidfile is owned by another process.',
    );
    expect(fsStore[filePath]).toBe('not-json!!!');
  });

  it('reserves serve-owned service info with exclusive create', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    reserveServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
    });

    expect(() =>
      reserveServeServiceInfo({
        channels: ['telegram'],
        servePid: 5678,
      }),
    ).toThrow('EEXIST');
    expect(readServiceInfo()).toMatchObject({
      owner: 'serve',
      pid: 4321,
      servePid: 4321,
      channels: ['telegram'],
    });
  });

  it('does not let standalone startup overwrite a serve-owned reservation', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    reserveServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
    });

    expect(() => writeServiceInfo(['telegram'])).toThrow('EEXIST');
    expect(readServiceInfo()).toMatchObject({
      owner: 'serve',
      pid: 4321,
      servePid: 4321,
      channels: ['telegram'],
    });
  });

  it('returns null when no PID file exists', () => {
    const info = readServiceInfo();
    expect(info).toBeNull();
  });

  it('cleans up and returns null for corrupt PID file', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = 'not-json!!!';

    const info = readServiceInfo();
    expect(info).toBeNull();
    // File should be cleaned up
    expect(filePath in fsStore).toBe(false);
  });

  it('cleans up and returns null for a pidfile with pid 0', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 0,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    const info = readServiceInfo();

    expect(info).toBeNull();
    expect(process.kill).not.toHaveBeenCalled();
    expect(filePath in fsStore).toBe(false);
  });

  it('cleans up and returns null for malformed service info', () => {
    const filePath = getPidFilePath();
    const invalidPidfiles = [
      { pid: -1, startedAt: new Date().toISOString(), channels: ['telegram'] },
      { pid: 1.5, startedAt: new Date().toISOString(), channels: ['telegram'] },
      {
        pid: '1234',
        startedAt: new Date().toISOString(),
        channels: ['telegram'],
      },
      { pid: 1234, startedAt: 'not-a-date', channels: ['telegram'] },
      { pid: 1234, startedAt: new Date().toISOString(), channels: 'telegram' },
      { pid: 1234, startedAt: new Date().toISOString(), channels: [42] },
      {
        pid: 1234,
        startedAt: new Date().toISOString(),
        channels: [],
        workers: 'invalid',
      },
      {
        pid: 1234,
        startedAt: new Date().toISOString(),
        channels: [],
        workers: [{}],
      },
      {
        pid: 1234,
        startedAt: new Date().toISOString(),
        channels: [],
        workers: [{ channels: [], workspaceId: 42 }],
      },
      {
        pid: 1234,
        startedAt: new Date().toISOString(),
        channels: [],
        workers: [{ channels: [], workerPid: 0 }],
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    for (const info of invalidPidfiles) {
      fsStore[filePath] = JSON.stringify(info);
      expect(readServiceInfo()).toBeNull();
      expect(filePath in fsStore).toBe(false);
    }

    expect(process.kill).not.toHaveBeenCalled();
  });

  it('cleans up and returns null for stale PID (dead process)', () => {
    // First write with alive process
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    writeServiceInfo(['telegram']);

    // Now simulate dead process

    process.kill = vi.fn(() => {
      throw errnoError('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const info = readServiceInfo();
    expect(info).toBeNull();
  });
});

describe('writeServiceInfo stale-pidfile recovery (doudouOUC C1)', () => {
  // SIGKILL/OOM and any process.exit() past the SIGINT/SIGTERM handlers
  // leave the pidfile dangling; the exclusive-create refusal must not
  // block the next start on a DEAD owner's leftover (mirrors the
  // serve-side reservation flow's liveness check).

  function seedStalePidfile(pid: number): void {
    fsStore[getPidFilePath()] = JSON.stringify({
      owner: 'channel',
      pid,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
  }

  it('replaces a stale pidfile left by a confirmed-dead process', () => {
    seedStalePidfile(999999);
    process.kill = vi.fn((pid: number, signal?: number | string) => {
      if (pid === 999999 && (signal === 0 || signal === undefined)) {
        throw errnoError('ESRCH');
      }
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    expect(() => writeServiceInfo(['feishu'], '/ws')).not.toThrow();

    const written = JSON.parse(fsStore[getPidFilePath()] ?? '') as {
      owner: string;
      pid: number;
      channels: string[];
      workspaceCwd?: string;
    };
    expect(written.owner).toBe('channel');
    expect(written.pid).toBe(process.pid);
    expect(written.channels).toEqual(['feishu']);
    expect(written.workspaceCwd).toBe('/ws');
  });

  it('replaces a corrupt pidfile blocking the exclusive create', () => {
    fsStore[getPidFilePath()] = 'not-json!!!';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(() => writeServiceInfo(['feishu'])).not.toThrow();

    const written = JSON.parse(fsStore[getPidFilePath()] ?? '') as {
      pid: number;
      channels: string[];
    };
    expect(written.pid).toBe(process.pid);
    expect(written.channels).toEqual(['feishu']);
  });

  it('still refuses when the existing pidfile belongs to a live process', () => {
    seedStalePidfile(4321);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(() => writeServiceInfo(['feishu'])).toThrow('EEXIST');
    // The live owner's reservation is untouched.
    expect(JSON.parse(fsStore[getPidFilePath()] ?? '').pid).toBe(4321);
  });

  it('still refuses when the existing pid is alive under another user (EPERM)', () => {
    seedStalePidfile(4321);
    process.kill = vi.fn(() => {
      throw errnoError('EPERM');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    expect(() => writeServiceInfo(['feishu'])).toThrow('EEXIST');
    expect(JSON.parse(fsStore[getPidFilePath()] ?? '').pid).toBe(4321);
  });
});

describe('removeServiceInfo', () => {
  it('removes existing PID file', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    writeServiceInfo(['test']);
    removeServiceInfo();

    const info = readServiceInfo();
    expect(info).toBeNull();
  });

  it('is a no-op when no PID file exists', () => {
    expect(() => removeServiceInfo()).not.toThrow();
  });
});

describe('removeServeServiceInfo', () => {
  it('removes only a serve-owned pidfile for the matching serve pid', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    writeServeServiceInfo({
      channels: ['telegram'],
      servePid: 4321,
      workerPid: 8765,
    });

    expect(removeServeServiceInfo(9999)).toBe(false);
    expect(readServiceInfo()).toMatchObject({
      owner: 'serve',
      servePid: 4321,
    });

    expect(removeServeServiceInfo(4321)).toBe(true);
    expect(readServiceInfo()).toBeNull();
  });

  it('does not remove standalone channel-owned pidfiles', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    writeServiceInfo(['telegram']);

    expect(removeServeServiceInfo(process.pid)).toBe(false);
    expect(readServiceInfo()).toMatchObject({
      owner: 'channel',
      pid: process.pid,
    });
  });

  it('returns false when the owned pidfile cannot be unlinked', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    writeServeServiceInfo({ channels: ['telegram'], servePid: 4321 });
    fsControls.failUnlink = true;

    expect(removeServeServiceInfo(4321)).toBe(false);
    expect(readServiceInfo()).toMatchObject({
      owner: 'serve',
      servePid: 4321,
    });
  });
});

describe('signalService', () => {
  it('returns true when signal is delivered', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    expect(signalService(1234, 'SIGTERM')).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('returns false when process is not found', () => {
    process.kill = vi.fn(() => {
      throw errnoError('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(signalService(9999)).toBe(false);
  });

  it('defaults to SIGTERM', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    signalService(1234);
    expect(process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('returns false for pid 0 without sending a signal', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    expect(signalService(0)).toBe(false);
    expect(process.kill).not.toHaveBeenCalled();
  });
});

describe('classifyProcessAccess (#8975, R14-26)', () => {
  // Direct pins on the classification the stop's dead-window branch keys
  // on: the 'other-user' vs 'dead' distinction is exactly the collapse
  // the function exists to prevent, and no other suite exercises it
  // unmocked. Flipping the ternary to pre-#8975 semantics (EPERM →
  // 'dead') must fail here: stop would then unlink another user's LIVE
  // shared-HOME pidfile and record its RUNNING channels as stopped.
  it('returns signalable for a live process', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    expect(classifyProcessAccess(1234)).toBe('signalable');
  });

  it('returns dead on ESRCH (confirmed dead)', () => {
    process.kill = vi.fn(() => {
      throw errnoError('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(classifyProcessAccess(9999)).toBe('dead');
  });

  it('returns other-user on EPERM (alive but owned by another user)', () => {
    process.kill = vi.fn(() => {
      throw errnoError('EPERM');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(classifyProcessAccess(424242)).toBe('other-user');
  });

  it('returns dead for an invalid pid without signaling', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    expect(classifyProcessAccess(0)).toBe('dead');
    expect(process.kill).not.toHaveBeenCalled();
  });
});

describe('waitForExit', () => {
  it('returns true immediately if process is already dead', async () => {
    process.kill = vi.fn(() => {
      throw errnoError('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const result = await waitForExit(9999, 1000, 50);
    expect(result).toBe(true);
  });

  it('treats pid 0 as already exited without polling it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    const result = await waitForExit(0, 1000, 50);

    expect(result).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('returns true when process dies within timeout', async () => {
    let alive = true;

    process.kill = vi.fn(() => {
      if (!alive) throw errnoError('ESRCH');
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    // Kill after 100ms
    setTimeout(() => {
      alive = false;
    }, 100);

    const result = await waitForExit(1234, 2000, 50);
    expect(result).toBe(true);
  });

  it('keeps waiting (times out) for an alive-but-EPERM pid (#8975)', async () => {
    // Another user's process can never be observed as dead from here;
    // waitForExit must not report it exited, or the stop path proceeds as
    // if the service tore down. EPERM is "still running", so the poll
    // runs to the timeout and reports false (#8975).
    process.kill = vi.fn(() => {
      throw errnoError('EPERM');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const result = await waitForExit(424242, 150, 50);
    expect(result).toBe(false);
  });

  it('returns false on timeout when process stays alive', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    const result = await waitForExit(1234, 150, 50);
    expect(result).toBe(false);
  });
});
