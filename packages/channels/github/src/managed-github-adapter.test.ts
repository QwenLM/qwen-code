/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedChannelControlPlane,
  ManagedClaimedDelivery,
  ManagedInboundEvent,
} from '@qwen-code/channel-base';
import { CHANNEL_INBOUND_TRUNCATION_NOTICE } from '@qwen-code/channel-base';
import {
  ManagedGithubAdapter,
  githubSettings,
  type GithubComment,
  type GithubNotification,
  type GithubSendFailure,
  type ManagedGithubAdapterDeps,
  type ManagedGithubClient,
} from './managed-github-adapter.js';
import {
  MANAGED_GITHUB_PENDING_LIMIT,
  ManagedGithubStateStore,
  type ManagedGithubState,
} from './managed-state.js';

const CONFIG = {
  type: 'github',
  token: 'ghp_test_token',
  allowedUsers: ['alice'],
  dispatchMode: 'followup',
};

const NOW = 1_763_287_200_000; // 2025-11-16T10:00:00Z-ish fixed clock

function notification(
  overrides: Partial<GithubNotification> = {},
): GithubNotification {
  return {
    id: 'n-1',
    reason: 'mention',
    updated_at: '2026-11-16T10:00:00Z',
    subject: {
      title: 'Issue title',
      url: 'https://api.github.com/repos/Owner/Repo/issues/7',
      type: 'Issue',
    },
    ...overrides,
  };
}

function comment(overrides: Partial<GithubComment> = {}): GithubComment {
  return {
    id: 101,
    node_id: 'IC_101',
    body: '@bot-user please help',
    created_at: '2026-11-16T09:59:00Z',
    user: { login: 'Alice' },
    ...overrides,
  };
}

function fakeControlPlane(journal: string[]) {
  const register: unknown[] = [];
  const submit: ManagedInboundEvent[] = [];
  const receipts: Array<{ deliveryId: string; receipt: unknown }> = [];
  const admitted = new Map<string, string>();
  let queue: ManagedClaimedDelivery[] = [];
  let disconnectCalls = 0;
  let refuseSubmit: { status: number; code?: string } | undefined;
  let refuseClaim: { status: number; code?: string } | undefined;
  const claimLimits: number[] = [];
  let receiptError:
    | ((
        deliveryId: string,
      ) => (Error & { status?: number; code?: string }) | undefined)
    | undefined;
  const controlPlane: ManagedChannelControlPlane = {
    register: async (request) => {
      journal.push('register');
      register.push(request);
    },
    disconnect: async () => {
      disconnectCalls += 1;
    },
    submitInbound: async (event) => {
      journal.push(`submit:${event.platformEventId}`);
      if (refuseSubmit) {
        throw Object.assign(new Error(`HTTP ${refuseSubmit.status}`), {
          status: refuseSubmit.status,
          code: refuseSubmit.code,
        });
      }
      submit.push(event);
      const existing = admitted.get(event.platformEventId);
      if (existing)
        return { inputId: existing, sessionId: 'session-1', replayed: true };
      const inputId = `input-${admitted.size + 1}`;
      admitted.set(event.platformEventId, inputId);
      return { inputId, sessionId: 'session-1', replayed: false };
    },
    claimDeliveries: async (limit) => {
      claimLimits.push(limit);
      if (refuseClaim) {
        throw Object.assign(new Error(`HTTP ${refuseClaim.status}`), {
          status: refuseClaim.status,
          code: refuseClaim.code,
        });
      }
      return queue.splice(0);
    },
    receipt: async (deliveryId, receipt) => {
      const error = receiptError?.(deliveryId);
      if (error) throw error;
      journal.push(`receipt:${deliveryId}:${receipt.outcome}`);
      receipts.push({ deliveryId, receipt });
    },
  };
  return {
    controlPlane,
    register,
    submit,
    receipts,
    claimLimits,
    disconnectCalls: () => disconnectCalls,
    enqueue: (deliveries: ManagedClaimedDelivery[]) => {
      queue = deliveries;
    },
    markAdmitted: (eventId: string) => {
      admitted.set(eventId, `input-${admitted.size + 1}`);
    },
    setRefuseSubmit: (value: { status: number; code?: string } | undefined) => {
      refuseSubmit = value;
    },
    setRefuseClaim: (value: { status: number; code?: string } | undefined) => {
      refuseClaim = value;
    },
    setReceiptError: (
      fn:
        | ((
            deliveryId: string,
          ) => (Error & { status?: number; code?: string }) | undefined)
        | undefined,
    ) => {
      receiptError = fn;
    },
  };
}

function fakeDeps(
  journal: string[],
  hooks: { log?: (line: string) => void } = {},
) {
  const knobs = {
    identity: 'bot-user',
    identityError: undefined as Error | undefined,
    notifications: [] as GithubNotification[],
    comments: [] as GithubComment[],
    commentsFor: undefined as
      | ((issueNumber: number) => GithubComment[])
      | undefined,
    listCommentsError: undefined as Error | undefined,
    listCommentsDelay: undefined as (() => Promise<void>) | undefined,
    listNotificationsError: undefined as Error | undefined,
    markReadError: undefined as Error | undefined,
    sendBehavior: 'ok' as 'ok' | 'definitive' | 'transient',
    pollFloor: 0,
  };
  const posted: Array<{
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }> = [];
  const markedRead: string[] = [];
  const sinceSeen: string[] = [];
  let compromised: (() => void) | undefined;
  const client: ManagedGithubClient = {
    resolveIdentity: async () => {
      if (knobs.identityError) throw knobs.identityError;
      return knobs.identity;
    },
    listNotifications: async (since) => {
      journal.push('listNotifications');
      sinceSeen.push(since);
      if (knobs.listNotificationsError) throw knobs.listNotificationsError;
      return knobs.notifications;
    },
    listComments: async (_owner, _repo, issueNumber) => {
      journal.push('listComments');
      if (knobs.listCommentsDelay) await knobs.listCommentsDelay();
      if (knobs.listCommentsError) throw knobs.listCommentsError;
      return knobs.commentsFor
        ? knobs.commentsFor(issueNumber)
        : knobs.comments;
    },
    markThreadRead: async (threadId) => {
      journal.push(`markRead:${threadId}`);
      if (knobs.markReadError) throw knobs.markReadError;
      markedRead.push(threadId);
    },
    postComment: async (owner, repo, issueNumber, body) => {
      journal.push('postComment');
      if (knobs.sendBehavior !== 'ok') {
        const error = new Error(
          knobs.sendBehavior === 'definitive' ? 'refused' : 'timeout',
        ) as GithubSendFailure;
        error.definitive = knobs.sendBehavior === 'definitive';
        throw error;
      }
      posted.push({ owner, repo, issueNumber, body });
      return { id: 9000 + posted.length };
    },
    pollIntervalFloorMs: () => knobs.pollFloor,
    disconnect: () => {},
  };
  const deps: ManagedGithubAdapterDeps = {
    createClient: async () => client,
    // Model proper-lockfile's mutual exclusion (retries:0): a held directory
    // rejects a second owner, and only the returned release function frees
    // it — so a connect failure path that forgets to release is observable.
    lock: async (directory, onCompromised) => {
      if (lockHeld.has(directory)) {
        throw new Error('ELOCKED');
      }
      lockHeld.add(directory);
      compromised = onCompromised;
      return async () => {
        lockHeld.delete(directory);
      };
    },
    now: () => NOW,
    log: hooks.log ?? (() => {}),
  };
  return {
    deps,
    knobs,
    posted,
    markedRead,
    sinceSeen,
    compromise: () => compromised!(),
  };
}

function delivery(
  deliveryId: string,
  segments: number,
  replyContext: unknown = {
    owner: 'Owner',
    repo: 'Repo',
    issueNumber: 7,
    senderId: 'alice',
  },
): ManagedClaimedDelivery {
  return {
    deliveryId,
    replyContext,
    segments: Array.from({ length: segments }, (_, ordinal) => ({
      ordinal,
      segmentId: `${deliveryId}:${ordinal}`,
      text: `segment ${ordinal}`,
    })),
  };
}

