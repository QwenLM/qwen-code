/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const eslint = new ESLint({ cwd: repoRoot });

const lintCliFile = (filePath, code) =>
  eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });

const expectServeBoundaryError = async (filePath, code) => {
  const [result] = await lintCliFile(filePath, code);
  expect(result.messages.map((message) => message.message)).toEqual(
    expect.arrayContaining([expect.stringContaining('serve')]),
  );
};

describe('eslint cli serve boundary rules', () => {
  it('rejects static and dynamic serve imports from runtime', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/runtime/boundary-fixture.ts',
      "import '../serve/index.js';",
    );

    await expectServeBoundaryError(
      'packages/cli/src/runtime/boundary-fixture.ts',
      "export async function load() { await import('../serve/index.js'); }",
    );
  });

  it('rejects acp dynamic serve imports through template and traversal paths', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      'export async function load() { await import(`../serve/acp-http/dispatch.js`); }',
    );

    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "export async function load() { await import('../runtime/../serve/index.js'); }",
    );
  });
});
