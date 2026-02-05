/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
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
import type { DnsResolutionOrder, LoadedSettings } from './config/settings.js';
import { getSettingsWarnings, loadSettings } from './config/settings.js';
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
import { initializeLlmOutputLanguage } from './utils/languageUtils.js';

/**
 * Find an available port starting from the given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  const net = await import('node:net');

  return new Promise((resolve) => {
    const tryPort = (port: number) => {
      const server = net.createServer();
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
      server.on('error', () => {
        // Port is in use, try next
        tryPort(port + 1);
      });
    };
    tryPort(startPort);
  });
}

/**
 * Parse web command arguments
 */
function parseWebArgs(args: string[]): {
  port: number;
  host: string;
  open: boolean;
  dev: boolean;
} {
  const result = {
    port: 5495,
    host: '127.0.0.1',
    open: true,
    dev: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if ((arg === '--port' || arg === '-p') && nextArg) {
      const port = parseInt(nextArg, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        result.port = port;
      }
      i++;
    } else if ((arg === '--host' || arg === '-h') && nextArg) {
      result.host = nextArg;
      i++;
    } else if (arg === '--no-open') {
      result.open = false;
    } else if (arg === '--dev' || arg === '-d') {
      result.dev = true;
    } else if (arg === '--help') {
      console.log(`
Usage: qwen web [options]

Start the Qwen Code Web GUI server.

Options:
  -p, --port <port>   Port to listen on (default: 5495)
  -h, --host <host>   Host to bind to (default: 127.0.0.1)
  --no-open           Don't open browser automatically
  -d, --dev           Run in development mode with hot reload
  --help              Show this help message
`);
      process.exit(0);
    }
  }

  return result;
}

/**
 * Run the web server (qwen web subcommand)
 */
async function runWebServer(args: string[]): Promise<void> {
  const parsed = parseWebArgs(args);

  // Dev mode: use Vite dev server with HMR
  if (parsed.dev) {
    console.log('Starting Qwen Code Web GUI in development mode...\n');

    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');

    // Find web-app package directory - try multiple possible locations
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const possiblePaths = [
      path.resolve(currentDir, '../../web-app'), // From src/gemini.tsx
      path.resolve(currentDir, '../../../web-app'), // From dist/src/gemini.js
      path.resolve(currentDir, '../../../../packages/web-app'), // From nested dist
      path.resolve(process.cwd(), 'packages/web-app'), // From project root
    ];

    let webAppDir: string | null = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(path.join(p, 'package.json'))) {
        webAppDir = p;
        break;
      }
    }

    if (!webAppDir) {
      console.error('Could not find web-app package directory.');
      console.error('Tried:', possiblePaths);
      process.exit(1);
    }

    console.log(`  Web App directory: ${webAppDir}\n`);
    console.log('  Starting Vite dev server (frontend) + backend server...\n');
    console.log('  Frontend: http://localhost:5173 (with HMR)');
    console.log('  Backend:  http://localhost:5495\n');

    const child = spawn('npm', ['run', 'dev'], {
      cwd: webAppDir,
      stdio: 'inherit',
      shell: true,
    });

    child.on('error', (err) => {
      console.error('Failed to start dev server:', err.message);
      process.exit(1);
    });

    // Keep process running
    await new Promise(() => {});
    return;
  }

  // Production mode: use built assets
  console.log('Starting Qwen Code Web GUI server...');

  try {
    // Find available port
    const actualPort = await findAvailablePort(parsed.port);

    if (actualPort !== parsed.port) {
      console.log(
        `Port ${parsed.port} is in use, using port ${actualPort} instead.`,
      );
    }

    // Dynamic import of the web-app package
    const webAppModule = await import('@qwen-code/web-app');
    const { startServer } = webAppModule;

    await startServer({
      port: actualPort,
      host: parsed.host,
      config: null,
    });

    const url = `http://${parsed.host === '0.0.0.0' ? 'localhost' : parsed.host}:${actualPort}`;

    console.log(`\n  Qwen Code Web GUI running at: ${url}\n`);

    if (parsed.host === '0.0.0.0') {
      console.log(
        '  Warning: Server is accessible from the network. Use with caution.\n',
      );
    }

    if (parsed.open) {
      try {
        const open = (await import('open')).default;
        await open(url);
        console.log('  Browser opened.\n');
      } catch {
        console.log(
          `  Could not open browser automatically. Please visit ${url}\n`,
        );
      }
    }

    console.log('  Press Ctrl+C to stop the server.\n');

    // Keep the process running
    await new Promise(() => {});
  } catch (error) {
    console.error(
      'Failed to start Web GUI server:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
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

  // Check for updates only if enableAutoUpdate is not explicitly disabled.
  // Using !== false ensures updates are enabled by default when undefined.
  if (settings.merged.general?.enableAutoUpdate !== false) {
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

  // Check for 'web' subcommand early - before any complex initialization
  const args = process.argv.slice(2);
  if (args[0] === 'web') {
    await runWebServer(args.slice(1));
    return;
  }

  const settings = loadSettings();
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
        argv,
        undefined,
        [],
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

  // Initialize output language file before config loads to ensure it's included in context
  initializeLlmOutputLanguage(settings.merged.general?.outputLanguage);

  {
    const config = await loadCliConfig(
      settings.merged,
      argv,
      process.cwd(),
      argv.extensions,
    );

    // Register cleanup for MCP clients as early as possible
    // This ensures MCP server subprocesses are properly terminated on exit
    registerCleanup(() => config.shutdown());

    // FIXME: list extensions after the config initialize
    // if (config.getListExtensions()) {
    //   console.log('Installed extensions:');
    //   for (const extension of extensions) {
    //     console.log(`- ${extension.config.name}`);
    //   }
    //   process.exit(0);
    // }

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
      return runAcpAgent(config, settings, argv);
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
      ]),
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
