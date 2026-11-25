/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared shell string scanning helpers.
 *
 * Kept independent from command validation modules so low-level quote and
 * expansion checks do not create circular imports between validators.
 */

export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ash',
  'mksh',
  'csh',
  'tcsh',
]);

/** Wrappers whose argv determines the program or script that actually runs. */
export const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'pkexec',
  'runuser',
  'exec',
  'command',
  'env',
  'nice',
  'nohup',
  'timeout',
  'stdbuf',
  'setsid',
  'ionice',
  'busybox',
  'time',
  'eval',
  'xargs',
  'parallel',
  'watch',
]);

/** May hand stdin to another execution environment; their argv is not a transparent wrapper. */
export const SHELL_STDIN_FORWARDERS: ReadonlySet<string> = new Set([
  'su',
  'ssh',
  'nsenter',
  'chroot',
  'docker',
  'podman',
  'kubectl',
  'wsl',
  'rsh',
  'mosh',
  'nerdctl',
  'lxc',
  'incus',
  'powershell',
  'pwsh',
  'cmd',
]);

/** Safety classification only; authorization rules keep the original executable identity. */
export function normalizeShellCommandName(token: string): string {
  return token
    .replace(/^\\/, '')
    .replace(/^[^\s=]*[\\/]/, '')
    .replace(/\.exe$/iu, '')
    .toLowerCase();
}

/**
 * Walks a command string character-by-character, tracking quote state, and
 * invokes the visitor for each unquoted character. The visitor receives the
 * character, its index, and whether we're inside double quotes.
 *
 * Return `true` from the visitor to short-circuit and report "found".
 */
export function walkUnquoted(
  command: string,
  visitor: (ch: string, i: number, inDoubleQuote: boolean) => boolean | void,
): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === '\\' && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;

    if (visitor(ch, i, inDouble)) return true;
  }
  return false;
}

/**
 * Checks if the command contains unquoted variable expansion ($VAR, ${VAR}) or
 * unquoted glob characters (*, ?, []).
 */
export function containsUnquotedExpansion(command: string): boolean {
  return walkUnquoted(command, (ch, i, inDouble) => {
    // $ expansion is dangerous inside double quotes and unquoted.
    if (ch === '$') {
      const next = command[i + 1];
      if (next && /[A-Za-z_@*#?!$0-9({-]/.test(next)) {
        return true;
      }
    }

    // Glob characters are only dangerous outside all quotes.
    if (!inDouble && ch && /[?*[\]]/.test(ch)) {
      return true;
    }
    return false;
  });
}
