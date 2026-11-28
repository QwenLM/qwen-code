/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { isGenerationModelId } from './modelClassification.js';

describe('isGenerationModelId', () => {
  it.each([
    'wan2.7-image',
    'wan2.7-image-pro',
    'wan3.0-video',
    'wan2.7-t2v-plus',
    'qwen-image-3.0-pro',
    'qwen-audio-3.0-tts-plus',
    'qwen-audio-3.0-asr-flash',
    'qwen-audio-3.0-realtime-plus',
    'qwen-vl-ocr-latest',
    'qwen2-audio-instruct',
    'dall-e-3',
    'gpt-image-1',
    'gpt-4o-audio-preview',
    'whisper-1',
    'tts-1',
    'text-embedding-3-small',
    'sora-2',
    'cogview-4',
    'cogvideo-x',
    'image-01',
    'openai/gpt-4o-mini-tts',
    'minimax/video-01',
  ])('classifies %s as a generation model', (id) => {
    expect(isGenerationModelId(id)).toBe(true);
  });

  it.each([
    'qwen3.5-plus',
    'qwen3-coder-plus',
    'qwen3-coder-next',
    'qwen3-max-2026-01-23',
    'glm-5',
    'glm-5.3',
    'deepseek-v4-pro',
    'deepseek-v4.1-flash',
    'kimi-k2.7-code',
    'MiniMax-M2.5',
    'grok-4.20-multi-agent-0309',
    'gemini-2.5-flash',
    'claude-sonnet-4',
    'gpt-4o',
    'auto',
    'decision-model-preview',
  ])('keeps %s selectable as a chat model', (id) => {
    expect(isGenerationModelId(id)).toBe(false);
  });
});
