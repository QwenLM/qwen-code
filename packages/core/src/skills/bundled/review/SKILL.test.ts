/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const coreBody = () =>
  fs.readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
const skillBody = () =>
  [
    coreBody(),
    ...['posting.md', 'persistence.md', 'aone.md'].map((name) =>
      fs.readFileSync(new URL(`./references/${name}`, import.meta.url), 'utf8'),
    ),
  ].join('\n');

describe('bundled review skill', () => {
  it('keeps posting authorization gates in the injected core body', () => {
    const body = coreBody();
    expect(body).toContain(
      '`qwen review submit` is the only write path in this skill',
    );
    expect(body).toContain('Posting is a PR-only, high-only action');
    expect(body).toContain(
      '`references/posting.md` — Step 7 (authorisation, anchors, presubmit, `submit`, the 422/head-drift recovery, `publish-assets`). Load it when, and only when, posting is live',
    );
  });

  it('keeps hostile filename quoting and literal pathspec rules together', () => {
    const body = skillBody();
    for (const rule of [
      "git --literal-pathspecs diff <commitId>..HEAD --unified=0 -- '<file>'",
      'neither hardening is optional',
      "a `'` inside the name becomes `'\\''`",
    ]) {
      expect(body).toContain(rule);
    }
  });

  it('keeps publication atomic and partial pushes recoverable', () => {
    const body = skillBody();
    expect(body).toContain(
      'the `--findings-out` rewrite runs only after every file has landed and the manifest is written',
    );
    expect(body).toContain(
      'a run that fails partway through the push is completed by an idempotent re-run',
    );
  });
});
