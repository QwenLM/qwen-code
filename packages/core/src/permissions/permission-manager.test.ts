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
  it('resolves canonical names', () => {
    expect(resolveToolName('run_shell_command')).toBe('run_shell_command');
    expect(resolveToolName('read_file')).toBe('read_file');
  });

  it('resolves display-name aliases', () => {
    expect(resolveToolName('Shell')).toBe('run_shell_command');
    expect(resolveToolName('ShellTool')).toBe('run_shell_command');
    expect(resolveToolName('Bash')).toBe('run_shell_command');
    expect(resolveToolName('ReadFile')).toBe('read_file');
    expect(resolveToolName('ReadFileTool')).toBe('read_file');
    expect(resolveToolName('EditTool')).toBe('edit');
    expect(resolveToolName('WriteFileTool')).toBe('write_file');
  });

  it('resolves "Read" and "Edit" meta-categories', () => {
    expect(resolveToolName('Read')).toBe('read_file');
    expect(resolveToolName('Edit')).toBe('edit');
    expect(resolveToolName('Write')).toBe('write_file');
  });

  it('resolves Agent category', () => {
    expect(resolveToolName('Agent')).toBe('agent');
    expect(resolveToolName('agent')).toBe('agent');
    expect(resolveToolName('AgentTool')).toBe('agent');
  });

  it('resolves legacy task aliases to agent', () => {
    expect(resolveToolName('task')).toBe('agent');
    expect(resolveToolName('Task')).toBe('agent');
    expect(resolveToolName('TaskTool')).toBe('agent');
  });

  it('returns unknown names unchanged', () => {
    expect(resolveToolName('my_mcp_tool')).toBe('my_mcp_tool');
    expect(resolveToolName('mcp__server__tool')).toBe('mcp__server__tool');
  });
});

// ─── getSpecifierKind ────────────────────────────────────────────────────────

describe('getSpecifierKind', () => {
  it('returns "command" for shell tools', () => {
    expect(getSpecifierKind('run_shell_command')).toBe('command');
  });

  it('returns "path" for file read/edit tools', () => {
    expect(getSpecifierKind('read_file')).toBe('path');
    expect(getSpecifierKind('edit')).toBe('path');
    expect(getSpecifierKind('write_file')).toBe('path');
    expect(getSpecifierKind('grep_search')).toBe('path');
    expect(getSpecifierKind('glob')).toBe('path');
    expect(getSpecifierKind('list_directory')).toBe('path');
  });

  it('returns "domain" for web fetch tools', () => {
    expect(getSpecifierKind('web_fetch')).toBe('domain');
  });

  it('returns "literal" for other tools', () => {
    expect(getSpecifierKind('Agent')).toBe('literal');
    expect(getSpecifierKind('task')).toBe('literal');
    expect(getSpecifierKind('mcp__server')).toBe('literal');
  });
});

// ─── toolMatchesRuleToolName ─────────────────────────────────────────────────

describe('toolMatchesRuleToolName', () => {
  it('exact match', () => {
    expect(toolMatchesRuleToolName('read_file', 'read_file')).toBe(true);
    expect(toolMatchesRuleToolName('edit', 'edit')).toBe(true);
  });

  it('"Read" (read_file) covers grep_search, glob, list_directory', () => {
    expect(toolMatchesRuleToolName('read_file', 'grep_search')).toBe(true);
    expect(toolMatchesRuleToolName('read_file', 'glob')).toBe(true);
    expect(toolMatchesRuleToolName('read_file', 'list_directory')).toBe(true);
  });

  it('"Edit" (edit) covers write_file', () => {
    expect(toolMatchesRuleToolName('edit', 'write_file')).toBe(true);
  });

  it('does not cross categories', () => {
    expect(toolMatchesRuleToolName('read_file', 'edit')).toBe(false);
    expect(toolMatchesRuleToolName('edit', 'read_file')).toBe(false);
    expect(toolMatchesRuleToolName('read_file', 'run_shell_command')).toBe(
      false,
    );
  });
});

// ─── parseRule ───────────────────────────────────────────────────────────────

