/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createDebugLogger,
  findGitRoot,
  partToString,
  type ChatRecord,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';

const STARTUP_CONTEXT_HEADER =
  'Startup context from Qwen Code.\nThis is background context about recent work and machine/workspace layout. It may be incomplete or stale. Use it to inform responses, and do not repeat it back unless relevant.';
const CURRENT_THREAD_SECTION_TOKEN_BUDGET = 1_200;
const RECENT_WORK_SECTION_TOKEN_BUDGET = 2_200;
const WORKSPACE_SECTION_TOKEN_BUDGET = 1_600;
const NOTES_SECTION_TOKEN_BUDGET = 300;
const REALTIME_TURN_TOKEN_BUDGET = 300;
const MAX_RECENT_THREADS = 40;
const MAX_RECENT_WORK_GROUPS = 8;
const MAX_CURRENT_CWD_ASKS = 8;
const MAX_OTHER_CWD_ASKS = 5;
const MAX_ASK_CHARS = 240;
const TREE_MAX_DEPTH = 2;
const DIR_ENTRY_LIMIT = 20;
const APPROX_BYTES_PER_TOKEN = 4;
const NOISY_DIR_NAMES = new Set([
  '.git',
  '.next',
  '.pytest_cache',
  '.ruff_cache',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'out',
  'target',
]);
const debugLogger = createDebugLogger('LIVE_REALTIME_CONTEXT');

interface RecentThread {
  cwd: string;
  updatedAt: number;
  firstUserMessage: string;
  gitBranch?: string;
}

export interface RealtimeStartupContextOptions {
  runtime: WorkspaceRuntime;
  workspaceRegistry: WorkspaceRegistry;
  sessionId: string;
  currentCwd: string;
  userRoot?: string;
}

function approxTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / APPROX_BYTES_PER_TOKEN);
}

function takeUtf8Prefix(text: string, byteLimit: number): string {
  let bytes = 0;
  let result = '';
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > byteLimit) break;
    result += character;
    bytes += size;
  }
  return result;
}

function takeUtf8Suffix(text: string, byteLimit: number): string {
  const characters = [...text];
  let bytes = 0;
  let result = '';
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > byteLimit) break;
    result = `${character}${result}`;
    bytes += size;
  }
  return result;
}

export function truncateRealtimeTextToTokenBudget(
  text: string,
  budgetTokens: number,
): string {
  const maxBytes = budgetTokens * APPROX_BYTES_PER_TOKEN;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) return text;
  if (maxBytes === 0) return '';

  let contentBytes = maxBytes;
  while (contentBytes > 0) {
    const headBytes = Math.ceil(contentBytes / 2);
    const tailBytes = Math.floor(contentBytes / 2);
    const head = takeUtf8Prefix(text, headBytes);
    const tail = takeUtf8Suffix(text, tailBytes);
    const removedBytes = Math.max(
      0,
      totalBytes -
        Buffer.byteLength(head, 'utf8') -
        Buffer.byteLength(tail, 'utf8'),
    );
    const marker = `…${Math.ceil(removedBytes / APPROX_BYTES_PER_TOKEN)} tokens truncated…`;
    const candidate = `${head}${marker}${tail}`;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate;
    contentBytes -= 1;
  }
  return '';
}

function textOf(record: ChatRecord): string {
  return partToString(record.message?.parts ?? []).trim();
}

