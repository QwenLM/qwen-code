/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ArenaAgentResult,
  ArenaDiffSummary,
  ArenaFileChangeSummary,
} from './types.js';
import { isSuccessStatus } from '../runtime/agent-types.js';

/**
 * Parse a unified git diff into file-level and aggregate line-change stats.
 */
export function summarizeUnifiedDiff(
  diff: string | undefined,
): ArenaDiffSummary {
  if (!diff) {
    return { files: [], additions: 0, deletions: 0 };
  }

  const files: ArenaFileChangeSummary[] = [];
  let current: ArenaFileChangeSummary | undefined;

  const finishFile = () => {
    if (!current) return;
    if (current.additions > 0 || current.deletions > 0) {
      files.push(current);
    }
    current = undefined;
  };

  const ensureFile = (path: string) => {
    if (!current) {
      current = { path, additions: 0, deletions: 0 };
      return;
    }
    current.path = path;
  };

  for (const line of diff.split('\n')) {
    const gitPath = parseDiffGitPath(line);
    if (gitPath) {
      finishFile();
      current = {
        path: gitPath,
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    if (line.startsWith('+++ ')) {
      const path = normalizeDiffPath(line.slice(4));
      if (path !== '/dev/null') {
        ensureFile(path);
      }
      continue;
    }

    if (line.startsWith('--- ')) {
      const path = normalizeDiffPath(line.slice(4));
      if (!current && path !== '/dev/null') {
        ensureFile(path);
      }
      continue;
    }

    if (!current) continue;

    if (line.startsWith('+')) {
      current.additions++;
    } else if (line.startsWith('-')) {
      current.deletions++;
    }
  }

  finishFile();

  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/**
 * Build a deterministic approach summary when semantic LLM summarization is
 * unavailable or returns unusable output.
 */
export function buildFallbackApproachSummary(result: ArenaAgentResult): string {
  if (!isSuccessStatus(result.status)) {
    const suffix = result.error ? `: ${result.error}` : '';
    return `Did not produce an applicable result${suffix}.`;
  }

  const diffSummary =
    result.diffSummary ?? summarizeUnifiedDiff(result.diff ?? '');
  if (diffSummary.files.length === 0) {
    return 'No code changes detected.';
  }

  const fileWord = diffSummary.files.length === 1 ? 'file' : 'files';
  const toolWord = result.stats.toolCalls === 1 ? 'tool call' : 'tool calls';
  return `Changed ${diffSummary.files.length} ${fileWord} with ${result.stats.toolCalls} ${toolWord} (${formatLineStats(diffSummary.additions, diffSummary.deletions)}).`;
}

export function formatLineStats(additions: number, deletions: number): string {
  if (additions === 0 && deletions === 0) {
    return 'no line changes';
  }
  return `+${additions}/-${deletions}`;
}

function normalizeDiffPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '/dev/null') {
    return trimmed;
  }
  return trimmed.replace(/^[ab]\//, '');
}

function parseDiffGitPath(line: string): string | undefined {
  const prefix = 'diff --git a/';
  const separator = ' b/';
  if (!line.startsWith(prefix)) {
    return undefined;
  }

  const separatorIndex = line.lastIndexOf(separator);
  if (separatorIndex < prefix.length) {
    return undefined;
  }

  const pathStart = separatorIndex + separator.length;
  if (pathStart >= line.length) {
    return undefined;
  }

  return line.slice(pathStart);
}
