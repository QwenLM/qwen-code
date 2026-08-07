/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { GenerateContentParameters } from '@google/genai';
import { GenerateContentResponse } from '@google/genai';
import type { ErrorHandler, PipelineConfig } from './types.js';
import { ContentGenerationPipeline } from './pipeline.js';
import { OpenAIContentConverter } from './converter.js';
import type { Config } from '../../config/config.js';
import type { AuthType, ContentGeneratorConfig } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';

const mockInvalidateByUrl = vi.hoisted(() => vi.fn());
const mockUploadCacheCtor = vi.hoisted(() => vi.fn());
const mockObjectStoreCtor = vi.hoisted(() => vi.fn());

vi.mock('openai');
vi.mock('./converter.js', () => ({
  OpenAIContentConverter: {
    convertGeminiRequestToOpenAI: vi.fn(),
    convertOpenAIResponseToGemini: vi.fn(),
    convertOpenAIChunkToGemini: vi.fn(),
    convertGeminiToolsToOpenAI: vi.fn(),
  },
}));
vi.mock('../../telemetry/loggers.js', () => ({
  logProtocolTagSanitized: vi.fn(),
}));
vi.mock('../../telemetry/gen-ai-request.js', () => ({
  reportOpenAiRequest: vi.fn(),
  reportOpenAiResponse: vi.fn(),
  reportOpenAiChunk: vi.fn(),
}));
vi.mock('../../omni/upload-cache.js', () => ({
  OmniUploadCache: class {
    constructor(...args: unknown[]) {
      mockUploadCacheCtor(...args);
    }

    invalidateByUrl = mockInvalidateByUrl;
  },
}));
vi.mock('../../omni/storage.js', () => ({
  OmniObjectStore: class {
    constructor(...args: unknown[]) {
      mockObjectStoreCtor(...args);
    }

    getOmniRootDir() {
      return '/tmp/omni-root';
    }
  },
}));

