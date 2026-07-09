/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('comment attachment guard workflow', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/comment-attachment-guard.yml'),
    'utf8',
  );

  it('treats a slash after a risky extension as a match boundary', () => {
    expect(workflow).toContain('>?#/]');
  });

  it('keeps diagnostics when deletion or summary writing fails', () => {
    expect(workflow).toContain(
      'Failed to delete suspicious comment ${comment.id}',
    );
    expect(workflow).toContain('Failed to write suspicious comment summary');
  });
});
