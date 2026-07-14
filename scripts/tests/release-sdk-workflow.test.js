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
    expect(workflow).toContain('elif [[ "${HAS_PERSISTED_SOURCE}" == "true" ]]');
    expect(workflow).toContain('TARGET="${RELEASE_BRANCH}"');
    expect(workflow).toContain('TARGET="${REF}"');
    const persistedSourceGuardCount = (
      workflow.match(
        /steps\.persist_source\.outputs\.HAS_PERSISTED_SOURCE == 'true'/g,
      ) ?? []
    ).length;
    expect(persistedSourceGuardCount).toBe(2);
  });
});
