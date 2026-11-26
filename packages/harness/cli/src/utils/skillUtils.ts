/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingScope } from '../config/settings.js';
import type { SkillActionResult } from './skillSettings.js';
import {
  Storage,
  loadSkillsFromDir,
  Downloader,
  copyContainedTree,
  assertContainedSymlinks,
  assertInside,
  extractArchiveSafely,
  type SkillDefinition,
  type SkillSource,
} from '@qwen-code/core';
import { cloneFromGit } from './gitClone.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

/** Canonical display labels for each skill source, shared across CLI and UI. */
export const SKILL_SOURCE_LABELS: Record<SkillSource, string> = {
  'built-in': 'Built-in',
  user: 'User',
  project: 'Project',
  plugin: 'Plugin',
};

/**
 * Shared logic for building the core skill action message while allowing the
 * caller to control how each scope and its path are rendered (e.g., bolding or
 * dimming).
 *
 * This function ONLY returns the description of what happened. It is up to the
 * caller to append any interface-specific guidance (like "Use /skills reload"
 * or "Restart required").
 */
export function renderSkillActionFeedback(
  result: SkillActionResult,
  formatScope: (label: string, path: string) => string,
): string {
  const { skillName, action, status, error } = result;

  if (status === 'error') {
    return (
      error ||
      `An error occurred while attempting to ${action} skill "${skillName}".`
    );
  }

  if (status === 'no-op') {
    return `Skill "${skillName}" is already ${action === 'enable' ? 'enabled' : 'disabled'}.`;
  }

  const isEnable = action === 'enable';
  const actionVerb = isEnable ? 'enabled' : 'disabled';
  const preposition = isEnable
    ? 'by removing it from the disabled list in'
    : 'by adding it to the disabled list in';

  const formatScopeItem = (s: { scope: SettingScope; path: string }) => {
    const label = s.scope.toLowerCase();
    return formatScope(label, s.path);
  };

  const totalAffectedScopes = [
    ...result.modifiedScopes,
    ...result.alreadyInStateScopes,
  ];

  if (totalAffectedScopes.length === 2) {
    const s1 = formatScopeItem(totalAffectedScopes[0]);
    const s2 = formatScopeItem(totalAffectedScopes[1]);

    if (isEnable) {
      return `Skill "${skillName}" ${actionVerb} ${preposition} ${s1} and ${s2} settings.`;
    } else {
      return `Skill "${skillName}" is now disabled in both ${s1} and ${s2} settings.`;
    }
  }

  const s = formatScopeItem(totalAffectedScopes[0]);
  return `Skill "${skillName}" ${actionVerb} ${preposition} ${s} settings.`;
}

/** Hard cap for remote skill zip downloads (100 MB). */
const MAX_REMOTE_SKILL_ZIP_BYTES = 100 * 1024 * 1024;

type SourceKind = 'remote-zip' | 'git' | 'local-archive' | 'local-dir';

/**
 * Classifies an install source. Remote zips are detected by parsing the URL
 * and inspecting the pathname (so query strings like `?sig=...` don't defeat
 * the `.zip` check), and must be matched before git URLs — otherwise a
 * `https://host/skill.zip` would be misrouted to `git clone`.
 */
function classifySource(source: string): SourceKind {
  const isHttpUrl =
    source.startsWith('http://') || source.startsWith('https://');

  if (isHttpUrl) {
    let pathname = '';
    try {
      pathname = new URL(source).pathname.toLowerCase();
    } catch {
      pathname = '';
    }
    if (pathname.endsWith('.zip')) {
      return 'remote-zip';
    }
  }

  if (isHttpUrl || source.startsWith('git@')) {
    return 'git';
  }

  const lower = source.toLowerCase();
  if (lower.endsWith('.skill') || lower.endsWith('.zip')) {
    return 'local-archive';
  }

  return 'local-dir';
}

/**
 * Central logic for installing a skill from a remote URL or local path.
 */
