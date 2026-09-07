/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isVoiceModelId } from './voiceModels';

describe('isVoiceModelId', () => {
  it('accepts the batch ASR model ids the daemon has a transport for', () => {
    // DashScope batch ASR model.
    expect(isVoiceModelId('qwen3-asr-flash')).toBe(true);
    // Model Studio Token Plan batch ASR model (issue #10932): the Web Shell
    // voice picker must offer it, mirroring the CLI's BATCH_ASR_MODEL_RE.
    expect(isVoiceModelId('qwen-audio-3.0-asr-flash')).toBe(true);
    // Date-stamped snapshots of either resolve the same way.
    expect(isVoiceModelId('qwen3-asr-flash-2026-09-01')).toBe(true);
    expect(isVoiceModelId('qwen-audio-3.0-asr-flash-2026-09-01')).toBe(true);
  });

  it('accepts the realtime ASR model ids', () => {
    expect(isVoiceModelId('qwen3-asr-flash-realtime')).toBe(true);
    expect(isVoiceModelId('fun-asr-realtime')).toBe(true);
    expect(isVoiceModelId('paraformer-realtime-v2')).toBe(true);
  });

  it('rejects non-ASR members of the qwen-audio-3.0 family', () => {
    // The realtime / TTS members are not batch ASR and must stay hidden.
    expect(isVoiceModelId('qwen-audio-3.0-realtime-plus')).toBe(false);
    expect(isVoiceModelId('qwen-audio-3.0-tts-plus')).toBe(false);
  });

  it('rejects ordinary chat model ids', () => {
    expect(isVoiceModelId('gpt-4o')).toBe(false);
    expect(isVoiceModelId('qwen3-coder')).toBe(false);
  });
});
