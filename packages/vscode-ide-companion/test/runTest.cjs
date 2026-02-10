/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.cjs');
  const workspacePath = path.resolve(__dirname, 'fixtures/workspace');
  const bundledCliEntry = path.resolve(
    extensionDevelopmentPath,
    'dist',
    'qwen-cli',
    'cli.js',
  );

  if (!fs.existsSync(bundledCliEntry)) {
    throw new Error(
      `Bundled CLI entry not found at ${bundledCliEntry}. Run "node scripts/prepackage.js" first.`,
    );
  }

  const hasQwenOauth = !!process.env.QWEN_OAUTH;
  const hasTestEnv =
    !!process.env.QWEN_TEST_API_KEY &&
    !!process.env.QWEN_TEST_BASE_URL &&
    !!process.env.QWEN_TEST_MODEL;

  if (!hasQwenOauth && !hasTestEnv) {
    throw new Error(
      'Missing auth env for integration tests. Set QWEN_OAUTH or QWEN_TEST_API_KEY, QWEN_TEST_BASE_URL, and QWEN_TEST_MODEL.',
    );
  }

  process.env.QWEN_CODE_TEST = '1';
  const extensionTestsEnv = {
    QWEN_CODE_TEST: '1',
  };
  // Map test env vars to the ones CLI expects
  if (process.env.QWEN_TEST_API_KEY) {
    extensionTestsEnv.OPENAI_API_KEY = process.env.QWEN_TEST_API_KEY;
  }
  if (process.env.QWEN_TEST_BASE_URL) {
    extensionTestsEnv.OPENAI_BASE_URL = process.env.QWEN_TEST_BASE_URL;
  }
  if (process.env.QWEN_TEST_MODEL) {
    extensionTestsEnv.OPENAI_MODEL = process.env.QWEN_TEST_MODEL;
  }
  if (process.env.QWEN_OAUTH) {
    extensionTestsEnv.QWEN_OAUTH = process.env.QWEN_OAUTH;
  }

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, '--disable-workspace-trust'],
    extensionTestsEnv,
  });
}

main().catch((error) => {
  console.error('Failed to run VS Code integration tests:', error);
  process.exit(1);
});
