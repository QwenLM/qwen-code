/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { runWithAgentContext } from '../utils/agentContext.js';
import { AskUserAsyncTool } from './ask-user-async.js';
import { AskUserTool } from './ask-user.js';
import type { Question } from './ask-user-types.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';

const question: Question = {
  question: 'Which approach?',
  header: 'Approach',
  options: [
    { label: 'A', description: 'First', preview: 'diff A' },
    { label: 'B', description: 'Second' },
  ],
  multiSelect: true,
};
const config = (plan = false) => ({
  isPlanMode: () => plan,
  isAsyncUserInteractionEnabled: () => true,
}) as Config;

describe('AskUserQuestionAsync', () => {
  it('publishes without confirmation or fabricated answers', async () => {
    const tool = new AskUserAsyncTool(config());
    const invocation = tool.build({ questions: [question] });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.data).toEqual({ status: 'published', questions: [question] });
    expect(result.toolUseResult).toEqual(result.data);
    expect(result.llmContent).toBe('Questions published. No user answer has been received. Replies will arrive as new user messages.');
    expect(result.returnDisplay).toBe('Questions published.');
    expect(result.data).not.toHaveProperty('answers');
    expect(tool.isReadOnly).toBe(true);
    expect(tool.isConcurrencySafe()).toBe(true);
  });

  it('keeps the question schema and rejects duplicates', () => {
    const asyncSchema = CORE_TOOL_SET.AskUserQuestionAsync.parametersJsonSchema as { properties: { questions: unknown } };
    const syncSchema = CORE_TOOL_SET.AskUserQuestion.parametersJsonSchema as { properties: { questions: unknown } };
    expect(asyncSchema.properties.questions).toEqual(syncSchema.properties.questions);
    const tool = new AskUserAsyncTool(config());
    expect(() => tool.build({ questions: [] })).toThrow();
    expect(() => tool.build({ questions: [question, question] })).toThrow();
    expect(() => tool.build({ questions: [question], answers: {} } as never)).toThrow();
  });

  it('rejects execution inside subagent and fork contexts', async () => {
    const invocation = new AskUserAsyncTool(config()).build({ questions: [question] });
    const result = await runWithAgentContext({ agentId: 'fork', agentType: 'fork' }, () =>
      invocation.execute(new AbortController().signal));
    expect(result.error?.message).toContain('only available in the main session');
    expect(result.data).toBeUndefined();
  });

  it('rejects excess question and option counts', () => {
    const tool = new AskUserAsyncTool(config());
    expect(() => tool.build({ questions: Array.from({ length: 5 }, (_, index) => ({ ...question, question: `Question ${index}` })) })).toThrow();
    expect(() => tool.build({ questions: [{ ...question, options: Array.from({ length: 5 }, (_, index) => ({ label: `Option ${index}`, description: 'Choice' })) }] })).toThrow();
  });

  it('keeps conditional Plan guidance stable without mutating shared schemas', () => {
    const before = CORE_TOOL_SET.AskUserQuestionAsync.description;
    expect(new AskUserAsyncTool(config()).getSchema()).toEqual(new AskUserAsyncTool(config(true)).getSchema());
    expect(new AskUserTool(config()).getSchema()).toEqual(new AskUserTool(config(true)).getSchema());
    expect(new AskUserAsyncTool(config(true)).getSchema().description).toContain('strongly prefer AskUserQuestion');
    expect(new AskUserTool(config()).getSchema().description).toContain('only available in Plan mode');
    expect(new AskUserTool(config()).getSchema().description).not.toContain('Outside Plan mode, use this tool');
    expect(new AskUserTool(config(true)).getSchema().description).toContain('An empty result is not a user choice or approval');
    expect(CORE_TOOL_SET.AskUserQuestionAsync.description).toBe(before);
  });
});
