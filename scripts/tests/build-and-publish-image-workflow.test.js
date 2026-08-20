/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/build-and-publish-image.yml',
  'utf8',
);
const processVersionStep =
  workflow.match(
    /- name: 'Process version'[\s\S]*?(?=\n[ ]{6}- name: 'Debug inputs')/,
  )?.[0] ?? '';
const metadataStep =
  workflow.match(
    /- name: 'Extract metadata \(tags, labels\) for Docker'[\s\S]*?(?=\n[ ]{6}- name: 'Log in to the Container registry')/,
  )?.[0] ?? '';

describe('build-and-publish-image workflow', () => {
  it('marks only stable three-part semver versions as stable', () => {
    expect(processVersionStep).toContain(
      'if [[ "$CLEAN_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
    );
    expect(processVersionStep).toContain('IS_STABLE_SEMVER=true');
    expect(processVersionStep).toContain('IS_STABLE_SEMVER=false');
    expect(processVersionStep.indexOf('IS_STABLE_SEMVER=true')).toBeLessThan(
      processVersionStep.indexOf('IS_STABLE_SEMVER=false'),
    );
  });

  it('only enables floating Docker tags for stable semver versions', () => {
    expect(metadataStep).toContain(
      "type=raw,value=${{ steps.version.outputs.major_minor }},enable=${{ steps.version.outputs.is_stable_semver == 'true' }}",
    );
    expect(metadataStep).toContain(
      "type=raw,value=latest,enable=${{ steps.version.outputs.is_stable_semver == 'true' }}",
    );
  });
});
