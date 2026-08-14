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
 * driven by the framework-neutral streaming model (`../model/streamingModel`).
 * The backend renders streaming markdown / tool cards / thinking / subagent
 * cards with first-class mouse (select+copy, click-expand, wheel scroll) on the
 * flicker-free cell-diff renderer. The real agent-loop event source replaces the
 * backend's scripted demo events in a later phase (P1d).
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from '../opentui/backend.js';
import { probeKittyKeyboardSupport } from '../opentui/kitty-negotiation.js';
import type { StreamEvent } from '../model/streamingModel.js';
import type { Config } from '@qwen-code/qwen-code-core';

/**
 * @param events optional pre-adapted neutral stream (resume mode).
 * @param config when provided, the backend submits prompts to the REAL client
 *   (`liveSession`) for live conversations (requires credentials).
 */
export async function startOpenTuiUI(opts?: {
  events?: AsyncIterable<StreamEvent>;
  config?: Config;
}): Promise<void> {
  // Headless/no-reply terminals never answer the kitty `\x1b[?u` queries the
  // framework would send, and without a fallback that left legacy keystrokes
  // entirely unprocessed (audit G-02). Probe once with a 200ms timeout first
  // (ink kittyProtocolDetector parity) and disable the protocol outright in
  // terminals that do not answer, so legacy key input always works.
  const kittySupported = await probeKittyKeyboardSupport();
  const renderer = await createCliRenderer({
    targetFps: 60,
    useKittyKeyboard: kittySupported ? {} : null,
    useMouse: true,
    exitOnCtrlC: false,
    externalOutputMode: 'passthrough',
    autoFocus: true,
  });
  createRoot(renderer).render(
    <App events={opts?.events} config={opts?.config} />,
  );
}
