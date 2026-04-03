/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SHELL_REGISTRY');

export interface ShellProcess {
  id: string;
  command: string;
  pid: number | undefined;
  status: 'running' | 'completed' | 'killed' | 'failed';
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  output: string;
  workingDirectory: string;
  isBackground: boolean;
}

export interface ShellProcessRegistration {
  id: string;
  command: string;
  pid: number | undefined;
  workingDirectory: string;
}

/**
 * Central registry to track all background shell processes.
 * Provides lifecycle management, output capture, and cleanup.
 */
export class ShellProcessRegistry {
  private static instance: ShellProcessRegistry | null = null;
  private static signalListenersRegistered = false;
  private processes: Map<string, ShellProcess> = new Map();
  private counter: number = 0;
  private readonly MAX_OUTPUT_SIZE = 1_000_000; // 1MB limit per process
  private readonly AUTO_CLEANUP_TTL_MS = 30 * 60 * 1000; // 30 minutes

  private constructor() {
    // Only register signal listeners once, and never in test environments
    if (
      !ShellProcessRegistry.signalListenersRegistered &&
      process.env.NODE_ENV !== 'test'
    ) {
      ShellProcessRegistry.signalListenersRegistered = true;
      process.on('exit', () => {
        this.cleanup();
      });

      process.on('SIGTERM', () => {
        this.cleanup();
      });

      process.on('SIGINT', () => {
        this.cleanup();
      });
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ShellProcessRegistry {
    // Auto-reset in test environments to prevent state leakage
    if (process.env.NODE_ENV === 'test') {
      ShellProcessRegistry.instance = null;
    }
    if (!ShellProcessRegistry.instance) {
      ShellProcessRegistry.instance = new ShellProcessRegistry();
    }
    return ShellProcessRegistry.instance;
  }

  /**
   * Reset instance (useful for testing)
   */
  static resetInstance(): void {
    ShellProcessRegistry.instance = null;
  }

  /**
   * Register a new background shell process
   */
  register(params: ShellProcessRegistration): ShellProcess {
    this.counter++;
    const id = `shell_${this.counter}`;

    const process: ShellProcess = {
      id,
      command: params.command,
      pid: params.pid,
      status: 'running',
      startTime: new Date(),
      output: '',
      workingDirectory: params.workingDirectory,
      isBackground: true,
    };

    this.processes.set(id, process);
    debugLogger.info(`Registered background shell: ${id} - ${params.command}`);

    return process;
  }

  /**
   * Get a process by ID
   */
  getProcess(id: string): ShellProcess | undefined {
    return this.processes.get(id);
  }

  /**
   * List all processes, optionally filtered by status
   */
  listProcesses(
    statusFilter?: Array<'running' | 'completed' | 'killed' | 'failed'>,
  ): ShellProcess[] {
    const processes = Array.from(this.processes.values());

    if (statusFilter) {
      return processes.filter((p) => statusFilter.includes(p.status));
    }

    return processes;
  }

  /**
   * Update process output (appends to existing output)
   */
  updateOutput(id: string, output: string): void {
    const process = this.processes.get(id);
    if (!process) {
      debugLogger.warn(
        `Attempted to update output for non-existent process: ${id}`,
      );
      return;
    }

    // Append new output
    process.output += output;

    // Trim if exceeds max size (keep last N characters)
    if (process.output.length > this.MAX_OUTPUT_SIZE) {
      const overflowMessage = `\n\n[Output truncated. First ${this.MAX_OUTPUT_SIZE} characters removed due to size limit.]`;
      process.output =
        overflowMessage + process.output.slice(-this.MAX_OUTPUT_SIZE);
    }
  }

  /**
   * Mark a process as completed
   */
  markCompleted(id: string, exitCode: number): void {
    const process = this.processes.get(id);
    if (!process) {
      debugLogger.warn(
        `Attempted to mark non-existent process as completed: ${id}`,
      );
      return;
    }

    process.status = 'completed';
    process.exitCode = exitCode;
    process.endTime = new Date();

    debugLogger.info(`Shell ${id} completed with exit code ${exitCode}`);
  }

  /**
   * Kill a background process
   */
  async killProcess(id: string): Promise<boolean> {
    const process = this.processes.get(id);
    if (!process) {
      debugLogger.warn(`Attempted to kill non-existent process: ${id}`);
      return false;
    }

    if (process.status !== 'running') {
      debugLogger.warn(`Process ${id} is already ${process.status}`);
      return false;
    }

    if (!process.pid) {
      debugLogger.warn(`Process ${id} has no PID`);
      process.status = 'killed';
      process.endTime = new Date();
      return true;
    }

    const isWindows = os.platform() === 'win32';

    try {
      if (isWindows) {
        // Windows: use taskkill
        const result = spawnSync(
          'taskkill',
          ['/pid', String(process.pid), '/f', '/t'],
          {
            timeout: 5000,
          },
        );

        if (result.error) {
          debugLogger.error(
            `Failed to kill shell ${id} on Windows: ${result.error}`,
          );
          return false;
        }

        debugLogger.info(
          `Killed shell ${id} (PID: ${process.pid}) via taskkill`,
        );
      } else {
        // POSIX: try SIGTERM first, then SIGKILL
        // Note: `process` here refers to the ShellProcess data object, not the Node.js global.
        // We must use `globalThis.process.kill(pid, signal)` to send OS signals.
        try {
          globalThis.process.kill(process.pid, 'SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 200));

          // Check if still running
          const updatedProcess = this.processes.get(id);
          if (updatedProcess && updatedProcess.status === 'running') {
            globalThis.process.kill(process.pid, 'SIGKILL');
            debugLogger.info(`Force killed shell ${id} (PID: ${process.pid})`);
          } else {
            debugLogger.info(
              `Gracefully killed shell ${id} (PID: ${process.pid})`,
            );
          }
        } catch (killError) {
          debugLogger.warn(`Failed to kill shell ${id}: ${killError}`);
          // Try to mark as killed anyway
        }
      }

      const updatedProcess = this.processes.get(id);
      if (updatedProcess) {
        updatedProcess.status = 'killed';
        updatedProcess.endTime = new Date();
      }

      return true;
    } catch (error) {
      debugLogger.error(`Failed to kill shell ${id}: ${error}`);
      return false;
    }
  }

  /**
   * Get process runtime in milliseconds
   */
  getRuntime(id: string): number | undefined {
    const process = this.processes.get(id);
    if (!process) return undefined;

    if (process.endTime) {
      return process.endTime.getTime() - process.startTime.getTime();
    }

    return Date.now() - process.startTime.getTime();
  }

  /**
   * Format runtime as human-readable string
   */
  formatRuntime(id: string): string | undefined {
    const runtime = this.getRuntime(id);
    if (runtime === undefined) return undefined;

    const seconds = Math.floor(runtime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get recent output (last N lines)
   */
  getRecentOutput(id: string, lines: number = 50): string {
    const process = this.processes.get(id);
    if (!process) return '';

    const outputLines = process.output.split('\n');
    return outputLines.slice(-lines).join('\n');
  }

  /**
   * Filter output by pattern
   */
  filterOutput(id: string, pattern: string): string[] {
    const process = this.processes.get(id);
    if (!process) return [];

    const regex = new RegExp(pattern, 'gi');
    return process.output.split('\n').filter((line) => regex.test(line));
  }

  /**
   * Auto-cleanup completed processes older than TTL
   */
  cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, process] of this.processes) {
      if (process.status !== 'running' && process.endTime) {
        const age = now - process.endTime.getTime();
        if (age > this.AUTO_CLEANUP_TTL_MS) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      this.processes.delete(id);
      debugLogger.info(`Auto-cleaned completed shell: ${id}`);
    }
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    total: number;
    running: number;
    completed: number;
    killed: number;
    failed: number;
  } {
    const processes = Array.from(this.processes.values());
    return {
      total: processes.length,
      running: processes.filter((p) => p.status === 'running').length,
      completed: processes.filter((p) => p.status === 'completed').length,
      killed: processes.filter((p) => p.status === 'killed').length,
      failed: processes.filter((p) => p.status === 'failed').length,
    };
  }

  /**
   * Clear all processes (use with caution)
   */
  clear(): void {
    this.processes.clear();
    this.counter = 0;
    debugLogger.info('Shell process registry cleared');
  }
}