function buildCurrentThreadSection(
  records: readonly ChatRecord[],
): string | undefined {
  const turns: Array<{ user: string[]; assistant: string[] }> = [];
  let currentUser: string[] = [];
  let currentAssistant: string[] = [];

  for (const record of records) {
    if (
      record.type === 'user' &&
      (record.provenance === undefined || record.provenance === 'real_user')
    ) {
      const text = textOf(record);
      if (!text) continue;
      if (currentUser.length > 0 || currentAssistant.length > 0) {
        turns.push({ user: currentUser, assistant: currentAssistant });
        currentUser = [];
        currentAssistant = [];
      }
      currentUser.push(text);
    } else if (record.type === 'assistant') {
      const text = textOf(record);
      if (
        !text ||
        (currentUser.length === 0 && currentAssistant.length === 0)
      ) {
        continue;
      }
      currentAssistant.push(text);
    }
  }
  if (currentUser.length > 0 || currentAssistant.length > 0) {
    turns.push({ user: currentUser, assistant: currentAssistant });
  }
  if (turns.length === 0) return undefined;

  const lines = [
    'Most recent user/assistant turns from this exact thread. Use them for continuity when responding.',
  ];
  let remainingBudget =
    CURRENT_THREAD_SECTION_TOKEN_BUDGET - approxTokenCount(lines.join('\n'));
  let retainedTurns = 0;

  for (const [index, turn] of [...turns].reverse().entries()) {
    if (remainingBudget <= 0) break;
    const turnLines = [
      index === 0 ? '### Latest turn' : `### Previous turn ${index}`,
    ];
    if (turn.user.length > 0) {
      turnLines.push('User:', turn.user.join('\n\n'));
    }
    if (turn.assistant.length > 0) {
      turnLines.push('', 'Assistant:', turn.assistant.join('\n\n'));
    }
    const turnText = truncateRealtimeTextToTokenBudget(
      turnLines.join('\n'),
      Math.min(REALTIME_TURN_TOKEN_BUDGET, remainingBudget),
    );
    const turnTokens = approxTokenCount(turnText);
    if (turnTokens === 0) continue;
    lines.push('', turnText);
    remainingBudget = Math.max(0, remainingBudget - turnTokens);
    retainedTurns += 1;
  }
  return retainedTurns > 0 ? lines.join('\n') : undefined;
}

function recentThread(item: SessionListItem): RecentThread {
  return {
    cwd: item.cwd,
    updatedAt: item.mtime,
    firstUserMessage: item.prompt,
    ...(item.gitBranch ? { gitBranch: item.gitBranch } : {}),
  };
}

async function loadRecentThreads(
  workspaceRegistry: WorkspaceRegistry,
): Promise<RecentThread[]> {
  try {
    const pages = await Promise.all(
      workspaceRegistry.listAll().map(async (runtime) => {
        const page = await createWorkspaceRuntimeSessionService(
          runtime,
        ).listSessions({
          size: MAX_RECENT_THREADS,
          archiveState: 'active',
        });
        return page.items.map(recentThread);
      }),
    );
    return pages
      .flat()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RECENT_THREADS);
  } catch (error) {
    debugLogger.warn(
      'Failed to load Live startup tasks from the session catalog:',
      error,
    );
    return [];
  }
}

function groupRoot(cwd: string): string {
  return findGitRoot(cwd) ?? cwd;
}

