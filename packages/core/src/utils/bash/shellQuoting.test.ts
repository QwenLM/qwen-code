/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';

import {
  quoteShellCommand,
  hasStdinRedirect,
  shouldAddStdinRedirect,
  rewriteWindowsNullRedirect,
  singleQuoteForEval,
} from './shellQuoting.js';

describe('singleQuoteForEval', () => {
  it('wraps a simple string in single quotes', () => {
    expect(singleQuoteForEval('hello')).toBe("'hello'");
  });

  it('handles empty string', () => {
    expect(singleQuoteForEval('')).toBe("''");
  });

  it('escapes embedded single quotes', () => {
    expect(singleQuoteForEval("it's")).toBe("'it'\"'\"'s'");
  });

  it('escapes multiple embedded single quotes', () => {
    expect(singleQuoteForEval("a'b'c")).toBe("'a'\"'\"'b'\"'\"'c'");
  });

  it('preserves double quotes without escaping', () => {
    expect(singleQuoteForEval('say "hi"')).toBe('\'say "hi"\'');
  });

  it('preserves special characters inside single quotes', () => {
    expect(singleQuoteForEval('$HOME && rm -rf /')).toBe("'$HOME && rm -rf /'");
  });
});

describe('hasStdinRedirect', () => {
  it('detects < file redirect', () => {
    expect(hasStdinRedirect('cat < input.txt')).toBe(true);
  });

  it('detects < /dev/null redirect', () => {
    expect(hasStdinRedirect('some_cmd < /dev/null')).toBe(true);
  });

  it('detects redirect at start of command', () => {
    expect(hasStdinRedirect('< input.txt cat')).toBe(true);
  });

  it('detects redirect after semicolon', () => {
    expect(hasStdinRedirect('echo hi; cat < file.txt')).toBe(true);
  });

  it('detects redirect after pipe', () => {
    expect(hasStdinRedirect('echo hi | cat < file.txt')).toBe(true);
  });

  it('does not match heredoc operator <<', () => {
    expect(hasStdinRedirect('cat <<EOF\nhello\nEOF')).toBe(false);
  });

  it('does not match process substitution <(', () => {
    expect(hasStdinRedirect('diff <(ls dir1) <(ls dir2)')).toBe(false);
  });

  it('returns false for command with no redirect', () => {
    expect(hasStdinRedirect('echo hello world')).toBe(false);
  });

  it('returns false for output redirect only', () => {
    expect(hasStdinRedirect('echo hello > output.txt')).toBe(false);
  });
});

describe('shouldAddStdinRedirect', () => {
  it('returns false for heredoc commands', () => {
    expect(shouldAddStdinRedirect('cat <<EOF\nhello\nEOF')).toBe(false);
  });

  it('returns false for heredoc with quoted delimiter', () => {
    expect(shouldAddStdinRedirect("cat <<'EOF'\nhello\nEOF")).toBe(false);
  });

  it('returns false when stdin redirect already exists', () => {
    expect(shouldAddStdinRedirect('cat < input.txt')).toBe(false);
  });

  it('returns false when /dev/null redirect exists', () => {
    expect(shouldAddStdinRedirect('cmd < /dev/null')).toBe(false);
  });

  it('returns true for a regular command', () => {
    expect(shouldAddStdinRedirect('echo hello')).toBe(true);
  });

  it('returns true for command with output redirect only', () => {
    expect(shouldAddStdinRedirect('echo hello > out.txt')).toBe(true);
  });

  it('returns true for piped commands without stdin redirect', () => {
    expect(shouldAddStdinRedirect('ls | grep foo')).toBe(true);
  });
});

