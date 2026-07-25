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

describe('qwen-triage verify workflow', () => {
  // Replay the authorize principal gate with a stubbed gh: /verify must
  // require write from BOTH the PR author (whose code executes) and the
  // commenter (who spends the runner slot + model budget). A refactor that
  // drops the /verify patterns from the case statement falls back to
  // commenter-only gating, which this catches via the author-without-write
  // arm; dropping the commenter check is caught by the drive-by arm.
  it('gates /verify on both the author and the commenter, fail-closed', () => {
    const permStep = step('Check principal write permission');
    const body = permStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
    expect(body).toBeTruthy();
    const script = body.replace(/^ {10}/gm, '');

    const dir = mkdtempSync(join(tmpdir(), 'verify-auth-'));
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        'u="${2##*collaborators/}"; u="${u%%/*}"',
        'case "$u" in',
        '  alice) echo write ;;',
        '  bob) echo admin ;;',
        '  mallory) echo none ;;',
        '  *) echo "HTTP 404" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 },
    );

    let n = 0;
    const gate = (commentBody, author, commenter) => {
      const out = join(dir, `out-${n++}`);
      writeFileSync(out, '');
      spawnSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_OUTPUT: out,
          EVENT_NAME: 'issue_comment',
          COMMENT_BODY: commentBody,
          ISSUE_AUTHOR: author,
          COMMENT_USER: commenter,
          PR_NUMBER: '1',
          TMUX_PR: '',
        },
        encoding: 'utf8',
      });
      const lines = readFileSync(out, 'utf8').trim().split('\n');
      return {
        run: lines.filter((l) => l.startsWith('should_run=')).pop(),
        explain: lines.some((l) => l === 'explain_deny=true'),
      };
    };

    try {
      // Drive-by commenter without write cannot spend the sandbox budget.
      const driveBy = gate('@qwen-code /verify', 'alice', 'mallory');
      expect(driveBy.run).toBe('should_run=false');
      expect(driveBy.explain).toBe(false);
      // Both principals hold write -> allowed.
      expect(gate('@qwen-code /verify', 'alice', 'bob').run).toBe(
        'should_run=true',
      );
      // A trusted commenter on an untrusted author's PR is denied (the
      // sandbox executes the AUTHOR's code) but gets the explanation flag.
      const untrustedAuthor = gate('@qwen-code /verify', 'mallory', 'bob');
      expect(untrustedAuthor.run).toBe('should_run=false');
      expect(untrustedAuthor.explain).toBe(true);
      // Author commenting on their own PR is checked exactly once.
      expect(gate('@qwen-code /verify', 'alice', 'alice').run).toBe(
        'should_run=true',
      );
      // A permission-API failure fails closed and stays silent.
      const apiError = gate('@qwen-code /verify', 'charlie', 'bob');
      expect(apiError.run).toBe('should_run=false');
      expect(apiError.explain).toBe(false);
      // /tmux keeps its existing author-only gate; /triage keeps the
      // commenter gate.
      expect(gate('@qwen-code /tmux', 'alice', 'mallory').run).toBe(
        'should_run=true',
      );
      expect(gate('@qwen-code /triage', 'alice', 'mallory').run).toBe(
        'should_run=false',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The pin step's sweep runs BEFORE npm ci/build execute the PR's
  // lifecycle scripts, so a postinstall can re-plant a fake
  // tmp/*-verify-* dir whose zeroed timestamp sorts ahead of the agent's
  // real one. The agent step must therefore sweep again after the last
  // PR-controlled process and before qwen launches.
  it('sweeps planted verify artifacts after the last PR-controlled process', () => {
    const runStep = step('Run verification agent');
    const sweep =
      "find tmp -maxdepth 2 -type d -name '*-verify-*' -exec rm -rf {} +";
    expect(step('Pin agent inputs from base')).toContain(sweep);
    expect(runStep).toContain(sweep);
    // Order inside the agent step: sweep first, model proxy and qwen after.
    expect(runStep.indexOf(sweep)).toBeGreaterThan(-1);
    expect(runStep.indexOf(sweep)).toBeLessThan(
      runStep.indexOf('start_openai_proxy'),
    );
    // Uploaded artifacts must not carry node-planted symlinks:
    // actions/upload-artifact dereferences them.
    expect(runStep).toContain('-type l -delete');
  });

  // RUNNER_TEMP hygiene between jobs is runner-managed; this pool is
  // persistent, so both result dirs are flushed before reuse — a stale
  // report or previous-report.md from ANOTHER PR's run must never leak
  // into this run's artifacts or agent context.
  it('resets RUNNER_TEMP verify dirs before reuse on the persistent pool', () => {
    const resolveStep = step('Resolve PR and snapshot metadata');
    expect(resolveStep).toContain('rm -rf "$RUNNER_TEMP/verify-context"');
    // 'Install and build PR app' also exists in the tmux job, so scope the
    // prepare assertions to the verify job's text.
    const verifyJob = job('verify');
    const rm = verifyJob.indexOf('rm -rf "$RUNNER_TEMP/verify-results"');
    const mk = verifyJob.indexOf('mkdir -p "$RUNNER_TEMP/verify-results"');
    expect(rm).toBeGreaterThan(-1);
    expect(mk).toBeGreaterThan(rm);
  });
});

