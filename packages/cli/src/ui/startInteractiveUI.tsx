/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename } from 'node:path';
import { render } from 'ink';
import React from 'react';
import {
  createDebugLogger,
  type Config,
  writeRuntimeStatus,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { InitializationResult } from '../core/initializer.js';
import { DualOutputBridge } from '../dualOutput/DualOutputBridge.js';
import { DualOutputContext } from '../dualOutput/DualOutputContext.js';
import { RemoteInputWatcher } from '../remoteInput/RemoteInputWatcher.js';
import { RemoteInputContext } from '../remoteInput/RemoteInputContext.js';
import { AppContainer } from './AppContainer.js';
import { KeypressProvider } from './contexts/KeypressContext.js';
import { SessionStatsProvider } from './contexts/SessionContext.js';
import { SettingsContext } from './contexts/SettingsContext.js';
import { VimModeProvider } from './contexts/VimModeContext.js';
import { AgentViewProvider } from './contexts/AgentViewContext.js';
import { BackgroundTaskViewProvider } from './contexts/BackgroundTaskViewContext.js';
import { useKittyKeyboardProtocol } from './hooks/useKittyKeyboardProtocol.js';
import { checkForUpdates } from './utils/updateCheck.js';
import { disableKittyProtocol } from './utils/kittyProtocolDetector.js';
import { installTerminalRedrawOptimizer } from './utils/terminalRedrawOptimizer.js';
import { installSynchronizedOutput } from './utils/synchronizedOutput.js';
import { handleAutoUpdate } from '../utils/handleAutoUpdate.js';
import { registerCleanup } from '../utils/cleanup.js';
import { stopAndGetCapturedInput } from '../utils/earlyInputCapture.js';
import { profileCheckpoint } from '../utils/startupProfiler.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import {
  computeWindowTitle,
  writeTerminalTitle,
} from '../utils/windowTitle.js';
import { getCliVersion } from '../utils/version.js';

const debugLogger = createDebugLogger('STARTUP');

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
