/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_FILE_FILTERING_OPTIONS,
  FileDiscoveryService,
  runLogger,
  beginStartupStep,
  ASK_USER_TOOL_NAME,
  LAZY_MCP_META_TOOL_NAMES,
  getVersion,
  coreEvents,
  isHeadlessMode,
  isRemoteWorkerMode,
  isSDKMode,
  Config,
  Storage,
  ResourceService,
  type WorktreeSettings,
  type HookDefinition,
  type HookEventName,
  type OutputFormat,
  type ModelConfig,
  type ModelReasoningConfig,
  type ModelThinkingConfig,
  generalistProfile,
  type MCPServerConfig,
  tagScope,
  type AgentSource,
  writeToStderr,
  BRAND_ENV_PREFIX,
  BRAND_FIXED_ENV_PREFIX,
  readBrandEnv,
  ENV_INTEGRATION_TEST,
  normalizeMcpServerConfigs,
  populateMcpServerCommand,
  parseReasoningEffortLevel,
  REASONING_EFFORT_LEVELS,
  isContextWindowSelectionEnabled,
  sessionLogger,
  normalizeWorktreeCreationSettings,
  type StartupPhaseObserver,
} from '@qwen-code/core';
import type { LoadedSettings } from './settings.js';
import { type MergedSettings, saveModelChange } from './settings.js';
import { resolvePath } from '../utils/resolvePath.js';
import { isWorkspaceTrusted } from './trustedFolders.js';
import { McpServerEnablementManager } from './mcp/mcpServerEnablement.js';
import {
  getProjectMcpServerNames,
  filterMcpServersByApproval,
} from './mcp/projectMcpApproval.js';
import { isExternalImportApprovedForProject } from './externalImportApproval.js';
import type { ProjectMcpConfigValidator } from './mcp/projectMcpJson.js';
import { loadProjectMcpJson } from './mcp/projectMcpJson.js';
import { loadSessionPluginRuntime } from '@qwen-code/core/plugin-management';
import { createSettingsContentValidator } from './settingsContentValidator.js';
import {
  getSettingsZodSchema,
  requireSettingsDefinition,
} from './settings-validation.js';
import { SETTINGS_DEFAULTS } from './settingsSchema.js';
import {
  logProxyResolution,
  resolveProxyFromSettings,
} from '../utils/proxySettings.js';
import { getHeadlessPermissionPromptMode } from '../utils/headlessPermissionPrompt.js';
import { getTrimmedEnv } from './cliEnvironment.js';
import { isMultiSessionHost } from '../startup/determineStartupMode.js';
import { isPlanModeRequest } from '../session/permissionMode.js';

export const ENV_MCP_CONFIG = `${BRAND_ENV_PREFIX}MCP_CONFIG`;
export const ENV_MCP_LAZY = `${BRAND_FIXED_ENV_PREFIX}MCP_LAZY`;
export const ENV_WORKING_DIR = `${BRAND_ENV_PREFIX}WORKING_DIR`;
export const ENV_SESSION_ID = `${BRAND_ENV_PREFIX}SESSION_ID`;
export const ENV_SESSION_NAME = `${BRAND_ENV_PREFIX}SESSION_NAME`;
export const ENV_PERMISSION_MODE = `${BRAND_ENV_PREFIX}PERMISSION_MODE`;
export const ENV_MODEL = `${BRAND_ENV_PREFIX}MODEL`;
export const ENV_APPEND_SYSTEM_PROMPT = `${BRAND_ENV_PREFIX}APPEND_SYSTEM_PROMPT`;

export interface CliArgs {
  /** Commander option attribute names explicitly supplied on the command line. */
  explicitCliOptionNames?: string[];
  /** Parsed option fields populated from QWEN_* startup environment variables. */
  environmentOptionNames?: string[];
  query: string | undefined;
  model: string | undefined;
  /** SDK 宿主显式提供的代理地址；SDK 模式未提供时为直连。 */
  proxy?: string;
  debug: boolean | undefined;
  prompt: string | undefined;
  promptInteractive: string | undefined;
  worktree?: string;
  cwd?: string;
  configDir?: string;
  /** Explicit socket path for cross-session peer messaging. */
  messagingSocketPath?: string;

  permissionMode: string | undefined;
  allowedMcpServerNames: string[] | undefined;
  tools: string[] | undefined;
  acp?: boolean;
  /** SDK daemon 入口；开源 CLI 保留该 flag，但未安装产品 runner 时直接报不支持。 */
  sdk?: boolean;
  extensions: string[] | undefined;
  pluginDir?: string[];
  listExtensions: boolean | undefined;
  continue?: boolean | undefined;
  forkSession?: boolean | undefined;
  resume: string | undefined;
  resumeSessionAt?: string | undefined;
  resumeDropsTurn?: string | undefined;
  name?: string | undefined;
  sessionId?: string | undefined;
  remote?: string | undefined;
  remoteSession?: string | undefined;
  listSessions: boolean | undefined;
  listModels: boolean | undefined;
  deleteSession: string | undefined;
  addDir: string[] | undefined;
  screenReader: boolean | undefined;
  alternateBuffer: boolean | undefined;
  outputFormat: string | undefined;
  inputFormat: string | undefined;
  print?: boolean | undefined;
  replayUserMessages?: boolean;
  fakeResponses: string | undefined;
  recordResponses: string | undefined;
  startupMessages?: string[];
  deprecationWarnings?: string[];
  rawOutput: boolean | undefined;
  acceptRawOutputRisk: boolean | undefined;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  allowPluginMcp?: boolean;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  sessionMirror?: boolean;
  sessionPersistence?: boolean;
  emitReferenceContent?: boolean;
  headlessFastHooks?: boolean;
  bare?: boolean;
  settingSources?: string[];
  /** `--settings`: JSON file path or inline JSON merged as the flag layer. */
  settings?: string;
  disableBuiltinSkills?: boolean;
  enableBuiltinSkills?: string[];
  /** JSON string defining inline agents for this session only. */
  agents?: string;
  /** Agent name to use as the main session agent. */
  agent?: string;
  /** System prompt override. */
  systemPrompt?: string;
  /** System prompt file override. */
  systemPromptFile?: string;
  /** Text appended to the effective system prompt. */
  appendSystemPrompt?: string;
  /** File content appended to the effective system prompt. */
  appendSystemPromptFile?: string;
  /** Output style to apply for this session (from --output-style). Overrides the `outputStyle` setting. */
  outputStyle?: string;
  /** Tool allow-list. */
  allowedTools?: string[];
  /** Tool deny-list. */
  disallowedTools?: string[];
  /** External tool for permission prompting ('stdio' or MCP tool name). */
  permissionPromptTool?: string;
  /** Maximum model output tokens. */
  maxOutputTokens?: string;
  /** Explicit reasoning effort for supported models. */
  reasoningEffort?: string;
  /** Thinking mode for this session. */
  thinking?: string;
  /** Fixed thinking budget for this session. */
  thinkingBudget?: string;
  /** Explicit context window for supported models. */
  contextWindow?: string;
  /** Quiet mode flag. */
  quiet?: boolean;
  /** Maximum turns per query. */
  maxTurns?: number;
  /** Maximum retries for server and Custom Provider model requests. */
  maxModelRequestRetries?: string;
}

