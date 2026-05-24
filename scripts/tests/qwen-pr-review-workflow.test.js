/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/qwen-code-pr-review.yml'),
  'utf8',
);
const gitignore = readFileSync(resolve(__dirname, '../../.gitignore'), 'utf8');
const deepTestCoveragePrompt = readFileSync(
  resolve(__dirname, '../../.qwen/deep-review-test-coverage-prompt.md'),
  'utf8',
);

const deepPromptTemplates = [
  '.qwen/deep-review-correctness-security-prompt.md',
  '.qwen/deep-review-test-coverage-prompt.md',
  '.qwen/deep-review-maintainability-performance-prompt.md',
  '.qwen/deep-review-undirected-audit-prompt.md',
];

describe('Qwen PR review workflow safety rails', () => {
  it('keeps qwen invocations toolless and without a GitHub token', () => {
    expect(workflow).not.toContain('--yolo');
    expect(workflow).not.toContain('"approvalMode": "yolo"');
    expect(workflow).toMatch(/pull-requests:\s+'write'/);
    expect(workflow).toContain(
      'qwen invocation below unsets GITHUB_TOKEN/GH_TOKEN',
    );

    const qwenCalls = workflow.match(/env -u GITHUB_TOKEN -u GH_TOKEN qwen/g);
    expect(qwenCalls).toHaveLength(4);
    expect(workflow).toContain('--approval-mode default');
    expect(workflow).toContain('--core-tools "$QWEN_REVIEW_CORE_TOOLS"');
    expect(workflow).toContain('--exclude-tools "$QWEN_REVIEW_DENY_TOOLS"');
    expect(workflow).toContain(
      '--allowed-mcp-server-names __qwen_review_no_mcp__',
    );
  });

  it('keeps all maintainer review comment triggers wired', () => {
    expect(workflow).toContain('pull_request_review_comment:');
    expect(workflow).toContain('pull_request_review:');
    expect(workflow).toContain(
      "github.event_name == 'pull_request_review_comment'",
    );
    expect(workflow).toContain("github.event_name == 'pull_request_review'");
  });

  it('uses @qwen-code /review as the maintainer comment trigger', () => {
    expect(workflow).toContain('@qwen-code /review');
    expect(workflow).toContain(
      "contains(github.event.comment.body, '@qwen-code /review')",
    );
    expect(workflow).toContain(
      "contains(github.event.review.body, '@qwen-code /review')",
    );
    expect(workflow).toContain("grep -qE '@qwen-code /review($|[[:space:]])'");
    expect(workflow).toContain('/@qwen-code \\/review([[:space:]]|$)/');
    expect(workflow).not.toContain('@qwen /review');
  });

  it('continues review for oversized PRs while surfacing a warning', () => {
    expect(workflow).not.toContain('Skipping AI review');
    expect(workflow).not.toContain(
      'Qwen PR review skipped (PR too large for AI review)',
    );
    expect(workflow).toContain('write_output "exceeds_review_threshold=false"');
    expect(workflow).toContain('write_output "exceeds_review_threshold=true"');
    expect(workflow).toContain('write_output "should_review=true"');
    expect(workflow).toContain('exceeds AI-review size guidance');
    expect(workflow).toContain(
      "EXCEEDS_REVIEW_THRESHOLD: '${{ steps.size.outputs.exceeds_review_threshold }}'",
    );
    expect(workflow).toContain('Large PR warning');
  });

  it('guards preflight model tier against contradictory blast radius', () => {
    expect(workflow).toContain(
      'contradicts high-risk blast_radius; upgrading to DEEP',
    );
    expect(workflow).toContain(
      'contradicts user_facing blast_radius; upgrading to STANDARD',
    );
    expect(workflow).toContain('blast_radius | type == "object"');
  });

  it('runs DEEP as a CI-safe bundled review profile', () => {
    expect(workflow).toContain('Extract bundled review rubric for CI DEEP');
    expect(workflow).toContain(
      'packages/core/src/skills/bundled/review/SKILL.md',
    );
    for (const template of deepPromptTemplates) {
      expect(workflow).toContain(template);
    }
    expect(workflow).toContain(
      'CI-safe profile adapted from bundled `/review`',
    );
  });

  it('includes author PR comments in AI review context', () => {
    expect(workflow).toContain('--json title,body,files,author,comments');
    expect(workflow).toContain('author_comments_block');
    expect(workflow).toContain('**Author PR comments');
  });

  it('guards DEEP status capture and rubric extraction against silent loss', () => {
    expect(workflow).not.toContain('local status\n            status=');
    expect(workflow).toContain('local status=0');
    expect(workflow).toContain('status=${PIPESTATUS[0]}');
    expect(workflow).toContain('missingSections');
    expect(workflow).toContain('falling back to the full bundled review skill');
  });

  it('keeps the DEEP focus pass list single-sourced', () => {
    expect(workflow).toContain('deep_focus_passes=(');
    expect(workflow).toContain('run_deep_focus "$focus" "$prompt_template"');

    const literalFocusLoops = workflow.match(
      /for focus in correctness-security test-coverage maintainability-performance undirected-audit/g,
    );
    expect(literalFocusLoops).toBeNull();
  });

  it('passes explicit tier labels into the review stream parser', () => {
    expect(workflow).toContain(
      'node scripts/parse-review-stream.cjs "$out" qwen-review-summary.md LIGHT "$status_label"',
    );
    expect(workflow).toContain(
      'node scripts/parse-review-stream.cjs "$out" qwen-review-summary.md STANDARD "$status_label"',
    );
    expect(workflow).toContain(
      'node scripts/parse-review-stream.cjs "$out" "$summary" "DEEP-${focus}" "$status_label"',
    );
  });

  it('keeps DEEP prompt templates versioned despite the .qwen ignore rule', () => {
    for (const template of deepPromptTemplates) {
      expect(gitignore).toContain(`!${template}`);
    }
  });

  it('keeps the project-required Validation Evidence section in split DEEP reviews', () => {
    expect(deepTestCoveragePrompt).toContain('## Validation Evidence');
    expect(deepTestCoveragePrompt).toContain(
      'This is an automated, advisory, comment-only review',
    );
  });

  it('posts a fallback comment whenever the summary comment did not succeed', () => {
    // The fallback runs under always() — it must also cover the SUCCESS
    // path where a tier step exited 0 but produced no output, the
    // near-empty guard deleted the file, and 'Post review summary
    // comment' silently skipped. `outcome != 'success'` captures skipped
    // (no file), failure (gh error), and cancelled alike.
    expect(workflow).toContain('always()');
    expect(workflow).toContain("steps.post-summary.outcome != 'success'");
    // Still gated so a declined slash-command posts nothing.
    expect(workflow).toContain("steps.size.outputs.should_review == 'true'");
  });

  it('uses placeholder-text guard, not byte-count heuristic, to detect empty reviews', () => {
    // Regression: an earlier byte-count guard (<200 bytes) conflated the
    // parser's empty-stream placeholder with short legitimate reviews
    // (e.g. "LGTM — only spelling fixes." ~70 bytes). Anchor the guard
    // semantically on the parser's actual placeholder phrase so concise
    // legitimate reviews survive.
    const placeholderGuards = workflow.match(
      /grep -qF 'no assistant text parsed' qwen-review-summary\.md/g,
    );
    // 3 tier-step guards (LIGHT/STANDARD/DEEP) + 1 fallback-step defense.
    expect(placeholderGuards?.length).toBeGreaterThanOrEqual(4);
    expect(workflow).toContain(
      "[ -s qwen-review-summary.md ] && ! grep -qF 'no assistant text parsed' qwen-review-summary.md",
    );
    // The old 200-byte threshold must not regress.
    expect(workflow).not.toContain('wc -c < qwen-review-summary.md)" -lt 200');
    expect(workflow).not.toContain('wc -c < qwen-review-summary.md)" -ge 200');
  });

  it('strips --tier= case-insensitively to match its case-insensitive detector', () => {
    // The grep that detects `--tier=` is `-i` (case-insensitive). The sed
    // that strips the matched token must also be case-insensitive so a
    // mixed-case `--tier=Light` doesn't end up as the literal token
    // `--TIER=LIGHT` downstream.
    expect(workflow).toMatch(/sed 's\/\^--tier=\/\/I'/);
  });

  it('fences untrusted model output before writing it to Actions logs', () => {
    expect(workflow).toContain('preflight-raw-');
    expect(workflow).toContain('qwen-light-stream-');
    expect(workflow).toContain('qwen-standard-stream-');
    expect(workflow).toContain('qwen-deep-stream-');
    expect(workflow).toContain('qwen-deep-summary-');

    const stopCommandMarkers = workflow.match(/::stop-commands::/g);
    expect(stopCommandMarkers?.length).toBeGreaterThanOrEqual(5);
  });
});
