/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  installArtifactPid,
  isInstallArtifactName,
  isInstallArtifactOfSkill,
  isSelfNamedSkillDirectory,
  resolveLegacyArtifactNamedSkillFile,
} from './skill-install-artifacts.js';

// The loader-side filtering of these names is pinned in
// `skill-install-artifacts.test.ts` (mocked fs). This file pins the shared
// name predicates and the content-level legacy-skill check with a real
// filesystem, because those are what the management surfaces and the
// installer sweep rely on to tell a legacy skill from a crashed artifact.

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-artifact-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSkillDir(
  baseDir: string,
  name: string,
  declaredName: string,
): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${declaredName}\ndescription: ${declaredName} skill\n---\nBody\n`,
    'utf8',
  );
  return skillDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('isInstallArtifactName', () => {
  it('matches the exact artifact shapes and rejects near misses', () => {
    expect(isInstallArtifactName('pptx.backup-12345-1753901234567')).toBe(true);
    expect(isInstallArtifactName('pptx.installing-12345-1753901234567')).toBe(
      true,
    );
    // Name merely contains the marker: not an artifact shape.
    expect(isInstallArtifactName('db.backup-2024')).toBe(false);
    // Trailing segments after the two digit groups break the end anchor.
    expect(isInstallArtifactName('db.backup-2024-1234-archive')).toBe(false);
    // Hyphen instead of a dot before `backup-` breaks the literal `\.`.
    expect(isInstallArtifactName('data-backup-2024-06')).toBe(false);
    // Only one digit group.
    expect(isInstallArtifactName('db.backup-2024')).toBe(false);
  });
});

describe('isInstallArtifactOfSkill', () => {
  it('matches only artifacts of the exact skill name', () => {
    expect(isInstallArtifactOfSkill('pptx.backup-123-456', 'pptx')).toBe(true);
    expect(isInstallArtifactOfSkill('pptx.installing-123-456', 'pptx')).toBe(
      true,
    );
    expect(isInstallArtifactOfSkill('pp.backup-123-456', 'pptx')).toBe(false);
    expect(isInstallArtifactOfSkill('other.backup-123-456', 'pptx')).toBe(
      false,
    );
    // A prefix of the skill name must not match.
    expect(isInstallArtifactOfSkill('pptx-old.backup-123-456', 'pptx')).toBe(
      false,
    );
  });

  it('escapes regex metacharacters in the skill name', () => {
    expect(isInstallArtifactOfSkill('a.b.backup-123-456', 'a.b')).toBe(true);
    expect(isInstallArtifactOfSkill('axb.backup-123-456', 'a.b')).toBe(false);
  });
});

describe('installArtifactPid', () => {
  it('extracts the embedded pid', () => {
    expect(installArtifactPid('pptx.backup-123-456')).toBe(123);
    expect(installArtifactPid('pptx.installing-7-8')).toBe(7);
    expect(installArtifactPid('pptx')).toBeUndefined();
    expect(installArtifactPid('db.backup-2024')).toBeUndefined();
  });
});

describe('isSelfNamedSkillDirectory', () => {
  it('distinguishes legacy self-named skills from swap artifacts', async () => {
    const baseDir = await makeTempDir();
    // Legacy skill: manifest declares the artifact-shaped directory name.
    const legacy = await writeSkillDir(
      baseDir,
      'foo.backup-1-2',
      'foo.backup-1-2',
    );
    // Crashed artifact of `foo`: manifest declares the base skill name.
    const artifact = await writeSkillDir(baseDir, 'foo.backup-3-4', 'foo');
    // Staging dir mid-write with no manifest yet.
    const staging = path.join(baseDir, 'foo.installing-5-6');
    await fs.mkdir(staging, { recursive: true });

    await expect(isSelfNamedSkillDirectory(legacy)).resolves.toBe(true);
    await expect(isSelfNamedSkillDirectory(artifact)).resolves.toBe(false);
    await expect(isSelfNamedSkillDirectory(staging)).resolves.toBe(false);
  });
});

describe('resolveLegacyArtifactNamedSkillFile', () => {
  it('resolves a legacy artifact-shaped skill', async () => {
    const baseDir = await makeTempDir();
    await writeSkillDir(baseDir, 'foo.backup-1-2', 'foo.backup-1-2');

    await expect(
      resolveLegacyArtifactNamedSkillFile(baseDir, 'foo.backup-1-2'),
    ).resolves.toBe(path.join(baseDir, 'foo.backup-1-2', 'SKILL.md'));
  });

  it('resolves a legacy skill named like a staging artifact', async () => {
    const baseDir = await makeTempDir();
    await writeSkillDir(
      baseDir,
      'legacy.installing-9-10',
      'legacy.installing-9-10',
    );

    await expect(
      resolveLegacyArtifactNamedSkillFile(baseDir, 'legacy.installing-9-10'),
    ).resolves.toBe(path.join(baseDir, 'legacy.installing-9-10', 'SKILL.md'));
  });

  it('returns undefined for crashed swap artifacts', async () => {
    const baseDir = await makeTempDir();
    await writeSkillDir(baseDir, 'foo.backup-1-2', 'foo');

    await expect(
      resolveLegacyArtifactNamedSkillFile(baseDir, 'foo.backup-1-2'),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for non-artifact-shaped names', async () => {
    const baseDir = await makeTempDir();
    await writeSkillDir(baseDir, 'pptx', 'pptx');

    await expect(
      resolveLegacyArtifactNamedSkillFile(baseDir, 'pptx'),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when nothing exists on disk', async () => {
    const baseDir = await makeTempDir();

    await expect(
      resolveLegacyArtifactNamedSkillFile(baseDir, 'foo.backup-1-2'),
    ).resolves.toBeUndefined();
  });
});
