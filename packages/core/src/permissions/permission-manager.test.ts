/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRule,
  parseRules,
  matchesRule,
  matchesCommandPattern,
  matchesPathPattern,
  matchesDomainPattern,
  resolveToolName,
  resolvePathPattern,
  getSpecifierKind,
  toolMatchesRuleToolName,
  splitCompoundCommand,
  splitCompoundCommandSegments,
  buildPermissionRules,
  getRuleDisplayName,
  buildHumanReadableRuleLabel,
  TOOL_NAME_ALIASES,
} from './rule-parser.js';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import { normalizeToolNameForProvider } from '../utils/tool-name-utils.js';
import { ToolNames, ToolDisplayNames } from '../tools/tool-names.js';

const debugLoggerMock = vi.hoisted(() => ({
  isEnabled: vi.fn().mockReturnValue(false),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => debugLoggerMock,
}));

// ─── resolveToolName ─────────────────────────────────────────────────────────

describe('resolveToolName', () => {
  it('resolves canonical names', async () => {
    expect(resolveToolName('run_shell_command')).toBe('run_shell_command');
    expect(resolveToolName('read_file')).toBe('read_file');
  });

  it('resolves display-name aliases', async () => {
    expect(resolveToolName('Shell')).toBe('run_shell_command');
    expect(resolveToolName('ShellTool')).toBe('run_shell_command');
    expect(resolveToolName('Bash')).toBe('run_shell_command');
    expect(resolveToolName('ReadFile')).toBe('read_file');
    expect(resolveToolName('ReadFileTool')).toBe('read_file');
    expect(resolveToolName('EditTool')).toBe('edit');
    expect(resolveToolName('NotebookEdit')).toBe('notebook_edit');
    expect(resolveToolName('NotebookEditTool')).toBe('notebook_edit');
    expect(resolveToolName('WriteFileTool')).toBe('write_file');
  });

  it('resolves "Read" and "Edit" meta-categories', async () => {
    expect(resolveToolName('Read')).toBe('read_file');
    expect(resolveToolName('Edit')).toBe('edit');
    expect(resolveToolName('Write')).toBe('write_file');
  });

  it('resolves Agent category', async () => {
    expect(resolveToolName('Agent')).toBe('agent');
    expect(resolveToolName('agent')).toBe('agent');
    expect(resolveToolName('AgentTool')).toBe('agent');
  });

  it('resolves legacy task aliases to agent', async () => {
    expect(resolveToolName('task')).toBe('agent');
    expect(resolveToolName('Task')).toBe('agent');
    expect(resolveToolName('TaskTool')).toBe('agent');
  });

  it('resolves TodoList aliases (incl. legacy TodoWrite) to todo_write', async () => {
    expect(resolveToolName('todo_write')).toBe('todo_write');
    // The display name shown in the UI; a user writing allow: ["TodoList"]
    // must resolve to the tool, not be silently dropped.
    expect(resolveToolName('TodoList')).toBe('todo_write');
    // Legacy display name (renamed from TodoWrite) keeps resolving.
    expect(resolveToolName('TodoWrite')).toBe('todo_write');
    expect(resolveToolName('TodoWriteTool')).toBe('todo_write');
  });

  it('returns unknown names unchanged', async () => {
    expect(resolveToolName('my_mcp_tool')).toBe('my_mcp_tool');
    expect(resolveToolName('mcp__server__tool')).toBe('mcp__server__tool');
    expect(resolveToolName('constructor')).toBe('constructor');
  });
});

// ─── resolveToolName exhaustiveness (#9827) ─────────────────────────────────

describe('resolveToolName exhaustiveness (#9827)', () => {
  // Every built-in tool's canonical name AND display name must resolve
  // through TOOL_NAME_ALIASES. A tool added to tool-names.ts without a
  // matching rule-parser alias entry silently never matches any permission
  // rule — the exact #9827 bug class. Let drift fail CI instead of
  // failing silently for a user.
  it.each(
    Object.entries(ToolDisplayNames).map(([key, displayName]) => ({
      key,
      displayName,
      canonicalName: ToolNames[key as keyof typeof ToolNames],
    })),
  )(
    'covers $key ($displayName -> $canonicalName)',
    ({ displayName, canonicalName }) => {
      expect(canonicalName).toBeDefined();
      // The canonical name itself is a valid rule spelling.
      expect(resolveToolName(canonicalName)).toBe(canonicalName);
      // The /tools display name — the spelling users copy into rules —
      // must resolve to the canonical tool.
      expect(resolveToolName(displayName)).toBe(canonicalName);
    },
  );

  it('registers every canonical tool name in the alias map', () => {
    for (const canonicalName of Object.values(ToolNames)) {
      expect(TOOL_NAME_ALIASES[canonicalName]).toBe(canonicalName);
    }
  });
});

// ─── getSpecifierKind ────────────────────────────────────────────────────────

describe('getSpecifierKind', () => {
  it('returns "command" for shell tools', async () => {
    expect(getSpecifierKind('run_shell_command')).toBe('command');
  });

  it('returns "path" for file read/edit tools', async () => {
    expect(getSpecifierKind('read_file')).toBe('path');
    expect(getSpecifierKind('zoom_image')).toBe('path');
    expect(getSpecifierKind('edit')).toBe('path');
    expect(getSpecifierKind('notebook_edit')).toBe('path');
    expect(getSpecifierKind('write_file')).toBe('path');
    expect(getSpecifierKind('grep_search')).toBe('path');
    expect(getSpecifierKind('glob')).toBe('path');
    expect(getSpecifierKind('list_directory')).toBe('path');
  });

  it('returns "domain" for web fetch tools', async () => {
    expect(getSpecifierKind('web_fetch')).toBe('domain');
  });

  it('returns "literal" for other tools', async () => {
    expect(getSpecifierKind('Agent')).toBe('literal');
    expect(getSpecifierKind('task')).toBe('literal');
    expect(getSpecifierKind('mcp__server')).toBe('literal');
  });
});

// ─── toolMatchesRuleToolName ─────────────────────────────────────────────────

describe('toolMatchesRuleToolName', () => {
  it('exact match', async () => {
    expect(toolMatchesRuleToolName('read_file', 'read_file')).toBe(true);
    expect(toolMatchesRuleToolName('edit', 'edit')).toBe(true);
  });

  it('"Read" (read_file) covers all read-only file tools', async () => {
    expect(toolMatchesRuleToolName('read_file', 'zoom_image')).toBe(true);
    expect(toolMatchesRuleToolName('read_file', 'grep_search')).toBe(true);
    expect(toolMatchesRuleToolName('read_file', 'glob')).toBe(true);
    expect(toolMatchesRuleToolName('read_file', 'list_directory')).toBe(true);
  });

  it('"Edit" (edit) covers write_file and notebook_edit', async () => {
    expect(toolMatchesRuleToolName('edit', 'write_file')).toBe(true);
    expect(toolMatchesRuleToolName('edit', 'notebook_edit')).toBe(true);
  });

  it('"Bash" (run_shell_command) covers monitor', async () => {
    expect(toolMatchesRuleToolName('run_shell_command', 'monitor')).toBe(true);
  });

  it('monitor rules do not cover run_shell_command', async () => {
    expect(toolMatchesRuleToolName('monitor', 'run_shell_command')).toBe(false);
  });

  it('does not cross categories', async () => {
    expect(toolMatchesRuleToolName('read_file', 'edit')).toBe(false);
    expect(toolMatchesRuleToolName('edit', 'read_file')).toBe(false);
    expect(toolMatchesRuleToolName('read_file', 'run_shell_command')).toBe(
      false,
    );
  });
});

// ─── parseRule ───────────────────────────────────────────────────────────────

describe('parseRule', () => {
  it('parses a simple tool name', async () => {
    const r = parseRule('ShellTool');
    expect(r.raw).toBe('ShellTool');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBeUndefined();
    expect(r.specifierKind).toBeUndefined();
  });

  it('parses Bash alias', async () => {
    const r = parseRule('Bash');
    expect(r.toolName).toBe('run_shell_command');
  });

  it('parses Monitor alias', async () => {
    const r = parseRule('Monitor');
    expect(r.toolName).toBe('monitor');
  });

  it('parses a shell tool with a specifier', async () => {
    const r = parseRule('Bash(git *)');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBe('git *');
    expect(r.specifierKind).toBe('command');
  });

  it('parses Monitor with command specifier', async () => {
    const r = parseRule('Monitor(tail -f *)');
    expect(r.toolName).toBe('monitor');
    expect(r.specifier).toBe('tail -f *');
    expect(r.specifierKind).toBe('command');
  });

  it('parses Read with path specifier', async () => {
    const r = parseRule('Read(./secrets/**)');
    expect(r.toolName).toBe('read_file');
    expect(r.specifier).toBe('./secrets/**');
    expect(r.specifierKind).toBe('path');
  });

  it('parses Edit with path specifier', async () => {
    const r = parseRule('Edit(/src/**/*.ts)');
    expect(r.toolName).toBe('edit');
    expect(r.specifier).toBe('/src/**/*.ts');
    expect(r.specifierKind).toBe('path');
  });

  it('parses WebFetch with domain specifier', async () => {
    const r = parseRule('WebFetch(domain:example.com)');
    expect(r.toolName).toBe('web_fetch');
    expect(r.specifier).toBe('domain:example.com');
    expect(r.specifierKind).toBe('domain');
  });

  it('parses Agent with literal specifier', async () => {
    const r = parseRule('Agent(Explore)');
    expect(r.toolName).toBe('agent');
    expect(r.specifier).toBe('Explore');
    expect(r.specifierKind).toBe('literal');
  });

  it('handles unknown tools without specifier', async () => {
    const r = parseRule('mcp__my_server__my_tool');
    expect(r.toolName).toBe('mcp__my_server__my_tool');
    expect(r.specifier).toBeUndefined();
  });

  it('handles legacy :* suffix (deprecated)', async () => {
    const r = parseRule('Bash(git:*)');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBe('git *');
  });

  it('handles malformed pattern (no closing paren)', async () => {
    const r = parseRule('Bash(git status');
    expect(r.invalid).toBe(true);
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBeUndefined();
    // Must not match any command
    expect(matchesRule(r, 'run_shell_command', 'git status')).toBe(false);
    expect(matchesRule(r, 'run_shell_command', 'rm -rf /')).toBe(false);
  });

  it('handles malformed pattern with trailing junk after paren', async () => {
    const r = parseRule('Bash(rm -rf /)*');
    expect(r.invalid).toBe(true);
    expect(matchesRule(r, 'run_shell_command', 'git status')).toBe(false);
    expect(matchesRule(r, 'run_shell_command', 'rm -rf /')).toBe(false);
  });

  it('handles malformed pattern with only open paren', async () => {
    const r = parseRule('Bash(');
    expect(r.invalid).toBe(true);
    expect(matchesRule(r, 'run_shell_command', 'ls')).toBe(false);
  });

  it('still parses well-formed rules correctly', async () => {
    const r = parseRule('Bash(rm -rf /)');
    expect(r.invalid).toBeUndefined();
    expect(matchesRule(r, 'run_shell_command', 'rm -rf /')).toBe(true);
    expect(matchesRule(r, 'run_shell_command', 'git status')).toBe(false);
  });
});

// ─── parseRules ──────────────────────────────────────────────────────────────

describe('parseRules', () => {
  it('filters empty strings', async () => {
    const rules = parseRules(['ShellTool', '', '  ', 'ReadFileTool']);
    expect(rules).toHaveLength(2);
  });
});

// ─── matchesCommandPattern (Shell glob) ──────────────────────────────────────

