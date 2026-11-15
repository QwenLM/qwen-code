/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regenerates the committed Managed /loop skill sidecars (description + body)
 * from the bundled SKILL.md. Run after editing SKILL.md (the parity test
 * reddens until you do):
 *
 *   npx tsx packages/core/src/skills/bundled/loop/regenerate-managed-loop-assets.ts
 *
 * The generated JSON sidecars live in managed-runtime/contracts and are copied
 * onto the Java classpath by the contracts module; the parity test pins them to
 * this generator's output byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManagedLoopSkill } from './managed-loop-skill.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'SKILL.md'), 'utf8');
const normalized = raw
  .replace(/^/, '')
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n');
const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
if (!match) throw new Error('SKILL.md frontmatter not found');
const frontmatter = match[1];
const body = match[2];
const descLine = frontmatter
  .split('\n')
  .find((line) => line.startsWith('description:'));
if (!descLine) throw new Error('SKILL.md frontmatter has no description');
const description = descLine.slice('description:'.length).trim();

const contractsDir = join(here, '../../../managed-runtime/contracts');
const targets = [
  ['union', 'managed-loop-skill-union.json'],
  ['cron', 'managed-loop-skill-cron.json'],
  ['wakeup', 'managed-loop-skill-wakeup.json'],
] as const;
for (const [profile, file] of targets) {
  const skill = buildManagedLoopSkill(profile, body, description);
  const out = JSON.stringify(skill, null, 2) + '\n';
  writeFileSync(join(contractsDir, file), out);
  // eslint-disable-next-line no-console
  console.log(`${file}: ${Buffer.byteLength(out, 'utf8')} bytes`);
}
