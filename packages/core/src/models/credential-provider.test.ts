/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  createCredentialStore,
  createCredentialProvider,
  defaultCredentialProvider,
  resolveCredential,
  isCustomCredentialKey,
  readEnvKey,
  writeEnvKey,
  deleteEnvKey,
} from './credential-provider.js';

const SET_KEYS: string[] = [];
afterEach(() => {
  for (const key of SET_KEYS) {
    delete process.env[key];
  }
  SET_KEYS.length = 0;
});

function trackEnv(key: string, value: string): void {
  process.env[key] = value;
  SET_KEYS.push(key);
}

describe('isCustomCredentialKey', () => {
  it('matches QWEN_CUSTOM_API_KEY_* keys', () => {
    expect(isCustomCredentialKey('QWEN_CUSTOM_API_KEY_FOO')).toBe(true);
    expect(isCustomCredentialKey('QWEN_CUSTOM_API_KEY_MY_PROVIDER')).toBe(true);
  });

  it('matches case-insensitively (Windows mixed-case)', () => {
    expect(isCustomCredentialKey('qwen_custom_api_key_foo')).toBe(true);
    expect(isCustomCredentialKey('Qwen_Custom_Api_Key_Foo')).toBe(true);
    expect(isCustomCredentialKey('QWEN_custom_API_key_FOO')).toBe(true);
  });

  it('rejects non-custom keys', () => {
    expect(isCustomCredentialKey('OPENAI_API_KEY')).toBe(false);
    expect(isCustomCredentialKey('QWEN_CUSTOM_API_KEY')).toBe(false);
    expect(isCustomCredentialKey('')).toBe(false);
  });
});

describe('defaultCredentialProvider', () => {
  it('reads from process.env', () => {
    const key = `QWEN_TEST_CRED_${Date.now()}`;
    trackEnv(key, 'secret-value');
    expect(defaultCredentialProvider.get(key)).toBe('secret-value');
  });

  it('returns undefined for missing keys', () => {
    expect(defaultCredentialProvider.get('QWEN_MISSING_KEY')).toBeUndefined();
  });
});

describe('resolveCredential', () => {
  it('falls back to process.env when provider is undefined', () => {
    const key = `QWEN_TEST_FALLBACK_${Date.now()}`;
    trackEnv(key, 'env-value');
    expect(resolveCredential(undefined, key)).toBe('env-value');
  });

  it('uses the provided provider', () => {
    const provider = createCredentialProvider(
      createCredentialStore({ QWEN_CUSTOM_API_KEY_X: 'store-value' }),
    );
    expect(resolveCredential(provider, 'QWEN_CUSTOM_API_KEY_X')).toBe(
      'store-value',
    );
  });
});

describe('createCredentialStore', () => {
  it('seeds from source, ignoring non-string values', () => {
    const store = createCredentialStore({
      A: '1',
      B: undefined,
      C: '3',
    });
    expect(store.get('A')).toBe('1');
    expect(store.get('B')).toBeUndefined();
    expect(store.get('C')).toBe('3');
  });

  it('supports set / delete / has / snapshot', () => {
    const store = createCredentialStore();
    expect(store.has('K')).toBe(false);
    store.set('K', 'v');
    expect(store.has('K')).toBe(true);
    expect(store.get('K')).toBe('v');
    store.delete('K');
    expect(store.has('K')).toBe(false);
    expect(store.get('K')).toBeUndefined();
  });

  it('snapshot returns a plain object copy', () => {
    const store = createCredentialStore({ A: '1' });
    store.set('B', '2');
    const snap = store.snapshot();
    expect(snap).toEqual({ A: '1', B: '2' });
    // Mutating the snapshot does not affect the store.
    snap['A'] = 'mutated';
    expect(store.get('A')).toBe('1');
  });
});

describe('createCredentialProvider', () => {
  it('resolves custom keys exclusively from the store', () => {
    // Even if process.env has the key, the store-backed provider ignores it.
    trackEnv('QWEN_CUSTOM_API_KEY_TEST', 'env-value');
    const store = createCredentialStore();
    const provider = createCredentialProvider(store);
    expect(provider.get('QWEN_CUSTOM_API_KEY_TEST')).toBeUndefined();

    store.set('QWEN_CUSTOM_API_KEY_TEST', 'store-value');
    expect(provider.get('QWEN_CUSTOM_API_KEY_TEST')).toBe('store-value');
  });

  it('resolves non-custom keys from process.env', () => {
    trackEnv('OPENAI_API_KEY', 'openai-key');
    const provider = createCredentialProvider(createCredentialStore());
    expect(provider.get('OPENAI_API_KEY')).toBe('openai-key');
  });

  it('store mutation is reflected (post-boot writes reach the provider)', () => {
    const store = createCredentialStore();
    const provider = createCredentialProvider(store);
    expect(provider.get('QWEN_CUSTOM_API_KEY_NEW')).toBeUndefined();
    store.set('QWEN_CUSTOM_API_KEY_NEW', 'late-key');
    expect(provider.get('QWEN_CUSTOM_API_KEY_NEW')).toBe('late-key');
    store.delete('QWEN_CUSTOM_API_KEY_NEW');
    expect(provider.get('QWEN_CUSTOM_API_KEY_NEW')).toBeUndefined();
  });
});

