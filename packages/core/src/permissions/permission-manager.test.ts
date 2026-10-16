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
  getToolNameAliases,
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
import type { PermissionCheckContext, PermissionRule } from './types.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';
import {
  generateLegacyMcpToolName,
  normalizeToolNameForProvider,
} from '../utils/tool-name-utils.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import type { CallableTool } from '@google/genai';
import { ToolNames, ToolDisplayNames } from '../tools/tool-names.js';
import { ToolMode } from '../tools/code-mode.js';

// Builds the tool exactly as MCP discovery builds it, so the permission
// aliases under test are the tool's own advertised `permissionAliases` — the
// exact raw identity first, then the legacy spelling — never a hand-written
// stand-in that could drift from the producer (same pattern as
// mcp-server-rule-collision.test.ts).
const callableTool = { callTool: async () => [] } as unknown as CallableTool;
function prodTool(
  serverName: string,
  serverToolName: string,
): DiscoveredMCPTool {
  return new DiscoveredMCPTool(
    callableTool,
    serverName,
    serverToolName,
    'test tool',
    {},
  );
}

const debugLoggerMock = vi.hoisted(() => ({
  isEnabled: vi.fn().mockReturnValue(false),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const shellTypeMock = vi.hoisted(() => ({
  value: 'bash' as 'bash' | 'cmd' | 'powershell',
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => debugLoggerMock,
}));

vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();
  return {
    ...actual,
    getShellConfiguration: () => ({
      ...actual.getShellConfiguration(),
      shell: shellTypeMock.value,
    }),
  };
});

// `shellTypeMock` backs the file-level `vi.mock` above: reset it file-wide,
// not just in `describe('PermissionManager')`, so no later describe inherits
// a shell type an earlier test left behind.
beforeEach(() => {
  shellTypeMock.value = 'bash';
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** `matchesRule` with only a literal specifier and/or tool params set. */
const matchesAgent = (
  rule: PermissionRule,
  toolParams?: Record<string, unknown>,
  specifier?: string,
  toolName = 'agent',
) =>
  matchesRule(
    rule,
    toolName,
    undefined,
    undefined,
    undefined,
    undefined,
    specifier,
    toolParams,
  );

/** A parsed `key:value` param matcher, as `parseRule` emits it. */
const paramMatcher = (key: string, valuePattern: string) => ({
  key,
  valuePattern,
});

/** `matchesRule` with only a file path set. */
const matchesPath = (
  rule: PermissionRule,
  toolName: string,
  filePath: string,
  pathCtx = { projectRoot: '/project', cwd: '/project' },
) => matchesRule(rule, toolName, undefined, filePath, undefined, pathCtx);

/** Runs `run` against a fresh temp directory and always removes it. */
async function withTempRoot(run: (root: string) => unknown): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-permission-'));
  try {
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Makes `<root>/<name>` (holding `files`) and a `<root>/link` symlink to it. */
function linkDir(
  root: string,
  files: Record<string, string> = {},
  name = 'protected',
) {
  const dir = path.join(root, name);
  const link = path.join(root, 'link');
  fs.mkdirSync(dir);
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), text);
  }
  fs.symlinkSync(dir, link, 'dir');
  return { dir, link };
}

type PmOpts = Partial<{
  permissionsAllow: string[];
  permissionsAsk: string[];
  permissionsDeny: string[];
  coreTools: string[];
  projectRoot: string;
  cwd: string;
  approvalMode: string;
  /**
   * `settings.tools.eager`: tools whose schemas ride in the initial request.
   * Absent = no restriction; `[]` is active and defers every non-exempt
   * tool. Independent of the permission rules (#10075).
   */
  eagerTools: string[];
  /** Live folder trust; absent reads as trusted. */
  isTrustedFolder: () => boolean;
}>;

function makeConfig(opts: PmOpts = {}): PermissionManagerConfig {
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

/** An initialized PermissionManager over `makeConfig(opts)`. */
function makePm(opts?: PmOpts): PermissionManager {
  const manager = new PermissionManager(makeConfig(opts));
  manager.initialize();
  return manager;
}

/** Sets the mocked shell first: the manager must be built under that shell. */
function makeShellPm(shell: typeof shellTypeMock.value, opts?: PmOpts) {
  shellTypeMock.value = shell;
  return makePm(opts);
}

/** A shell-like tool context; `cwd` is set only when given. */
const shellCtx =
  (toolName: string) =>
  (command: string, cwd?: string): PermissionCheckContext => ({
    toolName,
    command,
    ...(cwd === undefined ? {} : { cwd }),
  });
const sh = shellCtx('run_shell_command');
const mon = shellCtx('monitor');

/** An `agent` context: optional literal specifier plus tool params. */
const agentCtx = (
  toolParams: Record<string, unknown>,
  specifier?: string,
): PermissionCheckContext => ({
  toolName: 'agent',
  ...(specifier === undefined ? {} : { specifier }),
  toolParams,
});

/** Object.prototype keys that must never resolve via the alias table (#10400). */
const PROTO_KEYS = [
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
];

/** The session allow list, which has no public accessor. */
const sessionAllowRules = (pm: PermissionManager) =>
  (pm as unknown as { sessionRules: { allow: unknown[] } }).sessionRules.allow;

// ─── getToolNameAliases ──────────────────────────────────────────────────────

describe('getToolNameAliases', () => {
  it('lists every name that resolves to the tool', () => {
    expect(getToolNameAliases('run_shell_command')).toEqual(
      expect.arrayContaining([
        'run_shell_command',
        'Shell',
        'ShellTool',
        'Bash',
      ]),
    );
    expect(getToolNameAliases('read_file')).toEqual(
      expect.arrayContaining(['read_file', 'ReadFile', 'Read']),
    );
    for (const [alias, canonical] of Object.entries(TOOL_NAME_ALIASES)) {
      expect(getToolNameAliases(canonical)).toContain(alias);
    }
  });

  it('does not expand permission meta-categories', () => {
    expect(getToolNameAliases('grep_search')).not.toContain('Read');
    expect(getToolNameAliases('write_file')).not.toContain('Edit');
    expect(getToolNameAliases('monitor')).not.toContain('Bash');
  });

  it('returns nothing for a name that is not a canonical tool name', () => {
    expect(getToolNameAliases('mcp__server__tool')).toEqual([]);
    expect(getToolNameAliases('Bash')).toEqual([]);
  });
});

// ─── resolveToolName ─────────────────────────────────────────────────────────

describe('resolveToolName', () => {
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

  // Rows without a canonical name expect every name back unchanged.
  it.each<[string, string[], string?]>([
    ['resolves canonical names', ['run_shell_command', 'read_file']],
    ['resolves Agent category', ['Agent', 'agent', 'AgentTool'], 'agent'],
    [
      'resolves legacy task aliases to agent',
      ['task', 'Task', 'TaskTool'],
      'agent',
    ],
    // `TodoList` is the UI display name, so allow: ["TodoList"] must resolve
    // rather than be silently dropped; `TodoWrite` is the legacy name.
    [
      'resolves TodoList aliases (incl. legacy TodoWrite) to todo_write',
      ['todo_write', 'TodoList', 'TodoWrite', 'TodoWriteTool'],
      'todo_write',
    ],
    [
      'returns unknown names unchanged',
      ['my_mcp_tool', 'mcp__server__tool', 'constructor'],
    ],
    // Inherited keys must never resolve to the prototype value (e.g. the
    // `constructor` function): only own alias-table keys are aliases.
    ['returns Object.prototype-keyed names unchanged (#10400)', PROTO_KEYS],
  ])('%s', (_title, names, canonical) => {
    for (const name of names) {
      expect(resolveToolName(name)).toBe(canonical ?? name);
    }
  });
});

// ─── resolveToolName exhaustiveness (#9827) ─────────────────────────────────

describe('resolveToolName exhaustiveness (#9827)', () => {
  // Every built-in tool's canonical AND display name must resolve through
  // TOOL_NAME_ALIASES: a tool added to tool-names.ts without an alias entry
  // silently matches no permission rule (#9827), so drift must fail CI.
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
      // So must the /tools display name, the spelling users copy into rules.
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
  it.each([
    ['command', 'shell', ['run_shell_command']],
    ['domain', 'web fetch', ['web_fetch']],
    ['literal', 'other', ['Agent', 'task', 'mcp__server']],
  ])('returns "%s" for %s tools', async (kind, _label, toolNames) => {
    for (const toolName of toolNames) {
      expect(getSpecifierKind(toolName)).toBe(kind);
    }
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

  it.each([
    ['Bash', 'run_shell_command'],
    ['Monitor', 'monitor'],
  ])('parses %s alias', async (raw, toolName) => {
    expect(parseRule(raw).toolName).toBe(toolName);
  });

  it('parses a shell tool with a specifier', async () => {
    const r = parseRule('Bash(git *)');
    expect(r.toolName).toBe('run_shell_command');
    expect(r.specifier).toBe('git *');
    expect(r.specifierKind).toBe('command');
  });

  // Rows: display name and specifier kind (the title), rule, tool, specifier.
  it.each([
    ['Monitor', 'command', 'Monitor(tail -f *)', 'monitor', 'tail -f *'],
    ['Read', 'path', 'Read(./secrets/**)', 'read_file', './secrets/**'],
    ['Edit', 'path', 'Edit(/src/**/*.ts)', 'edit', '/src/**/*.ts'],
    [
      'WebFetch',
      'domain',
      'WebFetch(domain:example.com)',
      'web_fetch',
      'domain:example.com',
    ],
    ['Agent', 'literal', 'Agent(Explore)', 'agent', 'Explore'],
  ])(
    'parses %s with %s specifier',
    async (_name, kind, raw, toolName, specifier) => {
      const r = parseRule(raw);
      expect(r.toolName).toBe(toolName);
      expect(r.specifier).toBe(specifier);
      expect(r.specifierKind).toBe(kind);
    },
  );

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
  const matches = matchesCommandPattern;

  describe('prefix matching without glob', () => {
    it('exact match', async () => {
      expect(matches('git', 'git')).toBe(true);
    });

    it('prefix + space', async () => {
      expect(matches('git', 'git status')).toBe(true);
      expect(matches('git commit', 'git commit -m "test"')).toBe(true);
    });

    it('does not match as substring', async () => {
      expect(matches('git', 'gitcommit')).toBe(false);
    });
  });

  describe('wildcard at tail', () => {
    it('matches any arguments', async () => {
      expect(matches('git *', 'git status')).toBe(true);
      expect(matches('git *', 'git commit -m "test"')).toBe(true);
      expect(matches('npm run *', 'npm run build')).toBe(true);
    });

    it('matches commands with leading env var assignments', async () => {
      expect(
        matches('python3 *', 'PYTHONPATH=/tmp/lib python3 -c "print(1)"'),
      ).toBe(true);
    });

    it('matches commands containing embedded newlines (dotAll)', async () => {
      expect(
        matches('python3 *', 'python3 -c "\nimport sys\nprint(sys.version)\n"'),
      ).toBe(true);
    });

    it('space-star requires word boundary (ls * does not match lsof)', async () => {
      expect(matches('ls *', 'ls -la')).toBe(true);
      expect(matches('ls *', 'lsof')).toBe(false);
    });

    it('no-space-star allows prefix matching (ls* matches lsof)', async () => {
      expect(matches('ls*', 'ls -la')).toBe(true);
      expect(matches('ls*', 'lsof')).toBe(true);
    });

    it('does not match different command', async () => {
      expect(matches('git *', 'echo hello')).toBe(false);
    });
  });

  describe('wildcard at head', () => {
    it('matches any command ending with pattern', async () => {
      expect(matches('* --version', 'node --version')).toBe(true);
      expect(matches('* --version', 'npm --version')).toBe(true);
      expect(matches('* --help *', 'npm --help install')).toBe(true);
    });

    it('does not match non-matching suffix', async () => {
      expect(matches('* --version', 'node --help')).toBe(false);
    });
  });

  describe('wildcard in middle', () => {
    it('matches middle segments', async () => {
      expect(matches('git * main', 'git checkout main')).toBe(true);
      expect(matches('git * main', 'git merge main')).toBe(true);
    });

    it('does not match different suffix', async () => {
      expect(matches('git * main', 'git checkout dev')).toBe(false);
    });
  });

  describe('word boundary rule (space before *)', () => {
    it('Bash(ls *): matches "ls -la" but NOT "lsof"', async () => {
      expect(matches('ls *', 'ls -la')).toBe(true);
      expect(matches('ls *', 'ls')).toBe(true); // "ls" alone
      expect(matches('ls *', 'lsof')).toBe(false);
    });

    it('Bash(ls*): matches both "ls -la" and "lsof"', async () => {
      expect(matches('ls*', 'ls -la')).toBe(true);
      expect(matches('ls*', 'lsof')).toBe(true);
      expect(matches('ls*', 'ls')).toBe(true);
    });

    it('Bash(npm *): matches "npm run" but NOT "npmx"', async () => {
      expect(matches('npm *', 'npm run build')).toBe(true);
      expect(matches('npm *', 'npmx install')).toBe(false);
    });
  });

  // matchesCommandPattern sees simple commands only: on a compound `git *`
  // would match `git status && rm -rf /` and `rm *` would not. evaluate()
  // splits compounds first; these pin matching on the sub-commands.
  describe('simple command matching (no operators)', () => {
    it('matches when no operators are present', async () => {
      expect(matches('git *', 'git commit -m "hello world"')).toBe(true);
    });

    it('operators inside quotes are not boundaries for splitCompoundCommand', async () => {
      expect(matches('echo *', "echo 'a && b'")).toBe(true);
    });
  });

  describe('lone wildcard', () => {
    it('* matches any single command', async () => {
      expect(matches('*', 'anything here')).toBe(true);
    });
  });

  describe('exact command specifier', () => {
    it('Bash(npm run build) matches exact command', async () => {
      expect(matches('npm run build', 'npm run build')).toBe(true);
    });
    it('Bash(npm run build) also matches with trailing args (prefix)', async () => {
      expect(matches('npm run build', 'npm run build --verbose')).toBe(true);
    });
    it('Bash(npm run build) does not match different command', async () => {
      expect(matches('npm run build', 'npm run test')).toBe(false);
    });
  });
});

// ─── splitCompoundCommand ────────────────────────────────────────────────────

describe('splitCompoundCommand', () => {
  const split = splitCompoundCommand;

  it.each([
    ['splits on &&', 'git status && rm -rf /', ['git status', 'rm -rf /']],
    ['splits on ||', 'git push || echo failed', ['git push', 'echo failed']],
    ['splits on ;', 'echo hello; echo world', ['echo hello', 'echo world']],
    ['splits on |', 'git log | grep fix', ['git log', 'grep fix']],
    ['handles three-part compound', 'a && b && c', ['a', 'b', 'c']],
    ['handles mixed operators', 'a && b | c; d', ['a', 'b', 'c', 'd']],
    [
      'trims whitespace around sub-commands',
      '  git status  &&  rm -rf /  ',
      ['git status', 'rm -rf /'],
    ],
  ])('%s', async (_title, command, parts) => {
    expect(split(command)).toEqual(parts);
  });

  it.each([
    ['simple command returns single-element array', 'git status'],
    ['does not split on operators inside single quotes', "echo 'a && b'"],
    ['does not split on operators inside double quotes', 'echo "a && b"'],
    // A backslash escapes exactly one character, so `\&` is a literal
    // ampersand argument and the command really is a single one.
    ['handles escaped characters', 'echo a \\& b'],
  ])('%s', async (_title, command) => {
    expect(split(command)).toEqual([command]);
  });

  it('escapes only the first of two ampersands', async () => {
    // `echo a \&& b` is not an escaped `&&`: the backslash consumes the first
    // ampersand and the second is a live async operator. `bash -x` runs it as
    // two commands, `echo a '&'` and `b`, so the splitter has to see two.
    expect(split('echo a \\&& b')).toEqual(['echo a \\&', 'b']);
  });

  // Rows starting with a plain `'c\'` are split only by bash's reading, so
  // they pin the ANSI-C tracking.
  it.each([
    ["echo 'a\\' ; touch /tmp/x", ["echo 'a\\'", 'touch /tmp/x']],
    ["echo 'a\\' && touch /tmp/x", ["echo 'a\\'", 'touch /tmp/x']],
    ["echo 'a\\' | sh", ["echo 'a\\'", 'sh']],
    ["echo 'a\\' & touch /tmp/x", ["echo 'a\\'", 'touch /tmp/x']],
    ["echo 'a\\'\ntouch /tmp/x", ["echo 'a\\'", 'touch /tmp/x']],
    ["echo $'a\\'' ; touch /tmp/x", ["echo $'a\\''", 'touch /tmp/x']],
    [
      "echo 'c\\' $'a\\'' ; touch /tmp/x",
      ["echo 'c\\' $'a\\''", 'touch /tmp/x'],
    ],
    [
      "echo 'c\\' $'a\\'' && touch /tmp/x",
      ["echo 'c\\' $'a\\''", 'touch /tmp/x'],
    ],
    ["echo 'c\\' $'a\\'' | sh", ["echo 'c\\' $'a\\''", 'sh']],
    [
      "echo 'c\\' $'a\\'' & touch /tmp/x",
      ["echo 'c\\' $'a\\''", 'touch /tmp/x'],
    ],
    [
      "echo 'c\\' $'a\\''\ntouch /tmp/x",
      ["echo 'c\\' $'a\\''", 'touch /tmp/x'],
    ],
    [
      "echo 'c\\' \\\\$'a\\'' ; touch /tmp/x",
      ["echo 'c\\' \\\\$'a\\''", 'touch /tmp/x'],
    ],
    [
      "echo 'c\\' $\\\n'a\\'' ; touch /tmp/x",
      ["echo 'c\\' $\\\n'a\\''", 'touch /tmp/x'],
    ],
    [
      "echo 'c\\' $\\\n'a\\'' & touch /tmp/x",
      ["echo 'c\\' $\\\n'a\\''", 'touch /tmp/x'],
    ],
    [
      "echo 'c\\' $\\\n'a\\''\ntouch /tmp/x",
      ["echo 'c\\' $\\\n'a\\''", 'touch /tmp/x'],
    ],
    ["echo \\$'a\\' ; touch /tmp/x", ["echo \\$'a\\'", 'touch /tmp/x']],
    ["echo $$'a\\' ; touch /tmp/x", ["echo $$'a\\'", 'touch /tmp/x']],
    // A `$` opens ANSI-C only when the quote follows it directly.
    ["echo $x'a\\' ; touch /tmp/x", ["echo $x'a\\'", 'touch /tmp/x']],
    ['echo "$"\'a\\\' ; touch /tmp/x', ['echo "$"\'a\\\'', 'touch /tmp/x']],
  ])('splits after the quoted word in %s', async (command, parts) => {
    expect(split(command)).toEqual(parts);
  });

  it('keeps an escaped quote inside double quotes and a line continuation', async () => {
    expect(split('echo "a\\" ; touch /tmp/x"')).toEqual([
      'echo "a\\" ; touch /tmp/x"',
    ]);
    expect(split('echo a\\\nb')).toEqual(['echo a\\\nb']);
  });

  // The `echo 'a\'' ; rm x'` row is one command to bash but stays split, as on
  // main.
  it.each([
    [
      "echo done # note 'a\\''\nrm -rf /tmp/x",
      ["echo done # note 'a\\''", 'rm -rf /tmp/x'],
    ],
    [
      "echo `echo 'a\\''` ; rm -rf /tmp/x",
      ["echo `echo 'a\\''`", 'rm -rf /tmp/x'],
    ],
    [
      "cat <<EOF\necho safe 'a\\''\nEOF\nrm -rf /tmp/x",
      ['cat <<EOF', "echo safe 'a\\''", 'EOF', 'rm -rf /tmp/x'],
    ],
    ["echo 'a\\'' ; rm x'", ["echo 'a\\''", "rm x'"]],
    // Two carriers in a row: the newline before `touch` is found by the
    // escape-everywhere reading alone and comes after a bash-reading boundary,
    // so merging the scans unsorted drops it as an overlap and `touch` joins
    // the `echo` segment. bash runs four commands here.
    [
      "echo done # note 'a\\''\ntouch /tmp/x # it's\necho z ; echo w",
      ["echo done # note 'a\\''", "touch /tmp/x # it's", 'echo z', 'echo w'],
    ],
  ])('keeps the boundaries main found in %s', async (command, parts) => {
    expect(split(command)).toEqual(parts);
  });

  // The #11851 rows below put the target in a segment that ends at an operator;
  // the last segment is trimmed separately.
  it('keeps a redirection target bash does not treat as whitespace in the last segment', async () => {
    expect(split('cat f & echo x >\u00a0')).toEqual([
      'cat f',
      'echo x >\u00a0',
    ]);
    expect(split('cat f & echo x >\v')).toEqual(['cat f', 'echo x >\v']);
  });

  // The async operator. Everything after a bare `&` is a separate command that
  // the shell will run, so leaving it joined let one segment's allow rule
  // authorise whatever followed it.
  it.each([
    [
      'splits on the async operator',
      'git status & rm -rf /tmp/x',
      ['git status', 'rm -rf /tmp/x'],
    ],
    ['splits on repeated async operators', 'a & b & c', ['a', 'b', 'c']],
    ['splits a mix of long and bare operators', 'a && b & c', ['a', 'b', 'c']],
    [
      'drops the empty segment after a trailing async operator',
      'npm test &',
      ['npm test'],
    ],
    // Not a special case: an unquoted `&` in a URL really is the async
    // operator, and bash runs `b=2` as its own command.
    [
      'splits an unquoted URL query the way the shell does',
      'curl http://x?a=1&b=2',
      ['curl http://x?a=1', 'b=2'],
    ],
  ])('%s', async (_title, command, parts) => {
    expect(split(command)).toEqual(parts);
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
    expect(split(command)).toEqual([command]);
  });

  it.each([["echo 'x & y'"], ['echo "x & y"']])(
    'does not split %s, where & is quoted',
    async (command) => {
      expect(split(command)).toEqual([command]);
    },
  );

  // #11851: bash separates words only on space, tab and newline, so in
  // `echo x >\r& rm …` the `\r` (likewise `\v`, `\f`, `\u00a0`) is the redirect
  // target and `&` the async operator: two commands. Skipping those four as
  // whitespace kept one segment, so the first allow rule covered the second.
  // Titles use the escaped spelling: raw characters are invisible in a
  // terminal, and a `\v` or `\f` collapses a line break in the JUnit XML.
  it.each([
    ['\\r', 'echo x >\r& rm -rf /tmp/x', 'echo x >\r'],
    ['\\v', 'echo x >\v& rm -rf /tmp/x', 'echo x >\v'],
    ['\\f', 'echo x >\f& rm -rf /tmp/x', 'echo x >\f'],
    ['\\u00a0', 'echo x >\u00a0& rm -rf /tmp/x', 'echo x >\u00a0'],
    // Spaced variant: real separators around the non-IFS character.
    ['\\r (spaced)', 'echo x > \r & rm -rf /tmp/x', 'echo x > \r'],
  ])(
    'splits a command with %s between the > and the &',
    async (_label, command, first) => {
      // The character is the redirect target, so it stays: trimming drops only
      // what bash's lexer drops, not `String.prototype.trim`'s wider set.
      expect(split(command)).toEqual([first, 'rm -rf /tmp/x']);
    },
  );

  // A `\n` terminator drops the `\r` of a CRLF pair with it, so a
  // Windows-pasted script still splits and still trims — unless that `\r` *is*
  // the whole redirection target of the line, which bash names the file after.
  it.each([
    [
      'a plain CRLF line ending',
      'echo x\r\nrm -rf /tmp/x',
      ['echo x', 'rm -rf /tmp/x'],
    ],
    [
      'a CR that is the whole redirect target',
      'echo x >\r\necho y',
      ['echo x >\r', 'echo y'],
    ],
    [
      'a CR target on a command that takes arguments',
      'cat >\r\necho hi',
      ['cat >\r', 'echo hi'],
    ],
  ])('splits on a newline with %s', async (_label, command, parts) => {
    expect(split(command)).toEqual(parts);
  });

  // Over-correction guard: the longer operators must keep winning over the
  // bare `&`, so these two pass both before and after the change.
  it.each([
    ['a && b', ['a', 'b']],
    ['a |& b', ['a', 'b']],
  ])('keeps %s splitting on the longer operator', async (command, expected) => {
    expect(split(command)).toEqual(expected);
  });

  // The backward redirection scan must respect escaping: `\>` is a literal
  // argument, so bash backgrounds the `echo` and runs the `rm`; reading it as
  // a redirection kept one segment and the `echo` allow rule covered the `rm`.
  it.each([
    ['echo a \\> & rm -rf /tmp/x', ['echo a \\>', 'rm -rf /tmp/x']],
    ['echo a \\< & rm -rf /tmp/x', ['echo a \\<', 'rm -rf /tmp/x']],
  ])('splits %s, where the redirection is escaped', async (command, parts) => {
    expect(split(command)).toEqual(parts);
  });

  it('keeps an escaped backslash before a real redirection unsplit', async () => {
    // Two backslashes are a literal backslash, so the `>` really is a
    // redirection and the `&` really does duplicate a descriptor.
    expect(split('echo a \\\\>& 2')).toEqual(['echo a \\\\>& 2']);
  });

  // Inside `$(( … ))` / `(( … ))` a bare `&` is bitwise AND. Splitting there
  // produced two fragments that match no rule, so an otherwise allowed command
  // stopped matching its own allow rule.
  it.each([
    ['VAR=$(( FLAGS & MASK ))'],
    ['(( a & b ))'],
    ['echo $(( (x & y) + z ))'],
  ])('does not split %s, where & is arithmetic', async (command) => {
    expect(split(command)).toEqual([command]);
  });

  it('still splits a bare & that follows an arithmetic expansion', async () => {
    // Over-correction guard: the depth counter has to come back down.
    expect(split('echo $(( a & b )) & rm -rf /tmp/x')).toEqual([
      'echo $(( a & b ))',
      'rm -rf /tmp/x',
    ]);
  });

  // The backward scan runs off the front of the string: nothing precedes the
  // `&`, so it cannot be part of a redirection and is the async operator.
  it.each([['& echo hi'], ['   & echo hi']])(
    'treats the leading & in %s as the async operator',
    async (command) => {
      expect(split(command)).toEqual(['echo hi']);
    },
  );
});

// ─── splitCompoundCommandSegments ────────────────────────────────────────────

describe('splitCompoundCommandSegments', () => {
  const segments = splitCompoundCommandSegments;

  it('reports the operator that terminated each segment', async () => {
    expect(segments('a & b && c | d')).toEqual([
      { command: 'a', terminator: '&' },
      { command: 'b', terminator: '&&' },
      { command: 'c', terminator: '|' },
      { command: 'd', terminator: '' },
    ]);
  });

  it('reports an empty terminator for a single command', async () => {
    expect(segments('git status')).toEqual([
      { command: 'git status', terminator: '' },
    ]);
  });

  it('keeps the async terminator on a trailing background command', async () => {
    expect(segments('npm test &')).toEqual([
      { command: 'npm test', terminator: '&' },
    ]);
  });

  it('reports the terminator across a quote the two readings disagree on', async () => {
    // shell-semantics reads `&` as backgrounded, so the `cd` must not move the
    // cwd the write is attributed to — `&&` must, and the merge loop is what
    // decides which operator a boundary carries.
    expect(segments("cd 'a\\' & echo {} > settings.json")).toEqual([
      { command: "cd 'a\\'", terminator: '&' },
      { command: 'echo {} > settings.json', terminator: '' },
    ]);
    expect(segments("cd 'a\\' && echo {} > settings.json")).toEqual([
      { command: "cd 'a\\'", terminator: '&&' },
      { command: 'echo {} > settings.json', terminator: '' },
    ]);
  });
});

// ─── resolvePathPattern ──────────────────────────────────────────────────────

describe('resolvePathPattern', () => {
  const projectRoot = '/project';
  const cwd = '/project/subdir';
  const resolve = (pattern: string) =>
    resolvePathPattern(pattern, projectRoot, cwd);

  it('// prefix → absolute from filesystem root', async () => {
    expect(resolve('//Users/alice/secrets/**')).toBe('/Users/alice/secrets/**');
  });

  it('~/ prefix → relative to home directory', async () => {
    const result = resolve('~/Documents/*.pdf');
    expect(result).toContain('Documents/*.pdf');
    // The home dir starts with '/' on POSIX and may be 'C:/Users/foo' on
    // Windows; either way the result begins with the normalized home dir.
    const normalizedHome = os.homedir().replace(/\\/g, '/');
    expect(result.startsWith(normalizedHome)).toBe(true);
  });

  it('/ prefix → relative to project root (NOT absolute)', async () => {
    expect(resolve('/src/**/*.ts')).toBe('/project/src/**/*.ts');
  });

  it('./ prefix → relative to cwd', async () => {
    expect(resolve('./secrets/**')).toBe('/project/subdir/secrets/**');
  });

  it('no prefix → relative to cwd', async () => {
    expect(resolve('*.env')).toBe('/project/subdir/*.env');
  });

  it('/Users/alice/file is relative to project root, NOT absolute', async () => {
    expect(resolve('/Users/alice/file')).toBe('/project/Users/alice/file');
  });
});

// ─── matchesPathPattern ──────────────────────────────────────────────────────

describe('matchesPathPattern', () => {
  const projectRoot = '/project';
  const cwd = '/project';
  const matches = (pattern: string, filePath: string) =>
    matchesPathPattern(pattern, filePath, projectRoot, cwd);
  /** Canonical-mode match with `root` as both project root and cwd. */
  const matchesCanonical = (pattern: string, filePath: string, root: string) =>
    matchesPathPattern(pattern, filePath, root, root, 'canonical');

  it('matches dotfiles (e.g. .env)', async () => {
    expect(matches('.env', '/project/.env')).toBe(true);
    expect(matches('*.env', '/project/.env')).toBe(true);
  });

  // A line terminator is an ordinary word character to bash, so a redirect
  // target can end in one, and picomatch's `.`-based `**` body matches none of
  // the four JS line terminators. Unsubstituted, every row was `false` and a
  // `deny` silently became an `allow` (#11865).
  it.each([
    ['\\r', '/project/out\r'],
    ['\\n', '/project/out\n'],
    ['\\u2028', '/project/out '],
    ['\\u2029', '/project/out '],
    ['a whole-target \\r', '/project/\r'],
  ])('matches a path ending in %s against **', async (_label, filePath) => {
    expect(matches('//project/**', filePath)).toBe(true);
    expect(matches('./out*', filePath)).toBe(filePath !== '/project/\r');
  });

  it('still keeps * from crossing / for a line-terminator path', async () => {
    expect(matches('//project/*', '/project/a/out\r')).toBe(false);
    expect(matches('//project/*', '/project/out\r')).toBe(true);
  });

  it('** matches recursively across directories', async () => {
    const file = '/project/secrets/deep/nested/file.txt';
    expect(matches('./secrets/**', file)).toBe(true);
  });

  it('* matches single directory only', async () => {
    expect(matches('/src/*.ts', '/project/src/index.ts')).toBe(true);
    expect(matches('/src/*.ts', '/project/src/nested/index.ts')).toBe(false);
  });

  it('/docs/** matches under project root docs', async () => {
    expect(matches('/docs/**', '/project/docs/readme.md')).toBe(true);
    expect(matches('/docs/**', '/project/src/docs/readme.md')).toBe(false);
  });

  it('//tmp/scratch.txt matches absolute path', async () => {
    expect(matches('//tmp/scratch.txt', '/tmp/scratch.txt')).toBe(true);
  });

  it('does not match unrelated paths', async () => {
    expect(matches('./secrets/**', '/project/public/index.html')).toBe(false);
  });

  it('matches a path after resolving parent-directory traversal', () =>
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const nestedDir = path.join(root, 'workspace', 'nested');
      fs.mkdirSync(protectedDir);
      fs.mkdirSync(nestedDir, { recursive: true });
      const file = `${nestedDir}${path.sep}..${path.sep}..${path.sep}protected${path.sep}new.txt`;
      const pattern = `/${path.basename(protectedDir)}/**`;
      expect(matchesCanonical(pattern, file, root)).toBe(true);
    }));

  it('matches the canonical target of a symlinked path', () =>
    withTempRoot((root) => {
      const { link } = linkDir(root, { 'existing.txt': 'protected' });
      const file = path.join(link, 'existing.txt');
      expect(matchesPathPattern('/protected/**', file, root, root)).toBe(false);
      expect(matchesCanonical('/protected/**', file, root)).toBe(true);
    }));

  it('canonicalizes through a file that causes ENOTDIR', () =>
    withTempRoot((root) => {
      const { link } = linkDir(root, { 'config.json': '{}' });
      const file = path.join(link, 'config.json', 'nested.txt');
      expect(matchesCanonical('/protected/**', file, root)).toBe(true);
    }));

  it('canonicalizes a symlinked project root in restrictive rules', () =>
    withTempRoot((root) => {
      const realRoot = path.join(root, 'real');
      const linkedRoot = path.join(root, 'linked');
      const protectedDir = path.join(realRoot, 'protected');
      fs.mkdirSync(protectedDir, { recursive: true });
      fs.writeFileSync(path.join(protectedDir, 'file.txt'), 'protected');
      fs.symlinkSync(realRoot, linkedRoot, 'dir');
      const file = path.join(protectedDir, 'file.txt');
      expect(matchesCanonical('/protected/**', file, linkedRoot)).toBe(true);
    }));

  it('canonicalizes the nearest existing ancestor for a new path', () =>
    withTempRoot((root) => {
      const { link } = linkDir(root);
      const file = path.join(link, 'new', 'file.txt');
      expect(matchesCanonical('/protected/**', file, root)).toBe(true);
    }));

  it('matches the target of a dangling symlink', () =>
    withTempRoot((root) => {
      const protectedDir = path.join(root, 'protected');
      const target = path.join(protectedDir, 'new.txt');
      const link = path.join(root, 'link.txt');
      fs.mkdirSync(protectedDir);
      fs.symlinkSync(target, link, 'file');
      expect(matchesCanonical('/protected/**', link, root)).toBe(true);
    }));

  // Win32 normalizes `..` before traversing a reparse point; POSIX follows the
  // symlink first and applies `..` to its target.
  const targetRoot = process.platform === 'win32' ? 'project' : 'outside';
  const otherRoot = process.platform === 'win32' ? 'outside' : 'project';

  // Title names the platform assumption so a future realpath-based resolution
  // in matchesPathPattern is seen to break it, not silently re-asserted.
  it('preserves traversal semantics in a dangling symlink target (win32 collapses .. before the reparse point; POSIX follows the link first)', () =>
    withTempRoot((root) => {
      const projectDir = path.join(root, 'project');
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(projectDir);
      fs.mkdirSync(path.join(outsideDir, 'dir'), { recursive: true });
      fs.mkdirSync(path.join(outsideDir, 'safe'));
      const inner = path.join(projectDir, 'inner');
      fs.symlinkSync(path.join(outsideDir, 'dir'), inner, 'dir');
      const link = path.join(projectDir, 'link.txt');
      const up = `${path.sep}..${path.sep}`;
      fs.symlinkSync(`inner${up}safe${path.sep}new.txt`, link);
      expect(matchesCanonical(`/${targetRoot}/safe/**`, link, root)).toBe(true);
      expect(matchesCanonical(`/${otherRoot}/safe/**`, link, root)).toBe(false);
    }));

  it('resolves parent traversal after following a directory symlink (win32 collapses .. before the reparse point; POSIX follows the link first)', () =>
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
      const file = `${link}${path.sep}..${path.sep}safe${path.sep}file.txt`;
      expect(matchesCanonical(`/${targetRoot}/safe/**`, file, root)).toBe(true);
      expect(matchesCanonical(`/${otherRoot}/safe/**`, file, root)).toBe(false);
    }));

  it('preserves matching against the lexical symlink path', () =>
    withTempRoot((root) => {
      const { link } = linkDir(root);
      const file = path.join(link, 'new.txt');
      expect(matchesPathPattern('/link/**', file, root, root)).toBe(true);
    }));
});

