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
    /- name: 'Build and push Docker image \(retry\)'[\s\S]*?(?=\n[ ]{2}# One issue per version)/,
  )?.[0] ?? '';
const failureIssueJob =
  workflow.match(/file-failure-issue:[\s\S]*$/)?.[0] ?? '';
const failureIssueScript = readFileSync(
  '.github/scripts/image-build-failure-issue.sh',
  'utf8',
);

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
      'if: "${{ steps.build-and-push.outcome == \'failure\' }}"',
    );
    // failure() would be false once continue-on-error absorbs the first
    // attempt, silently skipping the retry.
    expect(retryStep).not.toContain('failure()');
  });

  it('pins the first build step id the retry gate references', () => {
    // steps.build-and-push.outcome only resolves when this exact id exists;
    // renaming the step would silently disable the retry.
    expect(buildStep).toContain("id: 'build-and-push'");
  });

  it('lets a failed retry fail the job', () => {
    // continue-on-error on the retry would absorb a genuine build failure and
    // leave the job green, so file-failure-issue would never run.
    expect(retryStep).not.toContain('continue-on-error');
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

  it('only runs the failure-issue job after a failed in-repo build', () => {
    // failure() keeps green builds from filing, the repository guard keeps
    // forks from filing, and needs wires the job to the build it reports on.
    // Deleting any of these must fail the suite.
    expect(failureIssueJob).toContain(
      "failure() && github.repository == 'QwenLM/qwen-code'",
    );
    expect(failureIssueJob).toContain("needs: ['build-and-push-to-ghcr']");
  });

  it('dedups the failure issue by an exact client-side marker match', () => {
    // GitHub search tokenizes the colon out of the marker, so a --search
    // lookup never finds the issues this job files.
    expect(failureIssueJob).toContain(
      'bash .github/scripts/image-build-failure-issue.sh',
    );
    expect(failureIssueScript).not.toContain('--search');
    expect(failureIssueScript).toContain(
      'jq -r --arg marker_html "${marker_html}"',
    );
    expect(failureIssueScript).toContain('contains($marker_html)');
  });
});
