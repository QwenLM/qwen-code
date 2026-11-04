/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';
import { AUTO_MEMORY_SKILL_NAME } from '../../auto-memory-skill.js';
import {
  buildResidentAutoMemoryPrompt,
  MEMORY_CATEGORY_SECTION,
  MEMORY_PERSISTENCE_SECTION,
  MEMORY_WRITING_RULES,
  TEAM_SCOPE_SECTION,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from '../../../memory/prompt.js';

function loadSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  return parseSkillContent(fs.readFileSync(skillPath, 'utf8'), skillPath);
}

/**
 * Collapse whitespace so a re-flowed paragraph does not break an anchor, and
 * spell single-asterisk emphasis the way Prettier writes it in Markdown
 * (`*why*` becomes `_why_`). Applied to both sides of every comparison.
 */
function normalize(text: string): string {
  return text.replace(/(?<!\*)\*(?!\*)/g, '_').replace(/\s+/g, ' ');
}

// Read and normalized once: every generated case below compares against the
// same three strings.
const skill = loadSkill();
const skillBody = normalize(skill.body);
/** The bundled listing charges the frontmatter on every request. */
const skillFrontmatter = normalize(
  `${skill.description} ${skill.whenToUse ?? ''}`,
);
const residentPrompt = normalize(
  buildResidentAutoMemoryPrompt(
    '/home/user/.qwen/projects/app/memory',
    { memoryDir: '/home/user/.qwen/memories' },
    { memoryDir: '/repo/.qwen/team-memory' },
    'POINTER',
  ),
);

/** Every non-empty line of a prompt constant, as one comparable paragraph. */
function lines(section: readonly string[]): string[] {
  return section.map((line) => line.trim()).filter((line) => line !== '');
}

describe('bundled auto-memory skill', () => {
  it('is the auto-memory reference, and says what the session already has', () => {
    expect(skill.name).toBe(AUTO_MEMORY_SKILL_NAME);
    expect(skill.description).toContain(
      'Load once you decide to save a memory',
    );
    expect(skillBody).toContain(
      'Your instructions already list the memory directories, the frontmatter template, the category names and the two save steps',
    );
  });

  // The constants stay the single source: the extraction, Dream, /remember
  // and import agents build their prompts from them. The skill must carry
  // each of their lines, so the reference cannot drift from what those agents
  // are told.
  describe.each([
    ['TYPES_SECTION_INDIVIDUAL', TYPES_SECTION_INDIVIDUAL],
    ['MEMORY_CATEGORY_SECTION', MEMORY_CATEGORY_SECTION],
    ['WHEN_TO_ACCESS_SECTION', WHEN_TO_ACCESS_SECTION],
    ['WHAT_NOT_TO_SAVE_SECTION', WHAT_NOT_TO_SAVE_SECTION],
    ['MEMORY_WRITING_RULES', MEMORY_WRITING_RULES],
    ['TEAM_SCOPE_SECTION', TEAM_SCOPE_SECTION],
    ['TRUSTING_RECALL_SECTION', TRUSTING_RECALL_SECTION],
    ['MEMORY_PERSISTENCE_SECTION', MEMORY_PERSISTENCE_SECTION],
  ])('carries %s', (_name, section) => {
    it.each(lines(section))('%s', (line) => {
      expect(skillBody).toContain(normalize(line));
    });
  });

  // Guidance that left the main session's prompt for this skill. Each anchor
  // is asserted both ways: in the skill, and absent from the resident prompt
  // and from the frontmatter the listing charges on every request. Either
  // half alone would let the guidance vanish, or be pasted back, with every
  // test green.
  describe.each([
    ['<types>'],
    ['Great user memories help you tailor your future behavior'],
    ["I'm a data scientist investigating what logging we have in place"],
    ["don't mock the database in these tests"],
    ['Record from failure AND success'],
    ['grafana.internal/d/api-latency'],
    ['MCP tool names, parameter schemas, field mappings'],
    ['Use 2-6 discriminative retrieval terms or short phrases'],
    ['Keep each memory body near or below 1,200 characters.'],
    ['## Before recommending from memory'],
    ['"The memory says X exists" is not the same as "X exists now."'],
    ['## Memory and other forms of persistence'],
    ['When to use or update tasks instead of memory'],
    ['`type` controls storage and maintenance'],
    ['## When to access memories'],
    ['Memory records can become stale over time'],
  ])('moved out of the resident prompt: %s', (anchor) => {
    it('is in the skill', () => {
      expect(skillBody).toContain(normalize(anchor));
    });
    it('is not in the resident prompt', () => {
      expect(residentPrompt).not.toContain(normalize(anchor));
    });
    it('is not in the skill frontmatter', () => {
      expect(skillFrontmatter).not.toContain(normalize(anchor));
    });
  });

  // The other half: what a session must have without loading anything. Kept
  // in the resident prompt, so a model that never loads the skill still saves
  // to the right directory, in the right format, and still checks a memory
  // before recommending from it.
  it.each([
    ['the user tier', 'USER memory (cross-project'],
    ['the project tier', 'PROJECT memory (this project only'],
    ['the team tier', 'TEAM memory (this project, shared'],
    ['remember and forget', 'If the user explicitly asks you to remember'],
    ['the user type and its scope', '`user` — the user'],
    ['the feedback scope', 'PROJECT only for a project-wide convention'],
    ['absolute dates', 'Convert relative dates to absolute ones'],
    ['the reference scope', '`reference` — where to find information'],
    ['the body structure', '**Why:** line and a **How to apply:** line'],
    ['secrets stay out of TEAM', 'You MUST NOT save API keys, tokens'],
    ['the generated team index', 'never edit it by hand'],
    ['what not to save', 'not even when the user asks'],
    ['the frontmatter template', 'usage_scenarios:'],
    ['the category list', '`category` is exactly one of: basic_information'],
    ['the same-directory index', 'lives in the SAME directory you wrote to'],
    ['no frontmatter in the index', 'The index has no frontmatter'],
    ['the index line limit', 'will be truncated, so keep every index concise'],
    ['no content in the index', 'Never write memory content directly'],
    ['deduplication', 'should be updated instead'],
    ['when to read memory', 'always when they ask you to check, recall'],
    ['ignoring memory', 'If the user says to _ignore_'],
    ['the drift caveat', 'A memory records what was true when it was written'],
    ['verifying before recommending', 'check the current state'],
    ['the reference pointer', 'POINTER'],
  ])('keeps %s in the resident prompt', (_what, anchor) => {
    expect(residentPrompt).toContain(normalize(anchor));
  });
});
