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
  type AdmissionRequest,
  type PeerAdmissionOptions,
} from './peer-admission.js';
import { MAX_CONCURRENT_SENDS } from './uds-client.js';

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

const ADMITTED = { admitted: true };
const LIMITED = { admitted: false, reason: 'rate-limited' };
const DUPLICATE = { admitted: false, reason: 'duplicate' };

/** A PeerAdmission whose monotonic clock the test drives. */
function onClock(options: PeerAdmissionOptions = {}) {
  const clock = stubClock();
  const admission = new PeerAdmission({ now: clock.now, ...options });
  return { clock, admission };
}

/** Admits `body` from `senderKey` and returns the verdict. */
const admit = (
  admission: PeerAdmission,
  body: string,
  senderKey = 'peer',
  messageId?: string,
) => admission.admit({ senderKey, body, messageId });

/** Admits `count` messages, the i-th being `request(i)`. */
function admitMany(
  admission: PeerAdmission,
  count: number,
  request: (index: number) => AdmissionRequest,
) {
  for (let index = 0; index < count; index++) admission.admit(request(index));
}

/** Spends `peer`'s whole default burst on distinct bodies. */
const spendBurst = (admission: PeerAdmission) =>
  admitMany(admission, PEER_ADMISSION_LIMITS.bucketCapacity, (index) => ({
    senderKey: 'peer',
    body: `message ${index}`,
  }));

/** One message of a flood that rotates its sender key. */
const rotating = (index: number) => ({
  senderKey: `peer-${index}`,
  body: 'hello',
});

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

describe('the limits themselves', () => {
  it('leaves room on the outbound ceiling for an admitted burst', () => {
    // Every admitted message draws its own receipt, sharing one
    // process-wide ceiling with everything else this session sends
    // (including a close's burst of expiry receipts). A global burst above
    // half of it would let one flood occupy the slots legitimate traffic
    // needs — the starvation this file exists to prevent.
    expect(PEER_ADMISSION_LIMITS.globalBucketCapacity).toBeLessThanOrEqual(
      MAX_CONCURRENT_SENDS / 2,
    );
  });
});

