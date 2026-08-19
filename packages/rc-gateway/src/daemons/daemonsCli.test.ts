/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseDaemonsArgs,
  formatDaemonsListTable,
  formatHealthLine,
  formatWhoami,
  type DaemonRow,
} from './daemonsCli.js';

describe('parseDaemonsArgs', () => {
  it('requires a subcommand', () => {
    const r = parseDaemonsArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('missing subcommand');
  });

  it('rejects an unknown subcommand', () => {
    const r = parseDaemonsArgs(['frobnicate']);
    expect(r.ok).toBe(false);
  });

  it('parses list with --format json (= form)', () => {
    const r = parseDaemonsArgs(['list', '--format=json']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.format).toBe('json');
  });

  it('parses add <name> <url> with flags', () => {
    const r = parseDaemonsArgs([
      'add',
      'work-a',
      'https://a.example:8443',
      '--code',
      'ABC123',
      '--force',
      '--token-storage-key',
      'a.key',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sub).toBe('add');
      expect(r.value.name).toBe('work-a');
      expect(r.value.url).toBe('https://a.example:8443');
      expect(r.value.code).toBe('ABC123');
      expect(r.value.force).toBe(true);
      expect(r.value.tokenStorageKey).toBe('a.key');
      expect(r.value.noPair).toBe(false);
    }
  });

  it('add: requires name AND url', () => {
    expect(parseDaemonsArgs(['add', 'only-name']).ok).toBe(false);
    expect(parseDaemonsArgs(['add']).ok).toBe(false);
  });

  it('add: validates the name (no punctuation-leading / path tricks)', () => {
    expect(parseDaemonsArgs(['add', '-lead', 'https://x']).ok).toBe(false);
    expect(parseDaemonsArgs(['add', '../evil', 'https://x']).ok).toBe(false);
    expect(parseDaemonsArgs(['add', 'x'.repeat(65), 'https://x']).ok).toBe(
      false,
    );
    expect(parseDaemonsArgs(['add', 'work-a', 'https://x']).ok).toBe(true);
  });

  it('add: validates the URL (absolute http/https only)', () => {
    expect(parseDaemonsArgs(['add', 'a', 'not a url']).ok).toBe(false);
    expect(parseDaemonsArgs(['add', 'a', 'ftp://x']).ok).toBe(false);
    expect(parseDaemonsArgs(['add', 'a', 'https://ok.example']).ok).toBe(true);
  });

  it('add: --no-pair conflicts with --code/--token; --code conflicts with --token', () => {
    expect(
      parseDaemonsArgs(['add', 'a', 'https://x', '--no-pair', '--code', 'C'])
        .ok,
    ).toBe(false);
    expect(
      parseDaemonsArgs(['add', 'a', 'https://x', '--no-pair', '--token', 'T'])
        .ok,
    ).toBe(false);
    expect(
      parseDaemonsArgs(['add', 'a', 'https://x', '--code', 'C', '--token', 'T'])
        .ok,
    ).toBe(false);
  });

  it('remove/set-default require exactly one name', () => {
    expect(parseDaemonsArgs(['remove']).ok).toBe(false);
    expect(parseDaemonsArgs(['remove', 'a', 'b']).ok).toBe(false);
    expect(parseDaemonsArgs(['remove', 'a', '--yes']).ok).toBe(true);
    expect(parseDaemonsArgs(['set-default', 'a']).ok).toBe(true);
  });

  it('health: --all and --daemon flags', () => {
    const r = parseDaemonsArgs(['health', '--all', '--daemon', 'b']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.all).toBe(true);
      expect(r.value.daemonName).toBe('b');
    }
  });

  it('list rejects a positional argument', () => {
    expect(parseDaemonsArgs(['list', 'stray']).ok).toBe(false);
  });

  it('rejects unknown flags', () => {
    expect(parseDaemonsArgs(['list', '--bogus']).ok).toBe(false);
  });
});

describe('formatDaemonsListTable', () => {
  const rows: DaemonRow[] = [
    {
      name: 'work-a',
      url: 'https://a.example:8443',
      isDefault: true,
      tokenPresent: true,
      health: 'ok',
    },
    {
      name: 'work-b',
      url: 'https://b.example:8443',
      isDefault: false,
      tokenPresent: false,
      health: 'unreachable',
    },
  ];

  it('renders aligned columns with the default marker', () => {
    const out = formatDaemonsListTable(rows);
    const lines = out.split('\n');
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('HEALTH');
    expect(lines[1]).toContain('work-a');
    expect(lines[1]).toContain('*');
    expect(lines[2]).toContain('work-b');
    expect(lines[2]).toContain('unreachable');
    // Alignment: every line is the same width.
    const width = lines[0].length;
    for (const l of lines) expect(l.length).toBe(width);
  });

  it('renders a placeholder for an empty registry', () => {
    expect(formatDaemonsListTable([])).toContain('no daemons registered');
  });
});

describe('formatHealthLine', () => {
  it('renders ok with latency', () => {
    expect(formatHealthLine('a', 'https://a', 'ok', 12)).toBe(
      'a  https://a  ok (12 ms)',
    );
  });
  it('renders unreachable with a detail', () => {
    expect(
      formatHealthLine(
        'a',
        'https://a',
        'unreachable',
        undefined,
        'ECONNREFUSED',
      ),
    ).toBe('a  https://a  UNREACHABLE — ECONNREFUSED');
  });
  it('renders error with a detail', () => {
    expect(
      formatHealthLine('a', 'https://a', 'error', undefined, 'HTTP 500'),
    ).toBe('a  https://a  ERROR — HTTP 500');
  });
});

describe('formatWhoami', () => {
  it('renders an owner token', () => {
    expect(
      formatWhoami({ kind: 'owner', name: 'work-a', scopes: ['owner'] }),
    ).toBe(
      'token  work-a\n  scopes: owner\n  no expiry (owner tokens are long-lived)',
    );
  });
  it('renders a share token with expiry', () => {
    const out = formatWhoami({
      kind: 'share',
      name: 'demo',
      scopes: ['share'],
      expiresAt: '2026-08-18T00:00:00.000Z',
    });
    expect(out).toContain('share token');
    expect(out).toContain('expires 2026-08-18T00:00:00.000Z');
  });
  it('renders the re-pair hint for a rejected token', () => {
    expect(formatWhoami({ kind: 'invalid', scopes: [] })).toContain('re-pair');
  });
});