const tempDirs: string[] = [];
// Shared across fake instances so two adapters on one state directory meet
// the same mutual exclusion production proper-lockfile enforces.
const lockHeld = new Set<string>();
function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-github-'));
  tempDirs.push(dir);
  return dir;
}
// The state store lives under getGlobalQwenDir(), not the workspace cwd; keep
// it inside the sandbox so a run never writes channel state into the real
// global Qwen directory.
beforeEach(() => {
  vi.stubEnv('QWEN_HOME', tempCwd());
  lockHeld.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function connectedAdapter(
  cwd = tempCwd(),
  config: Record<string, unknown> = CONFIG,
  hooks: { log?: (line: string) => void } = {},
  rawConfig?: Record<string, unknown>,
) {
  const journal: string[] = [];
  const plane = fakeControlPlane(journal);
  const fake = fakeDeps(journal, hooks);
  const adapter = new ManagedGithubAdapter({
    name: 'gh-1',
    cwd,
    config,
    ...(rawConfig !== undefined ? { rawConfig } : {}),
    controlPlane: plane.controlPlane,
    deps: fake.deps,
    pollLoop: false,
  });
  await adapter.connect();
  return { adapter, plane, fake, journal };
}

function readState(adapter: ManagedGithubAdapter): ManagedGithubState {
  return JSON.parse(
    readFileSync(adapter.stateFile, 'utf8'),
  ) as ManagedGithubState;
}

function seedState(
  adapter: ManagedGithubAdapter,
  mutate: (state: ReturnType<typeof readState>) => void,
): void {
  const state = readState(adapter);
  mutate(state);
  writeFileSync(adapter.stateFile, JSON.stringify(state));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pendingEntry(
  eventId: string,
  senderId: string,
  held?: boolean,
): {
  eventId: string;
  event: ManagedInboundEvent;
  notificationThreadId: string;
  held?: boolean;
} {
  return {
    eventId,
    event: {
      accountGeneration: 1,
      platformEventId: eventId,
      semanticRevision: 1,
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: 'owner/repo',
        threadId: 'issue:7',
      },
      senderId,
      chatId: 'owner/repo',
      threadId: 'issue:7',
      subject: 'Issue title',
      text: '@bot-user please help',
      attachments: [],
      replyContext: { owner: 'Owner', repo: 'Repo', issueNumber: 7, senderId },
    },
    notificationThreadId: 'n-1',
    ...(held ? { held: true } : {}),
  };
}

describe('managed GitHub adapter config', () => {
  it('requires a token and refuses useLocalGh', () => {
    expect(() => githubSettings({ type: 'github' })).toThrow(
      /requires a token/,
    );
    expect(() => githubSettings({ type: 'github', useLocalGh: true })).toThrow(
      /does not support useLocalGh/,
    );
    expect(() =>
      githubSettings({ type: 'github', token: 'ghp_x\r\n' }),
    ).toThrow(/requires a token/);
  });

  it('refuses pairing and defaults the flat sender policy', () => {
    expect(
      () =>
        new ManagedGithubAdapter({
          name: 'gh-1',
          cwd: tempCwd(),
          config: { ...CONFIG, privatePolicy: 'pairing' },
          controlPlane: fakeControlPlane([]).controlPlane,
          deps: fakeDeps([]).deps,
          pollLoop: false,
        }),
    ).toThrow(/does not support privatePolicy "pairing"/);
    const settings = githubSettings({ token: 'ghp_x' });
    expect(settings.baseUrl).toBe('https://api.github.com');
    expect(settings.pollInterval).toBe(60_000);
  });

  it('clamps a hot-loop pollInterval and reports the rewrite', () => {
    const lines: string[] = [];
    const settings = githubSettings({ token: 'ghp_x', pollInterval: 5 });
    expect(settings.pollInterval).toBe(60_000);
    expect(settings.pollIntervalRewritten).toBe(true);
    new ManagedGithubAdapter({
      name: 'gh-1',
      cwd: tempCwd(),
      config: { ...CONFIG, pollInterval: 5 },
      controlPlane: fakeControlPlane([]).controlPlane,
      deps: fakeDeps([], { log: (line) => lines.push(line) }).deps,
      pollLoop: false,
    });
    expect(
      lines.some((line) => /pollInterval 5 .*using 60000 ms/.test(line)),
    ).toBe(true);
  });

  it('lowercases the repoFilter allowlist and refuses a malformed one', () => {
    expect(
      githubSettings({
        token: 'ghp_x',
        repoFilter: ['Owner/Repo'],
        repoFilterMode: 'allowlist',
      }).repoFilter,
    ).toEqual(['owner/repo']);
    expect(() =>
      githubSettings({
        token: 'ghp_x',
        repoFilter: 'owner/repo',
        repoFilterMode: 'allowlist',
      }),
    ).toThrow(/repoFilter must be a non-empty array/);
    // An empty allowlist would silently drop every event while reporting
    // running; the Legacy validator refuses it for the same reason.
    expect(() =>
      githubSettings({
        token: 'ghp_x',
        repoFilter: [],
        repoFilterMode: 'allowlist',
      }),
    ).toThrow(/repoFilter must be a non-empty array/);
    expect(() =>
      githubSettings({
        token: 'ghp_x',
        repoFilter: ['myrepo'],
        repoFilterMode: 'allowlist',
      }),
    ).toThrow(/repoFilter must be a non-empty array/);
  });

  it('validates both repoFilter quadrants: mode needs a list, a list needs a mode', () => {
    // Declaring an allowlist without a list must not fail open to every repo.
    expect(() =>
      githubSettings({ token: 'ghp_x', repoFilterMode: 'allowlist' }),
    ).toThrow(/requires a non-empty repoFilter array/);
    // Legacy reads a list with no mode as "filter off"; promoting it to an
    // active allowlist would answer only inside the parked repos.
    expect(() =>
      githubSettings({ token: 'ghp_x', repoFilter: ['octo/noisy-repo'] }),
    ).toThrow(/requires repoFilterMode "allowlist"/);
  });

  it('starts off-mode as no filter and refuses only the invertible blocklist', () => {
    // The plugin descriptor defaults repoFilterMode to 'off' and the Web Shell
    // editor seeds 'off' on save, so an off-only config (the product default)
    // must start as "no repository filtering" — there is no list to invert.
    expect(
      githubSettings({ token: 'ghp_x', repoFilterMode: 'off' }).repoFilter,
    ).toBeUndefined();
    expect(
      githubSettings({
        token: 'ghp_x',
        repoFilter: ['org/parked'],
        repoFilterMode: 'off',
      }).repoFilter,
    ).toBeUndefined();
    // A blocklist with no list also filters nothing.
    expect(
      githubSettings({ token: 'ghp_x', repoFilterMode: 'blocklist' })
        .repoFilter,
    ).toBeUndefined();
    // A blocklist WITH a list is the invertible shape: reading it as an
    // allowlist would answer only in the repos the operator blocked.
    expect(() =>
      githubSettings({
        token: 'ghp_x',
        repoFilter: ['org/private'],
        repoFilterMode: 'blocklist',
      }),
    ).toThrow(/only as an allowlist/);
    expect(
      githubSettings({
        token: 'ghp_x',
        repoFilter: ['org/repo'],
        repoFilterMode: 'allowlist',
      }).repoFilter,
    ).toEqual(['org/repo']);
  });

  it('requires an absolute http(s) baseUrl and normalizes endpoint spellings', () => {
    // WHATWG parses a scheme-less host:port/path with an empty hostname; it
    // must not pass validation and fail later as "unknown scheme".
    expect(() =>
      githubSettings({
        token: 'ghp_x',
        baseUrl: 'ghe.example.com:8443/api/v3',
      }),
    ).toThrow(/absolute http\(s\) URL with a host/);
    expect(() =>
      githubSettings({ token: 'ghp_x', baseUrl: 'ftp://ghe.example.com' }),
    ).toThrow(/absolute http\(s\) URL with a host/);
    // Trailing slash and host case are one endpoint, one state directory.
    const a = githubSettings({
      token: 'ghp_x',
      baseUrl: 'https://GHE.example.com/api/v3/',
    }).baseUrl;
    const b = githubSettings({
      token: 'ghp_x',
      baseUrl: 'https://ghe.example.com/api/v3',
    }).baseUrl;
    expect(a).toBe(b);
    expect(a).toBe('https://ghe.example.com/api/v3');
  });

  it('preserves a valid pollInterval and accepts steer/disabled/baseUrl validation', () => {
    const settings = githubSettings({ token: 'ghp_x', pollInterval: 30_000 });
    expect(settings.pollInterval).toBe(30_000);
    expect(settings.pollIntervalRewritten).toBeFalsy();
    expect(() =>
      githubSettings({ token: 'ghp_x', baseUrl: 'not a url' }),
    ).toThrow(/baseUrl is not a valid URL/);
  });

  it('registers steer dispatch and refuses every sender under disabled', async () => {
    const steer = await connectedAdapter(tempCwd(), {
      ...CONFIG,
      dispatchMode: 'steer',
    });
    expect(steer.plane.register[0]).toMatchObject({
      policy: { dispatchMode: 'steer' },
    });
    await steer.adapter.disconnect();

    const disabled = await connectedAdapter(tempCwd(), {
      ...CONFIG,
      privatePolicy: 'disabled',
    });
    disabled.fake.knobs.notifications = [notification()];
    disabled.fake.knobs.comments = [comment()];
    await disabled.adapter.tick();
    expect(disabled.plane.submit).toHaveLength(0);
    await disabled.adapter.disconnect();
  });
});

describe('managed GitHub adapter inbound', () => {
  it('registers the github platform, bot account and resolved policy', async () => {
    const { adapter, plane } = await connectedAdapter();
    expect(plane.register).toHaveLength(1);
    expect(plane.register[0]).toEqual({
      platform: 'github',
      accountId: 'bot-user',
      accountGeneration: 1,
      policy: {
        adapter: 'github',
        senderPolicy: 'allowlist',
        allowedSenders: ['alice'],
        dispatchMode: 'followup',
      },
    });
    await adapter.disconnect();
  });

  it('admits a mention comment once with the chat_thread mapping', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const event = plane.submit[0]!;
    expect(event.platformEventId).toBe('github:IC_101');
    expect(event.scope).toEqual({
      kind: 'chat_thread',
      senderId: null,
      chatId: 'owner/repo',
      threadId: 'issue:7',
    });
    expect(event.senderId).toBe('alice');
    expect(event.subject).toBe('Issue title');
    expect(event.text).toBe('@bot-user please help');
    expect(event.attachments).toEqual([]);
    expect(event.replyContext).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      issueNumber: 7,
      senderId: 'alice',
    });
    // A re-listed notification admits nothing new.
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('maps a PR subject to pr:N and keeps the API casing for the reply', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [
      notification({
        subject: {
          title: 'PR title',
          url: 'https://api.github.com/repos/Owner/Repo/pulls/9',
          type: 'PullRequest',
        },
      }),
    ];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit[0]!.threadId).toBe('pr:9');
    expect(plane.submit[0]!.replyContext).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      issueNumber: 9,
      senderId: 'alice',
    });
    await adapter.disconnect();
  });

  it('ignores non-mention reasons and non-thread subjects', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.comments = [comment()];
    for (const reason of ['comment', 'assign', 'review_requested', 'author']) {
      fake.knobs.notifications = [notification({ id: `n-${reason}`, reason })];
      await adapter.tick();
    }
    fake.knobs.notifications = [
      notification({
        id: 'n-repo',
        subject: {
          title: 'Release',
          url: 'https://api.github.com/repos/Owner/Repo/releases/1',
          type: 'Release',
        },
      }),
    ];
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('ignores own comments and comments without a bot mention', async () => {
    // Admit the bot login in the allowlist so the own-comment guard is the
    // ONLY thing rejecting IC_own — with alice-only, the sender policy would
    // reject Bot-User too and the guard could be deleted without reddening.
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      ...CONFIG,
      allowedUsers: ['alice', 'bot-user'],
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [
      comment({ id: 1, node_id: 'IC_own', user: { login: 'Bot-User' } }),
      comment({ id: 2, node_id: 'IC_plain', body: 'no mention here' }),
    ];
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('gates senders by the allowlist and admits under open', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment({ user: { login: 'Bob' } })];
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();

    const open = await connectedAdapter(tempCwd(), {
      ...CONFIG,
      privatePolicy: 'open',
    });
    open.fake.knobs.notifications = [notification()];
    open.fake.knobs.comments = [comment({ user: { login: 'Bob' } })];
    await open.adapter.tick();
    expect(open.plane.submit).toHaveLength(1);
    expect(open.plane.submit[0]!.senderId).toBe('bob');
    await open.adapter.disconnect();
  });

  it('filters repositories by the repoFilter allowlist', async () => {
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      ...CONFIG,
      repoFilter: ['other/repo'],
      repoFilterMode: 'allowlist',
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('truncates over-long text to the wire and envelope bounds', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    // 65,536 ASCII characters: over the 32,000 UTF-16 wire bound.
    fake.knobs.comments = [
      comment({ body: `@bot-user ${'x'.repeat(65_536)}` }),
    ];
    await adapter.tick();
    const ascii = plane.submit[0]!.text;
    expect(ascii.length).toBeLessThanOrEqual(32_000);
    expect(ascii.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    // 25,000 CJK characters sit under the 32,000 character line but their
    // 75,000 UTF-8 bytes overflow the 64 KiB JSON envelope; the byte cut must
    // land on a code-point boundary.
    fake.knobs.comments = [
      comment({
        id: 2,
        node_id: 'IC_cjk',
        body: `@bot-user ${'汉'.repeat(25_000)}`,
      }),
    ];
    await adapter.tick();
    const cjk = plane.submit[1]!.text;
    expect(cjk.length).toBeLessThan(25_000);
    expect(cjk.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    // Mirror the production budget exactly: JSON-serialized bytes minus the
    // two quote characters (fitInboundText's encodedBytes).
    expect(
      Buffer.byteLength(JSON.stringify(cjk), 'utf8') - 2,
    ).toBeLessThanOrEqual(64 * 1024 - 4096);
    expect(/[\uD800-\uDBFF]$/.test(cjk)).toBe(false);
    // Astral plane: the reduced core char cap lands inside a surrogate pair;
    // the backoff must drop the lone high surrogate. BMP-only fixtures above
    // can never exercise this branch. The '@bot-user ' prefix is 10 units, so
    // coreCharLimit - 11 x's place the pair's high surrogate at the core cut.
    const coreCharLimit = 32_000 - CHANNEL_INBOUND_TRUNCATION_NOTICE.length;
    fake.knobs.comments = [
      comment({
        id: 3,
        node_id: 'IC_astral',
        body: `@bot-user ${'x'.repeat(coreCharLimit - 11)}${'😀'.repeat(100)}`,
      }),
    ];
    await adapter.tick();
    const astral = plane.submit[2]!.text;
    expect(astral.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    expect(astral.length).toBe(31_999);
    expect(/[\uD800-\uDBFF]$/.test(astral)).toBe(false);
    // Escape inflation: 30,000 control characters are only 30,010 raw UTF-8
    // bytes but serialize to ~180,012 envelope bytes; the JSON-escaped budget
    // must cut them, not the raw-byte budget.
    fake.knobs.comments = [
      comment({
        id: 4,
        node_id: 'IC_ctrl',
        body: `@bot-user ${'\u0001'.repeat(30_000)}`,
      }),
    ];
    await adapter.tick();
    const ctrl = plane.submit[3]!.text;
    expect(ctrl.length).toBeLessThan(30_010);
    expect(ctrl.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(ctrl), 'utf8') - 2,
    ).toBeLessThanOrEqual(64 * 1024 - 4096);
    await adapter.disconnect();
  });

  it('clamps the subject to the wire bound', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [
      notification({
        subject: {
          title: 't'.repeat(300),
          url: 'https://api.github.com/repos/Owner/Repo/issues/7',
          type: 'Issue',
        },
      }),
    ];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit[0]!.subject).toHaveLength(200);
    // The 200-unit slice lands inside a surrogate pair: fitSubject's backoff
    // must drop the lone high surrogate.
    fake.knobs.notifications = [
      notification({
        subject: {
          title: `${'t'.repeat(199)}😀${'u'.repeat(50)}`,
          url: 'https://api.github.com/repos/Owner/Repo/issues/7',
          type: 'Issue',
        },
      }),
    ];
    fake.knobs.comments = [comment({ id: 2, node_id: 'IC_subj' })];
    await adapter.tick();
    const subject = plane.submit[1]!.subject!;
    expect(subject).toHaveLength(199);
    expect(/[\uD800-\uDBFF]$/.test(subject)).toBe(false);
    await adapter.disconnect();
  });

  it('marks a thread read only after admission and advances the watermark', async () => {
    const { adapter, plane, fake, journal } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    const submitAt = journal.indexOf('submit:github:IC_101');
    const markAt = journal.indexOf('markRead:n-1');
    expect(submitAt).toBeGreaterThanOrEqual(0);
    expect(markAt).toBeGreaterThan(submitAt);
    expect(fake.markedRead).toEqual(['n-1']);
    const state = readState(adapter);
    expect(state.cursor.lastProcessedAt).toBe('2026-11-16T10:00:00Z');
    expect(state.cursor.dispatchedComments).toContain('IC_101');
    expect(state.pending).toHaveLength(0);
    // The next window steps back one second from the watermark.
    await adapter.tick();
    expect(fake.sinceSeen[1]).toBe('2026-11-16T09:59:59.000Z');
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('freezes the watermark when mark-read fails', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    fake.knobs.markReadError = new Error('PATCH failed');
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    // The re-listed window replays through idempotency, never a second input.
    fake.knobs.markReadError = undefined;
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(readState(adapter).cursor.lastProcessedAt).toBe(
      '2026-11-16T10:00:00Z',
    );
    await adapter.disconnect();
  });

  it('holds the window when a thread cannot be read', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    fake.knobs.listCommentsError = new Error('GET failed');
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(fake.markedRead).toHaveLength(0);
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    await adapter.disconnect();
  });

  it('starts the first window at connect time, not historical backlog', async () => {
    const { adapter, fake } = await connectedAdapter();
    await adapter.tick();
    expect(fake.sinceSeen[0]).toBe(new Date(NOW).toISOString());
    await adapter.disconnect();
  });

  it('bounds pending claims and waits for them to settle', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), CONFIG, {
      log: (line) => lines.push(line),
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = Array.from({ length: 40 }, (_, index) =>
      comment({ id: index, node_id: `IC_${index}` }),
    );
    plane.setRefuseSubmit({ status: 503 });
    await adapter.tick();
    const state = readState(adapter);
    expect(state.pending).toHaveLength(MANAGED_GITHUB_PENDING_LIMIT);
    expect(fake.markedRead).toHaveLength(0);
    expect(state.cursor.lastProcessedAt).toBeNull();
    // A full claim table skips the poll with one visible line.
    await adapter.tick();
    expect(
      lines.filter((line) => /no durable claim slot/.test(line)),
    ).toHaveLength(1);
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    expect(readState(adapter).pending).toHaveLength(0);
    // The drain frees claim slots, so the same tick admits the remainder.
    expect(plane.submit).toHaveLength(40);
    await adapter.disconnect();
  });

  it('never marks a thread read whose collection the claim cap cut short', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [
      notification(),
      notification({
        id: 'n-2',
        subject: {
          title: 'Second issue',
          url: 'https://api.github.com/repos/Owner/Repo/issues/8',
          type: 'Issue',
        },
      }),
    ];
    fake.knobs.commentsFor = (issueNumber) =>
      issueNumber === 7
        ? Array.from({ length: 40 }, (_, index) =>
            comment({ id: index, node_id: `IC_${index}` }),
          )
        : [comment({ id: 500, node_id: 'IC_500' })];
    // Admissions succeed, so the capped thread's claims all leave pending in
    // the same tick: only the capped guard (not heldThreads) can stop its
    // mark-read, and the 8 uncollected comments must survive to the next poll.
    await adapter.tick();
    expect(plane.submit).toHaveLength(32);
    expect(fake.markedRead).toHaveLength(0);
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    await adapter.tick();
    expect(plane.submit).toHaveLength(41);
    expect(fake.markedRead).toContain('n-1');
    expect(fake.markedRead).toContain('n-2');
    expect(readState(adapter).cursor.lastProcessedAt).toBe(
      '2026-11-16T10:00:00Z',
    );
    await adapter.disconnect();
  });

  it('re-drives the exact persisted event after a crash before submission', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.fake.knobs.notifications = [notification()];
    first.fake.knobs.comments = [comment()];
    first.plane.setRefuseSubmit({ status: 503 });
    await first.adapter.tick();
    expect(readState(first.adapter).pending).toHaveLength(1);
    await first.adapter.disconnect();

    // The control plane committed the admission but its answer was lost: the
    // restart's re-submission answers replayed for the same platformEventId.
    const second = await connectedAdapter(cwd);
    second.plane.markAdmitted('github:IC_101');
    second.fake.knobs.notifications = [];
    await second.adapter.tick();
    expect(second.plane.submit).toHaveLength(1);
    expect(second.plane.submit[0]!.platformEventId).toBe('github:IC_101');
    expect(second.plane.submit[0]!.text).toBe('@bot-user please help');
    expect(readState(second.adapter).pending).toHaveLength(0);
    await second.adapter.disconnect();
  });

  it('drops a deterministically refused admission visibly', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    plane.setRefuseSubmit({ status: 400 });
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(readState(adapter).pending).toHaveLength(0);
    expect(readState(adapter).cursor.dispatchedComments).toContain('IC_101');
    // The dropped comment is not re-staged on the next window.
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('stalls on the second consecutive instance-scoped refusal and lifts on a fresh probe admission', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    await adapter.tick();
    // First refusal drops as poison.
    expect(readState(adapter).pending).toHaveLength(0);
    fake.knobs.comments = [comment({ id: 2, node_id: 'IC_2' })];
    await adapter.tick();
    // Second refusal holds the claim and stalls admission.
    const held = readState(adapter).pending;
    expect(held).toHaveLength(1);
    expect(held[0]!.held).toBe(true);
    fake.knobs.comments = [comment({ id: 3, node_id: 'IC_3' })];
    await adapter.tick();
    expect(readState(adapter).pending).toHaveLength(1);
    // The held claim probes first; a fresh admission lifts the stall.
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    expect(readState(adapter).pending).toHaveLength(0);
    expect(plane.submit.map((event) => event.platformEventId)).toContain(
      'github:IC_2',
    );
    await adapter.disconnect();
  });

  it('re-registers after a registration refusal', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    plane.setRefuseSubmit({ status: 404, code: 'channel_not_found' });
    await adapter.tick();
    expect(plane.register).toHaveLength(1);
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    expect(plane.register).toHaveLength(2);
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('stops persisting once state ownership is lost', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    const before = readFileSync(adapter.stateFile, 'utf8');
    fake.compromise();
    fake.knobs.comments = [comment({ id: 2, node_id: 'IC_2' })];
    await adapter.tick().catch(() => undefined);
    expect(readFileSync(adapter.stateFile, 'utf8')).toBe(before);
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('surfaces the first identity failure and releases the lock', async () => {
    const cwd = tempCwd();
    const journal: string[] = [];
    const plane = fakeControlPlane(journal);
    const fake = fakeDeps(journal);
    fake.knobs.identityError = new Error('401 bad credentials');
    const adapter = new ManagedGithubAdapter({
      name: 'gh-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await expect(adapter.connect()).rejects.toThrow(/401 bad credentials/);
    // The lock was released: a second instance on the same state directory
    // can connect.
    const second = new ManagedGithubAdapter({
      name: 'gh-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    fake.knobs.identityError = undefined;
    await expect(second.connect()).resolves.toBeUndefined();
    await second.disconnect();
  });

  it('stops persisting when ownership is lost mid-await, before the next stage', async () => {
    const { adapter, fake, journal } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment({ id: 2, node_id: 'IC_2' })];
    let releaseGate!: () => void;
    fake.knobs.listCommentsDelay = () =>
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    const ticking = adapter.tick();
    await waitUntil(() => journal.includes('listComments'));
    const before = readFileSync(adapter.stateFile, 'utf8');
    // The lock is compromised while listComments is in flight: the inner
    // comment loop has no running check and would stage + persist the new
    // claim — only persist()'s ownershipLost guard stops the write.
    fake.compromise();
    releaseGate();
    await ticking;
    expect(readFileSync(adapter.stateFile, 'utf8')).toBe(before);
    await adapter.disconnect();
  });

  it('lifts the stall when a policy change drops the last held claim', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    await first.adapter.disconnect();
    // A held claim whose sender the current policy no longer allows: the
    // re-drive drops it, and liftStallWhenNothingHeld must disarm the stall
    // so the next poll admits again.
    seedState(first.adapter, (state) => {
      state.instanceRefusals = 2;
      state.pending = [pendingEntry('github:IC_mallory', 'mallory', true)];
    });
    const second = await connectedAdapter(cwd);
    second.fake.knobs.notifications = [notification()];
    second.fake.knobs.comments = [comment({ id: 9, node_id: 'IC_9' })];
    await second.adapter.tick();
    expect(readState(second.adapter).pending).toHaveLength(0);
    expect(second.plane.submit.map((event) => event.platformEventId)).toEqual([
      'github:IC_9',
    ]);
    await second.adapter.disconnect();
  });

  it('probes held claims before unheld ones under stall', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    await first.adapter.disconnect();
    seedState(first.adapter, (state) => {
      state.instanceRefusals = 2;
      state.pending = [
        pendingEntry('github:IC_A', 'alice'),
        pendingEntry('github:IC_B', 'alice', true),
      ];
    });
    const second = await connectedAdapter(cwd);
    // The held probe's fresh admission lifts the stall mid-pass, so the
    // unheld claim behind it submits in the same tick — and the sort is
    // observable in the attempt order.
    await second.adapter.tick();
    const aAt = second.journal.indexOf('submit:github:IC_A');
    const bAt = second.journal.indexOf('submit:github:IC_B');
    expect(bAt).toBeGreaterThanOrEqual(0);
    expect(aAt).toBeGreaterThan(bAt);
    expect(readState(second.adapter).pending).toHaveLength(0);
    await second.adapter.disconnect();
  });

  it('re-arms the stall from persisted held claims at connect', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    await first.adapter.disconnect();
    seedState(first.adapter, (state) => {
      state.instanceRefusals = 2;
      state.pending = [pendingEntry('github:IC_B', 'alice', true)];
    });
    const second = await connectedAdapter(cwd);
    second.fake.knobs.notifications = [notification()];
    second.fake.knobs.comments = [comment({ id: 9, node_id: 'IC_new' })];
    second.plane.setRefuseSubmit({ status: 503 });
    await second.adapter.tick();
    // The re-armed stall gates pollInbound: the transient probe keeps the
    // held claim, and the new comment must NOT be staged behind it.
    const pending = readState(second.adapter).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.eventId).toBe('github:IC_B');
    await second.adapter.disconnect();
  });

  it('re-registers and replays after a 409 generation-unregistered refusal', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    plane.setRefuseSubmit({
      status: 409,
      code: 'channel_generation_unregistered',
    });
    await adapter.tick();
    expect(plane.register).toHaveLength(1);
    expect(readState(adapter).pending).toHaveLength(1);
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    expect(plane.register).toHaveLength(2);
    expect(plane.submit).toHaveLength(1);
    expect(readState(adapter).pending).toHaveLength(0);
    await adapter.disconnect();
  });

  it('re-registers after a 409 disconnected refusal on the outbox pull', async () => {
    const { adapter, plane } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 1)]);
    plane.setRefuseClaim({ status: 409, code: 'channel_disconnected' });
    await adapter.tick();
    expect(plane.register).toHaveLength(1);
    plane.setRefuseClaim(undefined);
    await adapter.tick();
    expect(plane.register).toHaveLength(2);
    expect(plane.receipts).toHaveLength(1);
    await adapter.disconnect();
  });

  it('re-drives an orphan receipt after a 409 registration refusal', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    await first.adapter.disconnect();
    seedState(first.adapter, (state) => {
      state.outbound = [
        {
          deliveryId: 'd-x',
          ordinal: 0,
          receipt: {
            outcome: 'accepted',
            ordinal: 0,
            providerMessageId: '9001',
            acceptedAt: 1,
          },
        },
      ];
    });
    // The refusal must be armed BEFORE connect: connect itself replays
    // orphaned receipts, and an unarmed report would settle the seed.
    const journal: string[] = [];
    const plane = fakeControlPlane(journal);
    const fake = fakeDeps(journal);
    plane.setReceiptError((deliveryId) =>
      deliveryId === 'd-x'
        ? Object.assign(new Error('unregistered'), {
            status: 409,
            code: 'channel_generation_unregistered',
          })
        : undefined,
    );
    const second = new ManagedGithubAdapter({
      name: 'gh-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await second.connect();
    await second.tick();
    // The entry stays; the next tick re-registers first, then the receipt
    // settles.
    expect(readState(second).outbound).toHaveLength(1);
    plane.setReceiptError(undefined);
    await second.tick();
    expect(plane.register.length).toBeGreaterThanOrEqual(2);
    expect(readState(second).outbound).toHaveLength(0);
    await second.disconnect();
  });
});

