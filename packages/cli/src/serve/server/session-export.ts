/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import {
  collectSessionData,
  generateExportFilename,
  normalizeSessionData,
  toHtml,
  toJson,
  toJsonl,
  toMarkdown,
  type ExportConfig,
  type ExportSessionData,
} from '../../ui/utils/export/index.js';

// Archived export materializes the full transcript in memory, so it stays
// bounded at 256 MiB rather than inheriting the 1 GiB streaming index ceiling.
export const ARCHIVED_EXPORT_MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

const SESSION_EXPORT_FORMATS = ['html', 'md', 'json', 'jsonl'] as const;

export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

interface ExportFormatDefinition {
  mimeType: string;
  // `records` is required because the HTML path cannot render without it: the
  // document projector is the only HTML implementation left, and it projects
  // from original records rather than from the normalized session data. The
  // other formatters take `ExportSessionData` alone and simply ignore the
  // second argument, which structural typing allows. Keep the signature shared
  // so a caller cannot pick a format and then forget to pass records.
  render: (data: ExportSessionData, records: readonly unknown[]) => string;
}

const EXPORT_FORMATS: Record<SessionExportFormat, ExportFormatDefinition> = {
  html: {
    mimeType: 'text/html; charset=utf-8',
    render: toHtml,
  },
  md: {
    mimeType: 'text/markdown; charset=utf-8',
    render: toMarkdown,
  },
  json: {
    mimeType: 'application/json; charset=utf-8',
    render: toJson,
  },
  jsonl: {
    mimeType: 'application/jsonl; charset=utf-8',
    render: toJsonl,
  },
};

export interface SessionExportResult {
  format: SessionExportFormat;
  filename: string;
  mimeType: string;
  content: string;
}

export function parseSessionExportFormat(
  rawFormat: unknown,
): SessionExportFormat | undefined {
  if (rawFormat === undefined) return 'html';
  if (typeof rawFormat !== 'string') return undefined;
  return SESSION_EXPORT_FORMATS.includes(rawFormat as SessionExportFormat)
    ? (rawFormat as SessionExportFormat)
    : undefined;
}

export function sessionExportFormatValues(): SessionExportFormat[] {
  return [...SESSION_EXPORT_FORMATS];
}

export async function exportSessionTranscript(params: {
  workspaceCwd: string;
  sessionId: string;
  format: SessionExportFormat;
  archiveState?: SessionArchiveState;
  config?: ExportConfig;
  runtimeBaseDir?: string;
  worktreeRoot?: string;
}): Promise<SessionExportResult> {
  const { workspaceCwd, sessionId, format } = params;
  const service = new SessionService(workspaceCwd, {
    ...(params.runtimeBaseDir !== undefined
      ? { runtimeBaseDir: params.runtimeBaseDir }
      : {}),
    ...(params.worktreeRoot !== undefined
      ? { worktreeRoot: params.worktreeRoot }
      : {}),
  });
  const sessionData =
    params.archiveState === 'archived'
      ? await service.loadArchivedSession(sessionId, {
          maxBytes: ARCHIVED_EXPORT_MAX_TRANSCRIPT_BYTES,
        })
      : await service.loadSession(sessionId);
  if (!sessionData) {
    throw new SessionNotFoundError(sessionId);
  }

  const exportConfig = params.config ?? {};
  const collected = await collectSessionData(
    sessionData.conversation,
    exportConfig,
  );
  const normalized = normalizeSessionData(
    collected,
    sessionData.conversation.messages,
    exportConfig,
  );
  const formatDefinition = EXPORT_FORMATS[format];
  return {
    format,
    filename: generateExportFilename(format),
    mimeType: formatDefinition.mimeType,
    content: formatDefinition.render(
      normalized,
      sessionData.conversation.messages,
    ),
  };
}
