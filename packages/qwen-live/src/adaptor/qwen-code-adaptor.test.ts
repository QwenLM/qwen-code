/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { QwenCodeAdaptor } from './qwen-code-adaptor.js';
import type {
  DaemonClientLike,
  QwenCodeAdaptorOptions,
} from './qwen-code-adaptor.js';
import type { BackendEvent, BackendHandle, ContentBlock } from './types.js';

/** Mirrors REQUIRED_FEATURES in qwen-code-adaptor.ts. */
const ALL_FEATURES = [
  'session_create',
  'session_prompt',
  'session_events',
  'session_cancel',
  'session_permission_vote',
  'session_mid_turn_message_mutation',
] as const;

const CLIENT_ID = 'live-client-1';
// The id the daemon issues on create/attach; per-session calls must echo it.
const ISSUED_CLIENT_ID = 'daemon-issued-7';
const BASE_URL = 'http://127.0.0.1:0';
const SESSION_ID = 'sess-1';

interface EventEnvelope {
  id?: number;
  v: 1;
  type: string;
  data: unknown;
  promptId?: string;
  originatorClientId?: string;
}

type EnvelopeStream = ReturnType<DaemonClientLike['subscribeEvents']>;

function envelope(
  type: string,
  data: unknown = {},
  extra: Partial<Pick<EventEnvelope, 'promptId' | 'originatorClientId'>> = {},
): EventEnvelope {
  return { v: 1, type, data, ...extra };
}

async function* envelopeStream(
  envelopes: readonly EventEnvelope[],
): EnvelopeStream {
  for (const item of envelopes) yield item;
}

function makeClient(
  overrides: Partial<DaemonClientLike> = {},
): DaemonClientLike {
  return {
    capabilities: vi.fn(async () => ({
      features: [...ALL_FEATURES],
      workspaceCwd: '/daemon-ws',
    })),
    createOrAttachSession: vi.fn(async () => ({
      sessionId: SESSION_ID,
      clientId: ISSUED_CLIENT_ID,
    })),
    listWorkspaceSessions: vi.fn(async () => []),
    promptNonBlocking: vi.fn(async () => ({ promptId: 'p1' })),
    subscribeEvents: vi.fn(() => envelopeStream([])),
    enqueueMidTurnMessage: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(async () => undefined),
    respondToSessionPermission: vi.fn(async () => true),
    uploadSessionAttachment: vi.fn(async () => ({
      type: 'resource_link',
      uri: 'attachment://shot',
    })),
    updateSessionMetadata: vi.fn(async () => ({})),
    ...overrides,
  };
}

function makeAdaptor(
  client: DaemonClientLike,
  options: Partial<QwenCodeAdaptorOptions> = {},
): QwenCodeAdaptor {
  return new QwenCodeAdaptor({
    baseUrl: BASE_URL,
    client,
    clientId: CLIENT_ID,
    defaultCwd: '/ws',
    ...options,
  });
}

function handleFor(id: string = SESSION_ID): BackendHandle {
  return { id, adaptor: 'qwen-code' };
}

async function collect(
  adaptor: QwenCodeAdaptor,
  handle: BackendHandle,
): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of adaptor.events(handle)) events.push(event);
  return events;
}

function permissionRequestEnvelope(requestId = 'req-1'): EventEnvelope {
  return envelope('permission_request', {
    requestId,
    toolCall: { name: 'Bash', command: 'rm -rf /tmp' },
    // The ACP wire field for display text is `name` (there is no `label`).
    options: [{ optionId: 'allow', name: 'Allow once' }, { optionId: 'deny' }],
  });
}

/** Feeds one permission_request through the event stream to seed options. */
async function seedPermissionOptions(
  adaptor: QwenCodeAdaptor,
  client: DaemonClientLike,
  requestId = 'req-1',
): Promise<void> {
  await adaptor.createSession();
  vi.mocked(client.subscribeEvents).mockReturnValueOnce(
    envelopeStream([permissionRequestEnvelope(requestId)]),
  );
  await collect(adaptor, handleFor());
}

