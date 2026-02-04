/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  convertTomlToMarkdown,
  isTomlFormat,
} from './toml-to-markdown-converter.js';

describe('convertTomlToMarkdown', () => {
  it('should convert TOML with description to Markdown', () => {
    const tomlContent = `prompt = "This is a test prompt"
description = "Test command"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(result).toBe(`---
description: Test command
---

This is a test prompt
`);
  });

  it('should convert TOML without description to Markdown', () => {
    const tomlContent = `prompt = "Simple prompt"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(result).toBe('Simple prompt\n');
  });

  it('should handle multi-line prompts', () => {
    const tomlContent = `prompt = """
This is a multi-line
prompt with several
lines of text.
"""
description = "Multi-line test"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(result).toContain('This is a multi-line');
    expect(result).toContain('description: Multi-line test');
  });

  it('should throw error for invalid TOML', () => {
    const invalidToml = 'this is not valid toml {[}]';

    expect(() => convertTomlToMarkdown(invalidToml)).toThrow(
      'Failed to parse TOML',
    );
  });

  it('should throw error if prompt field is missing', () => {
    const tomlWithoutPrompt = 'description = "No prompt here"';

    expect(() => convertTomlToMarkdown(tomlWithoutPrompt)).toThrow(
      'TOML must contain a "prompt" field',
    );
  });

  it('should handle special characters in description', () => {
    const tomlContent = `prompt = "Test prompt"
description = "Command with: special, characters!"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(result).toContain('description: Command with: special, characters!');
  });
});

describe('isTomlFormat', () => {
  it('should return true for valid TOML', () => {
    const validToml = `prompt = "Test"
description = "Description"`;

    expect(isTomlFormat(validToml)).toBe(true);
  });

  it('should return false for invalid TOML', () => {
    const invalidToml = '{ this is not toml }';

    expect(isTomlFormat(invalidToml)).toBe(false);
  });

  it('should return true for empty TOML', () => {
    expect(isTomlFormat('')).toBe(true);
  });

  it('should return false for Markdown format', () => {
    const markdown = `---
description: Test
---

Prompt content`;

    expect(isTomlFormat(markdown)).toBe(false);
  });
});
