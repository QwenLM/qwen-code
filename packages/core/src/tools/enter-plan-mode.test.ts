/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EnterPlanModeTool } from './enter-plan-mode.js';
import type { Config } from '../config/config.js';
import fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      // @ts-expect-error - Property 'default' does not exist on type 'typeof import("node:fs")'
      ...actual.default,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

describe('EnterPlanModeTool', () => {
  let tool: EnterPlanModeTool;
  let mockConfig: Partial<Config>;

  beforeEach(() => {
    mockConfig = {
      getPermissionMode: vi.fn().mockReturnValue('default'),
      isPlanMode: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      storage: {
        getPlansDir: vi.fn().mockReturnValue('/mock/plans/dir'),
      } as unknown as Config['storage'],
      planStateManager: {
        enter: vi.fn(),
        getPlanFilePath: vi
          .fn()
          .mockReturnValue('/mock/plans/dir/test-slug.md'),
      } as unknown as Config['planStateManager'],
      notifyPlanStateChanged: vi.fn(),
      resetPreApprovedPrompts: vi.fn(),
    };
    tool = new EnterPlanModeTool(mockConfig as Config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    it('should enter Plan state and report the model tool trigger', async () => {
      const invocation = tool.build({});

      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.planStateManager?.enter).toHaveBeenCalledOnce();
      expect(mockConfig.notifyPlanStateChanged).toHaveBeenCalledWith(
        'model_tool',
      );
      expect(result.llmContent).toContain('Entered plan mode');
      expect(result.returnDisplay).toBe('Switching to Plan mode');
    });

    it('should create plans directory', async () => {
      const invocation = tool.build({});

      await invocation.execute(new AbortController().signal);

      expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/plans/dir', {
        recursive: true,
      });
    });

    it('should include optional reason in output display', async () => {
      const reason = 'Design new database schema';
      const invocation = tool.build({ reason });

      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.planStateManager?.enter).toHaveBeenCalledOnce();
      expect(result.llmContent).toContain('Entered plan mode');
      expect(result.llmContent).toContain(reason);
      expect(result.returnDisplay).toContain(reason);
    });

    it('should return idempotent message when already in plan mode', async () => {
      mockConfig.isPlanMode = vi.fn().mockReturnValue(true);
      const invocation = tool.build({});

      const result = await invocation.execute(new AbortController().signal);

      expect(mockConfig.planStateManager?.enter).not.toHaveBeenCalled();
      expect(mockConfig.notifyPlanStateChanged).not.toHaveBeenCalled();
      expect(result.llmContent).toContain('Already in plan mode');
      expect(result.returnDisplay).toBe('Already in plan mode.');
    });
  });

  describe('validateToolParams', () => {
    it('should allow empty params', () => {
      const result = tool.validateToolParams({});
      expect(result).toBeNull();
    });

    it('should allow reason param', () => {
      const result = tool.validateToolParams({ reason: 'test' });
      expect(result).toBeNull();
    });
  });
});
