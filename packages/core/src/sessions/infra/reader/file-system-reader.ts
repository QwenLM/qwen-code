/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-system implementation of {@link SessionRepository}.
 *
 * All Node.js `fs` calls for session transcripts live here. Higher layers
 * receive plain metadata and remain I/O-free.
 */

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { SessionFilter } from '../../domain/interface/manager/session-load-options.js';
import { isENOENT, isSafeSessionFileStem } from '../../utils/session-utils.js';
import { decodeTranscriptLine } from '../codec/transcript-entry-codec.js';
import { encodeTranscriptEntry } from '../codec/transcript-entry-codec.js';
import type { TranscriptEntry } from '../entry/transcript-entry.js';
import type { SessionFileMetadata } from '../entry/file-metadata-entry.js';

const TAIL_READ_BUFFER_SIZE = 64 * 1024;

const SESSION_FILE_EXTENSION = '.jsonl';

export class FileSystemSessionReader {
  async listSessionFiles(bucketDir: string): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(bucketDir);
    } catch (error) {
      if (isENOENT(error)) {
        return [];
      }
      throw error;
    }

    const filePaths = entries
      .filter(
        (name) =>
          name.endsWith(SESSION_FILE_EXTENSION) &&
          isSafeSessionFileStem(
            nodePath.basename(name, SESSION_FILE_EXTENSION),
          ),
      )
      .map((name) => nodePath.join(bucketDir, name));

    const stats = await Promise.all(
      filePaths.map(async (path) => ({
        path,
        stat: await fs.stat(path),
      })),
    );

    return stats
      .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime())
      .map((item) => item.path);
  }

  async listAllSessionFiles(
    configHomeDir: string,
    filter?: SessionFilter,
  ): Promise<readonly string[]> {
    const projectsDir = nodePath.join(configHomeDir, 'projects');
    let bucketNames: string[];
    try {
      bucketNames = await fs.readdir(projectsDir);
    } catch (error) {
      if (isENOENT(error)) {
        return [];
      }
      throw error;
    }

    const filePaths: string[] = [];
    await Promise.all(
      bucketNames.map(async (name) => {
        const bucketDir = nodePath.join(projectsDir, name);
        if (filter && !filter({ entryPath: bucketDir })) {
          return;
        }
        const stat = await fs.stat(bucketDir);
        if (!stat.isDirectory()) {
          return;
        }
        const entries = await fs.readdir(bucketDir);
        for (const entry of entries) {
          if (
            entry.endsWith(SESSION_FILE_EXTENSION) &&
            isSafeSessionFileStem(
              nodePath.basename(entry, SESSION_FILE_EXTENSION),
            )
          ) {
            const sessionPath = nodePath.join(bucketDir, entry);
            const sessionId = nodePath.basename(
              entry,
              SESSION_FILE_EXTENSION,
            );
            if (filter && !filter({ sessionId, entryPath: sessionPath })) {
              continue;
            }
            filePaths.push(sessionPath);
          }
        }
      }),
    );

    return filePaths;
  }

  async readSessionMetadata(sessionPath: string): Promise<SessionFileMetadata> {
    const stats = await fs.stat(sessionPath);
    if (!stats.isFile()) {
      throw new Error(`Session path is not a file: ${sessionPath}`);
    }
    const sessionId = nodePath.basename(sessionPath, SESSION_FILE_EXTENSION);
    const updatedAt = stats.mtime.toISOString();

    let startedAt = updatedAt;
    let cwd = '';
    let gitBranch: string | undefined;

    let tailMetadata: TailMetadata;
    const handle = await fs.open(sessionPath, 'r');
    try {
      const firstLine = await readFirstLineFromHandle(handle, stats.size);
      if (firstLine) {
        const timestamp = firstLine['timestamp'];
        startedAt = typeof timestamp === 'string' ? timestamp : startedAt;
        const lineCwd = firstLine['cwd'];
        cwd = typeof lineCwd === 'string' ? lineCwd : cwd;
        const lineGitBranch = firstLine['gitBranch'];
        gitBranch =
          typeof lineGitBranch === 'string' ? lineGitBranch : gitBranch;
      }
      tailMetadata = await readTailMetadataFromHandle(handle, stats.size);
    } finally {
      await handle.close();
    }

    return {
      sessionId,
      sessionPath,
      transcriptBucketDir: nodePath.dirname(sessionPath),
      fileSize: stats.size,
      updatedAt,
      startedAt,
      cwd,
      directories: tailMetadata.directories,
      gitBranch,
      customTitle: tailMetadata.customTitle,
      aiTitle: tailMetadata.aiTitle,
      lastPrompt: tailMetadata.lastPrompt,
      summary: tailMetadata.summary,
      tag: tailMetadata.tag,
    };
  }

  async readSessionEntries(
    sessionPath: string,
  ): Promise<readonly TranscriptEntry[]> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(sessionPath);
    } catch (error) {
      if (isENOENT(error)) {
        return [];
      }
      throw error;
    }

    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      const decoded = decodeTranscriptLine(line);
      if (decoded.kind === 'entry') {
        entries.push(decoded.entry);
      }
    }
    return entries;
  }

  async writeSessionEntries(
    sessionPath: string,
    entries: readonly TranscriptEntry[],
  ): Promise<void> {
    const bytes = entries
      .map((entry) => encodeTranscriptEntry(entry).bytes)
      .reduce(
        (acc, chunk) => (acc.length === 0 ? chunk : Buffer.concat([acc, chunk])),
        Buffer.alloc(0),
      );
    await fs.mkdir(nodePath.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, bytes);
  }

  async deleteSessionFile(sessionPath: string): Promise<boolean> {
    try {
      await fs.unlink(sessionPath);
      return true;
    } catch (error) {
      if (isENOENT(error)) {
        return false;
      }
      throw error;
    }
  }
}

