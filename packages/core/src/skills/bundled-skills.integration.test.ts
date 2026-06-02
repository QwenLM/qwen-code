/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from './skill-load.js';

// Bundled skills are loaded from disk at runtime by SkillManager. A typo in
// frontmatter (missing `description`, malformed YAML, broken `---` delimiter,
// `allowedTools` written as a scalar instead of a list, ...) currently fails
// only when a user invokes the skill — `skill-manager.ts` swallows the parse
// error and emits a debug log, so CI stays green. This integration test parses
// every shipped SKILL.md against the real loader so any frontmatter regression
// fails CI immediately.

const bundledDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'bundled',
);

const skillNames = fs
  .readdirSync(bundledDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe('bundled SKILL.md files', () => {
  it('discovers at least one bundled skill', () => {
    expect(skillNames.length).toBeGreaterThan(0);
  });

  it.each(skillNames)('%s/SKILL.md parses with required fields', (name) => {
    const file = path.join(bundledDir, name, 'SKILL.md');
    const content = fs.readFileSync(file, 'utf8');
    const cfg = parseSkillContent(content, file);

    expect(cfg.name).toBe(name);
    expect(cfg.description).toBeTruthy();
    expect(cfg.body.length).toBeGreaterThan(0);
    if (cfg.allowedTools !== undefined) {
      expect(Array.isArray(cfg.allowedTools)).toBe(true);
    }
  });
});
