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
 * Move newly created auto-skill directories from the skills root into the
 * pending (staging) root so they are not loaded until the user confirms.
 * `touchedFiles` is the list returned by the skill-review agent; only files
 * that (a) live under the skills root, (b) are a `<dir>/SKILL.md`, (c) are a
 * direct child of the skills root, and (d) still exist on disk are staged.
 * Paths that no longer exist on disk are skipped. Callers are expected to pass
 * only newly-created skill paths (the skill-review agent only writes new
 * dirs); this helper does not itself filter out edits of pre-existing skills.
 */
export async function stageSkillDirs(
  touchedFiles: string[],
  projectRoot: string,
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

    const finalManifestPath = path.join(skillsRoot, dirName, SKILL_FILE_NAME);
    let content: string;
    try {
      content = await fs.readFile(finalManifestPath, 'utf-8');
    } catch {
      continue; // dir vanished or was an edit to a non-existent path
    }
    const stagedDir = path.join(pendingRoot, dirName);
    await fs.mkdir(pendingRoot, { recursive: true });
    await fs.rm(stagedDir, { recursive: true, force: true });
    await fs.rename(skillDir, stagedDir);

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
 * treated as already-handled (no throw).
 */
export async function acceptPendingSkill(pending: PendingSkill): Promise<void> {
  const stagedDir = path.dirname(pending.stagedManifestPath);
  const finalDir = path.dirname(pending.finalManifestPath);
  try {
    await fs.access(stagedDir);
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.rename(stagedDir, finalDir);
}

/** Delete a staged skill. Never touches the skills root. */
export async function rejectPendingSkill(pending: PendingSkill): Promise<void> {
  const stagedDir = path.dirname(pending.stagedManifestPath);
  await fs.rm(stagedDir, { recursive: true, force: true });
}
