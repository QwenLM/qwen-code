/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Content } from '@google/genai';

const SESSIONS_DIR_NAME = '.qwen_sessions';

export interface SessionData {
  sessionId: string;
  createdAt: string;
  lastUpdated: string;
  history: Content[];
  projectRoot: string;
}

/**
 * Gets the sessions directory path
 */
function getSessionsDir(): string {
  return path.join(os.homedir(), SESSIONS_DIR_NAME);
}

/**
 * Gets the session file path for a given session ID
 */
function getSessionFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

/**
 * Ensures the sessions directory exists
 */
async function ensureSessionsDirExists(): Promise<void> {
  const sessionsDir = getSessionsDir();
  try {
    await fs.mkdir(sessionsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore error
  }
}

/**
 * Save session data to file
 */
export async function saveSession(sessionData: SessionData): Promise<void> {
  await ensureSessionsDirExists();
  const sessionFilePath = getSessionFilePath(sessionData.sessionId);
  const dataToSave = {
    ...sessionData,
    lastUpdated: new Date().toISOString(),
  };
  
  await fs.writeFile(sessionFilePath, JSON.stringify(dataToSave, null, 2));
}

/**
 * Load session data from file
 */
export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const sessionFilePath = getSessionFilePath(sessionId);
  
  try {
    const fileContent = await fs.readFile(sessionFilePath, 'utf-8');
    const sessionData = JSON.parse(fileContent) as SessionData;
    return sessionData;
  } catch (error) {
    // Session file doesn't exist or is corrupted
    return null;
  }
}

/**
 * Check if a session exists
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  const sessionFilePath = getSessionFilePath(sessionId);
  
  try {
    await fs.access(sessionFilePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all available sessions
 */
export async function listSessions(): Promise<SessionData[]> {
  const sessionsDir = getSessionsDir();
  
  try {
    const files = await fs.readdir(sessionsDir);
    const sessionFiles = files.filter(file => file.endsWith('.json'));
    
    const sessions: SessionData[] = [];
    for (const file of sessionFiles) {
      const sessionId = path.basename(file, '.json');
      const sessionData = await loadSession(sessionId);
      if (sessionData) {
        sessions.push(sessionData);
      }
    }
    
    // Sort by last updated, most recent first
    return sessions.sort((a, b) => 
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
    );
  } catch {
    return [];
  }
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  const sessionFilePath = getSessionFilePath(sessionId);
  
  try {
    await fs.unlink(sessionFilePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new session with basic metadata
 */
export function createNewSessionData(sessionId: string, projectRoot: string): SessionData {
  const now = new Date().toISOString();
  return {
    sessionId,
    createdAt: now,
    lastUpdated: now,
    history: [],
    projectRoot,
  };
}