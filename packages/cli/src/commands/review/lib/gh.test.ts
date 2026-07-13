/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ghEnv, setGhHost } from './gh.js';

// Host targeting is code, not prose: the subcommands thread `--host` here,
// and every gh child gets GH_HOST from ghEnv(). These tests pin the pure
// state machine; the spawn itself is exercised by the commands' own runs.
describe('setGhHost / ghEnv', () => {
  afterEach(() => setGhHost(undefined));

  it('defaults to inheriting the parent env untouched (undefined)', () => {
    expect(ghEnv()).toBeUndefined();
  });

  it('with a host set, extends the inherited env with GH_HOST', () => {
    setGhHost('github.example.com');
    const env = ghEnv();
    expect(env).toBeDefined();
    expect(env!['GH_HOST']).toBe('github.example.com');
    // Inherited keys survive — gh still needs PATH, HOME, its auth env.
    expect(env!['PATH']).toBe(process.env['PATH']);
  });

  it('accepts a host:port and resets on undefined or empty string', () => {
    setGhHost('ghe.internal:8443');
    expect(ghEnv()!['GH_HOST']).toBe('ghe.internal:8443');
    setGhHost('');
    expect(ghEnv()).toBeUndefined();
    setGhHost('ghe.internal');
    setGhHost(undefined);
    expect(ghEnv()).toBeUndefined();
  });

  it('rejects non-hostname input (an env value must never smuggle shell or spaces)', () => {
    expect(() => setGhHost('ghe.internal; rm -rf /')).toThrow(/--host/);
    expect(() => setGhHost('bad host')).toThrow(/--host/);
    expect(() => setGhHost('https://ghe.internal')).toThrow(/--host/);
  });
});
