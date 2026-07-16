/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The gap these close, and the noise they must not make.
//
// `/review` runs on other people's repositories. A built-in checklist that fires on
// every one of them, saying things their maintainers already decided against, is not
// a feature — it is the thing that teaches an author to stop reading the review. So
// two properties are tested here with equal weight: that the rule ARRIVES when the
// diff touches a workflow, and that it is ABSENT, and silent, when it does not.

import { describe, it, expect } from 'vitest';
import { pathRulesFor, PATH_RULES } from './path-rules.js';

describe('pathRulesFor — scoped, or it is noise', () => {
  it('is empty for a diff that touches no rule-governed file', () => {
    // The common case, and the one that has to cost nothing. A TypeScript PR must
    // not be handed a GitHub Actions syllabus.
    expect(pathRulesFor(['src/pay.ts', 'src/pay.test.ts', 'README.md'])).toBe(
      '',
    );
  });

  it('is empty for a diff with no files at all', () => {
    expect(pathRulesFor([])).toBe('');
  });

  it('attaches the workflow checklist when a workflow changes', () => {
    const out = pathRulesFor(['.github/workflows/ci.yml', 'src/pay.ts']);
    expect(out).toContain('GitHub Actions workflows');
    // And it names which file triggered it — an agent that cannot see why a rule
    // arrived applies it to the wrong file.
    expect(out).toContain('.github/workflows/ci.yml');
    expect(out).not.toContain('src/pay.ts');
  });

  it.each([
    ['.github/workflows/ci.yml', true],
    ['.github/workflows/nested/ci.yaml', true],
    ['.github/actions/setup/action.yml', true],
    ['.github/dependabot.yml', false],
    ['.github/ISSUE_TEMPLATE/bug.yml', false],
    ['deploy/workflows/ci.yml', false],
    ['src/github/workflows/ci.yml', false],
  ])('%s → governed by a rule: %s', (path, governed) => {
    expect(PATH_RULES.some((r) => r.matches(path))).toBe(governed);
  });

  it('names the attack classes no dimension agent would think to ask about', () => {
    const out = pathRulesFor(['.github/workflows/x.yml']);
    // The one that matters most: a privileged trigger that runs the contributor's
    // code with the base repository's write token.
    expect(out).toContain('pull_request_target');
    expect(out).toContain('head.sha');
    // Expression injection into `run:`.
    expect(out).toMatch(/interpolated into a `run:`/);
    // And the two that shade into taste, which is why they are Suggestions.
    expect(out).toContain('mutable tag');
    expect(out).toContain('permissions:');
  });

  it('does not turn a foreign project into a lint sweep', () => {
    // Three self-restraints, because /review runs on repositories whose maintainers
    // never asked for this: it reviews the DIFF, it exempts the conventions almost
    // everyone keeps, and it says out loud that a false alarm costs more than a
    // missed nit.
    const out = pathRulesFor(['.github/workflows/x.yml']);
    expect(out).toContain('reviewing this diff, not auditing this file');
    expect(out).toMatch(/actions\/\*.*common exception/s);
    expect(out).toContain('Favour precision over recall');
    // The two taste-adjacent items are Suggestions, and say so.
    expect(out).toMatch(/\*\*Recommendations \(Suggestion\)/);
  });

  it('does not make the blast radius of a blocker into a separate Suggestion', () => {
    // Dogfooded against a planted vulnerability, the security agent read the flat
    // rule ("`permissions:` is a Suggestion") and escalated anyway — "grants maximum
    // token scope to a job that processes untrusted contributor code, amplifying the
    // RCE above". It was right and the rule was too coarse. A broad token on a job
    // that runs the contributor's code is not a recommendation; it is how far the
    // blocker reaches.
    const out = pathRulesFor(['.github/workflows/x.yml']);
    expect(out).toContain('blast radius of the blocker above');
  });
});
