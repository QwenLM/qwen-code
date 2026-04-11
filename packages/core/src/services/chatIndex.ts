/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { QWEN_DIR } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';

/**
 * Session index data structure
 * Stored in <project>/.qwen/chat-index.json (isolated per project)
 */
export interface ChatIndex {
  /** name -> sessionId mapping */
  [name: string]: string;
}

/**
 * Gets the index file path
 * @param projectDir The project directory path
 */
function getIndexPath(projectDir: string): string {
  const qwenDir = path.join(projectDir, QWEN_DIR);
  return path.join(qwenDir, 'chat-index.json');
}

/**
 * Ensures the project .qwen directory exists
 * @param projectDir The project directory path
 */
async function ensureQwenDir(projectDir: string): Promise<void> {
  const qwenDir = path.join(projectDir, QWEN_DIR);
  await fs.mkdir(qwenDir, { recursive: true });
}

/**
 * Reads the chat index file
 * @param projectDir The project directory path
 * @returns Index object, returns empty object if file doesn't exist
 * @throws On real errors (permissions, I/O failures)
 */
export async function readChatIndex(projectDir: string): Promise<ChatIndex> {
  try {
    const content = await fs.readFile(getIndexPath(projectDir), 'utf-8');
    const parsed = JSON.parse(content);

    // Validate the parsed data
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('Invalid chat index format');
    }

    // Ensure all values are strings
    for (const [_key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        // Gracefully degrade to empty index on malformed data
        return {};
      }
    }

    return parsed as ChatIndex;
  } catch (error) {
    // JSON parse error, return empty index (file may be corrupted)
    if (error instanceof SyntaxError) {
      return {};
    }
    // File doesn't exist is normal, return empty index
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {};
    }
    // Other errors (permissions, I/O) should throw
    throw error;
  }
}

/**
 * Saves a session to the index
 * @param projectDir The project directory path
 * @param name Session name
 * @param sessionId Session ID
 */
export async function saveSessionToIndex(
  projectDir: string,
  name: string,
  sessionId: string,
): Promise<void> {
  await ensureQwenDir(projectDir);

  const index = await readChatIndex(projectDir);
  index[name] = sessionId;

  await atomicWriteJSON(getIndexPath(projectDir), index);
}

/**
 * Deletes a session from the index
 * @param projectDir The project directory path
 * @param name Session name
 * @returns Whether deletion was successful
 */
export async function deleteSessionFromIndex(
  projectDir: string,
  name: string,
): Promise<boolean> {
  const index = await readChatIndex(projectDir);

  if (!(name in index)) {
    return false;
  }

  delete index[name];
  await atomicWriteJSON(getIndexPath(projectDir), index);
  return true;
}

/**
 * Gets a session ID by name
 * @param projectDir The project directory path
 * @param name Session name
 * @returns Session ID, or undefined if not found
 */
export async function getSessionIdByName(
  projectDir: string,
  name: string,
): Promise<string | undefined> {
  const index = await readChatIndex(projectDir);
  return index[name];
}

/**
 * Lists all named sessions
 * @param projectDir The project directory path
 * @returns Mapping of name to sessionId
 */
export async function listNamedSessions(
  projectDir: string,
): Promise<ChatIndex> {
  return await readChatIndex(projectDir);
}
