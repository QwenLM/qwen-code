import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// vi.hoisted runs before vi.mock hoisting, so fsStore is available in the factory
const fsStore = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return store;
});
const mockGlobalQwenDir = vi.hoisted(() => '/tmp/qwen-pidfile-test/.qwen');

vi.mock('node:fs', () => {
  const mock = {
    existsSync: (p: string) => p in fsStore,
    readFileSync: (p: string) => {
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
    mkdirSync: () => {},
    unlinkSync: (p: string) => {
      delete fsStore[p];
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
  readServiceInfo,
  writeServiceInfo,
  writeServeServiceInfo,
  reserveServeServiceInfo,
  removeServiceInfo,
  removeServeServiceInfo,
  signalService,
  waitForExit,
} from './pidfile.js';

// We need to mock process.kill for isProcessAlive / signalService
const originalKill = process.kill;

function getPidFilePath() {
  return join(mockGlobalQwenDir, 'channels', 'service.pid');
}

beforeEach(() => {
  for (const k of Object.keys(fsStore)) delete fsStore[k];
});

afterEach(() => {
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
});
