/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-pr-backfill.js', () => ({
  bindSessionPrsFromPromptCommand: vi.fn(async () => undefined),
}));

import {
  CHANNEL_PROMPT_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  DAEMON_SUBMITTED_PROMPT_META_KEY,
  SUBMITTED_PROMPT_META_KEY,
} from '@qwen-code/acp-bridge/bridgeTypes';
import {
  CHANNEL_BOUND_RELAY_META_KEY,
  CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY,
  registerChannelWorkerPromptAuthorization,
  revokeChannelWorkerPromptAuthorization,
} from '../channel-worker-prompt-authorization.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import type { SessionArchiveCoordinator } from '../server/session-archive.js';
import { bindSessionPrsFromPromptCommand } from './session-pr-backfill.js';
import {
  PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH,
  admitSessionPrompt,
  classifyPromptRequest,
  type SessionPromptClassification,
} from './session-prompt-admission.js';

const mockBind = vi.mocked(bindSessionPrsFromPromptCommand);

type SendPrompt = (
  sessionId: string,
  request: unknown,
  signal: AbortSignal | undefined,
  context: { promptId: string; onPromptAdmitted?: () => void } & Record<
    string,
    unknown
  >,
) => Promise<unknown>;

/** The cursor every fake bridge reports; tests move it to see a fresh read. */
const lastEventId = { value: 41 };

/** A runtime whose bridge admits every prompt and settles it on demand. */
function fakeRuntime(
  overrides: { trusted?: boolean; sendPrompt?: SendPrompt } = {},
) {
  const calls: Array<{
    sessionId: string;
    request: unknown;
    context: Record<string, unknown>;
  }> = [];
  const settle: Array<{ resolve: () => void; reject: (e: unknown) => void }> =
    [];
  const sendPrompt: SendPrompt =
    overrides.sendPrompt ??
    ((sessionId, request, _signal, context) => {
      calls.push({ sessionId, request, context });
      context.onPromptAdmitted?.();
      return new Promise<void>((resolve, reject) => {
        settle.push({ resolve, reject });
      });
    });
  const runtime = {
    workspaceCwd: '/ws',
    primary: true,
    trusted: overrides.trusted ?? true,
    bridge: {
      sendPrompt,
      getSessionLastEventId: () => lastEventId.value,
      getSessionEventEpoch: () => 'epoch-1',
    },
  } as unknown as WorkspaceRuntime;
  return { runtime, calls, settle };
}

const deps = {
  archiveCoordinator: {} as SessionArchiveCoordinator,
};

const plain: SessionPromptClassification = {
  channelPrompt: false,
  requestedChannelPrompt: false,
};

let nextSession = 0;
/** A fresh session id per test: the idempotency ring is module state. */
const freshSessionId = () => `admission-test-${(nextSession += 1)}`;

const reviewPrompt = [{ type: 'text', text: '/review 7' }];

beforeEach(() => {
  mockBind.mockClear();
  lastEventId.value = 41;
});

describe('classifyPromptRequest', () => {
  const runtime = { workspaceCwd: '/ws', primary: true, trusted: true };
  afterEach(() => {
    revokeChannelWorkerPromptAuthorization('worker-token');
  });

  it('strips the envelope fields and every marker from the forwarded body', () => {
    const { forwardedBody } = classifyPromptRequest(
      {
        prompt: [],
        deadlineMs: 5,
        delivery: {},
        idempotencyKey: 'k',
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_BOUND_RELAY_META_KEY]: true,
          [CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY]: 'forged',
          [DAEMON_PROMPT_DISPLAY_TEXT_META_KEY]: 'shown',
          [SUBMITTED_PROMPT_META_KEY]: 'typed',
          [DAEMON_SUBMITTED_PROMPT_META_KEY]: 'typed',
          kept: 1,
        },
      },
      runtime,
    );
    expect(forwardedBody).toEqual({ prompt: [], _meta: { kept: 1 } });
  });

  it('gives a channel marker without the worker credential no classification', () => {
    const { classification } = classifyPromptRequest(
      {
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY]: 'forged',
        },
      },
      runtime,
    );
    expect(classification).toEqual({
      channelPrompt: false,
      requestedChannelPrompt: true,
    });
  });

  it('classifies a channel prompt carrying a registered worker token', () => {
    registerChannelWorkerPromptAuthorization('worker-token', '/ws');
    const { classification } = classifyPromptRequest(
      {
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY]: 'worker-token',
        },
      },
      runtime,
    );
    expect(classification).toEqual({
      channelPrompt: true,
      requestedChannelPrompt: true,
    });
  });
});

