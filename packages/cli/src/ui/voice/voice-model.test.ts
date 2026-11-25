/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType, type AvailableModel } from '@qwen-code/qwen-code-core';
import {
  isBatchVoiceTransport,
  isSelectableVoiceModel,
  isTranscribableVoiceModel,
  type VoiceTransport,
} from './voice-model.js';

function model(overrides: Partial<AvailableModel>): AvailableModel {
  return {
    id: 'qwen3-asr-flash',
    label: 'Qwen ASR',
    authType: AuthType.USE_OPENAI,
    baseUrl: 'https://dashscope.example/v1',
    ...overrides,
  } as AvailableModel;
}

describe('voice model guards', () => {
  it('isTranscribableVoiceModel accepts any OpenAI model with a baseUrl (transport-agnostic)', () => {
    expect(isTranscribableVoiceModel(model({}))).toBe(true);
    // Custom ids resolve at the config layer; transport is enforced separately.
    expect(isTranscribableVoiceModel(model({ id: 'custom:asr' }))).toBe(true);
  });

  it('isTranscribableVoiceModel rejects runtime models and empty baseUrls', () => {
    expect(isTranscribableVoiceModel(model({ isRuntimeModel: true }))).toBe(
      false,
    );
    expect(isTranscribableVoiceModel(model({ baseUrl: '' }))).toBe(false);
    expect(isTranscribableVoiceModel(model({ imageOnly: true }))).toBe(false);
  });

  it('isSelectableVoiceModel accepts ids with a real ASR transport', () => {
    expect(isSelectableVoiceModel(model({}))).toBe(true);
    expect(
      isSelectableVoiceModel(model({ id: 'qwen3-asr-flash-realtime' })),
    ).toBe(true);
    expect(
      isSelectableVoiceModel(model({ id: 'qwen-audio-3.0-asr-flash' })),
    ).toBe(true);
  });

  it('isSelectableVoiceModel rejects ids with no ASR transport', () => {
    // The core D fix: a chat/non-ASR id can no longer be persisted as voice.
    expect(isSelectableVoiceModel(model({ id: 'gpt-4o' }))).toBe(false);
    expect(isSelectableVoiceModel(model({ id: 'custom:asr' }))).toBe(false);
    expect(
      isSelectableVoiceModel(model({ id: 'qwen3-asr-flash-filetrans' })),
    ).toBe(false);
    expect(
      isSelectableVoiceModel(
        model({ id: 'qwen-audio-3.0-asr-flash-streaming' }),
      ),
    ).toBe(false);
  });

  const transportCases: Array<[VoiceTransport, boolean]> = [
    ['qwen-asr-chat', true],
    ['dashscope-multimodal-asr', true],
    ['qwen-asr-realtime', false],
    ['dashscope-task-realtime', false],
    ['unsupported', false],
  ];

  it.each(transportCases)(
    'isBatchVoiceTransport(%s) reports batch capability %s',
    (transport, expected) => {
      expect(isBatchVoiceTransport(transport)).toBe(expected);
    },
  );
});