describe('managed GitHub adapter adversarial hardening', () => {
  it('keeps two repos same-id comments without node_id as two events', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [
      notification(),
      notification({
        id: 'n-2',
        subject: {
          title: 'Other',
          url: 'https://api.github.com/repos/Other/Repo/issues/7',
          type: 'Issue',
        },
      }),
    ];
    // The numeric id fallback is only unique per repo; without thread
    // scoping the second repo's comment #555 replays the first away.
    fake.knobs.commentsFor = () => [comment({ node_id: undefined, id: 555 })];
    await adapter.tick();
    expect(plane.submit).toHaveLength(2);
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'github:owner/repo/issue:7/555',
      'github:other/repo/issue:7/555',
    ]);
    await adapter.disconnect();
  });

  it('holds the window on an unparseable updated_at while outbound keeps moving', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification({ updated_at: 'not-a-date' })];
    fake.knobs.comments = [comment()];
    plane.enqueue([delivery('d-1', 1)]);
    await adapter.tick();
    // A persisted non-date watermark would RangeError every later tick and
    // fail load() on restart; the window holds instead.
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    expect(fake.posted.map((entry) => entry.body)).toEqual(['segment 0']);
    expect(plane.receipts).toHaveLength(1);
    await adapter.disconnect();
  });

  it('skips ghost/deleted-user comments and url-less notifications', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment({ user: null })];
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    fake.knobs.notifications = [
      notification({ subject: { title: 'x', type: 'Issue' } }),
    ];
    fake.knobs.comments = [comment({ id: 2, node_id: 'IC_2' })];
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('matches a bot login with regex metacharacters and rejects team mentions', async () => {
    // The identity is resolved at connect, so arm it before connecting.
    const journal: string[] = [];
    const plane = fakeControlPlane(journal);
    const fake = fakeDeps(journal);
    fake.knobs.identity = 'bot.user+ci';
    const adapter = new ManagedGithubAdapter({
      name: 'gh-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await adapter.connect();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment({ body: 'ping @bot.user+ci please' })];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    fake.knobs.comments = [
      comment({
        id: 2,
        node_id: 'IC_team',
        // The armed identity prefix makes the assertion depend on the '/'
        // lookahead: with a foreign login the matcher would fail before the
        // lookahead is ever consulted and the guard would ship unverified.
        body: 'ping @bot.user+ci/team please',
      }),
    ];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('rejects a zero issueNumber reply target and still sends the batch', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([
      delivery('d-bad', 1, { owner: 'Owner', repo: 'Repo', issueNumber: 0 }),
      delivery('d-2', 1),
    ]);
    await adapter.tick();
    expect(plane.receipts[0]).toEqual({
      deliveryId: 'd-bad',
      receipt: { outcome: 'rejected' },
    });
    expect(fake.posted).toHaveLength(1);
    await adapter.disconnect();
  });

  it('survives a zero-segment delivery and never regresses the watermark', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-empty', 0)]);
    await expect(adapter.tick()).resolves.toBeUndefined();
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    fake.knobs.notifications = [
      notification({ id: 'n-old', updated_at: '2026-11-16T09:00:00Z' }),
    ];
    fake.knobs.comments = [];
    await adapter.tick();
    expect(readState(adapter).cursor.lastProcessedAt).toBe(
      '2026-11-16T10:00:00Z',
    );
    await adapter.disconnect();
  });
});

