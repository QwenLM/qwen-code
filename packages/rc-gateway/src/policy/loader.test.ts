/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPolicy,
  loadPolicyFile,
  loadLayeredPolicy,
  policyAdvisories,
  POLICY_PERMISSIONS_WARNING_KEYWORD,
  PolicyError,
} from './loader.js';

const lintWarningsFor = (yaml: string) => policyAdvisories(loadPolicy(yaml));

describe('loadPolicy', () => {
  it('parses valid YAML and fills in defaults', () => {
    const policy = loadPolicy(`
version: 1
rules:
  - id: allow-tests
    match:
      tool: execute
      argsGlob: "npm test*"
    action: allow
`);
    expect(policy.version).toBe(1);
    expect(policy.defaults).toEqual({
      action: 'prompt',
      requireScope: 'approve',
    });
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].id).toBe('allow-tests');
    expect(policy.rules[0].action).toBe('allow');
    expect(policy.rules[0].match.tool).toBe('execute');
  });

  it('honors explicit defaults', () => {
    const policy = loadPolicy(`
defaults:
  action: deny
  requireScope: owner
`);
    expect(policy.defaults).toEqual({ action: 'deny', requireScope: 'owner' });
    expect(policy.rules).toEqual([]);
  });

  it('throws PolicyError when parsed doc is not a plain object', () => {
    expect(() => loadPolicy('- a\n- b')).toThrow(PolicyError);
    expect(() => loadPolicy('42')).toThrow(PolicyError);
  });

  it('treats empty/null document as an empty policy with defaults', () => {
    const policy = loadPolicy('');
    expect(policy.defaults).toEqual({
      action: 'prompt',
      requireScope: 'approve',
    });
    expect(policy.rules).toEqual([]);
  });

  it('throws PolicyError on invalid defaults.action', () => {
    expect(() => loadPolicy('defaults:\n  action: maybe')).toThrow(PolicyError);
  });

  it('throws PolicyError when a rule is missing action', () => {
    expect(() => loadPolicy('rules:\n  - match:\n      tool: execute')).toThrow(
      PolicyError,
    );
  });

  it('throws PolicyError on an invalid rule action', () => {
    expect(() =>
      loadPolicy('rules:\n  - match: {tool: execute}\n    action: maybe'),
    ).toThrow(PolicyError);
  });

  it('throws PolicyError when a rule match is not an object', () => {
    expect(() =>
      loadPolicy('rules:\n  - match: "bash"\n    action: allow'),
    ).toThrow(PolicyError);
  });

  it('throws PolicyError when a rule is not an object', () => {
    expect(() => loadPolicy('rules:\n  - "bash"')).toThrow(PolicyError);
  });

  it('ignores unknown top-level and rule fields (forward-compat)', () => {
    const policy = loadPolicy(`
unknownTop: hello
rules:
  - match: {tool: execute}
    action: allow
    futureField: 99
`);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].action).toBe('allow');
  });
});

