/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_INBOUND_TRUNCATION_NOTICE,
  fitInboundText,
  MANAGED_OUTBOUND_LIMIT,
  validManagedReceipt,
} from './managed-channel.js';

// #17173 R1-29: the receipt validator lives beside the shared ManagedReceipt
// type so the email and DingTalk state stores cannot drift. Each guard below
// has a witness that reds when the guard is removed.
describe('validManagedReceipt (shared managed receipt validator)', () => {
  const accepted = {
    outcome: 'accepted',
    ordinal: 0,
    providerMessageId: 'provider-1',
    acceptedAt: 1_700_000_000_000,
  };

  it('accepts an absent receipt (the segment is still unanswered)', () => {
    expect(validManagedReceipt(undefined)).toBe(true);
  });

  it('accepts a well-formed accepted receipt', () => {
    expect(validManagedReceipt(accepted)).toBe(true);
    expect(validManagedReceipt({ ...accepted, ordinal: 7 })).toBe(true);
  });

  it('accepts unknown and rejected carrying only the outcome', () => {
    expect(validManagedReceipt({ outcome: 'unknown' })).toBe(true);
    expect(validManagedReceipt({ outcome: 'rejected' })).toBe(true);
  });

  it('rejects unknown/rejected that carry extra fields', () => {
    expect(validManagedReceipt({ outcome: 'unknown', ordinal: 0 })).toBe(false);
    expect(validManagedReceipt({ outcome: 'rejected', acceptedAt: 1 })).toBe(
      false,
    );
  });

  it('rejects non-object receipts', () => {
    expect(validManagedReceipt(null)).toBe(false);
    expect(validManagedReceipt([])).toBe(false);
    expect(validManagedReceipt('accepted')).toBe(false);
    expect(validManagedReceipt(42)).toBe(false);
  });

  it('rejects an unrecognized outcome', () => {
    expect(validManagedReceipt({ outcome: 'delivered' })).toBe(false);
    expect(validManagedReceipt({})).toBe(false);
  });

  it('rejects an accepted receipt with a bad ordinal', () => {
    expect(validManagedReceipt({ ...accepted, ordinal: -1 })).toBe(false);
    expect(validManagedReceipt({ ...accepted, ordinal: 1.5 })).toBe(false);
    expect(validManagedReceipt({ ...accepted, ordinal: '0' })).toBe(false);
    expect(validManagedReceipt({ ...accepted, ordinal: undefined })).toBe(
      false,
    );
  });

  it('rejects an accepted receipt with a bad providerMessageId', () => {
    expect(validManagedReceipt({ ...accepted, providerMessageId: '' })).toBe(
      false,
    );
    expect(
      validManagedReceipt({ ...accepted, providerMessageId: 'x'.repeat(513) }),
    ).toBe(false);
    expect(validManagedReceipt({ ...accepted, providerMessageId: 7 })).toBe(
      false,
    );
    expect(
      validManagedReceipt({ ...accepted, providerMessageId: undefined }),
    ).toBe(false);
    // The 512 boundary itself is still accepted.
    expect(
      validManagedReceipt({ ...accepted, providerMessageId: 'x'.repeat(512) }),
    ).toBe(true);
  });

  it('rejects an accepted receipt with a bad acceptedAt', () => {
    expect(validManagedReceipt({ ...accepted, acceptedAt: -1 })).toBe(false);
    expect(validManagedReceipt({ ...accepted, acceptedAt: 1.5 })).toBe(false);
    expect(validManagedReceipt({ ...accepted, acceptedAt: 'now' })).toBe(false);
    expect(validManagedReceipt({ ...accepted, acceptedAt: undefined })).toBe(
      false,
    );
  });
});

// #17173 R1-12: one shared outbound ledger cap feeds both the state
// validators' bound and the adapters' .slice(-N), so the two cannot drift.
describe('MANAGED_OUTBOUND_LIMIT (shared outbound ledger cap)', () => {
  it('pins the ledger cap the validators and adapters share', () => {
    expect(MANAGED_OUTBOUND_LIMIT).toBe(64);
  });
});

