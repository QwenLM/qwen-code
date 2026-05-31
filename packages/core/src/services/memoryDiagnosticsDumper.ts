/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Writes a lightweight memory diagnostics JSON to disk when the memory
 * pressure monitor detects hard or critical pressure. The file survives
 * a subsequent OOM crash, giving maintainers actionable data from bug
 * reports without requiring the user to manually run `/doctor memory`.
 *
 * Design: diagnostics JSON is written BEFORE any expensive operation
 * (like heap snapshots) so it lands on disk even if the process crashes
 * during the heavier step.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectMemoryDiagnostics } from '../utils/memoryDiagnostics.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import type { Config } from '../config/config.js';

const debugLogger = createDebugLogger('MEMORY_DUMP');

/** Maximum dumps per session to avoid disk flooding. */
const MAX_DUMPS_PER_SESSION = 3;

/** Minimum interval between dumps (ms). */
const MIN_DUMP_INTERVAL_MS = 30_000;

export interface MemoryDumpResult {
  filePath: string;
  trigger: string;
}

export class MemoryDiagnosticsDumper {
  private dumpCount = 0;
  private lastDumpTime = 0;

  constructor(private readonly config: Config) {}

  /**
   * Resets session-scoped state. Called when a new session starts.
   */
  resetForNewSession(): void {
    this.dumpCount = 0;
    this.lastDumpTime = 0;
  }

  /**
   * Writes a diagnostics snapshot to disk if within per-session limits.
   * Returns the file path on success, or undefined if skipped/failed.
   */
  async dump(
    trigger: 'hard' | 'critical',
  ): Promise<MemoryDumpResult | undefined> {
    if (this.dumpCount >= MAX_DUMPS_PER_SESSION) {
      debugLogger.debug(
        `Skipping dump: session cap reached (${MAX_DUMPS_PER_SESSION})`,
      );
      return undefined;
    }

    const now = Date.now();
    if (now - this.lastDumpTime < MIN_DUMP_INTERVAL_MS) {
      debugLogger.debug('Skipping dump: cooldown not elapsed');
      return undefined;
    }

    try {
      const diagnosticsDir = this.ensureDiagnosticsDir();
      const sessionId = this.config.getSessionId();
      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, '-')
        .replace(/\./g, '_');
      const fileName = `memory-${sessionId.slice(0, 8)}-${timestamp}.json`;
      const filePath = path.join(diagnosticsDir, fileName);

      const diagnostics = await collectMemoryDiagnostics({
        sessionId,
        qwenVersion: this.config.getCliVersion(),
      });

      const payload = {
        trigger,
        dumpNumber: this.dumpCount + 1,
        ...diagnostics,
        session: this.collectSessionStats(),
        suggestion: this.getSuggestion(trigger),
      };

      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

      this.dumpCount++;
      this.lastDumpTime = now;

      debugLogger.info(
        `Memory diagnostics written to ${filePath} (trigger=${trigger}, dump #${this.dumpCount})`,
      );

      return { filePath, trigger };
    } catch (err) {
      debugLogger.error(
        `Failed to write memory diagnostics: ${getErrorMessage(err)}`,
      );
      return undefined;
    }
  }

  private ensureDiagnosticsDir(): string {
    const projectDir = this.config.storage.getProjectDir();
    const diagnosticsDir = path.join(projectDir, 'diagnostics');
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    return diagnosticsDir;
  }

  private collectSessionStats(): Record<string, unknown> {
    try {
      const geminiClient = this.config.getGeminiClient?.();
      if (!geminiClient) return { available: false };
      const historyLength = geminiClient.getChat?.()?.getHistoryLength?.() ?? 0;
      return {
        historyEntries: historyLength,
      };
    } catch {
      return { available: false };
    }
  }

  private getSuggestion(trigger: 'hard' | 'critical'): string {
    if (trigger === 'critical') {
      return 'Memory is critically high. Consider running /compact or starting a fresh session to avoid OOM.';
    }
    return 'Memory pressure detected. Running /compact may help reduce memory usage.';
  }
}
