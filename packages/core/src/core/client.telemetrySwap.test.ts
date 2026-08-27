/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-level contract tests for the session-swap telemetry transaction
 * (#9833). These exercise LlmClient.beginTelemetrySwap /
 * commitTelemetrySwap / abortTelemetrySwap against the REAL
 * UiTelemetryService singleton — client.test.ts mocks the service, so it
 * cannot observe the aggregate these methods exist to protect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmClient } from './client.js';
import {
  uiTelemetryService,
  EVENT_API_RESPONSE,
  type UiEvent,
} from '../telemetry/uiTelemetry.js';
import type { Config } from '../config/config.js';
import type { ResumedSessionData } from '../services/sessionService.js';
import { SessionStartSource } from '../hooks/types.js';
import type { LlmChat } from './llm-chat.js';

const SESSION_A = 'session-A';
const SESSION_B = 'session-B';

function storedApiEvent(tokens: number, id = `resp-${tokens}`): UiEvent {
  return {
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': '2026-08-24T00:00:00.000Z',
    response_id: id,
    model: 'test-model',
    duration_ms: 10,
    input_token_count: tokens,
    output_token_count: 0,
    cached_content_token_count: 0,
    thoughts_token_count: 0,
    total_token_count: tokens,
    prompt_id: SESSION_A,
  } as UiEvent;
}

function conversationWith(tokens: number, sessionId = SESSION_A) {
  return {
    sessionId,
    projectHash: 'project-1',
    startTime: '2026-08-24T00:00:00.000Z',
    lastUpdated: '2026-08-24T00:00:00.000Z',
    messages: [
      {
        uuid: 'u-1',
        parentUuid: null,
        sessionId,
        type: 'user',
        timestamp: '2026-08-24T00:00:00.000Z',
        cwd: '/',
        version: 'test',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      },
      {
        uuid: `t-${tokens}`,
        parentUuid: null,
        sessionId,
        type: 'system',
        subtype: 'ui_telemetry',
        timestamp: '2026-08-24T00:00:00.000Z',
        cwd: '/',
        version: 'test',
        systemPayload: { uiEvent: storedApiEvent(tokens) },
      },
    ],
  };
}

function totalRequests(): number {
  return Object.values(uiTelemetryService.getMetrics().models).reduce(
    (sum, m) => sum + m.api.totalRequests,
    0,
  );
}

function makeEnv() {
  let sessionId = SESSION_A;
  let resumedData: ResumedSessionData | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    getSessionId: () => sessionId,
    getResumedSessionData: () => resumedData,
    swap(id: string, data?: ResumedSessionData) {
      sessionId = id;
      resumedData = data;
    },
    // `initialize()` calls restoreLoadedSkillsFromHistory, which resolves the
    // SKILL tool through the registry; this mock only exercises the telemetry
    // swap, so return an empty registry (no SKILL tool → the restore is a
    // no-op) rather than let the call throw `getToolRegistry is not a function`.
    getToolRegistry: () => ({ getTool: () => undefined }),
  };
  const client = new LlmClient(config as Config);
  const fakeChat = {
    seedResumeTokenCounts: vi.fn(),
    setLastPromptTokenCount: vi.fn(),
  } as unknown as LlmChat;
  const startChat = vi
    .spyOn(client, 'startChat')
    .mockImplementation(async function (this: LlmClient) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).chat = fakeChat;
      return fakeChat;
    });
  return { config, client, startChat };
}