export function getWorkingDirFromEnv(): string | undefined {
  return getTrimmedEnv(ENV_WORKING_DIR);
}

/**
 * Parses the --setting-sources flag values into AgentSource types.
 * Valid values: user (personal), project, local, plugin.
 * Note: 'local' is a valid setting source (controls settings.local.json loading)
 * but does not map to an AgentSource — it is silently skipped for agent filtering.
 */
export function parseSettingSourcesFlag(sources: string[]): AgentSource[] {
  const sourceMap: Record<string, AgentSource> = {
    user: 'user',
    project: 'project',
  };
  const validSettingSources = new Set([...Object.keys(sourceMap), 'local']);
  const result: AgentSource[] = [];
  for (const name of sources) {
    if (name === '') {
      continue;
    }
    if (!validSettingSources.has(name)) {
      throw new Error(
        `Invalid setting source: "${name}". Valid options are: user, project, local`,
      );
    }
    const mapped = sourceMap[name];
    if (mapped) {
      result.push(mapped);
    }
  }
  return result;
}

/**
 * Resolves a system prompt argument: returns the inline text if provided,
 * otherwise reads from the file path. Returns undefined if neither is given.
 * Throws on file read errors so yargs .fail() can surface them cleanly.
 */
function resolveSystemPromptArg(
  inlineText: string | undefined,
  filePath: string | undefined,
): string | undefined {
  if (inlineText) return inlineText;
  if (!filePath) return undefined;
  const resolved = path.resolve(filePath);
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`System prompt file not found: ${resolved}`);
    }
    throw new Error(
      `Error reading system prompt file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isDebugMode(argv: CliArgs): boolean {
  return (
    argv.debug ||
    [process.env['DEBUG'], process.env['DEBUG_MODE']].some(
      (v) => v === 'true' || v === '1',
    )
  );
}

/**
 * Returns project-level MCP servers that are in 'pending' approval state.
 * Used by the UI to show the approval dialog at startup.
 */
export function getPendingProjectMcpServers(
  loaded: LoadedSettings,
  cwd: string,
  validator?: ProjectMcpConfigValidator,
): Record<string, MCPServerConfig> {
  const settings = loaded.merged;
  const mcpJsonServers = loadProjectMcpJson(cwd, validator);
  const allMcpServers = resolveSettingsBackedMcpServers(
    cwd,
    loaded,
    validator,
  );
  const projectServerNames = getProjectMcpServerNames(loaded, mcpJsonServers);
  const { pending } = filterMcpServersByApproval(
    allMcpServers,
    projectServerNames,
    settings.mcp,
    false,
  );
  return pending;
}

/**
 * Re-read MCP server definitions from disk and write the approved subset back
 * onto `Config.mcpServers` so `mcpClientManager.restart()` picks up servers
 * added after startup (e.g. via the `/mcp-config` skill or `qwen mcp add`).
 *
 * Plugin/extension-provided servers are kept as-is — they live in
 * `McpClientManager.allServerConfigs`, not on disk, so we don't try to refresh
 * them here.
 *
 * When settings-backed MCP sources are disabled (for example by
 * `--strict-mcp-config`), the current disk bucket is preserved verbatim. This
 * keeps explicitly supplied MCP servers alive across a restart without
 * re-introducing settings.json / .mcp.json sources.
 *
 * Returns the still-pending project-level servers so the caller can prompt
 * the user (the `MCP server approval` dialog).
 */
export function refreshMcpServersFromDisk(
  config: Config,
  cwd: string,
): {
  approved: Record<string, MCPServerConfig>;
  pending: Record<string, MCPServerConfig>;
} {
  if (!config.getMcpSettingsSourcesEnabled()) {
    return {
      approved: config.getDiskMcpServers() ?? {},
      pending: {},
    };
  }

  const loaded = config.getLoadedSettings();
  loaded.reload();

  const validator = config.getProcessMcpManager();
  const projectMcpServers = loadProjectMcpJson(cwd, validator);
  const allFromDisk = resolveSettingsBackedMcpServers(cwd, loaded, validator);
  const projectServerNames = getProjectMcpServerNames(
    loaded,
    projectMcpServers,
  );
  const { approved, pending } = filterMcpServersByApproval(
    allFromDisk,
    projectServerNames,
    loaded.merged.mcp,
    false,
  );

  // Preserve plugin/extension-provided servers from the existing in-memory
  // disk bucket — they are not persisted in settings files and therefore
  // never appear in `allFromDisk`. Dynamic entries live in a separate bucket
  // and are unaffected by /mcp refresh.
  const previous = config.getDiskMcpServers() ?? {};
  const next: Record<string, MCPServerConfig> = { ...approved };
  for (const [name, cfg] of Object.entries(previous)) {
    if (cfg.plugin && !(name in next)) {
      next[name] = cfg;
    }
  }

  config.setDiskMcpServers(normalizeMcpServerConfigs(next));
  return { approved: next, pending };
}

function resolveSettingsBackedMcpServers(
  cwd: string,
  loaded: LoadedSettings,
  validator?: ProjectMcpConfigValidator,
): Record<string, MCPServerConfig> {
  const projectMcpServers = loadProjectMcpJson(cwd, validator);

  // Settings and MCP use the same user/project/local scope names.
  // The project MCP source also includes the separately loaded .mcp.json.
  const userServers = tagScope(loaded.user.settings.mcpServers, 'user');
  const projectServers = tagScope(
    loaded.project.settings.mcpServers,
    'project',
  );
  const projectFileServers = tagScope(projectMcpServers, 'project');
  const localServers = loaded.isTrusted
    ? tagScope(loaded.local.settings.mcpServers, 'local')
    : {};
  // --settings CLI flag is user-explicit and overrides all other sources.
  const flagServers = tagScope(loaded.flag.settings.mcpServers, 'flag');

  return {
    ...userServers,
    ...projectServers,
    ...projectFileServers,
    ...localServers,
    ...flagServers,
  };
}

function resolveLoadSkillsFromAgentsDirectory(loaded: LoadedSettings): boolean {
  // Read explicit sources: the merged schema default cannot distinguish an
  // SDK opt-in from omission. Both modes use the same source precedence.
  const scopes = [
    loaded.flag.settings,
    loaded.isTrusted ? loaded.local.settings : undefined,
    loaded.project.settings,
    loaded.user.settings,
  ];

  for (const scope of scopes) {
    const value = scope?.skills?.loadFromAgentsDirectory;
    if (typeof value === 'boolean') return value;
  }
  return !isSDKMode();
}

export interface LoadCliConfigOptions {
  pluginManagerFactory?: import('@qwen-code/core').PluginManagerFactory;
  /** Host 不绑定会话项目；会话配置必须在收到 cwd 后独立加载。 */
  scope?: 'host' | 'session';
  cwd?: string;
  projectHooks?: { [K in HookEventName]?: HookDefinition[] } & {
    disabled?: string[];
  };
  localHooks?: { [K in HookEventName]?: HookDefinition[] };
  userHooks?: { [K in HookEventName]?: HookDefinition[] };
  flagHooks?: { [K in HookEventName]?: HookDefinition[] };
  worktreeSettings?: WorktreeSettings;
  /** Pre-resolved trust for non-interactive sessions; omitted uses CLI rules. */
  trustedFolder?: boolean;
  /** 会话所属的产品启动面（含 SDK daemon 的 'sdk' 语义），不等于 CLI 路由。 */
  startupMode?:
    | 'interactive'
    | 'headless'
    | 'sdk'
    | 'acp'
    | 'daemon'
    | 'remoteWorker'
    | 'command';
  /** Startup-mode-specific MCP wait behavior for Config.initialize(). */
  mcpInitializationWaitStrategy?: 'none' | 'budget' | 'full';
  /** Process-level MCP pool; session configs borrow it from the framework. */
  mcpManager?: import('@qwen-code/core').McpManager;
  /** 会话级调用方从 Config/params 借共享成员时直接传入；Config 只释放自己的项目 handle。 */
  resourceService?: ResourceService;
  settingsService?: import('@qwen-code/resource').SettingsService;
  /**
   * 会话级 provider 工厂；缺省时从 framework 借用。Config 构造时调用，实例归本会话。
   */

  modelProviderFactory?: import('@qwen-code/core').ConfigParameters['modelProviderFactory'];
  /** 进程级权限管理器；会话只从它派生自己的会话对象。 */
  permissionManager?: import('@qwen-code/core').PermissionManager;
  /** 进程级 transport 查找面；缺省时使用通用注册表。 */
  modelTransportManager?: import('@qwen-code/core').ModelTransportManager;
  customProviderManager?: import('@qwen-code/core').CustomProviderManager;
  builtinPlugins?: import('@qwen-code/core').BuiltinPluginContributions;
  builtinPluginsInitialization?: Promise<unknown>;
  /** 接收启动阶段记录，写入会话阶段日志。 */
  startupPhaseObserver?: StartupPhaseObserver;
}

function extractMcpServers(
  parsed: unknown,
): Record<string, MCPServerConfig> | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (
    servers === undefined ||
    servers === null ||
    typeof servers !== 'object' ||
    Array.isArray(servers)
  ) {
    return null;
  }
  return servers as Record<string, MCPServerConfig>;
}

function resolveMcpConfigEntry(
  entry: string,
  cwd: string,
  sourceLabel = '--mcp-config',
): Record<string, MCPServerConfig> {
  if (entry.trimStart().startsWith('{')) {
    try {
      const extracted = extractMcpServers(JSON.parse(entry));
      if (extracted) {
        return extracted;
      }
    } catch {
      // fall through to error
    }
    writeToStderr(
      `[mcp-config] Invalid inline JSON for ${sourceLabel}: expected {"mcpServers": {...}}: ${entry}\n`,
    );
    sessionLogger.setExitContext({
      reason: 'config_error',
      exit_code: 1,
      message: `Invalid inline JSON for ${sourceLabel}`,
      source: 'config.resolveMcpConfigEntry',
    });
    process.exit(1);
  }

  const resolved = path.resolve(cwd, entry);
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    const extracted = extractMcpServers(JSON.parse(content));
    if (!extracted) {
      writeToStderr(
        `[mcp-config] Invalid format in ${resolved}: expected {"mcpServers": {...}}\n`,
      );
      sessionLogger.setExitContext({
        reason: 'config_error',
        exit_code: 1,
        message: `Invalid format in MCP config file: ${resolved}`,
        source: 'config.resolveMcpConfigEntry',
      });
      process.exit(1);
    }
    return extracted;
  } catch (e) {
    writeToStderr(
      `[mcp-config] Failed to load ${resolved}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    sessionLogger.setExitContext({
      reason: 'config_error',
      exit_code: 1,
      message: `Failed to load MCP config file: ${resolved}`,
      source: 'config.resolveMcpConfigEntry',
      error_name: e instanceof Error ? e.name : undefined,
      error_stack: e instanceof Error ? e.stack : undefined,
    });
    process.exit(1);
  }
}

