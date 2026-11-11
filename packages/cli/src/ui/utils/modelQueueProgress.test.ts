/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { modelQueueFromStatusEvent } from './modelQueueProgress.js';

describe('modelQueueFromStatusEvent', () => {
  it('keeps one baseline queue count and advances progress as queue count drops', () => {
    const first = modelQueueFromStatusEvent({
      status: 'queued',
      request_set_id: 'set-1',
      queue_count: 2000,
      wait_time_ms: 90_000,
      queue_wait_elapsed_ms: 10_000,
      queue_max_wait_ms: 3_600_000,
    });
    const second = modelQueueFromStatusEvent(
      {
        status: 'queued',
        request_set_id: 'set-1',
        queue_count: 1000,
        wait_time_ms: 45_000,
      },
      first,
    );

    expect(first.initialQueueCount).toBe(2000);
    expect(first.progress).toBe(3);
    expect(first.waitElapsedMs).toBe(10_000);
    expect(first.maxWaitMs).toBe(3_600_000);
    expect(second.initialQueueCount).toBe(2000);
    expect(second.progress).toBe(48);
  });

  it('marks ready events as complete', () => {
    const ready = modelQueueFromStatusEvent(
      {
        status: 'ready',
        request_set_id: 'set-1',
        model_key: 'qmodel',
      },
      {
        status: 'queued',
        requestSetId: 'set-1',
        modelKey: 'qmodel',
        queueCount: 10,
        initialQueueCount: 20,
        progress: 50,
      },
    );

    expect(ready.status).toBe('ready');
    expect(ready.progress).toBe(100);
    expect(ready.modelKey).toBe('qmodel');
  });

  it('uses wait budget for progress when queue count is unavailable', () => {
    const first = modelQueueFromStatusEvent({
      status: 'queued',
      request_set_id: 'set-1',
      wait_time_ms: 10_000,
      queue_wait_elapsed_ms: 720_000,
      queue_max_wait_ms: 3_600_000,
    });
    const second = modelQueueFromStatusEvent(
      {
        status: 'queued',
        request_set_id: 'set-1',
        wait_time_ms: 8_000,
        queue_wait_elapsed_ms: 1_200_000,
        queue_max_wait_ms: 3_600_000,
      },
      first,
    );

    expect(first.progress).toBe(19);
    expect(first.waitElapsedMs).toBe(720_000);
    expect(first.maxWaitMs).toBe(3_600_000);
    expect(second.progress).toBe(32);
  });

  it('falls back to small progress steps without queue count or wait budget', () => {
    const first = modelQueueFromStatusEvent({
      status: 'queued',
      request_set_id: 'set-1',
      wait_time_ms: 10_000,
    });
    const second = modelQueueFromStatusEvent(
      {
        status: 'queued',
        request_set_id: 'set-1',
        wait_time_ms: 8_000,
      },
      first,
    );

    expect(first.progress).toBe(4);
    expect(second.progress).toBe(8);
  });

  it('keeps progress stable when request set id is omitted', () => {
    const first = modelQueueFromStatusEvent({
      status: 'queued',
      queue_count: 2000,
    });
    const second = modelQueueFromStatusEvent(
      {
        status: 'queued',
        queue_count: 1000,
      },
      first,
    );

    expect(second.initialQueueCount).toBe(2000);
    expect(second.progress).toBe(48);
  });

  it('resets progress when request id changes without a request set id', () => {
    const first = modelQueueFromStatusEvent({
      status: 'queued',
      request_id: 'request-1',
      queue_count: 2000,
    });
    const second = modelQueueFromStatusEvent(
      {
        status: 'queued',
        request_id: 'request-2',
        queue_count: 1000,
      },
      first,
    );

    expect(second.initialQueueCount).toBe(1000);
    expect(second.progress).toBe(3);
  });

  it('does not jump to near-complete for an initial queued zero count', () => {
    const first = modelQueueFromStatusEvent({
      status: 'queued',
      request_set_id: 'set-1',
      queue_count: 0,
    });

    expect(first.initialQueueCount).toBeUndefined();
    expect(first.progress).toBe(4);
  });

  it('does not reuse ready progress for a later queued update', () => {
    const queued = modelQueueFromStatusEvent(
      {
        status: 'queued',
        request_set_id: 'set-1',
        queue_count: 50,
      },
      {
        status: 'ready',
        requestSetId: 'set-1',
        modelKey: 'qmodel',
        progress: 100,
      },
    );

    expect(queued.status).toBe('queued');
    expect(queued.initialQueueCount).toBe(50);
    expect(queued.progress).toBe(3);
  });
});
