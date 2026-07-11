/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MCPServerConfig,
  ExtensionInstallMetadata,
  SkillConfig,
  SubagentConfig,
  ClaudeMarketplaceConfig,
} from '../index.js';
import type { HookEventName, HookDefinition } from '../hooks/types.js';
import {
  Storage,
  Config,
  logExtensionEnable,
  logExtensionInstallEvent,
  logExtensionUninstall,
  logExtensionDisable,
} from '../index.js';
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
  substituteHookVariables,
  performVariableReplacement,
} from './variables.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import {
  checkForExtensionUpdate,
  cloneFromGit,
  downloadFromArchiveUrl,
  downloadFromGitHubRelease,
  extractArchiveFile,
  isSupportedArchivePath,
  parseGitHubRepoForReleases,
} from './github.js';
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
import { convertGeminiOrClaudeExtension } from './extension-converter.js';
import { glob } from 'glob';
import { createHash } from 'node:crypto';
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
  type ExtensionStoreSnapshot,
  type InitialExtensionActivation,
} from './extension-store.js';

const debugLogger = createDebugLogger('EXTENSIONS');

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
  installMetadata?: ExtensionInstallMetadata;

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
  hooks?: { [K in HookEventName]?: HookDefinition[] };
  channels?: Record<string, ExtensionChannelConfig>;
}

export interface ExtensionUpdateInfo {
  name: string;
  originalVersion: string;
  updatedVersion: string;
}

export interface ExtensionCommittedWithWarningsError extends Error {
  code: 'extension_committed_with_warnings';
  committed: true;
}

export function isExtensionCommittedWithWarningsError(
  error: unknown,
): error is ExtensionCommittedWithWarningsError {
  return (
    error instanceof Error &&
    (error as Partial<ExtensionCommittedWithWarningsError>).code ===
      'extension_committed_with_warnings' &&
    (error as Partial<ExtensionCommittedWithWarningsError>).committed === true
  );
}

export interface ExtensionUpdateStatus {
  status: ExtensionUpdateState;
  processed: boolean;
}

export enum ExtensionUpdateState {
  CHECKING_FOR_UPDATES = 'checking for updates',
  UPDATED_NEEDS_RESTART = 'updated, needs restart',
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
}

