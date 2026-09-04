/**
 * Incremental sync worker for qwen-code session transcripts.
 * Scans ~\/.qwen\/projects\/*\/chats\/*.jsonl, parses new entries since last offset,
 * and upserts into SQLite.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSessionFile } from './parser.js';
import {
  batchUpsertApiRequests,
  batchUpsertToolCalls,
  getSyncOffset,
  updateSyncState,
} from './db.js';

const QWEN_HOME = process.env['QWEN_HOME'] ?? join(process.env['HOME'] ?? '', '.qwen');
const PROJECTS_DIR = join(QWEN_HOME, 'projects');

export interface SyncProgress {
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  totalApiRequests: number;
  totalToolCalls: number;
}

export type ProgressCallback = (progress: SyncProgress) => void;

/** Find all session JSONL files under ~/.qwen/projects/. */
function findSessionFiles(): string[] {
  const files: string[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS_DIR);
  } catch {
    return files;
  }

  for (const projectDir of projectDirs) {
    const chatsDir = join(PROJECTS_DIR, projectDir, 'chats');
    let entries: string[];
    try {
      entries = readdirSync(chatsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = join(chatsDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files.push(fullPath);
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return files;
}

/** Sync all session files, processing only new data since last offset. */
export async function syncAllSessions(
  onProgress?: ProgressCallback,
): Promise<{ apiRequests: number; toolCalls: number; filesProcessed: number }> {
  const files = findSessionFiles();
  let totalApiRequests = 0;
  let totalToolCalls = 0;
  let filesProcessed = 0;

  const progress: SyncProgress = {
    totalFiles: files.length,
    processedFiles: 0,
    currentFile: '',
    totalApiRequests: 0,
    totalToolCalls: 0,
  };

  for (const file of files) {
    progress.currentFile = file;
    onProgress?.(progress);

    const lastOffset = getSyncOffset(file);

    try {
      const result = await parseSessionFile(file, lastOffset);

      if (result.apiRequests.length > 0) {
        batchUpsertApiRequests(result.apiRequests);
        totalApiRequests += result.apiRequests.length;
      }

      if (result.toolCalls.length > 0) {
        batchUpsertToolCalls(result.toolCalls);
        totalToolCalls += result.toolCalls.length;
      }

      updateSyncState(file, result.lastOffset);
      filesProcessed++;
    } catch (err) {
      console.error(`Failed to sync ${file}:`, err instanceof Error ? err.message : err);
    }

    progress.processedFiles++;
    progress.totalApiRequests = totalApiRequests;
    progress.totalToolCalls = totalToolCalls;
    onProgress?.(progress);
  }

  return { apiRequests: totalApiRequests, toolCalls: totalToolCalls, filesProcessed };
}
