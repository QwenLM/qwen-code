/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { OwnedPosixProcessGroup } from './posix-process-group.js';

const { read, list, boot } = vi.hoisted(() => ({
  read: vi.fn(),
  list: vi.fn(),
  boot: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: read,
  readdirSync: list,
}));
vi.mock('../utils/process-liveness.js', () => ({ readLocalBootId: boot }));

interface FixtureMember {
  pid: number;
  start: string;
  state: string;
  pgid: number;
  sid: number;
}

const PGID = 4100;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const members = new Map<number, FixtureMember>();
const owners: OwnedPosixProcessGroup[] = [];
let kill: MockInstance<typeof process.kill>;
let signalAction: (signal: string | number | undefined) => void;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function member(pid: number, overrides: Partial<FixtureMember> = {}) {
  const fixture = {
    pid,
    start: String(pid * 10),
    state: 'S',
    pgid: PGID,
    sid: PGID,
    ...overrides,
  };
  members.set(pid, fixture);
  return fixture;
}

function stat(fixture: FixtureMember): string {
  const fields = Array<string>(20).fill('0');
  fields[0] = fixture.state;
  fields[1] = '4000';
  fields[2] = String(fixture.pgid);
  fields[3] = String(fixture.sid);
  fields[19] = fixture.start;
  return `${fixture.pid} (owned ) fixture) ${fields.join(' ')}`;
}

function own(pid = PGID): OwnedPosixProcessGroup {
  const owner = new OwnedPosixProcessGroup(pid);
  owners.push(owner);
  return owner;
}

function signals(): Array<string | number | undefined> {
  return kill.mock.calls
    .map(([, signal]) => signal)
    .filter((signal) => signal !== 0);
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
  });
  members.clear();
  member(PGID);
  member(PGID + 1);
  boot.mockReturnValue('00000000-0000-0000-0000-000000000000');
  list.mockImplementation(() =>
    [...members.keys()].map(String).concat('self', 'sys'),
  );
  read.mockImplementation((file: unknown) => {
    const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(String(file))?.[1]);
    const fixture = members.get(pid);
    if (!fixture) throw errno('ENOENT');
    return stat(fixture);
  });
  signalAction = (signal) => {
    if (signal === 'SIGKILL') {
      for (const fixture of members.values()) fixture.state = 'Z';
    }
  };
  kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== -PGID) throw new Error(`Rejected nonfixture target ${pid}`);
    if (!members.size) throw errno('ESRCH');
    signalAction(signal);
    return true;
  });
});

afterEach(() => {
  for (const owner of owners.splice(0)) owner.release();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', platform);
});

