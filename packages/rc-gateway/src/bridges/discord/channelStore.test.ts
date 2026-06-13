/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordChannelStore } from './channelStore.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-dc-chan-'));
  path = join(dir, 'channels.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('DiscordChannelStore', () => {
  it('binds, looks up, and reverse-looks-up by session', async () => {
    const s = await DiscordChannelStore.open(path);
    await s.bind(
      '1234567890',
      '0987654321',
      'sess_abc',
      '2026-01-01T00:00:00Z',
    );
    expect(s.sessionFor('1234567890')).toBe('sess_abc');
    expect(s.getByChannel('1234567890')).toEqual({
      channelId: '1234567890',
      guildId: '0987654321',
      sessionId: 'sess_abc',
      boundAt: '2026-01-01T00:00:00Z',
    });
    expect(s.channelsFor('sess_abc')).toEqual(['1234567890']);
    expect(s.boundSessions()).toEqual(['sess_abc']);
  });

  it('keeps a 19-digit channel snowflake EXACT across persist + reload (no Number())', async () => {
    const bigChannel = '1234567890123456789'; // 19 digits, > 2^53
    const bigGuild = '9876543210987654321';
    const s1 = await DiscordChannelStore.open(path);
    await s1.bind(bigChannel, bigGuild, 'sess_q');

    // Round-trip through disk.
    const s2 = await DiscordChannelStore.open(path);
    const b = s2.getByChannel(bigChannel);
    expect(b?.channelId).toBe(bigChannel);
    expect(b?.guildId).toBe(bigGuild);
    expect(b?.sessionId).toBe('sess_q');

    // The raw file must contain the digits verbatim (not 1.2345e18 / rounded).
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain(bigChannel);
    expect(raw).toContain(bigGuild);
  });

  it('overwrites a re-attached channel and persists', async () => {
    const s = await DiscordChannelStore.open(path);
    await s.bind('c1', 'g1', 'sess_old');
    await s.bind('c1', 'g1', 'sess_new');
    expect(s.sessionFor('c1')).toBe('sess_new');
    expect(s.channelsFor('sess_old')).toEqual([]);

    const reloaded = await DiscordChannelStore.open(path);
    expect(reloaded.sessionFor('c1')).toBe('sess_new');
  });

  it('unbind removes the binding and reports whether one existed', async () => {
    const s = await DiscordChannelStore.open(path);
    await s.bind('c1', 'g1', 'sess_abc');
    expect(await s.unbind('c1')).toBe(true);
    expect(s.sessionFor('c1')).toBeUndefined();
    expect(await s.unbind('c1')).toBe(false); // already gone

    const reloaded = await DiscordChannelStore.open(path);
    expect(reloaded.all()).toEqual([]);
  });

  it('two channels can bind to the same session', async () => {
    const s = await DiscordChannelStore.open(path);
    await s.bind('c1', 'g1', 'sess_abc');
    await s.bind('c2', 'g1', 'sess_abc');
    expect(s.channelsFor('sess_abc').sort()).toEqual(['c1', 'c2']);
    expect(s.boundSessions()).toEqual(['sess_abc']);
  });

  it('a missing file opens empty', async () => {
    const s = await DiscordChannelStore.open(path);
    expect(s.all()).toEqual([]);
  });

  it('a corrupt file opens empty (never throws)', async () => {
    await writeFile(path, 'not json {{{');
    const s = await DiscordChannelStore.open(path);
    expect(s.all()).toEqual([]);
  });

  it('skips malformed rows but keeps valid ones', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        channels: [
          { channelId: 'c1', guildId: 'g1', sessionId: 'sess_ok', boundAt: '' },
          { channelId: 'c2' }, // missing sessionId → skipped
          { sessionId: 'sess_x' }, // missing channelId → skipped
          'garbage',
        ],
      }),
    );
    const s = await DiscordChannelStore.open(path);
    expect(s.all().map((b) => b.channelId)).toEqual(['c1']);
  });
});
