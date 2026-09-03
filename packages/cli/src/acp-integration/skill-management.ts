/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { RequestError } from '@agentclientprotocol/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { downloadSkill } from './skill-source-download.js';

function toRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const stringValue = readOptionalString(value, fieldName);
  if (!stringValue) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing ${fieldName}`,
    );
  }
  return stringValue;
}

type QwenSkillInstallRequest = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  sourceUrl: string;
  scope: 'global';
};

type QwenSkillDeleteRequest = {
  slug: string;
  scope: 'global';
};

type QwenSkillSetEnabledRequest = {
  slug: string;
  enabled: boolean;
  scope: 'global' | 'project';
};

type QwenManagedSkillFile = {
  skillDir: string;
  skillFile: string;
  content: string;
};

const PROJECT_SKILL_DIRS = ['.qwen', '.agents'] as const;
const SKILLS_DIR = 'skills';

// Skill slugs are used to build filesystem paths under `<globalQwenDir>/skills`.
// The character allowlist below already excludes `/` and `\`, but `.` and `..`
// would still slip through and let `path.join` traverse out of the skills dir
// (e.g. slug `..` resolves to the global config dir). Reject them explicitly.
function validateSkillSlug(slug: string): void {
  if (
    !slug ||
    slug === '.' ||
    slug === '..' ||
    slug.includes('/') ||
    slug.includes(path.sep) ||
    !/^[a-zA-Z0-9._-]+$/.test(slug)
  ) {
    throw RequestError.invalidParams(undefined, 'Invalid skill.slug');
  }
}

function rejectInstallArtifactSlug(slug: string): void {
  if (/\.(backup|installing)-\d+-\d+$/.test(slug)) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid skill.slug: name ends with a reserved install-artifact suffix',
    );
  }
}

function readSkillInstallRequest(
  params: Record<string, unknown>,
): QwenSkillInstallRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);
  rejectInstallArtifactSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global') {
    throw RequestError.invalidParams(
      undefined,
      'Only global skill installation is supported',
    );
  }

  const description = readOptionalString(
    input['description'],
    'skill.description',
  );
  return {
    id: readOptionalString(input['id'], 'skill.id') ?? slug,
    slug,
    name: readOptionalString(input['name'], 'skill.name') ?? slug,
    ...(description ? { description } : {}),
    sourceUrl: readRequiredString(input['sourceUrl'], 'skill.sourceUrl'),
    scope,
  };
}

function readSkillSlugRequest(
  params: Record<string, unknown>,
): QwenSkillDeleteRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global') {
    throw RequestError.invalidParams(
      undefined,
      'Only global skill management is supported',
    );
  }

  return { slug, scope };
}

function readSkillSetEnabledRequest(
  params: Record<string, unknown>,
): QwenSkillSetEnabledRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global' && scope !== 'project') {
    throw RequestError.invalidParams(
      undefined,
      'Only global or project skill management is supported',
    );
  }

  if (typeof input['enabled'] !== 'boolean') {
    throw RequestError.invalidParams(
      undefined,
      'Invalid skill.enabled: expected boolean',
    );
  }
  return {
    slug,
    scope,
    enabled: input['enabled'],
  };
}

function splitSkillMarkdown(content: string): {
  frontmatter: string;
  body: string;
} {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid skill file: missing YAML frontmatter',
    );
  }
  return {
    frontmatter: match[1],
    body: match[2],
  };
}

function setSkillFrontmatterEnabled(content: string, enabled: boolean): string {
  const { frontmatter, body } = splitSkillMarkdown(content);

  // Surgically add/remove only the top-level `disable-model-invocation:` line
  // instead of round-tripping the whole frontmatter through a YAML
  // parse/stringify. The minimal core YAML serializer drops comments and
  // flattens nested structures (e.g. `hooks:`), so reserializing here would
  // corrupt hooks-bearing skills and strip user comments. Working on the raw
  // text leaves every other byte untouched.
  const lines = frontmatter.split('\n');
  const disabledLineIndex = lines.findIndex((line) =>
    /^disable-model-invocation\s*:/.test(line),
  );

  if (enabled) {
    if (disabledLineIndex !== -1) {
      lines.splice(disabledLineIndex, 1);
    }
  } else if (disabledLineIndex !== -1) {
    lines[disabledLineIndex] = 'disable-model-invocation: true';
  } else {
    let insertIndex = lines.length;
    while (insertIndex > 0 && lines[insertIndex - 1].trim() === '') {
      insertIndex -= 1;
    }
    lines.splice(insertIndex, 0, 'disable-model-invocation: true');
  }

  const nextFrontmatter = lines.join('\n');
  return `---\n${nextFrontmatter}\n---\n${body}`;
}

function resolveSkillInstallPath(
  skillDir: string,
  relativePath: string,
): string {
  const root = path.resolve(skillDir);
  const target = path.resolve(skillDir, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid skill file path: ${relativePath}`,
    );
  }
  return target;
}

