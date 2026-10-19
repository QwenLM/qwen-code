/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { createHash } from 'node:crypto';
import { wrapSystemReminder } from './environmentContext.js';

export type ContextFileSnapshot = ReadonlyArray<{
  readonly path: string;
  readonly content: string;
}>;

const CONTEXT_FILES_OPENER = 'User and project instructions';
const INSTRUCTION_PRECEDENCE =
  'Follow these user and project instructions. They override default behavior. ' +
  'A newer explicit user instruction takes precedence over these file instructions.';

export function getContextFileSnapshot(config: {
  getUserMemory(): string;
  getContextFiles?(): ContextFileSnapshot | undefined;
}): ContextFileSnapshot {
  const content = config.getUserMemory().trim();
  if (!content) return [];
  return (
    config.getContextFiles?.() ?? [
      { path: 'user-provided instructions', content },
    ]
  );
}

export function buildContextFilesReminder(
  files: ContextFileSnapshot,
  previous?: ContextFileSnapshot,
): string | null {
  if (previous === undefined) {
    return wrapSystemReminder(
      [
        `${CONTEXT_FILES_OPENER} (current complete set):`,
        INSTRUCTION_PRECEDENCE,
        'This is the complete current set of instruction files. It replaces all earlier copies and updates; instructions from files absent here no longer apply.',
        files.length > 0
          ? files.map((file) => file.content).join('\n\n')
          : 'No instruction files are currently loaded.',
      ].join('\n\n'),
    );
  }

  const prior = new Map(previous.map((file) => [file.path, file.content]));
  const currentPaths = new Set(files.map((file) => file.path));
  const changed = files.filter((file) => prior.get(file.path) !== file.content);
  const removed = previous.filter((file) => !currentPaths.has(file.path));
  if (changed.length === 0 && removed.length === 0) return null;

  return wrapSystemReminder(
    [
      `${CONTEXT_FILES_OPENER} updated:`,
      INSTRUCTION_PRECEDENCE,
      ...changed.map(
        (file) =>
          `Updated instructions from: ${JSON.stringify(file.path)}. This replaces the earlier copy.\n\n${file.content}`,
      ),
      ...removed.map(
        (file) =>
          `Instructions no longer present: ${JSON.stringify(file.path)}. The earlier instructions from this file no longer apply.`,
      ),
    ].join('\n\n'),
  );
}

export function isContextFilesReminder(text: string): boolean {
  return (
    text.startsWith(`<system-reminder>\n${CONTEXT_FILES_OPENER}`) &&
    text.trimEnd().endsWith('</system-reminder>')
  );
}

export function stripContextFilesReminders(history: Content[]): Content[] {
  return history.flatMap((content) => {
    if (content.role !== 'user' || !content.parts) return [content];
    const parts = content.parts.filter(
      (part) => !part.text || !isContextFilesReminder(part.text),
    );
    if (parts.length === content.parts.length) return [content];
    return parts.length > 0 ? [{ ...content, parts }] : [];
  });
}

export function ensureCurrentContextFiles(
  history: Content[],
  files: ContextFileSnapshot,
): Content[] {
  const lastReminder = getLastContextFilesReminder(history)?.text;
  if (files.length === 0 && lastReminder === undefined) return history;
  const reminder = buildContextFilesReminder(files)!;
  return lastReminder === reminder
    ? history
    : [...history, { role: 'user', parts: [{ text: reminder }] }];
}

export function getLastContextFilesReminder(
  history: readonly Content[],
): Part | undefined {
  let lastReminder: Part | undefined;
  for (const content of history) {
    if (content.role !== 'user') continue;
    for (const part of content.parts ?? []) {
      if (part.text && isContextFilesReminder(part.text)) {
        lastReminder = part;
      }
    }
  }
  return lastReminder;
}

export function getContextFilesHistoryFingerprint(
  history: readonly Content[],
): string {
  const hash = createHash('sha256');
  for (const content of history) {
    if (content.role !== 'user') continue;
    for (const part of content.parts ?? []) {
      if (part.text && isContextFilesReminder(part.text)) {
        hash.update(JSON.stringify(part.text));
      }
    }
  }
  return hash.digest('hex');
}
