/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  testProviderModelResolution,
  testModelProviderManager,
} from './provider-test-helpers.js';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getContentBlocks, isToolResultBlock } from './message-types.js';
import type { Message } from './message-types.js';
import type { ToolResultBlockParam } from '../protocol/transcript/message.js';
import { makeUser, makeAssistant } from './test-helpers.js';
import { DEFAULT_COMPRESSION_CONFIG } from './config.js';
import { applyToolResultBudget } from './tool-result-budget.js';
import { SHELL_TOOL_NAME } from '../tools/tool-names.js';
import { formatUnpersistedToolOutput } from '../utils/fileUtils.js';
import { createEmptyCompressionPipelineState } from './state-store.js';
import type { CompressionStageContext } from './types.js';

const tempDirs: string[] = [];

function getToolResult(message: Message, index: number) {
  const block = getContentBlocks(message)[index];
  if (!block || !isToolResultBlock(block)) {
    throw new Error(`缺少第 ${index} 个工具结果`);
  }
  return block;
}

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'compression-v2-budget-'),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createContext(tempDir: string): CompressionStageContext {
  return {
    input: {
      modelProviderManager: testModelProviderManager(),
      modelResolution: testProviderModelResolution('test-model'),
      history: [],
      requestPrefixMessages: [],
      promptTokenCount: 0,
      promptId: 'prompt-1',
      force: false,
      trigger: 'auto',
      autoCompactTracking: { consecutiveFailures: 0 },
      config: {
        getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
        getNextCompressionTruncationId: () => 1,
        getTruncateToolOutputThreshold: () => 120,
        getSessionId: () => 'session-main',
        storage: {
          getProjectTempDir: () => tempDir,
        },
      } as unknown as CompressionStageContext['input']['config'],
      target: 'main',
      rootSessionId: 'root-session-main',
      sessionScopeId: 'session-main',
    },
    state: createEmptyCompressionPipelineState(),
    boundary: {
      startIndex: 0,
      prefixContents: [],
      contents: [],
      source: 'initial_history',
    },
    fullHistory: [],
    workingHistory: [],
  };
}

