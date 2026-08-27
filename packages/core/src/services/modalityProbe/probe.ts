/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-shot image modality probe (QwenLM/qwen-code#10309, phase 1).
 *
 * Sends a single chat-completions request carrying a tiny red 8x8 PNG to the
 * model's own endpoint and classifies the endpoint's response. Deliberately
 * bypasses the content pipeline: the converter's modality gate would replace
 * the image with a placeholder for pattern-guessed (text-only) models, which
 * is exactly the belief under test.
 *
 * Verdict is based solely on acceptance — the successful response's CONTENT is
 * never inspected: reasoning models routinely return an empty `content` with
 * text in `reasoning_content`/`thinking` even when the image was accepted.
 * Auth / rate-limit / timeout / ambiguous errors yield `unknown` (no
 * conclusion) — never a wrong `text_only`, which would be cached and silently
 * strip images from a vision model.
 */

/** Error-text phrases that express a modality rejection. Observed in the wild
 * (2026-08-27, four-endpoint validation — see issue #10309): DeepSeek/Ollama
 * reject via error.message; Zhipu phrases it as content.type enum validation;
 * OpenRouter's router returns 404 "No endpoints found that support image input". */
const MODALITY_ERROR_HINTS = [
  'not support',
  'text-only',
  'text only',
  'multimodal',
  'modalit',
  '不支持',
  '多模态',
  '识图',
  '无法处理图片',
  'images are not',
  'does not accept',
  'support image input',
  'content.type 参数非法',
  "取值范围 ['text']",
] as const;

/** The hints pre-lowercased once at module load, so the classification hot
 * path does substring checks without re-lowercasing every hint per call. */
const MODALITY_ERROR_HINTS_LOWER = MODALITY_ERROR_HINTS.map((hint) =>
  hint.toLowerCase(),
);

/** Red 8x8 PNG as a data URL. 8x8 rather than 1x1: some endpoints enforce a
 * minimum image size and would reject a 1x1 as malformed traffic, corrupting
 * the verdict. */
export const RED_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

export type ModalityProbeVerdict = 'image' | 'text_only' | 'unknown';

export interface ModalityProbeInput {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

export interface ModalityProbeResult {
  readonly verdict: ModalityProbeVerdict;
  readonly httpStatus: number;
  /** Truncated response/error body — for UI display and debug logging only. */
  readonly snippet: string;
}

export function classifyProbeResponse(
  status: number,
  errorText: string,
): ModalityProbeVerdict {
  if (status === 200) {
    return 'image';
  }
  // Hints are only consulted for 4xx client errors: 5xx bodies may contain
  // incidental "multimodal" text in server tracebacks (e.g. a vLLM stack
  // frame path like vllm/multimodal/utils.py), and trusting those would
  // classify a vision model as text_only — a verdict later tasks persist,
  // silently stripping images. Anything else non-200 abstains to 'unknown'
  // (the safe direction).
  if (status < 400 || status >= 500) {
    return 'unknown';
  }
  const low = (errorText ?? '').toLowerCase();
  // Match against the raw response text, not a parsed error.message field —
  // the error payload's shape itself differs per vendor (object-with-message
  // vs plain string).
  if (MODALITY_ERROR_HINTS_LOWER.some((hint) => low.includes(hint))) {
    return 'text_only';
  }
  return 'unknown';
}

export async function probeImageSupport(
  input: ModalityProbeInput,
): Promise<ModalityProbeResult> {
  const body = {
    model: input.model,
    max_tokens: 24,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图片是什么颜色？' },
          { type: 'image_url', image_url: { url: RED_PNG_DATA_URL } },
        ],
      },
    ],
  };
  try {
    const response = await fetch(
      `${input.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(input.timeoutMs ?? 90_000),
      },
    );
    const text = await response.text();
    return {
      verdict: classifyProbeResponse(response.status, text),
      httpStatus: response.status,
      snippet: text.slice(0, 200),
    };
  } catch (error) {
    return {
      verdict: 'unknown',
      httpStatus: -1,
      snippet:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
}
