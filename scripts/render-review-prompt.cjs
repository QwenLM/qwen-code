#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * render-review-prompt.cjs
 *
 * Render a Qwen Code review prompt template by substituting placeholders
 * with file contents. Replaces the inline `node -e '...'` snippets that
 * were spread across the preflight / LIGHT / STANDARD steps of
 * `.github/workflows/qwen-code-pr-review.yml`.
 *
 * Supported placeholders (any subset may appear in the template):
 *   <<<PR_CONTEXT>>>       — the PR's diff + metadata blob
 *   <<<REVIEW_RULES_MD>>>  — contents of .qwen/review-rules.md
 *
 * Filename uses .cjs because the repo's root package.json sets
 * "type": "module".
 *
 * Usage:
 *   render-review-prompt.cjs <template> <output> \
 *     [--context <file>] [--rules <file>]
 *
 * Notes:
 *   - Missing placeholders in the template are silently ignored (i.e.
 *     it's fine to render LIGHT-style prompts that don't include
 *     <<<REVIEW_RULES_MD>>>; just don't pass --rules then).
 *   - A `--context` or `--rules` flag passed but pointing at a missing
 *     file is a hard error — the caller should have ensured the file
 *     exists.
 *   - Placeholder values are inserted verbatim. The template author is
 *     responsible for safe surrounding markdown context (e.g., placing
 *     the placeholder inside a clearly-bounded `## Section` block).
 *
 * Exit codes:
 *   0  success
 *   1  read/write failure
 *   2  missing required positional args
 */
const fs = require('fs');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context' || a === '--rules') {
      flags[a.slice(2)] = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readOrThrow(path, label) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(
      `render-review-prompt: failed to read ${label} from ${path}: ${err.message}\n`,
    );
    process.exit(1);
  }
}

function render(template, { context, rules }) {
  let out = template;
  // Use a function in replace() to avoid `$1` and other special replacement
  // patterns being interpreted inside the substituted text.
  if (context != null) {
    out = out.replace(/<<<PR_CONTEXT>>>/g, () => context);
  }
  if (rules != null) {
    out = out.replace(/<<<REVIEW_RULES_MD>>>/g, () => rules);
  }
  return out;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 2) {
    process.stderr.write(
      'Usage: render-review-prompt.cjs <template> <output> ' +
        '[--context <file>] [--rules <file>]\n',
    );
    process.exit(2);
  }
  const [templatePath, outputPath] = positional;
  const template = readOrThrow(templatePath, 'template');
  const context = flags.context ? readOrThrow(flags.context, 'context') : null;
  const rules = flags.rules ? readOrThrow(flags.rules, 'rules') : null;
  const rendered = render(template, { context, rules });
  try {
    fs.writeFileSync(outputPath, rendered);
  } catch (err) {
    process.stderr.write(
      `render-review-prompt: failed to write ${outputPath}: ${err.message}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `render-review-prompt: wrote ${rendered.length} char(s) to ${outputPath}\n`,
  );
}

// Export for tests.
module.exports = { render, parseArgs };

if (require.main === module) {
  main();
}
