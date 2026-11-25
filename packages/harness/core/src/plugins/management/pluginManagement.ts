/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings, MergedSettings } from '@qwen-code/resource';
import { resolve as resolvePath } from 'node:path';
import type { Config } from '../../config/config.js';
import { BRAND_CLI_BIN } from '../../config/brand.js';
import { parseArguments } from '../../utils/argumentSubstitution.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  getPluginGitTimeoutMs,
  getPluginTimeoutSeconds,
} from '../pluginGit.js';
import { getEffectiveBlockedMarketplaces } from '../pluginPolicy.js';
import { clearAllPluginCaches } from '../refresh.js';
import type { PluginError } from '../types.js';
import type { PluginValidationReport } from '../validation/validatePlugin.js';
import type { InstalledPluginsState } from './installedPluginsManager.js';
import {
  listKnownMarketplaces,
  loadKnownMarketplacesConfig,
  refreshAllMarketplaces,
  refreshMarketplace,
} from './marketplaceManager.js';
import { addConfiguredMarketplace } from './marketplaceOperations.js';
import { getLoadedPluginId } from './pluginDependencies.js';
import {
  PluginManagerError,
  PLUGIN_MANAGEMENT_SCOPES,
  type PluginListRow,
  type PluginManagementScope,
  type PluginManager,
  type StaleEnabledPluginSetting,
} from './pluginManager.js';
import {
  createCorePluginManager,
  type PluginSettingsAccess,
  type PluginSettingsReader,
} from './pluginManagerSettings.js';

type CommandSettings = Pick<
  LoadedSettings,
  | 'merged'
  | 'isTrusted'
  | 'forScope'
  | 'setValue'
  | 'deleteValue'
  | 'mutateScope'
>;

export const VALID_PLUGIN_SCOPES = PLUGIN_MANAGEMENT_SCOPES;
export type PluginCliScope = PluginManagementScope;

export { PluginManagerError as PluginCommandError };

export function getMarketplaceOperationTimeoutMs(): number {
  return getPluginGitTimeoutMs();
}

export function getRemainingOperationSeconds(
  startedAt: number,
  timeoutMs = getMarketplaceOperationTimeoutMs(),
): number {
  const elapsedMs = Date.now() - startedAt;
  return Math.max(0, Math.ceil((timeoutMs - elapsedMs) / 1000));
}

export function formatMarketplaceOperationStatus(
  action: string,
  options: {
    target?: string;
    detail?: string;
    remainingSeconds?: number;
    timeoutMs?: number;
  } = {},
): string {
  const remainingSeconds =
    options.remainingSeconds ?? getPluginTimeoutSeconds(options.timeoutMs);
  const target = options.target ? ` "${options.target}"` : '';
  const detail = options.detail ? ` - ${options.detail}` : '';

  return `${action} marketplace${target}... ${remainingSeconds}s until timeout${detail}`;
}

export function getPluginCommandError(error: unknown): PluginError | undefined {
  return error instanceof PluginManagerError ? error.pluginError : undefined;
}

export function inferPluginErrorCode(error: unknown): string {
  const pluginError = getPluginCommandError(error);
  if (pluginError) {
    switch (pluginError.type) {
      case 'manifest-parse-error':
      case 'manifest-validation-error':
        return 'plugin_manifest_invalid';
      case 'plugin-not-found':
        return 'plugin_not_found';
      case 'marketplace-blocked-by-policy':
        return 'plugin_locked_by_policy';
      default:
        break;
    }
  }
  const msg = getErrorMessage(error).toLowerCase();
  if (msg.includes('not installed')) return 'plugin_not_installed';
  if (msg.includes('not found')) return 'plugin_not_found';
  if (msg.includes('locked') || msg.includes('managed'))
    return 'plugin_locked_by_policy';
  if (
    msg.includes('no plugin content') ||
    msg.includes('has no plugin content')
  )
    return 'plugin_manifest_invalid';
  return 'plugin_operation_failed';
}

export function parsePluginArgs(args: string): string[] {
  return parseArguments(args);
}

export function normalizePluginScope(
  scope: string | undefined,
): PluginCliScope {
  const candidate = scope ?? 'user';
  if (!VALID_PLUGIN_SCOPES.includes(candidate as PluginCliScope)) {
    throw new Error(
      `Invalid scope "${candidate}". Valid scopes: ${VALID_PLUGIN_SCOPES.join(', ')}`,
    );
  }
  return candidate as PluginCliScope;
}

