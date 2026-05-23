/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Direct unit tests for `extractCodeReviewSection`. The end-to-end
// `runLoadRules` path goes through `git show` to pull each rule source
// from the base branch, so driving it from the public surface to cover
// these edge cases would require a real git fixture per case. Calling
// the helper directly keeps the test matrix tight.

import { describe, it, expect } from 'vitest';
import { extractCodeReviewSection } from './load-rules.js';

describe('extractCodeReviewSection', () => {
  it('returns null when the document has no Code Review section', () => {
    const doc = `# Project

## Coding Style
Use tabs.

## Tests
Run vitest.
`;
    expect(extractCodeReviewSection(doc)).toBeNull();
  });

  it('extracts the section when it ends at EOF (no trailing `## ` heading)', () => {
    const doc = `# Project

## Coding Style
Use tabs.

## Code Review
- Be concise.
- Cite line numbers.`;
    const got = extractCodeReviewSection(doc);
    expect(got).not.toBeNull();
    expect(got).toContain('## Code Review');
    expect(got).toContain('- Be concise.');
    expect(got).toContain('- Cite line numbers.');
  });

  it('extracts only the Code Review section when followed by another `## ` heading', () => {
    const doc = `## Code Review
- Rule A.
- Rule B.

## Performance
Cache things.
`;
    const got = extractCodeReviewSection(doc);
    expect(got).not.toBeNull();
    expect(got).toContain('Rule A.');
    expect(got).toContain('Rule B.');
    expect(got).not.toContain('## Performance');
    expect(got).not.toContain('Cache things.');
  });

  it('matches the heading case-insensitively', () => {
    const doc = `## code review
hello`;
    expect(extractCodeReviewSection(doc)).toContain('hello');
  });

  it('does not match `## Code Review Guidelines` (heading must be exact)', () => {
    // The regex `/^## Code Review\s*$/i` anchors at end-of-line, so a
    // longer heading like `## Code Review Guidelines` must not match —
    // otherwise the section boundary semantics break.
    const doc = `## Code Review Guidelines
should not match
`;
    expect(extractCodeReviewSection(doc)).toBeNull();
  });

  it('treats `### ` sub-headings inside the section as part of the section', () => {
    // The terminator is `## ` (top-level), so sub-headings (`### `) do
    // NOT end the section — they're nested content.
    const doc = `## Code Review

### Subsection A
content a

### Subsection B
content b

## Next Top-Level Heading
not included
`;
    const got = extractCodeReviewSection(doc);
    expect(got).toContain('Subsection A');
    expect(got).toContain('Subsection B');
    expect(got).toContain('content a');
    expect(got).toContain('content b');
    expect(got).not.toContain('Next Top-Level Heading');
  });

  it('returns trimmed content (no leading/trailing blank lines)', () => {
    const doc = `## Code Review


hello


## After
`;
    const got = extractCodeReviewSection(doc);
    expect(got).not.toBeNull();
    expect(got!.startsWith('## Code Review')).toBe(true);
    expect(got!.endsWith('hello')).toBe(true);
  });

  it('returns the section even if it contains only whitespace lines after the heading', () => {
    // Empty-but-present section: heading + blank lines, terminated by EOF.
    // The function returns whatever is between the heading and EOF, then
    // trims — which collapses to just the heading line itself.
    const doc = `## Code Review


`;
    const got = extractCodeReviewSection(doc);
    expect(got).toBe('## Code Review');
  });
});
