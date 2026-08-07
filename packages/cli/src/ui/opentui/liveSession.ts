/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-client wiring (P1d): builds a real agent-loop event source from a
 * qwen-code `Config` and maps it onto the neutral `StreamEvent` so the OpenTUI
 * backend renders a LIVE conversation (requires valid API credentials at run
 * time). Without credentials this throws and callers fall back to
 * resume/scripted modes.
 *
 * Experimental: part of PR #8677; the legacy ink TUI remains the default until
 * feature parity + regression are complete.
 */

import type { Config } from '../../../core/src/config/config.js';
import { createEventMapper } from './eventAdapter.js';
import type { StreamEvent } from '../model/streamingModel.js';

/**
 * Sends one user prompt through the real client and yields neutral events.
 * The caller (backend) drains this into the streaming model.
 */
export async function* livePromptEvents(
  config: Config,
  prompt: string,
): AsyncGenerator<StreamEvent> {
  await config.initialize();
  const client = config.getGeminiClient();
  const signal = new AbortController().signal;
  const promptId = `opentui-${Date.now()}`;
  const map = createEventMapper();
  const stream = client.sendMessageStream(prompt, signal, promptId);
  for await (const ev of stream) {
    for (const neutral of map(ev)) yield neutral;
  }
}
