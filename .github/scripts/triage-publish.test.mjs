import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeActions, run } from './triage-publish.mjs';

const HEAD = 'a'.repeat(40);

// Minimal gh stub: the review list GET (paginated), the head lookup, and the
// review POST. Anything else is a test failure, not a silent success.
function ghStub(calls) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'api' && args.includes('--paginate')) {
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: HEAD };
    }
    if (args[0] === 'api' && args.includes('-f')) {
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
  };
}

function approveDraft() {
  return {
    action: 'review',
    event: 'APPROVE',
    commit_id: HEAD,
    bodyFile: 'body.md', // the stub never reads it
  };
}

test('a drafted approval is skipped, not failed, for github-actions[bot]', () => {
  const calls = [];
  const [result] = executeActions({
    actions: [approveDraft()],
    repo: 'o/r',
    number: 1,
    botLogin: 'github-actions[bot]',
    exec: ghStub(calls),
    err: { write() {} },
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.detail, /cannot approve/);
  // The skip must happen before any write: no review POST was attempted.
  assert.equal(
    calls.some((args) => args[0] === 'api' && args.includes('-f')),
    false,
  );
});

test('a PAT bot identity still submits the approval', () => {
  const calls = [];
  const [result] = executeActions({
    actions: [approveDraft()],
    repo: 'o/r',
    number: 1,
    botLogin: 'qwen-code-bot',
    exec: ghStub(calls),
    err: { write() {} },
  });
  assert.equal(result.status, 'published');
  const post = calls.find((args) => args[0] === 'api' && args.includes('-f'));
  assert.ok(post, 'expected a review POST');
  assert.ok(post.includes('event=APPROVE'));
  assert.ok(post.includes(`commit_id=${HEAD}`));
});

test('run() uses env.BOT_LOGIN without calling GET /user and exits 0 on skipped approval', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-pub-test-'));
  try {
    mkdirSync(path.join(dir, 'bodies'));
    writeFileSync(path.join(dir, 'bodies', 'approve.md'), 'LGTM\n');
    writeFileSync(
      path.join(dir, 'actions.jsonl'),
      `${JSON.stringify({
        action: 'review',
        event: 'APPROVE',
        commit_id: HEAD,
        body: 'bodies/approve.md',
      })}\n`,
    );
    const calls = [];
    let stdout = '';
    const code = run({
      argv: ['--drafts', dir, '--repo', 'o/r', '--number', '1'],
      env: { BOT_LOGIN: 'github-actions[bot]' },
      exec: (args) => {
        calls.push(args);
        if (args[0] === 'api' && args[1] === 'user') {
          return {
            status: 1,
            stderr: 'gh: Resource not accessible by integration (HTTP 403)',
          };
        }
        if (args[0] === 'api' && args[1] === 'repos/o/r/issues/1') {
          return { status: 0, stdout: JSON.stringify({ pull_request: {} }) };
        }
        return ghStub([])(args);
      },
      out: {
        write(chunk) {
          stdout += chunk;
        },
      },
      err: { write() {} },
    });
    assert.equal(code, 0);
    assert.equal(
      calls.some((args) => args[0] === 'api' && args[1] === 'user'),
      false,
      'must not call GET /user when BOT_LOGIN is already provided',
    );
    const [result] = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(result.status, 'skipped');
    assert.match(result.detail, /cannot approve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