export async function installSkill(
  source: string,
  scope: 'user' | 'workspace',
  subpath: string | undefined,
  onLog: (msg: string) => void,
  requestConsent: (
    skills: SkillDefinition[],
    targetDir: string,
  ) => Promise<boolean> = () => Promise.resolve(true),
): Promise<Array<{ name: string; location: string }>> {
  let sourcePath = source;
  let tempDirToClean: string | undefined = undefined;

  const kind = classifySource(source);

  try {
    if (kind === 'remote-zip') {
      if (source.startsWith('http://')) {
        throw new Error('Remote skill install requires an HTTPS URL.');
      }

      tempDirToClean = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gemini-skill-'),
      );
      const zipPath = path.join(tempDirToClean, 'download.zip');
      const extractDir = path.join(tempDirToClean, 'extracted');

      onLog(`Downloading skill from ${source}...`);
      await new Downloader({ maxSize: MAX_REMOTE_SKILL_ZIP_BYTES }).download(
        source,
        zipPath,
      );

      onLog(`Extracting skill from ${source}...`);
      await extractArchiveSafely(zipPath, extractDir, {
        symlinkPolicy: 'allow-contained',
      });
      sourcePath = extractDir;
    } else if (kind === 'git') {
      tempDirToClean = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gemini-skill-'),
      );
      sourcePath = tempDirToClean;

      onLog(`Cloning skill from ${source}...`);
      // Clone into the temporary directory before discovering skills.
      await cloneFromGit(
        {
          source,
          type: 'git',
        },
        tempDirToClean,
      );
    } else if (kind === 'local-archive') {
      tempDirToClean = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gemini-skill-'),
      );
      sourcePath = tempDirToClean;

      onLog(`Extracting skill from ${source}...`);
      await extractArchiveSafely(path.resolve(source), tempDirToClean, {
        symlinkPolicy: 'allow-contained',
      });
    }

    // If a subpath is provided, resolve it against the cloned/extracted root.
    if (subpath) {
      sourcePath = path.join(sourcePath, subpath);
    }

    sourcePath = path.resolve(sourcePath);

    // Prevent directory traversal out of the temp root (e.g. via subpath).
    if (tempDirToClean) {
      assertInside(tempDirToClean, sourcePath);
      assertInside(
        await fs.realpath(tempDirToClean),
        await fs.realpath(sourcePath),
      );
    }

    onLog(`Searching for skills in ${sourcePath}...`);
    // A cloned / extracted root may itself be the skill package, so this
    // caller opts into direct-skill semantics.
    const skills = await loadSkillsFromDir(sourcePath, {
      allowDirectSkill: true,
    });

    if (skills.length === 0) {
      throw new Error(
        `No valid skills found in ${source}${subpath ? ` at path "${subpath}"` : ''}. Ensure a SKILL.md file exists with valid frontmatter.`,
      );
    }

    const canonicalSourceRoot = await fs.realpath(sourcePath);
    for (const skill of skills) {
      const skillDir = path.dirname(skill.location);
      // Installation is a copy boundary: unlike linkSkill, installed Skills
      // may not retain dependencies outside the selected Skill root.
      assertInside(canonicalSourceRoot, await fs.realpath(skillDir));
      await assertContainedSymlinks(skillDir);
    }

    const workspaceDir = process.cwd();
    const storage = new Storage(workspaceDir);
    const targetDir =
      scope === 'workspace'
        ? storage.getProjectSkillsDir()
        : Storage.getUserSkillsDir();

    if (!(await requestConsent(skills, targetDir))) {
      throw new Error('Skill installation cancelled by user.');
    }

    await fs.mkdir(targetDir, { recursive: true });

    const installedSkills: Array<{ name: string; location: string }> = [];

    for (const skill of skills) {
      const skillName = skill.name;
      const skillDir = path.dirname(skill.location);
      const destPath = path.join(targetDir, skillName);

      // Stage into a unique temp sibling first, then swap. A failed copy
      // therefore never destroys the previously installed skill, and a
      // per-process staging name keeps concurrent installs from colliding.
      const stagingPath = path.join(
        targetDir,
        `.${skillName}.installing.${process.pid}.${randomUUID()}`,
      );
      let backupPath: string | undefined;
      try {
        const copyResult = await copyContainedTree(skillDir, stagingPath);
        if (copyResult.skippedSymlinks > 0) {
          throw new Error(
            `Refusing to install Skill "${skillName}": source contains ${copyResult.skippedSymlinks} unsafe symlink(s).`,
          );
        }

        const exists = await fs.stat(destPath).catch(() => null);
        if (exists) {
          onLog(`Skill "${skillName}" already exists. Overwriting...`);
          // Move the old install aside instead of deleting it, so a failed
          // swap can be rolled back without data loss.
          backupPath = `${stagingPath}.backup`;
          await fs.rename(destPath, backupPath);
        }

        try {
          await fs.rename(stagingPath, destPath);
        } catch (err) {
          if (backupPath) {
            try {
              await fs.rename(backupPath, destPath);
              // Rollback succeeded: backup is back in place as destPath.
              backupPath = undefined;
            } catch {
              // Rollback failed: keep backupPath so finally cleans it up.
            }
          }
          throw err;
        }
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
        if (backupPath) {
          await fs.rm(backupPath, { recursive: true, force: true });
        }
      }

      installedSkills.push({ name: skillName, location: destPath });
    }

    return installedSkills;
  } finally {
    if (tempDirToClean) {
      await fs.rm(tempDirToClean, { recursive: true, force: true });
    }
  }
}