describe('loadPolicy — tool alias normalization and match.operation', () => {
  it('normalizes a tool-name alias to its ACP kind', () => {
    const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: run_shell_command }
    action: deny
defaults: { action: prompt }
`);
    expect(p.rules[0].match.tool).toBe('execute');
  });

  it('accepts a kind directly', () => {
    const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: execute }
    action: deny
defaults: { action: prompt }
`);
    expect(p.rules[0].match.tool).toBe('execute');
  });

  it('maps write_file and edit to the same kind', () => {
    const p = loadPolicy(`
rules:
  - id: a
    match: { tool: write_file }
    action: deny
  - id: b
    match: { tool: edit }
    action: deny
defaults: { action: prompt }
`);
    expect(p.rules[0].match.tool).toBe('edit');
    expect(p.rules[1].match.tool).toBe('edit');
  });

  it('rejects an unknown tool value', () => {
    expect(() =>
      loadPolicy(`
rules:
  - id: r1
    match: { tool: not_a_tool }
    action: deny
defaults: { action: prompt }
`),
    ).toThrow(/not_a_tool/);
  });

  it('accepts and validates match.operation', () => {
    const p = loadPolicy(`
rules:
  - id: r1
    match: { operation: write }
    action: deny
defaults: { action: prompt }
`);
    expect(p.rules[0].match.operation).toBe('write');
    expect(() =>
      loadPolicy(`
rules:
  - id: r1
    match: { operation: delete }
    action: deny
defaults: { action: prompt }
`),
    ).toThrow(/operation/);
  });

  it('leaves the wildcard tool alone', () => {
    const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: "*" }
    action: deny
defaults: { action: prompt }
`);
    expect(p.rules[0].match.tool).toBe('*');
  });
});

describe('loadPolicy — aliasedTool contract', () => {
  it('sets aliasedTool to the original name when tool was written as a tool-name alias', () => {
    const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: run_shell_command }
    action: allow
defaults: { action: prompt }
`);
    expect(p.rules[0].aliasedTool).toBe('run_shell_command');
    expect(p.rules[0].match.tool).toBe('execute');
  });

  it('leaves aliasedTool undefined when tool was already written as a kind', () => {
    const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: execute }
    action: allow
defaults: { action: prompt }
`);
    expect(p.rules[0].aliasedTool).toBeUndefined();
  });

  it('leaves aliasedTool undefined for a wildcard tool', () => {
    const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: "*" }
    action: allow
defaults: { action: prompt }
`);
    expect(p.rules[0].aliasedTool).toBeUndefined();
  });
});

describe('policyAdvisories', () => {
  it('warns when an allow rule uses a widening tool alias', async () => {
    const warnings = lintWarningsFor(`
rules:
  - id: a
    match: { tool: write_file }
    action: allow
defaults: { action: prompt }
`);
    expect(warnings.join('\n')).toMatch(/write_file/);
    expect(warnings.join('\n')).toMatch(/also matches/i);
  });

  it('does not warn for a deny rule using the same alias', () => {
    const warnings = lintWarningsFor(`
rules:
  - id: a
    match: { tool: write_file }
    action: deny
defaults: { action: prompt }
`);
    expect(warnings.join('\n')).not.toMatch(/also matches/i);
  });

  it('reports how many allow rules are newly effective', () => {
    const warnings = lintWarningsFor(`
rules:
  - id: a
    match: { tool: read_file }
    action: allow
  - id: b
    match: { tool: execute }
    action: allow
defaults: { action: prompt }
`);
    expect(warnings.join('\n')).toMatch(/2 allow rule/);
  });
});

describe('deferred-field warning', () => {
  // `warnedDeferred` is a module-global once-latch; reset the module so each
  // test starts unlatched, and import the fresh copy dynamically (a static
  // top-of-file import would share the original module's latch).
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT warn for a rule with ONLY timeOfDay (now evaluated)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadPolicy: load } = await import('./loader.js');
    load(`
rules:
  - match:
      tool: execute
      timeOfDay:
        from: "09:00"
        to: "17:00"
        timezone: UTC
    action: allow
`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn for a rule with ONLY expiresAt (now evaluated)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadPolicy: load } = await import('./loader.js');
    load(`
rules:
  - match:
      tool: execute
    action: deny
    expiresAt: "2030-01-01T00:00:00Z"
`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn for a (now-honored) maxPerWindow rule', async () => {
    // Cycle 43: maxPerWindow is validated + honored at runtime by the quota store,
    // so it is no longer a "deferred field" and emits no load-time warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadPolicy: load } = await import('./loader.js');
    load(`
rules:
  - match:
      tool: execute
    action: allow
    maxPerWindow: { count: 5, windowSec: 60 }
`);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loadPolicyFile', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns null when the file is absent', async () => {
    const result = await loadPolicyFile(
      join(tmpdir(), 'does-not-exist-policy-xyz.yaml'),
    );
    expect(result).toBeNull();
  });

  it('parses a present file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policy-'));
    const path = join(dir, 'policy.yaml');
    await writeFile(
      path,
      'rules:\n  - match: {tool: execute}\n    action: deny\n',
    );
    const policy = await loadPolicyFile(path);
    expect(policy).not.toBeNull();
    expect(policy!.rules[0].action).toBe('deny');
  });
});

