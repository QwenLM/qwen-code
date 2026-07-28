import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIO_OUTPUT_BACKPRESSURE,
  scheduleOutputFrame,
} from '../../preload/audio-output-queue.ts';

describe('Live Host output queue', () => {
  it(
    'schedules frames while the resulting queue stays below ten seconds',
    () => {
      assert.deepEqual(scheduleOutputFrame(4, 13.5, 0.4), {
        startAt: 13.5,
        endAt: 13.9,
      });
    },
  );

  it('fails closed before accepting a frame that reaches ten seconds', () => {
    assert.throws(
      () => scheduleOutputFrame(4, 13, 1),
      new RegExp(AUDIO_OUTPUT_BACKPRESSURE, 'u'),
    );
  });

  it('uses a small lead when no audio is queued', () => {
    const schedule = scheduleOutputFrame(4, 2, 0.02);
    assert.equal(schedule.startAt, 4.01);
    assert.ok(Math.abs(schedule.endAt - 4.03) < Number.EPSILON * 4.03);
  });
});
