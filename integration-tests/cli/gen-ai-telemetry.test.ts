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
            content: 'Tool completed.',
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
        model: { name: 'request-model' },
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
      'gen_ai.response.model': 'provider-model-tool',
      'gen_ai.response.finish_reasons': ['STOP'],
      'gen_ai.usage.input_tokens': 20,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.cache_read.input_tokens': 3,
      cached_input_tokens: 3,
    });
    expect(secondLlm).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.response.model': 'provider-model-final',
      'gen_ai.response.finish_reasons': ['STOP'],
      'gen_ai.usage.input_tokens': 30,
      'gen_ai.usage.output_tokens': 5,
    });
    expect(firstLlm['gen_ai.conversation.id']).toEqual(
      secondLlm['gen_ai.conversation.id'],
    );
    expect(firstLlm['gen_ai.conversation.id']).toEqual(expect.any(String));

    for (const attributes of [firstLlm, secondLlm]) {
      expect(attributes).not.toHaveProperty('qwen-code.model');
      expect(attributes).not.toHaveProperty('response_id');
      expect(attributes).not.toHaveProperty('gen_ai.usage.cached_tokens');
      expect(attributes).not.toHaveProperty(
        'gen_ai.server.time_to_first_token',
      );
      expect(attributes).not.toHaveProperty('gen_ai.usage.reasoning_tokens');
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
    expect(toolSpan?.attributes).not.toHaveProperty('tool.name');
  });
});
