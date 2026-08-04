/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential provider abstraction for model resolution.
 *
 * Core's model config ({@link ModelsConfig}) and LLM client
 * ({@link BaseLlmClient}) read provider API keys through this interface
 * instead of `process.env` directly. This lets the daemon install a
 * store-backed provider that keeps custom-provider credentials
 * (`QWEN_CUSTOM_API_KEY_*`) out of its OS-visible `process.env` (so
 * same-UID `ps eww` cannot recover them) while still resolving them for
 * model configuration.
 *
 * The provider is injected per-ModelsConfig instance (NOT a process-wide
 * global), so concurrent daemons in the same process each carry their own
 * credential resolver. Non-daemon contexts (interactive CLI, ACP child
 * processes) use the default provider which reads from `process.env`.
 */

export interface CredentialProvider {
  get(key: string): string | undefined;
}

/**
 * Mutable credential store for daemon-private custom-provider keys.
 * The store is the single source of truth for `QWEN_CUSTOM_API_KEY_*`
 * in the daemon process. Env loading (`loadEnvironment`/`reloadEnvironment`)
 * and provider install (`applyProviderInstallPlan`) redirect custom-key
 * writes to the store instead of `process.env`, ensuring keys never
 * (re-)appear in the OS-visible environment after boot-time scrub.
 */
export interface CredentialStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
  /** Snapshot all key-value pairs as a plain object (for ACP env injection). */
  snapshot(): Record<string, string>;
}

const CUSTOM_KEY_PATTERN = /^QWEN_CUSTOM_API_KEY_.+$/i;

export function isCustomCredentialKey(key: string): boolean {
  return CUSTOM_KEY_PATTERN.test(key);
}

/**
 * Normalize a custom-credential key to canonical uppercase form.
 *
 * The generated env key (`generateCustomEnvKey`) is always uppercase, but on
 * Windows `process.env` is case-insensitive so a key may appear with mixed
 * casing (e.g. from a hand-edited `.env`). Normalizing to uppercase on all
 * store operations ensures that a key captured as `qwen_custom_api_key_foo`
 * is later found by a lookup for `QWEN_CUSTOM_API_KEY_FOO`.
 *
 * Non-custom keys are returned unchanged.
 */
function normalizeCredentialKey(key: string): string {
  return isCustomCredentialKey(key) ? key.toUpperCase() : key;
}

/**
 * Create a mutable credential store, optionally seeded from `source`.
 * Custom-credential keys are normalized to uppercase on seed.
 */
export function createCredentialStore(
  source?: Readonly<Record<string, string | undefined>>,
): CredentialStore {
  const map = new Map<string, string>();
  if (source) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        map.set(normalizeCredentialKey(key), value);
      }
    }
  }
  return {
    get: (key) => map.get(normalizeCredentialKey(key)),
    set: (key, value) => {
      map.set(normalizeCredentialKey(key), value);
    },
    delete: (key) => {
      map.delete(normalizeCredentialKey(key));
    },
    has: (key) => map.has(normalizeCredentialKey(key)),
    snapshot: () => Object.fromEntries(map),
  };
}

/**
 * Default provider: reads all keys from `process.env`. Used by non-daemon
 * contexts (interactive CLI, ACP child processes that receive credentials
 * via env injection).
 */
export const defaultCredentialProvider: CredentialProvider = {
  get: (key) => process.env[key],
};

/**
 * Create a store-backed provider for the daemon. Custom-provider keys
 * (`QWEN_CUSTOM_API_KEY_*`) are resolved exclusively from the store —
 * never from `process.env` — so even if a custom key somehow re-enters
 * `process.env` the provider ignores it. Non-custom keys (e.g.
 * `OPENAI_API_KEY`) fall through to `process.env`.
 */
export function createCredentialProvider(
  store: CredentialStore,
): CredentialProvider {
  return {
    get: (key) => {
      if (isCustomCredentialKey(key)) {
        return store.get(key);
      }
      return process.env[key];
    },
  };
}

/**
 * Resolve a credential via an optional provider, falling back to
 * `process.env`. Used by call sites that receive a `Config` (and thus
 * a `ModelsConfig` with a `credentialProvider`) but may be in a context
 * where no provider is installed.
 */
export function resolveCredential(
  provider: CredentialProvider | undefined,
  key: string,
): string | undefined {
  if (provider) {
    return provider.get(key);
  }
  return process.env[key];
}

/**
 * Read an env var, routing `QWEN_CUSTOM_API_KEY_*` to the store when one is
 * provided (daemon context). Without a store, reads from `process.env` —
 * the non-daemon (CLI / ACP child) behavior.
 */
export function readEnvKey(
  key: string,
  store?: CredentialStore,
): string | undefined {
  if (store && isCustomCredentialKey(key)) {
    return store.get(key);
  }
  return process.env[key];
}

/**
 * Write an env var, routing `QWEN_CUSTOM_API_KEY_*` to the store when one is
 * provided (daemon context). This is the single redirect point that keeps
 * custom-provider credentials out of the daemon's OS-visible `process.env`
 * even when env loading (`loadEnvironment`/`reloadEnvironment`) or provider
 * install (`applyProviderInstallPlan`) runs after boot-time scrub.
 */
export function writeEnvKey(
  key: string,
  value: string,
  store?: CredentialStore,
): void {
  if (store && isCustomCredentialKey(key)) {
    store.set(key, value);
  } else {
    process.env[key] = value;
  }
}

/**
 * Delete an env var, routing `QWEN_CUSTOM_API_KEY_*` deletions to the store
 * when one is provided (daemon context).
 */
export function deleteEnvKey(key: string, store?: CredentialStore): void {
  if (store && isCustomCredentialKey(key)) {
    store.delete(key);
  } else {
    delete process.env[key];
  }
}
