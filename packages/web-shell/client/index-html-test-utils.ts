/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Extract an inline `<script>` body from `client/index.html` by a marker
 * substring. Shared by the inline-script unit tests so the HTML-parsing
 * logic lives in one place.
 */
export function extractInlineScript(marker: string): string {
  const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
  const script = Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  )
    .map((match) => match[1] ?? '')
    .find((source) => source.includes(marker));

  if (!script) throw new Error(`Inline script not found: ${marker}`);
  return script;
}
