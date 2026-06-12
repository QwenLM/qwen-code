/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import {
  ENV_NONSECRET_VARS,
  ENV_PROXY_VARS,
  ENV_SECRET_VARS,
  buildEnvStatusFromProcess,
  readProxyVar,
} from './envSnapshot.js';

const TRACKED_ENV = [
  ...ENV_SECRET_VARS,
  ...ENV_NONSECRET_VARS,
  ...ENV_PROXY_VARS,
  ...ENV_PROXY_VARS.map((n) => n.toLowerCase()),
  'SANDBOX',
  'SEATBELT_PROFILE',
];

let prevEnv: Record<string, string | undefined>;

beforeEach(() => {
  prevEnv = {};
  for (const k of TRACKED_ENV) {
    prevEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TRACKED_ENV) {
    if (prevEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = prevEnv[k];
    }
  }
});

describe('buildEnvStatusFromProcess', () => {
  it('emits a runtime cell whose value matches the actual runtime version', () => {
    const status = buildEnvStatusFromProcess('/ws', false);
    const runtime = status.cells.find((c) => c.kind === 'runtime');
    expect(runtime).toBeDefined();
    expect(['node', 'bun', 'unknown']).toContain(runtime!.name);
    // `detectRuntime` keys on `process.versions['bun']`, so on Bun the
    // cell carries Bun's version, not Node's compat shim version.
    const expected =
      runtime!.name === 'bun'
        ? (process.versions['bun'] ?? process.versions.node)
        : process.versions.node;
    expect(runtime!.value).toBe(expected);
    expect(runtime!.status).toBe('ok');
  });

  it('reports Bun version (not Node compat shim) when running under Bun', () => {
    // `process.versions.bun` is undefined under Node; setting it makes
    // `detectRuntime()` (which keys on `process.versions['bun']`) return
    // `'bun'`, exercising the Bun branch of the runtime-version selector
    // without needing a real Bun process.
    const versions = process.versions as Record<string, string | undefined>;
    const prev = versions['bun'];
    versions['bun'] = '1.2.42';
    try {
      const status = buildEnvStatusFromProcess('/ws', false);
      const runtime = status.cells.find((c) => c.kind === 'runtime');
      expect(runtime!.name).toBe('bun');
      expect(runtime!.value).toBe('1.2.42');
      expect(runtime!.value).not.toBe(process.versions.node);
    } finally {
      if (prev === undefined) delete versions['bun'];
      else versions['bun'] = prev;
    }
  });

  it('emits platform and arch on the platform cell', () => {
    const status = buildEnvStatusFromProcess('/ws', true);
    const platform = status.cells.find((c) => c.kind === 'platform');
    expect(platform!.name).toBe(process.platform);
    expect(platform!.value).toBe(`${process.arch} (${os.release()})`);
  });

  it('marks SANDBOX disabled when unset and ok with the profile name when set', () => {
    let status = buildEnvStatusFromProcess('/ws', false);
    let cell = status.cells.find(
      (c) => c.kind === 'sandbox' && c.name === 'SANDBOX',
    );
    expect(cell!.status).toBe('disabled');
    expect(cell!.present).toBe(false);
    expect('value' in cell!).toBe(false);

    process.env['SANDBOX'] = 'docker';
    status = buildEnvStatusFromProcess('/ws', false);
    cell = status.cells.find(
      (c) => c.kind === 'sandbox' && c.name === 'SANDBOX',
    );
    expect(cell!.status).toBe('ok');
    expect(cell!.present).toBe(true);
    expect(cell!.value).toBe('docker');
  });

  it('redacts user:pass from proxy URLs and surfaces only the host:port', () => {
    process.env['HTTPS_PROXY'] = 'http://alice:secret@proxy.internal:1080';
    const status = buildEnvStatusFromProcess('/ws', false);
    const cell = status.cells.find(
      (c) => c.kind === 'proxy' && c.name === 'HTTPS_PROXY',
    );
    expect(cell!.present).toBe(true);
    expect(cell!.value).toBe('proxy.internal:1080');
    expect(cell!.value).not.toContain('alice');
    expect(cell!.value).not.toContain('secret');
  });

  it('reduces authority-only proxy values (no scheme) to host:port without leaking userinfo', () => {
    process.env['HTTPS_PROXY'] = 'alice:secret@proxy.internal:1080';
    const status = buildEnvStatusFromProcess('/ws', false);
    const cell = status.cells.find(
      (c) => c.kind === 'proxy' && c.name === 'HTTPS_PROXY',
    );
    expect(cell!.value).toBe('proxy.internal:1080');
    expect(cell!.value).not.toContain('alice');
    expect(cell!.value).not.toContain('secret');
    expect(cell!.value).not.toContain('@');
    expect(cell!.value).not.toContain('<redacted>');
  });

  it('falls back to a scrubbed authority for unparseable proxy values rather than the raw input', () => {
    process.env['HTTP_PROXY'] = 'garbage://[not a valid url]:::abc';
    const status = buildEnvStatusFromProcess('/ws', false);
    const cell = status.cells.find(
      (c) => c.kind === 'proxy' && c.name === 'HTTP_PROXY',
    );
    expect(cell!.present).toBe(true);
    // Whatever the value is, it must NOT contain credential-shaped userinfo
    // and must NOT be the original raw string verbatim.
    expect(cell!.value).not.toMatch(/[^@/?#]*:[^@/?#]+@/);
  });

  it('reads lowercase proxy env vars when uppercase is unset', () => {
    process.env['http_proxy'] = 'http://proxy.local:3128';
    const status = buildEnvStatusFromProcess('/ws', false);
    const cell = status.cells.find(
      (c) => c.kind === 'proxy' && c.name === 'HTTP_PROXY',
    );
    expect(cell!.present).toBe(true);
    expect(cell!.value).toBe('proxy.local:3128');
  });

  it('readProxyVar uses ?? not || so an explicit empty string disables fallthrough', () => {
    // Docker/K8s entrypoints commonly set `HTTPS_PROXY=""` to override an
    // inherited proxy. With `||` the empty string would be treated as
    // falsy and `readProxyVar` would fall through to the lowercase
    // variant; with `??` it preserves the empty string.
    //
    // Tested via `readProxyVar` directly (not `buildEnvStatusFromProcess`)
    // because Windows' `process.env` is case-INSENSITIVE — setting
    // `HTTPS_PROXY=""` then `https_proxy=...` ends up writing the same
    // key twice, so we couldn't distinguish `||` from `??` through the
    // process-env path on Windows. Passing a plain JS object here keeps
    // the keys distinct on every platform.
    const explicitlyDisabled = readProxyVar(
      { HTTPS_PROXY: '', https_proxy: 'http://proxy.parent:3128' },
      'HTTPS_PROXY',
    );
    expect(explicitlyDisabled).toBe('');

    // Sanity check — when the uppercase variant is absent (not just empty),
    // the lowercase fallback IS taken.
    const lowercaseFallback = readProxyVar(
      { https_proxy: 'http://proxy.parent:3128' },
      'HTTPS_PROXY',
    );
    expect(lowercaseFallback).toBe('http://proxy.parent:3128');
  });

  it('passes NO_PROXY through redaction without URL parsing', () => {
    process.env['NO_PROXY'] = 'localhost,127.0.0.1,internal.local';
    const status = buildEnvStatusFromProcess('/ws', false);
    const cell = status.cells.find(
      (c) => c.kind === 'proxy' && c.name === 'NO_PROXY',
    );
    expect(cell!.present).toBe(true);
    expect(cell!.value).toBe('localhost,127.0.0.1,internal.local');
  });

  it('emits env_var cells presence-only — never includes a value field', () => {
    process.env['OPENAI_API_KEY'] = 'sk-do-not-leak-1234567890';
    process.env['ANTHROPIC_BASE_URL'] = 'https://api.anthropic.com';
    const status = buildEnvStatusFromProcess('/ws', false);
    for (const cell of status.cells) {
      if (cell.kind !== 'env_var') continue;
      expect('value' in cell).toBe(false);
    }
    const apiKey = status.cells.find(
      (c) => c.kind === 'env_var' && c.name === 'OPENAI_API_KEY',
    );
    expect(apiKey!.present).toBe(true);
    expect(apiKey!.status).toBe('ok');
    const baseUrl = status.cells.find(
      (c) => c.kind === 'env_var' && c.name === 'ANTHROPIC_BASE_URL',
    );
    expect(baseUrl!.present).toBe(true);
  });

  it('does not enumerate non-whitelisted secrets even when set', () => {
    process.env['SOME_OTHER_SECRET_KEY'] = 'leak-me';
    const status = buildEnvStatusFromProcess('/ws', false);
    expect(
      status.cells.some(
        (c) => c.name === 'SOME_OTHER_SECRET_KEY' || c.value === 'leak-me',
      ),
    ).toBe(false);
  });

  it('preserves workspaceCwd / acpChannelLive / initialized=true on the envelope', () => {
    const live = buildEnvStatusFromProcess('/abs/ws', true);
    expect(live.workspaceCwd).toBe('/abs/ws');
    expect(live.acpChannelLive).toBe(true);
    expect(live.initialized).toBe(true);
    expect(live.v).toBe(1);

    const idle = buildEnvStatusFromProcess('/abs/ws', false);
    expect(idle.acpChannelLive).toBe(false);
    expect(idle.initialized).toBe(true);
  });
});
