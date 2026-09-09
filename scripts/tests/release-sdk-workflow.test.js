/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('TypeScript SDK release workflow', () => {
  const workflow = readFileSync('.github/workflows/release-sdk.yml', 'utf8');

  it('only creates a release PR when the package version changed', () => {
    expect(workflow).toContain("id: 'persist_source'");
    expect(workflow).toContain(
      'echo "HAS_PERSISTED_SOURCE=false" >> "${GITHUB_OUTPUT}"',
    );
    expect(workflow).toContain(
      'echo "HAS_PERSISTED_SOURCE=true" >> "${GITHUB_OUTPUT}"',
    );
    expect(workflow).toContain(
      'echo "::notice::No version changes in sdk-typescript; skipping release branch push and PR creation."',
    );
    expect(workflow).toContain(
      "HAS_PERSISTED_SOURCE: '${{ steps.persist_source.outputs.HAS_PERSISTED_SOURCE }}'",
    );
    expect(workflow).toContain(
      'elif [[ "${HAS_PERSISTED_SOURCE}" == "true" ]]',
    );
    expect(workflow).toContain('TARGET="${RELEASE_BRANCH}"');
    expect(workflow).toContain('TARGET="${REF}"');
    for (const stepName of [
      'Create GitHub Release and Tag',
      'Create PR to merge release branch into main',
      'Enable auto-merge for release PR',
    ]) {
      const stepStart = workflow.indexOf(`name: '${stepName}'`);
      const step = workflow.slice(
        stepStart,
        workflow.indexOf('\n      - name:', stepStart + 1),
      );
      expect(step).toContain(
        "steps.persist_source.outputs.HAS_PERSISTED_SOURCE == 'true'",
      );
    }
  });

  it('spaces PR creation out from the release to avoid secondary rate limits', () => {
    // `gh pr create` runs right after the branch push and release creation,
    // which can trip GitHub's "was submitted too quickly" GraphQL secondary
    // rate limit (issue #11402). Pin the gap in every release workflow so a
    // future removal lets the burst through again.
    for (const path of [
      '.github/workflows/release-sdk.yml',
      '.github/workflows/release-sdk-python.yml',
      '.github/workflows/finalize-release.yml',
    ]) {
      const text = readFileSync(path, 'utf8');
      const createIndex = text.indexOf('pr_url="$(gh pr create');
      // -1 when the create is gone or no `sleep 30` precedes it.
      const sleepIndex = text.lastIndexOf('sleep 30', createIndex);
      expect(sleepIndex, path).toBeGreaterThanOrEqual(0);
    }
  });
});
