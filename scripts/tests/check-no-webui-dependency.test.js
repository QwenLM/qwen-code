/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { containsForbiddenReference } from '../check-no-webui-dependency.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(
  new URL('../check-no-webui-dependency.js', import.meta.url),
);

describe('containsForbiddenReference', () => {
  it('passes against the tracked repository files', () => {
    expect(
      execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' }),
    ).toContain('No active @qwen-code/webui dependency references found.');
  });

  it.each([
    ['package import', "import { App } from '@qwen-code/webui';"],
    ['package dependency entry', '"@qwen-code/webui": "workspace:*"'],
    ['workspace path segment', 'packages/webui/src/components/App.tsx'],
    ['ci step text', 'cd packages/webui && npx vitest run'],
    ['yaml list item at end of line', 'entries:\n- packages/webui\n'],
    ['parenthesized reference', '(packages/webui)'],
    ['mid-file end-of-line reference', 'path: packages/webui\nnext: line'],
    ['final line reference', 'references:\npackages/webui\n'],
  ])('flags %s', (_label, source) => {
    expect(containsForbiddenReference(source)).toBe(true);
  });

  it.each([
    ['lookalike package name', "import { App } from '@qwen-code/webuix';"],
    ['lookalike directory name', 'packages/webuix/src/App.tsx'],
    ['web-shell workspace path', 'packages/web-shell/client/daemon/index.ts'],
    ['unrelated mention', 'the web shell client'],
  ])('ignores %s', (_label, source) => {
    expect(containsForbiddenReference(source)).toBe(false);
  });
});
