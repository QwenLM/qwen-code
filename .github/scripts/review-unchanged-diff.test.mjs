/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('./review-unchanged-diff.sh', import.meta.url),
);
const PR = '7';
const REPO = 'QwenLM/qwen-code';

// Real git against real repositories: the skip decision is the one piece of
// this workflow that can LOSE a review (a false "unchanged"), so the tests
// exercise the actual fetch / merge-base / diff path, with a fake `gh` that
// answers the commit-status lookup from a directory of "reviewed" shas.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`,
  );
  return result.stdout.trim();
}

function commit(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

let root;
let origin;
let work;
let ci;
let fakeBin;
let statusDir;

function publishPrHead() {
  git(work, 'push', '-q', 'origin', `HEAD:refs/pull/${PR}/head`);
  return git(work, 'rev-parse', 'HEAD');
}

// Criss-cross fixture: the PR side and main merge EACH OTHER, which is what
// leaves `merge-base --all` holding two best common ancestors. The topology
// is the mechanism — the `--no-ff` flags are decorative, since neither side
// is an ancestor of the other and so neither merge could fast-forward.
// Returns the anchor sha (the criss-cross merge commit) and stops there:
// whether the head built on top of it has a UNIQUE base is each case's own
// doing, not the fixture's. `tag` only namespaces the files and messages so
// two calls in one repo cannot collide.
function crissCrossAnchor(branch, tag) {
  const base = git(work, 'rev-parse', 'main');
  git(work, 'checkout', '-q', '-b', branch, base);
  const prSide = commit(work, `${tag}-pr.txt`, 'pr side\n', `${tag}: pr side`);
  git(work, 'checkout', '-q', 'main');
  const mainSide = commit(
    work,
    `${tag}-main.txt`,
    'main side\n',
    `${tag}: main side`,
  );
  git(work, 'merge', '-q', '--no-edit', '--no-ff', prSide);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', branch);
  git(work, 'merge', '-q', '--no-edit', '--no-ff', mainSide);
  return git(work, 'rev-parse', 'HEAD');
}

function markReviewed(
  sha,
  creator = 'github-actions[bot]',
  verdict = 'APPROVED',
) {
  writeFileSync(join(statusDir, sha), `${creator}|${verdict}`);
}

// Every status lookup the script made, as the fake `gh` recorded them.
function ghCalls() {
  try {
    return readFileSync(join(statusDir, 'calls'), 'utf8').trim();
  } catch {
    return '';
  }
}

function hostTool(tool) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  return found.status === 0 ? found.stdout.trim() : '';
}

// A PATH that holds symlinks to exactly these host tools and nothing else.
// The cases below need a program to be GENUINELY absent: a PATH that merely
// prepends an empty dir still resolves `/usr/bin/gh` — so the "no gh" case
// made a live authenticated api.github.com call and passed on its 401 — and
// `/usr/bin/sha256sum`, so a hasher could never be missing either. Returns
// null when the host lacks one of the tools (the case then skips).
function binFarm(tools) {
  const dir = mkdtempSync(join(root, 'bin-'));
  for (const tool of tools) {
    const path = hostTool(tool);
    if (!path) return null;
    symlinkSync(path, join(dir, tool));
  }
  return dir;
}

