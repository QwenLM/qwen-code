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
  PR_WATCH_TRANSITIONS,
  decodePrWatchInputEnvelope,
  encodePrWatchInputEnvelope,
  isPrWatchTransition,
  prWatchBindingId,
  prWatchInputId,
  prWatchInputText,
  type PrWatchEventIdentity,
  type PrWatchInputEnvelope,
} from './managed-pr-watch-operations.js';

const identity: PrWatchEventIdentity = {
  tenantId: 'tenant-1',
  channelInstanceId: 'gh-1',
  owner: 'Owner',
  repo: 'Repo',
  prNumber: 7,
  transition: 'ci_failure',
  headSha: 'abc123',
  episode: 1,
};

function sha256(parts: ReadonlyArray<string | number>): string {
  return createHash('sha256')
    .update(parts.map(String).join('\u0000'), 'utf8')
    .digest('hex');
}

describe('prWatchInputId', () => {
  it('derives the documented NUL-joined sha256 identity', () => {
    expect(prWatchInputId(identity)).toBe(
      `prw-${sha256([
        'tenant-1',
        'gh-1',
        'Owner',
        'Repo',
        7,
        'ci_failure',
        'abc123',
        1,
      ])}:input`,
    );
  });

  it('is deterministic for a redelivery and distinct across transitions/heads', () => {
    expect(prWatchInputId(identity)).toBe(prWatchInputId({ ...identity }));
    expect(prWatchInputId({ ...identity, transition: 'head_change' })).not.toBe(
      prWatchInputId(identity),
    );
    expect(prWatchInputId({ ...identity, headSha: 'def456' })).not.toBe(
      prWatchInputId(identity),
    );
    expect(prWatchInputId({ ...identity, prNumber: 8 })).not.toBe(
      prWatchInputId(identity),
    );
  });

  it('distinguishes a legitimate recurrence by episode, replays the same one', () => {
    // Same head + transition, new episode (dirty→clean→dirty, or A→B→A) is a
    // new occurrence; the same episode redelivered derives the same id.
    expect(prWatchInputId({ ...identity, episode: 2 })).not.toBe(
      prWatchInputId(identity),
    );
    expect(prWatchInputId({ ...identity, episode: 2 })).toBe(
      prWatchInputId({ ...identity, episode: 2 }),
    );
  });

  it('refuses an empty or NUL-bearing identity part', () => {
    expect(() => prWatchInputId({ ...identity, owner: '' })).toThrow();
    expect(() => prWatchInputId({ ...identity, repo: 'a\u0000b' })).toThrow();
    expect(() => prWatchInputId({ ...identity, prNumber: 0 })).toThrow();
    expect(() => prWatchInputId({ ...identity, episode: 0 })).toThrow();
  });
});

describe('prWatchBindingId', () => {
  it('is stable per PR and independent of transition/head', () => {
    const params = {
      tenantId: 'tenant-1',
      channelInstanceId: 'gh-1',
      owner: 'Owner',
      repo: 'Repo',
      prNumber: 7,
    };
    expect(prWatchBindingId(params)).toBe(
      `prb-${sha256(['tenant-1', 'gh-1', 'Owner', 'Repo', 7])}`,
    );
    expect(prWatchBindingId(params)).toBe(prWatchBindingId({ ...params }));
    expect(prWatchBindingId({ ...params, prNumber: 8 })).not.toBe(
      prWatchBindingId(params),
    );
  });
});

describe('isPrWatchTransition', () => {
  it('accepts the slice-1 set and refuses state_change/unknown', () => {
    for (const transition of PR_WATCH_TRANSITIONS) {
      expect(isPrWatchTransition(transition)).toBe(true);
    }
    expect(isPrWatchTransition('state_change')).toBe(false);
    expect(isPrWatchTransition('bogus')).toBe(false);
    expect(isPrWatchTransition(42)).toBe(false);
  });
});

describe('pr-watch input envelope', () => {
  const envelope: PrWatchInputEnvelope = {
    owner: 'Owner',
    repo: 'Repo',
    prNumber: 7,
    transition: 'merge_conflict',
    headSha: 'abc123',
    evidence: 'mergeable_state=dirty',
    text: 'The PR became conflicted.',
  };

  it('round-trips through encode/decode', () => {
    expect(
      decodePrWatchInputEnvelope(encodePrWatchInputEnvelope(envelope)),
    ).toEqual(envelope);
  });

  it('refuses an unknown transition, empty text, and over-bound evidence', () => {
    expect(() =>
      encodePrWatchInputEnvelope({
        ...envelope,
        transition: 'state_change' as never,
      }),
    ).toThrow();
    expect(() =>
      encodePrWatchInputEnvelope({ ...envelope, text: '' }),
    ).toThrow();
    expect(() =>
      encodePrWatchInputEnvelope({
        ...envelope,
        evidence: 'x'.repeat(MANAGED_PR_WATCH_LIMITS.maxEvidenceChars + 1),
      }),
    ).toThrow();
  });

  it('refuses an over-bound envelope byte length', () => {
    // Under the character bound but escape-heavy: each control char expands to
    // a six-byte \uXXXX escape in the JSON envelope, overflowing the byte bound.
    expect(() =>
      encodePrWatchInputEnvelope({
        ...envelope,
        text: '\u0001'.repeat(MANAGED_PR_WATCH_LIMITS.maxTextChars),
      }),
    ).toThrow(/byte_limit/);
  });

  it('refuses malformed JSON on decode', () => {
    expect(() => decodePrWatchInputEnvelope(Buffer.from('{broken'))).toThrow();
  });
});

describe('prWatchInputText', () => {
  it('renders the private prompt with untrusted evidence escaped', () => {
    const text = prWatchInputText({
      owner: 'Owner',
      repo: 'Repo',
      prNumber: 7,
      transition: 'ci_failure',
      headSha: 'abc123',
      evidence: '<check>&"name"',
      text: 'CI went red.',
    });
    expect(text).toContain('<pr-watch-event>');
    expect(text).toContain('<pr>Owner/Repo#7</pr>');
    expect(text).toContain('<transition>ci_failure</transition>');
    expect(text).toContain('&lt;check&gt;&amp;&quot;name&quot;');
    expect(text).toContain('CI went red.');
    expect(text).not.toContain('<check>');
  });

  it('exposes the pr_event source constant', () => {
    expect(PR_EVENT_INPUT_SOURCE).toBe('pr_event');
  });
});
