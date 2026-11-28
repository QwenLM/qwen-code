/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isVoiceModelId } from './voiceModels';

describe('isVoiceModelId', () => {
  const accepted = [
    'qwen3-asr-flash',
    'qwen3-asr-flash-2026-01-15',
    'qwen3-asr-flash-realtime',
    'qwen3-asr-flash-realtime-2026-01-15',
    'fun-asr-realtime',
    'paraformer-realtime-v2',
    'qwen-audio-3.0-asr-flash',
    'qwen-audio-3.0-asr-flash-2026-01-15',
    'QWEN-AUDIO-3.0-ASR-FLASH',
  ];

  const rejected = [
    'qwen3-asr-flash-filetrans',
    'qwen-audio-3.0-asr-flash-streaming',
    'qwen3.5-plus',
    '',
  ];

  it.each(accepted)('accepts %s', (id) => {
    expect(isVoiceModelId(id)).toBe(true);
  });

  it.each(rejected)('rejects %s', (id) => {
    expect(isVoiceModelId(id)).toBe(false);
  });
});