describe('loadLayeredPolicy — policy_permissions_warning', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('POLICY_PERMISSIONS_WARNING_KEYWORD is exactly "policy_permissions_warning"', () => {
    expect(POLICY_PERMISSIONS_WARNING_KEYWORD).toBe(
      'policy_permissions_warning',
    );
  });

  it('emits a policy_permissions_warning when user-scope file is group-readable (0644)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policy-rdwarn-'));
    const userPath = join(dir, 'policy.yaml');
    await writeFile(userPath, 'rules: []\n', { mode: 0o644 });
    const warnings: string[] = [];
    await loadLayeredPolicy(userPath, undefined, (msg) => warnings.push(msg));
    const w = warnings.find((m) =>
      m.includes(POLICY_PERMISSIONS_WARNING_KEYWORD),
    );
    expect(w).toBeDefined();
    expect(w).toContain(userPath);
    expect(w).toContain('0644');
    expect(w).toContain('chmod go-r');
  });

  it('emits a policy_permissions_warning when user-scope file is world-readable (0604)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policy-rdwarn-'));
    const userPath = join(dir, 'policy.yaml');
    await writeFile(userPath, 'rules: []\n', { mode: 0o604 });
    const warnings: string[] = [];
    await loadLayeredPolicy(userPath, undefined, (msg) => warnings.push(msg));
    const w = warnings.find((m) =>
      m.includes(POLICY_PERMISSIONS_WARNING_KEYWORD),
    );
    expect(w).toBeDefined();
    expect(w).toContain('0604');
  });

  it('does NOT emit the warning when user-scope file has mode 0600', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policy-rdwarn-'));
    const userPath = join(dir, 'policy.yaml');
    await writeFile(userPath, 'rules: []\n', { mode: 0o600 });
    const warnings: string[] = [];
    await loadLayeredPolicy(userPath, undefined, (msg) => warnings.push(msg));
    expect(
      warnings.some((m) => m.includes(POLICY_PERMISSIONS_WARNING_KEYWORD)),
    ).toBe(false);
  });

  it('does NOT emit the warning when the user-scope file is absent (ENOENT)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policy-rdwarn-'));
    const userPath = join(dir, 'absent.yaml');
    const warnings: string[] = [];
    await loadLayeredPolicy(userPath, undefined, (msg) => warnings.push(msg));
    expect(
      warnings.some((m) => m.includes(POLICY_PERMISSIONS_WARNING_KEYWORD)),
    ).toBe(false);
  });

  it('does NOT emit the warning for a group-readable workspace policy file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policy-rdwarn-'));
    const userPath = join(dir, 'absent-user.yaml'); // absent user file
    const wsDir = join(dir, 'ws');
    const wsPolicyDir = join(wsDir, '.qwen');
    await writeFile(join(dir, 'policy.yaml'), 'rules: []\n', { mode: 0o644 }); // readable but this is the user path
    // Create workspace policy dir + file
    await writeFile(
      userPath.replace('absent-user.yaml', 'user-ok.yaml'),
      'rules: []\n',
      { mode: 0o600 },
    );
    // Actually use a truly absent user path + a readable workspace file
    const wsPolicy = join(wsPolicyDir, 'policy.yaml');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(wsPolicyDir, { recursive: true });
    await writeFile(wsPolicy, 'rules: []\n', { mode: 0o644 });
    const warnings: string[] = [];
    await loadLayeredPolicy(join(dir, 'absent-user.yaml'), wsDir, (msg) =>
      warnings.push(msg),
    );
    // Only the user-scope file triggers the warning; workspace does not
    expect(
      warnings.some((m) => m.includes(POLICY_PERMISSIONS_WARNING_KEYWORD)),
    ).toBe(false);
  });
});