// R1-20: the inbound clamp marks itself when it shortens a message, reserving
// the notice inside both server bounds. Each witness reds when the notice or
// its reservation is removed; the exact-prefix assertions pin the maximal core.
describe('fitInboundText (shared inbound clamp with truncation notice)', () => {
  const notice = CHANNEL_INBOUND_TRUNCATION_NOTICE;
  const charLimit = 32_000;
  const byteLimit = 64 * 1024 - 4096;
  const encodedBytes = (s: string): number =>
    Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;
  const coreCharLimit = charLimit - notice.length;
  const coreByteLimit = byteLimit - encodedBytes(notice);

  it('admits a fitting frame unchanged, with no notice', () => {
    expect(fitInboundText('a short message')).toBe('a short message');
    // Exactly at the char cap still fits: no notice.
    const exact = 'x'.repeat(charLimit);
    expect(fitInboundText(exact)).toBe(exact);
  });

  it('marks a char-cap cut and reserves the notice inside the cap', () => {
    const text = fitInboundText('x'.repeat(charLimit + 1));
    expect(text.endsWith(notice)).toBe(true);
    expect(text).toBe('x'.repeat(coreCharLimit) + notice);
    expect(text.length).toBe(charLimit);
  });

  it('marks a CJK byte cut with a maximal whole-code-point core', () => {
    const text = fitInboundText('a' + '中'.repeat(25_000));
    expect(text.endsWith(notice)).toBe(true);
    // 'a' + floor((coreByteLimit-1)/3) CJK chars, then the notice.
    const n = Math.floor((coreByteLimit - 1) / 3);
    expect(text).toBe('a' + '中'.repeat(n) + notice);
    expect(encodedBytes(text)).toBeLessThanOrEqual(byteLimit);
    // Maximality: one more CJK char in the core would overflow the reduced
    // byte budget, so an over-truncation by one code point reds this.
    expect(encodedBytes('a' + '中'.repeat(n + 1))).toBeGreaterThan(
      coreByteLimit,
    );
  });

  it('keeps astral pairs whole at a mid-pair byte budget and marks the cut', () => {
    const text = fitInboundText('a' + '😀'.repeat(20_000));
    expect(text.endsWith(notice)).toBe(true);
    const m = Math.floor((coreByteLimit - 1) / 4);
    expect(text).toBe('a' + '😀'.repeat(m) + notice);
    expect(text.isWellFormed()).toBe(true);
    expect(encodedBytes(text)).toBeLessThanOrEqual(byteLimit);
  });

  it('marks an escape-heavy cut by its JSON-serialized length', () => {
    const ctrl = String.fromCharCode(1);
    const text = fitInboundText(ctrl.repeat(20_000));
    expect(text.endsWith(notice)).toBe(true);
    const k = Math.floor(coreByteLimit / 6);
    expect(text).toBe(ctrl.repeat(k) + notice);
    expect(encodedBytes(text)).toBeLessThanOrEqual(byteLimit);
    expect(encodedBytes(text + ctrl)).toBeGreaterThan(byteLimit);
  });

  it('backs off a lone surrogate at the reduced core cap, then marks', () => {
    // Place an astral pair straddling the core char cap so the core slice lands
    // on a high surrogate; the backoff must drop it, not admit a lone surrogate.
    const text = fitInboundText(
      'x'.repeat(coreCharLimit - 1) + '😀'.repeat(100),
    );
    expect(text.endsWith(notice)).toBe(true);
    expect(text).toBe('x'.repeat(coreCharLimit - 1) + notice);
    expect(text.isWellFormed()).toBe(true);
  });

  it('the marked result fits both server bounds', () => {
    for (const input of [
      'x'.repeat(charLimit + 500),
      'a' + '中'.repeat(25_000),
      'a' + '😀'.repeat(20_000),
      String.fromCharCode(1).repeat(20_000),
    ]) {
      const text = fitInboundText(input);
      expect(text.length).toBeLessThanOrEqual(charLimit);
      expect(encodedBytes(text)).toBeLessThanOrEqual(byteLimit);
      expect(text.endsWith(notice)).toBe(true);
    }
  });
});
