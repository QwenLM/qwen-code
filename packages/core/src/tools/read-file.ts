/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { makeRelative, shortenPath, unescapePath } from '../utils/paths.js';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';

import type { PartUnion } from '@google/genai';
import type { PermissionDecision } from '../permissions/types.js';
import {
  processSingleFileContent,
  getSpecificMimeType,
} from '../utils/fileUtils.js';
import { parsePDFPageRange } from '../utils/pdf.js';
import type { Config } from '../config/config.js';
import { FileOperation } from '../telemetry/metrics.js';
import { getProgrammingLanguage } from '../telemetry/telemetry-utils.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { isSubpaths } from '../utils/paths.js';
import { Storage } from '../config/storage.js';
import { isAutoMemPath } from '../memory/paths.js';
import { memoryFreshnessNote } from '../memory/memoryAge.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('READ_FILE_CACHE');

/**
 * Parameters for the ReadFile tool
 */
export interface ReadFileToolParams {
  /**
   * The absolute path to the file to read
   */
  file_path: string;

  /**
   * The line number to start reading from (optional)
   */
  offset?: number;

  /**
   * The number of lines to read (optional)
   */
  limit?: number;

  /**
   * For PDF files, the page range to extract as text (e.g. "1-5", "3", "10-20").
   * Pages are 1-indexed. Max 20 pages per request. Open-ended ranges like "3-"
   * are not supported.
   */
  pages?: string;
}

