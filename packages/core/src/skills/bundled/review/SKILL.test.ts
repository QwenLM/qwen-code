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

function incidentPointers(): string[] {
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  return [...skill.matchAll(POINTER_RE)].map(([, title]) => title.trim());
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
    const pointers = incidentPointers();
    expect(pointers.length).toBeGreaterThan(0);

    const headings = new Set(incidentHeadings());
    for (const title of pointers) {
      expect(
        headings.has(title),
        `SKILL.md points at a missing DESIGN.md heading: "### ${title}"`,
      ).toBe(true);
    }
  });

  it('leaves no DESIGN.md incident heading without a SKILL.md pointer', () => {
    const referenced = new Set(incidentPointers());
    for (const title of incidentHeadings()) {
      expect(
        referenced.has(title),
        `DESIGN.md incident heading has no SKILL.md pointer: "### ${title}"`,
      ).toBe(true);
    }
  });
});