function buildRecentWorkSection(
  currentCwd: string,
  recentThreads: readonly RecentThread[],
): string | undefined {
  const grouped = new Map<string, RecentThread[]>();
  for (const thread of recentThreads) {
    const root = groupRoot(thread.cwd);
    const entries = grouped.get(root);
    if (entries) entries.push(thread);
    else grouped.set(root, [thread]);
  }
  const currentGroup = groupRoot(currentCwd);
  const groups = [...grouped.entries()].sort(
    ([leftRoot, left], [rightRoot, right]) => {
      const byCurrent =
        Number(leftRoot !== currentGroup) - Number(rightRoot !== currentGroup);
      if (byCurrent !== 0) return byCurrent;
      const byLatest = right[0]!.updatedAt - left[0]!.updatedAt;
      return byLatest !== 0 ? byLatest : leftRoot.localeCompare(rightRoot);
    },
  );

  const sections: string[] = [];
  for (const [root, unsorted] of groups.slice(0, MAX_RECENT_WORK_GROUPS)) {
    const entries = [...unsorted].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    const latest = entries[0];
    if (!latest) continue;
    const lines = [
      `${findGitRoot(latest.cwd) ? '### Git repo' : '### Directory'}: ${root}`,
      `Recent sessions: ${entries.length}`,
      `Latest activity: ${new Date(latest.updatedAt).toISOString()}`,
    ];
    if (latest.gitBranch) lines.push(`Latest branch: ${latest.gitBranch}`);
    lines.push('', 'User asks:');

    const seen = new Set<string>();
    const maxAsks =
      root === currentGroup ? MAX_CURRENT_CWD_ASKS : MAX_OTHER_CWD_ASKS;
    for (const entry of entries) {
      const ask = entry.firstUserMessage.trim().split(/\s+/).join(' ');
      const dedupeKey = `${entry.cwd}:${ask}`;
      if (!ask || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const boundedAsk =
        [...ask].length > MAX_ASK_CHARS
          ? `${[...ask].slice(0, MAX_ASK_CHARS - 3).join('')}...`
          : ask;
      lines.push(`- ${entry.cwd}: ${boundedAsk}`);
      if (seen.size === maxAsks) break;
    }
    if (lines.length > 5) sections.push(lines.join('\n'));
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function isNoisyName(name: string): boolean {
  return name.startsWith('.') || NOISY_DIR_NAMES.has(name);
}

function collectTreeLines(
  directory: string,
  depth: number,
  lines: string[],
): void {
  if (depth >= TREE_MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !isNoisyName(entry.name))
      .sort((left, right) => {
        const byDirectory =
          Number(!left.isDirectory()) - Number(!right.isDirectory());
        return byDirectory !== 0
          ? byDirectory
          : left.name.localeCompare(right.name);
      });
  } catch {
    return;
  }
  for (const entry of entries.slice(0, DIR_ENTRY_LIMIT)) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- ${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) {
      collectTreeLines(join(directory, entry.name), depth + 1, lines);
    }
  }
  if (entries.length > DIR_ENTRY_LIMIT) {
    lines.push(
      `${'  '.repeat(depth)}- ... ${entries.length - DIR_ENTRY_LIMIT} more entries`,
    );
  }
}

function renderTree(root: string): string[] | undefined {
  const lines: string[] = [];
  collectTreeLines(root, 0, lines);
  return lines.length > 0 ? lines : undefined;
}

function buildWorkspaceSection(
  currentCwd: string,
  userRoot: string | undefined,
): string | undefined {
  const gitRoot = findGitRoot(currentCwd) ?? undefined;
  const cwdTree = renderTree(currentCwd);
  const gitRootTree =
    gitRoot && gitRoot !== currentCwd ? renderTree(gitRoot) : undefined;
  const userRootTree =
    userRoot && userRoot !== currentCwd && userRoot !== gitRoot
      ? renderTree(userRoot)
      : undefined;
  if (!cwdTree && !gitRoot && !userRootTree) return undefined;

  const lines = [
    `Current working directory: ${currentCwd}`,
    `Working directory name: ${basename(currentCwd) || currentCwd}`,
  ];
  if (gitRoot) {
    lines.push(`Git root: ${gitRoot}`);
    lines.push(`Git project: ${basename(gitRoot) || gitRoot}`);
  }
  if (userRoot) lines.push(`User root: ${userRoot}`);
  if (cwdTree) lines.push('', 'Working directory tree:', ...cwdTree);
  if (gitRootTree) lines.push('', 'Git root tree:', ...gitRootTree);
  if (userRootTree) lines.push('', 'User root tree:', ...userRootTree);
  return lines.join('\n');
}

function formatSection(
  title: string,
  body: string | undefined,
  budgetTokens: number,
): string | undefined {
  const trimmed = body?.trim();
  if (!trimmed) return undefined;
  const heading = `## ${title}\n`;
  const bodyBudget = budgetTokens - approxTokenCount(heading);
  if (bodyBudget <= 0) return undefined;
  const bounded = truncateRealtimeTextToTokenBudget(trimmed, bodyBudget);
  return bounded ? `${heading}${bounded}` : undefined;
}

export async function buildRealtimeStartupContext(
  options: RealtimeStartupContextOptions,
): Promise<string | undefined> {
  const current = await createWorkspaceRuntimeSessionService(options.runtime)
    .loadSession(options.sessionId)
    .catch(() => undefined);
  const currentThread = buildCurrentThreadSection(
    current?.conversation.messages ?? [],
  );
  const recentWork = buildRecentWorkSection(
    options.currentCwd,
    await loadRecentThreads(options.workspaceRegistry),
  );
  const workspace = buildWorkspaceSection(
    options.currentCwd,
    options.userRoot ?? homedir(),
  );
  if (!currentThread && !recentWork && !workspace) return undefined;

  const parts = [STARTUP_CONTEXT_HEADER];
  const sections = [
    formatSection(
      'Current Thread',
      currentThread,
      CURRENT_THREAD_SECTION_TOKEN_BUDGET,
    ),
    formatSection('Recent Work', recentWork, RECENT_WORK_SECTION_TOKEN_BUDGET),
    formatSection(
      'Machine / Workspace Map',
      workspace,
      WORKSPACE_SECTION_TOKEN_BUDGET,
    ),
    formatSection(
      'Notes',
      'Built at realtime startup from the current thread history, local thread metadata, and a bounded local workspace scan. This excludes repo memory instructions, AGENTS files, project-doc prompt blends, and memory summaries.',
      NOTES_SECTION_TOKEN_BUDGET,
    ),
  ];
  for (const section of sections) {
    if (section) parts.push(section);
  }
  return `<startup_context>\n${parts.join('\n\n')}\n</startup_context>`;
}