class ReadFileToolInvocation extends BaseToolInvocation<
  ReadFileToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: ReadFileToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    const shortPath = shortenPath(relativePath);

    if (this.params.pages) {
      return `${shortPath} (pages ${this.params.pages})`;
    }

    const { offset, limit } = this.params;
    if (offset !== undefined && limit !== undefined) {
      return `${shortPath} (lines ${offset + 1}-${offset + limit})`;
    } else if (offset !== undefined) {
      return `${shortPath} (from line ${offset + 1})`;
    } else if (limit !== undefined) {
      return `${shortPath} (first ${limit} lines)`;
    }

    return shortPath;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path, line: this.params.offset }];
  }

  /**
   * Returns 'ask' for paths outside the workspace/temp/userSkills directories,
   * so that external file reads require user confirmation.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const filePath = path.resolve(this.params.file_path);
    const workspaceContext = this.config.getWorkspaceContext();

    const allowedRoots = [
      this.config.storage.getProjectTempDir(),
      // Background subagent transcripts live under <projectDir>/subagents/ and
      // are advertised to the model as polling targets via read_file.
      path.join(this.config.storage.getProjectDir(), 'subagents'),
      Storage.getGlobalTempDir(),
      os.tmpdir(),
      ...this.config.storage.getUserSkillsDirs(),
      Storage.getUserExtensionsDir(),
    ];

    if (
      workspaceContext.isPathWithinWorkspace(filePath) ||
      isSubpaths(allowedRoots, filePath) ||
      // isAutoMemPath uses the narrower managed auto-memory root for this
      // project — not the broad getMemoryBaseDir() — to avoid exposing
      // sensitive ~/.qwen files such as settings.json or OAuth credentials.
      isAutoMemPath(filePath, this.config.getTargetDir())
    ) {
      return 'allow';
    }
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    const absPath = path.resolve(this.params.file_path);
    const projectRoot = this.config.getTargetDir();
    // Auto-memory files (AGENTS.md and friends under the auto-memory
    // root) get a per-read freshness `<system-reminder>` prepended in
    // the slow path — the signal that tells the model to treat the
    // contents as a point-in-time snapshot. Returning the
    // file_unchanged placeholder would skip that prepend, silently
    // dropping the staleness warning for the rest of the session.
    // These files are small; re-emit them on every read.
    const isAutoMem = isAutoMemPath(absPath, projectRoot);
    // The cache can be disabled at the Config level (escape hatch for
    // sessions where the "model has already seen the prior tool result"
    // assumption breaks down — e.g. after context compaction or
    // transcript transformation). When disabled we bypass both the
    // fast-path lookup and the post-read record so behaviour matches
    // the pre-cache implementation byte-for-byte.
    //
    // Auto-memory files are *recorded* in the cache (so prior-read
    // enforcement on Edit / WriteFile recognises them as read) but
    // never serve the file_unchanged placeholder — those files own a
    // per-read freshness `<system-reminder>` that must be re-emitted
    // on every read.
    const cacheEnabled = !this.config.getFileReadCacheDisabled();
    const useFastPath = cacheEnabled && !isAutoMem;
    const cache = this.config.getFileReadCache();
    // A "full" Read consumes the whole file: no offset, no limit, no PDF
    // page range. Only full Reads are eligible for the file_unchanged
    // fast-path; range-scoped Reads always go through, since the model
    // may legitimately ask for a different slice next time.
    const isFullRead =
      this.params.offset === undefined &&
      this.params.limit === undefined &&
      this.params.pages === undefined;

    // Stat up front so we can consult the cache before doing any heavy
    // work. processSingleFileContent re-stats anyway; the extra syscall
    // here is microseconds. If stat fails we fall through to the normal
    // pipeline so its error handling stays the single source of truth.
    let stats: Stats | undefined;
    try {
      stats = await fs.stat(absPath);
    } catch (err) {
      debugLogger.debug('stat-failed', {
        path: absPath,
        code: (err as NodeJS.ErrnoException).code,
      });
    }

    if (useFastPath && stats && isFullRead) {
      const status = cache.check(stats);
      if (
        status.state === 'fresh' &&
        status.entry.lastReadAt !== undefined &&
        status.entry.lastReadWasFull &&
        status.entry.lastReadCacheable &&
        (status.entry.lastWriteAt === undefined ||
          status.entry.lastReadAt > status.entry.lastWriteAt)
      ) {
        debugLogger.debug('hit', { path: absPath });
        return this.unchangedResult(absPath);
      }
      debugLogger.debug('miss', { path: absPath, state: status.state });
    }

    const result = await processSingleFileContent(
      this.params.file_path,
      this.config,
      this.params.offset,
      this.params.limit,
      this.params.pages,
    );

    if (result.error) {
      return {
        llmContent: result.llmContent,
        returnDisplay: result.returnDisplay || 'Error reading file',
        error: {
          message: result.error,
          type: result.errorType,
        },
      };
    }

    // Record a cache entry so that subsequent identical Reads can hit
    // the file_unchanged fast-path, and so prior-read enforcement on
    // Edit / WriteFile can recognise the read.
    //
    // Two independent flags are recorded:
    //
    //  - `cacheable` — whether the content is plain text (not binary /
    //    image / audio / video / PDF / notebook). This is the flag
    //    `priorReadEnforcement.ts` consults to decide whether the
    //    model has seen a payload that Edit / WriteFile can mutate as
    //    text. It must NOT include "was the read truncated", because
    //    a truncated text read still produced text — bundling those
    //    two concerns is what produced the issue #3964 regression
    //    where a partial Read of a regular `.kt` / `.cpp` / `.py`
    //    file caused the next Edit to be rejected with the
    //    misleading "binary / image / audio / video / PDF / notebook
    //    payload" error.
    //
    //  - `full` — whether the model has seen every byte of the
    //    current file. This now gates ONLY the file_unchanged
    //    fast-path; PR #4002 removed WriteFile's `requireFullRead`
    //    (the truncate-tool-output limit made "fully read" an
    //    impossible precondition on files past the limit, deadlocking
    //    issue #3945). A "full" Read at the request level (no
    //    offset / limit / pages) only counts as full at the cache
    //    level if the produced content was not truncated, otherwise
    //    the model only saw the head and a follow-up `file_unchanged`
    //    placeholder would falsely imply "you've already seen
    //    everything".
    //
    // The stat we record is the one taken inside `processSingleFileContent`
    // and surfaced via `result.stats`. The internal stat happens
    // immediately before the actual content read, so the fingerprint
    // it captures is the one closest to the bytes the model received.
    // Falling back to a post-read re-stat would describe a possibly-
    // mutated file rather than the file the read returned: a write
    // landing between the read and the post-stat would let the cache
    // record fingerprint Y for content the model only saw at X, and
    // a follow-up Edit would pass enforcement (`fresh + full +
    // cacheable @ Y`) against bytes the model never legitimately saw.
    //
    // Race residue: the internal-stat-to-actual-read window is still
    // a few microseconds wide. Closing it completely needs a content
    // hash on the read pipeline (deferred follow-up — see Risk
    // section in the PR description).
    if (cacheEnabled && (result.stats ?? stats)) {
      const cacheable =
        typeof result.llmContent === 'string' &&
        result.originalLineCount !== undefined;
      const recordStats: Stats = result.stats ?? stats!;
      cache.recordRead(absPath, recordStats, {
        full: isFullRead && !result.isTruncated,
        cacheable,
      });
    }

    let llmContent: PartUnion;
    if (result.isTruncated) {
      const [start, end] = result.linesShown!;
      const total = result.originalLineCount!;
      llmContent = `Showing lines ${start}-${end} of ${total} total lines.\n\n---\n\n${result.llmContent}`;
    } else {
      llmContent = result.llmContent || '';
    }

    // For memory files, prepend a per-file staleness caveat so the model knows
    // the content is a point-in-time snapshot and may be stale.
    if (typeof llmContent === 'string' && isAutoMem) {
      // Reuse the stat from above when we have it; only re-stat as a
      // fallback so memory-file behavior survives a stat failure earlier
      // (which would leave `stats` undefined).
      try {
        const memStat = stats ?? (await fs.stat(absPath));
        const note = memoryFreshnessNote(memStat.mtimeMs);
        if (note) {
          llmContent = note + llmContent;
        }
      } catch {
        // Best-effort — if stat fails, omit the note silently.
      }
    }

    const lines =
      typeof result.llmContent === 'string'
        ? result.llmContent.split('\n').length
        : undefined;
    const mimetype = getSpecificMimeType(this.params.file_path);
    const programming_language = getProgrammingLanguage({
      file_path: this.params.file_path,
    });
    logFileOperation(
      this.config,
      new FileOperationEvent(
        ReadFileTool.Name,
        FileOperation.READ,
        lines,
        mimetype,
        path.extname(this.params.file_path),
        programming_language,
      ),
    );

    return {
      llmContent,
      returnDisplay: result.returnDisplay || '',
    };
  }

  /**
   * Build the placeholder ToolResult returned when the cache indicates
   * the file has not changed since the model last fully read it. The
   * placeholder is intentionally explicit about its assumptions so the
   * model can decide whether to trust it:
   *
   *  1. The full content was emitted *earlier in this conversation*.
   *     If the conversation has been compacted, summarised, or the
   *     model is a subagent receiving a transformed transcript, the
   *     prior content may no longer be retrievable — the model should
   *     re-read with explicit offset/limit in that case.
   *  2. External mutations the cache cannot observe (shell writes via
   *     run_shell_command, MCP tool writes, other processes touching
   *     the file) will not appear here as `stale`. If the model
   *     suspects drift, it should re-read with explicit offset/limit.
   *
   * No `logFileOperation` is emitted on this path: the file_unchanged
   * fast-path bypasses the read pipeline entirely, and the existing
   * `FileOperationEvent` schema has no representation for "served from
   * cache". A dedicated cache-hit metric can be added when telemetry
   * needs visibility into the fast-path's effectiveness.
   */
  private unchangedResult(absPath: string): ToolResult {
    const relativePath = shortenPath(
      makeRelative(absPath, this.config.getTargetDir()),
    );
    const llmContent =
      `[File ${relativePath} unchanged since last read in this session — ` +
      `the full content was provided earlier in this conversation. ` +
      `If you cannot retrieve that prior content (e.g. after context ` +
      `compaction) or you suspect the file was modified outside the read/edit ` +
      `tools (shell command, MCP tool, another process), re-read with ` +
      `explicit offset/limit to fetch current content.]`;
    return {
      llmContent,
      returnDisplay: `Unchanged: ${relativePath}`,
    };
  }
}

