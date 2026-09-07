/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  PEER_ADMISSION_LIMITS,
  PeerAdmission,
  refillBucket,
} from './peer-admission.js';

/** A clock the test drives, so the minute-wide limits stay instant. */
function stubClock() {
  let value = 0;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

describe('refillBucket', () => {
  it('adds the elapsed time at the configured rate, up to the capacity', () => {
    expect(refillBucket(0, 0, 2000, 30, 0.5)).toBe(1);
    expect(refillBucket(10, 0, 10_000, 30, 0.5)).toBe(15);
    expect(refillBucket(29, 0, 10_000, 30, 0.5)).toBe(30);
  });

  it('treats a backward clock step as no time passing', () => {
    // Callers pass a monotonic clock, but one that did not must never be
    // handed more than it had.
    expect(refillBucket(5, 10_000, 0, 30, 0.5)).toBe(5);
  });
});

describe('PeerAdmission', () => {
  it('takes a full burst and then limits the sender', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({ now: clock.now });

    for (let index = 0; index < PEER_ADMISSION_LIMITS.bucketCapacity; index++) {
      expect(
        admission.admit({ senderKey: 'peer', body: `message ${index}` }),
      ).toEqual({ admitted: true });
    }

    expect(admission.admit({ senderKey: 'peer', body: 'one more' })).toEqual({
      admitted: false,
      reason: 'rate-limited',
    });
  });

  it('lets one more through per refill interval once the burst is spent', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({ now: clock.now });
    for (let index = 0; index < PEER_ADMISSION_LIMITS.bucketCapacity; index++) {
      admission.admit({ senderKey: 'peer', body: `message ${index}` });
    }

    clock.advance(1000);
    expect(admission.admit({ senderKey: 'peer', body: 'too soon' })).toEqual({
      admitted: false,
      reason: 'rate-limited',
    });

    clock.advance(1000);
    expect(admission.admit({ senderKey: 'peer', body: 'now ok' })).toEqual({
      admitted: true,
    });
    expect(admission.admit({ senderKey: 'peer', body: 'but not two' })).toEqual(
      {
        admitted: false,
        reason: 'rate-limited',
      },
    );
  });

  it('drops a repeat of the previous body inside the window', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({ now: clock.now });

    expect(
      admission.admit({ senderKey: 'peer', body: 'are you done' }),
    ).toEqual({ admitted: true });
    clock.advance(1000);
    expect(
      admission.admit({ senderKey: 'peer', body: 'are you done' }),
    ).toEqual({ admitted: false, reason: 'duplicate' });
  });

  it('lets the same body through once the window has passed', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({ now: clock.now });
    admission.admit({ senderKey: 'peer', body: 'ping' });

    clock.advance(PEER_ADMISSION_LIMITS.dedupWindowMs + 1);
    expect(admission.admit({ senderKey: 'peer', body: 'ping' })).toEqual({
      admitted: true,
    });
  });

  it('judges the repeat window across a system suspend', () => {
    // A monotonic clock does not tick while the machine is asleep, so a
    // re-send right after a resume must not be judged against only the
    // seconds it was awake: the window runs on the larger of the wall
    // and monotonic deltas, the way the hold buffer's age does.
    const mono = stubClock();
    const wall = stubClock();
    const admission = new PeerAdmission({ now: mono.now, wallNow: wall.now });

    expect(admission.admit({ senderKey: 'peer', body: 'ping' })).toEqual({
      admitted: true,
    });
    // The machine slept past the repeat window; the monotonic clock
    // barely moved.
    wall.advance(PEER_ADMISSION_LIMITS.dedupWindowMs + 1);
    expect(admission.admit({ senderKey: 'peer', body: 'ping' })).toEqual({
      admitted: true,
    });
  });

  it('does not charge a sender for a message it dropped as a repeat', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({
      now: clock.now,
      limits: { bucketCapacity: 2 },
    });

    expect(admission.admit({ senderKey: 'peer', body: 'same' })).toEqual({
      admitted: true,
    });
    // Ten repeats: if any of them spent a token there would be nothing
    // left for the different message below.
    for (let index = 0; index < 10; index++) {
      expect(admission.admit({ senderKey: 'peer', body: 'same' })).toEqual({
        admitted: false,
        reason: 'duplicate',
      });
    }
    expect(admission.admit({ senderKey: 'peer', body: 'different' })).toEqual({
      admitted: true,
    });
  });

  it('exempts a sender from the repeat check without exempting it from the rate', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({
      now: clock.now,
      limits: { bucketCapacity: 3 },
    });

    for (let index = 0; index < 3; index++) {
      expect(
        admission.admit({
          senderKey: 'own-process',
          body: 'build finished',
          exemptFromDedup: true,
        }),
      ).toEqual({ admitted: true });
    }
    expect(
      admission.admit({
        senderKey: 'own-process',
        body: 'build finished',
        exemptFromDedup: true,
      }),
    ).toEqual({ admitted: false, reason: 'rate-limited' });
  });

  it('stops a flood that rotates its sender key at the global limit', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({ now: clock.now });

    const capacity = PEER_ADMISSION_LIMITS.globalBucketCapacity;
    for (let index = 0; index < capacity; index++) {
      expect(
        admission.admit({ senderKey: `peer-${index}`, body: 'hello' }),
      ).toEqual({ admitted: true });
    }
    expect(
      admission.admit({ senderKey: `peer-${capacity}`, body: 'hello' }),
    ).toEqual({ admitted: false, reason: 'rate-limited' });
    // Rejected before a meter was minted, so the flood cannot fill the
    // sender table either.
    expect(admission.trackedSenderCount()).toBe(capacity);
  });

  it('evicts a refilled meter before one that is still holding a sender back', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({
      now: clock.now,
      limits: {
        bucketCapacity: 4,
        refillPerSecond: 0.5,
        maxTrackedSenders: 2,
        globalBucketCapacity: 1000,
        globalRefillPerSecond: 1000,
      },
    });

    for (let index = 0; index < 4; index++) {
      admission.admit({ senderKey: 'noisy', body: `message ${index}` });
    }
    admission.admit({ senderKey: 'quiet', body: 'just one' });

    // Two seconds on: `quiet` is back to full, `noisy` has one token.
    clock.advance(2000);
    expect(admission.admit({ senderKey: 'newcomer', body: 'hi' })).toEqual({
      admitted: true,
    });
    expect(admission.trackedSenderCount()).toBe(2);

    // `noisy` kept its meter: a fresh one would have given it four.
    expect(admission.admit({ senderKey: 'noisy', body: 'next' })).toEqual({
      admitted: true,
    });
    expect(admission.admit({ senderKey: 'noisy', body: 'and next' })).toEqual({
      admitted: false,
      reason: 'rate-limited',
    });
  });

  it('never tracks more senders than the cap', () => {
    const clock = stubClock();
    const admission = new PeerAdmission({
      now: clock.now,
      limits: {
        maxTrackedSenders: 8,
        globalBucketCapacity: 1000,
        globalRefillPerSecond: 1000,
      },
    });

    for (let index = 0; index < 200; index++) {
      admission.admit({ senderKey: `peer-${index}`, body: 'hello' });
    }
    expect(admission.trackedSenderCount()).toBe(8);
  });
});
