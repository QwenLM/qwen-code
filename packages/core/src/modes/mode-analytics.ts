/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode analytics for tracking mode usage statistics.
 *
 * The ModeAnalytics class records mode usage sessions, computes statistics,
 * generates productivity reports, and supports persistence to disk.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_ANALYTICS');

/**
 * Usage statistics for a single mode.
 */
export interface ModeUsageStats {
  /** Mode name */
  modeName: string;

  /** Total time spent in this mode (seconds) */
  totalTimeSeconds: number;

  /** Number of sessions in this mode */
  sessionCount: number;

  /** Average session duration (seconds) */
  averageSessionTime: number;

  /** Last time this mode was used */
  lastUsed: Date;

  /** Total number of tool calls made in this mode */
  toolCallCount: number;

  /** Total number of messages exchanged */
  messagesExchanged: number;

  /** Total number of files modified */
  filesModified: number;
}

/**
 * Session data for internal tracking.
 */
interface SessionRecord {
  modeName: string;
  duration: number;
  toolCalls: number;
  messages: number;
  filesModified: number;
  timestamp: Date;
}

/**
 * Productivity report summarizing mode usage.
 */
export interface ProductivityReport {
  /** Total time across all modes (seconds) */
  totalTime: number;

  /** Most frequently used mode */
  mostUsedMode: string;

  /** Distribution of time across modes (mode name -> percentage 0-100) */
  modeDistribution: Record<string, number>;

  /** Suggestions for improving productivity */
  suggestions: string[];
}

/**
 * Serialized analytics data for persistence.
 */
interface AnalyticsData {
  sessions: Array<{
    modeName: string;
    duration: number;
    toolCalls: number;
    messages: number;
    filesModified: number;
    timestamp: string;
  }>;
}

/**
 * Tracks and analyzes mode usage statistics.
 */
export class ModeAnalytics {
  private sessions: SessionRecord[];

  constructor() {
    this.sessions = [];
  }

  /**
   * Record a mode usage session.
   *
   * @param modeName - Name of the mode
   * @param duration - Session duration in seconds
   * @param stats - Session statistics
   */
  recordSession(
    modeName: string,
    duration: number,
    stats: {
      toolCalls: number;
      messages: number;
      filesModified: number;
    },
  ): void {
    this.sessions.push({
      modeName,
      duration,
      toolCalls: stats.toolCalls,
      messages: stats.messages,
      filesModified: stats.filesModified,
      timestamp: new Date(),
    });

    debugLogger.debug(
      `Recorded session: mode=${modeName}, duration=${duration}s, ` +
      `toolCalls=${stats.toolCalls}, messages=${stats.messages}, ` +
      `filesModified=${stats.filesModified}`,
    );
  }

  /**
   * Get statistics for a specific mode.
   *
   * @param modeName - Mode name
   * @returns Usage stats or null if mode has no sessions
   */
  getModeStats(modeName: string): ModeUsageStats | null {
    const modeSessions = this.sessions.filter((s) => s.modeName === modeName);
    if (modeSessions.length === 0) {
      return null;
    }

    return this.computeStats(modeName, modeSessions);
  }

  /**
   * Get statistics for all modes, sorted by total time (highest first).
   *
   * @returns Array of usage stats for all modes
   */
  getAllStats(): ModeUsageStats[] {
    const modeGroups = new Map<string, SessionRecord[]>();

    for (const session of this.sessions) {
      const group = modeGroups.get(session.modeName) || [];
      group.push(session);
      modeGroups.set(session.modeName, group);
    }

    const stats: ModeUsageStats[] = [];
    for (const [modeName, sessions] of modeGroups.entries()) {
      stats.push(this.computeStats(modeName, sessions));
    }

    // Sort by total time descending
    stats.sort((a, b) => b.totalTimeSeconds - a.totalTimeSeconds);

    return stats;
  }

  /**
   * Get a productivity report with insights and suggestions.
   *
   * @returns Productivity report
   */
  getProductivityReport(): ProductivityReport {
    const allStats = this.getAllStats();
    const totalTime = allStats.reduce((sum, s) => sum + s.totalTimeSeconds, 0);

    // Mode distribution
    const modeDistribution: Record<string, number> = {};
    for (const stat of allStats) {
      modeDistribution[stat.modeName] =
        totalTime > 0 ? (stat.totalTimeSeconds / totalTime) * 100 : 0;
    }

    // Most used mode by session count
    let mostUsedMode = 'general';
    let maxSessions = 0;
    for (const stat of allStats) {
      if (stat.sessionCount > maxSessions) {
        maxSessions = stat.sessionCount;
        mostUsedMode = stat.modeName;
      }
    }

    // Generate suggestions
    const suggestions = this.generateSuggestions(allStats, totalTime);

    return {
      totalTime,
      mostUsedMode,
      modeDistribution,
      suggestions,
    };
  }