// Builds the per-skill directory and asserts (defense-in-depth, on top of
// validateSkillSlug) that it stays strictly under the managed skills root, so a
// crafted slug can never make install/delete operate on `<globalQwenDir>` itself.
function resolveManagedSkillDir(skillsBaseDir: string, slug: string): string {
  const root = path.resolve(skillsBaseDir);
  const skillDir = path.resolve(skillsBaseDir, slug);
  if (!skillDir.startsWith(root + path.sep)) {
    throw RequestError.invalidParams(undefined, 'Invalid skill.slug');
  }
  return skillDir;
}

export async function installManagedSkill(
  config: Config,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return installSkillFromUrl(config, readSkillInstallRequest(params));
}

export async function deleteManagedSkill(
  config: Config,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return deleteGlobalSkill(config, readSkillSlugRequest(params));
}

export async function setManagedSkillEnabled(
  config: Config,
  params: Record<string, unknown>,
  cwd?: string,
): Promise<Record<string, unknown>> {
  return setGlobalSkillEnabled(config, readSkillSetEnabledRequest(params), cwd);
}

async function installSkillFromUrl(
  config: Config,
  request: QwenSkillInstallRequest,
): Promise<Record<string, unknown>> {
  const skillManager = config.getSkillManager();
  if (!skillManager) {
    throw RequestError.invalidParams(
      undefined,
      'SkillManager is not available',
    );
  }

  const download = await downloadSkill(request.sourceUrl);
  const skillsBaseDir = path.join(Storage.getGlobalQwenDir(), 'skills');
  const skillDir = resolveManagedSkillDir(skillsBaseDir, request.slug);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const parsed = skillManager.parseSkillContent(
    download.skillContent,
    skillFile,
    'user',
  );
  if (parsed.name !== request.slug) {
    throw RequestError.invalidParams(
      undefined,
      `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
    );
  }

  // Install atomically: stage all files in a sibling temp directory, then
  // swap it in with a rollback-capable rename sequence. A mid-write failure
  // (disk full, permission error) therefore leaves the previously installed
  // skill intact instead of deleting it up front and ending up with a partial
  // install. The rename-based swap also drops orphaned files from older
  // versions, preserving the behavior of the previous rm-based approach.
  const stagingDir = `${skillDir}.installing-${process.pid}-${Date.now()}`;
  try {
    await fs.rm(stagingDir, { recursive: true, force: true });
    for (const file of download.files) {
      const targetPath = resolveSkillInstallPath(stagingDir, file.relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content);
    }
    // Rollback-capable swap: backup the old directory, rename staging in,
    // then remove the backup. On rename failure, restore the backup.
    const backupDir = `${skillDir}.backup-${process.pid}-${Date.now()}`;
    let backedUp = false;
    try {
      try {
        await fs.rename(skillDir, backupDir);
        backedUp = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // Old directory doesn't exist, no backup needed.
      }
      await fs.rename(stagingDir, skillDir);
    } catch (error) {
      if (backedUp) {
        await fs.rename(backupDir, skillDir).catch(() => {});
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (backedUp) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await skillManager.refreshCache();

  return {
    id: request.id,
    slug: parsed.name,
    installed: true,
    installedPath: skillFile,
    sourceUrl: request.sourceUrl,
  };
}

async function deleteGlobalSkill(
  config: Config,
  request: QwenSkillDeleteRequest,
): Promise<Record<string, unknown>> {
  const skillManager = config.getSkillManager();
  if (!skillManager) {
    throw RequestError.invalidParams(
      undefined,
      'SkillManager is not available',
    );
  }

  const { skillDir, skillFile, content } = await readManagedSkillFile(
    request.slug,
    'global',
    skillManager,
  );
  const parsed = skillManager.parseSkillContent(content, skillFile, 'user');
  if (parsed.name !== request.slug) {
    throw RequestError.invalidParams(
      undefined,
      `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
    );
  }

  // Guard the recursive delete: readManagedSkillFile's generic fallback can
  // resolve skillDir from listSkills() to an arbitrary path. Only ever remove
  // the directory that directly contains the SKILL.md we just validated, and
  // never a filesystem root or the global Qwen dir itself, so a malformed
  // skill entry can't trigger a destructive rm of a shared/parent directory.
  const resolvedSkillDir = path.resolve(skillDir);
  const resolvedSkillFile = path.resolve(skillFile);
  const globalDir = path.resolve(Storage.getGlobalQwenDir());
  const isDedicatedSkillDir =
    resolvedSkillFile === path.join(resolvedSkillDir, 'SKILL.md');
  if (
    !isDedicatedSkillDir ||
    resolvedSkillDir === path.parse(resolvedSkillDir).root ||
    resolvedSkillDir === globalDir
  ) {
    throw RequestError.invalidParams(
      undefined,
      `Refusing to delete unexpected skill directory: ${skillDir}`,
    );
  }

  await fs.rm(skillDir, { recursive: true, force: true });
  await skillManager.refreshCache();
  return {
    slug: request.slug,
    deleted: true,
  };
}

