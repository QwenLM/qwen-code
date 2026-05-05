import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeIssue,
  buildRelatedIssueComment,
  DEFAULT_SCHEDULED_LIMIT,
  INVALID_COMMENT_MARKER,
  NEEDS_INFO_COMMENT_MARKER,
  RELATED_COMMENT_MARKER,
  shouldRetryGitHubRequest,
} from './issue-followup-bot.mjs';

const labelNames = [
  'type/bug',
  'type/feature-request',
  'type/support',
  'category/configuration',
  'category/integration',
  'scope/settings',
  'scope/vscode',
  'status/need-information',
  'status/waiting-for-feedback',
  'coding-plan',
];

describe('issue follow-up bot analysis', () => {
  it('closes obvious test issues with a bot comment', () => {
    const result = analyzeIssue({
      issue: {
        number: 3851,
        title: 'test',
        body: 'test',
        labels: [],
        state: 'open',
      },
      labelNames,
      relatedIssues: [],
      comments: [],
    });

    assert.equal(result.closeIssue, true);
    assert.equal(result.closeReason, 'not_planned');
    assert.equal(result.commentsToCreate.length, 1);
    assert.match(
      result.commentsToCreate[0].body,
      new RegExp(INVALID_COMMENT_MARKER),
    );
  });

  it('closes template reports whose user-provided fields are short gibberish', () => {
    const result = analyzeIssue({
      issue: {
        number: 3851,
        title: 'dwedew',
        body: `### What happened?

fede

### What did you expect to happen?

fsesedds

### Client information

Qwen Code: 0.15.6
IDE Client: VS Code
OS: win32 x64

### Login information

dsada

### Anything else we need to know?

dsas`,
        labels: ['type/bug'],
        state: 'open',
      },
      labelNames,
      relatedIssues: [],
      comments: [],
    });

    assert.equal(result.closeIssue, true);
    assert.equal(result.closeReason, 'not_planned');
    assert.match(
      result.commentsToCreate[0].body,
      new RegExp(INVALID_COMMENT_MARKER),
    );
  });

  it('asks for missing details on likely real bug reports', () => {
    const result = analyzeIssue({
      issue: {
        number: 3843,
        title: 'settings.json is overwritten',
        body: 'Qwen Code changed my settings file unexpectedly.',
        labels: ['type/bug'],
        state: 'open',
      },
      labelNames,
      relatedIssues: [],
      comments: [],
    });

    assert.equal(result.closeIssue, false);
    assert.deepEqual(
      result.labelsToAdd.sort(),
      [
        'category/configuration',
        'scope/settings',
        'status/need-information',
        'status/waiting-for-feedback',
      ].sort(),
    );
    assert.equal(result.commentsToCreate.length, 1);
    assert.match(
      result.commentsToCreate[0].body,
      new RegExp(NEEDS_INFO_COMMENT_MARKER),
    );
  });

  it('links related issues without closing as duplicate', () => {
    const result = analyzeIssue({
      issue: {
        number: 4000,
        title: 'VS Code companion overwrites settings.json',
        body: 'The VS Code companion overwrites my settings.json.',
        labels: ['type/bug'],
        state: 'open',
      },
      labelNames,
      relatedIssues: [
        {
          number: 3843,
          title: 'settings.json overwritten after using qwen',
          url: 'https://github.com/QwenLM/qwen-code/issues/3843',
          state: 'open',
        },
      ],
      comments: [],
    });

    assert.equal(result.closeIssue, false);
    assert.equal(result.commentsToCreate.length, 2);
    assert.match(
      result.commentsToCreate.at(-1).body,
      new RegExp(RELATED_COMMENT_MARKER),
    );
    assert.match(result.commentsToCreate.at(-1).body, /#3843/);
  });

  it('updates existing bot comments instead of duplicating them', () => {
    const result = analyzeIssue({
      issue: {
        number: 4000,
        title: 'VS Code companion overwrites settings.json',
        body: 'The VS Code companion overwrites my settings.json.',
        labels: ['type/bug'],
        state: 'open',
      },
      labelNames,
      relatedIssues: [
        {
          number: 3843,
          title: 'settings.json overwritten after using qwen',
          url: 'https://github.com/QwenLM/qwen-code/issues/3843',
          state: 'open',
        },
      ],
      comments: [
        {
          id: 100,
          body: `${RELATED_COMMENT_MARKER}\nold body`,
          user: { type: 'Bot' },
        },
      ],
    });

    assert.equal(result.commentsToCreate.length, 1);
    assert.deepEqual(
      result.commentsToUpdate.map((comment) => comment.id),
      [100],
    );
  });

  it('does not link weak body-only matches as related issues', () => {
    const result = analyzeIssue({
      issue: {
        number: 3830,
        title: 'Track result-side paths for path-conditional skill activation',
        body: 'Feed concrete filesystem result paths into skill activation.',
        labels: [],
        state: 'open',
      },
      labelNames,
      relatedIssues: [
        {
          number: 3634,
          title: 'Background task management: roadmap and next steps',
          body: 'Beyond track first item now in flight. Result paths and activation are mentioned only as broad background context.',
          url: 'https://github.com/QwenLM/qwen-code/issues/3634',
          state: 'open',
        },
      ],
      comments: [],
    });

    assert.equal(result.commentsToCreate.length, 0);
  });

  it('infers stable labels for VS Code settings reports', () => {
    const result = analyzeIssue({
      issue: {
        number: 4001,
        title: 'VS Code companion overwrites settings.json',
        body: 'The IDE companion in vscode changes settings.',
        labels: [],
        state: 'open',
      },
      labelNames,
      relatedIssues: [],
      comments: [],
    });

    assert.deepEqual(
      result.labelsToAdd.sort(),
      [
        'type/bug',
        'category/integration',
        'scope/settings',
        'scope/vscode',
        'status/need-information',
        'status/waiting-for-feedback',
      ].sort(),
    );
  });
});

describe('related issue comment', () => {
  it('renders a concise related issue list', () => {
    const body = buildRelatedIssueComment([
      {
        number: 3843,
        title: 'settings.json overwritten after using qwen',
        url: 'https://github.com/QwenLM/qwen-code/issues/3843',
        state: 'open',
      },
    ]);

    assert.match(body, new RegExp(RELATED_COMMENT_MARKER));
    assert.match(body, /#3843/);
    assert.match(body, /settings\.json overwritten/);
  });
});

describe('github request retry policy', () => {
  it('retries transient network and server failures only', () => {
    assert.equal(
      shouldRetryGitHubRequest({ cause: { code: 'ETIMEDOUT' } }),
      true,
    );
    assert.equal(
      shouldRetryGitHubRequest({ cause: { code: 'ECONNRESET' } }),
      true,
    );
    assert.equal(shouldRetryGitHubRequest({ status: 503 }), true);
    assert.equal(shouldRetryGitHubRequest({ status: 404 }), false);
    assert.equal(shouldRetryGitHubRequest(new Error('bad request')), false);
  });
});

describe('scheduled candidate limit', () => {
  it('defaults to a small manual rollout batch', () => {
    assert.equal(DEFAULT_SCHEDULED_LIMIT, 10);
  });
});
