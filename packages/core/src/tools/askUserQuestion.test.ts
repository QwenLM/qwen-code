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
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      getInputFormat: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    tool = new AskUserQuestionTool(mockConfig);
  });

  describe('tool registration flags', () => {
    it('is not deferred — must remain visible in the initial tool list', () => {
      // shouldDefer=true would hide the schema behind ToolSearch and force the
      // model to discover the tool by name before using it. The model then
      // tends to skip the structured clarification UX and ask in plain prose.
      expect(tool.shouldDefer).toBe(false);
    });
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

    it('should accept a header longer than 12 characters', () => {
      // The 12-char limit is guidance in the schema, not a hard constraint.
      // A slightly over-length header (e.g. "Target config", 13 chars) must
      // pass validation instead of bouncing the tool call back to the model;
      // the TUI truncates over-length headers for the chip/tab layout.
      const params = {
        questions: [
          {
            question: 'Test question?',
            header: 'Target config',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
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

    it('should accept params with multiSelect omitted', () => {
      const params = {
        questions: [
          {
            question: 'Pick a framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'A JavaScript library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
          },
        ],
      };

      expect(tool.validateToolParams(params)).toBeNull();
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should reject params where multiSelect is not a boolean', () => {
      const params = {
        questions: [
          {
            question: 'Pick a framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'A JavaScript library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
            multiSelect: 'yes' as unknown as boolean,
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBe('Question 1: "multiSelect" must be a boolean.');
    });
  });

  describe('getDefaultPermission and getConfirmationDetails', () => {
    it('should return ask permission and confirmation details in interactive mode', async () => {
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
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(confirmation.type).toBe('ask_user_question');
      if (confirmation.type === 'ask_user_question') {
        expect(confirmation.questions).toEqual(params.questions);
        expect(confirmation.onConfirm).toBeDefined();
      }
    });

    it('should return allow permission in non-interactive mode', async () => {
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
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('allow');
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
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      // Simulate user cancellation
      await confirmation.onConfirm(ToolConfirmationOutcome.Cancel);

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
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      // Simulate user providing answers
      await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: {
          '0': 'React',
          '1': 'TypeScript',
        },
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Framework**: React');
      expect(result.llmContent).toContain('Language**: TypeScript');
      expect(result.returnDisplay).toContain(
        'has provided the following answers:',
      );
    });

    it('should ignore answers with malformed question indexes', async () => {
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
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: {
          '0junk': 'React',
        },
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).not.toContain('Framework**: React');
      expect(result.llmContent).toContain('No valid answers were provided.');
    });

    it('should ignore non-canonical decimal answer indexes', async () => {
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
              { label: 'Python', description: 'General purpose language' },
            ],
            multiSelect: false,
          },
        ],
      };

      const invocation = tool.build(params);
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: {
          '01': 'TypeScript',
        },
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).not.toContain('Language**: TypeScript');
      expect(result.llmContent).toContain('No valid answers were provided.');
    });

    it('should ignore answers with out-of-range question indexes', async () => {
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
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: {
          '1': 'TypeScript',
        },
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).not.toContain('Question 2**: TypeScript');
      expect(result.llmContent).toContain('No valid answers were provided.');
    });
  });
});