describe('LlmClient telemetry swap transaction (#9833)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uiTelemetryService.reset();
  });

  it('a replay outside a transaction arms no undo (startup path)', async () => {
    const { config, client } = makeEnv();

    // Process-startup resume: no transaction is open, so the replay must be
    // permanent — nothing may later "undo" the process start and wipe the
    // usage accrued since.
    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    expect(totalRequests()).toBe(1);

    // Live usage after startup.
    uiTelemetryService.addEvent(storedApiEvent(5, 'live-1'), SESSION_A);
    expect(totalRequests()).toBe(2);

    // An abort with no armed undo changes nothing.
    expect(client.abortTelemetrySwap()).toBe(false);
    expect(totalRequests()).toBe(2);
  });

  it('abort restores the pre-swap state and forgets the abandoned session', async () => {
    const { config, client } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    uiTelemetryService.addEvent(storedApiEvent(5, 'live-1'), SESSION_A);
    expect(totalRequests()).toBe(2);

    // Failed swap to B: forward initialize replays B, then the swap aborts.
    client.beginTelemetrySwap();
    config.swap(SESSION_B, {
      conversation: conversationWith(100, SESSION_B),
    });
    await client.initialize();
    expect(totalRequests()).toBe(3);

    expect(client.abortTelemetrySwap()).toBe(true);
    expect(totalRequests()).toBe(2);
    expect(uiTelemetryService.getMetricsForSession(SESSION_B).models).toEqual(
      {},
    );

    // Trap (1): abort must forget initializedSessionId — retrying the same
    // swap replays again instead of early-returning into an under-counted
    // session.
    client.beginTelemetrySwap();
    await client.initialize();
    expect(totalRequests()).toBe(3);
    expect(
      uiTelemetryService.getMetricsForSession(SESSION_B).models['test-model']
        ?.api.totalRequests,
    ).toBe(1);
    client.commitTelemetrySwap();
  });

  it('commit drops the undo: the replay stays and a later abort cannot reach it', async () => {
    const { config, client } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();

    client.beginTelemetrySwap();
    config.swap(SESSION_B, {
      conversation: conversationWith(100, SESSION_B),
    });
    await client.initialize();
    client.commitTelemetrySwap();

    expect(totalRequests()).toBe(2);
    // A later abort has nothing to restore — the committed replay belongs to
    // the session the user is on.
    expect(client.abortTelemetrySwap()).toBe(false);
    expect(totalRequests()).toBe(2);
  });

  it('the rollback re-initialize does not re-arm: restore lands on top of it', async () => {
    const { config, client } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    uiTelemetryService.addEvent(storedApiEvent(5, 'live-1'), SESSION_A);
    // In-memory-only state on A's bucket: never persisted to transcripts, so
    // only the snapshot can carry it across a rollback's re-initialize.
    uiTelemetryService.recordSkillInvocation('test-skill', true, SESSION_A);

    // /branch shape: forward replay of the fork, then the rollback's own
    // re-initialize of the parent, then the abort.
    client.beginTelemetrySwap();
    config.swap(SESSION_B, {
      conversation: conversationWith(100, SESSION_B),
    });
    await client.initialize();
    expect(totalRequests()).toBe(3);

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize(); // rollback re-replays A on top
    expect(totalRequests()).toBe(4);

    expect(client.abortTelemetrySwap()).toBe(true);
    expect(totalRequests()).toBe(2);
    // initializedSessionId names the parent (the rollback re-initialized it)
    // — abort must keep it so the parent stays initialized.
    expect(client.isInitialized()).toBe(true);
    // A's live bucket — including the skill invocation the transcript can
    // never restore — came back with the snapshot.
    const bucketA = uiTelemetryService.getMetricsForSession(SESSION_A);
    expect(bucketA.models['test-model']?.api.totalRequests).toBe(2);
    expect(bucketA.skills?.totalCalls).toBe(1);

    // The kept initializedSessionId is the load-bearing part of the fix:
    // a follow-up same-session initialize — the /resume rollback shape
    // (#9844 review), or /resume of the session the user is already on —
    // early-returns instead of re-replaying A's stored telemetry on top of
    // the live aggregate (a double count) and wiping A's never-persisted
    // state via resetSession.
    await client.initialize();
    expect(totalRequests()).toBe(2);
    expect(
      uiTelemetryService.getMetricsForSession(SESSION_A).models['test-model']
        ?.api.totalRequests,
    ).toBe(2);
    expect(
      uiTelemetryService.getMetricsForSession(SESSION_A).skills?.totalCalls,
    ).toBe(1);
  });

  it('same-session initialize early-returns and arms nothing', async () => {
    const { config, client } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    expect(totalRequests()).toBe(1);

    // Same-session "resume": initializedSessionId already matches, so no
    // replay happens and the transaction closes empty.
    client.beginTelemetrySwap();
    await client.initialize();
    expect(totalRequests()).toBe(1);
    expect(client.abortTelemetrySwap()).toBe(false);
    expect(totalRequests()).toBe(1);
  });

  it('abort with an open but unarmed transaction is a no-op', async () => {
    const { client } = makeEnv();

    // Fresh-start initialize (no resumed data) replays nothing.
    await client.initialize();
    expect(client.isInitialized()).toBe(true);

    client.beginTelemetrySwap();
    // The swap fails before initialize runs (e.g. the core swap itself
    // throws) — nothing armed, abort must not touch the aggregate.
    uiTelemetryService.addEvent(storedApiEvent(7, 'live-1'), SESSION_A);
    expect(client.abortTelemetrySwap()).toBe(false);
    expect(totalRequests()).toBe(1);
  });

  it('a second begin while a transaction is open is rejected (serialization latch)', async () => {
    const { config, client } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();

    // The slot doubles as the session-switch latch (#9844): the session
    // picker fires swaps fire-and-forget and no input gate covers them, so
    // a concurrent second /resume or /branch must be rejected here. Two
    // open transactions would entangle — the second replay mutates the
    // same aggregate while the first swap's stale settlement either no-ops
    // or restores over the second's committed state.
    expect(client.beginTelemetrySwap()).toBe(true);
    expect(client.beginTelemetrySwap()).toBe(false);

    // The rejection leaves the first transaction untouched: it still
    // settles its own replay.
    config.swap(SESSION_B, {
      conversation: conversationWith(100, SESSION_B),
    });
    await client.initialize();
    expect(totalRequests()).toBe(2);
    expect(client.abortTelemetrySwap()).toBe(true);
    expect(totalRequests()).toBe(1);

    // Once settled, the slot is free again.
    expect(client.beginTelemetrySwap()).toBe(true);
    client.commitTelemetrySwap();
  });

  it('a swap after a failed swap still snapshots the live outgoing bucket', async () => {
    // The outgoing session is captured at begin time (outgoingHint), not
    // keyed on initializedSessionId: the FIRST swap's abort clears
    // initializedSessionId (it names the abandoned session), and a next swap
    // armed on the cleared field would snapshot no outgoing bucket — so the
    // rollback's re-initialize would wipe the live session's
    // never-persisted state (live events, skill invocations) for good.
    const { config, client } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    uiTelemetryService.addEvent(storedApiEvent(5, 'live-1'), SESSION_A);
    uiTelemetryService.recordSkillInvocation('test-skill', true, SESSION_A);

    // First swap to B fails after its forward replay; abort restores the
    // pre-swap state and forgets initializedSessionId (it names B).
    expect(client.beginTelemetrySwap()).toBe(true);
    config.swap(SESSION_B, { conversation: conversationWith(100, SESSION_B) });
    await client.initialize();
    expect(totalRequests()).toBe(3);
    expect(client.abortTelemetrySwap()).toBe(true);
    expect(totalRequests()).toBe(2);

    // The hook rollback puts core back on A.
    config.swap(SESSION_A, { conversation: conversationWith(100) });

    // Second swap attempt: initializedSessionId is undefined now, so the
    // outgoing session can only come from the begin-time hint.
    expect(client.beginTelemetrySwap()).toBe(true);
    config.swap(SESSION_B, { conversation: conversationWith(100, SESSION_B) });
    await client.initialize();
    expect(totalRequests()).toBe(3);

    // /branch-shaped rollback: re-initialize the parent (its resetSession
    // wipes A's live bucket), then abort puts the snapshot back.
    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    expect(client.abortTelemetrySwap()).toBe(true);

    expect(totalRequests()).toBe(2);
    // A's bucket came back complete — including what is never persisted.
    const bucketA = uiTelemetryService.getMetricsForSession(SESSION_A);
    expect(bucketA.models['test-model']?.api.totalRequests).toBe(2);
    expect(bucketA.skills?.totalCalls).toBe(1);
  });

  it('abort keeps the live parent initialized when the rollback re-initialize armed the undo', async () => {
    // The undo does not always name the abandoned INCOMING session: when a
    // /branch fails between startNewSession(fork) and initialize() (e.g.
    // waitForGoalRuntime rethrows), the forward replay never runs, so the
    // rollback's own re-initialize of the parent arms the still-open
    // transaction's undo — with the PARENT's id. Clearing
    // initializedSessionId there would forget a correctly-initialized live
    // session: the next initialize() of the session the user is already on
    // would skip the early return and re-replay its stored telemetry on
    // top of the live aggregate — a permanent double count, plus the loss
    // of the bucket's never-persisted state (#9844 review).
    const { config, client, startChat } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    uiTelemetryService.addEvent(storedApiEvent(5, 'live-1'), SESSION_A);
    uiTelemetryService.recordSkillInvocation('test-skill', true, SESSION_A);
    expect(totalRequests()).toBe(2);

    // Step 1: /resume B fails AFTER its forward replay, and the rollback's
    // own re-initialize of A fails too (startChat rejects), so
    // initializedSessionId still names the abandoned B; abort restores and
    // clears it — leaving the client initialized-but-unaware, the
    // precondition for the trap below. (A rollback re-initialize that
    // SUCCEEDS sets initializedSessionId back to A, which abort then keeps
    // — see 'the rollback re-initialize does not re-arm'.)
    expect(client.beginTelemetrySwap()).toBe(true);
    config.swap(SESSION_B, { conversation: conversationWith(100, SESSION_B) });
    await client.initialize();
    expect(totalRequests()).toBe(3);
    config.swap(SESSION_A, { conversation: conversationWith(100) });
    startChat.mockRejectedValueOnce(new Error('rollback re-init failed'));
    await expect(client.initialize()).rejects.toThrow(
      'rollback re-init failed',
    );
    expect(client.abortTelemetrySwap()).toBe(true);
    expect(totalRequests()).toBe(2);

    // Step 2: /branch — begin captures the outgoing parent, core swaps to
    // the fork, then the failure lands BEFORE the forward initialize. The
    // catch rolls back: startNewSession(parent) + re-initialize, and that
    // re-initialize arms the undo itself.
    const FORK = 'fork-of-A';
    expect(client.beginTelemetrySwap()).toBe(true);
    config.swap(FORK, { conversation: conversationWith(100, FORK) });
    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize();
    expect(client.abortTelemetrySwap()).toBe(true);

    // The restore itself is exact...
    expect(totalRequests()).toBe(2);
    const bucketA = uiTelemetryService.getMetricsForSession(SESSION_A);
    expect(bucketA.models['test-model']?.api.totalRequests).toBe(2);
    expect(bucketA.skills?.totalCalls).toBe(1);

    // ...and the abort kept the live parent as the initialized session:
    // the next same-session initialize early-returns instead of re-replaying
    // on top of the live aggregate (pre-fix: totalRequests 2 -> 3 and A's
    // bucket lost its never-persisted skill state).
    await client.initialize();
    expect(totalRequests()).toBe(2);
    expect(
      uiTelemetryService.getMetricsForSession(SESSION_A).models['test-model']
        ?.api.totalRequests,
    ).toBe(2);
    expect(
      uiTelemetryService.getMetricsForSession(SESSION_A).skills?.totalCalls,
    ).toBe(1);
  });

  it('initialize with a SessionStartSource still honors the transaction', async () => {
    const { config, client } = makeEnv();

    config.swap(SESSION_A, { conversation: conversationWith(100) });
    await client.initialize(SessionStartSource.Startup);

    client.beginTelemetrySwap();
    config.swap(SESSION_B, {
      conversation: conversationWith(100, SESSION_B),
    });
    await client.initialize(SessionStartSource.Branch);
    expect(client.abortTelemetrySwap()).toBe(true);
    expect(totalRequests()).toBe(1);
    expect(uiTelemetryService.getMetricsForSession(SESSION_B).models).toEqual(
      {},
    );
  });
});
