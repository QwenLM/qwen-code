/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Experimental OpenTUI renderer entry, loaded only when
 * `QWEN_TUI_RENDERER=opentui` (see `dispatch.ts`) — the default ink path never
 * imports this module.
 *
 * Mounts the OpenTUI chat backend (`../opentui/backend`), whose history is
 * driven by the framework-neutral streaming model (`../model/streaming-model`).
 *
 * Startup / lifecycle parity with the ink branch of `startInteractiveUI`:
 *  - writes the runtime.json sidecar + arms the session-swap refresh,
 *  - sets (and clears-on-exit) the terminal window title,
 *  - drains the early-input capture buffer and injects it into the composer,
 *  - registers the exit-cleanup drain (renderer destroy + farewell echo),
 *  - arms wake-repaint, progressive MCP discovery and post-render prefetches,
 *  - wraps the tree in an ErrorBoundary that exits through the cleanup drain.
 */

// MUST stay the first import: configures OTUI_ASSET_ROOT for bundled builds
// before '@opentui/core' evaluates its module scope (the native-library path
// is resolved once, at module load). See ../opentui/opentui-assets.ts.
import '../opentui/opentui-assets.js';

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from '../opentui/backend.js';
import { probeKittyKeyboardSupport } from '../opentui/kitty-negotiation.js';
import type { StreamEvent } from '../model/streaming-model.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { RemoteInputWatcher } from '../../remoteInput/RemoteInputWatcher.js';
import { registerCleanup } from '../../utils/cleanup.js';
import { registerOpenTuiExitCleanup } from '../opentui/opentui-exit-cleanup.js';
import { writeRuntimeSidecar } from '../opentui/runtime-sidecar.js';
import { installOpenTuiWindowTitle } from '../opentui/window-title.js';
import { drainCapturedInputAsText } from '../opentui/early-input.js';
import { startWakeRepaint } from '../opentui/wake-repaint.js';
import { startOpenTuiPostRenderPrefetches } from '../opentui/post-render.js';
import { startMcpProgressiveDiscovery } from '../opentui/mcp-progressive.js';
import { OpenTuiErrorBoundary } from '../opentui/opentui-error-boundary.js';

/**
 * @param events optional pre-adapted neutral stream (resume mode).
 * @param config when provided, the backend submits prompts to the REAL client
 *   (`liveSession`) for live conversations (requires credentials).
 * @param remoteInputWatcher when provided (--input-file), remote `submit`
 *   commands are routed into the backend like typed prompts.
 */
export interface OpenTuiStartOptions {
  /** Optional pre-adapted neutral stream (resume mode). */
  events?: AsyncIterable<StreamEvent>;
  /** When provided, the backend runs live conversations via the real client. */
  config?: Config;
  /** Remote input watcher for `--input-file`; null when not requested. */
  remoteInputWatcher?: RemoteInputWatcher | null;
  /** Loaded settings (window title, post-render prefetches, backend dialogs). */
  settings?: LoadedSettings;
  /** Post-render prefetch toggles (ink `StartInteractiveUIOptions` parity). */
  postRender?: {
    connectIde?: boolean;
    initializeTelemetry?: boolean;
  };
}

export async function startOpenTuiUI(
  opts?: OpenTuiStartOptions,
): Promise<void> {
  const { events, config, settings, postRender, remoteInputWatcher } =
    opts ?? {};

  // Drain the early-capture buffer BEFORE the renderer takes over stdin, so
  // startup keystrokes are recovered instead of leaking into the terminal.
  const initialCapturedInput = drainCapturedInputAsText();

  // runtime.json sidecar + session-swap refresh arming (best-effort).
  if (config) {
    void writeRuntimeSidecar(config);
  }

  // Terminal window title (set now, cleared on exit).
  if (settings) {
    installOpenTuiWindowTitle(settings, config);
  }

  // Headless/no-reply terminals never answer the kitty `\x1b[?u` queries the
  // framework would send, and without a fallback that left legacy keystrokes
  // entirely unprocessed (audit G-02). Probe once with a 200ms timeout first
  // (ink kittyProtocolDetector parity) and disable the protocol outright in
  // terminals that do not answer, so legacy key input always works.
  const kittySupported = await probeKittyKeyboardSupport();
  // Mouse capture honors the ui.mouseTracking setting (opencode config.mouse
  // parity, default on): off means the terminal keeps its native selection,
  // context menu, and wheel scrolling instead of the app.
  const mouseTracking = settings?.merged.ui?.mouseTracking ?? true;
  const renderer = await createCliRenderer({
    targetFps: 60,
    useKittyKeyboard: kittySupported ? {} : null,
    useMouse: mouseTracking,
    exitOnCtrlC: false,
    externalOutputMode: 'passthrough',
    autoFocus: true,
  });

  // Exit chain: destroying the renderer and echoing the farewell / resume
  // hint happen inside the shared runExitCleanup drain, so every exit path
  // (Ctrl+C/D double press, /quit, render error) runs them.
  registerOpenTuiExitCleanup({ renderer, config });

  // Repaint after sleep / SIGCONT resumes (use-wake-repaint parity).
  registerCleanup(startWakeRepaint(() => renderer.requestRender()));

  // Progressive MCP tool availability (mcp-client-update → setTools batches).
  registerCleanup(startMcpProgressiveDiscovery(config));

  createRoot(renderer).render(
    <OpenTuiErrorBoundary>
      <App
        events={events}
        config={config}
        settings={settings}
        remoteInputWatcher={remoteInputWatcher ?? undefined}
        initialCapturedInput={initialCapturedInput}
      />
    </OpenTuiErrorBoundary>,
  );

  // Post-render prefetches: update check, deferred IDE connect, deferred
  // telemetry init and background housekeeping (ink parity). Update
  // notifications are consumed inside the backend (footer/toast surface).
  if (config && settings) {
    startOpenTuiPostRenderPrefetches(config, settings, postRender ?? {});
  }
}
