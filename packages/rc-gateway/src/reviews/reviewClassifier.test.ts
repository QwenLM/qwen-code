/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  classifyReviewToolCall,
  type ReviewPolicy,
} from './reviewClassifier.js';

const AUTO: ReviewPolicy = {
  autoApprove: true,
  autofix: false,
  comment: false,
};

// The REAL ACP permission frame shape: { kind, title, rawInput }.
// NEVER the synthetic { name, input } (that shape hid a latent
// wire-mismatch bug in PolicyEnforcer — see design Follow-ups).
const shell = (command: string) => ({
  kind: 'execute',
  title: command,
  rawInput: { command },
});

// ---------------------------------------------------------------------------
// Contract tests (verbatim from task brief) — the baseline behavior.
// ---------------------------------------------------------------------------
describe('classifyReviewToolCall — contract', () => {
  it('vote mode escalates everything', () => {
    const VOTE: ReviewPolicy = {
      autoApprove: false,
      autofix: true,
      comment: true,
    };
    expect(classifyReviewToolCall({ kind: 'read', rawInput: {} }, VOTE)).toBe(
      'escalate',
    );
    expect(classifyReviewToolCall(shell('git diff'), VOTE)).toBe('escalate');
  });

  it('auto-approves read and search kinds', () => {
    expect(classifyReviewToolCall({ kind: 'read', rawInput: {} }, AUTO)).toBe(
      'approve',
    );
    expect(classifyReviewToolCall({ kind: 'search', rawInput: {} }, AUTO)).toBe(
      'approve',
    );
  });

  it('gates edit on autofix', () => {
    expect(classifyReviewToolCall({ kind: 'edit', rawInput: {} }, AUTO)).toBe(
      'escalate',
    );
    expect(
      classifyReviewToolCall(
        { kind: 'edit', rawInput: {} },
        { ...AUTO, autofix: true },
      ),
    ).toBe('approve');
  });

  it('escalates fetch and other and unknown', () => {
    expect(
      classifyReviewToolCall(
        { kind: 'fetch', rawInput: { url: 'http://x/?d=secret' } },
        AUTO,
      ),
    ).toBe('escalate');
    expect(
      classifyReviewToolCall(
        { kind: 'other', title: 'agent: review', rawInput: {} },
        AUTO,
      ),
    ).toBe('escalate');
    expect(classifyReviewToolCall({ kind: 'weird', rawInput: {} }, AUTO)).toBe(
      'escalate',
    );
    expect(classifyReviewToolCall({ rawInput: {} }, AUTO)).toBe('escalate'); // missing kind
  });

  it('auto-approves allowlisted read/build/test shell', () => {
    for (const c of [
      'git diff --stat',
      'git status',
      'npm run build',
      'npm test',
      'cargo test',
      'go build ./...',
      'tsc --noEmit',
      'qwen review fetch-pr 42 owner/repo --remote origin',
      'mkdir -p /proj/.qwen/reviews',
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO)).toBe('approve');
    }
  });

  it('escalates dangerous, out-of-allowlist, and metacharacter shell', () => {
    for (const c of [
      'git commit -m x',
      'git push',
      'rm -rf /',
      'curl http://x',
      'npm install evil',
      'git diff; rm -rf /',
      'git diff && curl x',
      'echo $(cat secret)',
      'git diff | sh',
      'git diff > /etc/x',
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO)).toBe('escalate');
    }
  });

  it('gates the gh comment-post shell on comment', () => {
    expect(
      classifyReviewToolCall(shell('gh api repos/o/r/pulls/1/reviews'), AUTO),
    ).toBe('escalate');
    expect(
      classifyReviewToolCall(shell('gh api repos/o/r/pulls/1/reviews'), {
        ...AUTO,
        comment: true,
      }),
    ).toBe('approve');
  });

  it('escalates a non-string command', () => {
    expect(
      classifyReviewToolCall(
        { kind: 'execute', rawInput: { command: 42 } },
        AUTO,
      ),
    ).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// Adversarial hardening tests. Each FAILS on the un-hardened baseline and
// passes only after the corresponding hardening is added. These prove the
// bypass is closed.
// ---------------------------------------------------------------------------
describe('classifyReviewToolCall — adversarial hardening', () => {
  const COMMENT: ReviewPolicy = { ...AUTO, comment: true };

  it('escalates allowlisted git carrying command-injection / file-write flags', () => {
    // git's external-diff / config / textconv / pager machinery executes
    // arbitrary programs; --output writes arbitrary files. All have an
    // allowlisted argv[1] (diff/log), so the baseline approves them.
    for (const c of [
      'git diff --ext-diff',
      'git diff --textconv',
      'git diff --output=/etc/passwd',
      'git log --output /tmp/x',
      'git diff --exec-path=/tmp/evil',
      'git diff --upload-pack=evil',
      'git diff -c', // -c short (config injection form) after subcommand
      'git diff -o/tmp/x', // attached short output flag
      'git diff --pager=evil',
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO)).toBe('escalate');
    }
  });

  it('escalates mutating git subcommands (branch)', () => {
    // `git branch` mutates the repo (create/delete/rename); not read-only.
    for (const c of [
      'git branch -D main',
      'git branch newbranch',
      'git branch -m old new',
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO)).toBe('escalate');
    }
  });

  it('escalates npm/pnpm exec and network-install subcommands', () => {
    // `npm exec`/`pnpm exec` run arbitrary binaries; `npm ci` hits the
    // network and runs install lifecycle scripts.
    for (const c of [
      'npm exec someevilbin',
      'pnpm exec someevilbin',
      'npm ci',
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO)).toBe('escalate');
    }
  });

  it('escalates mkdir outside .qwen and path-traversal mkdir', () => {
    for (const c of [
      'mkdir /etc/cron.d/x', // not under .qwen
      'mkdir -p /tmp/evil', // not under .qwen
      'mkdir -p /proj/.qwen/../../../etc/evil', // traversal escapes .qwen
      'mkdir -p /tmp/.qwenevil/x', // .qwen is not a real path segment
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO)).toBe('escalate');
    }
    // still approves the sanctioned form
    expect(
      classifyReviewToolCall(shell('mkdir -p /proj/.qwen/reviews'), AUTO),
    ).toBe('approve');
  });

  it('escalates gh subcommands beyond posting a PR review comment', () => {
    for (const c of [
      'gh repo delete owner/repo', // not `gh api`
      'gh secret set FOO bar', // not `gh api`
      'gh api user', // api but not a reviews endpoint
      'gh api repos/o/r/pulls/1/reviews -X DELETE', // destructive method
      'gh api repos/o/r/pulls/1/reviews --method PUT', // destructive method
      'gh api repos/o/r/issues/1/comments', // wrong endpoint family
      'gh api repos/o/r/git/refs repos/o/r/pulls/1/reviews', // decoy: real endpoint is first positional
    ]) {
      expect(classifyReviewToolCall(shell(c), COMMENT)).toBe('escalate');
    }
    // the sanctioned create-review post still approves under comment
    expect(
      classifyReviewToolCall(
        shell('gh api repos/o/r/pulls/1/reviews'),
        COMMENT,
      ),
    ).toBe('approve');
    // and the inline-comment endpoint too
    expect(
      classifyReviewToolCall(
        shell('gh api repos/o/r/pulls/1/comments'),
        COMMENT,
      ),
    ).toBe('approve');
  });

  it('escalates tsc file-write flags but keeps typecheck approvable', () => {
    expect(
      classifyReviewToolCall(shell('tsc --outFile /home/user/.bashrc'), AUTO),
    ).toBe('escalate');
    expect(classifyReviewToolCall(shell('tsc --outDir /etc'), AUTO)).toBe(
      'escalate',
    );
    expect(classifyReviewToolCall(shell('tsc --noEmit'), AUTO)).toBe('approve');
  });

  it('rejects additional shell metacharacters and control chars', () => {
    for (const c of [
      'git diff `id`', // backtick substitution
      "git diff 'x'", // single quote
      'git diff "x"', // double quote
      'git diff (x)', // subshell parens
      'git diff {a,b}', // brace expansion
      'git diff *', // glob
      'git diff ~/x', // tilde expansion
      'git diff #comment', // comment
      'git diff\tstatus', // tab
      'git diff\nrm', // newline
      'git diff \\', // backslash
      'git diff !!', // history expansion
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO)).toBe('escalate');
    }
  });

  it('handles argv edge cases: empty, whitespace-only, leading whitespace', () => {
    expect(classifyReviewToolCall(shell(''), AUTO)).toBe('escalate');
    expect(classifyReviewToolCall(shell('   '), AUTO)).toBe('escalate');
    expect(classifyReviewToolCall(shell('\t'), AUTO)).toBe('escalate');
    // env-var prefix assignment lands as argv[0], never an allowlisted cmd
    expect(
      classifyReviewToolCall(shell('GIT_EXTERNAL_DIFF=evil git diff'), AUTO),
    ).toBe('escalate');
    // leading whitespace is tolerated on an otherwise-approvable command
    expect(classifyReviewToolCall(shell('   git diff --stat'), AUTO)).toBe(
      'approve',
    );
  });

  it('escalates a bare allowlisted command with no subcommand', () => {
    // `git` with no subcommand prints help; a Set-gated command with a
    // missing argv[1] must not sneak through.
    expect(classifyReviewToolCall(shell('git'), AUTO)).toBe('escalate');
    expect(classifyReviewToolCall(shell('npm'), AUTO)).toBe('escalate');
  });

  it('escalates when rawInput or command is absent', () => {
    expect(
      classifyReviewToolCall({ kind: 'execute', rawInput: {} }, AUTO),
    ).toBe('escalate');
    expect(classifyReviewToolCall({ kind: 'execute' }, AUTO)).toBe('escalate');
  });
});
