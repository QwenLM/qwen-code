/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MCPServerConfig,
  ExtensionInstallMetadata,
} from '../config/config.js';
import { Config } from '../config/config.js';
import type { SkillConfig } from '../skills/types.js';
import type { SubagentConfig } from '../subagents/types.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import type { HookEventName, HookDefinition } from '../hooks/types.js';
import { Storage } from '../config/storage.js';
import {
  logExtensionEnable,
  logExtensionInstallEvent,
  logExtensionUninstall,
  logExtensionDisable,
} from '../telemetry/loggers.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  EXTENSIONS_CONFIG_FILENAME,
  EXTENSION_SETTINGS_FILENAME,
  INSTALL_METADATA_FILENAME,
  recursivelyHydrateStrings,
  performVariableReplacement,
} from './variables.js';
import {
  isRegularFile,
  readExtensionManifest,
  realPathWithin,
  readExtraJsonFile,
} from './path-confinement.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';
import type { JsonValue } from './variables.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import {
  checkForExtensionUpdate,
  cloneFromGit,
  downloadFromArchiveUrl,
  downloadFromGitHubRelease,
  downloadPublicGitHubArchiveFallback,
  extractArchiveFile,
  isSupportedArchivePath,
  parseGitHubRepoForReleases,
  shouldUsePublicGitHubArchiveFallback,
} from './github.js';
import { assertDirectorySymlinksAreSafe } from './archive-safety.js';
import { downloadFromNpmRegistry } from './npm.js';
import { redactUrlCredentials } from './redaction.js';
import type { LoadExtensionContext } from './variableSchema.js';
import { Override, type AllExtensionsEnablementConfig } from './override.js';
import {
  ExtensionPreferencesStore,
  type ExtensionScope,
} from './extensionPreferences.js';
import {
  SourceRegistryStore,
  discoverPlugins,
  parseExtensionSourceType,
  type ExtensionSource,
  type DiscoveredPlugin,
} from './sourceRegistry.js';
import {
  loadMarketplaceConfigFromSource,
  parseInstallSource,
} from './marketplace.js';
import { convertCompatibleExtension } from './extension-converter.js';
import { glob } from 'glob';
import { createHash, randomBytes } from 'node:crypto';
import { ExtensionStorage } from './storage.js';
import {
  resolveExtensionConfigLocale,
  type RawExtensionConfig,
  type LocalizableString,
} from './i18n.js';
import {
  getEnvContents,
  maybePromptForSettings,
  promptForSetting,
  type PreparedExtensionSettingsMutation,
  validateExtensionSettingEnvVars,
} from './extensionSettings.js';
import type {
  ExtensionSetting,
  ResolvedExtensionSetting,
} from './extensionSettings.js';
import type {
  ExtensionOriginSource,
  TelemetrySettings,
} from '../config/config.js';
import { logExtensionUpdateEvent } from '../telemetry/loggers.js';
import {
  ExtensionDisableEvent,
  ExtensionEnableEvent,
  ExtensionInstallEvent,
  ExtensionUninstallEvent,
  ExtensionUpdateEvent,
} from '../telemetry/types.js';
import { loadSkillsFromDir } from '../skills/skill-load.js';
import { loadSubagentFromDir } from '../subagents/subagent-manager.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { refreshExtensionRuntime } from './extension-runtime-refresh.js';
import {
  ExtensionStore,
  type ExtensionActivation,
  type ExtensionActivationResult,
  type ExtensionIdentity,
  type ExtensionStoreSnapshot,
  type InitialExtensionActivation,
  type WorkspaceActivation,
} from './extension-store.js';
import {
  AGENT_PLUGIN_MANIFEST,
  getAgentPluginSchemaStatus,
  loadAgentPluginManifest,
  loadAgentPluginMcpServers,
  loadAgentPluginSkills,
} from './agent-plugins-v1/index.js';
import { resolveContainedExistingPath } from './agent-plugins-v1/paths.js';
import {
  prepareStoredGitCredential,
  prepareStoredGitCredentialDeletion,
  removeGitCredentialSelector,
  resolveStoredGitCredential,
  writeGitCredentialSelector,
  type ExtensionGitCredential,
  type ExtensionGitCredentialSelector,
  type PreparedStoredGitCredential,
} from './extension-git-credentials.js';
import type { TokenStorageType } from '../mcp/token-storage/types.js';

const debugLogger = createDebugLogger('EXTENSIONS');

export type ExtensionPackageFormat = 'qwen' | 'agent-plugins-v1';

interface LoadedExtensionManifest {
  format: ExtensionPackageFormat;
  config: ExtensionConfig;
}

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum SettingScope {
  User = 'User',
  Workspace = 'Workspace',
  System = 'System',
  SystemDefaults = 'SystemDefaults',
}

export interface ExtensionChannelConfig {
  /** Relative path to JS entry point (must export `plugin: ChannelPlugin`) */
  entry: string;
  /** Human-readable name for CLI output */
  displayName?: string;
  /** Extra config fields required beyond the shared ChannelConfig fields */
  requiredConfigFields?: string[];
}

export interface Extension {
  id: string;
  name: string;
  displayName?: string;
  version: string;
  isActive: boolean;
  path: string;
  config: ExtensionConfig;
  format?: ExtensionPackageFormat;
  installMetadata?: ExtensionInstallMetadata;
  /** Out-of-band link trust grant — never derived from the extension's own payload. */
  trustedLinkSource?: string;

  mcpServers?: Record<string, MCPServerConfig>;
  contextFiles: string[];
  settings?: ExtensionSetting[];
  resolvedSettings?: ResolvedExtensionSetting[];
  commands?: string[];
  skills?: SkillConfig[];
  agents?: SubagentConfig[];
  hooks?: { [K in HookEventName]?: HookDefinition[] };
  channels?: Record<string, ExtensionChannelConfig>;
}

export interface ExtensionConfig {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  /** Original localizable values before resolution, for runtime re-resolution on language change. */
  _rawLocalizable?: {
    displayName?: LocalizableString;
    description?: LocalizableString;
  };
  mcpServers?: Record<string, MCPServerConfig>;
  lspServers?: string | Record<string, unknown>;
  contextFileName?: string | string[];
  commands?: string | string[];
  skills?: string | string[];
  agents?: string | string[];
  settings?: ExtensionSetting[];
  hooks?: string | { [K in HookEventName]?: HookDefinition[] };
  channels?: Record<string, ExtensionChannelConfig>;
}

export interface ExtensionUpdateInfo {
  name: string;
  originalVersion: string;
  updatedVersion: string;
  warnings?: Array<{ code: string; error: string }>;
}

export interface ExtensionCommittedWithWarningsError extends Error {
  code: 'extension_committed_with_warnings';
  committed: true;
  identity: { id: string; name: string };
  warnings: ReadonlyArray<{ code: string; error: string }>;
}

export function isExtensionCommittedWithWarningsError(
  error: unknown,
): error is ExtensionCommittedWithWarningsError {
  const candidate = error as Partial<ExtensionCommittedWithWarningsError>;
  return (
    error instanceof Error &&
    candidate.code === 'extension_committed_with_warnings' &&
    candidate.committed === true &&
    typeof candidate.identity?.id === 'string' &&
    typeof candidate.identity.name === 'string' &&
    Array.isArray(candidate.warnings)
  );
}

export interface ExtensionUpdateStatus {
  status: ExtensionUpdateState;
  processed: boolean;
}

export enum ExtensionUpdateState {
  CHECKING_FOR_UPDATES = 'checking for updates',
  UPDATED_NEEDS_RESTART = 'updated, needs restart',
  UPDATED_WITH_WARNINGS = 'updated with warnings',
  UPDATING = 'updating',
  UPDATED = 'updated',
  UPDATE_AVAILABLE = 'update available',
  UP_TO_DATE = 'up to date',
  ERROR = 'error',
  NOT_UPDATABLE = 'not updatable',
  UNKNOWN = 'unknown',
}

export type ExtensionRequestOptions = {
  extensionConfig: ExtensionConfig;
  originSource: ExtensionOriginSource;
  commands?: string[];
  skills?: SkillConfig[];
  subagents?: SubagentConfig[];
  previousExtensionConfig?: ExtensionConfig;
  previousCommands?: string[];
  previousSkills?: SkillConfig[];
  previousSubagents?: SubagentConfig[];
};

export interface ExtensionManagerOptions {
  /** Working directory for project-level extensions */
  workspaceDir?: string;
  /** Override list of enabled extension names (from CLI -e flag) */
  enabledExtensionOverrides?: string[];
  isWorkspaceTrusted: boolean;
  /** Locale code for resolving localizable fields (e.g., 'en', 'zh'). Defaults to 'en'. */
  locale?: string;
  telemetrySettings?: TelemetrySettings;
  config?: Config;
  requestConsent?: (options?: ExtensionRequestOptions) => Promise<void>;
  requestSetting?: (setting: ExtensionSetting) => Promise<string>;
  requestChoicePlugin?: (
    marketplace: ClaudeMarketplaceConfig,
  ) => Promise<string>;
  extensionStore?: ExtensionStore;
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'];
}

export interface PrepareExtensionInstallOptions {
  installMetadata: ExtensionInstallMetadata;
  initialActivation: InitialExtensionActivation;
  gitCredential?: ExtensionGitCredential;
  localSourcePath?: string;
  requestConsent?: (options?: ExtensionRequestOptions) => Promise<void>;
  requestSetting?: (setting: ExtensionSetting) => Promise<string>;
  cwd?: string;
  signal?: AbortSignal;
}

export interface PrepareExtensionUpdateOptions {
  extension: Extension;
  signal?: AbortSignal;
}

export interface PreparedExtensionMutation {
  readonly operation: 'install' | 'update';
  readonly identity: { id: string; name: string };
  readonly version: string;
  readonly expectedArtifactGeneration?: number;
  /** @internal */
  readonly installMetadata: ExtensionInstallMetadata;
  /** @internal */
  readonly config: ExtensionConfig;
  /** @internal */
  readonly previousConfig?: ExtensionConfig;
  /** @internal */
  readonly initialActivation: InitialExtensionActivation;
  /** @internal */
  readonly stagingDirectory: string;
  /** @internal */
  readonly destinationDirectory: string;
  /** @internal */
  readonly currentDir: string;
  /** @internal */
  readonly cleanupPaths: readonly string[];
  /** @internal */
  readonly commitSettings?: () => Promise<void>;
  /** @internal */
  readonly discardSettings?: () => Promise<void>;
  /** @internal */
  readonly credentialStorage?: TokenStorageType;
  /** @internal */
  readonly commitGitCredential?: () => void;
  /** @internal */
  readonly discardGitCredential?: () => Promise<void>;
  /** @internal */
  settingsActivated: boolean;
  /** @internal */
  gitCredentialActivated: boolean;
  /** @internal */
  consumed: boolean;
  /** @internal */
  disposed: boolean;
}

export interface CommittedExtensionMutation {
  identity: { id: string; name: string };
  version: string;
  generation: number;
  extension?: Extension;
  warnings?: Array<{ code: string; error: string }>;
}

export interface ExtensionStoreMutationResult extends ExtensionStoreSnapshot {
  warnings?: Array<{ code: string; error: string }>;
  updated?: boolean;
}

export type ExtensionCommitCallback = (generation: number) => void;

export class PreparedExtensionConsumedError extends Error {
  readonly code = 'prepared_extension_consumed';

  constructor() {
    super('Prepared extension mutation has already been consumed.');
    this.name = 'PreparedExtensionConsumedError';
  }
}

export class InvalidPreparedExtensionError extends Error {
  readonly code = 'invalid_prepared_extension';

  constructor() {
    super('Prepared extension mutation does not belong to this manager.');
    this.name = 'InvalidPreparedExtensionError';
  }
}

export class ExtensionNotUpdatableError extends Error {
  readonly code = 'extension_not_updatable';

  constructor(name: string) {
    super(`Extension "${name}" is not remotely updatable.`);
    this.name = 'ExtensionNotUpdatableError';
  }
}

interface RuntimeGitCredential extends ExtensionGitCredential {
  selector?: ExtensionGitCredentialSelector;
}

export interface ExtensionMutationEvent {
  id: number;
  phase: 'start' | 'end';
  operation: string;
}

export type ExtensionMutationListener = (event: ExtensionMutationEvent) => void;

// ============================================================================
// Helper Functions
// ============================================================================

function ensureLeadingAndTrailingSlash(dirPath: string): string {
  let result = dirPath.replace(/\\/g, '/');
  if (result.charAt(0) !== '/') {
    result = '/' + result;
  }
  if (result.charAt(result.length - 1) !== '/') {
    result = result + '/';
  }
  return result;
}

