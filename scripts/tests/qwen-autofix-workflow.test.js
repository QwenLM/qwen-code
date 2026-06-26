/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qwen-autofix.yml', 'utf8');
const refreshIssueComments =
  workflow.match(/refresh_issue_comments\(\) \{[\s\S]*?\n[ ]{12}\}/)?.[0] ?? '';
const tier2Scan =
  workflow.match(/Tier 2:[\s\S]*?tier2-scan\.json"; then/)?.[0] ?? '';
const filterUnattendedCandidates =
  workflow.match(
    /filter_unattended_candidates\(\) \{[\s\S]*?\n[ ]{12}\}/,
  )?.[0] ?? '';

describe('qwen-autofix workflow', () => {
  it('does not classify tier-2 issues with incomplete fallback comments', () => {
    expect(workflow).toContain('refresh_issue_comments()');
    expect(workflow).toContain('gh api --paginate');
    expect(workflow).toContain('TRUSTED_ASSOC');
    expect(workflow).toContain('KNOWN_BOTS');
    expect(workflow).toContain('autofixTier');
    expect(refreshIssueComments.length).toBeGreaterThan(0);
    expect(tier2Scan.length).toBeGreaterThan(0);
    expect(workflow).toContain('::warning::Failed to refresh comments');
    expect(workflow).toContain(
      '::warning::Failed to assemble refreshed comments',
    );
    expect(tier2Scan).toContain(
      '--limit 30 --json number,title,body,labels,createdAt,url \\',
    );
    expect(tier2Scan).not.toContain(',comments');
    expect(workflow).not.toContain('using issue-list comments');
    expect(refreshIssueComments.match(/>> "\$\{ndjson\}"/g)).toHaveLength(1);
    expect(refreshIssueComments).not.toContain(
      'printf \'%s\\n\' "${issue}" >> "${ndjson}"',
    );
  });

  it('keeps candidate tiering and age-window guards covered', () => {
    expect(workflow).toContain('MIN_ISSUE_AGE_DAYS');
    expect(workflow).toContain('MAX_ISSUE_AGE_DAYS');
    expect(workflow).toContain('created:${MAX_CREATED}..${MIN_CREATED}');
    expect(workflow).toContain('autofixTier: 0');
    expect(workflow).toContain('autofixTier: 1');
    expect(workflow).toContain('autofixTier: 2');
    expect(workflow).toContain('.[0] as $tier1 | .[1] as $tier2');
    expect(workflow).toContain('.[0:(10 - ($selected | length))]');
    expect(workflow).toContain('del(.comments)');
  });

  it('checks unattended filtering uses maintainer association gates', () => {
    expect(filterUnattendedCandidates.length).toBeGreaterThan(0);
    expect(filterUnattendedCandidates).toContain('authorAssociation');
    expect(filterUnattendedCandidates).toContain('IN($trust[])');
    expect(filterUnattendedCandidates).toContain('IN($bots[])');
    expect(filterUnattendedCandidates).not.toContain(
      '.author.login] | map(select',
    );
  });
});
