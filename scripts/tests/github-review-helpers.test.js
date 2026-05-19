/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  buildPrShape,
  extractKeywords,
} from '../../.github/scripts/lib/pr-shape-core.mjs';
import {
  buildHistoryQueries,
  classifyHistoryResults,
} from '../../.github/scripts/lib/history-core.mjs';
import {
  buildDesignGateLlmPrompt,
  evaluateDesignGate,
  formatProcessComment,
} from '../../.github/scripts/lib/design-gate-core.mjs';
import { loadAnchors } from '../../.github/scripts/lib/anchors.mjs';
import { buildSearchPrsArgs } from '../../.github/scripts/lib/gh-search.mjs';
import {
  buildQwenArgs,
  buildQwenNpxArgs,
} from '../../.github/scripts/lib/llm.mjs';
import { resolveReviewContext } from '../../.github/scripts/lib/review-context-core.mjs';

describe('GitHub review helper contracts', () => {
  it('summarizes PR shape from a unified diff without checking out PR code', () => {
    const diffText = [
      'diff --git a/packages/cli/src/commands/foo.ts b/packages/cli/src/commands/foo.ts',
      'index 111..222 100644',
      '--- a/packages/cli/src/commands/foo.ts',
      '+++ b/packages/cli/src/commands/foo.ts',
      '@@ -1,2 +1,4 @@',
      '+export function createFooCommand() {}',
      ' const existing = true;',
      'diff --git a/.github/workflows/qwen-code-pr-review.yml b/.github/workflows/qwen-code-pr-review.yml',
      '--- a/.github/workflows/qwen-code-pr-review.yml',
      '+++ b/.github/workflows/qwen-code-pr-review.yml',
      '@@ -1 +1 @@',
      '+name: review',
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -10,6 +10,7 @@',
      '+    "@octokit/rest": "^22.0.0",',
    ].join('\n');

    const shape = buildPrShape({
      diffText,
      additions: 3,
      deletions: 0,
      changedFiles: 3,
    });

    expect(shape.packages_touched).toEqual(['cli']);
    expect(shape.public_surface_changes).toEqual([
      {
        file: 'packages/cli/src/commands/foo.ts',
        kind: 'export',
        name: 'createFooCommand',
      },
    ]);
    expect(shape.api_entrypoints_changed).toContain(
      'packages/cli/src/commands/foo.ts',
    );
    expect(shape.config_files_changed).toContain(
      '.github/workflows/qwen-code-pr-review.yml',
    );
    expect(shape.dependency_changes).toContain('@octokit/rest@^22.0.0');
  });

  it('classifies by-design history hits as blocking only without a differentiating rationale', () => {
    const history = classifyHistoryResults({
      prBody: 'Adds another /model list provider command.',
      byDesignClosedPrs: [
        {
          number: 3863,
          title: 'Add /model list',
          url: 'https://github.com/QwenLM/qwen-code/pull/3863',
          labels: [{ name: 'not planned' }],
          comments: [
            {
              url: 'https://github.com/QwenLM/qwen-code/pull/3863#issuecomment-1',
              body: 'Direction: decided not to ship /model list.',
            },
          ],
        },
      ],
    });

    expect(history.findings).toEqual([
      expect.objectContaining({
        kind: 'by_design_rejected',
        severity: 'blocking',
        citations: [
          'https://github.com/QwenLM/qwen-code/pull/3863#issuecomment-1',
        ],
      }),
    ]);

    const explained = classifyHistoryResults({
      prBody:
        'Adds another /model list provider command.\n\nWhy this is different: this only documents provider capabilities.',
      byDesignClosedPrs: [
        {
          number: 3863,
          title: 'Add /model list',
          url: 'https://github.com/QwenLM/qwen-code/pull/3863',
          labels: [{ name: 'not planned' }],
          comments: [
            {
              url: 'https://github.com/QwenLM/qwen-code/pull/3863#issuecomment-1',
              body: 'Direction: decided not to ship /model list.',
            },
          ],
        },
      ],
    });

    expect(explained.findings[0].severity).toBe('advisory');
  });

  it('adds domain-specific closed PR searches for model/provider direction decisions', () => {
    const keywords = extractKeywords({
      title: 'Allow API Key users to select models directly when configured',
      body: [
        'When modelProviders.USE_OPENAI is configured, AuthDialog should open ModelDialog.',
        'This preserves API key authentication while allowing model selection.',
      ].join('\n'),
      files: [
        'packages/cli/src/ui/auth/AuthDialog.tsx',
        'packages/cli/src/ui/components/ModelDialog.tsx',
        'packages/core/src/config/config.ts',
      ],
    });

    const queries = buildHistoryQueries({ keywords, repo: 'QwenLM/qwen-code' });

    expect(queries.byDesignCandidates).toContain(
      'model list is:unmerged repo:QwenLM/qwen-code',
    );
    expect(queries.byDesignCandidates).toContain(
      'openai-compatible models is:unmerged repo:QwenLM/qwen-code',
    );
  });

  it('treats roadmap-but-not-now closed PRs as advisory rather than blocking', () => {
    const history = classifyHistoryResults({
      prBody: 'Adds a new Chrome extension surface.',
      byDesignClosedPrs: [
        {
          number: 1432,
          title: 'Support Chrome Extension',
          url: 'https://github.com/QwenLM/qwen-code/pull/1432',
          labels: [],
          comments: [
            {
              url: 'https://github.com/QwenLM/qwen-code/pull/1432#issuecomment-1',
              body: [
                'Closing this draft for now to keep the PR queue clean.',
                'The feature is still on the roadmap but not a near-term priority.',
              ].join('\n'),
            },
          ],
        },
      ],
    });

    expect(history.findings).toEqual([
      expect.objectContaining({
        kind: 'closed_unmerged_direction',
        severity: 'advisory',
        citations: [
          'https://github.com/QwenLM/qwen-code/pull/1432#issuecomment-1',
        ],
      }),
    ]);
  });

  it('keeps broad direction candidates advisory until the PR is proven to repeat the rejected direction', () => {
    const history = classifyHistoryResults({
      prBody:
        'Allows users to select models that are already configured in settings.',
      directionCandidatePrs: [
        {
          number: 3863,
          title: 'feat(cli): add Anthropic model listing support',
          url: 'https://github.com/QwenLM/qwen-code/pull/3863',
          labels: [],
          comments: [
            {
              url: 'https://github.com/QwenLM/qwen-code/pull/3863#issuecomment-1',
              body: [
                'Direction: We have decided not to ship /model list as a feature.',
                'The OpenAI-compatible provider space is too fragmented.',
              ].join('\n'),
            },
          ],
        },
      ],
    });

    expect(history.findings).toEqual([
      expect.objectContaining({
        kind: 'closed_unmerged_direction_candidate',
        severity: 'advisory',
      }),
    ]);
  });

  it('spells out direction gate severity rules in the LLM prompt', () => {
    const prompt = buildDesignGateLlmPrompt({
      pr: {
        title: 'Add model listing',
        body: 'Adds /model list for custom providers.',
      },
      shape: {
        changed_files: ['packages/cli/src/ui/components/ModelDialog.tsx'],
      },
      history: {
        findings: [
          {
            kind: 'by_design_rejected',
            severity: 'blocking',
            message: 'Prior not-planned decision for /model list.',
            citations: ['https://github.com/QwenLM/qwen-code/pull/3863'],
          },
        ],
      },
      anchors: { loaded: [] },
    });

    expect(prompt).toContain('closed-unmerged maintainer decisions');
    expect(prompt).toContain('not near-term priority');
    expect(prompt).toContain('duplicate/superseded');
    expect(prompt).toContain('BLOCK');
  });

  it('blocks high-risk feature PRs without reviewer validation evidence', () => {
    const result = evaluateDesignGate({
      pr: {
        title: 'Add workflow automation for reviews',
        body: '## Summary\n\nAdds review automation.\n',
      },
      shape: {
        changed_files: ['.github/workflows/qwen-code-pr-review.yml'],
        diff_stat: { files: 1, additions: 80, deletions: 2 },
        config_files_changed: ['.github/workflows/qwen-code-pr-review.yml'],
        api_entrypoints_changed: [],
        packages_touched: [],
        public_surface_changes: [],
      },
      history: { findings: [] },
      anchors: {
        loaded: [
          { path: '.qwen/review-rules.md', excerpt: 'Validation evidence' },
        ],
        missing: [],
      },
    });

    expect(result.status).toBe('BLOCK');
    expect(result.findings).toEqual([
      expect.objectContaining({
        gate: 'validation',
        severity: 'blocking',
        citations: [
          '.qwen/review-rules.md',
          '.github/pull_request_template.md',
        ],
      }),
    ]);
    expect(formatProcessComment(result)).toContain('Qwen Design Gate');
  });

  it('loads anchor docs and derives stable keywords from title and changed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-review-anchors-'));
    await mkdir(join(root, 'docs/developers'), { recursive: true });
    await mkdir(join(root, 'docs/design/review'), { recursive: true });
    await writeFile(
      join(root, 'docs/developers/roadmap.md'),
      '# Roadmap\nReview automation\n',
    );
    await writeFile(
      join(root, 'docs/developers/architecture.md'),
      '# Architecture\nCLI/Core split\n',
    );
    await writeFile(
      join(root, 'docs/design/review/design.md'),
      '# Review design\n',
    );

    const keywords = extractKeywords({
      title: 'Add design gate review automation',
      files: ['docs/design/review/design.md'],
    });
    const queries = buildHistoryQueries({ keywords, repo: 'QwenLM/qwen-code' });
    const anchors = await loadAnchors({
      rootDir: root,
      changedFiles: ['docs/design/review/design.md'],
    });

    expect(keywords).toContain('design gate');
    expect(queries.byDesign).toContain('is:unmerged');
    expect(anchors.loaded.map((anchor) => anchor.path)).toEqual([
      'docs/developers/roadmap.md',
      'docs/developers/architecture.md',
      'docs/design/review/design.md',
    ]);
  });

  it('uses the gh --merged flag for merged PR history scans', () => {
    const args = buildSearchPrsArgs({
      query: 'review automation repo:QwenLM/qwen-code',
      repo: 'QwenLM/qwen-code',
      merged: true,
      limit: 5,
    });

    expect(args).toContain('--merged');
    expect(args).not.toContain('--state');
    expect(args).not.toContain('merged');
  });

  it('does not pass a duplicate repo qualifier to gh search prs', () => {
    const args = buildSearchPrsArgs({
      query: 'model list is:unmerged repo:QwenLM/qwen-code',
      repo: 'QwenLM/qwen-code',
      state: 'closed',
      limit: 5,
    });

    expect(args[2]).toBe('model list is:unmerged');
    expect(args).toContain('--repo');
    expect(args).toContain('QwenLM/qwen-code');
  });

  it('runs Design Gate LLM through prompt mode, not an unreleased subcommand', () => {
    const promptArgs = buildQwenArgs('review this PR');
    const npxArgs = buildQwenNpxArgs('review this PR', {});

    expect(promptArgs).toEqual([
      '--yolo',
      '--prompt',
      'review this PR',
      '--channel=CI',
      '--output-format',
      'json',
    ]);
    expect(npxArgs[0]).toBe('-y');
    expect(npxArgs[1]).toBe('@qwen-code/qwen-code@latest');
    expect([...promptArgs, ...npxArgs]).not.toContain('design-gate');
  });

  it('treats @qwen /design-gate as a gate-only rerun', () => {
    const context = resolveReviewContext({
      eventName: 'issue_comment',
      event: {
        issue: { number: 42, pull_request: {} },
        comment: {
          body: '@qwen /design-gate',
          author_association: 'MEMBER',
        },
        sender: { login: 'maintainer' },
      },
      repository: 'QwenLM/qwen-code',
      serverUrl: 'https://github.com',
    });

    expect(context).toEqual(
      expect.objectContaining({
        number: '42',
        should_run_review: 'true',
        gate_only: 'true',
        bypass_design_gate: 'false',
        should_comment: 'true',
      }),
    );
    expect(context.review_prompt).toBe(
      '/review https://github.com/QwenLM/qwen-code/pull/42',
    );
  });

  it('allows owner and member override with an audit reason', () => {
    const context = resolveReviewContext({
      eventName: 'issue_comment',
      event: {
        issue: { number: 99, pull_request: {} },
        comment: {
          body: '@qwen /review --override-design-gate prior decision no longer applies',
          author_association: 'OWNER',
        },
        sender: { login: 'owner' },
      },
      repository: 'QwenLM/qwen-code',
      serverUrl: 'https://github.com',
    });

    expect(context).toEqual(
      expect.objectContaining({
        number: '99',
        should_run_review: 'true',
        gate_only: 'false',
        bypass_design_gate: 'true',
        override_reason: 'prior decision no longer applies',
        override_actor: 'owner',
      }),
    );
    expect(context.review_prompt).not.toContain('override-design-gate');
  });

  it('does not let collaborators bypass Design Gate', () => {
    const context = resolveReviewContext({
      eventName: 'issue_comment',
      event: {
        issue: { number: 99, pull_request: {} },
        comment: {
          body: '@qwen /review --override-design-gate prior decision no longer applies',
          author_association: 'COLLABORATOR',
        },
      },
      repository: 'QwenLM/qwen-code',
      serverUrl: 'https://github.com',
    });

    expect(context).toEqual(
      expect.objectContaining({
        should_run_review: 'true',
        bypass_design_gate: 'false',
        override_reason: '',
      }),
    );
    expect(context.review_prompt).not.toContain('override-design-gate');
  });

  it('runs only Design Gate when PR body is edited', () => {
    const context = resolveReviewContext({
      eventName: 'pull_request_target',
      event: {
        action: 'edited',
        changes: { body: { from: 'old body' } },
        pull_request: { number: 7 },
      },
      repository: 'QwenLM/qwen-code',
      serverUrl: 'https://github.com',
    });

    expect(context).toEqual(
      expect.objectContaining({
        number: '7',
        should_run_review: 'true',
        gate_only: 'true',
        should_comment: 'true',
      }),
    );
  });
});
