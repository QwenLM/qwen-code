/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.cjs');
  const workspacePath = path.resolve(__dirname, 'fixtures/workspace');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, '--disable-workspace-trust'],
  });
}

main().catch((error) => {
  console.error('Failed to run VS Code integration tests:', error);
  process.exit(1);
});
