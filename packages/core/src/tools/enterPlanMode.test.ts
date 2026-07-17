/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnterPlanModeTool } from './enterPlanMode.js';
import { ApprovalMode, type Config } from '../config/config.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';

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

    it('should require user opt-in in the tool description', () => {
      expect(tool.description).toContain(
        'only after the user explicitly asks to switch into plan mode',
      );
      expect(tool.description).toContain(
        'If plan mode seems helpful but the user has not asked for it, ask first',
      );
      expect(tool.description).not.toContain(
        'before doing uncertain or complex work',
      );
      expect(tool.description).not.toContain('if complexity rises');
    });

    it('should not defer (always visible)', () => {
      expect(tool.shouldDefer).toBe(false);
    });

    it('should expose only the userRequested flag in its schema', () => {
      expect(tool.schema.parametersJsonSchema).toEqual({
        type: 'object',
        properties: {
          userRequested: {
            type: 'boolean',
            description: expect.stringContaining('ONLY when the user'),
          },
        },
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

    it('does not resync tool declarations when entering plan mode', async () => {
      const getToolRegistry = vi.fn();
      const getGeminiClient = vi.fn();
      Object.assign(mockConfig, { getToolRegistry, getGeminiClient });

      const result = await tool.build({}).execute(new AbortController().signal);

      expect(result.llmContent).toContain('Plan mode is now active');
      expect(getToolRegistry).not.toHaveBeenCalled();
      expect(getGeminiClient).not.toHaveBeenCalled();
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

    it('should not switch from YOLO to PLAN when the entry is unsolicited', async () => {
      // Regression: #5970. A YOLO user opted into low-friction execution;
      // silently switching to read-only Plan mode surprised them and then
      // blocked reads/writes they expected to proceed. A model-initiated
      // enter_plan_mode from YOLO must keep the current mode instead.
      approvalMode = ApprovalMode.YOLO;
      const invocation = tool.build({});
      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
      expect(approvalMode).toBe(ApprovalMode.YOLO);
      expect(savedPrePlanMode).toBeUndefined();
      expect(result.llmContent).toContain('YOLO');
      expect(result.llmContent).not.toContain('Plan mode is now active');
      // The model must be told how to honour an explicit user request.
      expect(result.llmContent).toContain('userRequested: true');
    });

    it('should not switch from YOLO to PLAN when userRequested is explicitly false', async () => {
      approvalMode = ApprovalMode.YOLO;
      const invocation = tool.build({ userRequested: false });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
      expect(approvalMode).toBe(ApprovalMode.YOLO);
      expect(result.llmContent).toContain('YOLO');
      expect(result.llmContent).not.toContain('Plan mode is now active');
      expect(result.returnDisplay).toContain('Stayed in YOLO');
    });

    it('should treat userRequested as inert outside YOLO (DEFAULT enters PLAN normally)', async () => {
      // Defensive: the flag only gates the YOLO no-op. If it ever gained
      // significance in other modes, this pins the expected behavior.
      approvalMode = ApprovalMode.DEFAULT;
      const invocation = tool.build({ userRequested: true });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(approvalMode).toBe(ApprovalMode.PLAN);
      expect(savedPrePlanMode).toBe(ApprovalMode.DEFAULT);
      expect(result.llmContent).toContain('Plan mode is now active');
    });

    it('should switch from YOLO to PLAN when the user explicitly requested it', async () => {
      // The tool description instructs the model to call this only after the
      // user asks, and `/plan` is interactive-only — so this tool is the only
      // door into plan mode for headless/ACP sessions. A blanket YOLO guard
      // would make an explicit user request unreachable there.
      approvalMode = ApprovalMode.YOLO;
      const invocation = tool.build({ userRequested: true });
      const result = await invocation.execute(new AbortController().signal);

      // Preserve the YOLO mode so an approved plan exit can restore it.
      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(approvalMode).toBe(ApprovalMode.PLAN);
      expect(savedPrePlanMode).toBe(ApprovalMode.YOLO);
      expect(result.llmContent).toContain('Plan mode is now active');
    });

    it('should honour a user-requested YOLO entry in an ACP session', async () => {
      // Headless + ACP: no `/plan`, no Shift+Tab. This tool is the only path.
      approvalMode = ApprovalMode.YOLO;
      (mockConfig.isInteractive as ReturnType<typeof vi.fn>).mockReturnValue(
        false,
      );
      (
        mockConfig.getExperimentalZedIntegration as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);

      const invocation = tool.build({ userRequested: true });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(approvalMode).toBe(ApprovalMode.PLAN);
      expect(result.llmContent).not.toContain('non-interactive');
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

    it('rejects inside subagent context without changing approval mode', async () => {
      approvalMode = ApprovalMode.DEFAULT;
      const invocation = tool.build({});

      const result = await runWithAgentContext('agent-1', () =>
        invocation.execute(new AbortController().signal),
      );

      expect(result.llmContent).toContain('not available inside subagents');
      expect(result.llmContent).toContain('return your plan');
      expect(result.error?.message).toBe(result.llmContent);
      expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
      expect(approvalMode).toBe(ApprovalMode.DEFAULT);
    });

    it('rejects inside teammate context without changing approval mode', async () => {
      approvalMode = ApprovalMode.AUTO_EDIT;
      const invocation = tool.build({});

      const result = await runWithTeammateIdentity(
        {
          agentId: 'agent@test',
          agentName: 'agent',
          teamName: 'test',
          isTeamLead: false,
        },
        () => invocation.execute(new AbortController().signal),
      );

      expect(result.llmContent).toContain('not available inside subagents');
      expect(result.llmContent).toContain('return your plan');
      expect(result.error?.message).toBe(result.llmContent);
      expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
      expect(approvalMode).toBe(ApprovalMode.AUTO_EDIT);
    });
  });
});
