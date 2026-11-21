/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedPackageSkill } from './managed-package.js';
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

export function extensionInstructionText(
  body: string,
  extensionId: string,
): string {
  return body
    .replaceAll('${extensionPath}', `extension://${extensionId}`)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', `extension://${extensionId}`);
}

export function managedSkillCatalogEntry(
  skill: ManagedPackageSkill,
  extensionId: string,
) {
  return {
    name: skill.name,
    description: skill.description,
    body: extensionInstructionText(skill.body, extensionId),
    model_invocable: skill.model_invocable,
    user_invocable: skill.user_invocable,
    asset_directory: `extension://${extensionId}/${skill.assetDirectory.replace(/\/$/u, '')}/`,
  };
}

export const MANAGED_SKILL_BODY_MAX_BYTES = 512 * 1024;