describe('QwenCodeAdaptor.preflight', () => {
  it('throws listing the missing capabilities', async () => {
    const client = makeClient({
      capabilities: vi.fn(async () => ({
        features: ALL_FEATURES.filter(
          (feature) =>
            feature !== 'session_cancel' &&
            feature !== 'session_mid_turn_message_mutation',
        ),
        workspaceCwd: '/daemon-ws',
      })),
    });
    const adaptor = makeAdaptor(client);

    await expect(adaptor.preflight()).rejects.toThrow(
      /missing required capabilities.*session_cancel, session_mid_turn_message_mutation/,
    );
  });

  it('wraps network errors with the baseUrl and a start hint', async () => {
    const client = makeClient({
      capabilities: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    const adaptor = makeAdaptor(client);

    const error = await adaptor.preflight().then(
      () => {
        throw new Error('preflight resolved unexpectedly');
      },
      (raised: unknown) => raised as Error,
    );
    expect(error.message).toContain(BASE_URL);
    expect(error.message).toContain('connect ECONNREFUSED');
    expect(error.message).toContain('qwen serve');
  });

  it('distinguishes an HTTP refusal from an unreachable daemon', async () => {
    const client = makeClient({
      capabilities: vi.fn(async () => {
        throw Object.assign(new Error('Unauthorized'), {
          name: 'DaemonHttpError',
          status: 401,
        });
      }),
    });
    const adaptor = makeAdaptor(client);

    const error = await adaptor.preflight().then(
      () => {
        throw new Error('preflight resolved unexpectedly');
      },
      (raised: unknown) => raised as Error,
    );
    // The daemon responded — telling the operator to start one misdirects.
    expect(error.message).not.toContain('not reachable');
    expect(error.message).not.toContain('Start it');
    expect(error.message).toContain('401');
    expect(error.message).toContain('token');
    expect(error.message).toContain(BASE_URL);
  });

  it('remembers the daemon workspaceCwd for later createSession calls', async () => {
    const client = makeClient();
    const adaptor = new QwenCodeAdaptor({
      baseUrl: BASE_URL,
      client,
      clientId: CLIENT_ID,
      // No defaultCwd: the preflight-discovered workspaceCwd must win.
    });

    await adaptor.preflight();
    await adaptor.createSession();

    expect(client.createOrAttachSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/daemon-ws' }),
      CLIENT_ID,
    );
  });
});

describe('QwenCodeAdaptor.createSession', () => {
  it('requests a thread-scoped qwen-live session and returns the handle', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);

    const handle = await adaptor.createSession();

    expect(client.createOrAttachSession).toHaveBeenCalledWith(
      {
        workspaceCwd: '/ws',
        sessionScope: 'thread',
        sourceType: 'qwen-live',
      },
      CLIENT_ID,
    );
    expect(handle).toEqual({ id: SESSION_ID, adaptor: 'qwen-code' });
    expect(adaptor.isBusy(handle)).toBe(false);
    // No label requested: no metadata round-trip.
    expect(client.updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('applies the requested label via a session metadata update', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);

    await adaptor.createSession({ label: 'payroll refactor' });

    expect(client.updateSessionMetadata).toHaveBeenCalledWith(
      SESSION_ID,
      { displayName: 'payroll refactor' },
      ISSUED_CLIENT_ID,
    );
  });

  it('marks the session busy immediately when hasActivePrompt is set', async () => {
    const client = makeClient({
      createOrAttachSession: vi.fn(async () => ({
        sessionId: SESSION_ID,
        hasActivePrompt: true,
      })),
    });
    const adaptor = makeAdaptor(client);

    const handle = await adaptor.createSession();

    expect(adaptor.isBusy(handle)).toBe(true);
  });
});

describe('QwenCodeAdaptor.listSessions', () => {
  it('requests a full catalog page instead of the SDK default first page', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);

    await adaptor.listSessions();

    expect(client.listWorkspaceSessions).toHaveBeenCalledWith('/ws', {
      pageSize: 1000,
    });
  });

  it('queries every cwd sessions were created in, deduping by sessionId', async () => {
    const client = makeClient({
      listWorkspaceSessions: vi.fn(async (cwd: string) =>
        cwd === '/other'
          ? [{ sessionId: 'sess-other' }, { sessionId: SESSION_ID }]
          : [{ sessionId: SESSION_ID, displayName: 'main' }],
      ),
    });
    const adaptor = makeAdaptor(client);
    vi.mocked(client.createOrAttachSession).mockResolvedValueOnce({
      sessionId: 'sess-other',
      clientId: ISSUED_CLIENT_ID,
    });
    await adaptor.createSession({ cwd: '/other' });

    const sessions = await adaptor.listSessions();

    const queried = vi
      .mocked(client.listWorkspaceSessions)
      .mock.calls.map((call) => call[0]);
    expect(queried).toContain('/ws');
    expect(queried).toContain('/other');
    expect(sessions.map((s) => s.handle.id).sort()).toEqual([
      SESSION_ID,
      'sess-other',
    ]);
    // The duplicate row from '/other' must not clobber the first mapping.
    expect(sessions.find((s) => s.handle.id === SESSION_ID)?.label).toBe(
      'main',
    );
    expect(sessions.find((s) => s.handle.id === 'sess-other')?.cwd).toBe(
      '/other',
    );
  });

  it('derives busy/idle for untracked sessions from hasActivePrompt', async () => {
    const client = makeClient({
      listWorkspaceSessions: vi.fn(async () => [
        { sessionId: 'a', hasActivePrompt: true },
        { sessionId: 'b', hasActivePrompt: false },
        { sessionId: 'c' },
      ]),
    });
    const adaptor = makeAdaptor(client);

    const sessions = await adaptor.listSessions();

    expect(sessions.map((s) => s.state)).toEqual(['busy', 'idle', 'unknown']);
  });
});

