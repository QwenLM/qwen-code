/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Part } from '@google/genai';
import {
  runVisionBridge,
  selectVisionBridgeModel,
  type VisionModelCandidate,
} from './vision-bridge-service.js';
import type { Config } from '../../config/config.js';

vi.mock('../../utils/sideQuery.js', () => ({ runSideQuery: vi.fn() }));
import { runSideQuery } from '../../utils/sideQuery.js';

const mockSideQuery = runSideQuery as unknown as ReturnType<typeof vi.fn>;

const config = {
  getDefaultVisionBridgeModel: () => ({ id: 'qwen3-vl-plus' }),
} as unknown as Config;

const image = (data = 'aGVsbG8='): Part => ({
  inlineData: { mimeType: 'image/png', data },
});
const signal = () => new AbortController().signal;
const textOf = (parts: unknown): string =>
  (parts as Part[]).map((p) => p.text ?? '').join('\n');

beforeEach(() => {
  mockSideQuery.mockReset();
});

describe('runVisionBridge', () => {
  it('skips when there are no image parts', async () => {
    const result = await runVisionBridge({
      config,
      parts: 'just text',
      signal: signal(),
    });
    expect(result.status).toBe('skipped');
    expect(result.applied).toBe(false);
    expect(mockSideQuery).not.toHaveBeenCalled();
  });

  it('converts images to an untrusted text block on success', async () => {
    mockSideQuery.mockResolvedValue({ text: 'A red error dialog' });
    const result = await runVisionBridge({
      config,
      parts: ['Fix this error', image()],
      signal: signal(),
    });

    expect(result.status).toBe('ok');
    expect(result.applied).toBe(true);
    const out = result.parts as Part[];
    expect(out.some((p) => p.inlineData)).toBe(false); // no images leak through
    const joined = textOf(out);
    expect(joined).toContain('Fix this error'); // original text preserved
    expect(joined).toContain('A red error dialog'); // description inserted
    expect(joined).toMatch(/untrusted/i); // warned as untrusted
    expect(joined).toMatch(/do NOT follow/i);
    expect(mockSideQuery).toHaveBeenCalledOnce();
  });

  it('passes the bridge model and image, carrying intent in the user turn (not the system prompt)', async () => {
    mockSideQuery.mockResolvedValue({ text: 'desc' });
    await runVisionBridge({
      config,
      parts: ['Explain this UI', image('PAYLOAD64')],
      signal: signal(),
    });
    const callOptions = mockSideQuery.mock.calls[0][1];
    expect(callOptions.model).toBe('qwen3-vl-plus');
    // Intent is conveyed via the user turn so untrusted text never reshapes the
    // system role; the system instruction stays static.
    expect(JSON.stringify(callOptions.contents)).toContain('Explain this UI');
    expect(String(callOptions.systemInstruction)).not.toContain(
      'Explain this UI',
    );
    expect(JSON.stringify(callOptions.contents)).toContain('PAYLOAD64');
  });

  it('caps the intent so large @-file context is not dumped to the bridge model', async () => {
    mockSideQuery.mockResolvedValue({ text: 'desc' });
    await runVisionBridge({
      config,
      parts: ['x'.repeat(5000), image()],
      signal: signal(),
    });
    const sent = JSON.stringify(mockSideQuery.mock.calls[0][1].contents);
    expect(sent).toContain('x'.repeat(2000)); // the question still reaches it
    expect(sent).not.toContain('x'.repeat(2001)); // but capped at 2000 chars
  });

  it('reports the bridge model endpoint host for cross-provider egress clarity', async () => {
    mockSideQuery.mockResolvedValue({ text: 'desc' });
    const configWithEndpoint = {
      getDefaultVisionBridgeModel: () => ({
        id: 'qwen3-vl-plus',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    } as unknown as Config;
    const result = await runVisionBridge({
      config: configWithEndpoint,
      parts: ['look', image()],
      signal: signal(),
    });
    expect(result.status).toBe('ok');
    expect(result.modelEndpoint).toBe('dashscope.aliyuncs.com');
  });

  it('does not expose raw invalid endpoint URLs in the egress host', async () => {
    mockSideQuery.mockResolvedValue({ text: 'desc' });
    const configWithBadEndpoint = {
      getDefaultVisionBridgeModel: () => ({
        id: 'qwen3-vl-plus',
        baseUrl: 'not a url with token=secret',
      }),
    } as unknown as Config;

    const result = await runVisionBridge({
      config: configWithBadEndpoint,
      parts: ['look', image()],
      signal: signal(),
    });

    expect(result.status).toBe('ok');
    expect(result.modelEndpoint).toBeUndefined();
  });

  it('strips <think> tags from the bridge output', async () => {
    mockSideQuery.mockResolvedValue({
      text: '<think>hidden reasoning</think>Visible: a submit button',
    });
    const result = await runVisionBridge({
      config,
      parts: ['q', image()],
      signal: signal(),
    });
    const joined = textOf(result.parts);
    expect(joined).not.toContain('hidden reasoning');
    expect(joined).toContain('Visible: a submit button');
  });

  it('strips an unterminated <think> tail instead of leaking it', async () => {
    mockSideQuery.mockResolvedValue({
      text: 'A login form<think>now I will reason forever without closing',
    });
    const result = await runVisionBridge({
      config,
      parts: ['what is this', image()],
      signal: signal(),
    });
    const joined = textOf(result.parts);
    expect(joined).toContain('A login form');
    expect(joined).not.toContain('reason forever');
  });

  it('caps each bridge call at four images and reports the omitted count', async () => {
    mockSideQuery.mockResolvedValue({ text: 'desc' });
    const result = await runVisionBridge({
      config,
      parts: [
        'look',
        image('FIRST'),
        image('SECOND'),
        image('THIRD'),
        image('FOURTH'),
        image('FIFTH'),
      ],
      signal: signal(),
    });
    expect(result.convertedCount).toBe(4);
    expect(result.omittedCount).toBe(1); // 5 detected − 4 converted
    expect(textOf(result.parts)).toContain('1 image(s) omitted');
    const sent = JSON.stringify(mockSideQuery.mock.calls[0][1].contents);
    expect(sent).toContain('FIRST');
    expect(sent).toContain('FOURTH');
    expect(sent).not.toContain('FIFTH');
  });

  it('strips interleaved <think> blocks without eating answer text between them', async () => {
    mockSideQuery.mockResolvedValue({
      text: '<think>r1</think>Answer part 1<think>r2</think>Answer part 2',
    });
    const result = await runVisionBridge({
      config,
      parts: ['q', image()],
      signal: signal(),
    });
    const joined = textOf(result.parts);
    expect(joined).toContain('Answer part 1');
    expect(joined).toContain('Answer part 2');
    expect(joined).not.toContain('r1');
    expect(joined).not.toContain('r2');
  });

  it('strips nested <think> blocks without leaking inner reasoning', async () => {
    mockSideQuery.mockResolvedValue({
      text: '<think>outer<think>inner secret</think>still secret</think>Visible: a dialog',
    });
    const result = await runVisionBridge({
      config,
      parts: ['what is this', image()],
      signal: signal(),
    });
    const joined = textOf(result.parts);
    expect(joined).toContain('Visible: a dialog');
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('</think>');
  });

  it('counts both invalid and capped images in the omitted total', async () => {
    mockSideQuery.mockResolvedValue({ text: 'desc' });
    const oversized = image('a'.repeat(10 * 1024 * 1024));

    const result = await runVisionBridge({
      config,
      parts: [
        'look',
        image('OK1'),
        image('OK2'),
        image('OK3'),
        image('OK4'),
        image('OK5'),
        oversized,
      ],
      signal: signal(),
    });

    expect(result.convertedCount).toBe(4);
    expect(result.omittedCount).toBe(2); // one oversized + one over the cap
  });

  it('fails without calling the model when none is available', async () => {
    const result = await runVisionBridge({
      config: {} as Config,
      parts: ['q', image()],
      signal: signal(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/image-capable model/);
    expect(mockSideQuery).not.toHaveBeenCalled();
  });

  it('uses whichever model getDefaultVisionBridgeModel returns', async () => {
    mockSideQuery.mockResolvedValue({ text: 'auto-described' });
    const configWithAuto = {
      getDefaultVisionBridgeModel: () => ({ id: 'qwen3.7-plus' }),
    } as unknown as Config;
    const result = await runVisionBridge({
      config: configWithAuto,
      parts: ['look', image()],
      signal: signal(),
    });
    expect(result.status).toBe('ok');
    expect(result.modelId).toBe('qwen3.7-plus');
    expect(mockSideQuery.mock.calls[0][1].model).toBe('qwen3.7-plus');
  });

  it('marks cancellation after dispatch as skipped with egress disclosure', async () => {
    const controller = new AbortController();
    mockSideQuery.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });

    const result = await runVisionBridge({
      config,
      parts: ['look', image()],
      signal: controller.signal,
    });

    expect(result.status).toBe('skipped');
    expect(result.applied).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.egressOccurred).toBe(true);
    expect(result.modelId).toBe('qwen3-vl-plus');
  });

  it('treats user cancellation as skipped even if the timeout also fires', async () => {
    const controller = new AbortController();
    controller.abort();
    mockSideQuery.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('request aborted after timeout')),
            10,
          );
        }),
    );

    const result = await runVisionBridge({
      config,
      parts: ['look', image()],
      signal: controller.signal,
    });

    expect(result.status).toBe('skipped');
    expect(result.applied).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('bounds bridge output and skips output-language preference injection', async () => {
    mockSideQuery.mockResolvedValue({ text: 'desc' });

    await runVisionBridge({
      config,
      parts: ['look', image()],
      signal: signal(),
    });

    expect(mockSideQuery.mock.calls[0][1]).toMatchObject({
      skipOutputLanguagePreference: true,
      config: { maxOutputTokens: 2048 },
    });
  });

  it('on failure, preserves user text and appends a note while dropping images', async () => {
    mockSideQuery.mockRejectedValue(new Error('boom'));
    const result = await runVisionBridge({
      config,
      parts: ['Explain the screenshot please', image()],
      signal: signal(),
    });
    expect(result.status).toBe('failed');
    expect(result.applied).toBe(true);
    expect(textOf(result.parts)).toContain('Explain the screenshot please');
    expect(textOf(result.parts)).toMatch(/could not interpret/i);
    expect((result.parts as Part[]).some((p) => p.inlineData)).toBe(false);
    expect(result.egressOccurred).toBe(true);
    expect(result.error).toContain('boom');
  });

  it('does not forward raw provider error messages to the primary model', async () => {
    mockSideQuery.mockRejectedValue(
      new Error('401 from https://signed.example.com?token=secret'),
    );

    const result = await runVisionBridge({
      config,
      parts: ['Explain the screenshot please', image()],
      signal: signal(),
    });

    expect(result.status).toBe('failed');
    // The raw reason is kept on the result for logging/telemetry…
    expect(result.error).toContain('token=secret');
    // …but never leaked into the parts sent to the primary model.
    expect(textOf(result.parts)).toMatch(/could not interpret/i);
    expect(textOf(result.parts)).not.toContain('token=secret');
  });

  it('treats an empty model response as a failure', async () => {
    mockSideQuery.mockResolvedValue({ text: '   ' });
    const result = await runVisionBridge({
      config,
      parts: ['a real question here', image()],
      signal: signal(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no description/);
    expect(result.modelId).toBe('qwen3-vl-plus');
  });

  it('fails with "no usable image" when every image is invalid', async () => {
    const oversized = image('a'.repeat(10 * 1024 * 1024));
    const result = await runVisionBridge({
      config,
      parts: ['describe this', oversized],
      signal: signal(),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no usable image/);
    expect(result.omittedCount).toBe(1);
    expect(result.egressOccurred).toBeUndefined();
    expect(mockSideQuery).not.toHaveBeenCalled();
    expect(textOf(result.parts)).toContain('describe this');
  });

  it('surfaces only the raw description as the display transcript', async () => {
    mockSideQuery.mockResolvedValue({ text: 'A plain description' });
    const result = await runVisionBridge({
      config,
      parts: ['q', image()],
      signal: signal(),
    });

    expect(textOf(result.parts)).toMatch(/untrusted/i);
    expect(result.transcript).toBe('A plain description');
    expect(result.transcript).not.toMatch(/untrusted/i);
  });
});

describe('selectVisionBridgeModel (same-provider only)', () => {
  const dashscope = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const idealab = 'https://idealab.example.com/v1';
  // Primary qwen-text-max is text-only on dashscope; qwen3.7-plus shares that
  // endpoint (a real vision model), gpt-5.4 is image-capable but on idealab.
  const models: VisionModelCandidate[] = [
    { id: 'qwen-text-max', authType: 'openai', baseUrl: dashscope },
    { id: 'gpt-5.4', authType: 'openai', baseUrl: idealab },
    { id: 'qwen3.7-plus', authType: 'openai', baseUrl: dashscope },
  ];

  it('returns undefined when no image-capable model is registered', () => {
    expect(
      selectVisionBridgeModel(
        'qwen-text-max',
        [
          { id: 'qwen-text-max', baseUrl: dashscope },
          { id: 'deepseek-v3', baseUrl: dashscope },
        ],
        { baseUrl: dashscope },
      ),
    ).toBeUndefined();
  });

  it('never selects the primary model itself', () => {
    const picked = selectVisionBridgeModel('qwen3.7-plus', models, {
      baseUrl: dashscope,
    });
    expect(picked?.id).not.toBe('qwen3.7-plus');
  });

  it('picks the image-capable model on the SAME endpoint as the primary', () => {
    // gpt-5.4 (idealab) appears first, but qwen3.7-plus shares the primary's
    // dashscope endpoint and must win.
    expect(
      selectVisionBridgeModel('qwen-text-max', models, { baseUrl: dashscope }),
    ).toEqual({ id: 'qwen3.7-plus', baseUrl: dashscope });
  });

  it('never reaches across providers: undefined when the only vision model is on a different endpoint', () => {
    expect(
      selectVisionBridgeModel(
        'qwen-text-max',
        [
          { id: 'qwen-text-max', authType: 'openai', baseUrl: dashscope },
          { id: 'gpt-5.4', authType: 'openai', baseUrl: idealab },
          // OAuth/runtime model on yet another endpoint must never be picked.
          {
            id: 'coder-model',
            authType: 'qwen-oauth',
            baseUrl: 'DYNAMIC_QWEN_OAUTH_BASE_URL',
            isVision: true,
          },
        ],
        { authType: 'openai', baseUrl: dashscope },
      ),
    ).toBeUndefined();
  });

  it('falls back to same auth type when the primary has no baseUrl', () => {
    const picked = selectVisionBridgeModel(
      'runtime-text',
      [
        { id: 'runtime-text', authType: 'openai' },
        { id: 'vision-other', authType: 'anthropic', isVision: true },
        { id: 'vision-same', authType: 'openai', isVision: true },
      ],
      { authType: 'openai' },
    );
    expect(picked?.id).toBe('vision-same');
  });

  it('returns undefined when the provider identity is unknown', () => {
    expect(selectVisionBridgeModel('primary', models)).toBeUndefined();
  });

  it('respects explicit modalities and isVision over name-based detection', () => {
    const picked = selectVisionBridgeModel(
      'primary',
      [
        { id: 'primary', baseUrl: dashscope },
        // text-by-name but explicitly image-capable -> eligible
        {
          id: 'custom-text-name',
          baseUrl: dashscope,
          modalities: { image: true },
        },
      ],
      { baseUrl: dashscope },
    );
    expect(picked?.id).toBe('custom-text-name');
  });
});