export interface PrepareExtensionInstallOptions {
  installMetadata: ExtensionInstallMetadata;
  initialActivation: InitialExtensionActivation;
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
  private readonly preparedMutations = new WeakSet<PreparedExtensionMutation>();
  private discoverCache: DiscoveredPlugin[] | null = null;

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
    this.configDir = ExtensionStorage.getUserExtensionsDir();
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
    this.extensionStore = options.extensionStore ?? new ExtensionStore();
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
  ): Promise<ExtensionStoreSnapshot> {
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
      const config = getTelemetryConfig(currentDir, this.telemetrySettings);
      logExtensionEnable(config, new ExtensionEnableEvent(name, scope));
      this.applyStoreActivation(snapshot);
      await this.refreshTools().catch((error) => {
        debugLogger.warn(
          `Extension "${name}" was enabled, but runtime refresh failed: ${getErrorMessage(error)}`,
        );
      });
      return snapshot;
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
  ): Promise<ExtensionStoreSnapshot> {
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
      logExtensionDisable(config, new ExtensionDisableEvent(name, scope));
      this.applyStoreActivation(snapshot);
      await this.refreshTools().catch((error) => {
        debugLogger.warn(
          `Extension "${name}" was disabled, but runtime refresh failed: ${getErrorMessage(error)}`,
        );
      });
      return snapshot;
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
    const extension = this.findExtensionById(extensionId);
    const snapshot = await this.extensionStore.readSnapshot();
    return this.extensionStore.getActivation(
      snapshot,
      extension.id,
      extension.name,
      workspacePath,
    );
  }

  async setExtensionDefaultActivation(
    extensionId: string,
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('setExtensionDefaultActivation');
    try {
      const snapshot = await this.extensionStore.setDefaultActivation(
        { id: extension.id, name: extension.name },
        activation,
      );
      this.applyStoreActivation(snapshot);
      return snapshot;
    } finally {
      endMutation();
    }
  }

  async setExtensionActivationScope(
    extensionId: string,
    activation: InitialExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('setExtensionActivationScope');
    try {
      const snapshot = await this.extensionStore.setActivationScope(
        { id: extension.id, name: extension.name },
        activation,
      );
      this.applyStoreActivation(snapshot);
      return snapshot;
    } finally {
      endMutation();
    }
  }

  async setExtensionWorkspaceActivation(
    extensionId: string,
    workspacePath: string,
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('setExtensionWorkspaceActivation');
    try {
      const snapshot = await this.extensionStore.setWorkspaceActivation(
        { id: extension.id, name: extension.name },
        workspacePath,
        activation,
      );
      this.applyStoreActivation(snapshot);
      return snapshot;
    } finally {
      endMutation();
    }
  }

  async clearExtensionWorkspaceActivation(
    extensionId: string,
    workspacePath: string,
  ): Promise<ExtensionStoreSnapshot> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('clearExtensionWorkspaceActivation');
    try {
      const snapshot = await this.extensionStore.clearWorkspaceActivation(
        { id: extension.id, name: extension.name },
        workspacePath,
      );
      this.applyStoreActivation(snapshot);
      return snapshot;
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
    const config = await loadMarketplaceConfigFromSource(trimmed);
    if (!config) {
      // A "marketplace" is a Claude-format collection (.claude-plugin/
      // marketplace.json). A single extension repo (Gemini/Claude/git/npm) is
      // not a marketplace — guide the user to install it directly instead.
      let isInstallableExtension = false;
      try {
        await parseInstallSource(trimmed);
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
    return loadMarketplaceConfigFromSource(source);
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
    const result = await discoverPlugins(this.getSources(), installedNames);
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
    const requestedNames = options?.names?.filter(Boolean) ?? [];
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
            ExtensionStorage.getUserExtensionsDir(),
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
    const userExtensionsDir = ExtensionStorage.getUserExtensionsDir();
    if (!fs.existsSync(userExtensionsDir)) {
      return null;
    }

    for (const subdir of fs.readdirSync(userExtensionsDir)) {
      const extensionDir = path.join(userExtensionsDir, subdir);
      if (!fs.statSync(extensionDir).isDirectory()) {
        continue;
      }
      const extension = await this.loadExtension({
        extensionDir,
        workspaceDir: cwd,
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

    const extensions: Extension[] = [];
    for (const subdir of subdirs) {
      const extensionDir = path.join(extensionsDir, subdir);
      const extension = await this.loadExtension({
        extensionDir,
        workspaceDir,
      });
      if (extension != null) {
        extensions.push(extension);
      }
    }
    return extensions;
  }

  async loadExtension(
    context: LoadExtensionContext,
  ): Promise<Extension | null> {
    const { extensionDir, workspaceDir } = context;
    if (!fs.statSync(extensionDir).isDirectory()) {
      return null;
    }

    const installMetadata = this.loadInstallMetadata(extensionDir);
    let effectiveExtensionPath = extensionDir;

    if (installMetadata?.type === 'link') {
      effectiveExtensionPath = installMetadata.source;
    }

    try {
      let config = this.loadExtensionConfig({
        extensionDir: effectiveExtensionPath,
        workspaceDir,
      });

      config = resolveEnvVarsInObject(config);

      const extension: Extension = {
        id: getExtensionId(config, installMetadata),
        name: config.name,
        displayName: config.displayName,
        version:
          config.version ||
          installMetadata?.marketplaceConfig?.metadata?.version ||
          '1.0.0',
        path: effectiveExtensionPath,
        installMetadata,
        isActive: this.isEnabled(config.name, this.workspaceDir),
        config,
        settings: config.settings,
        contextFiles: [],
      };

      if (config.mcpServers) {
        extension.mcpServers = Object.fromEntries(
          Object.entries(config.mcpServers).map(([key, value]) => [
            key,
            filterMcpConfig(value),
          ]),
        );
      }

      if (config.channels) {
        extension.channels = config.channels;
      }

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

      if (config.hooks && typeof config.hooks !== 'string') {
        // Process the hooks to substitute variables like ${CLAUDE_PLUGIN_ROOT}
        extension.hooks = this.substituteHookVariables(
          config.hooks,
          effectiveExtensionPath,
        );
      }

      // Also load hooks from hooks directory or from config.hooks string path if available and not already set
      if (!extension.hooks) {
        const hooksDir = path.join(effectiveExtensionPath, 'hooks');
        const hooksJsonPath = path.join(hooksDir, 'hooks.json');

        const configHooksPath =
          typeof config.hooks === 'string'
            ? path.isAbsolute(config.hooks)
              ? config.hooks
              : path.join(effectiveExtensionPath, config.hooks)
            : null;

        if (
          fs.existsSync(hooksJsonPath) ||
          (configHooksPath && fs.existsSync(configHooksPath))
        ) {
          const hooksFilePath =
            configHooksPath && fs.existsSync(configHooksPath)
              ? configHooksPath
              : hooksJsonPath;

          try {
            const hooksContent = fs.readFileSync(hooksFilePath, 'utf-8');
            const parsedHooks = JSON.parse(hooksContent);

            let hooksData;
            if (parsedHooks.hooks && typeof parsedHooks.hooks === 'object') {
              hooksData = parsedHooks.hooks as {
                [K in HookEventName]?: HookDefinition[];
              };
            } else {
              // Assume the entire file content is the hooks object
              hooksData = parsedHooks as {
                [K in HookEventName]?: HookDefinition[];
              };
            }

            // Process the hooks to substitute variables like ${CLAUDE_PLUGIN_ROOT}
            extension.hooks = this.substituteHookVariables(
              hooksData,
              effectiveExtensionPath,
            );
          } catch (error) {
            debugLogger.warn(
              `Failed to parse hooks file ${hooksJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      return extension;
    } catch (e) {
      debugLogger.warn(
        `Warning: Skipping extension in ${effectiveExtensionPath}: ${getErrorMessage(
          e,
        )}`,
      );
      return null;
    }
  }

  /**
   * Substitute variables in hook configurations, particularly ${CLAUDE_PLUGIN_ROOT}
   */
  private substituteHookVariables(
    hooks: { [K in HookEventName]?: HookDefinition[] } | undefined,
    extensionPath: string,
  ): { [K in HookEventName]?: HookDefinition[] } | undefined {
    return substituteHookVariables(hooks, extensionPath);
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
    const { extensionDir, workspaceDir = this.workspaceDir } = context;
    const configFilePath = path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME);
    if (!fs.existsSync(configFilePath)) {
      throw new Error(`Configuration file not found at ${configFilePath}`);
    }
    try {
      const configContent = fs.readFileSync(configFilePath, 'utf-8');
      const rawConfig = recursivelyHydrateStrings(JSON.parse(configContent), {
        extensionPath: extensionDir,
        CLAUDE_PLUGIN_ROOT: extensionDir,
        workspacePath: workspaceDir,
        '/': path.sep,
        pathSeparator: path.sep,
      }) as unknown as RawExtensionConfig;

      const config = resolveExtensionConfigLocale(rawConfig, this.locale);

      if (!config.name) {
        throw new Error(
          `Invalid configuration in ${configFilePath}: missing "name"`,
        );
      }
      validateName(config.name);
      return config;
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
        if (!committed.extension) {
          const error = new Error(
            `Extension "${prepared.identity.name}" committed but could not be reloaded.`,
          ) as ExtensionCommittedWithWarningsError;
          error.code = 'extension_committed_with_warnings';
          error.committed = true;
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
    const previousConfig = this.loadExtensionConfig({
      extensionDir: extension.path,
    });
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
    )) as PreparedExtensionMutation;
  }

  async prepareExtensionUpdate(
    options: PrepareExtensionUpdateOptions,
  ): Promise<
    | { upToDate: true; extension: Extension }
    | { upToDate: false; prepared: PreparedExtensionMutation }
  > {
    const state = await checkForExtensionUpdate(
      options.extension,
      this,
      options.signal,
    );
    if (state === ExtensionUpdateState.UP_TO_DATE) {
      return { upToDate: true, extension: options.extension };
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
  ): Promise<Extension | PreparedExtensionMutation> {
    const currentDir = cwd ?? this.workspaceDir;
    const telemetryConfig = getTelemetryConfig(
      currentDir,
      this.telemetrySettings,
    );
    let extension: Extension | null;
    const redactedInstallSource = redactUrlCredentials(installMetadata.source);

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

      const extensionsDir = ExtensionStorage.getUserExtensionsDir();
      await fs.promises.mkdir(extensionsDir, { recursive: true });

      if (
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
          // downloadFromGitHubRelease may have written a partial archive or
          // extracted files into tempDir before failing (e.g. a repo whose
          // latest release is a source tarball that isn't a valid extension
          // archive). Reusing that dirty directory makes `git clone` fail with
          // "destination path '.' already exists and is not an empty directory".
          // Recreate a clean tempDir before falling back to a plain clone.
          // See #6334.
          await fs.promises.rm(tempDir, { recursive: true, force: true });
          await fs.promises.mkdir(tempDir, { recursive: true });
          await cloneFromGit(installMetadata, tempDir, signal);
          if (installMetadata.type === 'github-release') {
            installMetadata.type = 'git';
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
        isSupportedArchivePath(installMetadata.source)
      ) {
        tempDir = await ExtensionStorage.createTmpDir();
        await extractArchiveFile(installMetadata.source, tempDir);
        localSourcePath = tempDir;
      } else if (
        installMetadata.type === 'local' ||
        installMetadata.type === 'link'
      ) {
        localSourcePath = installMetadata.source;
      } else {
        throw new Error(`Unsupported install type: ${installMetadata.type}`);
      }

      try {
        const sourceBeforeConversion = localSourcePath;
        const { extensionDir, originSource } =
          await convertGeminiOrClaudeExtension(
            sourceBeforeConversion,
            installMetadata.pluginName,
          );

        if (extensionDir !== sourceBeforeConversion) {
          convertedSourcePath = extensionDir;
        }
        localSourcePath = extensionDir;
        installMetadata.originSource = originSource;

        newExtensionConfig = this.loadExtensionConfig({
          extensionDir: localSourcePath,
          workspaceDir: currentDir,
        });

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

        const commands = await loadCommandsFromDir(
          `${localSourcePath}/commands`,
        );
        const previousCommands = previous?.commands ?? [];

        const skills = await loadSkillsFromDir(`${localSourcePath}/skills`);
        const previousSkills = previous?.skills ?? [];

        const subagents = await loadSubagentFromDir(
          `${localSourcePath}/agents`,
        );
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
            originSource: installMetadata.originSource,
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
            originSource: installMetadata.originSource,
          });
        }

        const extensionStorage = new ExtensionStorage(newExtensionName);
        const destinationPath = extensionStorage.getExtensionDir();
        const extensionId = getExtensionId(newExtensionConfig, installMetadata);
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
          await copyExtension(localSourcePath, stagingPath);
        }

        if (isUpdate) {
          await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
            previousExtensionConfig,
            previousSettings,
            path.join(stagingPath, EXTENSION_SETTINGS_FILENAME),
          );
        } else {
          await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
            undefined,
            undefined,
            path.join(stagingPath, EXTENSION_SETTINGS_FILENAME),
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

        if (
          (originSource === 'Claude' && fs.existsSync(hooksDir)) ||
          (originSource === 'Claude' &&
            configHooksPath &&
            fs.existsSync(configHooksPath))
        ) {
          try {
            await performVariableReplacement(stagingPath);
          } catch (error) {
            debugLogger.error('Variable replacement failed', error);
          }
        }

        const metadataString = JSON.stringify(installMetadata, null, 2);
        const metadataPath = path.join(stagingPath, INSTALL_METADATA_FILENAME);
        await atomicWriteFile(metadataPath, metadataString);

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
            version: newExtensionConfig.version,
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
            consumed: false,
            disposed: false,
          };
          this.preparedMutations.add(prepared);
          ownershipTransferred = true;
          return prepared;
        }
        await this.extensionStore.commitArtifact({
          operation: isUpdate ? 'update' : 'install',
          identity: { id: extensionId, name: newExtensionName },
          stagingDirectory: stagingPath,
          destinationDirectory: destinationPath,
          ...(!isUpdate ? { initialActivation } : {}),
          ...(expectedArtifactGeneration === undefined
            ? {}
            : { expectedArtifactGeneration }),
        });
        stagingPath = undefined;

        extension = await this.loadExtension({ extensionDir: destinationPath });
        if (!extension) {
          throw new Error(`Extension not found`);
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
              redactUrlCredentials(installMetadata.source),
              'success',
            ),
          );
        }
        if (this.extensionCache) {
          const snapshot = await this.extensionStore.readSnapshot();
          this.applyStoreActivation(snapshot);
        }
        await this.refreshTools().catch((error) => {
          debugLogger.warn(
            `Extension "${newExtensionName}" was installed, but runtime refresh failed: ${getErrorMessage(error)}`,
          );
        });
      } finally {
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
            'error',
          ),
        );
      } else {
        logExtensionInstallEvent(
          telemetryConfig,
          new ExtensionInstallEvent(
            newExtensionConfig?.name ?? '',
            newExtensionConfig?.version ?? '',
            redactUrlCredentials(installMetadata.source),
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
  ): Promise<CommittedExtensionMutation> {
    return await this.commitPreparedExtensionInternal(prepared, true);
  }

  private async commitPreparedExtensionInternal(
    prepared: PreparedExtensionMutation,
    emitMutation: boolean,
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
      const snapshot = await this.extensionStore.commitArtifact({
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
      });
      const warnings: NonNullable<CommittedExtensionMutation['warnings']> = [];
      let extension: Extension | undefined;
      try {
        extension =
          (await this.loadExtension({
            extensionDir: prepared.destinationDirectory,
          })) ?? undefined;
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
    prepared.disposed = true;
    const results = await Promise.allSettled([
      fs.promises.rm(prepared.stagingDirectory, {
        recursive: true,
        force: true,
      }),
      ...prepared.cleanupPaths.map((cleanupPath) =>
        fs.promises.rm(cleanupPath, { recursive: true, force: true }),
      ),
    ]);
    return results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
  }

  /**
   * Uninstalls an extension.
   */
  async uninstallExtension(
    extensionIdentifier: string,
    isUpdate: boolean,
    cwd?: string,
  ): Promise<ExtensionStoreSnapshot> {
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
      const storage = new ExtensionStorage(
        extension.installMetadata?.type === 'link'
          ? extension.name
          : path.basename(extension.path),
      );

      const snapshot = await this.extensionStore.commitArtifact({
        operation: 'uninstall',
        identity: { id: extension.id, name: extension.name },
        destinationDirectory: storage.getExtensionDir(),
      });

      if (this.extensionCache) {
        this.extensionCache.delete(extension.name);
      }

      if (isUpdate) return snapshot;

      try {
        this.preferencesStore.clear(extension.name);
      } catch (error) {
        debugLogger.warn(
          `Extension "${extension.name}" was uninstalled, but preference cleanup failed: ${getErrorMessage(error)}`,
        );
      }
      await this.refreshTools().catch((error) => {
        debugLogger.warn(
          `Extension "${extension.name}" was uninstalled, but runtime refresh failed: ${getErrorMessage(error)}`,
        );
      });

      logExtensionUninstall(
        telemetryConfig,
        new ExtensionUninstallEvent(extension.name, 'success'),
      );
      return snapshot;
    } finally {
      endMutation();
    }
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
        if (isExtensionCommittedWithWarningsError(error)) continue;
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
      callback(extension.name, ExtensionUpdateState.CHECKING_FOR_UPDATES);
      promises.push(
        schedule(
          async () => await checkForExtensionUpdate(extension, this, signal),
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
      if (!committed.extension) {
        callback(extension.name, ExtensionUpdateState.UPDATED_NEEDS_RESTART);
        return {
          name: extension.name,
          originalVersion,
          updatedVersion: committed.version,
        };
      }
      const updatedVersion = committed.extension.version;
      callback(
        extension.name,
        enableExtensionReloading
          ? ExtensionUpdateState.UPDATED
          : ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      );
      return {
        name: extension.name,
        originalVersion,
        updatedVersion,
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
): Promise<void> {
  await fs.promises.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: async (src: string) => {
      try {
        const stats = await fs.promises.stat(src);
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