describe('QwenCodeAdaptor.prompt', () => {
  it('converts text blocks, returns an accepted receipt, and turns busy', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    const handle = await adaptor.createSession();

    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'run the tests' },
    ]);

    expect(client.promptNonBlocking).toHaveBeenCalledWith(
      SESSION_ID,
      { prompt: [{ type: 'text', text: 'run the tests' }] },
      undefined,
      ISSUED_CLIENT_ID,
    );
    expect(receipt).toEqual({ status: 'accepted', jobRef: 'p1' });
    expect(adaptor.isBusy(handle)).toBe(true);
  });

  it('maps a 503 rejection to a rejected receipt with a busy note', async () => {
    const client = makeClient({
      promptNonBlocking: vi.fn(async () => {
        throw Object.assign(new Error('queue full'), { status: 503 });
      }),
    });
    const adaptor = makeAdaptor(client);
    const handle = await adaptor.createSession();

    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'hi' },
    ]);

    expect(receipt.status).toBe('rejected');
    expect(receipt.note).toContain('busy');
    expect(adaptor.isBusy(handle)).toBe(false);
  });
});

describe('QwenCodeAdaptor.prompt steering', () => {
  async function busyAdaptor(client: DaemonClientLike) {
    vi.mocked(client.createOrAttachSession).mockResolvedValueOnce({
      sessionId: SESSION_ID,
      hasActivePrompt: true,
      clientId: ISSUED_CLIENT_ID,
    });
    const adaptor = makeAdaptor(client);
    const handle = await adaptor.createSession();
    return { adaptor, handle };
  }

  it('joins the active turn when the mid-turn injection is accepted', async () => {
    const client = makeClient();
    const { adaptor, handle } = await busyAdaptor(client);

    const receipt = await adaptor.prompt(
      handle,
      [
        { type: 'text', text: 'also update the docs' },
        { type: 'text', text: 'and keep it short' },
      ],
      { steer: true },
    );

    expect(client.enqueueMidTurnMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'also update the docs\n\nand keep it short',
      { clientId: ISSUED_CLIENT_ID },
    );
    expect(client.promptNonBlocking).not.toHaveBeenCalled();
    expect(receipt.status).toBe('accepted');
    expect(receipt.joinedActiveTurn).toBe(true);
  });

  it('falls back to a queued prompt when the injection is rejected', async () => {
    const client = makeClient({
      enqueueMidTurnMessage: vi.fn(async () => ({ accepted: false })),
    });
    const { adaptor, handle } = await busyAdaptor(client);

    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'next up' }],
      { steer: true },
    );

    expect(client.enqueueMidTurnMessage).toHaveBeenCalledOnce();
    expect(client.promptNonBlocking).toHaveBeenCalledOnce();
    expect(receipt.status).toBe('queued');
    expect(receipt.jobRef).toBe('p1');
    expect(receipt.joinedActiveTurn).toBeUndefined();
  });

  it('falls back to a queued prompt when the injection is rejected with 400', async () => {
    // The mid-turn route caps the message length with a 400; the identical
    // payload is admissible as a queued full prompt.
    const client = makeClient({
      enqueueMidTurnMessage: vi.fn(async () => {
        throw Object.assign(new Error('message too long'), {
          name: 'DaemonHttpError',
          status: 400,
        });
      }),
    });
    const { adaptor, handle } = await busyAdaptor(client);

    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'a very long steer' }],
      { steer: true },
    );

    expect(client.enqueueMidTurnMessage).toHaveBeenCalledOnce();
    expect(client.promptNonBlocking).toHaveBeenCalledOnce();
    expect(receipt.status).toBe('queued');
    expect(receipt.joinedActiveTurn).toBeUndefined();
  });

  it('rethrows non-400 mid-turn injection failures', async () => {
    const client = makeClient({
      enqueueMidTurnMessage: vi.fn(async () => {
        throw Object.assign(new Error('daemon exploded'), { status: 500 });
      }),
    });
    const { adaptor, handle } = await busyAdaptor(client);

    await expect(
      adaptor.prompt(handle, [{ type: 'text', text: 'x' }], { steer: true }),
    ).rejects.toThrow('daemon exploded');
    expect(client.promptNonBlocking).not.toHaveBeenCalled();
  });

  it('falls back to a full prompt when a steer payload carries images', async () => {
    const client = makeClient();
    const { adaptor, handle } = await busyAdaptor(client);

    const receipt = await adaptor.prompt(
      handle,
      [
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: new Uint8Array([1, 2, 3]),
          name: 'shot.png',
        },
      ],
      { steer: true },
    );

    // Mid-turn injection is text-only; dropping the screenshot silently
    // would betray the handoff contract.
    expect(client.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(client.uploadSessionAttachment).toHaveBeenCalledOnce();
    expect(client.promptNonBlocking).toHaveBeenCalledOnce();
    expect(receipt.status).toBe('queued');
  });

  it('maps the client-side pending-prompt limit error to a rejected receipt', async () => {
    const client = makeClient({
      promptNonBlocking: vi.fn(async () => {
        const error = new Error('Pending prompts full: "sess" (2/2)');
        error.name = 'DaemonPendingPromptLimitError';
        throw error;
      }),
    });
    const { adaptor, handle } = await busyAdaptor(client);
    vi.mocked(client.enqueueMidTurnMessage).mockResolvedValueOnce({
      accepted: false,
    });

    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'one more thing' }],
      { steer: true },
    );

    expect(receipt.status).toBe('rejected');
    expect(receipt.note).toContain('queue is full');
  });

  it('skips the mid-turn injection entirely when the session is idle', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    const handle = await adaptor.createSession();

    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'do the thing' }],
      { steer: true },
    );

    expect(client.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(client.promptNonBlocking).toHaveBeenCalledOnce();
    expect(receipt.status).toBe('queued');
  });
});

