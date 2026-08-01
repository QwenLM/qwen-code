/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSettings } from '../config/settings.js';
import {
  formatAudioBridgeNotice,
  runAudioBridge,
  shouldPreserveUnsupportedAudioForBridge,
} from './audio-bridge-service.js';

const transcribeVoiceAudio = vi.hoisted(() => vi.fn());

vi.mock('./voice-transcriber.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./voice-transcriber.js')>();
  return { ...actual, transcribeVoiceAudio };
});

function config(audio = false): Config {
  return {
    getEffectiveInputModalities: () => (audio ? { audio: true } : {}),
  } as unknown as Config;
}

function settings(voiceModel?: string): LoadedSettings {
  return {
    merged: voiceModel ? { voiceModel } : {},
  } as LoadedSettings;
}

function audio(data = 'UklGRg=='): Part {
  return { inlineData: { mimeType: 'audio/wav', data } };
}

describe('audio bridge service', () => {
  beforeEach(() => {
    transcribeVoiceAudio.mockReset();
  });

  it('keeps audio unchanged when the primary model supports it', async () => {
    const parts = [{ text: 'listen' }, audio()];
    const result = await runAudioBridge({
      config: config(true),
      settings: settings('qwen3-asr-flash'),
      parts,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: 'skipped' });
    expect(result.parts).toEqual(parts);
    expect(transcribeVoiceAudio).not.toHaveBeenCalled();
  });

  it('replaces audio with an untrusted transcript for a text-only model', async () => {
    transcribeVoiceAudio.mockImplementation(
      async (_audio: unknown, options: { onEgress?: () => void }) => {
        options.onEgress?.();
        return 'review the latest diff';
      },
    );

    const result = await runAudioBridge({
      config: config(),
      settings: settings('qwen3-asr-flash'),
      parts: [{ text: 'before' }, audio(), { text: 'after' }],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'ok',
      audioCount: 1,
      convertedCount: 1,
      egressCount: 1,
      modelId: 'qwen3-asr-flash',
    });
    expect(result.parts.map((part) => part.text)).toEqual([
      'before',
      expect.stringContaining('Untrusted machine transcription'),
      'after',
    ]);
    expect(result.parts[1]?.text).toContain('review the latest diff');
    expect(formatAudioBridgeNotice(result)).toContain(
      'Your audio was sent to that model',
    );
  });

  it('replaces audio with a safe note when no voice model is configured', async () => {
    const result = await runAudioBridge({
      config: config(),
      settings: settings(),
      parts: [audio()],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'failed',
      egressCount: 0,
    });
    expect(result.parts[0]?.text).toContain('no voice model is configured');
    expect(result.parts.some((part) => part.inlineData)).toBe(false);
  });

  it('discloses egress when transcription fails after upload', async () => {
    transcribeVoiceAudio.mockImplementation(
      async (_audio: unknown, options: { onEgress?: () => void }) => {
        options.onEgress?.();
        throw new Error('ASR unavailable');
      },
    );

    const result = await runAudioBridge({
      config: config(),
      settings: settings('qwen3-asr-flash'),
      parts: [audio()],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'failed',
      convertedCount: 0,
      egressCount: 1,
    });
    expect(result.parts[0]?.text).toContain('transcription was unavailable');
    expect(formatAudioBridgeNotice(result)).toBe(
      'Sent 1 audio file(s) to qwen3-asr-flash for transcription, but no transcript was produced.',
    );
  });

  it('does not start another transcription after cancellation', async () => {
    const controller = new AbortController();
    transcribeVoiceAudio.mockImplementation(
      async (_audio: unknown, options: { onEgress?: () => void }) => {
        options.onEgress?.();
        controller.abort();
        return 'discarded transcript';
      },
    );

    const result = await runAudioBridge({
      config: config(),
      settings: settings('qwen3-asr-flash'),
      parts: [audio(), { text: 'between' }, audio('T2dnUw==')],
      signal: controller.signal,
    });

    expect(transcribeVoiceAudio).toHaveBeenCalledTimes(1);
    expect(result.egressCount).toBe(1);
    expect(result.parts.some((part) => part.inlineData)).toBe(false);
    expect(result.parts.map((part) => part.text)).toContain('between');
  });

  it('preserves unsupported attachments only for a batch voice model', () => {
    expect(
      shouldPreserveUnsupportedAudioForBridge(
        config(),
        settings('qwen3-asr-flash'),
      ),
    ).toBe(true);
    expect(
      shouldPreserveUnsupportedAudioForBridge(
        config(),
        settings('qwen3-asr-flash-realtime'),
      ),
    ).toBe(false);
    expect(
      shouldPreserveUnsupportedAudioForBridge(
        config(true),
        settings('qwen3-asr-flash'),
      ),
    ).toBe(false);
  });
});
