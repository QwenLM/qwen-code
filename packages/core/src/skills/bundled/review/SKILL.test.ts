/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const skillDir = path.dirname(fileURLToPath(import.meta.url));

// Titles may end in one parenthesized qualifier, e.g. "The two-dot phantom
// regressions (PR #6626)", so the match allows a single nested group.
const POINTER_RE = /\(measured; DESIGN\.md — ([^()\n]+(?:\([^()\n]*\))?)\)/g;
const POINTER_OPEN = '(measured; DESIGN.md — ';

function skillBody(): string {
  return fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
}

function incidentPointers(body: string): string[] {
  return [...body.matchAll(POINTER_RE)].map(([, title]) => title.trim());
}

function incidentHeadings(): string[] {
  const design = fs.readFileSync(path.join(skillDir, 'DESIGN.md'), 'utf8');
  const start = design.indexOf('## Measured incidents');
  const end = design.indexOf('\n## ', start + 1);
  const section = end === -1 ? design.slice(start) : design.slice(start, end);
  return [...section.matchAll(/^### (.+)$/gm)].map(([, title]) => title.trim());
}

describe('bundled review skill', () => {
  it('anchors every SKILL.md incident pointer at a DESIGN.md heading', () => {
    const body = skillBody();
    const pointers = incidentPointers(body);
    expect(pointers.length).toBeGreaterThan(0);

    // A pointer the regex cannot parse must fail loudly, not drop silently:
    // every literal opener owes exactly one match.
    let opens = 0;
    for (
      let i = body.indexOf(POINTER_OPEN);
      i !== -1;
      i = body.indexOf(POINTER_OPEN, i + POINTER_OPEN.length)
    ) {
      opens++;
    }
    expect(pointers).toHaveLength(opens);

    const headings = new Set(incidentHeadings());
    for (const title of pointers) {
      expect(
        headings.has(title),
        `SKILL.md points at a missing DESIGN.md heading: "### ${title}"`,
      ).toBe(true);
    }
  });

  it('leaves no DESIGN.md incident heading without a SKILL.md pointer', () => {
    const referenced = new Set(incidentPointers(skillBody()));
    for (const title of incidentHeadings()) {
      expect(
        referenced.has(title),
        `DESIGN.md incident heading has no SKILL.md pointer: "### ${title}"`,
      ).toBe(true);
    }
  });

  it('keeps the runtime guard against reading DESIGN.md mid-review', () => {
    expect(skillBody()).toContain(
      'Never `read_file` DESIGN.md during a review.',
    );
  });

  it('pins the setup-batch ordering constraints', () => {
    const body = skillBody();
    expect(body).toContain('`fetch-pr` before all of them');
    expect(body).toContain('`agent-prompt --roster` after the rules load');
  });

  it('launches the 3B convergence pair in the same response', () => {
    // The pair's wall-clock saving exists only while both rounds go out
    // together: a later edit serializing the skill while the prompt-builder
    // tests stay green (they call each round builder themselves) restores
    // the extra round wall. Bounded to the 3B section so the 3A pair's
    // identical phrasing cannot satisfy it.
    const body = skillBody();
    const start = body.indexOf('**The convergence pair — 3B');
    const end = body.indexOf('**Do not write the reverse auditor');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = body.slice(start, end);
    expect(section).toContain('`--all-chunks --round 1`');
    expect(section).toContain('`--all-chunks --round 2`');
    expect(section).toContain('in the same response');
    // The reporting transition is the fix for the round-0 blocker; a revert
    // dropping it must fail here, not slip through.
    expect(section).toContain('wait for BOTH fan-outs');
    expect(section).toContain('every shard passed as `--round 2`');
  });

  it('pins the bounded-tail protocol on the round-cap bullet', () => {
    // The ROUND CAP refusal message carries the same verify-only /
    // compose-floor contract; a revert of the bullet's protocol hunk must
    // fail a test, not slip through.
    const body = skillBody();
    expect(body).toContain('`agent-prompt --role verify` **only**');
    expect(body).toContain('no fresh re-verification pass');
  });

  it('pins the relay-entry removal on the CONVERGED bullet', () => {
    // The CONVERGED clear removes the marker on disk, but the entry an
    // earlier stop refusal told the orchestrator to relay is orchestrator
    // state — compose-review's dedup splice stops running once the marker
    // is gone, so only this instruction recalls it. A revert of the
    // sentence must fail a test, not slip through.
    const body = skillBody();
    expect(body).toContain('remove it now — this convergence supersedes');
  });

  it('pins the unbounded-family collapse and its load-bearing clauses', () => {
    // Collapsing an unbounded family into one class-level finding is the whole
    // point of the change. Each clause below carries a distinct obligation a
    // "resolve the contradiction" follow-up is most likely to drop: the surface
    // (not round-count) definition, the anti-enumeration collapse, and the
    // structural-fix ruling. A paraphrase or revert of any must fail a test.
    const body = skillBody();
    expect(body).toContain('Boundedness is a property of the SURFACE');
    expect(body).toContain(
      'collapse the whole family into one class-level finding',
    );
    expect(body).toContain(
      'Rule the class finding `fixed` only when the structural change lands',
    );
    // The rule must govern BOTH sibling paths: the open-blocker re-check routes an
    // unbounded family to the collapse rule instead of enumerating (R3-1/R3-5), and
    // so does the ledger `fixed` bullet's own routing clause (R5-140).
    expect(body).toContain('apply the bounded/unbounded rule above instead');
    expect(body).toContain(
      'apply the bounded/unbounded rule below instead of filing the sibling',
    );
    // A resurfaced sibling of a collapsed family has its own disposition, so the
    // re-check does not fall to still-stands / cannot-tell every round (R3-6).
    expect(body).toContain('superseded by `<class-id>`');
    // Supersession must not retire a proven blocker behind a weaker class finding:
    // the strongest severity/confidence is preserved through the collapse (R5 R1-1).
    expect(body).toContain('Supersession preserves the strongest evidence');
    expect(body).toContain(
      'at least the highest severity AND confidence any absorbed sibling demonstrated',
    );
    // The class finding must carry a demonstrated witness corner or it confirms
    // only low, never posts, and the whole mechanism goes inert.
    expect(body).toContain(
      'The class finding carries one demonstrated entrance as its witness',
    );
  });

  it('pins the enumeration-trap sentence in the 3b role-table row', () => {
    // The role table is a digest, but the enumeration-trap sentence is this PR's
    // stated purpose in the role contract; a revert/paraphrase must fail (R5-487).
    expect(skillBody()).toContain('Also flags the **enumeration trap**');
  });

  it('pins the root-cause-as-one-finding rule against the pattern-merge', () => {
    // The root-cause family must NOT go through the pattern-aggregation merge
    // (severity promotion + per-location expansion → split ledger ids). A revert
    // to "merge them into a single finding" via the merge path must fail here.
    const body = skillBody();
    expect(body).toContain(
      'A root-cause family is one class-level finding, NOT a pattern-aggregation',
    );
    // The load-bearing clauses, not just the heading: root risk (not symptom-max)
    // and root confidence (not symptom-max) — harmonising to highest-severity must
    // fail here (R3-8).
    expect(body).toContain(
      'its severity is the demonstrated risk of the **root** (not the highest symptom)',
    );
    expect(body).toContain("at the **root's own confidence**");
  });

  it('routes both remote-resolution paths through match-remote', () => {
    // The pr-url path (Step 1) and the bare-PR-number path both resolve the
    // remote via the deterministic matcher. A later edit reverting either
    // hunk to the old model-prose rule must fail a test, not slip through.
    const body = skillBody();
    const invocations =
      body.match(/"\$\{QWEN_CODE_CLI:-qwen\}" review match-remote/g) ?? [];
    expect(invocations).toHaveLength(2);
    // The bare-number path threads the host `gh repo view` resolved at —
    // dropping it rematches auth-config-only GHE clones against github.com.
    expect(body).toContain('--host <host from gh repo view>');
    expect(body).toContain('Exit 6 means no remote matches');
    expect(body).toContain(
      'the matcher exits 6 (no remote matches) or 7 (several do)',
    );
  });
});