/**
 * Central logic for linking a skill from a local path via symlink.
 */
export async function linkSkill(
  source: string,
  scope: 'user' | 'workspace',
  onLog: (msg: string) => void,
  requestConsent: (
    skills: SkillDefinition[],
    targetDir: string,
  ) => Promise<boolean> = () => Promise.resolve(true),
): Promise<Array<{ name: string; location: string }>> {
  const sourcePath = path.resolve(source);

  onLog(`Searching for skills in ${sourcePath}...`);
  // The linked path may itself be the skill package, so this caller opts into
  // direct-skill semantics.
  const skills = await loadSkillsFromDir(sourcePath, {
    allowDirectSkill: true,
  });

  if (skills.length === 0) {
    throw new Error(
      `No valid skills found in "${sourcePath}". Ensure a SKILL.md file exists with valid frontmatter.`,
    );
  }

  // Check for internal name collisions
  const seenNames = new Map<string, string>();
  for (const skill of skills) {
    if (seenNames.has(skill.name)) {
      throw new Error(
        `Duplicate skill name "${skill.name}" found at multiple locations:\n  - ${seenNames.get(skill.name)}\n  - ${skill.location}`,
      );
    }
    seenNames.set(skill.name, skill.location);
  }

  const workspaceDir = process.cwd();
  const storage = new Storage(workspaceDir);
  const targetDir =
    scope === 'workspace'
      ? storage.getProjectSkillsDir()
      : Storage.getUserSkillsDir();

  if (!(await requestConsent(skills, targetDir))) {
    throw new Error('Skill linking cancelled by user.');
  }

  await fs.mkdir(targetDir, { recursive: true });

  const linkedSkills: Array<{ name: string; location: string }> = [];

  for (const skill of skills) {
    const skillName = skill.name;
    const skillSourceDir = path.dirname(skill.location);
    const destPath = path.join(targetDir, skillName);

    const exists = await fs.lstat(destPath).catch(() => null);
    if (exists) {
      onLog(
        `Skill "${skillName}" already exists at destination. Overwriting...`,
      );
      await fs.rm(destPath, { recursive: true, force: true });
    }

    // Use 'junction' on Windows to avoid EPERM errors — junctions don't
    // require elevated privileges or Developer Mode (fixes #24816)
    await fs.symlink(
      skillSourceDir,
      destPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    linkedSkills.push({ name: skillName, location: destPath });
  }

  return linkedSkills;
}

/**
 * SKILL.md means a dedicated subdirectory — delete the whole directory.
 * Bare .md files share a parent with siblings — only delete the file itself.
 */
export async function safeDeleteSkill(skillLocation: string): Promise<string> {
  if (/^skill\.md$/i.test(path.basename(skillLocation))) {
    const skillDir = path.dirname(skillLocation);
    await fs.rm(skillDir, { recursive: true, force: true });
    return skillDir;
  }
  await fs.rm(skillLocation, { force: true });
  return skillLocation;
}

/**
 * Central logic for uninstalling a skill by name.
 */
export async function uninstallSkill(
  name: string,
  scope: 'user' | 'workspace',
): Promise<{ location: string } | null> {
  const workspaceDir = process.cwd();
  const storage = new Storage(workspaceDir);
  const targetDir =
    scope === 'workspace'
      ? storage.getProjectSkillsDir()
      : Storage.getUserSkillsDir();

  // Load all skills in the target directory to find the one with the matching
  // name. Container semantics are deliberate: targetDir is the skills *root*,
  // so a stray SKILL.md there must not be matched — deleting it would take the
  // whole root with it (see safeDeleteSkill).
  const discoveredSkills = await loadSkillsFromDir(targetDir);
  const skillToUninstall = discoveredSkills.find((s) => s.name === name);

  if (!skillToUninstall) {
    // Fallback: Check if a directory with the given name exists.
    // This maintains backward compatibility for cases where the metadata might be missing or corrupted
    // but the directory name matches the user's request.
    const skillPath = path.resolve(targetDir, name);

    // Security check: ensure the resolved path is within the target directory to prevent path traversal
    if (!skillPath.startsWith(path.resolve(targetDir))) {
      return null;
    }

    const exists = await fs.lstat(skillPath).catch(() => null);

    if (!exists) {
      return null;
    }

    await fs.rm(skillPath, { recursive: true, force: true });
    return { location: skillPath };
  }

  const deletedPath = await safeDeleteSkill(skillToUninstall.location);
  return { location: deletedPath };
}
