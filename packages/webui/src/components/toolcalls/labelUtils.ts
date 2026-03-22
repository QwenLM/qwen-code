/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const normalizeValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const startsWithAny = (value: string, prefixes: string[]): boolean =>
  prefixes.some((prefix) => value.startsWith(prefix));

const getReadLikeLabelFromTitle = (title: unknown): string | null => {
  const normalizedTitle = normalizeValue(title);

  if (startsWithAny(normalizedTitle, ['readmanyfiles', 'read many files'])) {
    return 'ReadManyFiles';
  }

  if (
    startsWithAny(normalizedTitle, [
      'listfiles',
      'list files',
      'list directory',
    ])
  ) {
    return 'ListFiles';
  }

  if (startsWithAny(normalizedTitle, ['readfile', 'read file'])) {
    return 'ReadFile';
  }

  if (startsWithAny(normalizedTitle, ['skill'])) {
    return 'Skill';
  }

  return null;
};

export const getToolDisplayLabel = ({
  kind,
  title,
}: {
  kind: string;
  title?: unknown;
}): string => {
  const normalizedKind = normalizeValue(kind);

  switch (normalizedKind) {
    case 'execute':
    case 'bash':
    case 'command':
    case 'shell':
    case 'run_shell_command':
      return 'Shell';
    case 'todo_write':
    case 'todowrite':
    case 'update_todos':
    case 'updated_plan':
    case 'updatedplan':
      return 'TodoWrite';
    case 'web_fetch':
    case 'webfetch':
    case 'fetch':
      return 'WebFetch';
    case 'web_search':
    case 'websearch':
      return 'WebSearch';
    case 'grep':
    case 'grep_search':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'search':
    case 'find':
      return 'Search';
    case 'write':
    case 'write_file':
    case 'writefile':
      return 'WriteFile';
    case 'read_many_files':
    case 'readmanyfiles':
      return 'ReadManyFiles';
    case 'list_directory':
    case 'listfiles':
    case 'ls':
      return 'ListFiles';
    case 'read_file':
    case 'readfile':
      return 'ReadFile';
    case 'save_memory':
    case 'savememory':
    case 'memory':
      return 'SaveMemory';
    case 'exit_plan_mode':
      return 'ExitPlanMode';
    case 'task':
      return 'Task';
    case 'skill':
      return 'Skill';
    case 'think':
    case 'thinking':
      return 'Think';
    case 'read':
      return getReadLikeLabelFromTitle(title) ?? 'Read';
    default:
      return kind;
  }
};