function run(
  headSha,
  { env = {}, path = `${fakeBin}:${process.env.PATH}` } = {},
) {
  const result = spawnSync('bash', [SCRIPT, REPO, PR, headSha, 'main'], {
    cwd: ci,
    encoding: 'utf8',
    env: {
      ...gitEnv,
      PATH: path,
      FAKE_STATUS_DIR: statusDir,
      GH_TOKEN: 'fake',
      ...env,
    },
  });
  assert.equal(
    result.status,
    0,
    `script exited ${result.status}:\n${result.stderr}`,
  );
  const lines = result.stdout.trim().split('\n');
  return { verdict: lines[lines.length - 1], stderr: result.stderr };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'review-unchanged-'));
  origin = join(root, 'origin.git');
  work = join(root, 'work');
  ci = join(root, 'ci');
  fakeBin = join(root, 'bin');
  statusDir = join(root, 'statuses');
  mkdirSync(fakeBin);
  mkdirSync(statusDir);
  // The fake answers the endpoint the script actually calls —
  // `repos/<repo>/commits/<sha>/statuses`, the statuses LIST — with the bare
  // ARRAY of statuses that endpoint returns, each carrying its creator. Not
  // the combined status: `.../commits/<sha>/status` returns a single object
  // whose top-level shape has no per-status creator, so a fake that mirrored
  // it could not exercise the creator filter at all.
  writeFileSync(
    join(fakeBin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'set -u',
      'path="${2:-}"',
      'printf \'%s\\n\' "${path}" >> "${FAKE_STATUS_DIR}/calls"',
      'sha="${path#*/commits/}"; sha="${sha%%/*}"',
      'if [ -f "${FAKE_STATUS_DIR}/${sha}" ]; then',
      '  record="$(cat "${FAKE_STATUS_DIR}/${sha}")"',
      '  who="${record%%|*}"; verdict="${record#*|}"',
      '  if [ "$verdict" = LEGACY ]; then description="Reviewed by Qwen Code /review"; else description="Reviewed by Qwen Code /review; verdict=${verdict}"; fi',
      '  printf \'[{"id":1,"created_at":"2026-01-01T00:00:00Z","context":"qwen-review/reviewed","state":"success","description":"%s","creator":{"login":"%s"}},{"context":"ci/other","state":"failure","creator":{"login":"x"}}]\' "$description" "$who"',
      'else',
      "  printf '[]'",
      'fi',
    ].join('\n'),
  );
  chmodSync(join(fakeBin, 'gh'), 0o755);

  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  commit(work, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n', 'base');
  commit(work, 'b.txt', 'b\n', 'base b');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  // The CI checkout mirrors the review job: the default branch, full
  // history, with `origin` pointing at the repository.
  git(root, 'clone', '-q', '--branch', 'main', origin, ci);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('review-unchanged-diff', () => {
  let headA;
  let chain;

  it('a first head with no reviewed ancestor is reviewed in full', () => {
    git(work, 'checkout', '-q', '-b', 'pr');
    headA = commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\n',
      'A: real change',
    );
    publishPrHead();
    const { verdict, stderr } = run(headA);
    assert.equal(verdict, 'changed no-reviewed-ancestor');
    // headA's parent IS the base tip, so the walk stops at the base branch —
    // before a single status lookup. Without that stop the first-parent line
    // runs the whole LOOKBACK into authenticated `gh api` calls and reports
    // `changed lookback-exhausted`, pointing the reader at the wrong budget.
    assert.match(stderr, /reached base branch/);
    assert.equal(ghCalls(), '');
  });

  it('a merge of main that leaves the diff identical is unchanged', () => {
    markReviewed(headA);
    // main moves on a file the PR does not touch.
    git(work, 'checkout', '-q', 'main');
    commit(work, 'b.txt', 'b\nmain moved\n', 'main: b');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const merged = publishPrHead();
    const { verdict } = run(merged);
    assert.equal(verdict, `unchanged ${headA} APPROVED`);
  });

  it('an unreviewed real change followed by a merge of main is NOT skipped', () => {
    // The hole a `before`-sha anchor has: B's review was superseded by the
    // merge push, so B must still be caught here.
    commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\n',
      'B: another change',
    );
    git(work, 'checkout', '-q', 'main');
    commit(work, 'b.txt', 'b\nmain moved\nagain\n', 'main: b2');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const merged = publishPrHead();
    const { verdict, stderr } = run(merged);
    assert.equal(verdict, 'changed diff-differs', stderr);
  });

  it('a whitespace-only push is a change (sha256, not patch-id)', () => {
    const headB = git(work, 'rev-parse', 'HEAD');
    markReviewed(headB);
    const ws = commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\n  seven\n',
      'W: whitespace',
    );
    publishPrHead();
    const { verdict } = run(ws);
    assert.equal(verdict, 'changed diff-differs');
  });

  it('main editing a file the PR touches changes the diff even without conflict', () => {
    const headW = git(work, 'rev-parse', 'HEAD');
    markReviewed(headW);
    git(work, 'checkout', '-q', 'main');
    commit(
      work,
      'a.txt',
      'ZERO\ntwo\nthree\nfour\nfive\n',
      'main: edits a.txt top',
    );
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const merged = publishPrHead();
    const { verdict } = run(merged);
    assert.equal(verdict, 'changed diff-differs');
  });

  it('a second consecutive merge of main chains through the recorded skip', () => {
    // The caller stamps the skipped head too, so the next merge needs one
    // lookup: here the previous merge M1 is the anchor.
    const m1 = git(work, 'rev-parse', 'HEAD');
    markReviewed(m1);
    git(work, 'checkout', '-q', 'main');
    commit(work, 'c.txt', 'c\n', 'main: c');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const m2 = publishPrHead();
    const { verdict } = run(m2);
    assert.equal(verdict, `unchanged ${m1} APPROVED`);
    chain = { m1, m2 };
  });

  it('ignores a reviewed status written by any identity but the workflow', () => {
    // CI_BOT_PAT sits within the reviewed agent's reach; a status it writes
    // must not anchor a skip. The walk passes it and lands on the real one.
    markReviewed(chain.m2, 'qwen-code-ci-bot');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'e.txt', 'e\n', 'main: e');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const m3 = publishPrHead();
    const { verdict } = run(m3);
    assert.equal(verdict, `unchanged ${chain.m1} APPROVED`);
  });

  it('refuses a legacy reviewed status without verdict metadata', () => {
    const anchor = git(work, 'rev-parse', 'HEAD');
    markReviewed(anchor, 'github-actions[bot]', 'LEGACY');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'legacy.txt', 'main moved\n', 'main: legacy status');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const head = publishPrHead();
    const { verdict } = run(head);
    assert.equal(verdict, 'changed unsupported-status-metadata');
  });

  it('carries supported review verdict metadata in the unchanged result', () => {
    const anchor = git(work, 'rev-parse', 'HEAD');
    markReviewed(anchor, 'github-actions[bot]', 'CHANGES_REQUESTED');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'verdict.txt', 'main moved\n', 'main: verdict metadata');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const head = publishPrHead();
    const { verdict } = run(head);
    assert.equal(verdict, `unchanged ${anchor} CHANGES_REQUESTED`);
  });

  it('a reachable textconv driver cannot collapse the fingerprint', () => {
    // --no-ext-diff covers diff.external and diff.<driver>.command, not
    // diff.<driver>.textconv. A filter that prints a constant makes two
    // different blobs compare equal, so git drops the file from the diff
    // entirely — no `index` line survives to differ — every head then hashes
    // as the empty digest, and a reviewed ancestor anchors a skip for a head
    // that carries genuinely new code.
    const head = commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\n  seven\ntextconv\n',
      'T: textconv target',
    );
    const anchor = git(work, 'rev-parse', 'HEAD~1');
    publishPrHead();
    markReviewed(anchor);
    const attrs = join(ci, '.git', 'info', 'attributes');
    writeFileSync(attrs, '* diff=degenerate\n');
    git(ci, 'config', 'diff.degenerate.textconv', 'true');
    try {
      const { verdict } = run(head);
      assert.equal(verdict, 'changed diff-differs');
    } finally {
      git(ci, 'config', '--unset', 'diff.degenerate.textconv');
      rmSync(attrs, { force: true });
    }
  });

  it('a head that no longer matches the PR is not decided here', () => {
    const { verdict } = run('0123456789abcdef0123456789abcdef01234567');
    assert.equal(verdict, 'changed head-moved');
  });

  it('a failed status lookup falls back to a full review', (t) => {
    const head = git(work, 'rev-parse', 'HEAD');
    // Really no `gh`: the farm holds the script's own tools and nothing else,
    // where `PATH=<empty dir>:/usr/bin:/bin` still resolved /usr/bin/gh.
    const farm = binFarm(['bash', 'git', 'cut', 'sha256sum']);
    if (!farm) return t.skip('a required host tool is missing');
    const { verdict } = run(head, { path: farm });
    assert.equal(verdict, 'changed status-lookup-failed');
  });

  it('hashes with shasum where the host has no sha256sum', (t) => {
    const head = git(work, 'rev-parse', 'HEAD');
    const farm = binFarm(['bash', 'git', 'cut']);
    const coreutils = hostTool('sha256sum');
    if (!farm || !coreutils) {
      return t.skip('no host sha256sum to stand in as shasum');
    }
    // macOS ships `shasum -a 256`, not sha256sum: read the blob on stdin and
    // print the same "<hex>  -" as sha256sum would. The stub must PIN the
    // interface it stands in for: bare `exec $coreutils` discards the
    // script's own arguments, so a `hasher=(shasum)` regression — bare
    // shasum is SHA-1 on a real macOS host — kept this case green. Assert
    // the flag, then forward the remaining arguments.
    writeFileSync(
      join(farm, 'shasum'),
      `#!/bin/sh\n[ "$1" = "-a" ] && [ "$2" = "256" ] || exit 64\nshift 2\nexec "${coreutils}" "$@"\n`,
    );
    chmodSync(join(farm, 'shasum'), 0o755);
    // Bare, the 127 is reported as `changed no-merge-base` — a missing hasher
    // pointed at git merge-base.
    const { verdict } = run(head, { path: farm });
    assert.equal(verdict, 'changed status-lookup-failed');
  });

  it('rejects malformed arguments without touching git', () => {
    const result = spawnSync(
      'bash',
      [SCRIPT, REPO, 'abc', 'deadbeef', 'main'],
      {
        cwd: ci,
        encoding: 'utf8',
        env: { ...gitEnv, PATH: `${fakeBin}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'changed bad-pr-number');
    const badBase = spawnSync(
      'bash',
      [SCRIPT, REPO, PR, 'deadbeef', '--upload-pack=x'],
      {
        cwd: ci,
        encoding: 'utf8',
        env: { ...gitEnv, PATH: `${fakeBin}:${process.env.PATH}` },
      },
    );
    assert.equal(badBase.stdout.trim(), 'changed bad-base-ref');
  });

  it('refuses an ambiguous merge base rather than guessing one', () => {
    // Criss-cross: the PR side and main merge EACH OTHER, leaving two best
    // common ancestors. A single-pick merge-base then masks a different
    // file set on each side, so two heads whose PR content genuinely
    // differs can hash to the same digest — a false skip, the one harm
    // this script exists to prevent. The check must refuse, not guess.
    const anchor = crissCrossAnchor('criss-cross', 'cc');
    markReviewed(anchor);
    const head = commit(work, 'cc-r.txt', 'r\n', 'cc: head');
    // The criss-cross line is no descendant of the previously published
    // head; the fixture's bare origin stands in for a force-pushed PR.
    git(work, 'push', '-q', '--force', 'origin', `HEAD:refs/pull/${PR}/head`);
    const { verdict } = run(head);
    assert.equal(verdict, 'changed ambiguous-merge-base');
  });

  it('a reachable diff.external command cannot collapse the fingerprint', () => {
    // The --no-ext-diff half of the header's config neutralization (the
    // textconv half is pinned above): with diff.external set and the flag
    // dropped, `git diff` emits 0 bytes for every pair, every fingerprint
    // collapses to the empty digest, and any reviewed ancestor anchors a
    // false skip. Assert on a CHANGED fixture — under a collapse an
    // `unchanged`-shaped assertion would pass vacuously.
    git(work, 'checkout', '-q', 'pr');
    const head = commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\n  seven\ntextconv\nexternal\n',
      'E: external-diff target',
    );
    const anchor = git(work, 'rev-parse', 'HEAD~1');
    // Back on the original PR line, no longer a descendant of the head the
    // criss-cross case published.
    git(work, 'push', '-q', '--force', 'origin', `HEAD:refs/pull/${PR}/head`);
    markReviewed(anchor);
    git(ci, 'config', 'diff.external', 'true');
    try {
      const { verdict } = run(head);
      assert.equal(verdict, 'changed diff-differs');
    } finally {
      git(ci, 'config', '--unset', 'diff.external');
    }
  });

  it('a reachable refs/replace plant cannot collapse the fingerprint', () => {
    // The object-redirect half of the header's neutralization, and the one
    // that needs no config at all: a replace ref in the CI checkout's common
    // dir — a directory nothing in the review pipeline wipes — redirects the
    // head's TREE to the reviewed anchor's, so the fingerprint's diff comes
    // out byte-identical to the anchor's and a head carrying genuinely new
    // code verdicts `unchanged`. Assert on a CHANGED fixture, the two
    // collapse cases' own rule: under a collapse an `unchanged`-shaped
    // assertion would pass vacuously.
    git(work, 'checkout', '-q', 'pr');
    const head = commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\n  seven\ntextconv\nexternal\nreplace\n',
      'R: replace target',
    );
    const anchor = git(work, 'rev-parse', 'HEAD~1');
    git(work, 'push', '-q', '--force', 'origin', `HEAD:refs/pull/${PR}/head`);
    markReviewed(anchor);
    // The plant is read in `ci`, so the objects it names have to be there
    // before `git replace` will record them.
    const plantRef = 'refs/qwen-review-plant/pr';
    git(ci, 'fetch', '-q', 'origin', `+refs/pull/${PR}/head:${plantRef}`);
    const headTree = git(work, 'rev-parse', `${head}^{tree}`);
    const anchorTree = git(work, 'rev-parse', `${anchor}^{tree}`);
    git(ci, 'replace', headTree, anchorTree);
    try {
      const { verdict } = run(head);
      assert.equal(verdict, 'changed diff-differs');
    } finally {
      git(ci, 'replace', '-d', headTree);
      git(ci, 'update-ref', '-d', plantRef);
    }
  });

  it('refuses a reachable legacy grafts file', () => {
    const head = git(work, 'rev-parse', 'HEAD');
    const grafts = join(ci, '.git', 'info', 'grafts');
    writeFileSync(grafts, `${head}\n`);
    try {
      const { verdict, stderr } = run(head);
      assert.equal(verdict, 'changed grafts-present');
      assert.match(stderr, /refusing legacy grafts file/);
    } finally {
      rmSync(grafts, { force: true });
    }
  });

  it('names the anchor when its own merge base is ambiguous', () => {
    // R3-3. The criss-cross case above fails at `head_fp`, before the walk
    // ever reaches an anchor, so the anchor-side arms of the same rc-2
    // refusal were dead to this suite: dropping
    // `2) verdict "changed anchor-ambiguous-merge-base"` left every case
    // green, and a `log` added to debug the block would clobber `$?` and
    // silently fold the arm into `*)` — reporting every ambiguous ANCHOR as
    // `anchor-no-merge-base`, the wrong-mechanism misreport rc 2 exists to
    // prevent. Mirror the head-side fixture: the head's own base is unique
    // because it merges main, while the stamped ancestor one first-parent
    // step below it is the criss-cross commit with two.
    const anchor = crissCrossAnchor('cc-anchor', 'ca');
    markReviewed(anchor);
    // A real change on top, so the head's own fingerprint is non-degenerate
    // and the walk has to step past an unstamped commit to reach the anchor.
    commit(work, 'ca-head.txt', 'head change\n', 'ca: head change');
    // Merging main back makes the main tip an ancestor of the head, so
    // `merge-base --all` resolves it to exactly one commit and `head_fp`
    // succeeds — the walk then reaches the anchor and refuses THERE.
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', '--force', 'origin', `HEAD:refs/pull/${PR}/head`);
    const { verdict } = run(head);
    assert.equal(verdict, 'changed anchor-ambiguous-merge-base');
  });

  it('names the anchor when it has no merge base at all', () => {
    // R3-3, the other arm: `fingerprint` returns 1 when `merge-base --all`
    // finds no common ancestor, and the anchor-side `*)` arm has to name the
    // ANCHOR rather than reuse the head-side `changed no-merge-base` the
    // block above it reports. An orphan root on the PR's first-parent line
    // is the shape — the head still has a base because it merges main, while
    // the stamped ancestor below it shares no history with main at all.
    git(work, 'checkout', '-q', 'pr');
    git(work, 'checkout', '-q', '--orphan', 'orphan-anchor');
    const anchor = commit(work, 'orphan.txt', 'orphan root\n', 'O: root');
    markReviewed(anchor);
    // `-X ours`: with no merge base, every file both trees carry is an
    // add/add conflict, and the resolution is irrelevant here — the anchor's
    // fingerprint fails at `merge-base` before any diff is taken.
    git(
      work,
      'merge',
      '-q',
      '--no-edit',
      '--no-ff',
      '-X',
      'ours',
      '--allow-unrelated-histories',
      'main',
    );
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', '--force', 'origin', `HEAD:refs/pull/${PR}/head`);
    const { verdict } = run(head);
    assert.equal(verdict, 'changed anchor-no-merge-base');
  });
});
