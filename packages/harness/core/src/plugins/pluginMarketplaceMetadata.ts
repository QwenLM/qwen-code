/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  normalizePluginMarketplaceMetadata,
  type PluginMarketplaceMetadata,
} from '@qwen-code/resource';
import { runLogger } from '../utils/runLogger.js';

/** 从已安装插件的元数据读取归属，避免目录中的其他版本影响本次上报。 */
export async function readPluginMarketplaceMetadata(
  pluginRoot: string,
): Promise<PluginMarketplaceMetadata> {
  try {
    const text = await readFile(
      join(
        pluginRoot,
        '.qoder',
        'marketplace.json'
      ),
      'utf8',
    );
    return normalizePluginMarketplaceMetadata(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      runLogger.warn(
        `Could not read plugin marketplace metadata at ${pluginRoot}:`,
        error,
      );
    }
    return normalizePluginMarketplaceMetadata();
  }
}