function parseLegacyMaxOutputTokens(
  maxOutputTokens: string | undefined,
): number | undefined {
  switch (maxOutputTokens) {
    case '16k':
      return 16 * 1024;
    case '32k':
      return 32 * 1024;
    default:
      return undefined;
  }
}

/** Sentinel that clears a persisted effort instead of selecting a level. */
const AUTO_EFFORT = 'auto';

/**
 * Parses --thinking / --thinking-budget into a launch reasoning patch;
 * `auto` clears the stored thinking mode (explicit undefined).
 */
function parseCliThinking(
  rawMode: string | undefined,
  rawBudget: string | undefined,
): { thinking: ModelThinkingConfig | undefined } | undefined {
  const mode = rawMode?.trim().toLowerCase();
  const budget = parsePositiveIntegerFlag(rawBudget);
  if (rawBudget !== undefined && budget === undefined) {
    throw new Error(
      `Invalid thinking budget: ${rawBudget}. Must be a positive integer.`,
    );
  }

  if (mode === undefined) {
    return budget === undefined
      ? undefined
      : { thinking: { type: 'enabled', budgetTokens: budget } };
  }
  if (![AUTO_EFFORT, 'adaptive', 'enabled', 'disabled'].includes(mode)) {
    throw new Error(
      `Invalid thinking mode: ${rawMode}. Valid values are: auto, adaptive, enabled, disabled.`,
    );
  }
  if ((mode === 'adaptive' || mode === 'disabled') && budget !== undefined) {
    throw new Error(
      `--thinking-budget cannot be used with --thinking ${mode}.`,
    );
  }
  if (mode === 'enabled') {
    if (budget === undefined) {
      throw new Error(
        '--thinking enabled requires --thinking-budget <tokens>.',
      );
    }
    return { thinking: { type: 'enabled', budgetTokens: budget } };
  }
  if (mode === AUTO_EFFORT) return { thinking: undefined };
  return { thinking: { type: mode === 'adaptive' ? 'adaptive' : 'disabled' } };
}

