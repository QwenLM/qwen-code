/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const TRAILING_LINK_REGEX = /^(.*?)\s*\[([^\]]+)\]\(([^)]+)\)\s*$/;

/**
 * Parse a markdown description into plain text and optional trailing link.
 *
 * @example
 * parseMarkdownDescription("A model. [Learn More](https://example.com)")
 * // { description: "A model.", linkText: "Learn More", linkURL: "https://example.com" }
 */
export function parseMarkdownDescription(md: string): {
  description: string;
  linkText: string;
  linkURL: string;
} {
  const matches = TRAILING_LINK_REGEX.exec(md);
  if (!matches) {
    return { description: md, linkText: '', linkURL: '' };
  }
  return {
    description: matches[1],
    linkText: matches[2],
    linkURL: matches[3],
  };
}
