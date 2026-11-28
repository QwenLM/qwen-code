import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./review-pr-trust.mjs', import.meta.url));

function resolveTrust(event, pr = {}, ghFails = false) {
  const dir = mkdtempSync(join(tmpdir(), 'review-pr-trust-'));
  try {
    writeFileSync(
      join(dir, 'gh'),
      ghFails
        ? '#!/bin/sh\nexit 1\n'
        : `#!/bin/sh\nprintf '%s\\n' "$PR_JSON"\n`,
      { mode: 0o755 },
    );
    chmodSync(join(dir, 'gh'), 0o755);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    execFileSync(process.execPath, [script], {
      env: {
        ...process.env,
        PATH: `${dir}:/usr/bin:/bin`,
        GITHUB_REPOSITORY: 'QwenLM/qwen-code',
        GITHUB_EVENT_JSON: JSON.stringify(event),
        GITHUB_OUTPUT: output,
        PR_JSON: JSON.stringify(pr),
      },
    });
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('classifies trust and safely ignores unrelated events', () => {
  const basePr = {
    number: 7,
    state: 'OPEN',
    head: {
      sha: 'a'.repeat(40),
      repo: { full_name: 'FORK/qwen-code' },
    },
  };
  const event = {
    issue: { number: 7, pull_request: {} },
    comment: { body: '@qwen-code /review' },
  };
  assert.match(resolveTrust(event, basePr), /untrusted=true/);
  assert.match(
    resolveTrust(event, {
      ...basePr,
      head: { ...basePr.head, repo: { full_name: 'qwenlm/QWEN-CODE' } },
    }),
    /untrusted=false/,
  );
  for (const item of [
    [{ comment: { body: 'LGTM' } }],
    [{ pull_request: { ...basePr, state: 'CLOSED' } }],
    [
      {
        issue: { number: 7, pull_request: {} },
        comment: { body: '@qwen-code /review' },
      },
      {},
      true,
    ],
  ]) {
    const output = resolveTrust(...item);
    assert.match(output, /untrusted=true/);
    assert.match(output, /head_sha=\n/);
  }
});
