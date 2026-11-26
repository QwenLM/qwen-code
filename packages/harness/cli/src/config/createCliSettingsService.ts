/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isWorkspaceTrusted } from './trustedFolders.js';
import { join, relative } from 'node:path';
import {
  Storage,
  FatalConfigError,
  homedir,
  isHeadlessMode,
  coreEvents,
  runLogger,
  getFsErrorMessage,
} from '@qwen-code/core';
import { SettingsService } from '@qwen-code/resource';
import { SETTINGS_DEFAULTS } from './settingsSchema.js';
import { getSettingsZodSchema } from './settings-validation.js';
import {
  clearSettingsCache,
  mergeSettings,
  normalizeLegacyThemeNames,
  loadEnvironment,
  migrateDeprecatedSettings,
} from './settings.js';
import { logInfrastructureFailure } from './settingsPersistence.js';

const cliServicePolicies = new WeakMap<SettingsService, string>();

export type SettingsServiceFactory = () => SettingsService;
interface FactoryBinding {
  create: SettingsServiceFactory;
  previous?: FactoryBinding;
  active: boolean;
}
let settingsServiceFactory: FactoryBinding = {
  create: () => new SettingsService(),
  active: true,
};

/** Override future CLI service creation; schema reads never consume the factory. */
export function setCliSettingsServiceFactory(
  create: SettingsServiceFactory,
): () => void {
  const binding: FactoryBinding = {
    create,
    previous: settingsServiceFactory,
    active: true,
  };
  settingsServiceFactory = binding;
  return () => {
    binding.active = false;
    while (!settingsServiceFactory.active && settingsServiceFactory.previous) {
      settingsServiceFactory = settingsServiceFactory.previous;
    }
  };
}

/** Create an independent service through the currently selected product factory.
 * Environment policy stays explicit: command readers filter project .env by
 * source/trust; sessions retain CLI injection/restoration and protected keys.
 */
export function createCliSettingsService(
  options: {
    service?: SettingsService;
    environmentPolicy?: 'command' | 'session';
    sessionProjection?: boolean;
    hideUntrustedProject?: boolean;
  } = {},
): SettingsService {
  const service = options.service ?? settingsServiceFactory.create();
  const session = options.environmentPolicy === 'session';
  const sessionProjection = options.sessionProjection ?? session;
  const policy = JSON.stringify([
    session,
    sessionProjection,
    options.hideUntrustedProject ?? sessionProjection,
  ]);
  const existingPolicy = cliServicePolicies.get(service);
  if (existingPolicy !== undefined && existingPolicy !== policy) {
    throw new Error(
      'SettingsService CLI policy is incompatible; inject a service created with the same session policy',
    );
  }
  const projectPath = process.cwd();
  service.configureDefaults(
    { defaults: SETTINGS_DEFAULTS, createValidation: getSettingsZodSchema },
    {
      headless: () => isHeadlessMode(),
      environment: process.env,
      homeDir: homedir(),
      refreshProjectSources: !session,
      recomputeTrust: !sessionProjection,
      hideUntrustedProject: options.hideUntrustedProject ?? sessionProjection,
      ...(sessionProjection
        ? {
            resolveTrust: (settings, cwd, headless) =>
              isWorkspaceTrusted(settings, cwd, undefined, undefined, headless)
                .isTrusted ?? false,
            mergeSettings: (user, project, trusted, local, flag) =>
              mergeSettings(
                user,
                project,
                trusted,
                local,
                flag,
                service.getDefinition()?.schema,
              ),
            normalizeDisplaySettings: normalizeLegacyThemeNames,
            onResolved: (settings) => {
              migrateDeprecatedSettings(settings);
            },
          }
        : {}),
      ...(session
        ? {
            loadEnvironment: (settings, cwd, trustedOverride) =>
              loadEnvironment(
                settings,
                cwd,
                trustedOverride === undefined
                  ? undefined
                  : () => ({ isTrusted: trustedOverride, source: undefined }),
              ),
            createFatalError: (message: string) =>
              new FatalConfigError(
                `${message}\nPlease fix the configuration file(s) and try again.`,
              ),
          }
        : {}),
      onWriteError: (operation, error) =>
        coreEvents.emitFeedback(
          'error',
          `Failed to ${operation} settings: ${getFsErrorMessage(error)}`,
          error,
        ),
      onSettingsChanged: () => coreEvents.emitSettingsChanged(),
      onSettingsPersisted: clearSettingsCache,
      onWarning: (message) => runLogger.warn(message),
      onError: (message) => runLogger.error(message),
      onInfrastructureError: logInfrastructureFailure,
    },
  );
  if (!service.isInitialized) {
    service.initialize({
      userConfigDir: Storage.getGlobalConfigDir(),
      userSettingsPath: service.peekUserSettingsSource()?.path,
      policySettingsPath: join(
        Storage.getGlobalConfigDir(),
        'managed-settings.json',
      ),
      projectConfigDirName: relative(
        projectPath,
        new Storage(projectPath).getConfigDir(),
      ),
    });
  }
  cliServicePolicies.set(service, policy);
  return service;
}

/** The scoped read/write surface shared by commands and legacy session settings. */
export type CommandSettings = Pick<
  import('./settings.js').LoadedSettings,
  | 'merged'
  | 'isTrusted'
  | 'forScope'
  | 'setValue'
  | 'deleteValue'
  | 'updateValue'
  | 'mutateScope'
>;

/** Resolve one standalone command's settings without creating a session. */
export async function resolveCommandSettings(
  projectPath = process.cwd(),
): Promise<CommandSettings> {
  const {
    restoreLoadedEnvironment,
    getFlagSettingsInput,
    migrateDeprecatedSettings,
  } = await import('./settings.js');
  const { eagerParseSettingSourcesFlag } = await import('./flagSettings.js');
  restoreLoadedEnvironment();
  const service = await createCliSettingsService({
    hideUntrustedProject: true,
  });
  const settings = service.resolve({
    projectPath,
    sources: eagerParseSettingSourcesFlag(),
    flagSettings: getFlagSettingsInput(),
  });
  migrateDeprecatedSettings(settings);
  for (const error of settings.errors)
    runLogger.warn(`Error in ${error.path}: ${error.message}`);
  return settings;
}
