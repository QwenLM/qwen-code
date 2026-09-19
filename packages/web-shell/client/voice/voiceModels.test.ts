/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { extractVoiceModels, isVoiceModelId } from './voiceModels';

describe('isVoiceModelId', () => {
  it('accepts the qwen-audio Token Plan ASR family (#10932)', () => {
    expect(isVoiceModelId('qwen-audio-3.0-asr-flash')).toBe(true);
    expect(isVoiceModelId('qwen-audio-3.0-asr-flash-2026-09-01')).toBe(true);
    expect(isVoiceModelId('qwen-audio-3.0-asr-flash-streaming')).toBe(true);
    expect(isVoiceModelId('qwen-audio-3.0-asr-flash-realtime')).toBe(true);
    expect(isVoiceModelId('qwen-audio-3.0-realtime-plus')).toBe(true);
    expect(isVoiceModelId('Qwen-Audio-3.0-ASR-Flash')).toBe(true);
  });

  it('keeps accepting the legacy ASR ids', () => {
    expect(isVoiceModelId('qwen3-asr-flash')).toBe(true);
    expect(isVoiceModelId('qwen3-asr-flash-2025-08-20')).toBe(true);
    expect(isVoiceModelId('qwen3-asr-flash-realtime')).toBe(true);
    expect(isVoiceModelId('fun-asr-realtime')).toBe(true);
    expect(isVoiceModelId('paraformer-realtime-v2')).toBe(true);
  });

  it('rejects non-ASR ids, including filetrans and tts in the family', () => {
    expect(isVoiceModelId('gpt-4o')).toBe(false);
    expect(isVoiceModelId('qwen3-asr-flash-filetrans')).toBe(false);
    expect(isVoiceModelId('qwen-audio-3.0-asr-flash-filetrans')).toBe(false);
    expect(isVoiceModelId('qwen-audio-3.0-tts-plus')).toBe(false);
  });
});

describe('extractVoiceModels', () => {
  it('lists qwen-audio ASR ids from a providers status and dedupes', () => {
    const status = {
      providers: [
        {
          authType: 'USE_OPENAI',
          models: [
            {
              baseModelId: 'qwen-audio-3.0-asr-flash',
              name: 'Qwen Audio ASR',
              baseUrl: 'https://token-plan.example/compatible-mode/v1',
              contextLimit: 8000,
            },
            {
              // Registered with an auth suffix; the base id is the voice id.
              baseModelId: 'qwen-audio-3.0-asr-flash',
              name: 'Qwen Audio ASR (duplicate provider)',
            },
            { baseModelId: 'qwen-max', name: 'Qwen Max' },
            { baseModelId: 'qwen-audio-3.0-asr-flash-filetrans' },
            { isRuntime: true, baseModelId: 'qwen3-asr-flash-realtime' },
          ],
        },
      ],
    };
    const options = extractVoiceModels(status);
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({
      id: 'qwen-audio-3.0-asr-flash',
      label: 'Qwen Audio ASR',
      authType: 'USE_OPENAI',
      baseUrl: 'https://token-plan.example/compatible-mode/v1',
      contextWindow: 8000,
      modalities: { audio: true },
    });
  });

  it('returns an empty list for an undefined status', () => {
    expect(extractVoiceModels(undefined)).toEqual([]);
  });
});
