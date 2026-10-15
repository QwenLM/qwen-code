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
import { parse as parseYaml } from './yaml-parser.js';

function readDescriptionFromFrontmatter(markdown: string): unknown {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return parseYaml(match![1])['description'];
}

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

  it('should convert TOML saved with a UTF-8 BOM', () => {
    // Windows editors write the BOM, and `@iarna/toml` rejects U+FEFF with
    // `Unknown character "65279" at row 1, col 2`, so the command was dropped
    // before it ever reached Markdown.
    const tomlContent = `\uFEFFprompt = "BOM prompt"
description = "BOM command"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(readDescriptionFromFrontmatter(result)).toBe('BOM command');
    expect(result).toContain('BOM prompt');
  });

  it('should keep a BOM-like character that is not the leading one', () => {
    const tomlContent = `prompt = "a\uFEFFb"`;

    expect(convertTomlToMarkdown(tomlContent)).toBe('a\uFEFFb\n');
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

    expect(readDescriptionFromFrontmatter(result)).toBe(
      'Command with: special, characters!',
    );
  });

  it('should preserve YAML-like description strings as strings', () => {
    for (const description of ['false', '123', 'null', 'line one\nline two']) {
      const tomlContent = `prompt = "Test prompt"
description = ${JSON.stringify(description)}`;

      const result = convertTomlToMarkdown(tomlContent);

      expect(readDescriptionFromFrontmatter(result)).toBe(description);
    }
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

  it('agrees with convertTomlToMarkdown on BOM-prefixed input', () => {
    // The two exported functions must not disagree: a consumer composing them
    // as `if (isTomlFormat(c)) convertTomlToMarkdown(c)` would otherwise skip a
    // command file a Windows editor saved with a BOM.
    const withBom = '\uFEFFprompt = "x"';

    expect(isTomlFormat(withBom)).toBe(true);
    expect(convertTomlToMarkdown(withBom)).toBe('x\n');
  });
});
