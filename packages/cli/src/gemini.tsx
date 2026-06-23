/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  InputFormat,
  isDebugLoggingDegraded,
  isBareMode,
  logUserPrompt,
  QWEN_CODE_SIMPLE_ENV_VAR,
  Storage,
  SessionService,
  setStartupEventSink,
  type Config,
  createDebugLogger,
  writeRuntimeStatus,
  persistSessionUsage,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';
import { render } from 'ink';
import dns from 'node:dns';
import os from 'node:os';
import path, { basename } from 'node:path';
import v8 from 'node:v8';
import React from 'react';
import { validateAuthMethod } from './config/auth.js';
import * as cliConfig from './config/config.js';
import {
  buildDisabledSkillNamesProvider,
  loadCliConfig,
  parseArguments,
} from './config/config.js';
import type { DnsResolutionOrder, LoadedSettings } from './config/settings.js';
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  createMinimalSettings,
  getSettingsWarnings,
  loadSettings,
  preResolveHomeEnvOverrides,
} from './config/settings.js';
import { SettingsWatcher } from './config/settingsWatcher.js';
import {
  initializeApp,
  type InitializationResult,
} from './core/initializer.js';
import { handleList as handleListExtensions } from './commands/extensions/list.js';
import { initializeI18n, resolveLanguageSetting } from './i18n/index.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import {
  setupStartupWorktree,
  persistStartupWorktreeSidecar,
  buildStartupWorktreeNotice,
  type StartupWorktreeContext,
} from './startup/worktreeStartup.js';
import { runNonInteractiveStreamJson } from './nonInteractive/session.js';
import { AppContainer } from './ui/AppContainer.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { KeypressProvider } from './ui/contexts/KeypressContext.js';
import { SessionStatsProvider } from './ui/contexts/SessionContext.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';
import { VimModeProvider } from './ui/contexts/VimModeContext.js';
import { AgentViewProvider } from './ui/contexts/AgentViewContext.js';
import { BackgroundTaskViewProvider } from './ui/contexts/BackgroundTaskViewContext.js';
import { useKittyKeyboardProtocol } from './ui/hooks/useKittyKeyboardProtocol.js';
import { themeManager, AUTO_THEME_NAME } from './ui/themes/theme-manager.js';
import {
  detectAndEnableKittyProtocol,
  disableKittyProtocol,
} from './ui/utils/kittyProtocolDetector.js';
import { checkForUpdates } from './ui/utils/updateCheck.js';
import {
  cleanupCheckpoints,
  registerCleanup,
  runExitCleanup,
} from './utils/cleanup.js';
import { AppEvent, appEvents } from './utils/events.js';
import { handleAutoUpdate } from './utils/handleAutoUpdate.js';
import { readStdin } from './utils/readStdin.js';
import {
  profileCheckpoint,
  recordStartupEvent,
  setInteractiveMode,
  finalizeStartupProfile,
  isStartupProfilerEnabled,
} from './utils/startupProfiler.js';
import {
  relaunchAppInChildProcess,
  relaunchOnExitCode,
} from './utils/relaunch.js';
import { start_sandbox } from './utils/sandbox.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { getCliVersion } from './utils/version.js';
import { initializeWarningHandler } from './utils/warningHandler.js';
import { writeStderrLine } from './utils/stdioHelpers.js';
import { getHeadlessYoloSafetyWarning } from './utils/headlessSafetyWarnings.js';
import { computeWindowTitle, writeTerminalTitle } from './utils/windowTitle.js';
import {
  startEarlyInputCapture,
  stopAndGetCapturedInput,
} from './utils/earlyInputCapture.js';
import { preconnectApi } from './utils/apiPreconnect.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { showResumeSessionPicker } from './ui/components/StandaloneSessionPicker.js';
import { initializeLlmOutputLanguage } from './utils/languageUtils.js';
import { DualOutputBridge } from './dualOutput/DualOutputBridge.js';
import { DualOutputContext } from './dualOutput/DualOutputContext.js';
import { RemoteInputWatcher } from './remoteInput/RemoteInputWatcher.js';
import { RemoteInputContext } from './remoteInput/RemoteInputContext.js';
import { installTerminalRedrawOptimizer } from './ui/utils/terminalRedrawOptimizer.js';
import { installSynchronizedOutput } from './ui/utils/synchronizedOutput.js';

const debugLogger = createDebugLogger('STARTUP');

function clearCorruptionEnvVars(): void {
  delete process.env[ENV_CORRUPTED_PATH];
  delete process.env[ENV_WAS_RECOVERED];
}

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
  // We don't want to throw here, just warn and use the default.
  writeStderrLine(
    `Invalid value for dnsResolutionOrder in settings: "${order}". Using default "${defaultValue}".`,
  );
  return defaultValue;
}

