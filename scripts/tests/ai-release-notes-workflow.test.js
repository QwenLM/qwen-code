/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

describe('stable release notes workflow', () => {
  it('generates AI-assisted notes only for stable releases', () => {
    expect(workflow).toContain(
      "- name: 'Generate AI-assisted stable release notes'",
    );
    expect(workflow).toContain(
      "needs.prepare.outputs.is_nightly == 'false' && needs.prepare.outputs.is_preview == 'false'",
    );
    expect(workflow).toContain('node scripts/generate-release-notes.js');
    expect(workflow).toContain(
      "OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}'",
    );
    expect(workflow).toContain(
      "OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}'",
    );
    expect(workflow).toContain("OPENAI_MODEL: '${{ secrets.OPENAI_MODEL }}'");
  });

  it('uses the generated file when present and keeps GitHub generation as fallback', () => {
    expect(workflow).toContain(
      'NOTES_ARGS=(--notes-file "${RELEASE_NOTES_FILE}")',
    );
    expect(workflow).toContain(
      'NOTES_ARGS=(--notes-start-tag "${PREVIOUS_RELEASE_TAG}" --generate-notes)',
    );
    expect(workflow).toContain('"${NOTES_ARGS[@]}"');
  });
});