describe('QwenCodeAdaptor.events', () => {
  it('normalizes a full turn: started, buffered chunks, progress, complete', async () => {
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([
          envelope('pending_prompt_started', {}, { promptId: 'p1' }),
          envelope('session_update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello ' },
            },
          }),
          envelope('session_update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'world' },
            },
          }),
          envelope('session_update', {
            update: { sessionUpdate: 'tool_call', title: 'Run npm test' },
          }),
          envelope('turn_complete', {}, { promptId: 'p1' }),
        ]),
      ),
    });
    const adaptor = makeAdaptor(client);
    const handle = handleFor();

    const iterator = adaptor.events(handle)[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.value).toEqual({ type: 'turn_started', jobRef: 'p1' });
    expect(adaptor.isBusy(handle)).toBe(true);

    // The two agent_message_chunk envelopes yield no events of their own;
    // the next observable event is the tool_call progress line.
    const progress = await iterator.next();
    expect(progress.value).toEqual({
      type: 'progress',
      summary: 'Run npm test',
    });

    const complete = await iterator.next();
    expect(complete.value).toEqual({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'Hello world',
      detail: 'Hello world',
    });
    expect(adaptor.isBusy(handle)).toBe(false);

    const end = await iterator.next();
    expect(end.done).toBe(true);
  });

  it('maps turn_error to a turn_error event carrying the message', async () => {
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([envelope('turn_error', { message: 'boom' })]),
      ),
    });
    const adaptor = makeAdaptor(client);

    const events = await collect(adaptor, handleFor());

    expect(events).toEqual([{ type: 'turn_error', error: 'boom' }]);
  });

  it('maps prompt_cancelled to a cancelled turn_error', async () => {
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([envelope('prompt_cancelled', {}, { promptId: 'p1' })]),
      ),
    });
    const adaptor = makeAdaptor(client);
    const handle = handleFor();

    const events = await collect(adaptor, handle);

    expect(events).toEqual([
      { type: 'turn_error', jobRef: 'p1', error: 'cancelled' },
    ]);
    expect(adaptor.isBusy(handle)).toBe(false);
  });

  it('normalizes permission_request with a descriptive title and classified options', async () => {
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([permissionRequestEnvelope('req-1')]),
      ),
    });
    const adaptor = makeAdaptor(client);

    const events = await collect(adaptor, handleFor());

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('permission_request');
    if (event.type !== 'permission_request') return;
    expect(event.requestId).toBe('req-1');
    expect(event.title).toContain('Bash');
    expect(event.title).toContain('rm -rf /tmp');
    expect(event.options).toEqual([
      {
        optionId: 'allow',
        label: 'Allow once',
        kind: 'proceed',
        escalation: 'once',
      },
      { optionId: 'deny', kind: 'reject' },
    ]);
  });

  it('attributes permission_resolved by comparing the originator clientId', async () => {
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([
          envelope(
            'permission_resolved',
            { requestId: 'req-ours' },
            { originatorClientId: ISSUED_CLIENT_ID },
          ),
          envelope(
            'permission_resolved',
            { requestId: 'req-theirs' },
            { originatorClientId: 'webshell-42' },
          ),
        ]),
      ),
    });
    const adaptor = makeAdaptor(client);
    // Register the session so the daemon-issued clientId is tracked.
    await adaptor.createSession();

    const events = await collect(adaptor, handleFor());

    expect(events).toEqual([
      { type: 'permission_resolved', requestId: 'req-ours', byUs: true },
      { type: 'permission_resolved', requestId: 'req-theirs', byUs: false },
    ]);
  });

  it('strips terminal escapes and keeps only the first line of tool titles', async () => {
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([
          envelope('session_update', {
            update: {
              sessionUpdate: 'tool_call',
              title: '\x1b[31mRun\x1b[0m npm\ntest',
            },
          }),
        ]),
      ),
    });
    const adaptor = makeAdaptor(client);

    const events = await collect(adaptor, handleFor());

    expect(events).toEqual([{ type: 'progress', summary: 'Run npm' }]);
  });

  it('never starts a clamped summary with a lone low surrogate', async () => {
    // 5001 UTF-16 units; the 4000-unit tail cut lands between the halves of
    // an emoji surrogate pair unless the clamp snaps off it.
    const detail = `${'😀'.repeat(1000)}x${'😀'.repeat(1500)}`;
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([
          envelope('session_update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: detail },
            },
          }),
          envelope('turn_complete', {}, { promptId: 'p1' }),
        ]),
      ),
    });
    const adaptor = makeAdaptor(client);

    const events = await collect(adaptor, handleFor());

    const complete = events.find((event) => event.type === 'turn_complete');
    if (complete?.type !== 'turn_complete') throw new Error('no turn_complete');
    expect(complete.summary.startsWith('…')).toBe(true);
    const lead = complete.summary.charCodeAt(1);
    expect(lead >= 0xdc00 && lead <= 0xdfff).toBe(false);
    expect(complete.summary.length).toBe(4000); // '…' + 3999 snapped units
  });

  it('keeps the turn-buffer cap off surrogate boundaries', async () => {
    // 48001 units: the 48000-unit buffer cap cut lands mid-pair.
    const oversized = `${'😀'.repeat(24000)}x`;
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([
          envelope('session_update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: oversized },
            },
          }),
          envelope('turn_complete', {}, { promptId: 'p1' }),
        ]),
      ),
    });
    const adaptor = makeAdaptor(client);

    const events = await collect(adaptor, handleFor());

    const complete = events.find((event) => event.type === 'turn_complete');
    if (complete?.type !== 'turn_complete') throw new Error('no turn_complete');
    const lead = complete.detail?.charCodeAt(0) ?? 0;
    expect(lead >= 0xdc00 && lead <= 0xdfff).toBe(false);
  });

  it('attributes byUs via the own-vote record for adopted sessions', async () => {
    // Adopted via session_list: no createSession, so no daemon-issued
    // clientId and no originator stamp on the anonymous vote.
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([permissionRequestEnvelope('req-1')]),
    );
    await collect(adaptor, handleFor());

    await adaptor.respondPermission(handleFor(), 'req-1', 'allow');
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([envelope('permission_resolved', { requestId: 'req-1' })]),
    );
    const events = await collect(adaptor, handleFor());

    expect(events).toEqual([
      { type: 'permission_resolved', requestId: 'req-1', byUs: true },
    ]);
  });

  it('does not claim byUs for a vote the daemon refused', async () => {
    const client = makeClient({
      respondToSessionPermission: vi.fn(async () => false),
    });
    const adaptor = makeAdaptor(client);
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([permissionRequestEnvelope('req-1')]),
    );
    await collect(adaptor, handleFor());

    await adaptor.respondPermission(handleFor(), 'req-1', 'allow');
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([envelope('permission_resolved', { requestId: 'req-1' })]),
    );
    const events = await collect(adaptor, handleFor());

    expect(events).toEqual([
      { type: 'permission_resolved', requestId: 'req-1', byUs: false },
    ]);
  });

  it('drops stored permission options when the request resolves elsewhere', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await seedPermissionOptions(adaptor, client);
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([
        envelope(
          'permission_resolved',
          { requestId: 'req-1' },
          { originatorClientId: 'webshell-42' },
        ),
      ]),
    );
    await collect(adaptor, handleFor());

    // With the stored options gone, a late vote can only fall back to the
    // cancelled outcome instead of replaying a stale optionId.
    await adaptor.respondPermission(handleFor(), 'req-1', 'allow');

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'cancelled' } },
      ISSUED_CLIENT_ID,
    );
  });

  it('emits session_closed and stops consuming the upstream generator', async () => {
    let pulls = 0;
    let finalized = false;
    async function* stream(): EnvelopeStream {
      try {
        pulls += 1;
        yield envelope('session_closed');
        pulls += 1;
        yield envelope('turn_error', { message: 'never delivered' });
      } finally {
        finalized = true;
      }
    }
    const client = makeClient({ subscribeEvents: vi.fn(() => stream()) });
    const adaptor = makeAdaptor(client);
    const handle = handleFor();

    const events = await collect(adaptor, handle);

    expect(events).toEqual([{ type: 'session_closed' }]);
    expect(pulls).toBe(1);
    expect(finalized).toBe(true);
    expect(adaptor.isBusy(handle)).toBe(false);
  });

  it('ignores unknown envelope types', async () => {
    const client = makeClient({
      subscribeEvents: vi.fn(() =>
        envelopeStream([
          envelope('git_status_changed', { branch: 'main' }),
          envelope('some_future_thing'),
        ]),
      ),
    });
    const adaptor = makeAdaptor(client);

    const events = await collect(adaptor, handleFor());

    expect(events).toEqual([]);
  });
});