// ─── matchesDomainPattern ────────────────────────────────────────────────────

describe('matchesDomainPattern', () => {
  const matches = matchesDomainPattern;

  it.each([
    ['matches exact domain', 'domain:example.com', 'example.com', true],
    [
      'does not match different domain',
      'domain:example.com',
      'notexample.com',
      false,
    ],
    ['is case-insensitive', 'domain:Example.COM', 'example.com', true],
    ['handles missing prefix', 'example.com', 'example.com', true],
  ])('%s', async (_title, pattern, domain, expected) => {
    expect(matches(pattern, domain)).toBe(expected);
  });

  it('matches subdomain', async () => {
    expect(matches('domain:example.com', 'sub.example.com')).toBe(true);
    expect(matches('domain:example.com', 'deep.sub.example.com')).toBe(true);
  });
});

// ─── matchesRule (unified) ───────────────────────────────────────────────────

describe('matchesRule', () => {
  it('simple tool-name rule matches any invocation', async () => {
    const rule = parseRule('ShellTool');
    expect(matchesRule(rule, 'run_shell_command')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
  });

  it('does not match a different tool', async () => {
    const rule = parseRule('ShellTool');
    expect(matchesRule(rule, 'read_file')).toBe(false);
  });

  it('specifier rule requires a command for shell tools', async () => {
    const rule = parseRule('Bash(git *)');
    expect(matchesRule(rule, 'run_shell_command')).toBe(false); // no command
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'echo hello')).toBe(false);
  });

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
    expect(matchesRule(rule, 'run_shell_command', 'git status')).toBe(true);
    expect(matchesRule(rule, 'run_shell_command', 'rm -rf /')).toBe(false);
  });

  it('Read rule matches grep_search, glob, list_directory', async () => {
    const rule = parseRule('Read');
    expect(matchesRule(rule, 'read_file')).toBe(true);
    expect(matchesRule(rule, 'grep_search')).toBe(true);
    expect(matchesRule(rule, 'glob')).toBe(true);
    expect(matchesRule(rule, 'list_directory')).toBe(true);
    expect(matchesRule(rule, 'edit')).toBe(false); // not a read tool
  });

  it('Edit rule matches edit, write_file, and notebook_edit', async () => {
    const rule = parseRule('Edit');
    expect(matchesRule(rule, 'edit')).toBe(true);
    expect(matchesRule(rule, 'write_file')).toBe(true);
    expect(matchesRule(rule, 'notebook_edit')).toBe(true);
    expect(matchesRule(rule, 'read_file')).toBe(false); // not an edit tool
  });

  it('Read with path specifier requires filePath', async () => {
    const rule = parseRule('Read(.env)');
    expect(matchesRule(rule, 'read_file')).toBe(false);
    expect(matchesPath(rule, 'read_file', '/project/.env')).toBe(true);
    expect(matchesPath(rule, 'read_file', '/project/other.txt')).toBe(false);
  });

  it('Edit path specifier matches write_file too', async () => {
    const rule = parseRule('Edit(/src/**/*.ts)');
    expect(matchesPath(rule, 'write_file', '/project/src/index.ts')).toBe(true);
    expect(matchesPath(rule, 'write_file', '/project/docs/readme.md')).toBe(
      false,
    );
  });

  it('Edit path specifier matches notebook_edit too', async () => {
    const rule = parseRule('Edit(/src/**/*.ipynb)');
    const inSrc = '/project/src/analysis.ipynb';
    const inDocs = '/project/docs/analysis.ipynb';
    expect(matchesPath(rule, 'notebook_edit', inSrc)).toBe(true);
    expect(matchesPath(rule, 'notebook_edit', inDocs)).toBe(false);
  });

  it('WebFetch domain specifier', async () => {
    const rule = parseRule('WebFetch(domain:example.com)');
    const fetches = (domain: string) =>
      matchesRule(rule, 'web_fetch', undefined, undefined, domain);
    expect(fetches('example.com')).toBe(true);
    expect(fetches('sub.example.com')).toBe(true);
    expect(fetches('other.com')).toBe(false);
    expect(matchesRule(rule, 'web_fetch')).toBe(false);
  });

  it('Agent literal specifier', async () => {
    const rule = parseRule('Agent(Explore)');
    // Agent is an alias for 'task'; specifier matches via the specifier field
    expect(matchesAgent(rule, undefined, 'Explore', 'task')).toBe(true);
    expect(matchesAgent(rule, undefined, 'Plan', 'task')).toBe(false);
    expect(matchesRule(rule, 'task')).toBe(false); // no specifier
  });

  it('MCP tool exact match', async () => {
    const rule = parseRule('mcp__puppeteer__puppeteer_navigate');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_click')).toBe(false);
  });

  it('matches a legacy dotted MCP rule against its provider-safe name', () => {
    const legacyName = 'mcp__zybio__literature.search_pubmed';
    const providerSafeName = normalizeToolNameForProvider(legacyName);

    expect(providerSafeName).not.toBe(legacyName);
    // Production supplies the tool's advertised `permissionAliases` with the
    // evaluation; for this name the legacy reduction is lossless, so the
    // alias IS the exact raw spelling the matcher compares literally
    // (#10199). Without the alias channel the registered name alone cannot
    // vouch for a legacy unsafe spelling.
    expect(
      matchesRule(
        parseRule(legacyName),
        providerSafeName,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [legacyName],
      ),
    ).toBe(true);
  });

  it('keeps exact provider-safe MCP permission matches collision-safe', () => {
    const dottedName = 'mcp__zybio__literature.search';
    const slashedName = 'mcp__zybio__literature/search';
    const dottedProviderName = normalizeToolNameForProvider(dottedName);
    const slashedProviderName = normalizeToolNameForProvider(slashedName);

    expect(dottedProviderName).not.toBe(slashedProviderName);
    expect(
      matchesRule(
        parseRule(dottedName),
        dottedProviderName,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [dottedName],
      ),
    ).toBe(true);
    // The negative arm threads the alias channel too. Unthreaded it returns
    // `false` for the same structural reason the positive arm does, so it would
    // not be comparing two aliased tools at all and the `.`-versus-`/`
    // invariant this test is named for would go unobserved: both raws sanitize
    // to the identical body `mcp__zybio__literature_search` and differ only in
    // the FNV hash, so admitting a reduced spelling to the comparison has to be
    // caught here.
    expect(
      matchesRule(
        parseRule(dottedName),
        slashedProviderName,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [slashedName],
      ),
    ).toBe(false);
  });

  it('MCP server-level match (2-part pattern)', async () => {
    const rule = parseRule('mcp__puppeteer');
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_navigate')).toBe(true);
    expect(matchesRule(rule, 'mcp__puppeteer__puppeteer_click')).toBe(true);
    expect(matchesRule(rule, 'mcp__other__tool')).toBe(false);
  });

  it('matches a legacy dotted MCP server rule against provider-safe names', () => {
    const rule = parseRule('mcp__zybio.db');

    // Production supplies the tool's own `permissionAliases` with the
    // evaluation; the alias carries the raw spelling the registered name
    // lost (#10199).
    expect(
      matchesRule(
        rule,
        normalizeToolNameForProvider('mcp__zybio.db__query_uniprot'),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ['mcp__zybio.db__query_uniprot'],
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ['mcp__zybio.db__query_uniprot'],
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
    expect(r.toolParamMatchers).toEqual([paramMatcher('model', 'opus')]);
  });

  it('parseRule extracts multiple key:value pairs', async () => {
    const r = parseRule('Agent(model:opus,type:code)');
    expect(r.toolParamMatchers).toEqual([
      paramMatcher('model', 'opus'),
      paramMatcher('type', 'code'),
    ]);
  });

  it('parseRule handles mixed specifier and param matchers', async () => {
    const r = parseRule('Agent(coder,model:opus)');
    expect(r.specifier).toBe('coder');
    expect(r.toolParamMatchers).toEqual([paramMatcher('model', 'opus')]);
  });

  it('parseRule supports wildcard in value pattern', async () => {
    const r = parseRule('Agent(model:*)');
    expect(r.toolParamMatchers).toEqual([paramMatcher('model', '*')]);
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
    expect(matchesAgent(rule, { model: 'opus' })).toBe(true);
    expect(matchesAgent(rule, { model: 'sonnet' })).toBe(false);
  });

  it('matchesRule fails when toolParams missing for param matcher rule', async () => {
    const rule = parseRule('Agent(model:opus)');
    expect(matchesRule(rule, 'agent')).toBe(false);
  });

  it('matchesRule supports wildcard value pattern', async () => {
    const rule = parseRule('Agent(model:*)');
    expect(matchesAgent(rule, { model: 'opus' })).toBe(true);
    expect(matchesAgent(rule, { model: 'sonnet' })).toBe(true);
    expect(matchesRule(rule, 'agent')).toBe(false); // no toolParams
  });

  it('matchesRule requires all param matchers to match', async () => {
    const rule = parseRule('Agent(model:opus,type:code)');
    expect(matchesAgent(rule, { model: 'opus', type: 'code' })).toBe(true);
    expect(matchesAgent(rule, { model: 'opus', type: 'chat' })).toBe(false);
    expect(matchesAgent(rule, { model: 'opus' })).toBe(false); // missing 'type' param
  });

  it('matchesRule handles mixed specifier and param matchers', async () => {
    const rule = parseRule('Agent(coder,model:opus)');
    expect(matchesAgent(rule, { model: 'opus' }, 'coder')).toBe(true);
    expect(matchesAgent(rule, { model: 'sonnet' }, 'coder')).toBe(false); // param mismatch
    expect(matchesAgent(rule, { model: 'opus' }, 'explore')).toBe(false); // specifier mismatch
  });

  it('parseRule does not extract key:value for MCP tools (backward compat)', async () => {
    const r = parseRule('mcp__server__tool(server_name:myserver)');
    expect(r.toolName).toBe('mcp__server__tool');
    expect(r.specifier).toBe('server_name:myserver');
    expect(r.toolParamMatchers).toBeUndefined();
  });

  it('matchesRule supports partial wildcard patterns', async () => {
    const rule = parseRule('Agent(model:op*)');
    expect(matchesAgent(rule, { model: 'opus' })).toBe(true);
    expect(matchesAgent(rule, { model: 'opera' })).toBe(true);
    expect(matchesAgent(rule, { model: 'sonnet' })).toBe(false);
  });

  it('matchesRule handles multi-wildcard patterns without ReDoS', async () => {
    const rule = parseRule('Agent(prompt:*x*x*x*x*x*y)');
    // Must not hang (ReDoS), and returns false for non-matching input
    expect(matchesAgent(rule, { prompt: 'a'.repeat(1000) })).toBe(false);
    expect(matchesAgent(rule, { prompt: 'xaxaxaxaxay' })).toBe(true);
  });

  it('matchesRule coerces number values to string for matching', async () => {
    const rule = parseRule('Agent(count:42)');
    expect(matchesAgent(rule, { count: 42 })).toBe(true);
    expect(matchesAgent(rule, { count: 43 })).toBe(false);
  });
});

