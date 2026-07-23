/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseExplainArgs,
  formatExplanation,
  ExplainArgsError,
} from './explain.js';
import { explainPolicy } from './evaluator.js';
import type { Policy } from './loader.js';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('parseExplainArgs', () => {
  it('takes the first non-flag token as the tool', () => {
    const { tool, ctx } = parseExplainArgs(['bash', '--args=npm test']);
    expect(tool).toBe('bash');
    expect(ctx.tool).toBe('bash');
  });

  it('--args="npm test" → raw string (spec form)', () => {
    const { ctx } = parseExplainArgs(['bash', '--args=npm test']);
    expect(ctx.args).toBe('npm test');
  });

  it('--args with JSON object → parsed object', () => {
    const { ctx } = parseExplainArgs(['bash', '--args={"command":"rm -rf /"}']);
    expect(ctx.args).toEqual({ command: 'rm -rf /' });
  });

  it('--args with malformed JSON → falls back to the raw string', () => {
    const { ctx } = parseExplainArgs(['bash', '--args={not json']);
    expect(ctx.args).toBe('{not json');
  });

  it('--path alone → args = { path }', () => {
    const { ctx } = parseExplainArgs(['read', '--path=/etc/passwd']);
    expect(ctx.args).toEqual({ path: '/etc/passwd' });
  });

  it('--path merges into a JSON object args (when absent)', () => {
    const { ctx } = parseExplainArgs([
      'read',
      '--args={"mode":"r"}',
      '--path=/etc/passwd',
    ]);
    expect(ctx.args).toEqual({ mode: 'r', path: '/etc/passwd' });
  });

  it('--path does NOT clobber an explicit path in JSON args', () => {
    const { ctx } = parseExplainArgs([
      'read',
      '--args={"path":"/a"}',
      '--path=/b',
    ]);
    expect(ctx.args).toEqual({ path: '/a' });
  });

  it('string --args + --path → --path wins, string dropped (documented)', () => {
    const { ctx } = parseExplainArgs([
      'read',
      '--args=just a string',
      '--path=/etc/passwd',
    ]);
    expect(ctx.args).toEqual({ path: '/etc/passwd' });
  });

  it('--scope and --tag map to originScope / sessionTag', () => {
    const { ctx } = parseExplainArgs(['bash', '--scope=owner', '--tag=prod']);
    expect(ctx.originScope).toBe('owner');
    expect(ctx.sessionTag).toBe('prod');
  });

  it('missing tool → tool undefined (ctx.tool empty)', () => {
    const { tool, ctx } = parseExplainArgs(['--args=x']);
    expect(tool).toBeUndefined();
    expect(ctx.tool).toBe('');
  });

  it('ignores unknown flags and bare --flags', () => {
    const { tool, ctx } = parseExplainArgs(['bash', '--bogus=1', '--verbose']);
    expect(tool).toBe('bash');
    expect(ctx.args).toBeUndefined();
  });

  it('--path populates ctx.paths for pathGlob rule evaluation', () => {
    const { ctx } = parseExplainArgs(['edit', '--path=/proj/.env']);
    expect(ctx.paths).toEqual(['/proj/.env']);
    expect(ctx.projectRoot).toBe(process.cwd());
    expect(ctx.cwd).toBe(process.cwd());
  });

  it('--operation=write populates ctx.operations', () => {
    const { ctx } = parseExplainArgs(['edit', '--operation=write']);
    expect(ctx.operations).toEqual(['write']);
  });

  it('--operation is comma-separated', () => {
    const { ctx } = parseExplainArgs(['edit', '--operation=read,write']);
    expect(ctx.operations).toEqual(['read', 'write']);
  });

  it('--operation is repeatable', () => {
    const { ctx } = parseExplainArgs([
      'edit',
      '--operation=read',
      '--operation=write',
    ]);
    expect(ctx.operations).toEqual(['read', 'write']);
  });

  it('an invalid --operation value is rejected', () => {
    expect(() => parseExplainArgs(['edit', '--operation=delete'])).toThrow(
      ExplainArgsError,
    );
    expect(() => parseExplainArgs(['edit', '--operation=delete'])).toThrow(
      /invalid --operation value 'delete'/,
    );
  });

  it('no --operation flag leaves ctx.operations unset', () => {
    const { ctx } = parseExplainArgs(['edit']);
    expect(ctx.operations).toBeUndefined();
  });

  it('--project-root overrides the process.cwd() default for projectRoot/cwd', () => {
    const { ctx } = parseExplainArgs(['read', '--project-root=/some/proj']);
    expect(ctx.projectRoot).toBe('/some/proj');
    expect(ctx.cwd).toBe('/some/proj');
  });

  it('without --project-root, projectRoot/cwd default to process.cwd()', () => {
    const { ctx } = parseExplainArgs(['read']);
    expect(ctx.projectRoot).toBe(process.cwd());
    expect(ctx.cwd).toBe(process.cwd());
  });
});

