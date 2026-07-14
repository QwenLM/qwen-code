/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
const finalizeWorkflow = readFileSync(
  '.github/workflows/finalize-release.yml',
  'utf8',
);

function getStep(workflow, name) {
  const match = new RegExp(
    `\\n      - name: '${name}'[\\s\\S]*?(?=\\n      - name: '|\\n    [A-Za-z0-9_-]+:|$)`,
  ).exec(`\n${workflow}`);
  if (!match) {
    throw new Error(`Could not find workflow step: ${name}`);
  }
  return match[0];
}

describe('stable release notes workflow', () => {
  it('publishes immediately with GitHub-generated notes', () => {
    const step = getStep(releaseWorkflow, 'Create GitHub Release and Tag');

    expect(step).toContain('--notes-start-tag "${PREVIOUS_RELEASE_TAG}"');
    expect(step).toContain('--generate-notes');
    expect(releaseWorkflow).not.toContain(
      "name: 'Generate AI-assisted stable release notes'",
    );
    expect(releaseWorkflow).not.toContain("name: 'Regenerate CHANGELOG.md'");
    expect(releaseWorkflow).not.toContain(
      "name: 'Create PR to merge release branch into main'",
    );
  });

  it('finalizes stable releases asynchronously', () => {
    const generate = getStep(
      finalizeWorkflow,
      'Generate AI-assisted release notes',
    );
    const update = getStep(finalizeWorkflow, 'Update GitHub Release notes');
    const changelog = getStep(finalizeWorkflow, 'Regenerate CHANGELOG.md');

    expect(finalizeWorkflow).toContain("types: ['published']");
    expect(finalizeWorkflow).toContain(
      'github.event.release.prerelease == false',
    );
    expect(finalizeWorkflow).toContain('workflow_dispatch:');
    expect(finalizeWorkflow).toContain(
      'if [[ "${TAG}" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    );
    expect(generate).toContain('timeout-minutes: 15');
    expect(generate).toContain('continue-on-error: true');
    expect(generate).toContain('GitHub-generated notes');
    expect(generate).toContain('node scripts/generate-release-notes.js');
    expect(update).toContain('continue-on-error: true');
    expect(update).toContain(
      'gh release edit "${RELEASE_TAG}" --notes-file "${RELEASE_NOTES_FILE}"',
    );
    expect(changelog).toContain('continue-on-error: true');
  });

  it('updates the changelog before opening the release PR', () => {
    const changelog = finalizeWorkflow.indexOf(
      "name: 'Regenerate CHANGELOG.md'",
    );
    const pr = finalizeWorkflow.indexOf(
      "name: 'Create PR to merge release branch into main'",
    );

    expect(changelog).toBeGreaterThanOrEqual(0);
    expect(pr).toBeGreaterThan(changelog);
    expect(finalizeWorkflow).toContain("name: 'Approve release PR'");
    expect(finalizeWorkflow).toContain(
      "name: 'Enable auto-merge for release PR'",
    );
  });

  it('does not recreate an already merged release PR during retries', () => {
    const pr = getStep(
      finalizeWorkflow,
      'Create PR to merge release branch into main',
    );
    const approve = getStep(finalizeWorkflow, 'Approve release PR');
    const merge = getStep(finalizeWorkflow, 'Enable auto-merge for release PR');

    expect(pr).toContain('--state all');
    expect(pr).toContain('select(.state == "MERGED")');
    expect(pr).toContain('if [[ "${pr_state}" == "MERGED" ]]');
    expect(pr).toContain('SHOULD_MERGE=false');
    expect(approve).toContain("steps.pr.outputs.SHOULD_MERGE == 'true'");
    expect(merge).toContain("steps.pr.outputs.SHOULD_MERGE == 'true'");
  });
});
