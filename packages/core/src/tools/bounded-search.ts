/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { isPathWithinRoot } from '../utils/workspaceContext.js';
import type { ToolResult } from './tools.js';
import { ToolErrorType } from './tool-error.js';

export interface BoundedSearchOptions {
  containmentRoot?: string;
  executionTimeoutMs?: number;
}

export function validateContainedSearchPath(requested = '.'): void {
  if (
    path.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    requested.split(/[\\/]/).includes('..')
  ) {
    throw new Error(
      'Search path must be relative and stay within the Session directory.',
    );
  }
}

export function resolveContainedSearchPath(
  containmentRoot: string,
  requested = '.',
): { root: string; searchPath: string } {
  validateContainedSearchPath(requested);
  const root = fs.realpathSync(containmentRoot);
  const searchPath = fs.realpathSync(path.resolve(root, requested));
  if (!isPathWithinRoot(searchPath, root)) {
    throw new Error('Search path resolves outside the Session directory.');
  }
  return { root, searchPath };
}

export function boundedSearchError(message: string): ToolResult {
  // Error details can contain a caller-supplied regexp as well as rg's diagnostics.
  const detail =
    message.length <= 2000 ? message : message.slice(0, 2000) + '…';
  return {
    llmContent: detail,
    returnDisplay: 'Search failed',
    error: { message: detail, type: ToolErrorType.EXECUTION_FAILED },
  };
}

/** Paths stay internal for ownership checks; only content crosses the worker wire. */
export function boundSearchResult(result: ToolResult): ToolResult {
  const budget = 48 * 1024;
  const encodedSize = (candidate: ToolResult) =>
    Buffer.byteLength(
      JSON.stringify({
        ...candidate,
        resultFilePaths: undefined,
        collectedFilePaths: undefined,
      }),
      'utf8',
    );
  if (encodedSize(result) <= budget) return result;
  const body = result.llmContent;
  if (typeof body !== 'string') {
    return boundedSearchError(
      'Search result exceeded its output budget. Narrow the path or pattern and retry.',
    );
  }
  const notice = '\n---\n[Output truncated; results are incomplete.]';
  const base = { ...result, llmContent: notice };
  if (encodedSize(base) > budget) {
    return boundedSearchError(
      'Search path metadata exceeded its output budget. Narrow the path or pattern and retry.',
    );
  }
  let low = 0;
  let high = body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...result, llmContent: body.slice(0, middle) + notice };
    if (encodedSize(candidate) <= budget) low = middle;
    else high = middle - 1;
  }
  // Never leave half of a surrogate pair in the response.
  if (low > 0 && /[\uD800-\uDBFF]/.test(body[low - 1])) low--;
  return { ...result, llmContent: body.slice(0, low) + notice };
}