/**
 * Implementation of the ReadFile tool logic
 */
export class ReadFileTool extends BaseDeclarativeTool<
  ReadFileToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.READ_FILE;

  constructor(private config: Config) {
    super(
      ReadFileTool.Name,
      ToolDisplayNames.READ_FILE,
      `Reads and returns the content of a specified file. If the file is large, the content will be truncated. The tool's response will clearly indicate if truncation has occurred and will provide details on how to read more of the file using the 'offset' and 'limit' parameters. Handles text, images (PNG, JPG, GIF, WEBP, SVG, BMP), PDF files, and Jupyter notebooks (.ipynb). For text files, it can read specific line ranges. For PDF files, use the 'pages' parameter to extract specific page ranges as text (e.g. '1-5'). Max 20 pages per request. This tool can read Jupyter notebooks (.ipynb) and returns structured cell content with outputs.`,
      Kind.Read,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
            type: 'string',
          },
          offset: {
            description:
              "Optional: For text files, the 0-based line number to start reading from. Requires 'limit' to be set. Use for paginating through large files.",
            type: 'number',
          },
          limit: {
            description:
              "Optional: For text files, maximum number of lines to read. Use with 'offset' to paginate through large files. If omitted, reads the entire file (if feasible, up to a default limit).",
            type: 'number',
          },
          pages: {
            description:
              "Optional: For PDF files, the page range to extract as text (e.g., '1-5', '3', '10-20'). Pages are 1-indexed. Max 20 pages per request. Open-ended ranges like '3-' are not supported. When provided, PDF content is extracted as text regardless of model capabilities.",
            type: 'string',
          },
        },
        required: ['file_path'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: ReadFileToolParams,
  ): string | null {
    // Normalize shell-escaped paths (e.g. "my\ file.txt" → "my file.txt")
    // that may reach the LLM via at-completion or manual typing.
    const filePath = unescapePath(params.file_path.trim());
    params.file_path = filePath;

    if (!filePath) {
      return "The 'file_path' parameter must be non-empty.";
    }

    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}. You must provide an absolute path.`;
    }

    if (params.offset !== undefined && params.offset < 0) {
      return 'Offset must be a non-negative number';
    }
    if (params.limit !== undefined && params.limit <= 0) {
      return 'Limit must be a positive number';
    }

    if (params.pages) {
      const parsed = parsePDFPageRange(params.pages);
      if (!parsed) {
        return `Invalid pages parameter: '${params.pages}'. Use formats like '5' or '1-10'.`;
      }
      if (parsed.lastPage === Infinity) {
        return `Open-ended page ranges (e.g. '3-') are not supported; specify an explicit end page within the 20-page limit (e.g. '3-22').`;
      }
      const maxPages = 20;
      if (parsed.lastPage - parsed.firstPage + 1 > maxPages) {
        return `Pages range exceeds maximum of ${maxPages} pages per request.`;
      }
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldQwenIgnoreFile(params.file_path)) {
      return `File path '${filePath}' is ignored by .qwenignore pattern(s).`;
    }

    return null;
  }

  protected createInvocation(
    params: ReadFileToolParams,
  ): ToolInvocation<ReadFileToolParams, ToolResult> {
    return new ReadFileToolInvocation(this.config, params);
  }
}
