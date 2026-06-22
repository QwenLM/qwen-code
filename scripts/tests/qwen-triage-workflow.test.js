/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qwen-triage.yml', 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function step(name) {
  const escaped = escapeRegExp(name);
  const match = workflow.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|\\n\\s{2}[a-zA-Z0-9_-]+:|$)`,
    ),
  );
  return match?.[0] ?? '';
}

describe('qwen-triage tmux workflow', () => {
  it('escapes embedded tmux artifacts without bash pattern replacement ampersands', () => {
    const postStep = step('Post tmux result comment');

    expect(postStep).not.toContain('content="${content//&/&amp;}"');
    expect(postStep).not.toContain('content="${content//</&lt;}"');
    expect(postStep).not.toContain('content="${content//>/&gt;}"');
    expect(postStep).toContain("sed -e 's/&/\\&amp;/g'");
    expect(postStep).toContain("-e 's/</\\&lt;/g'");
    expect(postStep).toContain("-e 's/>/\\&gt;/g'");
    expect(postStep).toContain('html_escape()');
    expect(postStep).toContain("tr -d '\\000'");
    expect(postStep).toContain('Log could not be rendered');
    expect(postStep).toContain('if ! content="$(');
    expect(postStep).toContain('set -o pipefail');
    expect(postStep).toContain('::warning::emit_block failed');
    expect(postStep).toContain(
      "summary_html=\"$(printf '%s' \"$summary\" | html_escape)\"",
    );
    expect(postStep).toContain(
      "'<details>\\n<summary>%s</summary>\\n\\n<pre><code>\\n' \"$summary_html\"",
    );
  });

  it('passes the selected OpenAI model into the app under tmux test', () => {
    const runStep = step('Run tmux real-user testing');

    expect(runStep).toContain('if [ -n "${OPENAI_MODEL:-}" ]; then');
    expect(runStep).toContain('"OPENAI_MODEL=$OPENAI_MODEL"');
  });

  it('reports timeout and infra-error without claiming the flow was exercised', () => {
    const postStep = step('Post tmux result comment');

    expect(postStep).toContain('case "${VERDICT:-}" in');
    expect(postStep).toContain("VERDICT_LABEL='infra-error (crash/OOM)'");
    expect(postStep).toContain("VERDICT_LABEL='timeout'");
    expect(postStep).toContain("VERDICT_LABEL='pass'");
    expect(postStep).toContain("VERDICT_LABEL='fail'");
    expect(postStep).toContain("VERDICT_LABEL='unknown'");
    expect(postStep).toContain('The tmux test did not complete');
    expect(postStep).toContain(
      'The tmux test did not complete before the time limit',
    );
    expect(postStep).toContain('not a pass/fail result');
    expect(postStep).toContain('crashes or memory leaks');
    expect(postStep).toContain(
      'Launched the changed app in a real tmux session and exercised the affected flow.',
    );
    expect(postStep).toContain('produced an unrecognized verdict');
    expect(postStep).toContain('UNKNOWN_VERDICT="$(');
    expect(postStep).toContain('tr \'\\r\\n\' \'  \'');
    expect(postStep).toContain('<code>${UNKNOWN_VERDICT}</code>');
    expect(postStep).toContain('"$VERDICT_LABEL" "$RUN_URL"');
    expect(postStep).toContain('printf \'%s\\n\\n\' "$DESCRIPTION"');
  });

  it('removes GitHub command files from PR-controlled lifecycle scripts', () => {
    const prepareStep = step('Install and build PR app');

    expect(prepareStep).toContain('-u GITHUB_OUTPUT');
    expect(prepareStep).toContain('-u GITHUB_STATE');
    expect(prepareStep).toContain('-u GITHUB_ENV');
    expect(prepareStep).toContain('-u GITHUB_PATH');
    expect(prepareStep).toContain('-u GITHUB_STEP_SUMMARY');
  });

  it('installs the heavy tmux test harness only for runnable PRs', () => {
    const installStep = step('Install tmux runner tools');
    const resolverStep = step('Install PR resolver tools');

    expect(resolverStep).toContain('apt-get install');
    expect(installStep).toContain('if: "steps.pr.outputs.decision == \'run\'"');
    expect(installStep).toContain(
      'apt-get install -y --no-install-recommends tmux util-linux',
    );
    expect(installStep).toContain(
      "npm install -g --registry=https://registry.npmjs.org '@qwen-code/qwen-code@latest'",
    );
    expect(installStep).toContain('qwen --version');
    expect(installStep).toContain('tmux -V');
    expect(resolverStep).not.toContain('tmux');
    expect(resolverStep).not.toContain('npm install');
    expect(resolverStep).not.toContain('qwen --version');
    expect(
      workflow.indexOf("- name: 'Resolve PR and check state'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Install tmux runner tools'"));
    expect(
      workflow.indexOf("- name: 'Install tmux runner tools'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Checkout PR merge ref'"));
  });
});
