/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createMemory } from './memoryStore.js';
import type { MemoryScope } from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const logger = createDebugLogger('MEMORY_MIGRATION');

const LEGACY_SECTION_HEADER = '## Proto Added Memories';
const MIGRATED_HEADER = '## Proto Added Memories (Migrated)';

/**
 * Migrate old-format PROTO.md memories (bullet list under ## Proto Added Memories)
 * to individual memory files in .proto/memory/.
 *
 * Returns the count of migrated and skipped entries.
 */
export async function migrateProtoMd(
  protoMdPath: string,
  scope: MemoryScope,
  cwd?: string,
): Promise<{ migrated: number; skipped: number }> {
  let content: string;
  try {
    content = await fs.readFile(protoMdPath, 'utf-8');
  } catch {
    return { migrated: 0, skipped: 0 };
  }

  const headerIndex = content.indexOf(LEGACY_SECTION_HEADER);
  if (headerIndex === -1) {
    return { migrated: 0, skipped: 0 };
  }

  // Already migrated?
  if (content.includes(MIGRATED_HEADER)) {
    return { migrated: 0, skipped: 0 };
  }

  // Extract the section content
  const startOfSection = headerIndex + LEGACY_SECTION_HEADER.length;
  let endOfSection = content.indexOf('\n## ', startOfSection);
  if (endOfSection === -1) {
    endOfSection = content.length;
  }

  const sectionContent = content.substring(startOfSection, endOfSection);
  const bullets = sectionContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));

  let migrated = 0;
  let skipped = 0;

  for (const bullet of bullets) {
    const fact = bullet.replace(/^-\s*/, '').trim();
    if (!fact) {
      skipped++;
      continue;
    }

    // Generate a name from the first few words
    const words = fact.split(/\s+/).slice(0, 5).join(' ');
    const name = words.length > 40 ? words.slice(0, 40) : words;

    try {
      await createMemory({
        name,
        description: fact.length > 100 ? fact.slice(0, 100) + '...' : fact,
        type: 'user', // Default; user can recategorize later
        content: fact,
        scope,
        cwd,
      });
      migrated++;
    } catch (err) {
      logger.error(`Failed to migrate memory: "${fact}"`, err);
      skipped++;
    }
  }

  // Mark the old section as migrated
  const updatedContent = content.replace(
    LEGACY_SECTION_HEADER,
    MIGRATED_HEADER,
  );
  await fs.writeFile(protoMdPath, updatedContent, 'utf-8');

  logger.debug(
    `Migrated ${migrated} memories from ${protoMdPath} (${skipped} skipped)`,
  );
  return { migrated, skipped };
}
