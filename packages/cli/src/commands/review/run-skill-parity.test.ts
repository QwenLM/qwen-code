/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `review run` pins the artifacts it captures by exact filename, and those
// names are the bundled skill's to choose: the skill writes
// `--out .qwen/tmp/qwen-review-{target}-composed.json` in Step 6 and the
// report stems in Step 8. `composedNameFor`/`reportPatternFor` are therefore
// a SECOND copy of a template that lives in prose — and when the two drift,
// every affected `review run` completes (and, with --comment, posts) while
// the parent reports "no composed verdict was produced" and exits 1: the
// exact live defect the pinning exists to end.
//
// So the skill is the oracle here, not a hand-typed literal: this reads the
// templates out of SKILL.md and renders them for each target class. A skill
// edit that changes a template fails HERE, next to the code that must follow
// it, instead of silently in a review months later.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composedNameFor, reportPatternFor } from './run.js';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

const SKILL_PATH = join(
  repoRoot,
  'packages/core/src/skills/bundled/review/SKILL.md',
);

/** The `{target}` token, rendered per class exactly as the skill defines it. */
const TARGETS = {
  pr: { cls: { kind: 'pr', number: '9014' } as const, token: 'pr-9014' },
  file: { cls: { kind: 'file', base: 'foo.ts' } as const, token: 'foo.ts' },
  local: { cls: { kind: 'local' } as const, token: 'local' },
};

describe('run pins match the bundled skill templates', () => {
  const skill = existsSync(SKILL_PATH)
    ? readFileSync(SKILL_PATH, 'utf8').replace(/\r\n/g, '\n')
    : null;

  // A sparse or partial checkout has no skill to read; the pins are still
  // covered by run.test.ts's own cases. Failing here would report a checkout
  // shape as a contract drift.
  const itWithSkill = skill === null ? it.skip : it;

  itWithSkill('composedNameFor renders Step 6’s --out template', () => {
    // The template as the skill writes it, e.g.
    //   --out .qwen/tmp/qwen-review-{target}-composed.json
    // The filename must END the token: an unanchored capture matches a skill
    // edit that APPENDS to the artifact name (`…composed.json.tmp` for an
    // atomic write-then-rename, `…json-v2` for a rename) as a prefix,
    // leaving this oracle green while the pin drifts — one direction of the
    // drift it exists to catch. Whitespace-or-end, not a rejected character
    // class, so no future suffix character has to be foreseen.
    const m =
      /--out\s+\.qwen\/tmp\/(qwen-review-\{target\}-composed\.json)(?=\s|$)/.exec(
        skill as string,
      );
    // A null here means SKILL.md no longer writes that `--out` line: update
    // composedNameFor and this oracle together to the new template.
    expect(m).not.toBeNull();

    const template = (m as RegExpExecArray)[1];
    for (const { cls, token } of Object.values(TARGETS)) {
      expect(composedNameFor(cls)).toBe(template.replace('{target}', token));
    }
  });

  itWithSkill('reportPatternFor accepts Step 8’s report stems', () => {
    // The stems as the skill lists them, e.g.
    //   `.qwen/reviews/<YYYY-MM-DD>-<HHMMSS>-pr-<number>.md`
    const stems = [
      ...(skill as string).matchAll(
        /`\.qwen\/reviews\/<YYYY-MM-DD>-<HHMMSS>-([^`]+)\.md`/g,
      ),
    ].map((s) => s[1]);
    // A miss here means Step 8 no longer lists those stems: update
    // reportPatternFor and this oracle together to the new template.
    expect(stems).toEqual(
      expect.arrayContaining(['local', 'pr-<number>', '<filename>']),
    );

    const render = (stem: string): string =>
      `2026-08-13-101010-${stem}.md`
        .replace('pr-<number>', 'pr-9014')
        .replace('<filename>', 'foo.ts');

    expect(reportPatternFor(TARGETS.pr.cls).test(render('pr-<number>'))).toBe(
      true,
    );
    expect(reportPatternFor(TARGETS.file.cls).test(render('<filename>'))).toBe(
      true,
    );
    expect(reportPatternFor(TARGETS.local.cls).test(render('local'))).toBe(
      true,
    );
    // And each class refuses the neighbouring classes' rendered stems — the
    // cross-capture this pinning exists to prevent.
    expect(reportPatternFor(TARGETS.pr.cls).test(render('local'))).toBe(false);
    expect(
      reportPatternFor(TARGETS.local.cls).test(render('pr-<number>')),
    ).toBe(false);
    expect(reportPatternFor(TARGETS.file.cls).test(render('local'))).toBe(
      false,
    );
  });
});
