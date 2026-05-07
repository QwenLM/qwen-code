/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EventLog } from './EventLog.js';

describe('EventLog', () => {
  it('assigns monotonic sequence numbers and replays from a cursor', () => {
    const log = new EventLog();
    const first = log.append('session-1', 'event/append', { text: 'one' });
    const second = log.append('session-1', 'event/append', { text: 'two' });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(log.replay(1).events).toEqual([second]);
    expect(log.getLastSeq()).toBe(2);
  });

  it('reports truncation when the requested cursor is older than the ring buffer', () => {
    const log = new EventLog(2);
    log.append('session-1', 'event/append', { text: 'one' });
    log.append('session-1', 'event/append', { text: 'two' });
    log.append('session-1', 'event/append', { text: 'three' });

    const replay = log.replay(0);
    expect(replay.truncated).toBe(true);
    expect(replay.events.map((event) => event.seq)).toEqual([2, 3]);
  });
});
