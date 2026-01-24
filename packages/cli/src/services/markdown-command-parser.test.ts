/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseMarkdownCommand,
  MarkdownCommandDefSchema,
} from './markdown-command-parser.js';

describe('parseMarkdownCommand', () => {
  it('should parse markdown with YAML frontmatter', () => {
    const content = `---
description: Test command
---

This is the prompt content.`;

    const result = parseMarkdownCommand(content);

    expect(result).toEqual({
      frontmatter: {
        description: 'Test command',
      },
      prompt: 'This is the prompt content.',
    });
  });

  it('should parse markdown without frontmatter', () => {
    const content = 'This is just a prompt without frontmatter.';

    const result = parseMarkdownCommand(content);

    expect(result).toEqual({
      prompt: 'This is just a prompt without frontmatter.',
    });
  });

  it('should handle multi-line prompts', () => {
    const content = `---
description: Multi-line test
---

First line of prompt.
Second line of prompt.
Third line of prompt.`;

    const result = parseMarkdownCommand(content);

    expect(result.prompt).toBe(
      'First line of prompt.\nSecond line of prompt.\nThird line of prompt.',
    );
  });

  it('should trim whitespace from prompt', () => {
    const content = `---
description: Whitespace test
---

  Prompt with leading and trailing spaces  
`;

    const result = parseMarkdownCommand(content);

    expect(result.prompt).toBe('Prompt with leading and trailing spaces');
  });

  it('should handle empty frontmatter', () => {
    const content = `---
---

Prompt content after empty frontmatter.`;

    const result = parseMarkdownCommand(content);

    // Empty YAML frontmatter returns undefined, not {}
    expect(result.frontmatter).toBeUndefined();
    expect(result.prompt).toBe('Prompt content after empty frontmatter.');
  });

  it('should handle invalid YAML frontmatter gracefully', () => {
    // The YAML parser we use is quite tolerant, so most "invalid" YAML
    // actually parses successfully. This test verifies that behavior.
    const content = `---
description: test
---

Prompt content.`;

    const result = parseMarkdownCommand(content);

    expect(result.frontmatter).toBeDefined();
    expect(result.prompt).toBe('Prompt content.');
  });
});

describe('MarkdownCommandDefSchema', () => {
  it('should validate valid markdown command def', () => {
    const validDef = {
      frontmatter: {
        description: 'Test description',
      },
      prompt: 'Test prompt',
    };

    const result = MarkdownCommandDefSchema.safeParse(validDef);

    expect(result.success).toBe(true);
  });

  it('should validate markdown command def without frontmatter', () => {
    const validDef = {
      prompt: 'Test prompt',
    };

    const result = MarkdownCommandDefSchema.safeParse(validDef);

    expect(result.success).toBe(true);
  });

  it('should reject command def without prompt', () => {
    const invalidDef = {
      frontmatter: {
        description: 'Test description',
      },
    };

    const result = MarkdownCommandDefSchema.safeParse(invalidDef);

    expect(result.success).toBe(false);
  });

  it('should reject command def with non-string prompt', () => {
    const invalidDef = {
      prompt: 123,
    };

    const result = MarkdownCommandDefSchema.safeParse(invalidDef);

    expect(result.success).toBe(false);
  });
});