describe('matchesCommandPattern', () => {
  // Basic prefix matching (no wildcards)
  describe('prefix matching without glob', () => {
    it('exact match', async () => {
      expect(matchesCommandPattern('git', 'git')).toBe(true);
    });

    it('prefix + space', async () => {
      expect(matchesCommandPattern('git', 'git status')).toBe(true);
      expect(matchesCommandPattern('git commit', 'git commit -m "test"')).toBe(
        true,
      );
    });

    it('does not match as substring', async () => {
      expect(matchesCommandPattern('git', 'gitcommit')).toBe(false);
    });
  });

  // Wildcard at tail
  describe('wildcard at tail', () => {
    it('matches any arguments', async () => {
      expect(matchesCommandPattern('git *', 'git status')).toBe(true);
      expect(matchesCommandPattern('git *', 'git commit -m "test"')).toBe(true);
      expect(matchesCommandPattern('npm run *', 'npm run build')).toBe(true);
    });

    it('matches commands with leading env var assignments', async () => {
      expect(
        matchesCommandPattern(
          'python3 *',
          'PYTHONPATH=/tmp/lib python3 -c "print(1)"',
        ),
      ).toBe(true);
    });

    it('matches commands containing embedded newlines (dotAll)', async () => {
      expect(
        matchesCommandPattern(
          'python3 *',
          'python3 -c "\nimport sys\nprint(sys.version)\n"',
        ),
      ).toBe(true);
    });

    it('space-star requires word boundary (ls * does not match lsof)', async () => {
      expect(matchesCommandPattern('ls *', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls *', 'lsof')).toBe(false);
    });

    it('no-space-star allows prefix matching (ls* matches lsof)', async () => {
      expect(matchesCommandPattern('ls*', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls*', 'lsof')).toBe(true);
    });

    it('does not match different command', async () => {
      expect(matchesCommandPattern('git *', 'echo hello')).toBe(false);
    });
  });

  // Wildcard at head
  describe('wildcard at head', () => {
    it('matches any command ending with pattern', async () => {
      expect(matchesCommandPattern('* --version', 'node --version')).toBe(true);
      expect(matchesCommandPattern('* --version', 'npm --version')).toBe(true);
      expect(matchesCommandPattern('* --help *', 'npm --help install')).toBe(
        true,
      );
    });

    it('does not match non-matching suffix', async () => {
      expect(matchesCommandPattern('* --version', 'node --help')).toBe(false);
    });
  });

  // Wildcard in middle
  describe('wildcard in middle', () => {
    it('matches middle segments', async () => {
      expect(matchesCommandPattern('git * main', 'git checkout main')).toBe(
        true,
      );
      expect(matchesCommandPattern('git * main', 'git merge main')).toBe(true);
    });

    it('does not match different suffix', async () => {
      expect(matchesCommandPattern('git * main', 'git checkout dev')).toBe(
        false,
      );
    });
  });

  // Word boundary rule: space before * matters
  describe('word boundary rule (space before *)', () => {
    it('Bash(ls *): matches "ls -la" but NOT "lsof"', async () => {
      expect(matchesCommandPattern('ls *', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls *', 'ls')).toBe(true); // "ls" alone
      expect(matchesCommandPattern('ls *', 'lsof')).toBe(false);
    });

    it('Bash(ls*): matches both "ls -la" and "lsof"', async () => {
      expect(matchesCommandPattern('ls*', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls*', 'lsof')).toBe(true);
      expect(matchesCommandPattern('ls*', 'ls')).toBe(true);
    });

    it('Bash(npm *): matches "npm run" but NOT "npmx"', async () => {
      expect(matchesCommandPattern('npm *', 'npm run build')).toBe(true);
      expect(matchesCommandPattern('npm *', 'npmx install')).toBe(false);
    });
  });

  // Shell operator awareness
  //
  // Key insight: operator boundary extraction means we only match against
  // the FIRST simple command. So `git *` still matches `git status && rm -rf /`
  // because the first command IS `git status` which matches `git *`.
  //
  // The safety benefit: a pattern like `rm *` would NOT match
  // `git status && rm -rf /` because the first command is `git status`.
  // matchesCommandPattern operates on simple commands only.
  // Compound command splitting is handled by PermissionManager.evaluate().
  // These tests verify that matchesCommandPattern works correctly on
  // individual simple commands (the sub-commands after splitting).
  describe('simple command matching (no operators)', () => {
    it('matches when no operators are present', async () => {
      expect(
        matchesCommandPattern('git *', 'git commit -m "hello world"'),
      ).toBe(true);
    });

    it('operators inside quotes are not boundaries for splitCompoundCommand', async () => {
      // "echo 'a && b'" → the && is inside quotes, not an operator
      expect(matchesCommandPattern('echo *', "echo 'a && b'")).toBe(true);
    });
  });

  // Special: lone * matches any command
  describe('lone wildcard', () => {
    it('* matches any single command', async () => {
      expect(matchesCommandPattern('*', 'anything here')).toBe(true);
    });
  });

  // Exact command match with specifier
  describe('exact command specifier', () => {
    it('Bash(npm run build) matches exact command', async () => {
      expect(matchesCommandPattern('npm run build', 'npm run build')).toBe(
        true,
      );
    });
    it('Bash(npm run build) also matches with trailing args (prefix)', async () => {
      expect(
        matchesCommandPattern('npm run build', 'npm run build --verbose'),
      ).toBe(true);
    });
    it('Bash(npm run build) does not match different command', async () => {
      expect(matchesCommandPattern('npm run build', 'npm run test')).toBe(
        false,
      );
    });
  });
});

// ─── splitCompoundCommand ────────────────────────────────────────────────────

describe('splitCompoundCommand', () => {
  it('simple command returns single-element array', async () => {
    expect(splitCompoundCommand('git status')).toEqual(['git status']);
  });

  it('splits on &&', async () => {
    expect(splitCompoundCommand('git status && rm -rf /')).toEqual([
      'git status',
      'rm -rf /',
    ]);
  });

  it('splits on ||', async () => {
    expect(splitCompoundCommand('git push || echo failed')).toEqual([
      'git push',
      'echo failed',
    ]);
  });

  it('splits on ;', async () => {
    expect(splitCompoundCommand('echo hello; echo world')).toEqual([
      'echo hello',
      'echo world',
    ]);
  });

  it('splits on |', async () => {
    expect(splitCompoundCommand('git log | grep fix')).toEqual([
      'git log',
      'grep fix',
    ]);
  });

  it('handles three-part compound', async () => {
    expect(splitCompoundCommand('a && b && c')).toEqual(['a', 'b', 'c']);
  });

  it('handles mixed operators', async () => {
    expect(splitCompoundCommand('a && b | c; d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not split on operators inside single quotes', async () => {
    expect(splitCompoundCommand("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  it('does not split on operators inside double quotes', async () => {
    expect(splitCompoundCommand('echo "a && b"')).toEqual(['echo "a && b"']);
  });

  it('handles escaped characters', async () => {
    // A backslash escapes exactly one character, so `\&` is a literal
    // ampersand argument and the command really is a single one.
    expect(splitCompoundCommand('echo a \\& b')).toEqual(['echo a \\& b']);
  });

  it('escapes only the first of two ampersands', async () => {
    // `echo a \&& b` is not an escaped `&&`: the backslash consumes the first
    // ampersand and the second is a live async operator. `bash -x` runs it as
    // two commands, `echo a '&'` and `b`, so the splitter has to see two.
    expect(splitCompoundCommand('echo a \\&& b')).toEqual(['echo a \\&', 'b']);
  });

  it('trims whitespace around sub-commands', async () => {
    expect(splitCompoundCommand('  git status  &&  rm -rf /  ')).toEqual([
      'git status',
      'rm -rf /',
    ]);
  });

  // The async operator. Everything after a bare `&` is a separate command that
  // the shell will run, so leaving it joined let one segment's allow rule
  // authorise whatever followed it.
  it('splits on the async operator', async () => {
    expect(splitCompoundCommand('git status & rm -rf /tmp/x')).toEqual([
      'git status',
      'rm -rf /tmp/x',
    ]);
  });

  it('splits on repeated async operators', async () => {
    expect(splitCompoundCommand('a & b & c')).toEqual(['a', 'b', 'c']);
  });

  it('drops the empty segment after a trailing async operator', async () => {
    expect(splitCompoundCommand('npm test &')).toEqual(['npm test']);
  });

  it('splits an unquoted URL query the way the shell does', async () => {
    // Not a special case: an unquoted `&` in a URL really is the async
    // operator, and bash runs `b=2` as its own command.
    expect(splitCompoundCommand('curl http://x?a=1&b=2')).toEqual([
      'curl http://x?a=1',
      'b=2',
    ]);
  });

  it.each([
    ['build &> log.txt'],
    ['build &>> log.txt'],
    ['ls /nope 2>&1'],
    ['echo err >&2'],
    ['ls /nope > out.txt 2>& 1'],
    // Input-descriptor duplication: the `<` branch of the backward scan.
    ['exec 3<&4'],
    ['cat <&3'],
  ])('does not split %s, where & belongs to a redirection', async (command) => {
    expect(splitCompoundCommand(command)).toEqual([command]);
  });

  it.each([["echo 'x & y'"], ['echo "x & y"']])(
    'does not split %s, where & is quoted',
    async (command) => {
      expect(splitCompoundCommand(command)).toEqual([command]);
    },
  );

  // Over-correction guard: the longer operators must keep winning over the
  // bare `&`, so these two pass both before and after the change.
  it.each([
    ['a && b', ['a', 'b']],
    ['a |& b', ['a', 'b']],
  ])('keeps %s splitting on the longer operator', async (command, expected) => {
    expect(splitCompoundCommand(command)).toEqual(expected);
  });

  it('splits a mix of long and bare operators', async () => {
    expect(splitCompoundCommand('a && b & c')).toEqual(['a', 'b', 'c']);
  });

  // The backward scan for a redirection has to respect escaping. `\>` is a
  // literal `>` argument, so bash backgrounds the `echo` and then runs the
  // `rm`; reading it as a redirection kept both in one segment and let the
  // `echo`'s allow rule authorise the `rm`.
  it.each([
    ['echo a \\> & rm -rf /tmp/x', ['echo a \\>', 'rm -rf /tmp/x']],
    ['echo a \\< & rm -rf /tmp/x', ['echo a \\<', 'rm -rf /tmp/x']],
  ])('splits %s, where the redirection is escaped', async (command, parts) => {
    expect(splitCompoundCommand(command)).toEqual(parts);
  });

  it('keeps an escaped backslash before a real redirection unsplit', async () => {
    // Two backslashes are a literal backslash, so the `>` really is a
    // redirection and the `&` really does duplicate a descriptor.
    expect(splitCompoundCommand('echo a \\\\>& 2')).toEqual([
      'echo a \\\\>& 2',
    ]);
  });

  // Inside `$(( … ))` / `(( … ))` a bare `&` is bitwise AND. Splitting there
  // produced two fragments that match no rule, so an otherwise allowed command
  // stopped matching its own allow rule.
  it.each([
    ['VAR=$(( FLAGS & MASK ))'],
    ['(( a & b ))'],
    ['echo $(( (x & y) + z ))'],
  ])('does not split %s, where & is arithmetic', async (command) => {
    expect(splitCompoundCommand(command)).toEqual([command]);
  });

  it('still splits a bare & that follows an arithmetic expansion', async () => {
    // Over-correction guard: the depth counter has to come back down.
    expect(splitCompoundCommand('echo $(( a & b )) & rm -rf /tmp/x')).toEqual([
      'echo $(( a & b ))',
      'rm -rf /tmp/x',
    ]);
  });

  // The backward scan runs off the front of the string: nothing precedes the
  // `&`, so it cannot be part of a redirection and is the async operator.
  it.each([['& echo hi'], ['   & echo hi']])(
    'treats the leading & in %s as the async operator',
    async (command) => {
      expect(splitCompoundCommand(command)).toEqual(['echo hi']);
    },
  );
});

// ─── splitCompoundCommandSegments ────────────────────────────────────────────

describe('splitCompoundCommandSegments', () => {
  it('reports the operator that terminated each segment', async () => {
    expect(splitCompoundCommandSegments('a & b && c | d')).toEqual([
      { command: 'a', terminator: '&' },
      { command: 'b', terminator: '&&' },
      { command: 'c', terminator: '|' },
      { command: 'd', terminator: '' },
    ]);
  });

  it('reports an empty terminator for a single command', async () => {
    expect(splitCompoundCommandSegments('git status')).toEqual([
      { command: 'git status', terminator: '' },
    ]);
  });

  it('keeps the async terminator on a trailing background command', async () => {
    expect(splitCompoundCommandSegments('npm test &')).toEqual([
      { command: 'npm test', terminator: '&' },
    ]);
  });
});

// ─── resolvePathPattern ──────────────────────────────────────────────────────

describe('resolvePathPattern', () => {
  const projectRoot = '/project';
  const cwd = '/project/subdir';

  it('// prefix → absolute from filesystem root', async () => {
    expect(
      resolvePathPattern('//Users/alice/secrets/**', projectRoot, cwd),
    ).toBe('/Users/alice/secrets/**');
  });

  it('~/ prefix → relative to home directory', async () => {
    const result = resolvePathPattern('~/Documents/*.pdf', projectRoot, cwd);
    expect(result).toContain('Documents/*.pdf');
    // On POSIX systems the home dir starts with '/'; on Windows it may look like
    // 'C:/Users/foo'. Either way, verify the result begins with the (normalized)
    // home directory.
    const normalizedHome = os.homedir().replace(/\\/g, '/');
    expect(result.startsWith(normalizedHome)).toBe(true);
  });

  it('/ prefix → relative to project root (NOT absolute)', async () => {
    expect(resolvePathPattern('/src/**/*.ts', projectRoot, cwd)).toBe(
      '/project/src/**/*.ts',
    );
  });

  it('./ prefix → relative to cwd', async () => {
    expect(resolvePathPattern('./secrets/**', projectRoot, cwd)).toBe(
      '/project/subdir/secrets/**',
    );
  });

  it('no prefix → relative to cwd', async () => {
    expect(resolvePathPattern('*.env', projectRoot, cwd)).toBe(
      '/project/subdir/*.env',
    );
  });

  it('/Users/alice/file is relative to project root, NOT absolute', async () => {
    // Leading slash patterns are project-root relative.
    expect(resolvePathPattern('/Users/alice/file', projectRoot, cwd)).toBe(
      '/project/Users/alice/file',
    );
  });
});

// ─── matchesPathPattern ──────────────────────────────────────────────────────

describe('matchesPathPattern', () => {
  const projectRoot = '/project';
  const cwd = '/project';
  const withTempRoot = (run: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-permission-'));
    try {
      run(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it('matches dotfiles (e.g. .env)', async () => {
    expect(matchesPathPattern('.env', '/project/.env', projectRoot, cwd)).toBe(
      true,
    );
    expect(matchesPathPattern('*.env', '/project/.env', projectRoot, cwd)).toBe(
      true,
    );
  });

  it('** matches recursively across directories', async () => {
    expect(
      matchesPathPattern(
        './secrets/**',
        '/project/secrets/deep/nested/file.txt',
        projectRoot,
        cwd,
      ),
    ).toBe(true);
  });

  it('* matches single directory only', async () => {
    expect(
      matchesPathPattern(
        '/src/*.ts',
        '/project/src/index.ts',
        projectRoot,
        cwd,
      ),
    ).toBe(true);
    expect(
      matchesPathPattern(
        '/src/*.ts',
        '/project/src/nested/index.ts',
        projectRoot,
        cwd,
      ),
    ).toBe(false);
  });

  it('/docs/** matches under project root docs', async () => {
    expect(
      matchesPathPattern(
        '/docs/**',
        '/project/docs/readme.md',
        projectRoot,
        cwd,
      ),
    ).toBe(true);
    expect(
      matchesPathPattern(
        '/docs/**',
        '/project/src/docs/readme.md',
        projectRoot,
        cwd,
      ),
    ).toBe(false);
  });

  it('//tmp/scratch.txt matches absolute path', async () => {
    expect(
      matchesPathPattern(
        '//tmp/scratch.txt',
        '/tmp/scratch.txt',
        projectRoot,
        cwd,
      ),
    ).toBe(true);
  });

  it('does not match unrelated paths', async () => {
    expect(
      matchesPathPattern(
        './secrets/**',
        '/project/public/index.html',
        projectRoot,
        cwd,
      ),
    ).toBe(false);
  });

  it('matches a path after resolving parent-directory traversal', () => {
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const nestedDir = path.join(root, 'workspace', 'nested');
      fs.mkdirSync(protectedDir);
      fs.mkdirSync(nestedDir, { recursive: true });

      expect(
        matchesPathPattern(
          `/${path.basename(protectedDir)}/**`,
          `${nestedDir}${path.sep}..${path.sep}..${path.sep}protected${path.sep}new.txt`,
          root,
          root,
          'canonical',
        ),
      ).toBe(true);
    });
  });

  it('matches the canonical target of a symlinked path', () => {
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const link = path.join(root, 'link');
      fs.mkdirSync(protectedDir);
      fs.writeFileSync(path.join(protectedDir, 'existing.txt'), 'protected');
      fs.symlinkSync(protectedDir, link, 'dir');

      expect(
        matchesPathPattern(
          '/protected/**',
          path.join(link, 'existing.txt'),
          root,
          root,
        ),
      ).toBe(false);
      expect(
        matchesPathPattern(
          '/protected/**',
          path.join(link, 'existing.txt'),
          root,
          root,
          'canonical',
        ),
      ).toBe(true);
    });
  });

  it('canonicalizes through a file that causes ENOTDIR', () => {
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const link = path.join(root, 'link');
      fs.mkdirSync(protectedDir);
      fs.writeFileSync(path.join(protectedDir, 'config.json'), '{}');
      fs.symlinkSync(protectedDir, link, 'dir');

      expect(
        matchesPathPattern(
          '/protected/**',
          path.join(link, 'config.json', 'nested.txt'),
          root,
          root,
          'canonical',
        ),
      ).toBe(true);
    });
  });

  it('canonicalizes a symlinked project root in restrictive rules', () => {
    withTempRoot((root) => {
      const realRoot = path.join(root, 'real');
      const linkedRoot = path.join(root, 'linked');
      const protectedDir = path.join(realRoot, 'protected');
      fs.mkdirSync(protectedDir, { recursive: true });
      fs.writeFileSync(path.join(protectedDir, 'file.txt'), 'protected');
      fs.symlinkSync(realRoot, linkedRoot, 'dir');

      expect(
        matchesPathPattern(
          '/protected/**',
          path.join(protectedDir, 'file.txt'),
          linkedRoot,
          linkedRoot,
          'canonical',
        ),
      ).toBe(true);
    });
  });

  it('canonicalizes the nearest existing ancestor for a new path', () => {
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const link = path.join(root, 'link');
      fs.mkdirSync(protectedDir);
      fs.symlinkSync(protectedDir, link, 'dir');

      expect(
        matchesPathPattern(
          '/protected/**',
          path.join(link, 'new', 'file.txt'),
          root,
          root,
          'canonical',
        ),
      ).toBe(true);
    });
  });

  it('matches the target of a dangling symlink', () => {
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const target = path.join(protectedDir, 'new.txt');
      const link = path.join(root, 'link.txt');
      fs.mkdirSync(protectedDir);
      fs.symlinkSync(target, link, 'file');

      expect(
        matchesPathPattern('/protected/**', link, root, root, 'canonical'),
      ).toBe(true);
    });
  });

  // Title names the platform assumption so a future realpath-based resolution
  // in matchesPathPattern is seen to break it, not silently re-asserted.
  it('preserves traversal semantics in a dangling symlink target (win32 collapses .. before the reparse point; POSIX follows the link first)', () => {
    withTempRoot((root) => {
      const projectDir = path.join(root, 'project');
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(projectDir);
      fs.mkdirSync(path.join(outsideDir, 'dir'), { recursive: true });
      fs.mkdirSync(path.join(outsideDir, 'safe'));

      fs.symlinkSync(
        path.join(outsideDir, 'dir'),
        path.join(projectDir, 'inner'),
        'dir',
      );
      const link = path.join(projectDir, 'link.txt');
      fs.symlinkSync(
        `inner${path.sep}..${path.sep}safe${path.sep}new.txt`,
        link,
      );

      // Win32 normalizes `..` before traversing a reparse point; POSIX follows
      // the symlink first and applies `..` to its target.
      const targetRoot = process.platform === 'win32' ? 'project' : 'outside';
      const otherRoot = process.platform === 'win32' ? 'outside' : 'project';

      expect(
        matchesPathPattern(
          `/${targetRoot}/safe/**`,
          link,
          root,
          root,
          'canonical',
        ),
      ).toBe(true);
      expect(
        matchesPathPattern(
          `/${otherRoot}/safe/**`,
          link,
          root,
          root,
          'canonical',
        ),
      ).toBe(false);
    });
  });

  it('resolves parent traversal after following a directory symlink (win32 collapses .. before the reparse point; POSIX follows the link first)', () => {
    withTempRoot((root) => {
      const projectDir = path.join(root, 'project');
      const outsideDir = path.join(root, 'outside');
      const outsideSafeDir = path.join(outsideDir, 'safe');
      fs.mkdirSync(path.join(projectDir, 'safe'), { recursive: true });
      fs.mkdirSync(path.join(outsideDir, 'dir'), { recursive: true });
      fs.mkdirSync(outsideSafeDir);
      fs.writeFileSync(path.join(outsideSafeDir, 'file.txt'), 'outside');

      const link = path.join(projectDir, 'link');
      fs.symlinkSync(path.join(outsideDir, 'dir'), link, 'dir');
      const filePath = `${link}${path.sep}..${path.sep}safe${path.sep}file.txt`;

      // Win32 normalizes `..` before traversing a reparse point; POSIX follows
      // the symlink first and applies `..` to its target.
      const targetRoot = process.platform === 'win32' ? 'project' : 'outside';
      const otherRoot = process.platform === 'win32' ? 'outside' : 'project';

      expect(
        matchesPathPattern(
          `/${targetRoot}/safe/**`,
          filePath,
          root,
          root,
          'canonical',
        ),
      ).toBe(true);
      expect(
        matchesPathPattern(
          `/${otherRoot}/safe/**`,
          filePath,
          root,
          root,
          'canonical',
        ),
      ).toBe(false);
    });
  });

  it('preserves matching against the lexical symlink path', () => {
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const link = path.join(root, 'link');
      fs.mkdirSync(protectedDir);
      fs.symlinkSync(protectedDir, link, 'dir');

      expect(
        matchesPathPattern('/link/**', path.join(link, 'new.txt'), root, root),
      ).toBe(true);
    });
  });
});

// ─── matchesDomainPattern ────────────────────────────────────────────────────

describe('matchesDomainPattern', () => {
  it('matches exact domain', async () => {
    expect(matchesDomainPattern('domain:example.com', 'example.com')).toBe(
      true,
    );
  });

  it('matches subdomain', async () => {
    expect(matchesDomainPattern('domain:example.com', 'sub.example.com')).toBe(
      true,
    );
    expect(
      matchesDomainPattern('domain:example.com', 'deep.sub.example.com'),
    ).toBe(true);
  });

  it('does not match different domain', async () => {
    expect(matchesDomainPattern('domain:example.com', 'notexample.com')).toBe(
      false,
    );
  });

  it('is case-insensitive', async () => {
    expect(matchesDomainPattern('domain:Example.COM', 'example.com')).toBe(
      true,
    );
  });

  it('handles missing prefix', async () => {
    expect(matchesDomainPattern('example.com', 'example.com')).toBe(true);
  });
});

// ─── matchesRule (unified) ───────────────────────────────────────────────────

describe('matchesRule', () => {
  // Basic tool name matching
  it('simple tool-name rule matches any invocation', async () => {
    const rule = parseRule('ShellTool');
    expect(matchesRule(rule, 'run_shell_command')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
  });

  it('does not match a different tool', async () => {
    const rule = parseRule('ShellTool');
    expect(matchesRule(rule, 'read_file')).toBe(false);
  });

  // Shell command specifier
  it('specifier rule requires a command for shell tools', async () => {
    const rule = parseRule('Bash(git *)');
    expect(matchesRule(rule, 'run_shell_command')).toBe(false); // no command
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'echo hello')).toBe(false);
  });

  // Monitor command specifier
  it('Monitor rule matches monitor invocations with command specifier', async () => {
    const rule = parseRule('Monitor(tail -f *)');
    expect(matchesRule(rule, 'monitor')).toBe(false); // no command
    expect(matchesRule(rule, 'monitor', 'tail -f /var/log/app.log')).toBe(true);
    expect(matchesRule(rule, 'monitor', 'echo hello')).toBe(false);
  });

  it('Monitor rule does not match run_shell_command', async () => {
    const rule = parseRule('Monitor(tail -f *)');
    expect(
      matchesRule(rule, 'run_shell_command', 'tail -f /var/log/app.log'),
    ).toBe(false);
  });

  it('Bash rule also covers monitor (shell deny rules block monitor)', async () => {
    const rule = parseRule('Bash(tail -f *)');
    expect(matchesRule(rule, 'monitor', 'tail -f /var/log/app.log')).toBe(true);
    expect(matchesRule(rule, 'monitor', 'echo hello')).toBe(false);
  });

  it('matchesRule checks individual simple commands (compound splitting is at PM level)', async () => {
    const rule = parseRule('Bash(git *)');
    // matchesRule receives a simple command (already split by PM)
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'rm -rf /')).toBe(false);
  });

  // Meta-category matching: Read
  it('Read rule matches grep_search, glob, list_directory', async () => {
    const rule = parseRule('Read');
    expect(matchesRule(rule, 'read_file')).toBe(true);
    expect(matchesRule(rule, 'grep_search')).toBe(true);
    expect(matchesRule(rule, 'glob')).toBe(true);
    expect(matchesRule(rule, 'list_directory')).toBe(true);
    expect(matchesRule(rule, 'edit')).toBe(false); // not a read tool
  });

  // Meta-category matching: Edit
  it('Edit rule matches edit, write_file, and notebook_edit', async () => {
    const rule = parseRule('Edit');
    expect(matchesRule(rule, 'edit')).toBe(true);
    expect(matchesRule(rule, 'write_file')).toBe(true);
    expect(matchesRule(rule, 'notebook_edit')).toBe(true);
    expect(matchesRule(rule, 'read_file')).toBe(false); // not an edit tool
  });

  // File path matching
  it('Read with path specifier requires filePath', async () => {
    const rule = parseRule('Read(.env)');
    const pathCtx = { projectRoot: '/project', cwd: '/project' };
    // No filePath → no match
    expect(matchesRule(rule, 'read_file')).toBe(false);
    // With filePath
    expect(
      matchesRule(
        rule,
        'read_file',
        undefined,
        '/project/.env',
        undefined,
        pathCtx,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'read_file',
        undefined,
        '/project/other.txt',
        undefined,
        pathCtx,
      ),
    ).toBe(false);
  });

  it('Edit path specifier matches write_file too', async () => {
    const rule = parseRule('Edit(/src/**/*.ts)');
    const pathCtx = { projectRoot: '/project', cwd: '/project' };
    expect(
      matchesRule(
        rule,
        'write_file',
        undefined,
        '/project/src/index.ts',
        undefined,
        pathCtx,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'write_file',
        undefined,
        '/project/docs/readme.md',
        undefined,
        pathCtx,
      ),
    ).toBe(false);
  });

  it('Edit path specifier matches notebook_edit too', async () => {
    const rule = parseRule('Edit(/src/**/*.ipynb)');
    const pathCtx = { projectRoot: '/project', cwd: '/project' };
    expect(
      matchesRule(
        rule,
        'notebook_edit',
        undefined,
        '/project/src/analysis.ipynb',
        undefined,
        pathCtx,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'notebook_edit',
        undefined,
        '/project/docs/analysis.ipynb',
        undefined,
        pathCtx,
      ),
    ).toBe(false);
  });

  // WebFetch domain matching
  it('WebFetch domain specifier', async () => {
    const rule = parseRule('WebFetch(domain:example.com)');
    expect(
      matchesRule(rule, 'web_fetch', undefined, undefined, 'example.com'),
    ).toBe(true);
    expect(
      matchesRule(rule, 'web_fetch', undefined, undefined, 'sub.example.com'),
    ).toBe(true);
    expect(
      matchesRule(rule, 'web_fetch', undefined, undefined, 'other.com'),
    ).toBe(false);
    // No domain → no match
    expect(matchesRule(rule, 'web_fetch')).toBe(false);
  });

  // Agent literal matching
  it('Agent literal specifier', async () => {
    const rule = parseRule('Agent(Explore)');
    // Agent is an alias for 'task'; specifier matches via the specifier field
    expect(
      matchesRule(
        rule,
        'task',
        undefined,
        undefined,
        undefined,
        undefined,
        'Explore',
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'task',
        undefined,
        undefined,
        undefined,
        undefined,
        'Plan',
      ),
    ).toBe(false);
    expect(matchesRule(rule, 'task')).toBe(false); // no specifier
  });

  // MCP tool matching
  it('MCP tool exact match', async () => {
    const rule = parseRule('mcp__puppeteer__puppeteer_navigate');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_click')).toBe(false);
  });

  it('matches a legacy dotted MCP rule against its provider-safe name', () => {
    const legacyName = 'mcp__zybio__literature.search_pubmed';
    const providerSafeName = normalizeToolNameForProvider(legacyName);

    expect(providerSafeName).not.toBe(legacyName);
    expect(matchesRule(parseRule(legacyName), providerSafeName)).toBe(true);
  });

  it('keeps exact provider-safe MCP permission matches collision-safe', () => {
    const dottedName = 'mcp__zybio__literature.search';
    const slashedName = 'mcp__zybio__literature/search';
    const dottedProviderName = normalizeToolNameForProvider(dottedName);
    const slashedProviderName = normalizeToolNameForProvider(slashedName);

    expect(dottedProviderName).not.toBe(slashedProviderName);
    expect(matchesRule(parseRule(dottedName), dottedProviderName)).toBe(true);
    expect(matchesRule(parseRule(dottedName), slashedProviderName)).toBe(false);
  });

  it('MCP server-level match (2-part pattern)', async () => {
    const rule = parseRule('mcp__puppeteer');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_click')).toBe(true);
    expect(matchesRule(rule, 'mcp__other__tool')).toBe(false);
  });

  it('matches a legacy dotted MCP server rule against provider-safe names', () => {
    const rule = parseRule('mcp__zybio.db');

    expect(
      matchesRule(
        rule,
        normalizeToolNameForProvider('mcp__zybio.db__query_uniprot'),
      ),
    ).toBe(true);
    expect(matchesRule(rule, 'mcp__other__query_uniprot')).toBe(false);
  });

  it('MCP wildcard match', async () => {
    const rule = parseRule('mcp__puppeteer__*');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__other__tool')).toBe(false);
  });

  it('matches a legacy dotted MCP wildcard rule against provider-safe names', () => {
    const rule = parseRule('mcp__zybio.db__*');

    expect(
      matchesRule(
        rule,
        normalizeToolNameForProvider('mcp__zybio.db__query_uniprot'),
      ),
    ).toBe(true);
    expect(matchesRule(rule, 'mcp__other__query_uniprot')).toBe(false);
  });

  it('MCP intra-segment wildcard match (e.g. mcp__chrome__use_*)', async () => {
    const rule = parseRule('mcp__chrome__use_*');
    expect(matchesRule(rule, 'mcp__chrome__use_browser')).toBe(true);
    expect(matchesRule(rule, 'mcp__chrome__use_context')).toBe(true);
    expect(matchesRule(rule, 'mcp__chrome__navigate')).toBe(false);
    expect(matchesRule(rule, 'mcp__other__use_browser')).toBe(false);
  });

  // ─── Tool(param:value) syntax ───────────────────────────────────────────────

  it('parseRule extracts key:value param matchers', async () => {
    const r = parseRule('Agent(model:opus)');
    expect(r.toolName).toBe('agent');
    expect(r.specifier).toBeUndefined();
    expect(r.toolParamMatchers).toEqual([
      { key: 'model', valuePattern: 'opus' },
    ]);
  });

  it('parseRule extracts multiple key:value pairs', async () => {
    const r = parseRule('Agent(model:opus,type:code)');
    expect(r.toolParamMatchers).toEqual([
      { key: 'model', valuePattern: 'opus' },
      { key: 'type', valuePattern: 'code' },
    ]);
  });

  it('parseRule handles mixed specifier and param matchers', async () => {
    const r = parseRule('Agent(coder,model:opus)');
    expect(r.specifier).toBe('coder');
    expect(r.toolParamMatchers).toEqual([
      { key: 'model', valuePattern: 'opus' },
    ]);
  });

  it('parseRule supports wildcard in value pattern', async () => {
    const r = parseRule('Agent(model:*)');
    expect(r.toolParamMatchers).toEqual([{ key: 'model', valuePattern: '*' }]);
  });

  it('parseRule does not treat WebFetch domain: as key:value', async () => {
    const r = parseRule('WebFetch(domain:example.com)');
    expect(r.specifierKind).toBe('domain');
    expect(r.toolParamMatchers).toBeUndefined();
  });

  it('parseRule preserves legacy :* for command specifiers', async () => {
    const r = parseRule('Bash(git:*)');
    expect(r.specifier).toBe('git *');
    expect(r.toolParamMatchers).toBeUndefined();
  });

  it('matchesRule matches tool with param matcher', async () => {
    const rule = parseRule('Agent(model:opus)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'opus',
        },
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'sonnet',
        },
      ),
    ).toBe(false);
  });

  it('matchesRule fails when toolParams missing for param matcher rule', async () => {
    const rule = parseRule('Agent(model:opus)');
    expect(matchesRule(rule, 'agent')).toBe(false);
  });

  it('matchesRule supports wildcard value pattern', async () => {
    const rule = parseRule('Agent(model:*)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'opus',
        },
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'sonnet',
        },
      ),
    ).toBe(true);
    expect(matchesRule(rule, 'agent')).toBe(false); // no toolParams
  });

  it('matchesRule requires all param matchers to match', async () => {
    const rule = parseRule('Agent(model:opus,type:code)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'opus',
          type: 'code',
        },
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'opus',
          type: 'chat',
        },
      ),
    ).toBe(false);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'opus',
        },
      ),
    ).toBe(false); // missing 'type' param
  });

  it('matchesRule handles mixed specifier and param matchers', async () => {
    const rule = parseRule('Agent(coder,model:opus)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        'coder',
        { model: 'opus' },
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        'coder',
        { model: 'sonnet' },
      ),
    ).toBe(false); // param mismatch
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        'explore',
        { model: 'opus' },
      ),
    ).toBe(false); // specifier mismatch
  });

  it('parseRule does not extract key:value for MCP tools (backward compat)', async () => {
    const r = parseRule('mcp__server__tool(server_name:myserver)');
    expect(r.toolName).toBe('mcp__server__tool');
    expect(r.specifier).toBe('server_name:myserver');
    expect(r.toolParamMatchers).toBeUndefined();
  });

  it('matchesRule supports partial wildcard patterns', async () => {
    const rule = parseRule('Agent(model:op*)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'opus',
        },
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'opera',
        },
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          model: 'sonnet',
        },
      ),
    ).toBe(false);
  });

  it('matchesRule handles multi-wildcard patterns without ReDoS', async () => {
    const rule = parseRule('Agent(prompt:*x*x*x*x*x*y)');
    // This should not hang (ReDoS) and should return false for non-matching input
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          prompt: 'a'.repeat(1000),
        },
      ),
    ).toBe(false);
    // Should match when pattern is present
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          prompt: 'xaxaxaxaxay',
        },
      ),
    ).toBe(true);
  });

  it('matchesRule coerces number values to string for matching', async () => {
    const rule = parseRule('Agent(count:42)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          count: 42,
        },
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          count: 43,
        },
      ),
    ).toBe(false);
  });
});

