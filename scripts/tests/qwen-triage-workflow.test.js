/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qwen-triage.yml', 'utf8');
const prSkill = readFileSync(
  '.qwen/skills/triage/references/pr-workflow.md',
  'utf8',
);

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

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start === -1) {
    return '';
  }
  const nextJob = workflow.slice(start + 1).search(/\n {2}\S/);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + 1 + nextJob);
}

describe('qwen-triage tmux workflow', () => {
  it('does not require fork PR authors to have write permission for automatic triage', () => {
    const precheckJob = job('precheck-pr');
    const authorizeJob = job('authorize');
    const authorizeStep = step('Check principal write permission');

    expect(precheckJob).toContain("contents: 'read'");
    expect(precheckJob).toContain("pull-requests: 'read'");
    expect(precheckJob).toContain("issues: 'write'");
    expect(authorizeJob).toContain(
      "needs.precheck-pr.outputs.decision == 'allow_triage'",
    );
    expect(authorizeStep).toContain(
      'if [ "$EVENT_NAME" = "pull_request_target" ]; then',
    );
    expect(authorizeStep).toContain(
      'echo "should_run=true" >> "$GITHUB_OUTPUT"',
    );
    expect(authorizeStep).toContain(
      'Automatic PR triage allowed for PR #${PR_NUMBER} after same-repo/precheck gate.',
    );
    expect(authorizeStep).not.toContain(
      'pull_request_target) principal="$PR_AUTHOR"',
    );
  });

  it('requires open issues or PRs for comment-triggered triage', () => {
    const authorizeJob = job('authorize');
    const triageJob = job('triage');
    const tmuxJob = job('tmux-testing');

    expect(authorizeJob).toContain("github.event.issue.state == 'open'");
    expect(triageJob).toContain("github.event.issue.state == 'open'");
    expect(tmuxJob).toContain("github.event.issue.state == 'open'");
  });

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
      'summary_html="$(printf \'%s\' "$summary" | html_escape)"',
    );
    expect(postStep).toContain(
      '\'<details>\\n<summary>%s</summary>\\n\\n<pre><code>\\n\' "$summary_html"',
    );
  });

  it('passes the selected OpenAI model into the app under tmux test', () => {
    const runStep = step('Run tmux real-user testing');

    expect(runStep).toContain('if [ -n "${OPENAI_MODEL:-}" ]; then');
    expect(runStep).toContain('"OPENAI_MODEL=$OPENAI_MODEL"');
  });

  it('isolates agent state per run', () => {
    const cleanStep = step('Clean stale agent state');
    const runStep = step('Run Qwen Triage');

    expect(cleanStep).toContain('QWEN_HOME="${RUNNER_TEMP:?}/qwen-home"');
    expect(cleanStep).toContain('rm -rf "$QWEN_HOME"');
    expect(cleanStep).toContain('mkdir -p "$QWEN_HOME"');
    expect(cleanStep).toContain('rm -f /tmp/stage-*.md');
    expect(cleanStep).toContain('echo "stale agent state cleaned"');
    expect(runStep).toContain("QWEN_HOME: '${{ runner.temp }}/qwen-home'");
  });

  it('passes triage output through env before bash reads it', () => {
    const checkStep = step('Check triage response');

    expect(checkStep).toContain(
      "RESPONSE: '${{ steps.triage.outputs.summary }}'",
    );
    expect(checkStep).not.toContain(
      'RESPONSE="${{ steps.triage.outputs.summary }}"',
    );
    expect(checkStep).toContain('if [[ -z "${RESPONSE}"');
  });

  it('tells an action crash apart from a silent agent, and replays both', () => {
    const checkStep = step('Check triage response');
    // The outcome must arrive through env like RESPONSE does — inlining the
    // expression into the script would be the injection shape this step
    // already avoids for RESPONSE.
    expect(checkStep).toContain(
      "TRIAGE_OUTCOME: '${{ steps.triage.outcome }}'",
    );
    expect(checkStep).not.toContain('TRIAGE_OUTCOME="${{');

    const body = checkStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
    expect(body).toBeTruthy();
    const script = body.replace(/^ {10}/gm, '');
    const run = (env) => {
      const proc = spawnSync('bash', ['-c', script], {
        env: {
          ...process.env,
          RESPONSE: '',
          TRIAGE_OUTCOME: 'success',
          ...env,
        },
        encoding: 'utf8',
      });
      return { status: proc.status, out: `${proc.stdout}${proc.stderr}` };
    };

    // A crashed action: no model call happened, so nothing about the PR can
    // explain it and the guidance must say "re-run", not "read the log" —
    // the install runs under `npm --silent`, so there is no log to read.
    const crashed = run({ TRIAGE_OUTCOME: 'failure' });
    expect(crashed.status).not.toBe(0);
    expect(crashed.out).toContain('Triage did not start');
    expect(crashed.out).toContain('re-run the failed job');
    expect(crashed.out).not.toContain('Triage silent failure');

    // A completed action with no summary IS worth reading the step output for.
    const silent = run({ TRIAGE_OUTCOME: 'success' });
    expect(silent.status).not.toBe(0);
    expect(silent.out).toContain('Triage silent failure');
    expect(silent.out).toContain('model or prompt problem');
    expect(silent.out).not.toContain('Triage did not start');

    // A real response still passes, and 'null' still counts as no response.
    expect(run({ RESPONSE: 'triaged' }).status).toBe(0);
    expect(run({ RESPONSE: 'null' }).status).not.toBe(0);
  });

  it('notifies the author when a manual triage re-run posts no review', () => {
    const notifyStep = step('Notify silent triage re-run');

    expect(notifyStep).toContain("github.event_name == 'issue_comment'");
    expect(notifyStep).toContain('github.event.issue.pull_request');
    expect(notifyStep).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /triage')",
    );
    expect(notifyStep).toContain('--method GET');
    expect(notifyStep).toContain('--paginate');
    expect(notifyStep).toContain('any(.[][];');
    expect(notifyStep).toContain('.user.login == $bot');
    expect(notifyStep).toContain('.submitted_at != null');
    expect(notifyStep).toContain('.submitted_at >= $since');
    expect(notifyStep).not.toContain('.state == "APPROVED"');
    expect(notifyStep).toContain('HAS_REVIEW=false');
    expect(notifyStep).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/issues/$NUMBER/comments"',
    );
    expect(notifyStep).toContain('<!-- qwen-triage stage=rerun-summary -->');
    expect(notifyStep).toContain(
      'Triage re-run completed without a new review.',
    );
    expect(notifyStep).not.toContain('-X PATCH');
  });

  it('posts an early live-progress status comment and finalizes the same one', () => {
    const statusStep = step('Post triage status comment');
    // Announced up front (before the long agent step) with the live run link.
    expect(statusStep).toContain('<!-- qwen-triage stage=status -->');
    expect(statusStep).toContain('actions/runs/${{ github.run_id }}');
    expect(statusStep).toContain('watch live progress');
    // Upsert by marker so a re-run reuses the one comment instead of stacking.
    expect(statusStep).toContain('contains($m)');
    expect(statusStep).toContain('--method PATCH');
    // Best-effort: a failed status post warns and continues, never fails triage.
    expect(statusStep).toContain('set -uo pipefail');
    expect(statusStep).toContain('continuing.');

    const finalizeStep = step('Finalize triage status comment');
    // Runs on both outcomes and edits the SAME marker comment (no second post).
    expect(finalizeStep).toContain('<!-- qwen-triage stage=status -->');
    expect(finalizeStep).toContain('success() || failure()');
    expect(finalizeStep).toContain('steps.triage.outcome');
    expect(finalizeStep).toContain('--method PATCH');
    expect(finalizeStep).toContain('Qwen Triage finished');
    expect(finalizeStep).toContain('ended early');
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
    expect(postStep).toContain('::warning::Unrecognized tmux verdict');
    expect(postStep).toContain("tr '\\r\\n' '  '");
    expect(postStep).toContain('<code>${UNKNOWN_VERDICT}</code>');
    expect(postStep).toContain('"$VERDICT_LABEL" "$RUN_URL"');
    expect(postStep).toContain('printf \'%s\\n\\n\' "$DESCRIPTION"');
    expect(postStep).toContain('MISSING_ARTIFACTS_NOTE=');
    expect(postStep).toContain(
      'No report.md or tmux-readable-full.log was found in tmux-results',
    );
  });

  it('removes GitHub command files from PR-controlled lifecycle scripts', () => {
    const prepareStep = step('Install and build PR app');
    const strippedEnv =
      'env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY';

    expect(prepareStep).toContain('-u GITHUB_OUTPUT');
    expect(prepareStep).toContain('-u GITHUB_STATE');
    expect(prepareStep).toContain('-u GITHUB_ENV');
    expect(prepareStep).toContain('-u GITHUB_PATH');
    expect(prepareStep).toContain('-u GITHUB_STEP_SUMMARY');
    expect(prepareStep).toMatch(
      new RegExp(`${escapeRegExp(strippedEnv)} \\\\\\s+npm ci`),
    );
    expect(prepareStep).toMatch(
      new RegExp(`${escapeRegExp(strippedEnv)} \\\\\\s+npm run build`),
    );
  });

  it('does not echo unrecognized prepare failure phases into comments', () => {
    const postStep = step('Post tmux result comment');

    expect(postStep).toContain("PREPARE_COMMAND='install/build'");
    expect(postStep).toContain('::warning::Unrecognized prepare failure phase');
    expect(postStep).toContain('PREPARE_LOG_NOTE=');
    expect(postStep).toContain(
      'No prepare.log was found in tmux-results, so the install/build log section is omitted.',
    );
    expect(postStep).not.toContain('PREPARE_COMMAND="$PREPARE_FAILURE_PHASE"');
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

  it('escapes injected model names and fails loudly when the signature literal is gone', () => {
    const injectStep = step('Inject model name into triage signature');
    const body = injectStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
    expect(body).toBeTruthy();
    const script = body.replace(/^ {10}/gm, '');
    // The workflow step only ever executes on ubuntu runners (GNU sed), but
    // this suite also runs in the macOS merge-queue job, where BSD sed
    // requires an extension argument after -i. Shim ONLY on darwin: on GNU
    // sed a separated '' is parsed as the sed script (not the -i suffix), so
    // an unconditional rewrite would break the Linux runs that actually
    // mirror production.
    const portableScript =
      process.platform === 'darwin'
        ? script.replace(/sed -i /g, "sed -i '' ")
        : script;

    const run = (model, content) => {
      const dir = mkdtempSync(join(tmpdir(), 'triage-inject-'));
      try {
        const target = join(dir, '.qwen/skills/triage/references');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'pr-workflow.md'), content);
        const proc = spawnSync('bash', ['-c', portableScript], {
          cwd: dir,
          env: { ...process.env, OPENAI_MODEL: model },
          encoding: 'utf8',
        });
        return {
          status: proc.status,
          out: readFileSync(join(target, 'pr-workflow.md'), 'utf8'),
          log: `${proc.stdout}${proc.stderr}`,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // A model name carrying every sed replacement metacharacter (/ & \) must
    // land verbatim — the old unescaped sed corrupted the skill text on these.
    const meta = run('m1/pre&post\\x', 'sig: qwen3.7-max end');
    expect(meta.status).toBe(0);
    expect(meta.out).toBe('sig: m1/pre&post\\x end');

    // The signature literal disappearing from the skill must fail the step —
    // the old silent no-op shipped the wrong model name in every comment.
    const missing = run('m2', 'sig: some-other-model end');
    expect(missing.status).not.toBe(0);
    expect(missing.log).toContain('Signature literal');
    expect(missing.out).toBe('sig: some-other-model end');

    // No model configured → file untouched, step succeeds.
    const empty = run('', 'sig: qwen3.7-max end');
    expect(empty.status).toBe(0);
    expect(empty.out).toBe('sig: qwen3.7-max end');
  });

  it('pins the re-run comment-id recipe to startswith and the bot-author filter', () => {
    // The skill's stage_comment_id() exists because a re-run once PATCHed the
    // stage=3 comment with stage=1 content (#7693). Its two load-bearing
    // constraints must not silently regress: `startswith` (a `contains` match
    // would also hit a comment that merely quotes a marker) and the
    // bot-author filter (markers are public text; the PAT may be able to
    // edit other users' comments).
    const section = prSkill.slice(
      prSkill.indexOf('**Re-runs:**'),
      prSkill.indexOf('Never create duplicates'),
    );
    expect(section).toContain('stage_comment_id()');
    expect(section).toContain('select(.user.login == $bot)');
    expect(section).toContain('startswith($m)');
    expect(section).not.toContain('contains($m)');
    expect(section).toContain('re-resolve immediately before EACH patch');
  });
});
