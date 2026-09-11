import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_COMPLETED_OUTPUT_TOMBSTONES,
  OutputPlaybackTracker,
  scheduleOutputFrame,
} from '../../preload/audio-output-queue.ts';

describe('Live Host output queue', () => {
  it('schedules frames while the resulting queue stays below ten seconds', () => {
    assert.deepEqual(scheduleOutputFrame(4, 13.5, 0.4), {
      startAt: 13.5,
      endAt: 13.9,
    });
  });

  it('keeps scheduling a complete long response', () => {
    assert.deepEqual(scheduleOutputFrame(4, 63, 1), {
      startAt: 63,
      endAt: 64,
    });
  });

  it('uses a small lead when no audio is queued', () => {
    const schedule = scheduleOutputFrame(4, 2, 0.02);
    assert.equal(schedule.startAt, 4.01);
    assert.ok(Math.abs(schedule.endAt - 4.03) < Number.EPSILON * 4.03);
  });

  it('keeps queued audio contiguous even when less than ten milliseconds remain', () => {
    assert.deepEqual(scheduleOutputFrame(0.505, 0.51, 0.5), {
      startAt: 0.51,
      endAt: 1.01,
    });
    assert.deepEqual(scheduleOutputFrame(0.505, 0.51, 0.5, 48_000), {
      startAt: 0.51,
      endAt: 1.01,
    });
  });

  it('uses integer device-frame boundaries without cumulative rounding drift', () => {
    for (const rate of [16_000, 44_100, 48_000, 96_000]) {
      let cursor = 0;
      for (let index = 0; index < 10_000; index += 1) {
        const schedule = scheduleOutputFrame(0, cursor, 131 / rate, rate);
        if (index > 0) assert.equal(schedule.startAt, cursor);
        cursor = schedule.endAt;
      }
      assert.equal(cursor, (Math.ceil(0.01 * rate) + 1_310_000) / rate);
    }
  });

  it('waits for a marker across a temporary source gap', () => {
    const tracker = new OutputPlaybackTracker();
    tracker.setEndMarkerRequired(true);
    const identity = { epoch: 4, outputId: 11 };

    const first = tracker.beginFrame(identity);
    assert(first);
    assert.equal(first.playbackStarted, true);
    assert.deepEqual(tracker.endFrame(first.output), { accepted: true });

    const second = tracker.beginFrame(identity);
    assert(second);
    assert.equal(second.playbackStarted, false);
    assert.deepEqual(tracker.finish(identity), { accepted: true });
    assert.deepEqual(tracker.endFrame(second.output), {
      accepted: true,
      completed: identity,
    });
    assert.deepEqual(tracker.finish(identity), { accepted: false });
  });

  it('completes immediately when the marker arrives after the drain', () => {
    const tracker = new OutputPlaybackTracker();
    tracker.setEndMarkerRequired(true);
    const identity = { epoch: 4, outputId: 12 };
    const frame = tracker.beginFrame(identity);
    assert(frame);

    assert.deepEqual(tracker.endFrame(frame.output), { accepted: true });
    assert.deepEqual(tracker.finish(identity), {
      accepted: true,
      completed: identity,
    });
  });

  it('tracks consecutive sealed outputs independently', () => {
    const tracker = new OutputPlaybackTracker();
    tracker.setEndMarkerRequired(true);
    const firstIdentity = { epoch: 4, outputId: 13 };
    const secondIdentity = { epoch: 4, outputId: 14 };
    const first = tracker.beginFrame(firstIdentity);
    assert(first);
    assert.deepEqual(tracker.finish(firstIdentity), { accepted: true });
    const second = tracker.beginFrame(secondIdentity);
    assert(second);
    assert.deepEqual(tracker.finish(secondIdentity), { accepted: true });

    assert.deepEqual(tracker.endFrame(first.output), {
      accepted: true,
      completed: firstIdentity,
    });
    assert.deepEqual(tracker.endFrame(second.output), {
      accepted: true,
      completed: secondIdentity,
    });
  });

  it('bounds completed tombstones while rejecting recent late traffic', () => {
    const tracker = new OutputPlaybackTracker();
    tracker.setEndMarkerRequired(true);
    for (
      let outputId = 1;
      outputId <= MAX_COMPLETED_OUTPUT_TOMBSTONES + 1;
      outputId += 1
    ) {
      const identity = { epoch: 8, outputId };
      const frame = tracker.beginFrame(identity);
      assert(frame);
      assert.deepEqual(tracker.finish(identity), { accepted: true });
      assert.deepEqual(tracker.endFrame(frame.output), {
        accepted: true,
        completed: identity,
      });
    }

    const recent = {
      epoch: 8,
      outputId: MAX_COMPLETED_OUTPUT_TOMBSTONES + 1,
    };
    assert.equal(tracker.beginFrame(recent), undefined);
    assert.deepEqual(tracker.finish(recent), { accepted: false });

    const evicted = tracker.beginFrame({ epoch: 8, outputId: 1 });
    assert(evicted);
    assert.equal(evicted.playbackStarted, true);
  });

  it('invalidates stale source endings on clear and preserves legacy drain', () => {
    const tracker = new OutputPlaybackTracker();
    tracker.setEndMarkerRequired(true);
    const staleIdentity = { epoch: 4, outputId: 15 };
    const stale = tracker.beginFrame(staleIdentity);
    assert(stale);
    tracker.clear();
    assert.deepEqual(tracker.endFrame(stale.output), { accepted: false });
    assert.deepEqual(tracker.finish(staleIdentity), { accepted: false });

    tracker.setEndMarkerRequired(false);
    const legacyIdentity = { epoch: 5, outputId: 1 };
    const legacy = tracker.beginFrame(legacyIdentity);
    assert(legacy);
    assert.deepEqual(tracker.endFrame(legacy.output), {
      accepted: true,
      completed: legacyIdentity,
    });
  });
});
