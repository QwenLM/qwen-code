/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_SKILL_LISTING_CHARS } from '../core/environmentContext.js';
import {
  renderAvailableSkillsBlock,
  type AvailableSkillEntry,
} from '../tools/skill-utils.js';
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

  // Every model-invocable bundled skill's `description` and `when_to_use` are
  // rendered into the session-start <available_skills> listing and charged on
  // every request. The listing is simplified once it passes
  // MAX_SKILL_LISTING_CHARS, but that trim keeps bundled entries verbatim, so
  // whatever the bundled entries take is taken from the room left for the
  // user's project, user and extension skills and model-invocable commands
  // (#12472). At 6,549 characters for 15 entries, that room is about 1,450.
  // A failure here means compress a bundled frontmatter, or raise this number
  // as a decision about how much of the listing bundled skills may take.
  const BUNDLED_LISTING_BUDGET = 6_800;

  it(`renders the model-invocable bundled listing within ${BUNDLED_LISTING_BUDGET} characters`, () => {
    const entries: AvailableSkillEntry[] = skillNames
      .map((name) => {
        const file = path.join(bundledDir, name, 'SKILL.md');
        return parseSkillContent(fs.readFileSync(file, 'utf8'), file);
      })
      .filter((cfg) => !cfg.disableModelInvocation)
      .map((cfg) => ({
        name: cfg.name,
        description: cfg.description,
        whenToUse: cfg.whenToUse,
        level: 'bundled' as const,
      }));

    expect(renderAvailableSkillsBlock(entries).length).toBeLessThanOrEqual(
      BUNDLED_LISTING_BUDGET,
    );
    expect(BUNDLED_LISTING_BUDGET).toBeLessThan(MAX_SKILL_LISTING_CHARS);
  });

  it('ships dataviz validator and references with the bundled skill', () => {
    const datavizDir = path.join(bundledDir, 'dataviz');

    expect(fs.existsSync(path.join(datavizDir, 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(datavizDir, 'scripts', 'validate_palette.js')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(datavizDir, 'references', 'palette.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(datavizDir, 'references', 'choosing-a-form.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(datavizDir, 'references', 'anti-patterns.md')),
    ).toBe(true);
  });

  it('ships the review verdict-gated reference files with the bundled skill', () => {
    const reviewDir = path.join(bundledDir, 'review');

    expect(fs.existsSync(path.join(reviewDir, 'SKILL.md'))).toBe(true);
    for (const name of ['posting.md', 'persistence.md', 'aone.md']) {
      expect(fs.existsSync(path.join(reviewDir, 'references', name))).toBe(
        true,
      );
    }
  });
});
