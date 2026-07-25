/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('extension manifest', () => {
  it('exposes only the retrieval tool', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../qwen-extension.json', import.meta.url),
        'utf8',
      ),
    );

    expect(manifest.mcpServers?.['external-context']?.includeTools).toEqual([
      'context_search',
    ]);
  });
});
