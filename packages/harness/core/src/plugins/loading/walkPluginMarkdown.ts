/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { runLogger } from '../../utils/runLogger.js';

const SKILL_MD_RE = /^skill\.md$/i;

export async function walkPluginMarkdown(
  rootDir: string,
  onFile: (fullPath: string, namespace: string[]) => Promise<void>,
  opts: { stopAtSkillDir?: boolean; logLabel?: string } = {},
): Promise<void> {
  const label = opts.logLabel ?? 'plugin';

  async function scan(dirPath: string, namespace: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      runLogger.warn(
        `[walkPluginMarkdown] Failed to scan ${label} directory ${dirPath}: ${error}`,
      );
      return;
    }

    if (
      opts.stopAtSkillDir &&
      entries.some((e) => e.isFile() && SKILL_MD_RE.test(e.name))
    ) {
      // Skill directory: collect .md files here, don't recurse.
      await Promise.all(
        entries.map((entry) =>
          entry.isFile() && entry.name.toLowerCase().endsWith('.md')
            ? onFile(join(dirPath, entry.name), namespace)
            : undefined,
        ),
      );
      return;
    }

    await Promise.all(
      entries.map((entry) => {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return scan(fullPath, [...namespace, entry.name]);
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          return onFile(fullPath, namespace);
        }
        return undefined;
      }),
    );
  }

  await scan(rootDir, []);
}