export function parseScopeFlag(args: string[]): {
  scope?: PluginCliScope;
  rest: string[];
} {
  let scope: PluginCliScope | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scope' || arg === '-s') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) {
        throw new Error(`${arg} requires a scope value.`);
      }
      scope = normalizePluginScope(args[++i]);
    } else if (arg.startsWith('--scope=')) {
      scope = normalizePluginScope(arg.slice('--scope='.length));
    } else {
      rest.push(arg);
    }
  }
  return { scope, rest };
}

export function parseBooleanFlag(
  args: string[],
  names: string[],
): {
  enabled: boolean;
  rest: string[];
} {
  const nameSet = new Set(names);
  const rest: string[] = [];
  let enabled = false;
  for (const arg of args) {
    if (nameSet.has(arg)) {
      enabled = true;
    } else {
      rest.push(arg);
    }
  }
  return { enabled, rest };
}

export interface PluginCommandManagerOptions {
  manager?: PluginManager;
  config?: Config | null;
}

function managerForCommand(
  settings: PluginSettingsAccess,
  options: PluginCommandManagerOptions,
): PluginManager {
  return (
    options.manager ??
    createCorePluginManager(settings, {
      factory: options.config?.getPluginManagerFactory?.(),
      cwd: options.config?.getTargetDir?.(),
    })
  );
}

export function resolvePluginId(
  plugin: string,
  settings?: CommandSettings,
  config?: Config,
): string {
  return createCorePluginManager(settings, {
    factory: config?.getPluginManagerFactory?.(),
    cwd: config?.getTargetDir?.(),
  }).resolvePluginId(plugin);
}

export function resolveScopeForPlugin(
  pluginId: string,
  settings: CommandSettings,
  explicitScope?: PluginCliScope,
  config?: Config,
): PluginCliScope {
  return managerForCommand(settings, { config }).resolveScopeForPlugin(
    pluginId,
    explicitScope,
  );
}

export interface InstallPluginCommandResult {
  message: string;
  runtimeReloadRequired: true;
  pluginId: string;
  version: string;
  installPath: string;
}

export function formatPluginMutationMessage(result: {
  message: string;
  runtimeReloadRequired: boolean;
}): string {
  return result.runtimeReloadRequired
    ? `${result.message} Run /plugins reload to apply.`
    : result.message;
}

export async function installPluginForCommand(
  args: {
    plugin: string;
    scope: PluginCliScope;
    settings: CommandSettings;
  } & PluginCommandManagerOptions,
): Promise<InstallPluginCommandResult> {
  const result = await managerForCommand(args.settings, args).install(args);
  const notices = (result.notices ?? []).map((notice) => ` ${notice}`).join('');
  return {
    message: `Plugin "${result.pluginId}" installed successfully.${notices}`,
    runtimeReloadRequired: true,
    pluginId: result.pluginId,
    version: result.version,
    installPath: result.installPath,
  };
}

export interface UninstallPluginCommandResult {
  message: string;
  runtimeReloadRequired: true;
  pluginId: string;
  fullyRemoved: boolean;
  reverseDependents: string[];
}

export async function uninstallPluginForCommand(
  args: {
    plugin: string;
    scope: PluginCliScope;
    settings: CommandSettings;
    keepData?: boolean;
  } & PluginCommandManagerOptions,
): Promise<UninstallPluginCommandResult> {
  const result = await managerForCommand(args.settings, args).uninstall(args);
  const dependencyWarning = result.reverseDependents.length
    ? ` Warning: required by ${result.reverseDependents.join(', ')}.`
    : '';
  const message = result.fullyRemoved
    ? `Plugin "${result.pluginId}" fully uninstalled.${dependencyWarning}`
    : `Plugin "${result.pluginId}" removed from scope "${result.scope}".${dependencyWarning}`;
  return {
    message,
    runtimeReloadRequired: true,
    pluginId: result.pluginId,
    fullyRemoved: result.fullyRemoved,
    reverseDependents: result.reverseDependents,
  };
}

export async function updatePluginForCommand(
  args: {
    plugin: string;
    scope: PluginCliScope;
    settings: CommandSettings;
  } & PluginCommandManagerOptions,
): Promise<string> {
  const result = await managerForCommand(args.settings, args).update(args);
  return `Plugin "${result.pluginId}" updated successfully. Run /plugins reload to apply.`;
}

export async function validatePluginReportForCommand(
  pluginPath: string,
): Promise<PluginValidationReport> {
  return createCorePluginManager().validate(pluginPath);
}

