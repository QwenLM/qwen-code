/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadServerHierarchicalMemory } from './memoryDiscovery.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { setMemoryFilename } from '../utils/memory-constants.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: vi.fn(),
}));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('memory discovery trust and explicit scope', () => {
  let temp: string;
  let project: string;
  let cwd: string;
  let home: string;
  let explicit: string;

  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setMemoryFilename('QWEN.md');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', 'true');
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-boundary-'));
    project = path.join(temp, 'project');
    cwd = path.join(project, 'src');
    home = path.join(temp, 'home');
    explicit = path.join(temp, 'explicit');
    vi.mocked(os.homedir).mockReturnValue(home);
    await fs.mkdir(path.join(project, '.git'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await write(path.join(project, 'QWEN.md'), 'PROJECT_SECRET');
    await write(path.join(cwd, 'QWEN.md'), 'CWD_SECRET');
    await write(path.join(project, '.qwen', 'QWEN.local.md'), 'LOCAL_SECRET');
    await write(path.join(project, '.qwen', 'rules', 'rule.md'), 'RULE_SECRET');
    await write(path.join(explicit, 'QWEN.md'), 'EXPLICIT_CONTEXT');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setMemoryFilename('QWEN.md');
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each([
    {
      name: 'untrusted project',
      trusted: false,
      global: false,
      explicit: false,
      include: false,
      expected: undefined,
    },
    {
      name: 'user context outside untrusted project',
      trusted: false,
      global: true,
      explicit: false,
      include: false,
      expected: 'GLOBAL_CONTEXT',
    },
    {
      name: 'explicit mode with no include',
      trusted: true,
      global: true,
      explicit: true,
      include: false,
      expected: undefined,
    },
    {
      name: 'explicit include only',
      trusted: true,
      global: true,
      explicit: true,
      include: true,
      expected: 'EXPLICIT_CONTEXT',
    },
  ])('$name', async (row) => {
    if (row.global) {
      await write(path.join(home, '.qwen', 'QWEN.md'), 'GLOBAL_CONTEXT');
    }
    const result = await loadServerHierarchicalMemory(
      cwd,
      row.include ? [explicit] : [],
      new FileDiscoveryService(project),
      [],
      row.trusted,
      'tree',
      [],
      { explicitOnly: row.explicit },
    );
    expect(result.fileCount).toBe(row.expected ? 1 : 0);
    expect(result.ruleCount).toBe(0);
    expect(result.conditionalRules).toEqual([]);
    if (row.expected) expect(result.memoryContent).toContain(row.expected);
    else expect(result.memoryContent).toBe('');
    for (const forbidden of [
      'PROJECT_SECRET',
      'CWD_SECRET',
      'LOCAL_SECRET',
      'RULE_SECRET',
    ]) {
      expect(result.memoryContent).not.toContain(forbidden);
    }
    if (row.explicit)
      expect(result.memoryContent).not.toContain('GLOBAL_CONTEXT');
  });
});