interface TailMetadata {
  customTitle: string | undefined;
  aiTitle: string | undefined;
  lastPrompt: string | undefined;
  summary: string | undefined;
  tag: string | undefined;
  directories: readonly string[] | undefined;
}

const FIRST_LINE_INITIAL_BUFFER_SIZE = 4096;
const FIRST_LINE_MAX_BUFFER_SIZE = 64 * 1024;

async function readFirstLineFromHandle(
  handle: Awaited<ReturnType<typeof fs.open>>,
  fileSize: number,
): Promise<Record<string, unknown> | null> {
  if (fileSize === 0) {
    return null;
  }

  let bufferSize = Math.min(fileSize, FIRST_LINE_INITIAL_BUFFER_SIZE);
  while (bufferSize <= Math.min(fileSize, FIRST_LINE_MAX_BUFFER_SIZE)) {
    const buffer = Buffer.alloc(bufferSize);
    await handle.read(buffer, 0, bufferSize, 0);
    const text = buffer.toString('utf8');
    const firstLine = text.split(/\r?\n/)[0];
    if (firstLine) {
      try {
        return JSON.parse(firstLine) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    if (bufferSize === fileSize) {
      break;
    }
    bufferSize = Math.min(fileSize, bufferSize * 2);
  }

  return null;
}

async function readTailMetadataFromHandle(
  handle: Awaited<ReturnType<typeof fs.open>>,
  fileSize: number,
): Promise<TailMetadata> {
  const metadata: TailMetadata = {
    customTitle: undefined,
    aiTitle: undefined,
    lastPrompt: undefined,
    summary: undefined,
    tag: undefined,
    directories: undefined,
  };

  if (fileSize === 0) {
    return metadata;
  }

  try {
    const readSize = Math.min(fileSize, TAIL_READ_BUFFER_SIZE);
    const offset = fileSize - readSize;
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, offset);
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    // If we did not start at byte 0, the first split line is likely partial.
    if (offset > 0 && lines[0].length > 0) {
      lines.shift();
    }

    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      const decoded = decodeTranscriptLine(line);
      if (decoded.kind !== 'entry') {
        continue;
      }
      const entry = decoded.entry;
      switch (entry.type) {
        case 'custom-title':
          metadata.customTitle = entry.customTitle;
          break;
        case 'ai-title':
          metadata.aiTitle = entry.aiTitle;
          break;
        case 'last-prompt':
          metadata.lastPrompt = entry.lastPrompt;
          break;
        case 'summary':
          metadata.summary = entry.summary;
          break;
        case 'tag':
          metadata.tag = entry.tag;
          break;
        case 'workspace-directories':
          if (
            Array.isArray(entry.directories) &&
            entry.directories.every((d): d is string => typeof d === 'string')
          ) {
            metadata.directories = entry.directories as readonly string[];
          }
          break;
        default:
          break;
      }
    }
  } catch {
    // Fail-stop: if the tail cannot be read, fall back to metadata-free result.
  }

  return metadata;
}
