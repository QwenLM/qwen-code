/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { WorkflowAncestorTrustProvider } from '../../config/config.js';

export async function getTrustedWorkflowAncestors(
  canonicalTarget: string,
  provider: WorkflowAncestorTrustProvider | undefined,
): Promise<string[]> {
  if (!provider) return [];
  const ancestors: string[] = [];
  let current = canonicalTarget;
  while (true) {
    try {
      const git = await fs.lstat(path.join(current, '.git'));
      if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile())) {
        return [];
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [];
    }
    const parent = path.dirname(current);
    if (parent === current) return [];
    ancestors.push(parent);
    current = parent;
  }
  if (ancestors.length === 0) return [];
  try {
    const decisions = await provider(ancestors, canonicalTarget);
    if (
      !Array.isArray(decisions) ||
      decisions.length !== ancestors.length ||
      Array.from(decisions).some((decision) => typeof decision !== 'boolean')
    ) {
      return [];
    }
    const denied = decisions.indexOf(false);
    return denied === -1 ? ancestors : ancestors.slice(0, denied);
  } catch {
    return [];
  }
}
