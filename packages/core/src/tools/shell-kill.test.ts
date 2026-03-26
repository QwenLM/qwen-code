/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShellKillParams } from './shell-kill.js';
import { ShellKillTool } from './shell-kill.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

// Mock ShellExecutionService
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    getSessionInfo: vi.fn(),
    killSession: vi.fn(),
  },
}));

const mockShellExecutionService = vi.mocked(ShellExecutionService);

describe('ShellKillTool', () => {
  let tool: ShellKillTool;
  let mockAbortSignal: AbortSignal;

  beforeEach(() => {
    tool = new ShellKillTool();
    mockAbortSignal = new AbortController().signal;
    vi.clearAllMocks();
  });

  describe('validateToolParams', () => {
    it('should validate correct parameters with pid only', () => {
      const params: ShellKillParams = {
        pid: 12345,
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should validate correct parameters with signal', () => {
      const params: ShellKillParams = {
        pid: 12345,
        signal: 'SIGKILL',
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject non-integer pid', () => {
      const params = {
        pid: 123.45,
      } as ShellKillParams;

      const result = tool.validateToolParams(params);
      expect(result).toContain('integer number');
    });

    it('should reject negative pid', () => {
      const params: ShellKillParams = {
        pid: -1,
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });

    it('should reject zero pid', () => {
      const params: ShellKillParams = {
        pid: 0,
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });

    it('should reject invalid signal', () => {
      const params = {
        pid: 12345,
        signal: 'INVALID',
      } as unknown as ShellKillParams;

      const result = tool.validateToolParams(params);
      expect(result).toContain('SIGTERM, SIGKILL, SIGINT');
    });
  });

  describe('execute', () => {
    it('should return error when session not found', async () => {
      mockShellExecutionService.getSessionInfo.mockReturnValue(undefined);

      const params: ShellKillParams = {
        pid: 99999,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('No shell session found');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should return error when session has exited', async () => {
      mockShellExecutionService.getSessionInfo.mockReturnValue({
        pid: 12345,
        command: 'test',
        cwd: '/test',
        startedAt: new Date(),
        exited: true,
        exitCode: 0,
        signal: null,
      });

      const params: ShellKillParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('has already exited');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should kill session with default SIGTERM', async () => {
      mockShellExecutionService.getSessionInfo.mockReturnValue({
        pid: 12345,
        command: 'npm run dev',
        cwd: '/test',
        startedAt: new Date(),
        exited: false,
        exitCode: null,
        signal: null,
      });
      mockShellExecutionService.killSession.mockReturnValue(true);

      const params: ShellKillParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockShellExecutionService.killSession).toHaveBeenCalledWith(
        12345,
        'SIGTERM',
      );
      expect(result.llmContent).toContain('SIGTERM');
      expect(result.llmContent).toContain('Successfully');
    });

    it('should kill session with SIGKILL', async () => {
      mockShellExecutionService.getSessionInfo.mockReturnValue({
        pid: 12345,
        command: 'npm run dev',
        cwd: '/test',
        startedAt: new Date(),
        exited: false,
        exitCode: null,
        signal: null,
      });
      mockShellExecutionService.killSession.mockReturnValue(true);

      const params: ShellKillParams = {
        pid: 12345,
        signal: 'SIGKILL',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockShellExecutionService.killSession).toHaveBeenCalledWith(
        12345,
        'SIGKILL',
      );
      expect(result.llmContent).toContain('SIGKILL');
    });

    it('should handle kill failure', async () => {
      mockShellExecutionService.getSessionInfo.mockReturnValue({
        pid: 12345,
        command: 'npm run dev',
        cwd: '/test',
        startedAt: new Date(),
        exited: false,
        exitCode: null,
        signal: null,
      });
      mockShellExecutionService.killSession.mockReturnValue(false);

      const params: ShellKillParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('Failed to terminate');
      expect(result.returnDisplay).toContain('Failed');
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(ShellKillTool.Name).toBe('shell_kill');
      expect(tool.name).toBe('shell_kill');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('ShellKill');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('execute');
    });
  });

  describe('getDescription', () => {
    it('should return description with default signal', () => {
      const params: ShellKillParams = {
        pid: 12345,
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Kill PID 12345 with SIGTERM');
    });

    it('should return description with custom signal', () => {
      const params: ShellKillParams = {
        pid: 12345,
        signal: 'SIGKILL',
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Kill PID 12345 with SIGKILL');
    });
  });
});
