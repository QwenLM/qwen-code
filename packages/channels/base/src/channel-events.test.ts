/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
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

describe('channel events journal', async () => {
  it('appends and reads back the newest records', async () => {
    for (let index = 0; index < 5; index += 1) append(index);

    const { events, truncated } = await readChannelEvents({
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

  it('filters by channel and type and reports truncation', async () => {
    append(1, 'bot');
    append(2, 'other');
    append(3, 'bot', 'poll');
    append(4, 'bot');

    const byChannel = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      channels: ['bot'],
    });
    expect(byChannel.events).toHaveLength(3);

    const byType = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      types: ['poll'],
    });
    expect(byType.events).toHaveLength(1);
    expect(byType.events[0]?.outcome).toBe('ok');

    const limited = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 2,
    });
    expect(limited.events).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('honours since by timestamp', async () => {
    append(1);
    append(5);
    const cutoff = new Date(2026, 0, 1, 0, 0, 3).getTime();
    const { events } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      since: cutoff,
    });
    expect(events).toHaveLength(1);
  });

  it('keeps journals of different channels and workspaces apart', async () => {
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
      (await readChannelEvents({ scopeDirs: [channelEventScopeDir(cwd)] }))
        .events,
    ).toHaveLength(2);
    expect(
      (await readChannelEvents({ scopeDirs: [channelEventScopeDir(otherCwd)] }))
        .events,
    ).toHaveLength(1);
  });

  it('never writes outside its own scope directory for a hostile name', async () => {
    const path = channelEventFilePath('../../etc/passwd', cwd);
    expect(path.startsWith(channelEventScopeDir(cwd))).toBe(true);
    expect(path.includes('..')).toBe(false);
  });

  it('keeps the journal readable and writable only by its account', async () => {
    append(1);
    const path = channelEventFilePath('bot', cwd);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
  });

  it('bounds how many channel files one read opens', async () => {
    for (let index = 0; index < 40; index += 1) {
      appendChannelEvent(`bot-${index}`, cwd, {
        at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
        type: 'poll',
        outcome: 'ok',
      });
    }

    const { events, truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 500,
    });

    expect(events.length).toBeLessThanOrEqual(32);
    // Dropping whole Channels is incomplete data, so the completeness flag
    // must say so even when the returned rows fit the limit.
    expect(truncated).toBe(true);
  });

  it('reads events that only survive in the rotated file', async () => {
    const path = channelEventFilePath('rotated', cwd);
    mkdirSync(dirname(path), { recursive: true });
    const older = JSON.stringify({
      at: new Date(2026, 0, 1, 0, 0, 1).toISOString(),
      channel: 'rotated',
      type: 'inbound',
      outcome: 'skipped',
      reason: 'reason_filter',
    });
    writeFileSync(`${path}.1`, `${older}\n`);
    appendChannelEvent('rotated', cwd, {
      at: new Date(2026, 0, 2, 0, 0, 1).toISOString(),
      type: 'poll',
      outcome: 'ok',
    });

    const { events } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });

    expect(events.map((event) => event.type)).toEqual(['inbound', 'poll']);
  });

  it('clamps a limit above the maximum instead of returning everything', async () => {
    const path = channelEventFilePath('many', cwd);
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      at: new Date(2026, 0, 1).toISOString(),
      channel: 'many',
      type: 'poll',
      outcome: 'ok',
    });
    writeFileSync(path, `${`${line}\n`.repeat(501)}`);

    const { events, truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 100000,
    });

    expect(events).toHaveLength(500);
    expect(truncated).toBe(true);
  });

  it('reports truncation when the byte budget stops the read', async () => {
    const line = JSON.stringify({
      at: new Date(2026, 0, 1).toISOString(),
      channel: 'bulk',
      type: 'poll',
      outcome: 'ok',
      detail: { pad: 'x'.repeat(120) },
    });
    const block = `${line}\n`.repeat(
      Math.ceil((1024 * 1024) / (line.length + 1)),
    );
    for (let index = 0; index < 6; index += 1) {
      const path = channelEventFilePath(`bulk-${index}`, cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, block);
    }

    const { truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 500,
    });

    expect(truncated).toBe(true);
  });

  it('lets other timers run while a large journal is read', async () => {
    const line = JSON.stringify({
      at: new Date(2026, 0, 1).toISOString(),
      channel: 'bulk',
      type: 'poll',
      outcome: 'ok',
      detail: { pad: 'x'.repeat(120) },
    });
    const block = `${line}\n`.repeat(
      Math.ceil((1024 * 1024) / (line.length + 1)),
    );
    for (let index = 0; index < 4; index += 1) {
      const path = channelEventFilePath(`yield-${index}`, cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, block);
    }

    // The daemon serves sessions on this same loop: a synchronous scan would
    // starve every bystander timer for the whole read.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await readChannelEvents({
        scopeDirs: [channelEventScopeDir(cwd)],
        limit: 500,
      });
    } finally {
      clearInterval(timer);
    }

    expect(ticks).toBeGreaterThan(0);
  });

  it('fails loudly when the journal directory cannot be read', async () => {
    append(1);
    const dir = channelEventScopeDir(cwd);
    chmodSync(dir, 0o000);
    try {
      await expect(readChannelEvents({ scopeDirs: [dir] })).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('keeps an explicitly requested Channel reachable past the file cap', async () => {
    appendChannelEvent('requested', cwd, {
      at: new Date(2026, 0, 1, 0, 0, 0).toISOString(),
      type: 'poll',
      outcome: 'ok',
    });
    for (let index = 0; index < 32; index += 1) {
      appendChannelEvent(`peer-${index}`, cwd, {
        at: new Date(2026, 0, 2, 0, 0, index).toISOString(),
        type: 'poll',
        outcome: 'ok',
      });
    }

    const { events } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      channels: ['requested'],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.channel).toBe('requested');
  });

  it('preserves a full legal Channel name for display and filtering', async () => {
    const longName = 'c'.repeat(100);
    appendChannelEvent(longName, cwd, { type: 'poll', outcome: 'ok' });

    const all = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });
    expect(all.events[0]?.channel).toBe(longName);

    const filtered = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      channels: [longName],
    });
    expect(filtered.events).toHaveLength(1);
  });

  it('keeps names that share a long prefix distinguishable', async () => {
    const prefix = 'd'.repeat(90);
    appendChannelEvent(`${prefix}-alpha`, cwd, { type: 'poll', outcome: 'ok' });
    appendChannelEvent(`${prefix}-beta`, cwd, { type: 'poll', outcome: 'ok' });

    const { events } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      channels: [`${prefix}-alpha`],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.channel).toBe(`${prefix}-alpha`);
  });

  it('rotates once the journal reaches its size cap', async () => {
    const path = channelEventFilePath('bot', cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${'x'.repeat(1024 * 1024)}\n`);
    appendChannelEvent('bot', cwd, { type: 'poll', outcome: 'ok' });

    expect(statSync(`${path}.1`).size).toBeGreaterThan(1024 * 1024);
    const { events } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });
    expect(events).toHaveLength(1);
    expect(readFileSync(`${path}.1`, 'utf-8')).not.toContain('"type":"poll"');
  });

  it('drops corrupt lines instead of failing the whole read', async () => {
    append(1);
    const path = channelEventFilePath('bot', cwd);
    writeFileSync(
      path,
      `${readFileSync(path, 'utf-8')}not json\n{"type":"poll"}\n`,
    );

    const { events } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });
    expect(events).toHaveLength(1);
  });

  it('swallows a write failure into one stderr line', async () => {
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

  it('rejects records missing required fields or carrying unknown types', async () => {
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
