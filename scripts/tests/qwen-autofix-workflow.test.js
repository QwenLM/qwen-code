/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qwen-autofix.yml', 'utf8');

describe('qwen-autofix workflow', () => {
  it('does not classify tier-2 issues with incomplete fallback comments', () => {
    expect(workflow).toContain('refresh_issue_comments()');
    expect(workflow).toContain('gh api --paginate');
    expect(workflow).toContain('TRUSTED_ASSOC');
    expect(workflow).toContain('KNOWN_BOTS');
    expect(workflow).toContain('autofixTier');
    expect(workflow).toContain('::warning::Failed to refresh comments');
    expect(workflow).toContain(
      '::warning::Failed to assemble refreshed comments',
    );
    expect(workflow).not.toContain('using issue-list comments');
  });
});
