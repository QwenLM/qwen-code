/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_PR_WATCH_LIMITS,
  PR_EVENT_INPUT_SOURCE,
  decodePrWatchInputEnvelope,
  prWatchInputId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-pr-watch-operations.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type {
  ManagedSessionCommand,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  parsePrWatchSubmitInput,
  submitPrEventInput,
  type HostedPrWatchStore,
  type PrWatchSubmitParams,
} from './hosted-pr-watch-session.js';

const KEY: ManagedSessionKey = {
  tenantId: 't1',
  workspaceId: 'ws-1',
  sessionId: 'session-1',
};
const HEAD = 'a'.repeat(40);

function params(
  overrides: Partial<PrWatchSubmitParams> = {},
): PrWatchSubmitParams {
  const base: PrWatchSubmitParams = {
    inputId: prWatchInputId({
      tenantId: 't1',
      channelInstanceId: 'gh-e2e',
      owner: 'Owner',
      repo: 'Repo',
      prNumber: 7,
      transition: 'ci_failure',
      headSha: HEAD,
      episode: 1,
    }),
    owner: 'Owner',
    repo: 'Repo',
    prNumber: 7,
    transition: 'ci_failure',
    headSha: HEAD,
    evidence: 'Failed checks: build.',
    text: 'Inspect the pull request.',
    episode: 1,
  };
  return { ...base, ...overrides };
}

function fakeStore() {
  const events: ManagedSessionEvent[] = [];
  const published: Array<{ kind: string; bytes: Buffer }> = [];
  const submits: Array<{
    command: ManagedSessionCommand;
    input: ManagedSessionInputRequest;
  }> = [];
  const order: string[] = [];
  const store: HostedPrWatchStore = {
    authority: {
      get committedSequence() {
        return events.length;
      },
      eventsInSequenceRange(from, to) {
        return events.filter((e) => e.sequence >= from && e.sequence <= to);
      },
      async submitInput(command, input) {
        order.push('submitInput');
        submits.push({ command, input });
        events.push({
          v: 1,
          sequence: events.length + 1,
          eventId: `input.accepted:${input.inputId}`,
          sessionKey: KEY,
          kind: 'input.accepted',
          occurredAt: 0,
          payload: {
            inputId: input.inputId,
            source: input.source,
            turnId: input.turnId,
          },
        });
        return {};
      },
    },
    resources: {
      async publish(kind, bytes): Promise<ManagedSessionDurableRef> {
        order.push(`publish:${kind}`);
        published.push({ kind, bytes });
        return {
          resourceId: `res-${published.length}`,
          kind,
          schemaVersion: 1,
          byteLength: bytes.byteLength,
          digest: createHash('sha256').update(bytes).digest('hex'),
        };
      },
    },
  };
  return { store, events, published, submits, order };
}

