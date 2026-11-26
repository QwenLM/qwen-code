/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  ConfigKey,
  ConfigService,
  ConfigReadiness,
  ConfigValue,
  ConfigValueListener,
  ConfigValueUnsubscribe,
} from './config-service.js';
import { EnvConfigService } from './env-config-service.js';
import { registerBuiltInFeatures } from './features/index.js';
import { runLogger } from '../utils/runLogger.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';

let configService: ConfigService | undefined;
let builtInFeaturesRegistered = false;
let startInFlight: Promise<void> | undefined;

export function installConfigService(
  nextConfigService: ConfigService,
): void {
  if (configService === nextConfigService) return;
  if (configService !== undefined) {
    throw new Error('Config source has already been installed or created');
  }
  configService = nextConfigService;
}

function prepareConfigService(): ConfigService {
  configService ??= new EnvConfigService();

  if (!builtInFeaturesRegistered) {
    registerBuiltInFeatures();
    builtInFeaturesRegistered = true;
  }

  return configService;
}

export function initializeConfigService(): Promise<void> {
  const source = prepareConfigService();
  startInFlight ??= source.start().finally(() => {
    startInFlight = undefined;
  });
  return startInFlight;
}

/** Called after authentication and before a turn reads feature policy. */
export async function ensureConfigReadyForRequest(
  options: { signal?: AbortSignal } = {},
): Promise<ConfigReadiness> {
  options.signal?.throwIfAborted();
  const source = prepareConfigService();
  const pending = source.ensureReady
    ? source.ensureReady()
    : initializeConfigService().then(
        (): ConfigReadiness => ({
          status: 'ready',
          source: 'local',
          revision: 'local',
        }),
      );
  const result = await raceWithAbortSignal(pending, options.signal);
  runLogger.debug('[config-service] Request configuration ready', result);
  return result;
}

/** The installed source, or undefined before install/initialize has run. */
export function getConfigService(): ConfigService | undefined {
  return configService;
}

/**
 * Read one configuration value.
 * Returns undefined before a source is installed: gates are read from startup
 * paths that run before the config source exists (fetch diagnostics,
 * experiments), and throwing there failed the in-flight request.
 */
export function getConfigValue(key: ConfigKey): ConfigValue | undefined {
  return getConfigService()?.getValue(key);
}

/**
 * Subscribe to future changes for one configuration key.
 * Features subscribe from registerBuiltInFeatures(), which
 * initializeConfigService() runs after a source exists, so a missing
 * source here means the wiring is wrong. Warn instead of throwing — callers sit
 * on startup paths — but keep the drop visible: a silently lost subscription
 * means that gate never receives hot updates.
 */
export function subscribeConfigValue(
  key: ConfigKey,
  listener: ConfigValueListener,
): ConfigValueUnsubscribe {
  const source = getConfigService();
  if (source === undefined) {
    runLogger.warn(
      '[config-service] Dropped subscribeConfigValue before a source was installed',
      { key },
    );
    return () => {};
  }
  return source.onValueChange(key, listener);
}

export async function stopConfigService(): Promise<void> {
  if (configService !== undefined) {
    try {
      await configService.stop();
    } finally {
      builtInFeaturesRegistered = false;
      configService = undefined;
      startInFlight = undefined;
    }
  }
}
