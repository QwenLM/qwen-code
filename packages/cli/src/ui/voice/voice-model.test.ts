/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType, type AvailableModel } from '@qwen-code/qwen-code-core';
import {
  isSelectableVoiceModel,
  isTranscribableVoiceModel,
  resolveVoiceTransport,
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
  });

  it('isSelectableVoiceModel rejects ids with no ASR transport', () => {
    // The core D fix: a chat/non-ASR id can no longer be persisted as voice.
    expect(isSelectableVoiceModel(model({ id: 'gpt-4o' }))).toBe(false);
    expect(isSelectableVoiceModel(model({ id: 'custom:asr' }))).toBe(false);
    expect(
      isSelectableVoiceModel(model({ id: 'qwen3-asr-flash-filetrans' })),
    ).toBe(false);
  });

  it('isSelectableVoiceModel accepts the qwen-audio Token Plan ASR family', () => {
    expect(
      isSelectableVoiceModel(model({ id: 'qwen-audio-3.0-asr-flash' })),
    ).toBe(true);
    expect(
      isSelectableVoiceModel(model({ id: 'qwen-audio-3.0-realtime-plus' })),
    ).toBe(true);
  });
});

describe('resolveVoiceTransport', () => {
  it('routes the qwen-audio Token Plan ASR family', () => {
    // Bare and date-suffixed asr ids use the batch chat shape (#10932).
    expect(resolveVoiceTransport('qwen-audio-3.0-asr-flash')).toBe(
      'qwen-asr-chat',
    );
    expect(resolveVoiceTransport('qwen-audio-3.0-asr-flash-2026-09-01')).toBe(
      'qwen-asr-chat',
    );
    // Streaming variants speak the OpenAI realtime WebSocket dialect.
    expect(resolveVoiceTransport('qwen-audio-3.0-asr-flash-streaming')).toBe(
      'qwen-asr-realtime',
    );
    expect(resolveVoiceTransport('qwen-audio-3.0-asr-flash-realtime')).toBe(
      'qwen-asr-realtime',
    );
    expect(resolveVoiceTransport('qwen-audio-3.0-realtime-plus')).toBe(
      'qwen-asr-realtime',
    );
    expect(resolveVoiceTransport('Qwen-Audio-3.0-ASR-Flash')).toBe(
      'qwen-asr-chat',
    );
  });

  it('keeps routing the legacy qwen3-asr and dashscope ids', () => {
    expect(resolveVoiceTransport('qwen3-asr-flash')).toBe('qwen-asr-chat');
    expect(resolveVoiceTransport('qwen3-asr-flash-2025-08-20')).toBe(
      'qwen-asr-chat',
    );
    expect(resolveVoiceTransport('qwen3-asr-flash-realtime')).toBe(
      'qwen-asr-realtime',
    );
    expect(resolveVoiceTransport('fun-asr-realtime')).toBe(
      'dashscope-task-realtime',
    );
    expect(resolveVoiceTransport('paraformer-realtime-v2')).toBe(
      'dashscope-task-realtime',
    );
  });

  it('rejects non-ASR ids, including filetrans and tts in the family', () => {
    expect(resolveVoiceTransport('gpt-4o')).toBe('unsupported');
    expect(resolveVoiceTransport('custom:asr')).toBe('unsupported');
    expect(resolveVoiceTransport('qwen3-asr-flash-filetrans')).toBe(
      'unsupported',
    );
    expect(resolveVoiceTransport('qwen-audio-3.0-asr-flash-filetrans')).toBe(
      'unsupported',
    );
    expect(resolveVoiceTransport('qwen-audio-3.0-tts-plus')).toBe(
      'unsupported',
    );
  });
});
