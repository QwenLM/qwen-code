/**
 * @license
 * Copyright 2025 Qwen Team
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

describe('comment attachment guard workflow', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/comment-attachment-guard.yml'),
    'utf8',
  );
  const script = workflow
    .split('\n')
    .slice(
      workflow.split('\n').findIndex((line) => line.trim() === 'script: |') + 1,
    )
    .filter((line) => line.startsWith('            ') || line.trim() === '')
    .map((line) => (line.startsWith('            ') ? line.slice(12) : ''))
    .join('\n');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runScript = new AsyncFunction('github', 'context', 'core', script);

  async function runGuard(body, options = {}) {
    const calls = [];
    const failures = [];
    const warnings = [];
    const summaries = [];
    const github = {
      rest: {
        issues: {
          deleteComment: async (args) => {
            calls.push(['issue', args.comment_id]);
            if (options.deleteThrows) {
              throw Object.assign(new Error(options.deleteMessage ?? 'gone'), {
                status: options.deleteStatus ?? 404,
              });
            }
          },
        },
        pulls: {
          deleteReviewComment: async (args) => {
            calls.push(['review', args.comment_id]);
          },
        },
      },
      graphql: async (_query, variables) => {
        calls.push(['review-summary', variables.id]);
      },
    };
    const core = {
      info() {},
      setFailed: (message) => failures.push(message),
      warning: (message) => warnings.push(message),
      summary: {
        addHeading(value) {
          summaries.push(['heading', value]);
          return this;
        },
        addTable(value) {
          summaries.push(['table', value]);
          return this;
        },
        async write() {},
      },
    };
    const comment = {
      id: 123,
      node_id: options.nodeId ?? 'PRR_123',
      body,
      author_association: options.association ?? 'NONE',
      user: options.commentUser ?? { login: 'attacker' },
    };
    const context = {
      eventName: options.eventName ?? 'issue_comment',
      repo: { owner: 'QwenLM', repo: 'qwen-code' },
      payload: {
        action: options.action ?? 'created',
        sender: options.sender ?? { type: 'User', login: 'attacker' },
        ...(options.eventName === 'pull_request_review'
          ? { review: comment }
          : { comment }),
      },
    };

    await runScript(github, context, core);

    return { calls, failures, summaries, warnings };
  }

  // The trust check used to run only INSIDE the script, so a runner was
  // queued, allocated and started before the job could decide it had nothing
  // to do. Measured over the 200 most recent comments on this repo: 184
  // trusted associations + 9 bots = 96.5% of runs existed to print "Trusted
  // author; skipping", each waiting up to 629s on a saturated hosted pool.
  //
  // The hoisted `if:` is an OPTIMISATION, not the control — the script keeps
  // its own checks. So the only unsafe direction is skipping a scan that
  // should have run, and every ambiguity must resolve toward running.
  describe('job-level gate', () => {
    const startIdx = workflow.indexOf('  remove-suspicious-attachments:');
    // Search from the job start: a file-global indexOf would silently change
    // the slice's meaning if a job were ever added above this one.
    const gate = workflow.slice(
      startIdx,
      workflow.indexOf('runs-on:', startIdx),
    );

    it('gates on association and sender before a runner is allocated', () => {
      expect(gate).toContain('if: >-');
      expect(gate).toContain("github.event.sender.type != 'Bot'");
      expect(gate).toContain('!contains(');
      expect(gate).toContain('["OWNER","MEMBER","COLLABORATOR"]');
      // Both payload shapes: reviews carry the association on `review`,
      // comments on `comment`. Missing one silently un-gates that event.
      expect(gate).toContain('github.event.comment.author_association');
      expect(gate).toContain('github.event.review.author_association');
      // The script must KEEP its own copy — defence in depth, and the two
      // are allowed to disagree only in the safe direction.
      expect(script).toContain('trustedAssociations');
      expect(script).toContain("sender?.type === 'Bot'");
    });

    // Replicates GitHub expression semantics: `a || b` yields the first
    // truthy value, a missing path is '', and contains(list, '') is false.
    it('resolves every payload shape, ambiguity toward running', () => {
      const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
      const runs = (ev) =>
        (ev?.sender?.type ?? '') !== 'Bot' &&
        !TRUSTED.includes(
          ev?.comment?.author_association ||
            ev?.review?.author_association ||
            '',
        );
      const user = { type: 'User' };
      // Trusted -> skipped, which is the whole saving.
      for (const a of TRUSTED) {
        expect(runs({ sender: user, comment: { author_association: a } })).toBe(
          false,
        );
        expect(runs({ sender: user, review: { author_association: a } })).toBe(
          false,
        );
      }
      expect(
        runs({
          sender: { type: 'Bot' },
          comment: { author_association: 'NONE' },
        }),
      ).toBe(false);
      // Everyone else -> scanned. CONTRIBUTOR is deliberately NOT trusted:
      // a merged PR does not make someone's links safe.
      for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', '']) {
        expect(runs({ sender: user, comment: { author_association: a } })).toBe(
          true,
        );
      }
      // Fail-safe: an unrecognised or empty payload runs the scan rather
      // than skipping it.
      expect(runs({ sender: user })).toBe(true);
      expect(runs({})).toBe(true);
    });
  });

  // Every comment event started its own job, `edited` included — and the bot
  // PATCHes its own comments constantly, so repeated edits of one comment
  // stacked. The scan reads the CURRENT body, so a queued earlier scan is
  // already stale and cancelling it loses nothing.
  it('collapses repeated scans of one comment', () => {
    const concurrency = workflow.slice(
      workflow.indexOf('concurrency:'),
      workflow.indexOf('jobs:'),
    );
    expect(concurrency).toContain('cancel-in-progress: true');
    // Keyed per comment, not globally — a global group would serialise every
    // scan in the repo behind one runner.
    expect(concurrency).toContain('github.event.comment.id');
    expect(concurrency).toContain('github.event.review.id');
    // ...and an unexpected payload gets its own group rather than joining a
    // shared empty-key group where unrelated scans cancel each other.
    expect(concurrency).toContain('github.run_id');
  });

  it('stops risky extensions only on alphanumeric continuation', () => {
    expect(workflow).toContain('(?![a-zA-Z0-9])');
  });

  it('checks markdown link URLs instead of display text', () => {
    expect(workflow).toContain('const url = mdMatch ? mdMatch[1] : snippet;');
    expect(workflow).toContain(
      'return highRiskExtension.test(highRiskTarget(url));',
    );
  });

  it('listens for PR review summaries', () => {
    expect(workflow).toContain('pull_request_review:\n    types:');
    expect(workflow).toContain("- 'submitted'");
  });

  it('checks URL paths instead of country-code TLD hosts', () => {
    expect(workflow).toContain('const parsedUrl = new URL(');
    expect(workflow).toContain('/^www\\./i.test(url)');
    expect(workflow).toContain('...parsedUrl.pathname.split');
    expect(workflow).toContain(
      '.find((segment) => highRiskExtension.test(segment))',
    );
    expect(workflow).not.toContain('|sh|');
    expect(workflow).not.toContain('|so)');
  });

  it('skips comments edited by a different user', () => {
    expect(workflow).toContain("const action = context.payload.action ?? '';");
    expect(workflow).toContain("comment.user?.login ?? 'ghost'");
    expect(workflow).toContain("action === 'edited'");
    expect(workflow).toContain('sender.login !== commentAuthor');
  });

  it('does not scan fenced code blocks or inline code spans', () => {
    expect(workflow).toContain("replace(/```[\\s\\S]*?```/g, '')");
    expect(workflow).toContain("replace(/`[^`]*`/g, '')");
    expect(workflow).toContain('const linkSnippets = scanBody.match');
  });

  it('does not throw on malformed URL-like links', () => {
    expect(workflow).toContain('} catch {\n                  targets = [url];');
  });

  it('decodes escaped risky extensions in URL paths', () => {
    expect(workflow).toContain('const next = decodeURIComponent(decoded);');
    expect(workflow).toContain(".normalize('NFKC')");
    expect(workflow).toContain('Number.parseInt(match.slice(1), 16)');
  });

  it('strips zero-width characters before extension matching', () => {
    expect(workflow).toContain('[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\u180E]');
  });

  it('detects protocol-relative URLs', () => {
    expect(workflow).toContain('www\\.|\\/\\/');
    expect(workflow).toContain('/^\\/\\//.test(url)');
  });

  it('keeps parenthesized URL segments in link matches', () => {
    expect(workflow).toContain(
      String.raw`/(?:https?:\/\/|www\.|\/\/)[^\s"'<>\]]+|\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\)/gi;`,
    );
  });

  it('keeps diagnostics when deletion or summary writing fails', () => {
    expect(workflow).toContain(
      'Failed to ${moderationVerb} suspicious comment ${comment.id}',
    );
    expect(workflow).toContain('Failed to write suspicious comment summary');
  });

  it('records which moderation action ran', () => {
    expect(workflow).toContain("let actionTaken = '';");
    expect(workflow).toContain(
      "actionTaken ||\n                      (eventName === 'pull_request_review'",
    );
    expect(workflow).toContain(".addHeading('Suspicious attachment detected')");
  });

  it.each([
    ['path subsegment', 'https://evil.com/malware.exe/readme.txt'],
    ['trailing slash', 'https://evil.com/malware.exe/'],
    ['encoded extension', 'https://evil.com/file.e%78e'],
    ['double encoded extension', 'https://evil.com/file%252ezip'],
    ['query parameter filename', 'https://evil.com/download?file=malware.zip'],
    ['fullwidth dot', 'https://evil.com/malware．exe'],
    ['trailing punctuation', 'https://evil.com/malware.exe.'],
    ['pipe delimiter', 'https://evil.com/malware.exe|note'],
    ['equals delimiter', 'https://evil.com/malware.exe=1'],
    ['plus delimiter', 'https://evil.com/malware.exe+1'],
    ['malformed percent fallback', 'https://evil.com/file.e%78e%ZZ'],
    ['markdown parentheses', '[patch](https://evil.com/file(1).exe)'],
    ['www autolink', 'www.evil.com/malware.exe'],
    ['protocol-relative URL', '//evil.com/malware.exe'],
    ['zero-width space in extension', 'https://evil.com/malware.\u200Bexe'],
    ['zero-width joiner in extension', 'https://evil.com/malware.\u200Dzip'],
  ])('deletes risky links with %s', async (_name, body) => {
    const { calls } = await runGuard(body);

    expect(calls).toEqual([['issue', 123]]);
  });

  it.each([
    ['alphanumeric continuation', 'https://example.com/run.execution'],
    ['common .sh repository path', 'https://github.com/nvm-sh/nvm.sh/issues/1'],
    ['www .zip TLD host', 'www.example.zip/download'],
    ['inline code', '`https://evil.com/malware.exe`'],
    ['fenced code', '```txt\nhttps://evil.com/malware.exe\n```'],
  ])('keeps benign or quoted links with %s', async (_name, body) => {
    const { calls } = await runGuard(body);

    expect(calls).toEqual([]);
  });

  it('uses the review-comment delete API for PR review comments', async () => {
    const { calls } = await runGuard('https://evil.com/malware.exe', {
      eventName: 'pull_request_review_comment',
    });

    expect(calls).toEqual([['review', 123]]);
  });

  it('minimizes risky PR review summaries', async () => {
    const { calls, summaries } = await runGuard('www.evil.com/malware.exe', {
      action: 'submitted',
      eventName: 'pull_request_review',
      nodeId: 'PRR_test',
    });

    expect(calls).toEqual([['review-summary', 'PRR_test']]);
    expect(JSON.stringify(summaries)).toContain('minimized');
  });

  it('skips edited comments when the editor is not the author', async () => {
    const { calls } = await runGuard('https://evil.com/malware.exe', {
      action: 'edited',
      sender: { type: 'User', login: 'maintainer' },
    });

    expect(calls).toEqual([]);
  });

  it('keeps the audit summary when deleting fails', async () => {
    const { calls, failures, summaries, warnings } = await runGuard(
      'https://evil.com/malware.exe',
      { deleteThrows: true },
    );

    expect(calls).toEqual([['issue', 123]]);
    expect(warnings).toEqual([
      'Failed to delete suspicious comment 123: 404 gone',
    ]);
    expect(summaries).toContainEqual([
      'heading',
      'Suspicious attachment detected',
    ]);
    expect(JSON.stringify(summaries)).toContain('delete failed');
    expect(failures).toEqual([]);
  });

  it('fails the job after summary when deleting fails unexpectedly', async () => {
    const { calls, failures, summaries, warnings } = await runGuard(
      'https://evil.com/malware.exe',
      { deleteThrows: true, deleteStatus: 500, deleteMessage: 'server error' },
    );

    expect(calls).toEqual([['issue', 123]]);
    expect(warnings).toEqual([
      'Failed to delete suspicious comment 123: 500 server error',
    ]);
    expect(summaries).toContainEqual([
      'heading',
      'Suspicious attachment detected',
    ]);
    expect(JSON.stringify(summaries)).toContain('delete failed');
    expect(failures).toEqual([
      'Failed to delete suspicious comment 123: 500 server error',
    ]);
  });
});
