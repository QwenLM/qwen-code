/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const signalPath = '.github/workflows/qwen-autofix-fork-signal.yml';
const bridgePath = '.github/workflows/qwen-autofix-fork-bridge.yml';
const autofixPath = '.github/workflows/qwen-autofix.yml';
const signalText = readFileSync(signalPath, 'utf8');
const bridgeText = readFileSync(bridgePath, 'utf8');
const signal = parse(signalText);
const bridge = parse(bridgeText);
const autofix = parse(readFileSync(autofixPath, 'utf8'));

const signalJob = signal.jobs.signal;
const bridgeJob = bridge.jobs.dispatch;
const bridgeScript = bridgeJob.steps[0].run;

// Does the file actually READ a secret, as opposed to naming one in prose?
// Both workflows explain themselves by referring to `secrets.CI_DEV_BOT_PAT`,
// so only an expression counts.
const readsASecret = (text) => /\$\{\{[^}]*\bsecrets\./.test(text);

describe('qwen autofix fork bridge', () => {
  it('keeps the trigger name, artifact name and dispatch target wired together', () => {
    // Three cross-FILE contracts that no single file can be read to verify.
    // Each one, broken, leaves both files individually valid and the bridge
    // permanently silent — the exact failure this suite exists to catch.

    // `workflow_run` matches on the triggering workflow's `name:`, not its
    // path, so renaming the signal workflow decouples the two silently.
    expect(bridge.on.workflow_run.workflows).toEqual([signal.name]);
    expect(bridge.on.workflow_run.types).toEqual(['completed']);

    // The bridge downloads by artifact name.
    const upload = signalJob.steps.find((s) =>
      String(s.uses ?? '').startsWith('actions/upload-artifact@'),
    );
    expect(upload).toBeTruthy();
    expect(bridgeScript).toContain(`--name '${upload.with.name}'`);
    // …and reads the file the signal actually writes into it.
    expect(signalJob.steps[0].run).toContain(`> ${upload.with.path}`);
    expect(bridgeScript).toContain(`/${upload.with.path}`);

    // The dispatch target must exist and accept the input the bridge passes.
    expect(bridgeScript).toContain('gh workflow run qwen-autofix.yml');
    expect(bridgeScript).toContain('-f pr_number=');
    expect(Object.keys(autofix.on.workflow_dispatch.inputs)).toContain(
      'pr_number',
    );
  });

  it('gives the fork-triggered half nothing worth stealing', () => {
    // The signal is the ONLY half a fork PR's event can reach. GitHub already
    // withholds secrets there, but the token is not withheld — so the
    // permissions are emptied explicitly, and nothing in it may read a secret
    // or run repository code.
    expect(signal.permissions).toEqual({});
    // Matched as an EXPRESSION, not as a substring: both files discuss
    // `secrets.CI_DEV_BOT_PAT` in prose to explain why they exist, and a
    // grep-shaped assertion would either fail on that prose or be deleted.
    expect(readsASecret(signalText)).toBe(false);
    expect(signalText).not.toContain('actions/checkout');
    // Never the persistent pool: a self-hosted workspace outlives the job, and
    // fork-triggered work must not land in one.
    // Pinned as the resolved value, not as the absence of the word
    // "self-hosted" — the comment above the field explains the rule and would
    // fail a substring check.
    expect(signalJob['runs-on']).toBe('ubuntu-latest');

    // The bridge holds real power (`actions: write` dispatches the lane that
    // pushes commits), so it must not ALSO hold the PAT — that combination in
    // one run is what makes a pwn-request worth attempting.
    expect(bridge.permissions.actions).toBe('write');
    expect(readsASecret(bridgeText)).toBe(false);
    expect(bridgeText).not.toContain('actions/checkout');
  });

  it('signals only the PRs the direct lane cannot serve', () => {
    const gate = signalJob.if;
    // Fork-only. In-repo PRs keep their secrets and are served by
    // qwen-autofix.yml directly; signalling them would dispatch a duplicate
    // scan for every review the repository receives.
    expect(gate).toContain(
      'github.event.pull_request.head.repo.full_name != github.repository',
    );
    // The same trust rule route applies, so an untrusted review does not spend
    // a bridge run. Not the authorisation — review-scan re-derives that.
    expect(gate).toContain('github.event.review.author_association');
    expect(gate).toContain('qwen-code-ci-bot');
    expect(gate).toContain("github.event.pull_request.base.ref == 'main'");

    // A signal that gated itself out completes `skipped`; the bridge must not
    // treat that as something to act on.
    expect(bridgeJob.if).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
  });

  it('binds the signalled PR to the run that produced it', () => {
    // `workflow_run.pull_requests` is EMPTY for fork PRs and
    // `/commits/{sha}/pulls` does not resolve a fork head either, so the PR
    // number can only come from the artifact. This is the check that makes
    // acting on it safe, replayed against a stub API.
    const runBridge = ({
      artifact = '8436',
      headOid = 'b8ac04ef',
      signalHeadSha = 'b8ac04ef',
      state = 'OPEN',
      base = 'main',
      fork = true,
      downloadFails = false,
      prReadFails = false,
      dispatchFails = 0,
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'fork-bridge-'));
      try {
        const callsFile = join(dir, 'calls');
        const summaryFile = join(dir, 'summary');
        writeFileSync(callsFile, '');
        writeFileSync(summaryFile, '');
        writeFileSync(
          join(dir, 'gh'),
          `#!/bin/bash
printf '%q ' "$@" >> '${callsFile}'
printf '\\n' >> '${callsFile}'
if [[ "$1" == 'run' && "$2" == 'download' ]]; then
  ${downloadFails ? 'exit 1' : ''}
  # gh writes the artifact's files into --dir; mirror that, including the
  # trailing newline printf leaves behind.
  out=''
  while [[ $# -gt 0 ]]; do [[ "$1" == '--dir' ]] && out="$2"; shift; done
  printf '%s\\n' '${artifact}' > "\${out}/pr-number.txt"
  exit 0
fi
if [[ "$1" == 'pr' && "$2" == 'view' ]]; then
  ${prReadFails ? 'exit 1' : ''}
  printf '%s' '{"number":8436,"state":"${state}","baseRefName":"${base}","headRefOid":"${headOid}","isCrossRepository":${fork}}'
  exit 0
fi
if [[ "$1" == 'workflow' && "$2" == 'run' ]]; then
  n="$(cat '${dir}/dispatches' 2> /dev/null || echo 0)"
  n=$(( n + 1 )); printf '%s' "$n" > '${dir}/dispatches'
  [[ "$n" -le ${dispatchFails} ]] && exit 1
  exit 0
fi
exit 1
`,
        );
        chmodSync(join(dir, 'gh'), 0o755);
        const result = spawnSync(
          'bash',
          [
            '-c',
            // Production shell for a `run:` step under `defaults.run.shell:
            // bash` — errexit and pipefail both live.
            ['set -eo pipefail', 'sleep() { :; }', bridgeScript].join('\n'),
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              REPO: 'QwenLM/qwen-code',
              SIGNAL_RUN_ID: '31152873061',
              SIGNAL_HEAD_SHA: signalHeadSha,
              GITHUB_TOKEN: 'stub',
              GITHUB_SERVER_URL: 'https://github.com',
              GITHUB_STEP_SUMMARY: summaryFile,
            },
            encoding: 'utf8',
          },
        );
        return {
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          calls: readFileSync(callsFile, 'utf8'),
          summary: readFileSync(summaryFile, 'utf8'),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // Happy path: the signalled PR's head is the head the signal run carried.
    const ok = runBridge({});
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(ok.calls).toContain('pr_number=8436');
    expect(ok.stdout).toContain('dispatched the autofix review lane');
    expect(ok.summary).toContain('#8436');

    // FORGERY: a signal naming a PR it did not come from. The named PR is real
    // and open, so every other check passes — only the head binding refuses
    // it. Without this, a tampered signal would aim a credentialed dispatch at
    // an arbitrary PR.
    const forged = runBridge({ artifact: '9999', headOid: 'deadbeef' });
    expect(forged.status).toBe(1);
    expect(forged.stdout).toContain('not bound to the run that produced it');
    expect(forged.calls).not.toContain('workflow run');

    // Fails CLOSED on a head the API did not return, rather than reading the
    // empty string as "no mismatch".
    const noHead = runBridge({ headOid: '' });
    expect(noHead.status).toBe(1);
    expect(noHead.calls).not.toContain('workflow run');

    // The case the emptiness guard exists for, and the only one a bare `!=`
    // gets wrong: BOTH sides unreadable compare equal, so the binding would
    // silently pass and dispatch on a signal bound to nothing.
    const bothEmpty = runBridge({ headOid: '', signalHeadSha: '' });
    expect(bothEmpty.status).toBe(1);
    expect(bothEmpty.calls).not.toContain('workflow run');

    // Garbage never reaches the API at all.
    for (const artifact of ['', 'not-a-number', '0', '../../etc/passwd']) {
      const junk = runBridge({ artifact });
      expect(junk.status).toBe(1);
      expect(junk.stdout).toContain('did not carry a PR number');
      expect(junk.calls).not.toContain('pr view');
    }

    // Between the review and now the PR can close or retarget. Green, no
    // dispatch — the state is reported so the quiet run is readable.
    for (const state of [
      { state: 'CLOSED' },
      { base: 'release/v1' },
      { fork: false },
    ]) {
      const gone = runBridge(state);
      expect(gone.status).toBe(0);
      expect(gone.stdout).toContain('no longer needs the bridge');
      expect(gone.calls).not.toContain('workflow run');
    }

    // An unreadable artifact or PR is red: the bridge cannot tell a signal it
    // should have served from one it should not, and staying silent would look
    // exactly like a healthy bridge with nothing to do.
    expect(runBridge({ downloadFails: true }).status).toBe(1);
    expect(runBridge({ prReadFails: true }).status).toBe(1);

    // A transient dispatch failure retries; a persistent one reds the run
    // after three attempts instead of dropping the review on the floor.
    const flaky = runBridge({ dispatchFails: 1 });
    expect(flaky.status).toBe(0);
    expect(flaky.stdout).toContain('dispatched the autofix review lane');
    const dead = runBridge({ dispatchFails: 9 });
    expect(dead.status).toBe(1);
    expect(dead.stderr).toContain('(attempt 3/3)');
    expect(dead.calls.match(/workflow run/g) ?? []).toHaveLength(3);
  });
});
