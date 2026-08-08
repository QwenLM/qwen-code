/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaProbeResult } from '../../ffmpeg.js';
import type { ToolResult } from '../../../tools/tools.js';
import type { MediaPolicyToolConfigView } from './media-policy-tool.js';
import {
  OMNI_TRANSCRIBE_AUDIO_TOOL_NAME,
  OmniTranscribeAudioTool,
  TRANSCRIBE_AUDIO_DEFAULTS,
  parseSseTranscript,
} from './transcribe-audio.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
}));

/** Minimal RIFF/WAVE header so recognition sniffs audio/wav. */
const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVE'),
  Buffer.alloc(1024),
]);

const sse = (...contents: string[]): string =>
  contents
    .map(
      (c) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`,
    )
    .concat(['data: [DONE]'])
    .join('\n\n') + '\n';

describe('parseSseTranscript', () => {
  it('concatenates delta content across data lines and stops at [DONE]', () => {
    const body =
      'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n' +
      '\r\n' +
      ': keep-alive comment\n' +
      'event: message\n' +
      'data: {"choices":[{"delta":{"content":"，世界"}}]}\n' +
      'data: not-json\n' +
      'data: {"choices":[{"delta":{"content":null}}]}\n' +
      'data: [DONE]\n' +
      'data: {"choices":[{"delta":{"content":"after-done"}}]}\n';
    expect(parseSseTranscript(body)).toBe('你好，世界');
  });

  it('returns empty string for a body with no content frames', () => {
    expect(parseSseTranscript('data: [DONE]\n')).toBe('');
  });
});

describe('OmniTranscribeAudioTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  const tool = new OmniTranscribeAudioTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const fetchReturnsSse = (...contents: string[]): void => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => sse(...contents),
    });
  };

  const run = async (
    params: Record<string, unknown> = {},
    subject: OmniTranscribeAudioTool = tool,
  ): Promise<{ result: ToolResult; signal: AbortSignal }> => {
    const invocation = subject.build({
      inputPath,
      outputDir,
      ...params,
    } as never);
    const signal = new AbortController().signal;
    return { result: await invocation.execute(signal), signal };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-ta-'));
    inputPath = path.join(root, 'speech.wav');
    await fs.writeFile(inputPath, WAV_BYTES);
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    probe({ durationMs: 63_000 });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key-123');
    fetchReturnsSse('你好', '，世界');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and backend defaults', () => {
    expect(tool.name).toBe(OMNI_TRANSCRIBE_AUDIO_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['audio'],
      outputs: [
        {
          kind: 'file',
          role: 'transcript',
          mimeTypes: ['text/plain'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(TRANSCRIBE_AUDIO_DEFAULTS).toEqual({
      model: 'qwen3.5-omni-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      maxInputBytes: 10 * 1024 * 1024,
    });
  });

  it('transcribes via a streaming chat.completions call and emits the transcript-protocol artifact', async () => {
    const { result, signal } = await run();

    expect(mocks.probeMediaMetadata).toHaveBeenCalledWith(
      inputPath,
      'audio',
      signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer test-key-123',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'qwen3.5-omni-plus',
      modalities: ['text'],
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: `data:audio/wav;base64,${WAV_BYTES.toString('base64')}`,
                format: 'wav',
              },
            },
            {
              type: 'text',
              text: '请逐字转写这段音频的内容，只输出转写文本，不要添加任何解释。',
            },
          ],
        },
      ],
    });

    expect(result.error).toBeUndefined();
    const disclosure =
      '原 63s 音频 → 转写文本 5 字，语气/音色/非语音信息丢失，识别可能有误';
    expect(result.artifacts).toEqual([
      {
        kind: 'file',
        storage: 'workspace',
        title: 'Audio transcript',
        workspacePath: 'transcript.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength('你好，世界', 'utf-8'),
        metadata: { omniDisclosure: disclosure, omniRole: 'transcript' },
      },
    ]);
    await expect(
      fs.readFile(path.join(outputDir, 'transcript.txt'), 'utf-8'),
    ).resolves.toBe('你好，世界');
  });

  it('appends the language hint to the prompt when provided', async () => {
    await run({ language: 'zh' });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.messages[0].content[1].text).toBe(
      '请逐字转写这段音频的内容，只输出转写文本，不要添加任何解释。音频语言：zh。',
    );
  });

  it('falls back to policyTools settings for backend values, with params overriding', async () => {
    vi.stubEnv('MY_ASR_KEY', 'settings-key');
    const view: MediaPolicyToolConfigView = {
      getOmniPolicyToolsSettings: () => ({
        [OMNI_TRANSCRIBE_AUDIO_TOOL_NAME]: {
          settings: {
            model: 'settings-model',
            baseUrl: 'https://example.com/v1/',
            apiKeyEnv: 'MY_ASR_KEY',
            maxInputBytes: 5000,
          },
        },
      }),
    };
    const configured = new OmniTranscribeAudioTool(view);

    await run({}, configured);
    let [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Trailing slash on baseUrl is normalized away.
    expect(url).toBe('https://example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer settings-key',
    );
    expect(JSON.parse(init.body as string).model).toBe('settings-model');

    fetchMock.mockClear();
    fetchReturnsSse('嗯');
    await run({ model: 'param-model' }, configured);
    [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe('param-model');
  });

  it('fails without a network call when the API key env is unset', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', '');
    const { result } = await run();
    expect(result.error?.message).toBe(
      'environment variable DASHSCOPE_API_KEY is not set; transcription is unavailable',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without a network call when the input exceeds maxInputBytes', async () => {
    const { result } = await run({ maxInputBytes: 10 });
    expect(result.error?.message).toBe(
      `input audio is ${WAV_BYTES.length} bytes, over the 10-byte transcription limit`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports only the HTTP status on a non-2xx response (no body leak)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"secret internal detail"}}',
    });
    const { result } = await run();
    expect(result.error?.message).toBe(
      'transcription request failed: HTTP 429',
    );
  });

  it('fails when the stream yields an empty transcript', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'data: [DONE]\n',
    });
    const { result } = await run();
    expect(result.error?.message).toBe('transcription returned empty text');
  });

  it('refuses input whose bytes are not audio', async () => {
    // PNG magic — sniffs as image, expected audio.
    await fs.writeFile(
      inputPath,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64),
      ]),
    );
    const { result } = await run();
    expect(result.error?.message).toContain('sniffs as image');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an AbortSignal.timeout expiry to a timeout error', async () => {
    const view: MediaPolicyToolConfigView = {
      getOmniPolicyToolsSettings: () => ({
        [OMNI_TRANSCRIBE_AUDIO_TOOL_NAME]: {
          runtime: { timeoutMs: 123 },
        },
      }),
    };
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation timed out'), {
        name: 'TimeoutError',
      }),
    );
    const { result } = await run({}, new OmniTranscribeAudioTool(view));
    expect(result.error?.message).toBe('transcription timed out after 123ms');
  });

  it.each([
    [
      'relative inputPath',
      { inputPath: 'rel/a.wav', outputDir: '/tmp/x' },
      /absolute/,
    ],
    [
      'relative outputDir',
      { inputPath: '/tmp/a.wav', outputDir: 'staging' },
      /absolute/,
    ],
    [
      'unknown parameter',
      { inputPath: '/tmp/a.wav', outputDir: '/tmp/x', volume: 2 },
      /additional properties|not allowed/i,
    ],
    [
      'maxInputBytes below minimum',
      { inputPath: '/tmp/a.wav', outputDir: '/tmp/x', maxInputBytes: 0 },
      /minimum|>= 1/i,
    ],
  ])('build rejects %s', (_name, params, message) => {
    expect(() => tool.build(params as never)).toThrow(message);
  });
});
