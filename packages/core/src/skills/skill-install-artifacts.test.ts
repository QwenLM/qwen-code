/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import { loadSkillsFromDir } from './skill-load.js';
import { SkillManager } from './skill-manager.js';
import { makeFakeConfig } from '../test-utils/config.js';

// Mock file system operations
vi.mock('fs/promises');
vi.mock('os');

const { mockWatch } = vi.hoisted(() => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockWatch = vi.fn().mockReturnValue(mockWatcher);
  return { mockWatch };
});

vi.mock('chokidar', () => ({
  watch: mockWatch,
}));

// Mock yaml parser - use vi.hoisted for proper hoisting
const mockParseYaml = vi.hoisted(() => vi.fn());

vi.mock('../utils/yaml-parser.js', () => ({
  parse: mockParseYaml,
  stringify: vi.fn(),
}));

const TEST_HOME = '/home/user';
const BASE_DIR = '/test/skills';

// Entries seeded into the skills directory: one real skill, two crashed
// reinstall artifacts shaped like the ones `installSkill` leaves behind
// (`<slug>.backup-<pid>-<timestamp>` / `<slug>.installing-<pid>-<timestamp>`),
// and legitimate skill dirs that must still load: a name merely containing
// `.backup-` (`db.backup-2024`), a name continuing after the two digit
// groups (`db.backup-2024-1234-archive`, pins the `$` end anchor), and a
// name with a hyphen instead of a dot before `backup-`
// (`data-backup-2024-06`, pins the literal `\.` requirement).
const dirEntry = (name: string) => ({
  name,
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
});

function seedSkillsDir(): void {
  vi.mocked(fs.readdir).mockResolvedValue([
    dirEntry('my-skill'),
    dirEntry('my-skill.backup-12345-1753901234567'),
    dirEntry('my-skill.installing-12345-1753901234568'),
    dirEntry('db.backup-2024'),
    dirEntry('db.backup-2024-1234-archive'),
    dirEntry('data-backup-2024-06'),
  ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

  vi.mocked(fs.access).mockResolvedValue(undefined);

  // Every seeded dir carries a valid SKILL.md whose frontmatter name
  // identifies which directory it came from.
  vi.mocked(fs.readFile).mockImplementation((filePath) => {
    const pathStr = String(filePath);
    if (pathStr.includes('my-skill.backup-')) {
      return Promise.resolve(`---
name: stale-backup
description: Stale backup artifact
---
body`);
    }
    if (pathStr.includes('my-skill.installing-')) {
      return Promise.resolve(`---
name: stale-staging
description: Stale staging artifact
---
body`);
    }
    if (pathStr.includes('db.backup-2024-1234-archive')) {
      return Promise.resolve(`---
name: db-2024-archive
description: Legitimate dir continuing after the digit groups
---
body`);
    }
    if (pathStr.includes('db.backup-2024')) {
      return Promise.resolve(`---
name: db-2024
description: Legitimate dir with backup in its name
---
body`);
    }
    if (pathStr.includes('data-backup-2024-06')) {
      return Promise.resolve(`---
name: data-backup-skill
description: Legitimate dir with hyphen before backup-
---
body`);
    }
    if (pathStr.includes('my-skill')) {
      return Promise.resolve(`---
name: real-skill
description: The real skill
---
body`);
    }
    return Promise.reject(new Error('File not found'));
  });

  mockParseYaml.mockImplementation((yamlString: string) => {
    const text = String(yamlString);
    const name = /name:\s*(\S+)/.exec(text)?.[1];
    const description = /description:\s*(.+)/.exec(text)?.[1];
    return { name, description };
  });
}

const EXPECTED_LOADED = [
  'data-backup-skill',
  'db-2024',
  'db-2024-archive',
  'real-skill',
];

describe('install artifact filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(TEST_HOME);
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    seedSkillsDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skill-load: filters reinstall artifacts but loads legit `.backup-` dirs', async () => {
    const skills = await loadSkillsFromDir(BASE_DIR);

    expect(skills.map((s) => s.name).sort()).toEqual(EXPECTED_LOADED);
  });

  it('skill-manager: filters reinstall artifacts but loads legit `.backup-` dirs', async () => {
    const manager = new SkillManager(makeFakeConfig({}));

    const skills = await manager.loadSkillsFromDir(BASE_DIR, 'project');

    expect(skills.map((s) => s.name).sort()).toEqual(EXPECTED_LOADED);
  });
});
