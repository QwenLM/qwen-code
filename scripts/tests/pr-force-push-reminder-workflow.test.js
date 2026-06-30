/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('pr force-push reminder workflow', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/pr-force-push-reminder.yml'),
    'utf8',
  );

  it('triggers only on pull_request_target synchronize', () => {
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain("- 'synchronize'");
    // Must not check out or run PR code: a github-script-only job needs no
    // checkout, which is what keeps pull_request_target safe from pwn-requests.
    expect(workflow).not.toContain('actions/checkout');
  });

  it('only runs on the upstream repo', () => {
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
  });

  it('grants the permissions the comment endpoints need', () => {
    expect(workflow).toContain("contents: 'read'");
    expect(workflow).toContain("issues: 'write'");
    expect(workflow).toContain("pull-requests: 'write'");
  });

  it('uses no concurrency group so no push event is ever dropped', () => {
    // GitHub keeps at most one pending run per concurrency group, so a group
    // could cancel a still-pending force-push run before it posts. Idempotency
    // comes from the marker instead, so there must be no concurrency block.
    expect(workflow).not.toContain('concurrency:');
    expect(workflow).not.toContain('cancel-in-progress');
  });

  it('bounds the job and pins the github-script action by SHA', () => {
    expect(workflow).toContain('timeout-minutes: 5');
    expect(workflow).toContain(
      'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
    );
  });

  it('guards against missing or zero before/after SHAs', () => {
    expect(workflow).toContain('!before || !after || /^0+$/.test(before)');
  });

  it('skips bot and known-automation pushes', () => {
    // GitHub Apps arrive as sender.type Bot; the autofix bot force-pushes via a
    // PAT as a User account, so its login must be skipped explicitly.
    expect(workflow).toContain(
      "sender?.type === 'Bot' || KNOWN_AUTOMATION.has(sender?.login)",
    );
    for (const login of [
      'qwen-code-ci-bot',
      'qwen-code-dev-bot',
      'github-actions',
      'github-actions[bot]',
      'gemini-cli-robot',
    ]) {
      expect(workflow).toContain(`'${login}'`);
    }
    // The KNOWN_AUTOMATION list mirrors qwen-autofix.yml — drift would let an
    // automation account get reminded, so the sync is asserted here.
    expect(workflow).toContain(
      'KEEP IN SYNC with KNOWN_BOTS in .github/workflows/qwen-autofix.yml',
    );
  });

  it('detects force-pushes with a 3-dot compare on the base repo', () => {
    // Verified against the live REST API: 3-dot returns diverged/behind for
    // force-pushes and resolves fork-PR commits, while 2-dot 404s. Do not
    // "simplify" this to two dots.
    expect(workflow).toContain('basehead: `${before}...${after}`');
    expect(workflow).not.toContain('basehead: `${before}..${after}`');
    // The base repo resolves fork-PR commits via refs/pull/N/head, so the
    // compare targets context.repo, not the (possibly deleted) head repo.
    expect(workflow).not.toContain('pr.head.repo');
    // Only ahead/identical is a normal push; behind/diverged is a force-push.
    expect(workflow).toContain("status === 'ahead' || status === 'identical'");
  });

  it('skips on a 404 compare but surfaces other errors', () => {
    // A 404 means the old tip was orphaned by the force-push; anything else
    // (403/429/5xx) must fail the run loudly instead of a silent green no-op.
    expect(workflow).toContain('if (err.status === 404)');
    expect(workflow).toContain('throw err;');
    expect(workflow).not.toContain('Could not compare');
  });

  it('only trusts the dedup marker on its own bot comment', () => {
    // Otherwise any user could suppress all future reminders by pasting the
    // marker string into a comment.
    expect(workflow).toContain('<!-- pr-force-push-reminder -->');
    expect(workflow).toContain("c.user?.type === 'Bot'");
    expect(workflow).toContain("c.user?.login === 'github-actions[bot]'");
  });

  it('wraps every GitHub write/read in error logging that rethrows', () => {
    // listComments, compare (via the 404 branch), and createComment must all
    // surface failures rather than swallowing them.
    expect(workflow).toContain('Failed to list comments on PR #${pr.number}');
    expect(workflow).toContain('Failed to comment on PR #${pr.number}');
    expect(workflow).toContain('core.error(');
  });

  it('posts a bilingual reminder', () => {
    expect(workflow).toContain('Please do not rebase or force-push');
    expect(workflow).toContain('squash all changes into a single commit');
    expect(workflow).toContain('<summary>中文</summary>');
    expect(workflow).toContain('请勿对活跃的 PR 执行 rebase 或 force-push');
  });
});
