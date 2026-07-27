/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('main CI failure issue workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/main-ci-failure-issue.yml',
    'utf8',
  );

  it('opens an autofix-ready issue only for failed main CI runs', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain("workflows: ['E2E Tests', 'SDK Python']");
    expect(workflow).not.toContain("'Qwen Code CI'");
    expect(workflow).toContain("types: ['completed']");
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
  });

  it('creates an issue that the existing autofix worker can pick up', () => {
    expect(workflow).toContain("issues: 'write'");
    expect(workflow).toContain('CI_DEV_BOT_PAT');
    expect(workflow).toContain(
      'AUTOFIX_BOT: "${{ vars.AUTOFIX_BOT_LOGIN || \'qwen-code-dev-bot\' }}"',
    );
    expect(workflow).toContain("BUG_LABEL: 'type/bug'");
    expect(workflow).toContain(
      "READY_FOR_AGENT_LABEL: 'status/ready-for-agent'",
    );
    expect(workflow).toContain("AUTOFIX_APPROVED_LABEL: 'autofix/approved'");
    expect(workflow).toContain('gh issue edit "$1"');
    expect(workflow).toContain(
      '--add-label "${BUG_LABEL},${READY_FOR_AGENT_LABEL},${AUTOFIX_APPROVED_LABEL}"',
    );
    expect(workflow).toContain('--add-assignee "${AUTOFIX_BOT}"');
    expect(workflow).toContain('apply_autofix_route "${issue_url}"');
  });

  it('deduplicates failures for the same commit and includes run context', () => {
    expect(workflow).toContain('qwen-main-ci-failure:${HEAD_SHA}');
    expect(workflow).toContain('--search "${marker} in:body"');
    expect(workflow).toContain('gh issue list');
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('apply_autofix_route "${existing_sha_issue}"');
    expect(workflow).toContain(
      'apply_autofix_route "${existing_workflow_issue}"',
    );
    expect(workflow.indexOf('existing_sha_issue')).toBeLessThan(
      workflow.indexOf('existing_workflow_issue'),
    );
    expect(workflow).toContain('title_prefix="Main CI failed:"');
    expect(workflow).toContain(
      '--search "\\"${title_prefix} ${WORKFLOW_NAME}\\" in:title"',
    );
    expect(workflow).toContain(
      '--jq "[.[] | select(.title | startswith(\\"${title_prefix} ${WORKFLOW_NAME} on \\"))] | .[0].number // \\"\\""',
    );
    expect(workflow).toContain('--title "${title_prefix} ${WORKFLOW_NAME}');
    expect(workflow).toContain('gh issue comment "${existing_workflow_issue}"');
    expect(workflow).toContain('## Additional CI Failure');
    expect(workflow.match(/echo "<!-- \$\{marker\} -->"/g)).toHaveLength(2);
    expect(workflow).toContain('${WORKFLOW_RUN_URL}');
    expect(workflow).toContain('${HEAD_SHA}');
    expect(workflow.match(/exit 0/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('does not check out repository code', () => {
    expect(workflow).not.toContain('actions/checkout');
  });
});
