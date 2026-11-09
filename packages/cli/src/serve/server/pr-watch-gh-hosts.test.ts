/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ghConfigDir, readGhConfiguredHosts } from './pr-watch-gh-hosts.js';

let root: string;
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pr-watch-gh-hosts-'));
  logs = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a hosts.yml under a fresh config dir and return its env. */
function configWith(content: string): Record<string, string> {
  const dir = path.join(root, 'gh-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'hosts.yml'), content, 'utf8');
  return { GH_CONFIG_DIR: dir };
}

function read(env: Record<string, string | undefined>): string[] {
  return [...readGhConfiguredHosts(env, (m) => logs.push(m))].sort();
}

describe('ghConfigDir', () => {
  it('prefers GH_CONFIG_DIR over every other source', () => {
    expect(
      ghConfigDir({
        GH_CONFIG_DIR: '/explicit',
        XDG_CONFIG_HOME: '/xdg',
        HOME: '/home/u',
      }),
    ).toBe('/explicit');
  });

  it('falls back to XDG_CONFIG_HOME/gh, then HOME/.config/gh', () => {
    expect(ghConfigDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' })).toBe(
      path.join('/xdg', 'gh'),
    );
    expect(ghConfigDir({ HOME: '/home/u' })).toBe(
      path.join('/home/u', '.config', 'gh'),
    );
  });

  it('returns undefined when no source is set', () => {
    expect(ghConfigDir({})).toBeUndefined();
  });

  it('ignores an empty GH_CONFIG_DIR rather than reading the cwd', () => {
    // An empty string is unset in templated env files; treating it as a path
    // would read ./hosts.yml from the daemon's working directory.
    expect(ghConfigDir({ GH_CONFIG_DIR: '', HOME: '/home/u' })).toBe(
      path.join('/home/u', '.config', 'gh'),
    );
  });

  it.runIf(process.platform === 'win32')(
    'uses %AppData%/GitHub CLI on Windows',
    () => {
      expect(ghConfigDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(
        path.join('C:\\Users\\u\\AppData\\Roaming', 'GitHub CLI'),
      );
    },
  );
});

describe('readGhConfiguredHosts', () => {
  it('returns an empty set when no config dir can be resolved', () => {
    expect(read({})).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('returns an empty set when hosts.yml is absent, without logging', () => {
    const dir = path.join(root, 'empty-config');
    mkdirSync(dir, { recursive: true });
    expect(read({ GH_CONFIG_DIR: dir })).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('reads the mapping keys and normalises them', () => {
    const env = configWith(
      [
        'github.com:',
        '  oauth_token: secret-token-value',
        '  user: someone',
        'GHE.Example.COM:',
        '  oauth_token: another-secret',
        'www.github.com:',
        '  user: someone',
        '',
      ].join('\n'),
    );
    expect(read(env)).toEqual(['ghe.example.com', 'github.com']);
  });

  it('drops a port so the host matches the port-free watch identity', () => {
    // pullRequestKey drops the port from a binding URL, so a configured host
    // that kept one would never match any watch identity.
    const env = configWith('ghe.example.com:8443:\n  user: someone\n');
    expect(read(env)).toEqual(['ghe.example.com']);
  });

  it('skips keys that are not hostnames', () => {
    const env = configWith(
      [
        'not a host:',
        '  user: x',
        'https://ghe.example.com:',
        '  user: x',
        'github.com:',
        '  user: x',
        '',
      ].join('\n'),
    );
    expect(read(env)).toEqual(['github.com']);
  });

  it('never returns or logs the token values', () => {
    const env = configWith(
      'github.com:\n  oauth_token: super-secret-token\n  user: private-user\n',
    );
    const hosts = read(env);
    expect(hosts).toEqual(['github.com']);
    expect(JSON.stringify(hosts)).not.toContain('super-secret-token');
    expect(logs.join('\n')).not.toContain('super-secret-token');
    expect(logs.join('\n')).not.toContain('private-user');
  });

  it('never echoes a token through a YAML parse error message', () => {
    // The yaml library quotes the offending source line in its message, and a
    // hosts.yml line carries an oauth token. Each shape below was probed to
    // throw with the token in `error.message`; the log must not carry it.
    const shapes = [
      'github.com:\n\toauth_token: super-secret-token\n',
      'github.com: super-secret-token\n  nested: bad\n',
      'github.com:\n  oauth_token: super-secret-token\n  oauth_token: super-secret-token\n',
    ];
    for (const shape of shapes) {
      logs = [];
      expect(read(configWith(shape))).toEqual([]);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join('\n')).not.toContain('super-secret-token');
      expect(logs.join('\n')).toContain('cannot parse gh hosts');
      // Still diagnosable: the non-echoing line number survives.
      expect(logs.join('\n')).toMatch(/at line \d+/);
    }
  });

  it('never emits a token through a YAML warning either', () => {
    // The warning path bypasses both the catch and the caller's log: `parse()`
    // hands it to process.emitWarning with the offending source line attached.
    // An unresolved tag on a token line parses successfully and still writes
    // the whole line to stderr.
    const env = configWith(
      'github.com:\n  oauth_token: !unknown super-secret-token\n',
    );
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    let hosts: string[];
    try {
      hosts = read(env);
    } finally {
      spy.mockRestore();
    }
    const emitted = spy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(emitted).not.toContain('super-secret-token');
    // A warning does not invalidate the host names.
    expect(hosts).toEqual(['github.com']);
    expect(logs.join('\n')).not.toContain('super-secret-token');
    expect(logs.join('\n')).toContain('YAML warning');
    expect(logs.join('\n')).toMatch(/at line \d+/);
  });

  it('degrades to an empty set with a log on malformed YAML', () => {
    const env = configWith('github.com: [unclosed\n');
    expect(read(env)).toEqual([]);
    expect(logs.some((l) => l.includes('cannot parse gh hosts'))).toBe(true);
  });

  it('returns an empty set for a scalar or sequence document', () => {
    expect(read(configWith('just a string'))).toEqual([]);
    expect(read(configWith('- github.com\n- ghe.example.com\n'))).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('degrades with a log when hosts.yml is a symlink', () => {
    const dir = path.join(root, 'link-config');
    mkdirSync(dir, { recursive: true });
    const target = path.join(root, 'elsewhere.yml');
    writeFileSync(target, 'github.com:\n  user: x\n', 'utf8');
    symlinkSync(target, path.join(dir, 'hosts.yml'));
    expect(read({ GH_CONFIG_DIR: dir })).toEqual([]);
    expect(logs.some((l) => l.includes('cannot read gh hosts'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'does not hang when hosts.yml is a FIFO',
    () => {
      const dir = path.join(root, 'fifo-config');
      mkdirSync(dir, { recursive: true });
      execFileSync('mkfifo', [path.join(dir, 'hosts.yml')]);
      // A blocking read here would hang the refresh thread; the guarded open
      // must refuse it instead.
      expect(read({ GH_CONFIG_DIR: dir })).toEqual([]);
      expect(logs.some((l) => l.includes('cannot read gh hosts'))).toBe(true);
    },
  );
});