describe('daemon isolation (concurrent providers)', () => {
  it('two store-backed providers do not share credentials', () => {
    const storeA = createCredentialStore();
    const storeB = createCredentialStore();
    const providerA = createCredentialProvider(storeA);
    const providerB = createCredentialProvider(storeB);

    storeA.set('QWEN_CUSTOM_API_KEY_DAEMON', 'key-a');
    storeB.set('QWEN_CUSTOM_API_KEY_DAEMON', 'key-b');

    expect(providerA.get('QWEN_CUSTOM_API_KEY_DAEMON')).toBe('key-a');
    expect(providerB.get('QWEN_CUSTOM_API_KEY_DAEMON')).toBe('key-b');

    // Removing from one store does not affect the other.
    storeA.delete('QWEN_CUSTOM_API_KEY_DAEMON');
    expect(providerA.get('QWEN_CUSTOM_API_KEY_DAEMON')).toBeUndefined();
    expect(providerB.get('QWEN_CUSTOM_API_KEY_DAEMON')).toBe('key-b');
  });
});

describe('writeEnvKey / readEnvKey / deleteEnvKey (post-boot write redirection)', () => {
  // These helpers are the single redirect point that loadEnvironment,
  // reloadEnvironment, and applyProviderInstallPlan use to keep
  // QWEN_CUSTOM_API_KEY_* out of process.env after boot-time scrub.
  const ENV_KEYS = [
    'QWEN_CUSTOM_API_KEY_REDIRECT',
    'OPENAI_API_KEY',
    'QWEN_CUSTOM_API_KEY_MIXED',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('writeEnvKey routes custom keys to store, not process.env', () => {
    const store = createCredentialStore();
    writeEnvKey('QWEN_CUSTOM_API_KEY_REDIRECT', 'secret', store);
    expect(store.get('QWEN_CUSTOM_API_KEY_REDIRECT')).toBe('secret');
    expect(process.env['QWEN_CUSTOM_API_KEY_REDIRECT']).toBeUndefined();
  });

  it('writeEnvKey routes non-custom keys to process.env', () => {
    const store = createCredentialStore();
    writeEnvKey('OPENAI_API_KEY', 'sk-xxx', store);
    expect(process.env['OPENAI_API_KEY']).toBe('sk-xxx');
    expect(store.get('OPENAI_API_KEY')).toBeUndefined();
  });

  it('writeEnvKey without store always writes to process.env', () => {
    writeEnvKey('QWEN_CUSTOM_API_KEY_REDIRECT', 'secret');
    expect(process.env['QWEN_CUSTOM_API_KEY_REDIRECT']).toBe('secret');
  });

  it('readEnvKey reads custom keys from store, not process.env', () => {
    const store = createCredentialStore();
    store.set('QWEN_CUSTOM_API_KEY_REDIRECT', 'store-val');
    process.env['QWEN_CUSTOM_API_KEY_REDIRECT'] = 'env-val';
    expect(readEnvKey('QWEN_CUSTOM_API_KEY_REDIRECT', store)).toBe('store-val');
  });

  it('readEnvKey reads non-custom keys from process.env', () => {
    const store = createCredentialStore();
    process.env['OPENAI_API_KEY'] = 'sk-xxx';
    expect(readEnvKey('OPENAI_API_KEY', store)).toBe('sk-xxx');
  });

  it('readEnvKey without store reads from process.env', () => {
    process.env['QWEN_CUSTOM_API_KEY_REDIRECT'] = 'env-val';
    expect(readEnvKey('QWEN_CUSTOM_API_KEY_REDIRECT')).toBe('env-val');
  });

  it('deleteEnvKey removes custom keys from store, not process.env', () => {
    const store = createCredentialStore();
    store.set('QWEN_CUSTOM_API_KEY_REDIRECT', 'store-val');
    process.env['QWEN_CUSTOM_API_KEY_REDIRECT'] = 'env-val';
    deleteEnvKey('QWEN_CUSTOM_API_KEY_REDIRECT', store);
    expect(store.get('QWEN_CUSTOM_API_KEY_REDIRECT')).toBeUndefined();
    // process.env value is untouched by the store delete.
    expect(process.env['QWEN_CUSTOM_API_KEY_REDIRECT']).toBe('env-val');
    delete process.env['QWEN_CUSTOM_API_KEY_REDIRECT'];
  });

  it('deleteEnvKey removes non-custom keys from process.env', () => {
    process.env['OPENAI_API_KEY'] = 'sk-xxx';
    deleteEnvKey('OPENAI_API_KEY', createCredentialStore());
    expect(process.env['OPENAI_API_KEY']).toBeUndefined();
  });

  it('post-boot write then read round-trips through the store', () => {
    const store = createCredentialStore();
    // Simulate loadEnvironment writing a new key after boot scrub.
    writeEnvKey('QWEN_CUSTOM_API_KEY_REDIRECT', 'late-key', store);
    // Provider resolves it via the store.
    const provider = createCredentialProvider(store);
    expect(provider.get('QWEN_CUSTOM_API_KEY_REDIRECT')).toBe('late-key');
    // process.env stays clean.
    expect(process.env['QWEN_CUSTOM_API_KEY_REDIRECT']).toBeUndefined();
  });
});

describe('mixed-case key handling (Windows)', () => {
  // process.env on Windows is case-insensitive, so a key may appear with
  // non-standard casing. The store normalizes custom-credential keys to
  // uppercase so lookups via the canonical generated key always match.
  const MIXED_KEYS = ['qwen_custom_api_key_foo', 'Qwen_Custom_Api_Key_Bar'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MIXED_KEYS) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of MIXED_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('store normalizes mixed-case keys to uppercase on seed', () => {
    const store = createCredentialStore({
      qwen_custom_api_key_foo: 'val-foo',
      Qwen_Custom_Api_Key_Bar: 'val-bar',
    });
    // Lookup via canonical uppercase key works.
    expect(store.get('QWEN_CUSTOM_API_KEY_FOO')).toBe('val-foo');
    expect(store.get('QWEN_CUSTOM_API_KEY_BAR')).toBe('val-bar');
    // Mixed-case lookup also works (normalized internally).
    expect(store.get('qwen_custom_api_key_foo')).toBe('val-foo');
  });

  it('store.set normalizes mixed-case keys to uppercase', () => {
    const store = createCredentialStore();
    store.set('qwen_custom_api_key_foo', 'val');
    expect(store.get('QWEN_CUSTOM_API_KEY_FOO')).toBe('val');
    expect(store.has('QWEN_CUSTOM_API_KEY_FOO')).toBe(true);
  });

  it('store.delete normalizes mixed-case keys', () => {
    const store = createCredentialStore();
    store.set('QWEN_CUSTOM_API_KEY_FOO', 'val');
    store.delete('qwen_custom_api_key_foo');
    expect(store.get('QWEN_CUSTOM_API_KEY_FOO')).toBeUndefined();
  });

  it('snapshot returns uppercase keys', () => {
    const store = createCredentialStore();
    store.set('qwen_custom_api_key_foo', 'val');
    const snap = store.snapshot();
    expect(snap['QWEN_CUSTOM_API_KEY_FOO']).toBe('val');
    expect(snap['qwen_custom_api_key_foo']).toBeUndefined();
  });

  it('writeEnvKey/readEnvKey normalize mixed-case keys to store', () => {
    const store = createCredentialStore();
    writeEnvKey('qwen_custom_api_key_foo', 'secret', store);
    // process.env is untouched.
    expect(process.env['qwen_custom_api_key_foo']).toBeUndefined();
    // Read via canonical uppercase key.
    expect(readEnvKey('QWEN_CUSTOM_API_KEY_FOO', store)).toBe('secret');
    // Read via mixed-case key also works.
    expect(readEnvKey('qwen_custom_api_key_foo', store)).toBe('secret');
  });

  it('createCredentialProvider resolves mixed-case lookups via store', () => {
    const store = createCredentialStore();
    store.set('QWEN_CUSTOM_API_KEY_FOO', 'val');
    const provider = createCredentialProvider(store);
    // Canonical uppercase lookup.
    expect(provider.get('QWEN_CUSTOM_API_KEY_FOO')).toBe('val');
    // Mixed-case lookup also resolves from store.
    expect(provider.get('qwen_custom_api_key_foo')).toBe('val');
  });
});
