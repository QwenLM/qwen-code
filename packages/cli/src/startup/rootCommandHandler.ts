/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FrameworkMode } from '../framework/appFramework.js';
import type { SettingsService } from '@qwen-code/resource';
import type { StartFramework } from './frameworkFactory.js';
import {
  type Config,
  beginStartupStep,
  coreEvents,
  ENV_PROFILE_DIR,
  ENV_PROFILE_LOG_INTERVAL_MS,
  ENV_PROFILING,
  ExitCodes,
  flushPendingAsyncRewakeHooks,
  getErrorMessage,
  flushTelemetry,
  getOrInitRuntimeProfiler,
  getRuntimeProfiler,
  initializeRuntimeProfiler,
  installStartupTraceRecorder,
  isHeadlessMode,
  parseProfileLogIntervalMs,
  registerProfilingSignalHandlers,
  reportCliStartedEvent,
  resolveLatestSameRepoTranscriptSession,
  resolveSameRepoTranscriptSession,
  runLogger,
  StartupDiagnostics,
  sessionLogger,
  type SessionResumeData,
  setPkillSelfProtectionEnabled,
  shouldEnterAlternateScreen,
  startupProfiler,
  type StartupTraceRecorderOptions,
  type StartupWarning,
  TranscriptSessionError,
  WarningPriority,
  writeToStderr,
} from '@qwen-code/core';
import {
  resolveStartupWorkspace,
  type StartupWorkspace,
} from './startupWorkspace.js';
import type { WorktreeStartupRequest } from '../utils/worktreeStartupRequest.js';
import * as cliConfig from '../config/config.js';
import {
  type CliArgs,
  loadCliConfig,
  resolveConfigTargetDir,
} from '../config/config.js';
import {
  determineStartupMode,
  isMultiSessionHost,
  usesSharedRuntime,
} from './determineStartupMode.js';
import { buildStartupPolicy, type StartupPolicy } from './startupPolicy.js';
import { shouldEagerPreloadInteractiveUI } from './startupPreload.js';
import { selectBuiltinExitOption } from './selectBuiltinExitOption.js';
import { logRouteEntered } from './route/routeLogging.js';
import type {
  ConfiguredStartupContext,
  SettingsBootstrap,
  ShellBootstrap,
} from './startupContext.js';
import { createSessionBootstrap } from './startupContext.js';
import {
  endCliStartup,
  sinceProcessStartMs,
} from '../utils/processStartClock.js';
import { StartupCoordinator } from './startupCoordinator.js';
import {
  preloadInteractiveUI,
  runInteractiveRoute,
} from './route/interactiveRouteRunner.js';
import type { RuntimeRouteRunnerOptions } from './route/runtimeRouteTypes.js';
import { restoreRuntimeConfigFromResumeData } from '../utils/resumeModel.js';
import {
  buildResumedSessionData,
  resumeSessionDepsFromConfig,
} from '../utils/resumeSessionData.js';
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import dns from 'node:dns';
import {
  getSettingsResolveOptions,
  type DnsResolutionOrder,
  type LoadedSettings,
} from '../config/settings.js';
import { getPrefetchedStartupWarnings } from '../utils/startupWarnings.js';
import { getUserStartupWarnings } from '../utils/userStartupWarnings.js';
import { ConsolePatcher } from '../ui/utils/ConsolePatcher.js';
import type { SessionHandle } from '../session/session.js';
import type { SessionUiBinding } from '../ui/session/prepareSessionUi.js';
import {
  flushStaleStdinOnStartup,
  registerCleanup,
  registerSessionEndCleanup,
  registerSyncCleanup,
  registerExitConfig,
  runExitCleanupWithTimeout,
} from '../utils/cleanup.js';
import { validateTheme } from '../core/theme.js';
import { isAlternateBufferEnabled } from '../utils/alternateBuffer.js';
import type { SessionBrowserOpenOptions } from '../ui/hooks/useSessionBrowser.js';
import {
  getSessionIdAvailabilityError,
  getSessionIdUsageError,
} from '../utils/sessionIdFlag.js';

export function validateDnsResolutionOrder(
  order: string | undefined,
): DnsResolutionOrder {
  const defaultValue: DnsResolutionOrder = 'ipv4first';
  if (order === undefined) {
    return defaultValue;
  }
  if (order === 'ipv4first' || order === 'verbatim') {
    return order;
  }
  runLogger.warn(
    `Invalid value for dnsResolutionOrder in settings: "${order}". Using default "${defaultValue}".`,
  );
  return defaultValue;
}

