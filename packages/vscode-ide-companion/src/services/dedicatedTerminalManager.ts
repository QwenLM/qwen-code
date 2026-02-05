/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { AcpPermissionRequest } from '../types/acpTypes.js';
import type { ToolCallUpdateData } from '../types/chatTypes.js';

/**
 * Dedicated Terminal Manager for Qwen Code
 *
 * This class manages a dedicated terminal that displays shell command execution
 * in real-time. The terminal is a normal interactive terminal where users can
 * also run their own commands.
 */
export class DedicatedTerminalManager implements vscode.Disposable {
  private terminal: vscode.Terminal | null = null;
  private isDisposed = false;
  private pendingToolCalls: Map<
    string,
    { command: string; startTime: number }
  > = new Map();
  private terminalCloseListener: vscode.Disposable | null = null;

  constructor() {}

  /**
   * Get or create the dedicated terminal
   */
  private getOrCreateTerminal(): vscode.Terminal {
    // Check if terminal still exists
    if (this.terminal) {
      return this.terminal;
    }

    // Create a normal interactive terminal
    this.terminal = vscode.window.createTerminal({
      name: 'Qwen Code',
      iconPath: new vscode.ThemeIcon('terminal'),
    });

    // Listen for terminal close
    this.terminalCloseListener = vscode.window.onDidCloseTerminal(
      (closedTerminal) => {
        if (closedTerminal === this.terminal) {
          this.terminal = null;
          this.terminalCloseListener?.dispose();
          this.terminalCloseListener = null;
        }
      },
    );

    return this.terminal;
  }

  /**
   * Show the dedicated terminal
   */
  show(preserveFocus = true): void {
    if (this.isDisposed) {
      return;
    }
    const terminal = this.getOrCreateTerminal();
    terminal.show(preserveFocus);
  }

  /**
   * Send text to the terminal (will be executed as a command)
   */
  private sendCommand(command: string): void {
    const terminal = this.getOrCreateTerminal();
    terminal.sendText(command);
  }

  /**
   * Send a comment/info line to the terminal (using echo)
   */
  private sendInfo(message: string): void {
    const terminal = this.getOrCreateTerminal();
    // Use echo to display info without executing as command
    terminal.sendText(`echo '${message.replace(/'/g, "'\\''")}'`);
  }

  /**
   * Handle tool call event (both start and update)
   * Called when a shell command starts executing or updates
   */
  handleToolCall(update: ToolCallUpdateData): void {
    if (this.isDisposed) {
      return;
    }

    const { toolCallId, kind, title, status, rawInput } = update;

    // Only handle execute kind (shell commands)
    if (kind !== 'execute') {
      return;
    }

    // Extract command from rawInput
    const command = (rawInput as { command?: string })?.command || title || '';

    // Check if this is a new tool call (has command and not yet tracked)
    if (command && !this.pendingToolCalls.has(toolCallId)) {
      // Store pending tool call
      this.pendingToolCalls.set(toolCallId, {
        command,
        startTime: Date.now(),
      });

      // Show terminal and display the command being executed
      this.show();

      const timestamp = new Date().toLocaleTimeString();
      this.sendInfo(`[${timestamp}] Qwen Code executing:`);
      this.sendCommand(command);
    }

    // Handle completion status
    const pendingCall = this.pendingToolCalls.get(toolCallId);
    if (pendingCall && (status === 'completed' || status === 'failed')) {
      const duration = Date.now() - pendingCall.startTime;
      const durationStr = this.formatDuration(duration);

      if (status === 'completed') {
        this.sendInfo(`Command completed (${durationStr})`);
      } else {
        this.sendInfo(`Command failed (${durationStr})`);
      }

      this.pendingToolCalls.delete(toolCallId);
    }
  }

  /**
   * Handle permission request for shell commands
   * Shows the command that is requesting permission
   */
  handlePermissionRequest(request: AcpPermissionRequest): void {
    if (this.isDisposed) {
      return;
    }

    const { toolCall } = request;
    const command = toolCall.rawInput?.command;

    if (!command) {
      return;
    }

    // Show terminal
    this.show();

    const timestamp = new Date().toLocaleTimeString();
    this.sendInfo(`[${timestamp}] Qwen Code wants to execute:`);
    this.sendInfo(`$ ${command}`);
    this.sendInfo('Waiting for approval in the chat panel...');
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Dispose the terminal manager
   */
  dispose(): void {
    this.isDisposed = true;
    this.pendingToolCalls.clear();

    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }

    this.terminalCloseListener?.dispose();
    this.terminalCloseListener = null;
  }
}
