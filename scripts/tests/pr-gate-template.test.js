/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(__dirname, '../../.github/workflows/pr-gate.yml');

function extractPrTemplateScript() {
  const workflow = readFileSync(workflowPath, 'utf8');
  const stepName = "      - name: 'Validate PR body has required sections'";
  const stepIdx = workflow.indexOf(stepName);
  expect(stepIdx).toBeGreaterThanOrEqual(0);

  const marker = '          script: |\n';
  const scriptIdx = workflow.indexOf(marker, stepIdx);
  expect(scriptIdx).toBeGreaterThanOrEqual(0);

  const lines = workflow.slice(scriptIdx + marker.length).split('\n');
  const scriptLines = [];
  for (const line of lines) {
    if (line.startsWith('            ')) {
      scriptLines.push(line.slice(12));
    } else if (line.trim() === '') {
      scriptLines.push('');
    } else {
      break;
    }
  }
  return scriptLines.join('\n');
}

async function validateBody(body) {
  const failures = [];
  const core = {
    setFailed(message) {
      failures.push(message);
    },
  };
  const context = { payload: { pull_request: { body } } };
  const fn = new AsyncFunction('core', 'context', 'github', 'require', script);
  await fn(core, context, {}, () => {
    throw new Error('pr-template script must stay self-contained');
  });
  return failures;
}

const script = extractPrTemplateScript();

function completeBody(validation) {
  return `## Summary

Adds a focused regression fix for the PR gate.

## Validation

${validation}

## Linked Issues

N/A
`;
}

describe('PR Template workflow validation', () => {
  it('accepts validation evidence written only inside a code fence', async () => {
    const failures = await validateBody(
      completeBody(`- Commands run:

\`\`\`text
npm run build
npm run typecheck
\`\`\`
`),
    );

    expect(failures).toEqual([]);
  });

  it('rejects an untouched validation template', async () => {
    const failures = await validateBody(
      completeBody(`- Commands run:
- Expected result:
- Actual result: [paste here]

\`\`\`text
# paste commands here
\`\`\`
`),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Validation section looks like');
  });

  it('reports missing required sections', async () => {
    const failures = await validateBody('## Summary\n\nOnly a summary.\n');

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Missing "Validation" section');
    expect(failures[0]).toContain('Missing "Linked Issues" section');
    expect(failures[0]).toContain('.github/pull_request_template.md');
  });
});
