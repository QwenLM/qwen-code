/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopProject } from '../../api/client.js';

const MAX_SESSION_DISPLAY_TITLE_LENGTH = 52;

export function formatGitStatus(status: DesktopProject['gitStatus']): string {
  if (!status.isRepository) {
    return 'No Git repository';
  }

  if (status.clean) {
    return 'Clean';
  }

  return `${status.modified} modified · ${status.staged} staged · ${status.untracked} untracked`;
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

function normalizeSessionTitle(title: string): string {
  return title
    .replace(/`{1,3}([^`]+)`{1,3}/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\bConnected to\s+(?:session[-_\w]+|[0-9a-f-]{8,})/giu, '')
    .replace(
      /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)"'`<>,;]*)?/giu,
      'local server',
    )
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

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}
