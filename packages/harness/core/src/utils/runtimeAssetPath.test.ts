/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  '@qoder-ai/qodercli',
  '@qodercn-ai/qoderclicn',
  '@qwen-code/qwen-code',
])('finds the source repository for %s under paths with spaces and Chinese', async (npmPackage) => {
  vi.resetModules();
  vi.stubEnv('BRAND_NPM_PACKAGE', npmPackage);
  const { findCliRepoRoot } = await import('./runtimeAssetPath.js');
  root = mkdtempSync(path.join(tmpdir(), '品牌 resource root '));
  const nested = path.join(root, 'packages', 'core', 'src');
  mkdirSync(nested, { recursive: true });
  const packageJson = path.join(root, 'package.json');
  writeFileSync(
    packageJson,
    JSON.stringify({ name: npmPackage, workspaces: ['packages/*'] }),
  );

  expect(findCliRepoRoot([nested])).toBe(root);

  writeFileSync(
    packageJson,
    JSON.stringify({ name: '@unrelated/cli', workspaces: ['packages/*'] }),
  );
  expect(findCliRepoRoot([nested])).toBeNull();
});