describe('QwenCodeAdaptor.respondPermission', () => {
  it('votes the proceed option for an allow decision', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await seedPermissionOptions(adaptor, client);

    const result = await adaptor.respondPermission(
      handleFor(),
      'req-1',
      'allow',
    );

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'selected', optionId: 'allow' } },
      ISSUED_CLIENT_ID,
    );
    expect(result).toBe('delivered');
  });

  it('classifies real serve snake_case option ids (proceed_once)', async () => {
    // Regression: `\b` treats "_" as a word character, so a boundary match
    // against the raw id never fires — an allow vote silently degraded to a
    // cancelled outcome and serve dropped the turn.
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await adaptor.createSession();
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([
        envelope('permission_request', {
          requestId: 'req-1',
          toolCall: { name: 'write_file' },
          // Bare ids, no labels: nothing else may rescue the classification.
          options: [
            { optionId: 'proceed_once' },
            { optionId: 'proceed_always' },
            { optionId: 'cancel' },
          ],
        }),
      ]),
    );
    await collect(adaptor, handleFor());

    const result = await adaptor.respondPermission(
      handleFor(),
      'req-1',
      'allow',
    );

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
      ISSUED_CLIENT_ID,
    );
    expect(result).toBe('delivered');
  });

  it('votes the least-escalating allow option in production order', async () => {
    // qwen serve offers always-allow options FIRST (toPermissionOptions);
    // a bare voice "allow" must still take the one-shot grant, not persist
    // a project-scoped always-allow rule.
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await adaptor.createSession();
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([
        envelope('permission_request', {
          requestId: 'req-1',
          toolCall: { name: 'Bash', command: 'git push' },
          options: [
            {
              optionId: 'proceed_always_project',
              name: 'Always Allow in project: git',
              kind: 'allow_always',
            },
            {
              optionId: 'proceed_always_user',
              name: 'Always Allow for user: git',
              kind: 'allow_always',
            },
            { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
          ],
        }),
      ]),
    );
    await collect(adaptor, handleFor());

    const result = await adaptor.respondPermission(
      handleFor(),
      'req-1',
      'allow',
    );

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
      ISSUED_CLIENT_ID,
    );
    expect(result).toBe('delivered');
  });

  it('votes the least-escalating reject option for a deny decision', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await adaptor.createSession();
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([
        envelope('permission_request', {
          requestId: 'req-1',
          toolCall: { name: 'Bash', command: 'git push' },
          options: [
            {
              optionId: 'reject_always',
              name: 'Always Reject',
              kind: 'reject_always',
            },
            { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
          ],
        }),
      ]),
    );
    await collect(adaptor, handleFor());

    await adaptor.respondPermission(handleFor(), 'req-1', 'deny');

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'selected', optionId: 'cancel' } },
      ISSUED_CLIENT_ID,
    );
  });

  it('fails closed to cancelled when the wire kinds are unknown', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await adaptor.createSession();
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([
        envelope('permission_request', {
          requestId: 'req-1',
          toolCall: { name: 'write_file' },
          // A structured kind we do not understand must not be votable
          // through the word heuristics.
          options: [{ optionId: 'proceed_once', kind: 'allow_v2_mystery' }],
        }),
      ]),
    );
    await collect(adaptor, handleFor());

    await adaptor.respondPermission(handleFor(), 'req-1', 'allow');

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'cancelled' } },
      ISSUED_CLIENT_ID,
    );
  });

  it('votes the reject option for a deny decision', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await seedPermissionOptions(adaptor, client);

    const result = await adaptor.respondPermission(
      handleFor(),
      'req-1',
      'deny',
    );

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'selected', optionId: 'deny' } },
      ISSUED_CLIENT_ID,
    );
    expect(result).toBe('delivered');
  });

  it('votes cancelled for a cancel decision', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await seedPermissionOptions(adaptor, client);

    await adaptor.respondPermission(handleFor(), 'req-1', 'cancel');

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'cancelled' } },
      ISSUED_CLIENT_ID,
    );
  });

  it('reports already_resolved when the daemon refuses the vote', async () => {
    const client = makeClient({
      respondToSessionPermission: vi.fn(async () => false),
    });
    const adaptor = makeAdaptor(client);
    await seedPermissionOptions(adaptor, client);

    const result = await adaptor.respondPermission(
      handleFor(),
      'req-1',
      'allow',
    );

    expect(result).toBe('already_resolved');
  });

  it('falls back to cancelled when no options are known for the request', async () => {
    const client = makeClient();
    const adaptor = makeAdaptor(client);
    await adaptor.createSession();

    await adaptor.respondPermission(handleFor(), 'req-unknown', 'allow');

    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-unknown',
      { outcome: { outcome: 'cancelled' } },
      ISSUED_CLIENT_ID,
    );
  });
});

