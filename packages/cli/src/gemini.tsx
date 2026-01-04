/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, AuthType } from '@qwen-code/qwen-code-core';
import { InputFormat, logUserPrompt } from '@qwen-code/qwen-code-core';
import { render } from 'ink';
import dns from 'node:dns';
import os from 'node:os';
import { basename } from 'node:path';
import v8 from 'node:v8';
import React from 'react';
import { validateAuthMethod } from './config/auth.js';
import * as cliConfig from './config/config.js';
import { loadCliConfig, parseArguments } from './config/config.js';
import { ExtensionStorage, loadExtensions } from './config/extension.js';
import type { DnsResolutionOrder, LoadedSettings } from './config/settings.js';
import { loadSettings, migrateDeprecatedSettings } from './config/settings.js';
import {
  initializeApp,
  type InitializationResult,
} from './core/initializer.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import { runNonInteractiveStreamJson } from './nonInteractive/session.js';
import { AppContainer } from './ui/AppContainer.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { KeypressProvider } from './ui/contexts/KeypressContext.js';
import { SessionStatsProvider } from './ui/contexts/SessionContext.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';
import { VimModeProvider } from './ui/contexts/VimModeContext.js';
import { useKittyKeyboardProtocol } from './ui/hooks/useKittyKeyboardProtocol.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { detectAndEnableKittyProtocol } from './ui/utils/kittyProtocolDetector.js';
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
  relaunchAppInChildProcess,
  relaunchOnExitCode,
} from './utils/relaunch.js';
import { start_sandbox } from './utils/sandbox.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { getCliVersion } from './utils/version.js';
import { computeWindowTitle } from './utils/windowTitle.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { showResumeSessionPicker } from './ui/components/StandaloneSessionPicker.js';

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
  console.warn(
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
    console.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env['QWEN_CODE_NO_RELAUNCH']) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (isDebugMode) {
      console.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

import { ExtensionEnablementManager } from './config/extensions/extensionEnablement.js';
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

export async function startInteractiveUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string = process.cwd(),
  initializationResult: InitializationResult,
) {
  const version = await getCliVersion();
  setWindowTitle(basename(workspaceRoot), settings);

  // Create wrapper component to use hooks inside render
  const AppWrapper = () => {
    const kittyProtocolStatus = useKittyKeyboardProtocol();
    const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
    return (
      <SettingsContext.Provider value={settings}>
        <KeypressProvider
          kittyProtocolEnabled={kittyProtocolStatus.enabled}
          config={config}
          debugKeystrokeLogging={settings.merged.general?.debugKeystrokeLogging}
          pasteWorkaround={
            process.platform === 'win32' || nodeMajorVersion < 20
          }
        >
          <SessionStatsProvider sessionId={config.getSessionId()}>
            <VimModeProvider settings={settings}>
              <AppContainer
                config={config}
                settings={settings}
                startupWarnings={startupWarnings}
                version={version}
                initializationResult={initializationResult}
              />
            </VimModeProvider>
          </SessionStatsProvider>
        </KeypressProvider>
      </SettingsContext.Provider>
    );
  };

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
    },
  );

  if (!settings.merged.general?.disableUpdateNag) {
    checkForUpdates()
      .then((info) => {
        handleAutoUpdate(info, settings, config.getProjectRoot());
      })
      .catch((err) => {
        // Silently ignore update check errors.
        if (config.getDebugMode()) {
          console.error('Update check failed:', err);
        }
      });
  }

  registerCleanup(() => instance.unmount());
}

