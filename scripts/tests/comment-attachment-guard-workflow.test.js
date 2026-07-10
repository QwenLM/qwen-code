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
    expect(workflow).toContain(
      'target = new URL(/^www\\./i.test(url) ? `https://${url}` : url)',
    );
    expect(workflow).toContain('.pathname;');
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
    expect(workflow).toContain('} catch {\n                  target = url;');
  });

  it('decodes escaped risky extensions in URL paths', () => {
    expect(workflow).toContain('return decodeURIComponent(target);');
    expect(workflow).toContain('Number.parseInt(match.slice(1), 16)');
  });

  it('keeps parenthesized URL segments in link matches', () => {
    expect(workflow).toContain(
      String.raw`/(?:https?:\/\/|www\.)[^\s"'<>\]]+|\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\)/gi;`,
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
    ['malformed percent fallback', 'https://evil.com/file.e%78e%ZZ'],
    ['markdown parentheses', '[patch](https://evil.com/file(1).exe)'],
    ['www autolink', 'www.evil.com/malware.exe'],
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
