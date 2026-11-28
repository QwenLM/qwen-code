/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  findGitSubcommand,
  getEffectiveCommandDetail,
  normalizeCommand,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import { stripSafeWrappers } from './shell-permissions/shellPermissions.js';

/**
 * The mutually exclusive result fields a shell-family payload carries: a failure
 * sets `isError`, an expected non-zero exit sets `returnCodeInterpretation`, and
 * a plain success sets neither. Declared once, and produced only by
 * `interpretShellExitStatus`, so the two fields cannot drift apart between the
 * payload types that spread them in.
 */
export interface ShellExitStatusFields {
  isError?: true;
  returnCodeInterpretation?: string;
}

/**
 * Commands that document exit 1 as a normal answer, and what it means. `git`
 * entries use a `git <subcommand>` composite key so subcommand semantics
 * register the same way plain commands do. Exit codes >= 2 stay errors: for
 * every command here that is a usage or I/O failure, not an answer.
 */
const EXPECTED_EXIT_ONE = new Map<string, string>([
  ['grep', 'No matches found'],
  ['rg', 'No matches found'],
  ['egrep', 'No matches found'],
  ['fgrep', 'No matches found'],
  ['git grep', 'No matches found'],
  ['find', 'Some directories were inaccessible'],
  ['diff', 'Files differ'],
  ['git diff', 'Files differ'],
  ['test', 'Condition is false'],
  ['[', 'Condition is false'],
]);

const GIT_SUBCOMMANDS = [...EXPECTED_EXIT_ONE.keys()]
  .filter((key) => key.startsWith('git '))
  .map((key) => key.slice('git '.length));

/**
 * Cheap prefilter: only these names can change the answer, so a command that
 * mentions none of them skips the shell parse entirely. Deliberately loose —
 * `npm test` passes it and then fails the real lookup — because its only job is
 * to keep the common failure (a build or test command exiting 1) off the parser.
 */
const INTERPRETED_COMMAND_PREFILTER = new RegExp(
  `(?:^|[\\s;&|(])(?:${[...EXPECTED_EXIT_ONE.keys()]
    .map((key) => key.split(' ')[0])
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?=$|[\\s;&|)])`,
);

/**
 * The lookup key for a command's exit-code semantics: the effective command's
 * normalized name, or `git <subcommand>` for git.
 *
 * The whitespace-split fallbacks are not dead weight: `parseBashCommandDetails`
 * returns null until the tree-sitter grammar finishes loading, so the first
 * calls in a process get no parse at all. Splitting on whitespace still resolves
 * the plain `grep needle file` shape correctly, and anything it gets wrong just
 * misses the map and reports the plain failure.
 */
function getInterpreterKey(command: string): string {
  // Parse as bash: the shell tool runs Git Bash even on Windows, and leaving the
  // parser unset would spawn PowerShell on this path.
  const strippedCommand = stripSafeWrappers(stripShellWrapper(command));
  const detail = getEffectiveCommandDetail(strippedCommand, 'bash');
  const name =
    detail?.name ??
    normalizeCommand(strippedCommand.trim().match(/^\S+/)?.[0] ?? '');
  if (name !== 'git') return name;

  // findGitSubcommand expects the argv form, with the command itself at [0].
  const args = detail?.args ?? strippedCommand.trim().split(/\s+/).slice(1);
  const { subcommand } = findGitSubcommand(['git', ...args], GIT_SUBCOMMANDS);
  return subcommand ? `git ${subcommand}` : 'git';
}

/**
 * Interprets the final shell status using the effective command's documented
 * exit-code semantics. This intentionally does not inspect stdout/stderr:
 * output text is not a reliable process-status signal.
 */
export function interpretShellExitStatus(
  command: string,
  exitCode: number | null,
  signal: number | null,
): ShellExitStatusFields {
  // A signal is a hard failure regardless of which command ran.
  if (signal !== null) {
    return { isError: true };
  }

  // Exit 0 is always a success, so skip the shell parse on the dominant path.
  if (exitCode === null || exitCode === 0) {
    return {};
  }

  if (exitCode !== 1 || !INTERPRETED_COMMAND_PREFILTER.test(command)) {
    return { isError: true };
  }

  const message = EXPECTED_EXIT_ONE.get(getInterpreterKey(command));
  return message ? { returnCodeInterpretation: message } : { isError: true };
}

/** Shell-specific parsers supply a verified command identity, never source text. */
export function interpretKnownShellExitStatus(
  key: string | undefined,
  exitCode: number | null,
  signal: number | null,
): ShellExitStatusFields {
  if (signal !== null) return { isError: true };
  if (exitCode === null || exitCode === 0) return {};
  if (key === 'robocopy' && exitCode > 0 && exitCode < 8)
    return {
      returnCodeInterpretation: 'Copy completed without a copy failure.',
    };
  if (key === 'msiexec' && (exitCode === 3010 || exitCode === 1641))
    return {
      returnCodeInterpretation:
        exitCode === 3010
          ? 'The operation succeeded and a restart is required.'
          : 'The operation succeeded and initiated a restart.',
    };
  const message =
    exitCode === 1 && key
      ? key === 'findstr'
        ? 'No matches found'
        : EXPECTED_EXIT_ONE.get(key)
      : undefined;
  return message ? { returnCodeInterpretation: message } : { isError: true };
}

/**
 * Renders the deterministic process-status lines for a failed command. Shared
 * so every shell-family tool reports the same wording to the model.
 */
export function formatShellExitStatusPrefix(
  exitCode: number | null,
  signal: number | null,
): string | undefined {
  const lines: string[] = [];
  if (exitCode !== null && exitCode !== 0) lines.push(`Exit code ${exitCode}`);
  if (signal !== null) lines.push(`Signal: ${signal}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * The one line of status a shell-family tool shows the model: a failure reports
 * the deterministic exit status, an expected non-zero exit reports what it
 * means. Never both — they say the same thing.
 */
export function shellStatusText(
  fields: ShellExitStatusFields,
  exitCode: number | null,
  signal: number | null,
): string | undefined {
  return fields.isError
    ? formatShellExitStatusPrefix(exitCode, signal)
    : fields.returnCodeInterpretation;
}

/** Prepends the status lines unless `content` already leads with them. */
export function prependShellExitStatus(
  content: string,
  exitCode: number | null,
  signal: number | null,
): string {
  const prefix = formatShellExitStatusPrefix(exitCode, signal);
  if (!prefix || `${content}\n`.startsWith(`${prefix}\n`)) {
    return content;
  }
  return content ? `${prefix}\n${content}` : prefix;
}