// ─── PermissionManager ──────────────────────────────────────────────────────

describe('PermissionManager', () => {
  let pm: PermissionManager;
  const registration = (toolName: string) =>
    pm.getToolRegistrationStatus(toolName);
  const enabled = (toolName: string) => pm.isToolEnabled(toolName);

  it('does not implicitly allow read-only shell commands under internal sandbox policy', async () => {
    const manager = new PermissionManager({
      ...makeConfig(),
      getShellExecutionSandbox: () => ({}),
    });
    manager.initialize();
    expect(await manager.isCommandAllowed('git status && ls', '/project')).toBe(
      'ask',
    );
  });

  describe('basic rule evaluation', () => {
    beforeEach(() => {
      pm = makePm({
        permissionsAllow: ['ReadFileTool', 'Bash(git *)'],
        permissionsAsk: ['WriteFileTool'],
        permissionsDeny: ['ShellTool'],
      });
    });

    it.each([
      ['returns deny for a denied tool', 'run_shell_command', 'deny'],
      ['returns ask for an ask-rule tool', 'write_file', 'ask'],
      ['returns allow for an allow-rule tool', 'read_file', 'allow'],
      // 'glob' is covered by ReadFileTool via the Read meta-category, so
      // use a tool not in any rule or meta-category.
      ['returns default for unmatched tool', 'agent', 'default'],
    ])('%s', async (_title, toolName, expected) => {
      expect(await pm.evaluate({ toolName })).toBe(expected);
    });

    it('refuses a legacy truncated MCP permission alias on an exact entry', async () => {
      // Built through the real producer: the 31-character server key pushes
      // the raw identity past the 63-character budget, so registration
      // truncates and hashes, and the legacy reduction middle-truncates at
      // slice(0, 28) — keeping only the key's first 23 characters. A cut
      // that reached the server segment vouches for no server, so the
      // producer advertises only the exact raw identity (R12-1), and a
      // persisted allow in the truncated spelling fails closed instead of
      // auto-approving the tool; see mcp-server-rule-collision.test.ts
      // (R8-1) for the two-servers-one-spelling witnesses.
      const tool = prodTool(
        'weather-forecast-server-premium',
        'get_extended_forecast_for_next_week',
      );
      const legacyName = generateLegacyMcpToolName(
        'mcp__weather-forecast-server-premium__get_extended_forecast_for_next_week',
      );
      expect(tool.permissionAliases).not.toContain(legacyName);
      const pm2 = new PermissionManager(
        makeConfig({ permissionsAllow: [legacyName] }),
      );
      pm2.initialize();

      expect(
        await pm2.evaluate({
          toolName: tool.name,
          toolAliases: tool.permissionAliases,
        }),
      ).toBe('default');

      // Control: the same rule in the exact raw identity still names it.
      const rawPm = new PermissionManager(
        makeConfig({
          permissionsAllow: [
            'mcp__weather-forecast-server-premium__get_extended_forecast_for_next_week',
          ],
        }),
      );
      rawPm.initialize();
      expect(
        await rawPm.evaluate({
          toolName: tool.name,
          toolAliases: tool.permissionAliases,
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

      // Production supplies the tool's own `permissionAliases` with the
      // evaluation; the alias carries the raw spelling the registered name
      // lost (#10199). For this name the legacy reduction is lossless, so
      // the alias equals the raw spelling.
      expect(
        await pm2.evaluate({
          toolName: providerSafeName,
          toolAliases: [legacyName],
        }),
      ).toBe('deny');
    });

    it('deny takes precedence over ask and allow', async () => {
      const pm2 = makePm({
        permissionsAllow: ['run_shell_command'],
        permissionsAsk: ['run_shell_command'],
        permissionsDeny: ['run_shell_command'],
      });
      const ctx = { toolName: 'run_shell_command' };
      expect(await pm2.evaluate(ctx)).toBe('deny');
    });

    it('ask takes precedence over allow', async () => {
      const pm2 = makePm({
        permissionsAllow: ['write_file'],
        permissionsAsk: ['write_file'],
      });
      expect(await pm2.evaluate({ toolName: 'write_file' })).toBe('ask');
    });
  });

  describe('command-level evaluation', () => {
    beforeEach(() => {
      pm = makePm({
        permissionsAllow: ['Bash(git *)'],
        permissionsDeny: ['Bash(rm *)'],
      });
    });

    it.each([
      ['allows a matching allowed command', 'git status', 'allow'],
      ['denies a matching denied command', 'rm -rf /', 'deny'],
    ])('%s', async (_title, command, expected) => {
      expect(await pm.evaluate(sh(command))).toBe(expected);
    });

    it('resolves default to allow for readonly commands, ask for others', async () => {
      expect(await pm.evaluate(sh('echo hello'))).toBe('allow');
      expect(await pm.evaluate(sh('npm install'))).toBe('ask');
    });

    // Issue #4093: command substitution must never get a hard 'deny' from
    // resolveDefaultPermission. The L4 default branch used to deny any command
    // with $(), backticks, <() or >(), which YOLO could not override and which
    // fired only when hasRelevantRules() was true (e.g. another compound part
    // matched an unrelated allow rule); standalone ones got 'ask' from L3.
    // Both shapes must now resolve to 'ask', whatever the rules.
    describe('command substitution (issue #4093)', () => {
      it.each([
        // No 'python3' rule is configured, but the substitution must not
        // trip a deny — the only acceptable answer is 'ask'.
        [
          'a standalone command with $() substitution',
          'python3 -c "print($(echo hello))"',
        ],
        // The #4093 scenario: `git status` matches `Bash(git *)`, so full
        // evaluation runs; `python3 -c "..."` matches no rule and reaches
        // resolveDefaultPermission, whose old 'deny' made the most-restrictive
        // combine deny the whole compound; now it is 'ask'.
        [
          'a compound command where one sub-command matches an allow rule and another contains $()',
          'git status && python3 -c "print($(echo hello))"',
        ],
        ['backtick command substitution', 'echo `whoami`'],
        ['process substitution <()', 'diff <(ls /a) <(ls /b)'],
        ['>() output process substitution', 'echo data > >(tee log.txt)'],
      ])('returns ask for %s', async (_label, command) => {
        expect(await pm.evaluate(sh(command))).toBe('ask');
      });

      it('still honors explicit deny rules over substitution-bearing commands', async () => {
        // The 'ask' from substitution must never downgrade a real deny rule.
        expect(await pm.evaluate(sh('rm -rf "$(pwd)/build"'))).toBe('deny');
      });
    });

    it('isCommandAllowed delegates to evaluate', async () => {
      expect(await pm.isCommandAllowed('git commit')).toBe('allow');
      expect(await pm.isCommandAllowed('rm -rf /')).toBe('deny');
      // 'ls' is readonly, resolves to 'allow' when no rule matches
      expect(await pm.isCommandAllowed('ls')).toBe('allow');
    });

    // The manager's own cwd is the '/project' default; the invocation's wins.
    it('resolves shell virtual file operations relative to the explicit cwd', async () => {
      const pm2 = makePm({ permissionsAllow: ['Read(./subdir/secret.txt)'] });
      const ctx = sh('cat ./secret.txt', '/project/subdir');
      expect(await pm2.evaluate(ctx)).toBe('allow');
    });

    it('applies relative virtual file rules using the shell invocation cwd', async () => {
      const pm2 = makePm({ permissionsDeny: ['Read(./secret.txt)'] });
      const ctx = sh('cat ./secret.txt', '/project/subdir');
      expect(await pm2.evaluate(ctx)).toBe('deny');
    });
  });

  describe('monitor command-level evaluation', () => {
    it('Monitor(...) allow rule matches monitor invocations', async () => {
      const pm2 = makePm({ permissionsAllow: ['Monitor(tail -f *)'] });
      expect(await pm2.evaluate(mon('tail -f /var/log/app.log'))).toBe('allow');
    });

    it('Monitor(...) allow rule matches wrapped monitor invocations', async () => {
      const pm2 = makePm({ permissionsAllow: ['Monitor(tail -f *)'] });
      const command = `/bin/bash --noprofile -c 'tail -f /var/log/app.log &'`;
      expect(await pm2.evaluate(mon(command))).toBe('allow');
    });

    it('asks by default for wrapped commands with environment prefixes', async () => {
      const pm2 = makePm({});
      const command = String.raw`FOO="bar baz" /bin/bash --noprofile -c 'tail -f /var/log/app.log &'`;
      expect(await pm2.evaluate(mon(command))).toBe('ask');
    });

    it('Monitor(...) deny rule sees shell wrapper suffix commands', async () => {
      const pm2 = makePm({
        permissionsAllow: ['Monitor(tail -f *)'],
        permissionsDeny: ['Monitor(rm *)'],
      });
      const command = `/bin/bash -c 'tail -f /var/log/app.log' && rm -rf /tmp/owned`;
      expect(await pm2.evaluate(mon(command))).toBe('deny');
    });

    it('Monitor(...) deny rule blocks monitor invocations', async () => {
      const pm2 = makePm({ permissionsDeny: ['Monitor(rm *)'] });
      expect(await pm2.evaluate(mon('rm -rf /'))).toBe('deny');
    });

    it('Monitor approval does NOT allow run_shell_command', async () => {
      const pm2 = makePm({ permissionsAllow: ['Monitor(npm *)'] });
      expect(await pm2.evaluate(sh('npm install'))).not.toBe('allow');
    });

    it('Bash approval also allows monitor (shell rules cover monitor)', async () => {
      const pm2 = makePm({ permissionsAllow: ['Bash(npm *)'] });
      expect(await pm2.evaluate(mon('npm install'))).toBe('allow');
    });

    it('Bash deny rule blocks equivalent monitor command', async () => {
      const pm2 = makePm({ permissionsDeny: ['Bash(rm *)'] });
      expect(await pm2.evaluate(mon('rm -rf /'))).toBe('deny');
    });

    it('resolves default to allow for readonly monitor commands', async () => {
      const pm2 = makePm({});
      expect(await pm2.evaluate(mon('echo hello'))).toBe('allow');
    });

    it('applies relative virtual file deny rules using the monitor cwd', async () => {
      // As for run_shell_command above: a monitor's explicit `directory`
      // (forwarded as `cwd` by buildPermissionCheckContext) must anchor
      // relative deny rules, not the config cwd, or switching the monitor's
      // working directory silently bypasses `Read(./secret.txt)`.
      const pm2 = makePm({ permissionsDeny: ['Read(./secret.txt)'] });
      const ctx = mon('cat ./secret.txt', '/project/subdir');
      expect(await pm2.evaluate(ctx)).toBe('deny');
    });

    it('resolves monitor virtual file allow rules relative to the explicit cwd', async () => {
      const pm2 = makePm({ permissionsAllow: ['Read(./subdir/secret.txt)'] });
      const ctx = mon('cat ./secret.txt', '/project/subdir');
      expect(await pm2.evaluate(ctx)).toBe('allow');
    });
  });

  describe('compound command evaluation', () => {
    const echoRm = {
      permissionsAllow: ['Bash(echo *)'],
      permissionsDeny: ['Bash(rm *)'],
    };

    it('keeps Git after a directory change in the confirmation boundary', async () => {
      pm = makePm({ permissionsAllow: ['Bash(cd *)'] });
      const ctx = sh('cd /tmp && git status', process.cwd());
      expect(await pm.evaluate(ctx)).toBe('ask');
    });

    it('all sub-commands allowed → allow', async () => {
      pm = makePm({
        permissionsAllow: ['Bash(safe-cmd *)', 'Bash(one-cmd *)'],
      });
      const ctx = sh('safe-cmd arg1 && one-cmd arg2');
      expect(await pm.evaluate(ctx)).toBe('allow');
    });

    it('one sub-command unmatched (non-readonly) → ask (resolved from default)', async () => {
      pm = makePm({ permissionsAllow: ['Bash(safe-cmd *)'] });
      // 'two-cmd' is unknown/non-readonly, so its default permission is 'ask'
      expect(await pm.evaluate(sh('safe-cmd && two-cmd'))).toBe('ask');
    });

    it('one sub-command denied → deny', async () => {
      pm = makePm({
        permissionsAllow: ['Bash(safe-cmd *)'],
        permissionsDeny: ['Bash(evil-cmd *)'],
      });
      expect(await pm.evaluate(sh('safe-cmd && evil-cmd rm-all'))).toBe('deny');
    });

    it('one sub-command ask + one allow → ask', async () => {
      pm = makePm({
        permissionsAllow: ['Bash(git *)'],
        permissionsAsk: ['Bash(npm *)'],
      });
      expect(await pm.evaluate(sh('git status && npm publish'))).toBe('ask');
    });

    it('pipe compound: all matched → allow', async () => {
      pm = makePm({ permissionsAllow: ['Bash(git *)', 'Bash(grep *)'] });
      expect(await pm.evaluate(sh('git log | grep fix'))).toBe('allow');
    });

    it('pipe compound: second unmatched but readonly → allow (resolved from default)', async () => {
      pm = makePm({ permissionsAllow: ['Bash(git *)'] });
      // 'grep' is a readonly command, so its default permission is 'allow'
      expect(await pm.evaluate(sh('git log | grep fix'))).toBe('allow');
    });

    it('semicolon compound: deny in second → deny', async () => {
      pm = makePm(echoRm);
      expect(await pm.evaluate(sh('echo hello; rm -rf /'))).toBe('deny');
    });

    it.each<[string, string[], string]>([
      ["echo 'a\\' ; rm -rf /tmp/x", [], 'ask'],
      ["echo 'a\\' ; rm -rf /tmp/x", ['Bash(rm *)'], 'deny'],
      ["echo $'a\\'' ; rm -rf /tmp/x", [], 'ask'],
      ["echo $'a\\'' ; rm -rf /tmp/x", ['Bash(rm *)'], 'deny'],
      ["echo 'c\\' $'a\\'' ; rm -rf /tmp/x", [], 'ask'],
      ["echo 'c\\' $'a\\'' ; rm -rf /tmp/x", ['Bash(rm *)'], 'deny'],
      ["echo $\\\n'a\\'' ; rm -rf /tmp/x", ['Bash(rm *)'], 'deny'],
      ["echo done # note 'a\\''\nrm -rf /tmp/x", ['Bash(rm *)'], 'deny'],
      [
        "cat <<EOF\necho safe 'a\\''\nEOF\nrm -rf /tmp/x",
        ['Bash(rm *)'],
        'deny',
      ],
      [
        "echo done # note 'a\\''\necho {} > .qwen/settings.json",
        ['Write(.qwen/settings.json)'],
        'deny',
      ],
      // bash backgrounds the `cd`, so the write lands in the cwd — the
      // permissions file itself. main sees one segment and no write at all.
      [
        "cd 'a\\' & echo {} > .qwen/settings.json",
        ['Write(.qwen/settings.json)'],
        'deny',
      ],
      ["echo 'a\\'' ; rm x'", ['Bash(rm *)'], 'deny'],
    ])('%j with deny %j is %s', async (command, deny, expected) => {
      pm = makePm({
        permissionsAllow: ['Bash(echo *)', 'Bash(cat *)'],
        permissionsDeny: deny,
        cwd: '/repo',
        projectRoot: '/repo',
      });
      expect(await pm.evaluate(sh(command, '/repo'))).toBe(expected);
    });

    // The declared tradeoff: bash runs one command (all from `#` on is a
    // comment), but the pre-fix reading splits inside it, so `Bash(rm *)`
    // refuses a commit with no visible `rm`. Only shapes that bail out of
    // #12096's comment fast path (a newline, or `monitor`) still reach it; the
    // single-line spelling stays one segment for `Bash(...)` rules: allowed.
    it.each<[string, string, string]>([
      [
        'run_shell_command',
        "git commit -m 'x' # saved to 'C:\\'\nrm draft",
        'deny',
      ],
      ['monitor', "git commit -m 'x' # saved to 'C:\\' ; rm draft", 'deny'],
      [
        'run_shell_command',
        "git commit -m 'x' # saved to 'C:\\' ; rm draft",
        'allow',
      ],
    ])('%s %j is %s', async (toolName, command, expected) => {
      pm = makePm({
        permissionsAllow: ['Bash(git *)'],
        permissionsDeny: ['Bash(rm *)'],
      });
      expect(await pm.evaluate({ toolName, command })).toBe(expected);
    });

    it('|| compound: all allowed → allow', async () => {
      pm = makePm({ permissionsAllow: ['Bash(git *)', 'Bash(echo *)'] });
      expect(await pm.evaluate(sh('git push || echo failed'))).toBe('allow');
    });

    it('operators inside quotes: treated as single command', async () => {
      pm = makePm({ permissionsAllow: ['Bash(echo *)'] });
      expect(await pm.evaluate(sh("echo 'a && b'"))).toBe('allow');
    });

    it.each([
      ['bash', `echo 'a' # comment ; rm -rf /tmp/x`, 'allow'],
      ['cmd', `echo 'a' # comment ; rm -rf /tmp/x`, 'deny'],
      ['powershell', `echo 'a' # comment ; rm -rf /tmp/x`, 'deny'],
      ['bash', 'echo $(date) # comment ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo hi # comment\nrm -rf /tmp/x', 'deny'],
      ['bash', 'echo hi ; rm -rf /tmp/x # comment ; echo ignored', 'deny'],
      ['bash', 'echo a#b ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo a\v# comment ; rm -rf /tmp/x', 'deny'],
      ['bash', '# noop ; rm -rf /tmp/x', 'deny'],
      // Leading whitespace must not make the line one comment-only segment:
      // bash runs nothing either way, but collapsing leaves no text for a
      // `Bash(...)` rule to match. The guard is about the line, not the `#` the
      // scan stopped at, so a second word-start `#` must not collapse either:
      // testing `command.slice(0, i).trim() !== ''` instead keeps only the
      // whitespace-led spelling and lets `# noop # ; rm -rf /tmp/x` through.
      ['bash', ' # noop ; rm -rf /tmp/x', 'deny'],
      ['bash', '\t# noop ; rm -rf /tmp/x', 'deny'],
      ['bash', '# noop # ; rm -rf /tmp/x', 'deny'],
      ['bash', ' # a # b ; rm -rf /tmp/x', 'deny'],
      ['bash', "echo 'a # b' ; rm -rf /tmp/x", 'deny'],
      ['bash', 'echo "a # b" ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo hi > /tmp/o # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo hi | tee /tmp/o # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo hi # c\r; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo hi\t# comment ; rm -rf /tmp/x', 'allow'],
      ['bash', ' echo hi # comment ; rm -rf /tmp/x', 'allow'],
      // `\`, `$` and the backtick are their own disjuncts on the bail line
      // (permission-manager.ts:102), not in the ';&|(){}<>' literal, so each
      // needs a row where it is the FIRST guard the scan meets; otherwise
      // deleting it leaves the suite green (`echo $(date)` cannot pin `$`: the
      // scan still bails at `(`). The backtick row is the security-relevant
      // one: without the bail, `allow` covers a substitution that executes.
      ['bash', 'echo `whoami` # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo $HOME # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo a\\ b # c ; rm -rf /tmp/x', 'deny'],
      // Same standard for the other single-deletion survivors: the bail
      // literal's `&`, `<`, `(`, `)`, `{`, `}` and the quote cross-checks
      // `&& !inDouble` / `&& !inSingle`. Each row makes its target the FIRST
      // guard the scan meets and carries no OTHER bail character before its
      // `#`, so deleting that one disjunct changes the verdict; hence the
      // unbalanced `(` and `{` probes (a closing counterpart keeps it bailing).
      ['bash', 'echo hi && rm -rf /tmp/x # c', 'deny'],
      ['bash', 'sort < /etc/passwd # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo (a # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo {a # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo a} # c ; rm -rf /tmp/x', 'deny'],
      ['bash', 'echo x) # c ; rm -rf /tmp/x', 'deny'],
      // Mixed quote kinds ahead of the `#`, and the `;` deliberately after it:
      // the intact scan returns at the `#`, while a scan missing either
      // cross-check latches a quote, never sees the `#`, and bails at the `;`.
      ['bash', `echo "don't" # c ; rm -rf /tmp/x`, 'allow'],
      ['bash', `echo 'a"b' # c ; rm -rf /tmp/x`, 'allow'],
      // Characterization rows for #11815's measured table. Bash runs only the
      // `echo`, but `\` bails the fast path and the comment-blind splitter
      // closes `'a\'` as bash does, splitting at the in-comment separator: a
      // fail-closed `ask` where `main` read the quote as unterminated: `allow`.
      ['bash', "echo 'a\\' # note: use ; carefully", 'ask'],
      ['bash', "echo 'a\\' # trailing && touch /tmp/x", 'ask'],
      ['bash', "echo 'a\\' # trailing | touch /tmp/x", 'ask'],
    ] as const)(
      'handles comments conservatively for %s: %s',
      async (shell, command, expected) => {
        pm = makeShellPm(shell, echoRm);
        expect(await pm.evaluate(sh(command))).toBe(expected);
      },
    );

    // Row 6 of the same measured table, kept out because its `git` segment
    // cannot match the table's `Bash(echo *)` rule (the verdict would be the
    // read-only default `ask`). The split is asserted too: a bare `echo B` is
    // also `allow`, so the verdict alone stays green if the apostrophe in
    // `don't` ever stopped masking the `;`.
    it("keeps `git status # don't ; echo B` one allowed segment", async () => {
      const command = "git status # don't ; echo B";
      expect(splitCompoundCommand(command)).toEqual([command]);
      pm = makeShellPm('bash', { permissionsAllow: ['Bash(git *)'] });
      expect(await pm.evaluate(sh(command))).toBe('allow');
    });

    // The comment fast path is sound only when the scanned string is what the
    // shell executes: true for run_shell_command, not for monitor, where
    // normalizePermissionContext() analyses the quote-stripped `safetyCommand`
    // but spawns `spawnCommand`, so a `#` inside the wrapper's inner quotes
    // would swallow a separator the spawned command really runs.
    it.each([
      [
        "bash -c 'echo hi # done' ; rm -rf /tmp/x",
        ['Bash(echo *)'],
        ['Bash(rm *)'],
      ],
      ['cmd /c "dir # & del C:\\temp\\x"', ['Bash(dir *)'], ['Bash(del *)']],
    ] as const)(
      'keeps splitting monitor commands whose comment is only apparent: %s',
      async (command, permissionsAllow, permissionsDeny) => {
        pm = makeShellPm('bash', {
          permissionsAllow: [...permissionsAllow],
          permissionsDeny: [...permissionsDeny],
        });
        expect(await pm.evaluate(mon(command))).toBe('deny');
      },
    );

    // `splitCommandForRules` must drive every Bash-rule consumer, not just
    // `evaluate()`: each of the three below re-splits on its own path, and
    // reverting one to `splitCompoundCommand` silently disagrees with
    // `evaluate()` (citing a deny it never applied, or hiding "Always allow"
    // for an allowed command). Each pairs the bash arm (comment recognised →
    // one segment) with the cmd arm (no Bash comments → conservative split).
    const commented = `echo 'a' # comment ; rm -rf /tmp/x`;
    const denyRm = { permissionsDeny: ['Bash(rm *)'] };

    it('findMatchingDenyRule does not cite a rule the comment hid', () => {
      const ctx = sh(commented);
      expect(
        makeShellPm('bash', denyRm).findMatchingDenyRule(ctx),
      ).toBeUndefined();
      expect(makeShellPm('cmd', denyRm).findMatchingDenyRule(ctx)).toBe(
        'Bash(rm *)',
      );
    });

    it('hasRelevantRules drops the segment the comment hid', () => {
      const ctx = sh(commented);
      expect(makeShellPm('bash', denyRm).hasRelevantRules(ctx)).toBe(false);
      expect(makeShellPm('cmd', denyRm).hasRelevantRules(ctx)).toBe(true);
    });

    it('hasMatchingAskRule does not ask for a rule the comment hid', () => {
      const ctx = sh(commented);
      const ask = { permissionsAsk: ['Bash(rm *)'] };
      expect(makeShellPm('bash', ask).hasMatchingAskRule(ctx)).toBe(false);
      expect(makeShellPm('cmd', ask).hasMatchingAskRule(ctx)).toBe(true);
    });

    // The three above pin the rule lookups; this pins their decision. Under a
    // deny-only config the collapse demotes a hard `deny` to the default `ask`,
    // as #11815 asks (bash runs only the pre-comment `echo`, so an `rm` rule
    // has nothing to match), and gating it away would break the allow+deny arm
    // that must stay `allow`. Pinned because `ask` is a behaviour change: its
    // dialog still segments with the comment-blind splitter, listing the
    // never-run `rm -rf /tmp/x` and proposing `Bash(rm *)` (see
    // docs/design/safe-bash-comment-splitting.md, "Risks and constraints").
    // Reverting `splitCommandForRules` reds the bash arm back to `deny`.
    it('deny-only config: the commented command asks instead of denying', async () => {
      const ctx = sh(commented);
      expect(await makeShellPm('bash', denyRm).evaluate(ctx)).toBe('ask');
      expect(await makeShellPm('cmd', denyRm).evaluate(ctx)).toBe('deny');
    });

    // The verdict, not the split, is the guarantee: before the fix the scan
    // read these characters as whitespace, so `&` was no operator, the command
    // was one segment, and the `echo` allow rule covered the `rm`.
    it.each([
      ['\\r', 'echo x >\r& rm -rf /tmp/x'],
      ['\\v', 'echo x >\v& rm -rf /tmp/x'],
      ['\\f', 'echo x >\f& rm -rf /tmp/x'],
      // The NBSP verdict row: the path-deny test below is `deny` even without
      // the splitter fix (base never splits the NBSP payload, and the write op
      // is attributed either way), so this row discriminates for `\u00a0`:
      // `allow` at the merge base, `deny` here.
      ['\\u00a0', 'echo x >\u00a0& rm -rf /tmp/x'],
    ])(
      'compound with %s inside the redirect target: deny in second → deny',
      async (_label, command) => {
        pm = makePm(echoRm);
        expect(await pm.evaluate(sh(command))).toBe('deny');
      },
    );

    it('three-part compound: all must pass', async () => {
      pm = makePm({
        permissionsAllow: ['Bash(git *)', 'Bash(npm *)', 'Bash(echo *)'],
      });
      const ctx = sh('git add . && npm test && echo done');
      expect(await pm.evaluate(ctx)).toBe('allow');
    });

    it('three-part compound: one unmatched (non-readonly) → ask (resolved from default)', async () => {
      pm = makePm({ permissionsAllow: ['Bash(git *)', 'Bash(echo *)'] });
      // 'npm test' is not readonly, so its default permission is 'ask'
      const ctx = sh('git add . && npm test && echo done');
      expect(await pm.evaluate(ctx)).toBe('ask');
    });

    it('isCommandAllowed also handles compound commands', async () => {
      pm = makePm({
        permissionsAllow: ['Bash(safe-cmd *)', 'Bash(one-cmd *)'],
        permissionsDeny: ['Bash(evil-cmd *)'],
      });
      const allowed = (command: string) => pm.isCommandAllowed(command);
      expect(await allowed('safe-cmd a && one-cmd b')).toBe('allow');
      // 'unknown-cmd' is not readonly, resolves to 'ask'
      expect(await allowed('safe-cmd a && unknown-cmd')).toBe('ask');
      expect(await allowed('safe-cmd a && evil-cmd b')).toBe('deny');
    });
  });

  describe('file path evaluation', () => {
    beforeEach(() => {
      pm = makePm({
        permissionsDeny: ['Read(.env)', 'Edit(/src/generated/**)'],
        permissionsAllow: ['Read(/docs/**)'],
      });
    });
    const file = (toolName: string, filePath: string) => ({
      toolName,
      filePath,
    });

    it('denies reading a denied file', async () => {
      const ctx = file('read_file', '/project/.env');
      expect(await pm.evaluate(ctx)).toBe('deny');
    });

    it('denies editing in a denied directory', async () => {
      const ctx = file('edit', '/project/src/generated/code.ts');
      expect(await pm.evaluate(ctx)).toBe('deny');
    });

    it('denies an equivalent path containing parent traversal', async () => {
      const ctx = file('edit', '/project/work/../src/generated/code.ts');
      expect(await pm.evaluate(ctx)).toBe('deny');
    });

    it('canonicalizes restrictive rules without widening allow rules', () =>
      withTempRoot(async (root) => {
        const { link } = linkDir(root, { 'file.txt': 'protected' });
        const ctx = file('edit', path.join(link, 'file.txt'));
        const rootedAt = { projectRoot: root, cwd: root };
        const deny = makePm({
          permissionsDeny: ['Edit(/protected/**)'],
          ...rootedAt,
        });
        expect(await deny.evaluate(ctx)).toBe('deny');
        const allow = makePm({
          permissionsAllow: ['Edit(/protected/**)'],
          ...rootedAt,
        });
        expect(await allow.evaluate(ctx)).toBe('default');
      }));

    it('allows reading in an allowed directory', async () => {
      const ctx = file('read_file', '/project/docs/readme.md');
      expect(await pm.evaluate(ctx)).toBe('allow');
    });

    it('Read deny applies to grep_search too (meta-category)', async () => {
      const ctx = file('grep_search', '/project/.env');
      expect(await pm.evaluate(ctx)).toBe('deny');
    });

    it('returns default for unmatched path', async () => {
      const ctx = file('read_file', '/project/src/index.ts');
      expect(await pm.evaluate(ctx)).toBe('default');
    });
  });

  describe('WebFetch domain evaluation', () => {
    beforeEach(() => {
      pm = makePm({
        permissionsAllow: ['WebFetch(domain:github.com)'],
        permissionsDeny: ['WebFetch(domain:evil.com)'],
      });
    });

    it.each([
      ['allows fetch to allowed domain', 'github.com', 'allow'],
      [
        'allows fetch to subdomain of allowed domain',
        'api.github.com',
        'allow',
      ],
      ['denies fetch to denied domain', 'evil.com', 'deny'],
      ['returns default for unmatched domain', 'example.com', 'default'],
    ])('%s', async (_title, domain, expected) => {
      expect(await pm.evaluate({ toolName: 'web_fetch', domain })).toBe(
        expected,
      );
    });
  });

  describe('isToolEnabled', () => {
    it('returns false for deny-ruled tools', async () => {
      pm = makePm({ permissionsDeny: ['ShellTool'] });
      expect(await enabled('run_shell_command')).toBe(false);
    });

    it('returns true for tools with only specifier deny rules', async () => {
      pm = makePm({ permissionsDeny: ['Bash(rm *)'] });
      expect(await enabled('run_shell_command')).toBe(true);
    });

    it('excludeTools passed via permissionsDeny disables the tool', async () => {
      pm = makePm({ permissionsDeny: ['run_shell_command'] });
      expect(await enabled('run_shell_command')).toBe(false);
    });

    it('Edit deny rule disables notebook_edit', async () => {
      pm = makePm({ permissionsDeny: ['Edit'] });
      expect(await enabled('notebook_edit')).toBe(false);
    });

    it('coreTools allowlist: listed tool is enabled', async () => {
      pm = makePm({ coreTools: ['read_file', 'Bash'] });
      expect(await enabled('read_file')).toBe(true);
      expect(await enabled('run_shell_command')).toBe(true); // Bash resolves to run_shell_command
    });

    it('coreTools allowlist: unlisted tool is disabled', async () => {
      pm = makePm({ coreTools: ['read_file'] });
      expect(await enabled('read_file')).toBe(true);
      expect(await enabled('zoom_image')).toBe(false);
      expect(await enabled('run_shell_command')).toBe(false);
      expect(await enabled('edit')).toBe(false);
      expect(await enabled('notebook_edit')).toBe(false);
    });

    // Rows: alias, the tool it enables, and a sibling that stays disabled.
    it.each([
      ['ZoomImage', 'zoom_image', 'read_file'],
      ['NotebookEdit', 'notebook_edit', 'edit'],
    ])(
      'coreTools allowlist: %s alias enables %s',
      async (alias, toolName, sibling) => {
        pm = makePm({ coreTools: [alias] });
        expect(await enabled(toolName)).toBe(true);
        expect(await enabled(sibling)).toBe(false);
      },
    );

    it('coreTools allowlist gates loop_wakeup as a core scheduling tool', async () => {
      pm = makePm({ coreTools: ['read_file'] });
      expect(await enabled('loop_wakeup')).toBe(false);

      pm = makePm({ coreTools: ['loop_wakeup'] });
      expect(await enabled('loop_wakeup')).toBe(true);
    });

    it('coreTools allowlist gates managed memory tools', async () => {
      pm = new PermissionManager(makeConfig({ coreTools: ['read_file'] }));
      pm.initialize();

      expect(await pm.getToolRegistrationStatus('manage_memory')).toBe(
        'disabled',
      );
      expect(await pm.getToolRegistrationStatus('search_memory')).toBe(
        'disabled',
      );
    });

    it('coreTools with specifier: tool-level check strips specifier', async () => {
      // "Bash(ls -l)" should register run_shell_command (specifier only affects runtime)
      pm = makePm({ coreTools: ['Bash(ls -l)'] });
      expect(await enabled('run_shell_command')).toBe(true);
      expect(await enabled('read_file')).toBe(false);
    });

    it('empty coreTools: all tools enabled (no whitelist restriction)', async () => {
      pm = makePm({ coreTools: [] });
      expect(await enabled('read_file')).toBe(true);
      expect(await enabled('run_shell_command')).toBe(true);
    });

    it('coreTools allowlist + deny rule: deny takes precedence for listed tools', async () => {
      pm = makePm({
        coreTools: ['read_file', 'Bash'],
        permissionsDeny: ['Bash'],
      });
      expect(await enabled('read_file')).toBe(true);
      expect(await enabled('run_shell_command')).toBe(false); // in list but denied
    });

    it('permissionsAllow is not a whitelist — it never affects registration', async () => {
      // `permissions.allow` is pure auto-approval and must not remove, demote
      // or hide anything: that conflation silently dropped `edit` /
      // `write_file` for the #10075 reporter. Narrowing is `tools.eager`'s job.
      pm = makePm({ permissionsAllow: ['read_file'] });
      expect(await enabled('read_file')).toBe(true);
      expect(await enabled('run_shell_command')).toBe(true);
      expect(await registration('run_shell_command')).toBe('registered');
      expect(await registration('read_file')).toBe('registered');
    });

    it('permissions.allow never rescues a tool the coreTools allowlist excludes', async () => {
      // The #10075 decoupling in reverse: an allow rule cannot re-register a
      // core tool `coreTools` omits; the legacy hard `disabled` still wins.
      pm = makePm({ coreTools: ['read_file'], permissionsAllow: ['edit'] });
      expect(await registration('edit')).toBe('disabled');
      expect(await enabled('edit')).toBe(false);
      expect(await registration('read_file')).toBe('registered');
    });

    it('permissions.ask never demotes or removes a tool', async () => {
      // "Always require confirmation" must never become "tool unavailable":
      // ask rules only route confirmation; no registration effect (#10075).
      pm = makePm({ permissionsAsk: ['Edit'] });
      expect(await registration('edit')).toBe('registered');
      expect(await enabled('edit')).toBe(true);
    });

    it('MCP tools bypass coreTools allowlist check', async () => {
      pm = makePm({ coreTools: ['read_file'] });
      expect(await enabled('mcp__markitdown__convert_to_markdown')).toBe(true);
      expect(await enabled('mcp__puppeteer__navigate')).toBe(true);
    });

    it.each([
      ['Skill', 'skill'],
      ['Agent', 'agent'],
      ['exit_plan_mode', 'exit_plan_mode'],
      ['ask_user_question', 'ask_user_question'],
      // structured_output exists only under --json-schema, and
      // `--json-schema X --core-tools read_file` restricts the toolbelt while
      // still wanting the payload: dropping it would leave --json-schema with
      // no terminal contract, looping until maxTurns.
      ['structured_output', 'structured_output'],
    ])(
      '%s tool bypasses coreTools allowlist check',
      async (_label, toolName) => {
        pm = makePm({ coreTools: ['read_file'] });
        expect(await enabled(toolName)).toBe(true);
      },
    );

    it('Non-core tools still respect deny rules', async () => {
      pm = makePm({
        coreTools: ['read_file'],
        permissionsDeny: ['mcp__markitdown'],
      });
      // Denied even though MCP tools bypass coreTools.
      expect(await enabled('mcp__markitdown__convert_to_markdown')).toBe(false);
      expect(await enabled('mcp__puppeteer__navigate')).toBe(true);
    });
  });

  describe('tools.eager allowlist (#9827, #10075)', () => {
    it.each([
      [ToolMode.Direct, undefined, 'registered'],
      [ToolMode.CodeModeOnly, undefined, 'deferred'],
      [ToolMode.CodeModeOnly, [], 'deferred'],
      [ToolMode.CodeModeOnly, ['Read'], 'deferred'],
      [ToolMode.CodeModeOnly, ['workflow'], 'registered'],
      [ToolMode.CodeModeOnly, ['Workflow'], 'registered'],
    ] as const)(
      'registers workflow in %s with eager=%j as %s',
      async (toolMode, eagerTools, expected) => {
        pm = new PermissionManager({
          ...makeConfig(),
          getToolMode: () => toolMode,
          getEagerTools: () => eagerTools,
        });
        pm.initialize();
        expect(await pm.getToolRegistrationStatus(ToolNames.WORKFLOW)).toBe(
          expected,
        );
        expect(await pm.isToolEnabled(ToolNames.WORKFLOW)).toBe(true);
      },
    );

    it('keeps workflow deny rules ahead of Code Mode deferral and eager settings', async () => {
      for (const eagerTools of [undefined, ['workflow']]) {
        pm = new PermissionManager({
          ...makeConfig({ permissionsDeny: ['Workflow'] }),
          getToolMode: () => ToolMode.CodeModeOnly,
          getEagerTools: () => eagerTools,
        });
        pm.initialize();
        expect(await pm.getToolRegistrationStatus(ToolNames.WORKFLOW)).toBe(
          'disabled',
        );
        expect(await pm.isToolEnabled(ToolNames.WORKFLOW)).toBe(false);
      }
    });

    it('unlisted built-in tools are deferred, not disabled', async () => {
      // The #9827 reporter's config: only these ride in the eager request;
      // send_message / update_goal / loop_wakeup / read_mcp_resource (whose
      // large maxLength schemas break llama.cpp grammar compilation) must NOT.
      // They are DEFERRED (still registered and callable), not disabled, so
      // they never silently disappear (#10075).
      pm = makePm({
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
      });
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
        expect(await registration(covered)).toBe('registered');
      }

      for (const uncovered of [
        'send_message',
        'update_goal',
        'loop_wakeup',
        'read_mcp_resource',
      ]) {
        expect(await registration(uncovered)).toBe('deferred');
        // Deferred is not disabled: a call still flows through the normal
        // approval path rather than a permission error (#10075).
        expect(await enabled(uncovered)).toBe(true);
      }
    });

    it('permissions.allow does NOT defer anything (#10075 regression)', async () => {
      // The regression the decoupling exists to prevent: permissions.allow is
      // for auto-approval and must never reshape the registry.
      pm = makePm({
        permissionsAllow: ['ReadFile', 'Grep'],
        permissionsAsk: ['WebFetch'],
      });
      expect(pm.isEagerToolAllowListActive()).toBe(false);
      for (const name of [
        'read_file',
        'edit',
        'write_file',
        'send_message',
        'update_goal',
      ]) {
        expect(await registration(name)).toBe('registered');
      }
    });

    it('session-granted allow rules never change registration (#10075)', async () => {
      pm = makePm({ eagerTools: ['ReadFile'] });
      expect(await registration('edit')).toBe('deferred');
      pm.addSessionAllowRule('Edit');
      // The grant auto-approves, but registration is a startup decision
      // driven solely by tools.eager.
      expect(await registration('edit')).toBe('deferred');
      expect(await enabled('edit')).toBe(true);
    });

    it('an absent eager list leaves the allowlist inactive', async () => {
      // Only `undefined` means "no restriction" — see the empty-array case
      // below for the deliberate asymmetry.
      pm = makePm({ permissionsAllow: [] });
      expect(pm.isEagerToolAllowListActive()).toBe(false);
      expect(await registration('send_message')).toBe('registered');
    });

    it('specifier entries still cover their tool', async () => {
      // The eager gate is tool-level, not invocation-level, so a stray
      // specifier is stripped rather than making the entry match nothing.
      pm = makePm({ eagerTools: ['Bash(npm test)'] });
      expect(await registration('run_shell_command')).toBe('registered');
    });

    it('meta-category entries cover their tool families', async () => {
      pm = makePm({ eagerTools: ['Read'] });
      for (const name of ['read_file', 'grep_search', 'glob']) {
        expect(await registration(name)).toBe('registered');
      }
      expect(await registration('write_file')).toBe('deferred');
    });

    it('display-name entries resolve through aliases', async () => {
      pm = makePm({ eagerTools: ['SendMessage', 'UpdateGoal'] });
      expect(await registration('send_message')).toBe('registered');
      expect(await registration('update_goal')).toBe('registered');
      expect(await registration('loop_wakeup')).toBe('deferred');
    });

    it('an explicitly empty list is active and defers everything', async () => {
      // `[]` is an active allowlist naming nothing (unlike `tools.core`, whose
      // empty list reads as unset): the gentler answer for constrained-decoding
      // backends, as the eager request carries almost no schemas while every
      // tool stays registered and reachable via ToolSearch.
      pm = makePm({ eagerTools: [] });
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      for (const name of ['read_file', 'edit', 'send_message']) {
        expect(await registration(name)).toBe('deferred');
        expect(await enabled(name)).toBe(true);
      }
      // Exempt families still ride eagerly, so the session stays usable.
      expect(await registration('tool_search')).toBe('registered');
    });

    it('tolerates non-string entries instead of crashing initialize()', async () => {
      // Settings load does no element-type validation (the schema says only
      // `type: 'array'`): a stray number/null is skipped, not a crash.
      pm = new PermissionManager(
        makeConfig({
          eagerTools: [null, 42, 'ReadFile'] as unknown as string[],
        }),
      );
      expect(() => pm.initialize()).not.toThrow();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      expect(await registration('read_file')).toBe('registered');
      expect(await registration('send_message')).toBe('deferred');
    });

    it('tolerates Object.prototype-keyed entries without crashing (#10400)', async () => {
      // Object.prototype-named entries used to read the inherited value via
      // the plain-object alias table, a non-string toolName that crashed
      // initialize() with `rule.toolName.startsWith is not a function` (CLI
      // startup crash). Like any unknown name they must resolve to themselves,
      // match no registered tool and never abort initialization (#10400).
      pm = new PermissionManager(
        makeConfig({ eagerTools: ['constructor', ...PROTO_KEYS, 'ReadFile'] }),
      );
      expect(() => pm.initialize()).not.toThrow();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      // The valid entry works; the prototype keys disturb nothing else.
      expect(await registration('read_file')).toBe('registered');
      expect(await registration('send_message')).toBe('deferred');
      // The lookup itself must survive a prototype-keyed tool name too.
      await expect(registration('constructor')).resolves.toBeDefined();
    });

    it('malformed entries drop out but still leave the list active', async () => {
      // Deferring more than intended is recoverable (ToolSearch still
      // reaches every tool); silently ignoring a configured list would
      // resend exactly the schemas the user asked to keep out (#9827).
      pm = makePm({ eagerTools: ['', '   ', 'Bash(unbalanced'] });
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      expect(await registration('send_message')).toBe('deferred');
      expect(await enabled('send_message')).toBe(true);
    });

    it('logs the entries it dropped so a typo is not silent', async () => {
      // A misspelt entry defers the whole toolset: recoverable, but it must
      // not be invisible (silent reshaping is what #10075 reported). Pin the
      // console channel: the debug log file is off in default runs, where
      // this warning matters most.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pm = makePm({ eagerTools: ['ReadFile', '', 'Bash(unbalanced'] });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('tools.eager: ignoring 2 unusable entries'),
      );
      // The valid entry survives — dropping is per-entry, not all-or-nothing.
      expect(await registration('read_file')).toBe('registered');
      warnSpy.mockRestore();
    });

    it('stays quiet when every entry parses', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pm = makePm({ eagerTools: ['ReadFile'] });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('tools.eager'),
      );
      warnSpy.mockRestore();
    });

    it('deny rules still win over eager membership', async () => {
      pm = makePm({ eagerTools: ['ReadFile'], permissionsDeny: ['ReadFile'] });
      expect(await registration('read_file')).toBe('disabled');
      expect(await enabled('read_file')).toBe(false);
    });

    it('deny via display name removes the tool from the registry', async () => {
      pm = makePm({ eagerTools: ['ReadFile'], permissionsDeny: ['Edit'] });
      expect(await registration('edit')).toBe('disabled');
    });

    it('combines with the coreTools allowlist', async () => {
      // coreTools keeps its documented hard-disable; tools.eager only demotes,
      // so a tool coreTools excludes is disabled even if the eager list has it.
      pm = makePm({ eagerTools: ['ReadFile', 'Edit'], coreTools: ['Edit'] });
      expect(await registration('read_file')).toBe('disabled');
      expect(await registration('edit')).toBe('registered');
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
        // The bridge's other half, exempt since #10410 yet untested: deleting
        // that isExemptFromEagerAllowList arm left the suite green. Both halves
        // are alwaysLoad=true, so the arm guards not the declaration list but
        // the permission-deferred state other readers consult (speculation's
        // boundary check, the workflow-authoring skill's hidden-tool text).
        ['tool_call', 'tool_call'],
      ];

      it.each(exempt)('%s', async (_label, toolName) => {
        pm = makePm({ eagerTools: ['ReadFile'] });
        expect(await registration(toolName)).toBe('registered');
      });

      it('computer_use__* tools are exempt', async () => {
        // The generated cua-driver family has no alias, meta-category or
        // wildcard rule form (its wire names churn every version) and is all
        // shouldDefer=true, so its schemas never enter the eager request.
        pm = makePm({ eagerTools: ['ReadFile'] });
        expect(await registration('computer_use__screenshot')).toBe(
          'registered',
        );
      });

      it.each(exempt)(
        'a whole-tool deny rule still wins over the %s exemption',
        async (_label, toolName) => {
          pm = makePm({
            eagerTools: ['ReadFile'],
            permissionsDeny: [toolName],
          });
          expect(await registration(toolName)).toBe('disabled');
        },
      );
    });
  });

  describe('session rules', () => {
    beforeEach(() => {
      pm = makePm({});
    });

    it('addSessionAllowRule enables auto-approval for that pattern', async () => {
      // Use 'git commit' which is not readonly, so it resolves to 'ask' by default
      expect(await pm.evaluate(sh('git commit'))).toBe('ask');
      pm.addSessionAllowRule('Bash(git *)');
      expect(await pm.evaluate(sh('git commit'))).toBe('allow');
    });

    it('session deny rules override allow rules', async () => {
      pm.addSessionAllowRule('run_shell_command');
      pm.addSessionDenyRule('run_shell_command');
      expect(await pm.evaluate({ toolName: 'run_shell_command' })).toBe('deny');
    });

    it('a trust-gated allow rule is suspended while the folder is untrusted and restored with trust', async () => {
      // A project skill's `allowedTools` are repository-controlled: they
      // auto-approve only while the folder is trusted, re-read per decision,
      // so a mid-session revocation applies at the next call and a later
      // grant restores the rule (the second side of the gate on the way in).
      let trusted = true;
      pm = makePm({ isTrustedFolder: () => trusted });
      const call = sh('git commit');
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      pm.addSessionAllowRule('Bash(npm *)'); // the user's own grant
      expect(await pm.evaluate(call)).toBe('allow');

      trusted = false;
      expect(await pm.evaluate(call)).toBe('ask');
      expect(await pm.evaluate(sh('npm test'))).toBe('allow');
      // The effective-rules listing agrees with the decision.
      expect(pm.listRules().some((r) => r.rule.raw === 'Bash(git *)')).toBe(
        false,
      );

      trusted = true;
      expect(await pm.evaluate(call)).toBe('allow');
    });

    it('an ungated grant of the same raw rule outranks the repo grant — the dedup must not inherit the suspension', async () => {
      // A project skill grants `Bash(git *)` trust-gated, then a user-level
      // skill the same raw: the one deduped entry must carry the WIDER grant,
      // the user's, which no folder trust suspends. A gated re-arrival (skill
      // reload) stays a skip.
      let trusted = true;
      pm = makePm({ isTrustedFolder: () => trusted });
      const call = sh('git commit');
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      pm.addSessionAllowRule('Bash(git *)'); // the user-level skill's grant
      trusted = false;
      expect(await pm.evaluate(call)).toBe('allow');
      // Re-adding the gated rule (a reload cycle) neither duplicates nor
      // re-gates the entry the user now holds.
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      expect(await pm.evaluate(call)).toBe('allow');
      expect(sessionAllowRules(pm)).toHaveLength(1);
    });

    it('a trust-gated rule stays in force when the config reports no trust probe', async () => {
      pm.addSessionAllowRule('Bash(git *)', { trustGated: true });
      expect(await pm.evaluate(sh('git commit'))).toBe('allow');
    });

    it('clearSessionAllowRules drops live and AUTO-stashed session grants', async () => {
      pm.addSessionAllowRule('Bash(git *)');
      pm.stripDangerousRulesForAutoMode();
      pm.addSessionAllowRule('Bash(npm *)');
      expect(pm.getStrippedDangerousRules()?.session).toHaveLength(1);

      pm.clearSessionAllowRules();
      pm.restoreDangerousRules();

      expect(pm.getAllowRawStrings()).toEqual([]);
      expect(await pm.evaluate(sh('npm test'))).not.toBe('allow');
    });

    it('addSessionAllowRule deduplicates identical rules', () => {
      pm.addSessionAllowRule('Bash(git *)');
      pm.addSessionAllowRule('Bash(git *)');
      expect(sessionAllowRules(pm)).toHaveLength(1);
    });

    it('malformed session allow rule is silently ignored', async () => {
      pm.addSessionAllowRule('Bash(git commit');
      // 'git commit' is not readonly, so default is 'ask'.
      // The malformed rule must not act as catch-all allow.
      expect(await pm.evaluate(sh('git commit'))).toBe('ask');
    });

    it('malformed session deny rule is silently ignored', async () => {
      pm.addSessionDenyRule('Bash(rm -rf /)*');
      // Should NOT deny — the malformed rule must not act as catch-all
      expect(await pm.evaluate(sh('git status'))).not.toBe('deny');
    });
  });

  describe('allowedTools via permissionsAllow', () => {
    it('allow rule auto-approves matching tools/commands', async () => {
      pm = makePm({ permissionsAllow: ['ReadFileTool', 'Bash(git *)'] });
      expect(await pm.evaluate({ toolName: 'read_file' })).toBe('allow');
      expect(await pm.evaluate(sh('git status'))).toBe('allow');
    });
  });

  describe('listRules', () => {
    it('returns all rules with type and scope', async () => {
      pm = makePm({
        permissionsAllow: ['ReadFileTool'],
        permissionsDeny: ['ShellTool'],
      });
      pm.addSessionAllowRule('Bash(git *)');

      const rules = pm.listRules();
      expect(rules.length).toBe(3);
      const sessionAllow = rules.find(
        (r) => r.scope === 'session' && r.type === 'allow',
      );
      expect(sessionAllow?.rule.toolName).toBe('run_shell_command');
    });

    it('excludes malformed rules from listing', async () => {
      pm = makePm({
        permissionsAllow: ['ReadFileTool'],
        permissionsDeny: ['Bash(rm -rf /)*'],
      });

      const rules = pm.listRules();
      expect(rules.length).toBe(1);
      expect(rules[0]!.rule.toolName).toBe('read_file');
    });
  });

  describe('hasMatchingAskRule', () => {
    const addThenCommit = sh('git add file && git commit -m "msg"');

    it('returns false when shell ask comes only from default permission fallback', async () => {
      pm = makePm({ permissionsAllow: ['Bash(git add *)'] });
      expect(pm.hasMatchingAskRule(addThenCommit)).toBe(false);
    });

    it('returns true when an explicit ask rule matches a shell sub-command', async () => {
      pm = makePm({ permissionsAsk: ['Bash(git commit *)'] });
      expect(pm.hasMatchingAskRule(addThenCommit)).toBe(true);
    });

    it('matches an ask rule through a symlinked path', () =>
      withTempRoot((root) => {
        const { link } = linkDir(root);
        pm = makePm({
          permissionsAsk: ['Edit(/protected/**)'],
          projectRoot: root,
          cwd: root,
        });
        const ctx = { toolName: 'edit', filePath: path.join(link, 'file.txt') };
        expect(pm.hasMatchingAskRule(ctx)).toBe(true);
      }));
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
  const build = buildPermissionRules;

  describe('path-based tools (Read/Edit)', () => {
    // File-targeted tools: the path's dirname, plus a /** glob.
    it.each([
      ['Read', 'read_file', '/Users/alice/.secrets', 'Read(//Users/alice/**)'],
      [
        'Read',
        'zoom_image',
        '/Users/alice/chart.png',
        'Read(//Users/alice/**)',
      ],
      ['Edit', 'edit', '/external/file.ts', 'Edit(//external/**)'],
      ['Edit', 'write_file', '/tmp/output.txt', 'Edit(//tmp/**)'],
      ['Edit', 'notebook_edit', '/tmp/analysis.ipynb', 'Edit(//tmp/**)'],
    ])(
      'generates %s rule scoped to parent directory for %s',
      async (_category, toolName, filePath, rule) => {
        expect(build({ toolName, filePath })).toEqual([rule]);
      },
    );

    // Directory-targeted tools: the path as-is, plus a /** glob.
    it.each([
      ['grep_search', '/external/dir', 'Read(//external/dir/**)'],
      ['glob', '/tmp/data', 'Read(//tmp/data/**)'],
      ['list_directory', '/home/user/docs', 'Read(//home/user/docs/**)'],
    ])(
      'generates Read rule with directory as-is for %s',
      async (toolName, filePath, rule) => {
        expect(build({ toolName, filePath })).toEqual([rule]);
      },
    );

    it('falls back to bare display name when no filePath', async () => {
      expect(build({ toolName: 'read_file' })).toEqual(['Read']);
    });
  });

  describe('generated rules round-trip through parseRule and matchesRule', () => {
    it('Read rule for external file covers the containing directory', async () => {
      const rules = build({
        toolName: 'read_file',
        filePath: '/Users/alice/.secrets',
      });
      expect(rules).toHaveLength(1);
      expect(rules[0]).toBe('Read(//Users/alice/**)');

      const parsed = parseRule(rules[0]!);
      expect(parsed.toolName).toBe('read_file');
      expect(parsed.specifier).toBe('//Users/alice/**');
      expect(parsed.specifierKind).toBe('path');

      const reads = (filePath: string) =>
        matchesPath(parsed, 'read_file', filePath, {
          projectRoot: '/some/project',
          cwd: '/some/project',
        });
      // Matches the original file, other files in the same directory, and
      // nothing in a different directory.
      expect(reads('/Users/alice/.secrets')).toBe(true);
      expect(reads('/Users/alice/.other')).toBe(true);
      expect(reads('/Users/bob/.secrets')).toBe(false);
    });

    it('Read rule also matches other read-family tools on the same path', async () => {
      const rules = build({
        toolName: 'grep_search',
        filePath: '/external/dir',
      });
      const parsed = parseRule(rules[0]!);
      const matches = (toolName: string, filePath: string) =>
        matchesPath(parsed, toolName, filePath, {
          projectRoot: '/p',
          cwd: '/p',
        });
      // Matches grep_search inside the dir, and read_file (Read meta-category)
      expect(matches('grep_search', '/external/dir/file.txt')).toBe(true);
      expect(matches('read_file', '/external/dir/other.ts')).toBe(true);
    });
  });

  describe('domain-based tools', () => {
    it('generates WebFetch rule with domain specifier', async () => {
      expect(build({ toolName: 'web_fetch', domain: 'example.com' })).toEqual([
        'WebFetch(example.com)',
      ]);
    });

    it('falls back to bare display name when no domain', async () => {
      expect(build({ toolName: 'web_fetch' })).toEqual(['WebFetch']);
    });
  });

  describe('command-based tools', () => {
    it('generates Bash rule with command specifier', async () => {
      expect(build(sh('git status'))).toEqual(['Bash(git status)']);
    });

    it('falls back to bare display name when no command', async () => {
      expect(build({ toolName: 'run_shell_command' })).toEqual(['Bash']);
    });

    it('generates Monitor rule with command specifier', async () => {
      expect(build(mon('tail -f /var/log/app.log'))).toEqual([
        'Monitor(tail -f /var/log/app.log)',
      ]);
    });

    it('falls back to bare Monitor display name when no command', async () => {
      expect(build({ toolName: 'monitor' })).toEqual(['Monitor']);
    });
  });

  describe('literal-specifier tools', () => {
    it('generates Skill rule with specifier', async () => {
      expect(build({ toolName: 'skill', specifier: 'Explore' })).toEqual([
        'Skill(Explore)',
      ]);
    });

    it('generates Agent rule with specifier', async () => {
      expect(build({ toolName: 'agent', specifier: 'research' })).toEqual([
        'Agent(research)',
      ]);
    });

    it('falls back to bare display name when no specifier', async () => {
      expect(build({ toolName: 'skill' })).toEqual(['Skill']);
    });
  });

  describe('unknown / MCP tools', () => {
    it('uses the canonical name as display for MCP tools', async () => {
      const toolName = 'mcp__puppeteer__navigate';
      expect(build({ toolName })).toEqual([toolName]);
    });
  });

  describe('with toolParams (stable param serialization)', () => {
    const agentRules = (params: Record<string, unknown>, specifier?: string) =>
      build(agentCtx(params, specifier));

    it('serializes stable params (model, subagent_type) for Agent', async () => {
      const rules = agentRules(
        { subagent_type: 'coder', model: 'opus', prompt: 'Fix the bug' },
        'coder',
      );
      // prompt is not serialized (not in stableParamKeys); subagent_type is
      // skipped because it matches specifier
      expect(rules).toEqual(['Agent(coder,model:opus)']);
    });

    it('does not serialize volatile params like prompt or query', async () => {
      const rules = agentRules({
        model: 'sonnet',
        prompt: 'Some long prompt that should not be persisted',
      });
      expect(rules).toEqual(['Agent(model:sonnet)']);
      expect(rules[0]).not.toContain('prompt');
    });

    it('does not serialize sensitive params (no secret leakage)', async () => {
      const rules = agentRules({
        model: 'opus',
        api_key: 'sk-secret-123',
        token: 'bearer-xyz',
      });
      // api_key and token are not in stableParamKeys, so not serialized
      expect(rules).toEqual(['Agent(model:opus)']);
      expect(rules[0]).not.toContain('secret');
      expect(rules[0]).not.toContain('bearer');
    });

    it('generates bare MCP tool name without specifier or params', async () => {
      const rules = build({
        toolName: 'mcp__chrome__navigate',
        toolParams: { server_name: 'chrome', url: 'https://example.com' },
      });
      // MCP tools get bare name — specifier rejection in matchesRule
      // would make any specifier-carrying rule a dead entry
      expect(rules).toEqual(['mcp__chrome__navigate']);
    });

    it('round-trips Agent rule with stable params through parseRule', async () => {
      const rules = agentRules(
        { subagent_type: 'coder', model: 'opus' },
        'coder',
      );
      expect(rules).toEqual(['Agent(coder,model:opus)']);

      const parsed = parseRule(rules[0]!);
      expect(parsed.toolName).toBe('agent');
      expect(parsed.specifier).toBe('coder');
      expect(parsed.toolParamMatchers).toEqual([paramMatcher('model', 'opus')]);
    });

    it('handles number values in toolParams', async () => {
      const rules = agentRules({ model: 'opus', count: 42 });
      // count is not in stableParamKeys, so not serialized
      expect(rules).toEqual(['Agent(model:opus)']);
    });
  });
});

