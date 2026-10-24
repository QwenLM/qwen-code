/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AskUserQuestionTool, type Question } from './askUserQuestion.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { InputFormat } from '../output/types.js';
import { ToolConfirmationOutcome } from './tools.js';

/** A two-option question; `multiSelect` is present only when passed. */
const testQuestion = (fields: Partial<Question> = {}): Question => ({
  question: 'Test?',
  header: 'Test',
  options: [
    { label: 'A', description: 'Option A' },
    { label: 'B', description: 'Option B' },
  ],
  ...fields,
});

const frameworkQuestion = (fields: Partial<Question> = {}): Question => ({
  question: 'Pick a framework?',
  header: 'Framework',
  options: [
    { label: 'React', description: 'A JavaScript library' },
    { label: 'Vue', description: 'Progressive framework' },
  ],
  ...fields,
});

const makeConfig = () => ({
  isInteractive: vi.fn().mockReturnValue(true),
  getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
  getTargetDir: vi.fn().mockReturnValue('/mock/dir'),
  getChatRecordingService: vi.fn(),
  getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
  getInputFormat: vi.fn().mockReturnValue(undefined),
  getSdkMode: vi.fn().mockReturnValue(false),
});

describe('AskUserQuestionTool', () => {
  let mockConfig: ReturnType<typeof makeConfig>;
  let tool: AskUserQuestionTool;

  beforeEach(() => {
    mockConfig = makeConfig();
    tool = new AskUserQuestionTool(mockConfig as unknown as Config);
  });

  const requiresInteraction = () =>
    tool.build({ questions: [testQuestion()] }).requiresUserInteraction?.();

  /** Builds, answers the confirmation dialog with `outcome`, then executes. */
  const answerAndRun = async (
    questions: Question[],
    outcome: ToolConfirmationOutcome,
    answers?: Record<string, string>,
  ) => {
    const invocation = tool.build({ questions });
    const signal = new AbortController().signal;
    const confirmation = await invocation.getConfirmationDetails(signal);
    await confirmation.onConfirm(outcome, answers && { answers });
    return invocation.execute(signal);
  };

  describe('tool registration flags', () => {
    it('is not deferred — must remain visible in the initial tool list', () => {
      // shouldDefer=true hides the schema behind the deferred-tool bridge; the
      // model then tends to skip the structured UX and ask in plain prose.
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
        questions: Array(5).fill(testQuestion({ multiSelect: false })),
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('between 1 and 4 questions');
    });

    it('should accept a header longer than 12 characters', () => {
      // The 12-char limit is schema guidance, not a hard constraint: a 13-char
      // header must pass instead of bouncing the call back to the model; the
      // TUI truncates over-length headers for the chip/tab layout.
      const params = {
        questions: [
          testQuestion({
            question: 'Test question?',
            header: 'Target config',
            multiSelect: false,
          }),
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject question with too few options', () => {
      const params = {
        questions: [
          testQuestion({
            question: 'Test question?',
            options: [{ label: 'A', description: 'Only one option' }],
            multiSelect: false,
          }),
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('between 2 and 4 options');
    });

    it('should accept params with multiSelect omitted', () => {
      const params = { questions: [frameworkQuestion()] };

      expect(tool.validateToolParams(params)).toBeNull();
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should reject params where multiSelect is not a boolean', () => {
      const params = {
        questions: [
          frameworkQuestion({ multiSelect: 'yes' as unknown as boolean }),
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBe('Question 1: "multiSelect" must be a boolean.');
    });
  });

  describe('getDefaultPermission and getConfirmationDetails', () => {
    it('should return ask permission and confirmation details in interactive mode', async () => {
      const params = { questions: [frameworkQuestion({ multiSelect: false })] };

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

    it('should require explicit user interaction', () => {
      const invocation = tool.build({ questions: [testQuestion()] });

      expect(invocation.requiresUserInteraction?.()).toBe(true);
      expect(invocation.canAutoApproveOnAllow?.()).toBe(false);
    });

    it('should not require unavailable interaction in plain non-interactive mode', () => {
      mockConfig.isInteractive.mockReturnValue(false);
      expect(requiresInteraction()).toBe(false);
    });

    it('should require interaction through the stream-json host', () => {
      mockConfig.isInteractive.mockReturnValue(false);
      mockConfig.getInputFormat.mockReturnValue(InputFormat.STREAM_JSON);
      // Only the SDK control system can answer; direct stream-json has no
      // responder, so the host arm has to say so explicitly.
      mockConfig.getSdkMode.mockReturnValue(true);
      expect(requiresInteraction()).toBe(true);
    });

    it('should require interaction through an ACP host', () => {
      mockConfig.isInteractive.mockReturnValue(false);
      mockConfig.getExperimentalZedIntegration.mockReturnValue(true);
      expect(requiresInteraction()).toBe(true);
    });

    it('should return allow permission in non-interactive mode', async () => {
      mockConfig.isInteractive.mockReturnValue(false);

      const invocation = tool.build({
        questions: [testQuestion({ multiSelect: false })],
      });
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('allow');
    });
  });

  describe('requiresUserInteraction', () => {
    const params = { questions: [frameworkQuestion({ multiSelect: false })] };

    it('requires the dialog in interactive mode so allow rules cannot skip it', () => {
      // A bare `ask_user_question` allow rule (a skill's `allowedTools`
      // grant, permissions.allow, "always allow") overrides the 'ask'
      // default at L4. Without this flag the scheduler would then run the
      // tool with no dialog and execute() would report "declined".
      const invocation = tool.build(params);
      expect(invocation.requiresUserInteraction?.()).toBe(true);
    });

    it('requires the dialog for ACP hosts that run non-interactively', () => {
      // stream-json only has a responder once the SDK control system is up,
      // so this arm has to say so explicitly — without getSdkMode() the case
      // reads as "ACP" but actually pins direct mode.
      mockConfig.isInteractive.mockReturnValue(false);
      mockConfig.getInputFormat.mockReturnValue('stream-json');
      mockConfig.getSdkMode.mockReturnValue(true);
      expect(tool.build(params).requiresUserInteraction?.()).toBe(true);

      mockConfig.getSdkMode.mockReturnValue(false);
      mockConfig.getInputFormat.mockReturnValue(undefined);
      mockConfig.getExperimentalZedIntegration.mockReturnValue(true);
      expect(tool.build(params).requiresUserInteraction?.()).toBe(true);
    });

    it('does not require a dialog in stream-json direct mode, which has no responder', () => {
      // No control system is built for a plain first stdin frame, so nothing
      // can answer a confirmation round. Claiming a host here parks the turn
      // in awaiting_approval forever.
      mockConfig.isInteractive.mockReturnValue(false);
      mockConfig.getInputFormat.mockReturnValue('stream-json');
      mockConfig.getSdkMode.mockReturnValue(false);
      expect(tool.build(params).requiresUserInteraction?.()).toBe(false);
    });

    it('does not require a dialog in headless mode, where nothing can prompt', () => {
      mockConfig.isInteractive.mockReturnValue(false);
      const invocation = tool.build(params);
      expect(invocation.requiresUserInteraction?.()).toBe(false);
    });
  });

  describe('execute', () => {
    it('distinguishes partial answers containing another question header', async () => {
      const questions = ['A', 'B'].map((header) => ({
        header,
        question: `Question ${header}?`,
        options: [
          { label: 'Yes', description: 'Continue' },
          { label: 'No', description: 'Stop' },
        ],
      }));
      const result = await answerAndRun(
        questions,
        ToolConfirmationOutcome.ProceedOnce,
        { '0': 'first\n**B**: embedded', invalid: 'ignored' },
      );

      expect(result.returnDisplay).toEqual({
        type: 'ask_user_question_answers',
        text: result.llmContent,
        answers: [
          { question: 'Question A?', answer: 'first\n**B**: embedded' },
        ],
      });
      expect(result.llmContent).toBe(
        'User has provided the following answers:\n\n**A**: first\n**B**: embedded',
      );
    });

    it('should return error in non-interactive mode', async () => {
      mockConfig.isInteractive.mockReturnValue(false);

      const invocation = tool.build({
        questions: [testQuestion({ multiSelect: false })],
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('non-interactive mode');
      expect(result.returnDisplay).toContain('non-interactive mode');
    });

    it('should return cancellation message when user declines', async () => {
      const result = await answerAndRun(
        [testQuestion({ multiSelect: false })],
        ToolConfirmationOutcome.Cancel,
      );
      expect(result.llmContent).toContain('declined to answer');
    });

    it('should return formatted answers when user provides them', async () => {
      const questions = [
        frameworkQuestion({ multiSelect: false }),
        {
          question: 'Pick a language?',
          header: 'Language',
          options: [
            { label: 'TypeScript', description: 'Typed JavaScript' },
            { label: 'JavaScript', description: 'Plain JS' },
          ],
          multiSelect: false,
        },
      ];
      const result = await answerAndRun(
        questions,
        ToolConfirmationOutcome.ProceedOnce,
        { '0': 'React', '1': 'TypeScript' },
      );

      expect(result.llmContent).toContain('Framework**: React');
      expect(result.llmContent).toContain('Language**: TypeScript');
      expect(result.returnDisplay).toEqual({
        type: 'ask_user_question_answers',
        text: result.llmContent,
        answers: [
          { question: 'Pick a framework?', answer: 'React' },
          { question: 'Pick a language?', answer: 'TypeScript' },
        ],
      });
    });

    it.each<[string, Question[], Record<string, string>, string]>([
      [
        'should ignore answers with malformed question indexes',
        [frameworkQuestion({ multiSelect: false })],
        { '0junk': 'React' },
        'Framework**: React',
      ],
      [
        'should ignore non-canonical decimal answer indexes',
        [
          frameworkQuestion({ multiSelect: false }),
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
        { '01': 'TypeScript' },
        'Language**: TypeScript',
      ],
      [
        'should ignore answers with out-of-range question indexes',
        [frameworkQuestion({ multiSelect: false })],
        { '1': 'TypeScript' },
        'Question 2**: TypeScript',
      ],
    ])('%s', async (_title, questions, answers, rejected) => {
      const result = await answerAndRun(
        questions,
        ToolConfirmationOutcome.ProceedOnce,
        answers,
      );

      expect(result.llmContent).not.toContain(rejected);
      expect(result.llmContent).toContain('No valid answers were provided.');
    });
  });
});
