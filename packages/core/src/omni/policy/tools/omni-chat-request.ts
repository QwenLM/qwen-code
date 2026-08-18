/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared OpenAI-compatible streaming chat.completions request for the
 * omni "model-call" policy tools (caption / OCR / segment understanding)
 * — the tools whose output is MODEL-GENERATED TEXT about a media input,
 * as opposed to a media derivative (the ffmpeg/sharp tools) or an ASR
 * transcript (omni_transcribe_audio, which keeps its own audio-only
 * request helper with chunked-segment machinery).
 *
 * One request shape: media content parts (image_url / video_url /
 * input_audio data URIs) followed by the instruction text, streamed SSE
 * response assembled by the same delta-content parser the ASR tool uses
 * (DashScope compatible-mode omni models only support streaming).
 * Non-2xx statuses come back as `HTTP <status>` only: raw upstream
 * bodies must not reach model-visible content.
 */

import { parseSseTranscript } from './transcribe-audio.js';

/** One media content part of the request. `url`/`data` are base64 data
 * URIs (or, for operators pointing at reachable hosts, plain URLs). */
export type OmniChatMediaPart =
  | { type: 'image_url'; url: string }
  | { type: 'video_url'; url: string }
  | { type: 'input_audio'; data: string; format: string };

export interface OmniChatRequestOptions {
  model: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl: string;
  apiKey: string;
  /** Instruction text placed AFTER the media parts. */
  prompt: string;
  media: OmniChatMediaPart[];
  timeoutMs: number;
  signal: AbortSignal;
  /** Optional response cap forwarded as `max_tokens`. */
  maxTokens?: number;
}

/** Serialize one media part to the wire shape of its content type. */
function serializeMediaPart(part: OmniChatMediaPart): Record<string, unknown> {
  switch (part.type) {
    case 'image_url':
      return { type: 'image_url', image_url: { url: part.url } };
    case 'video_url':
      return { type: 'video_url', video_url: { url: part.url } };
    case 'input_audio':
      return {
        type: 'input_audio',
        input_audio: { data: part.data, format: part.format },
      };
    default: {
      const exhaustive: never = part;
      throw new Error(`unknown media part type ${String(exhaustive)}`);
    }
  }
}

/**
 * POST one streaming chat.completions request and assemble the delta
 * text. Returns `{ok: false, error}` for HTTP failures; transport
 * exceptions (including the timeout's TimeoutError) propagate to the
 * caller, whose catch-tail maps them onto the uniform error ToolResult.
 */
export async function requestOmniChatCompletion(
  options: OmniChatRequestOptions,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const requestSignal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs),
  ]);
  const content: Array<Record<string, unknown>> = [
    ...options.media.map(serializeMediaPart),
    { type: 'text', text: options.prompt },
  ];
  const response = await fetch(
    `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        modalities: ['text'],
        stream: true,
        messages: [{ role: 'user', content }],
        ...(options.maxTokens !== undefined
          ? { max_tokens: options.maxTokens }
          : {}),
      }),
      signal: requestSignal,
    },
  );
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}` };
  }
  return { ok: true, text: parseSseTranscript(await response.text()).trim() };
}
