/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRegistry,
  serializeRegistry,
  assertValid,
  resolveDefault,
  normalizeDefaults,
  DaemonRegistry,
  type DaemonEntry,
} from './registry.js';

const entry = (o: Partial<DaemonEntry>): DaemonEntry => {
  const name = o.name ?? 'a';
  return {
    name,
    url: o.url ?? `https://${name}.example`,
    tokenStorageKey: o.tokenStorageKey ?? name,
    ...(o.default !== undefined ? { default: o.default } : {}),
  };
};

describe('parseRegistry', () => {
  it('yields [] for null / empty / missing daemon', () => {
    expect(parseRegistry(null)).toEqual([]);
    expect(parseRegistry('')).toEqual([]);
    expect(parseRegistry('# just a comment\n')).toEqual([]);
  });

  it('parses a [[daemon]] array-of-tables', () => {
    const text = [
      '[[daemon]]',
      'name = "work"',
      'url = "https://work.example"',
      'tokenStorageKey = "work"',
      'default = true',
      '',
      '[[daemon]]',
      'name = "home"',
      'url = "https://home.example"',
      'tokenStorageKey = "home"',
    ].join('\n');
    const r = parseRegistry(text);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      name: 'work',
      url: 'https://work.example',
      tokenStorageKey: 'work',
      default: true,
    });
    expect(r[1].default).toBeUndefined();
  });

  it('round-trips through serializeRegistry', () => {
    const r = [entry({ name: 'a', default: true }), entry({ name: 'b' })];
    const reparsed = parseRegistry(serializeRegistry(r));
    expect(reparsed).toEqual(r);
  });

  it('throws on a non-array daemon or a missing required field', () => {
    expect(() => parseRegistry('daemon = "nope"\n')).toThrow(/array/);
    expect(() => parseRegistry('[[daemon]]\nname = "x"\n')).toThrow(
      /url must be/,
    );
  });
});

describe('assertValid', () => {
  it('accepts a valid set', () => {
    expect(() =>
      assertValid([entry({}), entry({ name: 'b', url: 'https://b' })]),
    ).not.toThrow();
  });
  it('rejects duplicate name / url / multiple defaults', () => {
    expect(() => assertValid([entry({}), entry({})])).toThrow(/name/);
    expect(() =>
      assertValid([entry({}), entry({ name: 'b', url: 'https://a.example' })]),
    ).toThrow(/url/);
    expect(() =>
      assertValid([
        entry({ default: true }),
        entry({ name: 'b', url: 'https://b', default: true }),
      ]),
    ).toThrow(/default/);
  });
});

describe('resolveDefault / normalizeDefaults', () => {
  it('prefers an explicit default, else the first entry', () => {
    expect(resolveDefault([])).toBeUndefined();
    expect(
      resolveDefault([entry({ name: 'a' }), entry({ name: 'b' })]).name,
    ).toBe('a');
    expect(
      resolveDefault([
        entry({ name: 'a' }),
        entry({ name: 'b', default: true }),
      ])?.name,
    ).toBe('b');
  });

  it('promotes the first entry to default when none is set, and keeps an existing one', () => {
    expect(
      normalizeDefaults([entry({ name: 'a' }), entry({ name: 'b' })]),
    ).toEqual([
      {
        name: 'a',
        url: 'https://a.example',
        tokenStorageKey: 'a',
        default: true,
      },
      { name: 'b', url: 'https://b.example', tokenStorageKey: 'b' },
    ]);
    const withDef = [entry({ name: 'a' }), entry({ name: 'b', default: true })];
    expect(normalizeDefaults(withDef)).toEqual(withDef);
    expect(normalizeDefaults([])).toEqual([]);
  });
});

describe('DaemonRegistry', () => {
  let dir: string;
  let path: string;
  let reg: DaemonRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-reg-'));
    path = join(dir, 'clients.toml');
    reg = new DaemonRegistry(path);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads [] from a missing file', async () => {
    await expect(reg.list()).resolves.toEqual([]);
  });

  it('upsert adds then replaces, writing a 0600 file', async () => {
    await reg.upsert({ name: 'a', url: 'https://a', tokenStorageKey: 'a' });
    await reg.upsert({ name: 'b', url: 'https://b', tokenStorageKey: 'b' });
    let all = await reg.list();
    expect(all.map((e) => e.name)).toEqual(['a', 'b']);
    // first entry auto-promoted to default
    expect(all[0].default).toBe(true);

    await reg.upsert({ name: 'a', url: 'https://a2', tokenStorageKey: 'a' });
    all = await reg.list();
    expect(all.find((e) => e.name === 'a')?.url).toBe('https://a2');
    expect(all).toHaveLength(2);

    const st = await fs.stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('rejects a duplicate url on upsert', async () => {
    await reg.upsert({ name: 'a', url: 'https://a', tokenStorageKey: 'a' });
    await expect(
      reg.upsert({ name: 'b', url: 'https://a', tokenStorageKey: 'b' }),
    ).rejects.toThrow(/url/);
  });

  it('remove promotes the first survivor to default', async () => {
    await reg.upsert({ name: 'a', url: 'https://a', tokenStorageKey: 'a' });
    await reg.upsert({ name: 'b', url: 'https://b', tokenStorageKey: 'b' });
    await reg.remove('a');
    const all = await reg.list();
    expect(all.map((e) => e.name)).toEqual(['b']);
    expect(all[0].default).toBe(true);
  });

  it('setDefault flips the flag', async () => {
    await reg.upsert({ name: 'a', url: 'https://a', tokenStorageKey: 'a' });
    await reg.upsert({ name: 'b', url: 'https://b', tokenStorageKey: 'b' });
    await reg.setDefault('b');
    const all = await reg.list();
    expect(all.find((e) => e.name === 'a')?.default).toBeUndefined();
    expect(all.find((e) => e.name === 'b')?.default).toBe(true);
    await expect(reg.setDefault('nope')).rejects.toThrow(/no such daemon/);
  });
});