// ─── buildHumanReadableRuleLabel ─────────────────────────────────────────────

describe('buildHumanReadableRuleLabel', () => {
  const label = (...rules: string[]) => buildHumanReadableRuleLabel(rules);

  it('returns empty string for empty rules array', () => {
    expect(buildHumanReadableRuleLabel([])).toBe('');
  });

  it.each([
    ['Read', 'read files'],
    ['Bash', 'run commands'],
    ['Monitor', 'monitor commands'],
  ])('converts bare %s rule to "%s"', (rule, expected) => {
    expect(label(rule)).toBe(expected);
  });

  // Rows: display name and specifier kind (the title), then rule and label.
  it.each([
    [
      'Read',
      'absolute path',
      'Read(//Users/mochi/.qwen/**)',
      'read files in /Users/mochi/.qwen/',
    ],
    ['Read', 'relative path', 'Read(/src/**)', 'read files in /src/'],
    ['Edit', 'path', 'Edit(//tmp/**)', 'edit files in /tmp/'],
    ['Bash', 'command', 'Bash(git *)', "run 'git *' commands"],
    [
      'Monitor',
      'command',
      'Monitor(tail -f *)',
      "monitor 'tail -f *' commands",
    ],
    ['WebFetch', 'domain', 'WebFetch(github.com)', 'fetch from github.com'],
    ['Skill', 'literal', 'Skill(Explore)', 'use skill "Explore"'],
    ['Agent', 'literal', 'Agent(research)', 'use agent "research"'],
  ])('converts %s with %s specifier', (_name, _kind, rule, expected) => {
    expect(label(rule)).toBe(expected);
  });

  it('joins multiple rules with commas', () => {
    expect(label('Read(//Users/alice/**)', 'Bash(npm *)')).toBe(
      "read files in /Users/alice/, run 'npm *' commands",
    );
  });

  it('handles unknown display names gracefully', () => {
    expect(label('mcp__server__tool')).toBe('mcp__server__tool');
  });

  it('handles unknown display name with specifier', () => {
    expect(label('UnknownCategory(someValue)')).toBe(
      'unknowncategory "someValue"',
    );
  });

  it('cleans path with /* suffix', () => {
    expect(label('Read(//home/user/docs/*)')).toBe(
      'read files in /home/user/docs/',
    );
  });

  it.each<[string, PermissionCheckContext, string]>([
    [
      'file tool',
      { toolName: 'read_file', filePath: '/Users/alice/.secrets' },
      'read files in /Users/alice/',
    ],
    ['shell command', sh('git status'), "run 'git status' commands"],
    [
      'web fetch',
      { toolName: 'web_fetch', domain: 'example.com' },
      'fetch from example.com',
    ],
  ])('round-trips from buildPermissionRules for %s', (_kind, ctx, expected) => {
    const rules = buildPermissionRules(ctx);
    expect(buildHumanReadableRuleLabel(rules)).toBe(expected);
  });
});