describe('parseRule', () => {
  it('parses a simple tool name', () => {
    const r = parseRule('ShellTool');
    expect(r.raw).toBe('ShellTool');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBeUndefined();
    expect(r.specifierKind).toBeUndefined();
  });

  it('parses Bash alias (Claude Code compat)', () => {
    const r = parseRule('Bash');
    expect(r.toolName).toBe('run_shell_command');
  });

  it('parses a shell tool with a specifier', () => {
    const r = parseRule('Bash(git *)');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBe('git *');
    expect(r.specifierKind).toBe('command');
  });

  it('parses Read with path specifier', () => {
    const r = parseRule('Read(./secrets/**)');
    expect(r.toolName).toBe('read_file');
    expect(r.specifier).toBe('./secrets/**');
    expect(r.specifierKind).toBe('path');
  });

  it('parses Edit with path specifier', () => {
    const r = parseRule('Edit(/src/**/*.ts)');
    expect(r.toolName).toBe('edit');
    expect(r.specifier).toBe('/src/**/*.ts');
    expect(r.specifierKind).toBe('path');
  });

  it('parses WebFetch with domain specifier', () => {
    const r = parseRule('WebFetch(domain:example.com)');
    expect(r.toolName).toBe('web_fetch');
    expect(r.specifier).toBe('domain:example.com');
    expect(r.specifierKind).toBe('domain');
  });

  it('parses Agent with literal specifier', () => {
    const r = parseRule('Agent(Explore)');
    expect(r.toolName).toBe('agent');
    expect(r.specifier).toBe('Explore');
    expect(r.specifierKind).toBe('literal');
  });

  it('handles unknown tools without specifier', () => {
    const r = parseRule('mcp__my_server__my_tool');
    expect(r.toolName).toBe('mcp__my_server__my_tool');
    expect(r.specifier).toBeUndefined();
  });

  it('handles legacy :* suffix (deprecated)', () => {
    const r = parseRule('Bash(git:*)');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBe('git *');
  });

  it('handles malformed pattern (no closing paren)', () => {
    const r = parseRule('Bash(git status');
    expect(r.specifier).toBeUndefined();
  });
});

// ─── parseRules ──────────────────────────────────────────────────────────────

describe('parseRules', () => {
  it('filters empty strings', () => {
    const rules = parseRules(['ShellTool', '', '  ', 'ReadFileTool']);
    expect(rules).toHaveLength(2);
  });
});

// ─── matchesCommandPattern (Shell glob) ──────────────────────────────────────

