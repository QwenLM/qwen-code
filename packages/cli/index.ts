/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Keep this entry lightweight: importing the CLI must not start it or load Core.
export { runCli } from './src/startup/runCli.js';
export { runWorkerCli } from './src/worker/workerRuntime.js';
export {
  createInsightsCommand,
  insightsCommand,
  type InsightsCommandOptions,
} from './src/ui/commands/insightsCommand.js';
export type { CliOptions } from './src/startup/runCli.js';
export type {
  AppFramework,
  FrameworkInitInput,
  FrameworkMode,
} from './src/framework/appFramework.js';
export type { CliFrameworkFactory } from './src/startup/frameworkFactory.js';
export type * from './src/app-plugins/types.js';

export { CommandKind } from './src/ui/commands/types.js';
export type {
  SlashCommand,
  CommandContext,
  SlashCommandActionReturn,
  LocalCommandResultReturn,
} from './src/ui/commands/types.js';
export { getUiLocale, onUiLocaleChange } from './src/ui/i18n/uiLocaleState.js';
export {
  onUpdateSuccess,
  updateEventEmitter,
} from './src/utils/updateEventEmitter.js';

/**
 * Settings helpers for product commands that also run outside the TUI, loaded
 * on demand so the package root stays free of Core.
 */
export async function loadCliRuntimeHelpers() {
  const [
    { persistentState },
    { SettingScope, setProcessOnlyEnvironmentVariables },
    { AppFramework },
  ] = await Promise.all([
    import('./src/utils/persistentState.js'),
    import('./src/config/settings.js'),
    import('./src/framework/appFramework.js'),
  ]);
  return {
    persistentState,
    SettingScope,
    setProcessOnlyEnvironmentVariables,
    AppFramework,
  };
}

/** Reuse the shared text input reader without loading Core at package import. */
export async function readStdin(): Promise<string> {
  const { readStdin: read } = await import('./src/utils/readStdin.js');
  return read();
}

/** Preserve the CLI's standard error result format for product commands. */
export async function buildErrorResultMessage(
  ...args: Parameters<
    typeof import('./src/utils/errors.js').buildErrorResultMessage
  >
) {
  const { buildErrorResultMessage: build } = await import(
    './src/utils/errors.js'
  );
  return build(...args);
}

/** Reuse the existing artifact registry and state format during host recovery.
 * Keep these Core-backed modules out of the lightweight package entry.
 */
export async function loadSessionArtifactHelpers() {
  const [registry, state, persistence, parser] = await Promise.all([
    import('./src/session/artifacts/artifactRegistry.js'),
    import('./src/session/artifacts/artifactRegistryState.js'),
    import('./src/session/artifacts/artifactRegistryStore.js'),
    import('./src/session/artifacts/sdkArtifactResolver.js'),
  ]);
  return {
    ArtifactRegistry: registry.ArtifactRegistry,
    serializeArtifactRegistryState: state.serializeArtifactRegistryState,
    SessionStateArtifactRegistryPersistence:
      persistence.SessionStateArtifactRegistryPersistence,
    parseResolveSessionArtifactsResponse:
      parser.parseResolveSessionArtifactsResponse,
  };
}

/** Project the session model catalog on demand. */
export async function projectSessionListedModels(
  models: readonly import('@qwen-code/core').Model[],
): Promise<import('./src/session/sessionModels.js').SessionModelInfo[]> {
  const { projectSessionListedModels: project } = await import(
    './src/session/buildSessionModelList.js'
  );
  return project(models);
}

/** Read the shared session permission policy without loading it at CLI import time. */
export async function computeAvailablePermissionModes(): Promise<
  import('./src/session/permissionMode.js').SdkPermissionMode[]
> {
  const { computeAvailablePermissionModes: compute } = await import(
    './src/session/permissionMode.js'
  );
  return compute();
}

export async function getTranscriptGitBranch(cwd: string): Promise<string> {
  const { getTranscriptGitBranch: getBranch } = await import(
    './src/utils/transcriptMetadata.js'
  );
  return getBranch(cwd);
}

// Load the plugin lifecycle only when executing a terminal action.
export async function runTerminalCommand(
  ...args: Parameters<
    typeof import('./src/app-plugins/commands.js').runTerminalCommand
  >
): Promise<void> {
  const { runTerminalCommand: execute } = await import(
    './src/app-plugins/commands.js'
  );
  return execute(...args);
}

/** Exit through the host cleanup pipeline so cleanup and hooks still run. */
export async function exitCli(
  ...args: Parameters<typeof import('./src/utils/exitCli.js').exitCli>
): Promise<void> {
  const { exitCli: exit } = await import('./src/utils/exitCli.js');
  return exit(...args);
}

// Native terminal commands share the host's Commander classes and error identity.
export { Command, Option } from '@commander-js/extra-typings';
export type { CommandUnknownOpts } from '@commander-js/extra-typings';

export type { CliWelcomeHeaderProps } from './src/ui/components/WelcomeHeaderProps.js';
export type CliWelcomeHeader = import('react').ComponentType<
  import('./src/ui/components/WelcomeHeaderProps.js').CliWelcomeHeaderProps
>;