/** daemon.validate_plugins 单请求的路径上限：启动期一次校验通常只有个位数。 */
export const DAEMON_PLUGIN_VALIDATION_MAX_PATHS = 16;
const DAEMON_PLUGIN_VALIDATION_CONCURRENCY = 4;
const DAEMON_PLUGIN_VALIDATION_TIMEOUT_MS = 30_000;

export class DaemonPluginValidationError extends Error {
  constructor(
    readonly code: 'PLUGIN_VALIDATION_TIMEOUT' | 'CANCELLED',
    message: string,
  ) {
    super(message);
    this.name = 'DaemonPluginValidationError';
  }
}

export interface DaemonPluginValidationOptions {
  /** 相对路径的解析基准；wire 侧 `config_dir`。绝对路径不受影响。 */
  configDir?: string;
  signal?: AbortSignal;
  /** 单路径超时，默认 30s；测试可缩短。 */
  timeoutMs?: number;
  /** 校验实现，默认 validatePluginReportForCommand；测试可注入。 */
  validate?: (pluginPath: string) => Promise<PluginValidationReport>;
}

/**
 * daemon 内批量校验插件：固定并发 4，单路径 30s 超时，结果顺序与入参一致。
 * 校验是纯静态读盘，不触发登录、不执行 hook/MCP/二进制。
 */
export async function validatePluginReportsForDaemon(
  paths: readonly string[],
  options: DaemonPluginValidationOptions = {},
): Promise<PluginValidationReport[]> {
  const validate = options.validate ?? validatePluginReportForCommand;
  const timeoutMs = options.timeoutMs ?? DAEMON_PLUGIN_VALIDATION_TIMEOUT_MS;
  const reports = new Array<PluginValidationReport>(paths.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= paths.length) return;
      if (options.signal?.aborted) {
        throw new DaemonPluginValidationError(
          'CANCELLED',
          'Plugin validation was cancelled',
        );
      }
      const pluginPath = options.configDir
        ? resolvePath(options.configDir, paths[index])
        : paths[index];
      reports[index] = await raceValidation(
        validate(pluginPath),
        timeoutMs,
        paths[index],
        options.signal,
      );
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(DAEMON_PLUGIN_VALIDATION_CONCURRENCY, paths.length) },
      runWorker,
    ),
  );
  return reports;
}

function raceValidation(
  validation: Promise<PluginValidationReport>,
  timeoutMs: number,
  pluginPath: string,
  signal: AbortSignal | undefined,
): Promise<PluginValidationReport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (finish()) {
        reject(
          new DaemonPluginValidationError(
            'CANCELLED',
            'Plugin validation was cancelled',
          ),
        );
      }
    };
    const timer = setTimeout(() => {
      if (finish()) {
        reject(
          new DaemonPluginValidationError(
            'PLUGIN_VALIDATION_TIMEOUT',
            `Plugin validation timed out after ${timeoutMs}ms: ${pluginPath}`,
          ),
        );
      }
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    validation.then(
      (report) => {
        if (finish()) resolve(report);
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
  });
}

export function formatPluginValidationReport(
  report: PluginValidationReport,
): string {
  const lines = [
    `Validating plugin: ${report.target.resolvedPath}`,
    ...(report.plugin ? [`  Plugin name: ${report.plugin.name}`] : []),
  ];

  const errors = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  const warnings = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'warning',
  );
  const appendDiagnostics = (
    heading: string,
    diagnostics: typeof report.diagnostics,
  ) => {
    if (diagnostics.length === 0) return;
    lines.push(`  ${heading}:`);
    for (const diagnostic of diagnostics) {
      const location = diagnostic.location?.path
        ? `${diagnostic.location.path}: `
        : '';
      lines.push(`    - [${diagnostic.code}] ${location}${diagnostic.message}`);
    }
  };

  appendDiagnostics('Errors', errors);
  appendDiagnostics('Warnings', warnings);

  if (report.resources) {
    const components = [
      ['skills', report.resources.skills.length],
      ['agents', report.resources.agents.length],
      ['commands', report.resources.commands.length],
      ['hooks', report.resources.hooks.length],
      ['mcp-servers', report.resources.mcpServers.length],
    ].filter(([, count]) => Number(count) > 0);
    if (components.length > 0) {
      lines.push('', '  Components loaded successfully:');
      for (const [name, count] of components) {
        lines.push(`    - ${name} (${count})`);
      }
    }
  }

  if (report.valid) {
    lines.push(
      '',
      `Plugin "${report.plugin?.name ?? report.target.resolvedPath}" is valid and ready to install.`,
    );
  } else {
    lines.push(
      '',
      `Plugin validation failed with ${report.summary.errorCount} error(s).`,
    );
  }
  return lines.join('\n');
}

