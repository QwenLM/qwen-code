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

function extractNamedStepScript(stepName) {
  const workflow = readFileSync(workflowPath, 'utf8');
  const stepIdx = workflow.indexOf(`      - name: '${stepName}'`);
  expect(stepIdx).toBeGreaterThanOrEqual(0);

  const marker = '          script: |\n';
  const scriptIdx = workflow.indexOf(marker, stepIdx);
  expect(scriptIdx).toBeGreaterThanOrEqual(0);

  const lines = workflow.slice(scriptIdx + marker.length).split('\n');
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

const script = extractNamedStepScript('Validate PR body has required sections');
const sizeScript = extractNamedStepScript('Compute reviewability size');

async function computeSize(files, labels = []) {
  const failures = [];
  const warnings = [];
  const infos = [];
  const core = {
    setFailed(message) {
      failures.push(message);
    },
    warning(message) {
      warnings.push(message);
    },
    info(message) {
      infos.push(message);
    },
  };
  const context = {
    issue: { number: 4359 },
    repo: { owner: 'QwenLM', repo: 'qwen-code' },
    payload: {
      pull_request: {
        labels: labels.map((name) => ({ name })),
        user: { login: 'author' },
      },
    },
  };
  const github = {
    paginate: async (_method, _options, mapper) => mapper({ data: files }),
    rest: {
      pulls: { listFiles: Symbol('listFiles') },
      issues: { listEvents: Symbol('listEvents') },
    },
  };
  const fn = new AsyncFunction(
    'core',
    'context',
    'github',
    'require',
    sizeScript,
  );
  await fn(core, context, github, () => {
    throw new Error('pr-size script must stay self-contained');
  });
  return { failures, warnings, infos };
}

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

describe('PR Size workflow validation', () => {
  it('does not warn or fail when the meaningful size is below thresholds', async () => {
    const { failures, warnings } = await computeSize([
      { filename: 'src/small.ts', additions: 100, deletions: 0 },
    ]);

    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns instead of failing when the meaningful size is over 1500 lines', async () => {
    const { failures, warnings } = await computeSize([
      { filename: 'src/large.ts', additions: 1501, deletions: 0 },
    ]);

    expect(sizeScript).not.toContain('core.setFailed');
    expect(failures).toEqual([]);
    expect(warnings.join('\n')).toContain('over the size threshold');
    expect(warnings.join('\n')).toContain('Merge is allowed');
  });

  it('does not claim maintainer acknowledgement when the label applier is unknown', async () => {
    const { warnings } = await computeSize(
      [{ filename: 'src/large.ts', additions: 1501, deletions: 0 }],
      ['oversized-ok'],
    );

    expect(warnings.join('\n')).toContain('could not be verified');
    expect(warnings.join('\n')).not.toContain(
      'a maintainer has consciously acknowledged',
    );
  });
});
