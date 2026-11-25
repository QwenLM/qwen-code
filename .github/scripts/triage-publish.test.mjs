import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeActions } from './triage-publish.mjs';

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