export async function validatePluginForCommand(
  pluginPath: string,
): Promise<string> {
  const report = await validatePluginReportForCommand(pluginPath);
  const formatted = formatPluginValidationReport(report);
  if (!report.valid) throw new Error(formatted);
  return formatted;
}

export async function setPluginEnabledForCommand(
  args: {
    plugin: string;
    enabled: boolean;
    settings: CommandSettings;
    scope?: PluginCliScope;
  } & PluginCommandManagerOptions,
): Promise<string> {
  const builtin = args.config
    ?.getPlugins()
    .find(
      (plugin) =>
        plugin.isBuiltin &&
        (getLoadedPluginId(plugin) === args.plugin ||
          plugin.name === args.plugin),
    );
  if (builtin && args.config) {
    const config = args.config;
    if (!config.reloadPlugins)
      throw new Error('Plugin reload is unavailable in this session.');
    const pluginId = getLoadedPluginId(builtin);
    const result = managerForCommand(args.settings, args).setBuiltinEnabled({
      pluginId,
      enabled: args.enabled,
      loadedPlugins: config.getPlugins(),
    });
    if (!result.ok) throw new Error(result.error);
    const owner = {
      name: builtin.name,
      id: pluginId,
      path: builtin.path,
      mcpServers: builtin.mcpServers,
    };
    const mcp = config.getMcpClientManager();
    try {
      // Stop before replacing Config so a failed stop remains retryable.
      if (!args.enabled && builtin.mcpServers) await mcp?.stopPlugin(owner);
      const reloaded = await config.reloadPlugins();
      await config.reloadSkills();
      const updated = reloaded.enabled.find(
        (plugin) => getLoadedPluginId(plugin) === pluginId,
      );
      if (!updated || (updated.enabled !== false) !== args.enabled) {
        throw new Error(
          `Plugin reload did not apply the requested state for "${pluginId}". Check /plugins Errors and settings overrides.`,
        );
      }
      if (args.enabled && updated.mcpServers) {
        await mcp?.startPlugin({
          ...owner,
          path: updated.path,
          mcpServers: updated.mcpServers,
        });
      }
    } catch (error) {
      throw new Error(
        `Plugin setting saved, but runtime update failed: ${getErrorMessage(error)}`,
      );
    }
    return `Plugin "${pluginId}" ${args.enabled ? 'enabled' : 'disabled'}.`;
  }
  const result = await managerForCommand(args.settings, args).setEnabled(args);
  if (result.staleSettingDisabled) {
    return `Stale plugin setting "${result.pluginId}" disabled.`;
  }
  const action = result.enabled ? 'enabled' : 'disabled';
  return `Plugin "${result.pluginId}" ${action}. Run /plugins reload to apply.`;
}

export async function disableAllPluginsForCommand(
  settings: CommandSettings,
  options: PluginCommandManagerOptions = {},
): Promise<string> {
  const result = await managerForCommand(settings, options).disableAll();
  if (result.disabledCount === 0) {
    return result.skippedLocked > 0
      ? `No user-toggleable plugins to disable. Skipped ${result.skippedLocked} admin-enforced plugin(s).`
      : 'No enabled plugins to disable.';
  }
  const suffix =
    result.skippedLocked > 0
      ? ` Skipped ${result.skippedLocked} admin-enforced plugin(s).`
      : '';
  return `Disabled ${result.disabledCount} plugin(s).${suffix} Run /plugins reload to apply.`;
}

export function getStaleEnabledPluginSettings(
  settings: CommandSettings,
  installedState: InstalledPluginsState,
): StaleEnabledPluginSetting[] {
  return createCorePluginManager(settings).getStaleEnabledPluginSettings(
    installedState,
  );
}

function formatInstalledPluginVersion(version?: string): string {
  if (!version || version === 'local' || version === 'unknown') return '';
  return ` v${version}`;
}

