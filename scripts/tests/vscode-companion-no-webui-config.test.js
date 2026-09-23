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
    'packages/vscode-ide-companion/src/boundary-probe.ts',
  );
  const [result] = await eslint.lintText(`${statement}\n`, { filePath });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

it('blocks @qwen-code/webui imports from the VS Code companion', async () => {
  expect(
    await restrictedReports(`import { App } from '@qwen-code/webui';`),
  ).toHaveLength(1);
  expect(
    await restrictedReports(
      `import type { AppProps } from '@qwen-code/webui';`,
    ),
  ).toHaveLength(1);
  expect(
    await restrictedReports(`export { App } from '@qwen-code/webui';`),
  ).toHaveLength(1);
});

it('blocks deep @qwen-code/webui specifiers from the VS Code companion', async () => {
  expect(
    await restrictedReports(
      `import { styles } from '@qwen-code/webui/styles';`,
    ),
  ).toHaveLength(1);
});

it('still allows @qwen-code/web-shell imports in the VS Code companion', async () => {
  expect(
    await restrictedReports(
      `import { WebShellApp } from '@qwen-code/web-shell';`,
    ),
  ).toHaveLength(0);
});
