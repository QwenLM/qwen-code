import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_SESSION');
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview ModeSessionManager - Manages saving and restoring mode sessions.
 *
 * Tracks the current mode state and persists it to disk for later restoration.
 * Sessions are stored in ~/.qwen/sessions/ directory.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

const SESSIONS_DIR_NAME = 'sessions';
const LAST_SESSION_FILE = 'last-session.json';

/**
 * Represents the state of a saved session.
 */
export interface SessionState {
  /** The name of the active mode */
  modeName: string;

  /** The approval mode that was active */
  approvalMode: string;

  /** List of open files, if available */
  openFiles?: string[];

  /** The working directory where the session was saved */
  workingDirectory: string;

  /** Timestamp when the session was saved */
  savedAt: Date;

  /** Optional metadata for extensions */
  metadata?: Record<string, unknown>;
}

/**
 * Manages saving and restoring mode sessions.
 */
export class ModeSessionManager {
  private sessionsDir: string;
  private lastSessionPath: string;

  /**
   * @param targetDir - The project target directory (used to scope sessions)
   */
  constructor(targetDir: string) {
    // Hash the target directory to create a unique session directory
    const dirHash = this.hashDirectory(targetDir);
    const qwenDir = path.join(os.homedir(), '.qwen');
    this.sessionsDir = path.join(qwenDir, SESSIONS_DIR_NAME, dirHash);
    this.lastSessionPath = path.join(this.sessionsDir, LAST_SESSION_FILE);
  }

  /**
   * Save the current session state to disk.
   *
   * @param modeName - The name of the current mode
   * @param approvalMode - The current approval mode
   * @param metadata - Optional metadata to store with the session
   */
  async saveSession(
    modeName: string,
    approvalMode: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const session: SessionState = {
      modeName,
      approvalMode,
      workingDirectory: process.cwd(),
      savedAt: new Date(),
      metadata,
    };

    try {
      // Ensure directory exists
      await fs.mkdir(this.sessionsDir, { recursive: true });

      // Write session file
      await fs.writeFile(
        this.lastSessionPath,
        JSON.stringify(session, null, 2),
        'utf-8',
      );
    } catch (error) {
      // Silently fail - session save is non-critical
      debugLogger.warn('Failed to save session state:', error);
    }
  }

  /**
   * Load the last saved session.
   *
   * @returns The saved session state, or null if none exists
   */
  loadLastSession(): SessionState | null {
    try {
      const data = fsSync.readFileSync(this.lastSessionPath, 'utf-8');
      const session = JSON.parse(data) as SessionState;
      return {
        ...session,
        savedAt: new Date(session.savedAt),
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if there is a saved session.
   *
   * @returns True if a saved session exists
   */
  hasSavedSession(): boolean {
    try {
      return fsSync.existsSync(this.lastSessionPath);
    } catch {
      return false;
    }
  }

  /**
   * Clear the saved session.
   */
  clearSavedSession(): void {
    try {
      if (fsSync.existsSync(this.lastSessionPath)) {
        fsSync.unlinkSync(this.lastSessionPath);
      }
    } catch {
      // Silently fail
    }
  }

  /**
   * List all saved sessions.
   * Currently returns only the last session, but structured as an array
   * for future multi-session support.
   *
   * @returns Array of saved session states
   */
  listSessions(): SessionState[] {
    const lastSession = this.loadLastSession();
    if (lastSession) {
      return [lastSession];
    }
    return [];
  }

  /**
   * Create a simple hash of a directory path for session scoping.
   */
  private hashDirectory(dirPath: string): string {
    let hash = 0;
    const str = dirPath;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to positive hex string
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return hex;
  }
}
