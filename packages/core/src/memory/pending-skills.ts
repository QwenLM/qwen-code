/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  getProjectSkillsRoot,
  getPendingSkillsRoot,
  isProjectSkillPath,
  SKILL_FILE_NAME,
} from '../skills/skill-paths.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('AUTO_SKILL_PENDING');

export interface PendingSkill {
  /** Skill directory name, e.g. `auto-skill-foo`. */
  name: string;
  /** One-line description parsed from frontmatter (may be empty). */
  description: string;
  /** Absolute path of the SKILL.md while staged under pending root. */
  stagedManifestPath: string;
  /** Absolute path the SKILL.md will occupy once accepted (skills root). */
  finalManifestPath: string;
}

function parseDescription(content: string): string {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content);
  if (!fm) return '';
  const m = /^description:\s*(.+)\s*$/m.exec(fm[1]);
  return m ? m[1].trim() : '';
}

/**
 * Move NEWLY CREATED auto-skill directories from the skills root into the
 * pending (staging) root so they are not loaded until the user confirms.
 *
 * `touchedFiles` (from the skill-review agent) mixes freshly-created skills
 * with in-place edits of pre-existing ones. Only directories NOT in
 * `preExistingDirNames` are staged — editing an already-confirmed skill takes
 * effect in place and never enters the confirmation flow, so a later Discard
 * can never delete a skill the user already accepted. A file is staged only
 * when it (a) lives under the skills root, (b) is a `<dir>/SKILL.md`, (c) is a
 * direct child of the skills root, (d) is not pre-existing, and (e) still
 * exists on disk.
 */
export async function stageSkillDirs(
  touchedFiles: string[],
  projectRoot: string,
  preExistingDirNames: ReadonlySet<string> = new Set(),
): Promise<PendingSkill[]> {
  const skillsRoot = getProjectSkillsRoot(projectRoot);
  const pendingRoot = getPendingSkillsRoot(projectRoot);
  const seen = new Set<string>();
  const result: PendingSkill[] = [];

  for (const file of touchedFiles) {
    if (!isProjectSkillPath(file, projectRoot)) continue;
    if (path.basename(file) !== SKILL_FILE_NAME) continue;
    const skillDir = path.dirname(path.resolve(projectRoot, file));
    if (path.dirname(skillDir) !== path.resolve(skillsRoot)) continue; // direct child only
    const dirName = path.basename(skillDir);
    if (seen.has(dirName)) continue;
    seen.add(dirName);

    if (preExistingDirNames.has(dirName)) {
      // The agent edited a skill that existed before this review run — leave it
      // live in the skills root (already-confirmed skills don't need re-review).
      debugLogger.debug(
        `Not staging "${dirName}": pre-existing skill edited in place.`,
      );
      continue;
    }

    const finalManifestPath = path.join(skillsRoot, dirName, SKILL_FILE_NAME);
    let content: string;
    try {
      content = await fs.readFile(finalManifestPath, 'utf-8');
    } catch (err) {
      // The touched path no longer exists on disk — nothing to stage.
      debugLogger.debug(
        `Not staging "${dirName}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const stagedDir = path.join(pendingRoot, dirName);
    await fs.mkdir(pendingRoot, { recursive: true });
    await fs.rm(stagedDir, { recursive: true, force: true });
    await fs.rename(skillDir, stagedDir);
    debugLogger.debug(`Staged "${dirName}" for confirmation.`);

    result.push({
      name: dirName,
      description: parseDescription(content),
      stagedManifestPath: path.join(stagedDir, SKILL_FILE_NAME),
      finalManifestPath,
    });
  }
  return result;
}

/**
 * Promote a staged skill back into the skills root. A missing staged dir is
 * treated as already-handled (no throw). A genuine fs failure throws so the
 * caller can surface it instead of silently losing the skill.
 */
export async function acceptPendingSkill(pending: PendingSkill): Promise<void> {
  const stagedDir = path.dirname(pending.stagedManifestPath);
  const finalDir = path.dirname(pending.finalManifestPath);
  try {
    await fs.access(stagedDir);
  } catch {
    debugLogger.debug(`Accept skipped "${pending.name}": staged dir gone.`);
    return;
  }
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.rename(stagedDir, finalDir);
  debugLogger.debug(`Accepted "${pending.name}" into the skills library.`);
}

/** Delete a staged skill. Never touches the skills root. */
export async function rejectPendingSkill(pending: PendingSkill): Promise<void> {
  const stagedDir = path.dirname(pending.stagedManifestPath);
  await fs.rm(stagedDir, { recursive: true, force: true });
  debugLogger.debug(`Discarded staged skill "${pending.name}".`);
}
