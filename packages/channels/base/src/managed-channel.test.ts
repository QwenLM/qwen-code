/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
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
