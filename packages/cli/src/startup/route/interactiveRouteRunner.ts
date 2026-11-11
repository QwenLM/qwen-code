/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExitCodes,
  FatalInputError,
  getErrorMessage,
  OutputFormat,
  runLogger,
  sessionLogger,
  startupProfiler,
  writeToStderr,
  type Config,
} from '@qwen-code/core';
import { gracefulExit } from '../../utils/cleanup.js';
import type { ConfiguredStartupContext } from '../startupContext.js';
import type { RuntimeRouteRunnerOptions } from './runtimeRouteTypes.js';
import { enableInteractiveConfigFeatures } from '../interactiveConfig.js';
import { createStartupModelApplier } from '../applyStartupModel.js';

export async function runInteractiveRoute(
  context: ConfiguredStartupContext,
  options: RuntimeRouteRunnerOptions,
): Promise<void> {
  const { config, framework } = context;
  if (framework.mode !== 'tui') {
    throw new Error('Interactive route requires a TUI framework');
  }
  const { settings } = context.settings;
  await validateHeadlessOnlyFlagsForInteractive(context);
  if (!options.session) {
    // 初始化已由 Framework 发起；这里只观察结果，不再次启动。
    void context.framework.whenConfigReady().catch((error: unknown) => {
      runLogger.warn('[config-service] Interactive prewarm failed', {
        error: getErrorMessage(error),
      });
    });
  }
  await enableInteractiveConfigFeatures(config, {
    localSession: !options.session,
  });
  if (!options.session) {
    // -m must fail before Ink mounts; render-time startup errors are caught by
    // the Ink error boundary and leave a frozen TUI instead of exiting.
    await applyCliModelBeforeInteractive(config);
  }
  if (process.stdin.isTTY) {
    process.stdin.resume();
  }

  const loadHandle = startupProfiler.start('load_interactive_ui');
  let modules: InteractiveUIModules;
  try {
    modules = await preloadInteractiveUI();
  } finally {
    loadHandle?.end();
  }
  const { ensureYogaLoaded, startInteractiveUI } = modules;
  const yogaHandle = startupProfiler.start('ensure_yoga_loaded');
  try {
    await ensureYogaLoaded();
  } finally {
    yogaHandle?.end();
  }

  await startInteractiveUI(
    framework.getAppContainer(),
    framework.getI18nService(),
    config,
    settings,
    options.startupWarnings,
    process.cwd(),
    options.resumedSessionData,
    options.themeError,
    options.initialSessionBrowserOptions
      ? undefined
      : options.initialSessionTitle,
    options.initialSessionBrowserOptions,
    options.startupCoordinator,
    options.worktreeStartupRequest,
    options.rebuildProject,
    {
      getCliDisplayName: () => framework.displayName,
      getAppPlugins: () => framework.appPlugins!.get(),
      bindLocalSession: (session) => framework.bindLocalSession(session),
    },
    options.sessionUi,
  );
}

async function applyCliModelBeforeInteractive(config: Config): Promise<void> {
  const modelInput = config.getCliModel?.();
  if (modelInput === undefined) return;
  try {
    if (typeof config.isInitialized === 'function' && !config.isInitialized()) {
      const startupConfig = config as Config & {
        initializeForInteractiveStartup?: () => Promise<void>;
      };
      if (startupConfig.initializeForInteractiveStartup) {
        await startupConfig.initializeForInteractiveStartup();
      } else {
        await config.initialize();
      }
    }
    await createStartupModelApplier(modelInput)(config);
  } catch (error) {
    // Auth/config failures still belong to the interactive flow (login gate).
    // Only an invalid -m is a CLI input error that must block the TUI.
    if (error instanceof FatalInputError) throw error;
    runLogger.warn(
      '[startup] Could not validate the CLI model before interactive startup',
      { error: getErrorMessage(error) },
    );
  }
}

async function validateHeadlessOnlyFlagsForInteractive(
  context: ConfiguredStartupContext,
): Promise<void> {
  const { argv } = context.settings;
  const headlessOnlyFlags: string[] = [];
  if (argv.outputFormat && argv.outputFormat !== OutputFormat.TEXT) {
    headlessOnlyFlags.push(`--output-format=${argv.outputFormat}`);
  }
  if (argv.includePartialMessages) {
    headlessOnlyFlags.push('--include-partial-messages');
  }
  if (argv.replayUserMessages) {
    headlessOnlyFlags.push('--replay-user-messages');
  }
  if (argv.rawOutput) {
    headlessOnlyFlags.push('--raw-output');
  }
  if (argv.acceptRawOutputRisk) {
    headlessOnlyFlags.push('--accept-raw-output-risk');
  }
  if (argv.headlessFastHooks) {
    headlessOnlyFlags.push('--headless-fast-hooks');
  }
  if (argv.bare) {
    headlessOnlyFlags.push('--bare');
  }
  if (headlessOnlyFlags.length === 0) {
    return;
  }

  writeToStderr(
    `Error: ${headlessOnlyFlags.join(', ')} can only be used in non-interactive (headless) mode.\n` +
      'Add -p (--print) with a prompt, or pipe input via stdin.\n',
  );
  sessionLogger.setExitContext({
    reason: 'input_error',
    exit_code: ExitCodes.FATAL_INPUT_ERROR,
    message: `Headless-only flags used in interactive mode: ${headlessOnlyFlags.join(', ')}`,
    source: 'gemini.parseArgs',
  });
  return gracefulExit(ExitCodes.FATAL_INPUT_ERROR, { exitReason: 'error' });
}

type InteractiveUIModules = {
  ensureYogaLoaded: typeof import('../../ink/layout/yoga.js').ensureYogaLoaded;
  startInteractiveUI: typeof import('../../interactiveCli.js').startInteractiveUI;
};

let interactiveUIImportPromise: Promise<InteractiveUIModules> | undefined;

export function preloadInteractiveUI(): Promise<InteractiveUIModules> {
  if (!interactiveUIImportPromise) {
    const preloadHandle = startupProfiler.start('preload_interactive_ui');
    interactiveUIImportPromise = Promise.all([
      import('../../ink/layout/yoga.js'),
      import('../../interactiveCli.js'),
    ])
      .then(([yogaModule, interactiveModule]) => ({
        ensureYogaLoaded: yogaModule.ensureYogaLoaded,
        startInteractiveUI: interactiveModule.startInteractiveUI,
      }))
      .catch((error) => {
        interactiveUIImportPromise = undefined;
        throw error;
      })
      .finally(() => preloadHandle?.end());
  }
  return interactiveUIImportPromise;
}
