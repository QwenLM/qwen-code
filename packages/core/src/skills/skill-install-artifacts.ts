/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from '../utils/yaml-parser.js';

/**
 * Shared contract for the directory names produced by the atomic skill
 * reinstall swap (see the `installSkill*` flows in the cli package):
 *
 *   `<skill>.installing-<pid>-<timestamp>` — staging directory mid-install
 *   `<skill>.backup-<pid>-<timestamp>`     — previous install, pending removal
 *
 * Every surface that must recognize, reject, filter, or sweep those names
 * goes through this module so the shape stays defined exactly once. Before
 * this module existed the pattern was hand-copied across four call sites in
 * two packages, and the copies could (and did) drift in their anchors.
 *
 * Two distinct predicates exist because they answer different questions:
 *
 * - {@link isInstallArtifactName} — "could a loader mistake this entry for a
 *   transient artifact?" Used by the skill loaders to skip such entries so a
 *   stale `.backup-*` sibling is not loaded as a duplicate skill. It is
 *   deliberately name-only: loaders must stay cheap and side-effect free.
 * - {@link isInstallArtifactOfSkill} — "was this entry created as an artifact
 *   sibling of this specific skill?" Used by installers to sweep exactly
 *   their own stale artifacts.
 *
 * A directory whose name matches the shape is not necessarily an artifact:
 * versions before the reserved-name rejection could install a skill whose
 * name is itself artifact-shaped (e.g. `foo.backup-1-2`). Such legacy skills
 * are distinguished from real artifacts by content, not by name — a crashed
 * artifact of `foo` contains a manifest declaring name `foo`, while a legacy
 * skill declares its own (artifact-shaped) directory name. See
 * {@link isSelfNamedSkillDirectory} and
 * {@link resolveLegacyArtifactNamedSkillFile}.
 */

const SKILL_MANIFEST_FILE = 'SKILL.md';

/**
 * Matches names that a skill loader must treat as a possible install
 * artifact: ending in `.backup-<digits>-<digits>` or
 * `.installing-<digits>-<digits>` (pid and timestamp), anchored at the end of
 * the name. Legitimate skills whose names merely contain `.backup-` or
 * `.installing-` (e.g. `db.backup-2024`) do not match.
 */
export function isInstallArtifactName(name: string): boolean {
  return /\.(backup|installing)-\d+-\d+$/.test(name);
}

/**
 * Matches the exact artifact-sibling names an installer creates for
 * `skillName` (`<skillName>.backup-<pid>-<ts>` /
 * `<skillName>.installing-<pid>-<ts>`). Unlike
 * {@link isInstallArtifactName} this is anchored at both ends, so an
 * installer sweeping its own artifacts never touches an unrelated entry.
 */
export function isInstallArtifactOfSkill(
  name: string,
  skillName: string,
): boolean {
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.(?:backup|installing)-\\d+-\\d+$`).test(
    name,
  );
}

/**
 * Extracts the pid embedded in an artifact-shaped name, for liveness checks
 * during sweeps. Returns undefined when the name is not artifact-shaped.
 */
export function installArtifactPid(name: string): number | undefined {
  const match = /\.(?:backup|installing)-(\d+)-\d+$/.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Reads the `name` field declared by the SKILL.md inside `skillDir`.
 * Returns undefined when the manifest is missing, unreadable, or declares no
 * usable name — the same failure posture as the loaders, which skip such
 * directories.
 */
async function readDeclaredSkillName(
  skillDir: string,
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(
      path.join(skillDir, SKILL_MANIFEST_FILE),
      'utf8',
    );
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!match) return undefined;
    const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
    const name = frontmatter['name'];
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the SKILL.md inside `skillDir` declares itself under the
 * directory's own name. This is the content-level test that separates a
 * legacy artifact-shaped *skill* from a crashed install *artifact*: an
 * artifact of `foo` named `foo.backup-1-2` declares name `foo`, not
 * `foo.backup-1-2`, so only a real legacy skill passes.
 */
export async function isSelfNamedSkillDirectory(
  skillDir: string,
): Promise<boolean> {
  const declaredName = await readDeclaredSkillName(skillDir);
  return declaredName !== undefined && declaredName === path.basename(skillDir);
}

/**
 * Resolves the manifest path of a legacy artifact-shaped skill installed by
 * an older version, for management surfaces that resolve skills through a
 * listing (which the loader artifact filter hides these names from).
 *
 * Returns the SKILL.md path only when `skillName` itself matches the
 * artifact shape AND a self-named skill directory with exactly that name
 * exists under `baseDir`. A crashed swap artifact fails the self-name test
 * and resolves to undefined, so callers keep failing closed for artifacts.
 * Returns undefined for every non-artifact-shaped name — those are always
 * visible to listings and must not bypass them.
 */
export async function resolveLegacyArtifactNamedSkillFile(
  baseDir: string,
  skillName: string,
): Promise<string | undefined> {
  if (!isInstallArtifactName(skillName)) return undefined;
  const skillDir = path.join(baseDir, skillName);
  const skillFile = path.join(skillDir, SKILL_MANIFEST_FILE);
  const stats = await fs.stat(skillFile).catch(() => undefined);
  if (!stats?.isFile()) return undefined;
  if (!(await isSelfNamedSkillDirectory(skillDir))) return undefined;
  return skillFile;
}
