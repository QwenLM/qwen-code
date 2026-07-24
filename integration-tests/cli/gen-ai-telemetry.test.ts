/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { TestRig } from '../test-helper.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

type TelemetryRecord = {
  name?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{ name?: string }>;
};

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
  );
const describeLocal = SKIP ? describe.skip : describe;

let rig: TestRig | undefined;
let server: FakeOpenAIServer | undefined;

function parseTelemetry(content: string): TelemetryRecord[] {
  return content
    .split(/}\n{/)
    .map((value, index, values) => {
      const prefix = index === 0 ? '' : '{';
      const suffix = index === values.length - 1 ? '' : '}';
      return `${prefix}${value}${suffix}`.trim();
    })
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [JSON.parse(value) as TelemetryRecord];
      } catch {
        return [];
      }
    });
}

function setEnvironment(
  values: Record<string, string | undefined>,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rig?.cleanup();
  rig = undefined;
});

describeLocal('GenAI telemetry fields', () => {
  it('exports aligned LLM and tool fields across a complete tool turn', async () => {
    server = await startFakeOpenAIServer(({ requestIndex }) =>
      requestIndex === 0
        ? {
            model: 'provider-model-tool',
            toolCalls: [
              fakeToolCall(
                'run_shell_command',
                { command: 'pwd' },
                'provider-call-123',
              ),
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 4,
              total_tokens: 24,
              prompt_tokens_details: { cached_tokens: 3 },
            },
          }
        : {
            model: 'provider-model-final',
            choices: [
              {
                index: 0,
                contentChunks: ['Tool ', 'completed.'],
                finishReason: 'stop',
              },
              {
                index: 1,
                content: 'Alternative final answer.',
                finishReason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 5,
              total_tokens: 35,
            },
          },
    );

    rig = new TestRig();
    rig.setup('gen-ai-telemetry', {
      settings: {
        security: { auth: { selectedType: 'openai' } },
        model: {
          name: 'request-model',
          generationConfig: {
            samplingParams: {
              n: 2,
              max_tokens: 128,
              temperature: 0,
              top_p: 0.8,
              frequency_penalty: -0.1,
              presence_penalty: 0.2,
              stop: ['END', 'DONE'],
            },
          },
        },
        ui: { enableFollowupSuggestions: false },
      },
    });

    const restoreEnvironment = setEnvironment({
      HOME: rig.testDir!,
      QWEN_HOME: join(rig.testDir!, '.qwen'),
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: server.baseUrl,
      OPENAI_MODEL: 'request-model',
      QWEN_MODEL: 'request-model',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
      DASHSCOPE_PROXY_BASE_URL: undefined,
      QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: 'true',
    });

    try {
      await rig.run(
        'Run the requested tool and then report completion.',
        '--output-format',
        'json',
      );
    } finally {
      restoreEnvironment();
    }

    const records = parseTelemetry(rig.readFile('telemetry.log'));
    const llmSpans = records.filter(
      (record) => record.name === 'qwen-code.llm_request',
    );
    expect(llmSpans).toHaveLength(2);

    const firstLlm = llmSpans[0]!.attributes!;
    const secondLlm = llmSpans[1]!.attributes!;
    expect(firstLlm).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'request-model',
      'gen_ai.request.choice.count': 2,
      'gen_ai.request.max_tokens': 128,
      'gen_ai.request.temperature': 0,
      'gen_ai.request.top_p': 0.8,
      'gen_ai.request.frequency_penalty': -0.1,
      'gen_ai.request.presence_penalty': 0.2,
      'gen_ai.request.stop_sequences': ['END', 'DONE'],
      'gen_ai.response.model': 'provider-model-tool',
      'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.usage.input_tokens': 20,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.cache_read.input_tokens': 3,
    });
    expect(secondLlm).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.choice.count': 2,
      'gen_ai.request.max_tokens': 128,
      'gen_ai.request.temperature': 0,
      'gen_ai.request.top_p': 0.8,
      'gen_ai.request.frequency_penalty': -0.1,
      'gen_ai.request.presence_penalty': 0.2,
      'gen_ai.request.stop_sequences': ['END', 'DONE'],
      'gen_ai.response.model': 'provider-model-final',
      'gen_ai.response.finish_reasons': ['stop', 'stop'],
      'gen_ai.usage.input_tokens': 30,
      'gen_ai.usage.output_tokens': 5,
    });
    expect(firstLlm['gen_ai.conversation.id']).toEqual(
      secondLlm['gen_ai.conversation.id'],
    );
    expect(firstLlm['gen_ai.conversation.id']).toEqual(expect.any(String));

    const firstRequest = server.requests[0]!.body;
    const firstInput = JSON.parse(
      firstLlm['gen_ai.input.messages'] as string,
    ) as Array<Record<string, unknown>>;
    const secondInput = JSON.parse(
      secondLlm['gen_ai.input.messages'] as string,
    ) as Array<Record<string, unknown>>;
    expect(firstInput.map((message) => message['role'])).toEqual(
      (firstRequest['messages'] as Array<Record<string, unknown>>).map(
        (message) => message['role'],
      ),
    );
    expect(
      JSON.stringify(firstInput).includes(
        'Run the requested tool and then report completion.',
      ),
    ).toBe(true);
    expect(
      secondInput.some(
        (message) =>
          message['role'] === 'tool' &&
          JSON.stringify(message).includes('provider-call-123'),
      ),
    ).toBe(true);
    expect(secondInput.length).toBeGreaterThan(firstInput.length);
    expect(firstLlm).not.toHaveProperty('gen_ai.system_instructions');
    expect(secondLlm).not.toHaveProperty('gen_ai.system_instructions');

    const rawTools = firstRequest['tools'] as Array<{
      type: string;
      function: {
        name: string;
        description?: string;
        parameters?: object;
      };
    }>;
    const toolDefinitions = JSON.parse(
      firstLlm['gen_ai.tool.definitions'] as string,
    ) as Array<Record<string, unknown>>;
    expect(toolDefinitions).toEqual(
      rawTools.map((tool) => ({
        type: tool.type,
        name: tool.function.name,
        ...(tool.function.description !== undefined
          ? { description: tool.function.description }
          : {}),
        ...(tool.function.parameters !== undefined
          ? { parameters: tool.function.parameters }
          : {}),
      })),
    );

    expect(JSON.parse(firstLlm['gen_ai.output.messages'] as string)).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'provider-call-123',
            name: 'run_shell_command',
            arguments: { command: 'pwd' },
          },
        ],
        finish_reason: 'tool_calls',
      },
    ]);
    expect(JSON.parse(secondLlm['gen_ai.output.messages'] as string)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Tool completed.' }],
        finish_reason: 'stop',
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Alternative final answer.' }],
        finish_reason: 'stop',
      },
    ]);

    for (const attributes of [firstLlm, secondLlm]) {
      expect(attributes).not.toHaveProperty('qwen-code.model');
      expect(attributes).not.toHaveProperty('response_id');
      expect(attributes).not.toHaveProperty('input_tokens');
      expect(attributes).not.toHaveProperty('output_tokens');
      expect(attributes).not.toHaveProperty('cached_input_tokens');
      expect(attributes).not.toHaveProperty('gen_ai.usage.cached_tokens');
      expect(attributes).not.toHaveProperty(
        'gen_ai.server.time_to_first_token',
      );
      expect(attributes).not.toHaveProperty('gen_ai.usage.reasoning_tokens');
      expect(attributes).not.toHaveProperty('choice_count');
      expect(attributes).not.toHaveProperty('max_tokens');
      expect(attributes).not.toHaveProperty('temperature');
      expect(attributes).not.toHaveProperty('top_p');
      expect(attributes).not.toHaveProperty('frequency_penalty');
      expect(attributes).not.toHaveProperty('presence_penalty');
      expect(attributes).not.toHaveProperty('stop_sequences');
      expect(attributes).not.toHaveProperty('system_prompt');
      expect(attributes).not.toHaveProperty('tools');
      expect(attributes).not.toHaveProperty('tools_count');
      expect(attributes).not.toHaveProperty('response.model_output');
    }
    expect(records.flatMap((record) => record.events ?? [])).not.toContainEqual(
      expect.objectContaining({ name: 'tool_schema' }),
    );

    expect(server.requests).toHaveLength(2);
    for (const { body } of server.requests) {
      expect(body).toMatchObject({
        n: 2,
        max_tokens: 128,
        temperature: 0,
        top_p: 0.8,
        frequency_penalty: -0.1,
        presence_penalty: 0.2,
        stop: ['END', 'DONE'],
      });
    }

    const toolSpan = records.find(
      (record) =>
        record.name === 'qwen-code.tool' &&
        record.attributes?.['gen_ai.tool.name'] === 'run_shell_command',
    );
    expect(toolSpan?.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'run_shell_command',
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': 'provider-call-123',
      'tool.call_id': 'provider-call-123',
    });
    expect(toolSpan?.attributes?.['gen_ai.tool.description']).toEqual(
      expect.any(String),
    );
    expect(
      JSON.parse(
        toolSpan?.attributes?.['gen_ai.tool.call.arguments'] as string,
      ),
    ).toEqual({ command: 'pwd' });
    expect(
      JSON.parse(toolSpan?.attributes?.['gen_ai.tool.call.result'] as string),
    ).toMatchObject({ output: expect.any(String) });
    expect(toolSpan?.attributes).not.toHaveProperty('tool.name');
    expect(toolSpan?.attributes).not.toHaveProperty('tool_input');
    expect(toolSpan?.attributes).not.toHaveProperty('tool_result');
  });

  it('omits the default choice count from the exported span', async () => {
    server = await startFakeOpenAIServer(() => ({
      model: 'provider-model',
      content: 'Done.',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    }));

    rig = new TestRig();
    rig.setup('gen-ai-default-choice-count', {
      settings: {
        security: { auth: { selectedType: 'openai' } },
        model: {
          name: 'request-model',
          generationConfig: {
            samplingParams: { n: 1 },
          },
        },
        ui: { enableFollowupSuggestions: false },
      },
    });

    const restoreEnvironment = setEnvironment({
      HOME: rig.testDir!,
      QWEN_HOME: join(rig.testDir!, '.qwen'),
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: server.baseUrl,
      OPENAI_MODEL: 'request-model',
      QWEN_MODEL: 'request-model',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
      DASHSCOPE_PROXY_BASE_URL: undefined,
      QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: 'false',
    });

    try {
      await rig.run('Reply with done.', '--output-format', 'json');
    } finally {
      restoreEnvironment();
    }

    expect(server.requests.length).toBeGreaterThan(0);
    for (const { body } of server.requests) {
      expect(body).toMatchObject({ n: 1 });
    }

    const records = parseTelemetry(rig.readFile('telemetry.log'));
    const llmSpans = records.filter(
      (record) => record.name === 'qwen-code.llm_request',
    );
    expect(llmSpans).toHaveLength(server.requests.length);
    for (const llmSpan of llmSpans) {
      expect(llmSpan.attributes).not.toHaveProperty(
        'gen_ai.request.choice.count',
      );
      expect(llmSpan.attributes).not.toHaveProperty('gen_ai.input.messages');
      expect(llmSpan.attributes).not.toHaveProperty('gen_ai.output.messages');
      expect(llmSpan.attributes).not.toHaveProperty(
        'gen_ai.system_instructions',
      );
      expect(llmSpan.attributes).not.toHaveProperty('gen_ai.tool.definitions');
    }
  });
});