// ─── PermissionManager ──────────────────────────────────────────────────────

function makeConfig(
  opts: Partial<{
    permissionsAllow: string[];
    permissionsAsk: string[];
    permissionsDeny: string[];
    coreTools: string[];
    projectRoot: string;
    cwd: string;
    approvalMode: string;
    /**
     * `settings.tools.eager` — eager-by-default tool names whose schemas may
     * ride in the initial request. Absent means "no restriction"; an empty
     * array is active and defers every non-exempt tool. Wholly independent
     * of the permission rules (#10075).
     */
    eagerTools: string[];
    /** Live folder trust; absent reads as trusted. */
    isTrustedFolder: () => boolean;
  }> = {},
): PermissionManagerConfig {
  return {
    ...(opts.isTrustedFolder ? { isTrustedFolder: opts.isTrustedFolder } : {}),
    getPermissionsAllow: () => opts.permissionsAllow,
    getPermissionsAsk: () => opts.permissionsAsk,
    getPermissionsDeny: () => opts.permissionsDeny,
    getCoreTools: () => opts.coreTools,
    getEagerTools: () => opts.eagerTools,
    getProjectRoot: () => opts.projectRoot ?? '/project',
    getCwd: () => opts.cwd ?? '/project',
    getApprovalMode: () => opts.approvalMode ?? 'default',
  };
}

