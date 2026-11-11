/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initializeShellParsers } from '../../utils/shell-utils.js';
import { analyzeShellCommand } from './shellCommandAnalysis.js';
import { checkShellPermission } from './shellPermissions.js';
import { checkDangerousRemoval } from './dangerousRemoval.js';
import { readShellSyntax, removeShellContinuations } from './shellSyntax.js';

beforeAll(initializeShellParsers);
const context = {
  rules: { allow: {}, deny: {}, ask: {} },
  additionalDirectories: [],
};
function permission(command: string, deny: string[] = []) {
  return checkShellPermission(
    { command, cwd: '/project' },
    {
      ...context,
      rules: { ...context.rules, deny: { localSettings: deny } },
    },
    'Bash',
  );
}

describe('literal data and executable shell syntax', () => {
  it('honors command rules for a pipeline consuming heredoc input', () => {
    const result = checkShellPermission(
      { command: "cat <<'EOF' | bash\nprintf hello\nEOF", cwd: '/project' },
      {
        ...context,
        rules: {
          ...context.rules,
          allow: { localSettings: ['Bash(cat:*)', 'Bash(bash:*)'] },
        },
      },
      'Bash',
    );
    expect(result.kind).toBe('allow');
  });
  it.each([
    "printf '%s\\n' 'git reset --hard'",
    "printf '%s\\n' 'git\nreset\n--hard'",
    "printf '%s\\n' 'hello\nrm -rf /tmp/example\nworld'",
    "printf '%s\\n' 'DROP TABLE examples'",
    "printf '%s\\n' 'node -e'",
    '# git reset --hard\npwd',
    "cat <<'EOF'\nrm -rf /\nEOF",
    "cat <<'EOF'\n$(rm -rf /)\nEOF",
    "cat <<'EOF'\nhello\nEOF",
  ])(
    'allows literal data without matching command deny rules: %s',
    (command) => {
      expect(
        permission(command, ['Bash(rm:*)', 'Bash(git reset:*)']).kind,
      ).toBe('allow');
    },
  );

  it.each([
    'echo "$(rm -rf /)"',
    'cat <<EOF\n$(rm -rf /)\nEOF',
    "bash <<'EOF'\nrm -rf /\nEOF",
  ])('keeps deny rules for executable nested commands: %s', (command) => {
    expect(permission(command, ['Bash(rm:*)']).kind).toBe('deny');
  });

  it.each([
    'rm -f /tmp/a \\\n /tmp/b',
    'cd /tmp && rm -rf a \\\n b r3_50_*.cnf',
    "rm -f '' /tmp/a",
  ])('does not invent a directory deletion target: %s', (command) => {
    expect(
      checkDangerousRemoval(command, analyzeShellCommand(command), {
        executionCwd: '/project',
        permissionCwd: '/project',
        additionalDirectories: [],
      }),
    ).toBeNull();
    const result = permission(command);
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask')
      expect(result.reason.decisionPoint).toBe('shell.dangerous_command.ask');
  });

  it('preserves single-quoted newlines and explicit empty arguments', () => {
    expect(removeShellContinuations("printf '%s' 'a\\\nb' '' \\\n c")).toBe(
      "printf '%s' 'a\\\nb' ''  c",
    );
  });

  it('preserves single-quoted continuations inside a double-quoted command substitution', () => {
    const command = 'printf "%s" "$(printf \'%s\' \'a\\\nb\')"';
    expect(readShellSyntax(command)?.source).toBe(command);
  });

  it('does not hide output redirections after a heredoc', () => {
    const command = "cat <<'EOF' > /tmp/output\nhello\nEOF";
    expect(permission(command).kind).toBe('ask');
  });

  it.each([
    "cat <<'EOF' | head\nhello\nEOF",
    'cat <<EOF\nhello\nEOF',
    "cat <<'EOF'\n> /tmp/data-only\nEOF",
  ])('recognizes inert heredoc data and read-only pipelines: %s', (command) => {
    expect(permission(command).kind).toBe('allow');
  });

  it('does not analyze an unsupported heredoc as a sequence of independent commands', () => {
    const result = permission("cat <<'A' <<'B'\nrm -rf /\nA\nhello\nB", [
      'Bash(rm:*)',
    ]);
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask')
      expect(result.reason.decisionPoint).toBe('shell.no_match.ask');
  });

  it('keeps unrecognized redirected program input subject to review', () => {
    const result = permission("python3 <<'EOF'\nprint('hello')\nEOF");
    expect(result.kind).toBe('ask');
  });
});
