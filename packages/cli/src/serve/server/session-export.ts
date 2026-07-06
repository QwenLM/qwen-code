/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionService } from '@qwen-code/qwen-code-core';
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

const SESSION_EXPORT_FORMATS = ['html', 'md', 'json', 'jsonl'] as const;

export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

interface ExportFormatDefinition {
  mimeType: string;
  render: (data: ExportSessionData) => string;
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
  config?: ExportConfig;
}): Promise<SessionExportResult> {
  const { workspaceCwd, sessionId, format } = params;
  const sessionData = await new SessionService(workspaceCwd).loadSession(
    sessionId,
  );
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
    content: formatDefinition.render(normalized),
  };
}