describe('qwen-triage verify hardening', () => {
  const verifyJob = job('verify');

  // GitHub Actions expression comparisons are case-insensitive, so
  // `@QWEN-CODE /VERIFY` satisfies the job predicates and reaches the shell.
  // A case-sensitive `case` would fall through to commenter-only gating and
  // run the PR author's code without ever checking the author.
  it('matches verify/tmux commands case-insensitively in the shell gate', () => {
    const permStep = step('Check principal write permission');
    expect(permStep).toContain("tr '[:upper:]' '[:lower:]'");
    expect(permStep).toMatch(/case "\$body_lc" in/);
  });

  // /verify on a plain issue would be acknowledged with 👀 while the verify
  // job's PR guard skips it and publish-verify skips with it — accepted
  // looking, permanently silent.
  it('restricts the verify ack and denial notice to pull requests', () => {
    for (const name of [
      'Acknowledge verify request',
      'Explain denied verify request',
    ]) {
      const raw = step(name);
      expect(raw).toContain('github.event.issue.pull_request');
    }
  });

  // extensions.worktreeConfig activates .git/config.worktree, which
  // `git config --local` neither lists nor unsets and which can carry
  // core.hooksPath — pointing the hook sweep's recursive delete at /.
  it('neutralizes worktree-scoped git config before resolving hooksPath', () => {
    const clean = verifyJob.slice(verifyJob.indexOf('Clean stale agent state'));
    const rmWorktreeCfg = clean.indexOf('--git-path config.worktree');
    const unsetExt = clean.indexOf('--unset-all extensions.worktreeConfig');
    const hooks = clean.indexOf('--git-path hooks');
    expect(rmWorktreeCfg).toBeGreaterThan(-1);
    expect(unsetExt).toBeGreaterThan(rmWorktreeCfg);
    expect(hooks).toBeGreaterThan(unsetExt);
    // And the sweep only deletes inside the repository's own git dir.
    expect(clean).toContain('rev-parse --absolute-git-dir');
    expect(clean).toContain('not sweeping it');
  });

  // A fixed proxy port lets PR lifecycle code squat it: the real proxy dies
  // with EADDRINUSE while the health probe succeeds against the squatter,
  // and the agent then takes ITS chat completions.
  it('binds the model proxy to an ephemeral port and authenticates it', () => {
    const runStep = step('Run verification agent');
    expect(runStep).not.toContain('proxy_port=8787');
    expect(runStep).toContain("server.listen(0, '127.0.0.1'");
    expect(runStep).toContain('QWEN_PROXY_NONCE');
    expect(runStep).toContain('!= "$proxy_nonce"');
    expect(runStep).toContain('kill -0 "$OPENAI_PROXY_PID"');
  });

  // tee can fail (full/unwritable volume) while qwen exits 0; reading only
  // PIPESTATUS[0] would publish `pass` over a truncated evidence stream.
  // And 137 is ambiguous between the watchdog and an OOM kill.
  it('classifies tee failures and distinguishes watchdog kills from crashes', () => {
    const runStep = step('Run verification agent');
    expect(runStep).toContain('TEE_STATUS=${PIPESTATUS[1]}');
    expect(runStep).toMatch(/TEE_STATUS:-0.*-ne 0/s);
    expect(runStep).toContain('WATCHDOG_FIRED');
  });

  // The lifecycle-script command-file guards must be asserted on the verify
  // job's own commands: a bare step() lookup returns the tmux job's
  // identically named step, so verify-side regressions would pass silently.
  it('strips GitHub command files from both verify lifecycle commands', () => {
    // Bound to the prepare step: the agent step's own `runuser` launches
    // qwen under `env -i`, which needs no per-variable stripping.
    const prepare = verifyJob.slice(
      verifyJob.indexOf('Install and build PR app'),
      verifyJob.indexOf('Run verification agent'),
    );
    const commands = prepare.match(/runuser -u node -- env[\s\S]*?\n/g) ?? [];
    expect(commands.length).toBe(2);
    expect(step('Run verification agent')).toContain(
      'runuser -u node -- env -i',
    );
    for (const cmd of commands) {
      for (const v of [
        'GITHUB_OUTPUT',
        'GITHUB_STATE',
        'GITHUB_ENV',
        'GITHUB_PATH',
        'GITHUB_STEP_SUMMARY',
      ]) {
        expect(cmd).toContain(`-u ${v}`);
      }
    }
  });

  // The publisher has its own html_escape/emit_block, so the tmux escaping
  // tests do not cover it. Execute it: hostile content must stay literal,
  // and the escaped body must land under GitHub's 65,536-char comment cap
  // (the cap is applied AFTER escaping for exactly this reason).
  it('escapes and size-caps the verify report body', () => {
    const publishStep = step('Post verification report comment');
    const body = publishStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
    expect(body).toBeTruthy();
    const script = body.replace(/^ {10}/gm, '');
    const helpers = script.slice(
      script.indexOf('html_escape()'),
      script.indexOf('EVIDENCE_SECTION='),
    );
    const dir = mkdtempSync(join(tmpdir(), 'verify-publish-'));
    try {
      const hostile = join(dir, 'hostile.md');
      writeFileSync(
        hostile,
        '</code></pre></details>\n@everyone <img src=x onerror=alert(1)>\n& done\n',
      );
      const dense = join(dir, 'dense.md');
      writeFileSync(dense, '<T<U>>&'.repeat(7300));
      const utf8 = join(dir, 'utf8.md');
      // One ASCII byte of padding so the 45,000-byte cut lands INSIDE a
      // 3-byte character rather than on a boundary — otherwise the
      // multibyte-repair path is never exercised.
      writeFileSync(utf8, `x${'验证证据链路测试'.repeat(8000)}`);

      const emit = (file) => {
        const proc = spawnSync(
          'bash',
          ['-c', `${helpers}\nemit_block 'Report' "$1" 45000`, '_', file],
          { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
        );
        expect(proc.status).toBe(0);
        return proc.stdout;
      };

      const escaped = emit(hostile);
      expect(escaped).toContain('&lt;/code&gt;&lt;/pre&gt;&lt;/details&gt;');
      expect(escaped).toContain('&amp; done');
      expect(escaped).not.toContain('<img');
      // Only the wrapper's own tags may remain.
      expect(escaped.match(/<(?!\/?(details|summary|pre|code)\b)[a-z]/g)).toBe(
        null,
      );

      const capped = emit(dense);
      expect(Buffer.byteLength(capped)).toBeLessThan(65536);
      expect(capped).toContain('truncated');

      const cut = emit(utf8);
      // A byte cut through a multibyte character must not ship broken UTF-8.
      expect(Buffer.from(cut, 'utf8').toString('utf8')).toBe(cut);
      expect(cut).not.toContain('�');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // npm lifecycle scripts run after the pre-install flush, so the upload
  // staging dir is swept again before the agent starts; the prepare log is
  // the one artifact that must survive that sweep.
  it('re-flushes the upload staging dir after PR lifecycle scripts', () => {
    const runStep = step('Run verification agent');
    const rm = runStep.indexOf('rm -rf "$RUNNER_TEMP/verify-results"');
    const mk = runStep.indexOf('mkdir -p "$RUNNER_TEMP/verify-results"');
    const proxy = runStep.indexOf('start_openai_proxy');
    expect(rm).toBeGreaterThan(-1);
    expect(mk).toBeGreaterThan(rm);
    expect(proxy).toBeGreaterThan(mk);
    expect(runStep).toContain('prepare.log.keep');
  });

  // An early merge-ready file must not headline a run that timed out,
  // crashed, or produced no report/assertions.
  it('only honors the agent verdict for a clean, evidenced run', () => {
    const publishStep = step('Post verification report comment');
    expect(publishStep).toContain('TRUST_AGENT_VERDICT');
    expect(publishStep).toMatch(/VERDICT:-\}" = 'pass' \] && \[ -n "\$REPORT"/);
    expect(publishStep).toContain('PARTIAL_EN');
  });
});

describe('qwen-triage verify hardening round 2', () => {
  const permScript = () => {
    const body = step('Check principal write permission').match(
      /run: \|-\n([\s\S]*)$/,
    )?.[1];
    return body.replace(/^ {10}/gm, '');
  };

  // Execute the gate rather than substring-matching it: substring checks
  // stay green if lowercasing becomes disconnected from the value the
  // `case` actually reads, and Actions still admits `@QWEN-CODE /VERIFY`.
  it('routes uppercase commands to the same principals as lowercase', () => {
    const script = permScript();
    const dir = mkdtempSync(join(tmpdir(), 'verify-case-'));
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        'u="${2##*collaborators/}"; u="${u%%/*}"',
        'case "$u" in',
        '  alice) echo write ;;',
        '  bob) echo admin ;;',
        '  mallory) echo none ;;',
        '  *) echo "HTTP 404" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 },
    );
    let n = 0;
    const gate = (commentBody, author, commenter) => {
      const out = join(dir, `o${n++}`);
      writeFileSync(out, '');
      spawnSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_OUTPUT: out,
          EVENT_NAME: 'issue_comment',
          COMMENT_BODY: commentBody,
          ISSUE_AUTHOR: author,
          COMMENT_USER: commenter,
          PR_NUMBER: '1',
          TMUX_PR: '',
        },
        encoding: 'utf8',
      });
      return readFileSync(out, 'utf8');
    };
    try {
      // An untrusted author must be denied however the command is cased.
      for (const cmd of [
        '@qwen-code /verify',
        '@QWEN-CODE /VERIFY',
        '@Qwen-Code /Verify',
      ]) {
        expect(gate(cmd, 'mallory', 'bob')).toContain('should_run=false');
      }
      // ...and /TMUX keeps its author-only routing when uppercased.
      expect(gate('@QWEN-CODE /TMUX', 'alice', 'mallory')).toContain(
        'should_run=true',
      );
      expect(gate('@QWEN-CODE /TMUX', 'mallory', 'alice')).toContain(
        'should_run=false',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An empty principal (deleted author) must not vanish in word splitting
  // and leave only the commenter checked.
  it('denies /verify when a required principal cannot be resolved', () => {
    const script = permScript();
    const dir = mkdtempSync(join(tmpdir(), 'verify-empty-'));
    writeFileSync(join(dir, 'gh'), '#!/usr/bin/env bash\necho admin\n', {
      mode: 0o755,
    });
    const out = join(dir, 'o');
    writeFileSync(out, '');
    try {
      spawnSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_OUTPUT: out,
          EVENT_NAME: 'issue_comment',
          COMMENT_BODY: '@qwen-code /verify',
          ISSUE_AUTHOR: '',
          COMMENT_USER: 'bob',
          PR_NUMBER: '1',
          TMUX_PR: '',
        },
        encoding: 'utf8',
      });
      expect(readFileSync(out, 'utf8')).toContain('should_run=false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Execute the docs-only classifier: a refactor could drop the behavioral
  // exception or restore a producer-to-`grep -q` pipeline (which makes a
  // long list with an early code file classify as n/a via SIGPIPE) while
  // every substring test stays green.
  it('classifies changed-file lists without a SIGPIPE false negative', () => {
    const resolve = step('Resolve PR and snapshot metadata');
    const body = resolve.match(/run: \|-\n([\s\S]*)$/)?.[1];
    const full = body.replace(/^ {10}/gm, '');
    const start = full.indexOf('# Behavioral paths first');
    const end = full.indexOf('# Snapshot PR metadata');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const classifier = `set -uo pipefail\nfiles="$1"\n${full
      .slice(start, end)
      .replace(/echo "::notice::[^\n]*\n/g, '')
      .replace(/echo "verdict=n\/a" >> "\$GITHUB_OUTPUT"/, 'echo NA')
      .replace(/echo "decision=na" >> "\$GITHUB_OUTPUT"/, '')}\necho RUN`;
    const classify = (files) =>
      spawnSync('bash', ['-c', classifier, '_', files], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      })
        .stdout.trim()
        .split('\n')
        .pop();

    const bigEarlyCode = [
      'packages/core/src/a.ts',
      ...Array.from({ length: 60000 }, (_, i) => `docs/f${i}.md`),
    ].join('\n');
    expect(classify(bigEarlyCode)).toBe('RUN');
    expect(classify('docs/a.md\nREADME.md\nassets/x.png')).toBe('NA');
    expect(classify('.qwen/skills/verify-pr/SKILL.md')).toBe('RUN');
    expect(classify('.github/workflows/x.yml')).toBe('RUN');
    expect(classify('scripts/lint.js')).toBe('RUN');
  });

  // Symlink stripping must happen AFTER the artifacts are copied in;
  // moving it earlier would keep a presence-only assertion green while
  // copied symlinks still reach upload-artifact, which dereferences them.
  it('strips symlinks after collecting artifacts, not before', () => {
    const runStep = step('Run verification agent');
    const copy = runStep.indexOf(
      '-exec cp -r {} "$RUNNER_TEMP/verify-results/"',
    );
    const strip = runStep.indexOf('-type l -delete');
    expect(copy).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(copy);
  });

  // The trust boundary is re-established after the PR's lifecycle scripts:
  // kill leftover build processes, re-pin the verifier root-owned, and give
  // the agent a fresh home before it starts.
  it('re-establishes the verifier trust boundary after the build', () => {
    const runStep = step('Run verification agent');
    const kill = runStep.indexOf('pkill -KILL -u node');
    const repin = runStep.indexOf("git archive 'HEAD^1' -- .qwen");
    const chown = runStep.indexOf('chown -R root:root .qwen');
    const home = runStep.indexOf('verify-agent-home');
    const launch = runStep.indexOf('QWEN_CMD=(');
    for (const i of [kill, repin, chown, home, launch]) {
      expect(i).toBeGreaterThan(-1);
    }
    expect(repin).toBeGreaterThan(kill);
    expect(chown).toBeGreaterThan(repin);
    expect(launch).toBeGreaterThan(home);
    // Killing is not enough on its own: surviving build processes must
    // fail the step rather than race the sweeps that follow.
    expect(runStep).toContain('pgrep -u node');
    expect(runStep).toContain('refusing to start the agent');
    expect(runStep).toContain('"HOME=$AGENT_HOME"');
    // The proxy must require this run's bearer, not just a fixed dummy key.
    expect(runStep).toContain('"OPENAI_API_KEY=$PROXY_TOKEN"');
    expect(runStep).toContain(
      'req.headers.authorization !== `Bearer ${token}`',
    );
  });

  // Cleanups must not glob below a PR-writable path: .qwen/tmp can be a
  // symlink, and `rm -rf .qwen/tmp/*` then deletes the target's contents.
  it('removes .qwen/tmp itself rather than globbing through it', () => {
    // Strip comment lines: the fix's own comment quotes the unsafe form.
    const code = job('verify')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toContain('rm -rf .qwen/tmp/*');
    expect(code).toContain('rm -rf .qwen/tmp ');
  });

  // Status/report lifecycle is keyed on a machine marker, and identity
  // failures must not widen the ownership filter to every user.
  it('keys the status comment on a marker and fails closed on identity', () => {
    for (const name of [
      'Resolve PR and snapshot metadata',
      'Post verification report comment',
    ]) {
      const s = step(name);
      expect(s).toContain('qwen-triage:verify-state=running');
      expect(s).not.toContain('$bot == ""');
      expect(s).toContain('.user.login == $bot');
    }
  });

  // The evidence-hosting path carries the untrusted-image checks; exercise
  // it end to end against a bare local remote.
  it('hosts only valid, unique, in-limit PNGs and degrades to text', () => {
    const publishStep = step('Post verification report comment');
    const script = publishStep
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    const dir = mkdtempSync(join(tmpdir(), 'verify-imgs-'));
    const sh = (cmd, opts = {}) =>
      spawnSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts });
    try {
      // A bare remote with a pr-assets branch, plus a gh stub.
      sh(`git init -q --bare "${dir}/assets.git"`);
      sh(
        `mkdir -p "${dir}/seed" && cd "${dir}/seed" && git init -q && git checkout -q -b pr-assets && echo s > s.txt && git add . && git -c user.name=t -c user.email=t@t commit -qm s && git push -q "${dir}/assets.git" pr-assets`,
      );
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/usr/bin/env bash',
          'for a in "$@"; do case "$a" in body=@*) cp "${a#body=@}" "$GH_STUB_OUT";; esac; done',
          'case "$*" in *user*--jq*) echo qwen-code-ci-bot ;; *comments*GET*) echo "[]" ;; esac',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      const work = join(dir, 'work');
      const art = join(work, 'verify-results', 'prA-verify-1');
      mkdirSync(join(art, 'evidence'), { recursive: true });
      mkdirSync(join(work, 'verify-results', 'prB-verify-2', 'evidence'), {
        recursive: true,
      });
      const png = (p, bytes) =>
        writeFileSync(
          p,
          Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(bytes),
          ]),
        );
      png(join(art, 'evidence', '01-ab.png'), 500);
      // Same sanitized name in a second artifact dir -> must not duplicate.
      png(
        join(work, 'verify-results', 'prB-verify-2', 'evidence', '01-ab.png'),
        500,
      );
      writeFileSync(join(art, 'evidence', '02-fake.png'), 'not a png');
      png(join(art, 'evidence', '03-big.png'), 2 * 1024 * 1024);
      png(join(art, 'evidence', '04-edge.png'), 2 * 1024 * 1024 - 9);
      writeFileSync(join(art, 'report.md'), '## r\n');

      const out = join(dir, 'comment.md');
      const res = sh(script, {
        cwd: work,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_STUB_OUT: out,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_RUN_ID: '77',
          GITHUB_RUN_ATTEMPT: '1',
          PR_NUMBER: '7999',
          RUN_URL: 'u',
          VERIFY_RESULT: 'success',
          VERDICT: 'pass',
          AGENT_VERDICT: 'findings',
          SKIP_REASON: '',
          PREPARE_FAILURE_PHASE: '',
          VERIFY_ASSETS_REMOTE: `${dir}/assets.git`,
        },
      });
      expect(res.status).toBe(0);
      const hosted = sh(
        `git -C "${dir}/assets.git" ls-tree -r --name-only pr-assets | grep verify/ || true`,
      )
        .stdout.trim()
        .split('\n')
        .filter(Boolean);
      // Valid + at the exact 2 MiB boundary are hosted; the text file, the
      // oversize file and the duplicate name are not.
      expect(hosted.map((p) => p.split('/').pop()).sort()).toEqual([
        '01-ab.png',
        '04-edge.png',
      ]);
      const comment = readFileSync(out, 'utf8');
      expect(comment).toContain('![01-ab](');
      expect(comment).not.toContain('02-fake');
      expect(comment).toContain('did not pass the hosting checks');

      // No reachable pr-assets branch -> text-only, never an aborted report.
      sh(`git init -q --bare "${dir}/empty.git"`);
      const out2 = join(dir, 'comment2.md');
      const res2 = sh(script, {
        cwd: work,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_STUB_OUT: out2,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_RUN_ID: '78',
          GITHUB_RUN_ATTEMPT: '1',
          PR_NUMBER: '7999',
          RUN_URL: 'u',
          VERIFY_RESULT: 'success',
          VERDICT: 'pass',
          AGENT_VERDICT: 'findings',
          SKIP_REASON: '',
          PREPARE_FAILURE_PHASE: '',
          VERIFY_ASSETS_REMOTE: `${dir}/empty.git`,
        },
      });
      expect(res2.status).toBe(0);
      const comment2 = readFileSync(out2, 'utf8');
      expect(comment2).toContain('Sandboxed verification');
      expect(comment2).not.toContain('Evidence images');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Only a validated assertions object counts as evidence.
  it('rejects inconsistent assertions objects', () => {
    const publishStep = step('Post verification report comment');
    expect(publishStep).toContain('.total == .pass + .fail');
    expect(publishStep).toContain('all(type == "number" and . >= 0');
  });
});