export async function main() {
  setupUnhandledRejectionHandler();
  const settings = loadSettings();
  migrateDeprecatedSettings(settings);
  await cleanupCheckpoints();

  let argv = await parseArguments(settings.merged);

  // Check for invalid input combinations early to prevent crashes
  if (argv.promptInteractive && !process.stdin.isTTY) {
    console.error(
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

  if (settings.merged.ui?.theme) {
    if (!themeManager.setActiveTheme(settings.merged.ui?.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in AppContainer.tsx will handle opening the dialog.
      console.warn(`Warning: Theme "${settings.merged.ui?.theme}" not found.`);
    }
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
        [],
        new ExtensionEnablementManager(ExtensionStorage.getUserExtensionsDir()),
        argv,
      );

      if (
        settings.merged.security?.auth?.selectedType &&
        !settings.merged.security?.auth?.useExternal
      ) {
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const err = validateAuthMethod(
            settings.merged.security.auth.selectedType,
          );
          if (err) {
            throw new Error(err);
          }

          await partialConfig.refreshAuth(
            settings.merged.security.auth.selectedType,
          );
        } catch (err) {
          console.error('Error authenticating:', err);
          process.exit(1);
        }
      }
      // For stream-json mode, don't read stdin here - it should be forwarded to the sandbox
      // and consumed by StreamJsonInputReader inside the container
      const inputFormat = argv.inputFormat as string | undefined;
      let stdinData = '';
      if (!process.stdin.isTTY && inputFormat !== 'stream-json') {
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

      const sandboxArgs = injectStdinIntoArgs(process.argv, stdinData);

      await relaunchOnExitCode(() =>
        start_sandbox(sandboxConfig, memoryArgs, partialConfig, sandboxArgs),
      );
      process.exit(0);
    } else {
      // Relaunch app so we always have a child process that can be internally
      // restarted if needed.
      await relaunchAppInChildProcess(memoryArgs, []);
    }
  }

  // Handle --resume without a session ID by showing the session picker
  if (argv.resume === '') {
    const selectedSessionId = await showResumeSessionPicker();
    if (!selectedSessionId) {
      // User cancelled or no sessions available
      process.exit(0);
    }

    // Update argv with the selected session ID
    argv = { ...argv, resume: selectedSessionId };
  }

  // We are now past the logic handling potentially launching a child process
  // to run Gemini CLI. It is now safe to perform expensive initialization that
  // may have side effects.
  {
    const extensionEnablementManager = new ExtensionEnablementManager(
      ExtensionStorage.getUserExtensionsDir(),
      argv.extensions,
    );
    const extensions = loadExtensions(extensionEnablementManager);
    const config = await loadCliConfig(
      settings.merged,
      extensions,
      extensionEnablementManager,
      argv,
    );

    if (config.getListExtensions()) {
      console.log('Installed extensions:');
      for (const extension of extensions) {
        console.log(`- ${extension.config.name}`);
      }
      process.exit(0);
    }

    // Setup unified ConsolePatcher based on interactive mode
    const isInteractive = config.isInteractive();
    const consolePatcher = new ConsolePatcher({
      stderr: isInteractive,
      debugMode: isDebugMode,
    });
    consolePatcher.patch();
    registerCleanup(consolePatcher.cleanup);

    const wasRaw = process.stdin.isRaw;
    let kittyProtocolDetectionComplete: Promise<boolean> | undefined;
    if (config.isInteractive() && !wasRaw && process.stdin.isTTY) {
      // Set this as early as possible to avoid spurious characters from
      // input showing up in the output.
      process.stdin.setRawMode(true);

      // This cleanup isn't strictly needed but may help in certain situations.
      process.on('SIGTERM', () => {
        process.stdin.setRawMode(wasRaw);
      });
      process.on('SIGINT', () => {
        process.stdin.setRawMode(wasRaw);
      });

      // Detect and enable Kitty keyboard protocol once at startup.
      kittyProtocolDetectionComplete = detectAndEnableKittyProtocol();
    }

    setMaxSizedBoxDebugging(isDebugMode);

    // Check input format early to determine initialization flow
    const inputFormat =
      typeof config.getInputFormat === 'function'
        ? config.getInputFormat()
        : InputFormat.TEXT;

    // For stream-json mode, defer config.initialize() until after the initialize control request
    // For other modes, initialize normally
    let initializationResult: InitializationResult | undefined;
    if (inputFormat !== InputFormat.STREAM_JSON) {
      initializationResult = await initializeApp(config, settings);
    }

    if (config.getExperimentalZedIntegration()) {
      return runAcpAgent(config, settings, extensions, argv);
    }

    let input = config.getQuestion();
    const startupWarnings = [
      ...(await getStartupWarnings()),
      ...(await getUserStartupWarnings({
        workspaceRoot: process.cwd(),
        useRipgrep: settings.merged.tools?.useRipgrep ?? true,
        useBuiltinRipgrep: settings.merged.tools?.useBuiltinRipgrep ?? true,
      })),
    ];

    // Render UI, passing necessary config values. Check that there is no command line question.
    if (config.isInteractive()) {
      // Need kitty detection to be complete before we can start the interactive UI.
      await kittyProtocolDetectionComplete;
      await startInteractiveUI(
        config,
        settings,
        startupWarnings,
        process.cwd(),
        initializationResult!,
      );
      return;
    }

    // For non-stream-json mode, initialize config here
    if (inputFormat !== InputFormat.STREAM_JSON) {
      await config.initialize();
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
      (argv.authType as AuthType) ||
        settings.merged.security?.auth?.selectedType,
      settings.merged.security?.auth?.useExternal,
      config,
      settings,
    );

    const prompt_id = Math.random().toString(16).slice(2);

    if (inputFormat === InputFormat.STREAM_JSON) {
      const trimmedInput = (input ?? '').trim();

      await runNonInteractiveStreamJson(
        nonInteractiveConfig,
        trimmedInput.length > 0 ? trimmedInput : '',
      );
      await runExitCleanup();
      process.exit(0);
    }

    if (!input) {
      console.error(
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

    if (config.getDebugMode()) {
      console.log('Session ID: %s', config.getSessionId());
    }

    await runNonInteractive(nonInteractiveConfig, settings, input, prompt_id);
    // Call cleanup before process.exit, which causes cleanup to not run
    await runExitCleanup();
    process.exit(0);
  }
}

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.ui?.hideWindowTitle) {
    const windowTitle = computeWindowTitle(title);
    process.stdout.write(`\x1b]2;${windowTitle}\x07`);

    process.on('exit', () => {
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}
