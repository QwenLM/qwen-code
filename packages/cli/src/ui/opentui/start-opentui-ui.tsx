/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI entry wiring (Batch 6) — the opentui-side peer of
 * `startInteractiveUI.tsx`. llm.tsx calls this only after
 * `selectTuiRenderer()` picked opentui; returning `false` here (the renderer
 * failed to initialize) falls back to ink, which stays the default renderer.
 *
 * Owns everything the shell names as entry seams: the native renderer
 * lifecycle, the runtime sidecar, the live model turn, tool/shell/action
 * confirmation delivery, the two-press exit guard, the update-notification
 * wiring, startup-warning and resume replay, and the exit-echo cleanup chain
 * (render-error echo + resume hint, ink parity).
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
// Must evaluate before '@opentui/core': the asset-root side effect has to be
// in place before @opentui/core's module evaluation resolves the native
// library path (see opentui-assets.ts).
import './opentui-assets.js';
import {
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { PartListUnion } from '@google/genai';
import {
  createDebugLogger,
  isDebugLogFileEnabled,
  registerSession,
  SessionEndReason,
  ToolConfirmationOutcome,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { isValidSessionId } from '../../config/config.js';
import type { InitializationResult } from '../../core/initializer.js';
import type { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import { registerCleanup } from '../../utils/cleanup.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { profileCheckpoint } from '../../utils/startupProfiler.js';
import { startPostRenderPrefetches } from '../../startup/startup-prefetch.js';
import {
  computeWindowTitle,
  writeTerminalTitle,
} from '../utils/windowTitle.js';
import { getCliVersion } from '../../utils/version.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';
import { t } from '../../i18n/index.js';
import {
  SessionStatsProvider,
  useSessionStats,
} from '../contexts/SessionContext.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import { setUpdateHandler } from '../handleAutoUpdate.js';
import { useLogger } from '../hooks/useLogger.js';
import type { UpdateObject } from '../utils/updateCheck.js';
import { OpenTuiApp } from './opentui-app-shell.js';
import { OpenTuiRuntime } from './opentui-runtime.js';
import { OpenTuiTranscriptView } from './transcript-view.js';
import { useOpenTuiLiveTurn, type OpenTuiSubmitOptions } from './live-turn.js';
import { consumeLastRenderError } from './opentui-error-boundary.js';
import { createExitGuard, exitGuardHint } from './exit-guard.js';
import { EXIT_CODE_INTERRUPT, exitSession } from './exit-lifecycle.js';
import { resumeEventsFromConfig } from './resume-session.js';
import {
  drainCapturedInputAsText,
  injectCapturedInput,
} from './early-input.js';

const debugLogger = createDebugLogger('OPEN_TUI_START');

export interface StartOpenTuiUIOptions {
  postRenderConnectIde?: boolean;
  postRenderInitializeTelemetry?: boolean;
  extensionRefreshState?: ExtensionRefreshState;
}

interface OpenTuiEntryAppProps {
  config: Config;
  settings: LoadedSettings;
  runtime: OpenTuiRuntime;
  startupWarnings: readonly string[];
  extensionRefreshState?: ExtensionRefreshState;
  /** Decoded early-captured keystrokes; injected into the composer once. */
  capturedText: string;
}

function OpenTuiEntryApp({
  config,
  settings,
  runtime,
  startupWarnings,
  extensionRefreshState,
  capturedText,
}: OpenTuiEntryAppProps) {
  const { width, height } = useTerminalDimensions();
  const { stats, startNewSession } = useSessionStats();
  const logger = useLogger(config.storage, config.getSessionId());
  const live = useOpenTuiLiveTurn({ config });
  const { applyEvent, submit, interrupt, resetTranscript, settleWaitingCall } =
    live;

  const statsRef = useRef(stats);
  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);
  const getSessionStats = useCallback(() => statsRef.current, []);

  // --- early-input injection (ink initialCapturedInput parity) -------------
  const composerHandle = useRef<{
    getText: () => string;
    setText: (text: string) => void;
  } | null>(null);
  useEffect(
    () => injectCapturedInput(() => composerHandle.current, capturedText),
    [capturedText],
  );

  // --- startup warnings + resume replay --------------------------------------
  useEffect(() => {
    const resumeEvents = resumeEventsFromConfig(config);
    if (resumeEvents) resetTranscript(resumeEvents);
    for (const warning of startupWarnings) {
      applyEvent({ type: 'warning', text: warning });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- update-notification wiring (ink AppContainer parity) -----------------
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const isIdleRef = useRef(true);
  useEffect(() => {
    isIdleRef.current = !live.streaming;
  }, [live.streaming]);
  const addUpdateItem = useCallback(
    (item: HistoryItemWithoutId) => {
      if (item.type === MessageType.INFO) {
        applyEvent({ type: 'info', text: item.text });
      } else if (item.type === MessageType.WARNING) {
        applyEvent({ type: 'warning', text: item.text });
      } else if (item.type === MessageType.ERROR) {
        applyEvent({ type: 'error', text: item.text });
      }
    },
    [applyEvent],
  );
  const setUpdateInfo = useCallback((info: UpdateObject | null) => {
    setUpdateNotice(info?.message ?? null);
  }, []);
  useEffect(() => {
    const { cleanup } = setUpdateHandler(
      addUpdateItem,
      setUpdateInfo,
      isIdleRef,
    );
    return cleanup;
  }, [addUpdateItem, setUpdateInfo]);

  // --- two-press exit guard (ink useDoublePress parity) ---------------------
  const [exitHint, setExitHint] = useState<string | null>(null);
  const exitGuard = useMemo(
    () => createExitGuard({ onWindowExpired: () => setExitHint(null) }),
    [],
  );
  useEffect(() => () => exitGuard.dispose(), [exitGuard]);
  const streamingRef = useRef(live.streaming);
  useEffect(() => {
    streamingRef.current = live.streaming;
  }, [live.streaming]);
  const waitingCallsRef = useRef(live.waitingCalls);
  useEffect(() => {
    waitingCallsRef.current = live.waitingCalls;
  }, [live.waitingCalls]);
  useKeyboard((key: KeyEvent) => {
    if (!key.ctrl || (key.name !== 'c' && key.name !== 'd')) return;
    // ink handleExit cascade parity: a parked confirmation closes first
    // (settled as Cancel), then an in-flight turn interrupts, and only a
    // fully idle session arms the two-press exit window.
    const parked = waitingCallsRef.current[0];
    if (parked) {
      void parked.confirmationDetails
        .onConfirm(ToolConfirmationOutcome.Cancel)
        .catch(() => {});
      settleWaitingCall(parked.callId);
      return;
    }
    if (streamingRef.current) {
      interrupt();
      return;
    }
    const guardKey = key.name === 'd' ? 'ctrl-d' : 'ctrl-c';
    if (exitGuard.press(guardKey) === 'exit') {
      void exitSession(config, EXIT_CODE_INTERRUPT);
    } else {
      setExitHint(exitGuardHint(guardKey));
    }
  });

  // --- seams handed to the shell ---------------------------------------------
  const renderMain = useCallback(
    () => (
      <box flexDirection="column" flexGrow={1}>
        <OpenTuiTranscriptView
          items={live.items}
          availableWidth={width}
          availableTerminalHeight={height}
        />
        {exitHint ? <text>{exitHint}</text> : null}
      </box>
    ),
    [live.items, width, height, exitHint],
  );

  const handleRenderError = useCallback(
    (error: Error) => {
      debugLogger.error(
        `[FATAL_RENDER_ERROR] ${error.message}\n${error.stack ?? ''}`,
      );
      // ink parity: the fallback unmounted the composer and Ctrl+C handling;
      // schedule a graceful exit so the session cannot hang.
      setTimeout(() => {
        void exitSession(config, 1);
      }, 5000);
    },
    [config],
  );

  const handleStartNewSession = useCallback(
    (sessionId: string) => startNewSession(sessionId),
    [startNewSession],
  );

  const handleSubmitPrompt = useCallback(
    (
      content: PartListUnion,
      imagePaths?: readonly string[],
      options?: OpenTuiSubmitOptions,
    ) => submit(content, imagePaths, options),
    [submit],
  );

  const handleQuit = useCallback(() => {
    void exitSession(config, 0);
  }, [config]);

  return (
    <OpenTuiApp
      config={config}
      settings={settings}
      logger={logger}
      getSessionStats={getSessionStats}
      runtime={runtime}
      extensionRefreshState={extensionRefreshState}
      renderMain={renderMain}
      onSubmitPrompt={handleSubmitPrompt}
      onQuit={handleQuit}
      onTranscriptReset={resetTranscript}
      onTranscriptEvent={applyEvent}
      onStartNewSession={handleStartNewSession}
      updateNotice={updateNotice}
      availableTerminalHeight={height}
      streaming={live.streaming}
      onInterrupt={interrupt}
      approvalMode={config.getApprovalMode()}
      queueLength={live.queueLength}
      onPopQueue={live.popQueue}
      waitingToolCalls={live.waitingCalls}
      onToolCallSettled={live.settleWaitingCall}
      onRenderError={handleRenderError}
      composerHandle={composerHandle}
    />
  );
}

/**
 * Boots the OpenTUI backend. Returns `false` when the OpenTUI boot cannot
 * complete (renderer creation, runtime sidecar, or first render) so the
 * caller falls back to ink — startup must never die here.
 */
export async function startOpenTuiUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string = process.cwd(),
  _initializationResult: InitializationResult,
  options: StartOpenTuiUIOptions = {},
): Promise<boolean> {
  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  } catch (err) {
    debugLogger.error('OpenTUI renderer initialization failed:', err);
    writeStderrLine(
      `Warning: OpenTUI renderer unavailable — ${err instanceof Error ? err.message : String(err)} (falling back to ink)`,
    );
    return false;
  }

  // Everything past renderer creation is also fallible (sidecar I/O, render,
  // prefetch wiring); a rejection must tear the renderer down and fall back
  // to ink instead of crashing the process (B2).
  const root = createRoot(renderer);
  let runtime: OpenTuiRuntime | null = null;
  try {
    const version = await getCliVersion();
    if (
      !settings.merged.ui?.hideWindowTitle &&
      settings.merged.ui?.showStatusInTitle !== false
    ) {
      writeTerminalTitle(
        (value) => process.stdout.write(value),
        computeWindowTitle(basename(workspaceRoot)),
      );
    }

    runtime = OpenTuiRuntime.create({ config, version });
    await runtime.writeRuntimeSidecar();
    runtime.startPressureMonitor();

    // Drain the early-captured input exactly once, before the renderer takes
    // over stdin; the decoded text is injected into the composer after mount.
    const capturedText = drainCapturedInputAsText();

    root.render(
      // children must sit in the props object: the provider declares it as a
      // required prop, which createElement's rest-children overloads can't fill.
      // eslint-disable-next-line react/no-children-prop
      createElement(SessionStatsProvider, {
        sessionId: config.getSessionId(),
        children: (
          <OpenTuiEntryApp
            config={config}
            settings={settings}
            runtime={runtime}
            startupWarnings={startupWarnings}
            extensionRefreshState={options.extensionRefreshState}
            capturedText={capturedText}
          />
        ),
      }),
    );
    profileCheckpoint('first_paint');

    startPostRenderPrefetches(config, settings, {
      connectIde: options.postRenderConnectIde ?? false,
      initializeTelemetry:
        options.postRenderInitializeTelemetry ??
        config.isTelemetryInitializationDeferred(),
    });

    registerCleanup(async () => {
      root.unmount();
      renderer.destroy();
      await runtime!.shutdown();
      // If the error boundary caught a render crash, echo it now that the
      // renderer is torn down (ink startInteractiveUI parity).
      const renderError = consumeLastRenderError();
      if (renderError) {
        const loggedHint = isDebugLogFileEnabled()
          ? ' (logged to debug file)'
          : '';
        writeStderrLine(
          `\nRendering error${loggedHint}: ${sanitizeTerminalText(renderError.message)}`,
        );
      }
      // The resume hint survives exit only on the main screen; the alt-screen
      // transcript is discarded with the renderer. Mirrors the ink echo,
      // including the sessionId-shape and non-empty-transcript gates.
      try {
        if (process.stdout.isTTY && config.getChatRecordingService()) {
          const sessionId = config.getSessionId();
          const sessionFile = config.getTranscriptPath();
          if (
            isValidSessionId(sessionId) &&
            (await stat(sessionFile)).size > 0
          ) {
            writeStdoutLine(
              `\n${t('To continue this session, run')}\nqwen --resume ${sessionId}`,
            );
          }
        }
      } catch {
        // Best-effort: a hint must never block or break exit.
      }
    });

    // SessionEnd hook parity (ink AppContainer registers the same cleanup):
    // user-configured SessionEnd hooks must fire on exit from this entry too.
    registerCleanup(async () => {
      try {
        await config
          .getHookSystem()
          ?.fireSessionEndEvent(SessionEndReason.PromptInputExit);
      } catch (err) {
        debugLogger.error(`SessionEnd hook failed: ${err}`);
      }
    });

    // Announce this session only after the teardown cleanup above is armed
    // (ink startInteractiveUI ordering).
    config.trackSessionRegistration(
      registerSession({
        sessionId: config.getSessionId(),
        cwd: config.getTargetDir(),
        qwenVersion: version,
      }),
    );
    registerCleanup(() => config.unregisterSessionRegistry());

    return true;
  } catch (err) {
    debugLogger.error('OpenTUI startup failed; falling back to ink:', err);
    writeStderrLine(
      `Warning: OpenTUI startup failed — ${err instanceof Error ? err.message : String(err)} (falling back to ink)`,
    );
    try {
      root.unmount();
      renderer.destroy();
      if (runtime) await runtime.shutdown();
    } catch {
      // Best-effort teardown; ink takes over from here.
    }
    return false;
  }
}
