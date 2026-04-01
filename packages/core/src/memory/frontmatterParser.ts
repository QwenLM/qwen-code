/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse as parseYaml } from '../utils/yaml-parser.js';
import type { MemoryHeader, MemoryType } from './types.js';
import { MEMORY_TYPES } from './types.js';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

/**
 * Parse YAML frontmatter from a memory markdown file.
 * Returns the parsed header and the body content after the frontmatter block.
 */
export function parseFrontmatter(raw: string): {
  header: MemoryHeader | null;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { header: null, body: raw };
  }

  const yamlBlock = match[1];
  const body = raw.slice(match[0].length);

  try {
    const parsed = parseYaml(yamlBlock);
    const name = String(parsed['name'] ?? '').trim();
    const description = String(parsed['description'] ?? '').trim();
    const rawType = String(parsed['type'] ?? '')
      .trim()
      .toLowerCase();
    const type = MEMORY_TYPES.includes(rawType as MemoryType)
      ? (rawType as MemoryType)
      : undefined;

    if (!name || !type) {
      return { header: null, body: raw };
    }

    return {
      header: { name, description, type },
      body: body.trim(),
    };
  } catch {
    return { header: null, body: raw };
  }
}

/**
 * Serialize a memory file with YAML frontmatter.
 */
export function serializeMemoryFile(
  header: MemoryHeader,
  body: string,
): string {
  const safeDesc = header.description.includes(':')
    ? `"${header.description.replace(/"/g, '\\"')}"`
    : header.description;

  return `---
name: ${header.name}
description: ${safeDesc}
type: ${header.type}
---

${body.trim()}
`;
}
