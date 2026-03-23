/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShellProcessStatusParams } from './shell-process-status.js';
import { ShellProcessStatusTool } from './shell-process-status.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

// Mock ShellExecutionService
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    getProcessStatus: vi.fn(),
  },
}));

const mockShellExecutionService = vi.mocked(ShellExecutionService);

describe('ShellProcessStatusTool', () => {
  let tool: ShellProcessStatusTool;
  let mockAbortSignal: AbortSignal;

  beforeEach(() => {
    tool = new ShellProcessStatusTool();
    mockAbortSignal = new AbortController().signal;
    vi.clearAllMocks();
  });

  describe('validateToolParams', () => {
    it('should validate correct parameters', () => {
      const params: ShellProcessStatusParams = {
        pid: 12345,
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject non-integer pid', () => {
      const params = {
        pid: 123.45,
      } as ShellProcessStatusParams;

      const result = tool.validateToolParams(params);
      expect(result).toContain('integer number');
    });

    it('should reject negative pid', () => {
      const params: ShellProcessStatusParams = {
        pid: -1,
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });

    it('should reject zero pid', () => {
      const params: ShellProcessStatusParams = {
        pid: 0,
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });
  });

  describe('execute', () => {
    it('should return error when session not found', async () => {
      mockShellExecutionService.getProcessStatus.mockReturnValue(undefined);

      const params: ShellProcessStatusParams = {
        pid: 99999,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('No shell session found');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should return running status for active process', async () => {
      mockShellExecutionService.getProcessStatus.mockReturnValue({
        running: true,
        exitCode: null,
        signal: null,
        pid: 12345,
      });

      const params: ShellProcessStatusParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('still running');
      expect(result.returnDisplay).toContain('running');
    });

    it('should return exit code for completed process', async () => {
      mockShellExecutionService.getProcessStatus.mockReturnValue({
        running: false,
        exitCode: 0,
        signal: null,
        pid: 12345,
      });

      const params: ShellProcessStatusParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('exited with code 0');
      expect(result.returnDisplay).toContain('exitCode');
    });

    it('should return signal for terminated process', async () => {
      mockShellExecutionService.getProcessStatus.mockReturnValue({
        running: false,
        exitCode: null,
        signal: 9,
        pid: 12345,
      });

      const params: ShellProcessStatusParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('terminated by signal 9');
      expect(result.returnDisplay).toContain('signal');
    });

    it('should return non-zero exit code for failed process', async () => {
      mockShellExecutionService.getProcessStatus.mockReturnValue({
        running: false,
        exitCode: 1,
        signal: null,
        pid: 12345,
      });

      const params: ShellProcessStatusParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('exited with code 1');
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(ShellProcessStatusTool.Name).toBe('shell_process_status');
      expect(tool.name).toBe('shell_process_status');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('ShellProcessStatus');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('execute');
    });
  });

  describe('getDescription', () => {
    it('should return description with pid', () => {
      const params: ShellProcessStatusParams = {
        pid: 12345,
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Check status of PID 12345');
    });
  });
});