function getNodeMemoryArgs(isDebugMode: boolean): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (isDebugMode) {
    writeStderrLine(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env['QWEN_CODE_NO_RELAUNCH']) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (isDebugMode) {
      writeStderrLine(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

import { loadSandboxConfig } from './config/sandboxConfig.js';
import { runAcpAgent } from './acp-integration/acpAgent.js';

export function setupUnhandledRejectionHandler() {
  let unhandledRejectionOccurred = false;
  process.on('unhandledRejection', (reason, _promise) => {
    const errorMessage = `=========================================
This is an unexpected error. Please file a bug report using the /bug tool.
CRITICAL: Unhandled Promise Rejection!
=========================================
Reason: ${reason}${
      reason instanceof Error && reason.stack
        ? `
Stack trace:
${reason.stack}`
        : ''
    }`;
    appEvents.emit(AppEvent.LogError, errorMessage);
    if (!unhandledRejectionOccurred) {
      unhandledRejectionOccurred = true;
      appEvents.emit(AppEvent.OpenDebugConsole);
    }
  });
}

function getSignalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function installInteractiveSignalHandlers(wasRaw: boolean): () => void {
  let cleanupStarted = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw);
    }

    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;

    void runExitCleanup()
      .catch((error) => {
        debugLogger.error(`Error during ${signal} cleanup:`, error);
      })
      .finally(() => {
        process.exit(getSignalExitCode(signal));
      });
  };

  const handleSigterm = () => {
    handleSignal('SIGTERM');
  };
  const handleSigint = () => {
    handleSignal('SIGINT');
  };

  process.once('SIGTERM', handleSigterm);
  process.once('SIGINT', handleSigint);

  return () => {
    process.removeListener('SIGTERM', handleSigterm);
    process.removeListener('SIGINT', handleSigint);
  };
}

