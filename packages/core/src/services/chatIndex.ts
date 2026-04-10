/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { QWEN_DIR } from '../config/storage.js';
import crypto from 'node:crypto';

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
 * Atomically writes to a file (using temp file + rename)
 * @param filePath Target file path
 * @param content File content
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempFile = path.join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(tempFile, content, 'utf-8');
    await fs.rename(tempFile, filePath);
  } catch (error) {
    // Clean up temp file
    try {
      await fs.unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
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
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        throw new Error(`Invalid entry in chat index: ${key}`);
      }
    }

    return parsed as ChatIndex;
  } catch (error) {
    // File doesn't exist is normal, return empty index
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {};
    }
    // JSON parse error, return empty index (file may be corrupted)
    if (error instanceof SyntaxError) {
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

  await atomicWrite(getIndexPath(projectDir), JSON.stringify(index, null, 2));
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
  await atomicWrite(getIndexPath(projectDir), JSON.stringify(index, null, 2));
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
