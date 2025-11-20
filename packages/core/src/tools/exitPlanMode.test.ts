/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExitPlanModeTool, type ExitPlanModeParams } from './exitPlanMode.js';
import { ApprovalMode, type Config } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';

describe('ExitPlanModeTool', () => {
  let tool: ExitPlanModeTool;
  let mockConfig: Config;
  let approvalMode: ApprovalMode;

  beforeEach(() => {
    approvalMode = ApprovalMode.PLAN;
    mockConfig = {
      getApprovalMode: vi.fn(() => approvalMode),
      setApprovalMode: vi.fn((mode: ApprovalMode) => {
        approvalMode = mode;
      }),
    } as unknown as Config;

    tool = new ExitPlanModeTool(mockConfig);
  });

  describe('constructor and metadata', () => {
    it('should have correct tool name', () => {
      expect(tool.name).toBe('exit_plan_mode');
      expect(ExitPlanModeTool.Name).toBe('exit_plan_mode');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('ExitPlanMode');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('think');
    });

    it('should have correct schema', () => {
      expect(tool.schema).toEqual({
        name: 'exit_plan_mode',
        description: expect.stringContaining(
          'Use this tool when you are in plan mode',
        ),
        parametersJsonSchema: {
          type: 'object',
          properties: {
            plan: {
              type: 'string',
              description: expect.stringContaining('The plan you came up with'),
            },
          },
          required: ['plan'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
        },
      });
    });
  });

  describe('validateToolParams', () => {
    it('should accept valid parameters', () => {
      const params: ExitPlanModeParams = {
        plan: 'This is a comprehensive plan for the implementation.',
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject missing plan parameter', () => {
      const params = {} as ExitPlanModeParams;

      const result = tool.validateToolParams(params);
      expect(result).toBe('Parameter "plan" must be a non-empty string.');
    });

    it('should reject empty plan parameter', () => {
      const params: ExitPlanModeParams = {
        plan: '',
      };

      const result = tool.validateToolParams(params);
      expect(result).toBe('Parameter "plan" must be a non-empty string.');
    });

    it('should reject whitespace-only plan parameter', () => {
      const params: ExitPlanModeParams = {
        plan: '   \n\t  ',
      };

      const result = tool.validateToolParams(params);
      expect(result).toBe('Parameter "plan" must be a non-empty string.');
    });

    it('should reject non-string plan parameter', () => {
      const params = {
        plan: 123,
      } as unknown as ExitPlanModeParams;

      const result = tool.validateToolParams(params);
      expect(result).toBe('Parameter "plan" must be a non-empty string.');
    });
  });

  describe('tool execution', () => {
    it('should execute successfully through tool interface after approval', async () => {
      const params: ExitPlanModeParams = {
        plan: 'This is my implementation plan:\n1. Step 1\n2. Step 2\n3. Step 3',
      };
      const signal = new AbortController().signal;

      // Use the tool's public build method
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);

      const confirmation = await invocation.shouldConfirmExecute(signal);
      expect(confirmation).toMatchObject({
        type: 'plan',
        title: 'Would you like to proceed?',
        plan: params.plan,
      });

      if (confirmation) {
        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }

      const result = await invocation.execute(signal);

      expect(result.llmContent).toContain(
        'User has approved your plan. You can now start coding',
      );
      expect(result.returnDisplay).toEqual({
        type: 'plan_summary',
        message: 'User approved the plan.',
        plan: params.plan,
      });

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.DEFAULT,
      );
      expect(approvalMode).toBe(ApprovalMode.DEFAULT);
    });

    it('should request confirmation with plan details', async () => {
      const params: ExitPlanModeParams = {
        plan: 'Simple plan',
      };
      const signal = new AbortController().signal;

      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(signal);

      if (confirmation) {
        expect(confirmation.type).toBe('plan');
        if (confirmation.type === 'plan') {
          expect(confirmation.plan).toBe(params.plan);
        }

        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedAlways);
      }

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.AUTO_EDIT,
      );
      expect(approvalMode).toBe(ApprovalMode.AUTO_EDIT);
    });

    it('should remain in plan mode when confirmation is rejected', async () => {
      const params: ExitPlanModeParams = {
        plan: 'Remain in planning',
      };
      const signal = new AbortController().signal;

      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(signal);

      if (confirmation) {
        await confirmation.onConfirm(ToolConfirmationOutcome.Cancel);
      }

      const result = await invocation.execute(signal);

      expect(result.llmContent).toBe(
        'Plan execution was not approved. Remaining in plan mode.',
      );
      expect(result.returnDisplay).toBe(
        'Plan execution was not approved. Remaining in plan mode.',
      );

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(approvalMode).toBe(ApprovalMode.PLAN);
    });

    it('should have correct description', () => {
      const params: ExitPlanModeParams = {
        plan: 'Test plan',
      };

      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe(
        'Present implementation plan for user approval',
      );
    });

    it('should return empty tool locations', () => {
      const params: ExitPlanModeParams = {
        plan: 'Test plan',
      };

      const invocation = tool.build(params);
      expect(invocation.toolLocations()).toEqual([]);
    });
  });

  describe('tool description', () => {
    it('should contain usage guidelines', () => {
      expect(tool.description).toContain(
        'Only use this tool when the task requires planning',
      );
      expect(tool.description).toContain(
        'Do not use the exit plan mode tool because you are not planning',
      );
      expect(tool.description).toContain(
        'Use the exit plan mode tool after you have finished planning',
      );
    });

    it('should contain examples', () => {
      expect(tool.description).toContain(
        'Search for and understand the implementation of vim mode',
      );
      expect(tool.description).toContain('Help me implement yank mode for vim');
    });
  });
});