// ─── PermissionManager.findMatchingDenyRule ──────────────────────────────────

describe('PermissionManager.findMatchingDenyRule', () => {
  it('returns the raw deny rule string when context matches', () => {
    const pm = makePm({ permissionsDeny: ['Bash(rm *)'] });
    expect(pm.findMatchingDenyRule(sh('rm -rf /tmp/foo'))).toBe('Bash(rm *)');
  });

  it('returns undefined when no deny rule matches', () => {
    const pm = makePm({ permissionsDeny: ['Bash(rm *)'] });
    expect(pm.findMatchingDenyRule(sh('git status'))).toBeUndefined();
  });

  it('matches session deny rules', () => {
    const pm = makePm();
    pm.addSessionDenyRule('Read(//secret/**)');
    const ctx = { toolName: 'read_file', filePath: '/secret/key.pem' };
    expect(pm.findMatchingDenyRule(ctx)).toBe('Read(//secret/**)');
  });

  it('returns undefined for non-denied tool', () => {
    const pm = makePm({ permissionsDeny: ['ShellTool'] });
    expect(pm.findMatchingDenyRule({ toolName: 'read_file' })).toBeUndefined();
  });

  it('matches bare tool deny rule', () => {
    const pm = makePm({ permissionsDeny: ['ShellTool'] });
    // rule.raw preserves the original rule string as written in config
    expect(pm.findMatchingDenyRule(sh('echo hello'))).toBe('ShellTool');
  });

  it('matches a deny rule through a symlinked path', () =>
    withTempRoot((root) => {
      const { link } = linkDir(root);
      const pm = makePm({
        permissionsDeny: ['Edit(/protected/**)'],
        projectRoot: root,
        cwd: root,
      });
      const ctx = { toolName: 'edit', filePath: path.join(link, 'file.txt') };
      expect(pm.findMatchingDenyRule(ctx)).toBe('Edit(/protected/**)');
    }));

  it('cites the deny rule for a compound command segment', () => {
    const pm = makePm({ permissionsDeny: ['Bash(npm view *)'] });
    // evaluate() splits the compound command and denies on the `npm view`
    // segment, so findMatchingDenyRule must cite that same rule (issue #11405).
    expect(pm.findMatchingDenyRule(sh('cd /tmp && npm view foo'))).toBe(
      'Bash(npm view *)',
    );
  });

  it('cites the deny rule when a shell command is denied via a virtual file op', () => {
    const pm = makePm({ permissionsDeny: ['Read(//**/node_modules/**)'] });
    // A `cat` of a node_modules file is denied through the shell virtual-op
    // pass (Read rule), not a Bash rule. findMatchingDenyRule must cite it.
    const ctx = sh('cat /app/node_modules/lodash/index.js');
    expect(pm.findMatchingDenyRule(ctx)).toBe('Read(//**/node_modules/**)');
  });
});

