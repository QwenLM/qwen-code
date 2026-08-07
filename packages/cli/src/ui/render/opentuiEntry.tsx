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
import type { StreamEvent } from '../model/streamingModel.js';

/**
 * @param events optional real agent-loop stream (already adapted to the
 *   neutral `StreamEvent` via `./eventAdapter`); when omitted the backend runs
 *   its scripted validation conversation.
 */
export async function startOpenTuiUI(opts?: {
  events?: AsyncIterable<StreamEvent>;
}): Promise<void> {
  const renderer = await createCliRenderer({
    targetFps: 60,
    useKittyKeyboard: {},
    useMouse: true,
    exitOnCtrlC: false,
    externalOutputMode: 'passthrough',
    autoFocus: true,
  });
  createRoot(renderer).render(<App events={opts?.events} />);
}
