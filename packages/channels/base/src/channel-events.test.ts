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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
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

  it('round-trips the session identity and its owner workspace', async () => {
    appendChannelEvent('bot', cwd, {
      type: 'task',
      outcome: 'running',
      sessionId: 'session-1',
      sessionWorkspaceCwd: '/work/other',
    });

    const { events } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 'session-1',
      sessionWorkspaceCwd: '/work/other',
    });
  });

  it('drops a non-string session owner workspace', async () => {
    const record = normalizeChannelEventRecord({
      at: new Date().toISOString(),
      channel: 'bot',
      type: 'task',
      outcome: 'running',
      sessionId: 'session-1',
      sessionWorkspaceCwd: 42,
    });
    expect(record).toMatchObject({ sessionId: 'session-1' });
    expect(record).not.toHaveProperty('sessionWorkspaceCwd');
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

  it('trims the accumulator without changing which events come back', async () => {
    // Four journals whose records interleave in time and share instants, read
    // freshest-first: a trim that kept the last-written rows instead of the
    // newest ones, or that disturbed the order of equal instants, would differ
    // from the same read with a limit large enough never to trim.
    for (let index = 0; index < 10; index += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        append(index, `chan-${channel}`);
      }
    }
    const scopeDirs = [channelEventScopeDir(cwd)];

    const whole = await readChannelEvents({ scopeDirs, limit: 500 });
    expect(whole.events).toHaveLength(40);
    expect(whole.truncated).toBe(false);

    const trimmed = await readChannelEvents({ scopeDirs, limit: 3 });
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.events).toEqual(whole.events.slice(-3));
  });

  it('reports truncation when trimming leaves exactly the limit', async () => {
    // 21 records with limit 5: the accumulator passes 4 x 5 and is trimmed to
    // 5, so the final count alone cannot reveal that older events were dropped.
    for (let index = 0; index < 21; index += 1) append(index);

    const { events, truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 5,
    });

    expect(events).toHaveLength(5);
    expect(truncated).toBe(true);
    expect(events[0]?.at).toBe(new Date(2026, 0, 1, 0, 0, 16).toISOString());
    expect(events.at(-1)?.at).toBe(
      new Date(2026, 0, 1, 0, 0, 20).toISOString(),
    );
  });

  it('reports truncation when a single journal is taller than the tail window', async () => {
    // ~1 KiB per record: a 1 MiB journal holds ~1000 records, but the 256 KiB
    // tail window only reaches the newest ~250 — fewer than the 500 limit, so
    // only the skipped head can explain a truncated result.
    const line = JSON.stringify({
      at: new Date(2026, 0, 1).toISOString(),
      channel: 'tall',
      type: 'poll',
      outcome: 'ok',
      detail: { pad: 'x'.repeat(900) },
    });
    const path = channelEventFilePath('tall', cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${line}\n`.repeat(1020));

    const { events, truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 500,
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(500);
    expect(truncated).toBe(true);
  });

  it('reports truncation when the byte budget stops the read', async () => {
    // 20 journals of 24 records each: every file fits one whole 256 KiB tail
    // window (so no per-file clipping), together they exceed the 4 MiB request
    // budget, and all 480 records together stay under the 500 record limit —
    // the budget is the only possible reason for a truncated result.
    const line = JSON.stringify({
      at: new Date(2026, 0, 1).toISOString(),
      channel: 'bulk',
      type: 'poll',
      outcome: 'ok',
      detail: { pad: 'x'.repeat(10700) },
    });
    const block = `${line}\n`.repeat(24);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(256 * 1024);
    for (let index = 0; index < 20; index += 1) {
      const path = channelEventFilePath(`bulk-${index}`, cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, block);
    }

    const { events, truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 500,
    });

    expect(truncated).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(480);
  });

  it('reads a small journal that fits the budget left over', async () => {
    // 17 journals of exactly 240 KiB plus one tiny journal, together under the
    // 4 MiB budget. The tiny one is the oldest, so it is read last, when less
    // than one 256 KiB window remains — it must still be read, because the
    // 16 KiB remainder covers its 200 bytes eighty times over.
    const at = new Date(2026, 0, 1).toISOString();
    const sized = (channel: string, sizeBytes: number): string => {
      const shape = { at, channel, type: 'poll', outcome: 'ok' };
      const base = JSON.stringify({ ...shape, detail: { pad: '' } });
      const line = JSON.stringify({
        ...shape,
        detail: { pad: 'x'.repeat(sizeBytes - 1 - Buffer.byteLength(base)) },
      });
      expect(Buffer.byteLength(line) + 1).toBe(sizeBytes);
      return line;
    };
    const epoch = new Date(Date.UTC(2026, 0, 1));
    const write = (channel: string, body: string, mtime: Date): void => {
      const path = channelEventFilePath(channel, cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      utimesSync(path, mtime, mtime);
    };

    write('win-last', `${sized('win-last', 200)}\n`, epoch);
    let total = 200;
    for (let index = 0; index < 17; index += 1) {
      const channel = `bulk-${index}`;
      const block = Array.from({ length: 10 }, () => sized(channel, 24576));
      write(
        channel,
        `${block.join('\n')}\n`,
        new Date(epoch.getTime() + (index + 1) * 1000),
      );
      total += 245760;
    }
    expect(total).toBeLessThan(4 * 1024 * 1024);

    const { events, truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 500,
    });

    expect(truncated).toBe(false);
    expect(events).toHaveLength(171);
    expect(events.filter((event) => event.channel === 'win-last')).toHaveLength(
      1,
    );
  });

  it('reads journals in chunks, so the read count grows with bytes, not files', async () => {
    // The daemon must be able to serve sessions between chunks, so the
    // awaited reads a journal takes have to grow with the bytes read, not
    // just with the file count. Count the chunk reads themselves rather than
    // the event-loop turns during the read: while an awaited read waits on
    // I/O the loop keeps ticking through idle turns, so on a contended host
    // a turn count measures the neighbors' load instead of the chunking
    // (run 42994647525 inverted this comparison on all three attempts, once
    // reporting 1701 turns for the tall read against a bound of 12691). The
    // read count is fixed by the window and chunk sizes. Measure the same
    // six journals short (one chunk each) and tall (a full 256 KiB window,
    // chunked several times): a tall window takes four more reads per
    // journal than a short one, so the tall read leads by 24 reads; the
    // bound below keeps half of that lead as margin. Reading those windows
    // synchronously, or each in a single piece, would erase the difference.
    const probePath = join(qwenHome, 'read-probe');
    writeFileSync(probePath, '');
    const probe = await open(probePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const originalRead = prototype.read as unknown as (
      this: typeof probe,
      ...args: unknown[]
    ) => Promise<unknown>;
    // The read count proves the journal is still read in chunks; the in-flight
    // bound proves those chunks are awaited one at a time, which is what gives
    // the daemon a turn between them.
    let inFlight = 0;
    let maxInFlight = 0;
    const readSpy = vi
      .spyOn(prototype, 'read')
      .mockImplementation(async function (
        this: typeof probe,
        ...args: unknown[]
      ) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await originalRead.apply(this, args);
        } finally {
          inFlight -= 1;
        }
      } as unknown as typeof prototype.read);

    const measure = async (repeat: number): Promise<number> => {
      rmSync(channelEventScopeDir(cwd), { recursive: true, force: true });
      for (let index = 0; index < 6; index += 1) {
        const channel = `yield-${index}`;
        const line = JSON.stringify({
          at: new Date(2026, 0, 1).toISOString(),
          channel,
          type: 'poll',
          outcome: 'ok',
          detail: { pad: 'x'.repeat(900) },
        });
        const path = channelEventFilePath(channel, cwd);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${line}\n`.repeat(repeat));
      }
      maxInFlight = 0;
      readSpy.mockClear();
      const { events } = await readChannelEvents({
        scopeDirs: [channelEventScopeDir(cwd)],
        limit: 500,
      });
      expect(events.length).toBeGreaterThan(0);
      // Concurrent reads would also scale with the bytes while starving the
      // daemon of the turns between chunks the window's yield relies on.
      expect(maxInFlight).toBeLessThanOrEqual(1);
      return readSpy.mock.calls.length;
    };

    try {
      const short = await measure(4);
      const tall = await measure(400);
      expect(tall).toBeGreaterThan(short + 12);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('keeps every complete record when the window starts on a line boundary', async () => {
    // 300 records of exactly 1 KiB, so the 256 KiB window starts exactly at
    // record 44: the first line it reads is complete and must not be dropped.
    const at = new Date(2026, 0, 1).toISOString();
    const lines = Array.from({ length: 300 }, (_, index) => {
      const shape = {
        at,
        channel: 'aligned',
        type: 'poll',
        outcome: 'ok',
        number: index,
      };
      const base = JSON.stringify({ ...shape, detail: { pad: '' } });
      const line = JSON.stringify({
        ...shape,
        detail: { pad: 'x'.repeat(1024 - 1 - Buffer.byteLength(base)) },
      });
      expect(Buffer.byteLength(line) + 1).toBe(1024);
      return line;
    });
    const path = channelEventFilePath('aligned', cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`);

    const { events, truncated } = await readChannelEvents({
      scopeDirs: [channelEventScopeDir(cwd)],
      limit: 500,
    });

    expect(truncated).toBe(true);
    expect(events).toHaveLength(256);
    expect(events[0]?.number).toBe(44);
    expect(events.at(-1)?.number).toBe(299);
  });

  it('shows an undated record unfiltered but not under a since bound', async () => {
    appendChannelEvent('bot', cwd, {
      at: 'not-a-date',
      type: 'poll',
      outcome: 'ok',
    });
    appendChannelEvent('bot', cwd, {
      at: new Date(2026, 0, 1, 0, 0, 5).toISOString(),
      type: 'poll',
      outcome: 'ok',
    });
    const scopeDirs = [channelEventScopeDir(cwd)];

    const all = await readChannelEvents({ scopeDirs });
    expect(all.events).toHaveLength(2);
    expect(all.events[0]?.at).toBe('not-a-date');

    const bounded = await readChannelEvents({
      scopeDirs,
      since: new Date(2026, 0, 1, 0, 0, 1).getTime(),
    });
    expect(bounded.events).toHaveLength(1);
    expect(bounded.events[0]?.at).not.toBe('not-a-date');
  });

  it('fails loudly when a journal file cannot be read', async () => {
    append(1);
    const path = channelEventFilePath('bot', cwd);
    chmodSync(path, 0o000);
    try {
      await expect(
        readChannelEvents({ scopeDirs: [channelEventScopeDir(cwd)] }),
      ).rejects.toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
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
