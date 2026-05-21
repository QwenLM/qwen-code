/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `defaultSpawnChannelFactory`'s security-critical env
 * scrubbing (wenshao #4319 Critical fold-in). The wider 174-test
 * `httpAcpBridge.test.ts` suite uses mock channels and never spawns a
 * real child, so none of those tests exercise `defaultSpawnChannelFactory`
 * or `scrubChildEnv` directly. These tests close that gap.
 *
 * Why this matters: now that `defaultSpawnChannelFactory` is a public
 * export of `@qwen-code/acp-bridge`, channels (`packages/channels/base/
 * AcpBridge.ts`) and the VSCode IDE companion will consume it directly
 * and cannot rely on cli-package integration tests for env-scrubbing
 * guarantees. The scrubbing logic protects against:
 *
 *   - `QWEN_SERVER_TOKEN` (the daemon's own bearer token) leaking into
 *     the spawned agent's environment, where prompt-injection could
 *     turn the agent into an authenticated client of its own daemon.
 *   - An `overrides` map smuggling a scrubbed key BACK into the child
 *     env (defense-in-depth — operators / embedders can pass overrides,
 *     but the denylist still wins).
 *   - An `overrides` map with `undefined` value silently failing to
 *     delete a stale inherited var (PR 14 fix #4247 wenshao R5 —
 *     the `runQwenServe.ts:216` use case).
 *
 * Each branch listed below is now regression-guarded by an assertion.
 */

import { describe, expect, it } from 'vitest';
import { scrubChildEnv } from './spawnChannel.js';

// Decoupled canary: we deliberately hand-roll the test set instead of
// importing `SCRUBBED_CHILD_ENV_KEYS` from `spawnChannel.ts` so the
// helper's behavior (clone + scrub + override + denylist-wins ordering)
// is tested as a pure function with parameterized input, independent
// of any current production denylist. The multi-key test below
// forward-guards expansion when a future sandboxed-agent mode grows
// the production set per the WARNING on `SCRUBBED_CHILD_ENV_KEYS`.
const SCRUBBED = new Set<string>(['QWEN_SERVER_TOKEN']);

describe('scrubChildEnv (defaultSpawnChannelFactory env policy)', () => {
  it('shallow-clones source — never aliases into the live process.env', () => {
    const source = { FOO: 'bar' };
    const result = scrubChildEnv(source, SCRUBBED);
    result['MUTATED'] = 'yes';
    expect(source).not.toHaveProperty('MUTATED');
  });

  it('strips QWEN_SERVER_TOKEN from the child env', () => {
    const source = { QWEN_SERVER_TOKEN: 'super-secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('passes through non-scrubbed env vars unchanged', () => {
    const source = {
      OPENAI_API_KEY: 'sk-test',
      DASHSCOPE_API_KEY: 'ds-test',
      HOME: '/home/user',
    };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).toEqual(source);
  });

  it('overrides with a string value ADD the key', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { NEW_KEY: 'new-value' });
    expect(result['NEW_KEY']).toBe('new-value');
  });

  it('overrides with a string value REPLACE an existing key', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { PATH: '/override/bin' });
    expect(result['PATH']).toBe('/override/bin');
  });

  it('overrides with undefined value DELETE the key from the child env (PR 14 fix #4247 wenshao R5)', () => {
    const source = { STALE_VAR: 'leftover', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { STALE_VAR: undefined });
    expect(result).not.toHaveProperty('STALE_VAR');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('overrides CANNOT re-introduce a scrubbed key (defense in depth)', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: 'sneaky-attempt-via-override',
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('overrides CANNOT undo the scrub by setting undefined for a scrubbed key', () => {
    // Edge case: `undefined` value would normally delete; but for a
    // scrubbed key, the `continue` in the loop short-circuits BEFORE
    // the undefined-vs-string check. The key stays deleted (by the
    // earlier scrub pass) regardless of what overrides says.
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: undefined,
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('overrides are applied AFTER scrub — the denylist always wins', () => {
    // Verifies the documented ordering invariant: even if the scrub
    // and override touch the same key in conflicting ways, scrub wins.
    const source = { QWEN_SERVER_TOKEN: 'from-process-env' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: 'from-override',
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('empty overrides leaves scrub-only behavior intact', () => {
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {});
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('no overrides arg works the same as empty overrides', () => {
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('multi-key scrub set strips every listed key', () => {
    // Forward-compat: if a future sandboxed-agent mode expands the
    // denylist (as the WARNING comment on SCRUBBED_CHILD_ENV_KEYS
    // anticipates), this verifies the loop handles multiple keys.
    const sandboxScrub = new Set<string>([
      'QWEN_SERVER_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
    ]);
    const source = {
      QWEN_SERVER_TOKEN: 't1',
      AWS_SECRET_ACCESS_KEY: 't2',
      OPENAI_API_KEY: 't3',
      PATH: '/usr/bin',
    };
    const result = scrubChildEnv(source, sandboxScrub);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result['PATH']).toBe('/usr/bin');
  });
});
