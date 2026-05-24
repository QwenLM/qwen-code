/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// render-review-prompt.cjs is CommonJS (.cjs ext because the repo root
// package.json sets "type": "module"). Vitest's ESM<->CJS interop
// exposes its CommonJS exports to this ESM test file as named imports.
import { describe, it, expect } from 'vitest';
import { render, parseArgs, ArgError } from '../render-review-prompt.cjs';

describe('render', () => {
  it('substitutes both placeholders', () => {
    const tmpl = 'before <<<PR_CONTEXT>>> mid <<<REVIEW_RULES_MD>>> after';
    expect(render(tmpl, { context: 'CTX', rules: 'RULES' })).toBe(
      'before CTX mid RULES after',
    );
  });

  it('replaces every occurrence of a placeholder', () => {
    const tmpl = '<<<PR_CONTEXT>>> and again <<<PR_CONTEXT>>>';
    expect(render(tmpl, { context: 'X' })).toBe('X and again X');
  });

  it('leaves a placeholder untouched when its value is not passed', () => {
    // LIGHT-style templates carry <<<REVIEW_RULES_MD>>>; STANDARD-style
    // ones do not. Passing only --context must not touch the other.
    const tmpl = 'ctx=<<<PR_CONTEXT>>> rules=<<<REVIEW_RULES_MD>>>';
    expect(render(tmpl, { context: 'C' })).toBe(
      'ctx=C rules=<<<REVIEW_RULES_MD>>>',
    );
  });

  it('inserts content containing $1 / $& verbatim (no regex special-pattern)', () => {
    // The substituted value is real PR-diff text and may contain `$1`,
    // `$&`, `$$` — these must NOT be interpreted as replacement patterns.
    const tricky = 'diff has $1 and $& and $$ literally';
    expect(render('<<<PR_CONTEXT>>>', { context: tricky })).toBe(tricky);
  });

  it('substitutes rules before context so a PR body cannot inject rules', () => {
    // Security invariant: <<<REVIEW_RULES_MD>>> is substituted FIRST so that
    // a PR body (untrusted) carrying the literal token `<<<REVIEW_RULES_MD>>>`
    // is not picked up by the rules pass and used to inject content into
    // the review-rules section of the prompt. If a future refactor swaps
    // the order, this guarantee silently breaks; lock it in with an
    // end-to-end test rather than relying on the implementation comment.
    const tmpl = 'RULES:<<<REVIEW_RULES_MD>>>\nPR:<<<PR_CONTEXT>>>';
    const malicious = 'innocuous body has <<<REVIEW_RULES_MD>>> in it';
    const result = render(tmpl, { context: malicious, rules: 'REAL_RULES' });
    expect(result).toBe(`RULES:REAL_RULES\nPR:${malicious}`);
  });
});

describe('parseArgs', () => {
  it('collects positionals and flags', () => {
    const { positional, flags } = parseArgs([
      'tmpl.md',
      'out.md',
      '--context',
      'ctx.md',
      '--rules',
      'rules.md',
    ]);
    expect(positional).toEqual(['tmpl.md', 'out.md']);
    expect(flags).toEqual({ context: 'ctx.md', rules: 'rules.md' });
  });

  it('accepts flags interleaved with positionals', () => {
    const { positional, flags } = parseArgs([
      '--context',
      'ctx.md',
      'tmpl.md',
      'out.md',
    ]);
    expect(positional).toEqual(['tmpl.md', 'out.md']);
    expect(flags).toEqual({ context: 'ctx.md' });
  });

  it('throws ArgError when a flag has no following value', () => {
    expect(() => parseArgs(['tmpl.md', 'out.md', '--context'])).toThrow(
      ArgError,
    );
  });

  it('throws ArgError when a flag is followed by another flag', () => {
    expect(() =>
      parseArgs(['tmpl.md', 'out.md', '--context', '--rules', 'r.md']),
    ).toThrow(ArgError);
  });
});
