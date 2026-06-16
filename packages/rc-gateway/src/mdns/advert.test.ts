/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  RC_PROTOCOL_VERSION,
  MdnsConfigError,
  validateMdnsLabel,
  deriveWorkspaceName,
  deriveInstanceName,
  mdnsDecision,
  buildTxtRecord,
  normalizeBrowseService,
  dedupeAndSortDaemons,
  formatDaemonsTable,
  formatDaemonsJson,
  parseDuration,
  parseDiscoverArgs,
} from './advert.js';

describe('validateMdnsLabel', () => {
  it('accepts 1-63 ASCII chars and trims', () => {
    expect(validateMdnsLabel('app', 'workspace')).toBe('app');
    expect(validateMdnsLabel('  app-public  ', 'workspace')).toBe('app-public');
    expect(validateMdnsLabel('a'.repeat(63), 'name')).toHaveLength(63);
  });

  it('rejects empty / whitespace-only', () => {
    expect(() => validateMdnsLabel('', 'workspace')).toThrow(MdnsConfigError);
    expect(() => validateMdnsLabel('   ', 'workspace')).toThrow(/workspace/);
  });

  it('rejects > 63 chars', () => {
    expect(() => validateMdnsLabel('a'.repeat(64), 'name')).toThrow(
      MdnsConfigError,
    );
  });

  it('rejects path separators and traversal', () => {
    for (const bad of ['../etc', 'a/b', 'a\\b', '..', '.', '/abs']) {
      expect(() => validateMdnsLabel(bad, 'workspace')).toThrow(
        MdnsConfigError,
      );
    }
  });

  it('rejects non-ASCII and control chars', () => {
    expect(() => validateMdnsLabel('café', 'name')).toThrow(MdnsConfigError);
    expect(() => validateMdnsLabel('a\tb', 'name')).toThrow(MdnsConfigError);
  });
});

describe('deriveWorkspaceName', () => {
  it('uses the cwd basename by default (never a full path)', () => {
    expect(deriveWorkspaceName('/home/user/projects/secret')).toBe('secret');
    const v = deriveWorkspaceName('/home/user/projects/secret');
    expect(v).not.toContain('/');
  });

  it('applies a validated override', () => {
    expect(deriveWorkspaceName('/x/y/api', 'app-public')).toBe('app-public');
  });

  it('refuses a path-traversal override (startup error)', () => {
    expect(() => deriveWorkspaceName('/x/y/api', '../etc')).toThrow(
      MdnsConfigError,
    );
  });
});

describe('deriveInstanceName', () => {
  it('defaults to <hostname>-<workspace>', () => {
    expect(deriveInstanceName('kitchen', 'app')).toBe('kitchen-app');
  });
  it('honors a validated override', () => {
    expect(deriveInstanceName('kitchen', 'app', 'my-daemon')).toBe('my-daemon');
  });
  it('truncates a long default to 63 chars (does not throw)', () => {
    const r = deriveInstanceName('h'.repeat(40), 'w'.repeat(40));
    expect(r.length).toBeLessThanOrEqual(63);
  });
});

describe('mdnsDecision', () => {
  it('advertises only on a native-TLS bind by default', () => {
    expect(mdnsDecision({ bindMode: 'tls' })).toEqual({
      advertise: true,
      reason: null,
    });
  });

  it('suppresses on a loopback-http bind', () => {
    expect(mdnsDecision({ bindMode: 'loopback-http' })).toEqual({
      advertise: false,
      reason: 'loopback',
    });
  });

  it('suppresses in insecure-proxy mode (the proxy is the better mDNS source)', () => {
    expect(mdnsDecision({ bindMode: 'insecure-proxy' })).toEqual({
      advertise: false,
      reason: 'insecure-proxy',
    });
  });

  it('--no-mdns wins over everything', () => {
    expect(mdnsDecision({ bindMode: 'tls', noMdnsFlag: true })).toEqual({
      advertise: false,
      reason: 'flag',
    });
  });

  it('env disable wins when the flag is absent', () => {
    expect(mdnsDecision({ bindMode: 'tls', envDisabled: true })).toEqual({
      advertise: false,
      reason: 'env',
    });
  });
});

describe('buildTxtRecord', () => {
  it('carries exactly the four documented keys as strings', () => {
    const txt = buildTxtRecord({
      name: 'kitchen-app',
      workspace: 'app',
      tlsRequired: true,
    });
    expect(txt).toEqual({
      version: String(RC_PROTOCOL_VERSION),
      name: 'kitchen-app',
      workspace: 'app',
      tlsRequired: 'true',
    });
    expect(Object.keys(txt).sort()).toEqual([
      'name',
      'tlsRequired',
      'version',
      'workspace',
    ]);
  });

  it('stringifies tlsRequired=false', () => {
    expect(
      buildTxtRecord({ name: 'n', workspace: 'w', tlsRequired: false }),
    ).toMatchObject({ tlsRequired: 'false' });
  });
});