// ─── AUTO mode dangerous-rule stash ────────────────────────────────────

describe('PermissionManager — strip/restore for AUTO mode', () => {
  it('strips Bash interpreter wildcards and stashes them', () => {
    const pm = makePm({
      permissionsAllow: ['Bash(python:*)', 'Bash(git status)'],
    });

    const stash = pm.stripDangerousRulesForAutoMode();
    expect(stash.persistent).toHaveLength(1);
    expect(stash.persistent[0].raw).toBe('Bash(python:*)');

    // The safe rule remains: git status still auto-allowed.
    return expect(pm.evaluate(sh('git status'))).resolves.toBe('allow');
  });

  it('strips bare tool-level Bash allow', async () => {
    const pm = makePm({ permissionsAllow: ['Bash'] });
    // Before strip: any Bash command is auto-allowed.
    expect(await pm.evaluate(sh('rm -rf /'))).toBe('allow');

    pm.stripDangerousRulesForAutoMode();

    // After strip: Bash falls through to default (which AST analysis turns
    // into ask for non-readonly commands).
    expect(await pm.evaluate(sh('rm -rf /'))).not.toBe('allow');
  });

  it('strips Agent / Skill any-allow rules', () => {
    const pm = makePm({
      permissionsAllow: ['Agent(coder)', 'Skill(pdf)', 'ReadFileTool'],
    });

    const stash = pm.stripDangerousRulesForAutoMode();
    expect(stash.persistent).toHaveLength(2);
    expect(stash.persistent.map((r) => r.toolName).sort()).toEqual(
      ['agent', 'skill'].sort(),
    );
    // Safe Read rule untouched.
    expect(pm.getAllowRawStrings()).toEqual(['ReadFileTool']);
  });

  it('is idempotent — second strip returns the same stash without re-removal', () => {
    const pm = makePm({ permissionsAllow: ['Bash(python:*)'] });

    const first = pm.stripDangerousRulesForAutoMode();
    const second = pm.stripDangerousRulesForAutoMode();
    expect(first).toBe(second);
    expect(pm.getAllowRawStrings()).toEqual([]);
  });

  it('restoreDangerousRules reattaches stripped rules to their original scope', async () => {
    const pm = makePm({ permissionsAllow: ['Bash(python:*)'] });

    pm.stripDangerousRulesForAutoMode();
    expect(pm.getAllowRawStrings()).toEqual([]);

    pm.restoreDangerousRules();
    expect(pm.getAllowRawStrings()).toEqual(['Bash(python:*)']);

    // And the rule works again: python anything is auto-allowed.
    expect(await pm.evaluate(sh('python foo.py'))).toBe('allow');
  });

  it('never strips deny rules — user intent for deny is honored', () => {
    const pm = makePm({
      permissionsDeny: ['Bash', 'Agent'],
      permissionsAllow: ['Bash(git log)'],
    });

    pm.stripDangerousRulesForAutoMode();
    // Bash deny still applies — no allow rule can override it after strip.
    return expect(pm.evaluate(sh('git log'))).resolves.toBe('deny');
  });

  it('auto-strips on initialize when approvalMode is "auto"', () => {
    const pm = makePm({
      permissionsAllow: ['Bash(python:*)'],
      approvalMode: 'auto',
    });
    expect(pm.getAllowRawStrings()).toEqual([]);
    expect(pm.getStrippedDangerousRules()?.persistent).toHaveLength(1);
  });

  it('does NOT auto-strip when approvalMode is the default', () => {
    const pm = makePm({ permissionsAllow: ['Bash(python:*)'] });
    expect(pm.getAllowRawStrings()).toEqual(['Bash(python:*)']);
    expect(pm.getStrippedDangerousRules()).toBeUndefined();
  });
});

