/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Catalog ids that are generation/service models rather than chat models.
 * `/models` returns no capability metadata, so classification stays heuristic
 * and only covers well-known families; curated preset ids are trusted as-is.
 */
const GENERATION_FAMILIES =
  /(?:^|[/_.-])(?:dall-e|gpt-image|imagen|flux|sdxl|stable-diffusion|midjourney|cogview|cogvideo|seedream|seedance|kolors|sora|veo|kling|hailuo|pika|runway|cosyvoice|sambert|paraformer|sensevoice|whisper|gummy|image-01|video-01)(?:$|[/_.-])/i;

const GENERATION_TASK_SUFFIX =
  /(?:^|[/_.-])(?:image|video|audio|voice|realtime|tts|asr|ocr|speech|transcribe|embedding|embeddings|rerank|moderation)(?:$|[/_.-])/i;

const VIDEO_TASK_CODE = /(?:^|[/_.-])(?:t2v|i2v|t2i|i2i)(?:$|[/_.-])/i;

export function isGenerationModelId(id: string): boolean {
  const normalized = id.trim();
  if (!normalized) return false;
  return (
    GENERATION_FAMILIES.test(normalized) ||
    GENERATION_TASK_SUFFIX.test(normalized) ||
    VIDEO_TASK_CODE.test(normalized)
  );
}