describe('normalizeBrowseService', () => {
  const raw = (over = {}) => ({
    name: 'kitchen-app',
    host: 'kitchen.local',
    port: 7070,
    txt: {
      version: '1',
      name: 'kitchen-app',
      workspace: 'app',
      tlsRequired: 'true',
    },
    ...over,
  });

  it('maps a raw service to the documented six-field record', () => {
    expect(normalizeBrowseService(raw())).toEqual({
      name: 'kitchen-app',
      host: 'kitchen.local',
      port: 7070,
      version: '1',
      tlsRequired: true,
      workspace: 'app',
    });
  });

  it('falls back to addresses[] when host is absent (prefers IPv4)', () => {
    const r = normalizeBrowseService(
      raw({ host: undefined, addresses: ['fe80::1', '192.168.1.9'] }),
    );
    expect(r?.host).toBe('192.168.1.9');
  });

  it('returns null when there is no usable host', () => {
    expect(
      normalizeBrowseService(raw({ host: undefined, addresses: [] })),
    ).toBeNull();
  });

  it('tolerates a missing txt block', () => {
    const r = normalizeBrowseService(raw({ txt: undefined }));
    expect(r).toMatchObject({ version: '', workspace: '', tlsRequired: false });
  });
});

describe('dedupeAndSortDaemons', () => {
  const rec = (over = {}) => ({
    name: 'a',
    host: 'h',
    port: 1,
    version: '1',
    tlsRequired: false,
    workspace: 'w',
    ...over,
  });

  it('dedupes by name (latest wins) and sorts by host then port', () => {
    const out = dedupeAndSortDaemons([
      rec({ name: 'a', host: 'z.local', port: 2 }),
      rec({ name: 'b', host: 'a.local', port: 9 }),
      rec({ name: 'a', host: 'z.local', port: 5 }), // dup name → replaces
      rec({ name: 'c', host: 'a.local', port: 3 }),
    ]);
    expect(out.map((r) => r.name)).toEqual(['c', 'b', 'a']);
    expect(out.find((r) => r.name === 'a')?.port).toBe(5); // latest won
  });

  it('returns [] for empty input', () => {
    expect(dedupeAndSortDaemons([])).toEqual([]);
  });
});

describe('formatDaemonsTable', () => {
  const recs = [
    {
      name: 'kitchen-app',
      host: 'kitchen.local',
      port: 7070,
      version: '1',
      tlsRequired: true,
      workspace: 'app',
    },
  ];

  it('starts with the column header and ends with a summary line', () => {
    const out = formatDaemonsTable(recs, 5000);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^NAME\s+HOST\s+PORT\s+VERSION\s+TLS\s+WORKSPACE/);
    expect(lines[lines.length - 1]).toMatch(/^1 daemon found in 5\.0s$/);
  });

  it('pluralizes and reports zero cleanly', () => {
    const out = formatDaemonsTable([], 1000);
    expect(out.trim()).toMatch(/^0 daemons found in 1\.0s$/);
  });

  it('renders TLS as yes/no', () => {
    expect(formatDaemonsTable(recs, 1000)).toMatch(/\byes\b/);
    expect(
      formatDaemonsTable([{ ...recs[0], tlsRequired: false }], 1000),
    ).toMatch(/\bno\b/);
  });
});

describe('formatDaemonsJson', () => {
  it('emits a parseable array with exactly the six fields', () => {
    const out = formatDaemonsJson([
      {
        name: 'n',
        host: 'h',
        port: 1,
        version: '1',
        tlsRequired: true,
        workspace: 'w',
      },
    ]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(Object.keys(parsed[0]).sort()).toEqual([
      'host',
      'name',
      'port',
      'tlsRequired',
      'version',
      'workspace',
    ]);
  });

  it('emits [] for no daemons', () => {
    expect(JSON.parse(formatDaemonsJson([]))).toEqual([]);
  });
});

describe('parseDuration', () => {
  it('parses s / ms / bare seconds', () => {
    expect(parseDuration('5s')).toBe(5000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('3')).toBe(3000);
  });
  it('throws on garbage and non-positive', () => {
    expect(() => parseDuration('soon')).toThrow();
    expect(() => parseDuration('0s')).toThrow();
    expect(() => parseDuration('-1s')).toThrow();
  });
});

describe('parseDiscoverArgs', () => {
  it('defaults to 5s / table', () => {
    expect(parseDiscoverArgs([])).toEqual({ timeoutMs: 5000, format: 'table' });
  });
  it('parses --timeout and --format', () => {
    expect(parseDiscoverArgs(['--timeout', '3s', '--format', 'json'])).toEqual({
      timeoutMs: 3000,
      format: 'json',
    });
  });
  it('rejects an unknown --format', () => {
    expect(() => parseDiscoverArgs(['--format', 'xml'])).toThrow();
  });
});