describe('submitPrEventInput', () => {
  it('commits input+wake with source pr_event and the derived command id', async () => {
    const { store, submits } = fakeStore();
    const p = params();
    const result = await submitPrEventInput(store, KEY, p);
    expect(result).toEqual({
      inputId: p.inputId,
      turnId: p.inputId,
      replayed: false,
    });
    expect(submits).toHaveLength(1);
    const { command, input } = submits[0]!;
    expect(command.operation).toBe('submitPrEventInput');
    expect(command.commandId).toBe(p.inputId);
    expect(command.sessionKey).toEqual(KEY);
    expect(input.source).toBe(PR_EVENT_INPUT_SOURCE);
    expect(input.inputId).toBe(p.inputId);
    expect(input.turnId).toBe(p.inputId);
    expect(input.wakeReason).toBe('input');
    expect(input.deadline).toBeNull();
  });

  it('pins the envelope and admission before the input commit', async () => {
    const { store, published, order, submits } = fakeStore();
    const p = params();
    await submitPrEventInput(store, KEY, p);
    expect(order).toEqual([
      'publish:managed-input',
      'publish:managed-admission',
      'submitInput',
    ]);
    expect(published[0]!.kind).toBe('managed-input');
    const bytes = published[0]!.bytes;
    expect(submits[0]!.command.contentDigest).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('envelope text is the private XML-wrapped prompt with untrusted evidence', async () => {
    const { store, published } = fakeStore();
    const p = params();
    await submitPrEventInput(store, KEY, p);
    const envelope = decodePrWatchInputEnvelope(published[0]!.bytes);
    expect(envelope.transition).toBe('ci_failure');
    expect(envelope.owner).toBe('Owner');
    expect(envelope.headSha).toBe(HEAD);
    expect(envelope.text).toContain('<pr-watch-event>');
    expect(envelope.text).toContain('<transition>ci_failure</transition>');
    expect(envelope.text).toContain('<evidence untrusted="true">');
    expect(envelope.text).toContain(p.text);
  });

  it('replays a committed admission without a second input or publish', async () => {
    const { store, submits, published } = fakeStore();
    const p = params();
    await submitPrEventInput(store, KEY, p);
    const again = await submitPrEventInput(store, KEY, p);
    expect(again.replayed).toBe(true);
    expect(again.inputId).toBe(p.inputId);
    expect(submits).toHaveLength(1);
    expect(published).toHaveLength(2);
  });

  it('serializes concurrent deliveries of one input id into one admission', async () => {
    // The guard reads the journal and the commit follows two awaits later, so
    // without a per-Session lane both calls pass it: two envelope pairs are
    // published and the loser reports `replayed: false` for an admission that
    // did happen.
    const { store, submits, published } = fakeStore();
    const p = params();
    const results = await Promise.all([
      submitPrEventInput(store, KEY, p),
      submitPrEventInput(store, KEY, p),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(submits).toHaveLength(1);
    expect(published).toHaveLength(2);
  });

  it('replay guard requires the pr_event source, not just the input id', async () => {
    const { store, events, submits } = fakeStore();
    const p = params();
    events.push({
      v: 1,
      sequence: 1,
      eventId: 'input.accepted:other-source',
      sessionKey: KEY,
      kind: 'input.accepted',
      occurredAt: 0,
      payload: { inputId: p.inputId, source: 'channel', turnId: p.inputId },
    });
    const result = await submitPrEventInput(store, KEY, p);
    expect(result.replayed).toBe(false);
    expect(submits).toHaveLength(1);
  });

  it('replay guard requires the same input id, not just the pr_event source', async () => {
    const { store, events, submits } = fakeStore();
    const p = params();
    const otherInputId = prWatchInputId({
      tenantId: 't1',
      channelInstanceId: 'gh-e2e',
      owner: 'Owner',
      repo: 'Repo',
      prNumber: 7,
      transition: 'ci_failure',
      headSha: HEAD,
      episode: 2,
    });
    const digest = createHash('sha256').update('{}').digest('hex');
    events.push({
      v: 1,
      sequence: 1,
      eventId: 'input.accepted:other-episode',
      sessionKey: KEY,
      kind: 'input.accepted',
      occurredAt: 0,
      payload: {
        inputId: otherInputId,
        turnId: otherInputId,
        source: PR_EVENT_INPUT_SOURCE,
        contentRef: {
          resourceId: 'res-1',
          kind: 'managed-input',
          schemaVersion: 1,
          byteLength: 2,
          digest,
        },
        deadline: null,
        admissionRef: {
          resourceId: 'res-2',
          kind: 'managed-admission',
          schemaVersion: 1,
          byteLength: 2,
          digest,
        },
      },
    });
    const result = await submitPrEventInput(store, KEY, p);
    expect(result.replayed).toBe(false);
    expect(submits).toHaveLength(1);
  });

  it('refuses an envelope over the evidence character bound', async () => {
    const { store } = fakeStore();
    const p = params({
      evidence: 'x'.repeat(MANAGED_PR_WATCH_LIMITS.maxEvidenceChars + 1),
    });
    await expect(submitPrEventInput(store, KEY, p)).rejects.toThrow();
  });

  it('refuses an envelope whose wrapped text exceeds the byte bound', async () => {
    const { store } = fakeStore();
    // Escape-heavy inner text stays under the character bound even after the
    // XML wrapper, but JSON-encoding each \u0001 as six bytes crosses the
    // envelope byte bound.
    const p = params({ text: '\u0001'.repeat(31_000) });
    await expect(submitPrEventInput(store, KEY, p)).rejects.toThrow(
      /byte_limit/u,
    );
  });
});

describe('parsePrWatchSubmitInput', () => {
  const valid = {
    inputId: prWatchInputId({
      tenantId: 't1',
      channelInstanceId: 'gh-e2e',
      owner: 'Owner',
      repo: 'Repo',
      prNumber: 7,
      transition: 'ci_failure',
      headSha: HEAD,
      episode: 1,
    }),
    owner: 'Owner',
    repo: 'Repo',
    prNumber: 7,
    transition: 'ci_failure',
    headSha: HEAD,
    evidence: 'Failed checks: build.',
    text: 'Inspect the pull request.',
    episode: 1,
  };

  it('accepts the closed operation body', () => {
    expect(parsePrWatchSubmitInput(valid)).toEqual(valid);
  });

  it('rejects null and undefined', () => {
    expect(parsePrWatchSubmitInput(null)).toBeUndefined();
    expect(parsePrWatchSubmitInput(undefined)).toBeUndefined();
  });

  it.each([
    ['inputId not the derived shape', { inputId: 'chin-1' }],
    ['inputId wrong prefix', { inputId: `prb-${'a'.repeat(64)}` }],
    ['empty owner', { owner: '' }],
    ['empty repo', { repo: '' }],
    ['prNumber zero', { prNumber: 0 }],
    ['prNumber fractional', { prNumber: 1.5 }],
    ['unknown transition', { transition: 'state_change' }],
    ['empty headSha', { headSha: '' }],
    ['empty text', { text: '' }],
    ['episode zero', { episode: 0 }],
    ['episode fractional', { episode: 2.5 }],
    ['evidence not a string', { evidence: 5 }],
  ])('rejects %s', (_label, override) => {
    expect(parsePrWatchSubmitInput({ ...valid, ...override })).toBeUndefined();
  });
});
