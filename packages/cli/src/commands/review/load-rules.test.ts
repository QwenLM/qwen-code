/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractCodeReviewSection } from './load-rules.js';

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

describe('extractCodeReviewSection', () => {
  it('returns null when there is no Code Review heading', () => {
    expect(extractCodeReviewSection('# T\n## Other\nbody\n')).toBeNull();
  });

  it('captures from the heading to the next top-level heading', () => {
    const md = '## Code Review\n- rule one\n- rule two\n## Next\nother\n';
    const got = extractCodeReviewSection(md);
    expect(got).toContain('- rule one');
    expect(got).toContain('- rule two');
    expect(got).not.toContain('## Next');
    expect(got).not.toContain('other');
  });

  it('captures to end of file when nothing follows', () => {
    const got = extractCodeReviewSection('## Code Review\n- only rule\n');
    expect(got).toContain('- only rule');
  });

  it('matches the heading case-insensitively', () => {
    expect(extractCodeReviewSection('## code review\n- r\n')).toContain('- r');
  });

  it('does not treat a ### subheading as the section boundary', () => {
    const md = '## Code Review\n- a\n### Sub\n- b\n## End\n';
    const got = extractCodeReviewSection(md)!;
    expect(got).toContain('- a');
    expect(got).toContain('### Sub');
    expect(got).toContain('- b');
    expect(got).not.toContain('## End');
  });

  // The whole point of #3: this repo's own AGENTS.md must carry a section the
  // loader can find, or every /review in the repo runs with zero project rules.
  it('AGENTS.md has a Code Review section the loader extracts non-empty', () => {
    const agentsMd = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
    const section = extractCodeReviewSection(agentsMd);
    expect(section).not.toBeNull();
    expect(section!.length).toBeGreaterThan(200);
    expect(section).toContain('## Code Review');
    // must stop at the next section, not bleed into it
    expect(section).not.toContain('## GitHub Operations');
  });
});
