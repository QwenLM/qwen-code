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
 * The optional `AbortSignal` is forwarded to `client.sendMessageStream` so the
 * UI can interrupt the live stream (Esc); the generator then rejects with the
 * abort error and the caller settles the UI state.
 *
 * Experimental: part of PR #8677; the legacy ink TUI remains the default until
 * feature parity + regression are complete.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { SendMessageType } from '@qwen-code/qwen-code-core';
import type { PartListUnion } from '@google/genai';
import { createEventMapper, type OpenTuiStreamEvent } from './event-adapter.js';

/** Options the backend passes through to the live turn. */
export interface LivePromptOptions {
  /** Per-turn model override (submit_prompt's modelOverride parity). */
  modelOverride?: string;
}

/**
 * Sends one user prompt through the real client and yields neutral events.
 * The caller (backend) drains this into the streaming model.
 *
 * The prompt is forwarded as a full `PartListUnion` (string or part list,
 * multimodal parts included) — exactly what `submit_prompt` outcomes carry —
 * and an optional per-turn `modelOverride` travels through
 * `SendMessageOptions` the way useGeminiStream feeds it.
 */
export async function* livePromptEvents(
  config: Config,
  prompt: PartListUnion,
  signal?: AbortSignal,
  options?: LivePromptOptions,
): AsyncGenerator<OpenTuiStreamEvent> {
  await config.initialize();
  const client = config.getGeminiClient();
  const promptId = `opentui-${Date.now()}`;
  const map = createEventMapper();
  const sendMessageOptions = options?.modelOverride
    ? {
        type: SendMessageType.UserQuery,
        modelOverride: options.modelOverride,
      }
    : undefined;
  const stream = client.sendMessageStream(
    prompt,
    signal ?? new AbortController().signal,
    promptId,
    sendMessageOptions,
  );
  for await (const ev of stream) {
    for (const neutral of map(ev)) yield neutral;
  }
}