describe('managed GitHub adapter round-3 hardening', () => {
  it('honors groupPolicy open when no managed spelling is present', async () => {
    // The plugin schema documents groupPolicy as the GitHub admission gate;
    // ignoring it resolved to an empty allowlist that consumed every mention.
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      type: 'github',
      token: 'ghp_test_token',
      groupPolicy: 'open',
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.senderId).toBe('alice');
    expect(plane.register[0]).toMatchObject({
      policy: { senderPolicy: 'open' },
    });
    await adapter.disconnect();
  });

  it('keeps the parse-default groupPolicy disabled from clobbering allowedUsers', async () => {
    // parseChannelConfig injects groupPolicy:'disabled' into EVERY channel
    // config (config-utils.ts). Honoring that default as an admit-nothing
    // policy would silently disable the natural allowedUsers-only config —
    // the R1-1 control arm. 'disabled' must stay inert: the managed
    // resolvePrivatePolicy allowlist still admits allowedUsers.
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      type: 'github',
      token: 'ghp_test_token',
      groupPolicy: 'disabled',
      allowedUsers: ['alice'],
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.senderId).toBe('alice');
    expect(plane.register[0]).toMatchObject({
      policy: { senderPolicy: 'allowlist' },
    });
    await adapter.disconnect();
  });

  it('treats a bare parse-default groupPolicy disabled as inert, not a refusal', async () => {
    // No allowedUsers: the managed allowlist default admits nothing, but the
    // constructor must not throw on the universal parse-default.
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      type: 'github',
      token: 'ghp_test_token',
      groupPolicy: 'disabled',
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(plane.register[0]).toMatchObject({
      policy: { senderPolicy: 'allowlist' },
    });
    await adapter.disconnect();
  });

  it('honors groupPolicy allowlist and refuses an unknown value', async () => {
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      type: 'github',
      token: 'ghp_test_token',
      groupPolicy: 'allowlist',
      allowedUsers: ['alice'],
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.register[0]).toMatchObject({
      policy: { senderPolicy: 'allowlist' },
    });
    await adapter.disconnect();
    await expect(
      connectedAdapter(tempCwd(), {
        type: 'github',
        token: 'ghp_test_token',
        groupPolicy: 'bogus',
      }),
    ).rejects.toThrow(/groupPolicy must be one of/);
  });

  it('lets an explicit managed spelling win over groupPolicy', async () => {
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      ...CONFIG,
      privatePolicy: 'open',
      groupPolicy: 'disabled',
    });
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment({ user: { login: 'Bob' } })];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('refuses groupPolicy pairing and per-repo groups', async () => {
    await expect(
      connectedAdapter(tempCwd(), { ...CONFIG, groupPolicy: 'pairing' }),
    ).rejects.toThrow(/groupPolicy "pairing"/);
    await expect(
      connectedAdapter(tempCwd(), {
        ...CONFIG,
        groups: { 'owner/repo': { allowedUsers: ['alice'] } },
      }),
    ).rejects.toThrow(/per-repo "groups"/);
  });

  it('holds the watermark when an unparseable sibling shares the window', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [
      notification({ id: 'n-bad', updated_at: 'not-a-date' }),
      notification({ id: 'n-ok' }),
    ];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    // The parseable sibling must not push the watermark past the bad one.
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    await adapter.disconnect();
  });

  it('drops a re-driven claim whose repo the narrowed allowlist excludes', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd, {
      ...CONFIG,
      repoFilter: ['a/b', 'c/d'],
      repoFilterMode: 'allowlist',
    });
    await first.adapter.disconnect();
    const entry = pendingEntry('github:IC_cd', 'alice');
    entry.event.chatId = 'c/d';
    entry.event.scope.chatId = 'c/d';
    entry.event.replyContext = {
      owner: 'c',
      repo: 'd',
      issueNumber: 5,
      senderId: 'alice',
    };
    seedState(first.adapter, (state) => {
      state.pending = [entry];
    });
    const second = await connectedAdapter(cwd, {
      ...CONFIG,
      repoFilter: ['a/b'],
      repoFilterMode: 'allowlist',
    });
    await second.adapter.tick();
    expect(second.plane.submit).toHaveLength(0);
    expect(readState(second.adapter).pending).toHaveLength(0);
    await second.adapter.disconnect();
  });

  it('drops a permanently unreadable thread and lets the window complete', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [
      notification(),
      notification({
        id: 'n-2',
        subject: {
          title: 'Other',
          url: 'https://api.github.com/repos/Owner/Repo/issues/8',
          type: 'Issue',
        },
      }),
    ];
    fake.knobs.commentsFor = (issueNumber) => {
      if (issueNumber === 7) {
        throw Object.assign(new Error('404 Not Found'), { status: 404 });
      }
      return [comment()];
    };
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(fake.markedRead).toEqual(['n-2']);
    expect(readState(adapter).cursor.lastProcessedAt).toBe(
      '2026-11-16T10:00:00Z',
    );
    // A transient (5xx) read failure still freezes the window.
    fake.knobs.commentsFor = (issueNumber) => {
      if (issueNumber === 7) {
        throw Object.assign(new Error('503 Service Unavailable'), {
          status: 503,
        });
      }
      return [];
    };
    fake.knobs.notifications = [
      notification({ id: 'n-3', updated_at: '2026-11-16T11:00:00Z' }),
    ];
    await adapter.tick();
    expect(readState(adapter).cursor.lastProcessedAt).toBe(
      '2026-11-16T10:00:00Z',
    );
    await adapter.disconnect();
  });

  it('holds the window on a bare 429 read failure instead of dropping the thread', async () => {
    // 429 is a rate limit by status alone — no retry-after or budget headers
    // here. The Legacy classifyThreadFailure treats it as shared: hold the
    // window, never drop the thread and consume its notifications.
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.commentsFor = () => {
      throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    };
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(fake.markedRead).toEqual([]);
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    await adapter.disconnect();
  });

  it('paces ticks by the client poll floor and survives a failed tick', async () => {
    // Real timers: the adapter's delay comes from node:timers/promises,
    // which vitest's fake timers do not intercept. The floor (1.5 s) is
    // above the configured interval (1 s), so dropping the floor from the
    // delay reddens the pacing assertion; deleting the per-tick catch
    // reddens the survival assertion.
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const journal: string[] = [];
    const plane = fakeControlPlane(journal);
    const fake = fakeDeps(journal);
    fake.knobs.pollFloor = 1_500;
    const adapter = new ManagedGithubAdapter({
      name: 'gh-1',
      cwd: tempCwd(),
      config: { ...CONFIG, pollInterval: 1_000 },
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      // pollLoop defaults to true: the loop itself is under test.
    });
    await adapter.connect();
    const polls = () =>
      journal.filter((line) => line === 'listNotifications').length;
    await waitUntil(() => polls() >= 1);
    await sleep(1_200);
    expect(polls()).toBe(1);
    await waitUntil(() => polls() >= 2, 3_000);
    // A tick-rejecting failure is survived by the runLoop per-tick catch, not
    // fatal. A 500 claim refusal is rethrown by pullOutbox (it is not a
    // registration refusal), so tick() rejects; pollInbound still runs each
    // tick, so polls keep advancing. A listNotifications error is caught
    // inside pollInbound and never rejects the tick, so it cannot pin this.
    plane.setRefuseClaim({ status: 500 });
    await waitUntil(() => polls() >= 4, 8_000);
    plane.setRefuseClaim(undefined);
    await waitUntil(() => polls() >= 5, 4_000);
    await adapter.disconnect();
    const after = polls();
    await sleep(1_700);
    expect(polls()).toBe(after);
  }, 20_000);
});

