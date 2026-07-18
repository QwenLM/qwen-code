#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from 'node:fs';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const ISSUE_LINK =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+\b/i;

function isType(title, type) {
  return new RegExp(`^\\s*${type}(?:\\([^)]*\\))?!?:`, 'i').test(title);
}

function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^###\\s+${heading}\\s*$`, 'i').test(line.trim()),
  );
  if (start === -1) return '';
  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,3}\s+/.test(line.trim()),
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

function field(body, label) {
  const pattern = new RegExp(
    `^\\s*-\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.*)$`,
    'im',
  );
  return body.match(pattern)?.[1]?.trim() ?? '';
}

function meaningful(value) {
  const normalized = value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[*_`]/g, '')
    .trim()
    .toLowerCase();
  return (
    normalized !== '' &&
    !/^(?:n\/?a|none|not applicable|tbd|todo|placeholder)[.!]?$/.test(
      normalized,
    )
  );
}

export function assessPullRequestIntake(pr) {
  const title = typeof pr?.title === 'string' ? pr.title : '';
  const body = typeof pr?.body === 'string' ? pr.body : '';
  const validCounts =
    Number.isInteger(pr?.additions) &&
    pr.additions >= 0 &&
    Number.isInteger(pr?.deletions) &&
    pr.deletions >= 0;
  const additions = validCounts ? pr.additions : 0;
  const deletions = validCounts ? pr.deletions : 0;
  const changedLines = additions + deletions;
  const feature = isType(title, 'feat');
  const fix = isType(title, 'fix');
  const trusted = TRUSTED_ASSOCIATIONS.has(pr?.author_association);
  const reasons = [];

  if (!validCounts) {
    reasons.push('invalid_changed_line_count');
  }
  if ((feature || fix) && !ISSUE_LINK.test(body)) {
    reasons.push('missing_linked_issue');
  }

  if (feature && trusted) {
    if (!meaningful(section(body, 'How to verify'))) {
      reasons.push('missing_dogfooding_plan');
    }
    if (!meaningful(section(body, 'Evidence \\(Before & After\\)'))) {
      reasons.push('missing_dogfooding_evidence');
    }
  }

  let oversizedComplete = false;
  if (changedLines > 2000) {
    const planningIssue = field(
      body,
      'Planning issue for changes over 2,000 lines',
    );
    const cannotSplit = field(body, 'Why this change cannot be split');
    if (!/(?:[\w.-]+\/[\w.-]+)?#\d+\b/.test(planningIssue)) {
      reasons.push('missing_planning_issue');
    }
    if (!meaningful(cannotSplit)) {
      reasons.push('missing_cannot_split_reason');
    }
    oversizedComplete =
      !reasons.includes('missing_planning_issue') &&
      !reasons.includes('missing_cannot_split_reason');
  }

  return {
    decision:
      reasons.length > 0
        ? 'block'
        : oversizedComplete
          ? 'needs_discussion'
          : 'allow',
    changed_lines: changedLines,
    reason_codes: reasons,
  };
}

const MESSAGES = {
  invalid_changed_line_count:
    'Changed-line metadata is unavailable; retry the intake check.',
  missing_linked_issue:
    'Link a tracking issue with a closing keyword such as `Resolves #123`.',
  missing_dogfooding_plan:
    'Internal `feat:` PRs need a concrete user-perspective plan under `### How to verify`.',
  missing_dogfooding_evidence:
    'Internal `feat:` PRs need real results under `### Evidence (Before & After)`.',
  missing_planning_issue:
    'PRs above 2,000 changed lines must fill in `Planning issue for changes over 2,000 lines`.',
  missing_cannot_split_reason:
    'PRs above 2,000 changed lines must explain `Why this change cannot be split`.',
};

export function renderIntakeComment(result) {
  if (result.decision === 'needs_discussion') {
    return `<!-- qwen-pr-intake:needs-discussion -->
This PR changes ${result.changed_lines} lines, above the 2,000-line intake threshold. The planning issue and split rationale are present, so this is marked \`TBD\` for a maintainer decision before detailed AI review.

<details>
<summary>中文说明</summary>

这个 PR 变更了 ${result.changed_lines} 行，超过 2,000 行 intake 阈值。规划 issue 和无法拆分的说明已经提供，因此先标记为 \`TBD\`，由 maintainer 决定是否进入详细 AI review。

</details>`;
  }

  const reasons = result.reason_codes
    .map((code) => `- ${MESSAGES[code]}`)
    .join('\n');
  return `<!-- qwen-pr-intake:block -->
PR intake stopped before detailed AI review:

${reasons}

Update the PR description, then ask a maintainer to re-run with \`@qwen-code /triage\`.

<details>
<summary>中文说明</summary>

PR intake 在详细 AI review 前停止。请按上面的要求更新 PR 描述，然后请 maintainer 用 \`@qwen-code /triage\` 重新运行。

</details>`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`Invalid argument: ${key ?? ''}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr) throw new Error('Missing --pr');
  const result = assessPullRequestIntake(
    JSON.parse(readFileSync(args.pr, 'utf8')),
  );
  if (args.comment && result.decision !== 'allow') {
    writeFileSync(args.comment, renderIntakeComment(result));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
