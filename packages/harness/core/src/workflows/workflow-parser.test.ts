/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import baseline from './__fixtures__/cc-2.1.260-prompts.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { parseWorkflowScript } from './workflow-parser.js';

describe('native authoring source diagnostics', () => {
  it('keeps the exact native line/column, excerpt and caret', () => {
    for (const fixture of baseline.syntaxErrors) {
      expect(() => parseWorkflowScript(fixture.script, { includeSourceContext: true })).toThrow(fixture.text);
    }
  });
});

describe('parseWorkflowScript', () => {
  it('parses pure literal meta and strips the export statement', () => {
    const parsed = parseWorkflowScript(`
export const meta = {
  name: 'audit',
  description: 'Audit the repository',
  title: 'Repo Audit',
  whenToUse: \`when broad review is needed\`,
  phases: [{ title: 'Read', detail: 'Inspect files', model: 'default' }],
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', description: 'Directory to audit' },
    },
    required: ['scope'],
  },
};

phase('Read');
return args;
`);

    expect(parsed.meta).toEqual({
      name: 'audit',
      description: 'Audit the repository',
      title: 'Repo Audit',
      whenToUse: 'when broad review is needed',
      phases: [{ title: 'Read', detail: 'Inspect files', model: 'default' }],
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Directory to audit' },
        },
        required: ['scope'],
      },
    });
    expect(parsed.scriptBody).toContain("phase('Read')");
    expect(parsed.scriptBody).not.toContain('export const meta');
  });

  it('requires meta to be the first statement', () => {
    expect(() =>
      parseWorkflowScript(`
const before = true;
export const meta = { name: 'x', description: 'y' };
`),
    ).toThrow(/FIRST statement/);
  });

  it('rejects non-literal meta values', () => {
    expect(() =>
      parseWorkflowScript(`
const name = 'x';
export const meta = { name, description: 'y' };
`),
    ).toThrow(/FIRST statement|non-literal/);

    expect(() =>
      parseWorkflowScript(`
export const meta = { name: 'x', description: computeDescription() };
`),
    ).toThrow(/non-literal/);
  });

  it('rejects reserved object keys', () => {
    expect(() =>
      parseWorkflowScript(`
export const meta = { name: 'x', description: 'y', constructor: 'bad' };
`),
    ).toThrow(/reserved key/);
  });

  it('rejects non-object workflow input schemas', () => {
    expect(() =>
      parseWorkflowScript(`
export const meta = {
  name: 'x',
  description: 'y',
  inputSchema: ['not', 'a', 'schema']
};
`),
    ).toThrow(/meta.inputSchema must be an object literal/);
  });

  it('rejects nondeterministic and dynamic constructs statically', () => {
    const cases = [
      ['Date.now()', /Date\.now\(\)/],
      ['Date()', /Date\(\)/],
      ['new Date()', /new Date\(\)/],
      ['Math.random()', /Math\.random\(\)/],
      ['import("node:fs")', /dynamic import/],
    ] as const;

    for (const [source, error] of cases) {
      expect(() =>
        parseWorkflowScript(`
export const meta = { name: 'x', description: 'y' };
${source};
`),
      ).toThrow(error);
    }
  });

  it('reports TypeScript syntax as unsupported JavaScript', () => {
    expect(() =>
      parseWorkflowScript(`
export const meta = { name: 'x', description: 'y' };
const value: string = 'nope';
`),
    ).toThrow(/plain JavaScript/);
  });
});