describe('PeerAdmission', () => {
  it('takes a full burst and then limits the sender', () => {
    const { admission } = onClock();
    for (let index = 0; index < PEER_ADMISSION_LIMITS.bucketCapacity; index++) {
      expect(admit(admission, `message ${index}`)).toEqual(ADMITTED);
    }
    expect(admit(admission, 'one more')).toEqual(LIMITED);
  });

  it('lets one more through per refill interval once the burst is spent', () => {
    const { clock, admission } = onClock();
    spendBurst(admission);

    clock.advance(1000);
    expect(admit(admission, 'too soon')).toEqual(LIMITED);
    clock.advance(1000);
    expect(admit(admission, 'now ok')).toEqual(ADMITTED);
    expect(admit(admission, 'but not two')).toEqual(LIMITED);
  });

  it('drops a repeat of the previous body inside the window', () => {
    const { clock, admission } = onClock();
    expect(admit(admission, 'are you done')).toEqual(ADMITTED);
    clock.advance(1000);
    expect(admit(admission, 'are you done')).toEqual(DUPLICATE);
  });

  it('compares repeats only with the latest admitted body', () => {
    const admission = new PeerAdmission();
    expect(admit(admission, 'A')).toEqual(ADMITTED);
    expect(admit(admission, 'B')).toEqual(ADMITTED);
    expect(admit(admission, 'A')).toEqual(ADMITTED);
  });

  it('lets the same body through once the window has passed', () => {
    const { clock, admission } = onClock();
    admit(admission, 'ping');
    clock.advance(PEER_ADMISSION_LIMITS.dedupWindowMs + 1);
    expect(admit(admission, 'ping')).toEqual(ADMITTED);
  });

  it('judges the repeat window across a system suspend', () => {
    // A monotonic clock does not tick while the machine is asleep, so a
    // re-send right after a resume must not be judged against only the
    // seconds it was awake: the window runs on the larger of the wall
    // and monotonic deltas, the way the hold buffer's age does.
    const wall = stubClock();
    const { admission } = onClock({ wallNow: wall.now });
    expect(admit(admission, 'ping')).toEqual(ADMITTED);
    // Slept past the repeat window; the monotonic clock barely moved.
    wall.advance(PEER_ADMISSION_LIMITS.dedupWindowMs + 1);
    expect(admit(admission, 'ping')).toEqual(ADMITTED);
  });

  it('does not charge a sender for a message it dropped as a repeat', () => {
    const { admission } = onClock({ limits: { bucketCapacity: 2 } });
    expect(admit(admission, 'same')).toEqual(ADMITTED);
    // Ten repeats: if any spent a token there would be nothing left for
    // the different message below.
    for (let index = 0; index < 10; index++) {
      expect(admit(admission, 'same')).toEqual(DUPLICATE);
    }
    expect(admit(admission, 'different')).toEqual(ADMITTED);
  });

  it('exempts a sender from the repeat check without exempting it from the rate', () => {
    const { admission } = onClock({ limits: { bucketCapacity: 3 } });
    const request = {
      senderKey: 'own-process',
      body: 'build finished',
      exemptFromDedup: true,
    };
    for (let index = 0; index < 3; index++) {
      expect(admission.admit(request)).toEqual(ADMITTED);
    }
    expect(admission.admit(request)).toEqual(LIMITED);
  });

  it('stops a flood that rotates its sender key at the global limit', () => {
    const { admission } = onClock();
    const capacity = PEER_ADMISSION_LIMITS.globalBucketCapacity;
    for (let index = 0; index < capacity; index++) {
      expect(admission.admit(rotating(index))).toEqual(ADMITTED);
    }
    expect(admission.admit(rotating(capacity))).toEqual(LIMITED);
    // Rejected before a meter was minted, so the flood cannot fill the
    // sender table either.
    expect(admission.trackedSenderCount()).toBe(capacity);
  });

  it('evicts a refilled meter before one that is still holding a sender back', () => {
    const { clock, admission } = onClock({
      limits: {
        bucketCapacity: 4,
        refillPerSecond: 0.5,
        maxTrackedSenders: 2,
        globalBucketCapacity: 1000,
        globalRefillPerSecond: 1000,
      },
    });
    admitMany(admission, 4, (index) => ({
      senderKey: 'noisy',
      body: `message ${index}`,
    }));
    admit(admission, 'just one', 'quiet');

    // Two seconds on: `quiet` is back to full, `noisy` has one token.
    clock.advance(2000);
    expect(admit(admission, 'hi', 'newcomer')).toEqual(ADMITTED);
    expect(admission.trackedSenderCount()).toBe(2);

    // `noisy` kept its meter: a fresh one would have given it four.
    expect(admit(admission, 'next', 'noisy')).toEqual(ADMITTED);
    expect(admit(admission, 'and next', 'noisy')).toEqual(LIMITED);
  });

  it('refills the global bucket over time', () => {
    // Without this the first 60 messages a long-lived session ever takes
    // would be its last: every later arrival dropped `rate-limited`, with
    // no recovery short of a restart.
    const { clock, admission } = onClock();
    admitMany(admission, PEER_ADMISSION_LIMITS.globalBucketCapacity, rotating);
    expect(admit(admission, 'hello', 'fresh')).toEqual(LIMITED);

    clock.advance(1000 / PEER_ADMISSION_LIMITS.globalRefillPerSecond);
    expect(admit(admission, 'hello', 'fresh')).toEqual(ADMITTED);
    expect(admit(admission, 'hello', 'fresher')).toEqual(LIMITED);
  });

  it('does not charge the global bucket for a message it dropped as a repeat', () => {
    // Otherwise one peer's retry loop starves every other sender.
    const { admission } = onClock({
      limits: { bucketCapacity: 2, globalBucketCapacity: 3 },
    });
    expect(admit(admission, 'same', 'noisy')).toEqual(ADMITTED);
    for (let index = 0; index < 3; index++) {
      expect(admit(admission, 'same', 'noisy')).toEqual(DUPLICATE);
    }
    expect(admit(admission, 'hello', 'quiet')).toEqual(ADMITTED);
  });

  it('keeps the buckets on the monotonic clock alone', () => {
    // The repeat window takes the larger of the two clocks so a suspend
    // cannot freeze it. The buckets must not: a forward wall-clock step —
    // an NTP correction, a VM resuming — would hand a peer that is
    // mid-flood a whole fresh burst.
    const wall = stubClock();
    const { admission } = onClock({ wallNow: wall.now });
    spendBurst(admission);

    const { bucketCapacity, refillPerSecond } = PEER_ADMISSION_LIMITS;
    wall.advance((bucketCapacity / refillPerSecond) * 1000 + 1);
    expect(admit(admission, 'after the step')).toEqual(LIMITED);
  });

  describe('forgetBody', () => {
    it('restores the record the failed message displaced', () => {
      // Clearing instead would drop the protection of the body admitted
      // before it — which may already be in the far model's queue.
      const { admission } = onClock();
      admit(admission, 'X');
      admit(admission, 'Y');
      admission.forgetBody('peer', 'Y');

      expect(admit(admission, 'Y')).toEqual(ADMITTED);
      admission.forgetBody('peer', 'Y');
      expect(admit(admission, 'X')).toEqual(DUPLICATE);
    });

    it('leaves a record a later message owns', () => {
      const { admission } = onClock();
      admit(admission, 'X');
      admit(admission, 'Y');
      admission.forgetBody('peer', 'X');
      expect(admit(admission, 'Y')).toEqual(DUPLICATE);
    });

    it('removes multiple undelivered admissions in arrival order', () => {
      const { admission } = onClock();
      admit(admission, 'A', 'peer', 'a');
      admit(admission, 'B', 'peer', 'b');
      admission.forgetBody('peer', 'A', 'a');
      admission.forgetBody('peer', 'B', 'b');
      expect(admit(admission, 'A')).toEqual(ADMITTED);
    });

    it('removes every record owned by a re-used message id', () => {
      const admission = new PeerAdmission();
      admit(admission, 'X', 'peer', 'a');
      admit(admission, 'Y', 'peer', 'b');
      admit(admission, 'X', 'peer', 'a');
      admission.forgetBody('peer', 'X', 'a');
      admission.forgetBody('peer', 'Y', 'b');
      expect(admit(admission, 'X')).toEqual(ADMITTED);
    });

    it('does not remove a later delivered copy with the same body', () => {
      const clock = stubClock();
      const admission = new PeerAdmission({
        now: clock.now,
        wallNow: clock.now,
      });
      admit(admission, 'X', 'peer', 'parked');
      clock.advance(PEER_ADMISSION_LIMITS.dedupWindowMs + 1000);
      admit(admission, 'X', 'peer', 'delivered');
      admission.forgetBody('peer', 'X', 'parked');

      clock.advance(500);
      expect(admit(admission, 'X')).toEqual(DUPLICATE);
    });

    it('leaves the bucket alone', () => {
      const { admission } = onClock({ limits: { bucketCapacity: 1 } });
      admit(admission, 'X');
      admission.forgetBody('peer', 'X');
      expect(admit(admission, 'Z')).toEqual(LIMITED);
    });

    it('is a no-op for a sender it never metered', () => {
      const admission = new PeerAdmission();
      expect(() => admission.forgetBody('nobody', 'X')).not.toThrow();
    });
  });

  it('never tracks more senders than the cap', () => {
    const { admission } = onClock({
      limits: {
        maxTrackedSenders: 8,
        globalBucketCapacity: 1000,
        globalRefillPerSecond: 1000,
      },
    });
    admitMany(admission, 200, rotating);
    expect(admission.trackedSenderCount()).toBe(8);
  });
});
