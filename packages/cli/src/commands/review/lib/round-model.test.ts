/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { certifierMatchesRound, roundModelIdFrom } from './round-model.js';

describe('roundModelIdFrom', () => {
  it('prefers the provider-qualified identity over the bare model id', () => {
    // Two provider configurations can expose one model NAME; only the
    // qualified form separates them, and the same-model gate that decides
    // whether to skip already-reviewed hunks is what reads this.
    expect(
      roundModelIdFrom({
        QWEN_CODE_MODEL: 'qwen3-coder-plus',
        QWEN_CODE_MODEL_IDENTITY: 'qwen3-coder-plus@1a2b3c4d',
      }),
    ).toBe('qwen3-coder-plus@1a2b3c4d');
  });

  it('falls back to the bare id when the runtime publishes no identity', () => {
    expect(roundModelIdFrom({ QWEN_CODE_MODEL: 'qwen3-coder-plus' })).toBe(
      'qwen3-coder-plus',
    );
  });

  it('falls back to the bare id when the identity slot is BLANK, not just absent', () => {
    // The blank is not hypothetical: `getShellContextEnvVars` writes `''`
    // rather than omitting the key, because an omitted key is not a withheld
    // value — the spawn-site `{...process.env, ...}` spread would leak the
    // parent's stale one. `??` falls back on absent and not on empty, so it
    // turned every such round into "no identity at all": nobody certified,
    // and the next round re-reviewed the full diff, permanently.
    expect(
      roundModelIdFrom({
        QWEN_CODE_MODEL: 'qwen3-coder-plus',
        QWEN_CODE_MODEL_IDENTITY: '',
      }),
    ).toBe('qwen3-coder-plus');
    expect(
      roundModelIdFrom({
        QWEN_CODE_MODEL: 'qwen3-coder-plus',
        QWEN_CODE_MODEL_IDENTITY: '   ',
      }),
    ).toBe('qwen3-coder-plus');
  });

  it('is empty only when NEITHER slot names anything', () => {
    // Empty means "unknown", which the composer reads as a MISMATCH rather
    // than as agreement — the anchor is withheld and the next round reviews
    // in full. A whitespace-only slot must reach that same state, not stamp a
    // blank identity that compares equal to another blank one.
    expect(roundModelIdFrom({})).toBe('');
    expect(roundModelIdFrom({ QWEN_CODE_MODEL: '   ' })).toBe('');
    expect(
      roundModelIdFrom({ QWEN_CODE_MODEL: '  ', QWEN_CODE_MODEL_IDENTITY: '' }),
    ).toBe('');
  });
});

describe('certifierMatchesRound', () => {
  it('holds only on whole-string equality', () => {
    expect(certifierMatchesRound('m@1a2b3c4d', 'm@1a2b3c4d')).toBe(true);
    // The prefix relation the digest exists to break, both directions: a bare
    // id must not match its own qualified form, or the qualifier buys nothing.
    expect(certifierMatchesRound('m', 'm@1a2b3c4d')).toBe(false);
    expect(certifierMatchesRound('m@1a2b3c4d', 'm')).toBe(false);
    // Same model NAME, different provider — the case the digest is for.
    expect(certifierMatchesRound('m@9f8e7d6c', 'm@1a2b3c4d')).toBe(false);
  });

  it('treats every unknown as a mismatch, including two unknowns', () => {
    // A marker written before the field, a runtime that published nothing,
    // and a whitespace-only value all mean "nobody can say who reviewed this
    // range". The fallback for not knowing is the full review, never a skip —
    // so two blanks must not compare equal to each other.
    expect(certifierMatchesRound(undefined, 'm@1a2b3c4d')).toBe(false);
    expect(certifierMatchesRound('m@1a2b3c4d', '')).toBe(false);
    expect(certifierMatchesRound(undefined, '')).toBe(false);
    expect(certifierMatchesRound('   ', 'm@1a2b3c4d')).toBe(false);
    expect(certifierMatchesRound('   ', '   ')).toBe(false);
  });

  it('ENGAGES on two bare ids — the qualifier is optional, not required', () => {
    // Every other case here is a refusal, so a `return false` mutant would
    // survive them all. A runtime that publishes no identity certifies with
    // its bare model id, and the next round under the same one must be able
    // to use that anchor — otherwise the gate does not narrow the feature, it
    // deletes it for anyone whose provider config resolves to nothing.
    expect(certifierMatchesRound('qwen3-coder-plus', 'qwen3-coder-plus')).toBe(
      true,
    );
  });

  it('ignores surrounding whitespace on the certifier', () => {
    // It comes off a parsed marker, where a stray space is a formatting
    // artefact rather than a different identity.
    expect(certifierMatchesRound(' m@1a2b3c4d ', 'm@1a2b3c4d')).toBe(true);
  });
});
