/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createChannelRestoreFailures } from './channel-restore-failures.js';

const AT = new Date('2026-09-23T08:00:00.000Z');

describe('createChannelRestoreFailures', () => {
  it('records failures per workspace and channel, stamped when recorded', () => {
    const failures = createChannelRestoreFailures(() => AT);
    failures.record([
      {
        workspaceCwd: '/ws/a',
        channel: 'bot',
        source: 'late',
        code: 'connect_timeout',
        message: 'timed out',
      },
      { workspaceCwd: '/ws/b', channel: 'bot', source: 'boot', message: 'no' },
    ]);

    expect(failures.get('/ws/a', 'bot')).toEqual({
      workspaceCwd: '/ws/a',
      channel: 'bot',
      source: 'late',
      code: 'connect_timeout',
      message: 'timed out',
      at: AT.toISOString(),
    });
    expect(failures.get('/ws/b', 'bot')).not.toHaveProperty('code');
    expect(failures.list()).toHaveLength(2);
  });

  it('replaces an earlier failure of the same channel', () => {
    const failures = createChannelRestoreFailures(() => AT);
    failures.record([
      { workspaceCwd: '/ws/a', channel: 'bot', source: 'boot', message: 'one' },
    ]);
    failures.record([
      { workspaceCwd: '/ws/a', channel: 'bot', source: 'late', message: 'two' },
    ]);

    expect(failures.list()).toEqual([
      expect.objectContaining({ source: 'late', message: 'two' }),
    ]);
  });

  it('redacts credentials and bounds the text it will serve', () => {
    const failures = createChannelRestoreFailures(() => AT);
    failures.record([
      {
        workspaceCwd: '/ws/a',
        channel: 'bot',
        source: 'late',
        message: `rejected Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 \u001b[31m${'x'.repeat(2000)}`,
      },
    ]);

    const message = failures.get('/ws/a', 'bot')!.message;
    expect(message).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(message).not.toContain('\u001b');
    expect(message.length).toBeLessThanOrEqual(512);
  });

  it('clears one channel, one workspace, or everything', () => {
    const failures = createChannelRestoreFailures(() => AT);
    const seed = () =>
      failures.record([
        { workspaceCwd: '/ws/a', channel: 'x', source: 'late', message: 'm' },
        { workspaceCwd: '/ws/a', channel: 'y', source: 'late', message: 'm' },
        { workspaceCwd: '/ws/b', channel: 'x', source: 'late', message: 'm' },
      ]);

    seed();
    failures.clear('/ws/a', 'x');
    expect(
      failures.list().map((f) => `${f.workspaceCwd}:${f.channel}`),
    ).toEqual(['/ws/a:y', '/ws/b:x']);

    failures.clearWorkspace('/ws/a');
    expect(
      failures.list().map((f) => `${f.workspaceCwd}:${f.channel}`),
    ).toEqual(['/ws/b:x']);

    seed();
    failures.clearAll();
    expect(failures.list()).toEqual([]);
  });
});
