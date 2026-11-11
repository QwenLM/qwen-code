/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

import type {
  ConfigKey,
  ConfigErrorListener,
  ConfigService,
  ConfigValue,
  ConfigValueListener,
  ConfigValueUnsubscribe,
} from './config-service.js';

export interface EnvConfigServiceOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

const ENABLED_FEATURE = JSON.stringify({ enabled: true });

/** Local feature defaults; keep payloads in the format each consumer parses. */
const DEFAULT_FEATURE_VALUES: Readonly<Record<ConfigKey, string>> =
  Object.freeze({
    auto_memory: JSON.stringify({ project_enabled: true, user_enabled: true }),
    auto_memory_policy: JSON.stringify({
      enabled: true,
      extraction_every_n_turns: 1,
    }),
    auto_dream: ENABLED_FEATURE,
    auto_compact_model_threshold_caps: JSON.stringify({
      enabled: true,
      model_threshold_caps: {},
    }),
    code_mode: JSON.stringify({ enabled: true, defaultMode: 'on' }),
    codebase_backflow: JSON.stringify({ enabled: true, allowed_org_ids: [] }),
    context_window_selection: ENABLED_FEATURE,
    legacy_infer_domain_failover: ENABLED_FEATURE,
    model_request_zstd: ENABLED_FEATURE,
    model_stream_diagnostics: ENABLED_FEATURE,
    powershell_tool: ENABLED_FEATURE,
    prompt_suggestion: JSON.stringify({
      enabled: true,
      unifiedRulesEnabled: true,
      forkEnabled: true,
    }),
    read_partial: ENABLED_FEATURE,
    echo: ENABLED_FEATURE,
  });

/**
 * Default, dependency-free {@link ConfigService} backed by process.env.
 *
 * Installed as the fallback when no other source is provided (see
 * initializeConfigService()), e.g. in non-commercial builds and tests.
 * Keys map to the branded `CONFIG_<UPPER_SNAKE_CASE>` namespace. Values are read
 * live as raw strings on each getValue() call — consumers own parsing/validation.
 * Known feature gates default to enabled JSON payloads when their environment
 * variable is absent. Explicit values, including empty strings, take priority.
 * Other configuration keys remain absent so consumers keep their own defaults.
 *
 * Environment variables are treated as static: nothing observes process.env at
 * runtime, so onValueChange() listeners are registered and tracked (for correct
 * unsubscribe/stop bookkeeping) but are never invoked. Features still receive
 * their initial value because they read through getValue() first, per the
 * ConfigService contract. onError() is a no-op for the same reason —
 * reading an in-memory env object cannot fail asynchronously.
 */
export class EnvConfigService implements ConfigService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly listeners = new Map<ConfigKey, Set<ConfigValueListener>>();

  constructor(options: EnvConfigServiceOptions = {}) {
    this.environment = options.environment ?? process.env;
  }

  getValue<T = ConfigValue>(key: ConfigKey): T | undefined {
    const value = this.environment[toEnvKey(key)];
    if (value !== undefined) return value as T;
    return Object.hasOwn(DEFAULT_FEATURE_VALUES, key)
      ? (DEFAULT_FEATURE_VALUES[key] as T)
      : undefined;
  }

  onError(_listener: ConfigErrorListener): ConfigValueUnsubscribe {
    return () => {};
  }

  onValueChange(
    key: ConfigKey,
    listener: ConfigValueListener,
  ): ConfigValueUnsubscribe {
    const existingListeners = this.listeners.get(key);
    const keyListeners = existingListeners ?? new Set<ConfigValueListener>();

    if (existingListeners === undefined) {
      this.listeners.set(key, keyListeners);
    }

    keyListeners.add(listener);

    return () => {
      keyListeners.delete(listener);
      if (keyListeners.size === 0 && this.listeners.get(key) === keyListeners) {
        this.listeners.delete(key);
      }
    };
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    for (const listeners of this.listeners.values()) {
      listeners.clear();
    }
    this.listeners.clear();
    return Promise.resolve();
  }
}

function toEnvKey(key: ConfigKey): string {
  const upperSnakeKey = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
  return `${BRAND_FIXED_ENV_PREFIX}CONFIG_${upperSnakeKey}`;
}