export async function listPluginsForCommand(
  args: {
    settings: PluginSettingsReader;
    json?: boolean;
    available?: boolean;
    pluginDirs?: string[];
  } & PluginCommandManagerOptions,
): Promise<string> {
  if (args.available && !args.json) {
    throw new Error('--available requires --json.');
  }
  const result = await managerForCommand(args.settings, args).list({
    includeAvailable: args.available,
    includeResources: args.json,
    pluginDirs: args.pluginDirs,
  });

  if (args.json) {
    return args.available
      ? JSON.stringify(
          { installed: result.installed, available: result.available ?? [] },
          null,
          2,
        )
      : JSON.stringify(result.installed, null, 2);
  }

  if (result.installed.length === 0 && result.warnings.length > 0) {
    return result.warnings.join('\n');
  }

  const sections: string[] = [];
  if (result.installed.length === 0) {
    sections.push(
      `No plugins installed. Use \`${BRAND_CLI_BIN} plugins install\` to install a plugin.`,
    );
  } else {
    sections.push(
      result.installed
        .map((plugin: PluginListRow) => {
          const status = plugin.enabled ? 'enabled' : 'disabled';
          const version = formatInstalledPluginVersion(plugin.version);
          return `${plugin.id}${version}\n  Scope: ${plugin.scope}\n  Status: ${status}`;
        })
        .join('\n\n'),
    );
  }

  if (result.warnings.length > 0) {
    sections.push(result.warnings.join('\n'));
  }
  return sections.join('\n\n');
}

export async function addMarketplaceForCommand(args: {
  settings: CommandSettings;
  sourceInput: string;
  scope: PluginCliScope;
  sparsePaths?: string[];
  onProgress?: (message: string) => void;
}): Promise<string> {
  const { name, alreadyMaterialized } = await addConfiguredMarketplace(args);
  return alreadyMaterialized
    ? `Marketplace "${name}" already exists. Declared in ${args.scope} settings.`
    : `Marketplace "${name}" added successfully. Declared in ${args.scope} settings.`;
}

export async function removeMarketplaceForCommand(
  args: {
    settings: CommandSettings;
    name: string;
    scope?: PluginCliScope;
  } & PluginCommandManagerOptions,
): Promise<string> {
  const result = await managerForCommand(args.settings, args).removeMarketplace(
    args,
  );
  if (result.kind === 'scope-only') {
    const { keptCount, scope } = result;
    return `Marketplace "${args.name}" removed from ${scope} settings. It is still declared elsewhere, so ${keptCount} installed ${keptCount === 1 ? 'plugin was' : 'plugins were'} kept. Run /plugins reload to apply.`;
  }

  const { removedCount, skippedCacheRemoval } = result;
  const cacheNote = skippedCacheRemoval
    ? ' Marketplace cache cleanup was skipped because its stored path was outside the marketplace cache directory.'
    : '';
  return `Marketplace "${args.name}" removed. Uninstalled ${removedCount} installed ${removedCount === 1 ? 'plugin' : 'plugins'} from it; plugin caches were marked orphaned.${cacheNote} Run /plugins reload to apply.`;
}

export async function updateMarketplaceForCommand(
  name: string | undefined,
  onProgress?: (message: string) => void,
): Promise<string> {
  if (name) {
    await refreshMarketplace(name, onProgress);
    clearAllPluginCaches({ clearOrphanExclusions: false });
    return `Marketplace "${name}" updated successfully.`;
  }

  const { refreshed, errors } = await refreshAllMarketplaces(onProgress);
  clearAllPluginCaches({ clearOrphanExclusions: false });
  const parts = [`Updated ${refreshed.length} marketplace(s).`];
  if (errors.length > 0) {
    parts.push(
      `Failed: ${errors.map((err) => `${err.name}: ${err.error}`).join('; ')}`,
    );
  }
  return parts.join(' ');
}

export function listMarketplacesForCommand(
  settings: MergedSettings,
  json?: boolean,
): string {
  const blocked = new Set(
    getEffectiveBlockedMarketplaces(settings.blockedMarketplaces),
  );
  const names = listKnownMarketplaces().filter(
    (name) => !blocked.has(name.toLowerCase()),
  );
  const config = loadKnownMarketplacesConfig();
  if (json) {
    return JSON.stringify(
      names.sort().map((name) => ({
        name,
        source: config[name]?.source,
        installLocation: config[name]?.installLocation,
        lastUpdated: config[name]?.lastUpdated,
        autoUpdate: config[name]?.autoUpdate !== false,
      })),
      null,
      2,
    );
  }

  if (names.length === 0) {
    return 'No marketplaces configured.';
  }

  return names
    .sort()
    .map((name) => {
      const entry = config[name];
      return `${name}\n  Source: ${JSON.stringify(entry?.source)}\n  Last updated: ${entry?.lastUpdated ?? 'unknown'}\n  Cache: ${entry?.installLocation ?? 'unknown'}`;
    })
    .join('\n\n');
}
