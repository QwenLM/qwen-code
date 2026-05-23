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

  it('guards preflight model tier against contradictory blast radius', () => {
    expect(workflow).toContain(
      'contradicts high-risk blast_radius; upgrading to DEEP',
    );
    expect(workflow).toContain(
      'contradicts user_facing blast_radius; upgrading to STANDARD',
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
    // Still gated so an intentionally size-skipped PR posts nothing.
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
    // The old 200-byte threshold must not regress.
    expect(workflow).not.toContain(
      'wc -c < qwen-review-summary.md)" -lt 200',
    );
    expect(workflow).not.toContain(
      'wc -c < qwen-review-summary.md)" -ge 200',
    );
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
