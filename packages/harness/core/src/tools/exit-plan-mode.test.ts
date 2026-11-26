/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExitPlanModeTool } from './exit-plan-mode.js';
import path from 'node:path';
import type { Config } from '../config/config.js';
import * as fs from 'node:fs';
import os from 'node:os';
import { validatePlanPath } from '../utils/planUtils.js';

describe('ExitPlanModeTool', () => {
  let tool: ExitPlanModeTool;
  let mockConfig: Partial<Config>;
  let tempRootDir: string;
  let mockPlansDir: string;
  /** The plan file path that the mock planStateManager returns. */
  let defaultPlanFilePath: string;

  const SESSION_ID = 'test-session-123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    tempRootDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'exit-plan-test-')),
    );
    const plansDirRaw = path.join(tempRootDir, 'plans');
    fs.mkdirSync(plansDirRaw, { recursive: true });
    mockPlansDir = fs.realpathSync(plansDirRaw);

    // Default plan file the mock planStateManager will return.
    defaultPlanFilePath = path.join(mockPlansDir, 'test-plan.md');

    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue(tempRootDir),
      setPermissionMode: vi.fn(),
      setApprovedPlanPath: vi.fn(),
      getSessionId: vi.fn().mockReturnValue(SESSION_ID),
      getPermissionMode: vi.fn().mockReturnValue('default'),
      isPlanMode: vi.fn().mockReturnValue(true),
      storage: {
        getPlansDir: vi.fn().mockReturnValue(mockPlansDir),
      } as unknown as Config['storage'],
      planStateManager: {
        getPlanFilePath: vi.fn().mockReturnValue(defaultPlanFilePath),
        exit: vi.fn(),
      } as unknown as Config['planStateManager'],
      notifyPlanStateChanged: vi.fn(),
      isInteractive: vi.fn().mockReturnValue(true),
    };
    tool = new ExitPlanModeTool(mockConfig as Config);
  });

  afterEach(() => {
    if (fs.existsSync(tempRootDir)) {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Write content to the default plan file and return its path. */
  const writePlanFile = (content: string): string => {
    fs.writeFileSync(defaultPlanFilePath, content);
    return defaultPlanFilePath;
  };

  describe('execute — direct (permission pipeline)', () => {
    it.each(['# Plan', '   '])(
      'creates a Goal on the supplied Config for plan %j',
      async (content) => {
        const setGoal = vi.fn();
        mockConfig.getGoalManager = vi.fn().mockReturnValue({ setGoal });
        writePlanFile(content);
        const result = await tool
          .build({ approved: true, startGoal: true })
          .execute(new AbortController().signal);
        expect(setGoal).toHaveBeenCalledWith({
          objective: `Execute the approved plan from ${defaultPlanFilePath}`,
        });
        expect(result.toolUseResult).toMatchObject({ status: 'approved' });
        expect(result.returnDisplay).not.toContain('Goal loop activation failed');
      },
    );

    it('should approve with DEFAULT mode after an explicit review decision', async () => {
      writePlanFile('# Content');
      const invocation = tool.build({ approved: true });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('approved');
      expect(result.returnDisplay).toContain('Plan approved');
      expect(mockConfig.setPermissionMode).not.toHaveBeenCalled();
      expect(mockConfig.notifyPlanStateChanged).toHaveBeenCalledWith(
        'review_approved',
      );
      expect(mockConfig.setApprovedPlanPath).toHaveBeenCalledWith(
        defaultPlanFilePath,
      );
    });

    it('does not report a Plan review when policy auto-allows execution', async () => {
      writePlanFile('# Content');
      const invocation = tool.build({});

      await invocation.execute(new AbortController().signal);
    });

    it('should return empty-plan message when plan file is empty at execute time', async () => {
      writePlanFile('   '); // whitespace only — trim() → ''
      const invocation = tool.build({});
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toBe(
        'User has approved exiting plan mode. You can now proceed.',
      );
      expect(result.toolUseResult).toMatchObject({
        plan: null,
        isAgent: false,
        status: 'approved',
        filePath: defaultPlanFilePath,
      });
    });

    it('should persist rejected status and feedback when user rejects with feedback', async () => {
      writePlanFile('# Content');
      const invocation = tool.build({
        approved: false,
        feedback: 'Add tests before implementation',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Plan rejected. User feedback');
      expect(result.returnDisplay).toBe(
        'Feedback: Add tests before implementation',
      );
      expect(result.toolUseResult).toEqual({
        plan: '# Content',
        isAgent: false,
        status: 'rejected',
        filePath: defaultPlanFilePath,
        feedback: 'Add tests before implementation',
      });
    });

    it('should persist rejected status when user rejects without feedback', async () => {
      writePlanFile('# Content');
      const invocation = tool.build({ approved: false });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain(
        'Plan rejected. No feedback provided',
      );
      expect(result.returnDisplay).toBe('Rejected (no feedback)');
      expect(result.toolUseResult).toEqual({
        plan: '# Content',
        isAgent: false,
        status: 'rejected',
        filePath: defaultPlanFilePath,
      });
    });

    it('should persist a null plan when the rejected plan file cannot be read', async () => {
      const invocation = tool.build({
        approved: false,
        feedback: 'Add tests before implementation',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.toolUseResult).toEqual({
        plan: null,
        isAgent: false,
        status: 'rejected',
        filePath: defaultPlanFilePath,
        feedback: 'Add tests before implementation',
      });
    });
  });

  describe('mode preservation after plan exit', () => {
    it('does not change permission mode when exiting plan mode', async () => {
      writePlanFile('# Content');
      const invocation = tool.build({});

      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.setPermissionMode).not.toHaveBeenCalled();
      expect(result.llmContent).toContain('approved');
    });
  });

  describe('validateToolParams', () => {
    it('should always return null (no required params)', () => {
      expect(tool.validateToolParams({})).toBeNull();
      expect(tool.validateToolParams({ allowedPrompts: [] })).toBeNull();
    });

    it('should accept JSON string allowedPrompts and write back an array', () => {
      const params = {
        allowedPrompts: JSON.stringify([
          { tool: 'Bash', prompt: 'run tests' },
        ]),
      } as unknown as Parameters<ExitPlanModeTool['validateToolParams']>[0];

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.allowedPrompts).toEqual([
        { tool: 'Bash', prompt: 'run tests' },
      ]);
    });

    it('should reject when not in plan mode', () => {
      mockConfig.isPlanMode = vi.fn().mockReturnValue(false);
      mockConfig.getPermissionMode = vi.fn().mockReturnValue('default');
      const error = tool.validateToolParams({});
      expect(error).toContain('not in plan mode');
    });

    it('should reject when not in plan mode even with bypassPermissions', () => {
      mockConfig.isPlanMode = vi.fn().mockReturnValue(false);
      mockConfig.getPermissionMode = vi
        .fn()
        .mockReturnValue('bypassPermissions');
      const error = tool.validateToolParams({});
      expect(error).toContain('not in plan mode');
    });

    it('should fail tool.build when invoked outside plan mode', () => {
      mockConfig.isPlanMode = vi.fn().mockReturnValue(false);
      mockConfig.getPermissionMode = vi.fn().mockReturnValue('default');
      let thrown: unknown;
      try {
        tool.build({});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/not in plan mode/);
      const data = (thrown as Error & { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        tool_error_stage: 'parameter_validation',
        tool_error_subtype: 'tool_state',
      });
      expect(JSON.parse(data['tool_error_details_json'] as string)).toEqual({
        schema_version: 1,
        validation_source: 'custom',
        constraint_category: 'plan_mode_inactive',
        quality: 'precise',
        validation_phase: 'build',
      });
    });
  });

  describe('path validation utilities', () => {
    it('should reject non-existent plan file via validatePlanPath', async () => {
      const result = await validatePlanPath(
        path.join(mockPlansDir, 'ghost.md'),
        mockPlansDir,
      );
      expect(result).toContain('Plan file does not exist');
    });
  });

  describe('subagent-bound (isolated plan state)', () => {
    /** A minimal AgentLoopContext stub with a mutable toolPermissionContext. */
    const makeSubagentContext = (planModeActive: boolean) =>
      ({
        planModeActive,
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
          isSubagentContext: true,
        },
      }) as unknown as Parameters<ExitPlanModeTool['bindSubagentContext']>[0];

    it('validate gates on the isolated plan flag, not global isPlanMode()', () => {
      // Global says NOT in plan mode, but the bound subagent context IS.
      mockConfig.isPlanMode = vi.fn().mockReturnValue(false);
      tool.bindSubagentContext(makeSubagentContext(true));
      expect(tool.validateToolParams({})).toBeNull();
    });

    it('validate rejects when the subagent is not in plan mode', () => {
      mockConfig.isPlanMode = vi.fn().mockReturnValue(true); // global true
      tool.bindSubagentContext(makeSubagentContext(false));
      expect(tool.validateToolParams({})).toContain('not in plan mode');
    });

    it('execute clears the isolated plan flag without touching global Config', async () => {
      const ctx = makeSubagentContext(true);
      tool.bindSubagentContext(ctx);
      const invocation = tool.build({ approved: true });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toBe('Exited plan mode');
      expect(ctx.planModeActive).toBe(false);
      // Global plan/permission state is untouched.
      expect(mockConfig.setPermissionMode).not.toHaveBeenCalled();
      expect(mockConfig.planStateManager!.exit).not.toHaveBeenCalled();
    });

    it('execute keeps plan active and returns feedback when rejected', async () => {
      const ctx = makeSubagentContext(true);
      tool.bindSubagentContext(ctx);
      const invocation = tool.build({
        approved: false,
        feedback: 'needs more detail',
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('needs more detail');
      expect(result.toolUseResult).toMatchObject({ status: 'rejected' });
      // Still in plan mode — rejection does not exit.
      expect(ctx.planModeActive).toBe(true);
    });
  });
});
