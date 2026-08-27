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
    closeSession: vi.fn(async () => undefined),
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
    options: [{ optionId: 'allow', label: 'Allow once' }, { optionId: 'deny' }],
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
      { optionId: 'allow', label: 'Allow once', kind: 'proceed' },
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
