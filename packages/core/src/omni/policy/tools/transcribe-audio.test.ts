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
  collapseRepetitionDegeneration,
  parseSseTranscript,
} from './transcribe-audio.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
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

describe('collapseRepetitionDegeneration', () => {
  it('collapses a degenerated tail to a single copy of the unit', () => {
    const { text, degenerated } = collapseRepetitionDegeneration(
      'Vi ses. ' + 'Hej! '.repeat(48),
    );
    expect(degenerated).toBe(true);
    expect(text).toBe('Vi ses. Hej!');
  });

  it('collapses multi-char CJK units', () => {
    const { text, degenerated } = collapseRepetitionDegeneration(
      '你好。' + '再见！'.repeat(20),
    );
    expect(degenerated).toBe(true);
    expect(text).toBe('你好。再见！');
  });

  it('leaves normal prose untouched', () => {
    const input = '今天天气很好，我们一起去潜水吧。水下三十米，一切都很安静。';
    expect(collapseRepetitionDegeneration(input)).toEqual({
      text: input,
      degenerated: false,
    });
  });

  it('does not treat a whitespace run as degeneration', () => {
    const input = '转写结束' + ' '.repeat(100);
    expect(collapseRepetitionDegeneration(input)).toEqual({
      text: input,
      degenerated: false,
    });
  });

  it('requires at least 8 repetitions', () => {
    // 6-char unit so 7 reps (42 chars) already clear the 24-char span
    // floor — this pins the rep threshold itself, not the span floor.
    const input = '好的，收到。'.repeat(7);
    expect(collapseRepetitionDegeneration(input).degenerated).toBe(false);
    const { text, degenerated } = collapseRepetitionDegeneration(
      '好的，收到。'.repeat(8),
    );
    expect(degenerated).toBe(true);
    expect(text).toBe('好的，收到。');
  });

  it('requires the repeated span to reach 24 chars', () => {
    // 8 reps but only a 16-char span — too short to count as a loop.
    const input = 'ab'.repeat(8);
    expect(collapseRepetitionDegeneration(input).degenerated).toBe(false);
  });

  it('collapses single-char loops once the span is long enough', () => {
    const { text, degenerated } = collapseRepetitionDegeneration(
      '嗯' + '啊'.repeat(30),
    );
    expect(degenerated).toBe(true);
    expect(text).toBe('嗯啊');
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
      // Endpoint + credential selection is operator-only: a gated caller
      // choosing both would let injected content exfiltrate arbitrary env
      // secrets to an attacker host.
      operatorOnlyParams: ['baseUrl', 'apiKeyEnv'],
    });
    expect(TRANSCRIBE_AUDIO_DEFAULTS).toEqual({
      model: 'qwen3.5-omni-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      maxInputBytes: 10 * 1024 * 1024,
      chunkSeconds: 180,
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
      stream_options: { include_usage: true },
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
        workspacePath: 'speech-transcript.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength('你好，世界', 'utf-8'),
        metadata: { omniDisclosure: disclosure, omniRole: 'transcript' },
      },
    ]);
    await expect(
      fs.readFile(path.join(outputDir, 'speech-transcript.txt'), 'utf-8'),
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

  it('collapses single-shot repetition degeneration and discloses it', async () => {
    fetchReturnsSse('你好。', '再见！'.repeat(20));
    const { result } = await run();

    expect(result.error).toBeUndefined();
    await expect(
      fs.readFile(path.join(outputDir, 'speech-transcript.txt'), 'utf-8'),
    ).resolves.toBe('你好。再见！');
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 63s 音频 → 转写文本 6 字，检测到重复退化已截断，语气/音色/非语音信息丢失，识别可能有误',
    );
  });

  describe('chunked transcription (duration > chunkSeconds)', () => {
    /** ffmpeg cut mock: writes the chunk file whose CONTENT is the run's
     * `-ss` value, so the fetch mock can tell segments apart by decoding
     * the base64 payload it receives. */
    const cutWritesSeekTag = (): void => {
      mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
        await fs.writeFile(args[args.length - 1], Buffer.from(args[2]));
        return { code: 0, stderr: '' };
      });
    };

    /** Decode the `-ss` seek tag back out of a fetch call's audio payload. */
    const seekTagOf = (init: RequestInit): string => {
      const body = JSON.parse(init.body as string);
      const dataUri = body.messages[0].content[0].input_audio.data as string;
      return Buffer.from(dataUri.split(',')[1], 'base64').toString();
    };

    beforeEach(() => {
      // 400s of audio at the default 180s chunk → 3 segments of 133.333s.
      probe({ durationMs: 400_000 });
      cutWritesSeekTag();
    });

    it('cuts equal 16kHz-mono-AAC segments, transcribes each, and assembles time-labeled lines', async () => {
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        text: async () => sse(`片段@${seekTagOf(init)}`),
      }));
      const { result, signal } = await run();

      // One cut per segment, seeking to the segment start.
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(3);
      expect(mocks.runFfmpeg).toHaveBeenNthCalledWith(
        1,
        [
          '-y',
          '-ss',
          '0.000',
          '-t',
          '133.333',
          '-i',
          inputPath,
          '-vn',
          '-c:a',
          'aac',
          '-b:a',
          '32k',
          '-ar',
          '16000',
          '-ac',
          '1',
          path.join(outputDir, 'chunk_0001.m4a'),
        ],
        { signal, timeoutMs: expect.any(Number) },
      );
      const seeks = mocks.runFfmpeg.mock.calls.map(
        (call) => (call[0] as string[])[2],
      );
      expect(seeks).toEqual(['0.000', '133.333', '266.667']);

      // Every chunk request carries the re-encoded m4a payload.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const call of fetchMock.mock.calls) {
        const body = JSON.parse((call[1] as RequestInit).body as string);
        expect(body.messages[0].content[0].input_audio.format).toBe('m4a');
        expect(body.model).toBe('qwen3.5-omni-plus');
      }

      expect(result.error).toBeUndefined();
      await expect(
        fs.readFile(path.join(outputDir, 'speech-transcript.txt'), 'utf-8'),
      ).resolves.toBe(
        '[00:00-02:13] 片段@0.000\n' +
          '[02:13-04:27] 片段@133.333\n' +
          '[04:27-06:40] 片段@266.667',
      );
      const disclosure = result.artifacts?.[0]?.metadata?.['omniDisclosure'];
      expect(disclosure).toContain('原 400s 音频 → 分 3 段转写文本');
      expect(disclosure).not.toContain('段失败');

      // Temporary chunk cuts are cleaned up; only the transcript remains.
      await expect(fs.readdir(outputDir)).resolves.toEqual([
        'speech-transcript.txt',
      ]);
    });

    it('uses H:MM:SS ranges for audio of an hour or longer', async () => {
      probe({ durationMs: 4_882_000 }); // 81:22 film → 28 segments
      fetchReturnsSse('对白');
      const { result } = await run();

      expect(result.error).toBeUndefined();
      const transcript = await fs.readFile(
        path.join(outputDir, 'speech-transcript.txt'),
        'utf-8',
      );
      expect(transcript).toContain('[0:00:00-0:02:54] 对白');
      expect(transcript).toContain('[1:18:28-1:21:22] 对白');
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '分 28 段转写文本',
      );
    });

    it('fails closed on an implausible container duration (segment-count ceiling)', async () => {
      // 10⁸ claimed seconds → ~555556 segments at 180s. The duration is
      // attacker-influenced metadata: without the ceiling this would fan
      // out into hundreds of thousands of ffmpeg cuts + API calls.
      probe({ durationMs: 100_000_000_000 });
      const { result } = await run();

      expect(result.error?.message).toMatch(/over the 512-segment ceiling/);
      expect(result.error?.message).toMatch(/implausible/);
      expect(mocks.runFfmpeg).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.artifacts).toBeUndefined();
    });

    it('marks individual failed segments inline instead of failing the run', async () => {
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
        seekTagOf(init).startsWith('133')
          ? { ok: false, status: 500, text: async () => 'secret detail' }
          : { ok: true, status: 200, text: async () => sse('还行') },
      );
      const { result } = await run();

      expect(result.error).toBeUndefined();
      const transcript = await fs.readFile(
        path.join(outputDir, 'speech-transcript.txt'),
        'utf-8',
      );
      expect(transcript).toContain('[02:13-04:27] （该段转写失败：HTTP 500）');
      expect(transcript).not.toContain('secret detail');
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '（1 段失败）',
      );
    });

    it('errors only when EVERY segment failed', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'boom',
      });
      const { result } = await run();
      expect(result.error?.message).toBe(
        'transcription failed for all 3 segments (last: HTTP 500)',
      );
    });

    it('collapses per-segment repetition degeneration and counts it in the disclosure', async () => {
      fetchReturnsSse('大家好。', '再见！'.repeat(20));
      const { result } = await run();

      expect(result.error).toBeUndefined();
      const transcript = await fs.readFile(
        path.join(outputDir, 'speech-transcript.txt'),
        'utf-8',
      );
      expect(transcript).toContain('大家好。再见！');
      expect(transcript).not.toContain('再见！再见！');
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '3 段检测到重复退化已截断',
      );
    });

    it('marks segments beyond an exhausted budget instead of starting them', async () => {
      probe({ durationMs: 720_000 }); // 4 segments — one more than the pool
      const view: MediaPolicyToolConfigView = {
        getOmniPolicyToolsSettings: () => ({
          [OMNI_TRANSCRIBE_AUDIO_TOOL_NAME]: {
            runtime: { timeoutMs: 60 },
          },
        }),
      };
      mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
        // Outlive the whole 60ms budget inside the first wave of cuts.
        await new Promise((r) => setTimeout(r, 90));
        await fs.writeFile(args[args.length - 1], Buffer.from('audio'));
        return { code: 0, stderr: '' };
      });
      fetchReturnsSse('还行');
      const { result } = await run({}, new OmniTranscribeAudioTool(view));

      // Segment 4 was never cut — its budget was gone before it started.
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(3);
      expect(result.error).toBeUndefined();
      const transcript = await fs.readFile(
        path.join(outputDir, 'speech-transcript.txt'),
        'utf-8',
      );
      expect(transcript).toContain(
        '[09:00-12:00] （该段转写失败：时间预算耗尽）',
      );
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '（1 段失败）',
      );
    });

    it('marks a failed cut with a short message (no ffmpeg stderr leak)', async () => {
      mocks.runFfmpeg
        .mockResolvedValueOnce({ code: 187, stderr: 'very long stderr dump' })
        .mockImplementation(async (args: string[]) => {
          await fs.writeFile(args[args.length - 1], Buffer.from('audio'));
          return { code: 0, stderr: '' };
        });
      fetchReturnsSse('还行');
      const { result } = await run();

      expect(result.error).toBeUndefined();
      const transcript = await fs.readFile(
        path.join(outputDir, 'speech-transcript.txt'),
        'utf-8',
      );
      expect(transcript).toContain(
        '[00:00-02:13] （该段转写失败：切片失败（ffmpeg exit 187））',
      );
      expect(transcript).not.toContain('very long stderr dump');
    });
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
    [
      'chunkSeconds below minimum',
      { inputPath: '/tmp/a.wav', outputDir: '/tmp/x', chunkSeconds: 10 },
      /minimum|>= 30/i,
    ],
  ])('build rejects %s', (_name, params, message) => {
    expect(() => tool.build(params as never)).toThrow(message);
  });
});
