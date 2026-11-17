/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseMarkdownCommand } from '../utils/markdown-command.js';
import { parseSkillContent } from '../skills/skill-load.js';

export class ManagedSkillCompatibilityError extends Error {}

export function parseManagedSkillContent(content: string, file: string) {
  const metadata = parseMarkdownCommand(content).frontmatter ?? {};
  for (const key of [
    'allowedTools',
    'allowed-tools',
    'hooks',
    'paths',
    'arguments',
    'args-file',
  ]) {
    if (metadata[key] !== undefined)
      throw new ManagedSkillCompatibilityError(
        `Managed Skill field ${key} is unsupported.`,
      );
  }
  if (metadata['model'] !== undefined && metadata['model'] !== 'inherit')
    throw new ManagedSkillCompatibilityError(
      'Managed Skill model override is unsupported.',
    );
  return parseSkillContent(content, file);
}
