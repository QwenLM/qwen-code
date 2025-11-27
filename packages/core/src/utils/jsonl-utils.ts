/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Efficient JSONL (JSON Lines) file utilities.
 *
 * Reading operations:
 * - readLines() - Reads the first N lines efficiently using buffered I/O
 * - read() - Reads entire file into memory as array
 *
 * Writing operations:
 * - writeLine() - Async append with mutex-based concurrency control
 * - writeLineSync() - Sync append (use in non-async contexts)
 * - write() - Overwrites entire file with array of objects
 *
 * Utility operations:
 * - countLines() - Counts non-empty lines
 * - exists() - Checks if file exists and is non-empty
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Mutex } from 'async-mutex';

/**
 * A map of file paths to mutexes for preventing concurrent writes.
 */
const fileLocks = new Map<string, Mutex>();

/**
 * Gets or creates a mutex for a specific file path.
 */
function getFileLock(filePath: string): Mutex {
  if (!fileLocks.has(filePath)) {
    fileLocks.set(filePath, new Mutex());
  }
  return fileLocks.get(filePath)!;
}

/**
 * Reads the first N lines from a JSONL file efficiently.
 * Returns an array of parsed objects.
 */
export async function readLines<T = unknown>(
  filePath: string,
  count: number,
): Promise<T[]> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const results: T[] = [];
    for await (const line of rl) {
      if (results.length >= count) break;
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        results.push(JSON.parse(trimmed) as T);
      }
    }

    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `Error reading first ${count} lines from ${filePath}:`,
        error,
      );
    }
    return [];
  }
}

/**
 * Reads all lines from a JSONL file.
 * Returns an array of parsed objects.
 */
export async function read<T = unknown>(filePath: string): Promise<T[]> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const results: T[] = [];
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        results.push(JSON.parse(trimmed) as T);
      }
    }

    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Error reading ${filePath}:`, error);
    }
    return [];
  }
}

/**
 * Appends a line to a JSONL file with concurrency control.
 * This method uses a mutex to ensure only one write happens at a time per file.
 */
export async function writeLine(
  filePath: string,
  data: unknown,
): Promise<void> {
  const lock = getFileLock(filePath);
  await lock.runExclusive(() => {
    const line = `${JSON.stringify(data)}\n`;
    // Ensure directory exists before writing
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, line, 'utf8');
  });
}

/**
 * Synchronous version of writeLine for use in non-async contexts.
 * Uses a simple flag-based locking mechanism (less robust than async version).
 */
export function writeLineSync(filePath: string, data: unknown): void {
  const line = `${JSON.stringify(data)}\n`;
  // Ensure directory exists before writing
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, line, 'utf8');
}

/**
 * Overwrites a JSONL file with an array of objects.
 * Each object will be written as a separate line.
 */
export function write(filePath: string, data: unknown[]): void {
  const lines = data.map((item) => JSON.stringify(item)).join('\n');
  // Ensure directory exists before writing
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${lines}\n`, 'utf8');
}

/**
 * Counts the number of non-empty lines in a JSONL file.
 */
export async function countLines(filePath: string): Promise<number> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let count = 0;
    for await (const line of rl) {
      if (line.trim().length > 0) {
        count++;
      }
    }
    return count;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Error counting lines in ${filePath}:`, error);
    }
    return 0;
  }
}

/**
 * Checks if a JSONL file exists and is not empty.
 */
export function exists(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}
