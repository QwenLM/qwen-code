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

// These two files, not the whole tree: qwen-triage.yml deliberately routes
// authorize, triage, publish-triage, publish-tmux, tmux-testing and verify to
// ecs-qwen — some through a `fromJSON([...]) || fromJSON(['ubuntu-latest'])`
// ternary, some as a bare `['self-hosted', 'linux', 'x64', 'ecs-qwen']` list
// with no hosted fallback at all — so a tree-wide "every job is hosted"
// assertion would fail on intentional code.
const PINNED = ['web-shell-visuals-publish', 'main-ci-failure-issue'];

// Derived from the parsed file, never a job list: a job added later is read by
// the same loop, while a list is a second copy that drifts. Compared as a
// literal, never by substring: the routing form either of these two files
// would grow is `... && fromJSON([pool]) || fromJSON(['ubuntu-latest'])`, whose
// text contains `ubuntu-latest`, so a substring check would pass it.
describe('workflows that must stay off the persistent pool', () => {
  // The publisher holds CI_BOT_PAT and the Aliyun OSS key pair and uploads to a
  // bucket that also serves release and live-host downloads. A reused pool slot
  // is not a boundary it can absorb: a hook in the previous job's .git, or in
  // the runner user's global git config (core.hooksPath / init.templateDir),
  // fires after the trusted checkout and then runs in this job with those
  // credentials. Moving it needs a per-run HOME, its own RUNNER_TEMP and
  // GIT_CONFIG_GLOBAL=/dev/null — not a workspace scrub.
  //
  // The report chain must never share a pool with the CI it reports: when the
  // pool is why main went red, a pool-hosted reporter queues behind the very
  // failure it documents. It is pinned as a chain because a pool-hosted analyze
  // yields no comment_body, so neither writer runs.
  it.each(PINNED)('keeps every %s job on hosted runners', (name) => {
    const jobs = workflow(name).jobs;
    // A workflow that lost its jobs would make the loop below vacuous.
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    for (const [id, job] of Object.entries(jobs)) {
      expect(job['runs-on'], id).toBe('ubuntu-latest');
    }
  });
});
