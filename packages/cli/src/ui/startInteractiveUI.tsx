/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { render } from 'ink';
import React from 'react';
import {
  createDebugLogger,
  isDebugLogFileEnabled,
  type Config,
  writeRuntimeStatus,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { isValidSessionId } from '../config/config.js';
import type { InitializationResult } from '../core/initializer.js';
import type { ExtensionRefreshState } from '../config/extension-refresh-state.js';
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
import {
  disableKittyProtocol,
  pushKittyProtocolFlags,
} from './utils/kittyProtocolDetector.js';
import { installTerminalRedrawOptimizer } from './utils/terminalRedrawOptimizer.js';
import { installSynchronizedOutput } from './utils/synchronizedOutput.js';
import {
  isInteractiveTerminal,
  shouldUseVirtualViewport,
} from './utils/terminal-buffer.js';
import {
  ErrorBoundary,
  consumeLastRenderError,
} from './components/shared/ErrorBoundary.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';
import { stopAndGetCapturedInput } from '../utils/earlyInputCapture.js';
import { t } from '../i18n/index.js';
import { profileCheckpoint } from '../utils/startupProfiler.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { sanitizeTerminalText } from './utils/textUtils.js';
import { startPostRenderPrefetches } from '../startup/startup-prefetch.js';
import {
  computeWindowTitle,
  writeTerminalTitle,
} from '../utils/windowTitle.js';
import { getCliVersion } from '../utils/version.js';

const debugLogger = createDebugLogger('STARTUP');

// The tool scheduler only runs a pressure check after a tool call, so a long
// interactive conversation with no tool calls would never reclaim and could
// grow toward the V8 heap limit. This interval closes that gap.
const PRESSURE_CHECK_INTERVAL_MS = 30_000;

export interface StartInteractiveUIOptions {
  postRenderConnectIde?: boolean;
  postRenderInitializeTelemetry?: boolean;
  extensionRefreshState?: ExtensionRefreshState;
}

export async function startInteractiveUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string = process.cwd(),
  initializationResult: InitializationResult,
  options: StartInteractiveUIOptions = {},
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

  const useVP = shouldUseVirtualViewport(
    settings.merged.ui?.useTerminalBuffer,
    config.getScreenReader(),
    isInteractiveTerminal(),
  );

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
                        initialUseVirtualViewport={useVP}
                        extensionRefreshState={options.extensionRefreshState}
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

  const stdoutMaxListeners = process.stdout.getMaxListeners();
  if (useVP) {
    // Visible VP rows each subscribe to resize through Ink's useBoxMetrics.
    // Node's default warning writes into the alternate screen and shifts mouse
    // coordinates even though these listeners are owned and cleaned up.
    process.stdout.setMaxListeners(0);
  }
  const appTree = (
    <ErrorBoundary
      recordForExitEcho
      onError={(error, info) => {
        debugLogger.error(
          `[FATAL_RENDER_ERROR] ${error.message}\n${info.componentStack ?? ''}\n${error.stack ?? ''}`,
        );
        // The fallback replaces AppWrapper, unmounting KeypressProvider and
        // Ctrl+C handling. Schedule a graceful exit so the session does not
        // hang (e.g. under the Kitty keyboard protocol where Ctrl+C is a
        // keypress, not SIGINT).
        setTimeout(() => {
          void runExitCleanup().then(() => process.exit(1));
        }, 5000);
      }}
    >
      <AppWrapper />
    </ErrorBoundary>
  );
  const instance = render(
    process.env['DEBUG'] ? (
      <React.StrictMode>{appTree}</React.StrictMode>
    ) : (
      appTree
    ),
    {
      exitOnCtrlC: false,
      isScreenReaderEnabled: config.getScreenReader(),
      alternateScreen: useVP,
    },
  );
  if (useVP) {
    // Ink entered the alternate screen synchronously inside render() above.
    // The Kitty keyboard flags were pushed at startup on the main screen, and
    // the spec tracks them per screen, so re-push them onto the alternate
    // screen now — otherwise Shift+Enter (and other modified keys) arrive
    // without their modifier and degrade to a bare Enter or an orphaned Escape.
    // The push is ordered after Ink's enter-alternate-screen write, and Ink
    // discards the alternate screen (and its flag stack) on unmount, so the
    // startup main-screen push remains balanced by disableKittyProtocol() below.
    pushKittyProtocolFlags();
  }
  // Records the moment Ink's `render()` call has returned, which is
  // synchronous and happens before React reconciliation actually pushes
  // bytes to the terminal. We intentionally keep the legacy name
  // `first_paint` for backward compatibility with previously-collected
  // profile files; the value is best read as "render call returned"
  // rather than literal pixel paint. AppContainer's mount effect runs
  // after this — it carries the `config_initialize_*` and
  // `input_enabled` checkpoints that complete the first-screen picture.
  profileCheckpoint('first_paint');

  startPostRenderPrefetches(config, settings, {
    connectIde: options.postRenderConnectIde ?? false,
    initializeTelemetry:
      options.postRenderInitializeTelemetry ??
      config.isTelemetryInitializationDeferred(),
  });

  // Periodic memory-pressure check for the interactive session. The interval
  // is unref'd (can't keep the loop alive on its own) and cleared on cleanup.
  const pressureMonitor = config.getMemoryPressureMonitor?.();
  let pressureCheckTimer: NodeJS.Timeout | undefined;
  if (pressureMonitor) {
    pressureCheckTimer = setInterval(() => {
      try {
        pressureMonitor.performCheck();
      } catch {
        // Best-effort: a failing pressure check must not break the UI loop.
      }
    }, PRESSURE_CHECK_INTERVAL_MS);
    pressureCheckTimer.unref?.();
  }

  registerCleanup(async () => {
    if (pressureCheckTimer) clearInterval(pressureCheckTimer);
    // Best-effort reclaim before unmounting the React tree. Runs the
    // synchronous cache-eviction step (and schedules compact_history) so a
    // near-limit heap is not pushed over the edge by React reconciliation
    // during unmount.
    try {
      pressureMonitor?.performCheck();
    } catch {
      // Best-effort: ignore.
    }
    remoteInputWatcher?.shutdown();
    await dualOutputBridge?.shutdown();
    instance.unmount();
    // Pop the Kitty keyboard protocol only after Ink has unmounted. The
    // protocol was enabled on the main screen before render, and the kitty
    // spec tracks keyboard flags per screen: with alternateScreen enabled, a
    // pop written before unmount lands on the alternate screen's (empty)
    // stack, unmount then leaves the alternate screen, and the main screen's
    // flags stay set — the user's shell keeps receiving kitty escape codes
    // (e.g. "9;5u" on Ctrl-C) after exit.
    disableKittyProtocol();
    if (useVP) {
      process.stdout.setMaxListeners(stdoutMaxListeners);
    }
    restoreSynchronizedOutput();
    restoreTerminalRedrawOptimizer();
    // If the ErrorBoundary caught a rendering error, echo it to stderr
    // now that we are back on the main screen buffer. In VP mode the
    // fallback UI was drawn on the alternate screen and is gone.
    const renderError = consumeLastRenderError();
    if (renderError) {
      const loggedHint = isDebugLogFileEnabled()
        ? ' (logged to debug file)'
        : '';
      writeStderrLine(
        `\nRendering error${loggedHint}: ${sanitizeTerminalText(renderError.message)}`,
      );
    }
    // Same reasoning as the render-error echo above: the quit screen (with
    // its resume hint) is drawn on the alternate screen in VP mode and is
    // discarded on teardown, so echo the resume command here where it
    // survives exit and can be copied from the terminal scrollback.
    // --resume lookup is cwd-scoped, so the hint assumes it is pasted in
    // the session's working directory. Sessions keyed elsewhere share this
    // limitation with the in-TUI hint — notably --worktree startup, which
    // chdirs into the worktree while the user's shell stays at the launch
    // directory.
    try {
      if (process.stdout.isTTY && config.getChatRecordingService()) {
        const sessionId = config.getSessionId();
        const sessionFile = config.getTranscriptPath();
        // The echoed ID is paste-into-shell text, and resume reads session
        // IDs from transcript contents any user-level process can write.
        // Gate to the canonical shape `--resume` itself accepts
        // (isValidSessionId): a single token with no newlines, escapes, or
        // leading dash, which also keeps the echoed command from falling
        // through to title matching on paste. Require a non-empty
        // transcript too: the recorder creates the file before the first
        // record lands, and `--resume` refuses to load an empty one.
        // Non-emptiness here relies on config.shutdown() flushing the
        // recorder first — it is registered earlier in the cleanup chain
        // in gemini.tsx; keep that registration order.
        if (isValidSessionId(sessionId) && (await stat(sessionFile)).size > 0) {
          writeStdoutLine(
            `\n${t('To continue this session, run')}\nqwen --resume ${sessionId}`,
          );
        }
      }
    } catch {
      // Best-effort: a hint must never block or break exit.
    }
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
