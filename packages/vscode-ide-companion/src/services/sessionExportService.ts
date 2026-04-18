/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SessionService, type Config } from '@qwen-code/qwen-code-core';
import {
  collectSessionData,
  generateExportFilename,
  normalizeSessionData,
  toHtml,
  toJson,
  toJsonl,
  toMarkdown,
} from '../../../cli/src/ui/utils/export/index.js';
import {
  EXPORT_SESSION_FORMATS,
  getExportSubcommandRequiredMessage,
  isSessionExportFormat,
  type SessionExportFormat,
} from '../utils/exportSlashCommand.js';

export { EXPORT_SESSION_FORMATS as SESSION_EXPORT_FORMATS };
export type { SessionExportFormat } from '../utils/exportSlashCommand.js';

export interface SessionExportResult {
  filename: string;
  uri: vscode.Uri;
}

const EXPORT_CONFIG = {
  getChannel: () => 'vscode-companion',
  getToolRegistry: () => undefined,
} as unknown as Config;

export function parseExportSlashCommand(
  text: string,
): SessionExportFormat | null {
  const trimmed = text.replace(/\u200B/g, '').trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const [command, format, ...rest] = parts;
  if (command !== '/export') {
    return null;
  }

  if (!format) {
    throw new Error(getExportSubcommandRequiredMessage());
  }

  const normalizedFormat = format.toLowerCase();
  if (rest.length === 0 && isSessionExportFormat(normalizedFormat)) {
    return normalizedFormat;
  }

  throw new Error(
    'Unsupported /export format. Use /export html, /export md, /export json, or /export jsonl.',
  );
}

function renderExportContent(
  format: SessionExportFormat,
  normalizedData: Awaited<ReturnType<typeof normalizeSessionData>>,
): string {
  switch (format) {
    case 'html':
      return toHtml(normalizedData);
    case 'md':
      return toMarkdown(normalizedData);
    case 'json':
      return toJson(normalizedData);
    case 'jsonl':
      return toJsonl(normalizedData);
    default: {
      const unreachableFormat: never = format;
      throw new Error(`Unsupported export format: ${unreachableFormat}`);
    }
  }
}

export async function exportSessionToFile(options: {
  sessionId: string;
  cwd: string;
  format: SessionExportFormat;
}): Promise<SessionExportResult> {
  const { cwd, format, sessionId } = options;
  const sessionService = new SessionService(cwd);
  const sessionData = await sessionService.loadSession(sessionId);

  if (!sessionData) {
    throw new Error('No active session found to export.');
  }

  const exportData = await collectSessionData(
    sessionData.conversation,
    EXPORT_CONFIG,
  );
  const normalizedData = normalizeSessionData(
    exportData,
    sessionData.conversation.messages,
    EXPORT_CONFIG,
  );
  const content = renderExportContent(format, normalizedData);
  const filename = generateExportFilename(format);
  const uri = vscode.Uri.file(path.join(cwd, filename));

  await fs.writeFile(uri.fsPath, content, 'utf-8');

  return {
    filename,
    uri,
  };
}