// ─── Compound shell + cd + wrapper → virtual-op rule matching ───────────────
// Regression coverage for compound shell writes reaching protected paths
// through `cd` and shell wrappers.

describe('PermissionManager — compound shell write attribution', () => {
  /** A manager rooted at `/repo` (cwd and project root) with `rules`. */
  const repoPm = (rules: PmOpts) =>
    makePm({ ...rules, cwd: '/repo', projectRoot: '/repo' });
  const denySettings = {
    permissionsDeny: ['WriteFileTool(.qwen/settings.json)'],
  };
  const opsIn = (command: string) =>
    extractShellOperationsAcrossCommand(command, '/project');
  const writeTo = (filePath: string) => [
    { virtualTool: 'write_file', filePath },
  ];

  it('deny rule matches a write after `cd` into a subdir', async () => {
    const ctx = sh("cd .qwen && echo '{}' > settings.json", '/repo');
    expect(await repoPm(denySettings).evaluate(ctx)).toBe('deny');
  });

  it('deny rule matches a write through a `bash -lc` wrapper after `cd`', async () => {
    const ctx = sh("cd .qwen && bash -lc 'echo {} > settings.json'", '/repo');
    expect(await repoPm(denySettings).evaluate(ctx)).toBe('deny');
  });

  it('ask rule matches a write through nested shell wrappers', async () => {
    const pm = repoPm({ permissionsAsk: ['WriteFileTool(.mcp.json)'] });
    const ctx = sh('bash -lc "sh -c \'echo hi > .mcp.json\'"', '/repo');
    expect(await pm.evaluate(ctx)).toBe('ask');
  });

  it('allow rule on the same shell command does NOT downgrade a virtual-op deny', async () => {
    // The Bash allow rule covers the literal command, but the cross-command
    // virtual-op pass surfaces the write target, whose deny rule escalates
    // the verdict: allow + virtual-op deny → deny ("deny > ask > allow").
    const pm = repoPm({ permissionsAllow: ['Bash(*)'], ...denySettings });
    const ctx = sh("cd .qwen && bash -lc 'echo {} > settings.json'", '/repo');
    expect(await pm.evaluate(ctx)).toBe('deny');
  });

  // #11865: a redirect target of non-separator characters (one NBSP here) is a
  // real filename to bash and must survive into the virtual op; deleting it
  // with `String.prototype.trim` dropped the write from a `deny` verdict.
  it('attributes a write whose whole target is an invisible character', () => {
    expect(opsIn('echo x >\r& echo y')).toEqual(writeTo('/project/\r'));
    expect(opsIn('echo x >\u00a0& echo y')).toEqual(writeTo('/project/\u00a0'));
  });

  it('does not invent a read op when an invisible target is followed by a word', () => {
    // `cat >\u00a0` takes no argument, so a deleted target left the bare `>`
    // in the positional args and `looksLikePath('>')` turned the real write
    // into a spurious `read_file '/project/>'`.
    expect(opsIn('cat >\u00a0& echo hi')).toEqual(writeTo('/project/\u00a0'));
  });

  // Same defect on the `\n` spelling: the CR of a CRLF pair is dropped with the
  // line ending, but a CR that *is* the whole redirect target took the write
  // with it and left the bare `>` for `looksLikePath('>')` to invent a
  // `read_file` of the matchable `/project/>`, firing `Read(//project/**)`.
  it('attributes a CR redirect target across a newline instead of inventing a read', () => {
    expect(opsIn('echo x >\r\necho y')).toEqual(writeTo('/project/\r'));
    expect(opsIn('cat >\r\necho hi')).toEqual(writeTo('/project/\r'));
  });

  // The verdict, not the op: bash keeps each target character in the word, so
  // the write lands in the denied tree; the `\r` rows were `allow` until the
  // path matcher stopped handing line terminators to picomatch (#11865).
  it.each([
    ['\\r (whole target)', 'echo x >\r& echo y'],
    ['\\r (visible prefix)', 'echo x >out\r& echo y'],
    ['\\v', 'echo x >\v& echo y'],
    ['\\f', 'echo x >\f& echo y'],
    ['\\u00a0', 'echo x >\u00a0& echo y'],
  ])(
    'denies an invisible write inside a denied directory: %s',
    async (_label, command) => {
      const pm = makePm({
        permissionsAllow: ['Bash(echo *)'],
        permissionsDeny: ['Edit(//project/**)', 'Write(//project/**)'],
      });
      expect(await pm.evaluate(sh(command, '/project'))).toBe('deny');
    },
  );

  it('ordinary writes after `cd` into project subdirs stay unmatched by self-mod rules', () => {
    const ctx = sh("cd src && bash -lc 'echo ok > generated.txt'", '/repo');
    expect(repoPm(denySettings).hasRelevantRules(ctx)).toBe(false);
  });

  it('does not treat canonical-only allow matches as relevant', () =>
    withTempRoot((root) => {
      const { link } = linkDir(root, { 'file.txt': 'allowed' }, 'allowed');
      const file = path.join(link, 'file.txt');
      const pm = makePm({
        permissionsAllow: ['Edit(/allowed/**)'],
        cwd: root,
        projectRoot: root,
      });
      const edit = { toolName: 'edit', filePath: file };
      expect(pm.hasRelevantRules(edit)).toBe(false);
      const write = sh(`echo allowed > ${file}`, root);
      expect(pm.hasRelevantRules(write)).toBe(false);
    }));

  it('hasRelevantRules sees protected writes after sibling shell-wrapper segments', () => {
    const command = "bash -lc 'echo ok' && echo hi > .qwen/settings.json";
    const ctx = sh(command, '/repo');
    expect(repoPm(denySettings).hasRelevantRules(ctx)).toBe(true);
  });

  it('hasRelevantRules sees protected writes after `cd` before compound recursion', () => {
    const pm = repoPm({ permissionsDeny: ['Write(.qwen/settings.json)'] });
    const ctx = sh("cd .qwen && bash -lc 'echo {} > settings.json'", '/repo');
    expect(pm.hasRelevantRules(ctx)).toBe(true);
  });

  it('hasMatchingAskRule sees writes after `cd` into a subdir', () => {
    const pm = repoPm({
      permissionsAsk: ['WriteFileTool(.qwen/settings.json)'],
    });
    const ctx = sh("cd .qwen && bash -lc 'echo {} > settings.json'", '/repo');
    expect(pm.hasMatchingAskRule(ctx)).toBe(true);
  });

  it('escalates dynamic-cd writes when path-specific deny rules may apply', async () => {
    const pm = repoPm({ permissionsAllow: ['Bash(*)'], ...denySettings });
    const ctx = sh('cd "$TARGET" && echo hi > ../settings.json', '/repo');
    expect(pm.hasRelevantRules(ctx)).toBe(true);
    expect(await pm.evaluate(ctx)).toBe('ask');
  });

  it('preserves wildcard deny rules for dynamic-cd writes', async () => {
    const pm = repoPm({
      permissionsAllow: ['Bash(*)'],
      permissionsDeny: ['WriteFileTool(*)'],
    });
    const ctx = sh('cd "$TARGET" && echo hi > settings.json', '/repo');
    expect(await pm.evaluate(ctx)).toBe('deny');
  });
});

