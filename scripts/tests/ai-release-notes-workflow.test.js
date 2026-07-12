/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

function getStep(name) {
  const match = new RegExp(
    `\\n      - name: '${name}'[\\s\\S]*?(?=\\n      - name: '|\\n    [A-Za-z0-9_-]+:|$)`,
  ).exec(`\n${workflow}`);
  if (!match) {
    throw new Error(`Could not find workflow step: ${name}`);
  }
  return match[0];
}

describe('stable release notes workflow', () => {
  it('generates AI-assisted notes only for stable releases', () => {
    const step = getStep('Generate AI-assisted stable release notes');

    expect(step).toContain(
      "needs.prepare.outputs.is_dry_run == 'false' && needs.prepare.outputs.is_nightly == 'false' && needs.prepare.outputs.is_preview == 'false'",
    );
    expect(step).toContain('node scripts/generate-release-notes.js');
    expect(step).toContain("OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}'");
    expect(step).toContain("OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}'");
    expect(step).toContain("OPENAI_MODEL: '${{ secrets.OPENAI_MODEL }}'");
  });

  it('uses the generated file when present and keeps GitHub generation as fallback', () => {
    const step = getStep('Create GitHub Release and Tag');

    expect(step).toContain('NOTES_ARGS=(--notes-file "${RELEASE_NOTES_FILE}")');
    expect(step).toContain(
      'NOTES_ARGS=(--notes-start-tag "${PREVIOUS_RELEASE_TAG}" --generate-notes)',
    );
    expect(step).toContain('"${NOTES_ARGS[@]}"');
  });
});
