/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditTool, type EditToolParams } from '../tools/edit.js';
import { GlobTool, type GlobToolParams } from '../tools/glob.js';
import { ReadFileTool, type ReadFileToolParams } from '../tools/read-file.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  WriteFileTool,
  type WriteFileToolParams,
} from '../tools/write-file.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { getCoreSystemPrompt } from './prompts.js';

interface ExampleToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function examplesFor(style: 'qwen-coder' | 'qwen-vl'): string {
  vi.stubEnv('QWEN_CODE_TOOL_CALL_STYLE', style);
  const prompt = getCoreSystemPrompt();
  return prompt.slice(prompt.lastIndexOf('# Examples (Illustrating Tone'));
}

function parseValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseCoderCalls(prompt: string): ExampleToolCall[] {
  return Array.from(
    prompt.matchAll(
      /<tool_call>\s*<function=([^>]+)>\s*([\s\S]*?)<\/function>\s*<\/tool_call>/g,
    ),
    (match) => {
      const args: Record<string, unknown> = {};
      for (const param of match[2]!.matchAll(
        /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g,
      )) {
        args[param[1]!] = parseValue(param[2]!);
      }
      return { name: match[1]!, arguments: args };
    },
  );
}

function parseVlCalls(prompt: string): ExampleToolCall[] {
  return Array.from(
    prompt.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g),
    (match) => JSON.parse(match[1]!) as ExampleToolCall,
  );
}

describe('prompt tool call examples', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['qwen-coder', parseCoderCalls],
    ['qwen-vl', parseVlCalls],
  ] as const)(
    'keeps %s examples valid against current tool schemas',
    (style, parse) => {
      const config = makeFakeConfig();
      const validators: Record<
        string,
        (args: Record<string, unknown>) => string | null
      > = {
        [ToolNames.GLOB]: (args) =>
          new GlobTool(config).validateToolParams(
            args as unknown as GlobToolParams,
          ),
        [ToolNames.READ_FILE]: (args) =>
          new ReadFileTool(config).validateToolParams(
            args as unknown as ReadFileToolParams,
          ),
        [ToolNames.EDIT]: (args) =>
          new EditTool(config).validateToolParams(
            args as unknown as EditToolParams,
          ),
        [ToolNames.WRITE_FILE]: (args) =>
          new WriteFileTool(config).validateToolParams(
            args as unknown as WriteFileToolParams,
          ),
      };
      const calls = parse(examplesFor(style)).filter(
        (call) => validators[call.name],
      );

      expect(new Set(calls.map((call) => call.name))).toEqual(
        new Set(Object.keys(validators)),
      );
      for (const call of calls) {
        expect(
          validators[call.name]!(call.arguments),
          `${call.name} example arguments: ${JSON.stringify(call.arguments)}`,
        ).toBeNull();
      }
    },
  );
});
