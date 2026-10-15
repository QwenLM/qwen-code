/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The pinned knobs are a contract with every parser downstream, and each one
// is here because its default breaks one of them. A pin deleted as
// "redundant" fails nothing else in the suite — the handler tests mock the
// capture and the integration fixtures parse both shapes — so the pins are
// asserted where they are declared.

import { describe, it, expect } from 'vitest';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from './diff-flags.js';

describe('the pinned diff config', () => {
  const config = PINNED_DIFF_CONFIG.join(' ');

  it('pins core.quotePath=false — non-ASCII paths must arrive unquoted', () => {
    // git's default C-style-quotes any path with a non-ASCII byte
    // (`"docs/\346\236\266.md"`). The containment oracle in `fetch-pr`
    // unquotes defensively, but the capture is where the whole pipeline —
    // the chunk plan, the anchors, the oracle — sees one shape instead of
    // two; dropping this pin makes every non-ASCII path take the quoted
    // path through all of them.
    expect(config).toContain('core.quotePath=false');
  });

  it('pins diff.suppressBlankEmpty=false — a blank context line is a space', () => {
    // With it set, git prints a blank context line as an empty record and
    // the parser's new-side cursor cannot tell context from structure.
    expect(config).toContain('diff.suppressBlankEmpty=false');
  });

  it('passes every pin as a -c pair, so none can be read as a path', () => {
    expect(PINNED_DIFF_CONFIG.length % 2).toBe(0);
    for (let i = 0; i < PINNED_DIFF_CONFIG.length; i += 2) {
      expect(PINNED_DIFF_CONFIG[i]).toBe('-c');
      expect(PINNED_DIFF_CONFIG[i + 1]).toContain('=');
    }
  });

  it('keeps the flags that decide whether the output is a unified diff at all', () => {
    // Spot-checks, not a snapshot: these are the ones whose user-config
    // defaults make the plan come back with zero chunks (colour), emit
    // something that is not a unified diff (external/textconv), or rename
    // the `a/`/`b/` prefixes the path stripper depends on.
    // Every one of them, not a sample: the header promises pins are
    // asserted where they are declared, and each of these is documented in
    // diff-flags.ts as plan-breaking on its own (without `--no-relative` a
    // subdirectory capture strips the repo prefix from every path, so the
    // chunk plan, the anchors and the containment oracle stop naming real
    // files; without `--ignore-submodules=none` a user config hides a
    // changed gitlink entirely).
    for (const flag of [
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--unified=3',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--find-renames',
      '--no-relative',
      '--ignore-submodules=none',
      '--submodule=short',
    ]) {
      expect(PINNED_DIFF_FLAGS).toContain(flag);
    }
  });
});
