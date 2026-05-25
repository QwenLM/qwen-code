/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
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
const preflightPrompt = readFileSync(
  resolve(__dirname, '../../.qwen/preflight-prompt.md'),
  'utf8',
);

const deepPromptTemplates = [
  '.qwen/deep-review-correctness-security-prompt.md',
  '.qwen/deep-review-test-coverage-prompt.md',
  '.qwen/deep-review-maintainability-performance-prompt.md',
  '.qwen/deep-review-undirected-audit-prompt.md',
];

function extractRunScript(stepName) {
  const stepIdx = workflow.indexOf(`      - name: '${stepName}'`);
  expect(stepIdx).toBeGreaterThanOrEqual(0);

  const marker = '        run: |-\n';
  const runIdx = workflow.indexOf(marker, stepIdx);
  expect(runIdx).toBeGreaterThanOrEqual(0);

  const lines = workflow.slice(runIdx + marker.length).split('\n');
  const firstCodeLine = lines.find((line) => line.trim() !== '');
  expect(firstCodeLine).toBeDefined();
  const indent = firstCodeLine.match(/^\s*/)[0];
  expect(indent.length).toBeGreaterThan(0);

  const scriptLines = [];
  for (const line of lines) {
    if (line.startsWith(indent)) {
      scriptLines.push(line.slice(indent.length));
    } else if (line.trim() === '') {
      scriptLines.push('');
    } else {
      break;
    }
  }

  const script = scriptLines.join('\n').trimEnd();
  expect(script.trim().length).toBeGreaterThan(0);
  return script;
}

function parseGithubOutput(raw) {
  const outputs = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^([^<]+)<<(.+)$/);
    if (heredoc) {
      const [, key, delimiter] = heredoc;
      const valueLines = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      outputs[key] = valueLines.join('\n');
      continue;
    }

    const eq = lines[i].indexOf('=');
    if (eq !== -1) {
      outputs[lines[i].slice(0, eq)] = lines[i].slice(eq + 1);
    }
  }
  return outputs;
}

