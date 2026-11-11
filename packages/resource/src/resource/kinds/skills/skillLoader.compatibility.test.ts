/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainSkillLoadErrors, loadSkillsFromDir } from './skillLoader.js';
import { logger } from './internal.js';

/**
 * `fs.opendir` cannot be spied on: an ESM module namespace is not
 * configurable. Wrap it once, passing through to the real implementation unless
 * a test installs an override, so only the tests that need a synthetic
 * directory handle see one.
 *
 * `readFileGate` serves the same purpose for ordering: it parks the read of one
 * specific file until the test releases it, which is the only way to pin down
 * what happens while a load is suspended mid-flight. `readFileFailures` reaches
 * the loader's fatal-error branch without having to craft file content that
 * defeats every parser fallback.
 */
let opendirOverride: typeof fs.opendir | null = null;
let readFileGate: { filePath: string; release: Promise<void> } | null = null;
let readFileFailures: Set<string> = new Set();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: ((...args: Parameters<typeof actual.opendir>) =>
      opendirOverride
        ? opendirOverride(...args)
        : actual.opendir(...args)) as typeof actual.opendir,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const target = args[0];
      if (readFileGate && target === readFileGate.filePath) {
        await readFileGate.release;
      }
      if (typeof target === 'string' && readFileFailures.has(target)) {
        const error: NodeJS.ErrnoException = new Error(
          `EACCES: permission denied, open '${target}'`,
        );
        error.code = 'EACCES';
        throw error;
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

describe('skillLoader', () => {
  let testRootDir: string;

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-loader-test-'),
    );
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // The loader accumulates load errors in a module-level buffer; clear it so
    // one test's leftovers cannot leak into another's assertions.
    drainSkillLoadErrors();
  });

  afterEach(async () => {
    opendirOverride = null;
    readFileGate = null;
    readFileFailures = new Set();
    await fs.rm(testRootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should load skills from a directory with valid SKILL.md', async () => {
    const skillDir = path.join(testRootDir, 'my-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---\nname: my-skill\ndescription: A test skill\n---\n# Instructions\nDo something.\n`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my-skill');
    expect(skills[0].description).toBe('A test skill');
    expect(skills[0].location).toBe(skillFile);
    expect(skills[0].skillRoot).toBe(skillDir);
    expect(skills[0].body).toBe('# Instructions\nDo something.');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should emit feedback when no valid skills are found in a non-empty directory', async () => {
    const notASkillDir = path.join(testRootDir, 'not-a-skill');
    await fs.mkdir(notASkillDir, { recursive: true });
    await fs.writeFile(path.join(notASkillDir, 'some-file.txt'), 'hello');

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load skills from'),
    );
  });

  it('should ignore empty directories and not emit feedback', async () => {
    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should ignore directories without SKILL.md', async () => {
    const notASkillDir = path.join(testRootDir, 'not-a-skill');
    await fs.mkdir(notASkillDir, { recursive: true });

    // With a subdirectory, even if empty, it might still trigger readdir
    // But my current logic is if discoveredSkills.length === 0, then check readdir
    // If readdir is empty, it's fine.

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(0);
    // If notASkillDir is empty, no warning.
  });

  it('loads SKILL.md without frontmatter using a body-derived description (SK45)', async () => {
    const skillDir = path.join(testRootDir, 'invalid-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillFile, '# No frontmatter here');

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('invalid-skill');
    // SK45: description falls back to the first body line (heading stripped).
    expect(skills[0].description).toBe('No frontmatter here');
    expect(skills[0].hasUserSpecifiedDescription).toBe(false);
  });

  it('should return empty array for non-existent directory', async () => {
    const skills = await loadSkillsFromDir('/non/existent/path');
    expect(skills).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should parse skill with colon in description (issue #16323)', async () => {
    const skillDir = path.join(testRootDir, 'colon-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
name: foo
description: Simple story generation assistant for fiction writing. Use for creating characters, scenes, storylines, and prose. Trigger words: character, scene, storyline, story, prose, fiction, writing.
---
# Instructions
Do something.
`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    // Identity now comes from the directory name; frontmatter.name → displayName.
    expect(skills[0].name).toBe('colon-skill');
    expect(skills[0].displayName).toBe('foo');
    expect(skills[0].description).toContain('Trigger words:');
  });

  it('should parse skill with multiple colons in description', async () => {
    const skillDir = path.join(testRootDir, 'multi-colon-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
name: multi-colon
description: Use this for tasks like: coding, reviewing, testing. Keywords: async, await, promise.
---
# Instructions
Do something.
`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('multi-colon-skill');
    expect(skills[0].displayName).toBe('multi-colon');
    expect(skills[0].description).toContain('tasks like:');
    expect(skills[0].description).toContain('Keywords:');
  });

  it('should parse skill with quoted YAML description (backward compatibility)', async () => {
    const skillDir = path.join(testRootDir, 'quoted-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
name: quoted-skill
description: "A skill with colons: like this one: and another."
---
# Instructions
Do something.
`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('quoted-skill');
    expect(skills[0].description).toBe(
      'A skill with colons: like this one: and another.',
    );
  });

  it('should parse skill with multi-line YAML description', async () => {
    const skillDir = path.join(testRootDir, 'multiline-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
name: multiline-skill
description:
  Expertise in reviewing code for style, security, and performance. Use when the
  user asks for "feedback," a "review," or to "check" their changes.
---
# Instructions
Do something.
`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('multiline-skill');
    expect(skills[0].description).toContain('Expertise in reviewing code');
    expect(skills[0].description).toContain('check');
  });

  it('should accept when-to-use, when_to_use, and whenToUse spellings', async () => {
    const cases: Array<[string, string]> = [
      ['kebab-skill', 'when-to-use'],
      ['snake-skill', 'when_to_use'],
      ['camel-skill', 'whenToUse'],
    ];
    for (const [dir, key] of cases) {
      const skillDir = path.join(testRootDir, dir);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${dir}\ndescription: d\n${key}: pick when X happens\n---\nbody`,
      );
    }

    const skills = await loadSkillsFromDir(testRootDir);
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get('kebab-skill')?.whenToUse).toBe('pick when X happens');
    expect(byName.get('snake-skill')?.whenToUse).toBe('pick when X happens');
    expect(byName.get('camel-skill')?.whenToUse).toBe('pick when X happens');
  });

  it('should handle empty name or description', async () => {
    const skillDir = path.join(testRootDir, 'empty-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
name:
description:
---
`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    // Empty frontmatter.name → identity falls back to the directory name.
    expect(skills[0].name).toBe('empty-skill');
    // displayName falls back to displayBase (the unprefixed label), which
    // is the directory name when loaded via loadSkillsFromDir.
    expect(skills[0].displayName).toBe('empty-skill');
    // Empty body + missing description → generic "Skill" fallback label.
    expect(skills[0].description).toBe('Skill');
  });

  it('should handle indented name and description fields', async () => {
    const skillDir = path.join(testRootDir, 'indented-fields');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
  name: indented-name
  description: indented-desc
---
`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('indented-fields');
    expect(skills[0].displayName).toBe('indented-name');
    expect(skills[0].description).toBe('indented-desc');
  });

  it('should handle missing space after colon', async () => {
    const skillDir = path.join(testRootDir, 'no-space');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
name:no-space-name
description:no-space-desc
---
`,
    );

    const skills = await loadSkillsFromDir(testRootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('no-space');
    expect(skills[0].displayName).toBe('no-space-name');
    expect(skills[0].description).toBe('no-space-desc');
  });

  it('should keep colons in displayName (identity stays path-derived)', async () => {
    const skillFile = path.join(testRootDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
name: gke:prs-troubleshooter
description: Test sanitization
---
`,
    );

    // The directory itself is the skill package here, which is install-style
    // input rather than a skills root.
    const skills = await loadSkillsFromDir(testRootDir, {
      allowDirectSkill: true,
    });

    expect(skills).toHaveLength(1);
    // Identity is path-derived (the testRoot basename), so it is filesystem-safe
    // by construction. frontmatter.name keeps its colon in displayName since
    // colons are the legitimate namespace separator.
    expect(skills[0].name).toBe(path.basename(testRootDir));
    expect(skills[0].displayName).toBe('gke:prs-troubleshooter');
  });

  it('ignores YAML `kind:` (converter-stamped only)', async () => {
    const skillFile = path.join(testRootDir, 'SKILL.md');
    await fs.writeFile(
      skillFile,
      `---
description: A skill that tries to stamp kind via YAML
kind: plugin-command
---
body
`,
    );

    const skills = await loadSkillsFromDir(testRootDir, {
      allowDirectSkill: true,
    });

    expect(skills).toHaveLength(1);
    // kind must remain undefined: only pluginCommandToSkill writes it.
    expect(skills[0].kind).toBeUndefined();
  });

  describe('skills root is a container', () => {
    const writeSkill = async (dir: string, name: string) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} description\n---\nbody\n`,
      );
    };

    it('ignores a stray SKILL.md at the root and still loads subdirectories', async () => {
      // Shape produced by an installer that unpacks a skill flat into the
      // skills root instead of <root>/<name>/.
      await writeSkill(testRootDir, 'stray-root-skill');
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');
      await writeSkill(path.join(testRootDir, 'beta'), 'beta');

      const skills = await loadSkillsFromDir(testRootDir);

      expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
      // The container's own basename must never become a skill identity: it
      // would collide with the built-in /skills command.
      expect(skills.some((s) => s.name === path.basename(testRootDir))).toBe(
        false,
      );
    });

    it('reports the ignored root SKILL.md as a warning', async () => {
      await writeSkill(testRootDir, 'stray-root-skill');
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');

      await loadSkillsFromDir(testRootDir);
      const errors = drainSkillLoadErrors();

      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('warning');
      expect(errors[0].configType).toBe('skill');
      expect(errors[0].filePath).toBe(path.join(testRootDir, 'SKILL.md'));
      expect(errors[0].message).toContain('Ignoring SKILL.md at the root');
      // /skills cannot render an ownerless warning, so the log is the only
      // place the actionable text survives.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring SKILL.md at the root'),
      );
    });

    it('does not warn when the root has no SKILL.md', async () => {
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');

      const skills = await loadSkillsFromDir(testRootDir);

      expect(skills.map((s) => s.name)).toEqual(['alpha']);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('loads the directory itself when allowDirectSkill is set', async () => {
      await writeSkill(testRootDir, 'package-root-skill');
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');

      const skills = await loadSkillsFromDir(testRootDir, {
        allowDirectSkill: true,
      });

      // Install-style callers get the package, not its subdirectories.
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe(path.basename(testRootDir));
      expect(skills[0].displayName).toBe('package-root-skill');
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('loads a direct skill whose root SKILL.md is an external symlink', async () => {
      // Dev/monorepo layout: the package root links its manifest at a file that
      // lives outside the directory handed to the loader.
      const packageDir = path.join(testRootDir, 'package');
      const externalDir = path.join(testRootDir, 'external-package');
      await fs.mkdir(packageDir, { recursive: true });
      await writeSkill(externalDir, 'external-direct-skill');
      await fs.symlink(
        path.join(externalDir, 'SKILL.md'),
        path.join(packageDir, 'SKILL.md'),
        'file',
      );

      const skills = await loadSkillsFromDir(packageDir, {
        allowDirectSkill: true,
      });

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('package');
      expect(skills[0].displayName).toBe('external-direct-skill');
      expect(drainSkillLoadErrors()).toEqual([]);
    });
  });

  describe('nested skill containers', () => {
    const writeSkill = async (dir: string, name: string) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} description\n---\nbody\n`,
      );
    };

    it('loads skills nested under category subdirectories', async () => {
      // Layout shipped by plugins that group skills by category:
      // <skills>/engineering/<name>/SKILL.md
      await writeSkill(
        path.join(testRootDir, 'engineering', 'code-review'),
        'code-review',
      );
      await writeSkill(
        path.join(testRootDir, 'engineering', 'deep', 'refactor'),
        'refactor',
      );
      await writeSkill(path.join(testRootDir, 'top-level'), 'top-level');

      const skills = await loadSkillsFromDir(testRootDir);

      expect(skills.map((s) => s.name).sort()).toEqual([
        'code-review',
        'refactor',
        'top-level',
      ]);
      // Identity comes from the skill package directory, not the category.
      const nested = skills.find((s) => s.name === 'code-review');
      expect(nested?.location).toBe(
        path.join(testRootDir, 'engineering', 'code-review', 'SKILL.md'),
      );
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('does not descend below a skill package boundary', async () => {
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');
      // A SKILL.md inside a skill package (e.g. bundled example) must not
      // surface as a separate skill.
      await writeSkill(
        path.join(testRootDir, 'alpha', 'examples', 'inner'),
        'inner',
      );

      const skills = await loadSkillsFromDir(testRootDir);

      expect(skills.map((s) => s.name)).toEqual(['alpha']);
    });

    it('skips node_modules and .git while scanning', async () => {
      await writeSkill(
        path.join(testRootDir, 'node_modules', 'dep-skill'),
        'dep-skill',
      );
      await writeSkill(
        path.join(testRootDir, '.git', 'git-skill'),
        'git-skill',
      );
      await writeSkill(path.join(testRootDir, 'real'), 'real');

      const skills = await loadSkillsFromDir(testRootDir);

      expect(skills.map((s) => s.name)).toEqual(['real']);
    });

    it('loads through an external symlink in a user skills root', async () => {
      const skillsRoot = path.join(testRootDir, 'user-skills');
      const externalSkill = path.join(testRootDir, 'external', 'linked-skill');
      await fs.mkdir(skillsRoot, { recursive: true });
      await writeSkill(externalSkill, 'linked-skill');
      await fs.symlink(
        externalSkill,
        path.join(skillsRoot, 'linked-skill'),
        'dir',
      );

      const skills = await loadSkillsFromDir(skillsRoot);

      expect(skills.map((s) => s.name)).toEqual(['linked-skill']);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('loads a plugin skill symlinked from elsewhere inside the plugin', async () => {
      const pluginRoot = path.join(testRootDir, 'plugin');
      const skillsRoot = path.join(pluginRoot, 'skills');
      const sharedSkill = path.join(pluginRoot, 'shared', 'shared-skill');
      await fs.mkdir(skillsRoot, { recursive: true });
      await writeSkill(sharedSkill, 'shared-skill');
      await fs.symlink(
        sharedSkill,
        path.join(skillsRoot, 'linked-skill'),
        'dir',
      );

      const skills = await loadSkillsFromDir(skillsRoot);

      expect(skills.map((s) => s.name)).toEqual(['linked-skill']);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('loads a skill directory symlinked outside the plugin root', async () => {
      const pluginRoot = path.join(testRootDir, 'plugin');
      const skillsRoot = path.join(pluginRoot, 'skills');
      const externalSkill = path.join(testRootDir, 'external', 'outside-skill');
      await fs.mkdir(skillsRoot, { recursive: true });
      await writeSkill(externalSkill, 'outside-skill');
      await writeSkill(path.join(skillsRoot, 'inside-skill'), 'inside-skill');
      await fs.symlink(
        externalSkill,
        path.join(skillsRoot, 'outside-skill'),
        'dir',
      );

      const skills = await loadSkillsFromDir(skillsRoot);

      expect(skills.map((s) => s.name).sort()).toEqual([
        'inside-skill',
        'outside-skill',
      ]);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('loads a nested category symlinked outside the plugin root', async () => {
      const pluginRoot = path.join(testRootDir, 'plugin');
      const skillsRoot = path.join(pluginRoot, 'skills');
      const externalCategory = path.join(testRootDir, 'external-category');
      await fs.mkdir(skillsRoot, { recursive: true });
      await writeSkill(
        path.join(externalCategory, 'outside-skill'),
        'outside-skill',
      );
      await fs.symlink(
        externalCategory,
        path.join(skillsRoot, 'engineering'),
        'dir',
      );

      const skills = await loadSkillsFromDir(skillsRoot);

      expect(skills.map((s) => s.name)).toEqual(['outside-skill']);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('loads a SKILL.md that is itself a symlink to an external file', async () => {
      const pluginRoot = path.join(testRootDir, 'plugin');
      const skillsRoot = path.join(pluginRoot, 'skills');
      const linkedSkillDir = path.join(skillsRoot, 'linked-file-skill');
      const externalSkillDir = path.join(testRootDir, 'external-file-skill');
      await fs.mkdir(linkedSkillDir, { recursive: true });
      await writeSkill(externalSkillDir, 'outside-file');
      await fs.symlink(
        path.join(externalSkillDir, 'SKILL.md'),
        path.join(linkedSkillDir, 'SKILL.md'),
        'file',
      );

      const skills = await loadSkillsFromDir(skillsRoot);

      expect(skills.map((s) => s.name)).toEqual(['linked-file-skill']);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('terminates when an external symlink points back into the scanned root', async () => {
      const pluginRoot = path.join(testRootDir, 'plugin');
      const skillsRoot = path.join(pluginRoot, 'skills');
      const externalCategory = path.join(testRootDir, 'external-loop');
      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.mkdir(externalCategory, { recursive: true });
      await writeSkill(path.join(skillsRoot, 'inside-skill'), 'inside-skill');
      // skills/hop -> external-loop, external-loop/back -> skills
      await fs.symlink(externalCategory, path.join(skillsRoot, 'hop'), 'dir');
      await fs.symlink(skillsRoot, path.join(externalCategory, 'back'), 'dir');

      const skills = await loadSkillsFromDir(skillsRoot);

      expect(skills.map((s) => s.name)).toEqual(['inside-skill']);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('still applies the scan budget to an external symlinked tree', async () => {
      const pluginRoot = path.join(testRootDir, 'plugin');
      const skillsRoot = path.join(pluginRoot, 'skills');
      const externalCategory = path.join(testRootDir, 'external-many');
      await fs.mkdir(skillsRoot, { recursive: true });
      await writeSkill(path.join(externalCategory, 'alpha'), 'alpha');
      await writeSkill(path.join(externalCategory, 'beta'), 'beta');
      await fs.symlink(
        externalCategory,
        path.join(skillsRoot, 'engineering'),
        'dir',
      );

      const skills = await loadSkillsFromDir(skillsRoot, {
        scanLimits: { maxSkills: 1 },
      });
      const errors = drainSkillLoadErrors();

      expect(skills).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('maximum 1 skills');
    });

    it('bounds nested discovery depth and reports an aggregate warning', async () => {
      await writeSkill(
        path.join(testRootDir, 'category', 'depth-two-skill'),
        'depth-two-skill',
      );
      await writeSkill(
        path.join(testRootDir, 'category', 'deeper', 'depth-three-skill'),
        'depth-three-skill',
      );

      const skills = await loadSkillsFromDir(testRootDir, {
        scanLimits: { maxDepth: 2 },
      });
      const errors = drainSkillLoadErrors();

      expect(skills.map((s) => s.name)).toEqual(['depth-two-skill']);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('maximum depth 2');
    });

    it('bounds the number of scanned directories', async () => {
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');
      await writeSkill(path.join(testRootDir, 'beta'), 'beta');

      const skills = await loadSkillsFromDir(testRootDir, {
        scanLimits: { maxDirectories: 1 },
      });
      const errors = drainSkillLoadErrors();

      expect(skills).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('maximum 1 directories');
    });

    it('bounds the number of directory entries read', async () => {
      // maxDirectories only bounds the subdirectories descended into; a single
      // listing must be truncated as it streams so one link at a huge tree
      // cannot make discovery unbounded.
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');
      await writeSkill(path.join(testRootDir, 'beta'), 'beta');
      await fs.writeFile(path.join(testRootDir, 'README.md'), 'noise');

      const skills = await loadSkillsFromDir(testRootDir, {
        scanLimits: { maxEntries: 1 },
      });
      const errors = drainSkillLoadErrors();

      // Iteration order is not guaranteed, so the single claimed entry may be
      // the plain file rather than a skill directory.
      expect(skills.length).toBeLessThanOrEqual(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('warning');
      expect(errors[0].message).toContain('maximum 1 directory entries');
    });

    it('stops pulling entries as soon as the entry budget is spent', async () => {
      // The truncation assertions above would hold for a readdir-then-slice
      // implementation too, which is exactly the unbounded materialization this
      // budget exists to prevent. Pin the streaming contract itself: the
      // listing must not be drained past the budget.
      let pulled = 0;
      let closed = false;
      let opendirCalls = 0;
      const fakeEntry = (name: string) =>
        ({
          name,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isFile: () => true,
        }) as unknown as Dirent;
      const fakeHandle = {
        path: testRootDir,
        close: async () => {
          closed = true;
        },
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 10_000; i++) {
            pulled++;
            yield fakeEntry(`entry-${i}`);
          }
        },
      };
      opendirOverride = (async () => {
        opendirCalls++;
        return fakeHandle as never;
      }) as typeof fs.opendir;

      let errors;
      try {
        await loadSkillsFromDir(testRootDir, {
          scanLimits: { maxEntries: 3 },
        });
        errors = drainSkillLoadErrors();
      } finally {
        opendirOverride = null;
      }

      expect(opendirCalls).toBe(1);
      // The budget is three, and whether the fourth entry has to arrive before
      // the check trips is an implementation detail — being anywhere near the
      // 10 000 available is not.
      expect(pulled).toBeGreaterThanOrEqual(3);
      expect(pulled).toBeLessThanOrEqual(4);
      expect(closed).toBe(true);
      expect(
        errors.some((e) => e.message.includes('maximum 3 directory entries')),
      ).toBe(true);
    });

    it('bounds the number of discovered skills', async () => {
      await writeSkill(path.join(testRootDir, 'alpha'), 'alpha');
      await writeSkill(path.join(testRootDir, 'beta'), 'beta');

      const skills = await loadSkillsFromDir(testRootDir, {
        scanLimits: { maxSkills: 1 },
      });
      const errors = drainSkillLoadErrors();

      expect(skills).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('maximum 1 skills');
    });
  });

  describe('requireSkills', () => {
    it('reports a load error when a declared non-empty dir yields no skills', async () => {
      const junkDir = path.join(testRootDir, 'not-a-skill');
      await fs.mkdir(junkDir, { recursive: true });
      await fs.writeFile(path.join(junkDir, 'readme.txt'), 'hello');

      const skills = await loadSkillsFromDir(testRootDir, {
        requireSkills: true,
      });
      const errors = drainSkillLoadErrors();

      expect(skills).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('error');
      expect(errors[0].configType).toBe('skill');
      expect(errors[0].filePath).toBe(testRootDir);
      expect(errors[0].message).toContain('No skills were loaded from');
      // The actionable text must also land in the persistent run log.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No skills were loaded from'),
      );
    });

    it('stays silent for an empty directory', async () => {
      const skills = await loadSkillsFromDir(testRootDir, {
        requireSkills: true,
      });

      expect(skills).toHaveLength(0);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('stays silent when skills load successfully', async () => {
      const skillDir = path.join(testRootDir, 'ok-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ok-skill\ndescription: fine\n---\nbody\n`,
      );

      const skills = await loadSkillsFromDir(testRootDir, {
        requireSkills: true,
      });

      expect(skills).toHaveLength(1);
      expect(drainSkillLoadErrors()).toEqual([]);
    });

    it('does not blame the layout when a budget cut the scan short', async () => {
      // Valid skills may well be sitting in the part of the tree that was never
      // read, so "no valid SKILL.md was found" is a claim the truncated scan
      // cannot make. The budget warning is the whole story.
      for (const name of ['a', 'b', 'c']) {
        const dir = path.join(testRootDir, name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'readme.txt'), 'hello');
      }

      await loadSkillsFromDir(testRootDir, {
        requireSkills: true,
        scanLimits: { maxEntries: 1 },
      });
      const errors = drainSkillLoadErrors();

      expect(errors.every((e) => e.severity === 'warning')).toBe(true);
      expect(
        errors.some((e) => e.message.includes('maximum 1 directory entries')),
      ).toBe(true);
      expect(
        errors.some((e) => e.message.includes('No skills were loaded from')),
      ).toBe(false);
    });

    it('reports a load error when a declared direct skill file yields nothing', async () => {
      // `allowDirectSkill` returns before the shared zero-result reporting, so
      // without its own check a declared skills path would vanish silently.
      const skillFile = path.join(testRootDir, 'SKILL.md');
      await fs.writeFile(skillFile, '');

      const skills = await loadSkillsFromDir(testRootDir, {
        allowDirectSkill: true,
        requireSkills: true,
      });
      const errors = drainSkillLoadErrors();

      expect(skills).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('error');
      expect(errors[0].filePath).toBe(skillFile);
      expect(errors[0].message).toContain('No skill was loaded from');
    });

    it('still reports the zero result when the file only earned a warning', async () => {
      // Broken YAML that the repair pass cannot fix: the parser records a
      // warning and the file yields no skill. A warning means "loaded despite a
      // problem", so on its own it would leave a declared source looking fine.
      const skillFile = path.join(testRootDir, 'SKILL.md');
      await fs.writeFile(skillFile, '---\n- [unclosed\n---\n');

      const skills = await loadSkillsFromDir(testRootDir, {
        allowDirectSkill: true,
        requireSkills: true,
      });
      const errors = drainSkillLoadErrors();

      expect(skills).toHaveLength(0);
      expect(
        errors.map((e) => ({
          severity: e.severity,
          yaml: e.message.includes('YAML parse error'),
          zeroResult: e.message.includes(
            `No skill was loaded from ${skillFile}`,
          ),
        })),
      ).toStrictEqual([
        { severity: 'warning', yaml: true, zeroResult: false },
        { severity: 'error', yaml: false, zeroResult: true },
      ]);
    });

    it('does not pile a vaguer report onto its own load failure', async () => {
      // The load itself already recorded why the file could not be read.
      const skillFile = path.join(testRootDir, 'SKILL.md');
      await fs.writeFile(skillFile, 'body\n');
      readFileFailures = new Set([skillFile]);

      const skills = await loadSkillsFromDir(testRootDir, {
        allowDirectSkill: true,
        requireSkills: true,
      });
      const errors = drainSkillLoadErrors();

      expect(skills).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].filePath).toBe(skillFile);
      expect(errors[0].message).toContain('Error parsing skill file');
      expect(
        errors.some((e) => e.message.includes('No skill was loaded from')),
      ).toBe(false);
    });

    it('still reports its own zero result when another load errors meanwhile', async () => {
      // Load errors accumulate in one module-level buffer that concurrent loads
      // share, so whether to report must be decided from this call's own result.
      // Park the empty file's read and let an unrelated load push its error in
      // the meantime: any check against that buffer — its length or a path match
      // — would drop this declared source without a word.
      const emptyRoot = path.join(testRootDir, 'empty-direct');
      const brokenRoot = path.join(testRootDir, 'broken-direct');
      await fs.mkdir(emptyRoot, { recursive: true });
      await fs.mkdir(brokenRoot, { recursive: true });
      const emptyFile = path.join(emptyRoot, 'SKILL.md');
      const brokenFile = path.join(brokenRoot, 'SKILL.md');
      await fs.writeFile(emptyFile, '');
      await fs.writeFile(brokenFile, 'body\n');
      readFileFailures = new Set([brokenFile]);

      let release!: () => void;
      readFileGate = {
        filePath: emptyFile,
        release: new Promise<void>((resolve) => {
          release = () => resolve();
        }),
      };
      let errors;
      // The gate must be released even if an assertion or load throws first,
      // otherwise the parked load never settles and the run hangs.
      const pendingEmpty = loadSkillsFromDir(emptyRoot, {
        allowDirectSkill: true,
        requireSkills: true,
      });
      try {
        await loadSkillsFromDir(brokenRoot, {
          allowDirectSkill: true,
          requireSkills: true,
        });
      } finally {
        release();
        await pendingEmpty;
        errors = drainSkillLoadErrors();
      }

      expect(
        errors
          .filter((e) => e.filePath === emptyFile)
          .map((e) => ({
            severity: e.severity,
            own: e.message.includes('No skill was loaded from'),
          })),
      ).toEqual([{ severity: 'error', own: true }]);
    });
  });
});
