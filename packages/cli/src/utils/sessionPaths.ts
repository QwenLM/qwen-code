/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveOpenAILogDir, Storage } from '@qwen-code/qwen-code-core';
import type { CommandContext } from '../ui/commands/types.js';

export interface SessionPathEntry {
  label: string;
  value: string;
}

export interface SessionPathSection {
  title: string;
  entries: SessionPathEntry[];
}

export interface SessionPathInfo {
  sections: SessionPathSection[];
}

export async function collectSessionPathInfo(
  context: CommandContext,
): Promise<SessionPathInfo> {
  const config = context.services.config;
  const sessionId =
    config?.getSessionId() || context.session.stats.sessionId || 'unknown';
  const contentGeneratorConfig = config?.getContentGeneratorConfig();
  const workingDir = config?.getWorkingDir() || process.cwd();
  const openAILogDir = resolveOpenAILogDir(
    contentGeneratorConfig?.openAILoggingDir,
    workingDir,
  );
  const openAILoggingEnabled =
    contentGeneratorConfig?.enableOpenAILogging === true;
  const latestOpenAILog =
    openAILoggingEnabled && sessionId !== 'unknown'
      ? await findLatestOpenAILogForSession(openAILogDir, sessionId)
      : undefined;
  const transcriptPath = config?.getTranscriptPath() || '';
  const debugLogPath =
    config?.getDebugMode() === true && sessionId !== 'unknown'
      ? Storage.getDebugLogPath(sessionId)
      : '';
  const planFilePath =
    config?.getPlanFilePath() ||
    (sessionId === 'unknown' ? '' : Storage.getPlanFilePath(sessionId));
  const planFileExists = planFilePath ? await pathExists(planFilePath) : false;

  const sections: SessionPathSection[] = [
    {
      title: 'Session files',
      entries: [
        { label: 'Session ID', value: sessionId },
        ...(transcriptPath
          ? [{ label: 'Transcript', value: transcriptPath }]
          : []),
        ...(debugLogPath ? [{ label: 'Debug log', value: debugLogPath }] : []),
        ...(planFileExists
          ? [{ label: 'Plan file', value: planFilePath }]
          : []),
      ],
    },
  ];

  if (openAILoggingEnabled) {
    sections.push({
      title: 'OpenAI logs',
      entries: [
        { label: 'Directory', value: openAILogDir },
        { label: 'Latest for session', value: latestOpenAILog ?? 'none yet' },
      ],
    });
  }

  return {
    sections,
  };
}

export function formatSessionPathInfo(info: SessionPathInfo): string {
  const lines: string[] = [];
  for (const [index, section] of info.sections.entries()) {
    if (index > 0) {
      lines.push('');
    }
    lines.push(`${section.title}:`);
    for (const entry of section.entries) {
      lines.push(`  ${entry.label}: ${entry.value}`);
    }
  }
  return lines.join('\n');
}

async function findLatestOpenAILogForSession(
  logDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const files = await listLogFiles(logDir, (name) =>
    /^openai-.*\.json$/.test(name),
  );
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (hasContextSessionId(parsed, sessionId)) {
        return file;
      }
    } catch {
      // Ignore malformed or concurrently-written log files.
    }
  }
  return undefined;
}

async function listLogFiles(
  dir: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort()
      .reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasContextSessionId(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const context = (value as { context?: unknown }).context;
  if (!context || typeof context !== 'object') {
    return false;
  }
  return (context as { sessionId?: unknown }).sessionId === sessionId;
}
