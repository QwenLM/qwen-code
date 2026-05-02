/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review load-rules`: read project-specific code-review rules from
// the **base branch** of a PR and emit a combined Markdown file.
//
// Rules are loaded from the base branch (not the PR branch) so a malicious
// PR cannot inject `.qwen/review-rules.md` content that bypasses scrutiny.
// Sources, in order:
//
//   1. `.qwen/review-rules.md`
//   2. `.github/copilot-instructions.md` (preferred)
//      OR `copilot-instructions.md` (fallback — only one is loaded)
//   3. `AGENTS.md` — only the `## Code Review` section
//   4. `QWEN.md`   — only the `## Code Review` section
//
// Missing files are skipped silently. If no rules are found, the script
// writes an empty file (or omits the file when `--out` is not given) and
// reports "no rules found" so the caller can skip the rule-injection step.

import type { CommandModule } from 'yargs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { gitOpt } from './lib/git.js';

interface LoadRulesArgs {
  base_ref: string;
  out: string;
}

function showFile(baseRef: string, path: string): string | null {
  return gitOpt('show', `${baseRef}:${path}`);
}

function extractCodeReviewSection(content: string): string | null {
  // Find `## Code Review` heading and return everything up to the next
  // top-level `## ` heading, or end of file. Done with line-based scanning
  // rather than a regex with `\Z` (which JS doesn't support).
  const lines = content.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (start < 0) {
      if (/^## Code Review\s*$/i.test(line)) start = i;
    } else if (/^## /.test(line)) {
      end = i;
      break;
    }
  }
  if (start < 0) return null;
  return lines.slice(start, end).join('\n').trim();
}

function loadCombined(baseRef: string): {
  combined: string;
  loaded: string[];
} {
  const sections: string[] = [];
  const loaded: string[] = [];

  // 1. Qwen-native rules.
  const qwenRules = showFile(baseRef, '.qwen/review-rules.md');
  if (qwenRules) {
    sections.push(`### From .qwen/review-rules.md\n\n${qwenRules.trim()}`);
    loaded.push('.qwen/review-rules.md');
  }

  // 2. Copilot-compatible rules: prefer .github/copilot-instructions.md;
  //    only fall back to root-level copilot-instructions.md if the
  //    preferred one doesn't exist on the base branch.
  const copilotPreferred = showFile(baseRef, '.github/copilot-instructions.md');
  if (copilotPreferred) {
    sections.push(
      `### From .github/copilot-instructions.md\n\n${copilotPreferred.trim()}`,
    );
    loaded.push('.github/copilot-instructions.md');
  } else {
    const copilotFallback = showFile(baseRef, 'copilot-instructions.md');
    if (copilotFallback) {
      sections.push(
        `### From copilot-instructions.md\n\n${copilotFallback.trim()}`,
      );
      loaded.push('copilot-instructions.md');
    }
  }

  // 3. AGENTS.md — extract Code Review section only.
  const agentsMd = showFile(baseRef, 'AGENTS.md');
  if (agentsMd) {
    const section = extractCodeReviewSection(agentsMd);
    if (section) {
      sections.push(`### From AGENTS.md\n\n${section}`);
      loaded.push('AGENTS.md');
    }
  }

  // 4. QWEN.md — extract Code Review section only.
  const qwenMd = showFile(baseRef, 'QWEN.md');
  if (qwenMd) {
    const section = extractCodeReviewSection(qwenMd);
    if (section) {
      sections.push(`### From QWEN.md\n\n${section}`);
      loaded.push('QWEN.md');
    }
  }

  return {
    combined: sections.join('\n\n---\n\n'),
    loaded,
  };
}

async function runLoadRules(args: LoadRulesArgs): Promise<void> {
  const { base_ref: baseRef, out } = args;
  const { combined, loaded } = loadCombined(baseRef);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, combined, 'utf8');

  if (loaded.length === 0) {
    writeStdoutLine(`No review rules found on ${baseRef}; wrote empty file to ${out}`);
  } else {
    writeStdoutLine(
      `Loaded ${loaded.length} rule source(s) from ${baseRef} → ${out}: ${loaded.join(', ')}`,
    );
  }
}

export const loadRulesCommand: CommandModule = {
  command: 'load-rules <base_ref>',
  describe:
    "Read project review rules from the base branch (.qwen/review-rules.md, .github/copilot-instructions.md, AGENTS.md, QWEN.md) and write a combined Markdown file",
  builder: (yargs) =>
    yargs
      .positional('base_ref', {
        type: 'string',
        demandOption: true,
        describe:
          'Base ref to read rules from — typically the PR base branch (e.g. "origin/main"). Loading from the base branch (not the PR branch) prevents a malicious PR from injecting bypass rules.',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output Markdown path (will be overwritten — empty if no rules found)',
      }),
  handler: async (argv) => {
    await runLoadRules(argv as unknown as LoadRulesArgs);
  },
};
