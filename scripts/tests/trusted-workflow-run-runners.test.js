/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = (name) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));

// Read from the UN-evaluated workflow, so the assertion can actually fail: a
// `runs-on` that grows a pool expression changes the trust boundary, it is not
// a refactor. Matching on a substring here would let a pool expression through.
describe('workflows that must stay off the persistent pool', () => {
  // This job holds CI_BOT_PAT and the Aliyun OSS key pair, and uploads to a
  // bucket that also serves release and live-host downloads. Every other job in
  // this tree carrying that key pair runs on a hosted runner. A reused pool
  // slot is not a boundary it can absorb: a hook planted in the previous job's
  // .git, or in the runner user's global git config (core.hooksPath /
  // init.templateDir), fires after the trusted checkout and then runs in this
  // job with those credentials. Moving it needs a per-run HOME, its own
  // RUNNER_TEMP and GIT_CONFIG_GLOBAL=/dev/null — not a workspace scrub.
  it('keeps the web-shell visuals publisher on hosted runners', () => {
    expect(workflow('web-shell-visuals-publish').jobs.publish['runs-on']).toBe(
      'ubuntu-latest',
    );
  });

  // The reporter must never share a pool with the CI it reports: when the pool
  // is why main went red, a pool-hosted reporter queues behind the very failure
  // it documents. The whole chain is pinned, not just the job that files the
  // issue — analyze produces the body both writers need, so a pool-hosted
  // analyze yields no body and neither writer runs.
  it.each(['analyze', 'rerun_infra', 'file_issue', 'report_pr'])(
    'keeps main-ci-failure-issue / %s on hosted runners',
    (job) => {
      expect(workflow('main-ci-failure-issue').jobs[job]['runs-on']).toBe(
        'ubuntu-latest',
      );
    },
  );
});
