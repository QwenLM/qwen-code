/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Content } from '@google/genai';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { BaseLlmClient } from '../core/baseLlmClient.js';
import {
  AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { LlmChat } from '../core/llm-chat.js';
import { OpenAIContentGenerator } from '../core/openaiContentGenerator/openaiContentGenerator.js';
import { DefaultOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/default.js';
import { CompressionStatus } from '../core/turn.js';
import { preloadRuntimeFetchModule } from '../utils/runtimeFetchOptions.js';
import {
  COMPACT_MAX_OUTPUT_TOKENS,
  ChatCompressionService,
  MIN_COMPACTION_OUTPUT_TOKENS,
} from './chatCompressionService.js';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

type ServerHandler = (
  req: CapturedRequest,
  res: http.ServerResponse,
  attemptIndex: number,
) => void;

function writeSse(
  res: http.ServerResponse,
  chunks: Array<Record<string, unknown>>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function sseDeltaChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl-real-http',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseUsageChunk(
  model: string,
  usage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'chatcmpl-real-http',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    choices: [],
    usage,
  };
}

function createFakeChat(history: Content[]): LlmChat {
  return {
    getHistory: vi.fn((_curated?: boolean) => history),
    getHistoryShallow: vi.fn((_curated?: boolean) => history),
    setHistory: vi.fn(),
    getTools: vi.fn(() => []),
    getSystemInstruction: vi.fn(() => undefined),
    getGenerationConfig: vi.fn(() => ({})),
    recordHistory: vi.fn(),
  } as unknown as LlmChat;
}

describe('ChatCompressionService real local HTTP/SSE integration', () => {
  const servers: http.Server[] = [];

  beforeAll(async () => {
    await preloadRuntimeFetchModule();
  });

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function startMockGateway(handler: ServerHandler): Promise<{
    baseUrl: string;
    requests: CapturedRequest[];
  }> {
    const requests: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const captured: CapturedRequest = {
          url: req.url ?? '',
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        };
        const attemptIndex = requests.length;
        requests.push(captured);
        handler(captured, res, attemptIndex);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
  }

  function createRealRuntime(params: {
    baseUrl: string;
    model: string;
    contextWindowSize: number;
    extraBody?: Record<string, unknown>;
  }): { config: Config; service: ChatCompressionService } {
    const contentGeneratorConfig: ContentGeneratorConfig = {
      model: params.model,
      apiKey: 'test-local-key',
      baseUrl: params.baseUrl,
      authType: AuthType.USE_OPENAI,
      contextWindowSize: params.contextWindowSize,
      ...(params.extraBody ? { extra_body: params.extraBody } : {}),
    };

    const runtime: {
      baseLlmClient?: BaseLlmClient;
      generator?: OpenAIContentGenerator;
    } = {};
    const debugLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const config = {
      getModel: () => params.model,
      getContentGeneratorConfig: () => contentGeneratorConfig,
      getContentGenerator: () => runtime.generator!,
      getBaseLlmClient: () => runtime.baseLlmClient!,
      getDebugLogger: () => debugLogger,
      getSessionId: () => 'real-http-compression-session',
      getProxy: () => undefined,
      getUsageStatisticsEnabled: () => false,
      getChatCompression: () => ({}),
      getHookSystem: () => undefined,
      getOutputLanguage: () => 'en',
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getCliVersion: () => '0.0.0-test',
      getWorkingDir: () => process.cwd(),
      getTargetDir: () => process.cwd(),
      getEnableOpenAILogging: () => false,
      getOpenAILoggingDir: () => undefined,
      getTimeout: () => 30_000,
      getMaxRetries: () => 0,
      isOmniEnabled: () => false,
      getCompactionModel: () => undefined,
      getModelRegistry: () => undefined,
    } as unknown as Config;

    const provider = new DefaultOpenAICompatibleProvider(
      contentGeneratorConfig,
      config,
    );
    runtime.generator = new OpenAIContentGenerator(
      contentGeneratorConfig,
      config,
      provider,
    );
    runtime.baseLlmClient = new BaseLlmClient(runtime.generator, config);

    return { config, service: new ChatCompressionService() };
  }

  it('strips unsigned thoughts and flips extra_body.enable_thinking over real HTTP/SSE', async () => {
    const model = 'custom-reasoning-gateway-model';
    const { baseUrl, requests } = await startMockGateway((_req, res) => {
      writeSse(res, [
        sseDeltaChunk(
          model,
          {
            role: 'assistant',
            content:
              '<state_snapshot><overall_goal>port parser cleanly</overall_goal></state_snapshot>',
          },
          'stop',
        ),
        sseUsageChunk(model, {
          prompt_tokens: 4_200,
          completion_tokens: 420,
          total_tokens: 4_620,
        }),
      ]);
    });

    const { config, service } = createRealRuntime({
      baseUrl,
      model,
      contextWindowSize: 65_536,
      extraBody: { enable_thinking: true },
    });

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'original request: port the parser' }] },
    ];
    for (let i = 0; i < 12; i++) {
      history.push({
        role: 'model',
        parts: [
          { text: 'x'.repeat(16_000), thought: true },
          { text: `visible reply ${i}` },
        ],
      });
      history.push({ role: 'user', parts: [{ text: `follow up ${i}` }] });
    }
    history.push({
      role: 'model',
      parts: [
        { text: 'empty-sig thought', thought: true, thoughtSignature: '' },
      ],
    });
    history.push({ role: 'user', parts: [{ text: 'final check' }] });
    history.push({ role: 'model', parts: [{ text: 'done' }] });

    const result = await service.compress(createFakeChat(history), {
      promptId: 'real-http-p1',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: 55_000,
      signal: new AbortController().signal,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(requests).toHaveLength(1);
    const wire = requests[0]!.body;
    expect(wire['stream']).toBe(true);
    expect(wire['enable_thinking']).toBe(false);
    expect(wire['max_tokens']).toBe(COMPACT_MAX_OUTPUT_TOKENS);
    const serializedMessages = JSON.stringify(wire['messages']);
    expect(serializedMessages).not.toContain('x'.repeat(100));
    expect(serializedMessages).not.toContain('empty-sig thought');
    expect(serializedMessages).toContain('visible reply 0');
    expect(result.info.newTokenCount).toBeLessThan(10_000);
  });

  it('retries once with reduced input over real HTTP/SSE when a clamped budget exhausts inside <analysis>', async () => {
    const model = 'custom-clamped-gateway-model';
    const { baseUrl, requests } = await startMockGateway((req, res, idx) => {
      const maxTokens = Number(req.body['max_tokens']);
      if (idx === 0) {
        writeSse(res, [
          sseDeltaChunk(
            model,
            {
              role: 'assistant',
              content:
                '<analysis>exhausted clamped budget before writing snapshot',
            },
            'length',
          ),
          sseUsageChunk(model, {
            prompt_tokens: 54_000,
            completion_tokens: maxTokens,
            total_tokens: 54_000 + maxTokens,
          }),
        ]);
        return;
      }
      writeSse(res, [
        sseDeltaChunk(
          model,
          {
            role: 'assistant',
            content:
              '<state_snapshot><overall_goal>recovered via real HTTP retry</overall_goal></state_snapshot>',
          },
          'stop',
        ),
        sseUsageChunk(model, {
          prompt_tokens: 18_000,
          completion_tokens: 550,
          total_tokens: 18_550,
        }),
      ]);
    });

    const { config, service } = createRealRuntime({
      baseUrl,
      model,
      contextWindowSize: 65_536,
    });

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'investigate build failure' }] },
    ];
    for (let i = 0; i < 12; i++) {
      history.push({
        role: 'model',
        parts: [{ functionCall: { id: `c${i}`, name: 'run', args: {} } }],
      });
      history.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: `c${i}`,
              name: 'run',
              response: { output: `tool-${i}-` + 'z'.repeat(17_500) },
            },
          },
        ],
      });
    }
    history.push({ role: 'model', parts: [{ text: 'analysis complete' }] });

    const result = await service.compress(createFakeChat(history), {
      promptId: 'real-http-p2',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: 54_000,
      signal: new AbortController().signal,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(requests).toHaveLength(2);
    const firstBudget = Number(requests[0]!.body['max_tokens']);
    const secondBudget = Number(requests[1]!.body['max_tokens']);
    expect(firstBudget).toBeGreaterThanOrEqual(MIN_COMPACTION_OUTPUT_TOKENS);
    expect(firstBudget).toBeLessThan(COMPACT_MAX_OUTPUT_TOKENS);
    expect(secondBudget).toBeGreaterThan(firstBudget);
    expect(JSON.stringify(requests[1]!.body['messages']).length).toBeLessThan(
      JSON.stringify(requests[0]!.body['messages']).length,
    );
    expect(JSON.stringify(result.newHistory)).toContain(
      'recovered via real HTTP retry',
    );
  });

  it('reports OUTPUT_TRUNCATED over real HTTP/SSE when budget is exhausted in reasoning_content alone', async () => {
    const model = 'custom-reasoning-exhaust-model';
    const { baseUrl, requests } = await startMockGateway((req, res) => {
      const maxTokens = Number(req.body['max_tokens']);
      writeSse(res, [
        sseDeltaChunk(
          model,
          {
            role: 'assistant',
            reasoning_content: 'thinking until hitting output limit...',
          },
          'length',
        ),
        sseUsageChunk(model, {
          prompt_tokens: 10_000,
          completion_tokens: maxTokens,
          total_tokens: 10_000 + maxTokens,
          completion_tokens_details: { reasoning_tokens: maxTokens },
        }),
      ]);
    });

    const { config, service } = createRealRuntime({
      baseUrl,
      model,
      contextWindowSize: 65_536,
    });

    const result = await service.compress(
      createFakeChat([
        { role: 'user', parts: [{ text: 'fix the bug' }] },
        { role: 'model', parts: [{ text: 'investigating' }] },
      ]),
      {
        promptId: 'real-http-p3',
        force: true,
        config,
        consecutiveFailures: 0,
        originalTokenCount: 10_000,
        signal: new AbortController().signal,
      },
    );

    expect(requests).toHaveLength(1);
    expect(result.newHistory).toBeNull();
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
    );
  });

  it('learns required thinking on HTTP 400 and retries streaming compression to success over real HTTP/SSE', async () => {
    const model = 'custom-mandatory-thinking-model';
    const { baseUrl, requests } = await startMockGateway((req, res) => {
      if (req.body['enable_thinking'] === false) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'enable_thinking must be true for this model',
              type: 'invalid_request_error',
            },
          }),
        );
        return;
      }
      writeSse(res, [
        sseDeltaChunk(
          model,
          {
            role: 'assistant',
            content:
              '<state_snapshot><overall_goal>succeeded after required-thinking retry</overall_goal></state_snapshot>',
          },
          'stop',
        ),
        sseUsageChunk(model, {
          prompt_tokens: 2_000,
          completion_tokens: 300,
          total_tokens: 2_300,
        }),
      ]);
    });

    const { config, service } = createRealRuntime({
      baseUrl,
      model,
      contextWindowSize: 65_536,
      extraBody: { enable_thinking: true },
    });

    const result = await service.compress(
      createFakeChat([
        { role: 'user', parts: [{ text: 'summarize this session' }] },
        { role: 'model', parts: [{ text: 'all tasks completed' }] },
      ]),
      {
        promptId: 'real-http-p4',
        force: true,
        config,
        consecutiveFailures: 0,
        originalTokenCount: 2_000,
        signal: new AbortController().signal,
      },
    );

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body['enable_thinking']).toBe(false);
    expect(requests[1]!.body['enable_thinking']).toBe(true);
    expect(JSON.stringify(result.newHistory)).toContain(
      'succeeded after required-thinking retry',
    );
  });
});
