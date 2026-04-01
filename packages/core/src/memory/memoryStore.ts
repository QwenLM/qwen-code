/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { parseFrontmatter, serializeMemoryFile } from './frontmatterParser.js';
import type {
  MemoryFile,
  MemoryHeader,
  MemoryScope,
  MemoryType,
  EntrypointTruncation,
} from './types.js';
import {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  MAX_MEMORY_FILES,
  FRONTMATTER_MAX_LINES,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const logger = createDebugLogger('MEMORY_STORE');

/**
 * Returns the memory directory for the given scope.
 */
export function getMemoryDir(scope: MemoryScope, cwd?: string): string {
  if (scope === 'global') {
    return path.join(Storage.getGlobalQwenDir(), 'memory');
  }
  const projectRoot = cwd ?? process.cwd();
  return path.join(projectRoot, '.proto', 'memory');
}

/**
 * Returns the path to the MEMORY.md index file.
 */
export function getMemoryIndexPath(scope: MemoryScope, cwd?: string): string {
  return path.join(getMemoryDir(scope, cwd), ENTRYPOINT_NAME);
}

/**
 * Create a URL-safe slug from a memory name.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Ensure the memory directory exists.
 */
async function ensureDir(scope: MemoryScope, cwd?: string): Promise<void> {
  await fs.mkdir(getMemoryDir(scope, cwd), { recursive: true });
}

/**
 * Create a new memory file and update the index.
 */
export async function createMemory(opts: {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  scope: MemoryScope;
  cwd?: string;
}): Promise<MemoryFile> {
  await ensureDir(opts.scope, opts.cwd);

  const slug = slugify(opts.name);
  const filename = `${opts.type}_${slug}.md`;
  const filePath = path.join(getMemoryDir(opts.scope, opts.cwd), filename);

  const header: MemoryHeader = {
    name: opts.name,
    description: opts.description,
    type: opts.type,
  };

  const fileContent = serializeMemoryFile(header, opts.content);
  await fs.writeFile(filePath, fileContent, 'utf-8');
  logger.debug(`Created memory: ${filePath}`);

  await regenerateIndex(opts.scope, opts.cwd);

  const stat = await fs.stat(filePath);
  return {
    header,
    content: opts.content,
    filePath,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Update an existing memory file.
 */
export async function updateMemory(
  filePath: string,
  updates: Partial<MemoryHeader> & { content?: string },
  scope: MemoryScope,
  cwd?: string,
): Promise<MemoryFile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const { header, body } = parseFrontmatter(raw);
    if (!header) return null;

    const newHeader: MemoryHeader = {
      name: updates.name ?? header.name,
      description: updates.description ?? header.description,
      type: updates.type ?? header.type,
    };
    const newBody = updates.content ?? body;

    await fs.writeFile(
      filePath,
      serializeMemoryFile(newHeader, newBody),
      'utf-8',
    );
    await regenerateIndex(scope, cwd);

    const stat = await fs.stat(filePath);
    return {
      header: newHeader,
      content: newBody,
      filePath,
      mtimeMs: stat.mtimeMs,
    };
  } catch (err) {
    logger.error(`Failed to update memory ${filePath}:`, err);
    return null;
  }
}

/**
 * Delete a memory file and regenerate the index.
 */
export async function deleteMemory(
  filePath: string,
  scope: MemoryScope,
  cwd?: string,
): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    await regenerateIndex(scope, cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all memory files in the given scope, with parsed headers.
 * Returns newest-first, capped at MAX_MEMORY_FILES.
 */
export async function listMemories(
  scope: MemoryScope,
  cwd?: string,
): Promise<MemoryFile[]> {
  const memoryDir = getMemoryDir(scope, cwd);
  let entries: string[];

  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter(
    (f) => f.endsWith('.md') && f !== ENTRYPOINT_NAME,
  );

  const results: MemoryFile[] = [];
  for (const filename of mdFiles) {
    const filePath = path.join(memoryDir, filename);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const stat = await fs.stat(filePath);
      const { header, body } = parseFrontmatter(raw);
      if (header) {
        results.push({
          header,
          content: body,
          filePath,
          mtimeMs: stat.mtimeMs,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sort newest-first, cap at limit
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, MAX_MEMORY_FILES);
}

/**
 * Scan memory headers without reading full file content.
 * Reads only the first FRONTMATTER_MAX_LINES of each file.
 */
export async function scanMemoryHeaders(
  scope: MemoryScope,
  cwd?: string,
): Promise<Array<MemoryHeader & { filePath: string; mtimeMs: number }>> {
  const memoryDir = getMemoryDir(scope, cwd);
  let entries: string[];

  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter(
    (f) => f.endsWith('.md') && f !== ENTRYPOINT_NAME,
  );

  const results: Array<MemoryHeader & { filePath: string; mtimeMs: number }> =
    [];

  await Promise.allSettled(
    mdFiles.map(async (filename) => {
      const filePath = path.join(memoryDir, filename);
      try {
        const handle = await fs.open(filePath, 'r');
        try {
          // Read only first chunk for frontmatter
          const buf = Buffer.alloc(4096);
          const { bytesRead } = await handle.read(buf, 0, 4096, 0);
          const raw = buf.toString('utf-8', 0, bytesRead);
          const lines = raw.split('\n').slice(0, FRONTMATTER_MAX_LINES);
          const { header } = parseFrontmatter(lines.join('\n'));
          if (header) {
            const stat = await fs.stat(filePath);
            results.push({ ...header, filePath, mtimeMs: stat.mtimeMs });
          }
        } finally {
          await handle.close();
        }
      } catch {
        // Skip unreadable files
      }
    }),
  );

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, MAX_MEMORY_FILES);
}

/**
 * Regenerate MEMORY.md index from all memory files in the directory.
 * Respects MAX_ENTRYPOINT_LINES and MAX_ENTRYPOINT_BYTES limits.
 */
export async function regenerateIndex(
  scope: MemoryScope,
  cwd?: string,
): Promise<void> {
  const memories = await listMemories(scope, cwd);
  const indexPath = getMemoryIndexPath(scope, cwd);

  const lines = ['# Proto Memory', ''];

  for (const mem of memories) {
    const filename = path.basename(mem.filePath);
    const line = `- [${mem.header.name}](${filename}) — ${mem.header.description}`;
    lines.push(line);
  }

  // Apply limits
  let content = lines.join('\n') + '\n';

  if (lines.length > MAX_ENTRYPOINT_LINES) {
    const truncated = lines.slice(0, MAX_ENTRYPOINT_LINES);
    truncated.push(
      '',
      `(${lines.length - MAX_ENTRYPOINT_LINES} more memories truncated)`,
    );
    content = truncated.join('\n') + '\n';
  }

  if (Buffer.byteLength(content) > MAX_ENTRYPOINT_BYTES) {
    // Truncate at last newline before byte limit
    const buf = Buffer.from(content);
    const truncBuf = buf.subarray(0, MAX_ENTRYPOINT_BYTES);
    const lastNewline = truncBuf.lastIndexOf(0x0a);
    content =
      truncBuf.toString(
        'utf-8',
        0,
        lastNewline > 0 ? lastNewline : MAX_ENTRYPOINT_BYTES,
      ) + '\n(truncated due to size limit)\n';
  }

  await ensureDir(scope, cwd);
  await fs.writeFile(indexPath, content, 'utf-8');
  logger.debug(`Regenerated index: ${indexPath} (${memories.length} memories)`);
}

/**
 * Read and truncate the MEMORY.md entrypoint content.
 */
export async function readEntrypoint(
  scope: MemoryScope,
  cwd?: string,
): Promise<EntrypointTruncation> {
  const indexPath = getMemoryIndexPath(scope, cwd);
  let raw: string;

  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return {
      content: '',
      lineCount: 0,
      byteCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
    };
  }

  const lines = raw.split('\n');
  const byteCount = Buffer.byteLength(raw);
  let wasLineTruncated = false;
  let wasByteTruncated = false;
  let content = raw;

  if (lines.length > MAX_ENTRYPOINT_LINES) {
    content = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n');
    wasLineTruncated = true;
  }

  if (Buffer.byteLength(content) > MAX_ENTRYPOINT_BYTES) {
    const buf = Buffer.from(content);
    const truncBuf = buf.subarray(0, MAX_ENTRYPOINT_BYTES);
    const lastNewline = truncBuf.lastIndexOf(0x0a);
    content = truncBuf.toString(
      'utf-8',
      0,
      lastNewline > 0 ? lastNewline : MAX_ENTRYPOINT_BYTES,
    );
    wasByteTruncated = true;
  }

  return {
    content,
    lineCount: lines.length,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}