async function readManagedSkillFile(
  slug: string,
  scope: QwenSkillSetEnabledRequest['scope'],
  skillManager: NonNullable<ReturnType<Config['getSkillManager']>>,
  cwd?: string,
): Promise<QwenManagedSkillFile> {
  if (scope === 'global') {
    const qwenSkillDir = resolveManagedSkillDir(
      path.join(Storage.getGlobalQwenDir(), 'skills'),
      slug,
    );
    const qwenSkillFile = path.join(qwenSkillDir, 'SKILL.md');
    const qwenContent = await fs
      .readFile(qwenSkillFile, 'utf8')
      .catch(() => undefined);
    if (qwenContent !== undefined) {
      return {
        skillDir: qwenSkillDir,
        skillFile: qwenSkillFile,
        content: qwenContent,
      };
    }
  }

  if (scope === 'project' && cwd?.trim()) {
    const projectSkill = await findProjectSkillFileFromCwd(
      slug,
      cwd,
      skillManager,
    );
    if (projectSkill) return projectSkill;
  }

  const level = scope === 'project' ? 'project' : 'user';
  const skill = (await skillManager.listSkills({ level })).find(
    (candidate) => candidate.name === slug,
  );
  const skillFile = skill?.filePath;
  if (!skillFile) {
    throw RequestError.invalidParams(
      undefined,
      `${scope === 'project' ? 'Project' : 'Global'} skill not found: ${slug}`,
    );
  }

  const content = await fs.readFile(skillFile, 'utf8').catch(() => {
    throw RequestError.invalidParams(
      undefined,
      `${scope === 'project' ? 'Project' : 'Global'} skill not found: ${slug}`,
    );
  });
  return {
    skillDir: path.dirname(skillFile),
    skillFile,
    content,
  };
}

async function findProjectSkillFileFromCwd(
  slug: string,
  cwd: string,
  skillManager: NonNullable<ReturnType<Config['getSkillManager']>>,
): Promise<QwenManagedSkillFile | undefined> {
  const projectRoot = path.resolve(cwd);
  for (const configDir of PROJECT_SKILL_DIRS) {
    const baseDir = path.join(projectRoot, configDir, SKILLS_DIR);
    const skills = await skillManager.loadSkillsFromDir(baseDir, 'project');
    const skill = skills.find((candidate) => candidate.name === slug);
    const skillFile = skill?.filePath;
    if (!skillFile) continue;

    const content = await fs.readFile(skillFile, 'utf8').catch(() => {
      throw RequestError.invalidParams(
        undefined,
        `Project skill not found: ${slug}`,
      );
    });
    return {
      skillDir: path.dirname(skillFile),
      skillFile,
      content,
    };
  }
  return undefined;
}

async function setGlobalSkillEnabled(
  config: Config,
  request: QwenSkillSetEnabledRequest,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const skillManager = config.getSkillManager();
  if (!skillManager) {
    throw RequestError.invalidParams(
      undefined,
      'SkillManager is not available',
    );
  }

  const { skillFile, content } = await readManagedSkillFile(
    request.slug,
    request.scope,
    skillManager,
    cwd,
  );
  const level = request.scope === 'project' ? 'project' : 'user';
  const parsed = skillManager.parseSkillContent(content, skillFile, level);
  if (parsed.name !== request.slug) {
    throw RequestError.invalidParams(
      undefined,
      `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
    );
  }

  const nextContent = setSkillFrontmatterEnabled(content, request.enabled);
  skillManager.parseSkillContent(nextContent, skillFile, level);
  // Defense-in-depth (consistent with deleteGlobalSkill): readManagedSkillFile's
  // generic fallback can resolve skillFile from listSkills() to an arbitrary
  // path. We only ever write back to the SKILL.md manifest we just read and
  // whose parsed name matched the slug, so refuse to write anything else.
  if (path.basename(skillFile) !== 'SKILL.md') {
    throw RequestError.invalidParams(
      undefined,
      `Refusing to write to unexpected skill file: ${skillFile}`,
    );
  }
  await fs.writeFile(skillFile, nextContent, 'utf8');
  await skillManager.refreshCache();
  return {
    slug: request.slug,
    enabled: request.enabled,
    installedPath: skillFile,
  };
}
