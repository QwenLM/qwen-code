/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const { runExtensionTests } = require('./extension.test.cjs');

async function run() {
  await runExtensionTests();
}

module.exports = { run };
