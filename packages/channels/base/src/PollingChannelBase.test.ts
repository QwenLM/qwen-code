import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PollingChannelBase } from './PollingChannelBase.js';
import { channelEventFilePath } from './channel-events.js';
import { getWorkspaceScopeDirName } from './paths.js';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import type { ChannelConfig } from './types.js';

const testHome = mkdtempSync(join(tmpdir(), 'poll-test-'));

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return { ...actual, getGlobalQwenDir: () => testHome };
});

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

interface TestCursor {
  ts: string;
  count: number;
}

function makeConfig(): ChannelConfig {
  return {
    type: 'test',
    token: 'x',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'user',
    cwd: '/tmp',
    groupPolicy: 'open',
    dmPolicy: 'open',
    groups: { '*': {} },
  };
}

function makeBridge(): ChannelAgentBridge {
  return {
    newSession: vi.fn().mockResolvedValue('s1'),
    loadSession: vi.fn(),
    prompt: vi.fn().mockResolvedValue('ok'),
    cancelSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as ChannelAgentBridge;
}

class TestPoller extends PollingChannelBase<TestCursor> {
  pollCount = 0;
  shouldThrow = false;
  errorMessage = 'poll failed';

  protected createInitialCursor(): TestCursor {
    return { ts: '2026-01-01T00:00:00.000Z', count: 0 };
  }

  protected get pollInterval(): number {
    return 10;
  }

  protected async pollOnce(): Promise<void> {
    this.pollCount++;
    if (this.shouldThrow) throw new Error(this.errorMessage);
    this.cursor.count++;
    this.cursor.ts = new Date().toISOString();
  }

  async connect(): Promise<void> {
    this.startPollLoop();
  }

  disconnect(): void {
    this.stopPollLoop();
  }

  async sendMessage(): Promise<void> {}

  save(): void {
    this.saveCursor();
  }
}

function scopeDir(cwd = '/tmp'): string {
  return join(testHome, 'channels', getWorkspaceScopeDirName(cwd));
}

function cursorFileName(name: string): string {
  const encoded = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `${encoded}-${hash}-poll-cursor.json`;
}

function cursorFile(name: string, cwd = '/tmp'): string {
  return join(scopeDir(cwd), cursorFileName(name));
}

function legacyCursorFile(name: string): string {
  return join(testHome, 'channels', cursorFileName(name));
}

describe('PollingChannelBase', () => {
  beforeEach(() => {
    mkdirSync(scopeDir(), { recursive: true });
  });

  it('initializes with default cursor when no file exists', () => {
    const poller = new TestPoller('fresh', makeConfig(), makeBridge());
    expect(poller.cursor).toEqual({ ts: '2026-01-01T00:00:00.000Z', count: 0 });
  });

  it('loads cursor from disk', () => {
    writeFileSync(
      cursorFile('saved'),
      JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', count: 5 }),
      'utf-8',
    );
    const poller = new TestPoller('saved', makeConfig(), makeBridge());
    expect(poller.cursor).toEqual({ ts: '2026-06-01T00:00:00.000Z', count: 5 });
  });

  it('falls back to initial cursor on corrupt file', () => {
    writeFileSync(cursorFile('corrupt'), 'not json{{{', 'utf-8');
    const poller = new TestPoller('corrupt', makeConfig(), makeBridge());
    expect(poller.cursor).toEqual({ ts: '2026-01-01T00:00:00.000Z', count: 0 });
  });

  it('keeps one cursor per workspace for channels sharing a name', () => {
    const a = new TestPoller(
      'shared',
      { ...makeConfig(), cwd: '/tmp/ws-a' },
      makeBridge(),
    );
    const b = new TestPoller(
      'shared',
      { ...makeConfig(), cwd: '/tmp/ws-b' },
      makeBridge(),
    );
    a.cursor = { ts: '2026-07-01T00:00:00.000Z', count: 1 };
    b.cursor = { ts: '2026-07-02T00:00:00.000Z', count: 2 };
    a.save();
    b.save();
    expect(cursorFile('shared', '/tmp/ws-a')).not.toBe(
      cursorFile('shared', '/tmp/ws-b'),
    );
    expect(
      new TestPoller(
        'shared',
        { ...makeConfig(), cwd: '/tmp/ws-a' },
        makeBridge(),
      ).cursor.count,
    ).toBe(1);
    expect(
      new TestPoller(
        'shared',
        { ...makeConfig(), cwd: '/tmp/ws-b' },
        makeBridge(),
      ).cursor.count,
    ).toBe(2);
  });

  it('reads a legacy global cursor until the scoped file exists', () => {
    writeFileSync(
      legacyCursorFile('upgraded'),
      JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', count: 5 }),
      'utf-8',
    );
    const poller = new TestPoller('upgraded', makeConfig(), makeBridge());
    expect(poller.cursor.count).toBe(5);
    poller.cursor.count = 6;
    poller.save();
    expect(
      JSON.parse(readFileSync(cursorFile('upgraded'), 'utf-8')).count,
    ).toBe(6);
    expect(
      JSON.parse(readFileSync(legacyCursorFile('upgraded'), 'utf-8')).count,
    ).toBe(5);
    expect(
      new TestPoller('upgraded', makeConfig(), makeBridge()).cursor.count,
    ).toBe(6);
  });

  it('prefers the scoped cursor over a legacy one', () => {
    writeFileSync(
      legacyCursorFile('both'),
      JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', count: 1 }),
      'utf-8',
    );
    writeFileSync(
      cursorFile('both'),
      JSON.stringify({ ts: '2026-06-02T00:00:00.000Z', count: 2 }),
      'utf-8',
    );
    const poller = new TestPoller('both', makeConfig(), makeBridge());
    expect(poller.cursor.count).toBe(2);
  });

  it('does not fall back to a legacy cursor when the scoped file is corrupt', () => {
    writeFileSync(
      legacyCursorFile('corrupt-scoped'),
      JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', count: 9 }),
      'utf-8',
    );
    writeFileSync(cursorFile('corrupt-scoped'), 'not json{{{', 'utf-8');
    const poller = new TestPoller('corrupt-scoped', makeConfig(), makeBridge());
    expect(poller.cursor).toEqual({ ts: '2026-01-01T00:00:00.000Z', count: 0 });
  });

  it.skipIf(process.platform === 'win32')(
    'writes the cursor with private permissions',
    () => {
      const poller = new TestPoller(
        'modes',
        { ...makeConfig(), cwd: '/tmp/ws-modes' },
        makeBridge(),
      );
      poller.save();
      const file = cursorFile('modes', '/tmp/ws-modes');
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a pre-existing temp file before it becomes the cursor',
    () => {
      const poller = new TestPoller(
        'stale-tmp',
        { ...makeConfig(), cwd: '/tmp/ws-stale-tmp' },
        makeBridge(),
      );
      const file = cursorFile('stale-tmp', '/tmp/ws-stale-tmp');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, 'stale', { encoding: 'utf-8', mode: 0o644 });
      poller.save();
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it('saveCursor persists JSON to disk', () => {
    const poller = new TestPoller('persist', makeConfig(), makeBridge());
    poller.cursor = { ts: '2026-07-01T00:00:00.000Z', count: 42 };
    (poller as unknown as { saveCursor: () => void }).saveCursor();
    const raw = readFileSync(cursorFile('persist'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      ts: '2026-07-01T00:00:00.000Z',
      count: 42,
    });
  });

  it('poll loop calls pollOnce and saves cursor', async () => {
    const poller = new TestPoller('loop', makeConfig(), makeBridge());
    poller.connect();
    await vi.waitFor(() => {
      expect(poller.pollCount).toBeGreaterThanOrEqual(1);
    });
    poller.disconnect();
    expect(poller.cursor.count).toBeGreaterThanOrEqual(1);
  });

  it('stopPollLoop stops the loop', async () => {
    const poller = new TestPoller('stop', makeConfig(), makeBridge());
    poller.connect();
    await vi.waitFor(() => {
      expect(poller.pollCount).toBeGreaterThanOrEqual(1);
    });
    poller.disconnect();
    const countAtStop = poller.pollCount;
    await new Promise((r) => setTimeout(r, 50));
    expect(poller.pollCount).toBe(countAtStop);
  });

  it('backs off on poll error', async () => {
    const poller = new TestPoller('backoff', makeConfig(), makeBridge());
    poller.shouldThrow = true;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    poller.connect();
    await vi.waitFor(() => {
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('backing off'),
      );
    });
    poller.disconnect();
    stderrSpy.mockRestore();
  });

  it('sanitizes the poll-error diagnostic against log-line forgery (R12-F3)', async () => {
    const poller = new TestPoller('sanitize', makeConfig(), makeBridge());
    poller.shouldThrow = true;
    // A terminal poll error reaches the runLoop catch raw; an upstream/proxy
    // error body can carry separators/ANSI that forge extra log lines.
    poller.errorMessage =
      'upstream boom\u2028[Channel:sanitize] preflight rejected reason=sender_denied\u001b[31mX';
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    poller.connect();
    await vi.waitFor(() => {
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('backing off'),
      );
    });
    poller.disconnect();
    const line =
      stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .find((s) => s.includes('poll error')) ?? '';
    stderrSpy.mockRestore();
    expect(line).toContain('upstream boom');
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u2028\u2029\u0085\u001b]/);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('uses configured pollInterval from config', () => {
    const poller = new TestPoller(
      'interval',
      { ...makeConfig(), pollInterval: 30_000 },
      makeBridge(),
    );
    const base = Object.getOwnPropertyDescriptor(
      PollingChannelBase.prototype,
      'pollInterval',
    )!.get!;
    expect(base.call(poller)).toBe(30_000);
  });

  it('defaults to 60000 when pollInterval not configured', () => {
    const poller = new TestPoller(
      'default-interval',
      makeConfig(),
      makeBridge(),
    );
    const base = Object.getOwnPropertyDescriptor(
      PollingChannelBase.prototype,
      'pollInterval',
    )!.get!;
    expect(base.call(poller)).toBe(60_000);
  });

  it('keeps cursor filename within filesystem limits for long names', () => {
    const longName = 'a'.repeat(300);
    const poller = new TestPoller(longName, makeConfig(), makeBridge());
    poller.saveCursor();
    const expectedHash = createHash('sha256')
      .update(longName)
      .digest('hex')
      .slice(0, 16);
    const files = readdirSync(scopeDir());
    const cursorFile = files.find((f: string) => f.includes(expectedHash));
    expect(cursorFile).toBeDefined();
    expect(cursorFile!.length).toBeLessThanOrEqual(255);
  });

  it('produces distinct cursor files for names sharing a long prefix', () => {
    const prefix = 'x'.repeat(250);
    const p1 = new TestPoller(`${prefix}-alpha`, makeConfig(), makeBridge());
    const p2 = new TestPoller(`${prefix}-beta`, makeConfig(), makeBridge());
    p1.saveCursor();
    p2.saveCursor();
    const files = readdirSync(scopeDir()).filter((f: string) =>
      f.endsWith('-poll-cursor.json'),
    );
    const h1 = createHash('sha256')
      .update(`${prefix}-alpha`)
      .digest('hex')
      .slice(0, 16);
    const h2 = createHash('sha256')
      .update(`${prefix}-beta`)
      .digest('hex')
      .slice(0, 16);
    expect(files.some((f: string) => f.includes(h1))).toBe(true);
    expect(files.some((f: string) => f.includes(h2))).toBe(true);
  });

  it('records the detail produced by the same poll, not the previous one', async () => {
    class DetailPoller extends PollingChannelBase<TestCursor> {
      private readonly counts = [7, 2, 11];
      private index = 0;

      protected createInitialCursor(): TestCursor {
        return { ts: '2026-01-01T00:00:00.000Z', count: 0 };
      }

      protected get pollInterval(): number {
        return 1;
      }

      protected async pollOnce(): Promise<void> {
        this.setPollEventDetail({
          notifications: this.counts[this.index++]!,
        });
      }

      async connect(): Promise<void> {
        this.startPollLoop();
      }

      disconnect(): void {
        this.stopPollLoop();
      }

      async sendMessage(): Promise<void> {}
    }

    vi.useFakeTimers();
    const poller = new DetailPoller(
      'detail-poller',
      makeConfig(),
      makeBridge(),
    );
    try {
      poller.connect();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      poller.disconnect();
    } finally {
      vi.useRealTimers();
    }

    const journal = readFileSync(
      channelEventFilePath('detail-poller', '/tmp'),
      'utf-8',
    )
      .split('\n')
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            detail?: { notifications?: number };
          },
      )
      .filter((event) => event.type === 'poll');

    expect(journal.map((event) => event.detail?.notifications)).toEqual([
      7, 2, 11,
    ]);
  });
});