describe('ContentGenerationPipeline omni oss cache invalidation', () => {
  let pipeline: ContentGenerationPipeline;
  let mockConfig: PipelineConfig;
  let mockProvider: OpenAICompatibleProvider;
  let mockClient: OpenAI;
  let mockConverter: typeof OpenAIContentConverter;
  let mockErrorHandler: ErrorHandler;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  const request: GenerateContentParameters = {
    model: 'test-model',
    contents: [{ parts: [{ text: 'Describe the media' }], role: 'user' }],
  };
  const userPromptId = 'omni-prompt-id';

  /** Messages carrying oss:// media in all three OpenAI part shapes. */
  const ossMediaMessages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the media' },
        { type: 'image_url', image_url: { url: 'oss://bucket/image.png' } },
        { type: 'video_url', video_url: { url: 'oss://bucket/video.mp4' } },
        {
          type: 'input_audio',
          input_audio: { data: 'oss://bucket/audio.wav', format: 'wav' },
        },
      ],
    },
  ] as unknown as OpenAI.Chat.ChatCompletionMessageParam[];

  const nonOssMediaMessages = [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'https://example.com/image.png' },
        },
        {
          type: 'input_audio',
          input_audio: { data: 'data:audio/wav;base64,AAAA', format: 'wav' },
        },
      ],
    },
  ] as unknown as OpenAI.Chat.ChatCompletionMessageParam[];

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as unknown as OpenAI;

    mockConverter = OpenAIContentConverter;

    mockProvider = {
      buildClient: vi.fn().mockReturnValue(mockClient),
      buildRequest: vi.fn().mockImplementation((req) => req),
      buildHeaders: vi.fn().mockReturnValue({}),
      getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
    };

    mockErrorHandler = {
      handle: vi.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
      shouldSuppressErrorLogging: vi.fn().mockReturnValue(false),
    } as unknown as ErrorHandler;

    mockCliConfig = {
      isOmniEnabled: () => true,
      storage: { getQwenDir: () => '/tmp/qwen' },
    } as unknown as Config;

    mockContentGeneratorConfig = {
      model: 'test-model',
      authType: 'openai' as AuthType,
    } as ContentGeneratorConfig;

    mockConfig = {
      cliConfig: mockCliConfig,
      provider: mockProvider,
      contentGeneratorConfig: mockContentGeneratorConfig,
      errorHandler: mockErrorHandler,
    };

    pipeline = new ContentGenerationPipeline(mockConfig);
  });

  it('invalidates each distinct oss:// URL when a non-streaming request fails with a media download error', async () => {
    (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
      ossMediaMessages,
    );
    (mockClient.chat.completions.create as Mock).mockRejectedValue(
      new Error('Download the media resource timed out'),
    );

    await expect(pipeline.execute(request, userPromptId)).rejects.toThrow(
      'Download the media resource timed out',
    );

    expect(mockInvalidateByUrl).toHaveBeenCalledTimes(3);
    expect(mockInvalidateByUrl).toHaveBeenCalledWith('oss://bucket/image.png');
    expect(mockInvalidateByUrl).toHaveBeenCalledWith('oss://bucket/video.mp4');
    expect(mockInvalidateByUrl).toHaveBeenCalledWith('oss://bucket/audio.wav');
    // The cache is constructed without a scope: invalidation scans all
    // entries by URL.
    expect(mockUploadCacheCtor).toHaveBeenCalledWith('/tmp/omni-root');
  });

  it('invalidates when the stream fails mid-iteration with an oss-naming error', async () => {
    (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
      ossMediaMessages,
    );
    const emptyResponse = new GenerateContentResponse();
    (mockConverter.convertOpenAIChunkToGemini as Mock).mockReturnValue(
      emptyResponse,
    );
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield {
          id: 'chunk-1',
          choices: [{ delta: { content: 'partial' }, finish_reason: null }],
        } as OpenAI.Chat.ChatCompletionChunk;
        throw new Error(
          'Failed to resolve oss://bucket/image.png: resource not found',
        );
      },
    };
    (mockClient.chat.completions.create as Mock).mockResolvedValue(stream);

    const generator = await pipeline.executeStream(request, userPromptId);
    await expect(
      (async () => {
        for await (const _ of generator) {
          // Drain until the mid-stream error surfaces.
        }
      })(),
    ).rejects.toThrow('Failed to resolve oss://bucket/image.png');

    expect(mockInvalidateByUrl).toHaveBeenCalledTimes(3);
    expect(mockInvalidateByUrl).toHaveBeenCalledWith('oss://bucket/image.png');
  });

  it('invalidates when the stream reports an error_finish chunk naming the oss media', async () => {
    (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
      ossMediaMessages,
    );
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield {
          id: 'chunk-1',
          choices: [
            {
              delta: {
                content: 'Download the media resource timed out',
              },
              finish_reason: 'error_finish',
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletionChunk;
      },
    };
    (mockClient.chat.completions.create as Mock).mockResolvedValue(stream);

    const generator = await pipeline.executeStream(request, userPromptId);
    await expect(
      (async () => {
        for await (const _ of generator) {
          // Drain until the error_finish chunk surfaces as an error.
        }
      })(),
    ).rejects.toThrow('Download the media resource timed out');

    expect(mockInvalidateByUrl).toHaveBeenCalledTimes(3);
  });

  it('does not invalidate on 429/RESOURCE_EXHAUSTED even with oss media present', async () => {
    (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
      ossMediaMessages,
    );
    (mockClient.chat.completions.create as Mock).mockRejectedValue(
      Object.assign(
        new Error('RESOURCE_EXHAUSTED: quota exceeded for oss:// media'),
        { status: 429 },
      ),
    );

    await expect(pipeline.execute(request, userPromptId)).rejects.toThrow(
      'RESOURCE_EXHAUSTED',
    );

    expect(mockInvalidateByUrl).not.toHaveBeenCalled();
  });

  it('does not invalidate when the error merely contains the letters "oss" without the scheme', async () => {
    (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
      ossMediaMessages,
    );
    (mockClient.chat.completions.create as Mock).mockRejectedValue(
      new Error('connection loss detected'),
    );

    await expect(pipeline.execute(request, userPromptId)).rejects.toThrow(
      'connection loss detected',
    );

    expect(mockInvalidateByUrl).not.toHaveBeenCalled();
  });

  it('does not invalidate when the request carries no oss:// URLs', async () => {
    (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
      nonOssMediaMessages,
    );
    (mockClient.chat.completions.create as Mock).mockRejectedValue(
      new Error('Failed to resolve oss://bucket/other.png'),
    );

    await expect(pipeline.execute(request, userPromptId)).rejects.toThrow(
      'Failed to resolve',
    );

    expect(mockInvalidateByUrl).not.toHaveBeenCalled();
  });

  it('does not invalidate when omni is disabled', async () => {
    mockCliConfig = {
      isOmniEnabled: () => false,
      storage: { getQwenDir: () => '/tmp/qwen' },
    } as unknown as Config;
    pipeline = new ContentGenerationPipeline({
      ...mockConfig,
      cliConfig: mockCliConfig,
    });
    (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
      ossMediaMessages,
    );
    (mockClient.chat.completions.create as Mock).mockRejectedValue(
      new Error('Download the media resource timed out'),
    );

    await expect(pipeline.execute(request, userPromptId)).rejects.toThrow(
      'Download the media resource timed out',
    );

    expect(mockInvalidateByUrl).not.toHaveBeenCalled();
  });
});
