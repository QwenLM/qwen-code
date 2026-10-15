/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { logs } from '@opentelemetry/api-logs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitSessionEnd, emitSessionStart } from './session-events.js';

describe('session lifecycle events', () => {
  const emit = vi.fn();

  beforeEach(() => {
    emit.mockReset();
    vi.spyOn(logs, 'getLogger').mockReturnValue({ emit } as never);
  });

  it('emits the required attributes for session.start', () => {
    emitSessionStart('session-2', 'session-1');

    expect(emit).toHaveBeenCalledWith({
      body: 'Session started.',
      attributes: {
        'event.name': 'session.start',
        'event.timestamp': expect.any(String),
        'session.id': 'session-2',
        'session.previous_id': 'session-1',
      },
    });
  });

  it('does not claim continuation for a replacement session', () => {
    emitSessionStart('replacement-session');

    expect(emit).toHaveBeenCalledWith({
      body: 'Session started.',
      attributes: {
        'event.name': 'session.start',
        'event.timestamp': expect.any(String),
        'session.id': 'replacement-session',
      },
    });
  });

  it('does not emit session.start twice for the same session', () => {
    emitSessionStart('duplicate-session');
    emitSessionStart('duplicate-session');

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits session.start again for an id that was ended', () => {
    emitSessionStart('session-a');
    emitSessionEnd('session-a');
    emitSessionStart('session-a', 'session-b');

    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('emits the required attributes for session.end', () => {
    emitSessionEnd('session-1');

    expect(emit).toHaveBeenCalledWith({
      body: 'Session ended.',
      attributes: {
        'event.name': 'session.end',
        'event.timestamp': expect.any(String),
        'session.id': 'session-1',
      },
    });
  });
});
