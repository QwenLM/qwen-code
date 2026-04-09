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

import { getErrorMessage } from '../utils/errors.js';
import {
  EXTENSIONS_CONFIG_FILENAME,
  INSTALL_METADATA_FILENAME,
  recursivelyHydrateStrings,
  substituteHookVariables,
  performVariableReplacement,
} from './variables.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import {
  checkForExtensionUpdate,
  cloneFromGit,
  downloadFromGitHubRelease,
  parseGitHubRepoForReleases,
} from './github.js';
import { downloadFromNpmRegistry } from './npm.js';
import type { LoadExtensionContext } from './variableSchema.js';
import { Override, type AllExtensionsEnablementConfig } from './override.js';
import {
  isGeminiExtensionConfig,
  convertGeminiExtensionPackage,
} from './gemini-converter.js';
import { convertClaudePluginPackage } from './claude-converter.js';
import { glob } from 'glob';
import { createHash } from 'node:crypto';
import { ExtensionStorage } from './storage.js';
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
  telemetrySettings?: TelemetrySettings;
  config?: Config;
  requestConsent?: (options?: ExtensionRequestOptions) => Promise<void>;
  requestSetting?: (setting: ExtensionSetting) => Promise<string>;
  requestChoicePlugin?: (
    marketplace: ClaudeMarketplaceConfig,
  ) => Promise<string>;
}

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
    const mdFiles = await glob('**/*.md', {
      ...globOptions,
      cwd: dir,
    });

    const commandNames = mdFiles.map((file) => {
      const relativePathWithExt = path.relative(dir, path.join(dir, file));
      const relativePath = relativePathWithExt.substring(
        0,
        relativePathWithExt.length - 3,
      );
      const commandName = relativePath
        .split(path.sep)
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

async function convertGeminiOrClaudeExtension(
  extensionDir: string,
  pluginName?: string,
): Promise<{ extensionDir: string; originSource: ExtensionOriginSource }> {
  let newExtensionDir = extensionDir;
  let originSource: ExtensionOriginSource = 'QwenCode';
  const configFilePath = path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME);
  if (fs.existsSync(configFilePath)) {
    newExtensionDir = extensionDir;
  } else if (isGeminiExtensionConfig(extensionDir)) {
    newExtensionDir = (await convertGeminiExtensionPackage(extensionDir))
      .convertedDir;
    originSource = 'Gemini';
  } else if (pluginName) {
    newExtensionDir = (
      await convertClaudePluginPackage(extensionDir, pluginName)
    ).convertedDir;
    originSource = 'Claude';
  }
  // Claude plugin conversion not yet implemented
  return { extensionDir: newExtensionDir, originSource };
}

// ============================================================================
// ExtensionManager Class
// ============================================================================

export class ExtensionManager {
  private extensionCache: Map<string, Extension> | null = null;

  // Enablement configuration (directly implemented)
  private readonly configDir: string;
  private readonly configFilePath: string;
  private readonly enabledExtensionNamesOverride: string[];
  private readonly workspaceDir: string;

  private config?: Config;
  private telemetrySettings?: TelemetrySettings;
  private isWorkspaceTrusted: boolean;
  private requestConsent: (options?: ExtensionRequestOptions) => Promise<void>;
  private requestSetting?: (setting: ExtensionSetting) => Promise<string>;
  private requestChoicePlugin: (
    marketplace: ClaudeMarketplaceConfig,
  ) => Promise<string>;

  constructor(options: ExtensionManagerOptions) {
    this.workspaceDir = options.workspaceDir ?? process.cwd();
    this.enabledExtensionNamesOverride =
      options.enabledExtensionOverrides?.map((name) => name.toLowerCase()) ??
      [];
    this.configDir = ExtensionStorage.getUserExtensionsDir();
    this.configFilePath = path.join(
      this.configDir,
      'extension-enablement.json',
    );
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
    for (const rule of allOverrides) {
      const override = Override.fromFileRule(rule);
      if (override.matchesPath(ensureLeadingAndTrailingSlash(checkPath))) {
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
  ): Promise<void> {
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
    const scopePath =
      scope === SettingScope.Workspace ? currentDir : os.homedir();
    this.enableByPath(name, true, scopePath);
    const config = getTelemetryConfig(currentDir, this.telemetrySettings);
    logExtensionEnable(config, new ExtensionEnableEvent(name, scope));
    extension.isActive = true;
    await this.refreshTools();
  }

  /**
   * Disables an extension at the specified scope.
   */
  async disableExtension(
    name: string,
    scope: SettingScope,
    cwd?: string,
  ): Promise<void> {
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
    const scopePath =
      scope === SettingScope.Workspace ? currentDir : os.homedir();
    this.disableByPath(name, true, scopePath);
    logExtensionDisable(config, new ExtensionDisableEvent(name, scope));
    extension.isActive = false;
    await this.refreshTools();
  }

  /**
   * Removes enablement configuration for an extension.
   */
  removeEnablementConfig(extensionName: string): void {
    const config = this.readEnablementConfig();
    if (config[extensionName]) {
      delete config[extensionName];
      this.writeEnablementConfig(config);
    }
  }

  private enableByPath(
    extensionName: string,
    includeSubdirs: boolean,
    scopePath: string,
  ): void {
    const config = this.readEnablementConfig();
    if (!config[extensionName]) {
      config[extensionName] = { overrides: [] };
    }
    const override = Override.fromInput(scopePath, includeSubdirs);
    const overrides = config[extensionName].overrides.filter((rule) => {
      const fileOverride = Override.fromFileRule(rule);
      if (
        fileOverride.conflictsWith(override) ||
        fileOverride.isEqualTo(override)
      ) {
        return false;
      }
      return !fileOverride.isChildOf(override);
    });
    overrides.push(override.output());
    config[extensionName].overrides = overrides;
    this.writeEnablementConfig(config);
  }

  private disableByPath(
    extensionName: string,
    includeSubdirs: boolean,
    scopePath: string,
  ): void {
    this.enableByPath(extensionName, includeSubdirs, `!${scopePath}`);
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

  private writeEnablementConfig(config: AllExtensionsEnablementConfig): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2));
  }

  /**
   * Refreshes the extension cache from disk.
   */
  async refreshCache(): Promise<void> {
    this.extensionCache = new Map<string, Extension>();
    const userExtensionsDir = ExtensionStorage.getUserExtensionsDir();

    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(userExtensionsDir);
    } catch {
      return;
    }

    for (const subdir of subdirs) {
      const extensionDir = path.join(userExtensionsDir, subdir);
      const extension = await this.loadExtension({
        extensionDir,
        workspaceDir: this.workspaceDir,
      });
      if (extension != null) {
        this.extensionCache!.set(extension.name, extension);
      }
    }
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
    const extensionsDir = storage.getExtensionsDir();

    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(extensionsDir);
    } catch {
      // Directory doesn't exist or is inaccessible
      return [];
    }

    const extensions: Extension[] = [];
    for (const subdir of subdirs) {
      const extensionDir = path.join(extensionsDir, subdir);

      const extension = await this.loadExtension({
        extensionDir,
        workspaceDir: dir,
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
      const config = recursivelyHydrateStrings(JSON.parse(configContent), {
        extensionPath: extensionDir,
        CLAUDE_PLUGIN_ROOT: extensionDir,
        workspacePath: workspaceDir,
        '/': path.sep,
        pathSeparator: path.sep,
      }) as unknown as ExtensionConfig;

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
  ): Promise<Extension> {
    const currentDir = cwd ?? this.workspaceDir;
    const telemetryConfig = getTelemetryConfig(
      currentDir,
      this.telemetrySettings,
    );
    let extension: Extension | null;

    const isUpdate = !!previousExtensionConfig;
    let newExtensionConfig: ExtensionConfig | null = null;
    let localSourcePath: string | undefined;

    try {
      if (!this.isWorkspaceTrusted) {
        throw new Error(
          `Could not install extension from untrusted folder at ${installMetadata.source}`,
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

      let tempDir: string | undefined;

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
          );
          if (
            installMetadata.type === 'git' ||
            installMetadata.type === 'github-release'
          ) {
            installMetadata.type = result.type;
            installMetadata.releaseTag = result.tagName;
          }
        } catch (_error) {
          await cloneFromGit(installMetadata, tempDir);
          if (installMetadata.type === 'github-release') {
            installMetadata.type = 'git';
          }
        }
        localSourcePath = tempDir;
      } else if (installMetadata.type === 'npm') {
        tempDir = await ExtensionStorage.createTmpDir();
        const result = await downloadFromNpmRegistry(installMetadata, tempDir);
        installMetadata.releaseTag = result.version;
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
        const { extensionDir, originSource } =
          await convertGeminiOrClaudeExtension(
            localSourcePath,
            installMetadata.pluginName,
          );

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
          (installed) => installed.name === newExtensionName,
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
        let previousSettings: Record<string, string> | undefined;
        if (isUpdate) {
          previousSettings = await getEnvContents(
            previousExtensionConfig,
            extensionId,
          );
          await this.uninstallExtension(newExtensionName, isUpdate);
        }
        await fs.promises.mkdir(destinationPath, { recursive: true });

        if (isUpdate) {
          await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
            previousExtensionConfig,
            previousSettings,
          );
        } else {
          await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
          );
        }

        if (installMetadata.type !== 'link') {
          await copyExtension(localSourcePath, destinationPath);
        }

        // Perform variable replacement in extension files (e.g., ${CLAUDE_PLUGIN_ROOT}) for Claude extensions
        const hooksDir = path.join(destinationPath, 'hooks');
        const configHooksPath =
          typeof newExtensionConfig.hooks === 'string'
            ? path.isAbsolute(newExtensionConfig.hooks)
              ? newExtensionConfig.hooks
              : path.join(destinationPath, newExtensionConfig.hooks)
            : null;

        if (
          (originSource === 'Claude' && fs.existsSync(hooksDir)) ||
          (originSource === 'Claude' &&
            configHooksPath &&
            fs.existsSync(configHooksPath))
        ) {
          try {
            await performVariableReplacement(destinationPath);
          } catch (error) {
            debugLogger.error('Variable replacement failed', error);
          }
        }

        const metadataString = JSON.stringify(installMetadata, null, 2);
        const metadataPath = path.join(
          destinationPath,
          INSTALL_METADATA_FILENAME,
        );
        await fs.promises.writeFile(metadataPath, metadataString);

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
          await this.refreshTools();
        } else {
          logExtensionInstallEvent(
            telemetryConfig,
            new ExtensionInstallEvent(
              newExtensionConfig.name,
              newExtensionConfig!.version,
              installMetadata.source,
              'success',
            ),
          );
          this.enableExtension(newExtensionConfig.name, SettingScope.User);
        }
      } finally {
        if (tempDir) {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
        if (
          localSourcePath !== tempDir &&
          installMetadata.type !== 'link' &&
          installMetadata.type !== 'local'
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
            installMetadata.source,
            'error',
          ),
        );
      }
      throw error;
    }
  }

  /**
   * Uninstalls an extension.
   */
  async uninstallExtension(
    extensionIdentifier: string,
    isUpdate: boolean,
    cwd?: string,
  ): Promise<void> {
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

    await fs.promises.rm(storage.getExtensionDir(), {
      recursive: true,
      force: true,
    });

    if (this.extensionCache) {
      this.extensionCache.delete(extension.name);
    }

    if (isUpdate) return;

    this.removeEnablementConfig(extension.name);
    await this.refreshTools();

    logExtensionUninstall(
      telemetryConfig,
      new ExtensionUninstallEvent(extension.name, 'success'),
    );
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
      } catch (_) {
        failedInstallNames.push(extension.config.name);
      }
    }
    return failedInstallNames;
  }

  async checkForAllExtensionUpdates(
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
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
        checkForExtensionUpdate(extension, this)
          .then((state) => callback(extension.name, state))
          .catch(() => callback(extension.name, ExtensionUpdateState.ERROR)),
      );
    }
    await Promise.all(promises);
  }

  async updateExtension(
    extension: Extension,
    currentState: ExtensionUpdateState,
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
    enableExtensionReloading: boolean = true,
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
    const originalVersion = extension.version;

    const tempDir = await ExtensionStorage.createTmpDir();
    try {
      const previousExtensionConfig = this.loadExtensionConfig({
        extensionDir: extension.path,
      });
      let updatedExtension: Extension;
      try {
        updatedExtension = await this.installExtension(
          installMetadata,
          undefined,
          undefined,
          undefined,
          previousExtensionConfig,
        );
      } catch (e) {
        callback(extension.name, ExtensionUpdateState.ERROR);
        throw new Error(
          `Updated extension not found after installation, got error:\n${e}`,
        );
      }
      const updatedVersion = updatedExtension.version;
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
      debugLogger.error(
        `Error updating extension, rolling back. ${getErrorMessage(e)}`,
      );
      callback(extension.name, ExtensionUpdateState.ERROR);
      await copyExtension(tempDir, extension.path);
      throw e;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
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

  async refreshMemory(): Promise<void> {
    if (!this.config) return;
    // refresh mcp servers
    await this.config.getToolRegistry().restartMcpServers();
    // refresh skills
    this.config.getSkillManager()?.refreshCache();
    // refresh subagents
    this.config.getSubagentManager().refreshCache();
    // refresh context files
    this.config.refreshHierarchicalMemory();
  }

  async refreshTools(): Promise<void> {
    if (!this.config) return;
    // FIXME: restart all mcp servers now, this can be optimized by only restarting changed ones at here
    await this.refreshMemory();
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
