import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import { setA1ExecForTest } from './a1-client.js';
import { AoneChannel, validateAoneConfig } from './AoneAdapter.js';

function makeConfig(
  overrides: Record<string, unknown> = {},
): ChannelConfig & Record<string, unknown> {
  return {
    type: 'aone',
    token: '',
    allowedUsers: [],
    sessionScope: 'chat_thread',
    cwd: '/tmp/test',
    groupPolicy: 'open',
    groups: { '*': {} },
    repos: ['test/repo'],
    triggerPrefixes: ['qwen:'],
    ...overrides,
  };
}

function makeBridge(): ChannelAgentBridge {
  return {
    newSession: vi.fn().mockResolvedValue('session-1'),
    loadSession: vi.fn(),
    prompt: vi.fn().mockResolvedValue('response'),
    cancelSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as ChannelAgentBridge;
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1000,
    createdAt: new Date().toISOString(),
    author: 'alice',
    user: { name: 'Alice', username: 'alice' },
    note: {
      id: 5000,
      note: 'qwen: do something',
      noteable_type: 'MergeRequest',
    },
    mergeRequest: { id: 30825167, iid: 1736615 },
    projectDetail: { path_with_namespace: 'test/repo' },
    ...overrides,
  };
}

interface FakeA1Options {
  account?: string;
  events?: (repo: string, page: number) => unknown[];
  view?: (id: string, repo: string) => unknown;
  createError?: Record<string, unknown>;
}

function installFakeA1(opts: FakeA1Options = {}) {
  const calls: string[][] = [];
  setA1ExecForTest(async (args) => {
    const argv = [...args];
    calls.push(argv);
    if (argv[0] === 'auth' && argv[1] === 'whoami') {
      return {
        stdout: JSON.stringify({ account: opts.account ?? 'stub-bot' }),
      };
    }
    if (argv[0] === 'events' && argv[1] === 'repo') {
      const page = Number(argv[argv.indexOf('--page') + 1]);
      const events = opts.events ? opts.events(argv[2]!, page) : [];
      return { stdout: JSON.stringify(events) };
    }
    if (argv[0] === 'repo' && argv[1] === 'mr' && argv[2] === 'view') {
      const body = opts.view
        ? opts.view(argv[3]!, argv[5]!)
        : {
            mergeRequest: {
              title: 'Stub MR title',
              detailUrl: `https://code.alibaba-inc.com/test/repo/codereview/${argv[3]}`,
            },
          };
      return { stdout: JSON.stringify(body) };
    }
    if (
      argv[0] === 'repo' &&
      argv[1] === 'mr' &&
      argv[2] === 'comment' &&
      argv[3] === 'create'
    ) {
      if (opts.createError) throw opts.createError;
      return { stdout: '{"id":999}' };
    }
    throw new Error(`unexpected a1 argv: ${JSON.stringify(argv)}`);
  });
  return calls;
}

/** Captures envelopes instead of running the full ChannelBase pipeline. */
class TestableAoneChannel extends AoneChannel {
  inboundEnvelopes: Envelope[] = [];
  handleInboundError: Error | null = null;

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (this.handleInboundError) throw this.handleInboundError;
    this.inboundEnvelopes.push(envelope);
  }

  protected override startPollLoop(): void {
    // no-op: tests call pollOnce() manually
  }

  async testPollOnce(): Promise<void> {
    return this.pollOnce();
  }

  async testSendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    return this.sendThreadMessage(chatId, threadId, text, sourceLabel);
  }
}

/** Serve a fixed event array as descending pages of 100. */
function pagedEvents(all: unknown[]) {
  return (_repo: string, page: number) =>
    all.slice((page - 1) * 100, page * 100);
}

