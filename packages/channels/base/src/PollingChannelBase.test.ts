import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PollingChannelBase } from './PollingChannelBase.js';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import type { ChannelConfig } from './types.js';

vi.mock('./paths.js', () => ({
  getGlobalQwenDir: () => '/tmp/test-polling-base',
}));

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

  protected createInitialCursor(): TestCursor {
    return { ts: '2026-01-01T00:00:00.000Z', count: 0 };
  }

  protected get pollInterval(): number {
    return 10;
  }

  protected async pollOnce(): Promise<void> {
    this.pollCount++;
    if (this.shouldThrow) throw new Error('poll failed');
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
}

describe('PollingChannelBase', () => {
  beforeEach(() => {
    mkdirSync('/tmp/test-polling-base/channels', { recursive: true });
  });

  it('initializes with default cursor when no file exists', () => {
    const poller = new TestPoller('fresh', makeConfig(), makeBridge());
    expect(poller.cursor).toEqual({ ts: '2026-01-01T00:00:00.000Z', count: 0 });
  });

  it('loads cursor from disk', () => {
    const path = '/tmp/test-polling-base/channels/saved-poll-cursor.json';
    writeFileSync(
      path,
      JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', count: 5 }),
      'utf-8',
    );
    const poller = new TestPoller('saved', makeConfig(), makeBridge());
    expect(poller.cursor).toEqual({ ts: '2026-06-01T00:00:00.000Z', count: 5 });
  });

  it('falls back to initial cursor on corrupt file', () => {
    const path = '/tmp/test-polling-base/channels/corrupt-poll-cursor.json';
    writeFileSync(path, 'not json{{{', 'utf-8');
    const poller = new TestPoller('corrupt', makeConfig(), makeBridge());
    expect(poller.cursor).toEqual({ ts: '2026-01-01T00:00:00.000Z', count: 0 });
  });

  it('saveCursor persists JSON to disk', () => {
    const poller = new TestPoller('persist', makeConfig(), makeBridge());
    poller.cursor = { ts: '2026-07-01T00:00:00.000Z', count: 42 };
    (poller as unknown as { saveCursor: () => void }).saveCursor();
    const raw = readFileSync(
      '/tmp/test-polling-base/channels/persist-poll-cursor.json',
      'utf-8',
    );
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
});
