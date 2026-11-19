/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  HttpManagedChannelControlPlane,
  ManagedChannelClientError,
} from './managed-channel-client.js';

function client(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const answer = answers.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as unknown as typeof fetch;
  return {
    calls,
    plane: new HttpManagedChannelControlPlane({
      baseUrl: 'http://127.0.0.1:4181/',
      tenantId: 'tenant-1',
      channelId: 'mail 1',
      actorId: 'owner',
      workspaceId: 'ws-1',
      cwdRelative: '.',
      fetch: fetchImpl,
    }),
  };
}

describe('HttpManagedChannelControlPlane', () => {
  it('addresses the trusted adapter surface with the tenant header', async () => {
    const { plane, calls } = client([
      { status: 200, body: {} },
      {
        status: 200,
        body: { inputId: 'chin-1', sessionId: 's-1', replayed: true },
      },
      {
        status: 200,
        body: {
          deliveries: [
            {
              deliveryId: 'd-1',
              replyContext: { to: 'alice@example.com' },
              segments: [{ ordinal: 0, segmentId: 'd-1:0', text: 'hi' }],
            },
          ],
        },
      },
      { status: 200, body: { deliveryId: 'd-1', state: 'delivered' } },
      { status: 200, body: {} },
    ]);
    await plane.register({
      platform: 'email',
      accountId: 'agent@example.com',
      accountGeneration: 2,
      policy: {
        adapter: 'email',
        senderPolicy: 'allowlist',
        allowedSenders: ['alice@example.com'],
        dispatchMode: 'followup',
      },
    });
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:4181/internal/managed-channels/v1/channels/mail%201',
      init: { method: 'PUT' },
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      platform: 'email',
      accountGeneration: 2,
      actorId: 'owner',
      workspaceId: 'ws-1',
      cwdRelative: '.',
    });
    expect(
      (calls[0]!.init.headers as Record<string, string>)['x-qwen-tenant-id'],
    ).toBe('tenant-1');
    const admitted = await plane.submitInbound({
      accountGeneration: 2,
      platformEventId: '1:2',
      semanticRevision: 1,
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: 'a',
        threadId: 't',
      },
      senderId: 'a',
      chatId: 'a',
      threadId: 't',
      subject: null,
      text: 'hello',
      attachments: [],
      replyContext: {
        to: 'a',
        threadId: 't',
        parent: '<p>',
        references: ['<p>'],
        subject: '',
      },
    });
    expect(admitted).toEqual({
      inputId: 'chin-1',
      sessionId: 's-1',
      replayed: true,
    });
    expect(calls[1]!.url).toMatch(/\/inbound$/);
    const claimed = await plane.claimDeliveries(16);
    expect(claimed).toEqual([
      {
        deliveryId: 'd-1',
        replyContext: { to: 'alice@example.com' },
        segments: [{ ordinal: 0, segmentId: 'd-1:0', text: 'hi' }],
      },
    ]);
    expect(calls[2]!.url).toMatch(/\/deliveries:claim$/);
    const settled = await plane.receipt('d-1', {
      outcome: 'accepted',
      ordinal: 0,
      providerMessageId: '<m@x>',
      acceptedAt: 5,
    });
    // The settled delivery view is the only gate for prune-on-delivered; the
    // producer must surface it, not discard it (R2-2). Returning {} reds this.
    expect(settled).toMatchObject({ state: 'delivered' });
    expect(calls[3]!.url).toMatch(/\/deliveries\/d-1:receipt$/);
    expect(JSON.parse(calls[3]!.init.body as string)).toEqual({
      outcome: 'accepted',
      ordinal: 0,
      providerMessageId: '<m@x>',
      acceptedAt: 5,
    });
    await plane.receipt('d-1', { outcome: 'unknown' });
    expect(JSON.parse(calls[4]!.init.body as string)).toEqual({
      outcome: 'unknown',
    });
  });

  it('injectPrEvent composes the model-facing prompt, not the raw evidence', async () => {
    const headSha = 'a'.repeat(40);
    const evidence = `CI failed on head ${headSha}. Failed checks: build.`;
    const { plane, calls } = client([{ status: 200, body: {} }]);
    await plane.injectPrEvent({
      owner: 'Owner',
      repo: 'Repo',
      prNumber: 7,
      transition: 'ci_failure',
      headSha,
      evidence,
      episode: 1,
    });
    expect(calls[0]!.url).toMatch(/\/pr-watch:inject$/);
    const body = JSON.parse(calls[0]!.init.body as string) as {
      text: string;
    };
    expect(body.text).toContain('Owner/Repo#7');
    expect(body.text).toContain('ci_failure');
    expect(body.text).toContain(headSha);
    expect(body.text).not.toContain(evidence);
  });

  it('returns the listed pr-watch bindings', async () => {
    const { plane } = client([
      {
        status: 200,
        body: {
          bindings: [
            {
              owner: 'Owner',
              repo: 'Repo',
              prNumber: 7,
              sessionId: 'session-1',
              events: ['ci_failure', 'head_change'],
            },
          ],
        },
      },
    ]);
    await expect(plane.listPrWatchBindings()).resolves.toEqual([
      {
        owner: 'Owner',
        repo: 'Repo',
        prNumber: 7,
        sessionId: 'session-1',
        events: ['ci_failure', 'head_change'],
      },
    ]);
  });

  it('refuses a malformed pr-watch:list answer instead of reading it as empty', async () => {
    // The adapter prunes every watch the answer omits, so coercing a bad body
    // to `[]` would wipe each persisted baseline, fired ring and pending
    // queue. Every shape below must throw out of the client.
    for (const body of [
      { bindings: null },
      { bindings: 'Owner/Repo#7' },
      {
        bindings: [
          { owner: 'Owner', repo: 'Repo', prNumber: 7, events: ['ci_failure'] },
          { owner: 'Owner', repo: 'Repo', prNumber: 0, events: [] },
        ],
      },
      {
        bindings: [
          { owner: 'Owner', repo: 'Repo', prNumber: 7, events: 'ci_failure' },
        ],
      },
    ]) {
      const { plane } = client([{ status: 200, body }]);
      const refusal = await plane.listPrWatchBindings().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect([JSON.stringify(body), refusal instanceof Error]).toEqual([
        JSON.stringify(body),
        true,
      ]);
    }
    const { plane } = client([{ status: 200, body: {} }]);
    await expect(plane.listPrWatchBindings()).rejects.toThrow(
      'without a bindings array',
    );
  });

  it('surfaces the server error code on a refusal', async () => {
    const { plane } = client([
      {
        status: 409,
        body: { error: { code: 'channel_generation_stale', message: 'stale' } },
      },
    ]);
    const refusal = await plane.disconnect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ManagedChannelClientError);
    expect(refusal).toMatchObject({
      status: 409,
      code: 'channel_generation_stale',
    });
  });

  it('destinationKey binds the full registration identity, not just tenant/channel', () => {
    const base = {
      baseUrl: 'http://127.0.0.1:4181/',
      tenantId: 'tenant-1',
      channelId: 'chan-1',
      actorId: 'owner',
      workspaceId: 'ws-1',
      cwdRelative: '.',
    };
    const key = (over: Record<string, string>) =>
      new HttpManagedChannelControlPlane({ ...base, ...over }).destinationKey;
    const original = key({});
    // Stable for the same registration (trailing slash normalized).
    expect(key({ baseUrl: 'http://127.0.0.1:4181' })).toBe(original);
    // Every ownership field changes the key, so a pending ledger follows its
    // registered owner/workspace/cwd rather than replaying into a new
    // registration of the same tenant/channel.
    expect(key({ actorId: 'other' })).not.toBe(original);
    expect(key({ workspaceId: 'ws-2' })).not.toBe(original);
    expect(key({ cwdRelative: 'sub' })).not.toBe(original);
    expect(key({ tenantId: 'tenant-2' })).not.toBe(original);
    expect(key({ channelId: 'chan-2' })).not.toBe(original);
  });
});
