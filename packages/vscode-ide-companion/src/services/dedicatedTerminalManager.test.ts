/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DedicatedTerminalManager } from './dedicatedTerminalManager.js';
import type { ToolCallUpdateData } from '../types/chatTypes.js';
import type { AcpPermissionRequest } from '../types/acpTypes.js';

// Mock vscode module
const mockTerminal = {
  show: vi.fn(),
  sendText: vi.fn(),
  dispose: vi.fn(),
};

const mockOnDidCloseTerminal = vi.fn();
const mockDisposable = { dispose: vi.fn() };

vi.mock('vscode', () => ({
  window: {
    createTerminal: vi.fn(() => mockTerminal),
    onDidCloseTerminal: vi.fn((callback) => {
      mockOnDidCloseTerminal.mockImplementation(callback);
      return mockDisposable;
    }),
  },
  ThemeIcon: vi.fn().mockImplementation((id: string) => ({ id })),
}));

describe('DedicatedTerminalManager', () => {
  let manager: DedicatedTerminalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new DedicatedTerminalManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('show', () => {
    it('creates terminal and shows it with preserveFocus=true by default', () => {
      manager.show();

      expect(mockTerminal.show).toHaveBeenCalledWith(true);
    });

    it('shows terminal with preserveFocus=false when specified', () => {
      manager.show(false);

      expect(mockTerminal.show).toHaveBeenCalledWith(false);
    });

    it('does not show terminal after dispose', () => {
      manager.dispose();
      manager.show();

      expect(mockTerminal.show).not.toHaveBeenCalled();
    });
  });

  describe('handleToolCall', () => {
    it('ignores non-execute kind tool calls', () => {
      const update: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'read',
        title: 'Read file',
        status: 'pending',
        rawInput: { path: '/test/file.ts' },
      };

      manager.handleToolCall(update);

      expect(mockTerminal.sendText).not.toHaveBeenCalled();
    });

    it('shows terminal and executes command for execute kind', () => {
      const update: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'execute',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'echo "hello"' },
      };

      manager.handleToolCall(update);

      expect(mockTerminal.show).toHaveBeenCalledWith(true);
      expect(mockTerminal.sendText).toHaveBeenCalledTimes(2);
      // First call is the info message with timestamp
      expect(mockTerminal.sendText.mock.calls[0][0]).toContain(
        'Qwen Code executing:',
      );
      // Second call is the actual command
      expect(mockTerminal.sendText).toHaveBeenCalledWith('echo "hello"');
    });

    it('uses title as fallback when command is not in rawInput', () => {
      const update: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'execute',
        title: 'ls -la',
        status: 'pending',
        rawInput: {},
      };

      manager.handleToolCall(update);

      expect(mockTerminal.sendText).toHaveBeenCalledWith('ls -la');
    });

    it('does not duplicate command execution for same toolCallId', () => {
      const update: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'execute',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'echo "hello"' },
      };

      manager.handleToolCall(update);
      manager.handleToolCall(update);

      // Command should only be sent once (2 calls: info + command)
      expect(mockTerminal.sendText).toHaveBeenCalledTimes(2);
    });

    it('shows completion message when status is completed', () => {
      const startUpdate: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'execute',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'echo "hello"' },
      };

      const completeUpdate: ToolCallUpdateData = {
        ...startUpdate,
        status: 'completed',
      };

      manager.handleToolCall(startUpdate);
      manager.handleToolCall(completeUpdate);

      // 2 calls for start (info + command) + 1 call for completion message
      expect(mockTerminal.sendText).toHaveBeenCalledTimes(3);
      expect(mockTerminal.sendText.mock.calls[2][0]).toContain(
        'Command completed',
      );
    });

    it('shows failure message when status is failed', () => {
      const startUpdate: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'execute',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'invalid-command' },
      };

      const failedUpdate: ToolCallUpdateData = {
        ...startUpdate,
        status: 'failed',
      };

      manager.handleToolCall(startUpdate);
      manager.handleToolCall(failedUpdate);

      expect(mockTerminal.sendText).toHaveBeenCalledTimes(3);
      expect(mockTerminal.sendText.mock.calls[2][0]).toContain(
        'Command failed',
      );
    });

    it('does not process after dispose', () => {
      manager.dispose();

      const update: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'execute',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'echo "hello"' },
      };

      manager.handleToolCall(update);

      expect(mockTerminal.sendText).not.toHaveBeenCalled();
    });
  });

  describe('handlePermissionRequest', () => {
    it('shows terminal with command awaiting approval', () => {
      const request: AcpPermissionRequest = {
        sessionId: 'test-session',
        toolCall: {
          toolCallId: 'test-id',
          kind: 'execute',
          title: 'Run command',
          rawInput: { command: 'rm -rf /' },
        },
        options: [],
      };

      manager.handlePermissionRequest(request);

      expect(mockTerminal.show).toHaveBeenCalledWith(true);
      expect(mockTerminal.sendText).toHaveBeenCalledTimes(3);
      expect(mockTerminal.sendText.mock.calls[0][0]).toContain(
        'Qwen Code wants to execute:',
      );
      expect(mockTerminal.sendText.mock.calls[1][0]).toContain('rm -rf /');
      expect(mockTerminal.sendText.mock.calls[2][0]).toContain(
        'Waiting for approval',
      );
    });

    it('does nothing when command is not present', () => {
      const request: AcpPermissionRequest = {
        sessionId: 'test-session',
        toolCall: {
          toolCallId: 'test-id',
          kind: 'read',
          title: 'Read file',
          rawInput: { path: '/test/file.ts' },
        },
        options: [],
      };

      manager.handlePermissionRequest(request);

      expect(mockTerminal.sendText).not.toHaveBeenCalled();
    });

    it('does not process after dispose', () => {
      manager.dispose();

      const request: AcpPermissionRequest = {
        sessionId: 'test-session',
        toolCall: {
          toolCallId: 'test-id',
          kind: 'execute',
          title: 'Run command',
          rawInput: { command: 'echo "hello"' },
        },
        options: [],
      };

      manager.handlePermissionRequest(request);

      expect(mockTerminal.sendText).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('disposes terminal and clears pending calls', () => {
      // First create the terminal by showing it
      manager.show();

      manager.dispose();

      expect(mockTerminal.dispose).toHaveBeenCalled();
      expect(mockDisposable.dispose).toHaveBeenCalled();
    });

    it('can be called multiple times safely', () => {
      manager.show();
      manager.dispose();
      manager.dispose();

      // Should not throw
      expect(mockTerminal.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('terminal close handling', () => {
    it('clears terminal reference when terminal is closed', async () => {
      const vscode = await import('vscode');

      // Create terminal
      manager.show();

      // Simulate terminal close
      mockOnDidCloseTerminal(mockTerminal);

      // Clear mocks to check next show() creates new terminal
      vi.clearAllMocks();

      // Show again should create new terminal
      manager.show();

      expect(vscode.window.createTerminal).toHaveBeenCalled();
    });
  });

  describe('formatDuration', () => {
    it('formats milliseconds correctly', () => {
      const update: ToolCallUpdateData = {
        toolCallId: 'test-id',
        kind: 'execute',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'echo "hello"' },
      };

      manager.handleToolCall(update);

      // Complete immediately
      const completeUpdate: ToolCallUpdateData = {
        ...update,
        status: 'completed',
      };
      manager.handleToolCall(completeUpdate);

      // Duration should be in ms format for quick commands
      const completionCall = mockTerminal.sendText.mock.calls[2][0];
      expect(completionCall).toMatch(/Command completed \(\d+ms\)/);
    });
  });
});
