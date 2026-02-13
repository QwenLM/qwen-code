/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AskUserQuestionTool } from './askUserQuestion.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';

describe('AskUserQuestionTool', () => {
  let mockConfig: Config;
  let tool: AskUserQuestionTool;

  beforeEach(() => {
    mockConfig = {
      isInteractive: vi.fn().mockReturnValue(true),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getTargetDir: vi.fn().mockReturnValue('/mock/dir'),
      getChatRecordingService: vi.fn(),
    } as unknown as Config;

    tool = new AskUserQuestionTool(mockConfig);
  });

  describe('validateToolParams', () => {
    it('should accept valid params with single question', () => {
      const params = {
        questions: [
          {
            question: 'What is your favorite color?',
            header: 'Color',
            options: [
              { label: 'Red', description: 'The color red' },
              { label: 'Blue', description: 'The color blue' },
            ],
            multiSelect: false,
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject params with too many questions', () => {
      const params = {
        questions: Array(5).fill({
          question: 'Test?',
          header: 'Test',
          options: [
            { label: 'A', description: 'Option A' },
            { label: 'B', description: 'Option B' },
          ],
          multiSelect: false,
        }),
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('between 1 and 4 questions');
    });

    it('should reject question with header too long', () => {
      const params = {
        questions: [
          {
            question: 'Test question?',
            header: 'ThisHeaderIsTooLong',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('12 characters or less');
    });

    it('should reject question with too few options', () => {
      const params = {
        questions: [
          {
            question: 'Test question?',
            header: 'Test',
            options: [{ label: 'A', description: 'Only one option' }],
            multiSelect: false,
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('between 2 and 4 options');
    });
  });

  describe('shouldConfirmExecute', () => {
    it('should return confirmation details in interactive mode', async () => {
      const params = {
        questions: [
          {
            question: 'Pick a framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'A JavaScript library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
            multiSelect: false,
          },
        ],
      };

      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(confirmation).not.toBe(false);
      if (confirmation && confirmation.type === 'ask_user_question') {
        expect(confirmation.type).toBe('ask_user_question');
        expect(confirmation.questions).toEqual(params.questions);
        expect(confirmation.onConfirm).toBeDefined();
      }
    });

    it('should return false in non-interactive mode', async () => {
      (mockConfig.isInteractive as Mock).mockReturnValue(false);

      const params = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(confirmation).toBe(false);
    });
  });

  describe('execute', () => {
    it('should return error in non-interactive mode', async () => {
      (mockConfig.isInteractive as Mock).mockReturnValue(false);

      const params = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('non-interactive mode');
      expect(result.returnDisplay).toContain('non-interactive mode');
    });

    it('should return cancellation message when user declines', async () => {
      const params = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      if (confirmation !== false) {
        // Simulate user cancellation
        await confirmation.onConfirm(ToolConfirmationOutcome.Cancel);
      }

      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toContain('declined to answer');
    });

    it('should return formatted answers when user provides them', async () => {
      const params = {
        questions: [
          {
            question: 'Pick a framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'A JavaScript library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
            multiSelect: false,
          },
          {
            question: 'Pick a language?',
            header: 'Language',
            options: [
              { label: 'TypeScript', description: 'Typed JavaScript' },
              { label: 'JavaScript', description: 'Plain JS' },
            ],
            multiSelect: false,
          },
        ],
      };

      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      if (confirmation !== false) {
        // Simulate user providing answers
        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
          answers: {
            '0': 'React',
            '1': 'TypeScript',
          },
        });
      }

      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Framework**: React');
      expect(result.llmContent).toContain('Language**: TypeScript');
      expect(result.returnDisplay).toContain(
        'has provided the following answers:',
      );
    });
  });
});
