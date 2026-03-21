/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShellReadOutputParams } from './shell-read-output.js';
import { ShellReadOutputTool } from './shell-read-output.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

// Mock ShellExecutionService
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    readOutput: vi.fn(),
  },
}));

const mockShellExecutionService = vi.mocked(ShellExecutionService);

describe('ShellReadOutputTool', () => {
  let tool: ShellReadOutputTool;
  let mockAbortSignal: AbortSignal;

  beforeEach(() => {
    tool = new ShellReadOutputTool();
    mockAbortSignal = new AbortController().signal;
    vi.clearAllMocks();
  });

  describe('validateToolParams', () => {
    it('should validate correct parameters', () => {
      const params: ShellReadOutputParams = {
        pid: 12345,
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject non-integer pid', () => {
      const params = {
        pid: 123.45,
      } as ShellReadOutputParams;

      const result = tool.validateToolParams(params);
      expect(result).toContain('integer number');
    });

    it('should reject negative pid', () => {
      const params: ShellReadOutputParams = {
        pid: -1,
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });

    it('should reject zero pid', () => {
      const params: ShellReadOutputParams = {
        pid: 0,
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });
  });

  describe('execute', () => {
    it('should return error when session not found', async () => {
      mockShellExecutionService.readOutput.mockReturnValue(undefined);

      const params: ShellReadOutputParams = {
        pid: 99999,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('No shell session found');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should return output from running session', async () => {
      mockShellExecutionService.readOutput.mockReturnValue({
        output: 'Building project...\nDone!',
        hasMore: false,
        exited: false,
      });

      const params: ShellReadOutputParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('still running');
      expect(result.llmContent).toContain('Building project');
      expect(result.returnDisplay).toContain('Building project');
    });

    it('should return output from exited session', async () => {
      mockShellExecutionService.readOutput.mockReturnValue({
        output: 'Build complete',
        hasMore: false,
        exited: true,
      });

      const params: ShellReadOutputParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('exited');
      expect(result.llmContent).toContain('Build complete');
    });

    it('should handle empty output', async () => {
      mockShellExecutionService.readOutput.mockReturnValue({
        output: '',
        hasMore: false,
        exited: false,
      });

      const params: ShellReadOutputParams = {
        pid: 12345,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('no output');
      expect(result.returnDisplay).toContain('no output');
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(ShellReadOutputTool.Name).toBe('shell_read_output');
      expect(tool.name).toBe('shell_read_output');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('ShellReadOutput');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('execute');
    });
  });

  describe('getDescription', () => {
    it('should return description with pid', () => {
      const params: ShellReadOutputParams = {
        pid: 12345,
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Read output from PID 12345');
    });
  });
});
