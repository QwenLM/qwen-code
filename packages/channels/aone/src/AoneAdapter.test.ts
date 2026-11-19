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

    it('lowercases repo paths for the cursor key and the a1 argv', async () => {
      // Pins the lowercasing (verify-round survivor M13): a mixed-case
      // config must route through the canonical lowercase key.
      const calls = installFakeA1({
        events: pagedEvents([makeEvent({ id: 100 })]),
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['Test/Repo'] }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce();
      ch.disconnect();
      expect(ch.cursor.repos['test/repo']).toBe(100);
      expect(ch.cursor.repos['Test/Repo']).toBeUndefined();
      const events = calls.find((argv) => argv[0] === 'events')!;
      expect(events[2]).toBe('test/repo');
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

    it('warns on the fully permissive default; silent when restricted (R2-7)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      // makeConfig defaults: groupPolicy open, groups {'*':{}} → senders
      // fall back to open — the UI-created posture.
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig(),
        makeBridge(),
      );
      await ch.connect();
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes('any commenter')),
      ).toBe(true);
      ch.disconnect();
      stderr.mockClear();
      const restricted = new TestableAoneChannel(
        'test-aone',
        makeConfig({
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
        }),
        makeBridge(),
      );
      await restricted.connect();
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes('any commenter')),
      ).toBe(false);
      restricted.disconnect();
      stderr.mockRestore();
    });

    it('a per-repo allowlist with no "*" entry does NOT warn (R3-4)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({
          groups: {
            'test/repo': { senders: 'allowlist', allowedUsers: ['alice'] },
          },
        }),
        makeBridge(),
      );
      await ch.connect();
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes('any commenter')),
      ).toBe(false);
      ch.disconnect();
      stderr.mockRestore();
    });

    it('allowlist with no watched-repo groups entry warns dead channel (R3-4)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ groupPolicy: 'allowlist', groups: { '*': {} } }),
        makeBridge(),
      );
      await ch.connect();
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes(
            'every event will be rejected as not_allowlisted',
          ),
        ),
      ).toBe(true);
      // The all-dead posture must NOT also report the repos as open: nothing
      // dispatches there, so "any commenter can drive the agent" is false.
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes('any commenter')),
      ).toBe(false);
      ch.disconnect();
      stderr.mockRestore();
    });

    it('allowlist membership with open "*" senders warns permissive, not dead', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({
          groupPolicy: 'allowlist',
          groups: { '*': {}, 'test/repo': {} },
        }),
        makeBridge(),
      );
      await ch.connect();
      const permissive = stderr.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('any commenter'));
      expect(permissive).toBeDefined();
      // The warning must NAME the open repo, not be generic.
      expect(permissive).toContain('test/repo');
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes(
            'every event will be rejected as not_allowlisted',
          ),
        ),
      ).toBe(false);
      ch.disconnect();
      stderr.mockRestore();
    });

    it('mixed allowlist: an entry-less repo is dead, not reported open (verify-r3 F1)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({
          groupPolicy: 'allowlist',
          repos: ['test/a', 'test/b'],
          groups: {
            'test/a': { senders: 'allowlist', allowedUsers: ['alice'] },
          },
        }),
        makeBridge(),
      );
      await ch.connect();
      const lines = stderr.mock.calls.map((c) => String(c[0]));
      // test/b has no groups entry: the allowlist gate rejects it BEFORE the
      // sender gate, so its open-by-default senders are never reached. It
      // must not be reported as open.
      expect(lines.some((l) => l.includes('any commenter'))).toBe(false);
      // The mixed dead-repo diagnostic names test/b instead.
      expect(lines.some((l) => l.includes('no groups entry for test/b'))).toBe(
        true,
      );
      // Not the all-dead wording — test/a is reachable.
      expect(
        lines.some((l) =>
          l.includes('no watched repository has a groups entry'),
        ),
      ).toBe(false);
      ch.disconnect();
      stderr.mockRestore();
    });

    it('mixed allowlist names the dead repo and only the reachable open repo', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({
          groupPolicy: 'allowlist',
          repos: ['test/a', 'test/b', 'test/c'],
          groups: {
            'test/a': { senders: 'open' },
            'test/b': { senders: 'allowlist', allowedUsers: ['alice'] },
          },
        }),
        makeBridge(),
      );
      await ch.connect();
      const lines = stderr.mock.calls.map((c) => String(c[0]));
      const permissive = lines.find((l) => l.includes('any commenter'));
      expect(permissive).toBeDefined();
      expect(permissive).toContain('test/a');
      expect(permissive).not.toContain('test/b');
      expect(permissive).not.toContain('test/c');
      expect(lines.some((l) => l.includes('no groups entry for test/c'))).toBe(
        true,
      );
      ch.disconnect();
      stderr.mockRestore();
    });

    it('a case-normalized groups entry counts as reachable (no dead warning)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({
          groupPolicy: 'allowlist',
          groups: {
            'Test/Repo': { senders: 'allowlist', allowedUsers: ['alice'] },
          },
        }),
        makeBridge(),
      );
      await ch.connect();
      const lines = stderr.mock.calls.map((c) => String(c[0]));
      // normalizeGroupId folds 'Test/Repo' onto the watched 'test/repo', so
      // the entry is found and the repo is neither dead nor open.
      expect(lines.some((l) => l.includes('not_allowlisted'))).toBe(false);
      expect(lines.some((l) => l.includes('any commenter'))).toBe(false);
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

    it('senderName falls back to the author when user.name is not a string', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1001 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([
          makeEvent({
            id: 1002,
            author: 'Alice',
            user: { name: 12345, username: 'alice' },
          }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.senderId).toBe('alice');
      // user.name is numeric drift → fall back to the author string,
      // preserving its original case (not the lowercased senderId).
      expect(env.senderName).toBe('Alice');
    });

    it('chatId falls back to the watched repo when path_with_namespace drifts', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1001 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([
          makeEvent({
            id: 1002,
            projectDetail: { path_with_namespace: 999 },
          }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.chatId).toBe('test/repo');
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

    it('prunes cursor keys for unwatched repos so a re-add baselines fresh', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 500 })]) });
      await channel.connect();
      await channel.testPollOnce(); // cursor test/repo=500 persisted
      channel.disconnect();

      // Operator drops test/repo, watches other/repo for a while.
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['other/repo'] }),
        makeBridge(),
      );
      await ch.connect();
      expect(ch.cursor.repos['test/repo']).toBeUndefined();
      // R2-1: the prune must be persisted by connect ITSELF, before any
      // poll — a later connect failure (e.g. no a1 login) must not leave
      // the stale key on disk. A fresh instance loads the pruned state
      // without either channel having polled.
      const mid = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['other/repo'] }),
        makeBridge(),
      );
      expect(mid.cursor.repos['test/repo']).toBeUndefined();
      await ch.testPollOnce();
      ch.disconnect();

      // Re-adding test/repo must baseline fresh (no 3-day window replay):
      // the pruned cursor on disk has no stale test/repo key.
      const ch2 = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['test/repo', 'other/repo'] }),
        makeBridge(),
      );
      expect(ch2.cursor.repos['test/repo']).toBeUndefined();
      await ch2.connect();
      await ch2.testPollOnce();
      ch2.disconnect();
      expect(ch2.inboundEnvelopes).toHaveLength(0);
      expect(ch2.cursor.repos['test/repo']).toBe(500);
    });

    it('an unparseable createdAt is skipped fail-closed but logged', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([
          makeEvent({ id: 1001, createdAt: '16/11/2026 18:07' }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.repos['test/repo']).toBe(1001);
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('unparseable createdAt on event 1001'),
        ),
      ).toBe(true);
      stderr.mockRestore();
    });

    it('an authorless event is skipped fail-closed but logged (R2-8)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([
          makeEvent({ id: 1001, author: undefined, user: undefined }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.repos['test/repo']).toBe(1001);
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('event 1001 has no author'),
        ),
      ).toBe(true);
      stderr.mockRestore();
    });

    it('a bodyless event is skipped fail-closed but logged (R2-8)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      installFakeA1({
        events: pagedEvents([
          makeEvent({
            id: 1001,
            note: { id: 5001, noteable_type: 'MergeRequest' },
          }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.repos['test/repo']).toBe(1001);
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('event 1001 has no note body'),
        ),
      ).toBe(true);
      stderr.mockRestore();
    });

    it('a type-drifted author is skipped closed, no public error comment (R3-2)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      const calls = installFakeA1({
        events: pagedEvents([
          makeEvent({ id: 1001, author: 12345, user: undefined }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.repos['test/repo']).toBe(1001);
      expect(
        calls.filter((a) => a[0] === 'repo' && a[3] === 'create'),
      ).toHaveLength(0);
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('event 1001 has no author'),
        ),
      ).toBe(true);
      stderr.mockRestore();
    });

    it('an empty-string author is skipped fail-closed but logged', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline
      const calls = installFakeA1({
        events: pagedEvents([
          makeEvent({ id: 1001, author: '', user: undefined }),
        ]),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.repos['test/repo']).toBe(1001);
      expect(
        calls.filter((a) => a[0] === 'repo' && a[3] === 'create'),
      ).toHaveLength(0);
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('event 1001 has no author'),
        ),
      ).toBe(true);
      stderr.mockRestore();
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
      // PARTIAL failure: the round completes normally (base keeps the
      // configured pollInterval cadence — rethrowing would drop healthy
      // repos onto the backoff ladder); the failure is logged per repo.
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      await expect(ch.testPollOnce()).resolves.toBeUndefined();
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('poll failed for bad/repo'),
        ),
      ).toBe(true);
      stderr.mockRestore();
      ch.disconnect();
      // good/repo dispatched and persisted despite bad/repo's failure.
      expect(ch.inboundEnvelopes).toHaveLength(1);
      expect(ch.cursor.repos['good/repo']).toBe(2002);
      // The persistence claim is about DISK: a fresh instance must load
      // good/repo's advanced cursor despite the failed repo.
      const ch2 = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['good/repo', 'bad/repo'] }),
        makeBridge(),
      );
      expect(ch2.cursor.repos['good/repo']).toBe(2002);
    });

    it('a failing repo FIRST does not starve the repos after it', async () => {
      installFakeA1({
        events: (repo) =>
          repo === 'good/repo' ? [makeEvent({ id: 2001 })] : [],
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['bad/repo', 'good/repo'] }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline both
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
      // good/repo — listed AFTER the broken one — must be polled and
      // dispatched this round; the partial failure is logged, not rethrown.
      await expect(ch.testPollOnce()).resolves.toBeUndefined();
      ch.disconnect();
      expect(ch.inboundEnvelopes).toHaveLength(1);
      expect(ch.cursor.repos['good/repo']).toBe(2002);
    });

    it('a TOTAL failure rethrows so the base loop backs off', async () => {
      const err = {
        code: 1,
        stdout: JSON.stringify({
          schemaVersion: 'a1.error/v1',
          message: 'SYSTEM_FORBIDDEN_ERROR',
        }),
        stderr: '',
      };
      installFakeA1({
        events: () => {
          throw err;
        },
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['bad/repo', 'dead/repo'] }),
        makeBridge(),
      );
      await ch.connect();
      // Both repos fail their baseline fetch → total failure → rethrow.
      await expect(ch.testPollOnce()).rejects.toThrow('SYSTEM_FORBIDDEN_ERROR');
      ch.disconnect();
    });

    it('a partial failure leaves a durable per-repo journal record (R3-3)', async () => {
      installFakeA1({
        events: (repo) =>
          repo === 'good/repo' ? [makeEvent({ id: 2001 })] : [],
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['good/repo', 'bad/repo'] }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline both
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
      await expect(ch.testPollOnce()).resolves.toBeUndefined();
      ch.disconnect();
      // The round resolved (partial failure), so the base journal shows ok;
      // the broken repo must still leave a durable repo_failed record.
      const files = readdirSync(join(tempDir, 'channels'), {
        recursive: true,
      }) as string[];
      const journal = files.find((f) =>
        String(f).endsWith('-channel-events.jsonl'),
      );
      expect(journal).toBeDefined();
      const records = readFileSync(
        join(tempDir, 'channels', String(journal)),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const failure = records.find(
        (r) => r.outcome === 'repo_failed' && r.repository === 'bad/repo',
      );
      expect(failure).toBeDefined();
      expect(failure.type).toBe('poll');
      expect(String(failure.error)).toContain('SYSTEM_FORBIDDEN_ERROR');
    });

    it('the repo_failed journal error stays bounded and single-line', async () => {
      const longMessage = 'FORBIDDEN ' + 'x'.repeat(500);
      installFakeA1({
        events: (repo) =>
          repo === 'good/repo' ? [makeEvent({ id: 2001 })] : [],
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ repos: ['good/repo', 'bad/repo'] }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline both
      installFakeA1({
        events: (repo) => {
          if (repo === 'bad/repo') {
            throw {
              code: 1,
              stdout: JSON.stringify({
                schemaVersion: 'a1.error/v1',
                message: longMessage,
              }),
              stderr: '',
            };
          }
          return [makeEvent({ id: 2002 })];
        },
      });
      await ch.testPollOnce();
      ch.disconnect();
      const files = readdirSync(join(tempDir, 'channels'), {
        recursive: true,
      }) as string[];
      const journal = files.find((f) =>
        String(f).endsWith('-channel-events.jsonl'),
      );
      const records = readFileSync(
        join(tempDir, 'channels', String(journal)),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const failure = records.find(
        (r) => r.outcome === 'repo_failed' && r.repository === 'bad/repo',
      );
      expect(failure).toBeDefined();
      // The status page reads this field verbatim: a 510-char cause must not
      // balloon the row. The journal write normalizes to 200 code points and
      // the adapter sanitizes too (defense in depth).
      expect(String(failure.error).length).toBeLessThanOrEqual(200);
      expect(String(failure.error)).not.toContain('\n');
      expect(String(failure.error)).toContain('FORBIDDEN');
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

    it('dispatches each boundary event once when offset pagination repeats it', async () => {
      // A comment landing between the page-1 and page-2 fetches shifts every
      // offset: page 2 repeats page 1's last event (id 1901).
      const withNoteId = (id: number) =>
        makeEvent({
          id,
          note: {
            id,
            note: 'qwen: do something',
            noteable_type: 'MergeRequest',
          },
        });
      const page1 = Array.from({ length: 100 }, (_, i) => withNoteId(2000 - i));
      const page2 = [
        withNoteId(1901),
        ...Array.from({ length: 50 }, (_, i) => withNoteId(1900 - i)),
      ];
      installFakeA1({
        events: (_repo, page) => (page === 1 ? page1 : page2),
      });
      await channel.connect();
      channel.cursor.repos['test/repo'] = 1800;
      await channel.testPollOnce();
      channel.disconnect();
      // 150 unique events, but the universal budget dispatches the oldest
      // 100 this poll; the duplicated id 1901 must appear exactly once.
      expect(channel.inboundEnvelopes).toHaveLength(100);
      expect(
        channel.inboundEnvelopes.filter((e) => e.messageId === '1901'),
      ).toHaveLength(1);
    });

    it('breaks on the cursor inside a FULL page 10 (no overflow walk)', async () => {
      // 1000 events ids 5000..4001; cursor 4100 sits inside page 10
      // (4100..4001). reachedCursor must break the walk at page 10; the
      // universal budget then dispatches the oldest 100 (4101..4200).
      // Without reachedCursor the walk continues to the empty page 11 and
      // the oldest slice becomes 4001..4100 — a different cursor.
      const all = Array.from({ length: 1000 }, (_, i) =>
        makeEvent({ id: 5000 - i }),
      );
      const calls = installFakeA1({ events: pagedEvents(all) });
      await channel.connect();
      channel.cursor.repos['test/repo'] = 4100;
      await channel.testPollOnce();
      channel.disconnect();
      const pages = calls
        .filter((argv) => argv[0] === 'events')
        .map((argv) => Number(argv[argv.indexOf('--page') + 1]));
      expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(channel.inboundEnvelopes).toHaveLength(100);
      expect(channel.cursor.repos['test/repo']).toBe(4200);
    });

    it('overflow walks to the tail and dispatches the oldest bounded slice', async () => {
      const all = Array.from({ length: 1200 }, (_, i) => {
        const id = 5000 - i;
        return makeEvent({
          id,
          note: {
            id,
            note: 'qwen: do something',
            noteable_type: 'MergeRequest',
          },
        });
      });
      const calls = installFakeA1({ events: pagedEvents(all) });
      await channel.connect();
      channel.cursor.repos['test/repo'] = 3800; // everything is newer
      await expect(channel.testPollOnce()).resolves.toBeUndefined();
      const pages = calls
        .filter((argv) => argv[0] === 'events')
        .map((argv) => Number(argv[argv.indexOf('--page') + 1]));
      // 12 full pages + the empty page 13 that ends the walk.
      expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      // Oldest 100 (3801..3900) dispatched; the cursor never crosses the
      // unfetched gap; the remainder drains on later polls.
      expect(channel.inboundEnvelopes).toHaveLength(100);
      expect(channel.cursor.repos['test/repo']).toBe(3900);
      expect(
        channel.inboundEnvelopes.every(
          (e) => Number(e.messageId) >= 3801 && Number(e.messageId) <= 3900,
        ),
      ).toBe(true);

      // Next poll drains the next oldest slice (progress, no wedge).
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(200);
      expect(channel.cursor.repos['test/repo']).toBe(4000);
    });

    it('a midnight-crossing walk keeps ONE window for all pages (R2-9)', async () => {
      // Page 2 is fetched after local midnight; the window must not shift
      // between pages (per-call dates would drop the oldest day and save
      // the cursor above unfetched events — permanent silent loss).
      const all = Array.from({ length: 150 }, (_, i) =>
        makeEvent({ id: 1000 - i }),
      );
      vi.useFakeTimers({ now: new Date('2026-11-16T23:59:50') });
      try {
        const calls = installFakeA1({
          events: (_repo, page) => {
            const slice = all.slice((page - 1) * 100, page * 100);
            if (page === 1) {
              // Midnight falls BETWEEN the two page fetches: a per-call
              // window computes page 2's dates after this advance, while
              // the once-per-poll window is already fixed.
              vi.setSystemTime(new Date('2026-11-17T00:00:05'));
            }
            return slice;
          },
        });
        await channel.connect();
        channel.cursor.repos['test/repo'] = 800;
        await channel.testPollOnce();
        channel.disconnect();
        const eventCalls = calls.filter((argv) => argv[0] === 'events');
        expect(eventCalls).toHaveLength(2);
        const win = (argv: string[]) => [
          argv[argv.indexOf('--since') + 1],
          argv[argv.indexOf('--until') + 1],
        ];
        expect(win(eventCalls[0]!)).toEqual(win(eventCalls[1]!));
        expect(win(eventCalls[0]!)).toEqual(['2026-11-13', '2026-11-16']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an aged-out cursor jump is diagnosed; a dormant repo is not (R3-1)', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      await channel.connect();
      await channel.testPollOnce(); // baseline at 1000
      // Dormant: empty window, cursor unchanged, NO aging warning.
      installFakeA1({ events: () => [] });
      await channel.testPollOnce();
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes('aged out')),
      ).toBe(false);
      expect(channel.cursor.repos['test/repo']).toBe(1000);
      stderr.mockClear();
      // Resume: the cursor event aged out; all window events are newer.
      installFakeA1({
        events: pagedEvents(
          Array.from({ length: 50 }, (_, i) => makeEvent({ id: 2050 - i })),
        ),
      });
      await channel.testPollOnce();
      channel.disconnect();
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('cursor for test/repo aged out'),
        ),
      ).toBe(true);
      expect(channel.inboundEnvelopes).toHaveLength(50);
      expect(channel.cursor.repos['test/repo']).toBe(2050);
      stderr.mockRestore();
    });

    it('the dispatch budget is monotonic: a 500-event backlog caps at 100', async () => {
      const all = Array.from({ length: 500 }, (_, i) => {
        const id = 3000 - i;
        return makeEvent({
          id,
          note: {
            id,
            note: 'qwen: do something',
            noteable_type: 'MergeRequest',
          },
        });
      });
      installFakeA1({ events: pagedEvents(all) });
      await channel.connect();
      channel.cursor.repos['test/repo'] = 2500; // everything is newer
      await channel.testPollOnce();
      channel.disconnect();
      expect(channel.inboundEnvelopes).toHaveLength(100);
      expect(channel.cursor.repos['test/repo']).toBe(2600);
    });

    it('throws only beyond the platform window (100 full pages)', async () => {
      const calls = installFakeA1({
        events: (_repo, page) =>
          Array.from({ length: 100 }, (_, i) =>
            makeEvent({ id: 1000000 - (page - 1) * 100 - i }),
          ),
      });
      await channel.connect();
      channel.cursor.repos['test/repo'] = 0;
      await expect(channel.testPollOnce()).rejects.toThrow(
        /exceeds the platform window/,
      );
      channel.disconnect();
      expect(channel.cursor.repos['test/repo']).toBe(0);
      expect(channel.inboundEnvelopes).toHaveLength(0);
      // Pins PLATFORM_MAX_PAGES=100 (R2-5): the walk must fetch exactly
      // pages 1..100 before throwing; a smaller ceiling changes the length.
      const pages = calls
        .filter((argv) => argv[0] === 'events')
        .map((argv) => Number(argv[argv.indexOf('--page') + 1]));
      expect(pages).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
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

    it('a failing view is negatively cached: one call per MR per poll, not per event', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      installFakeA1({
        events: pagedEvents([makeEvent({ id: 1000 })]),
      });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: 't=%title% u=%url%' }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline at 1000
      const calls = installFakeA1({
        events: pagedEvents([makeEvent({ id: 1002 }), makeEvent({ id: 1001 })]),
        view: () => {
          throw { code: 1, stdout: '', stderr: 'view forbidden' };
        },
      });
      await ch.testPollOnce(); // two events, same MR, view fails
      ch.disconnect();
      stderr.mockRestore();
      const views = calls.filter(
        (argv) => argv[0] === 'repo' && argv[2] === 'view',
      );
      expect(views).toHaveLength(1);
      expect(ch.inboundEnvelopes).toHaveLength(2);
      expect(ch.inboundEnvelopes[0]!.metadata).toBe('t= u=');
      expect(ch.inboundEnvelopes[1]!.metadata).toBe('t= u=');
    });

    it('an empty promptTemplate falls back to the default (descriptor contract)', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: '' }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1001 })]) });
      await ch.testPollOnce();
      ch.disconnect();
      expect(ch.inboundEnvelopes[0]!.metadata).toBe(
        'Aone CR test/repo !30825167 (iid 1736615) | author: alice | comment: 5000',
      );
    });

    it('a whitespace-only promptTemplate also falls back (R2-2)', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: '   ' }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1001 })]) });
      await ch.testPollOnce();
      ch.disconnect();
      expect(ch.inboundEnvelopes[0]!.metadata).toBe(
        'Aone CR test/repo !30825167 (iid 1736615) | author: alice | comment: 5000',
      );
    });

    it('the negative view cache is per-poll: a later poll retries (R2-6)', async () => {
      installFakeA1({ events: pagedEvents([makeEvent({ id: 1000 })]) });
      const ch = new TestableAoneChannel(
        'test-aone',
        makeConfig({ promptTemplate: 't=%title%' }),
        makeBridge(),
      );
      await ch.connect();
      await ch.testPollOnce(); // baseline at 1000
      // Poll 1: view fails → negative cache, empty title.
      const calls1 = installFakeA1({
        events: pagedEvents([makeEvent({ id: 1001 })]),
        view: () => {
          throw { code: 1, stdout: '', stderr: 'transient' };
        },
      });
      await ch.testPollOnce();
      // Poll 2: view succeeds → the negative entry must be gone.
      const calls2 = installFakeA1({
        events: pagedEvents([makeEvent({ id: 1002 })]),
      });
      await ch.testPollOnce();
      ch.disconnect();
      expect(
        calls1.filter((a) => a[0] === 'repo' && a[2] === 'view'),
      ).toHaveLength(1);
      expect(
        calls2.filter((a) => a[0] === 'repo' && a[2] === 'view'),
      ).toHaveLength(1);
      expect(ch.inboundEnvelopes[0]!.metadata).toBe('t=');
      expect(ch.inboundEnvelopes[1]!.metadata).toBe('t=Stub MR title');
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
      // Pins the numeric-only defensive check (verify-round survivor M11:
      // widening the regex to mr:(.*) must not let a non-numeric id through).
      await expect(
        channel.testSendThreadMessage('test/repo', 'mr:abc', 'x'),
      ).rejects.toThrow(/threadId/);
      await expect(
        channel.testSendThreadMessage('test/repo', 'mr:12x', 'x'),
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
