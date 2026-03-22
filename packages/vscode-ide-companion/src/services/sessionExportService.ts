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

export const SESSION_EXPORT_FORMATS = ['html', 'md', 'json', 'jsonl'] as const;

export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

export interface SessionExportResult {
  cancelled: boolean;
  filename?: string;
  uri?: vscode.Uri;
}

const EXPORT_CONFIG = {
  getChannel: () => 'vscode-companion',
  getToolRegistry: () => undefined,
} as unknown as Config;

const SAVE_DIALOG_FILTERS: Record<
  SessionExportFormat,
  Record<string, string[]>
> = {
  html: { HTML: ['html'] },
  md: { Markdown: ['md'] },
  json: { JSON: ['json'] },
  jsonl: { JSONL: ['jsonl'] },
};

function isSessionExportFormat(value: string): value is SessionExportFormat {
  return SESSION_EXPORT_FORMATS.includes(value as SessionExportFormat);
}

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
    return 'html';
  }

  const normalizedFormat = format.toLowerCase();
  if (rest.length === 0 && isSessionExportFormat(normalizedFormat)) {
    return normalizedFormat;
  }

  throw new Error(
    'Unsupported /export format. Use /export, /export html, /export md, /export json, or /export jsonl.',
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
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(cwd, filename)),
    filters: SAVE_DIALOG_FILTERS[format],
    saveLabel: 'Export Session',
    title: 'Export Session',
  });

  if (!uri) {
    return { cancelled: true };
  }

  await fs.writeFile(uri.fsPath, content, 'utf-8');

  return {
    cancelled: false,
    filename: path.basename(uri.fsPath),
    uri,
  };
}