// ─── PermissionManager integration tests with toolParams ─────────────────────

describe('PermissionManager — toolParams end-to-end', () => {
  it('evaluate respects allow rule with param matcher', async () => {
    const pm = makePm({ permissionsAllow: ['Agent(coder,model:opus)'] });
    const ctx = agentCtx({ subagent_type: 'coder', model: 'opus' }, 'coder');
    expect(await pm.evaluate(ctx)).toBe('allow');
  });

  it('evaluate denies when param matcher does not match', async () => {
    const pm = makePm({ permissionsAllow: ['Agent(coder,model:opus)'] });
    const ctx = agentCtx({ subagent_type: 'coder', model: 'sonnet' }, 'coder');
    expect(await pm.evaluate(ctx)).not.toBe('allow');
  });

  it('findMatchingDenyRule matches deny rule with param matcher', () => {
    const pm = makePm({ permissionsDeny: ['Agent(model:restricted)'] });
    const ctx = agentCtx({ model: 'restricted' });
    expect(pm.findMatchingDenyRule(ctx)).toBe('Agent(model:restricted)');
  });

  it('findMatchingDenyRule returns undefined when param does not match', () => {
    const pm = makePm({ permissionsDeny: ['Agent(model:restricted)'] });
    const ctx = agentCtx({ model: 'opus' });
    expect(pm.findMatchingDenyRule(ctx)).toBeUndefined();
  });

  it('hasRelevantRules returns true when param matcher rule exists', () => {
    const pm = makePm({ permissionsAsk: ['Agent(model:opus)'] });
    expect(pm.hasRelevantRules(agentCtx({ model: 'opus' }))).toBe(true);
  });

  it('hasMatchingAskRule returns true when param matcher ask rule matches', () => {
    const pm = makePm({ permissionsAsk: ['Agent(model:opus)'] });
    expect(pm.hasMatchingAskRule(agentCtx({ model: 'opus' }))).toBe(true);
  });

  it('case-insensitive param matching: deny rule blocks different casing', async () => {
    const pm = makePm({ permissionsDeny: ['Agent(model:Sonnet)'] });
    expect(await pm.evaluate(agentCtx({ model: 'sonnet' }))).toBe('deny');
  });
});

// ─── evaluateParamMatchers type guard tests ──────────────────────────────────

describe('matchesRule — param matcher type guards', () => {
  it.each([
    ['rejects boolean param values', 'model:*', { model: true }, false],
    ['rejects null param values', 'model:*', { model: null }, false],
    ['rejects undefined param values', 'model:*', { model: undefined }, false],
    [
      'rejects object param values',
      'model:*',
      { model: { nested: 'opus' } },
      false,
    ],
    [
      'accepts number param values via coercion',
      'count:42',
      { count: 42 },
      true,
    ],
  ])('%s', (_title, matcher, toolParams, expected) => {
    expect(matchesAgent(parseRule(`Agent(${matcher})`), toolParams)).toBe(
      expected,
    );
  });
});
