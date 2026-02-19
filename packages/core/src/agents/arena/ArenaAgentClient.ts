/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { isNodeError } from '../../utils/errors.js';
import {
  uiTelemetryService,
  type SessionMetrics,
} from '../../telemetry/uiTelemetry.js';
import type {
  ArenaAgentStats,
  ArenaControlSignal,
  ArenaStatusFile,
} from './types.js';
import { safeAgentId } from './types.js';

const debugLogger = createDebugLogger('ARENA_AGENT_CLIENT');

const AGENTS_SUBDIR = 'agents';
const CONTROL_SUBDIR = 'control';

/**
 * ArenaAgentClient is used by child agent processes to communicate
 * their status back to the main ArenaManager process via file-based IPC.
 *
 * Status files are written to a centralized arena session directory:
 *   `<arenaSessionDir>/agents/<safeAgentId>.json`
 *
 * Control signals are read from:
 *   `<arenaSessionDir>/control/<safeAgentId>.json`
 *
 * It self-activates based on the ARENA_AGENT_ID environment variable.
 * When running outside an Arena session, `ArenaAgentClient.create()`
 * returns null.
 */
export class ArenaAgentClient {
  private readonly agentsDir: string;
  private readonly controlDir: string;
  private readonly statusFilePath: string;
  private readonly controlFilePath: string;
  private initialized = false;

  /**
   * Static factory - returns an instance if ARENA_AGENT_ID, ARENA_SESSION_ID,
   * and ARENA_SESSION_DIR env vars are present, null otherwise.
   */
  static create(): ArenaAgentClient | null {
    const agentId = process.env['ARENA_AGENT_ID'];
    const sessionId = process.env['ARENA_SESSION_ID'];
    const sessionDir = process.env['ARENA_SESSION_DIR'];

    if (!agentId || !sessionId || !sessionDir) {
      return null;
    }

    return new ArenaAgentClient(agentId, sessionDir);
  }

  constructor(
    private readonly agentId: string,
    arenaSessionDir: string,
  ) {
    const safe = safeAgentId(agentId);
    this.agentsDir = path.join(arenaSessionDir, AGENTS_SUBDIR);
    this.controlDir = path.join(arenaSessionDir, CONTROL_SUBDIR);
    this.statusFilePath = path.join(this.agentsDir, `${safe}.json`);
    this.controlFilePath = path.join(this.controlDir, `${safe}.json`);
  }

  /**
   * Initialize the agents/ and control/ directories under the arena session
   * dir. Called automatically on first use if not invoked explicitly.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.agentsDir, { recursive: true });
    await fs.mkdir(this.controlDir, { recursive: true });
    this.initialized = true;
    debugLogger.info(
      `ArenaAgentClient initialized for agent ${this.agentId} at ${this.agentsDir}`,
    );
  }

  /**
   * Write current status to the per-agent status file using atomic write
   * (write to temp file then rename).
   *
   * Stats are derived automatically from uiTelemetryService which is the
   * canonical source for token counts, tool calls, and API request counts.
   */
  async updateStatus(currentActivity?: string): Promise<void> {
    await this.ensureInitialized();

    const stats = this.getStatsFromTelemetry();

    const statusFile: ArenaStatusFile = {
      agentId: this.agentId,
      status: 'running',
      updatedAt: Date.now(),
      rounds: stats.rounds,
      currentActivity,
      stats,
      finalSummary: null,
      error: null,
    };

    await this.atomicWrite(this.statusFilePath, statusFile);
  }

  /**
   * Read and delete control.json (consume-once pattern).
   * Returns null if no control signal is pending.
   */
  async checkControlSignal(): Promise<ArenaControlSignal | null> {
    await this.ensureInitialized();

    try {
      const content = await fs.readFile(this.controlFilePath, 'utf-8');
      // Parse before deleting so a corrupted file isn't silently consumed
      const signal = JSON.parse(content) as ArenaControlSignal;
      await fs.unlink(this.controlFilePath);
      return signal;
    } catch (error: unknown) {
      // File doesn't exist = no signal pending
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }
      // Re-throw permission errors so they surface immediately
      if (isNodeError(error) && error.code === 'EACCES') {
        throw error;
      }
      debugLogger.error('Error reading control signal:', error);
      return null;
    }
  }

  /**
   * Report that the agent has completed the current task successfully.
   * This is the primary signal to the main process that the agent is done working.
   */
  async reportCompleted(finalSummary?: string): Promise<void> {
    await this.ensureInitialized();

    const stats = this.getStatsFromTelemetry();

    const statusFile: ArenaStatusFile = {
      agentId: this.agentId,
      status: 'completed',
      updatedAt: Date.now(),
      rounds: stats.rounds,
      stats,
      finalSummary: finalSummary ?? null,
      error: null,
    };

    await this.atomicWrite(this.statusFilePath, statusFile);
  }

  /**
   * Report that the agent hit an error (API/auth/rate-limit, loop, etc.).
   */
  async reportError(errorMessage: string): Promise<void> {
    await this.ensureInitialized();

    const stats = this.getStatsFromTelemetry();

    const statusFile: ArenaStatusFile = {
      agentId: this.agentId,
      status: 'error',
      updatedAt: Date.now(),
      rounds: stats.rounds,
      stats,
      finalSummary: null,
      error: errorMessage,
    };

    await this.atomicWrite(this.statusFilePath, statusFile);
  }

  /**
   * Report that the agent's current request was cancelled by the user.
   */
  async reportCancelled(): Promise<void> {
    await this.ensureInitialized();

    const stats = this.getStatsFromTelemetry();

    const statusFile: ArenaStatusFile = {
      agentId: this.agentId,
      status: 'cancelled',
      updatedAt: Date.now(),
      rounds: stats.rounds,
      stats,
      finalSummary: null,
      error: null,
    };

    await this.atomicWrite(this.statusFilePath, statusFile);
  }

  /**
   * Build ArenaAgentStats from the current uiTelemetryService metrics.
   */
  private getStatsFromTelemetry(): ArenaAgentStats {
    return ArenaAgentClient.buildStatsFromMetrics(
      uiTelemetryService.getMetrics(),
    );
  }

  /**
   * Convert SessionMetrics into ArenaAgentStats by aggregating across
   * all models. Exposed as a static method for testability.
   */
  static buildStatsFromMetrics(metrics: SessionMetrics): ArenaAgentStats {
    let rounds = 0;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;

    for (const model of Object.values(metrics.models)) {
      rounds += model.api.totalRequests;
      totalTokens += model.tokens.total;
      inputTokens += model.tokens.prompt;
      outputTokens += model.tokens.candidates;
      durationMs += model.api.totalLatencyMs;
    }

    return {
      rounds,
      totalTokens,
      inputTokens,
      outputTokens,
      durationMs,
      toolCalls: metrics.tools.totalCalls,
      successfulToolCalls: metrics.tools.totalSuccess,
      failedToolCalls: metrics.tools.totalFail,
    };
  }

  /**
   * Atomically write JSON data to a file (write temp → rename).
   */
  private async atomicWrite(
    filePath: string,
    data: ArenaStatusFile,
  ): Promise<void> {
    const tmpPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      // Clean up temp file on failure
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }
}
