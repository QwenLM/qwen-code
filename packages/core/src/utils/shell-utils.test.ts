/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, vi, afterEach } from 'vitest';
import {
  checkArgumentSafety,
  checkCommandPermissions,
  escapeShellArg,
  getCommandRoots,
  getShellConfiguration,
  isCommandAllowed,
  isCommandNeedsPermission,
  stripShellWrapper,
} from './shell-utils.js';
import type { Config } from '../config/config.js';

const mockPlatform = vi.hoisted(() => vi.fn());
const mockHomedir = vi.hoisted(() => vi.fn());
vi.mock('os', () => ({
  default: {
    platform: mockPlatform,
    homedir: mockHomedir,
  },
  platform: mockPlatform,
  homedir: mockHomedir,
}));

const mockQuote = vi.hoisted(() => vi.fn());
const mockParse = vi.hoisted(() => vi.fn());
vi.mock('shell-quote', () => ({
  quote: mockQuote,
  parse: mockParse,
}));

let config: Config;

beforeEach(() => {
  mockPlatform.mockReturnValue('linux');
  mockQuote.mockImplementation((args: string[]) =>
    args.map((arg) => `'${arg}'`).join(' '),
  );
  mockParse.mockImplementation((cmd: string) => cmd.split(' '));
  config = {
    getCoreTools: () => [],
    getPermissionsDeny: () => [],
    getPermissionsAllow: () => [],
  } as unknown as Config;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('isCommandAllowed', () => {
  it('should allow a command if no restrictions are provided', async () => {
    const result = await isCommandAllowed('ls -l', config);
    expect(result.allowed).toBe(true);
  });

  it('should allow a command if it is in the global allowlist', async () => {
    config.getCoreTools = () => ['ShellTool(ls)'];
    const result = await isCommandAllowed('ls -l', config);
    expect(result.allowed).toBe(true);
  });

  it('should block a command if it is not in a strict global allowlist', async () => {
    config.getCoreTools = () => ['ShellTool(ls -l)'];
    const result = await isCommandAllowed('rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      `Command(s) not in the allowed commands list. Disallowed commands: "rm -rf /"`,
    );
  });

  it('should block a command if it is in the blocked list', async () => {
    config.getPermissionsDeny = () => ['ShellTool(rm -rf /)'];
    const result = await isCommandAllowed('rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      `Command 'rm -rf /' is blocked by configuration`,
    );
  });

  it('should prioritize the blocklist over the allowlist', async () => {
    config.getCoreTools = () => ['ShellTool(rm -rf /)'];
    config.getPermissionsDeny = () => ['ShellTool(rm -rf /)'];
    const result = await isCommandAllowed('rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      `Command 'rm -rf /' is blocked by configuration`,
    );
  });

  it('should allow any command when a wildcard is in coreTools', async () => {
    config.getCoreTools = () => ['ShellTool'];
    const result = await isCommandAllowed('any random command', config);
    expect(result.allowed).toBe(true);
  });

  it('should block any command when a wildcard is in excludeTools', async () => {
    config.getPermissionsDeny = () => ['run_shell_command'];
    const result = await isCommandAllowed('any random command', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      'Shell tool is globally disabled in configuration',
    );
  });

  it('should block a command on the blocklist even with a wildcard allow', async () => {
    config.getCoreTools = () => ['ShellTool'];
    config.getPermissionsDeny = () => ['ShellTool(rm -rf /)'];
    const result = await isCommandAllowed('rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      `Command 'rm -rf /' is blocked by configuration`,
    );
  });

  it('should allow a chained command if all parts are on the global allowlist', async () => {
    config.getCoreTools = () => [
      'run_shell_command(echo)',
      'run_shell_command(ls)',
    ];
    const result = await isCommandAllowed('echo "hello" && ls -l', config);
    expect(result.allowed).toBe(true);
  });

  it('should block a chained command if any part is blocked', async () => {
    config.getPermissionsDeny = () => ['run_shell_command(rm)'];
    const result = await isCommandAllowed('echo "hello" && rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      `Command 'rm -rf /' is blocked by configuration`,
    );
  });

  describe('command substitution', () => {
    it('should block command substitution using `$(...)`', async () => {
      const result = await isCommandAllowed('echo $(rm -rf /)', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Command substitution');
    });

    it('should block command substitution using `<(...)`', async () => {
      const result = await isCommandAllowed('diff <(ls) <(ls -a)', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Command substitution');
    });

    it('should block command substitution using `>(...)`', async () => {
      const result = await isCommandAllowed(
        'echo "Log message" > >(tee log.txt)',
        config,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Command substitution');
    });

    it('should block command substitution using backticks', async () => {
      const result = await isCommandAllowed('echo `rm -rf /`', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Command substitution');
    });

    it('should allow substitution-like patterns inside single quotes', async () => {
      config.getCoreTools = () => ['ShellTool(echo)'];
      const result = await isCommandAllowed("echo '$(pwd)'", config);
      expect(result.allowed).toBe(true);
    });

    describe('heredocs', () => {
      it('should allow substitution-like content in a quoted heredoc delimiter', async () => {
        const cmd = [
          "cat <<'EOF' > user_session.md",
          '```',
          '$(rm -rf /)',
          '`not executed`',
          '```',
          'EOF',
        ].join('\n');

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(true);
      });

      it('should block command substitution in an unquoted heredoc body', async () => {
        const cmd = [
          'cat <<EOF > user_session.md',
          "'$(rm -rf /)'",
          'EOF',
        ].join('\n');

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Command substitution');
      });

      it('should block backtick command substitution in an unquoted heredoc body', async () => {
        const cmd = ['cat <<EOF > user_session.md', '`rm -rf /`', 'EOF'].join(
          '\n',
        );

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Command substitution');
      });

      it('should allow escaped command substitution in an unquoted heredoc body', async () => {
        const cmd = [
          'cat <<EOF > user_session.md',
          '\\$(rm -rf /)',
          'EOF',
        ].join('\n');

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(true);
      });

      it('should support tab-stripping heredocs (<<-)', async () => {
        const cmd = [
          "cat <<-'EOF' > user_session.md",
          '\t$(rm -rf /)',
          '\tEOF',
        ].join('\n');

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(true);
      });

      it('should block command substitution split by line continuation in an unquoted heredoc body', async () => {
        const cmd = [
          'cat <<EOF > user_session.md',
          '$\\',
          '(rm -rf /)',
          'EOF',
        ].join('\n');

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Command substitution');
      });

      it('should allow escaped command substitution split by line continuation in an unquoted heredoc body', async () => {
        const cmd = [
          'cat <<EOF > user_session.md',
          '\\$\\',
          '(rm -rf /)',
          'EOF',
        ].join('\n');

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(true);
      });
    });

    describe('comments', () => {
      it('should ignore heredoc operators inside comments', async () => {
        const cmd = ["# Fake heredoc <<'EOF'", '$(rm -rf /)', 'EOF'].join('\n');

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Command substitution');
      });

      it('should allow command substitution patterns inside full-line comments', async () => {
        const cmd = ['# Note: $(rm -rf /) is dangerous', 'echo hello'].join(
          '\n',
        );

        const result = await isCommandAllowed(cmd, config);
        expect(result.allowed).toBe(true);
      });

      it('should allow command substitution patterns inside inline comments', async () => {
        const result = await isCommandAllowed(
          'echo hello # $(rm -rf /)',
          config,
        );
        expect(result.allowed).toBe(true);
      });

      it('should not treat # inside a word as a comment starter', async () => {
        const result = await isCommandAllowed('echo foo#$(rm -rf /)', config);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Command substitution');
      });
    });
  });
});

describe('checkCommandPermissions', () => {
  describe('in "Default Allow" mode (no sessionAllowlist)', () => {
    it('should return a detailed success object for an allowed command', async () => {
      const result = await checkCommandPermissions('ls -l', config);
      expect(result).toEqual({
        allAllowed: true,
        disallowedCommands: [],
      });
    });

    it('should return a detailed failure object for a blocked command', async () => {
      config.getPermissionsDeny = () => ['ShellTool(rm)'];
      const result = await checkCommandPermissions('rm -rf /', config);
      expect(result).toEqual({
        allAllowed: false,
        disallowedCommands: ['rm -rf /'],
        blockReason: `Command 'rm -rf /' is blocked by configuration`,
        isHardDenial: true,
      });
    });

    it('should return a detailed failure object for a command not on a strict allowlist', async () => {
      config.getCoreTools = () => ['ShellTool(ls)'];
      const result = await checkCommandPermissions('git status && ls', config);
      expect(result).toEqual({
        allAllowed: false,
        disallowedCommands: ['git status'],
        blockReason: `Command(s) not in the allowed commands list. Disallowed commands: "git status"`,
        isHardDenial: false,
      });
    });
  });

  describe('in "Default Deny" mode (with sessionAllowlist)', () => {
    it('should allow a command on the sessionAllowlist', async () => {
      const result = await checkCommandPermissions(
        'ls -l',
        config,
        new Set(['ls -l']),
      );
      expect(result.allAllowed).toBe(true);
    });

    it('should block a command not on the sessionAllowlist or global allowlist', async () => {
      const result = await checkCommandPermissions(
        'rm -rf /',
        config,
        new Set(['ls -l']),
      );
      expect(result.allAllowed).toBe(false);
      expect(result.blockReason).toContain(
        'not on the global or session allowlist',
      );
      expect(result.disallowedCommands).toEqual(['rm -rf /']);
    });

    it('should allow a command on the global allowlist even if not on the session allowlist', async () => {
      config.getCoreTools = () => ['ShellTool(git status)'];
      const result = await checkCommandPermissions(
        'git status',
        config,
        new Set(['ls -l']),
      );
      expect(result.allAllowed).toBe(true);
    });

    it('should allow a chained command if parts are on different allowlists', async () => {
      config.getCoreTools = () => ['ShellTool(git status)'];
      const result = await checkCommandPermissions(
        'git status && git commit',
        config,
        new Set(['git commit']),
      );
      expect(result.allAllowed).toBe(true);
    });

    it('should block a command on the sessionAllowlist if it is also globally blocked', async () => {
      config.getPermissionsDeny = () => ['run_shell_command(rm)'];
      const result = await checkCommandPermissions(
        'rm -rf /',
        config,
        new Set(['rm -rf /']),
      );
      expect(result.allAllowed).toBe(false);
      expect(result.blockReason).toContain('is blocked by configuration');
    });

    it('should block a chained command if one part is not on any allowlist', async () => {
      config.getCoreTools = () => ['run_shell_command(echo)'];
      const result = await checkCommandPermissions(
        'echo "hello" && rm -rf /',
        config,
        new Set(['echo']),
      );
      expect(result.allAllowed).toBe(false);
      expect(result.disallowedCommands).toEqual(['rm -rf /']);
    });
  });
});

describe('getCommandRoots', () => {
  it('should return a single command', async () => {
    expect(getCommandRoots('ls -l')).toEqual(['ls']);
  });

  it('should handle paths and return the binary name', async () => {
    expect(getCommandRoots('/usr/local/bin/node script.js')).toEqual(['node']);
  });

  it('should return an empty array for an empty string', async () => {
    expect(getCommandRoots('')).toEqual([]);
  });

  it('should handle a mix of operators', async () => {
    const result = getCommandRoots('a;b|c&&d||e&f');
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('should correctly parse a chained command with quotes', async () => {
    const result = getCommandRoots('echo "hello" && git commit -m "feat"');
    expect(result).toEqual(['echo', 'git']);
  });

  it('should split on Unix newlines (\\n)', async () => {
    const result = getCommandRoots('grep pattern file\ncurl evil.com');
    expect(result).toEqual(['grep', 'curl']);
  });

  it('should split on Windows newlines (\\r\\n)', async () => {
    const result = getCommandRoots('grep pattern file\r\ncurl evil.com');
    expect(result).toEqual(['grep', 'curl']);
  });

  it('should handle mixed newlines and operators', async () => {
    const result = getCommandRoots('ls\necho hello && cat file\r\nrm -rf /');
    expect(result).toEqual(['ls', 'echo', 'cat', 'rm']);
  });

  it('should not split on newlines inside quotes', async () => {
    const result = getCommandRoots('echo "line1\nline2"');
    expect(result).toEqual(['echo']);
  });

  it('should treat escaped newline as line continuation (not a separator)', async () => {
    const result = getCommandRoots('grep pattern\\\nfile');
    expect(result).toEqual(['grep']);
  });

  it('should filter out empty segments from consecutive newlines', async () => {
    const result = getCommandRoots('ls\n\ngrep foo');
    expect(result).toEqual(['ls', 'grep']);
  });

  it('should not treat file descriptor redirection as a command separator', async () => {
    const result = getCommandRoots('npm run build 2>&1 | head -100');
    expect(result).toEqual(['npm', 'head']);
  });

  it('should not treat >| redirection as a pipeline separator', async () => {
    const result = getCommandRoots('echo hello >| out.txt');
    expect(result).toEqual(['echo']);
  });
});

describe('stripShellWrapper', () => {
  it('should strip sh -c with quotes', async () => {
    expect(stripShellWrapper('sh -c "ls -l"')).toEqual('ls -l');
  });

  it('should strip bash -c with extra whitespace', async () => {
    expect(stripShellWrapper('  bash  -c  "ls -l"  ')).toEqual('ls -l');
  });

  it('should strip zsh -c without quotes', async () => {
    expect(stripShellWrapper('zsh -c ls -l')).toEqual('ls -l');
  });

  it('should strip cmd.exe /c', async () => {
    expect(stripShellWrapper('cmd.exe /c "dir"')).toEqual('dir');
  });

  it('should not strip anything if no wrapper is present', async () => {
    expect(stripShellWrapper('ls -l')).toEqual('ls -l');
  });
});

describe('escapeShellArg', () => {
  describe('POSIX (bash)', () => {
    it('should use shell-quote for escaping', async () => {
      mockQuote.mockReturnValueOnce("'escaped value'");
      const result = escapeShellArg('raw value', 'bash');
      expect(mockQuote).toHaveBeenCalledWith(['raw value']);
      expect(result).toBe("'escaped value'");
    });

    it('should handle empty strings', async () => {
      const result = escapeShellArg('', 'bash');
      expect(result).toBe('');
      expect(mockQuote).not.toHaveBeenCalled();
    });
  });

  describe('Windows', () => {
    describe('when shell is cmd.exe', () => {
      it('should wrap simple arguments in double quotes', async () => {
        const result = escapeShellArg('search term', 'cmd');
        expect(result).toBe('"search term"');
      });

      it('should escape internal double quotes by doubling them', async () => {
        const result = escapeShellArg('He said "Hello"', 'cmd');
        expect(result).toBe('"He said ""Hello"""');
      });

      it('should handle empty strings', async () => {
        const result = escapeShellArg('', 'cmd');
        expect(result).toBe('');
      });
    });

    describe('when shell is PowerShell', () => {
      it('should wrap simple arguments in single quotes', async () => {
        const result = escapeShellArg('search term', 'powershell');
        expect(result).toBe("'search term'");
      });

      it('should escape internal single quotes by doubling them', async () => {
        const result = escapeShellArg("It's a test", 'powershell');
        expect(result).toBe("'It''s a test'");
      });

      it('should handle double quotes without escaping them', async () => {
        const result = escapeShellArg('He said "Hello"', 'powershell');
        expect(result).toBe('\'He said "Hello"\'');
      });

      it('should handle empty strings', async () => {
        const result = escapeShellArg('', 'powershell');
        expect(result).toBe('');
      });
    });
  });
});

describe('getShellConfiguration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return bash configuration on Linux', async () => {
    mockPlatform.mockReturnValue('linux');
    const config = getShellConfiguration();
    expect(config.executable).toBe('bash');
    expect(config.argsPrefix).toEqual(['-c']);
    expect(config.shell).toBe('bash');
  });

  it('should return bash configuration on macOS (darwin)', async () => {
    mockPlatform.mockReturnValue('darwin');
    const config = getShellConfiguration();
    expect(config.executable).toBe('bash');
    expect(config.argsPrefix).toEqual(['-c']);
    expect(config.shell).toBe('bash');
  });

  describe('on Windows', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      mockPlatform.mockReturnValue('win32');
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return cmd.exe configuration by default', async () => {
      delete process.env['ComSpec'];
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];
      const config = getShellConfiguration();
      expect(config.executable).toBe('cmd.exe');
      expect(config.argsPrefix).toEqual(['/d', '/s', '/c']);
      expect(config.shell).toBe('cmd');
    });

    it('should respect ComSpec for cmd.exe', async () => {
      const cmdPath = 'C:\\WINDOWS\\system32\\cmd.exe';
      process.env['ComSpec'] = cmdPath;
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];
      const config = getShellConfiguration();
      expect(config.executable).toBe(cmdPath);
      expect(config.argsPrefix).toEqual(['/d', '/s', '/c']);
      expect(config.shell).toBe('cmd');
    });

    it('should return PowerShell configuration if ComSpec points to powershell.exe', async () => {
      const psPath =
        'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      process.env['ComSpec'] = psPath;
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];
      const config = getShellConfiguration();
      expect(config.executable).toBe(psPath);
      expect(config.argsPrefix).toEqual(['-NoProfile', '-Command']);
      expect(config.shell).toBe('powershell');
    });

    it('should return PowerShell configuration if ComSpec points to pwsh.exe', async () => {
      const pwshPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
      process.env['ComSpec'] = pwshPath;
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];
      const config = getShellConfiguration();
      expect(config.executable).toBe(pwshPath);
      expect(config.argsPrefix).toEqual(['-NoProfile', '-Command']);
      expect(config.shell).toBe('powershell');
    });

    it('should be case-insensitive when checking ComSpec', async () => {
      process.env['ComSpec'] = 'C:\\Path\\To\\POWERSHELL.EXE';
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];
      const config = getShellConfiguration();
      expect(config.executable).toBe('C:\\Path\\To\\POWERSHELL.EXE');
      expect(config.argsPrefix).toEqual(['-NoProfile', '-Command']);
      expect(config.shell).toBe('powershell');
    });

    describe('Git Bash / MSYS2 / MinTTY detection', () => {
      it('should return bash configuration when MSYSTEM starts with MINGW', () => {
        process.env['MSYSTEM'] = 'MINGW64';
        const config = getShellConfiguration();
        expect(config.executable).toBe('bash');
        expect(config.argsPrefix).toEqual(['-c']);
        expect(config.shell).toBe('bash');
      });

      it('should return bash configuration when MSYSTEM starts with MSYS', () => {
        process.env['MSYSTEM'] = 'MSYS';
        const config = getShellConfiguration();
        expect(config.executable).toBe('bash');
        expect(config.argsPrefix).toEqual(['-c']);
        expect(config.shell).toBe('bash');
      });

      it('should return bash configuration when TERM includes msys', () => {
        delete process.env['MSYSTEM'];
        process.env['TERM'] = 'xterm-256color-msys';
        const config = getShellConfiguration();
        expect(config.executable).toBe('bash');
        expect(config.argsPrefix).toEqual(['-c']);
        expect(config.shell).toBe('bash');
      });

      it('should return bash configuration when TERM includes cygwin', () => {
        delete process.env['MSYSTEM'];
        process.env['TERM'] = 'xterm-256color-cygwin';
        const config = getShellConfiguration();
        expect(config.executable).toBe('bash');
        expect(config.argsPrefix).toEqual(['-c']);
        expect(config.shell).toBe('bash');
      });

      it('should prioritize MSYSTEM over TERM for Git Bash detection', () => {
        process.env['MSYSTEM'] = 'MINGW64';
        process.env['TERM'] = 'xterm';
        const config = getShellConfiguration();
        expect(config.executable).toBe('bash');
        expect(config.argsPrefix).toEqual(['-c']);
        expect(config.shell).toBe('bash');
      });

      it('should return cmd.exe when MSYSTEM and TERM do not indicate Git Bash', () => {
        process.env['MSYSTEM'] = 'UNKNOWN';
        process.env['TERM'] = 'xterm';
        delete process.env['ComSpec'];
        const config = getShellConfiguration();
        expect(config.executable).toBe('cmd.exe');
        expect(config.argsPrefix).toEqual(['/d', '/s', '/c']);
        expect(config.shell).toBe('cmd');
      });

      it('should return bash when MSYSTEM is MINGW32', () => {
        process.env['MSYSTEM'] = 'MINGW32';
        const config = getShellConfiguration();
        expect(config.executable).toBe('bash');
        expect(config.argsPrefix).toEqual(['-c']);
        expect(config.shell).toBe('bash');
      });
    });
  });
});