describe('matchesCommandPattern', () => {
  // Basic prefix matching (no wildcards)
  describe('prefix matching without glob', () => {
    it('exact match', () => {
      expect(matchesCommandPattern('git', 'git')).toBe(true);
    });

    it('prefix + space', () => {
      expect(matchesCommandPattern('git', 'git status')).toBe(true);
      expect(matchesCommandPattern('git commit', 'git commit -m "test"')).toBe(
        true,
      );
    });

    it('does not match as substring', () => {
      expect(matchesCommandPattern('git', 'gitcommit')).toBe(false);
    });
  });

  // Wildcard at tail
  describe('wildcard at tail', () => {
    it('matches any arguments', () => {
      expect(matchesCommandPattern('git *', 'git status')).toBe(true);
      expect(matchesCommandPattern('git *', 'git commit -m "test"')).toBe(true);
      expect(matchesCommandPattern('npm run *', 'npm run build')).toBe(true);
    });

    it('space-star requires word boundary (ls * does not match lsof)', () => {
      expect(matchesCommandPattern('ls *', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls *', 'lsof')).toBe(false);
    });

    it('no-space-star allows prefix matching (ls* matches lsof)', () => {
      expect(matchesCommandPattern('ls*', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls*', 'lsof')).toBe(true);
    });

    it('does not match different command', () => {
      expect(matchesCommandPattern('git *', 'echo hello')).toBe(false);
    });
  });

  // Wildcard at head
  describe('wildcard at head', () => {
    it('matches any command ending with pattern', () => {
      expect(matchesCommandPattern('* --version', 'node --version')).toBe(true);
      expect(matchesCommandPattern('* --version', 'npm --version')).toBe(true);
      expect(matchesCommandPattern('* --help *', 'npm --help install')).toBe(
        true,
      );
    });

    it('does not match non-matching suffix', () => {
      expect(matchesCommandPattern('* --version', 'node --help')).toBe(false);
    });
  });

  // Wildcard in middle
  describe('wildcard in middle', () => {
    it('matches middle segments', () => {
      expect(matchesCommandPattern('git * main', 'git checkout main')).toBe(
        true,
      );
      expect(matchesCommandPattern('git * main', 'git merge main')).toBe(true);
    });

    it('does not match different suffix', () => {
      expect(matchesCommandPattern('git * main', 'git checkout dev')).toBe(
        false,
      );
    });
  });

  // Word boundary rule: space before * matters
  describe('word boundary rule (space before *)', () => {
    it('Bash(ls *): matches "ls -la" but NOT "lsof"', () => {
      expect(matchesCommandPattern('ls *', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls *', 'ls')).toBe(true); // "ls" alone
      expect(matchesCommandPattern('ls *', 'lsof')).toBe(false);
    });

    it('Bash(ls*): matches both "ls -la" and "lsof"', () => {
      expect(matchesCommandPattern('ls*', 'ls -la')).toBe(true);
      expect(matchesCommandPattern('ls*', 'lsof')).toBe(true);
      expect(matchesCommandPattern('ls*', 'ls')).toBe(true);
    });

    it('Bash(npm *): matches "npm run" but NOT "npmx"', () => {
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
    it('matches when no operators are present', () => {
      expect(
        matchesCommandPattern('git *', 'git commit -m "hello world"'),
      ).toBe(true);
    });

    it('operators inside quotes are not boundaries for splitCompoundCommand', () => {
      // "echo 'a && b'" → the && is inside quotes, not an operator
      expect(matchesCommandPattern('echo *', "echo 'a && b'")).toBe(true);
    });
  });

  // Special: lone * matches any command
  describe('lone wildcard', () => {
    it('* matches any single command', () => {
      expect(matchesCommandPattern('*', 'anything here')).toBe(true);
    });
  });

  // Exact command match with specifier
  describe('exact command specifier', () => {
    it('Bash(npm run build) matches exact command', () => {
      expect(matchesCommandPattern('npm run build', 'npm run build')).toBe(
        true,
      );
    });
    it('Bash(npm run build) also matches with trailing args (prefix)', () => {
      expect(
        matchesCommandPattern('npm run build', 'npm run build --verbose'),
      ).toBe(true);
    });
    it('Bash(npm run build) does not match different command', () => {
      expect(matchesCommandPattern('npm run build', 'npm run test')).toBe(
        false,
      );
    });
  });
});

// ─── splitCompoundCommand ────────────────────────────────────────────────────

describe('splitCompoundCommand', () => {
  it('simple command returns single-element array', () => {
    expect(splitCompoundCommand('git status')).toEqual(['git status']);
  });

  it('splits on &&', () => {
    expect(splitCompoundCommand('git status && rm -rf /')).toEqual([
      'git status',
      'rm -rf /',
    ]);
  });

  it('splits on ||', () => {
    expect(splitCompoundCommand('git push || echo failed')).toEqual([
      'git push',
      'echo failed',
    ]);
  });

  it('splits on ;', () => {
    expect(splitCompoundCommand('echo hello; echo world')).toEqual([
      'echo hello',
      'echo world',
    ]);
  });

  it('splits on |', () => {
    expect(splitCompoundCommand('git log | grep fix')).toEqual([
      'git log',
      'grep fix',
    ]);
  });

  it('handles three-part compound', () => {
    expect(splitCompoundCommand('a && b && c')).toEqual(['a', 'b', 'c']);
  });

  it('handles mixed operators', () => {
    expect(splitCompoundCommand('a && b | c; d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not split on operators inside single quotes', () => {
    expect(splitCompoundCommand("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  it('does not split on operators inside double quotes', () => {
    expect(splitCompoundCommand('echo "a && b"')).toEqual(['echo "a && b"']);
  });

  it('handles escaped characters', () => {
    expect(splitCompoundCommand('echo a \\&& b')).toEqual(['echo a \\&& b']);
  });

  it('trims whitespace around sub-commands', () => {
    expect(splitCompoundCommand('  git status  &&  rm -rf /  ')).toEqual([
      'git status',
      'rm -rf /',
    ]);
  });
});

// ─── resolvePathPattern ──────────────────────────────────────────────────────

describe('resolvePathPattern', () => {
  const projectRoot = '/project';
  const cwd = '/project/subdir';

  it('// prefix → absolute from filesystem root', () => {
    expect(
      resolvePathPattern('//Users/alice/secrets/**', projectRoot, cwd),
    ).toBe('/Users/alice/secrets/**');
  });

  it('~/ prefix → relative to home directory', () => {
    const result = resolvePathPattern('~/Documents/*.pdf', projectRoot, cwd);
    expect(result).toContain('Documents/*.pdf');
    // On POSIX systems the home dir starts with '/'; on Windows it may look like
    // 'C:/Users/foo'. Either way, verify the result begins with the (normalized)
    // home directory.
    const normalizedHome = os.homedir().replace(/\\/g, '/');
    expect(result.startsWith(normalizedHome)).toBe(true);
  });

  it('/ prefix → relative to project root (NOT absolute)', () => {
    expect(resolvePathPattern('/src/**/*.ts', projectRoot, cwd)).toBe(
      '/project/src/**/*.ts',
    );
  });

  it('./ prefix → relative to cwd', () => {
    expect(resolvePathPattern('./secrets/**', projectRoot, cwd)).toBe(
      '/project/subdir/secrets/**',
    );
  });

  it('no prefix → relative to cwd', () => {
    expect(resolvePathPattern('*.env', projectRoot, cwd)).toBe(
      '/project/subdir/*.env',
    );
  });

  it('/Users/alice/file is relative to project root, NOT absolute', () => {
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

  it('matches dotfiles (e.g. .env)', () => {
    expect(matchesPathPattern('.env', '/project/.env', projectRoot, cwd)).toBe(
      true,
    );
    expect(matchesPathPattern('*.env', '/project/.env', projectRoot, cwd)).toBe(
      true,
    );
  });

  it('** matches recursively across directories', () => {
    expect(
      matchesPathPattern(
        './secrets/**',
        '/project/secrets/deep/nested/file.txt',
        projectRoot,
        cwd,
      ),
    ).toBe(true);
  });

  it('* matches single directory only', () => {
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

  it('/docs/** matches under project root docs', () => {
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

  it('//tmp/scratch.txt matches absolute path', () => {
    expect(
      matchesPathPattern(
        '//tmp/scratch.txt',
        '/tmp/scratch.txt',
        projectRoot,
        cwd,
      ),
    ).toBe(true);
  });

  it('does not match unrelated paths', () => {
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
  it('matches exact domain', () => {
    expect(matchesDomainPattern('domain:example.com', 'example.com')).toBe(
      true,
    );
  });

  it('matches subdomain', () => {
    expect(matchesDomainPattern('domain:example.com', 'sub.example.com')).toBe(
      true,
    );
    expect(
      matchesDomainPattern('domain:example.com', 'deep.sub.example.com'),
    ).toBe(true);
  });

  it('does not match different domain', () => {
    expect(matchesDomainPattern('domain:example.com', 'notexample.com')).toBe(
      false,
    );
  });

  it('is case-insensitive', () => {
    expect(matchesDomainPattern('domain:Example.COM', 'example.com')).toBe(
      true,
    );
  });

  it('handles missing prefix', () => {
    expect(matchesDomainPattern('example.com', 'example.com')).toBe(true);
  });
});

// ─── matchesRule (unified) ───────────────────────────────────────────────────

describe('matchesRule', () => {
  // Basic tool name matching
  it('simple tool-name rule matches any invocation', () => {
    const rule = parseRule('ShellTool');
    expect(matchesRule(rule, 'run_shell_command')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
  });

  it('does not match a different tool', () => {
    const rule = parseRule('ShellTool');
    expect(matchesRule(rule, 'read_file')).toBe(false);
  });

  // Shell command specifier
  it('specifier rule requires a command for shell tools', () => {
    const rule = parseRule('Bash(git *)');
    expect(matchesRule(rule, 'run_shell_command')).toBe(false); // no command
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'echo hello')).toBe(false);
  });

  it('matchesRule checks individual simple commands (compound splitting is at PM level)', () => {
    const rule = parseRule('Bash(git *)');
    // matchesRule receives a simple command (already split by PM)
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'rm -rf /')).toBe(false);
  });

  // Meta-category matching: Read
  it('Read rule matches grep_search, glob, list_directory', () => {
    const rule = parseRule('Read');
    expect(matchesRule(rule, 'read_file')).toBe(true);
    expect(matchesRule(rule, 'grep_search')).toBe(true);
    expect(matchesRule(rule, 'glob')).toBe(true);
    expect(matchesRule(rule, 'list_directory')).toBe(true);
    expect(matchesRule(rule, 'edit')).toBe(false); // not a read tool
  });

  // Meta-category matching: Edit
  it('Edit rule matches edit and write_file', () => {
    const rule = parseRule('Edit');
    expect(matchesRule(rule, 'edit')).toBe(true);
    expect(matchesRule(rule, 'write_file')).toBe(true);
    expect(matchesRule(rule, 'read_file')).toBe(false); // not an edit tool
  });

  // File path matching
  it('Read with path specifier requires filePath', () => {
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

  it('Edit path specifier matches write_file too', () => {
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
  it('WebFetch domain specifier', () => {
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
  it('Agent literal specifier', () => {
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
  it('MCP tool exact match', () => {
    const rule = parseRule('mcp__puppeteer__puppeteer_navigate');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_click')).toBe(false);
  });

  it('MCP server-level match (2-part pattern)', () => {
    const rule = parseRule('mcp__puppeteer');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_click')).toBe(true);
    expect(matchesRule(rule, 'mcp__other__tool')).toBe(false);
  });

  it('MCP wildcard match', () => {
    const rule = parseRule('mcp__puppeteer__*');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__other__tool')).toBe(false);
  });

  it('MCP intra-segment wildcard match (e.g. mcp__chrome__use_*)', () => {
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

    it('returns deny for a denied tool', () => {
      expect(pm.evaluate({ toolName: 'run_shell_command' })).toBe('deny');
    });

    it('returns ask for an ask-rule tool', () => {
      expect(pm.evaluate({ toolName: 'write_file' })).toBe('ask');
    });

    it('returns allow for an allow-rule tool', () => {
      expect(pm.evaluate({ toolName: 'read_file' })).toBe('allow');
    });

    it('returns default for unmatched tool', () => {
      // Note: 'glob' is covered by ReadFileTool via Read meta-category,
      // so use a tool not in any rule or meta-category
      expect(pm.evaluate({ toolName: 'agent' })).toBe('default');
    });

    it('deny takes precedence over ask and allow', () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['run_shell_command'],
          permissionsAsk: ['run_shell_command'],
          permissionsDeny: ['run_shell_command'],
        }),
      );
      pm2.initialize();
      expect(pm2.evaluate({ toolName: 'run_shell_command' })).toBe('deny');
    });

    it('ask takes precedence over allow', () => {
      const pm2 = new PermissionManager(
        makeConfig({
          permissionsAllow: ['write_file'],
          permissionsAsk: ['write_file'],
        }),
      );
      pm2.initialize();
      expect(pm2.evaluate({ toolName: 'write_file' })).toBe('ask');
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

    it('allows a matching allowed command', () => {
      expect(
        pm.evaluate({ toolName: 'run_shell_command', command: 'git status' }),
      ).toBe('allow');
    });

    it('denies a matching denied command', () => {
      expect(
        pm.evaluate({ toolName: 'run_shell_command', command: 'rm -rf /' }),
      ).toBe('deny');
    });

    it('returns default for an unmatched command', () => {
      expect(
        pm.evaluate({ toolName: 'run_shell_command', command: 'echo hello' }),
      ).toBe('default');
    });

    it('isCommandAllowed delegates to evaluate', () => {
      expect(pm.isCommandAllowed('git commit')).toBe('allow');
      expect(pm.isCommandAllowed('rm -rf /')).toBe('deny');
      expect(pm.isCommandAllowed('ls')).toBe('default');
    });
  });

  describe('compound command evaluation', () => {
    it('all sub-commands allowed → allow', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)', 'Bash(one-cmd *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'safe-cmd arg1 && one-cmd arg2',
        }),
      ).toBe('allow');
    });

    it('one sub-command unmatched → default (most restrictive)', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'safe-cmd && two-cmd',
        }),
      ).toBe('default');
    });

    it('one sub-command denied → deny', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)'],
          permissionsDeny: ['Bash(evil-cmd *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'safe-cmd && evil-cmd rm-all',
        }),
      ).toBe('deny');
    });

    it('one sub-command ask + one allow → ask', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)'],
          permissionsAsk: ['Bash(npm *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git status && npm publish',
        }),
      ).toBe('ask');
    });

    it('pipe compound: all matched → allow', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(grep *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git log | grep fix',
        }),
      ).toBe('allow');
    });

    it('pipe compound: second unmatched → default', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git log | grep fix',
        }),
      ).toBe('default');
    });

    it('semicolon compound: deny in second → deny', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(echo *)'],
          permissionsDeny: ['Bash(rm *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'echo hello; rm -rf /',
        }),
      ).toBe('deny');
    });

    it('|| compound: all allowed → allow', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(echo *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git push || echo failed',
        }),
      ).toBe('allow');
    });

    it('operators inside quotes: treated as single command', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(echo *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: "echo 'a && b'",
        }),
      ).toBe('allow');
    });

    it('three-part compound: all must pass', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(npm *)', 'Bash(echo *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git add . && npm test && echo done',
        }),
      ).toBe('allow');
    });

    it('three-part compound: one unmatched → default', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(git *)', 'Bash(echo *)'],
        }),
      );
      pm.initialize();
      expect(
        pm.evaluate({
          toolName: 'run_shell_command',
          command: 'git add . && npm test && echo done',
        }),
      ).toBe('default');
    });

    it('isCommandAllowed also handles compound commands', () => {
      pm = new PermissionManager(
        makeConfig({
          permissionsAllow: ['Bash(safe-cmd *)', 'Bash(one-cmd *)'],
          permissionsDeny: ['Bash(evil-cmd *)'],
        }),
      );
      pm.initialize();
      expect(pm.isCommandAllowed('safe-cmd a && one-cmd b')).toBe('allow');
      expect(pm.isCommandAllowed('safe-cmd a && unknown-cmd')).toBe('default');
      expect(pm.isCommandAllowed('safe-cmd a && evil-cmd b')).toBe('deny');
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

    it('denies reading a denied file', () => {
      expect(
        pm.evaluate({ toolName: 'read_file', filePath: '/project/.env' }),
      ).toBe('deny');
    });

    it('denies editing in a denied directory', () => {
      expect(
        pm.evaluate({
          toolName: 'edit',
          filePath: '/project/src/generated/code.ts',
        }),
      ).toBe('deny');
    });

    it('allows reading in an allowed directory', () => {
      expect(
        pm.evaluate({
          toolName: 'read_file',
          filePath: '/project/docs/readme.md',
        }),
      ).toBe('allow');
    });

    it('Read deny applies to grep_search too (meta-category)', () => {
      expect(
        pm.evaluate({ toolName: 'grep_search', filePath: '/project/.env' }),
      ).toBe('deny');
    });

    it('returns default for unmatched path', () => {
      expect(
        pm.evaluate({
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

    it('allows fetch to allowed domain', () => {
      expect(pm.evaluate({ toolName: 'web_fetch', domain: 'github.com' })).toBe(
        'allow',
      );
    });

    it('allows fetch to subdomain of allowed domain', () => {
      expect(
        pm.evaluate({ toolName: 'web_fetch', domain: 'api.github.com' }),
      ).toBe('allow');
    });

    it('denies fetch to denied domain', () => {
      expect(pm.evaluate({ toolName: 'web_fetch', domain: 'evil.com' })).toBe(
        'deny',
      );
    });

    it('returns default for unmatched domain', () => {
      expect(
        pm.evaluate({ toolName: 'web_fetch', domain: 'example.com' }),
      ).toBe('default');
    });
  });

  describe('isToolEnabled', () => {
    it('returns false for deny-ruled tools', () => {
      pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['ShellTool'] }),
      );
      pm.initialize();
      expect(pm.isToolEnabled('run_shell_command')).toBe(false);
    });

    it('returns true for tools with only specifier deny rules', () => {
      pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['Bash(rm *)'] }),
      );
      pm.initialize();
      expect(pm.isToolEnabled('run_shell_command')).toBe(true);
    });

    it('excludeTools passed via permissionsDeny disables the tool', () => {
      pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['run_shell_command'] }),
      );
      pm.initialize();
      expect(pm.isToolEnabled('run_shell_command')).toBe(false);
    });

    it('coreTools allowlist: listed tool is enabled', () => {
      pm = new PermissionManager(
        makeConfig({ coreTools: ['read_file', 'Bash'] }),
      );
      pm.initialize();
      expect(pm.isToolEnabled('read_file')).toBe(true);
      expect(pm.isToolEnabled('run_shell_command')).toBe(true); // Bash resolves to run_shell_command
    });

    it('coreTools allowlist: unlisted tool is disabled', () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();
      expect(pm.isToolEnabled('read_file')).toBe(true);
      expect(pm.isToolEnabled('run_shell_command')).toBe(false);
      expect(pm.isToolEnabled('edit')).toBe(false);
    });

    it('coreTools with specifier: tool-level check strips specifier', () => {
      // "Bash(ls -l)" should register run_shell_command (specifier only affects runtime)
      pm = new PermissionManager(makeConfig({ coreTools: ['Bash(ls -l)'] }));
      pm.initialize();
      expect(pm.isToolEnabled('run_shell_command')).toBe(true);
      expect(pm.isToolEnabled('read_file')).toBe(false);
    });

    it('empty coreTools: all tools enabled (no whitelist restriction)', () => {
      pm = new PermissionManager(makeConfig({ coreTools: [] }));
      pm.initialize();
      expect(pm.isToolEnabled('read_file')).toBe(true);
      expect(pm.isToolEnabled('run_shell_command')).toBe(true);
    });

    it('coreTools allowlist + deny rule: deny takes precedence for listed tools', () => {
      pm = new PermissionManager(
        makeConfig({
          coreTools: ['read_file', 'Bash'],
          permissionsDeny: ['Bash'],
        }),
      );
      pm.initialize();
      expect(pm.isToolEnabled('read_file')).toBe(true);
      expect(pm.isToolEnabled('run_shell_command')).toBe(false); // in list but denied
    });

    it('permissionsAllow alone does NOT restrict unlisted tools (not a whitelist)', () => {
      // This verifies the previous incorrect behavior is gone: permissionsAllow
      // only means "auto-approve", it does NOT block unlisted tools.
      pm = new PermissionManager(
        makeConfig({ permissionsAllow: ['read_file'] }),
      );
      pm.initialize();
      expect(pm.isToolEnabled('read_file')).toBe(true);
      expect(pm.isToolEnabled('run_shell_command')).toBe(true); // not denied, just unreviewed
    });
  });

  describe('session rules', () => {
    beforeEach(() => {
      pm = new PermissionManager(makeConfig({}));
      pm.initialize();
    });

    it('addSessionAllowRule enables auto-approval for that pattern', () => {
      expect(
        pm.evaluate({ toolName: 'run_shell_command', command: 'git status' }),
      ).toBe('default');
      pm.addSessionAllowRule('Bash(git *)');
      expect(
        pm.evaluate({ toolName: 'run_shell_command', command: 'git status' }),
      ).toBe('allow');
    });

    it('session deny rules override allow rules', () => {
      pm.addSessionAllowRule('run_shell_command');
      pm.addSessionDenyRule('run_shell_command');
      expect(pm.evaluate({ toolName: 'run_shell_command' })).toBe('deny');
    });
  });

  describe('allowedTools via permissionsAllow', () => {
    it('allow rule auto-approves matching tools/commands', () => {
      pm = new PermissionManager(
        makeConfig({ permissionsAllow: ['ReadFileTool', 'Bash(git *)'] }),
      );
      pm.initialize();
      expect(pm.evaluate({ toolName: 'read_file' })).toBe('allow');
      expect(
        pm.evaluate({ toolName: 'run_shell_command', command: 'git status' }),
      ).toBe('allow');
    });
  });

  describe('listRules', () => {
    it('returns all rules with type and scope', () => {
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
});

// ─── getRuleDisplayName ──────────────────────────────────────────────────────

describe('getRuleDisplayName', () => {
  it('maps read tools to "Read" meta-category', () => {
    expect(getRuleDisplayName('read_file')).toBe('Read');
    expect(getRuleDisplayName('grep_search')).toBe('Read');
    expect(getRuleDisplayName('glob')).toBe('Read');
    expect(getRuleDisplayName('list_directory')).toBe('Read');
  });

  it('maps edit tools to "Edit" meta-category', () => {
    expect(getRuleDisplayName('edit')).toBe('Edit');
    expect(getRuleDisplayName('write_file')).toBe('Edit');
  });

  it('maps shell to "Bash"', () => {
    expect(getRuleDisplayName('run_shell_command')).toBe('Bash');
  });

  it('maps web_fetch to "WebFetch"', () => {
    expect(getRuleDisplayName('web_fetch')).toBe('WebFetch');
  });

  it('maps agent to "Agent" and skill to "Skill"', () => {
    expect(getRuleDisplayName('agent')).toBe('Agent');
    expect(getRuleDisplayName('skill')).toBe('Skill');
  });

  it('returns the canonical name for unknown tools (e.g. MCP)', () => {
    expect(getRuleDisplayName('mcp__server__tool')).toBe('mcp__server__tool');
  });
});

// ─── buildPermissionRules ────────────────────────────────────────────────────

describe('buildPermissionRules', () => {
  describe('path-based tools (Read/Edit)', () => {
    it('generates Read rule scoped to parent directory for read_file', () => {
      const rules = buildPermissionRules({
        toolName: 'read_file',
        filePath: '/Users/alice/.secrets',
      });
      // read_file is file-targeted → dirname gives /Users/alice, plus /** glob
      expect(rules).toEqual(['Read(//Users/alice/**)']);
    });

    it('generates Read rule with directory as-is for grep_search', () => {
      const rules = buildPermissionRules({
        toolName: 'grep_search',
        filePath: '/external/dir',
      });
      // grep_search is directory-targeted → path used as-is, plus /** glob
      expect(rules).toEqual(['Read(//external/dir/**)']);
    });

    it('generates Read rule with directory as-is for glob', () => {
      const rules = buildPermissionRules({
        toolName: 'glob',
        filePath: '/tmp/data',
      });
      expect(rules).toEqual(['Read(//tmp/data/**)']);
    });

    it('generates Read rule with directory as-is for list_directory', () => {
      const rules = buildPermissionRules({
        toolName: 'list_directory',
        filePath: '/home/user/docs',
      });
      expect(rules).toEqual(['Read(//home/user/docs/**)']);
    });

    it('generates Edit rule scoped to parent directory for edit', () => {
      const rules = buildPermissionRules({
        toolName: 'edit',
        filePath: '/external/file.ts',
      });
      // edit is file-targeted → dirname gives /external, plus /** glob
      expect(rules).toEqual(['Edit(//external/**)']);
    });

    it('generates Edit rule scoped to parent directory for write_file', () => {
      const rules = buildPermissionRules({
        toolName: 'write_file',
        filePath: '/tmp/output.txt',
      });
      expect(rules).toEqual(['Edit(//tmp/**)']);
    });

    it('falls back to bare display name when no filePath', () => {
      const rules = buildPermissionRules({ toolName: 'read_file' });
      expect(rules).toEqual(['Read']);
    });
  });

  describe('generated rules round-trip through parseRule and matchesRule', () => {
    it('Read rule for external file covers the containing directory', () => {
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

    it('Read rule also matches other read-family tools on the same path', () => {
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
    it('generates WebFetch rule with domain specifier', () => {
      const rules = buildPermissionRules({
        toolName: 'web_fetch',
        domain: 'example.com',
      });
      expect(rules).toEqual(['WebFetch(example.com)']);
    });

    it('falls back to bare display name when no domain', () => {
      const rules = buildPermissionRules({ toolName: 'web_fetch' });
      expect(rules).toEqual(['WebFetch']);
    });
  });

  describe('command-based tools', () => {
    it('generates Bash rule with command specifier', () => {
      const rules = buildPermissionRules({
        toolName: 'run_shell_command',
        command: 'git status',
      });
      expect(rules).toEqual(['Bash(git status)']);
    });

    it('falls back to bare display name when no command', () => {
      const rules = buildPermissionRules({ toolName: 'run_shell_command' });
      expect(rules).toEqual(['Bash']);
    });
  });

  describe('literal-specifier tools', () => {
    it('generates Skill rule with specifier', () => {
      const rules = buildPermissionRules({
        toolName: 'skill',
        specifier: 'Explore',
      });
      expect(rules).toEqual(['Skill(Explore)']);
    });

    it('generates Agent rule with specifier', () => {
      const rules = buildPermissionRules({
        toolName: 'agent',
        specifier: 'research',
      });
      expect(rules).toEqual(['Agent(research)']);
    });

    it('falls back to bare display name when no specifier', () => {
      const rules = buildPermissionRules({ toolName: 'skill' });
      expect(rules).toEqual(['Skill']);
    });
  });

  describe('unknown / MCP tools', () => {
    it('uses the canonical name as display for MCP tools', () => {
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
