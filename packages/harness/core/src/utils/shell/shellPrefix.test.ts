/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  BRAND_ENV_PREFIX,
  ENV_SHELL_PREFIX,
  ENV_SHELL_PREFIX_COMPAT,
} from '../../config/brand.js';
import {
  applyStdioShellPrefix,
  resolveShellPrefix,
  wrapPosixShellCommand,
} from './shellPrefix.js';

describe('shell prefix environment names', () => {
  it('uses the site-specific brand prefix and the fixed compatibility name', () => {
    expect(ENV_SHELL_PREFIX).toBe(`${BRAND_ENV_PREFIX}SHELL_PREFIX`);
    expect(ENV_SHELL_PREFIX_COMPAT).toBe('CLAUDE_CODE_SHELL_PREFIX');
  });
});

describe('resolveShellPrefix', () => {
  it('returns undefined when neither variable is set', () => {
    expect(resolveShellPrefix({})).toBeUndefined();
  });

  it('uses the branded variable', () => {
    expect(resolveShellPrefix({ [ENV_SHELL_PREFIX]: '/bin/branded' })).toBe(
      '/bin/branded',
    );
  });

  it('falls back to the compatibility variable', () => {
    expect(
      resolveShellPrefix({
        [ENV_SHELL_PREFIX_COMPAT]: '/bin/compat',
      }),
    ).toBe('/bin/compat');
  });

  it('prefers the branded variable when both are set', () => {
    expect(
      resolveShellPrefix({
        [ENV_SHELL_PREFIX]: '/bin/branded',
        [ENV_SHELL_PREFIX_COMPAT]: '/bin/compat',
      }),
    ).toBe('/bin/branded');
  });

  it('lets an explicitly empty branded variable disable the fallback', () => {
    expect(
      resolveShellPrefix({
        [ENV_SHELL_PREFIX]: '',
        [ENV_SHELL_PREFIX_COMPAT]: '/bin/compat',
      }),
    ).toBeUndefined();
  });

  it('treats an empty compatibility variable as disabled', () => {
    expect(
      resolveShellPrefix({ [ENV_SHELL_PREFIX_COMPAT]: '' }),
    ).toBeUndefined();
  });

  it('does not trim a whitespace-only value', () => {
    expect(resolveShellPrefix({ [ENV_SHELL_PREFIX]: '   ' })).toBe('   ');
  });
});

describe('wrapPosixShellCommand', () => {
  it('passes the complete command as one quoted argument', () => {
    const command = 'printf "hello" && cat file | wc -l > result';

    expect(wrapPosixShellCommand(command, '/opt/tools/logger')).toBe(
      `/opt/tools/logger 'printf "hello" && cat file | wc -l > result'`,
    );
  });

  it('treats ordinary spaces in a prefix as part of the executable path', () => {
    const command = 'echo ok';
    const prefix = '/Applications/My Logger/logger';

    expect(wrapPosixShellCommand(command, prefix)).toBe(
      `'/Applications/My Logger/logger' 'echo ok'`,
    );
  });

  it('quotes single quotes in both the executable and command', () => {
    const command = `printf '%s\\n' "it's $HOME"`;
    const prefix = "/opt/O'Reilly/logger";

    expect(wrapPosixShellCommand(command, prefix)).toBe(
      `'/opt/O'"'"'Reilly/logger' 'printf '"'"'%s\\n'"'"' "it'"'"'s $HOME"'`,
    );
  });

  it('preserves an option suffix beginning at the final " -"', () => {
    const command = 'echo "$HOME" && pwd';

    expect(wrapPosixShellCommand(command, '/bin/bash -c')).toBe(
      `/bin/bash -c 'echo "$HOME" && pwd'`,
    );
  });

  it('uses only the final " -" when multiple suffix-like segments exist', () => {
    const command = 'echo ok';
    const prefix = '/opt/wrapper -x -c';

    expect(wrapPosixShellCommand(command, prefix)).toBe(
      `'/opt/wrapper -x' -c 'echo ok'`,
    );
  });

  it('does not split when " -" begins at index zero', () => {
    const command = 'echo ok';
    const prefix = ' -c';

    expect(wrapPosixShellCommand(command, prefix)).toBe(
      `' -c' 'echo ok'`,
    );
  });

  it('preserves multiline and heredoc command content', () => {
    const command = 'cat <<\'EOF\'\n$HOME `pwd` && | >\nEOF';
    const result = wrapPosixShellCommand(command, '/bin/bash -c');

    expect(result).toBe(
      "/bin/bash -c 'cat <<'\"'\"'EOF'\"'\"'\n$HOME `pwd` && | >\nEOF'",
    );
  });

  it('quotes bang and tilde instead of changing their shell meaning', () => {
    expect(wrapPosixShellCommand('printf "hello!"', '~/wrapper')).toBe(
      `'~/wrapper' 'printf "hello!"'`,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'preserves bang operators through a real Bash wrapper',
    () => {
      const wrapped = wrapPosixShellCommand(
        "eval '! false' && printf ok",
        '/bin/bash -c',
      );

      expect(
        execFileSync('/bin/bash', ['-c', wrapped], { encoding: 'utf8' }),
      ).toBe('ok');
    },
  );
});

describe('applyStdioShellPrefix', () => {
  it('uses the entire prefix as the executable and emits one argv value', () => {
    const command = '/usr/local/bin/mcp server';
    const args = ['--flag', 'value with spaces', `it's-safe`, '$HOME'];
    const prefix = '/Applications/My MCP Wrapper/wrapper';

    expect(applyStdioShellPrefix(command, args, prefix)).toEqual({
      command: prefix,
      args: [
        `'/usr/local/bin/mcp server' --flag 'value with spaces' 'it'"'"'s-safe' '$HOME'`,
      ],
    });
  });

  it('does not parse option-like text in the prefix', () => {
    const prefix = '/bin/bash -c';

    expect(applyStdioShellPrefix('node', ['server.js'], prefix)).toEqual({
      command: prefix,
      args: ['node server.js'],
    });
  });

  it('supports an original command with no args', () => {
    expect(applyStdioShellPrefix('server', [], '/wrapper')).toEqual({
      command: '/wrapper',
      args: ['server'],
    });
  });

  it('quotes empty, bang, and tilde argv values without expansion', () => {
    expect(
      applyStdioShellPrefix('', ['hello!', '~/resource'], '/wrapper'),
    ).toEqual({
      command: '/wrapper',
      args: [`'' 'hello!' '~/resource'`],
    });
  });
});