  /**
   * Persist analytics data to a JSON file.
   *
   * @param filePath - Absolute path to save the data
   */
  async save(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const data: AnalyticsData = {
      sessions: this.sessions.map((s) => ({
        modeName: s.modeName,
        duration: s.duration,
        toolCalls: s.toolCalls,
        messages: s.messages,
        filesModified: s.filesModified,
        timestamp: s.timestamp.toISOString(),
      })),
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    debugLogger.debug(`Saved analytics to ${filePath} (${this.sessions.length} sessions)`);
  }

  /**
   * Load analytics data from a JSON file.
   *
   * @param filePath - Absolute path to load the data from
   */
  async load(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data: AnalyticsData = JSON.parse(content);

      this.sessions = data.sessions.map((s) => ({
        modeName: s.modeName,
        duration: s.duration,
        toolCalls: s.toolCalls,
        messages: s.messages,
        filesModified: s.filesModified,
        timestamp: new Date(s.timestamp),
      }));

      debugLogger.debug(`Loaded analytics from ${filePath} (${this.sessions.length} sessions)`);
    } catch (error) {
      debugLogger.warn(`Failed to load analytics from ${filePath}:`, error);
      this.sessions = [];
    }
  }

  /**
   * Clear all recorded sessions.
   */
  clear(): void {
    this.sessions = [];
  }

  /**
   * Get the number of recorded sessions.
   *
   * @returns Session count
   */
  getSessionCount(): number {
    return this.sessions.length;
  }

  /**
   * Compute aggregated stats for a group of sessions.
   */
  private computeStats(modeName: string, sessions: SessionRecord[]): ModeUsageStats {
    const totalTimeSeconds = sessions.reduce((sum, s) => sum + s.duration, 0);
    const sessionCount = sessions.length;
    const averageSessionTime = sessionCount > 0 ? totalTimeSeconds / sessionCount : 0;
    const lastUsed = sessions.reduce(
      (latest, s) => (s.timestamp > latest ? s.timestamp : latest),
      new Date(0),
    );
    const toolCallCount = sessions.reduce((sum, s) => sum + s.toolCalls, 0);
    const messagesExchanged = sessions.reduce((sum, s) => sum + s.messages, 0);
    const filesModified = sessions.reduce((sum, s) => sum + s.filesModified, 0);

    return {
      modeName,
      totalTimeSeconds,
      sessionCount,
      averageSessionTime,
      lastUsed,
      toolCallCount,
      messagesExchanged,
      filesModified,
    };
  }

  /**
   * Generate productivity suggestions based on usage patterns.
   */
  private generateSuggestions(
    allStats: ModeUsageStats[],
    totalTime: number,
  ): string[] {
    const suggestions: string[] = [];

    if (allStats.length === 0) {
      suggestions.push('No mode usage data yet. Start using different modes to get insights!');
      return suggestions;
    }

    // Check for over-reliance on a single mode
    if (allStats.length > 1) {
      const dominant = allStats[0];
      const dominantPercent = (dominant.totalTimeSeconds / totalTime) * 100;
      if (dominantPercent > 80) {
        suggestions.push(
          `You spend ${dominantPercent.toFixed(0)}% of your time in "${dominant.modeName}" mode. ` +
          'Consider using specialized modes for specific tasks to improve efficiency.',
        );
      }
    }

    // Check for underutilized modes
    const specializedModes = ['tester', 'reviewer', 'security', 'devops', 'optimizer'];
    const usedModes = new Set(allStats.map((s) => s.modeName));
    const unusedSpecialized = specializedModes.filter((m) => !usedModes.has(m));
    if (unusedSpecialized.length > 0) {
      suggestions.push(
        `Try using these specialized modes: ${unusedSpecialized.join(', ')}. ` +
        'They can help with specific tasks more effectively.',
      );
    }

    // Suggest reviewer if many files modified in developer mode
    const devStats = allStats.find((s) => s.modeName === 'developer');
    if (devStats && devStats.filesModified > 10) {
      suggestions.push(
        'You have modified many files. Consider using "reviewer" mode to review your changes.',
      );
    }

    // Suggest tester if not used
    if (!usedModes.has('tester')) {
      suggestions.push(
        'Consider using "tester" mode to improve your test coverage.',
      );
    }

    // Suggest debugger if many short sessions
    const avgSessionTime = totalTime / allStats.reduce((sum, s) => sum + s.sessionCount, 0);
    if (avgSessionTime < 60 && allStats.reduce((sum, s) => sum + s.sessionCount, 0) > 5) {
      suggestions.push(
        'Your sessions are quite short on average. For complex debugging tasks, try "debugger" mode.',
      );
    }

    return suggestions;
  }
}
