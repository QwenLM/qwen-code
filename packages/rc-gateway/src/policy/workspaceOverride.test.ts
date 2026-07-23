/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergePolicies, loadLayeredPolicy, type Policy } from './loader.js';
import { evaluate } from './evaluator.js';

function policy(rules: Policy['rules']): Policy {
  return { defaults: { action: 'prompt', requireScope: 'approve' }, rules };
}

describe('mergePolicies', () => {
  it('returns the user policy unchanged when there is no workspace layer', () => {
    const user = policy([
      { id: 'u', match: { tool: 'execute' }, action: 'deny' },
    ]);
    expect(mergePolicies(null, user)).toBe(user);
  });

  it('prepends workspace rules and keeps the USER defaults (ignores workspace defaults)', () => {
    const user: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [{ id: 'u', match: { tool: 'execute' }, action: 'deny' }],
    };
    const workspace: Policy = {
      defaults: { action: 'allow' }, // must be ignored
      rules: [{ id: 'w', match: { tool: 'execute' }, action: 'allow' }],
    };
    const merged = mergePolicies(workspace, user);
    expect(merged.rules.map((r) => r.id)).toEqual(['w', 'u']);
    expect(merged.defaults).toEqual({
      action: 'prompt',
      requireScope: 'approve',
    });
  });
});

describe('loadLayeredPolicy', () => {
  let dir: string;
  let userPath: string;
  let workspaceCwd: string;
  let workspaceFile: string;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-wspolicy-'));
    userPath = join(dir, 'policy.yaml');
    workspaceCwd = join(dir, 'ws');
    workspaceFile = join(workspaceCwd, '.qwen', 'policy.yaml');
    await mkdir(join(workspaceCwd, '.qwen'), { recursive: true });
    warnings = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rule = (id: string, action: string, match: string) =>
    `  - id: ${id}\n    match: ${match}\n    action: ${action}\n`;

  it('absent user file → default-prompt policy', async () => {
    const p = await loadLayeredPolicy(userPath, undefined, warn);
    expect(p.defaults.action).toBe('prompt');
    expect(p.rules).toHaveLength(0);
  });

  it('no workspace file → just the user policy', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('u', 'deny', '{ tool: execute }')}`,
      { mode: 0o600 },
    );
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn);
    expect(p.rules.map((r) => r.id)).toEqual(['u']);
    expect(warnings).toHaveLength(0);
  });

  it('spec scenario: workspace allow + user prompt (same match) → allow with the WORKSPACE ruleId', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('safe-tests', 'prompt', '{ tool: execute }')}`,
    );
    await writeFile(
      workspaceFile,
      `rules:\n${rule('ws-allow', 'allow', '{ tool: execute }')}`,
    );
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn);
    const d = evaluate(p, { tool: 'execute' });
    expect(d.action).toBe('allow');
    expect(d.ruleId).toBe('ws-allow');
  });

  it('a MORE-specific user deny still beats a broad workspace allow', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('user-deny', 'deny', "{ tool: execute, argsGlob: 'git push*' }")}`,
    );
    await writeFile(
      workspaceFile,
      `rules:\n${rule('ws-allow', 'allow', '{ tool: execute }')}`,
    );
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn);
    const d = evaluate(p, {
      tool: 'execute',
      args: 'git push --force origin main',
    });
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('user-deny');
  });

  it('workspace supremacy: workspace allow overrides a user deny at EQUAL specificity+priority → allow', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('user-deny', 'deny', '{ tool: execute }')}`,
    );
    await writeFile(
      workspaceFile,
      `rules:\n${rule('ws-allow', 'allow', '{ tool: execute }')}`,
    );
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn);
    const d = evaluate(p, { tool: 'execute' });
    expect(d.action).toBe('allow');
    expect(d.ruleId).toBe('ws-allow');
  });

  it('priority dominates specificity: a higher-priority workspace allow beats a MORE-specific user deny (documented worst case)', async () => {
    // The user deny is more specific (tool + argsGlob = 130) but priority 0; the
    // workspace allow is broad (tool = 100) but priority 5. The evaluator sorts
    // priority FIRST, so the workspace allow wins → the documented widening where
    // a workspace rule overrides even a more-specific user deny via priority.
    await writeFile(
      userPath,
      `rules:\n  - id: user-deny\n    match: { tool: execute, argsGlob: 'git push*' }\n    action: deny\n`,
    );
    await writeFile(
      workspaceFile,
      `rules:\n  - id: ws-allow\n    match: { tool: execute }\n    action: allow\n    priority: 5\n`,
    );
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn);
    const d = evaluate(p, {
      tool: 'execute',
      args: 'git push --force origin main',
    });
    expect(d.action).toBe('allow');
    expect(d.ruleId).toBe('ws-allow');
  });

  it('a higher-priority USER deny still beats a lower-priority workspace allow', async () => {
    // The inverse: priority lets the user protect a call the workspace would allow.
    await writeFile(
      userPath,
      `rules:\n  - id: user-deny\n    match: { tool: execute }\n    action: deny\n    priority: 10\n`,
    );
    await writeFile(
      workspaceFile,
      `rules:\n  - id: ws-allow\n    match: { tool: execute }\n    action: allow\n    priority: 5\n`,
    );
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn);
    const d = evaluate(p, { tool: 'execute' });
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('user-deny');
  });

  it('fail-closed: a malformed workspace file is logged + ignored; the user policy stays intact', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('user-deny', 'deny', '{ tool: execute }')}`,
    );
    await writeFile(workspaceFile, 'rules: not-a-sequence\n');
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn);
    // Workspace ignored → the user deny still governs.
    expect(evaluate(p, { tool: 'execute' }).ruleId).toBe('user-deny');
    expect(warnings.some((w) => w.includes('workspace policy.yaml'))).toBe(
      true,
    );
  });

  it('a malformed USER file throws (cycle-14 boot-fail preserved)', async () => {
    await writeFile(userPath, 'rules: 5\n');
    await expect(
      loadLayeredPolicy(userPath, workspaceCwd, warn),
    ).rejects.toThrow();
  });

  // cycle 45: hot-reload must RETAIN the previous ruleset on a malformed
  // workspace edit, NOT silently drop the layer (which would widen permissions).
  it('strictWorkspace: a malformed workspace file THROWS (reload retains previous)', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('user-allow', 'allow', '{ tool: execute }')}`,
    );
    await writeFile(workspaceFile, 'rules: not-a-sequence\n');
    await expect(
      loadLayeredPolicy(userPath, workspaceCwd, warn, {
        strictWorkspace: true,
      }),
    ).rejects.toThrow();
  });

  it('strictWorkspace: an ABSENT workspace file still resolves to user-only (intended removal)', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('user-deny', 'deny', '{ tool: execute }')}`,
    );
    // workspaceFile not written → ENOENT.
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn, {
      strictWorkspace: true,
    });
    expect(evaluate(p, { tool: 'execute' }).ruleId).toBe('user-deny');
  });

  it('strictWorkspace: a VALID workspace file still layers normally', async () => {
    await writeFile(
      userPath,
      `rules:\n${rule('user-prompt', 'prompt', '{ tool: execute }')}`,
    );
    await writeFile(
      workspaceFile,
      `rules:\n${rule('ws-allow', 'allow', '{ tool: execute }')}`,
    );
    const p = await loadLayeredPolicy(userPath, workspaceCwd, warn, {
      strictWorkspace: true,
    });
    // Workspace prepended → wins the equal-specificity tie.
    expect(evaluate(p, { tool: 'execute' }).ruleId).toBe('ws-allow');
  });
});