function getTelemetryConfig(
  cwd: string,
  telemetrySettings?: TelemetrySettings,
) {
  const config = new Config({
    telemetry: telemetrySettings,
    interactive: false,
    targetDir: cwd,
    cwd,
    model: '',
    debugMode: false,
    chatRecording: false,
  });
  return config;
}

function filterMcpConfig(original: MCPServerConfig): MCPServerConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { trust, ...rest } = original;
  return Object.freeze(rest);
}

function getContextFileNames(config: ExtensionConfig): string[] {
  if (!config.contextFileName || config.contextFileName.length === 0) {
    return ['QWEN.md'];
  } else if (!Array.isArray(config.contextFileName)) {
    return [config.contextFileName];
  }
  return config.contextFileName;
}

async function loadCommandsFromDir(dir: string): Promise<string[]> {
  const globOptions = {
    nodir: true,
    dot: true,
    follow: true,
  };

  try {
    const allFiles = await glob('**/*.{md,toml}', {
      ...globOptions,
      cwd: dir,
    });

    const commandNames = allFiles.map((file) => {
      const ext = path.extname(file);
      const relativePath = file.substring(0, file.length - ext.length);
      const commandName = relativePath
        .split(/[/\\]/)
        .map((segment) => segment.replaceAll(':', '_'))
        .join(':');

      return commandName;
    });

    return commandNames;
  } catch (error) {
    const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT';
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    if (!isEnoent && !isAbortError) {
      debugLogger.error(`Error loading commands from ${dir}:`, error);
    }
    return [];
  }
}

// ============================================================================
// ExtensionManager Class
// ============================================================================

export class ExtensionManager {
  private extensionCache: Map<string, Extension> | null = null;
  private readonly mutationListeners = new Set<ExtensionMutationListener>();
  private nextMutationId = 0;

  // Enablement configuration (directly implemented)
  private readonly configDir: string;
  private readonly configFilePath: string;
  private readonly enabledExtensionNamesOverride: string[];
  private readonly workspaceDir: string;
  private readonly preferencesStore: ExtensionPreferencesStore;
  private readonly sourceRegistryStore: SourceRegistryStore;
  private readonly extensionStore: ExtensionStore;
  private readonly networkPolicy?: ExtensionInstallMetadata['networkPolicy'];
  private readonly preparedMutations = new WeakSet<PreparedExtensionMutation>();
  private discoverCache: DiscoveredPlugin[] | null = null;
  /** See `sourceFingerprint`. `undefined` until the first refresh commits. */
  private lastSourceFingerprint: string | undefined;
  private inFlightSourceRevalidation: Promise<boolean> | undefined;

  private withNetworkPolicy(
    installMetadata: ExtensionInstallMetadata | undefined,
  ): ExtensionInstallMetadata | undefined {
    return installMetadata && this.networkPolicy
      ? { ...installMetadata, networkPolicy: this.networkPolicy }
      : installMetadata;
  }

  private config?: Config;
  private telemetrySettings?: TelemetrySettings;
  private isWorkspaceTrusted: boolean;
  private readonly locale: string;
  private requestConsent: (options?: ExtensionRequestOptions) => Promise<void>;
  private requestSetting?: (setting: ExtensionSetting) => Promise<string>;
  private requestChoicePlugin: (
    marketplace: ClaudeMarketplaceConfig,
  ) => Promise<string>;

  constructor(options: ExtensionManagerOptions) {
    this.workspaceDir = options.workspaceDir ?? process.cwd();
    this.locale = options.locale ?? 'en';
    this.enabledExtensionNamesOverride =
      options.enabledExtensionOverrides?.map((name) => name.toLowerCase()) ??
      [];
    this.extensionStore = options.extensionStore ?? new ExtensionStore();
    this.configDir = this.extensionStore.extensionsDir;
    this.configFilePath = path.join(
      this.configDir,
      'extension-enablement.json',
    );
    this.preferencesStore = new ExtensionPreferencesStore(
      path.join(this.configDir, 'extension-preferences.json'),
    );
    this.sourceRegistryStore = new SourceRegistryStore(
      // Keep the on-disk filename as marketplaces.json for backward
      // compatibility with sources added before the source/* rename.
      path.join(this.configDir, 'marketplaces.json'),
    );
    this.networkPolicy = options.networkPolicy;
    this.requestSetting = options.requestSetting;
    this.requestChoicePlugin =
      options.requestChoicePlugin || (() => Promise.resolve(''));
    this.requestConsent = options.requestConsent || (() => Promise.resolve());
    this.config = options.config;
    this.telemetrySettings = options.telemetrySettings;
    this.isWorkspaceTrusted = options.isWorkspaceTrusted;
  }

  setConfig(config: Config): void {
    this.config = config;
  }

  setRequestConsent(
    requestConsent: (options?: ExtensionRequestOptions) => Promise<void>,
  ): void {
    this.requestConsent = requestConsent;
  }

  setRequestSetting(
    requestSetting?: (setting: ExtensionSetting) => Promise<string>,
  ): void {
    this.requestSetting = requestSetting;
  }

  setRequestChoicePlugin(
    requestChoicePlugin: (
      marketplace: ClaudeMarketplaceConfig,
    ) => Promise<string>,
  ): void {
    this.requestChoicePlugin = requestChoicePlugin;
  }

