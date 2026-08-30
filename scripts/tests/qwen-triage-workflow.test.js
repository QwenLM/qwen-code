/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/qwen-triage.yml', 'utf8');
const cacheProducerWorkflow = readFileSync(
  '.github/workflows/npm-cache.yml',
  'utf8',
);
const prSkill = readFileSync(
  '.qwen/skills/triage/references/pr-workflow.md',
  'utf8',
);
const triageSkillDoc = readFileSync('.qwen/skills/triage/SKILL.md', 'utf8');
const verifySkill = readFileSync('.qwen/skills/verify-pr/SKILL.md', 'utf8');
const hasGnuRealpath =
  spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0;

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

// Several step names exist in more than one job (both `tmux-testing` and
// `verify` have "Install and build PR app"). `step()` returns the FIRST
// match, so anything asserting on a verify-lane step must scope to the job
// or it silently tests the tmux copy — which has bitten this suite before.
function stepIn(jobName, stepName) {
  const scope = job(jobName);
  const escaped = escapeRegExp(stepName);
  const match = scope.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|$)`,
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

// Executed-harness factory shared by the claim and finalize lifecycle tests:
// a stubbed `gh` on PATH with failure-injection arms, the real step script
// run under GitHub's exact shell flags, and capture of the body/call the
// stub saw plus whatever the step appended to $GITHUB_OUTPUT. GitHub runs
// `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`, and a step's
// own `set -uo pipefail` does not turn `-e` back off — match that, or an
// unguarded failing command kills the real step in production while the
// harness stays green. One shared copy keeps that fidelity contract in one
// place: the two pasted copies already diverged once (only the finalize stub
// had the failure arms), and a later fix made on only one copy would silently
// degrade exactly one test. The failure arms stay inert unless a scenario
// sets GH_STUB_FAIL_LIST / GH_STUB_FAIL_WRITE; a POST (any write that is not
// a PATCH) answers with GH_STUB_POST_ID (default 7777) like the comments
// API's created-id payload.
function makeGhHarness(label) {
  const dir = mkdtempSync(join(tmpdir(), `triage-${label}-`));
  const commentsFile = join(dir, 'comments.json');
  const bodyOut = join(dir, 'body.md');
  const callOut = join(dir, 'call.txt');
  const outputFile = join(dir, 'github_output');
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      'body=""',
      'for a in "$@"; do case "$a" in body=*) body="${a#body=}";; esac; done',
      'if [ -n "$body" ]; then',
      '  printf "%s" "$body" > "$GH_STUB_OUT"',
      '  printf "%s\\n" "$*" > "$GH_STUB_CALL"',
      'fi',
      'case "$*" in',
      "  'api user --jq .login') echo qwen-code-ci-bot ;;",
      '  *--paginate*) [ -n "${GH_STUB_FAIL_LIST:-}" ] && exit 1; cat "$GH_STUB_COMMENTS" ;;',
      '  *PATCH*) [ -n "${GH_STUB_FAIL_WRITE:-}" ] && exit 1 ;;',
      '  *) [ -n "${GH_STUB_FAIL_WRITE:-}" ] && exit 1; echo "${GH_STUB_POST_ID:-7777}" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  const RUN_URL = 'https://github.com/QwenLM/qwen-code/actions/runs/77';
  const bashArgs = ['--noprofile', '--norc', '-eo', 'pipefail', '-c'];
  const run = (script, env) => {
    rmSync(bodyOut, { force: true });
    rmSync(callOut, { force: true });
    rmSync(outputFile, { force: true });
    const proc = spawnSync('bash', [...bashArgs, script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 'x',
        GITHUB_REPOSITORY: 'QwenLM/qwen-code',
        NUMBER: '7999',
        RUN_URL,
        GITHUB_OUTPUT: outputFile,
        GH_STUB_OUT: bodyOut,
        GH_STUB_CALL: callOut,
        GH_STUB_COMMENTS: commentsFile,
        ...env,
      },
      encoding: 'utf8',
    });
    expect(proc.status, proc.stderr).toBe(0);
    return {
      body: existsSync(bodyOut) ? readFileSync(bodyOut, 'utf8') : null,
      call: existsSync(callOut) ? readFileSync(callOut, 'utf8') : null,
      out: `${proc.stdout}${proc.stderr}`,
      outputs: existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '',
    };
  };
  return {
    commentsFile,
    run,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    RUN_URL,
  };
}

// Spawns the real proxy against a streaming upstream (20 chunks, 200 ms
// apart = 4 s total) and a stalling upstream (headers + one chunk, then
// silence), with the proxy's 120 s watchdog shortened to 1.5 s. The healthy
// stream spans longer than the idle window while each gap stays under it, so
// it arrives in full only if the watchdog is idle (refreshed per chunk) and
// not a total cap; and a mid-body stall must CLOSE the downstream response,
// not strand the client on a silent socket until its own timeout.
function runProxyWatchdogTest(proxy) {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-watchdog-'));
  try {
    writeFileSync(
      join(dir, 'proxy.js'),
      proxy.replace(/^ {10}/gm, '').replaceAll('120_000', '1500'),
    );
    writeFileSync(
      join(dir, 'stream.js'),
      [
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        'const NL = String.fromCharCode(10);',
        'const ticks = Number(process.argv[3]);',
        'const tickMs = Number(process.argv[4]);',
        'const s = http.createServer((q, r) => {',
        "  r.writeHead(200, { 'content-type': 'text/event-stream' });",
        '  let i = 0;',
        '  const iv = setInterval(() => {',
        "    r.write('data: ' + i++ + NL + NL);",
        '    if (i >= ticks) { clearInterval(iv); r.end(); }',
        '  }, tickMs);',
        '});',
        "s.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(s.address().port)));",
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'stall.js'),
      [
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        'const NL = String.fromCharCode(10);',
        'const s = http.createServer((q, r) => {',
        "  r.writeHead(200, { 'content-type': 'text/event-stream' });",
        "  r.write('data: 0' + NL + NL);",
        '});',
        "s.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(s.address().port)));",
      ].join('\n'),
    );
    const driver = [
      'set -u',
      'node "$1/stream.js" "$1/stream.port" 20 200 & STREAM=$!',
      'node "$1/stall.js" "$1/stall.port" & STALL=$!',
      'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/stream.port" ] && [ -s "$1/stall.port" ] && break; sleep 0.3; done',
      'REVIEW_OPENAI_BASE_URL="http://127.0.0.1:$(cat "$1/stream.port")/v1" REVIEW_OPENAI_API_KEY=k QWEN_PROXY_NONCE=n0nce PROXY_TOKEN=t0ken node "$1/proxy.js" "$1/px.port" & PX=$!',
      'REVIEW_OPENAI_BASE_URL="http://127.0.0.1:$(cat "$1/stall.port")/v1" REVIEW_OPENAI_API_KEY=k QWEN_PROXY_NONCE=n0nce PROXY_TOKEN=t0ken node "$1/proxy.js" "$1/px2.port" & PX2=$!',
      'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/px.port" ] && [ -s "$1/px2.port" ] && break; sleep 0.3; done',
      'P="$(cat "$1/px.port")"; P2="$(cat "$1/px2.port")"',
      'echo "chunks=$(curl -sS --max-time 15 -X POST -H "Authorization: Bearer t0ken" "http://127.0.0.1:$P/v1/chat/completions" | grep -c "^data:")"',
      'curl -sS -o /dev/null --max-time 10 -X POST -H "Authorization: Bearer t0ken" "http://127.0.0.1:$P2/v1/chat/completions"',
      'echo "stall_exit=$?"',
      'kill $STREAM $STALL $PX $PX2 2>/dev/null',
    ].join('\n');
    return spawnSync('bash', ['-c', driver, '_', dir], {
      encoding: 'utf8',
      timeout: 60000,
    }).stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    // The escape now writes to a file and the cap is applied afterwards, so
    // the guarantee is "a render failure is caught", not the old inline
    // capture shape. See the tmux-lane-parity suite for the cap itself.
    expect(postStep).toContain('html_escape > "$esc_file"');
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

  it('pins the action reinstall to the version the job already runs', () => {
    expect(workflow).toContain("id: 'ensure_qwen'");
    expect(workflow).toContain(
      'echo "version=$(qwen --version)" >> "${GITHUB_OUTPUT}"',
    );
    expect(workflow).toContain(
      "qwen_cli_version: '${{ steps.ensure_qwen.outputs.version }}'",
    );
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

  it('fails an API-error response instead of passing it as a triage (#10314)', () => {
    const checkStep = step('Check triage response');
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

    // The verbatim 268-char response of run 33070765162 (triage for #10285):
    // a bare model-layer connection error that the old check classified as a
    // successful triage, so nothing retried or alerted.
    const apiError =
      '[API Error: Connection error. (cause: connect ETIMEDOUT 47.94.20.201:443; connect ENETUNREACH 2408:400a:3e:effd:6ac1:ae6e:cde9:4efe:443 - Local (:::0); connect ETIMEDOUT 101.201.58.201:443; connect ENETUNREACH 2408:400a:3e:effb:c146:fb04:1e3d:5cc1:443 - Local (:::0))]';
    const bare = run({ RESPONSE: apiError });
    expect(bare.status).not.toBe(0);
    expect(bare.out).toContain('API error');

    // The stream-json adapter appends the formatted error LAST
    // (BaseJsonOutputAdapter appendText), optionally followed by rate-limit
    // guidance: an error after partial output and a quota error ending in
    // the guidance suffix must fail too. Same shapes as
    // qwen-code-pr-review.yml's classifier.
    expect(
      run({ RESPONSE: `Partial triage notes\n${apiError}` }).status,
    ).not.toBe(0);
    expect(
      run({
        RESPONSE:
          '[API Error: Quota exceeded.] Please wait and try again later. To increase your limits, request a quota increase through AI Studio, or switch to another /auth method',
      }).status,
    ).not.toBe(0);

    // A real summary still passes: one that merely QUOTES an API error
    // mid-prose keeps writing afterwards (parity with the pr-review
    // workflow's success_mentions_api_error case), and the normal
    // empty/'null' behavior is untouched.
    expect(
      run({
        RESPONSE:
          'This issue reports "[API Error: Connection error.]" which points at the model endpoint; needs the endpoint config.',
      }).status,
    ).toBe(0);
    expect(run({ RESPONSE: 'triaged' }).status).toBe(0);
    expect(run({ RESPONSE: '' }).status).not.toBe(0);
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
    // "Did this re-run post anything?" must stay state-agnostic: a re-posted
    // CHANGES_REQUESTED counts as a review just as much as an approval. The
    // separate head-commit probe below is the one that filters on state.
    const sinceQuery = notifyStep.match(/any\(\.\[\]\[\];[^\n]*\$since\)/)?.[0];
    expect(sinceQuery).toBeTruthy();
    expect(sinceQuery).not.toContain('.state');
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

  // The re-run summary used to have two outcomes, and the routine one was
  // reported as the broken one. The triage skill's confidence table sends 3/5
  // down a DEFER path that posts a COMMENTED review and deliberately does not
  // vote — a fork `refactor` hitting the approval guardrail, or a core change
  // escalated for maintainer awareness. Observed on #7948 and #8141: both
  // deferred exactly as designed, and both were told the bot had "no review of
  // its own" while its COMMENTED review was visible on the page.
  //
  // Execute the real classifier rather than matching its text: the states are
  // the contract, and a jq edit that silently reclassifies one is invisible to
  // a string assertion.
  it.skipIf(spawnSync('jq', ['--version']).status !== 0)(
    'classifies a deferring COMMENTED review apart from a missing one',
    () => {
      const notifyStep = step('Notify silent triage re-run');
      const program = notifyStep.match(
        /--arg sha "\$HEAD_SHA" \\\n\s*'([\s\S]*?)'\n/,
      )?.[1];
      expect(program).toBeTruthy();

      const dir = mkdtempSync(join(tmpdir(), 'rerun-standing-'));
      const progFile = join(dir, 'standing.jq');
      writeFileSync(progFile, program);
      const classify = (reviews) => {
        const r = spawnSync(
          'jq',
          [
            '-rs',
            '--arg',
            'bot',
            'bot',
            '--arg',
            'sha',
            'HEAD',
            '-f',
            progFile,
          ],
          { input: JSON.stringify(reviews), encoding: 'utf8' },
        );
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      const rev = (state, login = 'bot', commit = 'HEAD') => ({
        user: { login },
        commit_id: commit,
        state,
      });

      try {
        // A vote of either kind stands.
        expect(classify([rev('APPROVED')])).toBe('own');
        expect(classify([rev('CHANGES_REQUESTED')])).toBe('own');

        // The defer path. The second arm is the real #7948/#8141 shape: the bot
        // deferred and a maintainer approved, which must NOT read as the bot's
        // own vote — `main` needs two, so the PR is still one short.
        expect(classify([rev('COMMENTED')])).toBe('deferred');
        expect(classify([rev('COMMENTED'), rev('APPROVED', 'wenshao')])).toBe(
          'deferred',
        );

        // DISMISSED is NOT a deferral, and this is the distinction the first
        // draft of this change got wrong. `dismiss_stale_reviews` voids the
        // bot's approval on every push, which is exactly when a fresh one is
        // required — reporting that as a routine defer would say the opposite
        // of what the maintainer needs to know. Same for an unsubmitted PENDING.
        expect(classify([rev('DISMISSED')])).toBe('none');
        expect(classify([rev('PENDING')])).toBe('none');
        // ...but a real COMMENTED alongside a DISMISSED one is still a defer.
        expect(classify([rev('DISMISSED'), rev('COMMENTED')])).toBe('deferred');

        // The original incident this whole probe exists for: a human approval
        // with no bot review must stay `none`, not be read as the bot's own.
        expect(classify([rev('APPROVED', 'wenshao')])).toBe('none');
        // A vote on an earlier commit does not carry over.
        expect(classify([rev('APPROVED', 'bot', 'OLD')])).toBe('none');
        expect(classify([])).toBe('none');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // Both notes are posted in both languages, matching the status comment
  // composer in the same step. The re-run summary was the one body in this
  // workflow that shipped English only, so a Chinese reader got the bot's
  // bilingual stage-3 review followed by an English-only summary of it.
  it('writes the re-run summary bilingually, and warns on every no-vote state', () => {
    const notifyStep = step('Notify silent triage re-run');
    for (const key of ['NOTE_EN', 'NOTE_ZH']) {
      // own / deferred / none / unreadable
      expect(
        (notifyStep.match(new RegExp(`${key}=`, 'g')) ?? []).length,
        `${key} is missing a branch`,
      ).toBe(4);
    }
    expect(notifyStep).toContain('"$NOTE_EN"');
    expect(notifyStep).toContain('"$NOTE_ZH"');
    expect(notifyStep).toMatch(/[一-鿿]/);

    // The ::warning is the operator-facing signal. Both no-vote states
    // (deferred and none) fire it — see the note below for why silencing
    // the defer case would be wrong.
    const noneBranch = notifyStep.slice(
      notifyStep.indexOf('none)'),
      notifyStep.indexOf('*)'),
    );
    const deferredBranch = notifyStep.slice(
      notifyStep.indexOf('deferred)'),
      notifyStep.indexOf('none)'),
    );
    // BOTH warn. At the reviews-API level a COMMENTED-only review is
    // indistinguishable from a deliberate 3/5 defer — the same tuple is
    // produced by an approval a push DISMISSED — and either way the PR is one
    // approval short with the bot not supplying it. So the operator signal
    // fires for both and only the wording differs. Silencing the defer case
    // would have muted a warning that exists for a real incident.
    expect(noneBranch).toContain(
      '::warning title=Triage re-run left no bot review',
    );
    expect(deferredBranch).toContain(
      '::warning title=Triage re-run left no bot review',
    );
    // ...and each warning describes what was actually measured.
    expect(noneBranch).toContain('APPROVED, CHANGES_REQUESTED or COMMENTED');
    expect(deferredBranch).toContain('only a COMMENTED review');
  });

  it('posts an early live-progress status comment and finalizes the same one', () => {
    const statusStep = step('Post triage status comment');
    // Announced up front (before the long agent step) with the live run link.
    expect(statusStep).toContain("MARKER='<!-- qwen-triage lifecycle -->'");
    expect(statusStep).toContain(
      "LEGACY_MARKER='<!-- qwen-triage stage=status -->'",
    );
    expect(statusStep).toContain('actions/runs/${{ github.run_id }}');
    expect(statusStep).toContain('watch live progress');
    // Upsert by marker so a re-run reuses the one comment instead of stacking.
    // startswith (not contains) prevents matching a comment that merely quotes
    // the marker; the bot-author filter prevents matching a human's comment.
    expect(statusStep).toContain("gh api user --jq '.login'");
    expect(statusStep).toContain(
      'Cannot resolve bot identity; skipping status comment upsert.',
    );
    expect(statusStep).toContain('select(.user.login == $bot)');
    expect(statusStep).toContain('startswith($m)');
    expect(statusStep).not.toContain('contains($m)');
    expect(statusStep).toContain('--method PATCH');
    // Best-effort: a failed status post warns and continues, never fails triage.
    expect(statusStep).toContain('set -uo pipefail');
    expect(statusStep).toContain('continuing.');
    // The claim exports the id of the comment it wrote; finalize PATCHes
    // exactly that id, so the two steps cannot disagree about which comment
    // this run owns — no body-URL matching, no second selection to race.
    expect(statusStep).toContain("id: 'status'");
    expect(statusStep).toContain(
      'echo "comment_id=$COMMENT_ID" >> "$GITHUB_OUTPUT"',
    );
    // The executed claim harness's stub answers a POST with the already-
    // extracted id, so nothing there exercises the POST arm's `--jq '.id'`
    // (removing the flag keeps the suite green). Pin the flag statically.
    expect(statusStep).toContain("--jq '.id'");
    expect(statusStep).toContain('[watch live progress]($RUN_URL)');
    expect(statusStep).toContain('[查看实时进度]($RUN_URL)');

    const finalizeStep = step('Finalize triage status comment');
    // Runs on EVERY terminal outcome and PATCHes exactly the comment the
    // claim step exported. always(), not success() || failure():
    // cancellation — cancel-in-progress superseding the run, job timeout, or
    // manual cancel — used to skip the step and leave the early comment
    // claiming the run was still in progress.
    expect(finalizeStep).toContain(
      'if: "always() && steps.resolve.outputs.number != \'\'"',
    );
    expect(finalizeStep).not.toContain('success() || failure()');
    expect(finalizeStep).toContain('steps.triage.outcome');
    expect(finalizeStep).toContain("JOB_STATUS: '${{ job.status }}'");
    expect(finalizeStep).toContain('Qwen Triage was cancelled');
    expect(finalizeStep).toContain('已取消');
    expect(finalizeStep).toContain(
      'elif [ "${JOB_STATUS:-}" = \'cancelled\' ]',
    );
    expect(finalizeStep).toContain(
      'if [ "${TRIAGE_OUTCOME:-}" = \'success\' ] && [ "${JOB_STATUS:-}" != \'failure\' ]; then',
    );
    // The id arrives through env like the other step inputs — and finalize
    // must NOT re-derive it by listing comments: re-running a selection at
    // finalize time is exactly the race this coupling removes.
    expect(finalizeStep).toContain(
      "STATUS_COMMENT_ID: '${{ steps.status.outputs.comment_id }}'",
    );
    expect(finalizeStep).not.toContain('--paginate');
    expect(finalizeStep).not.toContain('gh api user');
    expect(finalizeStep).toContain(
      'repos/$GITHUB_REPOSITORY/issues/comments/$STATUS_COMMENT_ID',
    );
    expect(finalizeStep).toContain('--method PATCH');
    // An empty id means this run never ended up owning a comment (a cancel
    // landing before the claim posted, or a transiently failed claim write):
    // no-op, never a fresh post or a lookup that could clobber a previous
    // run's terminal wording.
    expect(finalizeStep).toContain('if [ -z "${STATUS_COMMENT_ID:-}" ]; then');
    expect(finalizeStep).toContain(
      'This run claimed no status comment; nothing to finalize.',
    );
    expect(finalizeStep).toContain('Qwen Triage finished');
    expect(finalizeStep).toContain('ended early');
    expect(finalizeStep).toContain('[view run]($RUN_URL)');
  });

  // Unordered substring pinning cannot tell which terminal state PATCHes which
  // wording (swapping the success and cancelled bodies survives it), nor
  // whether the ZH half is really Chinese. Execute the real composer against
  // a stubbed `gh` and assert the body it sends for each terminal state.
  const finalizeWordings = {
    finished: ['Qwen Triage finished', 'Qwen Triage 已完成'],
    cancelled: ['Qwen Triage was cancelled', 'Qwen Triage 已取消'],
    early: ['Qwen Triage ended early', 'Qwen Triage 提前结束'],
  };
  const finalizeCombos = [
    [
      'green job',
      { TRIAGE_OUTCOME: 'success', JOB_STATUS: 'success' },
      'finished',
    ],
    // A timeout/manual cancel landing AFTER the triage step already
    // succeeded still reports the success.
    [
      'triage success, job cancelled after',
      { TRIAGE_OUTCOME: 'success', JOB_STATUS: 'cancelled' },
      'finished',
    ],
    // A red job despite a successful triage step — 'Check triage response'
    // exits 1 on an empty summary — must NOT say "finished" and point at
    // stage comments that were never posted.
    [
      'triage success, job failed',
      { TRIAGE_OUTCOME: 'success', JOB_STATUS: 'failure' },
      'early',
    ],
    [
      'triage cancelled',
      { TRIAGE_OUTCOME: 'cancelled', JOB_STATUS: 'cancelled' },
      'cancelled',
    ],
    [
      'triage failed, job cancelled',
      { TRIAGE_OUTCOME: 'failure', JOB_STATUS: 'cancelled' },
      'cancelled',
    ],
    [
      'triage failed, job failed',
      { TRIAGE_OUTCOME: 'failure', JOB_STATUS: 'failure' },
      'early',
    ],
    [
      'triage skipped, job failed',
      { TRIAGE_OUTCOME: 'skipped', JOB_STATUS: 'failure' },
      'early',
    ],
  ];

  it.each(finalizeCombos)(
    'finalizes the claimed comment: %s',
    (_label, env, expected) => {
      const finalizeStep = step('Finalize triage status comment');
      const script = finalizeStep
        .match(/run: \|-\n([\s\S]*)$/)?.[1]
        .replace(/^ {10}/gm, '');
      expect(script).toBeTruthy();

      const { run, cleanup } = makeGhHarness('finalize');
      try {
        const { body, call } = run(script, {
          ...env,
          STATUS_COMMENT_ID: '43',
        });
        expect(call).toContain('--method PATCH');
        expect(call).toContain('issues/comments/43');
        expect(body.startsWith('<!-- qwen-triage lifecycle -->'), body).toBe(
          true,
        );
        for (const [kind, [en, zh]] of Object.entries(finalizeWordings)) {
          if (kind === expected) {
            expect(body, JSON.stringify(env)).toContain(en);
            expect(body, JSON.stringify(env)).toContain(zh);
          } else {
            expect(body, JSON.stringify(env)).not.toContain(en);
            expect(body, JSON.stringify(env)).not.toContain(zh);
          }
        }
      } finally {
        cleanup();
      }
    },
  );

  it('skips finalize when the run never claimed a comment, and survives a failed PATCH', () => {
    const finalizeStep = step('Finalize triage status comment');
    const script = finalizeStep
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    expect(script).toBeTruthy();

    const { run, cleanup } = makeGhHarness('finalize-noop');
    try {
      // A cancel landing before the claim posted leaves the id empty: no
      // write at all — a fresh post here would clobber a previous run's
      // terminal wording, and a lookup-based finalize would PATCH whatever
      // comment happens to be newest.
      const noop = run(script, {
        TRIAGE_OUTCOME: 'skipped',
        JOB_STATUS: 'cancelled',
      });
      expect(noop.body).toBe(null);
      expect(noop.call).toBe(null);
      expect(noop.out).toContain(
        'This run claimed no status comment; nothing to finalize.',
      );

      // A failing PATCH must not fail the step: under GitHub's `-eo
      // pipefail` an unguarded write turns a transient API error into a red
      // job even under if: always(). `run` asserts exit 0.
      const patchFailed = run(script, {
        TRIAGE_OUTCOME: 'failure',
        JOB_STATUS: 'cancelled',
        STATUS_COMMENT_ID: '43',
        GH_STUB_FAIL_WRITE: '1',
      });
      expect(patchFailed.out).toContain(
        'Failed to finalize triage status comment; continuing.',
      );
    } finally {
      cleanup();
    }
  });

  // The claim step is the only selection left in the lifecycle: newest-wins
  // marker reuse (the shared slot), with the chosen or created id exported
  // for finalize to PATCH. Execute the real claim script against a stubbed
  // `gh`.
  it.skipIf(spawnSync('jq', ['--version']).status !== 0)(
    'claims the newest marker and exports the comment id for finalize',
    () => {
      const statusStep = step('Post triage status comment');
      const script = statusStep
        .match(/run: \|-\n([\s\S]*)$/)?.[1]
        .replace(/^ {10}/gm, '');
      expect(script).toBeTruthy();

      const { commentsFile, run, cleanup } = makeGhHarness('claim');
      try {
        const marker = '<!-- qwen-triage lifecycle -->';
        const comment = (id, body) => ({
          id,
          user: { login: 'qwen-code-ci-bot' },
          body,
        });
        const tombstone = (runId) =>
          `${marker}\n\n✅ earlier verdict [finalize run](https://github.com/QwenLM/qwen-code/actions/runs/${runId})`;

        // No marker yet: POST the running claim and export the created id.
        // The body must START with the lifecycle marker — the selector is
        // gated on startswith($m), so a composer that drops the marker posts
        // a claim nothing ever recognizes or flips.
        writeFileSync(commentsFile, '[]');
        const fresh = run(script, {});
        expect(fresh.call).toContain('issues/7999/comments');
        expect(fresh.call).not.toContain('--method PATCH');
        expect(fresh.body).toContain('Qwen Triage is running');
        expect(fresh.body.startsWith(marker), fresh.body).toBe(true);
        expect(fresh.outputs).toContain('comment_id=7777');

        // Existing markers: reuse the NEWEST one — the marker comment is a
        // shared slot, not a per-run log — and export the reused id.
        writeFileSync(
          commentsFile,
          JSON.stringify([
            comment(42, tombstone(55)),
            comment(44, tombstone(456)),
          ]),
        );
        const newest = run(script, {});
        expect(newest.call).toContain('--method PATCH');
        expect(newest.call).toContain('issues/comments/44');
        expect(newest.call).not.toContain('issues/comments/42');
        expect(newest.outputs).toContain('comment_id=44');

        // A legacy marker body is still a reusable slot: dropping
        // startswith($legacy) from the claim jq loses single-slot healing
        // for pre-migration threads and survives the suite.
        writeFileSync(
          commentsFile,
          JSON.stringify([
            comment(
              41,
              '<!-- qwen-triage stage=status -->\n\nlegacy status wording',
            ),
          ]),
        );
        const legacy = run(script, {});
        expect(legacy.call).toContain('--method PATCH');
        expect(legacy.call).toContain('issues/comments/41');
        expect(legacy.outputs).toContain('comment_id=41');

        // A failing write exports an EMPTY id — finalize must see "this run
        // never claimed anything", not a guessed id — and never fails the
        // step: under GitHub's `-eo pipefail` an unguarded POST/PATCH turns
        // a transient comments-API blip into a red job BEFORE 'Run Qwen
        // Triage' starts. `run` asserts exit 0 for each arm.
        writeFileSync(commentsFile, '[]');
        const postFailed = run(script, { GH_STUB_FAIL_WRITE: '1' });
        expect(postFailed.out).toContain(
          'Failed to post triage status comment; continuing.',
        );
        expect(postFailed.outputs).toContain('comment_id=');
        expect(postFailed.outputs).not.toContain('comment_id=7777');

        writeFileSync(
          commentsFile,
          JSON.stringify([comment(45, tombstone(55))]),
        );
        const patchFailed = run(script, { GH_STUB_FAIL_WRITE: '1' });
        expect(patchFailed.out).toContain(
          'Failed to update triage status comment; continuing.',
        );
        expect(patchFailed.outputs).toContain('comment_id=');
        expect(patchFailed.outputs).not.toContain('comment_id=45');

        // An unreadable comment list is best-effort too: `|| EXISTING_ID=''`
        // falls back to a fresh claim post; deleting the guard kills the
        // step on a transient blip.
        const listFailed = run(script, { GH_STUB_FAIL_LIST: '1' });
        expect(listFailed.call).toContain('issues/7999/comments');
        expect(listFailed.call).not.toContain('--method PATCH');
        expect(listFailed.outputs).toContain('comment_id=7777');
      } finally {
        cleanup();
      }
    },
  );

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

  it('keeps the sandboxed-lane recommendation out of the local-only section', () => {
    // Measured on 2026-07-28: of 16 open PRs whose AUTHOR had write access
    // and that already carried a triage comment, exactly 1 mentioned
    // `/verify`. The instruction existed the whole time — buried as a
    // conditional clause inside a section headed "local invocation ONLY"
    // that opens with "Never in unattended CI." An agent running in CI
    // reasonably skipped the whole section, so the instruction never fired.
    //
    // The fix is positional, so the test has to be positional too:
    // asserting merely that the file mentions `/verify` would have passed
    // throughout the entire period the recommendation was dead.
    const localOnly = prSkill.indexOf('local invocation ONLY');
    const recommendation = prSkill.indexOf(
      '#### 2b-bis. Name the sandboxed lane when CI cannot settle the claim',
    );
    expect(recommendation).toBeGreaterThan(-1);
    expect(localOnly).toBeGreaterThan(-1);
    expect(recommendation).toBeLessThan(localOnly);

    // Whitespace-normalised: these are prose assertions, and prettier
    // reflows this file. A test that goes red on a re-wrap teaches people to
    // ignore it.
    const section = prSkill
      .slice(recommendation, localOnly)
      .replace(/\s+/g, ' ');
    // It must be reachable on the CI path...
    expect(section).toContain('required element of the Stage 2 comment');
    expect(section).toContain('applies on an unattended run');
    expect(section).not.toContain('Never in unattended CI');
    // ...name the trigger and what it settles, not just the trigger...
    expect(section).toContain('@qwen-code /verify');
    expect(section).toContain('the specific claim it would settle');
    // ...and keep the author-permission case, which since the sponsored
    // lane shipped must offer the sponsored /verify (ephemeral runner +
    // risk screen) rather than declaring the lanes unavailable — while
    // still warning that an external author's report is adversarial input.
    expect(section).toContain('The author lacks write access');
    expect(section).toContain('sponsored run');
    // The controls, not a machine: external runs share the persistent pool
    // with everyone else, so the guidance must name what actually bounds
    // them. An "ephemeral runner" claim here would be describing a design
    // that no longer exists.
    expect(section).toContain('risk screen');
    expect(section).toContain('full workspace wipe');
    expect(section).not.toContain('ephemeral');
    expect(section).toContain('same skepticism as the fork');
    expect(section).not.toContain('sandboxed lanes are unavailable');

    // The assembly order is the other half: a section nothing assembles is
    // as dead as one nobody reads.
    const order = prSkill.slice(
      prSkill.indexOf('Post a single Stage 2 comment'),
      prSkill.indexOf('### Stage 3'),
    );
    expect(order).toContain('(2b-bis)');
    expect(order).toContain('not an enrichment');
  });

  it('makes the not-verified sentence a mechanical 2b-bis trigger', () => {
    // Post-merge measurement of #7917 (2026-07-29): 9 eligible PRs, two
    // considered-and-declined mentions, zero positive recommendations — and
    // the one clear behavioural candidate (#7947, bounded reads) wrote
    // "author tested on macOS only" in its own Stage 2 comment and never
    // named a lane. The judgement-based rule ("when 2b cannot settle it")
    // failed exactly where the comment had already written the gap down. So
    // the trigger is now textual: the draft's own admission is the trigger,
    // and pending CI does not lift it.
    const section = prSkill
      .slice(
        prSkill.indexOf('#### 2b-bis.'),
        prSkill.indexOf('#### 2c. Real-Scenario'),
      )
      .replace(/\s+/g, ' ');
    expect(section).toContain('mechanical, not a judgement call');
    expect(section).toContain('grep your own draft');
    // The trigger phrases are the ones real comments actually emit — the
    // first two are verbatim from #7947's and #7951's Stage 2 comments.
    expect(section).toContain('not verified');
    expect(section).toContain('author tested on <one platform> only');
    expect(section).toContain('not independently re-run');
    // Pending CI must not lift the trigger: #7947's likely out was "the
    // ubuntu Test job is still in progress".
    expect(section).toContain('"CI is still running" does not lift');
    // The mechanical rule must sit BEFORE the skip cases, or the skip cases
    // read as outs from it rather than the other way around.
    expect(section.indexOf('mechanical, not a judgement call')).toBeLessThan(
      section.indexOf('Skip it — explicitly'),
    );
    // And the skip cases themselves must survive — the trigger tightens the
    // rule, it does not replace the two legitimate outs.
    expect(section).toContain('No behavioural claim to settle');
    expect(section).toContain('The author lacks write access');
  });

  it('names /verify on the high-risk paths, not just tmux', () => {
    // 1e is the strongest triage-time signal in the skill (10 of 31 reverted
    // PRs touched these paths vs 5 of 60 controls, p = 0.006) — and it used
    // to recommend tmux alone, pointing at the local-only 2c. So the PRs
    // most likely to be reverted were the ones never offered the lane that
    // proves a change is load-bearing.
    const highRisk = prSkill.slice(
      prSkill.indexOf('If any file matches (the strongest triage-time signal'),
      prSkill.indexOf('This signal is NOT a terminal gate'),
    );
    expect(highRisk).toContain('@qwen-code /verify');
    expect(highRisk).toContain('2b-bis');
    // The dead pointer into the local-only section must not come back.
    expect(highRisk).not.toContain('Stage 2c');
  });

  it('scopes the approve-skip check to the bot own approval on the reviewed commit', () => {
    // A maintainer approved a PR three minutes before re-triggering /triage.
    // The agent read that human approval as "existing approval from prior run
    // still valid", skipped its own approve, and reported 5/5 Approved — the
    // PR sat at 1 of the 2 required approvals with nothing marked wrong. The
    // skip is worth keeping (three re-runs must not stack three approvals),
    // but all three filters are load-bearing: login (another account's vote is
    // not the bot's), state (a DISMISSED review is not an approval), and
    // commit (dismiss_stale_reviews voids the bot's own on every push).
    const section = prSkill.slice(
      prSkill.indexOf('**Approve once per commit'),
      prSkill.indexOf("Only approve when you're genuinely confident"),
    );
    expect(section).toContain('.user.login == $bot');
    expect(section).toContain('.state == "APPROVED"');
    expect(section).toContain('.commit_id == $sha');
    expect(section).toContain('--paginate');
    expect(section).toContain('DISMISSED');

    // The terminal-gate probe shares the same failure mode: an unpaginated
    // read sees only the first 30 reviews, and re-runs land on exactly the
    // heavily-reviewed PRs where the gating review sits on a later page.
    const terminalGate = prSkill.slice(
      prSkill.indexOf('Never create duplicates'),
      prSkill.indexOf('**Signature & footer:**'),
    );
    expect(terminalGate).toContain('--paginate');
    expect(terminalGate).toContain('.state == "CHANGES_REQUESTED"');
    expect(terminalGate).not.toContain("--jq '[.[] | select");
  });

  it.skipIf(spawnSync('jq', ['--version']).status !== 0)(
    'warns when a triage re-run leaves the bot with no review on the head commit',
    () => {
      const notifyStep = step('Notify silent triage re-run');
      const body = notifyStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
      expect(body).toBeTruthy();
      const script = body.replace(/^ {10}/gm, '');

      const REVIEWS = {
        // The observed case: the bot's approval was dismissed by a push, its
        // only review on the head commit is a /review downgrade to COMMENTED,
        // and the sole APPROVED on that commit belongs to a maintainer.
        humanOnly: [
          { user: { login: 'bot' }, state: 'DISMISSED', commit_id: 'old' },
          { user: { login: 'bot' }, state: 'COMMENTED', commit_id: 'head' },
          {
            user: { login: 'human' },
            state: 'APPROVED',
            submitted_at: '2026-01-01T00:00:00Z',
            commit_id: 'head',
          },
        ],
        ownApproval: [
          { user: { login: 'bot' }, state: 'APPROVED', commit_id: 'head' },
          { user: { login: 'human' }, state: 'APPROVED', commit_id: 'head' },
        ],
        postedNow: [
          {
            user: { login: 'bot' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2030-01-01T00:00:00Z',
            commit_id: 'head',
          },
        ],
        botNone: [
          {
            user: { login: 'human' },
            state: 'APPROVED',
            submitted_at: '2026-01-01T00:00:00Z',
            commit_id: 'head',
          },
        ],
      };

      const run = (reviews, head) => {
        const dir = mkdtempSync(join(tmpdir(), 'triage-notify-'));
        try {
          const bin = join(dir, 'bin');
          mkdirSync(bin, { recursive: true });
          writeFileSync(join(dir, 'reviews.json'), JSON.stringify(reviews));
          // Stand-in for `gh`: serves the PR state, the review list and
          // the head SHA, and
          // captures the comment body the step would have posted.
          writeFileSync(
            join(bin, 'gh'),
            [
              '#!/usr/bin/env bash',
              'case "$*" in',
              `  "api user --jq .login") echo bot ;;`,
              `  "pr view 1 --repo QwenLM/qwen-code --json state,closedAt") echo '{"state":"OPEN","closedAt":null}' ;;`,
              `  *"/pulls/1/reviews"*) cat "${join(dir, 'reviews.json')}" ;;`,
              `  *"/pulls/1 --jq .head.sha") [ -n "$FAKE_HEAD" ] && echo "$FAKE_HEAD" || exit 1 ;;`,
              `  *"/issues/1/comments"*)`,
              `    for a in "$@"; do case "$a" in body=*) printf '%s' "\${a#body=}" > "${join(dir, 'comment.txt')}" ;; esac; done`,
              `    echo '{}' ;;`,
              '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
              'esac',
            ].join('\n'),
            { mode: 0o755 },
          );
          const proc = spawnSync('bash', ['-c', script], {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              GITHUB_REPOSITORY: 'QwenLM/qwen-code',
              NUMBER: '1',
              TRIGGERED_AT: '2026-01-02T00:00:00Z',
              RUN_URL: 'https://example.invalid/run',
              FAKE_HEAD: head,
            },
            encoding: 'utf8',
          });
          let comment = '';
          try {
            comment = readFileSync(join(dir, 'comment.txt'), 'utf8');
          } catch {
            comment = '';
          }
          return {
            status: proc.status,
            log: `${proc.stdout}${proc.stderr}`,
            comment,
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };

      // The silent skip must surface as a warning AND in the posted comment.
      const humanOnly = run(REVIEWS.humanOnly, 'head');
      expect(humanOnly.status).toBe(0);
      expect(humanOnly.log).toContain('Triage re-run left no bot review');
      // Wording fixed: the bot DOES have a review here — a COMMENTED one,
      // visible on the page — it just carries no vote. "No review of its own"
      // told a reader the opposite of what they could see. The warning stays:
      // from the reviews API this state is indistinguishable from a deliberate
      // 3/5 defer, and both mean the PR is one approval short.
      expect(humanOnly.comment).toContain('carries no vote');
      expect(humanOnly.comment).not.toContain('no review of its own');
      expect(humanOnly.comment).toContain('does not count as the bot');

      // The bot's own approval standing on the head commit is the benign case.
      const ownApproval = run(REVIEWS.ownApproval, 'head');
      expect(ownApproval.status).toBe(0);
      expect(ownApproval.log).not.toContain('Triage re-run left no bot review');
      expect(ownApproval.comment).toContain('review of its own');
      expect(ownApproval.comment).toContain('still stands');

      // A review posted by this very re-run short-circuits before commenting.
      const postedNow = run(REVIEWS.postedNow, 'head');
      expect(postedNow.status).toBe(0);
      expect(postedNow.log).toContain('no summary comment needed');
      expect(postedNow.comment).toBe('');

      // A true none: the bot has no review at all on the head commit.
      // This exercises the none) arm's bash, which the humanOnly fixture
      // no longer reaches after its reclassification to deferred.
      const botNone = run(REVIEWS.botNone, 'head');
      expect(botNone.status).toBe(0);
      expect(botNone.log).toContain('Triage re-run left no bot review');
      expect(botNone.comment).toContain('neither a verdict nor a deferral');

      // An unreadable head SHA must not masquerade as either verdict.
      const noHead = run(REVIEWS.humanOnly, '');
      expect(noHead.status).toBe(0);
      expect(noHead.log).not.toContain('Triage re-run left no bot review');
      expect(noHead.comment).toContain('could not be read');
    },
  );

  // A Stage 1-pre duplicate-close exit leaves no review at all, and the
  // review-list check above cannot tell it apart from a re-run that did
  // nothing: it announced "completed without a new review ... it did not"
  // on the PR the same run just closed, and the ::warning dispatched a
  // human to a correctly-handled run. The close IS the terminal action:
  // the step must read the PR's own state and exit quietly. A close BEFORE
  // the trigger keeps the old behaviour — that run still owes its summary.
  it.skipIf(spawnSync('jq', ['--version']).status !== 0)(
    'exits quietly when the PR was closed at/after the trigger comment',
    () => {
      const notifyStep = step('Notify silent triage re-run');
      // The exemption reads the PR itself, not only the review list.
      expect(notifyStep).toContain(
        'gh pr view "$NUMBER" --repo "$GITHUB_REPOSITORY" --json state,closedAt',
      );
      const body = notifyStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
      expect(body).toBeTruthy();
      const script = body.replace(/^ {10}/gm, '');

      const run = (prState, reviews = []) => {
        const dir = mkdtempSync(join(tmpdir(), 'triage-close-exit-'));
        try {
          const bin = join(dir, 'bin');
          mkdirSync(bin, { recursive: true });
          writeFileSync(join(dir, 'pr-state.json'), JSON.stringify(prState));
          writeFileSync(join(dir, 'reviews.json'), JSON.stringify(reviews));
          // Stand-in for `gh`: serves the PR state, an (empty) review list
          // and the head SHA, and captures the comment body the step would
          // have posted.
          writeFileSync(
            join(bin, 'gh'),
            [
              '#!/usr/bin/env bash',
              'case "$*" in',
              `  "api user --jq .login") echo bot ;;`,
              `  "pr view 1 --repo QwenLM/qwen-code --json state,closedAt") cat "${join(dir, 'pr-state.json')}" ;;`,
              `  *"/pulls/1/reviews"*) cat "${join(dir, 'reviews.json')}" ;;`,
              `  *"/pulls/1 --jq .head.sha") echo head ;;`,
              `  *"/issues/1/comments"*)`,
              `    for a in "$@"; do case "$a" in body=*) printf '%s' "\${a#body=}" > "${join(dir, 'comment.txt')}" ;; esac; done`,
              `    echo '{}' ;;`,
              '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
              'esac',
            ].join('\n'),
            { mode: 0o755 },
          );
          const proc = spawnSync('bash', ['-c', script], {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              GITHUB_REPOSITORY: 'QwenLM/qwen-code',
              NUMBER: '1',
              TRIGGERED_AT: '2026-01-02T00:00:00Z',
              RUN_URL: 'https://example.invalid/run',
            },
            encoding: 'utf8',
          });
          let comment = '';
          try {
            comment = readFileSync(join(dir, 'comment.txt'), 'utf8');
          } catch {
            comment = '';
          }
          return {
            status: proc.status,
            log: `${proc.stdout}${proc.stderr}`,
            comment,
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };

      // The close-exit shape: closed after the trigger, no review left.
      // Neither the summary comment nor the warning may fire.
      const closeExit = run({
        state: 'CLOSED',
        closedAt: '2026-01-03T00:00:00Z',
      });
      expect(closeExit.status).toBe(0);
      expect(closeExit.comment).toBe('');
      expect(closeExit.log).not.toContain('Triage re-run left no bot review');
      expect(closeExit.log).toContain('no re-run summary needed');

      // The boundary: a close BEFORE the trigger comment is not this run's
      // terminal action, so the old notify behaviour stays intact.
      const closedBefore = run({
        state: 'CLOSED',
        closedAt: '2026-01-01T00:00:00Z',
      });
      expect(closedBefore.status).toBe(0);
      expect(closedBefore.log).toContain('Triage re-run left no bot review');
      expect(closedBefore.comment).toContain(
        '<!-- qwen-triage stage=rerun-summary -->',
      );
    },
  );

  it('includes high-risk path detection in the triage skill', () => {
    expect(prSkill).toContain('1e. High-risk path');
    expect(prSkill).toContain('openaiContentGenerator');
    expect(prSkill).toContain('streamingToolCallParser');
    expect(prSkill).toContain('geminiChat');
    expect(prSkill).toContain('acpConnection');
    expect(prSkill).toContain('(^|/)shell\\.ts$');
    expect(prSkill).toContain('shellExecutionService');
    expect(prSkill).toContain('mcp-client');
    expect(prSkill).toContain('mcp-pool');
    expect(prSkill).toContain('LspServer');
    expect(prSkill).toContain('acp-integration');
    expect(prSkill).toContain('(^|/)relaunch\\.ts$');
    expect(prSkill).toContain('(^|/)sandbox\\.ts$');
    expect(prSkill).toContain('electron-run-as-node');
    expect(prSkill).toContain('p = 0.006');
    expect(prSkill).toContain('do not skip any Stage 2 enrichment');
    expect(prSkill).toContain('gh api --paginate');
    expect(prSkill).toContain('|| true');
    expect(prSkill).toContain('WARNING: could not fetch PR files');
  });

  it('includes Risk field in the Stage 1 comment template', () => {
    expect(prSkill).toContain('Risk: <if Stage 1e matched');
  });
});

describe('qwen-triage verify workflow', () => {
  // Replay the authorize principal gate with a stubbed gh: /verify must
  // require write from BOTH the PR author (whose code executes) and the
  // commenter (who spends the runner slot + model budget). A refactor that
  // drops the /verify patterns from the case statement falls back to
  // commenter-only gating, which this catches via the author-without-write
  // arm; dropping the commenter check is caught by the drive-by arm.
  it('classifies /verify trust by author and gates on the commenter', () => {
    // The commenter GATES (they spend the runner slot and model budget);
    // the author's permission sets a TRUST LEVEL. Both run on the
    // persistent pool (maintainer decision), so the level selects the
    // extra controls an external run gets: pinned head OID, risk screen,
    // workspace wipe. Every lookup failure denies: a request that cannot
    // be classified must not pick a trust level.
    const permStep = step('Check principal write permission');
    const body = permStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
    expect(body).toBeTruthy();
    const script = body.replace(/^ {10}/gm, '');

    const dir = mkdtempSync(join(tmpdir(), 'verify-auth-'));
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = pr ]; then',
        '  # gh pr view <n> ... --json headRefOid: the sponsorship snapshot.',
        '  [ "$3" = "99" ] && exit 1',
        '  echo deadbeefcafe',
        '  exit 0',
        'fi',
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
    const gate = (
      commentBody,
      author,
      commenter,
      issueNumber = '1',
      isPr = 'true',
    ) => {
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
          ISSUE_NUMBER: issueNumber,
          IS_PR: isPr,
          TMUX_PR: '',
        },
        encoding: 'utf8',
      });
      const lines = readFileSync(out, 'utf8').trim().split('\n');
      const val = (k) =>
        lines
          .filter((l) => l.startsWith(`${k}=`))
          .pop()
          ?.slice(k.length + 1);
      return {
        run: val('should_run'),
        trust: val('verify_trust'),
        oid: val('verify_head_oid'),
        lane: val('verify_lane'),
      };
    };

    try {
      // Drive-by commenter without write cannot spend the sandbox budget,
      // whoever the author is.
      expect(gate('@qwen-code /verify', 'alice', 'mallory').run).toBe('false');
      // Write-access author -> trusted, no snapshot needed.
      const trusted = gate('@qwen-code /verify', 'alice', 'bob');
      expect(trusted.run).toBe('true');
      expect(trusted.trust).toBe('trusted');
      expect(trusted.oid).toBeUndefined();
      // EXTERNAL author + trusted commenter -> allowed as a sponsored run
      // with the head OID snapped now. This is the case that used to deny.
      const sponsored = gate('@qwen-code /verify', 'mallory', 'bob');
      expect(sponsored.run).toBe('true');
      expect(sponsored.trust).toBe('external');
      expect(sponsored.oid).toBe('deadbeefcafe');
      // Author commenting on their own PR is still trusted.
      expect(gate('@qwen-code /verify', 'alice', 'alice').trust).toBe(
        'trusted',
      );
      // Author permission unreadable -> deny; routing must not guess.
      expect(gate('@qwen-code /verify', 'charlie', 'bob').run).toBe('false');
      // Deleted author (empty login) -> deny, same reason.
      expect(gate('@qwen-code /verify', '', 'bob').run).toBe('false');
      // Head OID snapshot failure -> deny: a sponsored run without a
      // pinned head would execute whatever gets pushed next.
      expect(gate('@qwen-code /verify', 'mallory', 'bob', '99').run).toBe(
        'false',
      );
      // /tmux keeps its author-only gate; /triage keeps the commenter gate.
      expect(gate('@qwen-code /tmux', 'alice', 'mallory').run).toBe('true');
      expect(gate('@qwen-code /tmux', 'mallory', 'bob').run).toBe('false');
      expect(gate('@qwen-code /triage', 'mallory', 'bob').run).toBe('true');

      // /triage on a PR ALSO starts the verify lane, in parallel — and the
      // point of routing it through the same classifier is that an external
      // author still gets the external control set. If this ever emits
      // `trusted` (or no trust at all) for `mallory`, the head-OID pin, the
      // risk screen and both workspace wipes silently stop firing while the
      // lane keeps executing that author's code on the persistent pool.
      const triagePr = gate('@qwen-code /triage', 'mallory', 'bob');
      expect(triagePr.run).toBe('true');
      expect(triagePr.lane).toBe('true');
      expect(triagePr.trust).toBe('external');
      expect(triagePr.oid).toBe('deadbeefcafe');
      expect(gate('@qwen-code /triage', 'alice', 'bob').trust).toBe('trusted');

      // The lane fails closed DIFFERENTLY from an explicit /verify. An
      // unreadable author permission denies `/verify` outright, because the
      // commenter asked for exactly that; on `/triage` it must only close
      // the lane, or a flaky permission API silently costs the reviewer
      // their triage too. Same for a failed head-OID snapshot (issue 99).
      const laneFail = gate('@qwen-code /triage', 'charlie', 'bob');
      expect(laneFail.run).toBe('true');
      expect(laneFail.lane).toBe('false');
      expect(laneFail.trust).toBeUndefined();
      const oidFail = gate('@qwen-code /triage', 'mallory', 'bob', '99');
      expect(oidFail.run).toBe('true');
      expect(oidFail.lane).toBe('false');
      expect(gate('@qwen-code /verify', 'charlie', 'bob').run).toBe('false');

      // On a plain ISSUE there is nothing to build, so the lane stays off
      // and no author lookup is spent. This assertion used to be written as
      // "/triage emits no trust outputs" with a fixture that never set
      // IS_PR — true for the wrong reason, and it would have stayed green
      // through the change above.
      const triageIssue = gate('@qwen-code /triage', 'mallory', 'bob', '1', '');
      expect(triageIssue.run).toBe('true');
      expect(triageIssue.lane).toBeUndefined();
      expect(triageIssue.trust).toBeUndefined();
      expect(triageIssue.oid).toBeUndefined();

      const tmux = gate('@qwen-code /tmux', 'alice', 'bob');
      expect(tmux.trust).toBeUndefined();
      expect(tmux.oid).toBeUndefined();
      expect(tmux.lane).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    // Uploaded artifacts must not carry node-planted symlinks (or FIFOs/
    // sockets/devices, which can hang or redirect the collection):
    // actions/upload-artifact dereferences symlinks.
    expect(runStep).toContain(
      'find "$RUNNER_TEMP/verify-results" \\( -type l -o -type p -o -type s -o -type b -o -type c \\) -delete',
    );
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

  // The lane trigger was unpinned: deleting the gate from the verify job's
  // `if` left every assertion green while the job became reachable from any
  // comment on any open PR. Measured as a mutation before this test existed.
  //
  // `verify_lane` is also the single source of truth for WHICH comments
  // start the lane. Re-enumerating the command strings in the job predicate
  // is what let the trigger and the trust classification drift apart — the
  // classifier keyed on `/verify` while the predicate would have keyed on
  // `/verify` or `/triage`, so a `/triage`-started run would have executed
  // an external author's code with `verify_trust` empty and all four
  // external-only controls (head-OID pin, risk screen, both wipes) skipped.
  it('gates the verify lane on authorize alone, not on re-matched commands', () => {
    // Slice the two predicates APART. Asserting over the whole job text
    // cannot tell them apart: the first version of this test did exactly
    // that, and deleting the gate from `if:` still matched the copy inside
    // `concurrency:` — the mutation survived its own regression test.
    const raw = job('verify');
    const ifBlock = raw.slice(
      raw.indexOf('if: >-'),
      raw.indexOf('concurrency:'),
    );
    const concBlock = raw.slice(
      raw.indexOf('concurrency:'),
      raw.indexOf('timeout-minutes:'),
    );
    expect(ifBlock).toBeTruthy();
    expect(concBlock).toBeTruthy();
    for (const predicate of [ifBlock, concBlock]) {
      expect(predicate).toContain(
        "needs.authorize.outputs.verify_lane == 'true'",
      );
    }
    // Concurrency is evaluated after `needs`, so it can and must read the
    // same output; an unguarded group would let non-runnable triggers share
    // the per-PR group and cancel a real run.
    expect(ifBlock).not.toContain("comment.body == '@qwen-code /verify'");
    expect(concBlock).not.toContain("comment.body == '@qwen-code /verify'");

    // And the authorize job has to actually publish it.
    expect(job('authorize')).toContain(
      "verify_lane: '${{ steps.perm.outputs.verify_lane }}'",
    );
  });

  // Positive control for the mutations above: a guard this suite is known
  // to pin, asserted per predicate. Written first as one `toContain` over
  // the whole job, it survived its own mutation — the copy in
  // `concurrency:` matched after the `if:` copy was deleted, which is the
  // same coarse-assertion defect the test above documents. A control that
  // cannot fail proves nothing about the assertions it vouches for.
  it('pins the ECS kill switch on both verify predicates (control)', () => {
    const raw = job('verify');
    const ifBlock = raw.slice(
      raw.indexOf('if: >-'),
      raw.indexOf('concurrency:'),
    );
    const concBlock = raw.slice(
      raw.indexOf('concurrency:'),
      raw.indexOf('timeout-minutes:'),
    );
    expect(ifBlock).toContain("vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true'");
    expect(concBlock).toContain(
      "vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true'",
    );
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
  // looking, permanently silent. Every step that answers a /verify request
  // carries the same guard.
  // With external code on the PERSISTENT pool, the wipe replaces machine
  // destruction as the deny-by-default control — so it must run, must run
  // BEFORE the checkout that brings PR code in, and must fail the job
  // rather than proceed on a workspace it could not clear.
  it('wipes the workspace before external code, ahead of checkout', () => {
    const verifyJob = job('verify');
    // Both trust levels share one machine class now; nothing routes.
    expect(verifyJob).toContain(
      "runs-on: ['self-hosted', 'linux', 'x64', 'ecs-qwen']",
    );
    expect(verifyJob).not.toContain('ubuntu-latest');

    const wipe = stepIn('verify', 'Wipe workspace before external code');
    expect(wipe).not.toBe('');
    // Gated on the trust level, not on everything: a trusted run keeps the
    // warm workspace it has always had.
    expect(wipe).toContain(
      "needs.authorize.outputs.verify_trust == 'external'",
    );
    // Ordering is the whole point — after checkout it would delete the
    // code under test instead of the previous run's leftovers.
    expect(
      verifyJob.indexOf('Wipe workspace before external code'),
    ).toBeLessThan(verifyJob.indexOf('Checkout PR merge ref'));
    // Fails the job when the workspace is not actually empty afterwards.
    expect(wipe).toContain('refusing to execute external code on it');
    expect(wipe).toContain('exit 1');
    // The ported guard layers (#9265) — see the post-run wipe test for
    // what each pin catches.
    expect(wipe).toContain('realpath -m');
    expect(wipe).toContain('realpath -m -- "$RWS"');
    expect(wipe).toContain('RUNNER_WORKSPACE:?');
    expect(wipe).toContain('"$RWS"/*');
    // RWS-side layers: the '..' arm and the degenerate-root refusal that
    // keeps a stripped-empty runner workspace from degenerating the
    // allowlist pattern to `/*`.
    expect(wipe).toContain("refusing runner workspace path containing '..'");
    expect(wipe).toContain('runner workspace resolved to /');
  });

  it('carries the symlink heal in both wipes, ordered and bounded (#9480)', () => {
    // The guard's own wedge: a workspace replaced by a symlink resolves to
    // its target, the allowlist refuses, and the refusal removes nothing —
    // so the runner dies here on every later job. The heal must therefore
    // run BEFORE canonicalization, AFTER the allowlist root that bounds it,
    // and after the raw trailing-slash strip, since both of its predicates
    // resolve through a link when the path ends in '/'.
    for (const stepName of [
      'Wipe workspace before external code',
      'Wipe workspace after external code',
    ]) {
      const run = stepIn('verify', stepName);
      const healAt = run.indexOf('[ -L "$WS" ] || [ ! -d "$WS" ]');
      expect(healAt, `${stepName} has no heal`).toBeGreaterThan(-1);
      expect(healAt).toBeLessThan(run.indexOf('realpath -m -- "$WS"'));
      expect(run.indexOf('RWS="${RUNNER_WORKSPACE:?}"')).toBeLessThan(healAt);
      expect(run.indexOf('while [ "${WS%/}" != "$WS" ]')).toBeLessThan(healAt);
      // Containment on the canonical PARENT — resolving $WS would follow
      // the very link being removed, and a raw match cannot see
      // intermediate symlink components.
      expect(run).toContain(
        'HEAL_PARENT="$(realpath -m -- "$(dirname -- "$WS")" 2>/dev/null)"',
      );
      expect(run).toContain('"$RWS"|"$RWS"/*)');
      expect(run).toContain('refusing to heal workspace outside');
      // Both legs fail closed, and the incident leaves a trace.
      expect(run).toContain('rm -f -- "$WS" || {');
      expect(run).toContain('mkdir -- "$WS" || {');
      expect(run).toContain('::warning::healing workspace');
    }
  });

  // The wipe is the deny-by-default control, so run the real step text
  // against a workspace carrying the vectors the allowlist sweep is built
  // to enumerate — plus one it is not — and require every one to be gone.
  it.skipIf(!hasGnuRealpath)(
    'removes planted persistence vectors, known and unknown',
    () => {
      const wipe = stepIn('verify', 'Wipe workspace before external code')
        .match(/run: \|-\n([\s\S]*)$/)?.[1]
        .replace(/^ {10}/gm, '');
      expect(wipe).toBeTruthy();

      const dir = mkdtempSync(join(tmpdir(), 'verify-wipe-'));
      try {
        const ws = join(dir, 'workspace');
        mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
        // Vectors the sweep enumerates...
        writeFileSync(
          join(ws, '.git', 'hooks', 'pre-commit'),
          '#!/bin/sh\nid\n',
        );
        writeFileSync(
          join(ws, '.git', 'config.worktree'),
          '[core]\n\thooksPath = /\n',
        );
        // ...and ones it does not: a dotfile the next npm run would read,
        // and an ordinary file. Deny-by-default has to take all of them.
        writeFileSync(join(ws, '.npmrc'), 'script-shell=/tmp/evil\n');
        writeFileSync(join(ws, 'package.json'), '{}');
        mkdirSync(join(ws, 'node_modules'), { recursive: true });

        // GitHub Actions runs `shell: bash` steps with `-eo pipefail`,
        // so the battery must too: bare `bash -c` masks a failing
        // sweep command into a green test (probed with a failing `find`
        // stub on PATH: exit 0 here, exit 1 under the real step flags).
        const res = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipe], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_WORKSPACE: ws,
            // The ported guard allowlists against the runner workspace
            // (#9265): the test workspace must sit inside it.
            RUNNER_WORKSPACE: dir,
            GITHUB_STEP_SUMMARY: join(dir, 'summary'),
          },
        });
        expect(res.status).toBe(0);
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // The guard has to be exercised with the REAL dangerous paths — that is
  // the whole point of it — but a test that passes `/` to a live `rm -rf`
  // is only safe while the guard exists. Written that way it detonates on
  // the developer's machine the moment anyone removes the guard, which is
  // exactly when the test is supposed to protect them. (It did: a mutation
  // run that deleted the guard spent six minutes attempting to delete `/`
  // before it was killed. macOS permissions absorbed it; nothing was lost,
  // and nothing about that outcome was by design.)
  //
  // So `rm` is stubbed to a recorder on PATH. The destructive primitive
  // cannot fire here under ANY edit, and the assertion is on the decision
  // rather than on filesystem effects: with the guard gone the recorder
  // shows an attempted delete and the test fails, having deleted nothing.
  it('refuses a suspicious workspace path without invoking rm', () => {
    const wipe = stepIn('verify', 'Wipe workspace before external code')
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    expect(wipe).toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'verify-wipe-guard-'));
    try {
      const calls = join(dir, 'rm-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'rm'),
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$*" >> "$RM_CALLS"',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );

      // The second half are the spellings the ported guard layers exist
      // for (#9265): the kernel resolves each of them to a guarded root,
      // yet the bare denylist they faced before let every one through
      // (measured on main in the issue). `/tmp` and `/opt` are refused by
      // the allowlist alone — the denylist has no arm for them.
      for (const bad of [
        '/',
        '/usr',
        '/etc',
        '/var',
        '/root',
        '/home',
        '',
        '/home/',
        '/root/',
        '/var/',
        '//',
        '/home//',
        '/home/.',
        '/home/..',
        '//usr',
        '//home',
        '/tmp',
        '/opt',
      ]) {
        writeFileSync(calls, '');
        const guard = spawnSync('bash', ['-c', wipe], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            RM_CALLS: calls,
            GITHUB_WORKSPACE: bad,
            // The recorder dir doubles as the allowlist root: every bad
            // path sits outside it, so the refusal is the guard's, not a
            // side effect of the fixture layout.
            RUNNER_WORKSPACE: dir,
            GITHUB_STEP_SUMMARY: join(dir, 'summary'),
          },
        });
        // Non-zero, not exactly 1: several mechanisms refuse here — the
        // `case` exits 1 for a named root, an empty path never reaches it
        // because `${GITHUB_WORKSPACE:?}` aborts the shell first (127),
        // and the allowlist exits 1 for everything outside the runner
        // workspace. Which one fires depends on the host's realpath.
        expect(
          guard.status,
          `path ${bad || '<empty>'} was not refused`,
        ).not.toBe(0);
        // The load-bearing assertion: no delete was even attempted.
        expect(
          readFileSync(calls, 'utf8'),
          `rm was invoked for ${bad || '<empty>'}`,
        ).toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The canonicalization layer needs its own pin: every bad path above
  // sits OUTSIDE the recorder dir, so the allowlist refuses them
  // identically whether `realpath -m` ran or not — deleting that line
  // ships green against the battery. A raw '..' spelling does not pin it
  // either: the '..' case arm refuses that vector first, mutant or not.
  // What does pin it is a path whose INTERMEDIATE component leaves the
  // runner workspace: it matches "$RWS"/* as a string and names a
  // directory outside it, so with the line deleted find resolves the link
  // through the kernel and hands that directory's entries to the rm
  // recorder. It is deliberately a directory at the far end rather than
  // the link itself — a workspace that IS a link is now healed rather
  // than refused (#9480), and this test exists for the refusal.
  const extractRun = (stepName) => {
    const run = stepIn('verify', stepName)
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    expect(run, `run block for ${stepName}`).toBeTruthy();
    return run;
  };

  it.skipIf(!hasGnuRealpath)(
    'refuses an allowlist-escaping path reached through an intermediate symlink',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'verify-wipe-escape-'));
      const outside = mkdtempSync(join(tmpdir(), 'verify-wipe-outside-'));
      mkdirSync(join(outside, 'sub'));
      writeFileSync(join(outside, 'sub', 'canary'), 'x');
      symlinkSync(outside, join(dir, 'link'));
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );

        for (const stepName of [
          'Wipe workspace before external code',
          'Wipe workspace after external code',
        ]) {
          writeFileSync(calls, '');
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH}`,
                GITHUB_WORKSPACE: join(dir, 'link', 'sub'),
                RUNNER_WORKSPACE: dir,
                GITHUB_STEP_SUMMARY: join(dir, 'summary'),
              },
            },
          );
          expect(res.status, `${stepName} did not refuse`).not.toBe(0);
          expect(res.stdout + res.stderr).toContain(
            'outside the runner workspace',
          );
          expect(
            readFileSync(calls, 'utf8'),
            `${stepName} invoked rm on the escaping path`,
          ).toBe('');
          expect(readdirSync(join(outside, 'sub'))).toEqual(['canary']);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  // The wedge the guard itself created, and the hole the first attempt at
  // healing it shipped. Both wipes carry the same layer, so both are driven.
  const WIPE_STEPS = [
    'Wipe workspace before external code',
    'Wipe workspace after external code',
  ];

  it.skipIf(!hasGnuRealpath)(
    'heals a workspace a previous job replaced with a symlink',
    () => {
      // Without the heal this is permanent: canonicalization resolves the
      // link to its target, the allowlist refuses, the step exits 1 having
      // removed nothing, and every later job on the runner dies at the same
      // line. The unlink must take the LINK and leave the target alone —
      // which is also what pins the heal judging the canonical PARENT
      // rather than $WS itself, since resolving $WS follows the very link
      // being removed and would refuse a repair that must succeed.
      for (const stepName of WIPE_STEPS) {
        const parent = mkdtempSync(join(tmpdir(), 'verify-heal-'));
        const outside = mkdtempSync(join(tmpdir(), 'verify-heal-outside-'));
        const ws = join(parent, 'workspace');
        writeFileSync(join(outside, 'canary'), 'x');
        symlinkSync(outside, ws);
        try {
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_WORKSPACE: ws,
                RUNNER_WORKSPACE: parent,
                GITHUB_STEP_SUMMARY: join(parent, 'summary'),
              },
            },
          );
          expect(res.status, `${stepName}: ${res.stdout}${res.stderr}`).toBe(0);
          expect(res.stdout + res.stderr).toContain('healing workspace');
          expect(res.stdout + res.stderr).toContain(outside);
          expect(lstatSync(ws).isSymbolicLink()).toBe(false);
          expect(readdirSync(ws)).toEqual([]);
          expect(readdirSync(outside)).toEqual(['canary']);
        } finally {
          rmSync(parent, { recursive: true, force: true });
          rmSync(outside, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'refuses to heal through an intermediate symlink, before touching anything',
    () => {
      // The defect the first attempt kept through three rounds: it matched
      // the RAW path, and `$RWS/link/sub` matches "$RWS"/* as a string while
      // naming a file outside the runner workspace — so the unlink and the
      // mkdir landed OUTSIDE, and only then did the allowlist refuse.
      for (const stepName of WIPE_STEPS) {
        const parent = mkdtempSync(join(tmpdir(), 'verify-heal-inter-'));
        const outside = mkdtempSync(join(tmpdir(), 'verify-heal-outside-'));
        writeFileSync(join(outside, 'sub'), 'canary');
        symlinkSync(outside, join(parent, 'link'));
        try {
          const calls = join(parent, 'rm-calls');
          writeFileSync(calls, '');
          writeFileSync(
            join(parent, 'rm'),
            `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
            { mode: 0o755 },
          );
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                PATH: `${parent}:${process.env.PATH}`,
                GITHUB_WORKSPACE: join(parent, 'link', 'sub'),
                RUNNER_WORKSPACE: parent,
                GITHUB_STEP_SUMMARY: join(parent, 'summary'),
              },
            },
          );
          expect(res.status, stepName).not.toBe(0);
          expect(res.stdout + res.stderr).toContain(
            'refusing to heal workspace outside the runner workspace',
          );
          expect(readFileSync(calls, 'utf8')).toBe('');
          // The mutation the old shape performed before refusing: the file
          // at the resolved target is still a file, with its contents.
          expect(lstatSync(join(outside, 'sub')).isFile()).toBe(true);
          expect(readFileSync(join(outside, 'sub'), 'utf8')).toBe('canary');
        } finally {
          rmSync(parent, { recursive: true, force: true });
          rmSync(outside, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'heals a non-directory workspace, and sees it through a trailing slash',
    () => {
      // The `|| [ ! -d "$WS" ]` half, and the raw strip that has to precede
      // both predicates: `[ -L "$WS/" ]` is false and `[ ! -d "$WS/" ]`
      // resolves through the link, so one trailing slash hides the
      // corruption entirely.
      for (const stepName of WIPE_STEPS) {
        const parent = mkdtempSync(join(tmpdir(), 'verify-heal-file-'));
        const ws = join(parent, 'workspace');
        writeFileSync(ws, 'not a directory');
        try {
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_WORKSPACE: ws,
                RUNNER_WORKSPACE: parent,
                GITHUB_STEP_SUMMARY: join(parent, 'summary'),
              },
            },
          );
          expect(res.status, `${stepName}: ${res.stdout}${res.stderr}`).toBe(0);
          expect(res.stdout + res.stderr).toContain('it was not a directory');
          expect(lstatSync(ws).isDirectory()).toBe(true);
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }

        const linkParent = mkdtempSync(join(tmpdir(), 'verify-heal-slash-'));
        const outside = mkdtempSync(join(tmpdir(), 'verify-heal-outside-'));
        const linkWs = join(linkParent, 'workspace');
        writeFileSync(join(outside, 'canary'), 'x');
        symlinkSync(outside, linkWs);
        try {
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_WORKSPACE: `${linkWs}/`,
                RUNNER_WORKSPACE: linkParent,
                GITHUB_STEP_SUMMARY: join(linkParent, 'summary'),
              },
            },
          );
          expect(res.status, `${stepName}: ${res.stdout}${res.stderr}`).toBe(0);
          expect(lstatSync(linkWs).isSymbolicLink()).toBe(false);
          expect(readdirSync(outside)).toEqual(['canary']);
        } finally {
          rmSync(linkParent, { recursive: true, force: true });
          rmSync(outside, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'keeps a forged workflow command in the symlink target out of the log',
    () => {
      // On this lane the previous job may have run a contributor's code, and
      // the runner parses `::` at the start of ANY stdout line as a workflow
      // command — so a target of $'…\n::error::forged' would forge an
      // annotation from the very step reporting the corruption.
      for (const stepName of WIPE_STEPS) {
        const parent = mkdtempSync(join(tmpdir(), 'verify-heal-inject-'));
        const outside = mkdtempSync(join(tmpdir(), 'verify-heal-outside-'));
        const ws = join(parent, 'workspace');
        symlinkSync(`${outside}\n::error::forged-annotation`, ws);
        try {
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_WORKSPACE: ws,
                RUNNER_WORKSPACE: parent,
                GITHUB_STEP_SUMMARY: join(parent, 'summary'),
              },
            },
          );
          expect(res.status, `${stepName}: ${res.stdout}${res.stderr}`).toBe(0);
          const out = res.stdout + res.stderr;
          expect(out).toContain('healing workspace');
          expect(out).toContain('pointed at');
          for (const line of out.split('\n')) {
            expect(line.startsWith('::error::')).toBe(false);
          }
        } finally {
          rmSync(parent, { recursive: true, force: true });
          rmSync(outside, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'fails closed when the healed workspace cannot be recreated',
    () => {
      // The mkdir leg's own refusal, reachable without a permission trick:
      // `rm -f` returns 0 for a path whose parent is not a directory, and
      // the mkdir that follows cannot succeed. Swallowed, the wipe would run
      // against a path that does not exist.
      for (const stepName of WIPE_STEPS) {
        const parent = mkdtempSync(join(tmpdir(), 'verify-heal-mkdir-'));
        writeFileSync(join(parent, 'file'), 'not a directory');
        try {
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_WORKSPACE: join(parent, 'file', 'sub'),
                RUNNER_WORKSPACE: parent,
                GITHUB_STEP_SUMMARY: join(parent, 'summary'),
              },
            },
          );
          expect(res.status, stepName).not.toBe(0);
          expect(res.stdout + res.stderr).toContain('could not recreate');
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!hasGnuRealpath || process.getuid?.() === 0)(
    'fails closed when the corrupt workspace cannot be unlinked',
    () => {
      // A swallowed `rm -f` failure would let the mkdir and the wipe run on
      // a path that is still a symlink. Root bypasses the mode bits, so the
      // fixture cannot produce the refusal there.
      for (const stepName of WIPE_STEPS) {
        const parent = mkdtempSync(join(tmpdir(), 'verify-heal-perm-'));
        const outside = mkdtempSync(join(tmpdir(), 'verify-heal-outside-'));
        const ws = join(parent, 'workspace');
        writeFileSync(join(outside, 'canary'), 'x');
        symlinkSync(outside, ws);
        chmodSync(parent, 0o555);
        try {
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_WORKSPACE: ws,
                RUNNER_WORKSPACE: parent,
                GITHUB_STEP_SUMMARY: join(parent, 'summary'),
              },
            },
          );
          expect(res.status, stepName).not.toBe(0);
          expect(res.stdout + res.stderr).toContain('could not remove');
          expect(lstatSync(ws).isSymbolicLink()).toBe(true);
          expect(readdirSync(outside)).toEqual(['canary']);
        } finally {
          chmodSync(parent, 0o755);
          rmSync(parent, { recursive: true, force: true });
          rmSync(outside, { recursive: true, force: true });
        }
      }
    },
  );

  // Fronts PATH with a failing realpath so the script must fail closed instead
  // of matching and wiping a raw, potentially misleading spelling.
  const stubRealpath = () => {
    const bin = mkdtempSync(join(tmpdir(), 'verify-wipe-bin-'));
    writeFileSync(join(bin, 'realpath'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'realpath'), 0o755);
    return bin;
  };

  it('refuses to wipe when realpath is absent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'verify-wipe-rws-'));
    const ws = join(parent, 'repo');
    mkdirSync(ws);
    writeFileSync(join(ws, 'leftover'), 'x');
    const bin = stubRealpath();
    try {
      // Both copies carry the fail-closed realpath leg; exercise each so
      // a fail-open regression of either copy is caught.
      for (const stepName of [
        'Wipe workspace before external code',
        'Wipe workspace after external code',
      ]) {
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              GITHUB_WORKSPACE: ws,
              RUNNER_WORKSPACE: `${parent}/`,
              GITHUB_STEP_SUMMARY: join(parent, 'summary'),
            },
          },
        );
        expect(res.status, `${stepName} did not fail closed`).not.toBe(0);
        expect(readdirSync(ws), `${stepName} wiped without realpath`).toEqual([
          'leftover',
        ]);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refuses a trailing-slash GITHUB_WORKSPACE when realpath is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-wipe-ws-'));
    const bin = stubRealpath();
    try {
      const calls = join(dir, 'rm-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'rm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
        { mode: 0o755 },
      );

      for (const stepName of [
        'Wipe workspace before external code',
        'Wipe workspace after external code',
      ]) {
        writeFileSync(calls, '');
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${bin}:${process.env.PATH}`,
              GITHUB_WORKSPACE: '/home/',
              RUNNER_WORKSPACE: '/home',
              GITHUB_STEP_SUMMARY: join(dir, 'summary'),
            },
          },
        );
        expect(res.status, `${stepName} did not refuse`).not.toBe(0);
        expect(readFileSync(calls, 'utf8'), `${stepName} invoked rm`).toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refuses an allowlist-escaping .. path when realpath is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-wipe-fallback-'));
    const outside = mkdtempSync(join(tmpdir(), 'verify-wipe-outside-'));
    const bin = stubRealpath();
    mkdirSync(join(dir, 'sub'));
    try {
      const calls = join(dir, 'rm-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'rm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
        { mode: 0o755 },
      );

      for (const stepName of [
        'Wipe workspace before external code',
        'Wipe workspace after external code',
      ]) {
        writeFileSync(calls, '');
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${bin}:${process.env.PATH}`,
              GITHUB_WORKSPACE: `${dir}/sub/../../${basename(outside)}`,
              RUNNER_WORKSPACE: dir,
              GITHUB_STEP_SUMMARY: join(dir, 'summary'),
            },
          },
        );
        expect(res.status, `${stepName} did not refuse`).not.toBe(0);
        expect(
          readFileSync(calls, 'utf8'),
          `${stepName} invoked rm on the escaping path`,
        ).toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  // The degenerate-root arm keeps a stripped-empty RUNNER_WORKSPACE from
  // turning the allowlist pattern into `/*` (which admits every absolute
  // path). The reference suite covers the review workflow; each backported
  // copy needs its own case — deleting the arm ships green otherwise.
  it('refuses a runner workspace that resolves to / without invoking rm', () => {
    const parent = mkdtempSync(join(tmpdir(), 'verify-wipe-root-'));
    const ws = join(parent, 'repo');
    mkdirSync(ws);
    writeFileSync(join(ws, 'leftover'), 'x');
    try {
      const calls = join(parent, 'rm-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(parent, 'rm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
        { mode: 0o755 },
      );

      for (const stepName of [
        'Wipe workspace before external code',
        'Wipe workspace after external code',
      ]) {
        writeFileSync(calls, '');
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${parent}:${process.env.PATH}`,
              GITHUB_WORKSPACE: ws,
              RUNNER_WORKSPACE: '/',
              GITHUB_STEP_SUMMARY: join(parent, 'summary'),
            },
          },
        );
        expect(res.status, `${stepName} did not refuse`).not.toBe(0);
        expect(readFileSync(calls, 'utf8'), `${stepName} invoked rm`).toBe('');
        expect(readdirSync(ws), `${stepName} wiped`).toEqual(['leftover']);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // The RWS realpath line has no refusal of its own to observe, so pin it
  // from the happy side: a RUNNER_WORKSPACE spelled with '..' that
  // canonicalizes back to the real parent must still be allowed to wipe.
  // Deleting the RWS realpath line leaves the raw spelling to the '..'
  // arm, which refuses — and this test fails on that mutant.
  it.skipIf(!hasGnuRealpath)(
    'canonicalizes a ..-spelled runner workspace instead of refusing it',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'verify-wipe-rwsdot-'));
      const ws = join(parent, 'repo');
      mkdirSync(ws);
      try {
        for (const stepName of [
          'Wipe workspace before external code',
          'Wipe workspace after external code',
        ]) {
          writeFileSync(join(ws, 'leftover'), 'x');
          const res = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', extractRun(stepName)],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_WORKSPACE: ws,
                RUNNER_WORKSPACE: join(ws, '..'),
                GITHUB_STEP_SUMMARY: join(parent, 'summary'),
              },
            },
          );
          expect(res.status, `${stepName} refused a canonical RWS`).toBe(0);
          expect(readdirSync(ws), `${stepName} did not wipe`).toEqual([]);
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  // The pre-run wipe answers what an external run inherits; the
  // post-run wipe answers what it leaves behind for the next pool job.
  it('wipes the workspace after external code, on every outcome', () => {
    const verifyJob = job('verify');
    const postWipe = stepIn('verify', 'Wipe workspace after external code');
    expect(postWipe).not.toBe('');
    // Gated on the trust level: a trusted run keeps its warm workspace.
    expect(postWipe).toContain(
      "needs.authorize.outputs.verify_trust == 'external'",
    );
    // Must run on every outcome, including cancellation and timeout.
    expect(postWipe).toContain('always()');
    // Ordering: after the agent, not before it.
    expect(verifyJob.indexOf('Run verification agent')).toBeLessThan(
      verifyJob.indexOf('Wipe workspace after external code'),
    );
    // Same path guard as the pre-run wipe.
    expect(postWipe).toContain('refusing to wipe suspicious workspace path');
    // The ported guard layers (#9265), pinned on THIS copy: canonicalize
    // before matching, and allowlist the target inside the runner
    // workspace. The exec tests below prove behavior; these text pins
    // catch a mutation that deletes a layer from this copy alone.
    expect(postWipe).toContain('realpath -m');
    expect(postWipe).toContain('realpath -m -- "$RWS"');
    expect(postWipe).toContain('RUNNER_WORKSPACE:?');
    expect(postWipe).toContain('"$RWS"/*');
    expect(postWipe).toContain(
      "refusing runner workspace path containing '..'",
    );
    expect(postWipe).toContain('runner workspace resolved to /');
  });

  // The pre-run guard battery runs the post-run wipe too: it is a
  // separate copy of the script, and the pre-run battery passing says
  // nothing about mutations to this one.
  it('refuses a suspicious workspace path in the post-run wipe without invoking rm', () => {
    const wipe = extractRun('Wipe workspace after external code');

    const dir = mkdtempSync(join(tmpdir(), 'verify-postwipe-guard-'));
    try {
      const calls = join(dir, 'rm-calls');
      writeFileSync(
        join(dir, 'rm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
        { mode: 0o755 },
      );

      for (const bad of [
        '/',
        '/usr',
        '/etc',
        '/var',
        '/root',
        '/home',
        '',
        '/home/',
        '/root/',
        '/var/',
        '//',
        '/home//',
        '/home/.',
        '/home/..',
        '//usr',
        '//home',
        '/tmp',
        '/opt',
      ]) {
        writeFileSync(calls, '');
        const guard = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipe], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GITHUB_WORKSPACE: bad,
            RUNNER_WORKSPACE: dir,
            GITHUB_STEP_SUMMARY: join(dir, 'summary'),
          },
        });
        expect(
          guard.status,
          `path ${bad || '<empty>'} was not refused`,
        ).not.toBe(0);
        expect(
          readFileSync(calls, 'utf8'),
          `rm was invoked for ${bad || '<empty>'}`,
        ).toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The post-run wipe still has to wipe: its `if: always()` means it is
  // the ONLY cleanup a cancelled or timed-out external run gets, so a
  // guard regression that refuses the legitimate workspace would leak
  // every aborted run's tree into the next pool job.
  it.skipIf(!hasGnuRealpath)(
    'wipes a legitimate workspace in the post-run wipe and writes the summary',
    () => {
      const wipe = extractRun('Wipe workspace after external code');

      const parent = mkdtempSync(join(tmpdir(), 'verify-postwipe-ok-'));
      const ws = join(parent, 'workspace');
      mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
      writeFileSync(
        join(ws, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\nid\n',
      );
      writeFileSync(join(ws, 'leftover.o'), 'x');
      const summary = join(parent, 'summary');
      try {
        const res = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipe], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_WORKSPACE: ws,
            RUNNER_WORKSPACE: parent,
            GITHUB_STEP_SUMMARY: summary,
          },
        });
        expect(res.status).toBe(0);
        expect(readdirSync(ws)).toEqual([]);
        expect(readFileSync(summary, 'utf8')).toContain(
          'Workspace wiped after external code',
        );
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  // The sponsored lane's pre-execution risk screen, driven for real: the
  // actual resolve-step text runs against a stubbed gh and a live local
  // HTTP server standing in for the model endpoint, so the heredoc's
  // fetch/parse/fail-closed logic is what executes — not a re-statement
  // of it. Every arm asserts on the step's real GITHUB_OUTPUT.
  it('screens sponsored runs mechanically and via the model, fail-closed', async () => {
    const resolveStep = stepIn('verify', 'Resolve PR and snapshot metadata');
    const script = resolveStep
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    expect(script).toBeTruthy();
    // The screen prompt must describe the ACTUAL environment. The pool is
    // persistent and network-isolated, not ephemeral — a stale prompt
    // calibrates the model for leniency it should not have.
    expect(script).not.toContain('ephemeral');
    expect(script).not.toContain('credential-free');
    expect(script).toContain('network-isolated');

    // The model endpoint must be a SEPARATE process: the scenarios run the
    // step via spawnSync, which blocks this process's event loop — an
    // in-process server could never answer, and the screen's fetch would
    // sit on its 120 s abort timer instead of testing anything.
    const dir = mkdtempSync(join(tmpdir(), 'verify-screen-'));
    const replyFile = join(dir, 'model-reply');
    const hitsFile = join(dir, 'model-hits');
    const portFile = join(dir, 'model-port');
    writeFileSync(portFile, '');
    writeFileSync(replyFile, '{"risk":"clear"}');
    writeFileSync(hitsFile, '');
    const serverProc = spawn(
      process.execPath,
      [
        '-e',
        [
          "const http=require('http'),fs=require('fs');",
          'const s=http.createServer((q,r)=>{',
          "fs.appendFileSync(process.env.HITS,'x');",
          "r.setHeader('content-type','application/json');",
          "r.end(JSON.stringify({choices:[{message:{content:fs.readFileSync(process.env.REPLY,'utf8')}}]}));",
          '});',
          "s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.PORTF,String(s.address().port)));",
        ].join(''),
      ],
      {
        env: {
          ...process.env,
          HITS: hitsFile,
          REPLY: replyFile,
          PORTF: portFile,
        },
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 100 && !readFileSync(portFile, 'utf8').trim(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const port = readFileSync(portFile, 'utf8').trim();
    expect(port).not.toBe('');
    const modelHits = () => readFileSync(hitsFile, 'utf8').length;
    const setReply = (v) => writeFileSync(replyFile, v);
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"--json state,isDraft,mergeable"*)',

        '    echo \'{"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE"}\' ;;',
        '  *pulls/*/files*) echo packages/core/src/x.ts ;;',
        '  *"pr diff"*) cat "$GH_STUB_DIFF" ;;',
        '  *"--json number,title"*)',
        '    printf \'{"headRefOid":"%s","author":{"login":"ext"}}\' "$GH_STUB_OID" ;;',
        '  *collaborators/*) echo none ;;',
        '  *"api user"*) echo bot ;;',
        '  *comments*) echo "[]" ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 },
    );

    let n = 0;
    const run = ({ trust, diff, prOid, sponsoredOid, baseUrl, apiKey }) => {
      const temp = join(dir, `t${n}`);
      mkdirSync(temp, { recursive: true });
      const out = join(dir, `out-${n}`);
      const diffFile = join(dir, `diff-${n}`);
      n += 1;
      writeFileSync(out, '');
      writeFileSync(diffFile, diff);
      const res = spawnSync('bash', ['-c', script], {
        cwd: temp,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_TOKEN: 'x',
          GH_STUB_DIFF: diffFile,
          GH_STUB_OID: prOid ?? 'oid-1',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_OUTPUT: out,
          RUNNER_TEMP: temp,
          PR_NUMBER: '7',
          RUN_URL: 'u',
          VERIFY_TRUST: trust,
          SPONSORED_OID: sponsoredOid ?? 'oid-1',
          REVIEW_OPENAI_API_KEY: apiKey === undefined ? 'k' : apiKey,
          REVIEW_OPENAI_BASE_URL: baseUrl ?? `http://127.0.0.1:${port}/v1`,
          OPENAI_MODEL: 'screen-model',
        },
      });
      expect(res.status).toBe(0);
      const lines = readFileSync(out, 'utf8').trim().split('\n');
      const val = (k) =>
        lines
          .filter((l) => l.startsWith(`${k}=`))
          .pop()
          ?.slice(k.length + 1);
      return { decision: val('decision'), reason: val('skip_reason') ?? '' };
    };

    const CLEAN = '+++ b/packages/core/src/x.ts\n+const x = 1;\n';
    try {
      const before = modelHits();

      // Fail closed on an unfetchable diff: a transient `gh pr diff`
      // failure or an empty result must refuse rather than hand the model
      // an empty string it would almost certainly call "clear". No model
      // call is spent: the fetch guard runs before the screen.
      const noDiff = run({ trust: 'external', diff: '' });
      expect(noDiff.decision).toBe('skip');
      expect(noDiff.reason).toContain('could not be fetched');
      expect(modelHits()).toBe(before);

      // Mechanical: an added npm lifecycle script refuses WITHOUT spending
      // a model call — a mechanical flag cannot be un-refused by a second
      // opinion, so paying for one would be pure waste.
      const lifecycle = run({
        trust: 'external',
        diff: '+++ b/package.json\n+    "postinstall": "node evil.js",\n',
      });
      expect(lifecycle.decision).toBe('skip');
      expect(lifecycle.reason).toContain('risk screen');
      expect(lifecycle.reason).toContain('npm lifecycle');
      expect(modelHits()).toBe(before);

      // npm runs pre/post hooks for ANY `npm run <script>`, and this job
      // runs `npm run build` while the agent runs the PR's suites — so a
      // `prebuild` executes exactly like a `postinstall`. The alternation
      // originally stopped at the install lifecycle and let these through.
      for (const script of ['prebuild', 'postbuild', 'pretest', 'posttest']) {
        const hook = run({
          trust: 'external',
          diff: `+++ b/package.json\n+    "${script}": "node payload.js",\n`,
        });
        expect(hook.decision, `${script} was not flagged`).toBe('skip');
        expect(hook.reason).toContain('npm lifecycle');
      }

      // Mechanical: a dependency resolving off-registry.
      const offReg = run({
        trust: 'external',
        diff: '+++ b/package-lock.json\n+      "resolved": "https://evil.example/x.tgz",\n',
      });
      expect(offReg.decision).toBe('skip');
      expect(offReg.reason).toContain('registry.npmjs.org');

      // A lookalike host CONTAINS the registry name, so an unanchored
      // exclusion read it as npmjs and waved it through — and the malicious
      // tarball's own postinstall lives inside the tarball, never in the
      // diff this screen can see.
      for (const url of [
        'https://registry.npmjs.org.evil.com/pkg.tgz',
        'https://evil.com/?u=registry.npmjs.org',
        'https://registry.npmjs.org@evil.com/pkg.tgz',
      ]) {
        const lookalike = run({
          trust: 'external',
          diff: `+++ b/package-lock.json\n+      "resolved": "${url}",\n`,
        });
        expect(lookalike.decision, `${url} was not flagged`).toBe('skip');
        expect(lookalike.reason).toContain('registry.npmjs.org');
      }
      // ...and the genuine registry still passes, or the arm would be
      // refusing every lockfile change and the tests above would prove
      // nothing.
      expect(
        run({
          trust: 'external',
          diff: '+++ b/package-lock.json\n+      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",\n',
        }).decision,
      ).toBe('run');

      // Package-manager config: settings like `script-shell` redirect what
      // every later npm invocation executes.
      for (const cfg of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml']) {
        const pm = run({
          trust: 'external',
          diff: `+++ b/${cfg}\n+script-shell=/tmp/evil\n`,
        });
        expect(pm.decision, `${cfg} was not flagged`).toBe('skip');
        expect(pm.reason).toContain('package-manager configuration');
      }

      // The regex must not be root-anchored: a .npmrc in a package
      // subdirectory is just as dangerous as one at the root.
      const nested = run({
        trust: 'external',
        diff: '+++ b/packages/core/.npmrc\n+script-shell=/tmp/evil\n',
      });
      expect(nested.decision, 'nested .npmrc was not flagged').toBe('skip');
      expect(nested.reason).toContain('package-manager configuration');

      // A rename-only hunk emits `rename to` with no `+++ b/` header.
      const renamed = run({
        trust: 'external',
        diff: 'rename from something\nrename to .npmrc\n',
      });
      expect(renamed.decision, 'rename to .npmrc was not flagged').toBe('skip');
      expect(renamed.reason).toContain('package-manager configuration');

      // Long opaque single-line content: a space-free field of 600+ chars
      // is the shape of a packed payload, and the arm must skip lockfile
      // integrity/resolved lines or every dependency bump would refuse.
      const packed = run({
        trust: 'external',
        diff: `+++ b/src/x.js\n+${'A'.repeat(700)}\n`,
      });
      expect(packed.decision).toBe('skip');
      expect(packed.reason).toContain('long opaque');
      expect(
        run({
          trust: 'external',
          diff: `+++ b/package-lock.json\n+      "integrity": "sha512-${'B'.repeat(700)}",\n`,
        }).decision,
      ).toBe('run');

      // A line with spaces is still caught when one space-free field
      // is >= 600 chars (the old rule required the WHOLE line to be
      // space-free, so a single space anywhere was a bypass).
      const spacedOpaque = run({
        trust: 'external',
        diff: `+++ b/src/x.js\n+const p = '${'C'.repeat(650)}';\n`,
      });
      expect(spacedOpaque.decision, 'spaced opaque field was not flagged').toBe(
        'skip',
      );
      expect(spacedOpaque.reason).toContain('long opaque');
      // ...but a line whose fields are all short must still pass, or the
      // arm would be refusing ordinary code.
      expect(
        run({
          trust: 'external',
          diff: `+++ b/src/x.js\n+${'word '.repeat(200)}\n`,
        }).decision,
      ).toBe('run');

      // Oversized diff: the model screen reads at most 200 KB, so a
      // larger diff would be screened on a prefix only — fail closed.
      const oversized = run({
        trust: 'external',
        diff: CLEAN + '+'.padEnd(200001, 'x') + '\n',
      });
      expect(oversized.decision).toBe('skip');
      expect(oversized.reason).toContain('too large to screen');

      // Unconfigured model screen -> refuse. A missing key must never mean
      // "nothing flagged it, proceed".
      const unconfigured = run({
        trust: 'external',
        diff: CLEAN,
        apiKey: '',
      });
      expect(unconfigured.decision).toBe('skip');
      expect(unconfigured.reason).toContain('not configured');

      // Clean diff + model clear -> the run proceeds.
      setReply('{"risk":"clear"}');
      const clear = run({ trust: 'external', diff: CLEAN });
      expect(clear.decision).toBe('run');
      expect(modelHits()).toBeGreaterThan(before);

      // Model flagged -> refused.
      setReply('{"risk":"flagged"}');
      expect(run({ trust: 'external', diff: CLEAN }).decision).toBe('skip');

      // Unparseable model reply -> refused (fail closed), never treated
      // as clear.
      setReply('looks fine to me!');
      const garbage = run({ trust: 'external', diff: CLEAN });
      expect(garbage.decision).toBe('skip');
      expect(garbage.reason).toContain('unparseable');

      // Unreachable model endpoint -> refused (fail closed).
      setReply('{"risk":"clear"}');
      const dead = run({
        trust: 'external',
        diff: CLEAN,
        baseUrl: 'http://127.0.0.1:1/v1',
      });
      expect(dead.decision).toBe('skip');

      // Sponsorship pin: the head moved after the sponsoring comment.
      const moved = run({
        trust: 'external',
        diff: CLEAN,
        prOid: 'oid-2',
        sponsoredOid: 'oid-1',
      });
      expect(moved.decision).toBe('skip');
      expect(moved.reason).toContain('re-comment');

      // A trusted-level run is untouched by the screen: the same author is
      // refused by the execution-time permission re-check instead, and the
      // refusal points at the sponsored alternative.
      const ecs = run({ trust: 'trusted', diff: CLEAN });
      expect(ecs.decision).toBe('skip');
      expect(ecs.reason).toContain('sponsor');
    } finally {
      serverProc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('restricts every verify notice to pull requests', () => {
    // 'Explain denied verify request' is gone by design: an external author
    // no longer denies the run — it routes it to the hosted lane instead.
    expect(stepIn('authorize', 'Explain denied verify request')).toBe('');
    for (const name of [
      'Acknowledge verify request',
      'Report disabled verify lane',
    ]) {
      const raw = stepIn('authorize', name);
      expect(raw, `${name} is missing from the authorize job`).not.toBe('');
      expect(raw).toContain('github.event.issue.pull_request');
    }
  });

  // The kill switch must produce an answer, not an indefinite queue: the
  // verify job refuses to start and the hosted authorize job says why.
  it('answers a /verify request when the runner pool is disabled', () => {
    const notice = stepIn('authorize', 'Report disabled verify lane');
    expect(notice).toContain("vars.MAINTAINER_ECS_RUNNER_DISABLED == 'true'");
    expect(notice).toContain("steps.perm.outputs.should_run == 'true'");
    // Bilingual, and it names the alternative rather than just refusing.
    expect(notice).toContain('Sandboxed verification unavailable');
    expect(notice).toContain('沙箱验证当前不可用');
    expect(notice).toContain('@qwen-code /triage');
    // ...and the verify job itself must stay out of the disabled pool.
    expect(job('verify')).toContain(
      "vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true'",
    );
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
    // An outward-resolving entry is unlinked, not merely reported: leaving
    // it lets the next root-owned git command execute it.
    expect(clean).toContain('unlinking it');
    expect(clean).toContain('git config --local --unset-all core.hooksPath');
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
    expect(runStep).toContain('PIPE_STATUS=("${PIPESTATUS[@]}")');
    expect(runStep).toContain('TEE_STATUS=${PIPE_STATUS[1]:-0}');
    expect(runStep).toMatch(/TEE_STATUS:-0.*-ne 0/s);
    expect(runStep).toContain('WATCHDOG_FIRED');
  });

  // The lifecycle-script command-file guards must be asserted on the verify
  // job's own commands: a bare step() lookup returns the tmux job's
  // identically named step, so verify-side regressions would pass silently.
  it('strips GitHub command files from every node-run verify command', () => {
    // Bound to the commands that run as node before the agent: npm ci and
    // npm run build in the prepare step, the evidence browser download,
    // and the flake gate's four pre-sample git invocations — the .git
    // sanitize, git reset --hard, git clean -ffd, and the PINNED_OID
    // rev-parse (git filters run from PR-owned .git metadata). The slice
    // stops at the agent step, whose own `runuser` launches qwen under
    // `env -i` and needs no per-variable stripping; the gate's
    // per-sample invocation is a line-continuation shape this
    // single-line match does not fold. Covering all seven by
    // construction (not enumeration) is what catches a future node-run
    // command added without the strip.
    const prepare = verifyJob.slice(
      verifyJob.indexOf('Install and build PR app'),
      verifyJob.indexOf('Run verification agent'),
    );
    const commands = prepare.match(/runuser -u node -- env[\s\S]*?\n/g) ?? [];
    expect(commands.length).toBe(7);
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
  it('renders report.md as sanitized markdown with an escaped-pre fallback', () => {
    // #8140's verify comment displayed the whole curated bilingual report
    // as a wall of raw markdown source inside <pre><code>. report.md now
    // renders as MARKDOWN, wrapped in a collapsed <details> so it still
    // costs one line in the conversation. A code-region-aware node sanitizer
    // holds the security floor: CommonMark does NOT decode entities in code
    // spans/fences, so escaping there would show &amp;&amp; / &lt;T&gt; in
    // the very commands and types the report is read to copy — prose is
    // escaped, code is left alone (inert under a code/pre ancestor), the
    // comment-open token is broken EVERYWHERE so no forged qwen-triage:*
    // marker survives in the RAW body the upsert greps, prose @ cannot fire
    // mentions, and folds are balanced over prose only (a </details> quoted
    // in code is inert) so a malformed report cannot swallow the footer or
    // escape its wrapper. Oversized reports fall back to the escaped <pre>
    // wholesale (cut markdown dangles fences).
    const publishStep = step('Post verification report comment');
    const body = publishStep.match(/run: \|-\n([\s\S]*)$/)?.[1];
    const script = body.replace(/^ {10}/gm, '');
    const helpers = script.slice(
      script.indexOf('html_escape()'),
      script.indexOf('EVIDENCE_SECTION='),
    );
    expect(helpers).toContain('emit_report()');
    // Each fallback branch announces itself in the Actions log (mirroring
    // emit_block's failure warning) so a degradation to the escaped pre dump
    // is attributable, not silent. The fold-closer overhead is now budgeted
    // inside the sanitized-size gate (closers land before it), so four
    // warnings cover every degradation.
    expect(helpers).toContain(
      '::warning::emit_report fell back to escaped embedding (report exceeds size cap)',
    );
    expect(helpers).toContain(
      '::warning::emit_report fell back to escaped embedding (sanitize failed)',
    );
    expect(helpers).toContain(
      '::warning::emit_report fell back to escaped embedding (report ended inside an open code fence)',
    );
    expect(helpers).toContain(
      '::warning::emit_report fell back to escaped embedding (sanitized output exceeds size cap)',
    );
    // The report call site uses the rendering path; the tmux lane keeps
    // its escaped embedding.
    expect(script).toContain('emit_report "$REPORT" 45000');
    expect(step('Post tmux result comment')).not.toContain('emit_report');

    // Mirror the sanitizer's code-region model so security assertions test
    // PROSE only: a live-looking tag inside a fence is inert code text, not
    // a hole, so grepping the raw output would give false positives.
    const stripCode = (s) => {
      const kept = [];
      let inFence = false;
      let fc = '';
      let fl = 0;
      let inHtml = false;
      for (const line of s.split('\n')) {
        if (!inFence) {
          if (inHtml && /^\s*$/.test(line)) inHtml = false;
          const wasHtml = inHtml;
          const m = inHtml ? null : line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
          if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
            inFence = true;
            fc = m[1][0];
            fl = m[1].length;
            continue;
          }
          if (/^\s*<\/?(details|summary)\b/.test(line)) inHtml = true;
          kept.push(wasHtml ? line : line.replace(/`[^`]*`/g, ''));
        } else {
          const cm = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
          if (cm && cm[1][0] === fc && cm[1].length >= fl) inFence = false;
        }
      }
      return kept.join('\n');
    };

    const dir = mkdtempSync(join(tmpdir(), 'verify-render-'));
    try {
      const report = join(dir, 'report.md');
      writeFileSync(
        report,
        [
          '# Deep Verification — `merge-ready`',
          '',
          '**Verdict:** pass && <T<U>> ok',
          '',
          'Run `npm test && Map<string> @pkg` then check `a -> b`.',
          '',
          '```bash',
          'npm run build && node probe.mjs --pkg @qwen-code/core',
          '<img src=x onerror=alert(1)>',
          'marker: <!-- qwen-triage:verify-state=running -->',
          'fold-quote: </details>',
          '```',
          '',
          '> a blockquote && more',
          '',
          '| scenario | match |',
          '| --- | --- |',
          '| success | ✅ |',
          '',
          '<details>',
          '<summary>中文摘要</summary>',
          '',
          '- 结论：通过 @everyone <img src=x onerror=alert(1)>',
          '- marker: <!-- qwen-triage:verify -->',
          '',
          '</details>',
          '',
          '<details>',
          '<summary>unclosed fold</summary>',
          'tail',
          '',
        ].join('\n'),
      );
      const emit = (file, max) => {
        const proc = spawnSync(
          'bash',
          ['-c', `${helpers}\nemit_report "$1" ${max}`, '_', file],
          { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
        );
        expect(proc.status).toBe(0);
        return proc.stdout;
      };

      const out = emit(report, 45000);
      // Wrapped in a collapsed <details>; markdown structure survives inside.
      expect(out).toContain(
        '<details>\n<summary>Verification report</summary>',
      );
      expect(out).toContain('| scenario | match |');
      expect(out).toContain('**Verdict:**');
      expect(out).toContain('<summary>中文摘要</summary>');
      expect(out).not.toContain('<pre><code>');
      // Prose fidelity: && and blockquotes survive; a prose < is escaped
      // (renders back to <), > is left alone.
      expect(out).toContain('pass && &lt;T&lt;U>> ok');
      expect(out).toContain('> a blockquote && more');
      expect(out).not.toContain('&amp;&amp;');
      // Code fidelity: spans and fences are untouched — no entity mangling
      // of the commands/types/paths a reader copies, and a fenced <img> or
      // </details> stays inert code text.
      expect(out).toContain('`npm test && Map<string> @pkg`');
      expect(out).toContain(
        'npm run build && node probe.mjs --pkg @qwen-code/core',
      );
      expect(out).toContain('<img src=x onerror=alert(1)>');
      // Security floor over the WHOLE raw body: no live comment-open token
      // anywhere (broken globally, prose AND code), so the upsert grep for
      // the running marker cannot be forged from a fenced quote.
      expect(out).not.toContain('<!--');
      // Security floor over PROSE: the mention is neutralized by a ZWSP
      // (GitHub decodes &#64; before the mention filter, so the entity alone
      // was inert), no live non-allowlisted tag, and prose folds balance
      // (the fenced </details> is NOT counted, so the genuinely unclosed
      // fold still gets closed).
      const prose = stripCode(out);
      expect(prose).not.toContain('@everyone');
      expect(prose).toContain('@&#8203;everyone');
      expect(prose).not.toContain('<img');
      expect(prose.match(/<(?!\/?(details|summary)\b)[A-Za-z]/g)).toBe(null);
      const opens = prose.split('<details>').length - 1;
      const closes = prose.split('</details>').length - 1;
      expect(opens).toBe(closes);

      // Guarantee 4, the hole the review reproduced: one genuinely unclosed
      // fold plus a fenced block quoting </details>. The fenced closer is
      // inert code and must NOT balance the live fold — the prose folds
      // still net to zero only because a closer is appended for the open.
      const hole = join(dir, 'hole.md');
      writeFileSync(
        hole,
        '<details>\n<summary>fold that never closes</summary>\n\n```html\n</details>\n```\n',
      );
      const holeOut = emit(hole, 45000);
      const holeProse = stripCode(holeOut);
      expect(holeProse.split('<details>').length).toBe(
        holeProse.split('</details>').length,
      );

      // HTML-block divergence: a fence opener inside a <details> HTML
      // block is literal text per CommonMark/GitHub, not a fence. The
      // sanitizer must prose-escape the content (neutralizing <img>)
      // rather than passing it through escCode as inert code.
      const htmlblk = join(dir, 'htmlblk.md');
      writeFileSync(
        htmlblk,
        [
          '<details>',
          '<summary>fold</summary>',
          '```',
          '<img src=x onerror=alert(1)>',
          '```',
          '</details>',
          '',
        ].join('\n'),
      );
      const htmlOut = emit(htmlblk, 45000);
      // The <img> is prose-escaped, not passed through as inert code.
      expect(htmlOut).toContain('&lt;img src=x onerror=alert(1)>');
      expect(htmlOut).not.toContain('<img');
      // The fold balances: wrapper 1 open / 1 close, report fold balanced.
      expect(htmlOut.split('<details>').length - 1).toBe(
        htmlOut.split('</details>').length - 1,
      );

      // Code-span divergence: a backtick code span inside a <details>
      // HTML block is literal text per CommonMark/GitHub, not code.
      // The sanitizer must prose-escape the whole line (neutralizing
      // <img>) rather than splitting it through proseLine and passing
      // the span through escCode as inert code.
      const codespan = join(dir, 'codespan.md');
      writeFileSync(
        codespan,
        [
          '<details>',
          '<summary>fold</summary>',
          'text `<img src=x onerror=alert(1)>` more',
          '</details>',
          '',
        ].join('\n'),
      );
      const csOut = emit(codespan, 45000);
      expect(csOut).toContain('&lt;img src=x onerror=alert(1)>');
      expect(csOut).not.toContain('<img');
      expect(csOut.split('<details>').length - 1).toBe(
        csOut.split('</details>').length - 1,
      );
      const csProse = stripCode(csOut);
      expect(csProse).not.toContain('<img');

      // Indented fold: a <details> nested in a list (indent >= 4) must
      // enter the inHtml state too — GitHub opens HTML blocks relative
      // to the list-item content column, not just at column 0-3.
      const indented = join(dir, 'indented.md');
      writeFileSync(
        indented,
        [
          '- list item',
          '    <details>',
          '    <summary>fold</summary>',
          '    text `<img src=x>` more',
          '    </details>',
          '',
        ].join('\n'),
      );
      const indOut = emit(indented, 45000);
      expect(indOut).toContain('&lt;img src=x>');
      expect(indOut).not.toContain('<img');

      // Mirror case: a surplus </details> with no open is dropped so it
      // cannot close the wrapping fold early — the wrapper stays 1 open /
      // 1 close even though the report shipped an orphan closer.
      const surplus = join(dir, 'surplus.md');
      writeFileSync(surplus, 'text </details> more\n');
      const surplusOut = emit(surplus, 45000);
      expect(surplusOut).toContain('text  more');
      expect(surplusOut.split('<details>').length - 1).toBe(1);
      expect(surplusOut.split('</details>').length - 1).toBe(1);

      // A report ending inside an open code fence: a fence still open at
      // EOF means the flat scanner diverged from GitHub's container-aware
      // parser (which closes a list-nested fence at the container's end,
      // not at EOF). Rather than guess and ship prose GitHub parses as
      // live, emit_report degrades to the escaped-pre fallback through its
      // non-zero-exit branch, announcing the cause with its own warning.
      const fence = join(dir, 'fence.md');
      writeFileSync(fence, '# Title\n\n```bash\ncode here\n');
      const fenceProc = spawnSync(
        'bash',
        ['-c', `${helpers}\nemit_report "$1" 45000`, '_', fence],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      );
      expect(fenceProc.status).toBe(0);
      expect(fenceProc.stdout).toContain('<pre><code>');
      expect(fenceProc.stdout).toContain(
        'Verification report (report.md, escaped fallback)',
      );
      expect(fenceProc.stderr).toContain(
        '::warning::emit_report fell back to escaped embedding (report ended inside an open code fence)',
      );

      // Container-axis hole the review reproduced: a fence nested in a list
      // item, never explicitly closed. CommonMark closes it at the
      // container's end but the flat scanner stays inFence to EOF, so before
      // the fix the trailing unindented line shipped as prose GitHub parsed
      // as live (mention, <img>, raw <a href>). The EOF-open fence now
      // degrades to the escaped fallback. Red before the fix (output was
      // sanitized markdown carrying a literal <img>/<a>, not the escaped
      // pre), green after; the @mention is inert under the pre/code ancestor.
      const listFence = join(dir, 'list-fence.md');
      writeFileSync(
        listFence,
        [
          '- step one:',
          '',
          '  ```bash',
          '  npm test',
          '',
          'Back at top level: @everyone <img src=x onerror=alert(1)> <a href="https://evil.example/phish">click</a>',
          '',
        ].join('\n'),
      );
      const listOut = emit(listFence, 45000);
      expect(listOut).toContain('<pre><code>');
      expect(listOut).toContain(
        'Verification report (report.md, escaped fallback)',
      );
      expect(listOut).not.toContain('<img');
      expect(listOut).not.toContain('<a href');

      // Container-axis hole with a BALANCING closer (review hole #2 / the
      // inline Critical): the list-nested fence opens indented, column-0
      // prose follows, then a column-0 fence marker balances the flat
      // scanner so it reaches EOF with inFence false — the old EOF guard
      // never fired and the unescaped prose (mention, <img>, raw <a href>)
      // shipped. The dedent guard now exits non-zero the moment a non-blank
      // line dedents below the fence opener's indent. Asserted on the RAW
      // output (parser-independent): the fallback is the escaped pre, so no
      // live <img>/<a href> reaches the body and the @mention is inert under
      // the pre/code ancestor.
      const listFenceClosed = join(dir, 'list-fence-closed.md');
      writeFileSync(
        listFenceClosed,
        [
          '- step one:',
          '',
          '  ```bash',
          '  npm test',
          '',
          'Back at top level: @everyone <img src=x onerror=alert(1)> <a href="https://evil.example/phish">click</a>',
          '',
          '```',
          'after',
          '',
        ].join('\n'),
      );
      const lfcOut = emit(listFenceClosed, 45000);
      expect(lfcOut).toContain('<pre><code>');
      expect(lfcOut).toContain(
        'Verification report (report.md, escaped fallback)',
      );
      expect(lfcOut).not.toContain('<img');
      expect(lfcOut).not.toContain('<a href');

      // Paragraph-spanning code span (review hole #1): CommonMark matches a
      // code span across the lines of a paragraph, but proseLine matches per
      // line. An unmatched backtick run on one line flips the parity for the
      // rest of the paragraph, so the span the sanitizer classified as code
      // was prose to GitHub — a live <img>/@everyone shipped before the fix.
      // The scanner now fails closed: an unmatched run prose-escapes the rest
      // of the paragraph. Asserted on the RAW output (parser-independent)
      // rather than through stripCode, which mirrors the sanitizer's own
      // line-scoped model and so cannot see this divergence.
      const paraSpan = join(dir, 'para-span.md');
      writeFileSync(
        paraSpan,
        ['A `hint about --flag', 'See `<img src=x> @everyone` here', ''].join(
          '\n',
        ),
      );
      const psOut = emit(paraSpan, 45000);
      expect(psOut).toContain('&lt;img src=x>');
      expect(psOut).not.toContain('<img');
      expect(psOut).toContain('@&#8203;everyone');
      expect(psOut).not.toContain('@everyone');

      // Backslash-escaped opening backtick (review Critical): CommonMark's
      // escape rule consumes \` before the backticks rule runs, so it does
      // NOT open a code span — but the raw-text backtick scanner still lets it
      // CLOSE one. Before the fix proseLine paired the escaped backtick with a
      // later one and shipped the gap as inert code, so GitHub rendered prose:
      // a live <a href>, an un-defused @everyone, and a </details> that
      // balance() never saw (it went through escCode), closing the wrapper
      // early. The scanner now fails closed on an odd backslash run. Asserted
      // on the RAW output (parser-independent): no live <a href>/<img>, the
      // mention is ZWSP-defused, and the injected closer is dropped so the
      // wrapper stays 1 open / 1 close.
      const escBt = join(dir, 'esc-bt.md');
      writeFileSync(
        escBt,
        'see \\` opts </details> @everyone <a href="https://evil.example/phish">Merge instructions</a> ` end\n',
      );
      const escBtOut = emit(escBt, 45000);
      expect(escBtOut).not.toContain('<a href');
      expect(escBtOut).not.toContain('<img');
      expect(escBtOut).toContain('@&#8203;everyone');
      expect(escBtOut).not.toContain('@everyone');
      expect(escBtOut.split('<details>').length - 1).toBe(1);
      expect(escBtOut.split('</details>').length - 1).toBe(1);

      // Pre-escaped entities (review Medium): escProse restores the allowlist
      // by round-tripping through &lt;, so before the fix it could not tell a
      // &lt; it just produced from one the author typed — a literal
      // &lt;details> in the report was promoted to a LIVE fold and a literal
      // &lt;/details> was silently deleted by the surplus-closer drop. The
      // sentinel now protects only the source's OWN raw tags, so author-typed
      // entities stay escaped text: no forged fold, nothing deleted, wrapper
      // stays 1 open / 1 close.
      const ent = join(dir, 'entity.md');
      writeFileSync(
        ent,
        'pre-escaped: &lt;/details> and &lt;details> and &lt;img src=x>\n',
      );
      const entOut = emit(ent, 45000);
      expect(entOut).toContain('&lt;/details>');
      expect(entOut).toContain('&lt;details>');
      expect(entOut).toContain('&lt;img src=x>');
      expect(entOut.split('<details>').length - 1).toBe(1);
      expect(entOut.split('</details>').length - 1).toBe(1);

      // A NUL byte in the report is stripped (parity with emit_block's
      // tr -d '\000'); it must not reach the comment body.
      const nul = join(dir, 'nul.md');
      writeFileSync(nul, 'before\u0000after\n');
      const nulOut = emit(nul, 45000);
      expect(nulOut).toContain('beforeafter');
      expect(nulOut).not.toContain('\u0000');

      // Oversize → wholesale fallback to the escaped pre embedding.
      const big = join(dir, 'big.md');
      writeFileSync(big, `x${'y'.repeat(46000)}`);
      const fb = emit(big, 45000);
      expect(fb).toContain('<pre><code>');
      expect(fb).toContain('Verification report (report.md, truncated)');

      // Inflation: raw under the cap but sanitized over it. & is no longer
      // escaped (it is not a security control), so < drives the inflation —
      // each < becomes the 4-byte &lt;.
      const dense = join(dir, 'dense.md');
      writeFileSync(dense, '<'.repeat(12000));
      const inflated = emit(dense, 45000);
      expect(inflated).toContain('<pre><code>');
      expect(inflated).toContain('Verification report (report.md, truncated)');

      // The sanitizer runs under the step's real `set -euo pipefail`; a
      // fold-free report must still exit 0 and render (no grep whose
      // zero-match exit could abort the composer).
      const nofolds = join(dir, 'nofolds.md');
      writeFileSync(nofolds, '## heading\nbody text\n');
      const pf = spawnSync(
        'bash',
        [
          '-c',
          `set -o pipefail\n${helpers}\nemit_report "$1" 45000`,
          '_',
          nofolds,
        ],
        { encoding: 'utf8' },
      );
      expect(pf.status).toBe(0);
      expect(pf.stdout).toContain('<summary>Verification report</summary>');
      expect(pf.stdout).toContain('## heading');

      // Appended fold closers land in the sanitized output BEFORE the size
      // gate, so a report dense in unbalanced <details> opens falls back to
      // the capped pre dump once the closers push the wrapped section over
      // the budget — rather than shipping a section over the cap.
      // 100 opens: raw ~900 B clears max=2000, but 900 + 100*11 closers +
      // the ~61 B wrapper > 2000 forces the fallback.
      const folds = join(dir, 'folds.md');
      writeFileSync(folds, '<details>\n'.repeat(100));
      const over = emit(folds, 2000);
      expect(over).toContain('<pre><code>');
      expect(over).toContain('Verification report (report.md, truncated)');

      // Sanitizer crash → escaped-pre fallback. Override node so the
      // sanitizer's `node -e` fails; emit_block's own node call has a
      // head -c fallback so the escaped output still renders.
      const crash = join(dir, 'crash.md');
      writeFileSync(crash, '# crash report\n\nbody text\n');
      const crashProc = spawnSync(
        'bash',
        [
          '-c',
          `node() { return 1; }\n${helpers}\nemit_report "$1" 45000`,
          '_',
          crash,
        ],
        { encoding: 'utf8' },
      );
      expect(crashProc.status).toBe(0);
      expect(crashProc.stdout).toContain('<pre><code>');
      expect(crashProc.stdout).toContain(
        'Verification report (report.md, escaped fallback)',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    // The list arrives through a FILE, not argv: Linux caps a single
    // argument at 128 KB (MAX_ARG_STRLEN), so the 60k-entry case below
    // spawns fine on macOS and fails with E2BIG on CI.
    const classifier = `set -uo pipefail\nfiles="$(cat "$1")"\n${full
      .slice(start, end)
      .replace(/echo "::notice::[^\n]*\n/g, '')
      .replace(/echo "verdict=n\/a" >> "\$GITHUB_OUTPUT"/, 'echo NA')
      .replace(/echo "decision=na" >> "\$GITHUB_OUTPUT"/, '')}\necho RUN`;
    const dir = mkdtempSync(join(tmpdir(), 'verify-classify-'));
    const classify = (files) => {
      const listFile = join(dir, 'files.txt');
      writeFileSync(listFile, files);
      const proc = spawnSync('bash', ['-c', classifier, '_', listFile], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
      // Surface a spawn failure as itself, not as a TypeError on undefined.
      expect(proc.error ?? null).toBe(null);
      expect(typeof proc.stdout).toBe('string');
      return proc.stdout.trim().split('\n').pop();
    };

    try {
      const bigEarlyCode = [
        'packages/core/src/a.ts',
        ...Array.from({ length: 60000 }, (_, i) => `docs/f${i}.md`),
      ].join('\n');
      expect(classify(bigEarlyCode)).toBe('RUN');
      expect(classify('docs/a.md\nREADME.md\nassets/x.png')).toBe('NA');
      expect(classify('.qwen/skills/verify-pr/SKILL.md')).toBe('RUN');
      expect(classify('.github/workflows/x.yml')).toBe('RUN');
      expect(classify('scripts/lint.js')).toBe('RUN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Symlink stripping must happen AFTER the artifacts are copied in;
  // moving it earlier would keep a presence-only assertion green while
  // copied symlinks still reach upload-artifact, which dereferences them.
  it('strips symlinks after collecting artifacts, not before', () => {
    const runStep = step('Run verification agent');
    const copy = runStep.indexOf(
      '-exec cp -r {} "$RUNNER_TEMP/verify-results/"',
    );
    const strip = runStep.indexOf(
      'find "$RUNNER_TEMP/verify-results" \\( -type l -o -type p -o -type s -o -type b -o -type c \\) -delete',
    );
    expect(copy).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(copy);
  });

  // The trust boundary is re-established after the PR's lifecycle scripts:
  // kill leftover build processes, re-pin the verifier root-owned, and give
  // the agent a fresh home before it starts.
  it('re-establishes the verifier trust boundary after the build', () => {
    const runStep = step('Run verification agent');
    const kill = runStep.indexOf('pkill -KILL -u node');
    const repin = runStep.indexOf('git archive "$BASE_OID" -- .qwen');
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
    // fail the step rather than race the sweeps that follow. The check
    // disregards zombies — see the build-process-guard suite for why.
    expect(runStep).toContain('live_build_processes');
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
    // No glob below a PR-writable parent, anywhere in the job...
    expect(code).not.toContain('rm -rf .qwen/tmp/*');
    // ...and BOTH cleanups (job start and job end) unlink a symlink rather
    // than recursing through it. PR code runs between them, so the end is
    // no safer than the start.
    const guards = code.match(/if \[ -L \.qwen\/tmp \]; then/g) ?? [];
    expect(guards.length).toBe(2);
    expect((code.match(/\[ -L \.qwen \] && rm -f \.qwen/g) ?? []).length).toBe(
      2,
    );
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
  // it end to end against a local OSS uploader stub.
  it('hosts only valid, unique, in-limit PNGs and degrades to text', () => {
    const publishStep = step('Post verification report comment');
    const script = publishStep
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    const dir = mkdtempSync(join(tmpdir(), 'verify-imgs-'));
    const sh = (cmd, opts = {}) =>
      spawnSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts });
    try {
      // The uploader stub preserves the object layout while avoiding network
      // access, and enforces the real uploader's flag contract: the workflow
      // must pass --bucket, --config and --prefix with values, or the
      // harness fails exactly where production would silently degrade every
      // report to text-only. The gh stub captures the rendered report body.
      writeFileSync(
        join(dir, 'upload-assets'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'if [ "${OSS_STUB_FAIL:-}" = 1 ]; then exit 1; fi',
          'bucket=""; config=""; prefix=""',
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          '    --bucket) bucket="$2"; shift 2 ;;',
          '    --config) config="$2"; shift 2 ;;',
          '    --prefix) prefix="$2"; shift 2 ;;',
          '    *) break ;;',
          '  esac',
          'done',
          'if [ -z "$bucket" ] || [ -z "$config" ] || [ -z "$prefix" ]; then',
          '  echo "upload-assets stub: --bucket, --config and --prefix are all required" >&2',
          '  exit 1',
          'fi',
          // The real uploader hands --config to ossutil, which dies on a
          // missing file: checking it here means a workflow mutation that
          // drifts the flag away from the credential file the configure
          // step writes turns the harness red instead of staying green.
          'if [ ! -f "$config" ]; then',
          '  echo "upload-assets stub: --config file does not exist: $config" >&2',
          '  exit 1',
          'fi',
          'target="$OSS_STUB_ROOT/$bucket/$prefix"',
          'mkdir -p "$target"',
          'for file in "$@"; do cp "$file" "$target/$(basename "$file")"; done',
        ].join('\n'),
        { mode: 0o755 },
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

      // The stub arm receives --config "${RUNNER_TEMP}/.ossutilconfig" and
      // (like the real uploader's ossutil) refuses to run without that
      // file, so seed the configure step's product for the stub runs. The
      // production arms below manage the file explicitly instead.
      writeFileSync(join(dir, '.ossutilconfig'), '[Credentials]\n');

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
          ALIYUN_OSS_BUCKET: 'assets-bucket',
          ALIYUN_OSS_PUBLIC_BASE_URL: 'https://assets.example.test',
          VERIFY_ASSETS_UPLOADER: join(dir, 'upload-assets'),
          OSS_STUB_ROOT: join(dir, 'oss'),
        },
      });
      expect(res.status).toBe(0);
      const hosted = readdirSync(
        join(dir, 'oss', 'assets-bucket', 'pr-assets', 'verify', 'pr7999-77-1'),
      );
      // Valid + at the exact 2 MiB boundary are hosted; the text file, the
      // oversize file and the duplicate name are not.
      expect(hosted.sort()).toEqual(['01-ab.png', '04-edge.png']);
      const comment = readFileSync(out, 'utf8');
      expect(comment).toContain(
        '![01-ab](https://assets.example.test/pr-assets/verify/pr7999-77-1/01-ab.png)',
      );
      expect(comment).not.toContain('02-fake');
      expect(comment).toContain('did not pass the hosting checks');

      // Upload failure -> text-only, never an aborted report.
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
          ALIYUN_OSS_BUCKET: 'assets-bucket',
          ALIYUN_OSS_PUBLIC_BASE_URL: 'https://assets.example.test',
          VERIFY_ASSETS_UPLOADER: join(dir, 'upload-assets'),
          OSS_STUB_ROOT: join(dir, 'oss'),
          OSS_STUB_FAIL: '1',
        },
      });
      expect(res2.status).toBe(0);
      const comment2 = readFileSync(out2, 'utf8');
      expect(comment2).toContain('Sandboxed verification');
      expect(comment2).not.toContain('Evidence images');

      // A later run gets an immutable prefix instead of overwriting or
      // accumulating commits in the same Git ref.
      const out3 = join(dir, 'comment3.md');
      const res3 = sh(script, {
        cwd: work,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_STUB_OUT: out3,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_RUN_ID: '79',
          GITHUB_RUN_ATTEMPT: '1',
          PR_NUMBER: '7999',
          RUN_URL: 'u',
          VERIFY_RESULT: 'success',
          VERDICT: 'pass',
          AGENT_VERDICT: 'findings',
          SKIP_REASON: '',
          PREPARE_FAILURE_PHASE: '',
          ALIYUN_OSS_BUCKET: 'assets-bucket',
          ALIYUN_OSS_PUBLIC_BASE_URL: 'https://assets.example.test',
          VERIFY_ASSETS_UPLOADER: join(dir, 'upload-assets'),
          OSS_STUB_ROOT: join(dir, 'oss'),
        },
      });
      expect(res3.status).toBe(0);
      expect(
        readdirSync(
          join(
            dir,
            'oss',
            'assets-bucket',
            'pr-assets',
            'verify',
            'pr7999-79-1',
          ),
        ).sort(),
      ).toEqual(['01-ab.png', '04-edge.png']);
      expect(readFileSync(out3, 'utf8')).toContain(
        'https://assets.example.test/pr-assets/verify/pr7999-79-1/01-ab.png',
      );

      // The production arms below run WITHOUT the seeded credential file
      // until the success arm writes it back — the missing-file case is
      // exactly what res4b asserts on.
      rmSync(join(dir, '.ossutilconfig'));

      // An ossutil install failure is expected to degrade to a text-only
      // report. This executes the production dispatch arm without touching
      // the network and pins its successful return under set -e.
      const out4 = join(dir, 'comment4.md');
      const res4 = sh(script, {
        cwd: work,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_STUB_OUT: out4,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_RUN_ID: '80',
          GITHUB_RUN_ATTEMPT: '1',
          PR_NUMBER: '7999',
          RUN_URL: 'u',
          VERIFY_RESULT: 'success',
          VERDICT: 'pass',
          AGENT_VERDICT: 'findings',
          SKIP_REASON: '',
          PREPARE_FAILURE_PHASE: '',
          ALIYUN_OSS_BUCKET: 'assets-bucket',
          ALIYUN_OSS_PUBLIC_BASE_URL: 'https://assets.example.test',
          OSSUTIL_INSTALL_OUTCOME: 'failure',
          OSS_STUB_ROOT: join(dir, 'oss'),
        },
      });
      expect(res4.status).toBe(0);
      const comment4 = readFileSync(out4, 'utf8');
      expect(comment4).toContain('Sandboxed verification');
      expect(comment4).not.toContain('Evidence images');

      // Install green but NO credential file: the configure step is
      // continue-on-error, so this is what a missing/rotated OSS secret
      // looks like from here. The publisher must degrade to text rather
      // than hand the uploader a config it cannot read and pay three
      // retry backoffs per image to learn that.
      const out4b = join(dir, 'comment4b.md');
      const res4b = sh(script, {
        cwd: work,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_STUB_OUT: out4b,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_RUN_ID: '80',
          GITHUB_RUN_ATTEMPT: '2',
          PR_NUMBER: '7999',
          RUN_URL: 'u',
          VERIFY_RESULT: 'success',
          VERDICT: 'pass',
          AGENT_VERDICT: 'findings',
          SKIP_REASON: '',
          PREPARE_FAILURE_PHASE: '',
          ALIYUN_OSS_BUCKET: 'assets-bucket',
          ALIYUN_OSS_PUBLIC_BASE_URL: 'https://assets.example.test',
          OSSUTIL_INSTALL_OUTCOME: 'success',
          OSS_STUB_ROOT: join(dir, 'oss'),
        },
      });
      expect(res4b.status).toBe(0);
      expect(existsSync(join(dir, '.ossutilconfig'))).toBe(false);
      const comment4b = readFileSync(out4b, 'utf8');
      expect(comment4b).toContain('Sandboxed verification');
      expect(comment4b).not.toContain('Evidence images');

      // Exercise the production success dispatch too: copy the verified
      // binary into a job-private PATH and run the real uploader through it.
      const realUploader = readFileSync(
        'scripts/upload-aliyun-oss-assets.js',
        'utf8',
      );
      const realUtils = readFileSync('scripts/release-script-utils.js', 'utf8');
      mkdirSync(join(work, 'scripts'), { recursive: true });
      writeFileSync(
        join(work, 'scripts', 'upload-aliyun-oss-assets.js'),
        realUploader,
      );
      writeFileSync(
        join(work, 'scripts', 'release-script-utils.js'),
        realUtils,
      );
      writeFileSync(
        join(dir, 'ossutil'),
        [
          '#!/bin/bash',
          'set -euo pipefail',
          '[ "$1" = cp ]',
          'src="$2"; dest="$3"',
          'target="$OSS_STUB_ROOT/${dest#oss://}"',
          '/bin/mkdir -p "$(/usr/bin/dirname "$target")"',
          '/bin/cp "$src" "$target"',
        ].join('\n'),
        { mode: 0o755 },
      );
      // The configure step's product. The stub ossutil ignores -c, but the
      // publisher now refuses to dispatch without it — as production does.
      writeFileSync(join(dir, '.ossutilconfig'), '[Credentials]\n');
      const out5 = join(dir, 'comment5.md');
      const res5 = sh(script, {
        cwd: work,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_STUB_OUT: out5,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: '/dev/null',
          GITHUB_RUN_ID: '81',
          GITHUB_RUN_ATTEMPT: '1',
          PR_NUMBER: '7999',
          RUN_URL: 'u',
          VERIFY_RESULT: 'success',
          VERDICT: 'pass',
          AGENT_VERDICT: 'findings',
          SKIP_REASON: '',
          PREPARE_FAILURE_PHASE: '',
          ALIYUN_OSS_BUCKET: 'assets-bucket',
          ALIYUN_OSS_PUBLIC_BASE_URL: 'https://assets.example.test',
          OSSUTIL_INSTALL_OUTCOME: 'success',
          OSS_STUB_ROOT: join(dir, 'oss-production'),
        },
      });
      if (res5.status !== 0) {
        throw new Error(
          `production dispatch failed:\n${res5.stdout}\n${res5.stderr}`,
        );
      }
      expect(
        readdirSync(
          join(
            dir,
            'oss-production',
            'assets-bucket',
            'pr-assets',
            'verify',
            'pr7999-81-1',
          ),
        ).sort(),
      ).toEqual(['01-ab.png', '04-edge.png']);
      expect(readFileSync(out5, 'utf8')).toContain(
        'https://assets.example.test/pr-assets/verify/pr7999-81-1/01-ab.png',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The behavioural runs above either stub the uploader via
  // VERIFY_ASSETS_UPLOADER or (res5) already exercise the production
  // ossutil arm end-to-end through the real uploader. Pin the full
  // invocation shape as well: node must resolve under the inherited PATH
  // (never $RUNNER_TEMP — PATH hijack) and all three ossutil flags must be
  // present — the real uploader exits 1 on a valueless --config, which in
  // production silently degrades every /verify report to text-only.
  it('pins the production uploader invocation and its ossutil flags', () => {
    const script =
      stepIn('publish-verify', 'Post verification report comment').match(
        /run: \|-\n([\s\S]*)$/,
      )?.[1] ?? '';
    expect(script).toContain('node_bin="$(command -v node || true)"');
    expect(script).toContain('upload_cmd=("$node_bin" "$uploader")');
    expect(script).toContain('upload_path="$trusted_bin"');
    expect(script).toContain('if ! PATH="$upload_path" "${upload_cmd[@]}"');
    expect(script).not.toContain('PATH="$RUNNER_TEMP:$PATH"');
    expect(script).toContain('--bucket "$ALIYUN_OSS_BUCKET"');
    expect(script).toContain('--config "${RUNNER_TEMP:-/tmp}/.ossutilconfig"');
    expect(script).toContain('--prefix "$prefix"');
  });

  // The credential lifecycle is security-relevant: dropping the cleanup
  // (or its always() condition) leaves the OSS key pair in $RUNNER_TEMP —
  // not exploitable on today's ephemeral ubuntu-latest runner, but the
  // shape must not regress if the job ever returns to a persistent pool.
  // A dropped sha256 check installs whatever the mirror serves. Consumers
  // must also trust the Actions-computed outcome, never a marker in the
  // PR-writable temp dir.
  it('pins the ossutil install/configure/cleanup credential lifecycle', () => {
    const install = stepIn('publish-verify', 'Install ossutil');
    expect(install).toContain("id: 'install-ossutil'");
    expect(install).toContain('continue-on-error: true');
    expect(install).toContain('sha256sum -c');
    const configure = stepIn(
      'publish-verify',
      'Configure Aliyun OSS credentials',
    );
    expect(configure).toContain(
      'if: "${{ steps.install-ossutil.outcome == \'success\' }}"',
    );
    expect(configure).toContain('continue-on-error: true');
    expect(configure).toContain('-c "$RUNNER_TEMP/.ossutilconfig"');
    const publish = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    expect(publish).toContain(
      "OSSUTIL_INSTALL_OUTCOME: '${{ steps.install-ossutil.outcome }}'",
    );
    // Both preconditions: the Actions-computed install outcome (never a
    // marker in the PR-writable temp dir) AND the credential file the
    // continue-on-error configure step is supposed to have written.
    expect(publish).toContain(
      'elif [ "${OSSUTIL_INSTALL_OUTCOME:-}" = \'success\' ] &&',
    );
    expect(publish).toContain(
      '[ -f "${RUNNER_TEMP:-/tmp}/.ossutilconfig" ]; then',
    );
    const cleanup = stepIn('publish-verify', 'Cleanup Aliyun OSS credentials');
    expect(cleanup).toContain("if: '${{ always() }}'");
    expect(cleanup).toContain('rm -f "$RUNNER_TEMP/.ossutilconfig"');
  });

  // The publisher's checkout is the trust boundary for this job's OSS
  // credentials: it must take only the trusted base-repo scripts, from the
  // default-branch head (publish-verify only runs under issue_comment
  // events, where github.sha is exactly that — never a PR merge ref).
  // Dropping /package.json stops the uploader's `.js` parsing as ESM on
  // Node versions that don't infer module syntax, and this job pins no Node.
  it('checks out only trusted base-repo scripts at a pinned ref', () => {
    const checkout = stepIn(
      'publish-verify',
      'Checkout the OSS publisher scripts',
    );
    expect(checkout).toContain("ref: '${{ github.sha }}'");
    expect(checkout).toContain('persist-credentials: false');
    expect(checkout).toContain('sparse-checkout-cone-mode: false');
    for (const entry of [
      '/package.json',
      'scripts/upload-aliyun-oss-assets.js',
      'scripts/release-script-utils.js',
    ]) {
      expect(checkout).toContain(`\n            ${entry}\n`);
    }
  });

  // A CDN retry loop whose worst case exceeds the 10-minute job cap turns
  // the intended "degrade to a text-only report" into "job killed
  // mid-install"; pin the retry flags and compute the bound.
  it('keeps the ossutil download retry budget inside the job cap', () => {
    const install = stepIn('publish-verify', 'Install ossutil');
    expect(install).toContain('--retry-all-errors');
    const m = install.match(
      /curl -fsSL --retry (\d+) --retry-delay (\d+) --retry-all-errors \\\n\s+--connect-timeout (\d+) --max-time (\d+)/,
    );
    expect(m).not.toBeNull();
    const worstSeconds =
      (Number(m[1]) + 1) * Number(m[4]) + Number(m[1]) * Number(m[2]);
    const cap = job('publish-verify').match(/timeout-minutes: (\d+)/);
    expect(cap).not.toBeNull();
    expect(worstSeconds).toBeLessThan(Number(cap[1]) * 60);
  });

  // Overriding only one of the bucket/base-URL vars must not post comment
  // links that 404 against (or show stale objects from) the other bucket:
  // the default base URL is derived from whichever bucket wins. A stalled
  // upload is additionally bounded per attempt so one black-hole socket
  // cannot burn the job cap and lose the whole report.
  it('derives the public URL from the resolved bucket and bounds uploads', () => {
    const publish = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    expect(publish).toContain(
      'ALIYUN_OSS_BUCKET: "${{ vars.ALIYUN_OSS_PR_ASSETS_BUCKET || vars.ALIYUN_OSS_BUCKET || \'qwen-code-assets\' }}"',
    );
    expect(publish).toContain(
      "ALIYUN_OSS_PUBLIC_BASE_URL: \"${{ vars.ALIYUN_OSS_PR_ASSETS_PUBLIC_BASE_URL || (vars.ALIYUN_OSS_PR_ASSETS_BUCKET == '' && vars.ALIYUN_OSS_PUBLIC_BASE_URL) || format('https://{0}.oss-cn-hangzhou.aliyuncs.com', vars.ALIYUN_OSS_PR_ASSETS_BUCKET || vars.ALIYUN_OSS_BUCKET || 'qwen-code-assets') }}\"",
    );
    expect(publish).toContain("OSS_UPLOAD_ATTEMPT_TIMEOUT_MS: '120000'");
  });

  // Every publish fixture returned [] for the comments listing, so the
  // PATCH arm — the one that must reuse a live status comment instead of
  // stranding it — was never executed by any test.
  it('patches a live status comment instead of posting a duplicate', () => {
    const publishStep = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    const script = publishStep
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    const dir = mkdtempSync(join(tmpdir(), 'verify-upsert-'));
    try {
      // The stub records which HTTP verb the publisher used and against
      // which comment id, and serves a comments listing from a fixture.
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/usr/bin/env bash',
          'all="$*"',
          'case "$all" in',
          '  *"api user"*|*" user "*) echo qwen-code-ci-bot ;;',
          '  *"-X PATCH"*) echo "PATCH $all" >> "$CALLS" ;;',
          '  *comments*--method*GET*) cat "$LISTING" ;;',
          '  *issues/*/comments*) echo "POST $all" >> "$CALLS" ;;',
          'esac',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      const art = join(dir, 'work', 'verify-results', 'prA-verify-1');
      mkdirSync(art, { recursive: true });
      writeFileSync(join(art, 'report.md'), '## real report\n');
      writeFileSync(
        join(art, 'assertions.json'),
        '{"pass":3,"fail":0,"total":3}',
      );
      const listing = join(dir, 'listing.json');
      const calls = join(dir, 'calls');
      const M = '<!-- qwen-triage:verify -->';
      const RUNNING = '<!-- qwen-triage:verify-state=running -->';
      const run = (comments, env = {}) => {
        writeFileSync(listing, JSON.stringify(comments));
        writeFileSync(calls, '');
        const res = spawnSync('bash', ['-c', script], {
          cwd: join(dir, 'work'),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            LISTING: listing,
            CALLS: calls,
            GH_STUB_OUT: join(dir, 'body.md'),
            GH_TOKEN: 'x',
            GITHUB_REPOSITORY: 'QwenLM/qwen-code',
            RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: '/dev/null',
            GITHUB_RUN_ID: '1',
            GITHUB_RUN_ATTEMPT: '1',
            PR_NUMBER: '7999',
            RUN_URL: 'u',
            VERIFY_RESULT: 'success',
            DOWNLOAD_OUTCOME: 'success',
            VERDICT: 'pass',
            AGENT_VERDICT: 'findings',
            SKIP_REASON: '',
            PREPARE_FAILURE_PHASE: '',
            ...env,
          },
        });
        expect(res.status).toBe(0);
        return readFileSync(calls, 'utf8');
      };

      // A live status comment owned by the bot must be PATCHed, not
      // duplicated — otherwise the "running" line is stranded forever.
      // One page of comments, matching `gh --paginate` output shape.
      const patched = run([
        {
          id: 555,
          user: { login: 'qwen-code-ci-bot' },
          body: `${M}\n${RUNNING}\n\nrunning`,
        },
      ]);
      expect(patched).toContain('PATCH');
      expect(patched).toContain('/issues/comments/555');
      expect(patched).not.toContain('POST');

      // No prior comment: post fresh.
      expect(run([])).toContain('POST');

      // A comment carrying the marker but owned by someone else must not be
      // touched; the report is posted fresh instead.
      const foreign = run([
        {
          id: 777,
          user: { login: 'someone-else' },
          body: `${M}\n${RUNNING}\n\nrunning`,
        },
      ]);
      expect(foreign).toContain('POST');
      expect(foreign).not.toContain('/issues/comments/777');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Verification techniques lifted from maintainer-written verification rounds that
  // the skill could not previously have produced. Each is pinned to the
  // failure it exists for, because a rule stated without its failure reads
  // as advice and gets skipped.
  it('carries the maintainer-round verification techniques', () => {
    const flat = verifySkill.replace(/\s+/g, ' ');

    // #7914 §4: the PR added write_file as a second writer into the shared
    // artifact store, and the store's pre-existing first-writer-wins merge
    // then silently discarded record_artifact's curated title. Nothing in
    // the old skill pointed at collisions between writers.
    expect(flat).toContain('new writer into a shared store');
    expect(flat).toContain('in both orders');
    expect(flat).toContain('what the loser is told');

    // ...and that finding surfaced from a control that existed to validate
    // the BASE probe, run identically on head.
    expect(flat).toContain('Run every control on BOTH arms');

    // #7998: the hardware cursor was read with a tmux query, then
    // corroborated by a post-exit marker — a second effect of the same fact
    // whose failure mode does not involve the query.
    expect(flat).toContain('corroborate it with a mechanism that does not use');

    // #7998 nit: re-running patch-package produced a byte-different file,
    // proving the committed hunks were hand-written.
    expect(flat).toContain('Re-run the generator and diff');

    // #7998 "what I did not verify": a blank harness was proved
    // environmental by booting base and head identically.
    expect(flat).toContain('A/A control');

    // #7934 R4 §1: a new guard turned a vacuous pass into a failure that is
    // deterministic on a fast machine. Sampling cannot find it from a
    // loaded CI box — only measuring the margin can, so the rule must say
    // measure and must say why repetition is the wrong instrument here.
    expect(flat).toContain('measure it, do not sample it');
    expect(flat).toContain('speed-correlated failure is not flake');
    expect(flat).toContain('You cannot reproduce a fast-machine failure');
    // The blocking verdict must be expressible in the contract, not just
    // asserted in prose: encode the margin as a scripted assertion so a
    // crossing distribution lands in `fail`.
    expect(flat).toContain('encoding the margin as a scripted assertion');

    // #7934 R4 §2: the abort cases fired during CLI startup, so the fake
    // server saw zero requests — a suite named for mid-stream aborts never
    // streamed, and every assertion passed.
    expect(flat).toContain('the scenario never reached the code under test');
    expect(flat).toContain('assert that count is non-zero');

    // #7836: both blockers had one root cause — a route and the child it
    // spawns asked the same question against different state (pinned vs
    // unpinned runtime dir), and a lazily-created backing file left a
    // window where a just-created session was invisible to any on-disk
    // existence check.
    expect(flat).toContain('the same predicate is checked in two places');
    expect(flat).toContain('is the state observable yet at all');
    expect(flat).toContain('blast radius on bystanders');

    // #7836: a whole-file revert removed a test's precondition, so a good
    // test looked vacuous. A false "your test is vacuous" is worse than a
    // missed survivor, so the rule must demand the finer mutation first.
    expect(flat).toContain('escalate to a finer mutation');

    // #7885: an npm cache claimed ~75% off npm ci; isolating the slice a
    // download cache can touch (--ignore-scripts) showed 36s of 226s, so
    // the real saving was 15% — and 33s off a 14m37s job at that.
    expect(flat).toContain('Isolate the slice the mechanism can actually');
    expect(flat).toContain('has a cost, not only a benefit');
    // ...and the severity of the finding it did have was bounded by
    // disproving the scarier readings.
    expect(flat).toContain('report which ones do NOT hold');

    // #7885: the PR said the cache dir was discarded after the job; the
    // action's own manifest declares a post-step that uploads it as root.
    expect(flat).toContain('their own manifest');

    // #7899: the shipped script was run verbatim against the live repo with
    // every mutating call hard-failing — real data, no possible side effect.
    expect(flat).toContain('interpose a refusing proxy on the write path');

    // #7862 R4: the fix bundled reduce() with an ordering change. A third
    // build with only the ordering change showed each half does a different
    // job — either alone leaves a channel that floods or wedges, which the
    // two-cell A/B cannot reach.
    expect(flat).toContain('build the intermediate variants');
    // ...and the same round bisected the RangeError threshold through the
    // real async stack, where it fired far below a micro-benchmark's number.
    expect(flat).toContain(
      'A limit measured in isolation does not transfer to the real call site',
    );
    // ...counting emitted envelopes instead of delivered prompts would have
    // hidden every gate on the path.
    expect(flat).toContain('count at the destination, not at the component');

    // #8147 R6: a composer-step replay whose base arm reproduced the
    // production step's real posted comment byte-for-byte (allowed diffs
    // named: run id, assets block) — without that calibration the A/B
    // measures the harness, not the PR.
    expect(flat).toContain('Calibrate the replay before believing it');

    // #8147 R6: the verbatim-extraction half of the workflow/CI bullet —
    // a YAML parser, not retyping; bash --noprofile --norc plus the step's
    // own set line. Without this the calibration half is pinned but the
    // extraction discipline that feeds it is not.
    expect(flat).toContain('a YAML parser, not retyping');
    expect(flat).toContain('bash --noprofile --norc');

    // #8147 R6 §4: round 6 taught the sanitizer that a fence inside a
    // raw-HTML block is not a fence; the backtick code-span door next to
    // it was still open, and a list-nested fold never entered the state at
    // all. Same root cause, one level down — found by walking the
    // neighbouring doors, not by re-testing the reported shape.
    expect(flat).toContain('gets its siblings swept');

    // #8147 R6: the fix's new test drove the fence form only, so the suite
    // was green with and without the two-line patch — proof the code-span
    // axis was unpinned, visible only by running the mutation in reverse.
    expect(flat).toContain('cannot tell head from head-plus-fix');

    // #8147 R6 §5: a deferred mangling artifact got WORSE (5 visible
    // characters became 8) in exactly the shapes the base rendered
    // correctly — the follow-up status enum needs a cell for that, and
    // declined/deferred rows must be re-measured, not carried.
    expect(flat).toContain(
      'fixed / stands / worsened / superseded / declined-with-rationale',
    );

    // #8147 R6 §5: the enum alone does not pin the re-measurement rule —
    // deleting "declined and deferred rows are not exempt" would leave
    // the enum assertion green while the normative sentence is gone.
    expect(flat).toContain(
      'Declined and deferred rows are not exempt from re-measurement',
    );

    // #8147 R6 §6: the PR named links and images as the accepted rendering
    // cost; issue cross-references were the unnamed sibling that also
    // fired, stamping timeline events under the bot identity.
    expect(flat).toContain('An accepted-tradeoff list is a completeness claim');

    // #8147 R6: the two-line suggested fix shipped with measured zero
    // collateral — hostile fixtures clean, benign fixtures byte-identical,
    // suite green — which is what separates evidence from a guess.
    expect(flat).toContain('A suggested fix is measured, not eyeballed');

    // #8215 §1: an ambiguous line regex ran per line over the PR body and
    // went 0.96s/3.2s/14.4s/>100s on 2k/3k/5k/20k spaces. A single sample
    // is 0.0ms and proves nothing — only the ladder shows the curve, and
    // only tracing the body to a fork contributor makes it a finding.
    expect(flat).toContain(
      'Untrusted text reaching a parser is a scaling question',
    );
    expect(flat).toContain('ladder');
    expect(flat).toContain('claimed escape hatch really excludes the path');

    // #8215 §3: "one extra build per review, at most" was a line in an
    // agent brief, while Step 4 launched ceil(N/8) shards that each got
    // the same unleased worktree. The benign interleaving crashes; the
    // one that matters returns an empty BASE arm that reads as a real
    // behavioural difference and is quoted as deterministic evidence.
    expect(flat).toContain('An instruction in a prompt is not an invariant');
    expect(flat).toContain('rank the interleavings by what they produce');
    expect(flat).toContain(
      'A race that fabricates a result outranks a race that crashes',
    );

    // #8215 §4: the test titled "past a workspace flag" used a fixture
    // where the flag trails the script, so it stepped over nothing — the
    // shapes that break are the ones the title claims. Not vacuity: the
    // assertion can fail and the scenario runs; the fixture is just wrong.
    expect(flat).toContain("a test's name is a claim about its fixture");

    // #8215 §8: the PR priced a base worktree as "one extra build" while
    // the sibling probe tree in the same subsystem documents that a
    // repo-nested tree needs no per-tree install. One of the two accounts
    // is wrong and the reviewer pays whichever it is.
    expect(flat).toContain("audit it against the repo's own accounting");

    // #8037 F1: the recovery guard keyed on a length ratio, so whether it
    // fired depended on payload size. Holding the issue's own 1898-char
    // preamble fixed and varying only the tool showed run_shell_command —
    // named in the issue — declined at these sizes. The report enumerates
    // the cases; the fix inherits them.
    expect(flat).toContain('The bug report is a coverage specification');

    // #8037 F2: the same unescaped parser either dropped a required arg
    // (schema-rejected, loud) or silently truncated a file. Same defect,
    // and the silent half is the one to fix first — the same ordering as
    // the fabricating-race rule.
    expect(flat).toContain("Rank a defect's variants by observability");

    // #8037 "Not verified": the harness replayed the exact wire bytes of
    // the reported failure but not the model-side degradation producing
    // them. A reader otherwise credits an end-to-end reproduction.
    expect(flat).toContain('not the model-side degradation that produces it');

    // #8005 test plan: step 3 asked the reviewer to insert real user input
    // into an active turn. No code path does that — and the unrunnable
    // step was the round's sharpest finding, because it meant the
    // feature's own completion criterion was unreachable.
    expect(flat).toContain("Walk the PR's own Reviewer Test Plan step by step");

    // #8005 F1b: the static chain said the user_input branch was
    // unreachable; 30 captured verifier payloads carried only
    // delivered_output, which is what turned a reading into a proof.
    expect(flat).toContain('Prove a negative by census, not by reading');

    // #8005 F3: two mutations survived 429/429 and 326/326 — believable
    // only because a third, expected-caught mutation turned one test red.
    // Without it, "no coverage" and "harness never ran" look identical.
    expect(flat).toContain(
      'A surviving mutation needs a positive control before it becomes a',
    );

    // #8132: a cookie->Authorization bridge was gated to the desktop shell
    // on the MINTING side, while the accepting middleware was mounted
    // unconditionally, so every server treated that cookie as a bearer. The
    // tests were named after the gated end, which is what made the ungated
    // end look covered.
    expect(flat).toContain('A capability has two ends');
    expect(flat).toContain('tests are named after the gated end');

    // #8261: `emptyDiff` was set both for a genuinely empty PR and for a
    // FAILED diff capture, and the consumer answered it by recommending the
    // PR be closed as superseded — a transient fetch error closing live
    // work. The flag is not the defect; the consumer is.
    expect(flat).toContain('must be different values');
    expect(flat).toContain('check what consumes them');

    // #8261: the re-classifier that demotes a dead harness's findings ran
    // after the findings list was assembled, so a harness proven dead still
    // filed `mutant-survived`. A control that runs late is not a control.
    expect(flat).toContain(
      'A validity control must run before the artifact it invalidates',
    );
  });

  // PR #7836's report said "Verdict: merge-ready — the 7 failures are all
  // expected A/B base-cell failures proving the tests are load-bearing"
  // while assertions.json said fail:7 — so the publisher's trust rule
  // (merge-ready requires fail==0) correctly refused it and the headline
  // degraded to "no usable structured verdict". Both sides told the truth
  // about different questions. The fix is the counting semantics: a control
  // cell that fails AS PREDICTED is a passed assertion.
  it('defines expected failures as passes in the assertion contract', () => {
    const rules = verifySkill
      .slice(verifySkill.indexOf('## Hard rules'))
      .replace(/\s+/g, ' ');
    expect(rules).toContain('Expected failures are passes');
    expect(rules).toContain('assert the control goes red');
    expect(rules).toContain('counts only UNEXPECTED outcomes');
    // The rule must state the publisher-side consequence, or an agent has no
    // reason to believe the count semantics are load-bearing.
    expect(rules).toContain('cannot be `merge-ready`');
    expect(rules).toContain('`inconclusive`, not `findings`');
    // And it must sit in Hard rules, not in narrative prose.
    expect(verifySkill.indexOf('Expected failures are passes')).toBeGreaterThan(
      verifySkill.indexOf('## Hard rules'),
    );
  });

  // The whole report is already inside a <details> on the PR. With the
  // Chinese summary as the last item, reaching it meant expanding that fold
  // and scrolling the entire English report — ~90 lines on a real one.
  it('puts the report Chinese summary next to the verdict, not last', () => {
    const struct = verifySkill.slice(
      verifySkill.indexOf('### report.md structure'),
      verifySkill.indexOf('## Hard rules'),
    );
    expect(struct).toBeTruthy();
    const zh = struct.indexOf('中文摘要');
    expect(zh).toBeGreaterThan(-1);
    expect(zh).toBeLessThan(struct.indexOf('Central claim + A/B table'));
    expect(zh).toBeLessThan(struct.indexOf('**Not covered**'));
    expect(zh).toBeLessThan(struct.indexOf('**Methodology**'));
    // Moved, not duplicated — two summaries would drift apart.
    expect(struct.match(/中文摘要/g)?.length).toBe(1);
  });

  // Only a validated assertions object counts as evidence.
  it('rejects inconsistent assertions objects', () => {
    const publishStep = step('Post verification report comment');
    expect(publishStep).toContain('.total == .pass + .fail');
    expect(publishStep).toContain('all(type == "number" and . >= 0');
  });
});

describe('qwen-triage verify publish fidelity', () => {
  const publishScript = () =>
    step('Post verification report comment')
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');

  // Render the publisher for a given outcome with a stubbed gh, and return
  // the comment body it would post.
  const render = (dir, env) => {
    const out = join(dir, `body-${env.NAME}.md`);
    const work = join(dir, 'work');
    const res = spawnSync('bash', ['-c', publishScript()], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_STUB_OUT: out,
        GH_TOKEN: 'x',
        GITHUB_REPOSITORY: 'QwenLM/qwen-code',
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: '/dev/null',
        GITHUB_RUN_ID: '1',
        GITHUB_RUN_ATTEMPT: '1',
        PR_NUMBER: '7999',
        RUN_URL: 'u',
        VERIFY_RESULT: 'success',
        DOWNLOAD_OUTCOME: 'success',
        VERDICT: 'pass',
        AGENT_VERDICT: '',
        SKIP_REASON: '',
        PREPARE_FAILURE_PHASE: '',
        ...env,
      },
    });
    expect(res.status).toBe(0);
    return readFileSync(out, 'utf8');
  };

  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-publish2-'));
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
    const art = join(dir, 'work', 'verify-results', 'prA-verify-1');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, 'report.md'), '## real report\n');
    writeFileSync(
      join(art, 'assertions.json'),
      '{"pass":10,"fail":0,"total":10}',
    );
    writeFileSync(
      join(dir, 'work', 'verify-results', 'prepare.log'),
      'npm ERR boom\n',
    );
    return dir;
  };

  // The artifact download is continue-on-error, so the publisher can run
  // with no results at all. It must say so instead of rendering the
  // completed-method paragraph over an empty report.
  it('does not claim the phases ran when the artifact never arrived', () => {
    const dir = fixture();
    try {
      const body = render(dir, {
        NAME: 'dl',
        DOWNLOAD_OUTCOME: 'failure',
        AGENT_VERDICT: 'merge-ready',
      });
      expect(body).toContain('results unavailable');
      expect(body).not.toContain('A/B against the base build');
      expect(body).not.toContain('merge-ready');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every weak terminal body carries the qualitative prefix and folds its
  // Chinese into <details>, matching the full-report path's layout.
  it('renders weak terminal bodies with qualitative glyphs and folded Chinese', () => {
    const dir = fixture();
    try {
      const cancelled = render(dir, {
        NAME: 'wk-cancelled',
        VERIFY_RESULT: 'cancelled',
      });
      expect(cancelled).toContain('\u26a0\ufe0f incomplete \u2014 cancelled');
      expect(cancelled).toContain('<details>');
      expect(cancelled).toContain(
        '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a\u26a0\ufe0f \u672a\u5b8c\u6210 \u00b7 \u5df2\u53d6\u6d88</summary>',
      );

      const infra = render(dir, {
        NAME: 'wk-infra',
        VERIFY_RESULT: 'failure',
        VERDICT: '',
      });
      expect(infra).toContain(
        '\u26a0\ufe0f incomplete \u2014 infrastructure failure',
      );
      expect(infra).toContain('<details>');
      expect(infra).toContain(
        '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a\u26a0\ufe0f \u672a\u5b8c\u6210 \u00b7 \u57fa\u7840\u8bbe\u65bd\u6545\u969c</summary>',
      );

      const skipped = render(dir, {
        NAME: 'wk-skipped',
        VERDICT: 'skipped',
        SKIP_REASON: 'the PR is a draft',
      });
      expect(skipped).toContain('\u26a0\ufe0f not run \u2014 skipped');
      expect(skipped).toContain('the PR is a draft');
      expect(skipped).toContain('<details>');
      expect(skipped).toContain(
        '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a\u26a0\ufe0f \u672a\u8fd0\u884c \u00b7 \u5df2\u8df3\u8fc7</summary>',
      );

      const na = render(dir, { NAME: 'wk-na', VERDICT: 'n/a' });
      expect(na).toContain('\u26a0\ufe0f not run \u2014 n/a');
      expect(na).toContain('<details>');
      expect(na).toContain(
        '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a\u26a0\ufe0f \u672a\u8fd0\u884c \u00b7 \u4e0d\u9002\u7528</summary>',
      );
      // The Chinese body must be INSIDE the fold, not unfolded below.
      const naDetails = na.indexOf('<details>');
      const naZh = na.indexOf('\u8be5 PR \u4ec5\u6539\u52a8\u6587\u6863');
      expect(naZh).toBeGreaterThan(naDetails);

      const dl = render(dir, {
        NAME: 'wk-dl',
        DOWNLOAD_OUTCOME: 'failure',
      });
      expect(dl).toContain(
        '\u26a0\ufe0f incomplete \u2014 results unavailable',
      );
      expect(dl).toContain('<details>');
      expect(dl).toContain(
        '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a\u26a0\ufe0f \u672a\u5b8c\u6210 \u00b7 \u7ed3\u679c\u4e0d\u53ef\u7528</summary>',
      );
      const dlDetails = dl.indexOf('<details>');
      const dlZh = dl.indexOf('\u9a8c\u8bc1\u5df2\u6267\u884c');
      expect(dlZh).toBeGreaterThan(dlDetails);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The prepare step classifies install/build failures; the comment must
  // agree with that classification instead of always blaming the PR.
  it('reports an infra-classified prepare failure as infrastructure', () => {
    const dir = fixture();
    try {
      const infra = render(dir, {
        NAME: 'infra',
        VERDICT: 'infra-error',
        PREPARE_FAILURE_PHASE: 'install',
      });
      expect(infra).toContain('infrastructure failure');
      expect(infra).not.toContain('treated as a PR failure');
      // The qualitative glyph is what a swapped assignment would corrupt
      // while every substring above still matched: an infra incident is
      // nobody's-fault (warning); a real build failure is the PR's (cross).
      expect(infra).toContain(
        '\u26a0\ufe0f incomplete \u2014 infrastructure failure',
      );
      expect(infra).toContain(
        '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a\u26a0\ufe0f \u672a\u5b8c\u6210 \u00b7 \u57fa\u7840\u8bbe\u65bd\u6545\u969c</summary>',
      );

      const real = render(dir, {
        NAME: 'fail',
        VERDICT: 'fail',
        PREPARE_FAILURE_PHASE: 'install',
      });
      expect(real).toContain('treated as a PR failure');
      expect(real).toContain('npm ci');
      // The install is retried, so this sentence is blaming the PR for two
      // consecutive failures and has to say which. Without the count a
      // reader cannot tell this verdict from the single-shot one that
      // mis-blamed a PR for an ETXTBSY race.
      expect(real).toContain('failed twice in a row');
      expect(real).toContain(
        '\u274c not passed \u2014 the PR could not be built',
      );
      expect(real).toContain(
        '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a\u274c \u4e0d\u901a\u8fc7 \u00b7 PR \u6784\u5efa\u5931\u8d25</summary>',
      );
      // The retry clause has a Chinese counterpart on this same arm; pin
      // it so a dropped PREPARE_ATTEMPTS_ZH interpolation cannot ship silent.
      expect(real).toContain('\u8fde\u7eed\u4e24\u6b21');

      // The build arm of the phase mapping was never rendered by any test,
      // so a typo in that command name would have shipped unnoticed.
      const buildPhase = render(dir, {
        NAME: 'buildfail',
        VERDICT: 'fail',
        PREPARE_FAILURE_PHASE: 'build',
      });
      expect(buildPhase).toContain('npm run build');
      expect(buildPhase).not.toContain('`npm ci` failed');
      // The build is single-shot, so the retry clause must not leak onto it.
      expect(buildPhase).not.toContain('twice in a row');

      // Same arm, but with the clause pre-seeded in the environment. This
      // is what makes the explicit `PREPARE_ATTEMPTS=''` load-bearing
      // rather than decorative: defaulting it at the point of use (
      // `${PREPARE_ATTEMPTS:-}`) does nothing against an inherited value,
      // and the result would be a report claiming a single-shot build had
      // failed twice.
      const seededBuild = render(dir, {
        NAME: 'buildfail-seeded',
        VERDICT: 'fail',
        PREPARE_FAILURE_PHASE: 'build',
        PREPARE_ATTEMPTS: ' twice in a row',
      });
      expect(seededBuild).toContain('npm run build');
      expect(seededBuild).not.toContain('twice in a row');

      // An unrecognized phase must degrade, not mislabel.
      const unknownPhase = render(dir, {
        NAME: 'weirdphase',
        VERDICT: 'fail',
        PREPARE_FAILURE_PHASE: 'sideways',
      });
      expect(unknownPhase).toContain('install/build');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Only bodies carrying findings are substantive; weak notices must not be
  // snapshotted as the previous round's report.
  // The scope disclaimer under the headline has been bilingual since the
  // lane shipped, but the verdict itself — the one line a reader acts on —
  // was English-only. A Chinese reader got the caveat and not the
  // conclusion.
  it('leads every verdict with a distinct qualitative call, bilingually', () => {
    // "merge-ready (agent verdict)" is lane jargon; the maintainer asked for
    // pass/no-pass. Every arm now leads with a qualitative call, and only
    // agent verdicts may claim passed/not-passed — a crashed, timed-out, or
    // verdict-less run says nothing about the PR and must render as
    // incomplete/inconclusive, never as a pass or a fail.
    const dir = fixture();
    try {
      const ARMS = [
        [
          { VERDICT: 'pass', AGENT_VERDICT: 'merge-ready' },
          '\u2705 passed \u2014 merge-ready (agent verdict)',
          '\u2705 \u901a\u8fc7 \u00b7 \u53ef\u5408\u5165\uff08agent \u5224\u5b9a\uff09',
        ],
        [
          { VERDICT: 'pass', AGENT_VERDICT: 'findings' },
          '\u274c not passed \u2014 findings reported (agent verdict)',
          '\u274c \u4e0d\u901a\u8fc7 \u00b7 \u62a5\u544a\u4e86\u53d1\u73b0\uff08agent \u5224\u5b9a\uff09',
        ],
        [
          { VERDICT: 'pass', AGENT_VERDICT: 'blocked' },
          '\u274c not passed \u2014 blocked (agent verdict)',
          '\u274c \u4e0d\u901a\u8fc7 \u00b7 \u963b\u585e\uff08agent \u5224\u5b9a\uff09',
        ],
        [
          { VERDICT: 'pass', AGENT_VERDICT: 'inconclusive' },
          '\u26a0\ufe0f inconclusive \u2014 the agent could not reach a conclusion',
          '\u26a0\ufe0f \u65e0\u6cd5\u5224\u5b9a \u00b7 agent \u672a\u80fd\u5f97\u51fa\u7ed3\u8bba',
        ],
        [
          { VERDICT: 'pass' },
          '\u26a0\ufe0f inconclusive \u2014 completed without a usable structured verdict',
          '\u26a0\ufe0f \u65e0\u6cd5\u5224\u5b9a \u00b7 \u5df2\u5b8c\u6210\u4f46\u65e0\u53ef\u7528\u7684\u7ed3\u6784\u5316\u5224\u5b9a',
        ],
        [
          { VERDICT: 'fail' },
          '\u26a0\ufe0f incomplete \u2014 the agent run failed',
          '\u26a0\ufe0f \u672a\u5b8c\u6210 \u00b7 agent \u8fd0\u884c\u5931\u8d25',
        ],
        [
          { VERDICT: 'timeout' },
          '\u26a0\ufe0f incomplete \u2014 the run timed out with partial evidence',
          '\u26a0\ufe0f \u672a\u5b8c\u6210 \u00b7 \u8fd0\u884c\u8d85\u65f6\uff0c\u8bc1\u636e\u4e0d\u5b8c\u6574',
        ],
        [
          { VERDICT: 'infra-error' },
          '\u26a0\ufe0f incomplete \u2014 infra-error (crash, OOM, or unwritable results)',
          '\u26a0\ufe0f \u672a\u5b8c\u6210 \u00b7 \u57fa\u7840\u8bbe\u65bd\u6545\u969c\uff08\u5d29\u6e83\u3001OOM \u6216\u7ed3\u679c\u4e0d\u53ef\u5199\uff09',
        ],
        [
          { VERDICT: 'bogus' },
          '\u26a0\ufe0f inconclusive \u2014 the run ended in an unrecognized state',
          '\u26a0\ufe0f \u65e0\u6cd5\u5224\u5b9a \u00b7 \u8fd0\u884c\u4ee5\u672a\u8bc6\u522b\u7684\u72b6\u6001\u7ed3\u675f',
        ],
      ];
      const seenEn = new Set();
      const seenZh = new Set();
      ARMS.forEach(([env, en, zh], i) => {
        const body = render(dir, { NAME: `hl${i}`, AGENT_VERDICT: '', ...env });
        expect(body).toContain(`**Sandboxed verification: ${en}**`);
        expect(body).toContain(
          `<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a${zh}</summary>`,
        );
        // Only agent verdicts judge the code: every process-outcome arm must
        // carry \u26a0\ufe0f, and never the pass/fail glyphs.
        if (!env.AGENT_VERDICT) {
          const head = body.slice(0, body.indexOf('<details>'));
          expect(head).toContain('\u26a0\ufe0f');
          expect(head).not.toContain('\u2705');
          expect(head).not.toContain('\u274c');
        }
        seenEn.add(en);
        seenZh.add(zh);
      });
      // Distinct per arm, both sides. A single hardcoded string — or one
      // that echoes the English — satisfies per-arm containment, so the
      // pairing is pinned as a bijection.
      expect(seenEn.size).toBe(ARMS.length);
      expect(seenZh.size).toBe(ARMS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['pass', { VERDICT: 'pass', AGENT_VERDICT: 'merge-ready' }],
    ['timeout', { VERDICT: 'timeout', AGENT_VERDICT: '' }],
  ])(
    'keeps English unfolded and folds the Chinese into one details (%s)',
    (_label, env) => {
      const dir = fixture();
      try {
        const body = render(dir, { NAME: `fold-${_label}`, ...env });
        const details = body.indexOf(
          '<summary>\u4e2d\u6587 \u2014 \u5224\u5b9a\uff1a',
        );
        const detailsEnd = body.indexOf('</details>');
        expect(details).toBeGreaterThan(-1);
        // English body sits BEFORE the fold...
        if (_label === 'pass') {
          expect(body.indexOf('Ran the PR in an isolated')).toBeLessThan(
            details,
          );
          expect(body.indexOf('Scripted assertions:')).toBeLessThan(details);
        } else {
          expect(
            body.indexOf('The verification run did not complete'),
          ).toBeLessThan(details);
        }
        // ...and every Chinese body line sits INSIDE it.
        const zhBody =
          _label === 'pass'
            ? body.indexOf('\u6c99\u7bb1\u9a8c\u8bc1\u5728\u9694\u79bb')
            : body.indexOf(
                '\u672c\u6b21\u9a8c\u8bc1\u8fd0\u884c\u672a\u6b63\u5e38\u7ed3\u675f',
              );
        expect(zhBody).toBeGreaterThan(details);
        expect(zhBody).toBeLessThan(detailsEnd);
        if (_label === 'pass') {
          const assertZh = body.indexOf('\u811a\u672c\u65ad\u8a00\uff1a');
          expect(assertZh).toBeGreaterThan(details);
          expect(assertZh).toBeLessThan(detailsEnd);
        }
        // The report section stays outside the Chinese fold — now rendered
        // as markdown inside its own collapsed <details>, not an escaped
        // <pre> dump and not a 45 KB wall in the conversation.
        expect(
          body.indexOf('<summary>Verification report</summary>'),
        ).toBeGreaterThan(detailsEnd);
        expect(body).toContain('## real report');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('renders the assertion count in both languages', () => {
    const dir = fixture();
    try {
      const body = render(dir, {
        NAME: 'assertzh',
        VERDICT: 'pass',
        AGENT_VERDICT: 'merge-ready',
      });
      expect(body).toContain(
        'Scripted assertions: 10 passed · 0 failed · 10 total',
      );
      expect(body).toContain('脚本断言：10 通过 · 0 失败 · 10 总计');

      // The Chinese line rides the same validated object as the English one:
      // an inconsistent assertions.json must suppress BOTH, or the comment
      // grows a number that no gate checked.
      writeFileSync(
        join(dir, 'work', 'verify-results', 'prA-verify-1', 'assertions.json'),
        '{"pass":1,"fail":0,"total":0}',
      );
      const bad = render(dir, {
        NAME: 'assertbad',
        VERDICT: 'pass',
        AGENT_VERDICT: 'merge-ready',
      });
      expect(bad).not.toContain('Scripted assertions:');
      expect(bad).not.toContain('脚本断言');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #7836: when the agent claims merge-ready but assertions.json records
  // failures, the publisher must explain the mismatch in the comment body
  // so a reader does not see a hedged headline above "7 failed" with
  // nothing connecting them.
  it('explains why a merge-ready claim was not trusted', () => {
    const dir = fixture();
    try {
      writeFileSync(
        join(dir, 'work', 'verify-results', 'prA-verify-1', 'assertions.json'),
        '{"pass":1675,"fail":7,"total":1682}',
      );
      const body = render(dir, {
        NAME: 'mismatch',
        VERDICT: 'pass',
        AGENT_VERDICT: 'merge-ready',
      });
      expect(body).toContain(
        'The agent reported `merge-ready`, but `assertions.json` recorded 7 failures',
      );
      expect(body).toContain('\u26a0\ufe0f inconclusive');
      expect(body).not.toContain('\u2705 passed');
      // The Chinese counterpart must sit INSIDE the fold, so a Chinese-only
      // reader expanding it sees the reason, not just the raw numbers.
      const details = body.indexOf('<details>');
      const detailsEnd = body.indexOf('</details>');
      const zhMismatch = body.indexOf('agent \u62a5\u544a\u4e86 `merge-ready`');
      expect(zhMismatch).toBeGreaterThan(details);
      expect(zhMismatch).toBeLessThan(detailsEnd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Float counts (10.0) must be floored to integers (10) so a clean run
  // is not downgraded by a string comparison against '0.0'.
  it('floors float assertion counts to integers', () => {
    const dir = fixture();
    try {
      writeFileSync(
        join(dir, 'work', 'verify-results', 'prA-verify-1', 'assertions.json'),
        '{"pass":10.0,"fail":0.0,"total":10}',
      );
      const body = render(dir, {
        NAME: 'float',
        VERDICT: 'pass',
        AGENT_VERDICT: 'merge-ready',
      });
      expect(body).toContain(
        'Scripted assertions: 10 passed \u00b7 0 failed \u00b7 10 total',
      );
      expect(body).toContain('\u2705 passed');
      expect(body).not.toContain('10.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks only finding-bearing bodies as substantive', () => {
    const dir = fixture();
    const M = 'qwen-triage:verify-substantive';
    try {
      expect(render(dir, { NAME: 's1', AGENT_VERDICT: 'findings' })).toContain(
        M,
      );
      expect(
        render(dir, {
          NAME: 's2',
          VERDICT: 'fail',
          PREPARE_FAILURE_PHASE: 'install',
        }),
      ).toContain(M);
      expect(
        render(dir, {
          NAME: 's3',
          VERDICT: 'infra-error',
          PREPARE_FAILURE_PHASE: 'install',
        }),
      ).not.toContain(M);
      expect(
        render(dir, { NAME: 's4', DOWNLOAD_OUTCOME: 'failure' }),
      ).not.toContain(M);
      expect(
        render(dir, {
          NAME: 's5',
          VERDICT: 'skipped',
          SKIP_REASON: 'the PR is not open',
        }),
      ).not.toContain(M);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The follow-up snapshot must select the newest SUBSTANTIVE report, not
  // the newest non-running comment: a cancelled notice passes that test.
  it('snapshots the newest substantive report, not a weak notice', () => {
    const resolve = step('Resolve PR and snapshot metadata');
    // Run the workflow's own selector verbatim against a fixture shaped
    // exactly like one page of `gh api --paginate` output, so no rewriting
    // of the expression is needed.
    const jqProgram = resolve.match(/jq -rs --arg m[^']*'([\s\S]*?end)'/)?.[1];
    expect(jqProgram).toBeTruthy();
    expect(jqProgram).toContain('contains($sub)');

    const dir = mkdtempSync(join(tmpdir(), 'verify-snap-'));
    try {
      const comments = join(dir, 'c.json');
      writeFileSync(
        comments,
        JSON.stringify([
          {
            id: 101,
            user: { login: 'qwen-code-ci-bot' },
            body: '<!-- qwen-triage:verify -->\n<!-- qwen-triage:verify-substantive -->\n\nREAL REPORT',
          },
          {
            id: 102,
            user: { login: 'qwen-code-ci-bot' },
            body: '<!-- qwen-triage:verify -->\n\ncancelled notice',
          },
        ]),
      );
      const runJq = (program) =>
        spawnSync(
          'jq',
          [
            '-rs',
            '--arg',
            'm',
            '<!-- qwen-triage:verify -->',
            '--arg',
            's',
            '<!-- qwen-triage:verify-state=running -->',
            '--arg',
            'sub',
            '<!-- qwen-triage:verify-substantive -->',
            '--arg',
            'bot',
            'qwen-code-ci-bot',
            program,
            comments,
          ],
          { encoding: 'utf8' },
        ).stdout.trim();

      // The newest comment is the weak notice, but the snapshot must be the
      // substantive report behind it.
      expect(runJq(jqProgram)).toBe('102\tfalse\t101');
      // Control: selecting "newest non-running comment" picks the notice.
      expect(
        runJq(
          '[.[][] | select((.body | startswith($m)) and .user.login == $bot)] | map(select(.body | contains($s) | not)) | last | "\\(.id)"',
        ),
      ).toBe('102');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('qwen-triage verify execution-time controls', () => {
  // The queue-time gate is tested by executing it; these two controls run
  // AFTER the scarce-runner wait and were untested. A refactor that
  // disconnects the permission re-check, or inverts the head comparison,
  // would execute a revoked author's code or an unreviewed head while every
  // queue-time test stayed green.
  it('refuses to run when the author lost write access after queueing', () => {
    const resolve = step('Resolve PR and snapshot metadata');
    const body = resolve
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    const start = body.indexOf('# Re-authorize at execution time');
    const end = body.indexOf('# Status comment with the live run link');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const snippet = `set -euo pipefail\n${body.slice(start, end)}`;

    const dir = mkdtempSync(join(tmpdir(), 'verify-reauth-'));
    try {
      mkdirSync(join(dir, 'verify-context'), { recursive: true });
      writeFileSync(
        join(dir, 'verify-context', 'pr.json'),
        JSON.stringify({
          author: { login: 'alice' },
          headRefOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        }),
      );
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/usr/bin/env bash',
          'u="${2##*collaborators/}"; u="${u%%/*}"',
          'case "$u" in',
          '  alice) echo "${ALICE_PERM:-write}" ;;',
          '  *) echo "HTTP 404" >&2; exit 1 ;;',
          'esac',
        ].join('\n'),
        { mode: 0o755 },
      );
      const run = (env) => {
        const out = join(dir, 'out');
        writeFileSync(out, '');
        const proc = spawnSync('bash', ['-c', snippet], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GH_TOKEN: 'x',
            GITHUB_REPOSITORY: 'QwenLM/qwen-code',
            GITHUB_OUTPUT: out,
            RUNNER_TEMP: dir,
            ...env,
          },
        });
        return {
          out: readFileSync(out, 'utf8'),
          log: proc.stdout + proc.stderr,
        };
      };

      // Still a writer -> proceeds, and pins the head it authorized.
      const ok = run({ ALICE_PERM: 'write' });
      expect(ok.out).toContain('head_oid=deadbeef');
      expect(ok.out).not.toContain('decision=skip');

      // Access revoked during the wait -> refuses, with a reason to publish.
      const revoked = run({ ALICE_PERM: 'read' });
      expect(revoked.out).toContain('decision=skip');
      expect(revoked.out).toContain('verdict=skipped');
      expect(revoked.out).toContain('no longer has write access');
      expect(revoked.out).not.toContain('head_oid=deadbeef');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The merge ref is resolved after queueing, so the head that gets checked
  // out must be compared against the head that was authorized.
  it('refuses a head that moved between authorization and checkout', () => {
    const pin = step('Pin agent inputs from base');
    const body = pin.match(/run: \|-\n([\s\S]*)$/)?.[1].replace(/^ {10}/gm, '');
    expect(body).toContain('EXPECTED_HEAD');
    const snippet = `set -euo pipefail\n${body}`;

    const dir = mkdtempSync(join(tmpdir(), 'verify-headpin-'));
    const sh = (cmd, cwd) =>
      spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
    try {
      const repo = join(dir, 'repo');
      mkdirSync(join(repo, '.qwen', 'skills'), { recursive: true });
      // Build base -> feature, then a merge commit, so HEAD^1/HEAD^2 exist
      // exactly as the merge-ref checkout produces them.
      sh(
        [
          'git init -q .',
          'git config user.email t@t && git config user.name t',
          'echo base > f && mkdir -p .qwen/skills && echo skill > .qwen/skills/s.md',
          'git add -A && git commit -qm base',
          'git checkout -q -b feature',
          'echo head > f && git commit -qam head',
          'git checkout -q -',
          'git merge -q --no-ff feature -m merge',
        ].join(' && '),
        repo,
      );
      const headOid = sh('git rev-parse HEAD^2', repo).stdout.trim();
      expect(headOid).toMatch(/^[0-9a-f]{40}$/);

      const run = (expected) =>
        spawnSync('bash', ['-c', snippet], {
          cwd: repo,
          encoding: 'utf8',
          // The step also records the trusted base OID here, for the
          // post-build re-pin to archive by OID rather than by HEAD^1.
          env: { ...process.env, EXPECTED_HEAD: expected, RUNNER_TEMP: dir },
        });

      const matching = run(headOid);
      expect(matching.status).toBe(0);
      expect(matching.stdout).toContain('matches the authorized head');
      // The base OID is captured while .git is still root-owned.
      expect(readFileSync(join(dir, 'verify-base-oid'), 'utf8').trim()).toBe(
        spawnSync('git', ['rev-parse', 'HEAD^1'], {
          cwd: repo,
          encoding: 'utf8',
        }).stdout.trim(),
      );

      const moved = run('0000000000000000000000000000000000000000');
      expect(moved.status).not.toBe(0);
      expect(`${moved.stdout}${moved.stderr}`).toContain(
        'PR head moved after authorization',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The old log-pattern classifier is gone: both of its inputs were
  // PR-controlled, so it could be made to report a PR's own breakage as an
  // infrastructure incident. Its replacement is asserted in the
  // 'never derives an infra verdict from PR-controlled build output' test.
});

describe('qwen-triage verify round-3 hardening', () => {
  // Assignments reset PIPESTATUS, so reading [0] then [1] leaves the second
  // unset — and under `set -u` that aborts the step immediately after the
  // agent finishes, on every run.
  it('snapshots PIPESTATUS in one command', () => {
    const runStep = stepIn('verify', 'Run verification agent');
    expect(runStep).toContain('PIPE_STATUS=("${PIPESTATUS[@]}")');
    expect(runStep).not.toMatch(/AGENT_STATUS=\$\{PIPESTATUS\[0\]\}/);

    // Execute the shape both ways to keep the reason in the suite.
    const broken = spawnSync(
      'bash',
      [
        '-c',
        'set -euo pipefail\nset +e\n(exit 3) | tee /dev/null\nA=${PIPESTATUS[0]}\nB=${PIPESTATUS[1]}\nset -e\necho "reached $A $B"',
      ],
      { encoding: 'utf8' },
    );
    expect(`${broken.stdout}${broken.stderr}`).toContain('unbound variable');
    const fixed = spawnSync(
      'bash',
      [
        '-c',
        'set -euo pipefail\nset +e\n(exit 3) | tee /dev/null\nst=("${PIPESTATUS[@]}")\nset -e\necho "reached ${st[0]} ${st[1]}"',
      ],
      { encoding: 'utf8' },
    );
    expect(fixed.stdout).toContain('reached 3 0');
  });

  // GitHub evaluates concurrency BEFORE the job `if`, so a predicate that is
  // broader than the job's own condition lets a run that will skip take the
  // shared per-PR slot and displace one that would have run.
  it('keeps concurrency predicates as narrow as the job conditions', () => {
    // /verify must not enter the triage job's per-PR group.
    expect(job('triage')).toContain(
      "!startsWith(github.event.comment.body, '@qwen-code /triage')",
    );
    // A disabled-pool /verify must fall to the per-run group, not the
    // shared one it would then skip out of.
    const verifyJob = job('verify');
    const group = verifyJob.slice(
      verifyJob.indexOf('concurrency:'),
      verifyJob.indexOf('timeout-minutes:'),
    );
    expect(group).toContain("vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true'");
  });

  // Evidence images: the agent cannot install chromium (runs as `node`,
  // `env -i`, fresh HOME, no apt). The tools step installs system deps
  // as root; a post-checkout step downloads the browser binary using the
  // checkout's own Playwright so the version always matches the lockfile.
  it('pre-installs chromium and hands it to the agent', () => {
    // System deps only — no browser binary, no version-sensitive download.
    const tools = stepIn('verify', 'Install verify runner tools');
    expect(tools).toContain('install-deps chromium');
    expect(tools).not.toContain('install --with-deps');
    expect(tools).toContain('::warning::Chromium system deps install failed');
    // Deps success is recorded in a marker the browser step gates on: apt
    // and the Playwright CDN are independent servers, so a binary download
    // alone must not promise chromium to the agent.
    expect(tools).toContain('verify-chromium-deps-ok');
    // No hardcoded Playwright pin here either: the apt list must track
    // current Playwright so it covers the lockfile-matched binary below.
    expect(tools).not.toMatch(/playwright@[\d.]/);

    // Browser binary: downloaded after npm ci, and by the CLI of the
    // package the capture harness actually imports — never a hardcoded pin
    // (M5). This lockfile has TWO Playwright trees: terminal-capture.ts
    // imports `playwright`, but node_modules/.bin/playwright (what `npx
    // playwright` resolves) is @playwright/test's CLI, which pins a
    // different chromium revision. The install must therefore resolve the
    // imported package's cli.js from the harness's own directory (the same
    // algorithm as its import), not assume npm hoists `playwright` to the
    // root — a hoist nothing pins. cli.js is absent from the package's
    // exports map, so the workflow resolves the exported package.json and
    // joins; binding this assertion to the harness's import keeps the two
    // from drifting apart.
    const capture = readFileSync(
      'integration-tests/terminal-capture/terminal-capture.ts',
      'utf8',
    );
    expect(capture).toMatch(/from 'playwright'/);
    const browser = stepIn('verify', 'Install evidence browser');
    expect(browser).toContain(
      "require.resolve('playwright/package.json', { paths: ['./integration-tests/terminal-capture'] })",
    );
    expect(browser).toContain('node "$PW_CLI" install chromium');
    expect(browser).not.toContain('./node_modules/playwright/cli.js');
    expect(browser).not.toContain('npx playwright install chromium');
    expect(browser).not.toMatch(/playwright@[\d.]/);
    expect(browser).toContain('PLAYWRIGHT_BROWSERS_PATH');
    // The CLI runs PR-controlled code ($PW_CLI resolves from the PR's
    // node_modules), so it must drop the same runner-injected cache
    // credentials the prepare and agent steps unset — a doctored
    // playwright package could otherwise write to the Actions cache.
    expect(browser).toContain('-u ACTIONS_RUNTIME_TOKEN');
    expect(browser).toContain('-u ACTIONS_RUNTIME_URL');
    expect(browser).toContain('-u ACTIONS_CACHE_URL');
    // Marker is written ONLY inside the success branch (M6): the if
    // condition must precede the marker write, and the else branch must
    // carry the warning instead. The condition must ALSO require the deps
    // marker (M6b): a binary download alone is not enough.
    expect(browser).toContain('verify-chromium-deps-ok');
    const ifIdx = browser.indexOf(
      'if [ -f "${RUNNER_TEMP:?}/verify-chromium-deps-ok" ]',
    );
    const markerIdx = browser.indexOf('verify-chromium-path');
    const elseIdx = browser.indexOf('::warning::Chromium unavailable');
    expect(ifIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(ifIdx);
    expect(elseIdx).toBeGreaterThan(markerIdx);
    // Best-effort: a failed download must not fail a verification.
    expect(browser).not.toContain('exit 1');
    // A stale marker from an earlier run on the persistent pool must not
    // ride along: prepare clears it before this step writes a fresh one,
    // so absence stays a real signal even though RUNNER_TEMP outlives the
    // run.
    expect(stepIn('verify', 'Install and build PR app')).toContain(
      'rm -f "$RUNNER_TEMP/verify-chromium-path"',
    );

    // The agent is told ONLY when the install actually succeeded, so the
    // variable's absence is a real signal rather than a stale promise.
    // The guard must be CONDITIONAL (M1b): QWEN_VERIFY_CHROMIUM=1 must
    // appear inside the if-block that reads the marker, not unconditionally.
    const runStep = stepIn('verify', 'Run verification agent');
    expect(runStep).toContain('verify-chromium-path');
    expect(runStep).toContain('QWEN_VERIFY_CHROMIUM=1');
    // Both variables, not just the flag. Losing the path alone is the
    // nastiest arm: the agent is TOLD chromium is available, Playwright
    // then looks in the default ~/.cache/ms-playwright instead of the
    // shared install, and captures degrade to text-only after a successful
    // install — verified by mutation, this test passed without this line.
    expect(runStep).toContain('PLAYWRIGHT_BROWSERS_PATH=$CHROMIUM_PATH');
    const guard = runStep.indexOf('verify-chromium-path');
    const marker = runStep.indexOf('QWEN_VERIFY_CHROMIUM=1');
    const path = runStep.indexOf('PLAYWRIGHT_BROWSERS_PATH=$CHROMIUM_PATH');
    expect(guard).toBeLessThan(marker);
    expect(guard).toBeLessThan(path);
    // The if-fi block must wrap the QWEN_ENV+= assignment. Anchor the
    // slice at the real `if` keyword: `guard - 20` lands inside the marker
    // path, where "ver-if-y-chromium-path" satisfies toContain('if') even
    // with the guard deleted.
    const runIfIdx = runStep.lastIndexOf('if CHROMIUM_PATH', guard);
    expect(runIfIdx).toBeGreaterThan(-1);
    const ifBlock = runStep.slice(runIfIdx, marker + 30);
    expect(ifBlock).toMatch(/(^|\s)if\s/);
    expect(ifBlock).toContain('then');

    // The tmux lane is untouched: it has no evidence-image path.
    expect(stepIn('tmux-testing', 'Run tmux real-user testing')).not.toContain(
      'QWEN_VERIFY_CHROMIUM',
    );

    // And the skill must stop calling captures optional.
    const flat = verifySkill.replace(/\s+/g, ' ');
    expect(flat).toContain('Produce these whenever you ran a harness');
    expect(flat).not.toContain('Optionally `evidence/*.png`');
    // The TERMINAL capture route no longer depends on this browser at all —
    // it is @xterm/headless + sharp, so the skill must not gate captures on
    // QWEN_VERIFY_CHROMIUM or the agent skips when the browser is absent.
    // The variable and its install stay for a future web-UI capture; see
    // scripts/verify-capture.mjs for why the terminal route needs neither.
    expect(flat).toContain('node scripts/verify-capture.mjs --out');
    expect(flat).not.toContain('Route: `terminal-capture` skill');
  });

  // The browser step's require.resolve + cli.js join is otherwise guarded
  // only by a literal string match, so a Playwright bump that relocates
  // cli.js would break the download at runtime while that assertion still
  // passes. Execute the workflow's exact resolution against the installed
  // tree and require it to land on a real cli.js. Skipped only when
  // playwright is absent entirely (the require.resolve itself fails),
  // mirroring the jq tool-availability guard above.
  const resolveHarnessCli =
    "process.stdout.write(require('path').join(require('path').dirname(" +
    "require.resolve('playwright/package.json', { paths: ['./integration-tests/terminal-capture'] })" +
    "), 'cli.js'))";
  it.skipIf(spawnSync('node', ['-e', resolveHarnessCli]).status !== 0)(
    'resolves the harness Playwright cli.js to a real file',
    () => {
      const cli = spawnSync('node', ['-e', resolveHarnessCli], {
        encoding: 'utf8',
      });
      expect(cli.status).toBe(0);
      expect(cli.stdout).toMatch(/cli\.js$/);
      expect(existsSync(cli.stdout)).toBe(true);
    },
  );

  it('hosts verification evidence on OSS without writing Git refs', () => {
    const publish = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    expect(publish).toContain(
      'pr-assets/verify/pr${PR_NUMBER}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}',
    );
    expect(publish).toContain('scripts/upload-aliyun-oss-assets.js');
    expect(publish).not.toContain('checkout -q --orphan');
    expect(publish).not.toContain('git push');
  });

  // Keep deleting legacy refs until the historical branch population has
  // drained, even though new evidence is published to OSS.
  it('deletes both legacy pr-assets refs when a PR closes', () => {
    const cleanup = readFileSync(
      '.github/workflows/web-shell-visuals-cleanup.yml',
      'utf8',
    );
    // Both branch names, built from the same PR number.
    expect(cleanup).toContain('pr-assets/web-shell-visuals-${PR_NUMBER}');
    expect(cleanup).toContain('pr-assets/${PR_NUMBER}-verify');
    // Runs in the base context and never touches PR code.
    expect(cleanup).toContain('pull_request_target');
    expect(cleanup).not.toContain('actions/checkout');
    // One branch missing or one delete failing must not stop the other:
    // most PRs produce neither, so absence is the normal case.
    expect(cleanup).not.toContain('set -euo pipefail');
    expect(cleanup).toContain('continue');
    // ...but a real delete failure still has to be visible.
    expect(cleanup).toContain('::warning::Failed to delete');

    // Execute it against a stubbed gh: the loop must attempt both refs, and
    // a missing first branch must not skip the second.
    const script = cleanup.match(/run: \|-\n([\s\S]*?)$/)?.[1];
    expect(script).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'assets-cleanup-'));
    try {
      const calls = join(dir, 'gh-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$*" >> "$GH_CALLS"',
          // Only the verify branch exists; the visuals one 404s.
          'case "$*" in',
          '  *web-shell-visuals*) exit 1 ;;',
          'esac',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      const res = spawnSync('bash', ['-c', script.replace(/^ {10}/gm, '')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_CALLS: calls,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          PR_NUMBER: '7999',
        },
      });
      expect(res.status).toBe(0);
      const lines = readFileSync(calls, 'utf8').trim().split('\n');
      const deletes = lines.filter((l) => l.includes('DELETE'));
      // The missing visuals branch was probed but never deleted...
      expect(
        lines.some((l) => l.includes('pr-assets/web-shell-visuals-7999')),
      ).toBe(true);
      expect(deletes.some((l) => l.includes('web-shell-visuals'))).toBe(false);
      // ...and the loop carried on to the verify branch and deleted it.
      // This is the assertion the whole test exists for: a `set -e` script
      // would have exited on the first 404 and never reached here.
      expect(deletes.some((l) => l.includes('pr-assets/7999-verify'))).toBe(
        true,
      );
      expect(res.stdout).toContain('Deleted pr-assets/7999-verify');

      // Delete-FAILURE path: the verify branch probes OK but its DELETE
      // fails (transient 500, or the PAT lost contents:write). The loop
      // must set a non-zero exit and surface the warning — without this, a
      // future edit dropping `exit "$status"` leaves the job green while
      // the orphaned branch this workflow exists to prevent accumulates.
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$*" >> "$GH_CALLS"',
          // The verify branch probes OK but its DELETE fails; the visuals
          // branch still 404s on the probe.
          'case "$*" in',
          '  *web-shell-visuals*) exit 1 ;;',
          '  *"-X DELETE"*) exit 1 ;;',
          'esac',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      const res2 = spawnSync('bash', ['-c', script.replace(/^ {10}/gm, '')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_CALLS: calls,
          GH_TOKEN: 'x',
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          PR_NUMBER: '7999',
        },
      });
      expect(res2.status).toBe(1);
      expect(res2.stdout).toContain(
        '::warning::Failed to delete pr-assets/7999-verify',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // One budget drives the agent's graceful kill and the watchdog threshold
  // that distinguishes that kill from an OOM — both derive from a single
  // AGENT_BUDGET_M, so they cannot drift apart. The job limit and the
  // skill's advertised budget are still separate literals with their own
  // quiet failures, so pin their relationship to the budget, not the number.
  it('keeps the verify budget, watchdog and job limit consistent', () => {
    const verifyJob = job('verify');
    const runStep = stepIn('verify', 'Run verification agent');

    const agentMinutes = Number(runStep.match(/AGENT_BUDGET_M=(\d+)/)?.[1]);
    const jobMinutes = Number(
      verifyJob.match(/^ {4}timeout-minutes: (\d+)/m)?.[1],
    );
    expect(agentMinutes).toBeGreaterThan(0);
    expect(jobMinutes).toBeGreaterThan(0);

    // The graceful kill and the watchdog threshold must both derive from
    // AGENT_BUDGET_M rather than carry their own literals — that derivation
    // is what makes the coupling correct by construction. A hardcoded
    // `120m` or `7200` would reintroduce the drift this test exists to
    // catch: set the threshold below the budget and a late OOM (137) reads
    // as `timeout`, publishing "partial evidence" for a crash; set it above
    // and a real timeout reads as a crash.
    expect(runStep).toMatch(/timeout --kill-after=10s "\$\{AGENT_BUDGET_M\}m"/);
    expect(runStep).toMatch(
      /"\$AGENT_ELAPSED" -ge \$\(\(AGENT_BUDGET_M \* 60\)\)/,
    );

    // That comparison is only meaningful if the elapsed-time chain exists:
    // drop the baseline and AGENT_ELAPSED is total shell uptime, so a late
    // OOM reads as `timeout`; drop the assignment and it is empty, so the
    // watchdog never fires and a real timeout reads as a crash. Pin both
    // lines so deleting either fails here instead of silently in CI.
    expect(runStep).toMatch(/AGENT_START=\$SECONDS/);
    expect(runStep).toMatch(/AGENT_ELAPSED=\$\(\(SECONDS - AGENT_START\)\)/);

    // A step-level `timeout-minutes` on the run step would cap the agent
    // below the budget while every relationship above stays green — the
    // job limit must be the only cap.
    expect(runStep).not.toMatch(/^\s+timeout-minutes:/m);

    // The job limit only guards infra hangs, so it must clear the agent
    // budget plus install/build plus fixed overhead — otherwise the job
    // is killed mid-run and the agent never ships its partial report.
    // 20 minutes is the documented allowance (≈15m install/build + ≈5m
    // tools, checkout, pin, upload, cleanup).
    expect(jobMinutes).toBeGreaterThanOrEqual(agentMinutes + 20);

    // And the skill has to advertise the same budget, or the agent
    // self-limits to the old number and the raise does nothing.
    const advertised = Number(verifySkill.match(/hard (\d+)-minute kill/)?.[1]);
    expect(advertised).toBe(agentMinutes);
    const soft = Number(verifySkill.match(/Time budget ≈ (\d+) minutes/)?.[1]);
    expect(soft).toBeLessThan(agentMinutes);
    expect(soft).toBeLessThanOrEqual(agentMinutes - 10);
    // A proportional lower bound catches the most common drift — the hard
    // kill is raised but the soft budget is forgotten, silently wasting CI
    // time — without freezing the reserve at a fixed minute count for every
    // future budget.
    expect(soft).toBeGreaterThanOrEqual(Math.floor(agentMinutes * 0.8));
  });

  // Third instance of one structural bug: an instruction placed outside the
  // flow the agent actually follows. #7917 buried the /verify recommendation
  // in a "local invocation ONLY" section; #8016 marked captures "Optionally";
  // and captures still came out ZERO on two live runs (#7975, #8066) where
  // the browser installed fine — because the plan the agent executes is the
  // Scope-selection budget list, and that list had no capture line at all.
  it('budgets evidence capture in scope selection, not only in the contract', () => {
    const scope = verifySkill.slice(
      verifySkill.indexOf('## Scope selection'),
      verifySkill.indexOf('## Method'),
    );
    // A numbered budget item alongside the A/B, harnesses and gates.
    expect(scope).toMatch(/^4\. \*\*Capture/m);
    // The command, so budgeting does not mean budgeting for pipeline
    // authoring — that is what made this cost ~5 minutes and never happen.
    expect(scope).toContain('node scripts/verify-capture.mjs');
    expect(scope).toContain('~2 minutes');
    // Time reserved, and the failure that motivated it named — a rule
    // stated without its failure reads as advice and gets skipped.
    expect(scope).toContain('four live runs produced zero images');
    // Bounded: the cap exists so "budget it" does not become eight images.
    expect(scope).toMatch(/normally two, at most a handful/);

    // And the report has somewhere to put it, or a produced capture has no
    // referent and the naming rule means nothing.
    const structure = verifySkill.slice(
      verifySkill.indexOf('### report.md structure'),
      verifySkill.indexOf('## Hard rules'),
    );
    expect(structure).toContain('Reference the capture of those cells here');
  });

  // Cleanups must never descend through a PR-writable parent, and an
  // outward-resolving hooks entry must be removed rather than reported.
  it('survives symlink escapes in the workspace cleanup', () => {
    const clean = stepIn('verify', 'Clean stale agent state');
    const script = clean
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    const dir = mkdtempSync(join(tmpdir(), 'verify-symlink-'));
    const sh = (cmd, cwd) =>
      spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
    try {
      const victim = join(dir, 'victim');
      const repo = join(dir, 'repo');
      const setup = () => {
        rmSync(repo, { recursive: true, force: true });
        rmSync(victim, { recursive: true, force: true });
        mkdirSync(victim, { recursive: true });
        mkdirSync(repo, { recursive: true });
        writeFileSync(join(victim, 'precious.txt'), 'keep me');
        sh(
          'git init -q . && git config user.email t@t && git config user.name t && echo x > f && git add -A && git commit -qm x',
          repo,
        );
      };
      // Isolate from the developer's global/system git config: a global
      // core.hooksPath makes `git rev-parse --git-path hooks` resolve
      // outside .git, which is exactly the case the step must survive.
      // Run BOTH ways so the guard is proven, not assumed.
      const globalCfg = join(dir, 'gitconfig-global');
      writeFileSync(
        globalCfg,
        `[core]\n\thooksPath = ${join(dir, 'globalhooks')}\n`,
      );
      const runClean = (withGlobalHooksPath = false) =>
        spawnSync('bash', ['-c', script], {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_WORKSPACE: repo,
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: withGlobalHooksPath ? globalCfg : '/dev/null',
          },
        });

      // .qwen itself is a symlink pointing out of the workspace.
      setup();
      sh(`ln -s "${victim}" "${repo}/.qwen"`, dir);
      runClean();
      expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe(
        'keep me',
      );

      // .qwen/tmp is a symlink pointing out of the workspace.
      setup();
      mkdirSync(join(repo, '.qwen'), { recursive: true });
      sh(`ln -s "${victim}" "${repo}/.qwen/tmp"`, dir);
      runClean();
      expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe(
        'keep me',
      );

      // .git/hooks symlinked outside: the entry must go, its target must not.
      setup();
      rmSync(join(repo, '.git', 'hooks'), { recursive: true, force: true });
      sh(`ln -s "${victim}" "${repo}/.git/hooks"`, dir);
      writeFileSync(join(victim, 'post-checkout'), '#!/bin/sh\necho pwned\n');
      const out = runClean();
      expect(`${out.stdout}${out.stderr}`).toContain('unlinking it');
      expect(
        sh(`test -L "${repo}/.git/hooks"; echo $?`, dir).stdout.trim(),
      ).toBe('1');
      expect(
        sh(`test -d "${repo}/.git/hooks"; echo $?`, dir).stdout.trim(),
      ).toBe('0');
      // The link target is left alone — never traversed.
      expect(readFileSync(join(victim, 'post-checkout'), 'utf8')).toContain(
        'pwned',
      );

      // Same again with a global core.hooksPath in play: before the fix the
      // hooks path resolved to that global directory, the guard read
      // "outside the git dir", and the planted symlink survived.
      setup();
      rmSync(join(repo, '.git', 'hooks'), { recursive: true, force: true });
      sh(`ln -s "${victim}" "${repo}/.git/hooks"`, dir);
      runClean(true);
      expect(
        sh(`test -L "${repo}/.git/hooks"; echo $?`, dir).stdout.trim(),
      ).toBe('1');
      expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe(
        'keep me',
      );

      // And the ordinary case under the same global config: a REAL hooks
      // directory with a planted hook must still be swept. This is what the
      // hermetic HOOKS_DIR resolution governs — with the global path
      // winning, the sweep would run somewhere else and leave the
      // repository's own hook in place.
      setup();
      writeFileSync(
        join(repo, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\necho pwned\n',
      );
      writeFileSync(
        join(repo, '.git', 'hooks', 'pre-commit.sample'),
        '#!/bin/sh\nexit 0\n',
      );
      runClean(true);
      // The planted hook is gone...
      expect(
        sh(
          `test -e "${repo}/.git/hooks/post-checkout"; echo $?`,
          dir,
        ).stdout.trim(),
      ).toBe('1');
      // ...and git's own samples survive, which is what proves the sweep ran
      // on THIS repository's hooks directory. If resolution followed the
      // global core.hooksPath, the outward-path fallback would unlink the
      // whole directory and take the samples with it.
      expect(
        sh(
          `test -e "${repo}/.git/hooks/pre-commit.sample"; echo $?`,
          dir,
        ).stdout.trim(),
      ).toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The second pin runs after the workspace (including .git) was handed to
  // the build user, so it must archive an OID captured while .git was still
  // root-owned rather than re-deriving HEAD^1 from PR-writable metadata.
  it('re-pins the verifier from an OID recorded before the chown', () => {
    const pin = stepIn('verify', 'Pin agent inputs from base');
    expect(pin).toContain(
      'git rev-parse \'HEAD^1\' > "${RUNNER_TEMP:?}/verify-base-oid"',
    );
    const runStep = stepIn('verify', 'Run verification agent');
    expect(runStep).toContain(
      'BASE_OID="$(cat "${RUNNER_TEMP:?}/verify-base-oid")"',
    );
    expect(runStep).toContain('git archive "$BASE_OID" -- .qwen');
    expect(runStep).not.toContain("git archive 'HEAD^1' -- .qwen");
    expect(runStep).toContain('refusing to re-pin the verifier');
  });

  // Both inputs to the old classifier were PR-controlled, so no infra
  // verdict is derivable from the prepare step at all.
  it('never derives an infra verdict from PR-controlled build output', () => {
    const prepare = stepIn('verify', 'Install and build PR app');
    expect(prepare).not.toContain('classify_failure');
    expect(prepare).not.toContain('npm ERR! code');
    expect(prepare).toContain('echo "verdict=fail" >> "$GITHUB_OUTPUT"');
    // infra-error is allowed again, but ONLY behind the runner-owned
    // registry probe — never derived from anything the build wrote.
    const infra = prepare.indexOf('verdict=infra-error');
    if (infra > -1) {
      expect(prepare.slice(0, infra)).toContain('registry_unreachable');
    }
  });

  // Run 30319209722 reported `fail` against a PR whose only crime was that
  // npm exec'd esbuild's binary before its own write was closed (ETXTBSY),
  // so the install is now retried once.
  //
  // Asserting that structurally — "the step contains a loop" — would pass
  // on a loop that never retries and equally on one that never stops, which
  // are the two ways this can actually be wrong. So run the real step text:
  // `runuser` is stubbed to drop its own arguments and exec the rest (which
  // keeps the genuine `env -u ...` stripping in the path under test),
  // `chown` and `curl` are no-ops, and `npm` fails a set number of times.
  const runPrepare = (jobName, { failures, resultsDir }) => {
    const script = stepIn(jobName, 'Install and build PR app')
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    expect(script).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'prepare-retry-'));
    try {
      const work = join(dir, 'work');
      mkdirSync(work, { recursive: true });
      const calls = join(dir, 'npm-ci-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'runuser'),
        [
          '#!/usr/bin/env bash',
          'while [ "$#" -gt 0 ] && [ "$1" != \'--\' ]; do shift; done',
          'shift || true',
          'exec "$@"',
        ].join('\n'),
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, 'npm'),
        [
          '#!/usr/bin/env bash',
          // Only `ci` is counted/failed: `run build` shares this stub and
          // must stay a success, or an install-phase assertion could pass
          // because the BUILD failed instead.
          'if [ "$1" = ci ]; then',
          '  printf "ci\\n" >> "$NPM_CI_CALLS"',
          '  n=$(wc -l < "$NPM_CI_CALLS" | tr -d " ")',
          '  if [ "$n" -le "$NPM_CI_FAILURES" ]; then',
          '    echo "npm error ETXTBSY" >&2',
          '    exit 1',
          '  fi',
          'fi',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      for (const noop of ['chown', 'curl']) {
        writeFileSync(join(dir, noop), '#!/usr/bin/env bash\nexit 0\n', {
          mode: 0o755,
        });
      }
      const out = join(dir, 'step-output');
      writeFileSync(out, '');
      const res = spawnSync('bash', ['-c', script], {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          NPM_CI_CALLS: calls,
          NPM_CI_FAILURES: String(failures),
          RUNNER_TEMP: dir,
          GITHUB_WORKSPACE: work,
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: '/dev/null',
        },
      });
      return {
        status: res.status,
        stderr: res.stderr,
        output: readFileSync(out, 'utf8'),
        attempts: readFileSync(calls, 'utf8').trim()
          ? readFileSync(calls, 'utf8').trim().split('\n').length
          : 0,
        log: readFileSync(join(dir, resultsDir, 'prepare.log'), 'utf8'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  for (const [jobName, resultsDir] of [
    ['verify', 'verify-results'],
    ['tmux-testing', 'tmux-results'],
  ]) {
    it(`retries a transient npm ci once in the ${jobName} lane`, () => {
      // One ETXTBSY-style failure then success: the run must continue to
      // the build with no verdict at all. This is the arm the bug lives in
      // — before the retry it emitted verdict=fail here.
      const flaky = runPrepare(jobName, { failures: 1, resultsDir });
      expect(flaky.attempts).toBe(2);
      expect(flaky.output).not.toContain('verdict=');
      expect(flaky.log).toContain('retrying once');
      expect(flaky.log).toContain('$ npm run build');

      // A tree that is genuinely broken still fails, and the retry is
      // bounded: exactly two attempts, not an unbounded loop.
      const broken = runPrepare(jobName, { failures: 99, resultsDir });
      expect(broken.attempts).toBe(2);
      expect(broken.output).toContain('verdict=fail');
      expect(broken.output).toContain('failure_phase=install');
      expect(broken.log).toContain('after 2 attempts');
      // The build must not have run once the install gave up.
      expect(broken.log).not.toContain('$ npm run build');

      // Control: a healthy install must not pay for the retry at all.
      const clean = runPrepare(jobName, { failures: 0, resultsDir });
      expect(clean.attempts).toBe(1);
      expect(clean.output).not.toContain('verdict=');
      expect(clean.log).not.toContain('retrying once');
    });
  }

  // The build is deliberately NOT retried — a compile error is
  // deterministic, so a second run would only double the cost of an honest
  // failure. Pin that asymmetry so a future "retry everything" edit is a
  // decision rather than an accident.
  it('does not retry the build in either lane', () => {
    for (const jobName of ['verify', 'tmux-testing']) {
      const prepare = stepIn(jobName, 'Install and build PR app');
      const build = prepare.slice(prepare.indexOf('$ npm run build'));
      expect(build).not.toContain('while :;');
      expect(build).not.toContain('build_attempt');
    }
  });

  // The verify comment's retry clause is rendered for real by the publish
  // fidelity suite. There is no equivalent render harness for the tmux
  // comment, so its copy of the same wiring is pinned structurally: the
  // clause must be set ONLY on the install arm (the build is single-shot)
  // and must actually reach the sentence that blames the PR.
  it('threads the retry count into both lanes fail copy', () => {
    for (const [jobName, stepName] of [
      ['publish-verify', 'Post verification report comment'],
      ['publish-tmux', 'Post tmux result comment'],
    ]) {
      const publish = stepIn(jobName, stepName);
      const install = publish.indexOf("PREPARE_COMMAND='npm ci'");
      const build = publish.indexOf("PREPARE_COMMAND='npm run build'");
      expect(install).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(install);
      // Assigned between the install arm and the build arm — i.e. inside
      // the install arm and nowhere else.
      const attempts = publish.indexOf("PREPARE_ATTEMPTS=' twice in a row'");
      expect(attempts).toBeGreaterThan(install);
      expect(attempts).toBeLessThan(build);
      expect(publish.slice(build)).not.toContain('PREPARE_ATTEMPTS=');
      // ...and consumed by the PR-blaming sentence, not left dangling.
      expect(publish).toMatch(
        /failed%s[\s\S]*?treated as a PR failure verdict[\s\S]*?"\$\{PREPARE_ATTEMPTS:-\}"/,
      );
    }
  });

  // skipped / n-a upload no artifact, so their download always fails; their
  // own reason must still reach the comment.
  it('answers skipped and docs-only before the download-failure branch', () => {
    const publish = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    const skipped = publish.indexOf('"${VERDICT:-}" = "skipped"');
    const download = publish.indexOf(
      '"${DOWNLOAD_OUTCOME:-success}" != "success"',
    );
    expect(skipped).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(skipped);
  });

  // A crashed run with no report has nothing to preserve, so it must not
  // claim the substantive marker and overwrite the previous round's report.
  it('marks a body substantive only when a report exists', () => {
    const publish = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    expect(publish).toMatch(/if \[ -z "\$REPORT" \]; then\s+WEAK_BODY=true/);
    expect(publish).toMatch(
      /if \[ -n "\$REPORT" \]; then\s+printf '%s\\n' '<!-- qwen-triage:verify-substantive -->'/,
    );
  });
});

describe('qwen-triage verify maintainer-review round', () => {
  // The bearer check is the load-bearing control on the model credential;
  // asserting its presence is not the same as proving it rejects. Start the
  // real proxy and issue real requests.
  it('rejects unauthenticated calls to the model proxy', () => {
    const runStep = stepIn('verify', 'Run verification agent');
    const proxy = runStep.match(/<<'NODE'\n([\s\S]*?)\n\s*NODE\n/)?.[1];
    expect(proxy).toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'verify-proxy-'));
    try {
      writeFileSync(join(dir, 'proxy.js'), proxy.replace(/^ {10}/gm, ''));
      writeFileSync(
        join(dir, 'upstream.js'),
        [
          "const http = require('node:http');",
          "const fs = require('node:fs');",
          'const s = http.createServer((q, r) => {',
          "  r.writeHead(200, { 'content-type': 'application/json' });",
          '  r.end(JSON.stringify({ ok: true }));',
          '});',
          "s.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(s.address().port)));",
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'deadport.js'),
        [
          "const net = require('node:net');",
          "const fs = require('node:fs');",
          'const s = net.createServer();',
          "s.listen(0, '127.0.0.1', () => {",
          '  const p = s.address().port;',
          '  s.close(() => fs.writeFileSync(process.argv[2], String(p)));',
          '});',
        ].join('\n'),
      );
      const driver = [
        'set -u',
        'node "$1/upstream.js" "$1/up.port" & UP=$!',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/up.port" ] && break; sleep 0.3; done',
        'UPPORT="$(cat "$1/up.port")"',
        'REVIEW_OPENAI_BASE_URL="http://127.0.0.1:$UPPORT/v1" REVIEW_OPENAI_API_KEY=realkey \\',
        '  QWEN_PROXY_NONCE=nonce123 PROXY_TOKEN=tok456 node "$1/proxy.js" "$1/px.port" & PX=$!',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/px.port" ] && break; sleep 0.3; done',
        'P="$(cat "$1/px.port")"',
        'U="http://127.0.0.1:$P/v1/chat/completions"',
        'echo "health=$(curl -sS "http://127.0.0.1:$P/__health")"',
        'echo "noauth=$(curl -s -o /dev/null -w %{http_code} -X POST -d {} "$U")"',
        'echo "wrong=$(curl -s -o /dev/null -w %{http_code} -X POST -H "authorization: Bearer nope" -d {} "$U")"',
        'echo "right=$(curl -s -o /dev/null -w %{http_code} -X POST -H "authorization: Bearer tok456" -d {} "$U")"',
        'echo "otherpath=$(curl -s -o /dev/null -w %{http_code} -X POST -H "authorization: Bearer tok456" -d {} "http://127.0.0.1:$P/v1/models")"',
        'node "$1/deadport.js" "$1/dead.port"',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/dead.port" ] && break; sleep 0.3; done',
        'DEAD="$(cat "$1/dead.port")"',
        'REVIEW_OPENAI_BASE_URL="http://127.0.0.1:$DEAD/v1" REVIEW_OPENAI_API_KEY=realkey \\',
        '  QWEN_PROXY_NONCE=nonce123 PROXY_TOKEN=tok456 node "$1/proxy.js" "$1/px2.port" & PX2=$!',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/px2.port" ] && break; sleep 0.3; done',
        'P2="$(cat "$1/px2.port")"',
        'echo "dead=$(curl -s -o /dev/null -w %{http_code} -X POST -H "authorization: Bearer tok456" -d {} "http://127.0.0.1:$P2/v1/chat/completions")"',
        'echo "dead2=$(curl -s -o /dev/null -w %{http_code} -X POST -H "authorization: Bearer tok456" -d {} "http://127.0.0.1:$P2/v1/chat/completions")"',
        'kill $UP $PX $PX2 2>/dev/null',
      ].join('\n');
      const out = spawnSync('bash', ['-c', driver, '_', dir], {
        encoding: 'utf8',
        timeout: 60000,
      }).stdout;
      // Identity, not just liveness.
      expect(out).toContain('health=nonce123');
      // The credential is unreachable without this run's bearer...
      expect(out).toContain('noauth=401');
      expect(out).toContain('wrong=401');
      // ...and reachable with it, on the one allowed route.
      expect(out).toContain('right=200');
      expect(out).toContain('otherpath=403');
      // A dead upstream must surface as a 502 the agent can read, not crash
      // the proxy: the outer catch clears the hoisted timer (a ReferenceError
      // here would kill the process and turn qwen's next completion into a
      // false fail verdict), and the process serves the following request.
      expect(out).toContain('dead=502');
      expect(out).toContain('dead2=502');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The watchdog must be an IDLE timer, not a total one: fetch() resolves on
  // headers and a completion can stream for minutes (qwen tolerates 240 s of
  // silence, DEFAULT_STREAM_IDLE_TIMEOUT_MS). A total cap truncated healthy
  // long completions, and firing it mid-body never terminated the downstream
  // response, so the client sat on a silent socket.
  it('treats the verify proxy watchdog as idle and ends a stalled response', () => {
    const runStep = stepIn('verify', 'Run verification agent');
    const proxy = runStep.match(/<<'NODE'\n([\s\S]*?)\n\s*NODE\n/)?.[1];
    expect(proxy).toBeTruthy();
    const out = runProxyWatchdogTest(proxy);
    // 20 chunks at 200 ms span 4 s, longer than the 1.5 s idle window, yet
    // all arrive: the watchdog refreshes per chunk, so a healthy stream is
    // not cut.
    expect(out).toContain('chunks=20');
    // A mid-body stall closes the response (curl 18), not a hang until the
    // client's own timeout (curl 28).
    expect(out).toContain('stall_exit=18');
    // 20 chunks x 200 ms is 4 s before the stall arm even starts, so this
    // cannot fit vitest's 5 s default. It was timing out on main.
  }, 30000);

  // GitHub cancels the OLDER pending run in a concurrency group, so the
  // requester's own /verify proceeds — the earlier "queued behind other
  // runs" notice had that backwards and warned the wrong person. The real
  // silent drop is the victim of that replacement: a verify job cancelled
  // while pending never evaluates its `outputs:` block, so the publisher
  // must not depend on it for the PR number.
  it('still identifies the PR when verify was cancelled before it started', () => {
    const publishJob = job('publish-verify');
    // The fallback has to live where the value is READ.
    expect(publishJob).toContain(
      'needs.verify.outputs.pr_number || github.event.issue.number',
    );
    // Same one-line class in the tmux sibling: a job cancelled while
    // pending never evaluates its outputs either, so without the fallback
    // publish-tmux hits the same null guard and posts nothing.
    expect(job('publish-tmux')).toContain(
      'needs.tmux-testing.outputs.pr_number || github.event.issue.number',
    );
    // ...and the step that warned on the inverted premise is gone.
    expect(job('authorize')).not.toContain('Report saturated verify queue');

    const publishStep = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    const script = publishStep
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    const dir = mkdtempSync(join(tmpdir(), 'verify-cancelled-'));
    try {
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/usr/bin/env bash',
          'for a in "$@"; do case "$a" in body=*) echo posted >> "$POSTED" ;; esac; done',
          'case "$*" in',
          '  *user*) echo qwen-code-ci-bot ;;',
          "  *comments*--method*GET*) echo '[]' ;;",
          'esac',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      mkdirSync(join(dir, 'work'), { recursive: true });
      const posted = join(dir, 'posted');
      const run = (prNumber) => {
        writeFileSync(posted, '');
        const res = spawnSync('bash', ['-c', script], {
          cwd: join(dir, 'work'),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            POSTED: posted,
            GH_STUB_OUT: join(dir, 'body.md'),
            GH_TOKEN: 'x',
            GITHUB_REPOSITORY: 'QwenLM/qwen-code',
            RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: '/dev/null',
            GITHUB_RUN_ID: '1',
            GITHUB_RUN_ATTEMPT: '1',
            PR_NUMBER: prNumber,
            RUN_URL: 'u',
            VERIFY_RESULT: 'cancelled',
            DOWNLOAD_OUTCOME: 'success',
            VERDICT: '',
            SKIP_REASON: '',
            PREPARE_FAILURE_PHASE: '',
            AGENT_VERDICT: '',
          },
        });
        return {
          posted: readFileSync(posted, 'utf8').trim().length > 0,
          log: `${res.stdout}${res.stderr}`,
        };
      };
      // A number resolved either way must produce the cancelled notice.
      const resolved = run('7710');
      expect(resolved.posted).toBe(true);
      // With an empty number the step can only warn and exit — which is why
      // the workflow expression must never let that happen.
      const empty = run('');
      expect(empty.posted).toBe(false);
      expect(empty.log).toContain('No PR number resolved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The published copy must name only the condition that can actually
  // produce infra-error. Naming causes the code cannot reach is the same
  // mis-attribution the classifier removal set out to fix, pointed the
  // other way: it tells an author with a genuinely broken install that
  // their code is fine.
  it('names only the reachable cause in the infra-error body', () => {
    const publish = stepIn(
      'publish-verify',
      'Post verification report comment',
    );
    // Anchor on the prepare-failure arm specifically: "infrastructure
    // failure" also appears in the earlier artifact/infra-result branch,
    // whose copy is unrelated to the install classification.
    const start = publish.indexOf(
      'Reachable: the prepare step reports infra-error',
    );
    expect(start).toBeGreaterThan(-1);
    const body = publish.slice(start, publish.indexOf('emit_block', start));
    expect(body).toContain('registry.npmjs.org` was unreachable');
    // Causes the current prepare step can no longer emit.
    expect(body).not.toContain('signal/OOM');
    expect(body).not.toContain('full disk');
    expect(body).not.toContain('磁盘写满');
    // And the fix is offered, not asserted.
    expect(body).not.toContain('is the fix');
  });

  // Registry reachability is the one signal about an install failure that
  // PR code cannot write, so it is the only thing allowed to downgrade a
  // failure to infrastructure.
  it('only downgrades an install failure on a runner-owned signal', () => {
    const prepare = stepIn('verify', 'Install and build PR app');
    expect(prepare).toContain('registry_unreachable()');
    expect(prepare).toContain(
      'curl -sfI --max-time 20 https://registry.npmjs.org/',
    );
    // A build failure has no such signal and stays the tree's problem.
    const build = prepare.slice(prepare.indexOf('${build_status:-0}'));
    expect(build).toContain('echo "verdict=fail"');
    expect(build).not.toContain('registry_unreachable');
    // ...and the removed log heuristic must not creep back.
    expect(prepare).not.toContain('npm ERR! code');
  });

  // The publisher does one download and one comment; without a bound it
  // inherits the 360-minute default.
  it('bounds the publisher job', () => {
    const publish = job('publish-verify');
    expect(publish).toMatch(/timeout-minutes: \d+/);
    const minutes = Number(publish.match(/timeout-minutes: (\d+)/)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it('keeps the credential-bearing publisher on a hosted runner', () => {
    const publish = job('publish-verify');
    expect(publish).toContain("runs-on: 'ubuntu-latest'");
    expect(publish).not.toContain('ecs-qwen');
  });

  // Upstream failure text can name resolved hosts and TLS detail; the agent
  // only needs to know the call failed.
  it('does not forward upstream error text to the agent', () => {
    // Both lanes share the proxy design and must both keep upstream
    // topology out of the agent's error text.
    for (const [jobName, stepName] of [
      ['verify', 'Run verification agent'],
      ['tmux-testing', 'Run tmux real-user testing'],
    ]) {
      const runStep = stepIn(jobName, stepName);
      expect(runStep).toContain(
        "res.end('proxy error: upstream request failed",
      );
      expect(runStep).not.toContain('proxy error: ${error instanceof Error');
    }
  });
});

describe('qwen-triage tmux lane parity', () => {
  // The verify lane earned these controls the hard way; the tmux lane
  // executes the same untrusted PR code on the same persistent pool, so
  // leaving them out was a gap rather than a scope boundary.

  // A fixed proxy port is squattable by a detached lifecycle process: the
  // real proxy dies EADDRINUSE while the health probe succeeds against the
  // squatter, and the agent takes ITS chat completions.
  it('binds the tmux model proxy to an ephemeral port and authenticates it', () => {
    const runStep = stepIn('tmux-testing', 'Run tmux real-user testing');
    expect(runStep).not.toContain('proxy_port=8787');
    expect(runStep).toContain("server.listen(0, '127.0.0.1'");
    expect(runStep).toContain('QWEN_PROXY_NONCE');
    expect(runStep).toContain('!= "$proxy_nonce"');
    expect(runStep).toContain('kill -0 "$OPENAI_PROXY_PID"');
    expect(runStep).toContain('PROXY_TOKEN');
    expect(runStep).toContain('proxy: unauthorized');
    // The agent must actually present this run's token: reverting the env
    // wire to a literal makes every completion 401 and turns the verdict
    // into a false 'fail'. Assert the wire, not just the gate's presence.
    expect(runStep).toContain('"OPENAI_API_KEY=$PROXY_TOKEN"');

    // Execute the real proxy and prove the nonce + bearer token work.
    const proxy = runStep.match(/<<'NODE'\n([\s\S]*?)\n\s*NODE\n/)?.[1];
    expect(proxy).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'tmux-proxy-'));
    try {
      writeFileSync(join(dir, 'proxy.js'), proxy.replace(/^ {10}/gm, ''));
      writeFileSync(
        join(dir, 'upstream.js'),
        [
          "const http = require('node:http');",
          "const fs = require('node:fs');",
          "const s = http.createServer((q, r) => { r.writeHead(200); r.end('{}'); });",
          "s.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(s.address().port)));",
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'deadport.js'),
        [
          "const net = require('node:net');",
          "const fs = require('node:fs');",
          'const s = net.createServer();',
          "s.listen(0, '127.0.0.1', () => {",
          '  const p = s.address().port;',
          '  s.close(() => fs.writeFileSync(process.argv[2], String(p)));',
          '});',
        ].join('\n'),
      );
      const driver = [
        'set -u',
        'node "$1/upstream.js" "$1/up.port" & UP=$!',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/up.port" ] && break; sleep 0.3; done',
        'REVIEW_OPENAI_BASE_URL="http://127.0.0.1:$(cat "$1/up.port")/v1" \\',
        '  REVIEW_OPENAI_API_KEY=k QWEN_PROXY_NONCE=n0nce PROXY_TOKEN=t0ken \\',
        '  node "$1/proxy.js" "$1/px.port" & PX=$!',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/px.port" ] && break; sleep 0.3; done',
        'P="$(cat "$1/px.port")"',
        'echo "port=$P"',
        'echo "health=$(curl -sS "http://127.0.0.1:$P/__health")"',
        'echo "unauth=$(curl -sS -o /dev/null -w %{http_code} -X POST "http://127.0.0.1:$P/v1/chat/completions")"',
        'echo "auth=$(curl -sS -o /dev/null -w %{http_code} -X POST -H "Authorization: Bearer t0ken" "http://127.0.0.1:$P/v1/chat/completions")"',
        'echo "wrong=$(curl -sS -o /dev/null -w %{http_code} -X POST -H "Authorization: Bearer nope" "http://127.0.0.1:$P/v1/chat/completions")"',
        'node "$1/deadport.js" "$1/dead.port"',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/dead.port" ] && break; sleep 0.3; done',
        'DEAD="$(cat "$1/dead.port")"',
        'REVIEW_OPENAI_BASE_URL="http://127.0.0.1:$DEAD/v1" \\',
        '  REVIEW_OPENAI_API_KEY=k QWEN_PROXY_NONCE=n0nce PROXY_TOKEN=t0ken \\',
        '  node "$1/proxy.js" "$1/px2.port" & PX2=$!',
        'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$1/px2.port" ] && break; sleep 0.3; done',
        'P2="$(cat "$1/px2.port")"',
        'echo "dead=$(curl -sS -o /dev/null -w %{http_code} -X POST -H "Authorization: Bearer t0ken" "http://127.0.0.1:$P2/v1/chat/completions")"',
        'echo "dead2=$(curl -sS -o /dev/null -w %{http_code} -X POST -H "Authorization: Bearer t0ken" "http://127.0.0.1:$P2/v1/chat/completions")"',
        'kill $UP $PX $PX2 2>/dev/null',
      ].join('\n');
      const out = spawnSync('bash', ['-c', driver, '_', dir], {
        encoding: 'utf8',
        timeout: 60000,
      }).stdout;
      // An OS-chosen port, identity proven by the nonce, and bearer-token
      // gate rejecting unauthenticated callers.
      expect(out).toMatch(/port=\d+/);
      expect(out).toContain('health=n0nce');
      expect(out).toContain('unauth=401');
      expect(out).toContain('auth=200');
      // The gate exists for the wrong-token case: a prefix match would let
      // any 'Bearer ...' caller spend the real key.
      expect(out).toContain('wrong=401');
      // A dead upstream is a 502, not a crashed proxy: the outer catch must
      // clear the hoisted timer without a ReferenceError and survive to serve
      // the next call, or qwen's next completion hangs and the run maps the
      // infrastructure fault to a false fail verdict.
      expect(out).toContain('dead=502');
      expect(out).toContain('dead2=502');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Same regression as the verify lane, asserted here because this PR carries
  // the proxy across to tmux: the watchdog is idle (refreshed per chunk) and a
  // mid-body stall terminates the response instead of stranding the client.
  it('treats the tmux proxy watchdog as idle and ends a stalled response', () => {
    const runStep = stepIn('tmux-testing', 'Run tmux real-user testing');
    const proxy = runStep.match(/<<'NODE'\n([\s\S]*?)\n\s*NODE\n/)?.[1];
    expect(proxy).toBeTruthy();
    const out = runProxyWatchdogTest(proxy);
    expect(out).toContain('chunks=20');
    expect(out).toContain('stall_exit=18');
    // Same reason as its verify-lane twin: the stream alone outlasts the
    // 5 s default.
  }, 30000);

  // PR lifecycle scripts run before the agent and can plant a
  // tmp/<name>-tmux-<ts>/ directory whose report.md and transcript the
  // collector would hand to the publisher.
  it('sweeps planted tmux artifacts before the agent starts', () => {
    const runStep = stepIn('tmux-testing', 'Run tmux real-user testing');
    const sweep =
      "find tmp -maxdepth 2 -type d -name '*-tmux-*' -exec rm -rf {} +";
    const sweepAt = runStep.indexOf(sweep);
    expect(sweepAt).toBeGreaterThan(-1);
    // Before the proxy and the agent launch, after the build.
    expect(sweepAt).toBeLessThan(runStep.indexOf('start_openai_proxy'));
    // The sweep must not descend through a PR-planted `tmp` symlink: the
    // same root-owned escape the .qwen cleanup guards against.
    const guardAt = runStep.indexOf('if [ -L tmp ]; then');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(sweepAt);
  });

  // The global install must not read the previous PR's .npmrc: a --registry
  // flag does not override script-shell or hooks.
  it('runs the tmux global install away from the checked-out tree', () => {
    expect(stepIn('tmux-testing', 'Install tmux runner tools')).toContain(
      '(cd "${RUNNER_TEMP:?}" && npm install -g',
    );
  });

  // Cleanup must not descend through a PR-writable parent. Both the
  // pre-checkout step and the end-of-job step need the guard: the
  // pre-checkout site runs as root against the previous run's PR-written
  // tree before actions/checkout cleans anything.
  it('unlinks tmux-lane symlinks instead of globbing through them', () => {
    const preCheckout = stepIn('tmux-testing', 'Clean stale review worktrees');
    expect(preCheckout).toContain('[ -L .qwen ] && rm -f .qwen');
    expect(preCheckout).toContain('if [ -L .qwen/tmp ]; then');
    const endOfJob = stepIn('tmux-testing', 'Clean up runner workspace');
    expect(endOfJob).toContain('[ -L .qwen ] && rm -f .qwen');
    expect(endOfJob).toContain('if [ -L .qwen/tmp ]; then');
  });

  // cp -r copies symlinks as symlinks, but actions/upload-artifact follows
  // them — a node-planted link would exfiltrate its target into the artifact
  // and then into the public PR comment.
  it('strips symlinks from collected tmux artifacts', () => {
    const runStep = stepIn('tmux-testing', 'Run tmux real-user testing');
    const collect = runStep.indexOf('cp -r {} "$RUNNER_TEMP/tmux-results/"');
    expect(collect).toBeGreaterThan(-1);
    const strip = runStep.indexOf(
      'find "$RUNNER_TEMP/tmux-results" -type l -delete',
    );
    expect(strip).toBeGreaterThan(collect);
  });

  // Escaping inflates & < > by 4-5 bytes each, so a raw-side cap can push
  // the assembled comment past GitHub's 65,536-char limit and 422 the post.
  it('caps the tmux comment after escaping, on a character boundary', () => {
    const publish = stepIn('publish-tmux', 'Post tmux result comment');
    const escFirst = publish.indexOf('html_escape > "$esc_file"');
    expect(escFirst).toBeGreaterThan(-1);
    expect(publish).toContain('TextDecoder');
    expect(publish).not.toContain('head -c "$max" "$file" | tr -d');

    // Execute it: dense metacharacter content must stay under the cap and
    // remain valid UTF-8.
    const script = publish
      .match(/run: \|-\n([\s\S]*)$/)?.[1]
      .replace(/^ {10}/gm, '');
    const helpers = script.slice(
      script.indexOf('html_escape()'),
      script.indexOf('if [ "${TMUX_RESULT:-}"'),
    );
    const dir = mkdtempSync(join(tmpdir(), 'tmux-emit-'));
    try {
      const dense = join(dir, 'dense.log');
      writeFileSync(dense, '<T<U>>&'.repeat(7300));
      const utf8 = join(dir, 'utf8.log');
      // One ASCII byte of padding so the cut lands inside a 3-byte char.
      writeFileSync(utf8, `x${'验证证据链路测试'.repeat(8000)}`);
      const emit = (file) => {
        const proc = spawnSync(
          'bash',
          ['-c', `${helpers}\nemit_block 'Log' "$1" 20000`, '_', file],
          { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
        );
        expect(proc.status).toBe(0);
        return proc.stdout;
      };
      const capped = emit(dense);
      expect(Buffer.byteLength(capped)).toBeLessThan(65536);
      expect(capped).toContain('truncated');
      const cut = emit(utf8);
      expect(cut).not.toContain('\ufffd');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A detached lifecycle child can outlive the build step and the one-shot
  // sweep, re-planting artifacts or scanning localhost for the model proxy.
  // The verify lane kills the build user's processes before any cleanup; the
  // tmux lane runs the same untrusted code on the same pool and must too.
  it('kills surviving build-user processes before the tmux agent starts', () => {
    const runStep = stepIn('tmux-testing', 'Run tmux real-user testing');
    expect(runStep).toContain('pkill -KILL -u node');
    expect(runStep).toContain(
      'Processes owned by the build user survived SIGKILL; refusing to start the agent.',
    );
    // Before the sweep and the proxy: the cleanup must not race a live
    // process, and no leftover child may be alive when the proxy binds.
    const killAt = runStep.indexOf('pkill -KILL -u node');
    expect(killAt).toBeGreaterThan(-1);
    expect(killAt).toBeLessThan(
      runStep.indexOf("find tmp -maxdepth 2 -type d -name '*-tmux-*'"),
    );
    expect(killAt).toBeLessThan(runStep.indexOf('start_openai_proxy'));
  });

  // publish-verify bounds itself so a hung gh call cannot hold a hosted
  // runner for the 360-minute default; publish-tmux posts the same way.
  it('bounds the publish-tmux job with a timeout', () => {
    const publish = job('publish-tmux');
    expect(publish).toMatch(/timeout-minutes: \d+/);
    const minutes = Number(publish.match(/timeout-minutes: (\d+)/)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  // A per-RUN concurrency group (not per-PR) stops two publish-tmux jobs in
  // the same run racing the post, while never letting a newer run cancel a
  // completed run's pending publisher and drop its report. Parity with
  // publish-verify.
  it('serializes publish-tmux with a per-run concurrency group', () => {
    const publish = job('publish-tmux');
    expect(publish).toContain('concurrency:');
    expect(publish).toContain('publish-tmux-{1}');
    expect(publish).toContain('cancel-in-progress: false');
  });

  // The publisher must select the agent's report by TYPE and anchored PATH,
  // not a loose `-name report.md | head -1`: a planted DIRECTORY named
  // report.md that sorted ahead of the real one won the old predicate, and
  // emit_block's [ -f ] guard then dropped the report silently while the
  // non-empty REPORT string suppressed the missing-artifact note. Parity
  // with the verify lane's predicate.
  it('selects tmux artifacts by type and path, ignoring planted directories', () => {
    const publish = stepIn('publish-tmux', 'Post tmux result comment');
    expect(publish).toContain(
      "find tmux-results -mindepth 2 -type f -path '*-tmux-*/report.md' 2>/dev/null | sort | head -1",
    );
    expect(publish).toContain(
      "find tmux-results -mindepth 2 -type f -path '*-tmux-*/tmux-readable-full.log' 2>/dev/null | sort | head -1",
    );

    const dir = mkdtempSync(join(tmpdir(), 'tmux-select-'));
    try {
      // A planted directory named report.md that sorts FIRST.
      mkdirSync(join(dir, 'tmux-results/AAA-planted-tmux-0/report.md'), {
        recursive: true,
      });
      mkdirSync(join(dir, 'tmux-results/real-tmux-1'), { recursive: true });
      writeFileSync(
        join(dir, 'tmux-results/real-tmux-1/report.md'),
        '## real report\n',
      );
      const out = spawnSync(
        'bash',
        [
          '-c',
          "find tmux-results -mindepth 2 -type f -path '*-tmux-*/report.md' 2>/dev/null | sort | head -1",
        ],
        { encoding: 'utf8', cwd: dir },
      ).stdout.trim();
      expect(out).toBe('tmux-results/real-tmux-1/report.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Dedup must PATCH only a BOT-OWNED comment STARTING with the marker.
  // contains() with no author filter let a human reviewer who quoted the
  // marker have their comment overwritten by the bot's PAT (#7723). Fail
  // closed on identity, same as publish-verify.
  it('dedups the tmux comment on a bot-owned prefix match, fail-closed', () => {
    const publish = stepIn('publish-tmux', 'Post tmux result comment');
    expect(publish).toContain('startswith("<!-- qwen-triage:tmux -->")');
    expect(publish).toContain('.user.login == $bot');
    expect(publish).not.toContain('contains("<!-- qwen-triage:tmux -->")');
    expect(publish).toContain("gh api user --jq '.login'");
  });

  // GitHub 422s a comment over 65,536 chars and posts nothing. The invariant
  // is the SUM of the two block caps plus the envelope, not any single block:
  // a single-block assertion passes for any cap under ~65,000, so bumping the
  // transcript cap from 30000 to 60000 would 422 the post undetected.
  it('keeps the sum of the tmux block caps under the comment limit', () => {
    const publish = stepIn('publish-tmux', 'Post tmux result comment');
    const reportCap = Number(
      publish.match(/emit_block 'E2E test report' "\$REPORT" (\d+)/)?.[1],
    );
    const transcriptCap = Number(
      publish.match(
        /emit_block 'Full tmux transcript' "\$TRANSCRIPT" (\d+)/,
      )?.[1],
    );
    expect(reportCap).toBeGreaterThan(0);
    expect(transcriptCap).toBeGreaterThan(0);
    const envelope = 4096; // verdict header, description, markers, signature
    expect(reportCap + transcriptCap + envelope).toBeLessThan(65536);
  });

  // The cache step must be restore-only: `actions/cache/restore` has no
  // post-save hook, so PR lifecycle scripts cannot write to the shared
  // cache. Swapping to `actions/cache` would re-enable the save path and
  // let a PR poison subsequent runs.
  it('pins the npm cache step to restore-only in both lanes', () => {
    for (const jobName of ['verify', 'tmux-testing']) {
      const cacheStep = stepIn(jobName, 'Restore npm cache');
      expect(cacheStep).toContain('actions/cache/restore@');
      expect(cacheStep).not.toMatch(/uses:\s*'actions\/cache@/);
      // A separate save step would reopen the same hole the
      // restore-only variant closes.
      expect(job(jobName)).not.toContain('actions/cache/save@');
      expect(job(jobName)).not.toMatch(/uses:\s*'actions\/cache@/);
    }
  });

  it('points npm ci at the restored cache directory in both lanes', () => {
    for (const jobName of ['verify', 'tmux-testing']) {
      const prepare = stepIn(jobName, 'Install and build PR app');
      expect(prepare).toContain('--cache "$RUNNER_TEMP/npm-cache"');
      expect(prepare).toContain(
        'npm ci --prefer-offline --no-audit --progress=false --cache "$RUNNER_TEMP/npm-cache"',
      );
      expect(prepare).toContain('mkdir -p "$RUNNER_TEMP/npm-cache"');
      expect(prepare).toContain('chown -R node:node "$RUNNER_TEMP/npm-cache"');
      const cacheStep = stepIn(jobName, 'Restore npm cache');
      const cachePath = cacheStep.match(
        /path:\s*'\$\{\{\s*runner\.temp\s*\}\}\/([^']+)'/,
      )?.[1];
      expect(cachePath).toBeTruthy();
      const npmCaches = [
        ...prepare.matchAll(/--cache "\$RUNNER_TEMP\/([^"]+)"/g),
      ].map((m) => m[1]);
      expect(npmCaches.length).toBeGreaterThanOrEqual(2);
      for (const c of npmCaches) expect(c).toBe(cachePath);
    }
  });
  it('clears stale npm cache before restore in both lanes', () => {
    for (const jobName of ['verify', 'tmux-testing']) {
      const clearStep = stepIn(jobName, 'Clear stale npm cache');
      expect(clearStep, `${jobName} must have a clear step`).toContain(
        'rm -rf',
      );
      const clearIdx = job(jobName).indexOf("'Clear stale npm cache'");
      const restoreIdx = job(jobName).indexOf("'Restore npm cache'");
      expect(clearIdx).toBeGreaterThan(-1);
      expect(restoreIdx).toBeGreaterThan(-1);
      expect(clearIdx).toBeLessThan(restoreIdx);
    }
  });

  it('reports the npm cache hit so a permanent miss is visible in both lanes', () => {
    for (const jobName of ['verify', 'tmux-testing']) {
      const cacheStep = stepIn(jobName, 'Restore npm cache');
      expect(cacheStep).toContain("id: 'npm-cache'");
      const reportStep = stepIn(jobName, 'Report npm cache hit');
      expect(reportStep).toContain('steps.npm-cache.outputs.cache-hit');
      expect(reportStep).toContain('GITHUB_STEP_SUMMARY');
    }
  });
});

describe('qwen-triage npm cache producer', () => {
  it('saves with the same key and path the triage lanes restore', () => {
    expect(cacheProducerWorkflow).toContain('actions/cache/save@');
    // Prettier may choose single or double quotes depending on inner
    // quote characters, so compare the parsed scalar, not the raw YAML.
    const yamlScalar = (raw) => {
      if (!raw) return '';
      if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
      return raw.startsWith('"') ? raw.slice(1, -1) : raw;
    };
    const savePath = yamlScalar(
      cacheProducerWorkflow.match(/path:\s*('[^']+'|"[^"]+")/)?.[1],
    );
    const saveKey = yamlScalar(
      cacheProducerWorkflow.match(/key:\s*('(?:[^']|'')+'|"[^"]+")/)?.[1],
    );
    for (const jobName of ['verify', 'tmux-testing']) {
      const restoreStep = stepIn(jobName, 'Restore npm cache');
      const path = yamlScalar(
        restoreStep.match(/path:\s*('[^']+'|"[^"]+")/)?.[1],
      );
      const key = yamlScalar(
        restoreStep.match(/key:\s*('(?:[^']|'')+'|"[^"]+")/)?.[1],
      );
      expect(path).toBeTruthy();
      expect(key).toBeTruthy();
      expect(savePath).toBe(path);
      expect(saveKey).toBe(key);
    }
  });

  it('triggers on push to main', () => {
    expect(cacheProducerWorkflow).toMatch(/push:/);
    expect(cacheProducerWorkflow).toMatch(/branches:\s*\['main'\]/);
  });

  it('runs on the same target as the consumers so the cache version matches', () => {
    // actions/cache scopes an entry by a hash of the literal cache path plus
    // the compression method, so a producer on a different runner or outside
    // the container computes a different version and every restore misses
    // even when the key and path strings match.
    expect(cacheProducerWorkflow).toContain(
      "runs-on: ['self-hosted', 'linux', 'x64', 'ecs-qwen']",
    );
    expect(cacheProducerWorkflow).toContain("image: 'node:22-bookworm'");
    expect(cacheProducerWorkflow).toContain("options: '--init --user node'");
    for (const jobName of ['verify', 'tmux-testing']) {
      expect(job(jobName)).toContain(
        "runs-on: ['self-hosted', 'linux', 'x64', 'ecs-qwen']",
      );
      expect(job(jobName)).toContain("image: 'node:22-bookworm'");
    }
  });
});

describe('qwen-triage build-process guard', () => {
  // The guard fired on a real run (job 30267953352) and failed the job with
  // nothing but "processes survived" — no pid, no state, no command line.
  // Nobody could tell a genuine leftover from a harmless one, including the
  // person who wrote it. Both lanes now name what survived.
  it('names the surviving processes instead of just refusing', () => {
    for (const lane of ['verify', 'tmux-testing']) {
      const runStep = stepIn(
        lane,
        lane === 'verify'
          ? 'Run verification agent'
          : 'Run tmux real-user testing',
      );
      expect(runStep, `${lane} lost the guard`).toContain(
        'live_build_processes',
      );
      expect(runStep).toContain('surviving process:');
      expect(runStep).toContain(
        'Processes owned by the build user survived SIGKILL; refusing to start the agent.',
      );
    }
  });

  // `ps -u node` exits 1 when the user owns zero processes. Under
  // `set -euo pipefail` the bare assignment would die silently on the
  // success path — the `|| true` absorbs the no-match status.
  it('"survivors" assignment tolerates zero processes under pipefail', () => {
    for (const lane of ['verify', 'tmux-testing']) {
      const runStep = stepIn(
        lane,
        lane === 'verify'
          ? 'Run verification agent'
          : 'Run tmux real-user testing',
      );
      expect(
        runStep,
        `${lane}: survivors assignment must survive ps exit 1`,
      ).toContain('survivors="$(live_build_processes)" || true');
    }
  });

  // A zombie cannot be killed and cannot execute anything, so counting one
  // means this check can never clear.
  //
  // PLATFORM NOTE, and the reason this test is split in two: Linux pgrep
  // reports defunct processes ("Defunct processes are reported." — pgrep(1),
  // procps-ng), which is why the original `pgrep -u node` guard could hang
  // on a zombie in CI. macOS pgrep does NOT list them, so the behavioural
  // arm below cannot discriminate the old implementation from the new one
  // here — verified directly: ps lists our zombie, pgrep does not. The
  // structural assertion is therefore the one that holds on every platform.
  it('excludes zombies from the surviving-process check', () => {
    for (const lane of ['verify', 'tmux-testing']) {
      const runStep = stepIn(
        lane,
        lane === 'verify'
          ? 'Run verification agent'
          : 'Run tmux real-user testing',
      );
      const body = runStep
        .match(/live_build_processes\(\) \{\n([\s\S]*?)\n\s*\}/)?.[1]
        ?.trim();
      expect(body, `${lane}: no live_build_processes body`).toBeTruthy();
      // It must read process STATE and drop zombies. `pgrep` alone cannot:
      // on Linux it reports defunct processes and offers no default filter.
      expect(body, `${lane}: the filter must inspect process state`).toMatch(
        /stat=/,
      );
      expect(body, `${lane}: the filter must exclude zombies`).toMatch(
        /\/\^Z\//,
      );
      expect(body).not.toMatch(/^pgrep\b/);
    }
  });

  // The OS property the exclusion rests on: a zombie survives SIGKILL and
  // ps still lists it, so an unfiltered check would never clear.
  it('confirms a zombie survives SIGKILL and stays visible to ps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zombie-'));
    try {
      writeFileSync(
        join(dir, 'mkzombie.py'),
        [
          'import os, time',
          'pid = os.fork()',
          'if pid == 0:',
          '    os._exit(0)',
          'print(pid, flush=True)',
          'time.sleep(8)',
        ].join('\n'),
      );
      const driver = [
        'set -u',
        `python3 "$1/mkzombie.py" > "$1/zpid" &`,
        'PP=$!',
        'sleep 1',
        'Z="$(tr -d " \n" < "$1/zpid")"',
        '[ -n "$Z" ] || { echo "no-zombie"; kill $PP 2>/dev/null; exit 0; }',
        'kill -9 "$Z" 2>/dev/null',
        'sleep 0.5',
        'echo "state=$(ps -o stat= -p "$Z" 2>/dev/null | tr -d " ")"',
        'echo "unfiltered=$(ps -o pid= -p "$Z" 2>/dev/null | wc -l | tr -d " ")"',
        `echo "filtered=$(ps -o pid=,stat=,args= -p "$Z" 2>/dev/null | awk '$2 !~ /^Z/' | wc -l | tr -d ' ')"`,
        'kill $PP 2>/dev/null',
      ].join('\n');
      const out = spawnSync('bash', ['-c', driver, '_', dir], {
        encoding: 'utf8',
        timeout: 30000,
      }).stdout;
      if (out.includes('no-zombie')) return;
      expect(out).toMatch(/state=Z/);
      expect(out).toContain('unfiltered=1');
      expect(out).toContain('filtered=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('triage job budget', () => {
  // The fixed 30-minute cap was measurably clipping the distribution: 22
  // successful triage jobs sampled on 2026-08-09 ran median 5.8m / p90
  // 22.3m / max 29.5m, and five substantial PRs died at exactly the cap,
  // each discarding a full agent run for nothing — triage is advisory, so
  // a killed run wastes the runner AND the work it was about to publish.
  // The budget is a repository variable so the next resize needs no PR;
  // the fallback keeps an unconfigured repo bounded. Both halves pinned so
  // neither the knob nor its default can silently vanish.
  it('is operator-tunable through the sanitized authorize output', () => {
    // Pinned on the PARSED document, not job-text containment: relocating
    // either line inside the same job (the output mapping into the budget
    // step's env:, the job-level timeout-minutes onto a step) kept every
    // substring match green while the knob silently died — probe-verified
    // surviving mutations of the substring version. A parsed key also
    // cannot match a commented-out line.
    const doc = parse(workflow);
    expect(doc.jobs.authorize.outputs.triage_timeout_minutes).toBe(
      '${{ steps.budget.outputs.triage_timeout_minutes }}',
    );
    expect(doc.jobs.triage['timeout-minutes']).toBe(
      '${{ fromJSON(needs.authorize.outputs.triage_timeout_minutes || 60) }}',
    );
  });

  it('sanitizes the budget: integers clamp, garbage falls back with a warning', () => {
    // The REAL sanitize step, replayed: timeout-minutes is evaluated before
    // any step of the consuming job runs, so this bash is the only place a
    // bad repository variable can be caught — and the knob's whole point is
    // changing it without a PR, so nothing else reviews the value.
    const doc = parse(workflow);
    const budget = doc.jobs.authorize.steps.find((s) => s.id === 'budget');
    expect(budget).toBeTruthy();
    // The replay injects RAW itself, so pin the seams it cannot see: which
    // repository variable feeds RAW (a typo'd name expands to '' and hits
    // the silent default), and that the step is unconditional (a scoped
    // step skips on comment events and '' || 60 kills the knob there).
    expect(budget.env.RAW).toBe('${{ vars.QWEN_TRIAGE_TIMEOUT_MINUTES }}');
    expect(budget.if).toBeUndefined();
    const runBudget = (raw) => {
      const dir = mkdtempSync(join(tmpdir(), 'budget-'));
      try {
        const outFile = join(dir, 'out');
        writeFileSync(outFile, '');
        // GitHub wraps `shell: bash` steps as `bash --noprofile --norc -eo
        // pipefail {0}`; makeGhHarness pins the same contract. The script
        // self-arms `set -euo pipefail`, but only the wrapper's `-e` keeps
        // the replay fail-fast if a future edit drops that line.
        const res = execFileSync(
          'bash',
          ['--noprofile', '--norc', '-eo', 'pipefail', '-c', budget.run],
          {
            encoding: 'utf8',
            env: { ...process.env, RAW: raw, GITHUB_OUTPUT: outFile },
          },
        );
        return {
          out: readFileSync(outFile, 'utf8').trim(),
          warned: res.includes('::warning::'),
          log: res,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // unset → default, silently
    expect(runBudget('')).toMatchObject({
      out: 'triage_timeout_minutes=60',
      warned: false,
    });
    // a sane value passes through untouched
    expect(runBudget('90')).toMatchObject({
      out: 'triage_timeout_minutes=90',
      warned: false,
    });
    // a padded value must stay decimal — without 10#, bash parses 060 as
    // octal (48)
    expect(runBudget('060')).toMatchObject({
      out: 'triage_timeout_minutes=60',
      warned: false,
    });
    // exactly at the boundaries: no clamp, no warning
    expect(runBudget('10')).toMatchObject({
      out: 'triage_timeout_minutes=10',
      warned: false,
    });
    expect(runBudget('600')).toMatchObject({
      out: 'triage_timeout_minutes=600',
      warned: false,
    });
    // 0 would be an instantly-cancelled job — clamped to the floor
    expect(runBudget('0')).toMatchObject({
      out: 'triage_timeout_minutes=10',
      warned: true,
    });
    // a runaway value would hold the runner for days — ceiling
    expect(runBudget('3600')).toMatchObject({
      out: 'triage_timeout_minutes=600',
      warned: true,
    });
    // over 18 digits bash's 64-bit math wraps — 92233720368547758180
    // lands on 100, silently in range — so the length guard must clamp
    // to the ceiling with a warning instead
    expect(runBudget('92233720368547758180')).toMatchObject({
      out: 'triage_timeout_minutes=600',
      warned: true,
    });
    // The guard counts SIGNIFICANT digits: leading zeros are decoration,
    // so a padded 60 passes through untouched instead of tripping the
    // ceiling branch, and an all-zero value is still 0 → floor
    expect(runBudget('000000000000000000060')).toMatchObject({
      out: 'triage_timeout_minutes=60',
      warned: false,
    });
    expect(runBudget('0'.repeat(22))).toMatchObject({
      out: 'triage_timeout_minutes=10',
      warned: true,
    });
    // ...and padding must not defeat the wrap guard either: 19
    // significant digits still clamp to the ceiling
    expect(runBudget('000' + '9'.repeat(19))).toMatchObject({
      out: 'triage_timeout_minutes=600',
      warned: true,
    });
    // every malformed shape the review enumerated falls back and NAMES the
    // variable, so the operator's run log points at the knob, not fromJSON
    for (const bad of ['60 minutes', '1h', '6O', '60.5', '"60"']) {
      const r = runBudget(bad);
      expect(r.out, bad).toBe('triage_timeout_minutes=60');
      expect(r.log, bad).toContain('QWEN_TRIAGE_TIMEOUT_MINUTES');
    }
  });
});

describe('triage skips the autofix bot’s own bookkeeping issues (#9264)', () => {
  // Every PR that defers findings for the first time opens a tracking issue
  // upserted by the autofix bot, and `issues: [opened, edited, reopened]`
  // triaged that bookkeeping issue with a full agent run per deferral. The
  // guard keys on the same identity qwen-autofix.yml upserts under, so a
  // rename on one side without the other silently re-opens the waste.
  const botIdentityCore = "vars.AUTOFIX_BOT_LOGIN || 'qwen-code-dev-bot'";
  const botIdentity = `(${botIdentityCore})`;

  // The parsed expressions keep their YAML line breaks, so whitespace is
  // normalized before matching — the pin must survive a re-wrap, not test it.
  const flat = (value) => String(value).replace(/\s+/g, ' ');

  it('conditions the triage job’s issues clause on the creator not being the bot', () => {
    // Parsed, not raw-text containment: a commented-out guard would still
    // match a substring pin.
    const doc = parse(workflow);
    expect(flat(doc.jobs.triage.if)).toContain(
      `(github.event_name == 'issues' && github.event.issue.user.login != ${botIdentity}) || (github.event_name == 'workflow_dispatch'`,
    );
  });

  it('routes bot-created issues runs to a per-run concurrency group', () => {
    // GitHub evaluates concurrency BEFORE the job `if`: a bot bookkeeping run
    // inside the shared per-number group cancels an in-progress triage of the
    // same issue even though its own job skips.
    const doc = parse(workflow);
    expect(flat(doc.jobs.triage.concurrency.group)).toContain(
      `!startsWith(github.event.comment.body, '@qwen-code /triage'))) || (github.event_name == 'issues' && github.event.issue.user.login == ${botIdentity}) ) && format('{0}-run-{1}', github.workflow, github.run_id)`,
    );
  });

  it('keeps the guard identity in sync with the autofix workflow', () => {
    // qwen-autofix.yml defines AUTOFIX_BOT as the same variable-with-fallback
    // (inside a bare `${{ }}`, so without the expression's parentheses).
    expect(botIdentity).toContain(botIdentityCore);
    const autofixDoc = parse(
      readFileSync('.github/workflows/qwen-autofix.yml', 'utf8'),
    );
    expect(autofixDoc.env.AUTOFIX_BOT).toBe(`\${{ ${botIdentityCore} }}`);
  });
});

describe('stage 1-pre duplicate gate', () => {
  const section = prSkill.slice(
    prSkill.indexOf('**1-pre. Duplicate / already-fixed check'),
    prSkill.indexOf('**1a. Template check:**'),
  );

  it('reads linked issues from GitHub closing references, not a keyword grep', () => {
    // A keyword grep misses 6 of the 9 closing-keyword forms and matches
    // substrings like "prefixes"; GitHub's own parser is the linkage source.
    expect(section).toContain('--json closingIssuesReferences');
    expect(section).not.toContain("grep -oiE '(fixes|closes|resolves)");
  });

  it('runs only for PRs targeting the default branch', () => {
    // Backports to release/* branches legitimately carry changes that already
    // exist on the default branch; without this scope the gate closes them.
    expect(section).toContain('Run 1-pre only when the PR targets the default');
    expect(section).toContain('defaultBranchRef');
    expect(section).not.toContain('?ref=main');
  });

  it('defines subsumption over the full diff, never over added lines alone', () => {
    // Added-lines-only quantification closes deletions-only diffs vacuously;
    // the deleted-lines clause must stay.
    expect(section).toContain('every production line this PR adds');
    expect(section).toContain('every production line this PR deletes');
  });

  it('never closes a diff with no production changes', () => {
    // Stage 0 exclusions empty the comparison set for tests-only PRs; such a
    // diff must be a remaining delta, never "Fully subsumed".
    expect(section).toContain('NO production changes');
    expect(section).toContain('never fully subsumed');
  });

  it('scopes linkage extraction to same-repo closing references', () => {
    // A bare `.number` extraction drops the repository qualifier, so a
    // cross-repo closing reference resolves against this repo's
    // same-numbered unrelated issue. The scoping filter and the skip rule
    // must stay.
    expect(section).toContain('.repository.owner.login');
    expect(section).toContain('cross-repo closing references are skipped');
  });

  it('guards the duplicate close against a human reopen', () => {
    // A re-run on a reopened PR re-derives identical inputs; without the
    // reopen guard the gate re-closes against a maintainer's deliberate
    // reopen, and every later re-run closes again. Deleting the guard must
    // make this red.
    expect(section).toContain('**Reopen guard.**');
    expect(section).toContain('do not post or close again');
  });

  it('binds each linked-issue state to its gate action', () => {
    // The per-issue dispatch is the gate's decision table; deleting it or
    // swapping the NOT_PLANNED and COMPLETED actions must not leave the
    // suite green. The loop only collects states, so an OPEN issue must not
    // short-circuit to 1a over a CLOSED one.
    expect(section).toContain('"OPEN" -> contributes nothing');
    expect(section).toContain('"CLOSED NOT_PLANNED" -> request changes');
    expect(section).toContain('"CLOSED COMPLETED" -> run the closer query');
    expect(section).not.toContain('"OPEN" -> proceed to 1a');
  });

  it('defines one fixed precedence for mixed linked-issue states', () => {
    // xe6u: `fixes #101 and fixes #102` with #101 OPEN, #102 CLOSED-COMPLETED
    // must have one deterministic outcome. Without an explicit precedence the
    // per-issue loop legend and the aggregate bullets contradict each other.
    expect(section).toContain('fixed precedence');
    expect(section).toContain('never short-circuits');
  });

  it('never closes on an unresolvable closer', () => {
    // The ambiguity bullet is the only explicit prohibition against closing
    // on a closer that cannot be resolved; deleting it must make this red.
    expect(section).toContain('never close on ambiguity');
  });

  it('SKILL.md restates the 1-pre boundary without a production qualifier', () => {
    // xe6: SKILL.md's escalation summary must match pr-workflow.md's
    // operational definition — request changes on ANY remaining delta, close
    // only when the ENTIRE diff is subsumed. Re-qualifying either side with
    // "production" contradicts "any non-production addition is a remaining
    // delta" and "a diff with NO production changes is never fully subsumed",
    // giving a tests-only PR opposite instructions in the two files.
    const summary = triageSkillDoc.slice(
      triageSkillDoc.indexOf('The escalation criteria are those defined in'),
      triageSkillDoc.indexOf('Never execute PR-derived code'),
    );
    expect(summary).toContain('a remaining delta');
    expect(summary).toContain('entire diff');
    expect(summary).toContain('fully subsumed');
    expect(summary).not.toContain('production delta');
    expect(summary).not.toContain('production diff');
  });
});
