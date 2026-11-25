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
import {
  buildManagedLoopSkill,
  MANAGED_LOOP_PROFILES,
} from './managed-loop-skill.js';

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
// Derive the targets from the declared profile set so the producer cannot
// drift from MANAGED_LOOP_PROFILES: an added profile is generated here, and a
// removed one stops being written (the parity set assertion catches a sidecar
// left on disk). The filename convention is read by ASSETS in the parity test
// and by ManagedLoopSkill.java on the Java classpath.
for (const profile of MANAGED_LOOP_PROFILES) {
  const file = `managed-loop-skill-${profile}.json`;
  const skill = buildManagedLoopSkill(profile, body, description);
  const out = JSON.stringify(skill, null, 2) + '\n';
  writeFileSync(join(contractsDir, file), out);
  // eslint-disable-next-line no-console
  console.log(`${file}: ${Buffer.byteLength(out, 'utf8')} bytes`);
}

// The bundled body as the daemon publishes it, so admission can tell the Web
// Shell's bundled `loop` import apart from a user-authored `loop` and only
// replace the former. The producer trims (skill-manager.ts / parseSkillContent
// `body: body.trim()`), so the reference must be the trimmed wire value or the
// exact byte comparison never matches a real creation.
const bundledOut = JSON.stringify({ body: body.trim() }, null, 2) + '\n';
writeFileSync(
  join(contractsDir, 'managed-loop-skill-bundled-body.json'),
  bundledOut,
);
// eslint-disable-next-line no-console
console.log(
  `managed-loop-skill-bundled-body.json: ${Buffer.byteLength(bundledOut, 'utf8')} bytes`,
);
