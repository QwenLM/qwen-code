/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval instrumentation for the omni "model-call" policy tools
 * (transcribe / caption / OCR / segment understanding). These tools issue
 * their own OpenAI-compatible chat.completions requests to auxiliary
 * models (e.g. qwen3-omni-flash) and therefore bypass
 * LoggingContentGenerator, whose OMNI_USAGE_LOG writer only sees the main
 * agent model. Without this, a headless `-p` run's token total silently
 * omits every auxiliary-model call, understating the pipeline's real cost.
 *
 * Same JSONL line shape as LoggingContentGenerator's writer
 * (model/inputTokens/outputTokens/totalTokens/ts) so one harness parser
 * totals both, plus an optional `tool` tag for attribution. Opt-in via the
 * OMNI_USAGE_LOG env var; best-effort — a logging failure must never break
 * a tool call.
 */

import { appendFileSync } from 'node:fs';

/** OpenAI-compatible `usage` block from a chat.completions response.
 * `cached_tokens` (the prompt-cache hit) is reported either nested under
 * `prompt_tokens_details` (OpenAI standard) or at the top level (some
 * DashScope models) — both are read. */
export interface OpenAiUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cached_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

/**
 * Append one usage line to OMNI_USAGE_LOG if the env var is set. `usage`
 * is the OpenAI-shaped block (snake_case) returned by the auxiliary model;
 * absent when the upstream response carried no usage (e.g. a stream that
 * did not honor stream_options.include_usage) — in that case nothing is
 * logged rather than a line of nulls.
 */
export function appendOmniUsageLog(
  model: string,
  usage: OpenAiUsage | undefined,
  tool?: string,
): void {
  const usageLogPath = process.env['OMNI_USAGE_LOG'];
  if (!usageLogPath || !usage) return;
  const cachedInputTokens =
    usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? null;
  try {
    appendFileSync(
      usageLogPath,
      JSON.stringify({
        model,
        ...(tool !== undefined ? { tool } : {}),
        inputTokens: usage.prompt_tokens ?? null,
        outputTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
        cachedInputTokens,
        ts: Date.now(),
      }) + '\n',
    );
  } catch {
    // ignore — instrumentation must never break a tool call
  }
}
