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
      getPlanGateState: vi.fn().mockReturnValue(undefined),
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

  describe('applyPlanGateMetadata', () => {
    const gateState = {
      entryId: 1,
      reviewCount: 3,
      gateMode: 'capped' as const,
      lastFindings: [],
      capEscalationPending: true,
      needsUserPending: false,
    };

    beforeEach(() => {
      (mockConfig.getPlanGateState as ReturnType<typeof vi.fn>).mockReturnValue(
        gateState,
      );
      gateState.gateMode = 'capped';
      gateState.reviewCount = 3;
      gateState.capEscalationPending = true;
      gateState.needsUserPending = false;
    });

    it('should set gateMode to uncapped on CONTINUE answer', async () => {
      const { CAP_ESCALATION_LABELS } = await import('../plan-gate/types.js');
      const params = {
        questions: [
          {
            question: 'Cap reached',
            header: 'Gate',
            options: [
              {
                label: CAP_ESCALATION_LABELS.CONTINUE,
                description: 'Keep going',
              },
              {
                label: CAP_ESCALATION_LABELS.APPROVE,
                description: 'Skip gate',
              },
            ],
          },
        ],
        metadata: { source: 'plan_gate_cap' },
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': CAP_ESCALATION_LABELS.CONTINUE },
      });
      await invocation.execute(new AbortController().signal);

      expect(gateState.gateMode).toBe('uncapped');
      expect(gateState.capEscalationPending).toBe(false);
    });

    it('should set gateMode to user_override on APPROVE answer', async () => {
      const { CAP_ESCALATION_LABELS } = await import('../plan-gate/types.js');
      const params = {
        questions: [
          {
            question: 'Cap reached',
            header: 'Gate',
            options: [
              {
                label: CAP_ESCALATION_LABELS.CONTINUE,
                description: 'Keep going',
              },
              {
                label: CAP_ESCALATION_LABELS.APPROVE,
                description: 'Skip gate',
              },
            ],
          },
        ],
        metadata: { source: 'plan_gate_cap' },
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': CAP_ESCALATION_LABELS.APPROVE },
      });
      await invocation.execute(new AbortController().signal);

      expect(gateState.gateMode).toBe('user_override');
    });

    it('should set gateMode to user_takeover on free-text answer', async () => {
      const params = {
        questions: [
          {
            question: 'Cap reached',
            header: 'Gate',
            options: [
              { label: 'Continue editing plan', description: 'Keep going' },
              { label: 'Approve execution', description: 'Skip gate' },
            ],
          },
        ],
        metadata: { source: 'plan_gate_cap' },
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': 'I want to change the approach entirely' },
      });
      await invocation.execute(new AbortController().signal);

      expect(gateState.gateMode).toBe('user_takeover');
    });

    it('should reset reviewCount on plan_gate_needs_user', async () => {
      gateState.needsUserPending = true;
      const params = {
        questions: [
          {
            question: 'What DB?',
            header: 'DB',
            options: [
              { label: 'Postgres', description: 'PG' },
              { label: 'MySQL', description: 'My' },
            ],
          },
        ],
        metadata: { source: 'plan_gate_needs_user' },
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': 'Postgres' },
      });
      await invocation.execute(new AbortController().signal);

      expect(gateState.reviewCount).toBe(0);
    });

    it('should ignore plan_gate_cap when capEscalationPending is false', async () => {
      gateState.capEscalationPending = false;
      const params = {
        questions: [
          {
            question: 'Cap reached',
            header: 'Gate',
            options: [
              { label: 'Continue editing plan', description: 'Keep going' },
              { label: 'Approve execution', description: 'Skip gate' },
            ],
          },
        ],
        metadata: { source: 'plan_gate_cap' },
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': 'Approve execution' },
      });
      await invocation.execute(new AbortController().signal);

      // gateMode should NOT change because capEscalationPending was false
      expect(gateState.gateMode).toBe('capped');
    });

    it('should reset reviewCount on plan_gate_needs_user when needsUserPending is true', async () => {
      gateState.needsUserPending = true;
      const params = {
        questions: [
          {
            question: 'What DB?',
            header: 'DB',
            options: [
              { label: 'Postgres', description: 'PG' },
              { label: 'MySQL', description: 'My' },
            ],
          },
        ],
        metadata: { source: 'plan_gate_needs_user' },
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': 'Postgres' },
      });
      await invocation.execute(new AbortController().signal);

      expect(gateState.reviewCount).toBe(0);
      expect(gateState.needsUserPending).toBe(false);
    });

    it('should ignore plan_gate_needs_user when needsUserPending is false', async () => {
      gateState.needsUserPending = false;
      const params = {
        questions: [
          {
            question: 'What DB?',
            header: 'DB',
            options: [
              { label: 'Postgres', description: 'PG' },
              { label: 'MySQL', description: 'My' },
            ],
          },
        ],
        metadata: { source: 'plan_gate_needs_user' },
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': 'Postgres' },
      });
      await invocation.execute(new AbortController().signal);

      // reviewCount should NOT be reset because needsUserPending was false
      expect(gateState.reviewCount).toBe(3);
    });

    it('should not mutate state when no metadata source', async () => {
      const params = {
        questions: [
          {
            question: 'Pick?',
            header: 'Choice',
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
          },
        ],
      };

      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { '0': 'A' },
      });
      await invocation.execute(new AbortController().signal);

      expect(gateState.gateMode).toBe('capped');
      expect(gateState.reviewCount).toBe(3);
    });
  });
});
