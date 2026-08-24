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
const buildStep =
  workflow.match(
    /- name: 'Build and push Docker image'\n[\s\S]*?(?=\n[ ]{6}# One bounded retry)/,
  )?.[0] ?? '';
const retryStep =
  workflow.match(
    /- name: 'Build and push Docker image \(retry\)'[\s\S]*?(?=\n[ ]{2}# A released npm version)/,
  )?.[0] ?? '';
const failureIssueJob = workflow.match(/file-failure-issue:[\s\S]*$/)?.[0] ?? '';

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

  it('keeps a failed first build from pre-failing the job', () => {
    // Without continue-on-error a successful retry would leave the job red
    // (GitHub computes the job conclusion from every step conclusion), which
    // would make file-failure-issue report an image that WAS published.
    expect(buildStep).toContain('continue-on-error: true');
  });

  it('gates the retry on the first attempt outcome only', () => {
    expect(retryStep).toContain(
      "if: \"${{ steps.build-and-push.outcome == 'failure' }}\"",
    );
    // failure() would be false once continue-on-error absorbs the first
    // attempt, silently skipping the retry.
    expect(retryStep).not.toContain('failure()');
  });

  it('publishes from both build steps through one shared expression', () => {
    expect(buildStep).toContain("push: '${{ env.PUSH_IMAGE }}'");
    expect(retryStep).toContain("push: '${{ env.PUSH_IMAGE }}'");
    expect(workflow).toContain('PUSH_IMAGE: |-');
  });

  it('files a failure issue for tag pushes and publishing dispatches', () => {
    expect(failureIssueJob).toContain(
      "(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')) || (github.event_name == 'workflow_dispatch' && github.event.inputs.publish == 'true')",
    );
  });

  it('dedups the failure issue by an exact client-side marker match', () => {
    // GitHub search tokenizes the colon out of the marker, so a --search
    // lookup never finds the issues this job files.
    expect(failureIssueJob).not.toContain('--search');
    expect(failureIssueJob).toContain(
      'jq -r --arg marker_html "${marker_html}"',
    );
    expect(failureIssueJob).toContain('contains($marker_html)');
  });
});