export async function startInteractiveUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string = process.cwd(),
  initializationResult: InitializationResult,
) {
  const version = await getCliVersion();
  setWindowTitle(settings, basename(workspaceRoot));

  // Write a small runtime.json sidecar next to the chat log so external
  // tools (terminal multiplexers, IDE integrations, status daemons) can
  // map the running PID back to its session id and work directory.
  // Best-effort: a read-only filesystem must not prevent the UI from
  // starting up. Marking the runtime status as enabled is what arms the
  // session-swap refresh in `Config.refreshSessionId()` — without this
  // call, the sidecar would never update on `/clear` or `/resume`.
  try {
    const sessionId = config.getSessionId();
    const runtimeStatusPath = config.storage.getRuntimeStatusPath(sessionId);
    await writeRuntimeStatus(runtimeStatusPath, {
      sessionId,
      workDir: config.getTargetDir(),
      qwenVersion: version,
    });
    config.markRuntimeStatusEnabled();
  } catch {
    // ignored: best-effort, never block UI startup.
  }

  const restoreTerminalRedrawOptimizer =
    process.stdout.isTTY && !config.getScreenReader()
      ? installTerminalRedrawOptimizer(process.stdout)
      : () => {};
  const restoreSynchronizedOutput =
    process.stdout.isTTY && !config.getScreenReader()
      ? installSynchronizedOutput(process.stdout)
      : () => {};

  // Create dual output bridge if --json-fd or --json-file is specified.
  // Errors are caught so a bad fd/path degrades gracefully instead of
  // preventing the TUI from launching.
  let dualOutputBridge: DualOutputBridge | null = null;
  const jsonFd = config.getJsonFd?.();
  const jsonFile = config.getJsonFile?.();
  try {
    if (jsonFd != null) {
      dualOutputBridge = new DualOutputBridge(
        config,
        { fd: jsonFd },
        { version },
      );
    } else if (jsonFile != null) {
      dualOutputBridge = new DualOutputBridge(
        config,
        { filePath: jsonFile },
        { version },
      );
    }
  } catch (err) {
    debugLogger.error('Failed to initialize dual output bridge:', err);
    writeStderrLine(
      `Warning: dual output disabled — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Create remote input watcher if --input-file is specified.
  // This enables bidirectional sync: an external process writes JSONL
  // commands to this file, and the TUI processes them as user messages.
  let remoteInputWatcher: RemoteInputWatcher | null = null;
  const inputFile = config.getInputFile?.();
  if (inputFile) {
    try {
      remoteInputWatcher = new RemoteInputWatcher(inputFile);
    } catch (err) {
      debugLogger.error('Failed to initialize remote input watcher:', err);
      writeStderrLine(
        `Warning: remote input disabled — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Drain the early-captured input exactly once, before any React rendering.
  // Must be outside any component/effect so StrictMode's mount/cleanup/remount
  // always reads from the same stable prop rather than the (now empty) module buffer.
  const initialCapturedInput = stopAndGetCapturedInput();

  // Create wrapper component to use hooks inside render
  const AppWrapper = () => {
    const kittyProtocolStatus = useKittyKeyboardProtocol();
    const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
    return (
      <RemoteInputContext.Provider value={remoteInputWatcher}>
        <DualOutputContext.Provider value={dualOutputBridge}>
          <SettingsContext.Provider value={settings}>
            <KeypressProvider
              kittyProtocolEnabled={kittyProtocolStatus.enabled}
              config={config}
              debugKeystrokeLogging={
                settings.merged.general?.debugKeystrokeLogging
              }
              pasteWorkaround={
                process.platform === 'win32' || nodeMajorVersion < 20
              }
              initialCapturedInput={initialCapturedInput}
            >
              <SessionStatsProvider sessionId={config.getSessionId()}>
                <VimModeProvider settings={settings}>
                  <AgentViewProvider config={config}>
                    <BackgroundTaskViewProvider config={config}>
                      <AppContainer
                        config={config}
                        settings={settings}
                        startupWarnings={startupWarnings}
                        version={version}
                        initializationResult={initializationResult}
                      />
                    </BackgroundTaskViewProvider>
                  </AgentViewProvider>
                </VimModeProvider>
              </SessionStatsProvider>
            </KeypressProvider>
          </SettingsContext.Provider>
        </DualOutputContext.Provider>
      </RemoteInputContext.Provider>
    );
  };

  const useVP = settings.merged.ui?.useTerminalBuffer ?? false;
  const instance = render(
    process.env['DEBUG'] ? (
      <React.StrictMode>
        <AppWrapper />
      </React.StrictMode>
    ) : (
      <AppWrapper />
    ),
    {
      exitOnCtrlC: false,
      isScreenReaderEnabled: config.getScreenReader(),
      alternateScreen: useVP,
    },
  );
  // Records the moment Ink's `render()` call has returned, which is
  // synchronous and happens before React reconciliation actually pushes
  // bytes to the terminal. We intentionally keep the legacy name
  // `first_paint` for backward compatibility with previously-collected
  // profile files; the value is best read as "render call returned"
  // rather than literal pixel paint. AppContainer's mount effect runs
  // after this — it carries the `config_initialize_*` and
  // `input_enabled` checkpoints that complete the first-screen picture.
  profileCheckpoint('first_paint');

  // Check for updates only if enableAutoUpdate is not explicitly disabled.
  // Using !== false ensures updates are enabled by default when undefined.
  if (settings.merged.general?.enableAutoUpdate !== false) {
    checkForUpdates()
      .then((info) => {
        handleAutoUpdate(info, settings, config.getProjectRoot());
      })
      .catch((err) => {
        // Silently ignore update check errors.
        debugLogger.warn(`Update check failed: ${err}`);
      });
  }

  registerCleanup(async () => {
    remoteInputWatcher?.shutdown();
    await dualOutputBridge?.shutdown();
    // Explicitly disable the Kitty keyboard protocol before unmounting Ink so
    // that the disable escape sequence is written while stdout is still fully
    // operational, preventing garbled terminal output after the app exits.
    disableKittyProtocol();
    instance.unmount();
    restoreSynchronizedOutput();
    restoreTerminalRedrawOptimizer();
  });
}

export async function main() {
  profileCheckpoint('main_entry');
  // Bridge core-package startup events (Config.initialize, MCP discovery,
  // GeminiClient.setTools) into the cli's startup profiler. Gated on
  // `isStartupProfilerEnabled()` so that when QWEN_CODE_PROFILE_STARTUP is
  // unset (the common case) every core-side `recordStartupEvent()` call
  // sees a null sink and short-circuits at the first comparison, instead
  // of going through this arrow wrapper and the profiler's own enabled
  // check.
  if (isStartupProfilerEnabled()) {
    setStartupEventSink((name, attrs) => recordStartupEvent(name, attrs));
  }
  setupUnhandledRejectionHandler();
  initializeWarningHandler();

  if (process.argv.includes('--bare')) {
    process.env[QWEN_CODE_SIMPLE_ENV_VAR] = '1';
  }

  // Run before yargs parses subcommands — handlers like `channel status`/`stop`
  // call `process.exit` before `loadSettings()` would otherwise bootstrap.
  preResolveHomeEnvOverrides();

  let argv = await parseArguments();
  profileCheckpoint('after_parse_arguments');

  if (isBareMode(argv.bare)) {
    process.env[QWEN_CODE_SIMPLE_ENV_VAR] = '1';
  }

  // Load user settings — bare mode uses minimal config, normal mode loads full.
  const settings = isBareMode(argv.bare)
    ? createMinimalSettings()
    : loadSettings();

  // Propagate corruption state to child process via env vars so
  // relaunchAppInChildProcess() doesn't lose the marker.
  if (settings.corruptedPath) {
    process.env[ENV_CORRUPTED_PATH] = settings.corruptedPath;
    process.env[ENV_WAS_RECOVERED] = settings.wasRecovered ? '1' : '0';
  }
  await cleanupCheckpoints();
  // Performance checkpoint
  profileCheckpoint('after_load_settings');

  // Emit settings warnings early so the parent process surfaces them
  // before relaunchAppInChildProcess() exits (the child has empty
  // migrationWarnings because the parent already renamed the file).
  const settingsWarnings = getSettingsWarnings(settings);
  for (const warning of settingsWarnings) {
    writeStderrLine(warning);
  }
  // Corruption notification no longer goes through migrationWarnings —
  // check corruptedPath directly to keep stderr visible in relaunch.
  if (settings.corruptedPath) {
    writeStderrLine(
      'Warning: Settings file had invalid JSON and was reset. ' +
        'A copy of the corrupted file has been saved at: ' +
        settings.corruptedPath,
    );
  }

  if (argv.listExtensions) {
    await initializeI18n(
      resolveLanguageSetting(settings.merged.general?.language as string),
    );
    await handleListExtensions();
    process.exit(0);
  }

  // Check for invalid input combinations early to prevent crashes
  if (argv.promptInteractive && !process.stdin.isTTY) {
    writeStderrLine(
      'Error: The --prompt-interactive flag cannot be used when input is piped from stdin.',
    );
    process.exit(1);
  }

  const isDebugMode = cliConfig.isDebugMode(argv);

  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced?.dnsResolutionOrder),
  );

  // Load custom themes from settings
  themeManager.loadCustomThemes(settings.merged.ui?.customThemes);

  const configuredTheme = settings.merged.ui?.theme;
  if (configuredTheme && configuredTheme !== AUTO_THEME_NAME) {
    if (!themeManager.setActiveTheme(configuredTheme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in AppContainer.tsx will handle opening the dialog.
      writeStderrLine(`Warning: Theme "${configuredTheme}" not found.`);
    }
  } else {
    // 'auto' or unset: resolve a synchronous baseline (COLORFGBG + macOS)
    // so non-interactive runs and any pre-render UI (e.g. the --resume
    // session picker) already have a sensible theme. The interactive
    // startup block refines this with an OSC 11 probe later on, which is
    // intentionally deferred to run inside the early-capture window so
    // terminal response bytes cannot leak into the TUI input.
    themeManager.setActiveTheme(AUTO_THEME_NAME);
  }

  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env['SANDBOX']) {
    const memoryArgs = settings.merged.advanced?.autoConfigureMemory
      ? getNodeMemoryArgs(isDebugMode)
      : [];
    const sandboxConfig = await loadSandboxConfig(settings.merged, argv);
    // We intentially omit the list of extensions here because extensions
    // should not impact auth or setting up the sandbox.
    // TODO(jacobr): refactor loadCliConfig so there is a minimal version
    // that only initializes enough config to enable refreshAuth or find
    // another way to decouple refreshAuth from requiring a config.

    if (sandboxConfig) {
      const partialConfig = await loadCliConfig(
        settings.merged,
        argv,
        undefined,
        [],
        // Pass separated hooks for proper source attribution
        {
          userHooks: settings.getUserHooks(),
          projectHooks: settings.getProjectHooks(),
        },
        buildDisabledSkillNamesProvider(settings),
      );

      if (!settings.merged.security?.auth?.useExternal) {
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const authType = partialConfig.getModelsConfig().getCurrentAuthType();
          // Fresh users may not have selected/persisted an authType yet.
          // In that case, defer auth prompting/selection to the main interactive flow.
          if (authType) {
            const err = validateAuthMethod(authType, partialConfig);
            if (err) {
              throw new Error(err);
            }

            await partialConfig.refreshAuth(authType);
          }
        } catch (err) {
          writeStderrLine(`Error authenticating: ${err}`);
          process.exit(1);
        }
      }
      // For stream-json and ACP modes, don't read stdin here — stdin carries
      // protocol data (not a user prompt) and should be forwarded to the sandbox
      // intact via stdio: 'inherit'.
      const inputFormat = argv.inputFormat as string | undefined;
      const isAcpMode = argv.acp || argv.experimentalAcp;
      let stdinData = '';
      if (!process.stdin.isTTY && inputFormat !== 'stream-json' && !isAcpMode) {
        stdinData = await readStdin();
      }

      // This function is a copy of the one from sandbox.ts
      // It is moved here to decouple sandbox.ts from the CLI's argument structure.
      const injectStdinIntoArgs = (
        args: string[],
        stdinData?: string,
      ): string[] => {
        const finalArgs = [...args];
        if (stdinData) {
          const promptIndex = finalArgs.findIndex(
            (arg) => arg === '--prompt' || arg === '-p',
          );
          if (promptIndex > -1 && finalArgs.length > promptIndex + 1) {
            // If there's a prompt argument, prepend stdin to it
            finalArgs[promptIndex + 1] =
              `${stdinData}\n\n${finalArgs[promptIndex + 1]}`;
          } else {
            // If there's no prompt argument, add stdin as the prompt
            finalArgs.push('--prompt', stdinData);
          }
        }
        return finalArgs;
      };

      const injectSandboxSessionIdIntoArgs = (
        args: string[],
        sessionId: string,
      ): string[] => {
        const separatorIndex = args.indexOf('--');
        const cliArgs =
          separatorIndex < 0 ? args : args.slice(0, separatorIndex);
        const hasArg = (names: string[]) =>
          cliArgs.some((arg) =>
            names.some((name) => arg === name || arg.startsWith(`${name}=`)),
          );
        if (
          hasArg(['--session-id', '--sandbox-session-id']) ||
          hasArg(['--continue', '-c']) ||
          hasArg(['--resume', '-r'])
        ) {
          return args;
        }

        const sessionArgs = ['--sandbox-session-id', sessionId];
        if (separatorIndex < 0) {
          return [...args, ...sessionArgs];
        }

        return [...cliArgs, ...sessionArgs, ...args.slice(separatorIndex)];
      };

      const sessionId = partialConfig.getSessionId();
      const sandboxArgs = sessionId
        ? injectSandboxSessionIdIntoArgs(
            injectStdinIntoArgs(process.argv, stdinData),
            sessionId,
          )
        : injectStdinIntoArgs(process.argv, stdinData);

      await relaunchOnExitCode(() =>
        start_sandbox(sandboxConfig, memoryArgs, partialConfig, sandboxArgs),
      );
      process.exit(0);
    } else {
      // Relaunch app so we always have a child process that can be internally
      // restarted if needed.
      await relaunchAppInChildProcess(memoryArgs, [], {
        afterSpawn: clearCorruptionEnvVars,
      });
    }
  }

  // When --worktree is going to chdir us into a worktree below, resolve
  // any relative-path argv fields to absolute paths now — BEFORE the
  // chdir. Otherwise downstream `fs.existsSync('./mcp.json')` calls in
  // `loadCliConfig` re-resolve against the worktree dir, where the file
  // doesn't exist. Only touches values that look like paths (mcpConfig
  // also accepts inline JSON — skip those).
  //
  // The list of fields below is hand-maintained. If you add a new
  // CLI flag that takes a relative path, register it here too,
  // otherwise --worktree silently breaks for that flag.
  if (argv.worktree !== undefined) {
    const launchCwdForPaths = process.cwd();
    const looksLikeInlineJson = (v: string): boolean => {
      const t = v.trim();
      return t.startsWith('{') || t.startsWith('[');
    };
    const resolveIfPath = (v: string | undefined): string | undefined => {
      if (typeof v !== 'string' || v.length === 0) return v;
      if (looksLikeInlineJson(v)) return v;
      return path.resolve(launchCwdForPaths, v);
    };
    argv.mcpConfig = resolveIfPath(argv.mcpConfig);
    argv.openaiLoggingDir = resolveIfPath(argv.openaiLoggingDir);
    argv.jsonFile = resolveIfPath(argv.jsonFile);
    argv.inputFile = resolveIfPath(argv.inputFile);
    argv.telemetryOutfile = resolveIfPath(argv.telemetryOutfile);
    if (Array.isArray(argv.includeDirectories)) {
      argv.includeDirectories = argv.includeDirectories.map((d) =>
        typeof d === 'string' && d.length > 0
          ? path.resolve(launchCwdForPaths, d)
          : d,
      );
    }
    // `--json-schema` accepts either an inline schema or `@<path>`. The
    // `@`-prefixed form is read from disk inside `resolveJsonSchemaArg`
    // (`packages/cli/src/config/config.ts`), AFTER chdir, so a relative
    // value would resolve against the worktree — fix the prefix path
    // here.
    if (typeof argv.jsonSchema === 'string') {
      const trimmedSchema = argv.jsonSchema.trim();
      if (trimmedSchema.startsWith('@')) {
        const rel = trimmedSchema.slice(1);
        if (rel.length > 0 && !path.isAbsolute(rel)) {
          argv.jsonSchema = '@' + path.resolve(launchCwdForPaths, rel);
        }
      }
    }
  }

  // Phase D-1: process --worktree before the resume picker so the picker
  // (which uses process.cwd() to scope its session search) finds sessions
  // saved inside the target worktree. Creates the worktree directory on
  // disk and chdirs into it; on failure we emit to stderr and exit before
  // any expensive initialization runs.
  //
  // ACP mode is exempt: the ACP host (Zed, etc.) supplies its own per-session
  // cwd, and the startup-level chdir would not propagate. Reject the
  // combination with a clear error rather than silently dropping --worktree.
  let startupWorktreeContext: StartupWorktreeContext | null = null;
  if (argv.worktree !== undefined && (argv.acp || argv.experimentalAcp)) {
    writeStderrLine(
      '--worktree cannot be combined with --acp / --experimental-acp. ' +
        'Pass the worktree path as the cwd of the ACP loadSession / newSession ' +
        'request instead.',
    );
    process.exit(1);
  }
  {
    const startupRes = await setupStartupWorktree(argv.worktree, {
      symlinkDirectories: settings.merged.worktree?.symlinkDirectories,
    });
    if (startupRes !== null) {
      if (!startupRes.ok) {
        writeStderrLine(startupRes.error);
        process.exit(1);
      }
      startupWorktreeContext = startupRes.context;
    }
  }

  // Handle --resume without a session ID, or with a custom title, by showing
  // the session picker. Set the runtime output dir early so the picker can find
  // sessions stored under a custom runtimeOutputDir (setRuntimeBaseDir is
  // idempotent and will be called again inside loadCliConfig).
  if (argv.resume !== undefined) {
    Storage.setRuntimeBaseDir(
      settings.merged.advanced?.runtimeOutputDir,
      process.cwd(),
    );

    let resolvedSessionId: string | undefined;

    if (argv.resume === '') {
      // No argument — show picker
      resolvedSessionId = await showResumeSessionPicker();
    } else if (!cliConfig.isValidSessionId(argv.resume)) {
      // Non-UUID argument — treat as custom title search
      const sessionService = new SessionService(process.cwd());
      const matches = await sessionService.findSessionsByTitle(argv.resume);
      if (matches.length === 1) {
        resolvedSessionId = matches[0].sessionId;
      } else if (matches.length > 1) {
        // Multiple matches — show picker to let user choose
        writeStderrLine(
          `Multiple sessions found with title "${argv.resume}". Please select one:`,
        );
        resolvedSessionId = await showResumeSessionPicker(
          process.cwd(),
          matches,
        );
      }
      // matches.length === 0 → resolvedSessionId stays undefined, handled below
    }

    if (resolvedSessionId !== undefined) {
      argv = { ...argv, resume: resolvedSessionId };
    } else if (argv.resume === '' || !cliConfig.isValidSessionId(argv.resume)) {
      // User cancelled the picker or no sessions found for the title
      if (argv.resume !== '') {
        writeStderrLine(`No saved session found with title "${argv.resume}".`);
        process.exit(1);
      } else {
        process.exit(0);
      }
    }
    // else: argv.resume is already a valid UUID, pass through to loadCliConfig
  }

  // We are now past the logic handling potentially launching a child process
  // to run Qwen Code. It is now safe to perform expensive initialization that
  // may have side effects.
  profileCheckpoint('after_sandbox_check');

  // Initialize output language file before config loads to ensure it's included in context
  if (!isBareMode(argv.bare)) {
    initializeLlmOutputLanguage(settings.merged.general?.outputLanguage);
  }

  {
    // Start settings file watcher (skip in bare mode)
    const settingsWatcher = isBareMode(argv.bare)
      ? undefined
      : new SettingsWatcher(settings);
    settingsWatcher?.startWatching();

    const config = await loadCliConfig(
      settings.merged,
      argv,
      process.cwd(),
      argv.extensions,
      // Pass separated hooks for proper source attribution
      {
        userHooks: settings.getUserHooks(),
        projectHooks: settings.getProjectHooks(),
      },
      buildDisabledSkillNamesProvider(settings),
      undefined,
      settingsWatcher,
    );
    profileCheckpoint('after_load_cli_config');

    // Phase D-1: persist the WorktreeSession sidecar so Phase C's restore
    // machinery on a subsequent `--resume` picks the worktree back up, and
    // capture any override of a previously-resumed session's worktree so
    // we can emit a one-shot notice on the model's first prompt.
    //
    // The notice is set BEFORE the persist attempt and AGAIN inside the
    // try block (so the override addendum can be appended on success).
    // A persist failure must NOT silently drop the notice — the cwd is
    // already switched, and the model needs to know which worktree it's
    // operating in regardless of whether the sidecar landed.
    if (startupWorktreeContext) {
      config.setPendingStartupWorktreeNotice(
        buildStartupWorktreeNotice(startupWorktreeContext),
      );
      try {
        const startupWorktreePersist = await persistStartupWorktreeSidecar(
          config,
          startupWorktreeContext,
        );
        if (startupWorktreePersist.overrodeResumedWorktree) {
          writeStderrLine(
            `--worktree overrode the resumed session's previous worktree ` +
              `"${startupWorktreePersist.overriddenSlug ?? '(unknown)'}". ` +
              `That worktree directory was left intact on disk.`,
          );
        }
        // Refresh the notice with the override addendum (if any). When
        // there is no override this is a no-op text-wise; on override it
        // gives the model the "you overrode <previous-slug>" hint. TUI
        // and headless consume this via Config.consumePendingStartupWorktreeNotice();
        // ACP is excluded above (`--worktree` × `--acp` is mutually
        // exclusive — see the mutex check earlier in this function).
        config.setPendingStartupWorktreeNotice(
          buildStartupWorktreeNotice(
            startupWorktreeContext,
            startupWorktreePersist,
          ),
        );
      } catch (error) {
        debugLogger.warn(
          `--worktree sidecar persist failed (non-fatal, notice preserved): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Persist session usage for cross-session reports (must run before
    // config.shutdown() which clears telemetry state).
    // sessionStartTime is read from uiTelemetryService so it stays correct
    // after /clear resets the session (reset() updates the internal timestamp).
    registerCleanup(() => {
      try {
        const metrics = uiTelemetryService.getMetrics();
        const hasActivity = Object.values(metrics.models).some(
          (m) => m.api.totalRequests > 0,
        );
        if (!hasActivity) return;
        persistSessionUsage({
          sessionId: config.getSessionId(),
          startTime: uiTelemetryService.getSessionStartTime(),
          endTime: new Date(),
          project: config.getProjectRoot(),
          metrics,
        });
      } catch {
        // Best-effort — don't block shutdown
      }
    });

    // Register cleanup for MCP clients as early as possible
    // This ensures MCP server subprocesses are properly terminated on exit
    registerCleanup(() => config.shutdown());

    // Startup optimization: preconnect API to warm TCP+TLS connection
    // Fires early; cost is one HEAD request even for local-only commands
    try {
      const modelsConfig = config.getModelsConfig();
      const authType = modelsConfig.getCurrentAuthType();
      const resolvedBaseUrl = modelsConfig.getGenerationConfig().baseUrl;
      const proxy = config.getProxy();
      preconnectApi(authType, { resolvedBaseUrl, proxy });
    } catch (error) {
      // If we can't get authType, skip preconnect - it's optional optimization
      debugLogger.debug(
        `Preconnect skipped due to error getting authType: ${error}`,
      );
    }

    const wasRaw = process.stdin.isRaw;
    let kittyProtocolDetectionComplete: Promise<boolean> | undefined;
    let themeAutoDetectionComplete: Promise<void> | undefined;
    if (config.isInteractive()) {
      registerCleanup(installInteractiveSignalHandlers(wasRaw));
    }
    if (config.isInteractive() && !wasRaw && process.stdin.isTTY) {
      // Set this as early as possible to avoid spurious characters from
      // input showing up in the output.
      process.stdin.setRawMode(true);

      // Startup optimization: start early input capture
      startEarlyInputCapture();
      // Ensure the stdin listener is removed on any exit path (error, signal, etc.)
      registerCleanup(() => stopAndGetCapturedInput());

      // Detect and enable Kitty keyboard protocol once at startup.
      kittyProtocolDetectionComplete = detectAndEnableKittyProtocol();

      // Auto-detect theme (OSC 11 + COLORFGBG + macOS) when the user has
      // opted into 'auto' or has not configured a theme at all. Kicked off
      // here without awaiting so the OSC 11 timeout overlaps with the
      // heavier startup work below (initializeApp, warnings) instead of
      // blocking the critical path. The synchronous baseline picked above
      // keeps the active theme valid in the meantime; this probe only
      // refines it. Running inside the early-capture window is deliberate:
      // the filter in startEarlyInputCapture absorbs the OSC 11 response
      // bytes so they cannot leak into the TUI input, even though our
      // probe attaches its own listener to parse the RGB value.
      if (!configuredTheme || configuredTheme === AUTO_THEME_NAME) {
        themeAutoDetectionComplete = themeManager
          .resolveAutoThemeAsync()
          .catch((err) => {
            debugLogger.warn('Async theme auto-detection failed:', err);
          });
      }
    }

    setMaxSizedBoxDebugging(isDebugMode);

    // Check input format early to determine initialization flow
    // In TTY mode, ignore stream-json input format to prevent process from hanging
    const inputFormat = process.stdin.isTTY
      ? InputFormat.TEXT
      : typeof config.getInputFormat === 'function'
        ? config.getInputFormat()
        : InputFormat.TEXT;

    // For stream-json mode, defer config.initialize() until after the initialize control request
    // For other modes, initialize normally
    const initializationResult = await initializeApp(config, settings);
    profileCheckpoint('after_initialize_app');

    if (config.getExperimentalZedIntegration()) {
      await runAcpAgent(config, settings, argv);
      // Clean up child processes and force exit, matching other non-interactive modes
      await runExitCleanup();
      process.exit(0);
    }

    // Background housekeeping: file-history cleanup and (future) other
    // periodic disk maintenance. Interactive-only — serve/SDK/ACP modes
    // don't create the file-history dirs this cleans, so they skip.
    // Dynamic import keeps --help / one-shot --prompt paths from loading
    // this code at all. Timers inside are .unref()'d so they never block
    // process exit.
    if (config.isInteractive()) {
      // .catch() is intentional: a dynamic-import or module-init failure
      // (theoretically near-impossible — the module has no top-level side
      // effects — but defense in depth matches the runPass try/catch in
      // scheduler.ts) becomes a swallowed log instead of an unhandled
      // promise rejection that crashes the REPL.
      void import('./utils/housekeeping/scheduler.js')
        .then((m) => m.startBackgroundHousekeeping(config, settings))
        .catch((err) => {
          debugLogger.warn('failed to start background housekeeping:', err);
        });
    }

    let input = config.getQuestion();
    const startupWarnings = [
      ...new Set([
        ...(await getStartupWarnings()),
        ...(await getUserStartupWarnings({
          workspaceRoot: process.cwd(),
          useRipgrep: settings.merged.tools?.useRipgrep ?? true,
          useBuiltinRipgrep: settings.merged.tools?.useBuiltinRipgrep ?? true,
        })),
        ...getSettingsWarnings(settings),
        ...config.getWarnings(),
        ...(config.getModelsConfig().getCurrentAuthType() ===
        AuthType.QWEN_OAUTH
          ? [
              'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan or another provider.',
            ]
          : []),
      ]),
    ];
    const emittedStartupWarnings = new Set(startupWarnings);

    // Surface critical startup warnings (corrupted settings, recovery, etc.)
    // to stderr so they are visible regardless of UI mode. In interactive
    // mode the TUI's Notifications component also renders them, but the
    // onboarding flow can obscure the notification area, leaving users
    // unaware that their settings were reset. Writing to stderr before
    // the TUI takes over ensures the message is visible in the terminal
    // scrollback. In non-interactive mode this is the *only* channel.
    for (const warning of startupWarnings) {
      writeStderrLine(warning);
    }

    // Render UI, passing necessary config values. Check that there is no command line question.
    profileCheckpoint('before_render');

    if (config.isInteractive()) {
      // --json-schema is a headless-only contract: the synthetic
      // structured_output tool only terminates the run inside
      // runNonInteractive's main/drain loops. In TUI mode the same call
      // would just emit "Structured output accepted." and keep the chat
      // alive, which silently strands the user's run. Parse-time gating
      // can't catch this case (`qwen --json-schema '...'` on a TTY with
      // no prompt routes to interactive only after stdin TTY detection),
      // so reject here before the UI launches.
      if (config.getJsonSchema?.()) {
        writeStderrLine(
          'Error: --json-schema is a headless-only flag. Provide a one-shot prompt via -p / --prompt or pipe one in via stdin.',
        );
        // Run cleanup so MCP subprocesses + telemetry exporters that the
        // earlier initializeApp() / loadCliConfig() registered get shut
        // down — process.exit() doesn't drain them on its own.
        await runExitCleanup();
        process.exit(1);
      }
      // For the interactive path, the profile is finalized by AppContainer
      // after `config.initialize()` and `input_enabled` are recorded — that's
      // the only way `first_paint`, `config_initialize_*`, `input_enabled`,
      // and the MCP events are captured. See AppContainer's mount effect.
      setInteractiveMode(true);
      // Need kitty detection to be complete before we can start the interactive UI.
      await kittyProtocolDetectionComplete;
      // Drain the auto-theme probe before render so the OSC 11 response is
      // absorbed by the early-capture filter (which is closed inside
      // startInteractiveUI) and so the first paint uses the refined theme
      // when the probe finishes in time.
      await themeAutoDetectionComplete;
      await startInteractiveUI(
        config,
        settings,
        startupWarnings,
        process.cwd(),
        initializationResult!,
      );
      // Clean up corruption env vars so subsequent relaunch children
      // and subprocesses don't inherit stale state.
      clearCorruptionEnvVars();
      return;
    }

    // Also clean up env vars for non-interactive paths so that
    // subprocesses don't inherit stale state.
    clearCorruptionEnvVars();

    // Non-interactive: defer finalize until after `config.initialize()` runs
    // so MCP discovery events (mcp_first_tool_registered, mcp_all_servers_settled,
    // gemini_tools_updated) are captured in the profile.

    // Print debug mode notice to stderr for non-interactive mode
    if (config.getDebugMode()) {
      writeStderrLine('Debug mode enabled');
      writeStderrLine(
        `Logging to: ${Storage.getDebugLogPath(config.getSessionId())}`,
      );
      if (isDebugLoggingDegraded()) {
        writeStderrLine(
          'Warning: Debug logging is degraded (write failures occurred)',
        );
      }
    }

    // Headless + YOLO without a sandbox lets the model auto-approve and
    // execute shell / write / edit tools at the current process's
    // privilege level. Emit a one-line stderr warning so unattended runs
    // have at least an observable signal. Interactive runs are excluded
    // because the user is at the keyboard and the TUI shows approval
    // state directly. See issue #4103.
    if (!config.isInteractive()) {
      const yoloWarning = getHeadlessYoloSafetyWarning(config);
      if (yoloWarning) writeStderrLine(yoloWarning);
    }

    // For non-stream-json mode, initialize config here. Stream-json defers
    // `config.initialize()` to inside `Session.ensureConfigInitialized`
    // because the initial control_request may register SDK MCP servers
    // that must be in place before discovery runs (see session.ts).
    if (inputFormat !== InputFormat.STREAM_JSON) {
      profileCheckpoint('config_initialize_start');
      await config.initialize();
      for (const warning of config.getWarnings()) {
        if (emittedStartupWarnings.has(warning)) continue;
        emittedStartupWarnings.add(warning);
        writeStderrLine(warning);
      }
      profileCheckpoint('config_initialize_end');

      // Non-interactive paths feed a prompt to the model immediately after
      // init. Under PR-A's progressive MCP availability,
      // `config.initialize()` returns BEFORE MCP servers settle, so
      // without this wait the first sendMessage would see only built-in
      // tools — a silent regression versus the legacy synchronous
      // behavior. Interactive paths skip this (AppContainer's batch-flush
      // subscriber updates the tool list as MCP servers come online).
      await config.waitForMcpReady();
      // Surface MCP server failures on stderr so non-interactive runs
      // (--prompt / piped stdin / scripts) don't silently regress to
      // built-in-tools-only when a server cannot connect. The legacy
      // synchronous MCP path was visibly noisy on failures because
      // per-server errors logged to stderr during the blocking
      // `discoverAllMcpTools` call; PR-A moves discovery to a
      // background promise whose per-server errors are caught inside
      // `discoverAllMcpToolsIncremental` and never reach a TTY. This
      // helper closes that gap without re-introducing blocking.
      // Defensive against tests that pass a stubbed Config without
      // `getFailedMcpServerNames` — the warning is best-effort visibility
      // and never gates startup.
      const failedMcpServers =
        typeof config.getFailedMcpServerNames === 'function'
          ? config.getFailedMcpServerNames()
          : [];
      if (failedMcpServers.length > 0) {
        writeStderrLine(
          `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
            `Continuing with built-in tools and any servers that did connect. ` +
            `Re-run with QWEN_CODE_DEBUG=1 to see per-server reasons.`,
        );
      }
      // Finalize the non-interactive startup profile here so MCP events
      // emitted during initialize() / waitForMcpReady() are captured.
      // Subsequent stdin reads / auth checks / prompt execution are not
      // part of the "first-screen" budget.
      //
      // For stream-json we deliberately do NOT finalize here: the profile
      // is finalized inside Session.ensureConfigInitialized() after MCP
      // settles, so its `config_initialize_*` and MCP events make it into
      // the file. Finalizing here would write an empty profile and the
      // module-level `finalized` guard would suppress every subsequent
      // event.
      finalizeStartupProfile(config.getSessionId());
    }

    // Only read stdin if NOT in stream-json mode
    // In stream-json mode, stdin is used for protocol messages (control requests, etc.)
    // and should be consumed by StreamJsonInputReader instead
    if (inputFormat !== InputFormat.STREAM_JSON && !process.stdin.isTTY) {
      const stdinData = await readStdin();
      if (stdinData) {
        input = `${stdinData}\n\n${input}`;
      }
    }

    const nonInteractiveConfig = await validateNonInteractiveAuth(
      settings.merged.security?.auth?.useExternal,
      config,
      settings,
    );

    const prompt_id = createNonInteractivePromptId(config.getSessionId());

    if (inputFormat === InputFormat.STREAM_JSON) {
      const trimmedInput = (input ?? '').trim();

      await runNonInteractiveStreamJson(
        nonInteractiveConfig,
        trimmedInput.length > 0 ? trimmedInput : '',
        settings,
      );
      await runExitCleanup();
      // `runNonInteractiveStreamJson` doesn't return an explicit exit
      // code yet, so a cleanup task that mutates `process.exitCode`
      // could clobber a non-zero failure signal. This is currently safe
      // because `--json-schema` is rejected at parse time when combined
      // with `--input-format stream-json` (see the yargs `.check` in
      // resolveCliGenerationConfig), so structured-output failures
      // never reach this branch. If a future stream-json equivalent of
      // structured output is added, plumb the exit code through the
      // function's return value the way `runNonInteractive` below does.
      process.exit(process.exitCode ?? 0);
    }

    if (!input) {
      writeStderrLine(
        `No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.`,
      );
      process.exit(1);
    }

    logUserPrompt(config, {
      'event.name': 'user_prompt',
      'event.timestamp': new Date().toISOString(),
      prompt: input,
      prompt_id,
      auth_type: config.getContentGeneratorConfig()?.authType,
      prompt_length: input.length,
    });

    debugLogger.debug(`Session ID: ${config.getSessionId()}`);

    const exitCode = await runNonInteractive(
      nonInteractiveConfig,
      settings,
      input,
      prompt_id,
    );
    // Call cleanup before process.exit, which causes cleanup to not run.
    // Capture the exit code BEFORE cleanup so any cleanup task that
    // mutates process.exitCode can't silently turn a structured-output
    // failure (or other explicit non-zero return from runNonInteractive)
    // into a zero exit.
    await runExitCleanup();
    process.exit(exitCode);
  }
}

export function createNonInteractivePromptId(sessionId: string): string {
  return `${sessionId}########0`;
}

function setWindowTitle(settings: LoadedSettings, folderName?: string) {
  if (
    settings.merged.ui?.hideWindowTitle ||
    settings.merged.ui?.showStatusInTitle === false
  ) {
    return;
  }
  const windowTitle = computeWindowTitle(folderName);
  writeTerminalTitle((value) => process.stdout.write(value), windowTitle);

  process.on('exit', () => {
    try {
      writeTerminalTitle((value) => process.stdout.write(value), '');
    } catch {
      // Best-effort: clearing the title during exit must not produce
      // a visible error (e.g. EPIPE if stdout is already closed).
    }
  });
}