describe('PermissionManager', () => {
  let pm: PermissionManager;

  describe('basic rule evaluation', () => {
    beforeEach(() => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['ReadFileTool', 'Bash(git *)'],
          permissionsAsk: ['WriteFileTool'],
          permissionsDeny: ['ShellTool'],
        }),
      );
      pm.initialize();
    });

    it('returns deny for a denied tool', async () => {
      expect(await pm.evaluate({ toolName: 'run_shell_command' })).toBe('deny');
    });

    it('returns ask for an ask-rule tool', async () => {
      expect(await pm.evaluate({ toolName: 'write_file' })).toBe('ask');
    });

    it('returns allow for an allow-rule tool', async () => {
      expect(await pm.evaluate({ toolName: 'read_file' })).toBe('allow');
    });

    it('returns default for unmatched tool', async () => {
      // Note: 'glob' is covered by ReadFileTool via Read meta-category,
      // so use a tool not in any rule or meta-category
      expect(await pm.evaluate({ toolName: 'agent' })).toBe('default');
    });

    it('matches a legacy truncated MCP permission alias', async () => {
      const rawName = `mcp__server__${'x'.repeat(80)}`;
      const legacyName = rawName.slice(0, 28) + '___' + rawName.slice(-32);
      const providerSafeName = normalizeToolNameForProvider(rawName);
      const pm2 = new PermissionManager(
        makeConfig({ permissionsAllow: [legacyName] }),
      );
      pm2.initialize();

      expect(
        await pm2.evaluate({
          toolName: providerSafeName,
          toolAliases: [legacyName],
        }),
      ).toBe('allow');
    });

    it('honors legacy MCP wildcard deny rules for provider-safe names', async () => {
      const legacyName = 'mcp__server__literature.search_pubmed';
      const providerSafeName = normalizeToolNameForProvider(legacyName);
      const pm2 = new PermissionManager(
        makeConfig({ permissionsDeny: ['mcp__server__literature.*'] }),
      );
      pm2.initialize();

      expect(
        await pm2.evaluate({
          toolName: providerSafeName,
        }),
      ).toBe('deny');
    });

    it('deny takes precedence over ask and allow', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['run_shell_command'],
          permissionsAsk: ['run_shell_command'],
          permissionsDeny: ['run_shell_command'],
        }),
      );
      pm2.initialize();
      expect(await pm2.evaluate({ toolName: 'run_shell_command' })).toBe(
        'deny',
      );
    });

    it('ask takes precedence over allow', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['write_file'],
          permissionsAsk: ['write_file'],
        }),
      );
      pm2.initialize();
      expect(await pm2.evaluate({ toolName: 'write_file' })).toBe('ask');
    });
  });

  describe('command-level evaluation', () => {
    beforeEach(() => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)'],
          permissionsDeny: ['Bash(rm *)'],
        }),
      );
      pm.initialize();
    });

    it('allows a matching allowed command', async () => {
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git status',
        }),
      ).toBe('allow');
    });

    it('denies a matching denied command', async () => {
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'rm -rf /',
        }),
      ).toBe('deny');
    });

    it('resolves default to allow for readonly commands, ask for others', async () => {
      // 'echo' is a readonly command, so it resolves to 'allow'
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'echo hello',
        }),
      ).toBe('allow');
      // 'npm install' is not readonly, so it resolves to 'ask'
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'npm install',
        }),
      ).toBe('ask');
    });

    // Regression coverage for issue #4093: command substitution must never
    // produce a hard 'deny' from resolveDefaultPermission. Before the fix
    // the L4 default branch returned 'deny' for any command containing
    // $(), backticks, <(), or >(), which:
    //   1. could not be overridden by YOLO mode, and
    //   2. fired inconsistently — only when hasRelevantRules() happened to
    //      be true (e.g. a compound command where another sub-command
    //      matched an unrelated allow rule). Standalone substitution
    //      commands with no relevant rule skipped L4 entirely and got
    //      'ask' from L3, producing surprising asymmetry.
    // Both shapes must now resolve to 'ask' regardless of rule shape.
    describe('command substitution (issue #4093)', () => {
      it('returns ask for a standalone command with $() substitution', async () => {
        // No 'python3' rule is configured, but the substitution must not
        // trip a deny — the only acceptable answer is 'ask'.
        expect(
          await pm.evaluate({
            toolName: 'run_shell_command',
            command: 'python3 -c "print($(echo hello))"',
          }),
        ).toBe('ask');
      });

      it('returns ask for a compound command where one sub-command matches an allow rule and another contains $()', async () => {
        // Structurally equivalent to the scenario reported in issue #4093:
        // the first sub-command (`git status`) matches the surrounding
        // describe's `Bash(git *)` allow rule, which makes
        // hasRelevantRules() return true and triggers full PM evaluation;
        // the second sub-command (`python3 -c "..."`) contains command
        // substitution and does not match any rule, so it falls into
        // resolveDefaultPermission. Before the fix, that path returned
        // 'deny' for the substitution sub-command and the most-restrictive
        // combine made the whole compound deny. After the fix it returns
        // 'ask' and the compound resolves to 'ask'.
        expect(
          await pm.evaluate({
            toolName: 'run_shell_command',
            command: 'git status && python3 -c "print($(echo hello))"',
          }),
        ).toBe('ask');
      });

      it('returns ask for backtick command substitution', async () => {
        expect(
          await pm.evaluate({
            toolName: 'run_shell_command',
            command: 'echo `whoami`',
          }),
        ).toBe('ask');
      });

      it('returns ask for process substitution <()', async () => {
        expect(
          await pm.evaluate({
            toolName: 'run_shell_command',
            command: 'diff <(ls /a) <(ls /b)',
          }),
        ).toBe('ask');
      });

      it('returns ask for >() output process substitution', async () => {
        expect(
          await pm.evaluate({
            toolName: 'run_shell_command',
            command: 'echo data > >(tee log.txt)',
          }),
        ).toBe('ask');
      });

      it('still honors explicit deny rules over substitution-bearing commands', async () => {
        // The 'ask' from substitution must never downgrade a real deny rule.
        expect(
          await pm.evaluate({
            toolName: 'run_shell_command',
            command: 'rm -rf "$(pwd)/build"',
          }),
        ).toBe('deny');
      });
    });

    it('isCommandAllowed delegates to evaluate', async () => {
      expect(await pm.isCommandAllowed('git commit')).toBe('allow');
      expect(await pm.isCommandAllowed('rm -rf /')).toBe('deny');
      // 'ls' is readonly, resolves to 'allow' when no rule matches
      expect(await pm.isCommandAllowed('ls')).toBe('allow');
    });

    it('resolves shell virtual file operations relative to the explicit cwd', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Read(./subdir/secret.txt)'],
          projectRoot: '/project',
          cwd: '/project',
        }),
      );
      pm2.initialize();

      expect(
        await pm2.evaluate({
          toolName: 'run_shell_command',
          command: 'cat ./secret.txt',
          cwd: '/project/subdir',
        }),
      ).toBe('allow');
    });

    it('applies relative virtual file rules using the shell invocation cwd', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsDeny: ['Read(./secret.txt)'],
          projectRoot: '/project',
          cwd: '/project',
        }),
      );
      pm2.initialize();

      expect(
        await pm2.evaluate({
          toolName: 'run_shell_command',
          command: 'cat ./secret.txt',
          cwd: '/project/subdir',
        }),
      ).toBe('deny');
    });
  });

  describe('monitor command-level evaluation', () => {
    it('Monitor(...) allow rule matches monitor invocations', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Monitor(tail -f *)'],
        }),
      );
      pm2.initialize();
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: 'tail -f /var/log/app.log',
        }),
      ).toBe('allow');
    });

    it('Monitor(...) allow rule matches wrapped monitor invocations', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Monitor(tail -f *)'],
        }),
      );
      pm2.initialize();
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: `/bin/bash --noprofile -c 'tail -f /var/log/app.log &'`,
        }),
      ).toBe('allow');
    });

    it('asks by default for wrapped commands with environment prefixes', async () => {
      const pm2 = new PermissionManager(makeConfig({}));
      pm2.initialize();
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: String.raw`FOO="bar baz" /bin/bash --noprofile -c 'tail -f /var/log/app.log &'`,
        }),
      ).toBe('ask');
    });

    it('Monitor(...) deny rule sees shell wrapper suffix commands', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Monitor(tail -f *)'],
          permissionsDeny: ['Monitor(rm *)'],
        }),
      );
      pm2.initialize();
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: `/bin/bash -c 'tail -f /var/log/app.log' && rm -rf /tmp/owned`,
        }),
      ).toBe('deny');
    });

    it('Monitor(...) deny rule blocks monitor invocations', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsDeny: ['Monitor(rm *)'],
        }),
      );
      pm2.initialize();
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: 'rm -rf /',
        }),
      ).toBe('deny');
    });

    it('Monitor approval does NOT allow run_shell_command', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Monitor(npm *)'],
        }),
      );
      pm2.initialize();
      // Same command via shell tool should NOT be allowed by Monitor rule
      expect(
        await pm2.evaluate({
          toolName: 'run_shell_command',
          command: 'npm install',
        }),
      ).not.toBe('allow');
    });

    it('Bash approval also allows monitor (shell rules cover monitor)', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(npm *)'],
        }),
      );
      pm2.initialize();
      // Same command via monitor tool should be allowed by Bash rule
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: 'npm install',
        }),
      ).toBe('allow');
    });

    it('Bash deny rule blocks equivalent monitor command', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsDeny: ['Bash(rm *)'],
        }),
      );
      pm2.initialize();
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: 'rm -rf /',
        }),
      ).toBe('deny');
    });

    it('resolves default to allow for readonly monitor commands', async () => {
      const pm2 = new PermissionManager(makeConfig({}));
      pm2.initialize();
      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: 'echo hello',
        }),
      ).toBe('allow');
    });

    it('applies relative virtual file deny rules using the monitor cwd', async () => {
      // Mirrors the run_shell_command coverage above: when a monitor is
      // started with an explicit `directory` (forwarded as `cwd` via
      // buildPermissionCheckContext), relative-path deny rules must resolve
      // against that directory rather than the global config cwd. Without
      // this propagation a `Read(./secret.txt)` rule could be silently
      // bypassed by switching the monitor's working directory.
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsDeny: ['Read(./secret.txt)'],
          projectRoot: '/project',
          cwd: '/project',
        }),
      );
      pm2.initialize();

      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: 'cat ./secret.txt',
          cwd: '/project/subdir',
        }),
      ).toBe('deny');
    });

    it('resolves monitor virtual file allow rules relative to the explicit cwd', async () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Read(./subdir/secret.txt)'],
          projectRoot: '/project',
          cwd: '/project',
        }),
      );
      pm2.initialize();

      expect(
        await pm2.evaluate({
          toolName: 'monitor',
          command: 'cat ./secret.txt',
          cwd: '/project/subdir',
        }),
      ).toBe('allow');
    });
  });

  describe('compound command evaluation', () => {
    it('keeps Git after a directory change in the confirmation boundary', async () => {
      pm = new PermissionManager(
        makeConfig({ permissionsAllow: ['Bash(cd *)'] }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'cd /tmp && git status',
          cwd: process.cwd(),
        }),
      ).toBe('ask');
    });

    it('all sub-commands allowed → allow', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)', 'Bash(one-cmd *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'safe-cmd arg1 && one-cmd arg2',
        }),
      ).toBe('allow');
    });

    it('one sub-command unmatched (non-readonly) → ask (resolved from default)', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)'],
        }),
      );
      pm.initialize();
      // 'two-cmd' is unknown/non-readonly, so its default permission is 'ask'
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'safe-cmd && two-cmd',
        }),
      ).toBe('ask');
    });

    it('one sub-command denied → deny', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)'],
          permissionsDeny: ['Bash(evil-cmd *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'safe-cmd && evil-cmd rm-all',
        }),
      ).toBe('deny');
    });

    it('one sub-command ask + one allow → ask', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)'],
          permissionsAsk: ['Bash(npm *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git status && npm publish',
        }),
      ).toBe('ask');
    });

    it('pipe compound: all matched → allow', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(grep *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git log | grep fix',
        }),
      ).toBe('allow');
    });

    it('pipe compound: second unmatched but readonly → allow (resolved from default)', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)'],
        }),
      );
      pm.initialize();
      // 'grep' is a readonly command, so its default permission is 'allow'
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git log | grep fix',
        }),
      ).toBe('allow');
    });

    it('semicolon compound: deny in second → deny', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(echo *)'],
          permissionsDeny: ['Bash(rm *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'echo hello; rm -rf /',
        }),
      ).toBe('deny');
    });

    it('|| compound: all allowed → allow', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(echo *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git push || echo failed',
        }),
      ).toBe('allow');
    });

    it('operators inside quotes: treated as single command', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(echo *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: "echo 'a && b'",
        }),
      ).toBe('allow');
    });

    it('three-part compound: all must pass', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(npm *)', 'Bash(echo *)'],
        }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git add . && npm test && echo done',
        }),
      ).toBe('allow');
    });

    it('three-part compound: one unmatched (non-readonly) → ask (resolved from default)', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(echo *)'],
        }),
      );
      pm.initialize();
      // 'npm test' is not readonly, so its default permission is 'ask'
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git add . && npm test && echo done',
        }),
      ).toBe('ask');
    });

    it('isCommandAllowed also handles compound commands', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)', 'Bash(one-cmd *)'],
          permissionsDeny: ['Bash(evil-cmd *)'],
        }),
      );
      pm.initialize();
      expect(await pm.isCommandAllowed('safe-cmd a && one-cmd b')).toBe(
        'allow',
      );
      // 'unknown-cmd' is not readonly, resolves to 'ask'
      expect(await pm.isCommandAllowed('safe-cmd a && unknown-cmd')).toBe(
        'ask',
      );
      expect(await pm.isCommandAllowed('safe-cmd a && evil-cmd b')).toBe(
        'deny',
      );
    });
  });

  describe('file path evaluation', () => {
    beforeEach(() => {
      pm = new PermissionManager(
        makeConfig({
          permissionsDeny: ['Read(.env)', 'Edit(/src/generated/**)'],
          permissionsAllow: ['Read(/docs/**)'],
          projectRoot: '/project',
          cwd: '/project',
        }),
      );
      pm.initialize();
    });

    it('denies reading a denied file', async () => {
      expect(
        await pm.evaluate({ toolName: 'read_file', filePath: '/project/.env' }),
      ).toBe('deny');
    });

    it('denies editing in a denied directory', async () => {
      expect(
        await pm.evaluate({
          toolName: 'edit',
          filePath: '/project/src/generated/code.ts',
        }),
      ).toBe('deny');
    });

    it('denies an equivalent path containing parent traversal', async () => {
      expect(
        await pm.evaluate({
          toolName: 'edit',
          filePath: '/project/work/../src/generated/code.ts',
        }),
      ).toBe('deny');
    });

    it('canonicalizes restrictive rules without widening allow rules', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-permission-'));
      try {
        const protectedDir = path.join(root, 'protected');
        const link = path.join(root, 'link');
        fs.mkdirSync(protectedDir);
        fs.writeFileSync(path.join(protectedDir, 'file.txt'), 'protected');
        fs.symlinkSync(protectedDir, link, 'dir');
        const filePath = path.join(link, 'file.txt');

        const denyManager = new PermissionManager(
          makeConfig({
            permissionsDeny: ['Edit(/protected/**)'],
            projectRoot: root,
            cwd: root,
          }),
        );
        denyManager.initialize();
        expect(await denyManager.evaluate({ toolName: 'edit', filePath })).toBe(
          'deny',
        );

        const allowManager = new PermissionManager(
          makeConfig({
            permissionsAllow: ['Edit(/protected/**)'],
            projectRoot: root,
            cwd: root,
          }),
        );
        allowManager.initialize();
        expect(
          await allowManager.evaluate({ toolName: 'edit', filePath }),
        ).toBe('default');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('allows reading in an allowed directory', async () => {
      expect(
        await pm.evaluate({
          toolName: 'read_file',
          filePath: '/project/docs/readme.md',
        }),
      ).toBe('allow');
    });

    it('Read deny applies to grep_search too (meta-category)', async () => {
      expect(
        await pm.evaluate({
          toolName: 'grep_search',
          filePath: '/project/.env',
        }),
      ).toBe('deny');
    });

    it('returns default for unmatched path', async () => {
      expect(
        await pm.evaluate({
          toolName: 'read_file',
          filePath: '/project/src/index.ts',
        }),
      ).toBe('default');
    });
  });

  describe('WebFetch domain evaluation', () => {
    beforeEach(() => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['WebFetch(domain:github.com)'],
          permissionsDeny: ['WebFetch(domain:evil.com)'],
        }),
      );
      pm.initialize();
    });

    it('allows fetch to allowed domain', async () => {
      expect(
        await pm.evaluate({ toolName: 'web_fetch', domain: 'github.com' }),
      ).toBe('allow');
    });

    it('allows fetch to subdomain of allowed domain', async () => {
      expect(
        await pm.evaluate({ toolName: 'web_fetch', domain: 'api.github.com' }),
      ).toBe('allow');
    });

    it('denies fetch to denied domain', async () => {
      expect(
        await pm.evaluate({ toolName: 'web_fetch', domain: 'evil.com' }),
      ).toBe('deny');
    });

    it('returns default for unmatched domain', async () => {
      expect(
        await pm.evaluate({ toolName: 'web_fetch', domain: 'example.com' }),
      ).toBe('default');
    });
  });

  describe('isToolEnabled', () => {
    it('returns false for deny-ruled tools', async () => {
      pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['ShellTool'] }),
      );
      pm.initialize();
      expect(await pm.isToolEnabled('run_shell_command')).toBe(false);
    });

    it('returns true for tools with only specifier deny rules', async () => {
      pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['Bash(rm *)'] }),
      );
      pm.initialize();
      expect(await pm.isToolEnabled('run_shell_command')).toBe(true);
    });

    it('excludeTools passed via permissionsDeny disables the tool', async () => {
      pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['run_shell_command'] }),
      );
      pm.initialize();
      expect(await pm.isToolEnabled('run_shell_command')).toBe(false);
    });

    it('Edit deny rule disables notebook_edit', async () => {
      pm = new PermissionManager(makeConfig({ permissionsDeny: ['Edit'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('notebook_edit')).toBe(false);
    });

    it('coreTools allowlist: listed tool is enabled', async () => {
      pm = new PermissionManager(
        makeConfig({ coreTools: ['read_file', 'Bash'] }),
      );
      pm.initialize();
      expect(await pm.isToolEnabled('read_file')).toBe(true);
      expect(await pm.isToolEnabled('run_shell_command')).toBe(true); // Bash resolves to run_shell_command
    });

    it('coreTools allowlist: unlisted tool is disabled', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('read_file')).toBe(true);
      expect(await pm.isToolEnabled('zoom_image')).toBe(false);
      expect(await pm.isToolEnabled('run_shell_command')).toBe(false);
      expect(await pm.isToolEnabled('edit')).toBe(false);
      expect(await pm.isToolEnabled('notebook_edit')).toBe(false);
    });

    it('coreTools allowlist: ZoomImage alias enables zoom_image', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['ZoomImage'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('zoom_image')).toBe(true);
      expect(await pm.isToolEnabled('read_file')).toBe(false);
    });

    it('coreTools allowlist: NotebookEdit alias enables notebook_edit', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['NotebookEdit'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('notebook_edit')).toBe(true);
      expect(await pm.isToolEnabled('edit')).toBe(false);
    });

    it('coreTools allowlist gates loop_wakeup as a core scheduling tool', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('loop_wakeup')).toBe(false);

      pm = new PermissionManager(makeConfig({ coreTools: ['loop_wakeup'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('loop_wakeup')).toBe(true);
    });

    it('coreTools with specifier: tool-level check strips specifier', async () => {
      // "Bash(ls -l)" should register run_shell_command (specifier only affects runtime)
      pm = new PermissionManager(makeConfig({ coreTools: ['Bash(ls -l)'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('run_shell_command')).toBe(true);
      expect(await pm.isToolEnabled('read_file')).toBe(false);
    });

    it('empty coreTools: all tools enabled (no whitelist restriction)', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: [] }));
      pm.initialize();
      expect(await pm.isToolEnabled('read_file')).toBe(true);
      expect(await pm.isToolEnabled('run_shell_command')).toBe(true);
    });

    it('coreTools allowlist + deny rule: deny takes precedence for listed tools', async () => {
      pm = new PermissionManager(
        makeConfig({
          coreTools: ['read_file', 'Bash'],
          permissionsDeny: ['Bash'],
        }),
      );
      pm.initialize();
      expect(await pm.isToolEnabled('read_file')).toBe(true);
      expect(await pm.isToolEnabled('run_shell_command')).toBe(false); // in list but denied
    });

    it('permissionsAllow is not a whitelist — it never affects registration', async () => {
      // `permissions.allow` is pure auto-approval. Configuring it must not
      // remove, demote, or hide anything: that conflation is what silently
      // dropped `edit` / `write_file` for the #10075 reporter. Restricting
      // the eager tool surface is `tools.eager`'s job instead.
      pm = new PermissionManager(
        makeConfig({ permissionsAllow: ['read_file'] }),
      );
      pm.initialize();
      expect(await pm.isToolEnabled('read_file')).toBe(true);
      expect(await pm.isToolEnabled('run_shell_command')).toBe(true);
      expect(await pm.getToolRegistrationStatus('run_shell_command')).toBe(
        'registered',
      );
      expect(await pm.getToolRegistrationStatus('read_file')).toBe(
        'registered',
      );
    });

    it('permissions.allow never rescues a tool the coreTools allowlist excludes', async () => {
      // The #10075 decoupling must not revive in reverse: an allow rule
      // covering a core tool that `coreTools` omits cannot re-register it
      // — the legacy allowlist's hard `disabled` still wins.
      pm = new PermissionManager(
        makeConfig({
          coreTools: ['read_file'],
          permissionsAllow: ['edit'],
        }),
      );
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('edit')).toBe('disabled');
      expect(await pm.isToolEnabled('edit')).toBe(false);
      expect(await pm.getToolRegistrationStatus('read_file')).toBe(
        'registered',
      );
    });

    it('permissions.ask never demotes or removes a tool', async () => {
      // "Always require confirmation" must never become "tool
      // unavailable": ask rules are pure confirmation routing and have no
      // registration effect (#10075).
      pm = new PermissionManager(makeConfig({ permissionsAsk: ['Edit'] }));
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('edit')).toBe('registered');
      expect(await pm.isToolEnabled('edit')).toBe(true);
    });

    // Non-core tools bypass coreTools allowlist
    it('MCP tools bypass coreTools allowlist check', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      // MCP tools should be enabled even if not in coreTools
      expect(
        await pm.isToolEnabled('mcp__markitdown__convert_to_markdown'),
      ).toBe(true);
      expect(await pm.isToolEnabled('mcp__puppeteer__navigate')).toBe(true);
    });

    it('Skill tool bypasses coreTools allowlist check', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('skill')).toBe(true);
    });

    it('Agent tool bypasses coreTools allowlist check', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('agent')).toBe(true);
    });

    it('exit_plan_mode tool bypasses coreTools allowlist check', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('exit_plan_mode')).toBe(true);
    });

    it('ask_user_question tool bypasses coreTools allowlist check', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('ask_user_question')).toBe(true);
    });

    it('structured_output tool bypasses coreTools allowlist check', async () => {
      // structured_output is a synthetic tool that only exists when the
      // user opts into --json-schema. Treating it like agent/skill/
      // exit_plan_mode (bypass the coreTools allowlist) is the right
      // default: a run that combines `--json-schema X --core-tools read_file`
      // intends "restrict the model's pluggable toolbelt to read_file"
      // while still receiving the structured payload — silently dropping
      // structured_output here would leave --json-schema with no terminal
      // contract, so the run would loop until maxTurns.
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(await pm.isToolEnabled('structured_output')).toBe(true);
    });

    it('Non-core tools still respect deny rules', async () => {
      pm = new PermissionManager(
        makeConfig({
          coreTools: ['read_file'],
          permissionsDeny: ['mcp__markitdown'],
        }),
      );
      pm.initialize();
      // MCP tool should be disabled due to deny rule, even though it bypasses coreTools
      expect(
        await pm.isToolEnabled('mcp__markitdown__convert_to_markdown'),
      ).toBe(false);
      // Other MCP tools without deny rule should still be enabled
      expect(await pm.isToolEnabled('mcp__puppeteer__navigate')).toBe(true);
    });
  });

  describe('tools.eager allowlist (#9827, #10075)', () => {
    it('unlisted built-in tools are deferred, not disabled', async () => {
      // The reporter's configuration from #9827: only these tools ride in
      // the eager request; send_message / update_goal / loop_wakeup /
      // read_mcp_resource (whose large maxLength schemas break llama.cpp
      // grammar compilation) must NOT reach it. They are DEFERRED — still
      // registered and callable — rather than disabled, so they never
      // silently disappear (#10075).
      pm = new PermissionManager(
        makeConfig({
          eagerTools: [
            'ReadFile',
            'WriteFile',
            'Edit',
            'Grep',
            'Glob',
            'ListFiles',
            'Shell',
            'WebFetch',
          ],
        }),
      );
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(true);

      for (const covered of [
        'read_file',
        'write_file',
        'edit',
        'grep_search',
        'glob',
        'list_directory',
        'run_shell_command',
        'web_fetch',
      ]) {
        expect(await pm.getToolRegistrationStatus(covered)).toBe('registered');
      }

      for (const uncovered of [
        'send_message',
        'update_goal',
        'loop_wakeup',
        'read_mcp_resource',
      ]) {
        expect(await pm.getToolRegistrationStatus(uncovered)).toBe('deferred');
        // Deferred is not disabled: a call still flows through the normal
        // approval path rather than a permission error (#10075).
        expect(await pm.isToolEnabled(uncovered)).toBe(true);
      }
    });

    it('permissions.allow does NOT defer anything (#10075 regression)', async () => {
      // The regression this whole decoupling exists to prevent: configuring
      // permissions.allow purely for auto-approval must never reshape the
      // registry. Every built-in stays eagerly registered.
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['ReadFile', 'Grep'],
          permissionsAsk: ['WebFetch'],
        }),
      );
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(false);
      for (const name of [
        'read_file',
        'edit',
        'write_file',
        'send_message',
        'update_goal',
      ]) {
        expect(await pm.getToolRegistrationStatus(name)).toBe('registered');
      }
    });

    it('session-granted allow rules never change registration (#10075)', async () => {
      pm = new PermissionManager(makeConfig({ eagerTools: ['ReadFile'] }));
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('edit')).toBe('deferred');
      pm.addSessionAllowRule('Edit');
      // The grant auto-approves, but registration is a startup decision
      // driven solely by tools.eager.
      expect(await pm.getToolRegistrationStatus('edit')).toBe('deferred');
      expect(await pm.isToolEnabled('edit')).toBe(true);
    });

    it('an absent eager list leaves the allowlist inactive', async () => {
      // Only `undefined` means "no restriction" — see the empty-array case
      // below for the deliberate asymmetry.
      pm = new PermissionManager(makeConfig({ permissionsAllow: [] }));
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(false);
      expect(await pm.getToolRegistrationStatus('send_message')).toBe(
        'registered',
      );
    });

    it('specifier entries still cover their tool', async () => {
      // The eager gate is tool-level, not invocation-level, so a stray
      // specifier is stripped rather than making the entry match nothing.
      pm = new PermissionManager(
        makeConfig({ eagerTools: ['Bash(npm test)'] }),
      );
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('run_shell_command')).toBe(
        'registered',
      );
    });

    it('meta-category entries cover their tool families', async () => {
      pm = new PermissionManager(makeConfig({ eagerTools: ['Read'] }));
      pm.initialize();
      for (const name of ['read_file', 'grep_search', 'glob']) {
        expect(await pm.getToolRegistrationStatus(name)).toBe('registered');
      }
      expect(await pm.getToolRegistrationStatus('write_file')).toBe('deferred');
    });

    it('display-name entries resolve through aliases', async () => {
      pm = new PermissionManager(
        makeConfig({ eagerTools: ['SendMessage', 'UpdateGoal'] }),
      );
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('send_message')).toBe(
        'registered',
      );
      expect(await pm.getToolRegistrationStatus('update_goal')).toBe(
        'registered',
      );
      expect(await pm.getToolRegistrationStatus('loop_wakeup')).toBe(
        'deferred',
      );
    });

    it('an explicitly empty list is active and defers everything', async () => {
      // `[]` is an active allowlist that names nothing; `tools.core` differs
      // because its empty list is treated as unset.
      // This is the gentler answer for constrained-decoding backends: the
      // eager request carries almost no tool schemas, but every tool is
      // still registered and reachable via ToolSearch.
      pm = new PermissionManager(makeConfig({ eagerTools: [] }));
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      for (const name of ['read_file', 'edit', 'send_message']) {
        expect(await pm.getToolRegistrationStatus(name)).toBe('deferred');
        expect(await pm.isToolEnabled(name)).toBe(true);
      }
      // Exempt families still ride eagerly, so the session stays usable.
      expect(await pm.getToolRegistrationStatus('tool_search')).toBe(
        'registered',
      );
    });

    it('tolerates non-string entries instead of crashing initialize()', async () => {
      // Settings load performs no element-type validation (the schema
      // declares only `type: 'array'`), so a stray number/null must be
      // skipped rather than crash registry construction.
      pm = new PermissionManager(
        makeConfig({
          eagerTools: [null, 42, 'ReadFile'] as unknown as string[],
        }),
      );
      expect(() => pm.initialize()).not.toThrow();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      expect(await pm.getToolRegistrationStatus('read_file')).toBe(
        'registered',
      );
      expect(await pm.getToolRegistrationStatus('send_message')).toBe(
        'deferred',
      );
    });

    it('malformed entries drop out but still leave the list active', async () => {
      // Deferring more than intended is recoverable (ToolSearch still
      // reaches every tool); silently ignoring a configured list would
      // resend exactly the schemas the user asked to keep out (#9827).
      pm = new PermissionManager(
        makeConfig({ eagerTools: ['', '   ', 'Bash(unbalanced'] }),
      );
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      expect(await pm.getToolRegistrationStatus('send_message')).toBe(
        'deferred',
      );
      expect(await pm.isToolEnabled('send_message')).toBe(true);
    });

    it('logs the entries it dropped so a typo is not silent', async () => {
      // A misspelt entry narrows the eager set to nothing and defers the
      // whole toolset. That is recoverable, but it must not be invisible —
      // silent reshaping of the toolset is what #10075 reported. Pin the
      // console channel: the debug log file is off in default runs, where
      // this warning matters most.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pm = new PermissionManager(
        makeConfig({ eagerTools: ['ReadFile', '', 'Bash(unbalanced'] }),
      );
      pm.initialize();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('tools.eager: ignoring 2 unusable entries'),
      );
      // The valid entry survives — dropping is per-entry, not all-or-nothing.
      expect(await pm.getToolRegistrationStatus('read_file')).toBe(
        'registered',
      );
      warnSpy.mockRestore();
    });

    it('stays quiet when every entry parses', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pm = new PermissionManager(makeConfig({ eagerTools: ['ReadFile'] }));
      pm.initialize();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('tools.eager'),
      );
      warnSpy.mockRestore();
    });

    it('deny rules still win over eager membership', async () => {
      pm = new PermissionManager(
        makeConfig({
          eagerTools: ['ReadFile'],
          permissionsDeny: ['ReadFile'],
        }),
      );
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('read_file')).toBe('disabled');
      expect(await pm.isToolEnabled('read_file')).toBe(false);
    });

    it('deny via display name removes the tool from the registry', async () => {
      pm = new PermissionManager(
        makeConfig({ eagerTools: ['ReadFile'], permissionsDeny: ['Edit'] }),
      );
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('edit')).toBe('disabled');
    });

    it('combines with the coreTools allowlist', async () => {
      // coreTools keeps its documented hard-disable semantic; tools.eager
      // only demotes. A tool excluded by coreTools is disabled even when
      // the eager list names it.
      pm = new PermissionManager(
        makeConfig({ eagerTools: ['ReadFile', 'Edit'], coreTools: ['Edit'] }),
      );
      pm.initialize();
      expect(await pm.getToolRegistrationStatus('read_file')).toBe('disabled');
      expect(await pm.getToolRegistrationStatus('edit')).toBe('registered');
    });

    describe('exemptions stay eagerly registered', () => {
      const exempt: Array<[string, string]> = [
        ['MCP tools', 'mcp__markitdown__convert_to_markdown'],
        ['structured_output', 'structured_output'],
        ['plan-mode exit_plan_mode', 'exit_plan_mode'],
        ['plan-mode enter_plan_mode', 'enter_plan_mode'],
        ['plan-mode ask_user_question', 'ask_user_question'],
        ['task_stop', 'task_stop'],
        ['tool_search', 'tool_search'],
      ];

      it.each(exempt)('%s', async (_label, toolName) => {
        pm = new PermissionManager(makeConfig({ eagerTools: ['ReadFile'] }));
        pm.initialize();
        expect(await pm.getToolRegistrationStatus(toolName)).toBe('registered');
      });

      it('computer_use__* tools are exempt', async () => {
        // The generated cua-driver family has no alias entry,
        // meta-category, or wildcard rule form — its wire names churn on
        // every version bump — and every member is shouldDefer=true, so the
        // schemas never enter the eager request anyway.
        pm = new PermissionManager(makeConfig({ eagerTools: ['ReadFile'] }));
        pm.initialize();
        expect(
          await pm.getToolRegistrationStatus('computer_use__screenshot'),
        ).toBe('registered');
      });

      it.each(exempt)(
        'a whole-tool deny rule still wins over the %s exemption',
        async (_label, toolName) => {
          pm = new PermissionManager(
            makeConfig({
              eagerTools: ['ReadFile'],
              permissionsDeny: [toolName],
            }),
          );
          pm.initialize();
          expect(await pm.getToolRegistrationStatus(toolName)).toBe('disabled');
        },
      );
    });
  });

  describe('session rules', () => {
    beforeEach(() => {
      pm = new PermissionManager(makeConfig({}));
      pm.initialize();
    });

    it('addSessionAllowRule enables auto-approval for that pattern', async () => {
      // Use 'git commit' which is not readonly, so it resolves to 'ask' by default
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git commit',
        }),
      ).toBe('ask');
      pm.addSessionAllowRule('Bash(git *)');
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git commit',
        }),
      ).toBe('allow');
    });

    it('session deny rules override allow rules', async () => {
      pm.addSessionAllowRule('run_shell_command');
      pm.addSessionDenyRule('run_shell_command');
      expect(await pm.evaluate({ toolName: 'run_shell_command' })).toBe('deny');
    });

    it('a trust-gated allow rule is suspended while the folder is untrusted and restored with trust', async () => {
      // A project skill's `allowedTools` are repository-controlled: they
      // auto-approve only while the folder is trusted, re-read at every
      // decision, so a revocation mid-session takes effect at the next
      // tool call and a later grant of trust restores the rule — the
      // second side of the gate applied on the way in.
      let trusted = true;
      pm = new PermissionManager(
        makeConfig({ isTrustedFolder: () => trusted }),
      );
      pm.initialize();
      const call = { toolName: 'run_shell_command', command: 'git commit' };
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      pm.addSessionAllowRule('Bash(npm *)'); // the user's own grant
      expect(await pm.evaluate(call)).toBe('allow');

      trusted = false;
      expect(await pm.evaluate(call)).toBe('ask');
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'npm test',
        }),
      ).toBe('allow');
      // The effective-rules listing agrees with the decision.
      expect(pm.listRules().some((r) => r.rule.raw === 'Bash(git *)')).toBe(
        false,
      );

      trusted = true;
      expect(await pm.evaluate(call)).toBe('allow');
    });

    it('an ungated grant of the same raw rule outranks the repo grant — the dedup must not inherit the suspension', async () => {
      // A project skill grants `Bash(git *)` trust-gated; a user-level
      // skill later grants the identical raw. The dedup keeps one entry,
      // and it must carry the WIDER grant: the user's, which no folder
      // trust suspends. A gated re-arrival (skill reload) stays a skip.
      let trusted = true;
      pm = new PermissionManager(
        makeConfig({ isTrustedFolder: () => trusted }),
      );
      pm.initialize();
      const call = { toolName: 'run_shell_command', command: 'git commit' };
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      pm.addSessionAllowRule('Bash(git *)'); // the user-level skill's grant
      trusted = false;
      expect(await pm.evaluate(call)).toBe('allow');
      // Re-adding the gated rule (a reload cycle) neither duplicates nor
      // re-gates the entry the user now holds.
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      expect(await pm.evaluate(call)).toBe('allow');
      expect(
        (pm as unknown as { sessionRules: { allow: unknown[] } }).sessionRules
          .allow,
      ).toHaveLength(1);
    });

    it('a trust-gated rule stays in force when the config reports no trust probe', async () => {
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git commit',
        }),
      ).toBe('allow');
    });

    it('addSessionAllowRule deduplicates identical rules', () => {
      pm.addSessionAllowRule('Bash(git *)');
      pm.addSessionAllowRule('Bash(git *)');
      expect(
        (pm as unknown as { sessionRules: { allow: unknown[] } }).sessionRules
          .allow,
      ).toHaveLength(1);
    });

    it('malformed session allow rule is silently ignored', async () => {
      pm.addSessionAllowRule('Bash(git commit');
      // 'git commit' is not readonly, so default is 'ask'.
      // The malformed rule must not act as catch-all allow.
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git commit',
        }),
      ).toBe('ask');
    });

    it('malformed session deny rule is silently ignored', async () => {
      pm.addSessionDenyRule('Bash(rm -rf /)*');
      // Should NOT deny — the malformed rule must not act as catch-all
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git status',
        }),
      ).not.toBe('deny');
    });
  });

  describe('allowedTools via permissionsAllow', () => {
    it('allow rule auto-approves matching tools/commands', async () => {
      pm = new PermissionManager(
        makeConfig({ permissionsAllow: ['ReadFileTool', 'Bash(git *)'] }),
      );
      pm.initialize();
      expect(await pm.evaluate({ toolName: 'read_file' })).toBe('allow');
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git status',
        }),
      ).toBe('allow');
    });
  });

  describe('listRules', () => {
    it('returns all rules with type and scope', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['ReadFileTool'],
          permissionsDeny: ['ShellTool'],
        }),
      );
      pm.initialize();
      pm.addSessionAllowRule('Bash(git *)');

      const rules = pm.listRules();
      expect(rules.length).toBe(3);
      const sessionAllow = rules.find(
        (r) => r.scope === 'session' && r.type === 'allow',
      );
      expect(sessionAllow?.rule.toolName).toBe('run_shell_command');
    });

    it('excludes malformed rules from listing', async () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['ReadFileTool'],
          permissionsDeny: ['Bash(rm -rf /)*'],
        }),
      );
      pm.initialize();

      const rules = pm.listRules();
      // The malformed deny rule should be filtered out
      expect(rules.length).toBe(1);
      expect(rules[0]!.rule.toolName).toBe('read_file');
    });
  });

  describe('hasMatchingAskRule', () => {
    it('returns false when shell ask comes only from default permission fallback', async () => {
      pm = new PermissionManager(
        makeConfig({ permissionsAllow: ['Bash(git add *)'] }),
      );
      pm.initialize();

      expect(
        pm.hasMatchingAskRule({
          toolName: 'run_shell_command',
          command: 'git add file && git commit -m "msg"',
        }),
      ).toBe(false);
    });

    it('returns true when an explicit ask rule matches a shell sub-command', async () => {
      pm = new PermissionManager(
        makeConfig({ permissionsAsk: ['Bash(git commit *)'] }),
      );
      pm.initialize();

      expect(
        pm.hasMatchingAskRule({
          toolName: 'run_shell_command',
          command: 'git add file && git commit -m "msg"',
        }),
      ).toBe(true);
    });

    it('matches an ask rule through a symlinked path', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-permission-'));
      try {
        const protectedDir = path.join(root, 'protected');
        const link = path.join(root, 'link');
        fs.mkdirSync(protectedDir);
        fs.symlinkSync(protectedDir, link, 'dir');
        pm = new PermissionManager(
          makeConfig({
            permissionsAsk: ['Edit(/protected/**)'],
            projectRoot: root,
            cwd: root,
          }),
        );
        pm.initialize();

        expect(
          pm.hasMatchingAskRule({
            toolName: 'edit',
            filePath: path.join(link, 'file.txt'),
          }),
        ).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

// ─── getRuleDisplayName ──────────────────────────────────────────────────────

describe('getRuleDisplayName', () => {
  it('maps read tools to "Read" meta-category', async () => {
    expect(getRuleDisplayName('read_file')).toBe('Read');
    expect(getRuleDisplayName('zoom_image')).toBe('Read');
    expect(getRuleDisplayName('grep_search')).toBe('Read');
    expect(getRuleDisplayName('glob')).toBe('Read');
    expect(getRuleDisplayName('list_directory')).toBe('Read');
  });

  it('maps edit tools to "Edit" meta-category', async () => {
    expect(getRuleDisplayName('edit')).toBe('Edit');
    expect(getRuleDisplayName('write_file')).toBe('Edit');
    expect(getRuleDisplayName('notebook_edit')).toBe('Edit');
  });

  it('maps shell to "Bash"', async () => {
    expect(getRuleDisplayName('run_shell_command')).toBe('Bash');
  });

  it('maps web_fetch to "WebFetch"', async () => {
    expect(getRuleDisplayName('web_fetch')).toBe('WebFetch');
  });

  it('maps agent to "Agent" and skill to "Skill"', async () => {
    expect(getRuleDisplayName('agent')).toBe('Agent');
    expect(getRuleDisplayName('skill')).toBe('Skill');
  });

  it('returns the canonical name for unknown tools (e.g. MCP)', async () => {
    expect(getRuleDisplayName('mcp__server__tool')).toBe('mcp__server__tool');
  });
});

// ─── buildPermissionRules ────────────────────────────────────────────────────

describe('buildPermissionRules', () => {
  describe('path-based tools (Read/Edit)', () => {
    it('generates Read rule scoped to parent directory for read_file', async () => {
      const rules = buildPermissionRules({
        toolName: 'read_file',
        filePath: '/Users/alice/.secrets',
      });
      // read_file is file-targeted → dirname gives /Users/alice, plus /** glob
      expect(rules).toEqual(['Read(//Users/alice/**)']);
    });

    it('generates Read rule scoped to parent directory for zoom_image', async () => {
      const rules = buildPermissionRules({
        toolName: 'zoom_image',
        filePath: '/Users/alice/chart.png',
      });
      expect(rules).toEqual(['Read(//Users/alice/**)']);
    });

    it('generates Read rule with directory as-is for grep_search', async () => {
      const rules = buildPermissionRules({
        toolName: 'grep_search',
        filePath: '/external/dir',
      });
      // grep_search is directory-targeted → path used as-is, plus /** glob
      expect(rules).toEqual(['Read(//external/dir/**)']);
    });

    it('generates Read rule with directory as-is for glob', async () => {
      const rules = buildPermissionRules({
        toolName: 'glob',
        filePath: '/tmp/data',
      });
      expect(rules).toEqual(['Read(//tmp/data/**)']);
    });

    it('generates Read rule with directory as-is for list_directory', async () => {
      const rules = buildPermissionRules({
        toolName: 'list_directory',
        filePath: '/home/user/docs',
      });
      expect(rules).toEqual(['Read(//home/user/docs/**)']);
    });

    it('generates Edit rule scoped to parent directory for edit', async () => {
      const rules = buildPermissionRules({
        toolName: 'edit',
        filePath: '/external/file.ts',
      });
      // edit is file-targeted → dirname gives /external, plus /** glob
      expect(rules).toEqual(['Edit(//external/**)']);
    });

    it('generates Edit rule scoped to parent directory for write_file', async () => {
      const rules = buildPermissionRules({
        toolName: 'write_file',
        filePath: '/tmp/output.txt',
      });
      expect(rules).toEqual(['Edit(//tmp/**)']);
    });

    it('generates Edit rule scoped to parent directory for notebook_edit', async () => {
      const rules = buildPermissionRules({
        toolName: 'notebook_edit',
        filePath: '/tmp/analysis.ipynb',
      });
      expect(rules).toEqual(['Edit(//tmp/**)']);
    });

    it('falls back to bare display name when no filePath', async () => {
      const rules = buildPermissionRules({ toolName: 'read_file' });
      expect(rules).toEqual(['Read']);
    });
  });

  describe('generated rules round-trip through parseRule and matchesRule', () => {
    it('Read rule for external file covers the containing directory', async () => {
      const rules = buildPermissionRules({
        toolName: 'read_file',
        filePath: '/Users/alice/.secrets',
      });
      expect(rules).toHaveLength(1);
      expect(rules[0]).toBe('Read(//Users/alice/**)');

      const parsed = parseRule(rules[0]!);
      expect(parsed.toolName).toBe('read_file');
      expect(parsed.specifier).toBe('//Users/alice/**');
      expect(parsed.specifierKind).toBe('path');

      // Should match the original file (inside the directory)
      expect(
        matchesRule(
          parsed,
          'read_file',
          undefined,
          '/Users/alice/.secrets',
          undefined,
          { projectRoot: '/some/project', cwd: '/some/project' },
        ),
      ).toBe(true);

      // Should also match other files in the same directory
      expect(
        matchesRule(
          parsed,
          'read_file',
          undefined,
          '/Users/alice/.other',
          undefined,
          { projectRoot: '/some/project', cwd: '/some/project' },
        ),
      ).toBe(true);

      // Should NOT match files in a different directory
      expect(
        matchesRule(
          parsed,
          'read_file',
          undefined,
          '/Users/bob/.secrets',
          undefined,
          { projectRoot: '/some/project', cwd: '/some/project' },
        ),
      ).toBe(false);
    });

    it('Read rule also matches other read-family tools on the same path', async () => {
      const rules = buildPermissionRules({
        toolName: 'grep_search',
        filePath: '/external/dir',
      });
      const parsed = parseRule(rules[0]!);

      // Should match grep_search on a file inside the dir
      expect(
        matchesRule(
          parsed,
          'grep_search',
          undefined,
          '/external/dir/file.txt',
          undefined,
          { projectRoot: '/p', cwd: '/p' },
        ),
      ).toBe(true);

      // Should also match read_file (Read meta-category)
      expect(
        matchesRule(
          parsed,
          'read_file',
          undefined,
          '/external/dir/other.ts',
          undefined,
          { projectRoot: '/p', cwd: '/p' },
        ),
      ).toBe(true);
    });
  });

  describe('domain-based tools', () => {
    it('generates WebFetch rule with domain specifier', async () => {
      const rules = buildPermissionRules({
        toolName: 'web_fetch',
        domain: 'example.com',
      });
      expect(rules).toEqual(['WebFetch(example.com)']);
    });

    it('falls back to bare display name when no domain', async () => {
      const rules = buildPermissionRules({ toolName: 'web_fetch' });
      expect(rules).toEqual(['WebFetch']);
    });
  });

  describe('command-based tools', () => {
    it('generates Bash rule with command specifier', async () => {
      const rules = buildPermissionRules({
        toolName: 'run_shell_command',
        command: 'git status',
      });
      expect(rules).toEqual(['Bash(git status)']);
    });

    it('falls back to bare display name when no command', async () => {
      const rules = buildPermissionRules({ toolName: 'run_shell_command' });
      expect(rules).toEqual(['Bash']);
    });

    it('generates Monitor rule with command specifier', async () => {
      const rules = buildPermissionRules({
        toolName: 'monitor',
        command: 'tail -f /var/log/app.log',
      });
      expect(rules).toEqual(['Monitor(tail -f /var/log/app.log)']);
    });

    it('falls back to bare Monitor display name when no command', async () => {
      const rules = buildPermissionRules({ toolName: 'monitor' });
      expect(rules).toEqual(['Monitor']);
    });
  });

  describe('literal-specifier tools', () => {
    it('generates Skill rule with specifier', async () => {
      const rules = buildPermissionRules({
        toolName: 'skill',
        specifier: 'Explore',
      });
      expect(rules).toEqual(['Skill(Explore)']);
    });

    it('generates Agent rule with specifier', async () => {
      const rules = buildPermissionRules({
        toolName: 'agent',
        specifier: 'research',
      });
      expect(rules).toEqual(['Agent(research)']);
    });

    it('falls back to bare display name when no specifier', async () => {
      const rules = buildPermissionRules({ toolName: 'skill' });
      expect(rules).toEqual(['Skill']);
    });
  });

  describe('unknown / MCP tools', () => {
    it('uses the canonical name as display for MCP tools', async () => {
      const rules = buildPermissionRules({
        toolName: 'mcp__puppeteer__navigate',
      });
      expect(rules).toEqual(['mcp__puppeteer__navigate']);
    });
  });

  describe('with toolParams (stable param serialization)', () => {
    it('serializes stable params (model, subagent_type) for Agent', async () => {
      const rules = buildPermissionRules({
        toolName: 'agent',
        specifier: 'coder',
        toolParams: {
          subagent_type: 'coder',
          model: 'opus',
          prompt: 'Fix the bug',
        },
      });
      // prompt is not serialized (not in stableParamKeys)
      // subagent_type is skipped because it matches specifier
      expect(rules).toEqual(['Agent(coder,model:opus)']);
    });

    it('does not serialize volatile params like prompt or query', async () => {
      const rules = buildPermissionRules({
        toolName: 'agent',
        toolParams: {
          model: 'sonnet',
          prompt: 'Some long prompt that should not be persisted',
        },
      });
      expect(rules).toEqual(['Agent(model:sonnet)']);
      // Verify prompt is NOT in the rule string
      expect(rules[0]).not.toContain('prompt');
    });

    it('does not serialize sensitive params (no secret leakage)', async () => {
      const rules = buildPermissionRules({
        toolName: 'agent',
        toolParams: {
          model: 'opus',
          api_key: 'sk-secret-123',
          token: 'bearer-xyz',
        },
      });
      // api_key and token are not in stableParamKeys, so not serialized
      expect(rules).toEqual(['Agent(model:opus)']);
      expect(rules[0]).not.toContain('secret');
      expect(rules[0]).not.toContain('bearer');
    });

    it('generates bare MCP tool name without specifier or params', async () => {
      const rules = buildPermissionRules({
        toolName: 'mcp__chrome__navigate',
        toolParams: {
          server_name: 'chrome',
          url: 'https://example.com',
        },
      });
      // MCP tools get bare name — specifier rejection in matchesRule
      // would make any specifier-carrying rule a dead entry
      expect(rules).toEqual(['mcp__chrome__navigate']);
    });

    it('round-trips Agent rule with stable params through parseRule', async () => {
      const rules = buildPermissionRules({
        toolName: 'agent',
        specifier: 'coder',
        toolParams: { subagent_type: 'coder', model: 'opus' },
      });
      expect(rules).toEqual(['Agent(coder,model:opus)']);

      // Parse the generated rule back
      const parsed = parseRule(rules[0]!);
      expect(parsed.toolName).toBe('agent');
      expect(parsed.specifier).toBe('coder');
      expect(parsed.toolParamMatchers).toEqual([
        { key: 'model', valuePattern: 'opus' },
      ]);
    });

    it('handles number values in toolParams', async () => {
      const rules = buildPermissionRules({
        toolName: 'agent',
        toolParams: { model: 'opus', count: 42 },
      });
      // count is not in stableParamKeys, so not serialized
      expect(rules).toEqual(['Agent(model:opus)']);
    });
  });
});

// ─── buildHumanReadableRuleLabel ─────────────────────────────────────────────

describe('buildHumanReadableRuleLabel', () => {
  it('returns empty string for empty rules array', () => {
    expect(buildHumanReadableRuleLabel([])).toBe('');
  });

  it('converts bare Read rule to "read files"', () => {
    expect(buildHumanReadableRuleLabel(['Read'])).toBe('read files');
  });

  it('converts bare Bash rule to "run commands"', () => {
    expect(buildHumanReadableRuleLabel(['Bash'])).toBe('run commands');
  });

  it('converts bare Monitor rule to "monitor commands"', () => {
    expect(buildHumanReadableRuleLabel(['Monitor'])).toBe('monitor commands');
  });

  it('converts Read with absolute path specifier', () => {
    const label = buildHumanReadableRuleLabel(['Read(//Users/mochi/.qwen/**)']);
    expect(label).toBe('read files in /Users/mochi/.qwen/');
  });

  it('converts Read with relative path specifier', () => {
    const label = buildHumanReadableRuleLabel(['Read(/src/**)']);
    expect(label).toBe('read files in /src/');
  });

  it('converts Edit with path specifier', () => {
    const label = buildHumanReadableRuleLabel(['Edit(//tmp/**)']);
    expect(label).toBe('edit files in /tmp/');
  });

  it('converts Bash with command specifier', () => {
    const label = buildHumanReadableRuleLabel(['Bash(git *)']);
    expect(label).toBe("run 'git *' commands");
  });

  it('converts Monitor with command specifier', () => {
    const label = buildHumanReadableRuleLabel(['Monitor(tail -f *)']);
    expect(label).toBe("monitor 'tail -f *' commands");
  });

  it('converts WebFetch with domain specifier', () => {
    const label = buildHumanReadableRuleLabel(['WebFetch(github.com)']);
    expect(label).toBe('fetch from github.com');
  });

  it('converts Skill with literal specifier', () => {
    const label = buildHumanReadableRuleLabel(['Skill(Explore)']);
    expect(label).toBe('use skill "Explore"');
  });

  it('converts Agent with literal specifier', () => {
    const label = buildHumanReadableRuleLabel(['Agent(research)']);
    expect(label).toBe('use agent "research"');
  });

  it('joins multiple rules with commas', () => {
    const label = buildHumanReadableRuleLabel([
      'Read(//Users/alice/**)',
      'Bash(npm *)',
    ]);
    expect(label).toBe("read files in /Users/alice/, run 'npm *' commands");
  });

  it('handles unknown display names gracefully', () => {
    const label = buildHumanReadableRuleLabel(['mcp__server__tool']);
    expect(label).toBe('mcp__server__tool');
  });

  it('handles unknown display name with specifier', () => {
    const label = buildHumanReadableRuleLabel(['UnknownCategory(someValue)']);
    expect(label).toBe('unknowncategory "someValue"');
  });

  it('cleans path with /* suffix', () => {
    const label = buildHumanReadableRuleLabel(['Read(//home/user/docs/*)']);
    expect(label).toBe('read files in /home/user/docs/');
  });

  it('round-trips from buildPermissionRules for file tool', () => {
    const rules = buildPermissionRules({
      toolName: 'read_file',
      filePath: '/Users/alice/.secrets',
    });
    const label = buildHumanReadableRuleLabel(rules);
    expect(label).toBe('read files in /Users/alice/');
  });

  it('round-trips from buildPermissionRules for shell command', () => {
    const rules = buildPermissionRules({
      toolName: 'run_shell_command',
      command: 'git status',
    });
    const label = buildHumanReadableRuleLabel(rules);
    expect(label).toBe("run 'git status' commands");
  });

  it('round-trips from buildPermissionRules for web fetch', () => {
    const rules = buildPermissionRules({
      toolName: 'web_fetch',
      domain: 'example.com',
    });
    const label = buildHumanReadableRuleLabel(rules);
    expect(label).toBe('fetch from example.com');
  });
});

// ─── PermissionManager.findMatchingDenyRule ──────────────────────────────────

describe('PermissionManager.findMatchingDenyRule', () => {
  it('returns the raw deny rule string when context matches', () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['Bash(rm *)'] }),
    );
    pm.initialize();

    const result = pm.findMatchingDenyRule({
      toolName: 'run_shell_command',
      command: 'rm -rf /tmp/foo',
    });
    expect(result).toBe('Bash(rm *)');
  });

  it('returns undefined when no deny rule matches', () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['Bash(rm *)'] }),
    );
    pm.initialize();

    const result = pm.findMatchingDenyRule({
      toolName: 'run_shell_command',
      command: 'git status',
    });
    expect(result).toBeUndefined();
  });

  it('matches session deny rules', () => {
    const pm = new PermissionManager(makeConfig());
    pm.initialize();
    pm.addSessionDenyRule('Read(//secret/**)');

    const result = pm.findMatchingDenyRule({
      toolName: 'read_file',
      filePath: '/secret/key.pem',
    });
    expect(result).toBe('Read(//secret/**)');
  });

  it('returns undefined for non-denied tool', () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['ShellTool'] }),
    );
    pm.initialize();

    const result = pm.findMatchingDenyRule({ toolName: 'read_file' });
    expect(result).toBeUndefined();
  });

  it('matches bare tool deny rule', () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['ShellTool'] }),
    );
    pm.initialize();

    const result = pm.findMatchingDenyRule({
      toolName: 'run_shell_command',
      command: 'echo hello',
    });
    // rule.raw preserves the original rule string as written in config
    expect(result).toBe('ShellTool');
  });

  it('matches a deny rule through a symlinked path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-permission-'));
    try {
      const protectedDir = path.join(root, 'protected');
      const link = path.join(root, 'link');
      fs.mkdirSync(protectedDir);
      fs.symlinkSync(protectedDir, link, 'dir');
      const pm = new PermissionManager(
        makeConfig({
          permissionsDeny: ['Edit(/protected/**)'],
          projectRoot: root,
          cwd: root,
        }),
      );
      pm.initialize();

      expect(
        pm.findMatchingDenyRule({
          toolName: 'edit',
          filePath: path.join(link, 'file.txt'),
        }),
      ).toBe('Edit(/protected/**)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── AUTO mode dangerous-rule stash ────────────────────────────────────

describe('PermissionManager — strip/restore for AUTO mode', () => {
  it('strips Bash interpreter wildcards and stashes them', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Bash(python:*)', 'Bash(git status)'],
      }),
    );
    pm.initialize();

    const stash = pm.stripDangerousRulesForAutoMode();
    expect(stash.persistent).toHaveLength(1);
    expect(stash.persistent[0].raw).toBe('Bash(python:*)');

    // The safe rule remains: git status still auto-allowed.
    return expect(
      pm.evaluate({ toolName: 'run_shell_command', command: 'git status' }),
    ).resolves.toBe('allow');
  });

  it('strips bare tool-level Bash allow', async () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['Bash'] }),
    );
    pm.initialize();

    // Before strip: any Bash command is auto-allowed.
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: 'rm -rf /',
      }),
    ).toBe('allow');

    pm.stripDangerousRulesForAutoMode();

    // After strip: Bash falls through to default (which AST analysis turns
    // into ask for non-readonly commands).
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: 'rm -rf /',
      }),
    ).not.toBe('allow');
  });

  it('strips Agent / Skill any-allow rules', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Agent(coder)', 'Skill(pdf)', 'ReadFileTool'],
      }),
    );
    pm.initialize();

    const stash = pm.stripDangerousRulesForAutoMode();
    expect(stash.persistent).toHaveLength(2);
    expect(stash.persistent.map((r) => r.toolName).sort()).toEqual(
      ['agent', 'skill'].sort(),
    );
    // Safe Read rule untouched.
    expect(pm.getAllowRawStrings()).toEqual(['ReadFileTool']);
  });

  it('is idempotent — second strip returns the same stash without re-removal', () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['Bash(python:*)'] }),
    );
    pm.initialize();

    const first = pm.stripDangerousRulesForAutoMode();
    const second = pm.stripDangerousRulesForAutoMode();
    expect(first).toBe(second);
    expect(pm.getAllowRawStrings()).toEqual([]);
  });

  it('restoreDangerousRules reattaches stripped rules to their original scope', async () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['Bash(python:*)'] }),
    );
    pm.initialize();

    pm.stripDangerousRulesForAutoMode();
    expect(pm.getAllowRawStrings()).toEqual([]);

    pm.restoreDangerousRules();
    expect(pm.getAllowRawStrings()).toEqual(['Bash(python:*)']);

    // And the rule works again: python anything is auto-allowed.
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: 'python foo.py',
      }),
    ).toBe('allow');
  });

  it('never strips deny rules — user intent for deny is honored', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['Bash', 'Agent'],
        permissionsAllow: ['Bash(git log)'],
      }),
    );
    pm.initialize();

    pm.stripDangerousRulesForAutoMode();
    // Bash deny still applies — no allow rule can override it after strip.
    return expect(
      pm.evaluate({ toolName: 'run_shell_command', command: 'git log' }),
    ).resolves.toBe('deny');
  });

  it('auto-strips on initialize when approvalMode is "auto"', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Bash(python:*)'],
        approvalMode: 'auto',
      }),
    );
    pm.initialize();
    expect(pm.getAllowRawStrings()).toEqual([]);
    expect(pm.getStrippedDangerousRules()?.persistent).toHaveLength(1);
  });

  it('does NOT auto-strip when approvalMode is the default', () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['Bash(python:*)'] }),
    );
    pm.initialize();
    expect(pm.getAllowRawStrings()).toEqual(['Bash(python:*)']);
    expect(pm.getStrippedDangerousRules()).toBeUndefined();
  });
});

