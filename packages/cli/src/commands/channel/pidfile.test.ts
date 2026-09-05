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
const pidfileLock = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  failures: 0,
  failureCode: 'ELOCKED',
}));
const processIdentity = vi.hoisted(() => ({
  currentToken: 'boot-id:current-start' as string | null,
  tokenReads: [] as Array<string | null>,
  localBootId: 'boot-id' as string | null,
  pidNamespace: 4026531836 as number | null,
  namespaceReads: [] as Array<number | null>,
}));

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

vi.mock('proper-lockfile', () => ({
  default: {
    lockSync: (...args: unknown[]) => {
      pidfileLock.acquire(...args);
      if (pidfileLock.failures > 0) {
        pidfileLock.failures -= 1;
        const error = new Error(
          'Lock file is already being held',
        ) as NodeJS.ErrnoException;
        error.code = pidfileLock.failureCode;
        throw error;
      }
      return pidfileLock.release;
    },
  },
}));

vi.mock('@qwen-code/qwen-code-core', () => {
  // Core builds every token from the boot id, so an unreadable boot id makes
  // each read return null and degrades `isSameProcess` to a plain liveness
  // check (process-liveness.ts). Model that coupling, not a stricter one.
  const nextToken = () =>
    processIdentity.localBootId === null
      ? null
      : processIdentity.tokenReads.length > 0
        ? processIdentity.tokenReads.shift()!
        : processIdentity.currentToken;

  return {
    Storage: {
      getGlobalQwenDir: () => mockGlobalQwenDir,
    },
    readProcStartToken: () => nextToken(),
    readLocalBootId: () => processIdentity.localBootId,
    readPidNamespaceId: () =>
      processIdentity.namespaceReads.length > 0
        ? processIdentity.namespaceReads.shift()!
        : processIdentity.pidNamespace,
    isSameProcess: (pid: number, procStart: string | null | undefined) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      const currentToken = nextToken();
      return (
        procStart == null || currentToken == null || procStart === currentToken
      );
    },
  };
});

import {
  readServiceInfo,
  writeServiceInfo,
  writeServeServiceInfo,
  reserveServeServiceInfo,
  removeServiceInfo,
  removeServeServiceInfo,
  signalService,
  waitForExit,
} from './pidfile.js';

// We need to mock process.kill for isSameProcess / signalService.
const originalKill = process.kill;
const originalPlatform = process.platform;

function getPidFilePath() {
  return join(mockGlobalQwenDir, 'channels', 'service.pid');
}

/** A serve reservation another machine wrote into this shared home. */
function seedForeignServeReservation(): string {
  const foreign = JSON.stringify({
    owner: 'serve',
    pid: 4321,
    procStart: 'foreign-boot-id:4321-start',
    pidNs: 4026532999,
    startedAt: '2026-08-26T08:35:25.541Z',
    channels: ['dingtalk'],
    servePid: 4321,
  });
  fsStore[getPidFilePath()] = foreign;
  return foreign;
}