describe('managed GitHub adapter outbound', () => {
  it('posts each segment in order and receipts the real comment id', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 3)]);
    await adapter.tick();
    // The wire contract is @Min(1) @Max(16); the adapter pins CLAIM_BATCH=16.
    expect(plane.claimLimits).toEqual([16]);
    expect(fake.posted.map((entry) => entry.body)).toEqual([
      'segment 0',
      'segment 1',
      'segment 2',
    ]);
    expect(fake.posted[0]).toMatchObject({
      owner: 'Owner',
      repo: 'Repo',
      issueNumber: 7,
    });
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd-1',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: '9001',
          acceptedAt: NOW,
        },
      },
      {
        deliveryId: 'd-1',
        receipt: {
          outcome: 'accepted',
          ordinal: 1,
          providerMessageId: '9002',
          acceptedAt: NOW,
        },
      },
      {
        deliveryId: 'd-1',
        receipt: {
          outcome: 'accepted',
          ordinal: 2,
          providerMessageId: '9003',
          acceptedAt: NOW,
        },
      },
    ]);
    expect(readState(adapter).outbound).toHaveLength(0);
    await adapter.disconnect();
  });

  it('stops the rest of a delivery on a definitive refusal', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 3)]);
    fake.knobs.sendBehavior = 'definitive';
    await adapter.tick();
    expect(fake.posted).toHaveLength(0);
    expect(plane.receipts).toEqual([
      { deliveryId: 'd-1', receipt: { outcome: 'rejected' } },
    ]);
    await adapter.disconnect();
  });

  it('receipts unknown on an ambiguous failure and never re-sends on restart', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.enqueue([delivery('d-1', 2)]);
    first.fake.knobs.sendBehavior = 'transient';
    await first.adapter.tick();
    expect(first.plane.receipts).toEqual([
      { deliveryId: 'd-1', receipt: { outcome: 'unknown' } },
    ]);
    await first.adapter.disconnect();

    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.fake.posted).toHaveLength(0);
    await second.adapter.disconnect();
  });

  it('replays a persisted receipt when its report was lost, never the send', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 1)]);
    plane.setReceiptError(() =>
      Object.assign(new Error('connection lost'), { status: 503 }),
    );
    await adapter.tick();
    expect(fake.posted).toHaveLength(1);
    const state = readState(adapter);
    expect(state.outbound).toHaveLength(1);
    expect(state.outbound[0]!.receipt).toMatchObject({
      outcome: 'accepted',
      providerMessageId: '9001',
    });
    plane.setReceiptError(undefined);
    await adapter.tick();
    expect(fake.posted).toHaveLength(1);
    expect(plane.receipts).toHaveLength(1);
    expect(readState(adapter).outbound).toHaveLength(0);
    await adapter.disconnect();
  });

  it('re-drives a persisted unknown receipt whose report was lost', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.enqueue([delivery('d-1', 1)]);
    // The transient send failure classifies and persists an unknown receipt
    // BEFORE the report fails, so the restart replays that persisted receipt.
    first.fake.knobs.sendBehavior = 'transient';
    first.plane.setReceiptError(() =>
      Object.assign(new Error('connection lost'), { status: 503 }),
    );
    await first.adapter.tick();
    expect(readState(first.adapter).outbound[0]!.receipt).toEqual({
      outcome: 'unknown',
    });
    await first.adapter.disconnect();
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.fake.posted).toHaveLength(0);
    expect(second.plane.receipts).toEqual([
      { deliveryId: 'd-1', receipt: { outcome: 'unknown' } },
    ]);
    await second.adapter.disconnect();
  });

  it('settles unknown for a seeded orphan with no receipt, never re-sending', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    await first.adapter.disconnect();
    // The real crash window: outbound persisted, send outcome never produced.
    // Seed the ledger entry without a receipt (valid per validManagedReceipt).
    seedState(first.adapter, (state) => {
      state.outbound = [{ deliveryId: 'd-x', ordinal: 0 }];
    });
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.fake.posted).toHaveLength(0);
    expect(second.plane.receipts).toEqual([
      { deliveryId: 'd-x', receipt: { outcome: 'unknown' } },
    ]);
    expect(readState(second.adapter).outbound).toHaveLength(0);
    await second.adapter.disconnect();
  });

  it('continues the batch when a rejection receipt cannot be reported', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-bad', 1, null), delivery('d-2', 1)]);
    plane.setReceiptError((deliveryId) =>
      deliveryId === 'd-bad'
        ? Object.assign(new Error('connection lost'), { status: 503 })
        : undefined,
    );
    await adapter.tick();
    // d-bad's rejection stays unreported (the lease reconciler settles it);
    // d-2 must still send — the exception must not escape send().
    expect(fake.posted).toHaveLength(1);
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd-2',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: '9001',
          acceptedAt: NOW,
        },
      },
    ]);
    await adapter.disconnect();
  });

  it('drops a deterministically refused orphan receipt and keeps later deliveries moving', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    await first.adapter.disconnect();
    seedState(first.adapter, (state) => {
      state.outbound = [
        {
          deliveryId: 'd-dead',
          ordinal: 0,
          receipt: {
            outcome: 'accepted',
            ordinal: 0,
            providerMessageId: '1',
            acceptedAt: 1,
          },
        },
      ];
    });
    // Arm the refusal before connect: connect replays orphaned receipts, so
    // an unarmed report would settle the seed instead of exercising the drop.
    const journal: string[] = [];
    const plane = fakeControlPlane(journal);
    const fake = fakeDeps(journal);
    plane.setReceiptError((deliveryId) =>
      deliveryId === 'd-dead'
        ? Object.assign(new Error('gone'), { status: 400 })
        : undefined,
    );
    const second = new ManagedGithubAdapter({
      name: 'gh-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await second.connect();
    plane.enqueue([delivery('d-3', 1)]);
    await second.tick();
    // The 400-refused orphan is dropped visibly instead of re-driving before
    // every outbox pull and stalling all later deliveries.
    expect(readState(second).outbound).toHaveLength(0);
    expect(fake.posted).toHaveLength(1);
    await second.disconnect();
  });

  it('rejects a delivery without a usable reply target and still sends the batch', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-bad', 1, null), delivery('d-2', 1)]);
    await adapter.tick();
    expect(plane.receipts[0]).toEqual({
      deliveryId: 'd-bad',
      receipt: { outcome: 'rejected' },
    });
    expect(fake.posted).toHaveLength(1);
    expect(plane.receipts[1]).toMatchObject({
      deliveryId: 'd-2',
      receipt: { outcome: 'accepted' },
    });
    await adapter.disconnect();
  });

  it('disconnects under lock and reports the control-plane disconnect', async () => {
    const { adapter, plane } = await connectedAdapter();
    await adapter.disconnect();
    expect(plane.disconnectCalls()).toBe(1);
  });
});