// ─── Compound shell + cd + wrapper → virtual-op rule matching ───────────────
//
// Regression coverage for compound shell writes reaching protected paths
// through `cd` and shell wrappers.

describe('PermissionManager — compound shell write attribution', () => {
  it('deny rule matches a write after `cd` into a subdir', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['WriteFileTool(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: "cd .qwen && echo '{}' > settings.json",
        cwd: '/repo',
      }),
    ).toBe('deny');
  });

  it('deny rule matches a write through a `bash -lc` wrapper after `cd`', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['WriteFileTool(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: "cd .qwen && bash -lc 'echo {} > settings.json'",
        cwd: '/repo',
      }),
    ).toBe('deny');
  });

  it('ask rule matches a write through nested shell wrappers', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAsk: ['WriteFileTool(.mcp.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: 'bash -lc "sh -c \'echo hi > .mcp.json\'"',
        cwd: '/repo',
      }),
    ).toBe('ask');
  });

  it('allow rule on the same shell command does NOT downgrade a virtual-op deny', async () => {
    // The Bash allow rule covers the literal command, but the cross-command
    // virtual-op pass surfaces the write target and the deny rule on
    // .qwen/settings.json escalates the verdict. Allow + virtual-op deny
    // → deny, matching the "deny > ask > allow" priority.
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Bash(*)'],
        permissionsDeny: ['WriteFileTool(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: "cd .qwen && bash -lc 'echo {} > settings.json'",
        cwd: '/repo',
      }),
    ).toBe('deny');
  });

  it('ordinary writes after `cd` into project subdirs stay unmatched by self-mod rules', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['WriteFileTool(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      pm.hasRelevantRules({
        toolName: 'run_shell_command',
        command: "cd src && bash -lc 'echo ok > generated.txt'",
        cwd: '/repo',
      }),
    ).toBe(false);
  });

  it('does not treat canonical-only allow matches as relevant', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-permission-'));
    try {
      const allowedDir = path.join(root, 'allowed');
      const link = path.join(root, 'link');
      fs.mkdirSync(allowedDir);
      fs.writeFileSync(path.join(allowedDir, 'file.txt'), 'allowed');
      fs.symlinkSync(allowedDir, link, 'dir');

      const pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Edit(/allowed/**)'],
          cwd: root,
          projectRoot: root,
        }),
      );
      pm.initialize();

      expect(
        pm.hasRelevantRules({
          toolName: 'edit',
          filePath: path.join(link, 'file.txt'),
        }),
      ).toBe(false);
      expect(
        pm.hasRelevantRules({
          toolName: 'run_shell_command',
          command: `echo allowed > ${path.join(link, 'file.txt')}`,
          cwd: root,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('hasRelevantRules sees protected writes after sibling shell-wrapper segments', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['WriteFileTool(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      pm.hasRelevantRules({
        toolName: 'run_shell_command',
        command: "bash -lc 'echo ok' && echo hi > .qwen/settings.json",
        cwd: '/repo',
      }),
    ).toBe(true);
  });

  it('hasRelevantRules sees protected writes after `cd` before compound recursion', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['Write(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      pm.hasRelevantRules({
        toolName: 'run_shell_command',
        command: "cd .qwen && bash -lc 'echo {} > settings.json'",
        cwd: '/repo',
      }),
    ).toBe(true);
  });

  it('hasMatchingAskRule sees writes after `cd` into a subdir', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAsk: ['WriteFileTool(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      pm.hasMatchingAskRule({
        toolName: 'run_shell_command',
        command: "cd .qwen && bash -lc 'echo {} > settings.json'",
        cwd: '/repo',
      }),
    ).toBe(true);
  });

  it('escalates dynamic-cd writes when path-specific deny rules may apply', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Bash(*)'],
        permissionsDeny: ['WriteFileTool(.qwen/settings.json)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();
    expect(
      pm.hasRelevantRules({
        toolName: 'run_shell_command',
        command: 'cd "$TARGET" && echo hi > ../settings.json',
        cwd: '/repo',
      }),
    ).toBe(true);
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: 'cd "$TARGET" && echo hi > ../settings.json',
        cwd: '/repo',
      }),
    ).toBe('ask');
  });

  it('preserves wildcard deny rules for dynamic-cd writes', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Bash(*)'],
        permissionsDeny: ['WriteFileTool(*)'],
        cwd: '/repo',
        projectRoot: '/repo',
      }),
    );
    pm.initialize();

    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: 'cd "$TARGET" && echo hi > settings.json',
        cwd: '/repo',
      }),
    ).toBe('deny');
  });
});

// ─── PermissionManager integration tests with toolParams ─────────────────────

describe('PermissionManager — toolParams end-to-end', () => {
  it('evaluate respects allow rule with param matcher', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Agent(coder,model:opus)'],
      }),
    );
    pm.initialize();

    expect(
      await pm.evaluate({
        toolName: 'agent',
        specifier: 'coder',
        toolParams: { subagent_type: 'coder', model: 'opus' },
      }),
    ).toBe('allow');
  });

  it('evaluate denies when param matcher does not match', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAllow: ['Agent(coder,model:opus)'],
      }),
    );
    pm.initialize();

    expect(
      await pm.evaluate({
        toolName: 'agent',
        specifier: 'coder',
        toolParams: { subagent_type: 'coder', model: 'sonnet' },
      }),
    ).not.toBe('allow');
  });

  it('findMatchingDenyRule matches deny rule with param matcher', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['Agent(model:restricted)'],
      }),
    );
    pm.initialize();

    expect(
      pm.findMatchingDenyRule({
        toolName: 'agent',
        toolParams: { model: 'restricted' },
      }),
    ).toBe('Agent(model:restricted)');
  });

  it('findMatchingDenyRule returns undefined when param does not match', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['Agent(model:restricted)'],
      }),
    );
    pm.initialize();

    expect(
      pm.findMatchingDenyRule({
        toolName: 'agent',
        toolParams: { model: 'opus' },
      }),
    ).toBeUndefined();
  });

  it('hasRelevantRules returns true when param matcher rule exists', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAsk: ['Agent(model:opus)'],
      }),
    );
    pm.initialize();

    expect(
      pm.hasRelevantRules({
        toolName: 'agent',
        toolParams: { model: 'opus' },
      }),
    ).toBe(true);
  });

  it('hasMatchingAskRule returns true when param matcher ask rule matches', () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsAsk: ['Agent(model:opus)'],
      }),
    );
    pm.initialize();

    expect(
      pm.hasMatchingAskRule({
        toolName: 'agent',
        toolParams: { model: 'opus' },
      }),
    ).toBe(true);
  });

  it('case-insensitive param matching: deny rule blocks different casing', async () => {
    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['Agent(model:Sonnet)'],
      }),
    );
    pm.initialize();

    expect(
      await pm.evaluate({
        toolName: 'agent',
        toolParams: { model: 'sonnet' },
      }),
    ).toBe('deny');
  });
});

// ─── evaluateParamMatchers type guard tests ──────────────────────────────────

describe('matchesRule — param matcher type guards', () => {
  it('rejects boolean param values', () => {
    const rule = parseRule('Agent(model:*)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { model: true },
      ),
    ).toBe(false);
  });

  it('rejects null param values', () => {
    const rule = parseRule('Agent(model:*)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { model: null },
      ),
    ).toBe(false);
  });

  it('rejects undefined param values', () => {
    const rule = parseRule('Agent(model:*)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { model: undefined },
      ),
    ).toBe(false);
  });

  it('rejects object param values', () => {
    const rule = parseRule('Agent(model:*)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { model: { nested: 'opus' } },
      ),
    ).toBe(false);
  });

  it('accepts number param values via coercion', () => {
    const rule = parseRule('Agent(count:42)');
    expect(
      matchesRule(
        rule,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { count: 42 },
      ),
    ).toBe(true);
  });
});
