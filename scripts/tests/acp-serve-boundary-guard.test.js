/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const eslint = new ESLint({ cwd: root });

// Static imports are reported by no-restricted-imports; dynamic import() is
// reported by no-restricted-syntax because the former never sees it.
const BOUNDARY_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
]);

async function restrictedReports(statement) {
  const filePath = join(
    root,
    'packages/cli/src/acp-integration/boundary-probe.ts',
  );
  const [result] = await eslint.lintText(`${statement}\n`, { filePath });
  return result.messages.filter((m) => BOUNDARY_RULES.has(m.ruleId));
}

// Bare-directory specifiers resolve to packages/cli/src/serve/index.ts, a
// barrel re-exporting the full daemon surface — they must be caught by the
// same guard that blocks deep serve/ internals (#8084).
it.each(['../serve', '../../serve'])(
  'blocks the bare barrel specifier %s from acp-integration',
  async (specifier) => {
    const reports = await restrictedReports(
      `import { createServeApp } from '${specifier}';`,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].message).toContain('acp-integration');
  },
);

it('blocks a bare barrel re-export from acp-integration', async () => {
  const reports = await restrictedReports(
    `export { createServeApp } from '../serve';`,
  );
  expect(reports).toHaveLength(1);
});

it('still blocks deep serve/ internals from acp-integration', async () => {
  const reports = await restrictedReports(
    `import { createServeApp } from '../serve/index.js';`,
  );
  expect(reports).toHaveLength(1);
});

it('blocks type-only imports and re-exports from serve/ from acp-integration', async () => {
  expect(
    await restrictedReports(`import type { ServeAppDeps } from '../serve';`),
  ).toHaveLength(1);
  expect(
    await restrictedReports(`export type { ServeAppDeps } from '../serve';`),
  ).toHaveLength(1);
});

it('blocks a dynamic import() of serve/ from acp-integration', async () => {
  const reports = await restrictedReports(
    `async function probe() { await import('../serve/index.js'); }`,
  );
  expect(reports).toHaveLength(1);
  expect(reports[0].message).toContain('acp-integration');
});

it('blocks a case-variant dynamic import() of Serve/ from acp-integration', async () => {
  const reports = await restrictedReports(
    `async function probe() { await import('../Serve/index.js'); }`,
  );
  expect(reports).toHaveLength(1);
});

it('allows neutral runtime/ contracts from acp-integration', async () => {
  expect(
    await restrictedReports(
      `import { something } from '../runtime/contracts.js';`,
    ),
  ).toHaveLength(0);
  expect(
    await restrictedReports(
      `async function probe() { await import('../runtime/contracts.js'); }`,
    ),
  ).toHaveLength(0);
  // A computed specifier (not a string literal) has no source.value, so the
  // dynamic guard must not reject it — the import target is unknowable at
  // lint time.
  expect(
    await restrictedReports(
      `async function probe() { const target = '../runtime/contracts.js'; await import(target); }`,
    ),
  ).toHaveLength(0);
});