describe('admitSessionPrompt', () => {
  it('admits a prompt and dedupes a repeated key into the first admission', () => {
    const { runtime, calls } = fakeRuntime();
    const sessionId = freshSessionId();
    const input = {
      runtime,
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
      request: {},
      classification: plain,
      idempotencyKey: 'event-1',
    };
    const first = admitSessionPrompt(deps, input);
    lastEventId.value = 57;
    const second = admitSessionPrompt(deps, input);
    expect(first).toMatchObject({
      deduplicated: false,
      lastEventId: 41,
      eventEpoch: 'epoch-1',
    });
    // The repeat reads the cursor afresh, so the caller can seed a resume.
    expect(second).toEqual({
      deduplicated: true,
      promptId: first.promptId,
      lastEventId: 57,
      eventEpoch: 'epoch-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context['promptId']).toBe(first.promptId);
  });

  it('passes a trusted channel classification to the bridge and skips the backfill', () => {
    // The in-process caller: no request marker, only the classification.
    const { runtime, calls } = fakeRuntime();
    admitSessionPrompt(deps, {
      runtime,
      sessionId: freshSessionId(),
      prompt: reviewPrompt,
      request: {},
      classification: { channelPrompt: true, requestedChannelPrompt: false },
    });
    expect(calls[0]!.context['channelPrompt']).toBe(true);
    expect(mockBind).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "skips the backfill for a request's own channel marker (trusted: %s)",
    (channelPrompt) => {
      const { runtime, calls } = fakeRuntime();
      admitSessionPrompt(deps, {
        runtime,
        sessionId: freshSessionId(),
        prompt: reviewPrompt,
        request: {},
        classification: { channelPrompt, requestedChannelPrompt: true },
      });
      expect(calls[0]!.context['channelPrompt']).toBe(
        channelPrompt ? true : undefined,
      );
      expect(mockBind).not.toHaveBeenCalled();
    },
  );

  it("backfills a trusted workspace's plain prompt from its first text block only", () => {
    const { runtime } = fakeRuntime();
    const sessionId = freshSessionId();
    admitSessionPrompt(deps, {
      runtime,
      sessionId,
      prompt: [
        null,
        undefined,
        'text',
        { type: 'image', data: 'x', mimeType: 'image/png' },
        { type: 'text', text: '/review 7' },
        { type: 'text', text: '/review 8' },
      ],
      request: {},
      classification: plain,
    });
    expect(mockBind).toHaveBeenCalledTimes(1);
    expect(mockBind).toHaveBeenCalledWith(runtime, sessionId, '/review 7', {
      archiveCoordinator: deps.archiveCoordinator,
    });

    mockBind.mockClear();
    const untrusted = fakeRuntime({ trusted: false });
    admitSessionPrompt(deps, {
      runtime: untrusted.runtime,
      sessionId: freshSessionId(),
      prompt: reviewPrompt,
      request: {},
      classification: plain,
    });
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('forgets the key of a prompt rejected before admission, keeps that of a failed turn', async () => {
    const sessionId = freshSessionId();
    let admit = false;
    const { runtime } = fakeRuntime({
      sendPrompt: (_id, _request, _signal, context) => {
        if (admit) context.onPromptAdmitted?.();
        return Promise.reject(new Error('nope'));
      },
    });
    const input = {
      runtime,
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
      request: {},
      classification: plain,
      idempotencyKey: 'event-1',
    };

    const rejected = admitSessionPrompt(deps, input);
    if (rejected.deduplicated) throw new Error('unexpected dedupe');
    await rejected.settled;
    // Never admitted: a retry is a fresh admission, not a phantom dedupe.
    admit = true;
    const retried = admitSessionPrompt(deps, input);
    expect(retried.deduplicated).toBe(false);
    if (retried.deduplicated) return;
    await retried.settled;
    // Admitted, then the turn failed: the key stays.
    expect(admitSessionPrompt(deps, input)).toMatchObject({
      deduplicated: true,
      promptId: retried.promptId,
    });
  });

  it('revokes the delivery authorization and remembers nothing on a synchronous rejection', () => {
    const sessionId = freshSessionId();
    const failure = new Error('queue full');
    const { runtime } = fakeRuntime({
      sendPrompt: () => {
        throw failure;
      },
    });
    const authorizations = {
      authorizePrompt: vi.fn(),
      revokePrompt: vi.fn(),
    };
    const input = {
      runtime,
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
      request: {},
      classification: plain,
      idempotencyKey: 'event-1',
      delivery: { target: 'chat' } as never,
    };
    let promptId: string | undefined;
    expect(() =>
      admitSessionPrompt(
        {
          ...deps,
          channelDeliveryAuthorizations: authorizations as never,
        },
        { ...input, onPromptId: (id) => (promptId = id) },
      ),
    ).toThrow(failure);
    expect(authorizations.authorizePrompt).toHaveBeenCalledWith('/ws', {
      sessionId,
      deliveryId: promptId,
      target: 'chat',
    });
    expect(authorizations.revokePrompt).toHaveBeenCalledWith(
      '/ws',
      sessionId,
      promptId,
    );
    expect(mockBind).not.toHaveBeenCalled();

    const { runtime: healthy, calls } = fakeRuntime();
    expect(
      admitSessionPrompt(deps, { ...input, runtime: healthy }).deduplicated,
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('dedupes before minting a delivery authorization, and revokes it after the turn', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, settle } = fakeRuntime();
      const authorizations = {
        authorizePrompt: vi.fn(),
        revokePrompt: vi.fn(),
      };
      const admissionDeps = {
        ...deps,
        channelDeliveryAuthorizations: authorizations as never,
      };
      const sessionId = freshSessionId();
      const input = {
        runtime,
        sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
        request: {},
        classification: plain,
        idempotencyKey: 'event-1',
        delivery: { target: 'chat' } as never,
      };
      const first = admitSessionPrompt(admissionDeps, input);
      expect(admitSessionPrompt(admissionDeps, input).deduplicated).toBe(true);
      expect(authorizations.authorizePrompt).toHaveBeenCalledTimes(1);
      if (first.deduplicated) throw new Error('unexpected dedupe');

      settle[0]!.resolve();
      await first.settled;
      // The grace outlasts the 30 s delivery IPC timeout.
      vi.advanceTimersByTime(59_999);
      expect(authorizations.revokePrompt).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(authorizations.revokePrompt).toHaveBeenCalledWith(
        '/ws',
        sessionId,
        first.promptId,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('mints no authorization when the session is gone before the enqueue', () => {
    const { runtime } = fakeRuntime();
    const gone = new Error('session not found');
    (
      runtime.bridge as unknown as { getSessionLastEventId: () => never }
    ).getSessionLastEventId = () => {
      throw gone;
    };
    const authorizations = { authorizePrompt: vi.fn(), revokePrompt: vi.fn() };
    expect(() =>
      admitSessionPrompt(
        { ...deps, channelDeliveryAuthorizations: authorizations as never },
        {
          runtime,
          sessionId: freshSessionId(),
          prompt: [{ type: 'text', text: 'hi' }],
          request: {},
          classification: plain,
          delivery: { target: 'chat' } as never,
        },
      ),
    ).toThrow(gone);
    expect(authorizations.authorizePrompt).not.toHaveBeenCalled();
  });

  it('accepts a key at the route limit and refuses an empty or longer one before anything happens', () => {
    const { runtime, calls } = fakeRuntime();
    const authorizations = { authorizePrompt: vi.fn(), revokePrompt: vi.fn() };
    const onPromptId = vi.fn();
    const admit = (idempotencyKey: string) =>
      admitSessionPrompt(
        { ...deps, channelDeliveryAuthorizations: authorizations as never },
        {
          runtime,
          sessionId: freshSessionId(),
          prompt: [{ type: 'text', text: 'hi' }],
          request: {},
          classification: plain,
          idempotencyKey,
          delivery: { target: 'chat' } as never,
          onPromptId,
        },
      );

    expect(() =>
      admit('k'.repeat(PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH + 1)),
    ).toThrow(RangeError);
    expect(() => admit('')).toThrow(RangeError);
    expect(calls).toHaveLength(0);
    expect(onPromptId).not.toHaveBeenCalled();
    expect(authorizations.authorizePrompt).not.toHaveBeenCalled();

    expect(
      admit('k'.repeat(PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH)).deduplicated,
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('settles once the turn has finished, whatever its outcome', async () => {
    const { runtime, settle } = fakeRuntime();
    const done = admitSessionPrompt(deps, {
      runtime,
      sessionId: freshSessionId(),
      prompt: [{ type: 'text', text: 'hi' }],
      request: {},
      classification: plain,
    });
    const failed = admitSessionPrompt(deps, {
      runtime,
      sessionId: freshSessionId(),
      prompt: [{ type: 'text', text: 'hi' }],
      request: {},
      classification: plain,
    });
    if (done.deduplicated || failed.deduplicated) throw new Error('dedupe');
    let finished = 0;
    void done.settled.then(() => (finished += 1));
    void failed.settled.then(() => (finished += 1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(0);
    settle[0]!.resolve();
    settle[1]!.reject(new Error('turn failed'));
    await expect(done.settled).resolves.toBeUndefined();
    await expect(failed.settled).resolves.toBeUndefined();
    expect(finished).toBe(2);
  });
});