describe('isCommandNeedPermission', () => {
  it('returns false for read-only commands', async () => {
    const result = isCommandNeedsPermission('ls');
    expect(result.requiresPermission).toBe(false);
  });

  it('returns true for mutating commands with reason', async () => {
    const result = isCommandNeedsPermission('rm -rf temp');
    expect(result.requiresPermission).toBe(true);
    expect(result.reason).toContain('requires permission to execute');
  });
});

describe('checkArgumentSafety', () => {
  describe('command substitution patterns', () => {
    it('should detect $() command substitution', async () => {
      const result = checkArgumentSafety('$(whoami)');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('$() command substitution');
    });

    it('should detect backtick command substitution', async () => {
      const result = checkArgumentSafety('`whoami`');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain(
        'backtick command substitution',
      );
    });

    it('should detect <() process substitution', async () => {
      const result = checkArgumentSafety('<(cat file)');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('<() process substitution');
    });

    it('should detect >() process substitution', async () => {
      const result = checkArgumentSafety('>(tee file)');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('>() process substitution');
    });
  });

  describe('command separators', () => {
    it('should detect semicolon separator', async () => {
      const result = checkArgumentSafety('arg1; rm -rf /');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('; command separator');
    });

    it('should detect pipe', async () => {
      const result = checkArgumentSafety('arg1 | cat file');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('| pipe');
    });

    it('should detect && operator', async () => {
      const result = checkArgumentSafety('arg1 && ls');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('&& AND operator');
    });

    it('should detect || operator', async () => {
      const result = checkArgumentSafety('arg1 || ls');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('|| OR operator');
    });
  });

  describe('background execution', () => {
    it('should detect background operator', async () => {
      const result = checkArgumentSafety('arg1 & ls');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('& background operator');
    });
  });

  describe('input/output redirection', () => {
    it('should detect output redirection', async () => {
      const result = checkArgumentSafety('arg1 > file');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('> output redirection');
    });

    it('should detect input redirection', async () => {
      const result = checkArgumentSafety('arg1 < file');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('< input redirection');
    });

    it('should detect append redirection', async () => {
      const result = checkArgumentSafety('arg1 >> file');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('> output redirection');
    });
  });

  describe('safe inputs', () => {
    it('should accept simple arguments', async () => {
      const result = checkArgumentSafety('arg1 arg2');
      expect(result.isSafe).toBe(true);
      expect(result.dangerousPatterns).toHaveLength(0);
    });

    it('should accept arguments with numbers', async () => {
      const result = checkArgumentSafety('file123.txt');
      expect(result.isSafe).toBe(true);
    });

    it('should accept arguments with hyphens', async () => {
      const result = checkArgumentSafety('--flag=value');
      expect(result.isSafe).toBe(true);
    });

    it('should accept arguments with underscores', async () => {
      const result = checkArgumentSafety('my_file_name');
      expect(result.isSafe).toBe(true);
    });

    it('should accept arguments with dots', async () => {
      const result = checkArgumentSafety('path/to/file.txt');
      expect(result.isSafe).toBe(true);
    });

    it('should accept empty string', async () => {
      const result = checkArgumentSafety('');
      expect(result.isSafe).toBe(true);
    });

    it('should accept arguments with spaces (quoted)', async () => {
      const result = checkArgumentSafety('hello world');
      expect(result.isSafe).toBe(true);
    });
  });

  describe('multiple dangerous patterns', () => {
    it('should detect multiple dangerous patterns', async () => {
      const result = checkArgumentSafety('$(whoami); rm -rf / &');
      expect(result.isSafe).toBe(false);
      expect(result.dangerousPatterns).toContain('$() command substitution');
      expect(result.dangerousPatterns).toContain('; command separator');
      expect(result.dangerousPatterns).toContain('& background operator');
      expect(result.dangerousPatterns).toHaveLength(3);
    });
  });
});
