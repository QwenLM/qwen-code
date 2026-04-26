/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopGitDiff, DesktopProject } from '../../api/client.js';
import type { DesktopModelInfo } from '../../../shared/desktopProtocol.js';

const MAX_SESSION_DISPLAY_TITLE_LENGTH = 52;
const MAX_TOPBAR_BRANCH_LABEL_LENGTH = 30;
const MAX_RUNTIME_MODEL_LABEL_LENGTH = 32;

export interface GitDiffStats {
  additions: number;
  deletions: number;
  files: number;
}

export function formatGitStatus(status: DesktopProject['gitStatus']): string {
  if (!status.isRepository) {
    return 'No Git repository';
  }

  if (status.clean) {
    return 'Clean';
  }

  return `${status.modified} modified · ${status.staged} staged · ${status.untracked} untracked`;
}

export function formatGitStatusSummary(
  status: DesktopProject['gitStatus'],
): string {
  if (!status.isRepository) {
    return 'No Git';
  }

  if (status.clean) {
    return 'Clean';
  }

  const dirtyCount = status.modified + status.untracked;
  const parts: string[] = [];

  if (dirtyCount > 0) {
    parts.push(`${dirtyCount} dirty`);
  }

  if (status.staged > 0) {
    parts.push(`${status.staged} staged`);
  }

  return parts.length > 0 ? parts.join(' · ') : 'Dirty';
}

export function summarizeGitDiffStats(
  gitDiff: DesktopGitDiff | null | undefined,
): GitDiffStats | null {
  const files = gitDiff?.files ?? [];
  if (files.length === 0) {
    return null;
  }

  const stats = files.reduce(
    (totals, file) => {
      const lines =
        file.hunks.length > 0
          ? file.hunks.flatMap((hunk) => hunk.lines)
          : file.diff.split('\n');

      for (const line of lines) {
        if (line.startsWith('+++') || line.startsWith('---')) {
          continue;
        }

        if (line.startsWith('+')) {
          totals.additions += 1;
        } else if (line.startsWith('-')) {
          totals.deletions += 1;
        }
      }

      return totals;
    },
    { additions: 0, deletions: 0 },
  );

  return {
    ...stats,
    files: files.length,
  };
}

export function formatGitDiffStats(stats: GitDiffStats): string {
  return `+${stats.additions} -${stats.deletions}`;
}

export function formatSessionDisplayTitle(
  title: string | null | undefined,
): string {
  const normalized = normalizeSessionTitle(title ?? '');

  if (!normalized || isSessionIdentifier(normalized)) {
    return 'Untitled thread';
  }

  return truncateLabel(normalized, MAX_SESSION_DISPLAY_TITLE_LENGTH);
}

export function formatTopbarBranchLabel(
  branch: string | null | undefined,
): string {
  const normalized = branch?.trim() || 'No branch';
  return truncateMiddle(normalized, MAX_TOPBAR_BRANCH_LABEL_LENGTH);
}

export function formatRuntimeModelLabel(model: DesktopModelInfo): string {
  const label = stripCodingPlanProviderPrefix(formatRuntimeModelTitle(model));
  const pathTail = label.split('/').pop()?.trim() || label;
  const compactLabel = pathTail.length < label.length ? pathTail : label;

  return truncateRuntimeLabel(compactLabel, MAX_RUNTIME_MODEL_LABEL_LENGTH);
}

export function formatRuntimeModelTitle(model: DesktopModelInfo): string {
  const label = (model.name || model.modelId).trim();
  return label.length > 0 ? label : model.modelId;
}

function normalizeSessionTitle(title: string): string {
  return title
    .replace(/`{1,3}([^`]+)`{1,3}/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\bConnected to\s+(?:session[-_\w]+|[0-9a-f-]{8,})/giu, '')
    .replace(
      /(?:\s+\b(?:in|at|from|via|on|to)\s+)?https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)"'`<>,;]*)?/giu,
      '',
    )
    .replace(/\s+\b(?:in|at|from|via|on|to)\s+local server\b/giu, '')
    .replace(
      /(^|[\s(["'`])((?:~|\/(?:Users|home|tmp|var|private|Volumes|opt|workspace|run|mnt))\/[^\s)"'`<>,;]+)/gu,
      (_match, prefix: string, path: string) => `${prefix}${basename(path)}`,
    )
    .replace(
      /(^|[\s(["'`])([A-Za-z]:\\[^\s)"'`<>,;]+)/gu,
      (_match, prefix: string, path: string) => `${prefix}${basename(path)}`,
    )
    .replace(/\b(?:session|thread|conversation)[-_][\w-]*\d[\w-]*\b/giu, '')
    .replace(/\b[A-Za-z0-9_:-]{48,}\b/gu, '')
    .replace(/[*~>#]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function basename(path: string): string {
  const normalized = path.replace(/\\/gu, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) ?? 'path';
}

function isSessionIdentifier(value: string): boolean {
  return (
    /^(?:session|thread|conversation)[-_\w]*\d[\w-]*$/iu.test(value) ||
    /^[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/iu.test(value)
  );
}

function stripCodingPlanProviderPrefix(label: string): string {
  return label
    .replace(/^\[ModelStudio Coding Plan(?: for [^\]]+)?\]\s*/u, '')
    .trim();
}

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function truncateRuntimeLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const truncated = value.slice(0, maxLength - 3).replace(/[\s/_-]+$/u, '');
  return `${truncated}...`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const preservedLength = maxLength - 3;
  const startLength = Math.ceil(preservedLength * 0.58);
  const endLength = preservedLength - startLength;

  return `${value.slice(0, startLength).trimEnd()}...${value
    .slice(-endLength)
    .trimStart()}`;
}
