/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Identifier of one configuration value within the service. */
export type ConfigKey = string;

/** Raw configuration payload; each consumer owns its runtime validation. */
export type ConfigValue = unknown;

/** Request readiness is distinct from a transport merely having started. */
export type ConfigReadiness =
  | { status: 'ready'; source: 'remote' | 'local'; revision: string }
  | {
      status: 'degraded';
      source: 'cache' | 'defaults';
      reason: string;
      revision: string;
    }
  | { status: 'skipped'; reason: string };

/**
 * Releases a previously registered listener.
 *
 * Implementations must make this function idempotent: it is safe to call more
 * than once, including after the source has stopped.
 */
export type ConfigValueUnsubscribe = () => void;

/** Receives an update for one exact configuration key. */
export type ConfigValueListener = (value: ConfigValue | undefined) => void;

/** Receives asynchronous errors raised after a source has started. */
export type ConfigErrorListener = (error: Error) => void;

/**
 * Configuration value access, subscriptions, readiness, and lifecycle contract.
 *
 * Implementations may read from process environment, local files, or a remote
 * service. This contract does not load or merge user/project settings files.
 * Consumers must not rely on a listener receiving an immediate replay
 * of the current value: read with getValue() first, then observe future changes.
 * stop() invalidates all outstanding subscriptions.
 */
export interface ConfigService {
  /** Prepare the source. Safe to call more than once. */
  start(): Promise<void>;

  /**
   * Join the current identity's bounded initial load, or return its settled
   * fallback. Optional for local/custom sources whose start() already suffices.
   * Implementations own the shared operation; cancelling one waiter must not
   * cancel other requests' initialization.
   */
  ensureReady?(): Promise<ConfigReadiness>;

  /** Releases source-owned resources and invalidates value-change subscriptions. */
  stop(): Promise<void>;

  /** Return the current raw value for one key, or undefined when it is absent. */
  getValue<T = ConfigValue>(key: ConfigKey): T | undefined;

  /**
   * Resolve a fresh value using credentials captured for this request, without
   * trusting cached/default values. Optional: sources unable to prove freshness
   * leave this absent. Consumers must verify their identity is still current.
   */
  resolveValue?(key: ConfigKey): Promise<ConfigValue | undefined>;

  /**
   * Observe future changes to one exact key.
   *
   * Implementations may report undefined when a value is removed or becomes
   * unavailable. The caller owns the resulting fallback policy.
   */
  onValueChange(
    key: ConfigKey,
    listener: ConfigValueListener,
  ): ConfigValueUnsubscribe;

  /**
   * Observe non-fatal, source-owned operational errors emitted after start()
   * resolves. This does not replace errors returned by lifecycle operations.
   */
  onError(listener: ConfigErrorListener): ConfigValueUnsubscribe;
}