describe('OwnedPosixProcessGroup', () => {
  it('escalates surviving descendants after their TERM-responsive leader exits', async () => {
    const owner = own();
    signalAction = (signal) => {
      if (signal === 'SIGTERM') members.delete(PGID);
      if (signal === 'SIGKILL') members.get(PGID + 1)!.state = 'Z';
    };
    let completed = false;
    const completion = owner.cancel().then((error) => {
      completed = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(completed).toBe(false);
    expect(signals()).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await completion).toBeNull();
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('waits for post-KILL disappearance instead of equating dispatch to termination', async () => {
    signalAction = () => {};
    const owner = own();
    let completed = false;
    const completion = owner.cancel().then((error) => {
      completed = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(completed).toBe(false);
    members.clear();
    await vi.advanceTimersByTimeAsync(25);
    expect(await completion).toBeNull();
  });

  it('reports bounded incomplete cleanup when SIGKILL dispatch leaves survivors', async () => {
    signalAction = () => {};
    const completion = own().cancel();
    await vi.advanceTimersByTimeAsync(400);
    expect((await completion)?.message).toContain('did not stop after SIGKILL');
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it.each([-86_400_000, 86_400_000])(
    'keeps grace and confirmation bounded across a wall-clock jump of %s ms',
    async (jump) => {
      signalAction = () => {};
      const wallTime = Date.now();
      let completed = false;
      const completion = own()
        .cancel()
        .then((error) => {
          completed = true;
          return error;
        });
      vi.setSystemTime(wallTime + jump);
      await vi.advanceTimersByTimeAsync(199);
      expect(completed).toBe(false);
      expect(signals()).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
      expect(completed).toBe(false);
      vi.setSystemTime(wallTime - jump);
      await vi.advanceTimersByTimeAsync(199);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await completion)?.message).toContain(
        'did not stop after SIGKILL',
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not escalate when TERM leaves no survivors', async () => {
    signalAction = (signal) => {
      if (signal === 'SIGTERM') members.clear();
    };
    expect(await own().cancel()).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(signals()).toEqual(['SIGTERM']);
  });

  it('uses zombie witnesses to authenticate live descendants', async () => {
    signalAction = (signal) => {
      if (signal === 'SIGTERM') {
        members.get(PGID)!.state = 'Z';
        members.get(PGID + 1)!.state = 'Z';
        member(PGID + 2);
      }
      if (signal === 'SIGKILL') members.get(PGID + 2)!.state = 'Z';
    };
    const completion = own().cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(await completion).toBeNull();
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('considers an authenticated group of zombies stopped', async () => {
    for (const fixture of members.values()) fixture.state = 'Z';
    expect(await own().cancel()).toBeNull();
    expect(signals()).toEqual([]);
  });

  it('keeps cleanup pending when enumeration omits a still-running recorded descendant', async () => {
    list.mockImplementation(() =>
      signals().includes('SIGTERM') ? [] : [...members.keys()].map(String),
    );
    signalAction = (signal) => {
      if (signal === 'SIGTERM') members.delete(PGID);
      if (signal === 'SIGKILL') members.get(PGID + 1)!.state = 'Z';
    };
    let completed = false;
    const completion = own()
      .cancel()
      .then((error) => {
        completed = true;
        return error;
      });
    await vi.advanceTimersByTimeAsync(199);
    expect(completed).toBe(false);
    expect(signals()).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await completion).toBeNull();
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it.each(['SIGTERM', 0, 'SIGKILL'] as const)(
    'latches ESRCH at %s and never signals again',
    async (target) => {
      let termSent = false;
      signalAction = (signal) => {
        if (signal === 'SIGTERM') termSent = true;
        if (signal === target && (target !== 0 || termSent))
          throw errno('ESRCH');
      };
      const owner = own();
      const completion = owner.cancel();
      await vi.advanceTimersByTimeAsync(500);
      expect(await completion).toBeNull();
      const calls = kill.mock.calls.length;
      owner.force();
      owner.cancel();
      await vi.advanceTimersByTimeAsync(500);
      expect(kill.mock.calls).toHaveLength(calls);
    },
  );

  it.each(['EPERM', 'EIO'])(
    'reports %s on failed TERM and KILL without a leader fallback',
    async (code) => {
      signalAction = (signal) => {
        if (signal !== 0) throw errno(code);
      };
      const completion = own().cancel();
      await vi.advanceTimersByTimeAsync(400);
      const error = await completion;
      expect(error?.message).toContain('did not stop after SIGKILL');
      expect((error?.cause as Error).message).toContain(
        'Could not send SIGKILL',
      );
      expect(
        ((error?.cause as Error).cause as NodeJS.ErrnoException).code,
      ).toBe(code);
      expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
      expect(kill.mock.calls.every(([pid]) => pid === -PGID)).toBe(true);
    },
  );

  it('does not misread EPERM probes as group disappearance', async () => {
    signalAction = (signal) => {
      if (signal === 0) throw errno('EPERM');
      if (signal === 'SIGKILL')
        for (const fixture of members.values()) fixture.state = 'Z';
    };
    const completion = own().cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(await completion).toBeNull();
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports unexpected probe errors without destructive signals', async () => {
    signalAction = (signal) => {
      if (signal === 0) throw errno('EIO');
    };
    expect((await own().cancel())?.message).toContain('Could not inspect');
    expect(signals()).toEqual([]);
  });

  it.each([
    0,
    1,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('refuses invalid PGID %s', async (pid) => {
    expect(await own(pid).cancel()).toBeInstanceOf(Error);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses an original leader whose birth identity was recycled before cancellation', async () => {
    const owner = own();
    member(PGID, { start: '999999' });
    expect((await owner.cancel())?.message).toContain(
      'original leader identity',
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it('captures birth before setsid completes without adopting a new birth', async () => {
    member(PGID, { pgid: 4000, sid: 4000 });
    const owner = own();
    member(PGID);
    const completion = owner.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(await completion).toBeNull();
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it.each(['pgid', 'sid'] as const)(
    'refuses a changed original %s before cancellation',
    async (field) => {
      const owner = own();
      members.get(PGID)![field] = 4500;
      expect((await owner.cancel())?.message).toContain('isolation changed');
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it('refuses an unobserved recycled group after every recorded member disappeared', async () => {
    signalAction = (signal) => {
      if (signal === 'SIGTERM') {
        members.clear();
        member(PGID + 2);
      }
    };
    expect((await own().cancel())?.message).toContain(
      'identities are gone or changed',
    );
    expect(signals()).toEqual(['SIGTERM']);
  });

  it.each(['start', 'pgid', 'sid'] as const)(
    'refuses delayed escalation when the surviving witness changes %s',
    async (field) => {
      signalAction = (signal) => {
        if (signal === 'SIGTERM') {
          members.delete(PGID);
          if (field === 'start') members.get(PGID + 1)!.start = '999999';
          else members.get(PGID + 1)![field] = 4500;
        }
      };
      expect(await own().cancel()).toBeInstanceOf(Error);
      expect(signals()).toEqual(['SIGTERM']);
    },
  );

  it('does not claim success when member identity is unreadable', async () => {
    const owner = own();
    read.mockImplementation(() => {
      throw errno('EACCES');
    });
    expect(await owner.cancel()).toBeInstanceOf(Error);
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not claim success from an incomplete process-table inspection', async () => {
    const owner = own();
    list.mockImplementation(() => {
      throw errno('EACCES');
    });
    const error = await owner.cancel();
    expect(error?.message).toContain('Could not inspect');
    expect((error?.cause as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(signals()).toEqual([]);
  });

  it('refuses a group recycled during the initial process-table snapshot', async () => {
    const owner = own();
    list.mockImplementation(() => {
      members.clear();
      member(PGID, { start: '999999' });
      member(PGID + 2);
      return [...members.keys()].map(String);
    });
    expect((await owner.cancel())?.message).toContain(
      'ownership changed during inspection',
    );
    expect(signals()).toEqual([]);
  });

  it('refuses missing identity data after TERM instead of escalating blindly', async () => {
    signalAction = (signal) => {
      if (signal === 'SIGTERM') boot.mockReturnValue(null);
    };
    expect(await own().cancel()).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals()).toEqual(['SIGTERM']);
  });

  it('does not mistake an unreadable descendant beside a zombie witness for completed cleanup', async () => {
    const readStat = read.getMockImplementation()!;
    signalAction = (signal) => {
      if (signal === 'SIGTERM') {
        members.get(PGID)!.state = 'Z';
        read.mockImplementation((file: unknown) => {
          if (String(file) === `/proc/${PGID + 1}/stat`) throw errno('EACCES');
          return readStat(file);
        });
      }
    };
    expect(await own().cancel()).toBeInstanceOf(Error);
    expect(signals()).toEqual(['SIGTERM']);
  });

  it('reports malformed original identity and refuses all signals', async () => {
    read.mockReturnValue(`${PGID} malformed identity`);
    expect(await own().cancel()).toBeInstanceOf(Error);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid grace period %s',
    async (grace) => {
      expect(await own().cancel(grace)).toBeInstanceOf(Error);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it('refuses absent start tokens rather than adopting a liveness-only identity', async () => {
    boot.mockReturnValue(null);
    expect(await own().cancel()).toBeInstanceOf(Error);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses unsupported platforms without signaling', async () => {
    Object.defineProperty(process, 'platform', {
      ...platform,
      value: 'darwin',
    });
    expect((await own().cancel())?.message).toContain('unavailable on darwin');
    expect(kill).not.toHaveBeenCalled();
  });

  it('publishes one completion before a TERM callback races forced cleanup', async () => {
    const owner = own();
    signalAction = (signal) => {
      if (signal === 'SIGTERM') {
        expect(owner.cancelling).toBe(true);
        expect(owner.completion).toBeDefined();
        owner.force();
        owner.force();
      }
      if (signal === 'SIGKILL')
        for (const fixture of members.values()) fixture.state = 'Z';
    };
    const completion = owner.cancel();
    expect(owner.cancel()).toBe(completion);
    expect(owner.completion).toBe(completion);
    expect(await completion).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('force consumes the grace timer and repeated cleanup never dispatches a second KILL', async () => {
    const owner = own();
    const completion = owner.cancel();
    await vi.advanceTimersByTimeAsync(100);
    owner.force();
    owner.force();
    expect(await completion).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('force during a grace probe replaces the old waiter without leaking a timer', async () => {
    const owner = own();
    let forced = false;
    signalAction = (signal) => {
      if (signal === 0 && signals().includes('SIGTERM') && !forced) {
        forced = true;
        owner.force();
      }
    };
    const completion = owner.cancel();
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await completion).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('force during the initial probe suppresses TERM after KILL', async () => {
    const owner = own();
    let forced = false;
    signalAction = (signal) => {
      if (signal === 0 && !forced) {
        forced = true;
        owner.force();
      }
    };
    const completion = owner.cancel();
    expect(signals()).toEqual(['SIGKILL']);
    expect(vi.getTimerCount()).toBe(1);
    owner.release();
    expect(await completion).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumes forced cleanup before a synchronous KILL callback reenters it', async () => {
    const owner = own();
    signalAction = (signal) => {
      if (signal === 'SIGKILL') {
        owner.force();
        for (const fixture of members.values()) fixture.state = 'Z';
      }
    };
    owner.force();
    expect(await owner.completion).toBeNull();
    expect(signals()).toEqual(['SIGKILL']);
  });

  it('force can begin synchronous app-exit cleanup without an earlier cancellation', async () => {
    const owner = own();
    owner.force();
    expect(owner.cancelling).toBe(true);
    expect(await owner.completion).toBeNull();
    owner.force();
    expect(signals()).toEqual(['SIGKILL']);
  });

  it('release preserves natural exit and promotion by revoking ownership without signals', async () => {
    const owner = own();
    owner.release();
    owner.force();
    expect(owner.completion).toBeUndefined();
    expect(owner.cancelling).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(await owner.cancel()).toBeInstanceOf(Error);
    expect(kill).not.toHaveBeenCalled();
  });

  it('release races cancellation without a delayed signal or false success', async () => {
    const owner = own();
    const completion = owner.cancel();
    owner.release();
    expect((await completion)?.message).toContain(
      'released before termination was confirmed',
    );
    owner.force();
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals()).toEqual(['SIGTERM']);
  });
});