// Fail the Nth store.save call (1-based), passing the rest through to the real
// implementation. The fs error rides on cause exactly as production's store
// rethrow carries it, so persistErrorText has something to name.
function failSaveOnCall(n: number) {
  const original = ManagedGithubStateStore.prototype.save;
  let calls = 0;
  return vi
    .spyOn(ManagedGithubStateStore.prototype, 'save')
    .mockImplementation(function (
      this: ManagedGithubStateStore,
      state: ManagedGithubState,
    ) {
      calls += 1;
      if (calls === n) {
        throw Object.assign(
          new Error(
            'Managed GitHub state could not be saved; admission stopped.',
          ),
          { cause: new Error('ENOSPC: no space left on device') },
        );
      }
      return original.call(this, state);
    });
}

describe('managed GitHub adapter persist-failure discipline (R1-5)', () => {
  it('abandons a send whose ledger write fails and still sends the next delivery', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 1), delivery('d-2', 1)]);
    const spy = failSaveOnCall(1); // d-1's ledger append, before its post
    await adapter.tick();
    spy.mockRestore();
    // d-1 posted nothing and reported no receipt: the rollback abandoned it
    // before the side effect (the lease reconciler settles it unknown). d-2
    // must still send — the failed write must not escape send().
    expect(fake.posted.map((entry) => entry.body)).toEqual(['segment 0']);
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd-2',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: '9001',
          acceptedAt: NOW,
        },
      },
    ]);
    expect(readState(adapter).outbound).toHaveLength(0);
    await adapter.disconnect();
  });

  it('still reports accepted when the receipt write fails', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 1)]);
    const spy = failSaveOnCall(2); // ledger #1 ok, receipt write #2 fails
    await adapter.tick();
    spy.mockRestore();
    // The comment is already on GitHub; the acceptance is still reported even
    // though the local receipt write failed.
    expect(fake.posted).toHaveLength(1);
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd-1',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: '9001',
          acceptedAt: NOW,
        },
      },
    ]);
    expect(readState(adapter).outbound).toHaveLength(0);
    await adapter.disconnect();
  });

  it('keeps a settled segment on disk when its removal write fails, then re-drives the receipt on restart', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.enqueue([delivery('d-1', 1)]);
    const spy = failSaveOnCall(3); // ledger #1, receipt #2 ok; settle removal #3 fails
    await first.adapter.tick();
    spy.mockRestore();
    expect(first.fake.posted).toHaveLength(1);
    expect(first.plane.receipts).toHaveLength(1);
    // The removal applied in memory but never reached disk: the entry stays on
    // disk with its accepted receipt, and the failed write did not escape the
    // tick.
    const state = readState(first.adapter);
    expect(state.outbound).toHaveLength(1);
    expect(state.outbound[0]!.receipt).toMatchObject({
      outcome: 'accepted',
      providerMessageId: '9001',
    });
    await first.adapter.disconnect();
    // Restart loads the disk entry; the orphan re-drive replays the receipt
    // (never the send) and removes it.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.fake.posted).toHaveLength(0);
    expect(second.plane.receipts).toHaveLength(1);
    expect(readState(second.adapter).outbound).toHaveLength(0);
    await second.adapter.disconnect();
  });

  it('re-drives an admission whose settle write failed instead of dropping it', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    await first.adapter.disconnect();
    seedState(first.adapter, (state) => {
      state.pending = [pendingEntry('github:IC_1', 'alice')];
    });
    const second = await connectedAdapter(cwd);
    const spy = vi
      .spyOn(ManagedGithubStateStore.prototype, 'save')
      .mockImplementation(() => {
        throw Object.assign(
          new Error(
            'Managed GitHub state could not be saved; admission stopped.',
          ),
          { cause: new Error('ENOSPC: no space left on device') },
        );
      });
    await second.adapter.tick();
    spy.mockRestore();
    // Both re-drives in the tick admitted server-side, but neither settle
    // reached disk; the rollback keeps the claim pending. Without the rollback
    // the first settle would drop the claim from this process's re-drive and
    // the second submit would never happen.
    expect(second.plane.submit).toHaveLength(2);
    expect(readState(second.adapter).pending).toHaveLength(1);
    await second.adapter.tick();
    expect(readState(second.adapter).pending).toHaveLength(0);
    await second.adapter.disconnect();
  });
});

