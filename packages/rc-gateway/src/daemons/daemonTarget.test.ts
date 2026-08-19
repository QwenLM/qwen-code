/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDaemonTarget,
  splitTargetFlags,
  LOCAL_DAEMON_URL,
  type DaemonEntry,
} from './daemonTarget.js';

const entry = (o: Partial<DaemonEntry>): DaemonEntry => {
  const name = o.name ?? 'a';
  return {
    name,
    url: o.url ?? `https://${name}.example`,
    tokenStorageKey: o.tokenStorageKey ?? name,
    ...(o.default !== undefined ? { default: o.default } : {}),
  };
};

const tokens = new Map<string, string>([
  ['a', 'qwk_a'],
  ['b', 'qwk_b'],
]);
const tokenFor = (key: string) => tokens.get(key);

describe('resolveDaemonTarget', () => {
  it('resolves the local default when the registry is empty', async () => {
    const r = await resolveDaemonTarget({}, [], tokenFor);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toEqual({
      name: 'local',
      url: LOCAL_DAEMON_URL,
      fromRegistry: false,
    });
  });

  it('honors QWEN_RC_DAEMON_URL over the built-in local default', async () => {
    const r = await resolveDaemonTarget({}, [], tokenFor, {
      QWEN_RC_DAEMON_URL: 'http://10.0.0.5:9000/',
    });
    expect(r.ok && r.target.url).toBe('http://10.0.0.5:9000');
  });

  it('resolves the default registry entry (explicit default wins over first)', async () => {
    const entries = [entry({ name: 'a' }), entry({ name: 'b', default: true })];
    const r = await resolveDaemonTarget({}, entries, tokenFor);
    expect(r.ok && r.target.name).toBe('b');
    expect(r.ok && r.target.url).toBe('https://b.example');
    expect(r.ok && r.target.token).toBe('qwk_b');
    expect(r.ok && r.target.fromRegistry).toBe(true);
  });

  it('resolves the FIRST entry when none is marked default', async () => {
    const entries = [entry({ name: 'a' }), entry({ name: 'b' })];
    const r = await resolveDaemonTarget({}, entries, tokenFor);
    expect(r.ok && r.target.name).toBe('a');
  });

  it('resolves --daemon <name> to that entry', async () => {
    const entries = [entry({ name: 'a' }), entry({ name: 'b' })];
    const r = await resolveDaemonTarget({ daemonName: 'b' }, entries, tokenFor);
    expect(r.ok && r.target.name).toBe('b');
    expect(r.ok && r.target.token).toBe('qwk_b');
  });

  it('errors on an unknown --daemon name and lists the known ones', async () => {
    const entries = [entry({ name: 'a' }), entry({ name: 'b' })];
    const r = await resolveDaemonTarget(
      { daemonName: 'zz' },
      entries,
      tokenFor,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Spec: unknown --daemon exits 1 with `daemon_unknown`.
    expect(r.code).toBe('daemon_unknown');
    expect(r.error).toContain('daemon_unknown');
    expect(r.error).toContain('zz');
    expect(r.error).toContain('a, b');
  });

  it('unknown --daemon with an empty registry lists (none)', async () => {
    const r = await resolveDaemonTarget({ daemonName: 'zz' }, [], tokenFor);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('daemon_unknown');
    expect(r.error).toContain('(none)');
  });

  it('carries the bad_url code for an unparseable --url', async () => {
    const r = await resolveDaemonTarget({ url: 'not a url' }, [], tokenFor);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_url');
  });

  it('explicit --url bypasses the registry (name = host, no token lookup)', async () => {
    const entries = [entry({ name: 'a' })];
    const r = await resolveDaemonTarget(
      { url: 'https://elsewhere:8443/' },
      entries,
      tokenFor,
    );
    expect(r.ok && r.target.name).toBe('elsewhere:8443');
    expect(r.ok && r.target.url).toBe('https://elsewhere:8443');
    expect(r.ok && r.target.token).toBeUndefined();
    expect(r.ok && r.target.fromRegistry).toBe(false);
  });

  it('rejects a non-http(s) --url', async () => {
    const r = await resolveDaemonTarget({ url: 'not a url' }, [], tokenFor);
    expect(r.ok).toBe(false);
    const r2 = await resolveDaemonTarget(
      { url: 'ftp://x.example' },
      [],
      tokenFor,
    );
    expect(r2.ok).toBe(false);
  });

  it('explicit --token wins over the token store', async () => {
    const entries = [entry({ name: 'a' })];
    const r = await resolveDaemonTarget(
      { token: 'qwk_override' },
      entries,
      tokenFor,
    );
    expect(r.ok && r.target.token).toBe('qwk_override');
  });

  it('an entry without a stored token yields no token', async () => {
    const entries = [entry({ name: 'ghost' })]; // not in the token map
    const r = await resolveDaemonTarget({}, entries, tokenFor);
    expect(r.ok && r.target.token).toBeUndefined();
  });

  it('works with an async token lookup', async () => {
    const entries = [entry({ name: 'a' })];
    const r = await resolveDaemonTarget({}, entries, async (k) =>
      tokens.get(k),
    );
    expect(r.ok && r.target.token).toBe('qwk_a');
  });
});

describe('splitTargetFlags', () => {
  it('pulls --daemon/--url/--token/--insecure out, leaving core args', () => {
    const r = splitTargetFlags([
      'abc-123',
      '--from-event',
      '5',
      '--daemon',
      'work-a',
      '--insecure',
      '--token',
      'qwk_x',
    ]);
    expect(r.core).toEqual(['abc-123', '--from-event', '5']);
    expect(r.target).toEqual({ daemonName: 'work-a', token: 'qwk_x' });
    expect(r.insecure).toBe(true);
  });

  it('accepts the --flag=value forms', () => {
    const r = splitTargetFlags(['--url=https://x:8443', 'abc', '--daemon=y']);
    expect(r.core).toEqual(['abc']);
    expect(r.target).toEqual({ url: 'https://x:8443', daemonName: 'y' });
  });

  it('throws when a value flag is missing its value', () => {
    expect(() => splitTargetFlags(['--daemon'])).toThrow(
      /--daemon requires a value/,
    );
  });

  it('passes through unknown flags untouched', () => {
    const r = splitTargetFlags(['--mode', 'empty', 'abc']);
    expect(r.core).toEqual(['--mode', 'empty', 'abc']);
    expect(r.target).toEqual({});
  });
});
