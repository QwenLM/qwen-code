/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

const autofixWorkflow = readFileSync(
  path.join(ROOT, '.github/workflows/qwen-autofix.yml'),
  'utf8',
);
const releaseWorkflow = readFileSync(
  path.join(ROOT, '.github/workflows/release.yml'),
  'utf8',
);
const triageWorkflow = readFileSync(
  path.join(ROOT, '.github/workflows/qwen-triage.yml'),
  'utf8',
);

describe('autofix workflow trust gates', () => {
  it('does not use the LLM-applied ready-for-agent label for tier-1 issue scans', () => {
    expect(autofixWorkflow).toContain("AUTOFIX_READY_LABEL: 'autofix/ready'");
    expect(autofixWorkflow).not.toContain('READY_FOR_AGENT_LABEL');
    expect(autofixWorkflow).toContain('label:${AUTOFIX_READY_LABEL}');
    expect(autofixWorkflow).not.toContain('label:${READY_FOR_AGENT_LABEL}');
    expect(autofixWorkflow).toContain(
      'it is not applied by the\n            # LLM triage path',
    );
  });

  it('marks workflow-owned release failure issues as autofix-ready for fallback scans', () => {
    expect(releaseWorkflow).toContain("AUTOFIX_READY_LABEL: 'autofix/ready'");
    expect(releaseWorkflow).toContain(
      'gh label create "${AUTOFIX_READY_LABEL}"',
    );
    expect(releaseWorkflow).toContain(
      '--add-label "${BUG_LABEL},${READY_FOR_AGENT_LABEL},${AUTOFIX_READY_LABEL}"',
    );
    expect(releaseWorkflow).toContain('--label "${AUTOFIX_READY_LABEL}"');
  });

  it('removes autofix-ready labels after untrusted issue-opened triage', () => {
    const triageIndex = triageWorkflow.indexOf("- name: 'Run Qwen Triage'");
    const guardIndex = triageWorkflow.indexOf(
      "- name: 'Drop autofix fast-path label from untrusted issue triage'",
    );

    expect(guardIndex).toBeGreaterThan(triageIndex);
    expect(triageWorkflow).toContain("github.event_name == 'issues'");
    expect(triageWorkflow).toContain("--remove-label 'autofix/ready'");
    expect(triageWorkflow).toContain(
      'scheduled autofix fast path limited to maintainer/workflow labels',
    );
  });
});