/** Strict positive-integer flag parser shared by context and thinking budgets. */
function parsePositiveIntegerFlag(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return String(parsed) === value.trim() && parsed > 0 ? parsed : undefined;
}

function parseModelRequestRetries(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function modelMaxAttemptsFromRetries(value: number): number {
  const retries = Math.min(
    Math.max(0, Math.trunc(value)),
    Number.MAX_SAFE_INTEGER - 1,
  );
  return retries + 1;
}

/** Resolves the interactive behavior configured for a CLI invocation. */
export function resolveConfigInteractive(argv: CliArgs): boolean {
  return (
    !!argv.promptInteractive ||
    !!argv.acp ||
    !isHeadlessMode({
      prompt: argv.prompt,
      inputFormat: argv.inputFormat,
      print: argv.print,
    })
  );
}

export function resolveConfigTargetDir(cwd = process.cwd()): string {
  return path.resolve(cwd);
}

/** Resolve process-owned user paths after the startup settings bootstrap. */
export async function initializeUserResources(
  resourceService: ResourceService,
  settings?: LoadedSettings,
): Promise<void> {
  await resourceService.initializeUserResources({
    homeDir: path.dirname(Storage.getGlobalAgentsDir()),
    globalConfigDirOverride: Storage.getGlobalConfigDir(),
    userAgentSkillsDirOverride: Storage.getUserAgentSkillsDir(),
    // Startup settings may preload the shared user source. A later session's
    // effective setting can activate it on demand without a second user resource.
    loadFromAgentsDirectory:
      settings?.flag.settings.skills?.loadFromAgentsDirectory ??
      settings?.user.settings.skills?.loadFromAgentsDirectory ??
      !isSDKMode(),
  });
}

export async function loadCliConfig(
  loadedSettings: LoadedSettings,
  sessionId: string,
  argv: CliArgs,
  options: LoadCliConfigOptions,
): Promise<Config> {
  if (
    options.scope !== 'host' &&
    isMultiSessionHost(argv) &&
    options.cwd === undefined
  ) {
    throw new Error(
      'A session cwd is required when loading host session configuration.',
    );
  }
  // Keep the rules that produced the settings projection for later edits.
  const resolvedSettingsService = loadedSettings.getSettingsService();
  if (resolvedSettingsService && !resolvedSettingsService.getDefinition()) {
    resolvedSettingsService.configureDefaults(
      { defaults: SETTINGS_DEFAULTS, createValidation: getSettingsZodSchema },
      {},
    );
  }
  let settingsService = resolvedSettingsService ?? options.settingsService;
  if (
    !settingsService ||
    (!resolvedSettingsService &&
      (!settingsService.isInitialized || !settingsService.getDefinition()))
  ) {
    const { createCliSettingsService } = await import(
      './createCliSettingsService.js'
    );
    settingsService = createCliSettingsService({
      service: settingsService,
      environmentPolicy: 'session',
    });
  }
  const { validation } = requireSettingsDefinition(settingsService);
  loadedSettings.refreshSettingsRules();
  const validateSettingsContent = createSettingsContentValidator(validation);
  const useHostConfig =
    (options.scope === 'host' && options.startupMode !== 'daemon') || argv.bare;
  // Host and bare projections adopt product rules without adding file sources.
  loadedSettings.attachSettingsService(settingsService, {
    bindFileSources: !useHostConfig,
  });
  const settings = loadedSettings.merged;
  const {
    cwd = options.scope === 'host' ? homedir() : process.cwd(),
    projectHooks = loadedSettings.project.settings.hooks,
    localHooks = loadedSettings.local.settings.hooks,
    userHooks = loadedSettings.user.settings.hooks,
    flagHooks = loadedSettings.flag.settings.hooks,
  } = options;
  const debugMode = isDebugMode(argv);
  runLogger.minLevel = debugMode ? 'DEBUG' : 'LOG';
  const startupStep = (name: string) =>
    beginStartupStep(
      name,
      false,
      options.startupPhaseObserver
        ? (durationMs, status) =>
            options.startupPhaseObserver?.({
              kind: 'phase',
              name,
              durationMs,
              status: status ?? 'resolved',
            })
        : undefined,
    );

  const proxyResolution = resolveProxyFromSettings(settings, {
    explicitProxy: argv.proxy,
    sdkMode: isSDKMode(),
  });
  logProxyResolution(proxyResolution);
  const proxy = proxyResolution.proxy;

  const borrowedResourceService = options.resourceService;
  const borrowedPlugins = options.builtinPlugins;
  const borrowedPluginsInitialization = options.builtinPluginsInitialization;
  const borrowedMcpManager = options.mcpManager;
  const borrowedModelTransportManager = options.modelTransportManager;
  const borrowedCustomProviderManager = options.customProviderManager;

  if (useHostConfig) {
    // ACP 的 Config 暂承载认证、Store 和 ResourceService，不加载未来会话的资源。
    // daemon 查询接口仍需要用户级资源投影，沿用下方完整加载，但不读取会话项目。
    const config = new Config({
      loadedSettings,
      sessionId,
      targetDir: cwd,
      cwd,
      resourceService: borrowedResourceService,
      pluginManagerFactory: options.pluginManagerFactory,
      settingsService,
      startupPhaseObserver: options.startupPhaseObserver,
      modelProviderFactory: options.modelProviderFactory,
      modelTransportManager: borrowedModelTransportManager,
      customProviderManager: borrowedCustomProviderManager,
      mcpManager: borrowedMcpManager,
      builtinPlugins: borrowedPlugins,
      builtinPluginsInitialization: borrowedPluginsInitialization,
      debugMode,
      clientVersion: await getVersion(),
      sessionPersistence: false,
      acpMode: argv.acp === true,
      interactive: argv.acp === true,
      proxy,
      model: argv.model ?? '',
      fakeResponses: argv.fakeResponses,
      usageStatisticsEnabled: settings.privacy?.usageStatisticsEnabled,
      enableAgents: false,
      allowedAgentSources: ['user'],
      settingSources: ['user'],
      skillsSupport: false,
      autoMemoryEnabled: false,
      mcpSettingsSourcesEnabled: false,
      pluginMcpServersEnabled: false,
      mcpInitializationWaitStrategy: 'none',
      customProviderAccessMode: 'disabled',
      output: {
        format:
          (argv.outputFormat as OutputFormat) ??
          (settings.output?.format as OutputFormat),
      },
      getSetting: (section) =>
        (settings as unknown as Record<string, unknown>)[section],
      getSettings: () => settings,
      getLaunchSetting: (section) =>
        (
          loadedSettings.flag.originalSettings as unknown as Record<
            string,
            unknown
          >
        )[section],
    });
    config.setSettingsContentValidator(validateSettingsContent);
    return config;
  }

  const worktreeSettings = options.worktreeSettings;

  const folderTrust =
    readBrandEnv(ENV_INTEGRATION_TEST) === 'true' ||
    process.env['VITEST'] === 'true'
      ? false
      : (settings.security?.folderTrust?.enabled ?? false);
  const trustedFolder =
    options.trustedFolder ??
    (isWorkspaceTrusted(settings, cwd, undefined, {
      prompt: argv.prompt,
    })?.isTrusted ?? false);

  const fileDiscoveryDone = startupStep('file_discovery');
  const fileService = new FileDiscoveryService(cwd);
  fileDiscoveryDone();

  const fileFiltering = {
    ...DEFAULT_FILE_FILTERING_OPTIONS,
    ...settings.context?.fileFiltering,
  };

  // Resolve extra workspace directories from the supported trust inputs.
  // resolvePath only expands ~/ and normalizes; anchor relative values to the
  // session cwd so they can match the absolute paths tools resolve.
  const resolveTrustDir = (dir: string): string => {
    const expanded = resolvePath(dir);
    return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  };
  const includeDirectories = (argv.addDir || [])
    .map(resolveTrustDir)
    .concat(
      (settings.permissions?.additionalDirectories || []).map(resolveTrustDir),
    );

  const pluginsDone = startupStep('plugins_load');
  const sessionPlugins = await loadSessionPluginRuntime(loadedSettings, {
    cwd,
    initialSettings: settings,
    factory: options.pluginManagerFactory,
    pluginDirs: argv.pluginDir,
    // daemon 路由：root 这次加载不碰企业插件，因此也不碰登录态——企业插件的 lazy auth
    // init 会认证进程级 authManager 单例，而 daemon 的身份要等 SDK 握手帧才到、且必须
    // 来自帧里的凭据。managed 插件的下载/同步由进程级 ManagedPluginsService 跟随 auth
    // 状态自动起停；账号面清单读盘只读合并（accountQueries.listPlugins）。
    //
    // 只跳 root 这一次：下面 config.reloadPlugins 里的常规重载不跳（身份落地后企业
    // 加载因「已认证」短路，不会换身份），会话级 Config（startupMode 'sdk'）也不跳——
    // 那里的加载发生在身份落地之后。
    skipAdditionalPlugins: options.startupMode === 'daemon',
  });
  pluginsDone();

  const extensionPlanSettings = undefined;

  const question = argv.promptInteractive || argv.prompt || '';

  const interactive = resolveConfigInteractive(argv);
  const headlessPermissionPromptMode = getHeadlessPermissionPromptMode({
    inputFormat: argv.inputFormat,
    permissionPromptTool: argv.permissionPromptTool,
  });

  if (argv.sessionPersistence === false && !argv.print) {
    throw new Error(
      '--no-session-persistence can only be used with --print mode.',
    );
  }

  const coreTools = argv.tools ?? settings.tools?.core;
  const allowedToolsCli = argv.allowedTools ?? [];
  const disallowedToolsCli = argv.disallowedTools ?? [];
  const legacyMaxOutputTokens = parseLegacyMaxOutputTokens(
    argv.maxOutputTokens,
  );

  const isAcpMode = !!argv.acp;

  // In non-interactive mode, exclude ask_user unless the Host has the stdio
  // permission channel that can return structured answers.
  const extraExcludes: string[] = [];
  // An explicit --tools selection uses built-in tools without MCP meta tools,
  // even for "default" or when a meta tool is named. Settings alone do not opt in.
  if (argv.tools !== undefined) {
    extraExcludes.push(...LAZY_MCP_META_TOOL_NAMES);
  }
  if (
    !interactive &&
    !isSDKMode() &&
    !isRemoteWorkerMode() &&
    !headlessPermissionPromptMode.useStdioPermissionPrompt
  ) {
    extraExcludes.push(ASK_USER_TOOL_NAME);
  }

  const excludeTools = mergeExcludeTools(settings, extraExcludes);

  // 主模型求解归口在 MainModelAnchor：此处只透传 `--model` 入参，settings 档与
  // 兜底档由锚点在初始化时按优先级求解。
  const resolvedModel = argv.model ?? '';
  // ACP does not inherit new interactive/session policies from the shared
  // Config assembly path. It must be enabled through an ACP-specific design.
  const ultracodeAllowed = !isAcpMode;
  const rawCliEffort = argv.reasoningEffort?.trim().toLowerCase();
  const cliRequestsUltracode = rawCliEffort === 'ultracode';
  const cliEnablesUltracode = ultracodeAllowed && cliRequestsUltracode;
  if (
    rawCliEffort !== undefined &&
    rawCliEffort !== AUTO_EFFORT &&
    !cliRequestsUltracode &&
    parseReasoningEffortLevel(rawCliEffort) === undefined
  ) {
    throw new Error(
      `Invalid reasoning effort: ${argv.reasoningEffort}. Valid values are: ${[
        AUTO_EFFORT,
        ...REASONING_EFFORT_LEVELS,
        ...(ultracodeAllowed ? ['ultracode'] : []),
      ].join(', ')}.`,
    );
  }
  const cliThinking = parseCliThinking(argv.thinking, argv.thinkingBudget);
  // settings.ultracode only applies when the launch carries no ordinary
  // effort/thinking; Config additionally yields to a stored effort.
  const hasExplicitOrdinaryEffort =
    (rawCliEffort !== undefined && !cliRequestsUltracode) ||
    cliThinking !== undefined;
  const cliEffort: Pick<ModelReasoningConfig, 'effort'> | undefined =
    rawCliEffort === AUTO_EFFORT
      ? { effort: undefined }
      : cliRequestsUltracode
        ? cliEnablesUltracode
          ? { effort: 'xhigh' }
          : undefined
        : rawCliEffort !== undefined
          ? { effort: parseReasoningEffortLevel(rawCliEffort) }
          : undefined;
  const rawContextWindow = isContextWindowSelectionEnabled()
    ? argv.contextWindow
    : undefined;
  const resolvedContextWindow = parsePositiveIntegerFlag(rawContextWindow);
  if (rawContextWindow !== undefined && resolvedContextWindow === undefined) {
    throw new Error(
      `Invalid context window: ${String(rawContextWindow)}. Must be a positive integer.`,
    );
  }
  // Launch flags become a session-only patch on the main model's config,
  // applied by Config through the ModelProviderManager after startup.
  const launchModelConfig: ModelConfig = {
    ...(cliEffort || cliThinking
      ? { reasoning: { ...cliEffort, ...cliThinking } }
      : {}),
    ...(resolvedContextWindow !== undefined ||
    legacyMaxOutputTokens !== undefined
      ? {
          context: {
            ...(resolvedContextWindow !== undefined
              ? { contextWindow: resolvedContextWindow }
              : {}),
            ...(legacyMaxOutputTokens !== undefined
              ? { maxOutputTokens: legacyMaxOutputTokens }
              : {}),
          },
        }
      : {}),
  };
  const rawMaxModelRequestRetries = argv.maxModelRequestRetries;
  const resolvedMaxModelRequestRetries = parseModelRequestRetries(
    rawMaxModelRequestRetries,
  );
  if (
    rawMaxModelRequestRetries !== undefined &&
    resolvedMaxModelRequestRetries === undefined
  ) {
    throw new Error(
      `Invalid max model request retries: ${String(rawMaxModelRequestRetries)}. Must be a finite number.`,
    );
  }

  const screenReader =
    argv.screenReader !== undefined
      ? argv.screenReader
      : (settings.ui?.accessibility?.screenReader ?? false);

  const useAlternateBuffer =
    argv.alternateBuffer !== undefined
      ? argv.alternateBuffer
      : (settings.ui?.useAlternateBuffer ?? false);

  // Create MCP enablement manager and callbacks
  const mcpEnablementManager = McpServerEnablementManager.getInstance();
  const mcpEnablementCallbacks =
    mcpEnablementManager.getEnablementCallbacks(loadedSettings);

  const mcpServerCommand = settings.mcp?.serverCommand;
  const mcpLazyLoadFromEnvironment = process.env[ENV_MCP_LAZY] === '1';
  const mcpLazyLoadFromSettings = hasExplicitMcpLazyLoadSetting(loadedSettings);
  const mcpSettingsSourcesEnabled = !argv.strictMcpConfig;
  let mcpServers = mcpSettingsSourcesEnabled
    ? resolveSettingsBackedMcpServers(cwd, loadedSettings, borrowedMcpManager)
    : {};

  // The legacy ACP path used to inject MCP servers by writing into
  // settings.mcpServers, which loadCliConfig ignores. Warn so misuse is
  // observable; the new injection path is Config.setDynamicMcpServers.
  // Skip in strict mode because the disk map is intentionally empty
  // there, which would make every disk entry look "runtime-only".
  if (
    !argv.strictMcpConfig &&
    settings.mcpServers &&
    Object.keys(settings.mcpServers).length > 0
  ) {
    const diskNames = new Set(Object.keys(mcpServers));
    const runtimeOnly = Object.keys(settings.mcpServers).filter(
      (name) => !diskNames.has(name),
    );
    if (runtimeOnly.length > 0) {
      runLogger.warn(
        `[loadCliConfig] settings.mcpServers contains entries not present in any disk scope: ` +
          `${runtimeOnly.join(', ')}. This is NOT a runtime-injection path. ` +
          `Use Config.setDynamicMcpServers() (see docs/design/mcp-source-model.md). Ignored.`,
      );
    }
  }

  // Handle ENV_MCP_CONFIG before --mcp-config so CLI values override env.
  const envMcpConfig = getTrimmedEnv(ENV_MCP_CONFIG);
  if (envMcpConfig) {
    const external = resolveMcpConfigEntry(
      envMcpConfig,
      cwd,
      ENV_MCP_CONFIG,
    );
    mcpServers = { ...mcpServers, ...tagScope(external, 'flag') };
  }

  // Handle --mcp-config and --strict-mcp-config
  for (const entry of argv.mcpConfig ?? []) {
    const external = resolveMcpConfigEntry(entry, cwd);
    mcpServers = { ...mcpServers, ...tagScope(external, 'flag') };
  }

  // Filter project-level MCP servers by approval status.
  // Project servers (from Project, Local, or .mcp.json) require
  // explicit user approval. Pending servers are excluded here and will be
  // presented to the user via the approval dialog at startup.
  const projectMcpServers = loadProjectMcpJson(cwd, borrowedMcpManager);
  const projectServerNames = getProjectMcpServerNames(
    loadedSettings,
    projectMcpServers,
  );
  // ACP previously omitted LoadedSettings and did not run this startup
  // approval filter. Its interactive Config flag does not imply a TUI MCP
  // approval dialog. Passing session settings must not change that policy.
  if (!isAcpMode && projectServerNames.size > 0) {
    const isNonInteractive = !interactive;
    const { approved } = filterMcpServersByApproval(
      mcpServers,
      projectServerNames,
      settings.mcp,
      isNonInteractive,
    );
    mcpServers = approved;
  }

  // Normalize MCP server type values (e.g. 'streamable-http' -> 'http')
  // and warn about unrecognized types.
  mcpServers = populateMcpServerCommand(
    normalizeMcpServerConfigs(mcpServers),
    mcpServerCommand,
  );

  // Nothing reads Config.getClientName() today; keep a stable placeholder
  // instead of sniffing the hosting IDE for a value no consumer observes.
  const clientName = isAcpMode ? 'vscode' : undefined;

  const useGeneralistProfile =
    settings.experimental?.generalistProfile ?? false;
  const useContextManagement =
    settings.experimental?.contextManagement ?? false;
  const contextManagement = {
    ...(useGeneralistProfile ? generalistProfile : {}),
    ...(useContextManagement ? settings?.contextManagement : {}),
    enabled: useContextManagement || useGeneralistProfile,
  };

  // Select the requested output style name. Core resolves it against its own
  // workspace and plugin set during initialization.
  // Requested-name precedence (highest → lowest): `--output-style` CLI flag →
  // top-level `outputStyle` setting → `general.outputStyle`. Core applies the
  // default and may override the request with a forced plugin style.
  const outputStyleName =
    (typeof argv.outputStyle === 'string' && argv.outputStyle) ||
    (typeof settings.outputStyle === 'string' && settings.outputStyle) ||
    (typeof (settings.general as { outputStyle?: unknown } | undefined)
      ?.outputStyle === 'string' &&
      (settings.general as { outputStyle?: string }).outputStyle) ||
    undefined;

  const customProviderAccessMode = isRemoteWorkerMode()
    ? 'disabled'
    : options.startupMode === 'sdk'
      ? 'sdk'
      : 'local';
  const isLocalInteractiveSession =
    interactive &&
    !isAcpMode &&
    !isSDKMode() &&
    !isRemoteWorkerMode() &&
    (options.startupMode === undefined ||
      options.startupMode === 'interactive') &&
    (argv.outputFormat ?? settings.output?.format ?? 'text') === 'text';
  // Root startup has already fixed the user resource. Embedded callers that
  // enter here directly need the same process-owned initialization first.
  // Only user/flag sources determine the initial shared user resource.
  // Project opt-ins are applied by the session resource view.
  const resourceService = borrowedResourceService ?? new ResourceService();
  if (resourceService.loadFromAgentsDirectory === undefined) {
    const userResourcesDone = startupStep('user_resources');
    await initializeUserResources(resourceService, loadedSettings);
    userResourcesDone();
  }
  const configParams = {
    pluginManagerFactory: options.pluginManagerFactory,
    resourceService,
    settingsService,
    startupPhaseObserver: options.startupPhaseObserver,
    modelProviderFactory: options.modelProviderFactory,
    permissionManager: options.permissionManager,
    modelTransportManager: borrowedModelTransportManager,
    customProviderManager: borrowedCustomProviderManager,
    mcpManager: borrowedMcpManager,
    builtinPlugins: borrowedPlugins,
    builtinPluginsInitialization: borrowedPluginsInitialization,
    loadedSettings,
    sessionSettingsManager: loadedSettings,
    acpMode: isAcpMode,
    // Reviewed execution hosts opt in independently of their result-order policy.
    // Daemon-only and unspecified integration hosts retain the core default.
    parallelReadOnlyShell:
      isLocalInteractiveSession ||
      options.startupMode === 'interactive' ||
      options.startupMode === 'headless' ||
      options.startupMode === 'sdk' ||
      options.startupMode === 'acp',
    parallelToolStreaming: isLocalInteractiveSession,
    canConsumeAsyncRewake:
      argv.inputFormat === 'stream-json' || isRemoteWorkerMode(),
    clientName,
    sessionId,
    sessionPersistence: argv.sessionPersistence !== false,
    clientVersion: await getVersion(),
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    targetDir: cwd,
    includeDirectories,
    loadMemoryFromIncludeDirectories:
      settings.context?.loadMemoryFromIncludeDirectories || false,
    discoveryMaxDirs: settings.context?.discoveryMaxDirs,
    memoryBoundaryMarkers: settings.context?.memoryBoundaryMarkers,
    agentsMdExcludes: settings.agentsMdExcludes,
    importFormat: settings.context?.importFormat,
    contextFileName: settings.context?.fileName,
    debugMode,
    question,
    worktreeSettings,

    coreTools,
    excludeTools,
    mcpServerCommand,
    mcpServers,
    mcpSettingsSourcesEnabled,
    pluginMcpServersEnabled:
      !argv.strictMcpConfig || argv.allowPluginMcp === true,
    mcpInitializationWaitStrategy: options.mcpInitializationWaitStrategy,
    mcpLazyLoad: mcpLazyLoadFromEnvironment
      ? true
      : mcpLazyLoadFromSettings
        ? settings.mcp?.lazyLoad === true
        : true,
    mcpLazyLoadSource: mcpLazyLoadFromEnvironment
      ? 'environment'
      : mcpLazyLoadFromSettings
        ? 'settings'
        : 'default',
    mcpEnablementCallbacks,
    allowedMcpServers: argv.allowedMcpServerNames ?? settings.mcp?.allowed,
    blockedMcpServers: argv.allowedMcpServerNames
      ? undefined
      : settings.mcp?.excluded,
    agents: settings.agents,
    blockedEnvironmentVariables:
      settings.security?.environmentVariableRedaction?.blocked,
    allowedEnvironmentVariables:
      settings.security?.environmentVariableRedaction?.allowed,
    enableEnvironmentVariableRedaction:
      settings.security?.environmentVariableRedaction?.enabled,
    userMemory: '',
    memoryMdFileCount: 0,
    geminiMdFilePaths: [],
    permissionModeFlag: argv.permissionMode,
    allowedTools: allowedToolsCli,
    disallowedTools: disallowedToolsCli,
    accessibility: {
      ...settings.ui?.accessibility,
      screenReader,
    },
    usageStatisticsEnabled: settings.privacy?.usageStatisticsEnabled,
    fileFiltering,
    fileCheckpointing: settings.general?.fileCheckpointing?.enabled,
    proxy,
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    cwd,
    fileDiscoveryService: fileService,
    model: resolvedModel,
    modelSource: argv.model === undefined ? 'config' : 'cli',
    ultracode:
      ultracodeAllowed &&
      (cliRequestsUltracode ||
        (settings.ultracode === true && !hasExplicitOrdinaryEffort)),
    workflowKeywordTriggerEnabled:
      ultracodeAllowed && settings.workflowKeywordTriggerEnabled !== false,
    launchModelConfig,
    cliReasoningEffort: argv.reasoningEffort,
    cliContextWindow: argv.contextWindow,
    sessionPlugins,
    enableExtensionReloading: settings.experimental?.extensionReloading,
    enableAgents: settings.experimental?.enableAgents,
    allowedAgentSources:
      options.scope === 'host'
        ? ['user']
        : argv.settingSources
          ? parseSettingSourcesFlag(argv.settingSources)
          : undefined,
    settingSources: options.scope === 'host' ? ['user'] : argv.settingSources,
    inlineAgentsJson: argv.agents,
    sessionAgent: argv.agent ?? settings.agent,
    customSystemPrompt: resolveSystemPromptArg(
      argv.systemPrompt,
      argv.systemPromptFile,
    ),
    appendSystemPrompt: resolveSystemPromptArg(
      argv.appendSystemPrompt,
      argv.appendSystemPromptFile,
    ),
    outputStyleName,
    language: settings.language?.trim() || undefined,
    plan: settings.general?.plan?.enabled ?? true,
    planSettings: settings.general?.plan?.directory
      ? settings.general.plan
      : (extensionPlanSettings ?? settings.general?.plan),
    enableEventDrivenScheduler: true,
    skillsSupport: settings.skills?.enabled ?? true,
    loadSkillsFromAgentsDirectory:
      resolveLoadSkillsFromAgentsDirectory(loadedSettings),
    disableBuiltinSkills: argv.disableBuiltinSkills,
    enableBuiltinSkills: argv.enableBuiltinSkills,
    disabledSkills: settings.skills?.disabled,
    disableSkillShellExecution: settings.skills?.disableShellExecution,
    skillVisibilityOverrides: settings.skillOverrides,
    skillListingMaxDescChars: settings.skillListingMaxDescChars,
    skillListingBudgetFraction: settings.skillListingBudgetFraction,
    dream: settings.dream,
    worktree: normalizeWorktreeCreationSettings(settings.worktree),
    autoMemoryEnabled: settings.autoMemoryEnabled,
    autoMemoryUserScopeEnabled: settings.autoMemoryUserScopeEnabled,
    contextManagement,
    modelSteering: settings.experimental?.modelSteering,
    topicUpdateNarration: settings.experimental?.topicUpdateNarration,
    noBrowser: !!process.env['NO_BROWSER'],
    summarizeToolOutput: settings.model?.summarizeToolOutput,
    folderTrust,
    interactive,
    trustedFolder,
    useBackgroundColor: settings.ui?.useBackgroundColor,
    useAlternateBuffer,
    useTerminalBuffer: settings.ui?.terminalBuffer,
    useRenderProcess: settings.ui?.renderProcess,
    useRipgrep: settings.tools?.useRipgrep,
    shellToolInactivityTimeout: settings.tools?.shell?.inactivityTimeout,
    truncateToolOutputThreshold: settings.tools?.truncateToolOutputThreshold,
    eventEmitter: coreEvents,
    output: {
      format: (argv.outputFormat ?? settings.output?.format) as OutputFormat,
    },
    adk: settings.experimental?.adk,
    fakeResponses: argv.fakeResponses,
    recordResponses: argv.recordResponses,
    retryFetchErrors: settings.general?.retryFetchErrors,
    maxAttempts:
      resolvedMaxModelRequestRetries === undefined
        ? settings.general?.maxAttempts
        : modelMaxAttemptsFromRetries(resolvedMaxModelRequestRetries),
    disableLLMCorrection: settings.tools?.disableLLMCorrection,
    rawOutput: argv.rawOutput,
    acceptRawOutputRisk: argv.acceptRawOutputRisk,
    // TODO: loading of hooks based on workspace trust
    enableHooks:
      settings.disableAllHooks !== true && settings.hooksConfig.enabled,
    enableHooksUI:
      settings.disableAllHooks !== true && settings.hooksConfig.enabled,
    hooks: settings.hooks || {},
    projectHooks: projectHooks || {},
    localHooks: localHooks || {},
    userHooks: userHooks || {},
    flagHooks: flagHooks || {},
    onModelChange: (model: string) => saveModelChange(loadedSettings, model),
    onReload: async () => {
      const refreshedSettings = loadedSettings;
      return {
        disabledSkills: refreshedSettings.merged.skills.disabled,
        agents: refreshedSettings.merged.agents,
        // Hook definitions from each source, matching the shape used at
        // initial config construction in the TUI entry module. Use `?? {}` so that
        // removing all hooks from a file yields an empty object (not
        // `undefined`), which lets updateHookDefinitions() clear stale defs.
        hooks: refreshedSettings.merged.hooks ?? {},
        projectHooks: refreshedSettings.project.settings.hooks ?? {},
        localHooks: refreshedSettings.local.settings.hooks ?? {},
        userHooks: refreshedSettings.user.settings.hooks ?? {},
        flagHooks: refreshedSettings.flag.settings.hooks ?? {},
      };
    },
    onManualSettingsReload: () => loadedSettings.reload(),
    isExternalImportApproved: () =>
      isExternalImportApprovedForProject(cwd, settings.security),
    customProviderSettings:
      customProviderAccessMode === 'disabled' ? undefined : settings.providers,
    customProviderAccessMode,
    compressionConfig: settings.compression as unknown as
      | Partial<import('@qwen-code/core').CompressionConfig>
      | undefined,
    getSetting: (section: string) =>
      (settings as unknown as Record<string, unknown>)[section],
    getSettings: () => settings,
    getLaunchSetting: (section: string) =>
      (
        loadedSettings.flag.originalSettings as unknown as Record<
          string,
          unknown
        >
      )[section],
  };

  const configBuildDone = startupStep('config_build');
  const config = new Config(
    configParams as ConstructorParameters<typeof Config>[0],
  );
  configBuildDone();

  config.enableBuiltinPluginsForHeadless();

  // Inject settings file content validator so that Edit/Write tools
  // reject writes that would produce invalid settings JSON.
  config.setSettingsContentValidator(validateSettingsContent);

  let isPlainHeadless = false;

  isPlainHeadless =
    !interactive && !headlessPermissionPromptMode.hasExternalPermissionHandler;
  config.setHideInteractiveTools(isPlainHeadless);

  // Activate plan work state when plan was requested at startup. Plan is a
  // session-level work state, not a permission mode: the permission mode starts
  // at "default" and the request is routed to PlanStateManager here.
  // Plan is fully disabled in plain headless mode (no user to approve).
  const startupModeRequest =
    argv.permissionMode || settings.general?.defaultPermissionMode;
  if (isPlanModeRequest(startupModeRequest) && !isPlainHeadless) {
    if (config.isPlanEnabled()) {
      config.planStateManager.enter();
      config.notifyPlanStateChanged();
      runLogger.log('Started in plan mode (permission mode = default).');
    } else {
      runLogger.warn(
        'Permission mode "plan" is disabled in your settings. Falling back to "default".',
      );
    }
  }

  // Acquire the workspace resource view here, before runtime initialization.
  // Config.initialize reuses it, or reacquires if its workspace context changes.
  const prepareResourceViewDone = startupStep('prepare_resource_view');
  try {
    await config.prepareResourceView();
  } catch (error) {
    // The acquired resource handle is refcounted; without a Config.dispose the
    // shared entry and its watchers would leak in long-lived processes.
    runLogger.error(
      `[Config] Failed to prepare resource view: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await config.dispose().catch(() => undefined);
    throw error;
  } finally {
    prepareResourceViewDone();
  }
  return config;
}

function hasExplicitMcpLazyLoadSetting(
  loadedSettings: LoadedSettings,
): boolean {
  return [
    loadedSettings.user,
    loadedSettings.project,
    loadedSettings.local,
    loadedSettings.flag,
  ].some((source) => source.settings.mcp?.lazyLoad !== undefined);
}

function mergeExcludeTools(
  settings: MergedSettings,
  extraExcludes: string[] = [],
): string[] {
  const allExcludeTools = new Set([
    ...(settings.tools.exclude || []),
    ...extraExcludes,
  ]);
  return Array.from(allExcludeTools);
}