  addMutationListener(listener: ExtensionMutationListener): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  private beginMutation(operation: string): () => void {
    const id = ++this.nextMutationId;
    this.emitMutation({ id, phase: 'start', operation });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.emitMutation({ id, phase: 'end', operation });
    };
  }

  private emitMutation(event: ExtensionMutationEvent): void {
    for (const listener of this.mutationListeners) {
      try {
        listener(event);
      } catch (error) {
        debugLogger.warn('Extension mutation listener failed:', error);
      }
    }
  }

  // ==========================================================================
  // Enablement functionality (directly implemented)
  // ==========================================================================

  /**
   * Validates that override extension names exist in the extensions list.
   */
  validateExtensionOverrides(extensions: Extension[]): void {
    for (const name of this.enabledExtensionNamesOverride) {
      if (name === 'none') continue;
      if (
        !extensions.some(
          (ext) => ext.config.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        debugLogger.error(`Extension not found: ${name}`);
      }
    }
  }

  /**
   * Determines if an extension is enabled based on its name and the current path.
   */
  isEnabled(extensionName: string, currentPath?: string): boolean {
    const checkPath = currentPath ?? this.workspaceDir;

    // If we have a single override called 'none', this disables all extensions.
    if (
      this.enabledExtensionNamesOverride.length === 1 &&
      this.enabledExtensionNamesOverride[0] === 'none'
    ) {
      return false;
    }

    // If we have explicit overrides, only enable those extensions.
    if (this.enabledExtensionNamesOverride.length > 0) {
      return this.enabledExtensionNamesOverride.includes(
        extensionName.toLowerCase(),
      );
    }

    // Otherwise, use the configuration settings
    const config = this.readEnablementConfig();
    const extensionConfig = config[extensionName];
    let enabled = true;
    const allOverrides = extensionConfig?.overrides ?? [];
    const lexicalPath = ensureLeadingAndTrailingSlash(checkPath);
    let canonicalPath = lexicalPath;
    try {
      canonicalPath = ensureLeadingAndTrailingSlash(
        fs.realpathSync.native(path.resolve(checkPath)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const rule of allOverrides) {
      const override = Override.fromFileRule(rule);
      if (
        override.matchesPath(lexicalPath) ||
        override.matchesPath(canonicalPath)
      ) {
        enabled = !override.isDisable;
      }
    }
    return enabled;
  }

  /**
   * Enables an extension at the specified scope.
   */
  async enableExtension(
    name: string,
    scope: SettingScope,
    cwd?: string,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const currentDir = cwd ?? this.workspaceDir;
    if (
      scope === SettingScope.System ||
      scope === SettingScope.SystemDefaults
    ) {
      throw new Error('System and SystemDefaults scopes are not supported.');
    }
    const extension = this.getLoadedExtensions().find(
      (ext) => ext.name === name,
    );
    if (!extension) {
      throw new Error(`Extension with name ${name} does not exist.`);
    }

    const endMutation = this.beginMutation('enableExtension');
    try {
      let snapshot: ExtensionStoreSnapshot;
      if (scope === SettingScope.Workspace) {
        snapshot = await this.extensionStore.setWorkspaceActivation(
          { id: extension.id, name: extension.name },
          currentDir,
          'enabled',
        );
      } else {
        const scopePath = os.homedir();
        snapshot = await this.extensionStore.setLegacyPathActivation(
          { id: extension.id, name: extension.name },
          scopePath,
          'enabled',
        );
      }
      onCommitted?.(snapshot.generation);
      const config = getTelemetryConfig(currentDir, this.telemetrySettings);
      logExtensionEnable(config, new ExtensionEnableEvent(name, scope));
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  /**
   * Disables an extension at the specified scope.
   */
  async disableExtension(
    name: string,
    scope: SettingScope,
    cwd?: string,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const currentDir = cwd ?? this.workspaceDir;
    const config = getTelemetryConfig(currentDir, this.telemetrySettings);
    if (
      scope === SettingScope.System ||
      scope === SettingScope.SystemDefaults
    ) {
      throw new Error('System and SystemDefaults scopes are not supported.');
    }
    const extension = this.getLoadedExtensions().find(
      (ext) => ext.name === name,
    );
    if (!extension) {
      throw new Error(`Extension with name ${name} does not exist.`);
    }

    const endMutation = this.beginMutation('disableExtension');
    try {
      let snapshot: ExtensionStoreSnapshot;
      if (scope === SettingScope.Workspace) {
        snapshot = await this.extensionStore.setWorkspaceActivation(
          { id: extension.id, name: extension.name },
          currentDir,
          'disabled',
        );
      } else {
        const scopePath = os.homedir();
        snapshot = await this.extensionStore.setLegacyPathActivation(
          { id: extension.id, name: extension.name },
          scopePath,
          'disabled',
        );
      }
      onCommitted?.(snapshot.generation);
      logExtensionDisable(config, new ExtensionDisableEvent(name, scope));
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  async getExtensionStoreSnapshot(): Promise<ExtensionStoreSnapshot> {
    return await this.extensionStore.readSnapshot();
  }

  async getExtensionActivation(
    extensionId: string,
    workspacePath: string = this.workspaceDir,
  ): Promise<ExtensionActivationResult> {
    const snapshot = await this.extensionStore.readSnapshot();
    return this.getExtensionActivationFromSnapshot(
      extensionId,
      snapshot,
      workspacePath,
    );
  }

  getExtensionActivationFromSnapshot(
    extensionId: string,
    snapshot: ExtensionStoreSnapshot,
    workspacePath: string = this.workspaceDir,
  ): ExtensionActivationResult {
    const extension = this.findExtensionById(extensionId);
    return this.getExtensionActivationForIdentityFromSnapshot(
      { id: extension.id, name: extension.name },
      snapshot,
      workspacePath,
    );
  }

  getExtensionActivationForIdentityFromSnapshot(
    identity: ExtensionIdentity,
    snapshot: ExtensionStoreSnapshot,
    workspacePath: string = this.workspaceDir,
  ): ExtensionActivationResult {
    const activation = this.extensionStore.getActivation(
      snapshot,
      identity.id,
      identity.name,
      workspacePath,
    );
    if (this.enabledExtensionNamesOverride.length === 0) {
      return activation;
    }
    return {
      ...activation,
      effective: this.isEnabled(identity.name) ? 'enabled' : 'disabled',
      source: 'cli_override',
    };
  }

  getExtensionActivationForNameFromSnapshot(
    name: string,
    snapshot: ExtensionStoreSnapshot,
    workspacePath: string = this.workspaceDir,
  ): ExtensionActivationResult {
    const entry = Object.entries(snapshot.extensions).find(
      ([, policy]) => policy.name.toLowerCase() === name.toLowerCase(),
    );
    if (!entry) {
      const cliOverride = this.enabledExtensionNamesOverride.length > 0;
      return {
        default: 'enabled',
        workspace: 'inherit',
        effective:
          cliOverride && !this.isEnabled(name) ? 'disabled' : 'enabled',
        source: cliOverride ? 'cli_override' : 'default',
      };
    }
    const [id, policy] = entry;
    return this.getExtensionActivationForIdentityFromSnapshot(
      { id, name: policy.name },
      snapshot,
      workspacePath,
    );
  }

  async setExtensionDefaultActivation(
    extensionId: string,
    activation: ExtensionActivation,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('setExtensionDefaultActivation');
    try {
      const snapshot = await this.extensionStore.setDefaultActivation(
        { id: extension.id, name: extension.name },
        activation,
      );
      onCommitted?.(snapshot.generation);
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(extension.name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  async setExtensionDefaultActivations(
    names: readonly string[],
    activation: ExtensionActivation,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const endMutation = this.beginMutation('setExtensionDefaultActivations');
    try {
      const identities = this.resolveBatchExtensionIdentities(names);
      const snapshot = await this.extensionStore.setDefaultActivations(
        identities,
        activation,
      );
      onCommitted?.(snapshot.generation);
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(
        `${identities.length} extensions`,
      );
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  async setExtensionActivationScope(
    extensionId: string,
    activation: InitialExtensionActivation,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('setExtensionActivationScope');
    try {
      const snapshot = await this.extensionStore.setActivationScope(
        { id: extension.id, name: extension.name },
        activation,
      );
      onCommitted?.(snapshot.generation);
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(extension.name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  async setExtensionWorkspaceActivation(
    extensionId: string,
    workspacePath: string,
    activation: ExtensionActivation,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('setExtensionWorkspaceActivation');
    try {
      const snapshot = await this.extensionStore.setWorkspaceActivation(
        { id: extension.id, name: extension.name },
        workspacePath,
        activation,
      );
      onCommitted?.(snapshot.generation);
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(extension.name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  async setExtensionWorkspaceActivations(
    names: readonly string[],
    workspacePath: string,
    activation: WorkspaceActivation,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const endMutation = this.beginMutation('setExtensionWorkspaceActivations');
    try {
      const identities = this.resolveBatchExtensionIdentities(names);
      let snapshot: ExtensionStoreSnapshot;
      let updated = true;
      if (activation === 'inherit') {
        const outcome = await this.extensionStore.clearWorkspaceActivations(
          identities,
          workspacePath,
        );
        snapshot = outcome.snapshot;
        updated = outcome.updated;
      } else {
        snapshot = await this.extensionStore.setWorkspaceActivations(
          identities,
          workspacePath,
          activation,
        );
      }
      if (!updated) {
        this.applyStoreActivation(snapshot);
        return { ...snapshot, updated: false };
      }
      onCommitted?.(snapshot.generation);
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(
        `${identities.length} extensions`,
      );
      return warning
        ? { ...snapshot, updated: true, warnings: [warning] }
        : { ...snapshot, updated: true };
    } finally {
      endMutation();
    }
  }

  private resolveBatchExtensionIdentities(
    names: readonly string[],
  ): ExtensionIdentity[] {
    const loadedByName = new Map(
      this.getLoadedExtensions().map((extension) => [
        extension.name.toLowerCase(),
        extension,
      ]),
    );
    return names.map((name) => {
      const loaded = loadedByName.get(name.toLowerCase());
      return loaded
        ? { id: loaded.id, name: loaded.name }
        : { id: hashValue(name.toLowerCase()), name };
    });
  }

  async clearExtensionWorkspaceActivation(
    extensionId: string,
    workspacePath: string,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('clearExtensionWorkspaceActivation');
    try {
      const snapshot = await this.extensionStore.clearWorkspaceActivation(
        { id: extension.id, name: extension.name },
        workspacePath,
      );
      onCommitted?.(snapshot.generation);
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(extension.name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  private findExtensionById(extensionId: string): Extension {
    const extension = this.getLoadedExtensions().find(
      (candidate) => candidate.id === extensionId,
    );
    if (!extension) {
      throw new Error(`Extension with id ${extensionId} does not exist.`);
    }
    return extension;
  }

  private applyStoreActivation(snapshot: ExtensionStoreSnapshot): void {
    for (const extension of this.getLoadedExtensions()) {
      if (this.enabledExtensionNamesOverride.length > 0) {
        extension.isActive = this.isEnabled(extension.name);
        continue;
      }
      extension.isActive =
        this.extensionStore.getActivation(
          snapshot,
          extension.id,
          extension.name,
          this.workspaceDir,
        ).effective === 'enabled';
    }
  }

  private async refreshToolsAfterActivation(
    name: string,
  ): Promise<{ code: string; error: string } | undefined> {
    try {
      await this.refreshTools();
      return undefined;
    } catch (error) {
      debugLogger.warn(
        `Extension "${name}" activation changed, but runtime refresh failed: ${getErrorMessage(error)}`,
      );
      return {
        code: 'extension_runtime_refresh_failed',
        error: getErrorMessage(error),
      };
    }
  }

  // ==========================================================================
  // Favorites & scope preferences (Installed view grouping)
  // ==========================================================================

  isFavorite(name: string): boolean {
    return this.preferencesStore.isFavorite(name);
  }

  getFavorites(): string[] {
    return this.preferencesStore.getFavorites();
  }

  /** Toggles favorite state for an extension/MCP server; returns new state. */
  toggleFavorite(name: string): boolean {
    return this.preferencesStore.toggleFavorite(name);
  }

  getExtensionScope(name: string): ExtensionScope | undefined {
    return this.preferencesStore.getScope(name);
  }

  getExtensionScopes(): Record<string, ExtensionScope> {
    return this.preferencesStore.getScopes();
  }

  setExtensionScope(name: string, scope: ExtensionScope): void {
    const endMutation = this.beginMutation('setExtensionScope');
    try {
      this.preferencesStore.setScope(name, scope);
    } finally {
      endMutation();
    }
  }

  /** MCP servers individually disabled inside the given extension. */
  getDisabledMcpServers(extensionName: string): string[] {
    return this.preferencesStore.getDisabledMcpServers(extensionName);
  }

  setMcpServerDisabled(
    extensionName: string,
    serverName: string,
    disabled: boolean,
  ): void {
    const endMutation = this.beginMutation('setMcpServerDisabled');
    try {
      this.preferencesStore.setMcpServerDisabled(
        extensionName,
        serverName,
        disabled,
      );
    } finally {
      endMutation();
    }
  }

  // ==========================================================================
  // Marketplace registry & discovery
  // ==========================================================================

  getSources(): ExtensionSource[] {
    return this.sourceRegistryStore.read();
  }

  /**
   * Adds a marketplace source. Loads the marketplace config to resolve a
   * human-readable name (falling back to the raw source). Throws if no
   * marketplace config can be resolved from the source.
   */
  async addSource(source: string): Promise<ExtensionSource> {
    const trimmed = source.trim();
    if (!trimmed) {
      throw new Error('Marketplace source cannot be empty.');
    }
    const config = await loadMarketplaceConfigFromSource(
      trimmed,
      this.networkPolicy,
    );
    if (!config) {
      // A "marketplace" is a Claude-format collection (.claude-plugin/
      // marketplace.json). A single extension repo (Gemini/Claude/git/npm) is
      // not a marketplace — guide the user to install it directly instead.
      let isInstallableExtension = false;
      try {
        await parseInstallSource(trimmed, {
          networkPolicy: this.networkPolicy,
        });
        isInstallableExtension = true;
      } catch {
        // Not a recognizable install source either.
      }
      const redacted = redactUrlCredentials(trimmed);
      if (isInstallableExtension) {
        throw new Error(
          `"${redacted}" looks like a single extension, not a marketplace. ` +
            `Install it directly with: /extensions install ${redacted}`,
        );
      }
      throw new Error(
        `No marketplace found at "${redacted}". ` +
          `Expected a .claude-plugin/marketplace.json.`,
      );
    }

    const endMutation = this.beginMutation('addSource');
    try {
      const now = new Date().toISOString();
      const entry: ExtensionSource = {
        name: config.name || trimmed,
        source: trimmed,
        type: parseExtensionSourceType(trimmed),
        addedAt: now,
        lastUpdatedAt: now,
      };
      this.sourceRegistryStore.add(entry);
      this.discoverCache = null; // sources changed -> refetch on next discover
      return entry;
    } finally {
      endMutation();
    }
  }

  removeSource(name: string): boolean {
    const endMutation = this.beginMutation('removeSource');
    try {
      const removed = this.sourceRegistryStore.remove(name);
      if (removed) {
        this.discoverCache = null;
      }
      return removed;
    } finally {
      endMutation();
    }
  }

  /**
   * Records a fresh "last updated" timestamp for a marketplace and invalidates
   * the discovery cache so the next discover re-fetches it.
   */
  markSourceUpdated(name: string): ExtensionSource | undefined {
    const entry = this.getSources().find((m) => m.name === name);
    if (!entry) {
      return undefined;
    }
    const updated: ExtensionSource = {
      ...entry,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.sourceRegistryStore.add(updated); // add() replaces by name
    this.discoverCache = null;
    return updated;
  }

  loadSource(source: string): Promise<ClaudeMarketplaceConfig | null> {
    return loadMarketplaceConfigFromSource(source, this.networkPolicy);
  }

  /**
   * Discovers all installable plugins across configured sources, marking
   * which are already installed. The fetched listing is cached for the session;
   * pass `{ refresh: true }` to force a re-fetch. The cheap `installed` flags are
   * always recomputed against the current install state.
   */
  async discoverPlugins(options?: {
    refresh?: boolean;
  }): Promise<DiscoveredPlugin[]> {
    const installedNames = new Set(
      this.getLoadedExtensions().map((ext) => ext.name),
    );
    if (this.discoverCache && !options?.refresh) {
      return this.discoverCache.map((plugin) => ({
        ...plugin,
        installed: installedNames.has(plugin.name),
      }));
    }
    const result = await discoverPlugins(
      this.getSources(),
      installedNames,
      this.networkPolicy,
    );
    this.discoverCache = result;
    return result;
  }

  private readEnablementConfig(): AllExtensionsEnablementConfig {
    try {
      const content = fs.readFileSync(this.configFilePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return {};
      }
      debugLogger.error('Error reading extension enablement config:', error);
      return {};
    }
  }

  /**
   * Refreshes the extension cache from disk.
   */
  async refreshCache(options?: { names?: string[] }): Promise<void> {
    await this.refreshCacheWithSnapshot(options);
  }

  async refreshCacheWithSnapshot(options?: {
    names?: string[];
  }): Promise<ExtensionStoreSnapshot> {
    const requestedNames = options?.names?.filter(Boolean) ?? [];
    // Captured before the load, not after: an install landing mid-refresh must
    // leave the committed fingerprint stale so the next check still sees it.
    // Stamping post-load would mask that change until something else moved.
    const dirFingerprintBeforeLoad =
      requestedNames.length === 0
        ? await this.extensionDirFingerprint()
        : undefined;
    const { value: extensions, snapshot } =
      await this.extensionStore.readConsistent(async () => {
        let loaded: Extension[];
        if (requestedNames.length > 0) {
          loaded = (
            await Promise.all(
              requestedNames.map((name) => this.loadExtensionByName(name)),
            )
          ).filter((extension): extension is Extension => extension !== null);
        } else {
          // Default: load all extensions from QWEN_HOME-aware user extensions dir.
          loaded = await this.loadExtensionsFromExtensionsDir(
            this.configDir,
            this.workspaceDir,
          );
        }
        return {
          value: loaded,
          extensions: loaded.map((extension) => ({
            id: extension.id,
            name: extension.name,
          })),
        };
      });
    const nextCache = new Map<string, Extension>();
    extensions.forEach((extension) => {
      nextCache.set(extension.name, extension);
    });
    this.extensionCache = nextCache;
    this.applyStoreActivation(snapshot);
    // Only a full refresh establishes a baseline. A name-filtered refresh leaves
    // the cache partial, so claiming the whole directory is up to date would let
    // `refreshCacheIfSourcesChanged` report "unchanged" over a partial set.
    if (dirFingerprintBeforeLoad !== undefined) {
      this.lastSourceFingerprint = this.sourceFingerprint(
        dirFingerprintBeforeLoad,
      );
    }
    return snapshot;
  }

  private static stampPath(target: string, followSymlinks = true): string {
    try {
      const stats = followSymlinks ? fs.statSync(target) : fs.lstatSync(target);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      // Absent is a real state and must not collide with any present one —
      // otherwise deleting the last extension would look unchanged.
      return '-';
    }
  }

  /**
   * Fingerprints which extension directories exist (install / uninstall) and
   * each manifest's mtime and size (in-place edits).
   *
   * A pure function of on-disk state, deliberately independent of the current
   * cache, so the same disk yields the same value before and after a refresh.
   * A refresh never writes these paths, which is what makes it safe to commit
   * the pre-load value — see `refreshCacheWithSnapshot`.
   *
   * Deliberately cheap: one `readdir`, one manifest `stat` per entry, and a
   * sidecar read for linked entries, where `refreshCache()` parses every
   * manifest and re-lists every extension skill directory. That difference is
   * what lets a status read stay self-healing without becoming a directory
   * scan.
   *
   * mtime-and-size is the usual stat-based approximation, so an edit that
   * preserves both is not detected. That is acceptable here: this is only the
   * out-of-band safety net — mutations made through the daemon invalidate
   * explicitly and never rely on it.
   */
  private async extensionDirFingerprint(): Promise<string> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.configDir);
    } catch {
      return 'dir:-';
    }
    // Match loadExtension: use the store grant, not in-band installMetadata.
    const linkedSources = this.linkedSourcesByDirectory(
      await this.extensionStore.peekSnapshot(),
    );
    const parts: string[] = [];
    for (const entry of entries) {
      const extensionRoot = path.join(this.configDir, entry);
      const effectiveRoot = linkedSources.get(entry) ?? extensionRoot;
      const manifestName =
        getAgentPluginSchemaStatus(effectiveRoot) === 'unrelated'
          ? EXTENSIONS_CONFIG_FILENAME
          : AGENT_PLUGIN_MANIFEST;
      let manifestPath = path.join(effectiveRoot, manifestName);
      let followManifestSymlink = true;
      if (manifestName === AGENT_PLUGIN_MANIFEST) {
        try {
          manifestPath = resolveContainedExistingPath(
            effectiveRoot,
            manifestPath,
          );
        } catch {
          followManifestSymlink = false;
        }
      }
      const stamp = ExtensionManager.stampPath(
        manifestPath,
        followManifestSymlink,
      );
      // Entries with no manifest are not extensions — notably the enablement
      // file, which lives in this directory and is created lazily by the store.
      // Counting them would make the store's own bookkeeping look like an
      // install and cost one spurious refresh.
      if (stamp === '-') continue;
      parts.push(`ext:${entry}:${stamp}`);
    }
    // Sorted so directory iteration order cannot make an unchanged set look
    // moved.
    return parts.sort().join('|');
  }

  /**
   * Fingerprints the enablement file and the store's activation state — where
   * `enable` / `disable` land.
   *
   * Unlike the directory part this is stamped *after* a refresh, because a
   * refresh writes the store itself. That is safe: store mutations hold the
   * store lock, so no external write can interleave with the refresh and be
   * masked by the post-load stamp.
   */
  private extensionStoreFingerprint(): string {
    return [
      `enablement:${ExtensionManager.stampPath(this.configFilePath)}`,
      `state:${ExtensionManager.stampPath(
        path.join(this.extensionStore.storeDir, 'state.json'),
      )}`,
    ].join('|');
  }

  private sourceFingerprint(dirFingerprint: string): string {
    return `${dirFingerprint}||${this.extensionStoreFingerprint()}`;
  }

  /**
   * Refreshes the cache only when the on-disk extension sources moved since the
   * last refresh. Returns whether a refresh actually ran.
   *
   * Extension sources have no watcher (skills do — see
   * `SkillManager.startWatching`), so read-only consumers that must not scan on
   * every call use this to stay eventually consistent with `qwen extensions
   * install` / `enable` / `disable` run outside the process.
   *
   * Concurrent callers share one refresh, so a caller can join a refresh that
   * started just before the change it cares about. That is bounded rather than
   * lost: the committed baseline is the pre-load fingerprint, so the change is
   * still visible to the next call.
   */
  async refreshCacheIfSourcesChanged(): Promise<boolean> {
    const inFlight = this.inFlightSourceRevalidation;
    if (inFlight) return await inFlight;
    // Build revalidation synchronously to set inFlight before fingerprint suspension.
    const revalidation = (async () => {
      const current = this.sourceFingerprint(
        await this.extensionDirFingerprint(),
      );
      if (this.lastSourceFingerprint === current) return false;
      // `refreshCache` commits the new baseline itself, from its pre-load
      // fingerprint. A throw leaves the old baseline in place so the next call
      // retries rather than assuming the refresh landed.
      await this.refreshCache();
      return true;
    })();
    this.inFlightSourceRevalidation = revalidation;
    const clear = () => {
      if (this.inFlightSourceRevalidation === revalidation) {
        this.inFlightSourceRevalidation = undefined;
      }
    };
    void revalidation.then(clear, clear);
    return await revalidation;
  }

  getLoadedExtensions(): Extension[] {
    if (!this.extensionCache) {
      return [];
    }
    return [...this.extensionCache!.values()];
  }

  // ==========================================================================
  // Extension loading methods
  // ==========================================================================

  /**
   * Loads an extension by name.
   */
  async loadExtensionByName(
    name: string,
    workspaceDir?: string,
  ): Promise<Extension | null> {
    const cwd = workspaceDir ?? this.workspaceDir;
    const userExtensionsDir = this.configDir;
    if (!fs.existsSync(userExtensionsDir)) {
      return null;
    }

    const snapshot = await this.extensionStore.peekSnapshot();
    const linkedSources = this.linkedSourcesByDirectory(snapshot);

    for (const subdir of fs.readdirSync(userExtensionsDir)) {
      const extensionDir = path.join(userExtensionsDir, subdir);
      if (!fs.statSync(extensionDir).isDirectory()) {
        continue;
      }
      const extension = await this.loadExtension({
        extensionDir,
        workspaceDir: cwd,
        trustedLinkSource: linkedSources.get(subdir),
      });
      if (
        extension &&
        extension.config.name.toLowerCase() === name.toLowerCase()
      ) {
        return extension;
      }
    }

    return null;
  }

  async loadExtensionsFromDir(dir: string): Promise<Extension[]> {
    const storage = new Storage(dir);
    return this.loadExtensionsFromExtensionsDir(
      storage.getExtensionsDir(),
      dir,
    );
  }

  private async loadExtensionsFromExtensionsDir(
    extensionsDir: string,
    workspaceDir: string,
  ): Promise<Extension[]> {
    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(extensionsDir);
    } catch {
      return [];
    }

    // Link grants are read via peekSnapshot (no extra lock): this function
    // runs inside refreshCache's readConsistent callback, where the store
    // lock is already held.
    const snapshot = await this.extensionStore.peekSnapshot();
    const linkedSources = this.linkedSourcesByDirectory(snapshot);

    const extensions: Extension[] = [];
    for (const subdir of subdirs) {
      const extensionDir = path.join(extensionsDir, subdir);
      const extension = await this.loadExtension({
        extensionDir,
        workspaceDir,
        trustedLinkSource: linkedSources.get(subdir),
      });
      if (extension != null) {
        extensions.push(extension);
      }
    }
    return extensions;
  }

  async loadExtension(
    context: LoadExtensionContext,
    options: { throwOnError?: boolean } = {},
  ): Promise<Extension | null> {
    const { extensionDir, workspaceDir } = context;
    if (!fs.statSync(extensionDir).isDirectory()) {
      return null;
    }

    const installMetadata = this.loadInstallMetadata(extensionDir);
    let effectiveExtensionPath = extensionDir;
    // Link-mode reads the user's own dev tree; manifest/hooks may be
    // symlinks (monorepo) and `..` may point at a sibling file. Trust
    // it: skip symlink-escape rejection and honor `..`. Link trust is
    // OUT-OF-BAND: only the scanning/installing flow grants it (from the
    // store snapshot or the caller-supplied metadata) — never the
    // extension's own .qwen-extension-install.json, which a hand-placed
    // payload could forge. The grant is the path authority: when an
    // in-band source disagrees, the metadata has been tampered with and
    // we refuse the load.
    const trustSymlinks =
      installMetadata?.type === 'link' &&
      context.trustedLinkSource !== undefined;

    if (trustSymlinks) {
      if (
        typeof installMetadata?.source === 'string' &&
        installMetadata.source.length > 0 &&
        installMetadata.source !== context.trustedLinkSource
      ) {
        debugLogger.warn(
          `Refusing extension ${extensionDir}: in-band source "${installMetadata.source}" does not match trusted link source "${context.trustedLinkSource}"`,
        );
        return null;
      }
      effectiveExtensionPath = context.trustedLinkSource as string;
    }

    try {
      const loadedManifest = this.loadExtensionManifest({
        extensionDir: effectiveExtensionPath,
        workspaceDir,
        trustSymlinks,
      });
      let config = loadedManifest.config;
      if (loadedManifest.format === 'qwen') {
        config = resolveEnvVarsInObject(config);
      }
      const extensionId = getExtensionId(config, installMetadata);
      if (loadedManifest.format === 'agent-plugins-v1') {
        config = {
          ...config,
          mcpServers: await loadAgentPluginMcpServers(
            effectiveExtensionPath,
            this.extensionStore.agentPluginDataRoot(extensionId),
            { createDataDir: true },
          ),
        };
      }

      const extension: Extension = {
        id: extensionId,
        name: config.name,
        displayName: config.displayName,
        version:
          config.version ||
          installMetadata?.marketplaceConfig?.metadata?.version ||
          '1.0.0',
        path: effectiveExtensionPath,
        format: loadedManifest.format,
        installMetadata,
        isActive: this.isEnabled(config.name, this.workspaceDir),
        config,
        settings: config.settings,
        contextFiles: [],
        trustedLinkSource: trustSymlinks ? context.trustedLinkSource : undefined,
      };

      if (config.mcpServers) {
        extension.mcpServers = Object.fromEntries(
          Object.entries(config.mcpServers).map(([key, value]) => [
            key,
            filterMcpConfig(value),
          ]),
        );
      }

      if (loadedManifest.format === 'qwen' && config.channels) {
        extension.channels = config.channels;
      }

      if (loadedManifest.format === 'agent-plugins-v1') {
        extension.commands = [];
        extension.skills = await loadAgentPluginSkills(effectiveExtensionPath);
        extension.agents = [];
      } else {
        extension.commands = await loadCommandsFromDir(
          `${effectiveExtensionPath}/commands`,
        );
        extension.contextFiles = getContextFileNames(config)
          .map((contextFileName) =>
            path.join(effectiveExtensionPath, contextFileName),
          )
          .filter((contextFilePath) => fs.existsSync(contextFilePath));
        extension.skills = await loadSkillsFromDir(
          `${effectiveExtensionPath}/skills`,
        );
        extension.agents = await loadSubagentFromDir(
          `${effectiveExtensionPath}/agents`,
        );
      }

      if (
        loadedManifest.format === 'qwen' &&
        config.hooks &&
        typeof config.hooks !== 'string'
      ) {
        // Inline hooks are already hydrated by loadExtensionConfig.
        // Deep-clone so subsequent hookRegistry mutations (e.g. .source
        // rewrites) don't leak back into config.hooks on the live config.
        extension.hooks = structuredClone(config.hooks) as {
          [K in HookEventName]?: HookDefinition[];
        };
      }

      // Also load hooks from hooks directory or from config.hooks string path if available and not already set
      if (loadedManifest.format === 'qwen' && !extension.hooks) {
        const hooksDir = path.join(effectiveExtensionPath, 'hooks');
        const hooksJsonPath = path.join(hooksDir, 'hooks.json');

        let configHooksPath =
          typeof config.hooks === 'string'
            ? path.isAbsolute(config.hooks)
              ? config.hooks
              : path.join(effectiveExtensionPath, config.hooks)
            : null;

        // A hooks path (string or absolute) must stay inside the extension;
        // an escaping value would otherwise load an arbitrary host file. Only
        // an existing path can escape via symlink — a missing file is dropped
        // by the isRegularFile below, not an escape. Link-mode installs trust
        // the user's own dev tree, so their symlinks are followed (not dropped).
        // isRegularFile (not fs.existsSync) also rejects directory-valued
        // config.hooks so the reader below doesn't silently load a folder.
        if (
          configHooksPath &&
          !trustSymlinks &&
          isRegularFile(configHooksPath) &&
          !realPathWithin(configHooksPath, effectiveExtensionPath)
        ) {
          debugLogger.warn(
            `Dropping hooks path "${stripAnsiAndControl(String(config.hooks))}" that escapes the extension; falling back to hooks/hooks.json if present.`,
          );
          configHooksPath = null;
        }

        // Warn when the user-set hooks path is missing or directory-valued —
        // independent of whether a default hooks/hooks.json exists (without
        // this, a typo + no co-shipped default fails silently, and a
        // directory-valued reference would silently fall back).
        if (
          typeof config.hooks === 'string' &&
          configHooksPath &&
          !isRegularFile(configHooksPath)
        ) {
          const reason = fs.existsSync(configHooksPath)
            ? 'is a directory, not a regular file'
            : 'was not found';
          debugLogger.warn(
            `Referenced hooks path "${stripAnsiAndControl(config.hooks)}" ${reason}; falling back to hooks/hooks.json.`,
          );
        }

        // Symmetric with the user-set warning above: a directory-valued
        // DEFAULT hooks/hooks.json would otherwise fall through silently.
        if (
          fs.existsSync(hooksJsonPath) &&
          !isRegularFile(hooksJsonPath) &&
          !(configHooksPath && isRegularFile(configHooksPath))
        ) {
          debugLogger.warn(
            `Default hooks path "${stripAnsiAndControl(hooksJsonPath)}" is a directory, not a regular file; no hooks will load.`,
          );
        }

        if (
          isRegularFile(hooksJsonPath) ||
          (configHooksPath && isRegularFile(configHooksPath))
        ) {
          // Pass raw config.hooks (not the pre-joined absolute) so the
          // relative-branch confinement check applies uniformly to both
          // strict-mode (rejects `..`) and link-mode (honors `..`).
          const rawHooksFileRef =
            configHooksPath &&
            typeof config.hooks === 'string' &&
            isRegularFile(configHooksPath)
              ? config.hooks
              : 'hooks/hooks.json';

          const parsedHooks = readExtraJsonFile(
            effectiveExtensionPath,
            rawHooksFileRef,
            trustSymlinks,
          );
          if (parsedHooks) {
            let hooksData;
            if (
              parsedHooks['hooks'] &&
              typeof parsedHooks['hooks'] === 'object'
            ) {
              hooksData = parsedHooks['hooks'] as {
                [K in HookEventName]?: HookDefinition[];
              };
            } else {
              // Assume the entire file content is the hooks object
              hooksData = parsedHooks as {
                [K in HookEventName]?: HookDefinition[];
              };
            }

            // Hydrate the same variables as inline hooks (see loadExtensionConfig).
            extension.hooks = recursivelyHydrateStrings(
              hooksData as unknown as JsonValue,
              {
                extensionPath: effectiveExtensionPath,
                CLAUDE_PLUGIN_ROOT: effectiveExtensionPath,
                workspacePath: workspaceDir ?? this.workspaceDir,
                '/': path.sep,
                pathSeparator: path.sep,
              },
            ) as { [K in HookEventName]?: HookDefinition[] };
          }
        }
      }

      return extension;
    } catch (e) {
      if (options.throwOnError) throw e;
      // Pre-migration link installs fail with the generic "Configuration
      // file not found" because the in-band grant is no longer trusted;
      // surface a distinct diagnostic so the user reinstalls instead of
      // chasing a phantom config file.
      if (installMetadata?.type === 'link') {
        debugLogger.warn(
          `Legacy link install at ${effectiveExtensionPath} requires reinstallation after the out-of-band trust migration; run the install command again to register the link source in the store.`,
        );
        return null;
      }
      debugLogger.warn(
        `Warning: Skipping extension in ${effectiveExtensionPath}: ${getErrorMessage(
          e,
        )}`,
      );
      return null;
    }
  }

  /** Maps extension-directory entries to their out-of-band link grant from
   *  the store snapshot. Takes the snapshot as a parameter and never touches
   *  the store — safe with the store lock held (see peekSnapshot). */
  private linkedSourcesByDirectory(
    snapshot: ExtensionStoreSnapshot,
  ): Map<string, string> {
    const grants = new Map<string, string>();
    for (const policy of Object.values(snapshot.extensions)) {
      if (policy.linkedSource !== undefined) {
        grants.set(
          policy.artifactDirectory ?? policy.name,
          policy.linkedSource,
        );
      }
    }
    return grants;
  }

  loadInstallMetadata(
    extensionDir: string,
  ): ExtensionInstallMetadata | undefined {
    const metadataFilePath = path.join(extensionDir, INSTALL_METADATA_FILENAME);
    try {
      const configContent = fs.readFileSync(metadataFilePath, 'utf-8');
      const metadata = JSON.parse(configContent) as ExtensionInstallMetadata;
      return metadata;
    } catch (_e) {
      return undefined;
    }
  }

  loadExtensionConfig(context: LoadExtensionContext): ExtensionConfig {
    return this.loadExtensionManifest(context).config;
  }

  private loadExtensionManifest(
    context: LoadExtensionContext,
  ): LoadedExtensionManifest {
    const {
      extensionDir,
      workspaceDir = this.workspaceDir,
      trustSymlinks,
    } = context;
    const agentPluginStatus = getAgentPluginSchemaStatus(extensionDir);
    if (agentPluginStatus !== 'unrelated') {
      try {
        return {
          format: 'agent-plugins-v1',
          config: loadAgentPluginManifest(extensionDir),
        };
      } catch (error) {
        throw new Error(
          `Failed to load Agent Plugins manifest from ${path.join(extensionDir, 'plugin.json')}: ${getErrorMessage(error)}`,
        );
      }
    }

    const configFilePath = path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME);
    if (!fs.existsSync(configFilePath)) {
      throw new Error(`Configuration file not found at ${configFilePath}`);
    }
    try {
      const manifest = readExtensionManifest(
        extensionDir,
        EXTENSIONS_CONFIG_FILENAME,
        trustSymlinks,
      );
      if (!manifest) {
        throw new Error(`Invalid configuration in ${configFilePath}`);
      }
      const rawConfig = recursivelyHydrateStrings(
        manifest as unknown as JsonValue,
        {
          extensionPath: extensionDir,
          CLAUDE_PLUGIN_ROOT: extensionDir,
          workspacePath: workspaceDir,
          '/': path.sep,
          pathSeparator: path.sep,
        },
      ) as unknown as RawExtensionConfig;

      const config = resolveExtensionConfigLocale(rawConfig, this.locale);

      if (!config.name) {
        throw new Error(
          `Invalid configuration in ${configFilePath}: missing "name"`,
        );
      }
      validateName(config.name);
      validateExtensionSettingEnvVars(config.settings);
      return { format: 'qwen', config };
    } catch (e) {
      throw new Error(
        `Failed to load extension config from ${configFilePath}: ${getErrorMessage(
          e,
        )}`,
      );
    }
  }

  // ==========================================================================
  // Extension installation/uninstallation
  // ==========================================================================

  /**
   * Installs an extension.
   */
  async installExtension(
    installMetadata: ExtensionInstallMetadata,
    requestConsent?: (options?: ExtensionRequestOptions) => Promise<void>,
    requestSetting?: (setting: ExtensionSetting) => Promise<string>,
    cwd?: string,
    previousExtensionConfig?: ExtensionConfig,
    initialActivation: InitialExtensionActivation = { scope: 'user' },
    signal?: AbortSignal,
  ): Promise<Extension> {
    if (!previousExtensionConfig) {
      const endMutation = this.beginMutation('installExtension');
      let prepared: PreparedExtensionMutation | undefined;
      try {
        prepared = await this.prepareExtensionInstall({
          installMetadata,
          initialActivation,
          ...(requestConsent ? { requestConsent } : {}),
          ...(requestSetting ? { requestSetting } : {}),
          ...(cwd ? { cwd } : {}),
          ...(signal ? { signal } : {}),
        });
        const committed = await this.commitPreparedExtensionInternal(
          prepared,
          false,
        );
        const warnings = committed.warnings ?? [];
        if (!committed.extension || warnings.length > 0) {
          const reloadWarning = committed.warnings?.find(
            (warning) => warning.code === 'extension_reload_failed',
          );
          const firstWarning = reloadWarning ?? warnings[0];
          const error = new Error(
            `Extension "${prepared.identity.name}" committed with warnings${
              firstWarning
                ? `: ${firstWarning.code}: ${firstWarning.error}`
                : '.'
            }`,
            firstWarning ? { cause: new Error(firstWarning.error) } : undefined,
          ) as ExtensionCommittedWithWarningsError;
          error.code = 'extension_committed_with_warnings';
          error.committed = true;
          error.identity = committed.identity;
          error.warnings = warnings;
          throw error;
        }
        return committed.extension;
      } finally {
        if (prepared) await this.disposePreparedExtension(prepared);
        endMutation();
      }
    }
    return (await this.installExtensionInternal(
      installMetadata,
      requestConsent,
      requestSetting,
      cwd,
      previousExtensionConfig,
      initialActivation,
      signal,
      false,
      true,
    )) as Extension;
  }

  async prepareExtensionInstall(
    options: PrepareExtensionInstallOptions,
  ): Promise<PreparedExtensionMutation> {
    return (await this.installExtensionInternal(
      { ...options.installMetadata },
      options.requestConsent,
      options.requestSetting,
      options.cwd,
      undefined,
      options.initialActivation,
      options.signal,
      true,
      false,
      options.localSourcePath,
      options.gitCredential,
    )) as PreparedExtensionMutation;
  }

  private async prepareExtensionUpdateFromState(
    extension: Extension,
    signal?: AbortSignal,
  ): Promise<PreparedExtensionMutation> {
    const installMetadata = this.loadInstallMetadata(extension.path);
    if (!installMetadata?.type || installMetadata.type === 'link') {
      throw new Error(`Extension ${extension.name} cannot be updated.`);
    }
    if (installMetadata.type === 'snapshot') {
      throw new ExtensionNotUpdatableError(extension.name);
    }
    const previousConfig = this.loadExtensionConfig({
      extensionDir: extension.path,
    });
    let gitCredential: RuntimeGitCredential | undefined;
    if (installMetadata.credentialPersistence === 'stored') {
      const stored = await resolveStoredGitCredential(extension.path);
      gitCredential = {
        ...stored.credential,
        persistence: 'stored',
        selector: stored.selector,
      };
    }
    return (await this.installExtensionInternal(
      { ...installMetadata },
      undefined,
      undefined,
      undefined,
      previousConfig,
      { scope: 'user' },
      signal,
      true,
      false,
      undefined,
      gitCredential,
    )) as PreparedExtensionMutation;
  }

  async prepareExtensionUpdate(
    options: PrepareExtensionUpdateOptions,
  ): Promise<
    | { upToDate: true; extension: Extension }
    | { upToDate: false; prepared: PreparedExtensionMutation }
  > {
    const installMetadata = this.withNetworkPolicy(
      options.extension.installMetadata,
    );
    const extension =
      installMetadata === options.extension.installMetadata
        ? options.extension
        : { ...options.extension, installMetadata };
    const state = await checkForExtensionUpdate(
      extension,
      this,
      options.signal,
    );
    if (state === ExtensionUpdateState.UP_TO_DATE) {
      return { upToDate: true, extension: options.extension };
    }
    if (state === ExtensionUpdateState.NOT_UPDATABLE) {
      throw new ExtensionNotUpdatableError(options.extension.name);
    }
    if (state !== ExtensionUpdateState.UPDATE_AVAILABLE) {
      throw new Error(
        `Extension "${options.extension.name}" update check returned ${state}.`,
      );
    }
    return {
      upToDate: false,
      prepared: await this.prepareExtensionUpdateFromState(
        options.extension,
        options.signal,
      ),
    };
  }

  private async installExtensionInternal(
    installMetadata: ExtensionInstallMetadata,
    requestConsent:
      | ((options?: ExtensionRequestOptions) => Promise<void>)
      | undefined,
    requestSetting:
      | ((setting: ExtensionSetting) => Promise<string>)
      | undefined,
    cwd: string | undefined,
    previousExtensionConfig: ExtensionConfig | undefined,
    initialActivation: InitialExtensionActivation,
    signal: AbortSignal | undefined,
    prepareOnly: boolean,
    emitMutation: boolean,
    localSourcePathOverride?: string,
    gitCredential?: RuntimeGitCredential,
  ): Promise<Extension | PreparedExtensionMutation> {
    if (localSourcePathOverride && installMetadata.type !== 'local') {
      throw new Error('A local source path requires a local install.');
    }
    installMetadata = this.withNetworkPolicy(installMetadata)!;
    const remoteGitInstall =
      installMetadata.type === 'git' ||
      installMetadata.type === 'github-release';
    if (gitCredential && !remoteGitInstall) {
      throw new Error('Git credentials require an HTTPS Git install source.');
    }
    if (gitCredential?.persistence === 'one_time' && previousExtensionConfig) {
      throw new ExtensionNotUpdatableError(previousExtensionConfig.name);
    }
    if (gitCredential && !installMetadata.installId) {
      installMetadata.installId = randomBytes(32).toString('hex');
    }
    const currentDir = cwd ?? this.workspaceDir;
    const telemetryConfig = getTelemetryConfig(
      currentDir,
      this.telemetrySettings,
    );
    let extension: Extension | null;
    const redactedInstallSource =
      gitCredential?.persistence === 'one_time'
        ? 'credentialed HTTPS Git source'
        : redactUrlCredentials(installMetadata.source);

    const isUpdate = !!previousExtensionConfig;
    const expectedArtifactGeneration = previousExtensionConfig
      ? ((await this.extensionStore.readSnapshot()).extensions[
          getExtensionId(previousExtensionConfig, installMetadata)
        ]?.artifactGeneration ?? 0)
      : undefined;
    let newExtensionConfig: ExtensionConfig | null = null;
    let localSourcePath: string | undefined;
    let tempDir: string | undefined;
    let convertedSourcePath: string | undefined;
    let stagingPath: string | undefined;
    let archiveSymlinksValidated = false;
    let preparedSettings: PreparedExtensionSettingsMutation | undefined;
    let preparedGitCredential: PreparedStoredGitCredential | undefined;

    let ownershipTransferred = false;
    const endMutation = emitMutation
      ? this.beginMutation('installExtension')
      : () => undefined;
    try {
      if (!this.isWorkspaceTrusted) {
        throw new Error(
          `Could not install extension from untrusted folder at ${redactedInstallSource}`,
        );
      }

      const extensionsDir = this.configDir;
      await fs.promises.mkdir(extensionsDir, { recursive: true });

      if (
        !localSourcePathOverride &&
        !path.isAbsolute(installMetadata.source) &&
        (installMetadata.type === 'local' || installMetadata.type === 'link')
      ) {
        installMetadata.source = path.resolve(
          currentDir,
          installMetadata.source,
        );
      }

      if (
        installMetadata.originSource === 'Claude' &&
        installMetadata.marketplaceConfig &&
        !installMetadata.pluginName
      ) {
        const pluginName = await this.requestChoicePlugin(
          installMetadata.marketplaceConfig,
        );
        installMetadata.pluginName = pluginName;
      }

      if (
        installMetadata.type === 'git' ||
        installMetadata.type === 'github-release'
      ) {
        tempDir = await ExtensionStorage.createTmpDir();
        if (gitCredential) {
          installMetadata.type = 'git';
          installMetadata.releaseTag = undefined;
          installMetadata.gitCommit = await cloneFromGit(
            installMetadata,
            tempDir,
            signal,
            gitCredential,
            gitCredential.persistence === 'one_time',
          );
        } else {
          try {
            const result = await downloadFromGitHubRelease(
              installMetadata,
              tempDir,
              signal,
            );
            if (
              installMetadata.type === 'git' ||
              installMetadata.type === 'github-release'
            ) {
              installMetadata.type = result.type;
              installMetadata.releaseTag = result.tagName;
            }
          } catch (_error) {
            signal?.throwIfAborted();
            // Release extraction may leave a partial destination behind.
            await fs.promises.rm(tempDir, { recursive: true, force: true });
            await fs.promises.mkdir(tempDir, { recursive: true });
            // Keep release-first for older Git too: the archive fallback is
            // only a clone replacement, not a release replacement.
            if (await shouldUsePublicGitHubArchiveFallback(installMetadata)) {
              installMetadata.gitCommit =
                await downloadPublicGitHubArchiveFallback(
                  installMetadata,
                  tempDir,
                  signal,
                );
              archiveSymlinksValidated = true;
            } else {
              installMetadata.gitCommit = await cloneFromGit(
                installMetadata,
                tempDir,
                signal,
              );
              if (installMetadata.type === 'github-release') {
                installMetadata.type = 'git';
              }
            }
          }
        }
        localSourcePath = tempDir;
      } else if (installMetadata.type === 'archive-url') {
        tempDir = await ExtensionStorage.createTmpDir();
        await downloadFromArchiveUrl(installMetadata, tempDir, signal);
        localSourcePath = tempDir;
      } else if (installMetadata.type === 'npm') {
        tempDir = await ExtensionStorage.createTmpDir();
        const result = await downloadFromNpmRegistry(
          installMetadata,
          tempDir,
          signal,
        );
        installMetadata.releaseTag = result.version;
        localSourcePath = tempDir;
      } else if (
        installMetadata.type === 'local' &&
        isSupportedArchivePath(
          localSourcePathOverride ?? installMetadata.source,
        )
      ) {
        tempDir = await ExtensionStorage.createTmpDir();
        await extractArchiveFile(
          localSourcePathOverride ?? installMetadata.source,
          tempDir,
          signal,
        );
        localSourcePath = tempDir;
      } else if (
        installMetadata.type === 'local' ||
        installMetadata.type === 'link'
      ) {
        localSourcePath = localSourcePathOverride ?? installMetadata.source;
      } else {
        throw new Error(`Unsupported install type: ${installMetadata.type}`);
      }

      signal?.throwIfAborted();
      try {
        const sourceBeforeConversion = localSourcePath;
        const { extensionDir, originSource, externalContent } =
          await convertCompatibleExtension(
            sourceBeforeConversion,
            installMetadata.pluginName,
            installMetadata.networkPolicy,
            signal,
          );
        signal?.throwIfAborted();

        if (extensionDir !== sourceBeforeConversion) {
          convertedSourcePath = extensionDir;
        }
        localSourcePath = extensionDir;
        installMetadata.originSource = originSource;
        installMetadata.externalContent = externalContent;
        if (externalContent) {
          // The commit recorded above belongs to the outer clone (e.g. the
          // marketplace repo), not plugin content fetched from a nested
          // source; drop it so update checks don't compare the wrong repo.
          installMetadata.gitCommit = undefined;
        }

        if (gitCredential?.persistence === 'stored') {
          installMetadata.type = 'git';
          installMetadata.credentialPersistence = 'stored';
        } else if (
          gitCredential?.persistence === 'one_time' &&
          !previousExtensionConfig
        ) {
          installMetadata = {
            source: 'snapshot',
            type: 'snapshot',
            installId: installMetadata.installId,
            ...(originSource ? { originSource } : {}),
            ...(externalContent ? { externalContent: true } : {}),
            ...(installMetadata.pluginName
              ? { pluginName: installMetadata.pluginName }
              : {}),
          };
        }

        newExtensionConfig = this.loadExtensionConfig({
          extensionDir: localSourcePath,
          workspaceDir: currentDir,
          trustSymlinks: installMetadata.type === 'link',
        });
        const isAgentPlugin = originSource === 'AgentPlugins';
        const extensionId = getExtensionId(newExtensionConfig, installMetadata);
        if (isAgentPlugin) {
          newExtensionConfig = {
            ...newExtensionConfig,
            mcpServers: await loadAgentPluginMcpServers(
              localSourcePath,
              this.extensionStore.agentPluginDataRoot(extensionId),
            ),
          };
        }

        if (isUpdate && installMetadata.autoUpdate) {
          const oldSettings = new Set(
            previousExtensionConfig.settings?.map((s) => s.name) || [],
          );
          const newSettings = new Set(
            newExtensionConfig.settings?.map((s) => s.name) || [],
          );

          const settingsAreEqual =
            oldSettings.size === newSettings.size &&
            [...oldSettings].every((value) => newSettings.has(value));

          if (!settingsAreEqual && installMetadata.autoUpdate) {
            throw new Error(
              `Extension "${newExtensionConfig.name}" has settings changes and cannot be auto-updated. Please update manually.`,
            );
          }
        }

        const newExtensionName = newExtensionConfig.name;
        const previous = this.getLoadedExtensions().find(
          (installed) =>
            installed.name.toLowerCase() === newExtensionName.toLowerCase(),
        );
        if (isUpdate && !previous) {
          throw new Error(
            `Extension "${newExtensionName}" was not already installed, cannot update it.`,
          );
        } else if (!isUpdate && previous) {
          throw new Error(
            `Extension "${newExtensionName}" is already installed. Please uninstall it first.`,
          );
        }

        const commands = isAgentPlugin
          ? []
          : await loadCommandsFromDir(`${localSourcePath}/commands`);
        const previousCommands = previous?.commands ?? [];

        const skills = isAgentPlugin
          ? await loadAgentPluginSkills(localSourcePath)
          : await loadSkillsFromDir(`${localSourcePath}/skills`);
        const previousSkills = previous?.skills ?? [];

        const subagents = isAgentPlugin
          ? []
          : await loadSubagentFromDir(`${localSourcePath}/agents`);
        const previousSubagents = previous?.agents ?? [];

        if (requestConsent) {
          await requestConsent({
            extensionConfig: newExtensionConfig,
            commands,
            skills,
            subagents,
            previousExtensionConfig,
            previousCommands,
            previousSkills,
            previousSubagents,
            originSource,
          });
        } else {
          await this.requestConsent({
            extensionConfig: newExtensionConfig,
            commands,
            skills,
            subagents,
            previousExtensionConfig,
            previousCommands,
            previousSkills,
            previousSubagents,
            originSource,
          });
        }

        const destinationPath = path.join(this.configDir, newExtensionName);
        if (isUpdate && previous?.id !== extensionId) {
          throw new Error(
            `Extension "${newExtensionName}" changed its stable id during update.`,
          );
        }
        let previousSettings: Record<string, string> | undefined;
        if (isUpdate) {
          previousSettings = await getEnvContents(
            previousExtensionConfig,
            extensionId,
          );
        }
        stagingPath = await this.extensionStore.createStagingDirectory();

        if (installMetadata.type !== 'link') {
          if (
            archiveSymlinksValidated &&
            localSourcePath !== sourceBeforeConversion
          ) {
            // archiveSymlinksValidated was only ever proven for
            // sourceBeforeConversion. `isAgentPlugin` is true only when
            // convertCompatibleExtension left the directory unchanged
            // (extension-converter.ts's AgentPlugins branch never reassigns
            // its output dir), so gating this on `isAgentPlugin` as well
            // would make it unreachable: every branch that actually moves
            // the tree sets a different originSource. A converter that
            // restructures the tree while preserving symlinks (today's
            // Gemini/Claude/Qoder converters materialize links instead, but
            // that's not an invariant) would otherwise carry stale trust
            // onto a directory that was never actually checked.
            await assertDirectorySymlinksAreSafe(localSourcePath, signal);
          }
          await copyExtension(localSourcePath, stagingPath, {
            skipSymlinks: isAgentPlugin && !archiveSymlinksValidated,
            excludeRootGitDirectory: remoteGitInstall,
          });
        }
        await removeGitCredentialSelector(stagingPath);
        if (gitCredential?.persistence === 'stored') {
          if (gitCredential.selector) {
            await writeGitCredentialSelector(
              stagingPath,
              gitCredential.selector,
            );
          } else {
            preparedGitCredential = await prepareStoredGitCredential(
              stagingPath,
              gitCredential,
            );
          }
        }

        if (isUpdate) {
          preparedSettings = await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
            previousExtensionConfig,
            previousSettings,
            path.join(stagingPath, EXTENSION_SETTINGS_FILENAME),
            true,
          );
        } else {
          preparedSettings = await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
            undefined,
            undefined,
            path.join(stagingPath, EXTENSION_SETTINGS_FILENAME),
            true,
          );
        }

        // Perform variable replacement in extension files (e.g., ${CLAUDE_PLUGIN_ROOT}) for Claude extensions
        const hooksDir = path.join(stagingPath, 'hooks');
        const configHooksPath =
          typeof newExtensionConfig.hooks === 'string'
            ? path.isAbsolute(newExtensionConfig.hooks)
              ? newExtensionConfig.hooks
              : path.join(stagingPath, newExtensionConfig.hooks)
            : null;

        const usesPluginVariables =
          originSource === 'Claude' || originSource === 'Qoder';
        if (
          usesPluginVariables &&
          (fs.existsSync(hooksDir) ||
            (configHooksPath && isRegularFile(configHooksPath)))
        ) {
          try {
            await performVariableReplacement(stagingPath, destinationPath);
          } catch (error) {
            debugLogger.error('Variable replacement failed', error);
          }
        }

        const metadataString = JSON.stringify(installMetadata, null, 2);
        const metadataPath = path.join(stagingPath, INSTALL_METADATA_FILENAME);
        await atomicWriteFile(metadataPath, metadataString);

        const stagedExtension = await this.loadExtension(
          {
            extensionDir: stagingPath,
            workspaceDir: currentDir,
            // The installing flow holds the caller-supplied metadata, so it
            // is the trust authority until the commit's linkedSource lands.
            trustedLinkSource:
              installMetadata.type === 'link'
                ? installMetadata.source
                : undefined,
          },
          { throwOnError: true },
        );
        if (!stagedExtension) {
          throw new Error('Prepared extension could not be loaded.');
        }

        signal?.throwIfAborted();
        if (prepareOnly) {
          const cleanupPaths = [
            tempDir,
            convertedSourcePath !== tempDir ? convertedSourcePath : undefined,
            localSourcePath !== tempDir &&
            localSourcePath !== convertedSourcePath &&
            installMetadata.type !== 'link' &&
            installMetadata.type !== 'local'
              ? localSourcePath
              : undefined,
          ].filter((value): value is string => !!value);
          const prepared: PreparedExtensionMutation = {
            operation: isUpdate ? 'update' : 'install',
            identity: { id: extensionId, name: newExtensionName },
            version: stagedExtension.version,
            ...(expectedArtifactGeneration === undefined
              ? {}
              : { expectedArtifactGeneration }),
            installMetadata,
            config: newExtensionConfig,
            ...(previousExtensionConfig
              ? { previousConfig: previousExtensionConfig }
              : {}),
            initialActivation,
            stagingDirectory: stagingPath,
            destinationDirectory: destinationPath,
            currentDir,
            cleanupPaths,
            ...(preparedSettings
              ? {
                  commitSettings: preparedSettings.commit,
                  discardSettings: preparedSettings.discard,
                }
              : {}),
            ...(preparedGitCredential
              ? {
                  credentialStorage: preparedGitCredential.storageType,
                  commitGitCredential: preparedGitCredential.commit,
                  discardGitCredential: preparedGitCredential.discard,
                }
              : gitCredential?.selector
                ? { credentialStorage: gitCredential.selector.backend }
                : {}),
            settingsActivated: false,
            gitCredentialActivated: false,
            consumed: false,
            disposed: false,
          };
          this.preparedMutations.add(prepared);
          ownershipTransferred = true;
          return prepared;
        }
        const snapshot = await this.extensionStore.commitArtifact({
          operation: isUpdate ? 'update' : 'install',
          identity: { id: extensionId, name: newExtensionName },
          stagingDirectory: stagingPath,
          destinationDirectory: destinationPath,
          ...(!isUpdate ? { initialActivation } : {}),
          ...(expectedArtifactGeneration === undefined
            ? {}
            : { expectedArtifactGeneration }),
          ...(installMetadata.type === 'link'
            ? {
                linkedSource:
                  typeof installMetadata.source === 'string'
                    ? installMetadata.source
                    : undefined,
              }
            : {}),
        });
        preparedGitCredential?.commit();
        preparedGitCredential = undefined;
        await preparedSettings?.commit().catch((error) => {
          debugLogger.warn(
            `Extension "${newExtensionName}" settings compatibility cleanup failed: ${getErrorMessage(error)}`,
          );
        });
        preparedSettings = undefined;
        stagingPath = undefined;

        try {
          extension = await this.loadExtension(
            {
              extensionDir: destinationPath,
              trustedLinkSource:
                installMetadata.type === 'link'
                  ? installMetadata.source
                  : undefined,
            },
            { throwOnError: true },
          );
          if (!extension) throw new Error('Extension not found after commit.');
        } catch (reloadError) {
          this.extensionCache?.delete(newExtensionName);
          this.applyStoreActivation(snapshot);
          const warnings = [
            {
              code: 'extension_reload_failed',
              error: getErrorMessage(reloadError),
            },
          ];
          await this.refreshTools().catch((error) => {
            warnings.push({
              code: 'extension_runtime_refresh_failed',
              error: getErrorMessage(error),
            });
            debugLogger.warn(
              `Extension "${newExtensionName}" was committed, but runtime refresh failed: ${getErrorMessage(error)}`,
            );
          });
          const error = new Error(
            `Extension "${newExtensionName}" committed but could not be reloaded: ${getErrorMessage(reloadError)}`,
            { cause: reloadError },
          ) as ExtensionCommittedWithWarningsError;
          error.code = 'extension_committed_with_warnings';
          error.committed = true;
          error.identity = { id: extensionId, name: newExtensionName };
          error.warnings = warnings;
          throw error;
        }

        if (this.extensionCache) {
          this.extensionCache.set(extension.name, extension);
        }

        if (isUpdate) {
          logExtensionUpdateEvent(
            telemetryConfig,
            new ExtensionUpdateEvent(
              newExtensionConfig.name,
              getExtensionId(newExtensionConfig, installMetadata),
              newExtensionConfig.version,
              previousExtensionConfig.version,
              installMetadata.type,
              'success',
            ),
          );
        } else {
          logExtensionInstallEvent(
            telemetryConfig,
            new ExtensionInstallEvent(
              newExtensionConfig.name,
              newExtensionConfig!.version,
              redactedInstallSource,
              'success',
            ),
          );
        }
        if (this.extensionCache) this.applyStoreActivation(snapshot);
        await this.refreshTools().catch((error) => {
          debugLogger.warn(
            `Extension "${newExtensionName}" was installed, but runtime refresh failed: ${getErrorMessage(error)}`,
          );
        });
      } finally {
        if (!ownershipTransferred && preparedGitCredential) {
          await preparedGitCredential.discard().catch((error) => {
            debugLogger.warn(
              `Failed to discard prepared extension Git credentials: ${getErrorMessage(error)}`,
            );
          });
        }
        if (!ownershipTransferred && preparedSettings) {
          await preparedSettings.discard().catch((error) => {
            debugLogger.warn(
              `Failed to discard prepared extension settings: ${getErrorMessage(error)}`,
            );
          });
        }
        if (stagingPath && !ownershipTransferred) {
          await fs.promises.rm(stagingPath, {
            recursive: true,
            force: true,
          });
          stagingPath = undefined;
        }
        if (tempDir && !ownershipTransferred) {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
        if (
          convertedSourcePath &&
          convertedSourcePath !== tempDir &&
          !ownershipTransferred
        ) {
          await fs.promises.rm(convertedSourcePath, {
            recursive: true,
            force: true,
          });
        }
        if (
          localSourcePath &&
          localSourcePath !== tempDir &&
          localSourcePath !== convertedSourcePath &&
          installMetadata.type !== 'link' &&
          installMetadata.type !== 'local' &&
          !ownershipTransferred
        ) {
          await fs.promises.rm(localSourcePath, {
            recursive: true,
            force: true,
          });
        }
      }
      return extension;
    } catch (error) {
      if (!newExtensionConfig && localSourcePath) {
        try {
          newExtensionConfig = this.loadExtensionConfig({
            extensionDir: localSourcePath,
            workspaceDir: currentDir,
            trustSymlinks: installMetadata.type === 'link',
          });
        } catch {
          // Ignore error
        }
      }
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
      if (convertedSourcePath && convertedSourcePath !== tempDir) {
        await fs.promises.rm(convertedSourcePath, {
          recursive: true,
          force: true,
        });
      }
      const config = newExtensionConfig ?? previousExtensionConfig;
      const extensionId = config
        ? getExtensionId(config, installMetadata)
        : undefined;
      if (isUpdate) {
        logExtensionUpdateEvent(
          telemetryConfig,
          new ExtensionUpdateEvent(
            config?.name ?? '',
            extensionId ?? '',
            newExtensionConfig?.version ?? '',
            previousExtensionConfig.version,
            installMetadata.type,
            isExtensionCommittedWithWarningsError(error) ? 'success' : 'error',
          ),
        );
      } else {
        logExtensionInstallEvent(
          telemetryConfig,
          new ExtensionInstallEvent(
            newExtensionConfig?.name ?? '',
            newExtensionConfig?.version ?? '',
            redactedInstallSource,
            'error',
          ),
        );
      }
      throw error;
    } finally {
      endMutation();
    }
  }

  async commitPreparedExtension(
    prepared: PreparedExtensionMutation,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<CommittedExtensionMutation> {
    return await this.commitPreparedExtensionInternal(
      prepared,
      true,
      onCommitted,
    );
  }

  private async commitPreparedExtensionInternal(
    prepared: PreparedExtensionMutation,
    emitMutation: boolean,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<CommittedExtensionMutation> {
    if (!this.preparedMutations.has(prepared)) {
      throw new InvalidPreparedExtensionError();
    }
    if (prepared.consumed) throw new PreparedExtensionConsumedError();
    prepared.consumed = true;
    const endMutation = emitMutation
      ? this.beginMutation(
          prepared.operation === 'update'
            ? 'updateExtension'
            : 'installExtension',
        )
      : () => undefined;
    try {
      let snapshot: ExtensionStoreSnapshot;
      try {
        const stagedExtension = await this.loadExtension(
          {
            extensionDir: prepared.stagingDirectory,
            workspaceDir: prepared.currentDir,
            trustedLinkSource:
              prepared.installMetadata?.type === 'link'
                ? prepared.installMetadata.source
                : undefined,
          },
          { throwOnError: true },
        );
        if (!stagedExtension) {
          throw new Error('Prepared extension could not be loaded.');
        }
        if (
          stagedExtension.id !== prepared.identity.id ||
          stagedExtension.name !== prepared.identity.name ||
          stagedExtension.version !== prepared.version
        ) {
          throw new Error('Prepared extension identity changed before commit.');
        }
        snapshot = await this.extensionStore.commitArtifact({
          operation: prepared.operation,
          identity: prepared.identity,
          stagingDirectory: prepared.stagingDirectory,
          destinationDirectory: prepared.destinationDirectory,
          ...(prepared.operation === 'install'
            ? { initialActivation: prepared.initialActivation }
            : {
                expectedArtifactGeneration:
                  prepared.expectedArtifactGeneration ?? 0,
              }),
          ...(prepared.installMetadata?.type === 'link'
            ? {
                linkedSource:
                  typeof prepared.installMetadata.source === 'string'
                    ? prepared.installMetadata.source
                    : undefined,
              }
            : {}),
        });
        prepared.commitGitCredential?.();
        prepared.gitCredentialActivated = true;
        prepared.settingsActivated = true;
      } catch (error) {
        const telemetryConfig = getTelemetryConfig(
          prepared.currentDir,
          this.telemetrySettings,
        );
        if (prepared.operation === 'update' && prepared.previousConfig) {
          logExtensionUpdateEvent(
            telemetryConfig,
            new ExtensionUpdateEvent(
              prepared.identity.name,
              prepared.identity.id,
              prepared.version,
              prepared.previousConfig.version,
              prepared.installMetadata.type,
              'error',
            ),
          );
        } else {
          logExtensionInstallEvent(
            telemetryConfig,
            new ExtensionInstallEvent(
              prepared.identity.name,
              prepared.version,
              redactUrlCredentials(prepared.installMetadata.source),
              'error',
            ),
          );
        }
        throw error;
      }
      const warnings: NonNullable<CommittedExtensionMutation['warnings']> = [];
      onCommitted?.(snapshot.generation);
      try {
        await prepared.commitSettings?.();
      } catch (error) {
        warnings.push({
          code: 'extension_settings_legacy_sync_failed',
          error: getErrorMessage(error),
        });
      }
      let extension: Extension | undefined;
      try {
        extension =
          (await this.loadExtension(
            {
              extensionDir: prepared.destinationDirectory,
              trustedLinkSource:
                prepared.installMetadata?.type === 'link'
                  ? prepared.installMetadata.source
                  : undefined,
            },
            { throwOnError: true },
          )) ?? undefined;
        if (!extension) throw new Error('Extension not found after commit.');
        this.extensionCache?.set(extension.name, extension);
        this.applyStoreActivation(snapshot);
      } catch (error) {
        this.extensionCache?.delete(prepared.identity.name);
        this.applyStoreActivation(snapshot);
        warnings.push({
          code: 'extension_reload_failed',
          error: getErrorMessage(error),
        });
      }

      const telemetryConfig = getTelemetryConfig(
        prepared.currentDir,
        this.telemetrySettings,
      );
      if (prepared.operation === 'update' && prepared.previousConfig) {
        logExtensionUpdateEvent(
          telemetryConfig,
          new ExtensionUpdateEvent(
            prepared.identity.name,
            prepared.identity.id,
            prepared.version,
            prepared.previousConfig.version,
            prepared.installMetadata.type,
            'success',
          ),
        );
      } else {
        logExtensionInstallEvent(
          telemetryConfig,
          new ExtensionInstallEvent(
            prepared.identity.name,
            prepared.version,
            redactUrlCredentials(prepared.installMetadata.source),
            'success',
          ),
        );
      }
      try {
        await this.refreshTools();
      } catch (error) {
        warnings.push({
          code: 'extension_runtime_refresh_failed',
          error: getErrorMessage(error),
        });
      }
      for (const error of await this.cleanupPreparedExtension(prepared)) {
        warnings.push({
          code: 'extension_temp_cleanup_failed',
          error: getErrorMessage(error),
        });
      }
      return {
        identity: prepared.identity,
        version: prepared.version,
        generation: snapshot.generation,
        ...(extension ? { extension } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } finally {
      endMutation();
    }
  }

  async disposePreparedExtension(
    prepared: PreparedExtensionMutation,
  ): Promise<void> {
    if (!this.preparedMutations.has(prepared)) {
      throw new InvalidPreparedExtensionError();
    }
    for (const error of await this.cleanupPreparedExtension(prepared)) {
      debugLogger.warn(
        `Failed to clean prepared extension files: ${getErrorMessage(error)}`,
      );
    }
  }

  private async cleanupPreparedExtension(
    prepared: PreparedExtensionMutation,
  ): Promise<unknown[]> {
    if (prepared.disposed) return [];
    const settingsCleanup =
      !prepared.settingsActivated && prepared.discardSettings
        ? await Promise.allSettled([prepared.discardSettings()])
        : [];
    const credentialCleanup =
      !prepared.gitCredentialActivated && prepared.discardGitCredential
        ? await Promise.allSettled([prepared.discardGitCredential()])
        : [];
    const settingsErrors = settingsCleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    const credentialErrors = credentialCleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    const paths = [prepared.stagingDirectory, ...prepared.cleanupPaths];
    let failedPaths = paths;
    let pathErrors: unknown[] = [];
    for (let attempt = 0; attempt < 2 && failedPaths.length > 0; attempt++) {
      const results = await Promise.allSettled(
        failedPaths.map(async (target) =>
          fs.promises.rm(target, { recursive: true, force: true }),
        ),
      );
      pathErrors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      failedPaths = failedPaths.filter(
        (_target, index) => results[index]?.status === 'rejected',
      );
    }
    const errors = [...settingsErrors, ...credentialErrors, ...pathErrors];
    prepared.disposed = errors.length === 0;
    return errors;
  }

  /**
   * Uninstalls an extension.
   */
  async uninstallExtension(
    extensionIdentifier: string,
    isUpdate: boolean,
    cwd?: string,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const endMutation = this.beginMutation('uninstallExtension');
    try {
      const currentDir = cwd ?? this.workspaceDir;
      const telemetryConfig = getTelemetryConfig(
        currentDir,
        this.telemetrySettings,
      );
      const installedExtensions = this.getLoadedExtensions();
      const extension = installedExtensions.find(
        (installed) =>
          installed.config.name.toLowerCase() ===
            extensionIdentifier.toLowerCase() ||
          installed.installMetadata?.source.toLowerCase() ===
            extensionIdentifier.toLowerCase(),
      );
      if (!extension) {
        throw new Error(`Extension not found.`);
      }
      return await this.uninstallExtensionPolicy(
        { id: extension.id, name: extension.name },
        extension.installMetadata?.type === 'link'
          ? path.join(this.configDir, extension.name)
          : extension.path,
        isUpdate,
        telemetryConfig,
        onCommitted,
        extension.installMetadata?.credentialPersistence === 'stored',
      );
    } finally {
      endMutation();
    }
  }

  async uninstallExtensionById(
    extensionId: string,
    isUpdate: boolean,
    cwd?: string,
    onCommitted?: ExtensionCommitCallback,
  ): Promise<ExtensionStoreMutationResult> {
    const endMutation = this.beginMutation('uninstallExtension');
    try {
      const snapshot = await this.extensionStore.readSnapshot();
      const policy = snapshot.extensions[extensionId];
      if (!policy || policy.declarationOnly) return snapshot;
      const extension = this.getLoadedExtensions().find(
        (candidate) => candidate.id === extensionId,
      );
      const destinationDirectory =
        extension && extension.installMetadata?.type !== 'link'
          ? extension.path
          : path.join(this.configDir, policy.name);
      const installMetadata =
        extension?.installMetadata ??
        this.loadInstallMetadata(destinationDirectory);
      return await this.uninstallExtensionPolicy(
        { id: extensionId, name: policy.name },
        destinationDirectory,
        isUpdate,
        getTelemetryConfig(cwd ?? this.workspaceDir, this.telemetrySettings),
        onCommitted,
        installMetadata?.credentialPersistence === 'stored',
      );
    } finally {
      endMutation();
    }
  }

  private async uninstallExtensionPolicy(
    identity: { id: string; name: string },
    destinationDirectory: string,
    isUpdate: boolean,
    telemetryConfig: Config,
    onCommitted?: ExtensionCommitCallback,
    hasStoredGitCredential = false,
  ): Promise<ExtensionStoreMutationResult> {
    let deleteGitCredential: (() => Promise<void>) | undefined;
    let credentialCleanupError: unknown;
    if (hasStoredGitCredential && !isUpdate) {
      try {
        deleteGitCredential =
          await prepareStoredGitCredentialDeletion(destinationDirectory);
      } catch (error) {
        credentialCleanupError = error;
      }
    }
    const snapshot = await this.extensionStore.commitArtifact({
      operation: 'uninstall',
      identity,
      destinationDirectory,
    });
    onCommitted?.(snapshot.generation);
    this.extensionCache?.delete(identity.name);
    if (isUpdate) return snapshot;
    const warnings: NonNullable<ExtensionStoreMutationResult['warnings']> = [];
    if (deleteGitCredential) {
      try {
        await deleteGitCredential();
      } catch (error) {
        credentialCleanupError = error;
      }
    }
    if (credentialCleanupError) {
      warnings.push({
        code: 'extension_credential_cleanup_failed',
        error: getErrorMessage(credentialCleanupError),
      });
    }
    try {
      this.preferencesStore.clear(identity.name);
    } catch (error) {
      debugLogger.warn(
        `Extension "${identity.name}" was uninstalled, but preference cleanup failed: ${getErrorMessage(error)}`,
      );
      warnings.push({
        code: 'extension_preferences_cleanup_failed',
        error: getErrorMessage(error),
      });
    }
    try {
      await this.refreshTools();
    } catch (error) {
      debugLogger.warn(
        `Extension "${identity.name}" was uninstalled, but runtime refresh failed: ${getErrorMessage(error)}`,
      );
      warnings.push({
        code: 'extension_runtime_refresh_failed',
        error: getErrorMessage(error),
      });
    }
    logExtensionUninstall(
      telemetryConfig,
      new ExtensionUninstallEvent(identity.name, 'success'),
    );
    return warnings.length > 0 ? { ...snapshot, warnings } : snapshot;
  }

  async performWorkspaceExtensionMigration(
    extensions: Extension[],
    requestConsent: (options?: ExtensionRequestOptions) => Promise<void>,
    requestSetting?: (setting: ExtensionSetting) => Promise<string>,
  ): Promise<string[]> {
    const failedInstallNames: string[] = [];

    for (const extension of extensions) {
      try {
        const installMetadata: ExtensionInstallMetadata = {
          source: extension.path,
          type: 'local',
          originSource: extension.installMetadata?.originSource || 'QwenCode',
        };
        await this.installExtension(
          installMetadata,
          requestConsent,
          requestSetting,
        );
      } catch (error) {
        if (
          isExtensionCommittedWithWarningsError(error) &&
          !error.warnings.some(
            (warning) => warning.code === 'extension_reload_failed',
          )
        ) {
          continue;
        }
        failedInstallNames.push(extension.config.name);
      }
    }
    return failedInstallNames;
  }

  async checkForAllExtensionUpdates(
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
    signal?: AbortSignal,
    schedule: <T>(task: () => Promise<T>) => Promise<T> = async (task) =>
      await task(),
  ): Promise<void> {
    const extensions = this.getLoadedExtensions();
    const promises: Array<Promise<void>> = [];
    for (const extension of extensions) {
      if (!extension.installMetadata) {
        callback(extension.name, ExtensionUpdateState.NOT_UPDATABLE);
        continue;
      }
      const installMetadata = this.withNetworkPolicy(extension.installMetadata);
      const extensionForUpdate =
        installMetadata === extension.installMetadata
          ? extension
          : { ...extension, installMetadata };
      callback(extension.name, ExtensionUpdateState.CHECKING_FOR_UPDATES);
      promises.push(
        schedule(
          async () =>
            await checkForExtensionUpdate(extensionForUpdate, this, signal),
        )
          .then((state) => callback(extension.name, state))
          .catch(() => {
            signal?.throwIfAborted();
            callback(extension.name, ExtensionUpdateState.ERROR);
          }),
      );
    }
    const results = await Promise.allSettled(promises);
    signal?.throwIfAborted();
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  async updateExtension(
    extension: Extension,
    currentState: ExtensionUpdateState,
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
    enableExtensionReloading: boolean = true,
    signal?: AbortSignal,
  ): Promise<ExtensionUpdateInfo | undefined> {
    if (currentState === ExtensionUpdateState.UPDATING) {
      return undefined;
    }
    callback(extension.name, ExtensionUpdateState.UPDATING);
    const installMetadata = this.loadInstallMetadata(extension.path);

    if (!installMetadata?.type) {
      callback(extension.name, ExtensionUpdateState.ERROR);
      throw new Error(
        `Extension ${extension.name} cannot be updated, type is unknown.`,
      );
    }
    if (installMetadata.type === 'snapshot') {
      callback(extension.name, ExtensionUpdateState.NOT_UPDATABLE);
      throw new ExtensionNotUpdatableError(extension.name);
    }
    if (installMetadata?.type === 'link') {
      callback(extension.name, ExtensionUpdateState.UP_TO_DATE);
      throw new Error(`Extension is linked so does not need to be updated`);
    }
    const endMutation = this.beginMutation('updateExtension');
    const originalVersion = extension.version;
    let prepared: PreparedExtensionMutation | undefined;

    try {
      prepared = await this.prepareExtensionUpdateFromState(extension, signal);
      const committed = await this.commitPreparedExtensionInternal(
        prepared,
        false,
      );
      const warnings = committed.warnings ?? [];
      for (const warning of warnings) {
        debugLogger.warn(
          `Update of "${extension.name}" warning: ${warning.code}: ${warning.error}`,
        );
      }
      const updatedVersion = committed.extension?.version ?? committed.version;
      const needsRestart = warnings.some(
        (warning) =>
          warning.code === 'extension_reload_failed' ||
          warning.code === 'extension_runtime_refresh_failed',
      );
      callback(
        extension.name,
        !committed.extension || needsRestart || !enableExtensionReloading
          ? ExtensionUpdateState.UPDATED_NEEDS_RESTART
          : warnings.length > 0
            ? ExtensionUpdateState.UPDATED_WITH_WARNINGS
            : ExtensionUpdateState.UPDATED,
      );
      return {
        name: extension.name,
        originalVersion,
        updatedVersion,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (e) {
      debugLogger.error(`Error updating extension. ${getErrorMessage(e)}`);
      callback(extension.name, ExtensionUpdateState.ERROR);
      throw e;
    } finally {
      if (prepared) await this.disposePreparedExtension(prepared);
      endMutation();
    }
  }

  async updateAllUpdatableExtensions(
    extensionsState: Map<string, ExtensionUpdateStatus>,
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
    enableExtensionReloading: boolean = true,
  ): Promise<ExtensionUpdateInfo[]> {
    const extensions = this.getLoadedExtensions();
    return (
      await Promise.all(
        extensions
          .filter(
            (extension) =>
              extensionsState.get(extension.name)?.status ===
              ExtensionUpdateState.UPDATE_AVAILABLE,
          )
          .map((extension) =>
            this.updateExtension(
              extension,
              extensionsState.get(extension.name)!.status,
              callback,
              enableExtensionReloading,
            ),
          ),
      )
    ).filter((updateInfo) => !!updateInfo);
  }

  async refreshTools(): Promise<void> {
    await refreshExtensionRuntime(this.config);
  }
}

export async function copyExtension(
  source: string,
  destination: string,
  options: {
    skipSymlinks?: boolean;
    excludeRootGitDirectory?: boolean;
  } = {},
): Promise<void> {
  const copySource = options.skipSymlinks
    ? await fs.promises.realpath(source)
    : source;
  await fs.promises.cp(copySource, destination, {
    recursive: true,
    dereference: !options.skipSymlinks,
    filter: async (src: string) => {
      try {
        if (
          options.excludeRootGitDirectory &&
          path.relative(copySource, src) === '.git'
        ) {
          return false;
        }
        const stats = options.skipSymlinks
          ? await fs.promises.lstat(src)
          : await fs.promises.stat(src);
        if (options.skipSymlinks && stats.isSymbolicLink()) return false;
        // Only copy regular files and directories
        // Skip sockets, FIFOs, block devices, and character devices
        return stats.isFile() || stats.isDirectory();
      } catch {
        // If we can't stat the file, skip it
        return false;
      }
    },
  });
}

export function getExtensionId(
  config: ExtensionConfig,
  installMetadata?: ExtensionInstallMetadata,
): string {
  if (
    installMetadata?.installId &&
    (installMetadata.type === 'snapshot' ||
      installMetadata.credentialPersistence === 'stored')
  ) {
    if (!/^[a-f0-9]{64}$/.test(installMetadata.installId)) {
      throw new Error('Stored extension install id is invalid.');
    }
    return installMetadata.installId;
  }
  let idValue = config.name;
  let githubUrlParts = null;
  if (
    installMetadata &&
    (installMetadata.type === 'git' ||
      installMetadata.type === 'github-release')
  ) {
    try {
      githubUrlParts = parseGitHubRepoForReleases(installMetadata.source);
    } catch {
      // Non-GitHub URL (GitLab, Bitbucket, etc.) - use source as-is
    }
  }
  if (githubUrlParts) {
    idValue = `https://github.com/${githubUrlParts.owner}/${githubUrlParts.repo}`;
  } else {
    idValue = installMetadata?.source ?? config.name;
  }
  // A marketplace repo can host several plugins; hashing only the repo URL
  // collapses them into one id and the second install trips the store's
  // id-ownership check (#7568). Suffix the plugin name so each plugin from
  // the same source gets its own id. Installs recorded under the old
  // repo-only id are re-keyed by ExtensionStore.ensureInitialized.
  if (installMetadata?.pluginName) {
    idValue += `:${installMetadata.pluginName}`;
  }
  return hashValue(idValue);
}

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateName(name: string) {
  if (!/^[a-zA-Z0-9-_.]+$/.test(name)) {
    throw new Error(
      `Invalid extension name: "${name}". Only letters (a-z, A-Z), numbers (0-9), underscores (_), dots (.), and dashes (-) are allowed.`,
    );
  }
}
