/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonTranscriptStore } from '@qwen-code/sdk/daemon';
import { schedulePassiveAssistantDone } from './timing.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('schedulePassiveAssistantDone', () => {
  it('settles prompt status after a Goal status closes the assistant block', () => {
    vi.useFakeTimers();
    const store = createDaemonTranscriptStore();
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = {
      current: undefined,
    };
    const onDone = vi.fn();

    store.dispatch({ type: 'assistant.text.delta', text: 'TEST2' });
    schedulePassiveAssistantDone(
      store,
      timerRef,
      'passive_observer',
      3_000,
      onDone,
    );
    store.dispatch({
      type: 'status',
      source: 'goal',
      text: '',
      data: {
        kind: 'aborted',
        condition: 'reply TEST2 until QQQ',
      },
    });

    expect(store.getSnapshot().activeAssistantBlockId).toBeUndefined();
    vi.advanceTimersByTime(3_000);

    expect(onDone).toHaveBeenCalledOnce();
  });
});