const PROFILE_STARTUP_DISABLED_VALUES = new Set([
  '0',
  'false',
  'off',
  'none',
  'no',
]);
const PROFILE_HEAVY_MODES = new Set(['cpu', 'heap', 'heap-alloc', 'all']);

function normalizeProfileStartupMode(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || PROFILE_STARTUP_DISABLED_VALUES.has(normalized)) {
    return null;
  }
  return normalized;
}

const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 8192;
const MAX_OLD_SPACE_SIZE_FLAG = /--max[-_]old[-_]space[-_]size(?:=|\s|$)/;

/** Writes the trace once the mode's last startup milestone is reached; exit always writes. */
function startupTraceOptions(
  mode: 'interactive' | 'headless' | 'daemon' | 'acp',
): StartupTraceRecorderOptions {
  switch (mode) {
    case 'interactive':
      return { mode: 'tui', flushOn: ['tui_first_turn_ready'] };
    case 'daemon':
      return { mode: 'daemon', flushOn: ['session_initialized'] };
    case 'headless':
    case 'acp':
      return { mode, flushOn: [] };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

function hasExplicitMaxOldSpaceSize(): boolean {
  return (
    process.execArgv.some((arg) => MAX_OLD_SPACE_SIZE_FLAG.test(arg)) ||
    MAX_OLD_SPACE_SIZE_FLAG.test(process.env['NODE_OPTIONS'] ?? '')
  );
}

export function getNodeMemoryArgs(isDebugMode: boolean): string[] {
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  if (isDebugMode) {
    runLogger.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (hasExplicitMaxOldSpaceSize()) {
    return [];
  }

  // Single-process startup cannot change the current process' V8 heap limit
  // after Node has already started. Return the default args for launch paths
  // that still create a child CLI process.
  return [`--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_SIZE_MB}`];
}

function shouldPreloadTerminalCapabilities(
  startupPolicy: StartupPolicy,
  settings: LoadedSettings,
): boolean {
  return !(
    !startupPolicy.preload.terminalCapabilityModule ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    settings.merged.ui.accessibility?.screenReader
  );
}

function shouldRunEarlyTerminalCapabilityDetection(
  startupPolicy: StartupPolicy,
  settings: LoadedSettings,
): boolean {
  if (!shouldPreloadTerminalCapabilities(startupPolicy, settings)) {
    return false;
  }

  // Windows cmd/PowerShell/ConPTY can deliver probe responses and user Enter
  // bytes through the same raw-mode stdin window. Keep the module preload, but
  // avoid attaching an early data listener before Ink owns stdin.
  return process.platform !== 'win32';
}

function preloadTerminalCapabilityModuleForInteractive(
  startupPolicy: StartupPolicy,
  settings: LoadedSettings,
  shouldPreloadInteractiveUI = startupPolicy.preload.interactiveUI,
): void {
  if (
    !shouldPreloadInteractiveUI ||
    !shouldPreloadTerminalCapabilities(startupPolicy, settings)
  ) {
    return;
  }

  const preloadHandle = startupProfiler.start(
    'preload_terminal_capabilities_module',
  );
  import('../ui/utils/terminalCapabilityManager.js')
    .catch((error: unknown) => {
      runLogger.debug(
        '[terminal] Early capability module preload failed:',
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      preloadHandle?.end();
    });
}

function startTerminalCapabilitiesDetectionForInteractive(
  startupPolicy: StartupPolicy,
  settings: LoadedSettings,
): void {
  if (!shouldRunEarlyTerminalCapabilityDetection(startupPolicy, settings)) {
    return;
  }

  const preloadHandle = startupProfiler.start('preload_terminal_capabilities');
  import('../ui/utils/terminalCapabilityManager.js')
    .then(({ terminalCapabilityManager }) =>
      terminalCapabilityManager.detectCapabilities(),
    )
    .catch((error: unknown) => {
      runLogger.debug(
        '[terminal] Early capability detection failed:',
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      preloadHandle?.end();
    });
}

async function buildStartupWarnings(
  settings: LoadedSettings,
  config: Config,
): Promise<StartupWarning[]> {
  const warningsHandle = startupProfiler.start('collect_startup_warnings');
  try {
    // Captured before the first await: Config.initialize() consumes and clears
    // this list, and this function runs as a floating promise.
    const pendingDirectories = config.getPendingIncludeDirectories();
    const useAlternateBuffer = shouldEnterAlternateScreen(
      isAlternateBufferEnabled(config),
      config.getScreenReader(),
    );
    const [rawStartupWarnings, userStartupWarnings] = await Promise.all([
      getPrefetchedStartupWarnings(),
      getUserStartupWarnings(settings.merged, undefined, {
        isAlternateBuffer: useAlternateBuffer,
        workingDirectories: pendingDirectories,
      }),
    ]);

    return [
      ...rawStartupWarnings.map((message) => ({
        id: `startup-${createHash('sha256').update(message).digest('hex').substring(0, 16)}`,
        message,
        priority: WarningPriority.High,
      })),
      ...userStartupWarnings,
    ];
  } finally {
    warningsHandle?.end();
  }
}

/**
 * Runs everything the root command needs after argv is known: startup policy,
 * config loading, auth, and the three startup pipelines. Triggered from the
 * root command's action in commands/index.ts, so main() only owns the
 * process-level setup that must happen before any command runs.
 */
export async function handleRootCommand(
  argv: CliArgs,
  preparedWorkspace: StartupWorkspace | undefined,
  settingsService: SettingsService,
  startFramework: StartFramework,
): Promise<void> {
  const sessionBootstrap = createSessionBootstrap(argv);
  const host = isMultiSessionHost(argv);
  const workspaceResolveDone = beginStartupStep('workspace_resolve');
  const workspace = host
    ? await resolveStartupWorkspace(argv)
    : (preparedWorkspace ?? (await resolveStartupWorkspace(argv)));
  workspaceResolveDone();
  const {
    resourceRoot: startupResourceRoot,
    resumeSelection: startupResumeSelection,
    inheritedWorktreeRequest,
  } = workspace;
  if (startupResumeSelection?.status === 'fulfilled') {
    const attempt = startupResumeSelection.value.resumeAttempt;
    registerSyncCleanup(() => attempt?.finish());
  }
  const settingsLoadDone = beginStartupStep('settings_load');
  const settings = host
    ? settingsService.resolve(
        getSettingsResolveOptions(startupResourceRoot, ['user']),
      )
    : settingsService.resolve(getSettingsResolveOptions(startupResourceRoot));
  settingsLoadDone();
  if (settings.isUserSettingsLoadRejected?.()) {
    const error = settings.errors
      .filter((item) => item.path === settings.user.path)
      .at(-1);
    if (error) {
      runLogger.warn(
        `[Settings] Invalid settings file ${error.path}: ${error.message}`,
      );
    }
  }
  sessionLogger.event({
    level: 'info',
    kind: 'cli',
    type: 'cli.arguments.parsed',
    data: {
      interactive_prompt: argv.promptInteractive,
      output_format: argv.outputFormat,
      input_format: argv.inputFormat,
      has_prompt: !!argv.prompt,
      cwd: argv.cwd,
      sdk: argv.sdk === true,
      resume: argv.resume !== undefined,
      continue: argv.continue,
    },
  });

  if (argv.startupMessages) {
    argv.startupMessages.forEach((msg) => {
      coreEvents.emitFeedback('info', msg);
    });
  }
  if (argv.deprecationWarnings) {
    argv.deprecationWarnings.forEach((msg) => {
      writeToStderr(`${msg}\n`);
    });
  }

  if (argv.promptInteractive && !process.stdin.isTTY) {
    writeToStderr(
      'Error: The --prompt-interactive flag cannot be used when input is piped from stdin.\n',
    );
    await runExitCleanupWithTimeout();
    sessionLogger.setExitContext({
      reason: 'input_error',
      exit_code: ExitCodes.FATAL_INPUT_ERROR,
      message:
        '--prompt-interactive cannot be used when input is piped from stdin',
      source: 'gemini.parseArgs',
    });
    process.exit(ExitCodes.FATAL_INPUT_ERROR);
  }

  const startupMode = determineStartupMode(argv);

  const logStartupPhase = (
    phase: string,
    startedAt: number,
    extras?: Record<string, unknown>,
  ) => {
    const now = Date.now();
    sessionLogger.event({
      level: 'info',
      kind: 'cli',
      type: 'cli.startup.phase.completed',
      data: {
        phase,
        mode: startupMode.kind,
        bare: argv.bare === true,
        duration_ms: now - startedAt,
        since_main_start_ms: sinceProcessStartMs(),
        ...extras,
      },
    });
  };

  const startupPolicy = buildStartupPolicy(startupMode);
  const startupTrace = installStartupTraceRecorder(
    startupTraceOptions(startupMode.kind),
  );
  if (startupTrace) {
    registerCleanup(() => {
      startupTrace.writeSync();
      startupTrace.dispose();
    });
  }
  const startupCoordinator = new StartupCoordinator(
    startupPolicy,
    settings.merged,
  );
  const shouldPreloadInteractiveUI = shouldEagerPreloadInteractiveUI(
    startupMode,
    argv,
  );
  const effectivePreload = {
    ...startupPolicy.preload,
    interactiveUI: shouldPreloadInteractiveUI,
    terminalCapabilityModule:
      startupPolicy.preload.terminalCapabilityModule &&
      shouldPreloadInteractiveUI,
  };
  sessionLogger.event({
    level: 'info',
    kind: 'cli',
    type: 'cli.startup.mode.resolved',
    data: {
      mode: startupPolicy.mode.kind,
      bare: argv.bare === true,
      pre_config_route: 'none',
      mcp_initialization_wait: startupPolicy.mcpInitializationWait,
      preload: effectivePreload,
      since_main_start_ms: sinceProcessStartMs(),
    },
  });
  runLogger.debug(
    `[startup] mode=${startupPolicy.mode.kind} mcpInitializationWait=${startupPolicy.mcpInitializationWait} cleanup=${startupPolicy.cleanup.phase} preload=${JSON.stringify(effectivePreload)}`,
  );
  preloadTerminalCapabilityModuleForInteractive(
    startupPolicy,
    settings,
    shouldPreloadInteractiveUI,
  );
  startupCoordinator.registerStartupCleanupOnExit();
  if (shouldPreloadInteractiveUI) {
    void preloadInteractiveUI().catch(() => {});
  }

  const isDebugMode = cliConfig.isDebugMode(argv);
  const nodeMemoryArgs = settings.merged.advanced.autoConfigureMemory
    ? getNodeMemoryArgs(isDebugMode)
    : [];
  const settingsBootstrap: SettingsBootstrap = {
    settings,
    argv,
  };
  const startupCwd = process.cwd();
  const shellBootstrap: ShellBootstrap = {
    cwd: startupCwd,
    isDebugMode,
    nodeMemoryArgs,
  };
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    interactive: !isHeadlessMode(),
    debugMode: isDebugMode,
    onNewMessage: (msg) => {
      coreEvents.emitConsoleLog(msg.type, msg.content);
    },
  });
  consolePatcher.patch();
  // Register consolePatcher cleanup on process 'exit' (not registerCleanup) so it
  // runs AFTER all async cleanup handlers (SessionEnd hooks, WorktreeRemove, etc.).
  // If consolePatcher.cleanup ran earlier, those handlers' runLogger calls would
  // bypass the patcher and leak to the terminal in non-debug mode.
  process.on('exit', consolePatcher.cleanup);

  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced.dnsResolutionOrder),
  );

  const sessionIdUsageError = getSessionIdUsageError(argv);
  if (sessionIdUsageError) {
    coreEvents.emitFeedback('error', sessionIdUsageError);
    await runExitCleanupWithTimeout();
    sessionLogger.setExitContext({
      reason: 'input_error',
      exit_code: ExitCodes.FATAL_INPUT_ERROR,
      message: 'Invalid --session-id usage',
      source: 'gemini.parseArgs',
    });
    process.exit(ExitCodes.FATAL_INPUT_ERROR);
  }

  const diagnostics = new StartupDiagnostics(
    sessionBootstrap.initialSessionId,
    startupResourceRoot,
  );
  const sessionIdAvailabilityError = await getSessionIdAvailabilityError(
    resolveConfigTargetDir(startupResourceRoot),
    argv,
  );
  if (sessionIdAvailabilityError) {
    coreEvents.emitFeedback('error', sessionIdAvailabilityError);
    await runExitCleanupWithTimeout();
    sessionLogger.setExitContext({
      reason: 'input_error',
      exit_code: ExitCodes.FATAL_INPUT_ERROR,
      message: 'Session ID not available',
      source: 'gemini.parseArgs',
    });
    process.exit(ExitCodes.FATAL_INPUT_ERROR);
  }

  const frameworkInput = {
    argv,
    settings,
    workspaceRoot: startupResourceRoot,
    inheritedWorktreeRequest,
  };
  const shortCommand =
    !argv.acp &&
    !argv.sdk &&
    (argv.listExtensions ||
      argv.listSessions ||
      argv.listModels ||
      argv.deleteSession !== undefined);
  const mode: FrameworkMode = shortCommand
    ? 'command'
    : startupMode.kind === 'interactive'
      ? 'tui'
      : startupMode.kind;
  const entryInput = shortCommand
    ? {
        ...frameworkInput,
        command: argv.listExtensions
          ? ('resources' as const)
          : argv.listModels
            ? // 清单要向推理端点发签名请求，仅有登录态不够：客户端不启动就
              // 没有端点选举，请求会落到静态兜底域名而签名不匹配。
              ('client' as const)
            : ('local' as const),
      }
    : frameworkInput;
  const framework = await startFramework(mode, entryInput);

  // We are now past pre-config handling. It is safe to perform expensive
  // initialization that may have side effects.
  const userResourcesDone = beginStartupStep('user_resources');
  const sharedRuntime = usesSharedRuntime(argv);
  const daemonEntry = startupMode.kind === 'daemon';
  if (sharedRuntime || argv.listExtensions)
    await diagnostics.phase('startup.user_resources', () =>
      framework.resources!.whenReady(),
    );
  userResourcesDone();

  // 共享成员在入口解析后逐字段交给 Config；Config 不认识 Framework，也不接管生命周期。
  // daemon 只取“已创建”的句柄，不在这里等插件/MCP 初始化；Config 在会话 initialize
  // 时再 await 它们，握手因此可以先完成。
  const borrowedPluginsInitialization = sharedRuntime
    ? framework.appPlugins!.whenReady()
    : undefined;
  const borrowedPlugins = daemonEntry
    ? await framework.appPlugins!.whenCreated()
    : await borrowedPluginsInitialization;
  const borrowedMcpManager = sharedRuntime
    ? daemonEntry
      ? await framework.mcpManager!.whenCreated()
      : await framework.mcpManager!.whenReady()
    : framework.mcpManager?.isInitialized()
      ? framework.mcpManager.get()
      : undefined;

  const permissionManager = framework.permissionManager?.isInitialized()
    ? framework.permissionManager.get()
    : undefined;

  const loadConfigStartedAt = Date.now();
  const loadConfigHandle = startupProfiler.start('load_cli_config');
  const config = await diagnostics.phase('startup.config_load', () =>
    loadCliConfig(settings, sessionBootstrap.initialSessionId, argv, {
      scope: isMultiSessionHost(argv) ? 'host' : 'session',
      cwd: startupResourceRoot,
      mcpInitializationWaitStrategy: startupPolicy.mcpInitializationWait,
      startupMode: startupMode.kind,
      resourceService: framework.resources!.get(),
      settingsService: framework.settingsService,
      builtinPlugins: borrowedPlugins,
      builtinPluginsInitialization: borrowedPluginsInitialization,
      mcpManager: borrowedMcpManager,
      modelTransportManager: framework.modelTransportManager?.get(),
      customProviderManager: framework.customProviderManager?.get(),
      pluginManagerFactory: framework.pluginManagerFactory,
      modelProviderFactory: framework.getModelProviderFactory(),
      permissionManager,
    }),
  );
  loadConfigHandle?.end();
  const loadConfigDurationMs = Date.now() - loadConfigStartedAt;
  logStartupPhase('load_cli_config_full', loadConfigStartedAt);
  sessionLogger.event({
    level: 'info',
    kind: 'session',
    type: 'session.config.loaded',
    ids: {
      session_id: config.getSessionId(),
    },
    data: {
      project_root: config.getProjectRoot(),
      target_dir: config.getTargetDir(),
      debug_mode: config.getDebugMode(),
      interactive: config.isInteractive(),
      model: config.getModel(),
      permission_mode: config.getPermissionMode(),
      load_config_duration_ms: loadConfigDurationMs,
    },
  });
  // One anonymous cli_started per root-command start (TUI, headless, ACP, SDK
  // all branch below); subcommands and --version/--help never get here.
  // Delivery is fire-and-forget; the pending export is awaited at exit.
  if (
    reportCliStartedEvent({
      sessionId: config.getSessionId(),
      usageStatisticsEnabled: config.getUsageStatisticsEnabled(),
    })
  ) {
    registerCleanup(flushTelemetry);
  }
  const configuredContext: ConfiguredStartupContext = {
    phase: 'configured',
    shell: shellBootstrap,
    settings: settingsBootstrap,
    session: sessionBootstrap,
    policy: startupPolicy,
    config,
    framework,
  };
  const startupWarningsPromise = config.isInteractive()
    ? buildStartupWarnings(settings, config)
    : Promise.resolve([]);
  void startupWarningsPromise.catch(() => {});

  // Storage must be initialized before session operations (listing,
  // resuming) so they see the project identifier.
  const storageInitializeStartedAt = Date.now();
  await config.storage.initialize();
  logStartupPhase('storage_initialize', storageInitializeStartedAt);

  let activeInteractiveConfig = config;
  registerExitConfig(config);

  // SessionEnd has its own shutdown phase so unrelated cleanup cannot consume
  // the hook's timeout budget before it runs.
  registerSessionEndCleanup(async (reason) => {
    await flushPendingAsyncRewakeHooks();
    await activeInteractiveConfig.getHookSystem()?.fireSessionEndEvent(reason);
  });

  // daemon / acp 自带会话生命周期与身份来源，先于入口的 resume/终端启动流程分派。
  if (startupMode.kind === 'daemon') {
    const { runSdkOption } = await import('./options/sdk.js');
    await runSdkOption(configuredContext, startupCoordinator);
    return;
  }

  if (startupMode.kind === 'acp') {
    const { runAcpOption } = await import('./options/acp.js');
    await runAcpOption(configuredContext, startupCoordinator);
    return;
  }

  // Builtin exit options win over headless: --list-sessions etc. run under a
  // 'command' framework, and CI/piped environments are detected as headless,
  // so the headless branch must not claim them.
  switch (selectBuiltinExitOption(argv)) {
    case 'listExtensions': {
      const { runListExtensionsOption } = await import(
        './options/listExtensions.js'
      );
      await runListExtensionsOption(configuredContext, startupCoordinator);
      return;
    }
    case 'listSessions': {
      const { runListSessionsOption } = await import(
        './options/listSessions.js'
      );
      await runListSessionsOption(configuredContext, startupCoordinator);
      return;
    }
    case 'listModels': {
      const { runModelListOption } = await import('./options/modelList.js');
      await runModelListOption(configuredContext);
      return;
    }
    case 'deleteSession': {
      const { runDeleteSessionOption } = await import(
        './options/deleteSession.js'
      );
      await runDeleteSessionOption(
        configuredContext,
        startupCoordinator,
        argv.deleteSession!,
      );
      return;
    }
    default:
      break;
  }

  if (startupMode.kind === 'headless') {
    const { runHeadlessOption } = await import('./options/headless.js');
    await runHeadlessOption(configuredContext, startupCoordinator);
    return;
  }

  if (config.isInteractive() && !process.stdin.isRaw && process.stdin.isTTY) {
    process.stdin.setRawMode(true);

    // Windows-only: drop stdin bytes the previous CLI invocation left in
    // libuv's pipeline so a stale "↓ Enter" doesn't auto-dismiss the next
    // dialog. See flushStaleStdinOnStartup for details.
    await flushStaleStdinOnStartup();
    startTerminalCapabilitiesDetectionForInteractive(startupPolicy, settings);

    registerSyncCleanup(() => {
      process.stdin.setRawMode(false);
    });
  }

  let profileOutputDir = process.env[ENV_PROFILE_DIR]?.trim() || undefined;
  const profilingMode = normalizeProfileStartupMode(process.env[ENV_PROFILING]);

  if (profileOutputDir) {
    try {
      initializeRuntimeProfiler({ outputDir: profileOutputDir });
    } catch (err) {
      runLogger.warn(
        `[profile] Invalid ${ENV_PROFILE_DIR}; using default profile output directory. ${getErrorMessage(err)}`,
      );
      profileOutputDir = undefined;
    }
  }

  registerProfilingSignalHandlers({
    outputDir: profileOutputDir,
  });

  // Cross-session peer messaging. Never fatal: a session that cannot bind
  // simply has no peers.
  let stopCrossSessionMessaging: (() => Promise<void>) | undefined;
  registerCleanup(async () => {
    await stopCrossSessionMessaging?.();
  });
  try {
    const { startCrossSessionMessaging } = await import(
      './crossSessionMessaging.js'
    );
    stopCrossSessionMessaging = await startCrossSessionMessaging({
      config,
      settings,
      ...(argv.messagingSocketPath !== undefined && {
        explicitSocketPath: argv.messagingSocketPath,
      }),
    });
  } catch (error) {
    runLogger.error(`[uds-messaging] Startup failed: ${error}`);
  }

  registerCleanup(async () => {
    const profiler = getRuntimeProfiler();
    if (!profiler) {
      return;
    }

    const results = await profiler.dispose();
    for (const result of results) {
      runLogger.log(
        `[runtime-profiler] Encrypted profile saved on exit: ${result.filePath} (${result.type})`,
      );
    }
  });

  if (profilingMode) {
    const profiler = getOrInitRuntimeProfiler();
    if (PROFILE_HEAVY_MODES.has(profilingMode)) {
      runLogger.warn(
        `[profile] ${ENV_PROFILING}=${profilingMode}: only lightweight logging is started at boot. Use /profile cpu start, /profile snapshot, or /profile heap-alloc start to capture heavy profiles on demand.`,
      );
    }

    try {
      profiler.startLightweightLogging(
        parseProfileLogIntervalMs(process.env[ENV_PROFILE_LOG_INTERVAL_MS]),
      );
    } catch (err) {
      runLogger.warn(
        `[profile] Invalid ${ENV_PROFILE_LOG_INTERVAL_MS}; using default interval. ${getErrorMessage(err)}`,
      );
      profiler.startLightweightLogging();
    }
  }

  let terminalSetupPromise: Promise<void> | undefined;
  if (config.isInteractive()) {
    const terminalHandle = startupProfiler.start('setup_terminal');
    const { setupTerminalAndTheme } = await import('../utils/terminalTheme.js');
    terminalSetupPromise = setupTerminalAndTheme(config, settings)
      .then(() => undefined)
      .finally(() => {
        terminalHandle?.end();
      });
  }

  const themeError = validateTheme(settings);
  if (terminalSetupPromise) {
    await terminalSetupPromise;
  }
  if (!config.isInteractive() && themeError) {
    runLogger.warn(`Warning: ${themeError}`);
  }

  const initialSessionTitle = argv.name;
  const startupWarnings = await startupWarningsPromise;

  // Handle session resume flags.
  let resumedSessionData: SessionResumeData | undefined = undefined;
  let session: SessionHandle | undefined;
  let sessionUi: SessionUiBinding | undefined;
  let initialSessionBrowserOptions: SessionBrowserOpenOptions | undefined =
    undefined;
  let resumedWorktreeStartupRequest: WorktreeStartupRequest | undefined;
  if (argv.continue) {
    try {
      if (startupResumeSelection?.status === 'rejected')
        throw startupResumeSelection.reason;
      const result =
        startupResumeSelection?.value ??
        (await resolveLatestSameRepoTranscriptSession(
          config.getProjectRoot(),
          config.getSessionId(),
        ));
      resumedSessionData = await buildResumedSessionData(
        resumeSessionDepsFromConfig(config),
        result,
        {
          forkSession: argv.forkSession,
          sessionMirror: argv.sessionMirror,
          targetSessionId: argv.sessionId,
        },
      );
      if (resumedSessionData) {
        // 本地恢复由挂载后的 useSessionResume 完成；首屏前不能等待认证驱动的模型目录。
        if (argv.remoteSession) {
          await restoreRuntimeConfigFromResumeData(config, resumedSessionData);
        }
        config.setSessionId(resumedSessionData.sessionId);
      }
    } catch (error) {
      if (
        error instanceof TranscriptSessionError &&
        error.code === 'NO_SESSIONS_FOUND'
      ) {
        coreEvents.emitFeedback('error', 'No conversation found to continue');
      } else {
        coreEvents.emitFeedback(
          'error',
          `Error continuing session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
      await runExitCleanupWithTimeout();
      sessionLogger.setExitContext({
        reason: 'input_error',
        exit_code: ExitCodes.FATAL_INPUT_ERROR,
        message: `Error continuing session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: 'gemini.resume',
        error_name: error instanceof Error ? error.name : undefined,
        error_stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(ExitCodes.FATAL_INPUT_ERROR);
    }
  } else if (argv.resume !== undefined) {
    const trimmedResume = argv.resume.trim();
    try {
      if (
        config.isInteractive() &&
        !config.getAcpMode() &&
        startupResumeSelection?.status !== 'fulfilled'
      ) {
        initialSessionBrowserOptions = trimmedResume
          ? {
              resumeTarget: trimmedResume,
              forkSession: argv.forkSession,
              initialSessionTitle,
              targetSessionId: argv.sessionId,
            }
          : {
              forkSession: argv.forkSession,
              initialSessionTitle,
              targetSessionId: argv.sessionId,
            };
      } else {
        if (!trimmedResume) {
          coreEvents.emitFeedback(
            'error',
            'Error resuming session: --resume requires a session identifier outside interactive mode.',
          );
          await runExitCleanupWithTimeout();
          sessionLogger.setExitContext({
            reason: 'input_error',
            exit_code: ExitCodes.FATAL_INPUT_ERROR,
            message:
              '--resume requires a session identifier outside interactive mode',
            source: 'gemini.resume',
          });
          process.exit(ExitCodes.FATAL_INPUT_ERROR);
        }
        if (startupResumeSelection?.status === 'rejected')
          throw startupResumeSelection.reason;
        const result =
          startupResumeSelection?.value ??
          (await resolveSameRepoTranscriptSession(
            config.getProjectRoot(),
            trimmedResume,
            config.getSessionId(),
          ));
        resumedSessionData = await buildResumedSessionData(
          resumeSessionDepsFromConfig(config),
          result,
          {
            forkSession: argv.forkSession,
            sessionMirror: argv.sessionMirror,
            resumeSessionAt: argv.resumeSessionAt,
            resumeDropsTurn: argv.resumeDropsTurn,
            targetSessionId: argv.sessionId,
          },
        );
      }
      if (resumedSessionData) {
        // 本地恢复由挂载后的 useSessionResume 完成；首屏前不能等待认证驱动的模型目录。
        if (argv.remoteSession) {
          await restoreRuntimeConfigFromResumeData(config, resumedSessionData);
        }
        config.setSessionId(resumedSessionData.sessionId);
      }
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        `Error resuming session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      await runExitCleanupWithTimeout();
      sessionLogger.setExitContext({
        reason: 'input_error',
        exit_code: ExitCodes.FATAL_INPUT_ERROR,
        message: `Error resuming session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: 'gemini.resume',
        error_name: error instanceof Error ? error.name : undefined,
        error_stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(ExitCodes.FATAL_INPUT_ERROR);
    }
  }
  try {
    // prepareSession 仅负责远程交接。
    // 远端交接同样发生在首屏之前，此时不能读取需要登录态的模型目录：解析器会等待
    // 认证，而认证要等交接返回后才发起，两者互相等待。偏好由挂载后的 UI 在模型目录
    // 就绪时补齐。
    if (argv.remoteSession) {
      session = await framework?.prepareSession({
        model: config.getModel() ?? '',
        permissionMode: config.getPermissionMode(),
      });
    }
    if (session) {
      try {
        const { prepareSessionUi } = await import(
          '../ui/session/prepareSessionUi.js'
        );
        sessionUi = prepareSessionUi(session)!;
      } catch (error) {
        await session.release();
        throw error;
      }
      const ownedBinding = sessionUi;
      registerCleanup(() => ownedBinding.dispose());
      const state = session.getState();
      if (state.access.sessionId) config.setSessionId(state.access.sessionId);
      for (const message of state.warnings ?? [])
        startupWarnings.push({
          id: 'session-warning-' + state.access.sessionId,
          message,
          priority: WarningPriority.High,
        });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Error preparing session';
    coreEvents.emitFeedback('error', message);
    await runExitCleanupWithTimeout();
    sessionLogger.setExitContext({
      reason: 'input_error',
      exit_code: ExitCodes.FATAL_INPUT_ERROR,
      message,
      source: 'session.prepare',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(ExitCodes.FATAL_INPUT_ERROR);
  }

  // 配置加载只确定项目归属；Worktree 请求在分发给 Session 前组装。
  const unifiedWorktreeRequest: WorktreeStartupRequest | undefined =
    isMultiSessionHost(argv)
      ? undefined
      : (inheritedWorktreeRequest ??
        (argv.worktree === undefined
          ? undefined
          : {
              kind: 'create',
              name: argv.worktree,
              originalCwd: startupResourceRoot,
            }));
  if (unifiedWorktreeRequest && !session) {
    if (resumedSessionData) {
      // 已选中的历史 Session 必须先建立 Writer 并恢复旧状态，再立即写入
      // 显式 Worktree 请求，避免资源发现与 transcript 归属提前切到 checkout。
      resumedWorktreeStartupRequest = unifiedWorktreeRequest;
    } else if (initialSessionBrowserOptions) {
      initialSessionBrowserOptions = {
        ...initialSessionBrowserOptions,
        worktreeStartupRequest: unifiedWorktreeRequest,
      };
    } else {
      // 新的 TUI 与 Headless Session 同样在 Writer 可用后处理请求；完整
      // Config 初始化始终基于 originalCwd，Agent/Skill/MCP 不会被 Worktree
      // 运行根重新发现。
      resumedWorktreeStartupRequest = unifiedWorktreeRequest;
    }
  }

  endCliStartup();
  const runtimeRouteOptions: RuntimeRouteRunnerOptions = {
    startupCoordinator,
    themeError,
    startupWarnings,
    resumedSessionData,
    session,
    initialSessionBrowserOptions,
    worktreeStartupRequest: resumedWorktreeStartupRequest,
    initialSessionTitle,
    sessionUi,
    rebuildProject: async (current, data) => {
      await stopCrossSessionMessaging?.();
      stopCrossSessionMessaging = undefined;
      const { rebuildInteractiveProject } = await import(
        '../interactiveProjectRuntime.js'
      );
      const next = await rebuildInteractiveProject(current, data, argv);
      activeInteractiveConfig = next.config;
      registerExitConfig(next.config);
      try {
        const { startCrossSessionMessaging } = await import(
          './crossSessionMessaging.js'
        );
        stopCrossSessionMessaging = await startCrossSessionMessaging({
          config: next.config,
          settings: next.settings,
          explicitSocketPath: argv.messagingSocketPath,
        });
      } catch (error) {
        runLogger.warn('[uds-messaging] Project resume setup failed:', error);
      }
      return next;
    },
  };
  setPkillSelfProtectionEnabled(true);
  logRouteEntered(configuredContext, startupMode.kind);
  await runInteractiveRoute(configuredContext, runtimeRouteOptions);
}
