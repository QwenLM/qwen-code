/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getTranslator } from '../i18n';
import { describeMicError } from './capture-utils';
import { formatVoiceError } from './voice-error';

const errors = [
  [
    'No voice model is configured for this workspace.',
    '当前工作区未配置语音模型。',
  ],
  ['Voice transcription failed. Please try again.', '语音转写失败，请重试。'],
  ['Voice transcription failed.', '语音转写失败，请重试。'],
  [
    'Too many voice sessions in progress; try again shortly.',
    '正在进行的语音会话过多，请稍后重试。',
  ],
  [
    'Microphone capture is not supported in this browser.',
    '此浏览器不支持麦克风采集。',
  ],
  [
    'Microphone needs a secure context — open the Web Shell via localhost/127.0.0.1 or https.',
    '麦克风需要安全上下文，请通过 localhost、127.0.0.1 或 HTTPS 打开 Web Shell。',
  ],
  ['Voice capture timed out while starting.', '语音采集启动超时，请重试。'],
  [
    'Voice capture buffer limit reached while starting.',
    '启动期间的语音缓冲区已达上限，请重试。',
  ],
  [
    'No response from server. Check that the voice model is running.',
    '服务器无响应，请检查语音模型是否正在运行。',
  ],
  [
    'Voice capacity is temporarily unavailable. Retry shortly.',
    '语音服务容量暂时不足，请稍后重试。',
  ],
  ['Transcription timed out.', '语音转写超时，请重试。'],
  ['Failed to finalize voice transcription.', '无法结束语音转写，请重试。'],
  ['Voice session exceeded the time limit.', '语音会话已超过时间限制。'],
  [
    'Recording is too long for transcription (max ~5 minutes).',
    '录音过长，无法转写（最长约 5 分钟）。',
  ],
  [
    'Queued voice audio exceeded the memory limit.',
    '排队的语音音频已超过内存限制，请重试。',
  ],
  [describeMicError({ name: 'NotFoundError' }), '未找到麦克风，请连接后重试。'],
  [
    describeMicError({ name: 'NotReadableError' }),
    '麦克风正被其他应用占用，请关闭该应用后重试。',
  ],
  [
    describeMicError({ name: 'NotAllowedError' }),
    '麦克风权限被阻止。请点击地址栏中的摄像头或锁图标，允许此网站使用麦克风，并在系统设置 → 隐私 → 麦克风中允许浏览器使用麦克风，然后重试。',
  ],
  ['Voice error', '语音错误'],
] as const;

describe('formatVoiceError', () => {
  it.each(errors)('translates %s into Chinese', (message, expected) => {
    expect(formatVoiceError(message, getTranslator('zh-CN'))).toBe(expected);
  });

  it.each(errors)('provides English feedback for %s', (message) => {
    const expected =
      message === 'Voice transcription failed.'
        ? 'Voice transcription failed. Please try again.'
        : message;
    expect(formatVoiceError(message, getTranslator('en'))).toBe(expected);
  });

  it('preserves numeric sample-rate diagnostics in both languages', () => {
    const error = 'Browser audio rate 48000 Hz is not the required 16000 Hz.';
    expect(formatVoiceError(error, getTranslator('en'))).toBe(error);
    expect(formatVoiceError(error, getTranslator('zh-CN'))).toBe(
      '浏览器音频采样率为 48000 Hz，不符合要求的 16000 Hz。',
    );
  });

  it.each([
    ['none', '未提供原因', 'no reason provided'],
    ['busy', '语音服务繁忙', 'voice service busy'],
    ['Connection cap', '连接数已达上限', 'connection limit reached'],
    ['Server shutting down', '服务器正在关闭', 'server shutting down'],
    ['Workspace removed', '工作区已移除', 'workspace removed'],
    [
      'Workspace trust reconfigured',
      '工作区信任设置已更改',
      'workspace trust settings changed',
    ],
    [
      'Workspace runtime reconfigured',
      '工作区运行时已重新配置',
      'workspace runtime reconfigured',
    ],
    ['voice error', '语音转写失败', 'voice transcription failed'],
    ['unknown upstream reason', '未知原因', 'unknown reason'],
  ])('translates close reason %s and preserves the code', (reason, zh, en) => {
    const error = `Voice connection closed (code=1012, reason=${reason}).`;
    expect(formatVoiceError(error, getTranslator('zh-CN'))).toBe(
      `语音连接已关闭（错误码：1012，原因：${zh}）。`,
    );
    expect(formatVoiceError(error, getTranslator('en'))).toBe(
      `Voice connection closed (code=1012, reason=${en}).`,
    );
  });

  it('translates a direct capacity close reason', () => {
    expect(formatVoiceError('busy', getTranslator('zh-CN'))).toBe(
      '语音服务繁忙',
    );
    expect(formatVoiceError('busy', getTranslator('en'))).toBe(
      'voice service busy',
    );
  });

  it.each(['Unexpected browser exception', 'private upstream endpoint', ''])(
    'uses localized fallback for unknown error %s',
    (error) => {
      expect(formatVoiceError(error, getTranslator('zh-CN'))).toBe(
        '语音转写失败，请重试。',
      );
      expect(formatVoiceError(error, getTranslator('en'))).toBe(
        'Voice transcription failed. Please try again.',
      );
    },
  );

  it('localizes the missing-message fallback', () => {
    expect(formatVoiceError(undefined, getTranslator('zh-CN'))).toBe(
      '语音错误',
    );
    expect(formatVoiceError(undefined, getTranslator('en'))).toBe(
      'Voice error',
    );
  });
});