describe('QwenCodeAdaptor.close', () => {
  it('clears all tracked session state', async () => {
    const client = makeClient({
      createOrAttachSession: vi.fn(async () => ({
        sessionId: SESSION_ID,
        hasActivePrompt: true,
        clientId: ISSUED_CLIENT_ID,
      })),
    });
    const adaptor = makeAdaptor(client);
    const handle = await adaptor.createSession();
    vi.mocked(client.subscribeEvents).mockReturnValueOnce(
      envelopeStream([permissionRequestEnvelope('req-1')]),
    );
    await collect(adaptor, handle);
    expect(adaptor.isBusy(handle)).toBe(true);

    await adaptor.close();

    // Busy flag, issued clientId, and stored permission options are gone:
    // isBusy resets and a late vote can only fall back to the anonymous
    // cancelled outcome.
    expect(adaptor.isBusy(handle)).toBe(false);
    await adaptor.respondPermission(handle, 'req-1', 'allow');
    expect(client.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'req-1',
      { outcome: { outcome: 'cancelled' } },
      undefined,
    );
  });
});

describe('QwenCodeAdaptor prompt image blocks', () => {
  it('uploads image blocks and splices the returned reference into the prompt', async () => {
    const reference = { type: 'resource_link', uri: 'attachment://shot' };
    const client = makeClient({
      uploadSessionAttachment: vi.fn(async () => reference),
    });
    const adaptor = makeAdaptor(client);
    const handle = await adaptor.createSession();
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'see the screenshot' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
        name: 'shot.png',
      },
    ];

    await adaptor.prompt(handle, blocks);

    const uploadCall = vi.mocked(client.uploadSessionAttachment).mock.calls[0]!;
    expect(uploadCall[0]).toBe(SESSION_ID);
    expect(uploadCall[1]).toBeInstanceOf(Blob);
    expect(uploadCall[1].type).toBe('image/png');
    expect(uploadCall[1].size).toBe(3);
    expect(uploadCall[2]).toBe('shot.png');
    expect(uploadCall[3]).toBe('image/png');

    const promptCall = vi.mocked(client.promptNonBlocking).mock.calls[0]!;
    const body = promptCall[1] as { prompt: unknown[] };
    expect(body.prompt).toHaveLength(2);
    expect(body.prompt[0]).toEqual({
      type: 'text',
      text: 'see the screenshot',
    });
    expect(body.prompt[1]).toBe(reference);
  });
});
