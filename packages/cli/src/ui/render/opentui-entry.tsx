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

// MUST stay the first import: configures OTUI_ASSET_ROOT for bundled builds
// before '@opentui/core' evaluates its module scope (the native-library path
// is resolved once, at module load). See ../opentui/opentui-assets.ts.
import '../opentui/opentui-assets.js';

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from '../opentui/backend.js';
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
  const renderer = await createCliRenderer({
    targetFps: 60,
    useKittyKeyboard: {},
    useMouse: true,
    exitOnCtrlC: false,
    externalOutputMode: 'passthrough',
    autoFocus: true,
  });
  createRoot(renderer).render(
    <App events={opts?.events} config={opts?.config} />,
  );
}
