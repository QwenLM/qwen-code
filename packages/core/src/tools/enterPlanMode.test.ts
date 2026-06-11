/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnterPlanModeTool } from './enterPlanMode.js';
import { ApprovalMode, type Config } from '../config/config.js';

describe('EnterPlanModeTool', () => {
  let tool: EnterPlanModeTool;
  let mockConfig: Config;
  let approvalMode: ApprovalMode;
  let savedPrePlanMode: ApprovalMode | undefined;

  beforeEach(() => {
    approvalMode = ApprovalMode.DEFAULT;
    savedPrePlanMode = undefined;
    mockConfig = {
      getApprovalMode: vi.fn(() => approvalMode),
      getPrePlanMode: vi.fn(() => savedPrePlanMode ?? ApprovalMode.DEFAULT),
      setApprovalMode: vi.fn((mode: ApprovalMode) => {
        if (mode === ApprovalMode.PLAN && approvalMode !== ApprovalMode.PLAN) {
          savedPrePlanMode = approvalMode;
        }
        approvalMode = mode;
      }),
      isInteractive: vi.fn(() => true),
      getExperimentalZedIntegration: vi.fn(() => false),
      getInputFormat: vi.fn(() => undefined),
    } as unknown as Config;

    tool = new EnterPlanModeTool(mockConfig);
  });

  describe('constructor and metadata', () => {
    it('should have correct tool name', () => {
      expect(tool.name).toBe('enter_plan_mode');
      expect(EnterPlanModeTool.Name).toBe('enter_plan_mode');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('EnterPlanMode');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('think');
    });

    it('should not defer (always visible)', () => {
      expect(tool.shouldDefer).toBe(false);
    });

    it('should have empty-object schema', () => {
      expect(tool.schema.parametersJsonSchema).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      });
    });
  });

  describe('getDefaultPermission', () => {
    it('should always return allow', async () => {
      const invocation = tool.build({});
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('allow');
    });
  });

  describe('execute', () => {
    it('should switch from DEFAULT to PLAN and save prePlanMode', async () => {
      approvalMode = ApprovalMode.DEFAULT;
      const invocation = tool.build({});
      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(approvalMode).toBe(ApprovalMode.PLAN);
      expect(savedPrePlanMode).toBe(ApprovalMode.DEFAULT);
      expect(result.llmContent).toContain('Plan mode is now active');
    });

    it('should switch from AUTO_EDIT to PLAN', async () => {
      approvalMode = ApprovalMode.AUTO_EDIT;
      const invocation = tool.build({});
      await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(savedPrePlanMode).toBe(ApprovalMode.AUTO_EDIT);
    });

    it('should switch from AUTO to PLAN', async () => {
      approvalMode = ApprovalMode.AUTO;
      const invocation = tool.build({});
      await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(savedPrePlanMode).toBe(ApprovalMode.AUTO);
    });

    it('should switch from YOLO to PLAN', async () => {
      approvalMode = ApprovalMode.YOLO;
      const invocation = tool.build({});
      await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(savedPrePlanMode).toBe(ApprovalMode.YOLO);
    });

    it('should be idempotent: already in PLAN does not call setApprovalMode', async () => {
      approvalMode = ApprovalMode.PLAN;
      savedPrePlanMode = ApprovalMode.AUTO;
      const invocation = tool.build({});
      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
      expect(savedPrePlanMode).toBe(ApprovalMode.AUTO);
      expect(result.llmContent).toContain('Plan mode is now active');
    });

    it('should return error when setApprovalMode throws', async () => {
      (
        mockConfig.setApprovalMode as ReturnType<typeof vi.fn>
      ).mockImplementation(() => {
        throw new Error('trust gate');
      });
      const invocation = tool.build({});
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Failed to enter plan mode');
      expect(result.llmContent).toContain('trust gate');
    });
  });
});