describe('applyToolResultBudget', () => {
  it('preserves parallel fallback results on repeated persistence failure and retries after recovery', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    const blockedPath = path.join(tempDir, 'tool-outputs');
    fs.writeFileSync(blockedPath, 'block directory creation');
    const blocks: ToolResultBlockParam[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'tool_result',
      tool_use_id: `fallback-${i}`,
      content: formatUnpersistedToolOutput('x'.repeat(96_000), 50_000),
      is_error: false,
    }));
    const history: Message[] = [makeUser(blocks)];

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await applyToolResultBudget(history, context)).toBe(history);
      expect(context.state.replacementDecisions).toEqual({});
      // At least one selected result must remain eligible for retry.
      expect(context.state.seenFunctionResponseIds.length).toBeLessThan(5);
    }

    fs.unlinkSync(blockedPath);
    const recovered = await applyToolResultBudget(history, context);
    expect(recovered).not.toBe(history);
    expect(
      Object.keys(context.state.replacementDecisions).length,
    ).toBeGreaterThan(0);
    expect(context.state.seenFunctionResponseIds).toHaveLength(5);
    expect(getContentBlocks(history[0])).toEqual(blocks);
  });

  it('commits successful saves while preserving a sibling whose file cannot be written', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    // mkdir succeeds, but writeFile fails because the destination is a directory.
    const outputDir = path.join(tempDir, 'tool-outputs', 'session-session-main');
    const blockedFile = path.join(outputDir, 'unknown_tool_a.txt');
    fs.mkdirSync(blockedFile, { recursive: true });
    const history: Message[] = [
      makeUser(['a', 'b', 'c'].map((id) => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: id.repeat(150_000),
        is_error: false,
      }))),
    ];

    const result = await applyToolResultBudget(history, context);
    const blocks = getContentBlocks(result[0]) as ToolResultBlockParam[];
    expect(blocks[0].content).toBe('a'.repeat(150_000));
    expect(blocks[1].content).toContain('For full output see:');
    expect(
      fs.readFileSync(path.join(outputDir, 'unknown_tool_b.txt'), 'utf8'),
    ).toBe('b'.repeat(150_000));
    expect(context.state.replacementDecisions['a']).toBeUndefined();
    expect(context.state.seenFunctionResponseIds).not.toContain('a');
    expect(context.state.replacementDecisions['b']).toBe(blocks[1].content);
  });

  it('truncates tool results within a single message when over per-message budget', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    // 250K chars exceeds the 200K per-message budget
    const huge = 'x'.repeat(250_000);
    const history: Message[] = [
      makeAssistant([
        {
          type: 'tool_use',
          id: 'resp-1',
          name: SHELL_TOOL_NAME,
          input: {},
        },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-1',
          content: huge,
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const block = getToolResult(result[1], 0);

    expect(typeof block.content).toBe('string');
    expect(block.content).toContain('For full output see:');
    expect(block.content).not.toBe(huge);
    expect(context.state.replacementDecisions['resp-1']).toBe(block.content);
    expect(context.state.seenFunctionResponseIds).toContain('resp-1');
  });

  it('does not truncate results under the per-message budget', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    // 150K chars is under the 200K per-message budget
    const moderate = 'x'.repeat(150_000);
    const history: Message[] = [
      makeAssistant([
        {
          type: 'tool_use',
          id: 'resp-1',
          name: SHELL_TOOL_NAME,
          input: {},
        },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-1',
          content: moderate,
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const block = getToolResult(result[1], 0);

    expect(block.content).toBe(moderate);
    expect(context.state.replacementDecisions['resp-1']).toBeUndefined();
    expect(context.state.seenFunctionResponseIds).toContain('resp-1');
  });

  it('preserves image parts when truncating oversized text content', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    const image = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png',
        data: 'image-data',
      },
    };
    const history: Message[] = [
      makeAssistant([
        {
          type: 'tool_use',
          id: 'resp-image',
          name: SHELL_TOOL_NAME,
          input: {},
        },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-image',
          content: [
            { type: 'text', text: 'x'.repeat(250_000) },
            image,
            { type: 'text', text: 'trailing text' },
          ],
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const block = getToolResult(result[1], 0);

    expect(block.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('For full output see:'),
      },
      image,
    ]);
  });

  it('截断冻结的会话内容时保留缓存元数据且不修改原始结果', async () => {
    const context = createContext(makeTempDir());
    const cache_control = Object.freeze({
      type: 'ephemeral' as const,
      ttl: '1h',
    });
    const text = Object.freeze({
      type: 'text' as const,
      text: 'x'.repeat(250_000),
      cache_control,
    });
    const image = Object.freeze({
      type: 'image' as const,
      source: Object.freeze({
        type: 'url' as const,
        url: 'https://example.test/image.png',
      }),
      cache_control,
    });
    const content = Object.freeze([text, image]);
    const history = [
      makeAssistant([
        {
          type: 'tool_use',
          id: 'cached-result',
          name: SHELL_TOOL_NAME,
          input: {},
        },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'cached-result',
          content,
          is_error: false,
        },
      ]),
    ];
    const result = await applyToolResultBudget(history, context);
    const block = getContentBlocks(result[1])[0];
    if (block.type !== 'tool_result' || typeof block.content === 'string') {
      throw new Error('应保留结构化工具结果');
    }
    expect(block.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('For full output see:'),
      cache_control,
    });
    expect(block.content[1]).toBe(image);
    expect(block.content).not.toBe(content);
    expect(content[0]).toBe(text);
    expect(text.text).toHaveLength(250_000);
  });

  it('does not budget image-only tool results by base64 character size', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    const imageContent = [
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png',
          data: 'x'.repeat(250_000),
        },
      },
    ];
    const history: Message[] = [
      makeAssistant([
        {
          type: 'tool_use',
          id: 'resp-image-only',
          name: SHELL_TOOL_NAME,
          input: {},
        },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-image-only',
          content: imageContent,
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const block = getToolResult(result[1], 0);

    expect(block.content).toEqual(imageContent);
    expect(
      context.state.replacementDecisions['resp-image-only'],
    ).toBeUndefined();
  });

  it('evaluates messages independently — each turn has its own budget', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    // Two turns each with 150K — both under per-message 200K budget
    const turn1 = 'A'.repeat(150_000);
    const turn2 = 'B'.repeat(150_000);
    const history: Message[] = [
      makeAssistant([
        { type: 'tool_use', id: 'resp-1', name: 'cmd', input: {} },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-1',
          content: turn1,
          is_error: false,
        },
      ]),
      makeAssistant([
        { type: 'tool_use', id: 'resp-2', name: 'cmd', input: {} },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-2',
          content: turn2,
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const block1 = getToolResult(result[1], 0);
    const block2 = getToolResult(result[3], 0);

    // Both should be untouched — each is under the per-message budget
    expect(block1.content).toBe(turn1);
    expect(block2.content).toBe(turn2);
  });

  it('reuses frozen replacement decisions across runs (mustReapply)', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    const placeholder = 'placeholder output';
    context.state.replacementDecisions['resp-frozen'] = placeholder;
    // Also mark as seen so it's recognized as mustReapply
    context.state.seenFunctionResponseIds.push('resp-frozen');

    const history: Message[] = [
      makeAssistant([
        {
          type: 'tool_use',
          id: 'resp-frozen',
          name: SHELL_TOOL_NAME,
          input: {},
        },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-frozen',
          content: 'original output that should be replaced',
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const block = getToolResult(result[1], 0);
    expect(block.content).toBe(placeholder);
  });

  it('freezes previously-seen-but-not-replaced results (prompt cache protection)', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    // Mark resp-seen as seen but NOT in replacementDecisions → frozen state
    context.state.seenFunctionResponseIds.push('resp-seen');

    // 120K is under 200K budget alone, but even if budget were tight,
    // frozen results should never be truncated.
    const content = 'x'.repeat(120_000);
    const history: Message[] = [
      makeAssistant([
        { type: 'tool_use', id: 'resp-seen', name: 'cmd', input: {} },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-seen',
          content,
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const block = getToolResult(result[1], 0);

    // Should remain untouched — frozen results are not eligible for truncation
    expect(block.content).toBe(content);
    expect(context.state.replacementDecisions['resp-seen']).toBeUndefined();
  });

  it('selects the largest fresh result first when parallel results exceed budget', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    const larger = 'L'.repeat(160_000);
    const smaller = 'S'.repeat(90_000);
    // Together: 250K > 200K budget. Larger should be truncated first.
    const history: Message[] = [
      makeAssistant([
        {
          type: 'tool_use',
          id: 'resp-small',
          name: SHELL_TOOL_NAME,
          input: {},
        },
        {
          type: 'tool_use',
          id: 'resp-large',
          name: SHELL_TOOL_NAME,
          input: {},
        },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-small',
          content: smaller,
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'resp-large',
          content: larger,
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const smallBlock = getToolResult(result[1], 0);
    const largeBlock = getToolResult(result[1], 1);

    expect(smallBlock.content).toBe(smaller);
    expect(typeof largeBlock.content).toBe('string');
    expect(largeBlock.content).toContain('For full output see:');
    expect(largeBlock.content).not.toBe(larger);
    expect(context.state.replacementDecisions['resp-large']).toBe(
      largeBlock.content,
    );
    expect(context.state.replacementDecisions['resp-small']).toBeUndefined();
    // Both should be in seenIds
    expect(context.state.seenFunctionResponseIds).toContain('resp-small');
    expect(context.state.seenFunctionResponseIds).toContain('resp-large');
  });

  it('only truncates fresh candidates, not frozen ones, when over budget', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    // Mark resp-old as seen (frozen) — it was kept in a previous round
    context.state.seenFunctionResponseIds.push('resp-old');

    const frozenContent = 'F'.repeat(120_000);
    const freshContent = 'N'.repeat(120_000);
    // Together: 240K > 200K. But resp-old is frozen → only resp-new can be truncated.
    const history: Message[] = [
      makeAssistant([
        { type: 'tool_use', id: 'resp-old', name: 'cmd', input: {} },
        { type: 'tool_use', id: 'resp-new', name: 'cmd', input: {} },
      ]),
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-old',
          content: frozenContent,
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'resp-new',
          content: freshContent,
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    const oldBlock = getToolResult(result[1], 0);
    const newBlock = getToolResult(result[1], 1);

    // Frozen result stays intact
    expect(oldBlock.content).toBe(frozenContent);
    expect(context.state.replacementDecisions['resp-old']).toBeUndefined();

    // Fresh result is truncated
    expect(newBlock.content).toContain('For full output see:');
    expect(context.state.replacementDecisions['resp-new']).toBe(
      newBlock.content,
    );
  });

  it('returns the same array reference when no changes are needed', async () => {
    const tempDir = makeTempDir();
    const context = createContext(tempDir);
    const history: Message[] = [
      makeUser([
        {
          type: 'tool_result',
          tool_use_id: 'resp-1',
          content: 'small output',
          is_error: false,
        },
      ]),
    ];

    const result = await applyToolResultBudget(history, context);
    expect(result).toBe(history);
  });
});
