/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { parse as parseYaml } from '@qwen-code/qwen-code-core';

/**
 * Defines the Zod schema for a Markdown command definition file.
 * The frontmatter contains optional metadata, and the body is the prompt.
 */
export const MarkdownCommandDefSchema = z.object({
  frontmatter: z
    .object({
      description: z.string().optional(),
    })
    .optional(),
  prompt: z.string({
    required_error: 'The prompt content is required.',
    invalid_type_error: 'The prompt content must be a string.',
  }),
});

export type MarkdownCommandDef = z.infer<typeof MarkdownCommandDefSchema>;

/**
 * Parses a Markdown command file with optional YAML frontmatter.
 * @param content The file content
 * @returns Parsed command definition with frontmatter and prompt
 */
export function parseMarkdownCommand(content: string): MarkdownCommandDef {
  // Match YAML frontmatter pattern: ---\n...\n---\n
  // Allow empty frontmatter: ---\n---\n  // Use (?:[\s\S]*?) to make the frontmatter content optional
  const frontmatterRegex = /^---\n([\s\S]*?)---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    // No frontmatter, entire content is the prompt
    return {
      prompt: content.trim(),
    };
  }

  const [, frontmatterYaml, body] = match;

  // Parse YAML frontmatter if not empty
  let frontmatter: Record<string, unknown> | undefined;
  if (frontmatterYaml.trim()) {
    try {
      frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    frontmatter,
    prompt: body.trim(),
  };
}