function runResolvePrContext(eventName, eventPayload, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-pr-context-'));
  const eventPath = join(dir, 'event.json');
  const outputPath = join(dir, 'github-output.txt');
  writeFileSync(eventPath, JSON.stringify(eventPayload));

  try {
    const result = spawnSync(
      'bash',
      ['-c', extractRunScript('Resolve PR context')],
      {
        cwd: resolve(__dirname, '../..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          EVENT_NAME: eventName,
          WORKFLOW_PR_NUMBER: '',
          WORKFLOW_REVIEW_MODE: '',
          WORKFLOW_TIER_OVERRIDE: '',
          WORKFLOW_ADDITIONAL_INSTRUCTIONS: '',
          ...extraEnv,
        },
      },
    );
    let rawOutput = '';
    try {
      rawOutput = readFileSync(outputPath, 'utf8');
    } catch {
      rawOutput = '';
    }
    return {
      ...result,
      githubOutput: rawOutput,
      outputs: parseGithubOutput(rawOutput),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Qwen PR review workflow safety rails', () => {
  it('keeps qwen invocations scoped with deny list and MCP block', () => {
    expect(workflow).not.toContain('--yolo');
    expect(workflow).toMatch(/pull-requests:\s+'write'/);

    // YOLO mode auto-approves all tools not in the deny list;
    // security is maintained by deny-list + MCP block + base-only checkout.
    expect(workflow).toContain('--approval-mode yolo');
    expect(workflow).toContain('"approvalMode": "yolo"');
    expect(workflow).not.toContain('--core-tools');
    expect(workflow).toContain('--exclude-tools "$QWEN_REVIEW_DENY_TOOLS"');
    expect(workflow).toContain(
      '--allowed-mcp-server-names __qwen_review_no_mcp__',
    );
    expect(workflow).toContain('QWEN_REVIEW_DENY_TOOLS');
    expect(workflow).toContain('enter_plan_mode');
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

  it('parses maintainer slash-command tier flags and focus text', () => {
    const result = runResolvePrContext('issue_comment', {
      issue: { number: 4359 },
      comment: {
        body: '@qwen-code /review --tier=deep\nFocus on workflow token handling.',
      },
    });

    expect(result.status).toBe(0);
    expect(result.outputs.number).toBe('4359');
    expect(result.outputs.review_mode).toBe('comment');
    expect(result.outputs.should_comment).toBe('true');
    expect(result.outputs.should_run_review).toBe('true');
    expect(result.outputs.tier_override).toBe('DEEP');
    expect(result.outputs.additional_instructions).toBe(
      'Focus on workflow token handling.',
    );
  });

  it('declines malformed @qwen-code review mentions after the coarse Actions gate', () => {
    const result = runResolvePrContext('issue_comment', {
      issue: { number: 4359 },
      comment: { body: '@qwen-code /reviewer' },
    });

    expect(result.status).toBe(0);
    expect(result.outputs.should_run_review).toBe('false');
    expect(result.outputs.tier_override).toBe('');
  });

  it('warns when workflow_dispatch focus text is truncated', () => {
    const result = runResolvePrContext(
      'workflow_dispatch',
      {},
      {
        WORKFLOW_PR_NUMBER: '4359',
        WORKFLOW_REVIEW_MODE: 'dry-run',
        WORKFLOW_TIER_OVERRIDE: 'auto',
        WORKFLOW_ADDITIONAL_INSTRUCTIONS: 'x'.repeat(2050),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      '::warning::additional_instructions exceeded 2048 characters',
    );
    expect(result.outputs.additional_instructions).toHaveLength(2048);
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
      "printf '## Qwen Code Review (DEEP)",
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
    expect(workflow).toContain('using partial extracted rubric');
    expect(workflow).not.toContain(
      'falling back to the full bundled review skill',
    );
  });

  it('marks DEEP failed when no focused pass produced usable review content', () => {
    expect(workflow).toContain('deep_unusable_section_count=0');
    expect(workflow).toContain(
      'if run_deep_focus "$focus" "$prompt_template"; then',
    );
    expect(workflow).toContain(
      '::error::DEEP review produced no usable focused sections',
    );
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

  it('keeps tier stderr out of JSONL parser input', () => {
    expect(workflow).not.toContain('2>&1 | tee "$out"');
    expect(workflow).toContain(
      '2> >(tee /tmp/qwen-light-stderr.log >&2)',
    );
    expect(workflow).toContain(
      '2> >(tee /tmp/qwen-standard-stderr.log >&2)',
    );
    expect(workflow).toContain(
      '2> >(tee "/tmp/qwen-deep-${focus}-stderr.log" >&2)',
    );
  });

  it('does not silently swallow non-SIGPIPE gh pr diff failures', () => {
    expect(workflow).toContain('capture_capped_pr_diff()');
    expect(workflow).toContain('diff_status=${PIPESTATUS[0]}');
    expect(workflow).toContain('Could not capture PR unified diff');
    expect(workflow.match(/gh pr diff "\$PR_NUMBER"/g)).toHaveLength(1);
    expect(workflow).not.toMatch(
      /unified_diff="\$\( \{ gh pr diff[\s\S]*?\|\| true; \} \| head -c/,
    );
  });

  it('does not present a diff-unavailable placeholder as a fenced diff', () => {
    expect(workflow).toContain('never wrap the failure');
    expect(workflow).toContain(
      '`gh pr diff` failed during CI context collection',
    );
    expect(workflow).toContain(
      "DIFF_AVAILABLE: '${{ steps.size.outputs.diff_available }}'",
    );
    expect(
      workflow.match(/\[ "\$\{DIFF_AVAILABLE:-true\}" = "true" \]/g),
    ).toHaveLength(4);
    expect(
      workflow.match(/This review proceeds without diff content/g),
    ).toHaveLength(3);
  });

  it('extracts preflight JSON from common code fence and prose wrappers', () => {
    expect(workflow).toContain('extract_preflight_json()');
    expect(workflow).toContain(
      'raw.match(/```\\s*[A-Za-z0-9_-]*\\s*\\n([\\s\\S]*?)\\n```/)',
    );
    expect(workflow).toContain('candidate.indexOf("{")');
    expect(workflow).toContain('candidate.lastIndexOf("}")');
  });

  it('keeps DEEP prompt templates versioned despite the .qwen ignore rule', () => {
    for (const template of deepPromptTemplates) {
      expect(gitignore).toContain(`!${template}`);
    }
  });

  it('keeps the project-required Validation Evidence section in split DEEP reviews', () => {
    expect(deepTestCoveragePrompt).toContain('## Validation Evidence');
    expect(deepTestCoveragePrompt).toContain('PRESENT');
    expect(deepTestCoveragePrompt).toContain('MISSING');
  });

  it('keeps preflight agent hints aligned with actual DEEP focused pass names', () => {
    expect(preflightPrompt).toContain('"correctness-security"');
    expect(preflightPrompt).toContain('"test-coverage"');
    expect(preflightPrompt).toContain('"maintainability-performance"');
    expect(preflightPrompt).toContain('"undirected-audit"');
    expect(preflightPrompt).not.toContain('"code_quality"');
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