describe('AoneChannel', () => {
  let channel: TestableAoneChannel;
  let savedQwenHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    savedQwenHome = process.env.QWEN_HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'qwen-aone-test-'));
    process.env.QWEN_HOME = tempDir;
    installFakeA1();
    channel = new TestableAoneChannel('test-aone', makeConfig(), makeBridge());
  });

  afterEach(() => {
    setA1ExecForTest();
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('connect', () => {
    it('resolves the bot account via whoami and lowercases allowedUsers', async () => {
      installFakeA1({ account: 'Stub-Bot' });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ allowedUsers: ['Alice'] }),
        makeBridge(),
      );
      await ch.connect();
      expect(ch.config.allowedUsers).toEqual(['alice']);
      ch.disconnect();
    });

    it('rejects invalid repos before any a1 call', async () => {
      const calls = installFakeA1();
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: [] }),
        makeBridge(),
      );
      await expect(ch.connect()).rejects.toThrow(/non-empty array/);
      expect(calls).toHaveLength(0);
    });

    it('rejects invalid triggerPrefixes', async () => {
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ triggerPrefixes: ['  '] }),
        makeBridge(),
      );
      await expect(ch.connect()).rejects.toThrow(/non-empty strings/);
    });

    it('rejects a non-string promptTemplate', async () => {
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: 42 }),
        makeBridge(),
      );
      await expect(ch.connect()).rejects.toThrow(/promptTemplate/);
    });

    it('fails connect when whoami fails', async () => {
      setA1ExecForTest(async () => {
        throw { code: 'ENOENT' };
      });
      await expect(channel.connect()).rejects.toThrow(/a1 auth login/);
    });

    it('warns when groupPolicy cannot dispatch', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ groupPolicy: 'disabled' }),
        makeBridge(),
      );
      await ch.connect();
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes('groupPolicy')),
      ).toBe(true);
      ch.disconnect();
      stderr.mockRestore();
    });
  });

  describe('baseline', () => {
    it('first poll records the max event id and dispatches nothing', async () => {
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 300 }), makeEvent({ id: 200 })]),
      });
      await channel.connect();
      await channel.testPollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.repos['test/repo']).toBe(300);
      channel.disconnect();
    });

    it('an empty first window baselines to 0 without dispatching later historical events', async () => {
      let events: unknown[] = [];
      installFakeA1({ events: () => events });
      await channel.connect();
      await channel.testPollOnce();
      expect(channel.cursor.repos['test/repo']).toBe(0);

      // A comment created BEFORE the channel existed enters the window on
      // the next poll — it must not dispatch (no historical backlog).
      events = [makeEvent({ id: 10, createdAt: '2020-01-01T00:00:00.000Z' })];
      await channel.testPollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.repos['test/repo']).toBe(10);

      // A comment created after creation dispatches.
      events = [makeEvent({ id: 20 })];
      await channel.testPollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      channel.disconnect();
    });

    it('a repo added to the config later baselines without backlog dispatch', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 500 })]) });
      await channel.connect();
      await channel.testPollOnce();
      channel.disconnect();

      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['test/repo', 'other/repo'] }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce();
      expect(ch.cursor.repos['other/repo']).toBe(500);
      expect(ch.inboundEnvelopes).toHaveLength(0);
      ch.disconnect();
    });
  });

  describe('dispatch filters', () => {
    async function pollWith(events: unknown[]) {
      // Baseline on a LOW id first, then serve the test events as NEW —
      // re-serving the same fixture would sit at/below the cursor and
      // exercise no filter at all (vacuous pass).
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline at 1
      installFakeA1({ events: pagedEvents(events) });
      await channel.testPollOnce(); // test events are new; filters decide
      channel.disconnect();
    }

    it('skips the bot own comments', async () => {
      await pollWith([makeEvent({ id: 1001, author: 'stub-bot' })]);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips non-MR notes', async () => {
      await pollWith([
        makeEvent({
          id: 1001,
          note: {
            id: 5001,
            note: 'qwen: go',
            noteable_type: 'Issue',
          },
        }),
      ]);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips events without a mergeRequest id', async () => {
      await pollWith([makeEvent({ id: 1001, mergeRequest: undefined })]);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips comments without a trigger prefix', async () => {
      await pollWith([
        makeEvent({
          id: 1001,
          note: { id: 5001, note: 'plain talk', noteable_type: 'MergeRequest' },
        }),
      ]);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips a bare prefix with no instruction text', async () => {
      await pollWith([
        makeEvent({
          id: 1001,
          note: { id: 5001, note: 'qwen:', noteable_type: 'MergeRequest' },
        }),
      ]);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('builds the envelope from the event', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1001 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline at 1001
      // A NEW event above the baseline:
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1002 })]) });
      await channel.testPollOnce();
      channel.disconnect();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.senderId).toBe('alice');
      expect(env.senderName).toBe('Alice');
      expect(env.chatId).toBe('test/repo');
      expect(env.threadId).toBe('mr:30825167');
      expect(env.messageId).toBe('5000');
      expect(env.text).toBe('do something');
      expect(env.isGroup).toBe(true);
      expect(env.isMentioned).toBe(true);
      expect(env.isReplyToBot).toBe(false);
      expect(env.metadata).toBe(
        'Aone CR test/repo !30825167 (iid 1736615) | author: alice | comment: 5000',
      );
    });

    it('dispatches new events in ascending id order', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 100 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([
          makeEvent({
            id: 1003,
            note: { id: 3, note: 'qwen: third', noteable_type: 'MergeRequest' },
          }),
          makeEvent({
            id: 1001,
            note: { id: 1, note: 'qwen: first', noteable_type: 'MergeRequest' },
          }),
          makeEvent({
            id: 1002,
            note: {
              id: 2,
              note: 'qwen: second',
              noteable_type: 'MergeRequest',
            },
          }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes.map((e) => e.text)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });

  describe('cursor', () => {
    it('advances past skipped events and persists to disk', async () => {
      installFakeA1({
        events: pagedEvents([
          makeEvent({ id: 1002, author: 'stub-bot' }),
          makeEvent({ id: 1001 }),
        ]),
      });
      await channel.connect();
      await channel.testPollOnce(); // baseline 1002
      installFakeA1({
        events: pagedEvents([
          makeEvent({ id: 1004, author: 'stub-bot' }),
          makeEvent({ id: 1003 }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.cursor.repos['test/repo']).toBe(1004);
      expect(channel.inboundEnvelopes).toHaveLength(1);

      // A fresh instance with the same name/cwd loads the persisted cursor
      // and does not re-dispatch the same events.
      const ch2 = new TestableAoneChannel(
        'test-aone',
        makeConfig(),
        makeBridge(),
      );
      await ch2.connect();
      await ch2.testPollOnce();
      ch2.disconnect();
      expect(ch2.inboundEnvelopes).toHaveLength(0);
      expect(ch2.cursor.repos['test/repo']).toBe(1004);
    });

    it('advances the cursor even when handleInbound fails, and posts an error comment', async () => {
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 1000 })]),
      });
      await channel.connect();
      await channel.testPollOnce(); // baseline at 1000
      const calls = installFakeA1({
        events: pagedEvents([makeEvent({ id: 1001 })]),
      });
      channel.handleInboundError = new Error('agent exploded');
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.cursor.repos['test/repo']).toBe(1001);
      const creates = calls.filter(
        (argv) => argv[0] === 'repo' && argv[3] === 'create',
      );
      expect(creates).toHaveLength(1);
      expect(creates[0]).toContain('--mr');
      expect(creates[0]!.join(' ')).toContain('Failed to process');
    });

    it('swallows a failing error comment', async () => {
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 1000 })]),
      });
      await channel.connect();
      await channel.testPollOnce(); // baseline at 1000
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 1001 })]),
        createError: { code: 1, stdout: '', stderr: 'write refused' },
      });
      channel.handleInboundError = new Error('agent exploded');
      await expect(channel.testPollOnce()).resolves.toBeUndefined();
      channel.disconnect();
      expect(channel.cursor.repos['test/repo']).toBe(1001);
    });

    it('re-baselines when baselineAt is unparseable (no silent freeze)', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 800 })]) });
      await channel.connect();
      await channel.testPollOnce();
      channel.disconnect();

      const files = readdirSync(join(tempDir, 'channels'), {
        recursive: true,
      }) as string[];
      const cursorFile = files.find((f) =>
        String(f).endsWith('-poll-cursor.json'),
      );
      const cursorPath = join(tempDir, 'channels', String(cursorFile));
      const saved = JSON.parse(readFileSync(cursorPath, 'utf8')) as {
        repos: Record<string, number>;
      };
      writeFileSync(
        cursorPath,
        JSON.stringify({ baselineAt: 'not-a-date', repos: saved.repos }),
      );

      const ch2 = new TestableAoneChannel(
        'test-aone',
        makeConfig(),
        makeBridge(),
      );
      await ch2.connect();
      await ch2.testPollOnce();
      ch2.disconnect();
      // Invalid floor → cursor rejected → fresh baseline, no dispatch,
      // and the new cursor carries a parseable floor again.
      expect(ch2.inboundEnvelopes).toHaveLength(0);
      expect(ch2.cursor.repos['test/repo']).toBe(800);
      expect(Number.isNaN(Date.parse(ch2.cursor.baselineAt))).toBe(false);
    });

    it('re-baselines when the persisted cursor is invalid', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 700 })]) });
      await channel.connect();
      await channel.testPollOnce();
      channel.disconnect();

      const files = readdirSync(join(tempDir, 'channels'), {
        recursive: true,
      }) as string[];
      const cursorFile = files.find((f) =>
        String(f).endsWith('-poll-cursor.json'),
      );
      expect(cursorFile).toBeDefined();
      writeFileSync(
        join(tempDir, 'channels', String(cursorFile)),
        '{"garbage":true}',
      );

      const ch2 = new TestableAoneChannel(
        'test-aone',
        makeConfig(),
        makeBridge(),
      );
      await ch2.connect();
      await ch2.testPollOnce();
      ch2.disconnect();
      expect(ch2.inboundEnvelopes).toHaveLength(0);
      expect(ch2.cursor.repos['test/repo']).toBe(700);
    });
  });

  describe('failure isolation', () => {
    it('continues to later events after one dispatch fails', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([
          makeEvent({
            id: 1002,
            note: {
              id: 2,
              note: 'qwen: second',
              noteable_type: 'MergeRequest',
            },
          }),
          makeEvent({
            id: 1001,
            note: { id: 1, note: 'qwen: first', noteable_type: 'MergeRequest' },
          }),
        ]),
      });
      const original = channel.handleInbound.bind(channel);
      channel.handleInbound = async (envelope: Envelope) => {
        if (envelope.text === 'first') throw new Error('first fails');
        return original(envelope);
      };
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes.map((e) => e.text)).toEqual(['second']);
      expect(channel.cursor.repos['test/repo']).toBe(1002);
    });

    it('a failing repo does not swallow another repo already-saved progress', async () => {
      const okEvents = [makeEvent({ id: 2001 })];
      installFakeA1({
        events: (repo) => (repo === 'good/repo' ? okEvents : []),
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['good/repo', 'bad/repo'] }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline both repos (good=2001, bad=0)
      // good/repo gets a new trigger event; bad/repo starts erroring.
      installFakeA1({
        events: (repo) => {
          if (repo === 'bad/repo') {
            throw {
              code: 1,
              stdout: JSON.stringify({
                schemaVersion: 'a1.error/v1',
                message: 'SYSTEM_FORBIDDEN_ERROR',
              }),
              stderr: '',
            };
          }
          return [makeEvent({ id: 2002 })];
        },
      });
      await expect(ch.testPollOnce()).rejects.toThrow('SYSTEM_FORBIDDEN_ERROR');
      ch.disconnect();
      // good/repo dispatched and persisted BEFORE bad/repo threw.
      expect(ch.inboundEnvelopes).toHaveLength(1);
      expect(ch.cursor.repos['good/repo']).toBe(2002);
      // The persistence claim is about DISK: a fresh instance must load
      // good/repo's advanced cursor despite the failed poll.
      const ch2 = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['good/repo', 'bad/repo'] }),
        makeBridge(),
      );
      expect(ch2.cursor.repos['good/repo']).toBe(2002);
    });
  });

  describe('pagination', () => {
    it('passes explicit --since/--until dates (a1 rejects omitted ones)', async () => {
      const calls = installFakeA1({
        events: pagedEvents([makeEvent({ id: 100 })]),
      });
      await channel.connect();
      await channel.testPollOnce();
      channel.disconnect();
      const events = calls.find((argv) => argv[0] === 'events')!;
      const since = events[events.indexOf('--since') + 1]!;
      const until = events[events.indexOf('--until') + 1]!;
      expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Date.parse(until) - Date.parse(since)).toBe(3 * 86_400_000);
    });

    it('stops at a partial page', async () => {
      const calls = installFakeA1({
        events: pagedEvents([makeEvent({ id: 100 })]),
      });
      await channel.connect();
      await channel.testPollOnce();
      channel.disconnect();
      const eventCalls = calls.filter((argv) => argv[0] === 'events');
      expect(eventCalls).toHaveLength(1);
    });

    it('pages until the cursor is reached', async () => {
      const all = Array.from({ length: 150 }, (_, i) =>
        makeEvent({ id: 1000 - i }),
      );
      const calls = installFakeA1({ events: pagedEvents(all) });
      await channel.connect();
      await channel.testPollOnce(); // baseline at 1000 (page 1 only)
      channel.disconnect();
      expect(calls.filter((argv) => argv[0] === 'events')).toHaveLength(1);

      // Cursor at 900: page 1 (1000..901) all new, page 2 reaches 900.
      const ch2 = new TestableAoneChannel(
        'test-aone',
        makeConfig(),
        makeBridge(),
      );
      // The fixture predates ch2, so floor its baseline below the fixture
      // timestamps — this test targets pagination, not the baseline floor.
      ch2.cursor.baselineAt = '2020-01-01T00:00:00.000Z';
      ch2.cursor.repos['test/repo'] = 900;
      await ch2.connect();
      const calls2 = installFakeA1({ events: pagedEvents(all) });
      await ch2.testPollOnce();
      ch2.disconnect();
      const pages = calls2
        .filter((argv) => argv[0] === 'events')
        .map((argv) => Number(argv[argv.indexOf('--page') + 1]));
      expect(pages).toEqual([1, 2]);
      // ids 1000..901 are newer than the cursor at 900 — 100 events.
      expect(ch2.inboundEnvelopes).toHaveLength(100);
    });

    it('fails closed when the backlog exceeds the page budget', async () => {
      const all = Array.from({ length: 1000 }, (_, i) =>
        makeEvent({ id: 5000 - i }),
      );
      installFakeA1({ events: pagedEvents(all) });
      await channel.connect();
      channel.cursor.repos['test/repo'] = 100; // everything is newer
      await expect(channel.testPollOnce()).rejects.toThrow(/backlog/);
      channel.disconnect();
      expect(channel.cursor.repos['test/repo']).toBe(100);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });
  });

  describe('metadata template', () => {
    it('renders %% escapes and unknown variables verbatim', async () => {
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 1001 })]),
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: '100%% %repo% %unknown%' }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1002 })]) });
      await ch.testPollOnce();
      ch.disconnect();
      expect(ch.inboundEnvelopes[0]!.metadata).toBe('100% test/repo %unknown%');
    });

    it('fetches the MR view once per MR per poll for %title%/%url%', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: '%title% | %url%' }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline at 1000
      const calls = installFakeA1({
        events: pagedEvents([
          makeEvent({ id: 1002 }),
          makeEvent({
            id: 1001,
            note: {
              id: 4999,
              note: 'qwen: earlier',
              noteable_type: 'MergeRequest',
            },
          }),
        ]),
      });
      await ch.testPollOnce(); // both events dispatch, same MR
      ch.disconnect();
      const views = calls.filter(
        (argv) => argv[0] === 'repo' && argv[2] === 'view',
      );
      expect(views).toHaveLength(1);
      expect(ch.inboundEnvelopes[0]!.metadata).toBe(
        'Stub MR title | https://code.alibaba-inc.com/test/repo/codereview/30825167',
      );
    });

    it('degrades to empty title/url when the view fails', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 1001 })]),
        view: () => {
          throw { code: 1, stdout: '', stderr: 'view forbidden' };
        },
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: 't=%title% u=%url%' }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 1002 })]),
        view: () => {
          throw { code: 1, stdout: '', stderr: 'view forbidden' };
        },
      });
      await ch.testPollOnce();
      ch.disconnect();
      stderr.mockRestore();
      expect(ch.inboundEnvelopes).toHaveLength(1);
      expect(ch.inboundEnvelopes[0]!.metadata).toBe('t= u=');
    });
  });

  describe('outbound', () => {
    it('posts the reply with repo/mr/message argv, exactly once', async () => {
      const calls = installFakeA1();
      await channel.connect();
      await channel.testSendThreadMessage(
        'test/repo',
        'mr:30825167',
        'the reply',
      );
      channel.disconnect();
      const creates = calls.filter(
        (argv) => argv[0] === 'repo' && argv[3] === 'create',
      );
      expect(creates).toHaveLength(1);
      expect(creates[0]).toEqual([
        'repo',
        'mr',
        'comment',
        'create',
        '--repo',
        'test/repo',
        '--mr',
        '30825167',
        '-m',
        'the reply',
        '--no-update-check',
        '--format',
        'json',
      ]);
    });

    it('propagates a failed create without retrying', async () => {
      const calls = installFakeA1({
        createError: { code: 1, stdout: '', stderr: 'refused' },
      });
      await channel.connect();
      await expect(
        channel.testSendThreadMessage('test/repo', 'mr:1', 'x'),
      ).rejects.toThrow('refused');
      channel.disconnect();
      expect(
        calls.filter((argv) => argv[0] === 'repo' && argv[3] === 'create'),
      ).toHaveLength(1);
    });

    it('rejects a missing or malformed threadId', async () => {
      await channel.connect();
      await expect(
        channel.testSendThreadMessage('test/repo', undefined, 'x'),
      ).rejects.toThrow(/threadId/);
      await expect(
        channel.testSendThreadMessage('test/repo', 'issue:42', 'x'),
      ).rejects.toThrow(/threadId/);
      channel.disconnect();
    });

    it('sendMessage without a thread throws', async () => {
      await expect(channel.sendMessage('test/repo', 'x')).rejects.toThrow(
        /sendThreadMessage/,
      );
    });
  });

  describe('validateAoneConfig', () => {
    it('accepts a valid config', () => {
      expect(
        validateAoneConfig(
          { repos: ['g/p'], triggerPrefixes: ['qwen:'] },
          'aone',
        ),
      ).toBeUndefined();
    });

    it('accepts nested group paths', () => {
      expect(
        validateAoneConfig(
          { repos: ['group/sub/project'], triggerPrefixes: ['go'] },
          'aone',
        ),
      ).toBeUndefined();
    });

    it('rejects malformed repo paths', () => {
      expect(
        validateAoneConfig(
          { repos: ['no-slash'], triggerPrefixes: ['go'] },
          'aone',
        ),
      ).toMatch(/group\/project/);
      expect(
        validateAoneConfig(
          { repos: ['/leading/slash'], triggerPrefixes: ['go'] },
          'aone',
        ),
      ).toMatch(/group\/project/);
    });

    it('rejects a non-string promptTemplate', () => {
      expect(
        validateAoneConfig(
          { repos: ['g/p'], triggerPrefixes: ['go'], promptTemplate: 1 },
          'aone',
        ),
      ).toMatch(/promptTemplate/);
    });
  });
});
