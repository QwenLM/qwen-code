/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds the LLM-facing content string when a skill body is injected.
 * Shared between SkillToolInvocation (runtime) and /context (estimation)
 * so that token estimates stay in sync with actual usage.
 */
export function buildSkillLlmContent(baseDir: string, body: string): string {
  return `Base directory for this skill: ${baseDir}\nImportant: ALWAYS resolve absolute paths from this base directory when working with skills.\n\n${body}\n`;
}