describe('rewriteWindowsNullRedirect', () => {
  it('rewrites >nul to >/dev/null', () => {
    expect(rewriteWindowsNullRedirect('echo hello >nul')).toBe(
      'echo hello >/dev/null',
    );
  });

  it('rewrites >NUL (uppercase) to >/dev/null', () => {
    expect(rewriteWindowsNullRedirect('echo hello >NUL')).toBe(
      'echo hello >/dev/null',
    );
  });

  it('rewrites 2>nul to 2>/dev/null', () => {
    expect(rewriteWindowsNullRedirect('cmd 2>nul')).toBe('cmd 2>/dev/null');
  });

  it('rewrites &>nul to &>/dev/null', () => {
    expect(rewriteWindowsNullRedirect('cmd &>nul')).toBe('cmd &>/dev/null');
  });

  it('rewrites >>nul to >>/dev/null', () => {
    expect(rewriteWindowsNullRedirect('cmd >>nul')).toBe('cmd >>/dev/null');
  });

  it('rewrites >nul with space before nul', () => {
    expect(rewriteWindowsNullRedirect('echo hello > nul')).toBe(
      'echo hello > /dev/null',
    );
  });

  it('handles mixed case (>Nul)', () => {
    expect(rewriteWindowsNullRedirect('cmd >Nul')).toBe('cmd >/dev/null');
  });

  it('rewrites multiple nul redirects in one command', () => {
    expect(rewriteWindowsNullRedirect('cmd >nul 2>nul')).toBe(
      'cmd >/dev/null 2>/dev/null',
    );
  });

  it('does not rewrite when nul is part of a longer word', () => {
    expect(rewriteWindowsNullRedirect('echo nullable')).toBe('echo nullable');
  });

  it('leaves commands without nul redirects unchanged', () => {
    expect(rewriteWindowsNullRedirect('echo hello > /dev/null')).toBe(
      'echo hello > /dev/null',
    );
  });
});

describe('quoteShellCommand', () => {
  describe('heredoc path', () => {
    it('single-quotes a heredoc command', () => {
      const cmd = 'cat <<EOF\nhello\nEOF';
      const result = quoteShellCommand(cmd);
      expect(result).toBe(singleQuoteForEval(cmd));
    });

    it('does not append stdin redirect for heredocs even when addStdinRedirect is true', () => {
      const cmd = 'cat <<EOF\nhello\nEOF';
      const result = quoteShellCommand(cmd, true);
      expect(result).not.toContain('< /dev/null');
    });

    it('handles heredoc with quoted delimiter', () => {
      const cmd = "cat <<'END'\nsome text\nEND";
      const result = quoteShellCommand(cmd);
      expect(result).toBe(singleQuoteForEval(cmd));
    });

    it('handles heredoc with double-quoted delimiter', () => {
      const cmd = 'cat <<"END"\nsome text\nEND';
      const result = quoteShellCommand(cmd);
      expect(result).toBe(singleQuoteForEval(cmd));
    });

    it('handles heredoc with dash (<<-)', () => {
      const cmd = 'cat <<-EOF\n\thello\n\tEOF';
      const result = quoteShellCommand(cmd);
      expect(result).toBe(singleQuoteForEval(cmd));
    });
  });

  describe('multiline string path', () => {
    it('single-quotes a command with multiline single-quoted string and adds redirect', () => {
      const cmd = "echo 'hello\nworld'";
      const result = quoteShellCommand(cmd, true);
      expect(result).toBe(singleQuoteForEval(cmd) + ' < /dev/null');
    });

    it('single-quotes a command with multiline double-quoted string and adds redirect', () => {
      const cmd = 'echo "hello\nworld"';
      const result = quoteShellCommand(cmd, true);
      expect(result).toBe(singleQuoteForEval(cmd) + ' < /dev/null');
    });

    it('does not add redirect when addStdinRedirect is false', () => {
      const cmd = "echo 'hello\nworld'";
      const result = quoteShellCommand(cmd, false);
      expect(result).toBe(singleQuoteForEval(cmd));
    });
  });

  describe('regular command path', () => {
    it('quotes a simple command with stdin redirect by default', () => {
      const result = quoteShellCommand('echo hello');
      expect(result).toContain('echo hello');
      expect(result).toContain('/dev/null');
    });

    it('quotes a simple command without stdin redirect when disabled', () => {
      const result = quoteShellCommand('echo hello', false);
      expect(result).not.toContain('/dev/null');
    });

    it('defaults addStdinRedirect to true', () => {
      const withDefault = quoteShellCommand('ls -la');
      const withExplicitTrue = quoteShellCommand('ls -la', true);
      expect(withDefault).toBe(withExplicitTrue);
    });

    it('properly escapes special characters in regular commands', () => {
      const result = quoteShellCommand('echo $HOME', false);
      // shell-quote should escape the dollar sign
      expect(result).toContain('HOME');
    });
  });
});