describe('managed GitHub adapter round-4 hardening', () => {
  // parseChannelConfig always injects privatePolicy/senderPolicy (and a
  // groupPolicy default) into the config the CLI hands the adapter, so these
  // cases build that production shape and pass the pre-parse entry as
  // rawConfig — the shape the round-3 config-only guard could never see.
  const parsedShape = (
    raw: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...raw,
    // Mirror parseChannelConfig: privatePolicy is resolvePrivatePolicy(raw),
    // senderPolicy/groupPolicy/dmPolicy collapse to their defaults.
    privatePolicy:
      raw['privatePolicy'] ??
      (raw['dmPolicy'] === 'disabled'
        ? 'disabled'
        : (raw['senderPolicy'] ?? 'allowlist')),
    senderPolicy: raw['senderPolicy'] ?? 'allowlist',
    allowedUsers: raw['allowedUsers'] ?? [],
    groupPolicy: raw['groupPolicy'] ?? 'disabled',
    dmPolicy: raw['dmPolicy'] ?? 'open',
  });

  it('honors groupPolicy open on the production parse shape', async () => {
    const raw = {
      type: 'github',
      token: 'ghp_test_token',
      groupPolicy: 'open',
    };
    const { adapter, plane, fake } = await connectedAdapter(
      tempCwd(),
      parsedShape(raw),
      {},
      raw,
    );
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.register[0]).toMatchObject({
      policy: { senderPolicy: 'open' },
    });
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.senderId).toBe('alice');
    await adapter.disconnect();
  });

  it('refuses an unknown groupPolicy on the production parse shape', async () => {
    const raw = {
      type: 'github',
      token: 'ghp_test_token',
      groupPolicy: 'bogus',
    };
    await expect(
      connectedAdapter(tempCwd(), parsedShape(raw), {}, raw),
    ).rejects.toThrow(/groupPolicy must be one of/);
  });

  it('keeps the injected groupPolicy disabled inert for an allowedUsers allowlist', async () => {
    const raw = {
      type: 'github',
      token: 'ghp_test_token',
      allowedUsers: ['alice'],
    };
    const { adapter, plane, fake } = await connectedAdapter(
      tempCwd(),
      parsedShape(raw),
      {},
      raw,
    );
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.register[0]).toMatchObject({
      policy: { senderPolicy: 'allowlist' },
    });
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.senderId).toBe('alice');
    await adapter.disconnect();
  });

  it('lets an explicit raw managed policy win over an active groupPolicy', async () => {
    const raw = {
      type: 'github',
      token: 'ghp_test_token',
      senderPolicy: 'disabled',
      groupPolicy: 'open',
    };
    const { adapter, plane, fake } = await connectedAdapter(
      tempCwd(),
      parsedShape(raw),
      {},
      raw,
    );
    fake.knobs.notifications = [notification()];
    fake.knobs.comments = [comment()];
    await adapter.tick();
    expect(plane.register[0]).toMatchObject({
      policy: { senderPolicy: 'disabled' },
    });
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('holds the window on a 401 read failure, never dropping the thread', async () => {
    // A token revoked mid-run answers 401 on every comment read; that is a
    // global, healable condition, so the thread must not be dropped as poison.
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.commentsFor = () => {
      throw Object.assign(new Error('401 Unauthorized'), { status: 401 });
    };
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(fake.markedRead).toEqual([]);
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    await adapter.disconnect();
  });

  it('holds the window on a 408 read failure, never dropping the thread', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.knobs.notifications = [notification()];
    fake.knobs.commentsFor = () => {
      throw Object.assign(new Error('408 Request Timeout'), { status: 408 });
    };
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(fake.markedRead).toEqual([]);
    expect(readState(adapter).cursor.lastProcessedAt).toBeNull();
    await adapter.disconnect();
  });

  it('rejects a delivery whose sender the current policy no longer allows', async () => {
    // The send-time re-check (DingTalk/email parity): a sender excluded after
    // admission must not receive the reply.
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([
      delivery('d-1', 1, {
        owner: 'Owner',
        repo: 'Repo',
        issueNumber: 7,
        senderId: 'mallory',
      }),
    ]);
    await adapter.tick();
    expect(fake.posted).toHaveLength(0);
    expect(plane.receipts).toEqual([
      { deliveryId: 'd-1', receipt: { outcome: 'rejected' } },
    ]);
    await adapter.disconnect();
  });

  it('rejects a delivery whose repo the current allowlist excludes', async () => {
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      ...CONFIG,
      repoFilter: ['a/b'],
      repoFilterMode: 'allowlist',
    });
    plane.enqueue([delivery('d-1', 1)]); // Owner/Repo is not in the allowlist
    await adapter.tick();
    expect(fake.posted).toHaveLength(0);
    expect(plane.receipts).toEqual([
      { deliveryId: 'd-1', receipt: { outcome: 'rejected' } },
    ]);
    await adapter.disconnect();
  });
});
