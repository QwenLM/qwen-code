import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'review-publish-comment.mjs');
const head = 'a'.repeat(40);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'review-publish-'));
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/bash', 'printf "gh %s\\n" "$*" >> "$LOG"',
    'case "$*" in',
    "  'pr view'*) printf '%s\\n' '{\"state\":\"OPEN\",\"headRefOid\":\"'\"${CI_CURRENT_HEAD}\"'\"}' ;;",
    "  'api user'*) printf '%s\\n' '\"bot\"' ;;",
    "  'api --paginate'*) printf '%s\\n' \"{\\\"user\\\":{\\\"login\\\":\\\"bot\\\"},\\\"commit_id\\\":\\\"$EXPECTED_HEAD_SHA\\\"}\" ;;",
    'esac',
  ].join('\n') + '\n');
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'npm'), '#!/bin/bash\nprintf "npm %s\\n" "$*" >> "$LOG"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const workspace = join(dir, 'workspace');
  mkdirSync(join(workspace, '.github', 'scripts'), { recursive: true });
  writeFileSync(
    join(workspace, '.github', 'scripts', 'upsert-bot-comment.sh'),
    '#!/bin/bash\nprintf "upsert-bot-comment.sh %s\\n" "$*" >> "$LOG"\n',
  );
  chmodSync(join(workspace, '.github', 'scripts', 'upsert-bot-comment.sh'), 0o755);
  const input = join(dir, 'input');
  mkdirSync(input);
  writeFileSync(join(input, 'qwen-review-pr-17-review.json'), JSON.stringify({ commit_id: head, comments: [], state: {} }));
  writeFileSync(join(input, 'qwen-review-pr-17-diff.txt'), '');
  const env = {
    PATH: `${bin}:${process.env.PATH}`, LOG: log, CI_CURRENT_HEAD: head,
    GITHUB_REPOSITORY: 'org/repo', PR_NUMBER: '17', EXPECTED_HEAD_SHA: head,
    GITHUB_WORKSPACE: workspace,
  };
  return { dir, log, env, run: (extra = {}) => execFileSync(process.execPath, [script, input], {
    env: { ...env, ...extra }, cwd: dir, encoding: 'utf8',
  }) };
}

test('validates artifact identity before invoking the trusted CLI', () => {
  const f = fixture();
  try {
    f.run({ REVIEW_COMPLETED: 'true' });
    const log = readFileSync(f.log, 'utf8');
    assert.match(log, /npm run dev -- review submit --pr 17 --repo org\/repo .*--user-authorized --comment-only/);
    assert.doesNotMatch(log, /gh api .*pulls.*reviews/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('keeps a salvaged review pinned to the old head', () => {
  const f = fixture();
  try {
    f.env.CI_CURRENT_HEAD = 'b'.repeat(40);
    f.env.ALLOW_STALE = 'true';
    f.run({ REVIEW_COMPLETED: 'true' });
    assert.match(readFileSync(f.log, 'utf8'), /gh pr comment 17.*qwen-review-salvaged a{40}/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('refuses an artifact for a different commit', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'input', 'qwen-review-pr-17-review.json'), JSON.stringify({ commit_id: 'b'.repeat(40) }));
    assert.throws(() => f.run({ REVIEW_COMPLETED: 'true' }), /not pinned to the trusted head/);
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /npm run dev/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('docs-only relay never invokes the review publisher', () => {
  const f = fixture();
  try {
    f.run({ DOCS_ONLY: 'true', REVIEW_COMPLETED: 'true' });
    const log = readFileSync(f.log, 'utf8');
    assert.doesNotMatch(log, /npm run dev/);
    assert.match(log, /upsert-bot-comment\.sh/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('failure reporting never invokes the review publisher', () => {
  const f = fixture();
  try {
    f.run({ REVIEW_FAILED: 'true', FAILURE_REASON: 'sentinel failure' });
    const log = readFileSync(f.log, 'utf8');
    assert.match(log, /gh pr comment 17[\s\S]*sentinel failure/);
    assert.doesNotMatch(log, /npm run dev/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
