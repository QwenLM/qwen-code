/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createChannelRestoreFailures,
  type ChannelRestoreFailure,
} from './channel-restore-failures.js';

const key = (failure: ChannelRestoreFailure) =>
  `${failure.workspaceCwd}:${failure.channel}`;

describe('createChannelRestoreFailures', () => {
  it('records failures per workspace and channel', () => {
    const failures = createChannelRestoreFailures();
    failures.record([
      { workspaceCwd: '/ws/a', channel: 'bot', message: 'timed out' },
      { workspaceCwd: '/ws/b', channel: 'bot', message: 'no' },
    ]);

    expect(failures.get('/ws/a', 'bot')).toEqual({
      workspaceCwd: '/ws/a',
      channel: 'bot',
      message: 'timed out',
    });
    expect(failures.list().map(key)).toEqual(['/ws/a:bot', '/ws/b:bot']);
  });

  it('replaces an earlier failure of the same channel', () => {
    const failures = createChannelRestoreFailures();
    failures.record([
      { workspaceCwd: '/ws/a', channel: 'bot', message: 'one' },
    ]);
    failures.record([
      { workspaceCwd: '/ws/a', channel: 'bot', message: 'two' },
    ]);

    expect(failures.list()).toEqual([
      expect.objectContaining({ message: 'two' }),
    ]);
  });

  it('redacts credentials and bounds the text it will serve', () => {
    const failures = createChannelRestoreFailures();
    failures.record([
      {
        workspaceCwd: '/ws/a',
        channel: 'bot',
        message: `rejected Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 \u001b[31m${'x'.repeat(2000)}`,
      },
    ]);

    const message = failures.get('/ws/a', 'bot')!.message;
    expect(message).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(message).not.toContain('\u001b');
    expect(message.length).toBeLessThanOrEqual(512);
  });

  it('hides a record that went stale, on both read paths, and prunes it', () => {
    const stale = new Set<string>();
    const failures = createChannelRestoreFailures({
      isStale: (failure) => stale.has(key(failure)),
    });
    failures.record([
      { workspaceCwd: '/ws/a', channel: 'x', message: 'm' },
      { workspaceCwd: '/ws/a', channel: 'y', message: 'm' },
      { workspaceCwd: '/ws/b', channel: 'x', message: 'm' },
    ]);

    stale.add('/ws/a:x');
    expect(failures.get('/ws/a', 'x')).toBeUndefined();
    expect(failures.list().map(key)).toEqual(['/ws/a:y', '/ws/b:x']);

    // Dropped, not merely filtered out of one answer: a record that stopped
    // standing must not come back if the predicate changes its mind, and must
    // not sit in memory for the rest of the daemon's life.
    stale.clear();
    expect(failures.get('/ws/a', 'x')).toBeUndefined();
    expect(failures.list().map(key)).toEqual(['/ws/a:y', '/ws/b:x']);
  });

  it('clears one channel or everything', () => {
    const failures = createChannelRestoreFailures();
    failures.record([
      { workspaceCwd: '/ws/a', channel: 'x', message: 'm' },
      { workspaceCwd: '/ws/a', channel: 'y', message: 'm' },
      { workspaceCwd: '/ws/b', channel: 'x', message: 'm' },
    ]);

    failures.clear('/ws/a', 'x');
    expect(failures.list().map(key)).toEqual(['/ws/a:y', '/ws/b:x']);

    failures.clearAll();
    expect(failures.list()).toEqual([]);
  });
});
