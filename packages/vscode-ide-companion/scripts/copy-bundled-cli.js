/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Copy the already-built root dist/ folder into the extension dist/qwen-cli/.
 *
 * Assumes repoRoot/dist already exists (e.g. produced by `npm run bundle` and
 * optionally `npm run prepare:package`).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..', '..');
const rootDistDir = path.join(repoRoot, 'dist');
const extensionDistDir = path.join(extensionRoot, 'dist');
const bundledCliDir = path.join(extensionDistDir, 'qwen-cli');

async function main() {
  const cliJs = path.join(rootDistDir, 'cli.js');
  const vendorDir = path.join(rootDistDir, 'vendor');

  if (!existsSync(cliJs) || !existsSync(vendorDir)) {
    throw new Error(
      `[copy-bundled-cli] Missing root dist artifacts. Expected:\n- ${cliJs}\n- ${vendorDir}\n\nRun root "npm run bundle" first.`,
    );
  }

  await fs.mkdir(extensionDistDir, { recursive: true });
  const existingNodeModules = path.join(bundledCliDir, 'node_modules');
  const tmpNodeModules = path.join(
    extensionDistDir,
    'qwen-cli.node_modules.tmp',
  );
  const keepNodeModules = existsSync(existingNodeModules);

  // Preserve destination node_modules if it exists (e.g. after packaging install).
  if (keepNodeModules) {
    await fs.rm(tmpNodeModules, { recursive: true, force: true });
    await fs.rename(existingNodeModules, tmpNodeModules);
  }

  await fs.rm(bundledCliDir, { recursive: true, force: true });
  await fs.mkdir(bundledCliDir, { recursive: true });

  await fs.cp(rootDistDir, bundledCliDir, { recursive: true });

  if (keepNodeModules) {
    await fs.rename(tmpNodeModules, existingNodeModules);
  }

  console.log(`[copy-bundled-cli] Copied ${rootDistDir} -> ${bundledCliDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
