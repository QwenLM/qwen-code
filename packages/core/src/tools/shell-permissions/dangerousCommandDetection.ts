/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { POWERSHELL_TOOL_NAME, SHELL_TOOL_NAME } from '../tool-names.js';
import {
  analyzeShellCommand,
  type ShellCommandAnalysis,
} from './shellCommandAnalysis.js';
import {
  collectShellExecutions,
  locateHead,
} from './shellExecutionAnalysis.js';

/**
 * Set of tool names that execute shell commands.
 * Used to identify when dangerous command detection should apply.
 */
export const SHELL_TOOL_NAMES = new Set([
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  'shell',
]);

/**
 * Patterns that identify destructive/dangerous shell commands.
 * When matched, these commands MUST force 'ask' behavior regardless of
 * any tool-level or content-level allow rules.
 *
 * This ensures users always get an explicit confirmation prompt before
 * commands that could cause irreversible damage.
 */
const DANGEROUS_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  warning: string;
  sql?: true;
}> = [
  // Git — data loss / hard to reverse
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    warning: 'may discard uncommitted changes',
  },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    warning: 'may overwrite remote history',
  },
  {
    pattern:
      /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    warning: 'may permanently delete untracked files',
  },
  {
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    warning: 'may permanently remove stashed changes',
  },
  {
    pattern:
      /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    warning: 'may force-delete a branch',
  },

  // Git — safety bypass
  {
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    warning: 'may skip safety hooks',
  },
  {
    pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/,
    warning: 'may rewrite the last commit',
  },

  // File deletion
  {
    pattern:
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    warning: 'may recursively force-remove files',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    warning: 'may recursively remove files',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,
    warning: 'may force-remove files',
  },

  // Database
  {
    sql: true,
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: 'may drop or truncate database objects',
  },
  {
    sql: true,
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    warning: 'may delete all rows from a database table',
  },

  // Infrastructure
  {
    pattern: /\bkubectl\s+delete\b/,
    warning: 'may delete Kubernetes resources',
  },
  {
    pattern: /\bterraform\s+destroy\b/,
    warning: 'may destroy Terraform infrastructure',
  },
];

const EXECUTABLE_PATTERNS = DANGEROUS_COMMAND_PATTERNS.map((rule) => ({
  ...rule,
  executablePattern: new RegExp(
    '^(?:' + rule.pattern.source + ')',
    rule.pattern.flags,
  ),
}));
const SQL_COMMANDS = new Set([
  'mysql',
  'mariadb',
  'psql',
  'sqlite3',
  'sqlcmd',
  'drop',
  'truncate',
  'delete',
]);
const SCRIPT_INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'php',
]);

/**
 * Checks if a shell tool input contains a dangerous command.
 * Returns the warning message if dangerous, or null if safe.
 *
 * @param input The tool input (expects a `command` string field)
 * @returns Warning string if dangerous, null otherwise
 */
export function isDangerousShellCommand(
  input: Record<string, unknown>,
  precomputed?: ShellCommandAnalysis,
): string | null {
  const command = input['command'];
  if (typeof command !== 'string') {
    return null;
  }

  const analysis = precomputed ?? analyzeShellCommand(command);
  for (const { tokens } of collectShellExecutions(command, analysis)) {
    const head = locateHead(tokens);
    if (!head) continue;
    // Match from the executable command head, not command names in ordinary arguments.
    const executable = [head.name, ...head.args].join(' ');
    const commandArgs = [...head.args];
    if (head.name === 'git' && commandArgs[0] === 'commit') {
      for (let i = 1; i < commandArgs.length - 1; i++) {
        if (
          ['-m', '--message', '-F', '--file', '--author', '--date'].includes(
            commandArgs[i],
          )
        ) {
          commandArgs[++i] = '__argument__';
        }
      }
    }
    const commandShape = [
      head.name,
      ...commandArgs.map((arg) => (/\s/.test(arg) ? '__argument__' : arg)),
    ].join(' ');
    for (const {
      pattern,
      warning,
      sql,
      executablePattern,
    } of EXECUTABLE_PATTERNS) {
      if (sql) {
        // Check SQL in database client and interpreter arguments, not printed or searched text.
        if (!SQL_COMMANDS.has(head.name) && !SCRIPT_INTERPRETERS.has(head.name))
          continue;
        if (pattern.test(executable)) return warning;
      } else if (
        ['git', 'rm', 'kubectl', 'terraform'].includes(head.name) &&
        executablePattern.test(commandShape)
      ) {
        return warning;
      }
    }
  }
  return null;
}