beforeEach(() => {
  for (const k of Object.keys(fsStore)) delete fsStore[k];
  fsFds.next = 3;
  for (const k of Object.keys(fsFds.paths)) delete fsFds.paths[Number(k)];
  for (const k of Object.keys(fsFds.flags)) delete fsFds.flags[Number(k)];
  fsFds.openedFlags.length = 0;
  fsControls.failUnlink = false;
  pidfileLock.acquire.mockClear();
  pidfileLock.release.mockClear();
  pidfileLock.failures = 0;
  pidfileLock.failureCode = 'ELOCKED';
  processIdentity.currentToken = 'boot-id:current-start';
  processIdentity.tokenReads.length = 0;
  processIdentity.localBootId = 'boot-id';
  processIdentity.pidNamespace = 4026531836;
  processIdentity.namespaceReads.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  process.kill = originalKill;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
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
    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:current-start',
    });
  });

  it('retries a transient Linux process-token read before writing', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    processIdentity.tokenReads.push(null, 'boot-id:recovered-start');

    writeServiceInfo(['dingtalk']);

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:recovered-start',
    });
  });

  it('refuses to write an impersonable Linux pidfile', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    processIdentity.tokenReads.push(null, null);

    expect(() => writeServiceInfo(['dingtalk'])).toThrow('process start token');
    expect(getPidFilePath() in fsStore).toBe(false);
  });

  it('refuses to write a Linux pidfile while the boot id is unreadable', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    processIdentity.localBootId = null;

    expect(() => writeServiceInfo(['dingtalk'])).toThrow('process start token');
    expect(getPidFilePath() in fsStore).toBe(false);
  });

  it('retries a transient Linux PID namespace read before writing', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    processIdentity.namespaceReads.push(null);

    writeServiceInfo(['dingtalk']);

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      pidNs: 4026531836,
    });
  });

  it('refuses to write an unreclaimable Linux pidfile', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    processIdentity.pidNamespace = null;

    for (const create of [
      () => writeServiceInfo(['dingtalk']),
      () => reserveServeServiceInfo({ channels: ['dingtalk'], servePid: 4321 }),
      () => writeServeServiceInfo({ channels: ['dingtalk'], servePid: 4321 }),
    ]) {
      expect(create).toThrow('PID namespace id');
      expect(getPidFilePath() in fsStore).toBe(false);
    }
  });

  it('keeps writing a namespace-less pidfile on non-Linux platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    processIdentity.pidNamespace = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    writeServiceInfo(['dingtalk']);

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      pidNs: null,
    });
    expect(readServiceInfo()).toMatchObject({ pidNs: null });
  });

  it('keeps the tokenless fallback on non-Linux platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    processIdentity.currentToken = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    writeServiceInfo(['dingtalk']);

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: null,
    });
    expect(readServiceInfo()).toMatchObject({ procStart: null });
  });

  it('cleans up a pidfile when the live PID belongs to a different process incarnation', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'boot-id:old-start',
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toBeNull();
    expect(filePath in fsStore).toBe(false);
  });

  it('records the writer PID namespace alongside the process token', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    writeServiceInfo(['dingtalk']);

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:current-start',
      pidNs: 4026531836,
    });
  });

  it('keeps a pidfile another machine wrote into this shared home', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'foreign-boot-id:old-start',
      pidNs: 4026531836,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toBeNull();
    expect(filePath in fsStore).toBe(true);
  });

  it('keeps a pidfile another PID namespace wrote on this machine', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'boot-id:old-start',
      pidNs: 4026532999,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toBeNull();
    expect(filePath in fsStore).toBe(true);
  });

  it('keeps a foreign-namespace record whose PID collides with a live local process', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'boot-id:current-start',
      pidNs: 4026532999,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toBeNull();
    expect(filePath in fsStore).toBe(true);
  });

  it('keeps a tokenized pidfile while the local boot id is unreadable', () => {
    const filePath = getPidFilePath();
    processIdentity.localBootId = null;
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'boot-id:old-start',
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toBeNull();
    expect(filePath in fsStore).toBe(true);
  });

  it('sweeps a dead record written without a PID namespace or token', () => {
    const filePath = getPidFilePath();
    processIdentity.pidNamespace = null;
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: null,
      pidNs: null,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    process.kill = vi.fn(() => {
      throw new Error('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    expect(readServiceInfo()).toBeNull();
    expect(filePath in fsStore).toBe(false);
  });

  it('keeps a tokenized pidfile while the local PID namespace is unreadable', () => {
    const filePath = getPidFilePath();
    processIdentity.pidNamespace = null;
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'boot-id:old-start',
      pidNs: 4026532999,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    process.kill = vi.fn(() => {
      throw new Error('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    expect(readServiceInfo()).toBeNull();
    expect(filePath in fsStore).toBe(true);
  });

  it('serializes stale cleanup through the shared pidfile lock', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'boot-id:old-start',
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toBeNull();
    expect(pidfileLock.acquire).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ realpath: false }),
    );
    expect(pidfileLock.release).toHaveBeenCalledOnce();
  });

  it('retries brief synchronous pidfile lock contention', () => {
    pidfileLock.failures = 2;

    expect(readServiceInfo()).toBeNull();
    expect(pidfileLock.acquire).toHaveBeenCalledTimes(3);
    expect(pidfileLock.release).toHaveBeenCalledOnce();
  });

  it('rethrows a lock failure that is not contention without retrying', () => {
    pidfileLock.failures = 1;
    pidfileLock.failureCode = 'EACCES';

    let thrown: NodeJS.ErrnoException | undefined;
    try {
      readServiceInfo();
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    }

    expect(thrown?.code).toBe('EACCES');
    expect(thrown?.message).not.toContain('10 seconds');
    expect(pidfileLock.acquire).toHaveBeenCalledOnce();
    expect(pidfileLock.release).not.toHaveBeenCalled();
  });

  it('keeps legacy live pidfiles that do not carry a process-start token', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(readServiceInfo()).toMatchObject({
      pid: 1234,
      channels: ['dingtalk'],
    });
    expect(filePath in fsStore).toBe(true);
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
    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:current-start',
      pidNs: 4026531836,
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
    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:current-start',
    });
    expect(fsFds.openedFlags).toContain(2 | 0x20000);
  });

  it('preserves the reservation token when serve metadata changes', () => {
    processIdentity.currentToken = 'boot-id:original-start';
    reserveServeServiceInfo({ channels: ['dingtalk'], servePid: 4321 });
    processIdentity.currentToken = 'boot-id:recycled-start';

    writeServeServiceInfo({
      channels: ['dingtalk'],
      servePid: 4321,
      workerPid: 8765,
    });

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:original-start',
      workerPid: 8765,
    });
  });

  it('retries before backfilling a legacy Linux serve reservation', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    fsStore[getPidFilePath()] = JSON.stringify({
      owner: 'serve',
      pid: 4321,
      servePid: 4321,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    processIdentity.tokenReads.push(null, 'boot-id:recovered-start');

    writeServeServiceInfo({
      channels: ['dingtalk'],
      servePid: 4321,
      workerPid: 8765,
    });

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:recovered-start',
      workerPid: 8765,
    });
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
    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      procStart: 'boot-id:current-start',
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

  it('does not let a colliding serve pid overwrite a foreign reservation', () => {
    const reserved = seedForeignServeReservation();

    expect(() =>
      writeServeServiceInfo({
        channels: ['telegram'],
        servePid: 4321,
        workerPid: 8765,
      }),
    ).toThrow('Channel service pidfile is owned by another process.');
    expect(fsStore[getPidFilePath()]).toBe(reserved);
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

    expect(JSON.parse(fsStore[getPidFilePath()]!)).toMatchObject({
      pidNs: 4026531836,
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

  it('names the unverifiable record blocking an exclusive create', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 1234,
      procStart: 'boot-id:old-start',
      pidNs: 4026532999,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    process.kill = vi.fn(() => {
      throw new Error('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    for (const create of [
      () => writeServiceInfo(['dingtalk']),
      () => reserveServeServiceInfo({ channels: ['dingtalk'], servePid: 4321 }),
    ]) {
      let thrown: NodeJS.ErrnoException | undefined;
      try {
        create();
      } catch (err) {
        thrown = err as NodeJS.ErrnoException;
      }

      expect(thrown?.code).toBe('channel_service_conflict');
      expect(thrown?.message).toContain(filePath);
      expect(thrown?.message).toContain('delete');
    }

    expect(filePath in fsStore).toBe(true);
  });

  it('replaces a dead local record blocking an exclusive create', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      owner: 'channel',
      pid: 1234,
      procStart: 'boot-id:current-start',
      pidNs: 4026531836,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });
    process.kill = vi.fn((pid: number) => {
      if (pid === 1234) throw new Error('ESRCH');
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    writeServiceInfo(['telegram']);

    expect(JSON.parse(fsStore[filePath]!)).toMatchObject({
      owner: 'channel',
      pid: process.pid,
      channels: ['telegram'],
    });
  });

  it('replaces an invalid local record blocking an exclusive create', () => {
    const filePath = getPidFilePath();
    fsStore[filePath] = JSON.stringify({
      pid: 0,
      startedAt: '2026-08-26T08:35:25.541Z',
      channels: ['dingtalk'],
    });

    writeServiceInfo(['telegram']);

    expect(JSON.parse(fsStore[filePath]!)).toMatchObject({
      pid: process.pid,
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
        procStart: 42,
        startedAt: new Date().toISOString(),
        channels: ['telegram'],
      },
      {
        pid: 1234,
        procStart: {},
        startedAt: new Date().toISOString(),
        channels: ['telegram'],
      },
      {
        pid: 1234,
        pidNs: 'foreign',
        startedAt: new Date().toISOString(),
        channels: ['telegram'],
      },
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
      throw new Error('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const info = readServiceInfo();
    expect(info).toBeNull();
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

  it('removes only the pidfile matching the expected service identity', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;
    writeServiceInfo(['dingtalk']);
    const info = readServiceInfo()!;

    for (const successor of [
      { ...info, startedAt: '2026-01-01T00:00:00.000Z' },
      { ...info, pid: info.pid + 1 },
      { ...info, procStart: 'boot-id:successor-start' },
      { ...info, owner: 'serve' as const },
    ]) {
      removeServiceInfo(successor);
      expect(getPidFilePath() in fsStore).toBe(true);
    }

    removeServiceInfo(info);
    expect(getPidFilePath() in fsStore).toBe(false);
  });

  it('matches a legacy identity and a tokenless one when removing', () => {
    const filePath = getPidFilePath();
    const legacy = {
      owner: 'channel' as const,
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['dingtalk'],
    };

    fsStore[filePath] = JSON.stringify(legacy);
    removeServiceInfo(legacy);
    expect(filePath in fsStore).toBe(false);

    fsStore[filePath] = JSON.stringify({ ...legacy, procStart: null });
    removeServiceInfo({ ...legacy, procStart: null });
    expect(filePath in fsStore).toBe(false);

    fsStore[filePath] = JSON.stringify({ ...legacy, procStart: null });
    removeServiceInfo(legacy);
    expect(filePath in fsStore).toBe(true);
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

  it('does not remove a foreign serve reservation with a colliding pid', () => {
    const reserved = seedForeignServeReservation();

    expect(removeServeServiceInfo(4321)).toBe(false);
    expect(fsStore[getPidFilePath()]).toBe(reserved);
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
      throw new Error('ESRCH');
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

  it('does not signal a recycled PID when the process token changed', () => {
    processIdentity.currentToken = 'boot-id:new-start';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(signalService(1234, 'SIGKILL', 'boot-id:old-start')).toBe(false);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('does not signal when the current process token is unreadable', () => {
    processIdentity.currentToken = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(signalService(1234, 'SIGKILL', 'boot-id:old-start')).toBe(false);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('delivers the signal when the process token matches', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(signalService(1234, 'SIGTERM', 'boot-id:current-start')).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('retries a transient token read before refusing to signal', () => {
    processIdentity.tokenReads.push(null, 'boot-id:recorded-start');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    expect(signalService(1234, 'SIGTERM', 'boot-id:recorded-start')).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
  });
});

describe('waitForExit', () => {
  it('returns true immediately if process is already dead', async () => {
    process.kill = vi.fn(() => {
      throw new Error('ESRCH');
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
      if (!alive) throw new Error('ESRCH');
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

  it('returns false on timeout when process stays alive', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    const result = await waitForExit(1234, 150, 50);
    expect(result).toBe(false);
  });

  it('treats a recycled PID as the original process having exited', async () => {
    processIdentity.currentToken = 'boot-id:new-start';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.kill = vi.fn(() => true) as any;

    const result = await waitForExit(1234, 1000, 50, 'boot-id:old-start');

    expect(result).toBe(true);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith(1234, 0);
  });
});
