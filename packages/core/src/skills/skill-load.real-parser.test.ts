/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseSkillContent } from './skill-load.js';

describe('parseSkillContent with real YAML parser', () => {
  const testPath = '/test/extension/skills/test-skill/SKILL.md';

  it('parses folded block scalar descriptions (>)', () => {
    const markdown = `---
name: test-skill
description: >
  This is a folded
  multiline description.
---

Body.
`;
    const config = parseSkillContent(markdown, testPath);
    expect(config.name).toBe('test-skill');
    expect(config.description).toBe(
      'This is a folded multiline description.\n',
    );
  });

  it('parses literal block scalar descriptions (|)', () => {
    const markdown = `---
name: test-skill
description: |
  Line one.
  Line two.
---
Body.
`;
    const config = parseSkillContent(markdown, testPath);
    expect(config.description).toBe('Line one.\nLine two.\n');
  });

  it('parses strip-chomped folded block scalar (>-)', () => {
    const markdown = `---
name: test-skill
description: >-
  No trailing newline.
---
Body.
`;
    const config = parseSkillContent(markdown, testPath);
    expect(config.description).toBe('No trailing newline.');
  });

  it('does not coerce date-like values to Date objects', () => {
    const markdown = `---
name: test-skill
description: A skill created on 2024-01-01
---
Body.
`;
    const config = parseSkillContent(markdown, testPath);
    expect(typeof config.description).toBe('string');
  });

  it('handles allowedTools array correctly', () => {
    const markdown = `---
name: test-skill
description: A test skill
allowedTools:
  - read_file
  - write_file
---
Body.
`;
    const config = parseSkillContent(markdown, testPath);
    expect(config.allowedTools).toEqual(['read_file', 'write_file']);
  });

  it('handles complex frontmatter with mixed field types', () => {
    const markdown = `---
name: test-skill
description: >
  Manage the full lifecycle of
  cloud resources.
allowedTools:
  - read_file
  - write_file
model: qwen-max
argument-hint: "[resource-type]"
priority: 10
disable-model-invocation: true
---
Body content here.
`;
    const config = parseSkillContent(markdown, testPath);
    expect(config.name).toBe('test-skill');
    expect(config.description).toContain('Manage the full lifecycle');
    expect(config.allowedTools).toEqual(['read_file', 'write_file']);
    expect(config.model).toBe('qwen-max');
    expect(config.argumentHint).toBe('[resource-type]');
    expect(config.priority).toBe(10);
    expect(config.disableModelInvocation).toBe(true);
  });

  it('falls back gracefully for malformed YAML', () => {
    // Unclosed flow mapping triggers a yaml.parse error; the simple
    // parser ignores it and still extracts name + description.
    const markdown = `---
name: test-skill
description: a test skill
extra: {key: [nested unclosed
---
Body.
`;
    const config = parseSkillContent(markdown, testPath);
    expect(config.name).toBe('test-skill');
    expect(config.description).toBe('a test skill');
  });
});