function policy(rules: Policy['rules']): Policy {
  return { defaults: { action: 'prompt', requireScope: 'approve' }, rules };
}

describe('formatExplanation', () => {
  it('renders MATCHED / not-reached lines and the decision', () => {
    const p = policy([
      { id: 'low', match: { tool: '*' }, action: 'deny' },
      { id: 'high', match: { tool: 'bash' }, action: 'allow' },
    ]);
    const out = formatExplanation(explainPolicy(p, { tool: 'bash' }, NOW));
    expect(out).toContain('rules considered (evaluation order):');
    expect(out).toMatch(/MATCHED\s+high -> allow/);
    expect(out).toMatch(/high[\s\S]*low/); // eval order: high before low
    expect(out).toMatch(/not reached: earlier-rule-won/);
    expect(out).toContain('decision: allow (source: rule high)');
  });

  it('renders SKIPPED with a reason and a default decision', () => {
    const p = policy([{ id: 'a', match: { tool: 'git' }, action: 'allow' }]);
    const out = formatExplanation(explainPolicy(p, { tool: 'bash' }, NOW));
    expect(out).toContain('SKIPPED   a (tool-mismatch)');
    expect(out).toContain('decision: prompt (source: default)');
  });

  it('marks a downgraded winner and appends the quota caveat', () => {
    const p = policy([
      {
        id: 'q',
        match: { tool: 'bash' },
        action: 'allow',
        maxPerWindow: { count: 1, windowSec: 60 },
      },
    ]);
    const out = formatExplanation(explainPolicy(p, { tool: 'bash' }, NOW));
    expect(out).toMatch(
      /MATCHED\s+q -> prompt \(downgraded: quota-not-evaluated\)/,
    );
    expect(out).toContain('[downgraded to prompt]');
    expect(out).toContain('no live quota store');
  });

  it('a deny + maxPerWindow rule: caveat never claims "allow"', () => {
    // A deny rule with a quota is valid policy; at runtime with room it stays
    // deny — the caveat must NOT assert it could become allow.
    const p = policy([
      {
        id: 'd',
        match: { tool: 'bash' },
        action: 'deny',
        maxPerWindow: { count: 1, windowSec: 60 },
      },
    ]);
    const out = formatExplanation(explainPolicy(p, { tool: 'bash' }, NOW));
    expect(out).toContain('no live quota store');
    expect(out).not.toMatch(/\ballow\b/);
  });

  it('caveat still fires when a malformed sibling field wins the reason slot', () => {
    // maxPerWindow + a malformed expiresAt: the reason token is
    // malformed-expiresAt, but the quota was still not evaluated → caveat fires.
    const p = policy([
      {
        id: 'q',
        match: { tool: 'bash' },
        action: 'allow',
        maxPerWindow: { count: 1, windowSec: 60 },
        expiresAt: 'not-a-date',
      },
    ]);
    const out = formatExplanation(explainPolicy(p, { tool: 'bash' }, NOW));
    expect(out).toMatch(/downgraded: malformed-expiresAt/);
    expect(out).toContain('no live quota store');
  });

  it('no quota caveat when no maxPerWindow rule is involved', () => {
    const p = policy([{ id: 'a', match: { tool: 'bash' }, action: 'allow' }]);
    const out = formatExplanation(explainPolicy(p, { tool: 'bash' }, NOW));
    expect(out).not.toContain('no live quota store');
  });

  it('renders an id-less matched rule by its index', () => {
    const p = policy([{ match: { tool: 'bash' }, action: 'allow' }]);
    const out = formatExplanation(explainPolicy(p, { tool: 'bash' }, NOW));
    expect(out).toMatch(/MATCHED\s+\[0\] -> allow/);
    expect(out).toContain('decision: allow (source: rule (id-less))');
  });
});
