/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/release-benchmark.yml',
  'utf8',
);

function getStep(name) {
  const match = new RegExp(
    `\\n      - name: '${name}'[\\s\\S]*?(?=\\n      - name: '|$)`,
  ).exec(`\n${workflow}`);
  if (!match) {
    throw new Error(`Could not find workflow step: ${name}`);
  }
  return match[0];
}

describe('release benchmark workflow', () => {
  it('only automatically dispatches stable upstream releases', () => {
    expect(workflow).toContain("types: ['published']");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("github.event_name == 'release'");
    expect(workflow).toContain("vars.RELEASE_BENCHMARK_ENABLED == 'true'");
    expect(workflow).toContain('github.event.release.prerelease == false');
    expect(workflow).toContain(
      "vars.RELEASE_BENCHMARK_SUITE || 'release-full-v1'",
    );

    const resolve = getStep('Resolve stable release');
    expect(resolve).toContain(
      '[[ ! "${RELEASE_TAG}" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    );
    expect(resolve).toContain(
      '"$(jq -r \'.prerelease\' <<<"${release_json}")" != \'false\'',
    );
  });

  it('uses OIDC and keeps evaluation credentials off the runner', () => {
    expect(workflow).toContain("environment:\n      name: 'release-benchmark'");
    expect(workflow).toContain("contents: 'read'");
    expect(workflow).toContain("id-token: 'write'");
    expect(workflow).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    expect(workflow).toContain('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('OPENAI_API_KEY');
    expect(workflow).not.toContain("runs-on: 'self-hosted'");
  });

  it('sends an idempotent versioned request to the server', () => {
    const resolve = getStep('Resolve stable release');
    const dispatch = getStep('Dispatch benchmark');

    expect(resolve).toContain(
      'idempotency_key="${GITHUB_REPOSITORY}:${RELEASE_TAG}:${REQUESTED_SUITE}"',
    );
    expect(resolve).toContain('endpoint="${API_URL%/}/v1/release-benchmarks"');
    expect(dispatch).toContain('schema_version: 1');
    expect(dispatch).toContain('idempotency_key: $idempotency_key');
    expect(dispatch).toContain('commit_sha: $commit_sha');
    expect(dispatch).toContain('workflow_ref: $workflow_ref');
    expect(dispatch).toContain('actions_run_url: $actions_run_url');
    expect(dispatch).toContain('-H "Idempotency-Key: ${IDEMPOTENCY_KEY}"');
  });

  it('requires a safe status response and publishes a link', () => {
    const dispatch = getStep('Dispatch benchmark');
    const summary = getStep('Publish dispatch summary');

    expect(dispatch).toContain(
      '.state | select(. == "queued" or . == "running" or . == "already_exists")',
    );
    expect(dispatch).toContain(
      '.status_url | select(type == "string" and test("^https://[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$"))',
    );
    expect(summary).toContain(
      '| ${TAG} | ${SUITE} | [${JOB_ID}](${STATUS_URL}) | ${STATE} |',
    );
    expect(summary).toContain('GITHUB_STEP_SUMMARY');
    expect(summary).toContain('public status page');
  });
});
