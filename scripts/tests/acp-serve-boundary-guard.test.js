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

async function restrictedReports(statement) {
  const filePath = join(
    root,
    'packages/cli/src/acp-integration/boundary-probe.ts',
  );
  const [result] = await eslint.lintText(`${statement}\n`, { filePath });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
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

it('allows neutral runtime/ contracts from acp-integration', async () => {
  const reports = await restrictedReports(
    `import { something } from '../runtime/contracts.js';`,
  );
  expect(reports).toHaveLength(0);
});
