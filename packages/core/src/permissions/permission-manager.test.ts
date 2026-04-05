/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
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
  buildPermissionRules,
  getRuleDisplayName,
  buildHumanReadableRuleLabel,
} from './rule-parser.js';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';

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

  it('returns unknown names unchanged', async () => {
    expect(resolveToolName('my_mcp_tool')).toBe('my_mcp_tool');
    expect(resolveToolName('mcp__server__tool')).toBe('mcp__server__tool');
  });
});

// ─── getSpecifierKind ────────────────────────────────────────────────────────

describe('getSpecifierKind', () => {
  it('returns "command" for shell tools', async () => {
    expect(getSpecifierKind('run_shell_command')).toBe('command');
  });

  it('returns "path" for file read/edit tools', async () => {
    expect(getSpecifierKind('read_file')).toBe('path');
    expect(getSpecifierKind('edit')).toBe('path');
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

  it('"Read" (read_file) covers grep_search, glob, list_directory', async () => {
    expect(toolMatchesRuleToolName('read_file', 'grep_search')).toBe(true);
    expect(toolMatchesRuleToolName('read_file', 'glob')).toBe(true);
    expect(toolMatchesRuleToolName('read_file', 'list_directory')).toBe(true);
  });

  it('"Edit" (edit) covers write_file', async () => {
    expect(toolMatchesRuleToolName('edit', 'write_file')).toBe(true);
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

  it('parses Bash alias (Claude Code compat)', async () => {
    const r = parseRule('Bash');
    expect(r.toolName).toBe('run_shell_command');
  });

  it('parses a shell tool with a specifier', async () => {
    const r = parseRule('Bash(git *)');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBe('git *');
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
    expect(r.specifier).toBeUndefined();
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
    expect(splitCompoundCommand('echo a \\&& b')).toEqual(['echo a \\&& b']);
  });

  it('trims whitespace around sub-commands', async () => {
    expect(splitCompoundCommand('  git status  &&  rm -rf /  ')).toEqual([
      'git status',
      'rm -rf /',
    ]);
  });

  it('splits on newline', async () => {
    expect(splitCompoundCommand('export FOO=bar\npython3 script.py')).toEqual([
      'export FOO=bar',
      'python3 script.py',
    ]);
  });

  it('does not split on newline inside quotes', async () => {
    expect(splitCompoundCommand('echo "line1\nline2"')).toEqual([
      'echo "line1\nline2"',
    ]);
  });

  it('does not split heredoc bodies on newlines', async () => {
    const command = ["python - <<'PY'", 'print(1)', 'PY', 'echo done'].join(
      '\n',
    );

    expect(splitCompoundCommand(command)).toEqual([
      ["python - <<'PY'", 'print(1)', 'PY'].join('\n'),
      'echo done',
    ]);
  });

  it('keeps heredoc bodies attached to the command that declared them', async () => {
    const command = ["cat <<'EOF' | grep foo", 'foo', 'EOF'].join('\n');

    expect(splitCompoundCommand(command)).toEqual([
      ["cat <<'EOF'", 'foo', 'EOF'].join('\n'),
      'grep foo',
    ]);
  });

  it('does not treat comment text containing << as a heredoc', async () => {
    const command = ["# <<'EOF'", 'rm -rf /', 'EOF', 'echo done'].join('\n');

    expect(splitCompoundCommand(command)).toEqual([
      "# <<'EOF'",
      'rm -rf /',
      'EOF',
      'echo done',
    ]);
  });

  it('does not treat arithmetic shifts as heredoc operators', async () => {
    const command = ['echo $((1 << 2))', 'echo done'].join('\n');

    expect(splitCompoundCommand(command)).toEqual([
      'echo $((1 << 2))',
      'echo done',
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
    // This is a gotcha from the Claude Code docs
    expect(resolvePathPattern('/Users/alice/file', projectRoot, cwd)).toBe(
      '/project/Users/alice/file',
    );
  });
});

// ─── matchesPathPattern ──────────────────────────────────────────────────────

describe('matchesPathPattern', () => {
  const projectRoot = '/project';
  const cwd = '/project';

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
  it('Edit rule matches edit and write_file', async () => {
    const rule = parseRule('Edit');
    expect(matchesRule(rule, 'edit')).toBe(true);
    expect(matchesRule(rule, 'write_file')).toBe(true);
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

  it('MCP server-level match (2-part pattern)', async () => {
    const rule = parseRule('mcp__puppeteer');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_click')).toBe(true);
    expect(matchesRule(rule, 'mcp__other__tool')).toBe(false);
  });

  it('MCP wildcard match', async () => {
    const rule = parseRule('mcp__puppeteer__*');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__other__tool')).toBe(false);
  });

  it('MCP intra-segment wildcard match (e.g. mcp__chrome__use_*)', async () => {
    const rule = parseRule('mcp__chrome__use_*');
    expect(matchesRule(rule, 'mcp__chrome__use_browser')).toBe(true);
    expect(matchesRule(rule, 'mcp__chrome__use_context')).toBe(true);
    expect(matchesRule(rule, 'mcp__chrome__navigate')).toBe(false);
    expect(matchesRule(rule, 'mcp__other__use_browser')).toBe(false);
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
  }> = {},
): PermissionManagerConfig {
  return {
    getPermissionsAllow: () => opts.permissionsAllow,
    getPermissionsAsk: () => opts.permissionsAsk,
    getPermissionsDeny: () => opts.permissionsDeny,
    getCoreTools: () => opts.coreTools,
    getProjectRoot: () => opts.projectRoot ?? '/project',
    getCwd: () => opts.cwd ?? '/project',
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

    it('isCommandAllowed delegates to evaluate', async () => {
      expect(await pm.isCommandAllowed('git commit')).toBe('allow');
      expect(await pm.isCommandAllowed('rm -rf /')).toBe('deny');
      // 'ls' is readonly, resolves to 'allow' when no rule matches
      expect(await pm.isCommandAllowed('ls')).toBe('allow');
    });
  });

  describe('compound command evaluation', () => {
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
      expect(await pm.isToolEnabled('run_shell_command')).toBe(false);
      expect(await pm.isToolEnabled('edit')).toBe(false);
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

    it('permissionsAllow alone does NOT restrict unlisted tools (not a whitelist)', async () => {
      // This verifies the previous incorrect behavior is gone: permissionsAllow
      // only means "auto-approve", it does NOT block unlisted tools.
      pm = new PermissionManager(
        makeConfig({ permissionsAllow: ['read_file'] }),
      );
      pm.initialize();
      expect(await pm.isToolEnabled('read_file')).toBe(true);
      expect(await pm.isToolEnabled('run_shell_command')).toBe(true); // not denied, just unreviewed
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
  });
});

// ─── getRuleDisplayName ──────────────────────────────────────────────────────

describe('getRuleDisplayName', () => {
  it('maps read tools to "Read" meta-category', async () => {
    expect(getRuleDisplayName('read_file')).toBe('Read');
    expect(getRuleDisplayName('grep_search')).toBe('Read');
    expect(getRuleDisplayName('glob')).toBe('Read');
    expect(getRuleDisplayName('list_directory')).toBe('Read');
  });

  it('maps edit tools to "Edit" meta-category', async () => {
    expect(getRuleDisplayName('edit')).toBe('Edit');
    expect(getRuleDisplayName('write_file')).toBe('Edit');
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

  it('converts bare WebSearch rule to "search the web"', () => {
    expect(buildHumanReadableRuleLabel(['WebSearch'])).toBe('search the web');
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
});
