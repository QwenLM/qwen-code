/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BundledGeneratedUiConfig } from '@qwen-code/qwen-code-core/config/generated-ui.js';
import { resolveBundleDir } from '@qwen-code/qwen-code-core/utils/bundlePaths.js';

export function prepareBundledGeneratedUi(
  value: unknown,
  supported: boolean,
): BundledGeneratedUiConfig {
  if (value !== true) return { enabled: false };
  if (!supported) {
    return { enabled: true, unavailableReason: 'unsupported-runtime' };
  }
  let directory = resolveBundleDir(import.meta.url);
  let assetsDir = join(directory, 'generated-ui');
  let entry = 'main.js';
  if (!existsSync(assetsDir)) {
    while (dirname(directory) !== directory) {
      if (
        existsSync(
          join(directory, 'integrations', 'generated-ui', 'package.json'),
        ) &&
        existsSync(join(directory, 'scripts', 'copy_bundle_assets.js'))
      ) {
        const productAssets = join(directory, 'dist', 'generated-ui');
        if (existsSync(productAssets)) {
          assetsDir = productAssets;
        } else {
          assetsDir = join(directory, 'integrations', 'generated-ui', 'dist');
          entry = 'bundled-main.js';
        }
        break;
      }
      directory = dirname(directory);
    }
  }
  const required = [
    entry,
    'app.html',
    join('skills', 'generated-ui', 'SKILL.md'),
    'THIRD_PARTY_NOTICES.txt',
  ];
  if (
    !required.every((file) => {
      try {
        return statSync(join(assetsDir, file)).isFile();
      } catch {
        return false;
      }
    })
  ) {
    return { enabled: true, unavailableReason: 'assets-missing' };
  }
  return {
    enabled: true,
    skillsDir: join(assetsDir, 'skills'),
    server: {
      command: process.execPath,
      args: [join(assetsDir, entry)],
      includeTools: ['generated_ui_show'],
      trust: false,
    },
  };
}
