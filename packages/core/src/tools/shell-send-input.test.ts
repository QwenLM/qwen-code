/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShellSendInputParams } from './shell-send-input.js';
import { ShellSendInputTool } from './shell-send-input.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

// Mock ShellExecutionService
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    getSessionInfo: vi.fn(),
    writeToPty: vi.fn(),
  },
}));

const mockShellExecutionService = vi.mocked(ShellExecutionService);

describe('ShellSendInputTool', () => {
  let tool: ShellSendInputTool;
  let mockAbortSignal: AbortSignal;

  beforeEach(() => {
    tool = new ShellSendInputTool();
    mockAbortSignal = new AbortController().signal;
    vi.clearAllMocks();
  });

  describe('validateToolParams', () => {
    it('should validate correct parameters', () => {
      const params: ShellSendInputParams = {
        pid: 12345,
        input: 'test input\n',
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject non-integer pid', () => {
      const params = {
        pid: 123.45,
        input: 'test',
      } as ShellSendInputParams;

      const result = tool.validateToolParams(params);
      expect(result).toContain('integer number');
    });

    it('should reject negative pid', () => {
      const params: ShellSendInputParams = {
        pid: -1,
        input: 'test',
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });

    it('should reject zero pid', () => {
      const params: ShellSendInputParams = {
        pid: 0,
        input: 'test',
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('positive number');
    });

    it('should reject non-string input', () => {
      const params = {
        pid: 12345,
        input: 123,
      } as unknown as ShellSendInputParams;

      const result = tool.validateToolParams(params);
      expect(result).toContain('must be a string');
    });
  });

  describe('execute', () => {
    it('should return error when session not found', async () => {
      mockShellExecutionService.getSessionInfo.mockReturnValue(undefined);

      const params: ShellSendInputParams = {
        pid: 99999,
        input: 'test',
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

      const params: ShellSendInputParams = {
        pid: 12345,
        input: 'test',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('has already exited');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should send input to active session', async () => {
      mockShellExecutionService.getSessionInfo.mockReturnValue({
        pid: 12345,
        command: 'python3 -i',
        cwd: '/test',
        startedAt: new Date(),
        exited: false,
        exitCode: null,
        signal: null,
      });
      mockShellExecutionService.writeToPty.mockReturnValue(undefined);

      const params: ShellSendInputParams = {
        pid: 12345,
        input: 'print("hello")\n',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockShellExecutionService.writeToPty).toHaveBeenCalledWith(
        12345,
        'print("hello")\n',
      );
      expect(result.llmContent).toContain('Successfully sent input');
      expect(result.returnDisplay).toContain('Input sent');
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(ShellSendInputTool.Name).toBe('shell_send_input');
      expect(tool.name).toBe('shell_send_input');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('ShellSendInput');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('execute');
    });
  });

  describe('getDescription', () => {
    it('should return description with pid', () => {
      const params: ShellSendInputParams = {
        pid: 12345,
        input: 'test',
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Send input to PID 12345');
    });
  });
});
