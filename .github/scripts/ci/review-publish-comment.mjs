#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY;
const pr = Number(process.env.PR_NUMBER);
const expectedHead = process.env.EXPECTED_HEAD_SHA;
const inputPath = process.argv[2];
if (
  !repository ||
  !Number.isInteger(pr) ||
  pr <= 0 ||
  !/^[a-f0-9]{40}$/.test(expectedHead || '')
) {
  throw new Error('review publisher: invalid trusted target');
}
// A failed review stages no artifact, so the download may be skipped
// (continue-on-error) and the path may not exist; only the completed path
// reads from it.
const inputRoot = existsSync(inputPath) ? realpathSync(inputPath) : inputPath;
const gh = (args, input) => {
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : undefined;
};
const current = gh([
  'pr',
  'view',
  String(pr),
  '--repo',
  repository,
  '--json',
  'state,headRefOid',
]);
if (current.state !== 'OPEN') {
  console.log('Review target is closed; nothing to publish.');
  process.exit(0);
}
if (current.headRefOid !== expectedHead && process.env.ALLOW_STALE !== 'true') {
  console.log('Review target moved; skip this historical review.');
  process.exit(0);
}
const docsMarker = '<!-- qwen-review docs-only-medium -->';
function comment(body) {
  // `gh pr comment` prints the created URL, not JSON — send it through the
  // non-parsing path so a posted comment does not crash the publisher.
  execFileSync(
    'gh',
    ['pr', 'comment', String(pr), '--repo', repository, '--body', body],
    { stdio: 'inherit' },
  );
}
function upsert(body, updateOnly = false) {
  const path = join(process.env.RUNNER_TEMP || '/tmp', 'qwen-review-relay.md');
  writeFileSync(path, body, { mode: 0o600 });
  execFileSync(
    '.github/scripts/upsert-bot-comment.sh',
    [
      repository,
      String(pr),
      docsMarker,
      path,
      ...(updateOnly ? ['--update-only'] : []),
    ],
    { stdio: 'inherit', cwd: process.env.GITHUB_WORKSPACE || process.cwd() },
  );
}
if (
  process.env.SUPERSEDE_DOCS_ONLY === 'true' ||
  process.env.DOCS_ONLY_FAILED === 'true'
) {
  if (current.headRefOid !== expectedHead) {
    console.log('Review target moved; skip this historical badge update.');
    process.exit(0);
  }
  const failed = process.env.DOCS_ONLY_FAILED === 'true';
  upsert(
    failed
      ? `${docsMarker}\n\n📄 **Docs-only change** — this review **did not complete**. Reviewed head: \`${expectedHead}\`. See the [workflow run](${process.env.RUN_URL}).`
      : `${docsMarker}\n\n📄 ~~Docs-only change~~ **(superseded)** — this badge no longer reflects the current review state of this PR. See the latest review activity.`,
    true,
  );
  // The badge update is a side effect; a completed non-docs review must still
  // reach the submit below. Only a docs-only medium review (which never
  // publishes a review body) exits here.
  if (process.env.REVIEW_FAILED !== 'true' && process.env.DOCS_ONLY === 'true')
    process.exit(0);
}
if (process.env.REVIEW_FAILED === 'true') {
  if (current.headRefOid !== expectedHead) {
    console.log('Review target moved; skip this historical failure comment.');
    process.exit(0);
  }
  const reason =
    process.env.FAILURE_REASON ||
    'Run review failed. See workflow logs for details.';
  const body =
    process.env.FAILURE_KIND === 'quota'
      ? `**Qwen Code review paused — model quota exhausted.** ${reason} Re-run after the quota resets.`
      : process.env.FAILURE_KIND === 'timeout'
        ? `**Qwen Code review timed out.** ${reason} Retry with \`@qwen-code /review\`.`
        : `**Qwen Code review did not complete successfully.** ${reason} Retry with \`@qwen-code /review\`.`;
  comment(
    `<!-- qwen-review-fallback -->\n\n${body} See [workflow logs](${process.env.RUN_URL}).`,
  );
  process.exit(0);
}
if (process.env.DOCS_ONLY === 'true') {
  if (current.headRefOid !== expectedHead) {
    console.log('Review target moved; skip this historical medium review.');
    process.exit(0);
  }
  const completion =
    /^Review complete: pr-\d+ — (Comment|Request changes), not posted \(\d+ Critical, \d+ Suggestion\)$/.test(
      process.env.COMPLETION_LINE || '',
    )
      ? process.env.COMPLETION_LINE
      : 'See the workflow run for the review outcome.';
  const body = [
    '<!-- qwen-review docs-only-medium -->',
    '',
    `📄 **Docs-only change** — the automatic review completed at medium effort. ${completion} Reviewed head: \`${expectedHead}\`. Full report in the [workflow run](${process.env.RUN_URL}).`,
    '',
    '<details><summary>中文说明</summary>',
    '',
    `📄 **纯文档变更** —— 自动评审已完成，评审的 head：\`${expectedHead}\`。完整报告见 [workflow 运行](${process.env.RUN_URL})。`,
    '',
    '</details>',
  ].join('\n');
  upsert(body);
  process.exit(0);
}

if (process.env.REVIEW_COMPLETED !== 'true') {
  console.log('No completed review artifact to publish.');
  process.exit(0);
}
for (const name of [
  `qwen-review-pr-${pr}-review.json`,
  `qwen-review-pr-${pr}-diff.txt`,
]) {
  const path = join(inputRoot, name);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    realpathSync(path) !== path ||
    stat.size > 8 * 1024 * 1024
  ) {
    throw new Error(`review publisher: invalid artifact ${name}`);
  }
}
const payload = JSON.parse(
  readFileSync(join(inputRoot, `qwen-review-pr-${pr}-review.json`), 'utf8'),
);
if (payload?.commit_id !== expectedHead) {
  throw new Error(
    'review publisher: review payload is not pinned to the trusted head',
  );
}
execFileSync(
  'npm',
  [
    'run',
    'dev',
    '--',
    'review',
    'submit',
    '--pr',
    String(pr),
    '--repo',
    repository,
    '--review',
    join(inputRoot, `qwen-review-pr-${pr}-review.json`),
    '--host',
    'github.com',
    '--user-authorized',
    '--comment-only',
  ],
  { stdio: 'inherit', cwd: process.env.GITHUB_WORKSPACE || process.cwd() },
);

if (process.env.ALLOW_STALE === 'true') {
  const bot = gh(['api', 'user', '--jq', '.login']);
  const reviews = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repository}/pulls/${pr}/reviews?per_page=100`,
      '--jq',
      '.[]',
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const posted = reviews.filter((review) => review.user?.login === bot).at(-1);
  if (posted?.commit_id !== expectedHead) {
    throw new Error(
      'review publisher: queried historical anchor does not match the trusted head',
    );
  }
  const movedTo = /^[a-f0-9]{40}$/.test(process.env.MOVED_TO || '')
    ? process.env.MOVED_TO
    : current.headRefOid;
  const body = `<!-- qwen-review-salvaged ${expectedHead} -->\n\n⏳ **Historical-head review** — this COMMENT-only review targets \`${expectedHead}\`. The current head is \`${movedTo}\`; a later review covers the new head.`;
  comment(body);
}
