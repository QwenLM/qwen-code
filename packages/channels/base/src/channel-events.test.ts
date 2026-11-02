/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChannelEvent,
  channelEventFilePath,
  channelEventScopeDir,
  normalizeChannelEventRecord,
  readChannelEvents,
} from './channel-events.js';

let qwenHome: string;
let cwd: string;

beforeEach(() => {
  qwenHome = mkdtempSync(join(tmpdir(), 'channel-events-'));
  cwd = join(qwenHome, 'workspace');
  vi.stubEnv('QWEN_HOME', qwenHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(qwenHome, { recursive: true, force: true });
});

function append(
  index: number,
  channel = 'bot',
  type: 'inbound' | 'poll' = 'inbound',
) {
  appendChannelEvent(channel, cwd, {
    at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    type,
    outcome: type === 'poll' ? 'ok' : 'skipped',
    reason: 'reason_filter',
    repository: 'owner/repo',
    thread: 'pr:7',
    number: 7,
    actor: 'alice',
  });
}

describe('channel events journal', () => {
  it('appends and reads back the newest records', () => {
    for (let index = 0; index < 5; index += 1) append(index);

    const { events, truncated } = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });

    expect(truncated).toBe(false);
    expect(events).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({
      channel: 'bot',
      type: 'inbound',
      outcome: 'skipped',
      reason: 'reason_filter',
      repository: 'owner/repo',
      thread: 'pr:7',
      number: 7,
      actor: 'alice',
    });
  });

  it('filters by channel and type and reports truncation', () => {
    append(1, 'bot');
    append(2, 'other');
    append(3, 'bot', 'poll');
    append(4, 'bot');

    const byChannel = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      channels: ['bot'],
    });
    expect(byChannel.events).toHaveLength(3);

    const byType = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      types: ['poll'],
    });
    expect(byType.events).toHaveLength(1);
    expect(byType.events[0]?.outcome).toBe('ok');

    const limited = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 2,
    });
    expect(limited.events).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('honours since by timestamp', () => {
    append(1);
    append(5);
    const cutoff = new Date(2026, 0, 1, 0, 0, 3).getTime();
    const { events } = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      since: cutoff,
    });
    expect(events).toHaveLength(1);
  });

  it('keeps journals of different channels and workspaces apart', () => {
    append(1, 'bot');
    append(2, 'other');
    const otherCwd = join(qwenHome, 'other-workspace');
    appendChannelEvent('bot', otherCwd, {
      type: 'poll',
      outcome: 'ok',
    });

    expect(channelEventFilePath('bot', cwd)).not.toBe(
      channelEventFilePath('bot', otherCwd),
    );
    expect(
      readChannelEvents({ scopeDirs: [channelEventScopeDir(cwd)] }).events,
    ).toHaveLength(2);
    expect(
      readChannelEvents({ scopeDirs: [channelEventScopeDir(otherCwd)] }).events,
    ).toHaveLength(1);
  });

  it('never writes outside its own scope directory for a hostile name', () => {
    const path = channelEventFilePath('../../etc/passwd', cwd);
    expect(path.startsWith(channelEventScopeDir(cwd))).toBe(true);
    expect(path.includes('..')).toBe(false);
  });

  it('keeps the journal readable and writable only by its account', () => {
    append(1);
    const path = channelEventFilePath('bot', cwd);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
  });

  it('bounds how many channel files one read opens', () => {
    for (let index = 0; index < 40; index += 1) {
      appendChannelEvent(`bot-${index}`, cwd, {
        at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
        type: 'poll',
        outcome: 'ok',
      });
    }

    const { events } = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 500,
    });

    expect(events.length).toBeLessThanOrEqual(32);
  });

  it('rotates once the journal reaches its size cap', () => {
    const path = channelEventFilePath('bot', cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${'x'.repeat(1024 * 1024)}\n`);
    appendChannelEvent('bot', cwd, { type: 'poll', outcome: 'ok' });

    expect(statSync(`${path}.1`).size).toBeGreaterThan(1024 * 1024);
    const { events } = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });
    expect(events).toHaveLength(1);
    expect(readFileSync(`${path}.1`, 'utf-8')).not.toContain('"type":"poll"');
  });

  it('drops corrupt lines instead of failing the whole read', () => {
    append(1);
    const path = channelEventFilePath('bot', cwd);
    writeFileSync(
      path,
      `${readFileSync(path, 'utf-8')}not json\n{"type":"poll"}\n`,
    );

    const { events } = readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });
    expect(events).toHaveLength(1);
  });

  it('swallows a write failure into one stderr line', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    // A file where the scope directory belongs makes mkdir fail.
    mkdirSync(dirname(channelEventScopeDir(cwd)), { recursive: true });
    writeFileSync(channelEventScopeDir(cwd), 'blocked');

    expect(() =>
      appendChannelEvent('bot', cwd, { type: 'poll', outcome: 'ok' }),
    ).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('channel event write failed'),
    );
    stderr.mockRestore();
  });

  it('rejects records missing required fields or carrying unknown types', () => {
    expect(normalizeChannelEventRecord({})).toBeUndefined();
    expect(
      normalizeChannelEventRecord({
        at: new Date().toISOString(),
        channel: 'bot',
        type: 'unknown',
        outcome: 'ok',
      }),
    ).toBeUndefined();
    expect(
      normalizeChannelEventRecord({
        at: new Date().toISOString(),
        channel: 'bot',
        type: 'poll',
        outcome: 'ok',
        detail: { notifications: 3, extra: { nested: true } },
      }),
    ).toMatchObject({ detail: { notifications: 3 } });
  });
});
