/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import {
  RuntimeDiagnosticsCollector,
  summarizeAnthropicWireRequest,
  summarizeOpenAIWireRequest,
} from './runtimeDiagnostics.js';

describe('RuntimeDiagnosticsCollector', () => {
  it('summarizes generate-content requests without retaining prompt text or tool args', () => {
    const collector = new RuntimeDiagnosticsCollector({
      enabled: true,
      now: () => '2026-05-19T00:00:00.000Z',
    });
    const request = {
      model: 'diagnostic-model',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'secret user prompt' }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'tool-1',
                name: 'read_file',
                response: { output: 'secret tool output' },
              },
            },
          ],
        },
      ],
      config: {
        systemInstruction: { parts: [{ text: 'secret system prompt' }] },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                description: 'Read file',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                },
              },
            ],
          },
        ],
      },
    } satisfies GenerateContentParameters;

    collector.recordGenerateContentRequest(request, {
      stream: true,
      source: 'generateContentStream',
    });

    const snapshot = collector.snapshot();
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.requests[0]).toMatchObject({
      index: 1,
      source: 'generateContentStream',
      model: 'diagnostic-model',
      stream: true,
      contents: {
        count: 2,
        roleCounts: { user: 2 },
        partCount: 2,
        textBytes: Buffer.byteLength('secret user prompt'),
        functionResponseCount: 1,
        functionResponseBytes: expect.any(Number),
      },
      systemInstructionBytes: Buffer.byteLength('secret system prompt'),
      tools: {
        count: 1,
        functionDeclarationCount: 1,
        schemaBytes: expect.any(Number),
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret user prompt');
    expect(JSON.stringify(snapshot)).not.toContain('secret tool output');
    expect(JSON.stringify(snapshot)).not.toContain('secret system prompt');
  });

  it('summarizes OpenAI wire requests by size and role only', () => {
    const summary = summarizeOpenAIWireRequest({
      model: 'wire-model',
      stream: true,
      messages: [
        { role: 'system', content: 'secret system' },
        { role: 'user', content: [{ type: 'text', text: 'secret user' }] },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'run_shell_command',
            description: 'Run shell command',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
            },
          },
        },
      ],
    });

    expect(summary).toMatchObject({
      model: 'wire-model',
      stream: true,
      messageCount: 2,
      messageBytesByRole: {
        system: Buffer.byteLength('secret system'),
        user: expect.any(Number),
      },
      toolsCount: 1,
      toolSchemaBytes: expect.any(Number),
      bodyBytes: expect.any(Number),
      topLevelKeys: ['messages', 'model', 'stream', 'tools'],
    });
    expect(JSON.stringify(summary)).not.toContain('secret system');
    expect(JSON.stringify(summary)).not.toContain('secret user');
  });

  it('summarizes Anthropic wire requests by size and role only', () => {
    const summary = summarizeAnthropicWireRequest({
      model: 'anthropic-wire-model',
      stream: true,
      system: [{ type: 'text', text: 'secret system' }],
      messages: [
        { role: 'user', content: 'secret user' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'run_shell_command',
              input: { command: 'secret command' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'run_shell_command',
          description: 'Run shell command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
          },
        },
      ],
      max_tokens: 1024,
    });

    expect(summary).toMatchObject({
      model: 'anthropic-wire-model',
      stream: true,
      messageCount: 2,
      messageBytesByRole: {
        user: Buffer.byteLength('secret user'),
        assistant: expect.any(Number),
      },
      systemBytes: expect.any(Number),
      toolsCount: 1,
      toolSchemaBytes: expect.any(Number),
      bodyBytes: expect.any(Number),
      topLevelKeys: [
        'max_tokens',
        'messages',
        'model',
        'stream',
        'system',
        'tools',
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('secret system');
    expect(JSON.stringify(summary)).not.toContain('secret user');
    expect(JSON.stringify(summary)).not.toContain('secret command');
  });

  it('aggregates tool use and tool result sizes without retaining payloads', () => {
    const collector = new RuntimeDiagnosticsCollector({ enabled: true });

    collector.recordToolUse('read_file', { path: '/private/path.txt' });
    collector.recordToolResult({
      name: 'read_file',
      callId: 'tool-1',
      resultBytes: 2048,
      isError: false,
    });
    collector.recordToolResult({
      name: 'run_shell_command',
      callId: 'tool-2',
      resultBytes: 512,
      isError: true,
    });

    const snapshot = collector.snapshot();
    expect(snapshot.tools).toMatchObject({
      toolUseCount: 1,
      toolResultCount: 2,
      toolResultErrorCount: 1,
      totalToolUseArgBytes: expect.any(Number),
      maxToolUseArgBytes: expect.any(Number),
      totalToolResultBytes: 2560,
      maxToolResultBytes: 2048,
      byName: {
        read_file: {
          uses: 1,
          argBytes: expect.any(Number),
          maxArgBytes: expect.any(Number),
          results: 1,
          errors: 0,
          resultBytes: 2048,
          maxResultBytes: 2048,
        },
        run_shell_command: {
          uses: 0,
          results: 1,
          errors: 1,
          resultBytes: 512,
          maxResultBytes: 512,
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('/private/path.txt');
  });
});
