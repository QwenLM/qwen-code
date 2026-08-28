/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  commitMigratedMemoryMetadata,
  runMemoryMetadataMigration,
  scanMemoryMetadataCorpusStatus,
  scanMemoryMetadataMigrationCandidates,
  type GeneratedMemoryMetadata,
  type MemoryMetadataMigrationCandidate,
} from './metadata-migration.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
} from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';

function legacyContent(body = 'BODY\nWITH TRAILING NEWLINE\n'): string {
  return [
    '---',
    'type: project',
    'title: Legacy title',
    'custom_field:',
    '  nested: preserved',
    '---',
    body,
  ].join('\n');
}

function metadata(
  candidate: MemoryMetadataMigrationCandidate,
  keyword = 'memory migration',
): GeneratedMemoryMetadata {
  return {
    relativePath: candidate.relativePath,
    sourceHash: candidate.sourceHash,
    name: 'Migrated memory',
    description: 'Complete migrated metadata',
    type: 'project',
    category: 'project_introduction',
    keywords: [keyword, 'frontmatter migration'],
    usage_scenarios: ['Migrating legacy memories'],
  };
}

describe('memory metadata migration', () => {
  let tempDir: string;
  let projectRoot: string;
  let memoryRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-migration-'));
    projectRoot = path.join(tempDir, 'project');
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'global');
    clearAutoMemoryRootCache();
    await ensureAutoMemoryScaffold(projectRoot);
    memoryRoot = getAutoMemoryRoot(projectRoot);
  });

  afterEach(async () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function write(relativePath: string, content: string): Promise<string> {
    const filePath = path.join(memoryRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  it('selects only files missing the strict structured contract', async () => {
    await write('project/legacy.md', legacyContent());
    await write(
      'project/structured.md',
      [
        '---',
        'name: Structured',
        'description: Complete metadata',
        'type: project',
        'category: project_introduction',
        'keywords:',
        '  - memory migration',
        '  - structured memory',
        'usage_scenarios:',
        '  - Testing migration',
        '---',
        'Body.',
      ].join('\n'),
    );

    const candidates = await scanMemoryMetadataMigrationCandidates(
      memoryRoot,
      'project',
    );

    expect(candidates.map((candidate) => candidate.relativePath)).toEqual([
      'project/legacy.md',
    ]);
  });

  it('ignores directories whose names end in .md', async () => {
    await fs.mkdir(path.join(memoryRoot, 'project', 'fake.md'), {
      recursive: true,
    });

    await expect(
      scanMemoryMetadataMigrationCandidates(memoryRoot, 'project'),
    ).resolves.toEqual([]);
  });

  it.each([
    ['unclosed boundary', '---\ntype: project\nUnclosed body'],
    ['invalid YAML', '---\nname: [broken\n---\nBody'],
    ['non-object YAML', '---\n- item\n---\nBody'],
  ])('repairs %s without dropping the original file', async (_, original) => {
    const filePath = await write('project/broken.md', original);
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) =>
        metadata(candidate),
    );

    const result = await runMemoryMetadataMigration({
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project',
      generateMetadata,
    });

    expect(result).toMatchObject({
      legacyFiles: 1,
      remainingLegacyFiles: 0,
      attempted: 1,
      committed: 1,
    });
    expect(generateMetadata).toHaveBeenCalledOnce();
    expect(await fs.readFile(filePath, 'utf-8')).toContain(
      `\n---\n${original}`,
    );
    await expect(
      scanMemoryMetadataCorpusStatus({
        projectRoot,
        teamMemoryEnabled: false,
        trustedProject: true,
      }),
    ).resolves.toMatchObject({ ready: true, legacyFiles: 0 });
  });

  it('requires every visible project, user, and enabled team file to be structured', async () => {
    const localProjectRoot = path.join(projectRoot, '.qwen', 'memory');
    const userRoot = path.join(tempDir, 'global', 'memories');
    const teamRoot = path.join(projectRoot, '.qwen', 'team-memory');
    await write(
      'project/structured.md',
      [
        '---',
        'name: Structured',
        'description: Complete metadata',
        'type: project',
        'category: project_introduction',
        'keywords:',
        '  - memory migration',
        '  - structured memory',
        'usage_scenarios:',
        '  - Testing migration',
        '---',
        'Body.',
      ].join('\n'),
    );
    await fs.mkdir(localProjectRoot, { recursive: true });
    await fs.writeFile(
      path.join(localProjectRoot, 'legacy.md'),
      legacyContent(),
      'utf-8',
    );
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(
      path.join(userRoot, 'legacy.md'),
      legacyContent(),
      'utf-8',
    );
    await fs.mkdir(teamRoot, { recursive: true });
    await fs.writeFile(
      path.join(teamRoot, 'legacy.md'),
      legacyContent(),
      'utf-8',
    );

    const status = await scanMemoryMetadataCorpusStatus({
      projectRoot,
      teamMemoryEnabled: true,
      trustedProject: true,
    });

    expect(status).toMatchObject({
      ready: false,
      files: 4,
      legacyFiles: 3,
      legacyByScope: { project: 1, user: 1, team: 1 },
    });
  });

  it('does not count disabled or untrusted team memory in readiness', async () => {
    const teamRoot = path.join(projectRoot, '.qwen', 'team-memory');
    await fs.mkdir(teamRoot, { recursive: true });
    await fs.writeFile(
      path.join(teamRoot, 'legacy.md'),
      legacyContent(),
      'utf-8',
    );

    await expect(
      scanMemoryMetadataCorpusStatus({
        projectRoot,
        teamMemoryEnabled: false,
        trustedProject: true,
      }),
    ).resolves.toMatchObject({ ready: true, legacyFiles: 0 });
    await expect(
      scanMemoryMetadataCorpusStatus({
        projectRoot,
        teamMemoryEnabled: true,
        trustedProject: false,
      }),
    ).resolves.toMatchObject({ ready: true, legacyFiles: 0 });
  });

  it('does not count repo-local project memory when the project is untrusted', async () => {
    await write('legacy.md', legacyContent());

    await expect(
      scanMemoryMetadataCorpusStatus({
        projectRoot,
        teamMemoryEnabled: false,
        trustedProject: false,
      }),
    ).resolves.toMatchObject({ ready: true, files: 0, legacyFiles: 0 });
  });

  it('atomically merges metadata while preserving unknown fields and body bytes', async () => {
    const original = legacyContent('BODY\r\nBYTES\r\n');
    await write('project/legacy.md', original);
    const [candidate] = await scanMemoryMetadataMigrationCandidates(
      memoryRoot,
      'project',
    );

    expect(
      await commitMigratedMemoryMetadata(candidate!, metadata(candidate!)),
    ).toBe('committed');
    const updated = await fs.readFile(candidate!.filePath, 'utf-8');
    expect(updated).toContain('custom_field:\n  nested: preserved');
    expect(updated.slice(updated.indexOf('\n---') + 4)).toBe(
      original.slice(original.indexOf('\n---') + 4),
    );
  });

  it('adds frontmatter to a plain legacy file without changing its body', async () => {
    const body = 'Plain legacy body.\r\nSecond line.\r\n';
    await write('project/plain.md', body);
    const [candidate] = await scanMemoryMetadataMigrationCandidates(
      memoryRoot,
      'project',
    );

    expect(
      await commitMigratedMemoryMetadata(candidate!, metadata(candidate!)),
    ).toBe('committed');
    const updated = await fs.readFile(candidate!.filePath, 'utf-8');
    expect(updated.slice(updated.indexOf('\r\n---\r\n') + 7)).toBe(body);
  });

  it('does not overwrite a file changed after candidate selection', async () => {
    const filePath = await write('project/legacy.md', legacyContent());
    const [candidate] = await scanMemoryMetadataMigrationCandidates(
      memoryRoot,
      'project',
    );
    await fs.writeFile(filePath, `${legacyContent()}NEWER`, 'utf-8');

    expect(
      await commitMigratedMemoryMetadata(candidate!, metadata(candidate!)),
    ).toBe('conflict');
    expect((await fs.readFile(filePath, 'utf-8')).endsWith('NEWER')).toBe(true);
  });

  it('rejects a symlinked migration root before reading or writing files', async () => {
    const outsideRoot = path.join(tempDir, 'outside');
    const outsideFile = path.join(outsideRoot, 'legacy.md');
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(outsideFile, legacyContent());
    await fs.rm(memoryRoot, { recursive: true, force: true });
    await fs.symlink(
      outsideRoot,
      memoryRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const generateMetadata = vi.fn();

    await expect(
      runMemoryMetadataMigration({
        config: {} as Config,
        projectRoot,
        root: memoryRoot,
        scope: 'project',
        generateMetadata,
      }),
    ).rejects.toThrow('symlinked memory root');

    expect(generateMetadata).not.toHaveBeenCalled();
    await expect(fs.readFile(outsideFile, 'utf-8')).resolves.toBe(
      legacyContent(),
    );
    await expect(
      fs.stat(path.join(outsideRoot, 'MEMORY.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not migrate files through a symlinked directory', async () => {
    const outsideRoot = path.join(tempDir, 'outside-directory');
    const outsideFile = path.join(outsideRoot, 'legacy.md');
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(outsideFile, legacyContent(), 'utf-8');
    await fs.symlink(
      outsideRoot,
      path.join(memoryRoot, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const candidates = await scanMemoryMetadataMigrationCandidates(
      memoryRoot,
      'project',
    );

    expect(candidates).toEqual([]);
    await expect(fs.readFile(outsideFile, 'utf-8')).resolves.toBe(
      legacyContent(),
    );
  });

  it('treats deletion and rename after selection as CAS conflicts', async () => {
    const deletedPath = await write('project/deleted.md', legacyContent());
    const renamedPath = await write('project/renamed.md', legacyContent());
    const candidates = await scanMemoryMetadataMigrationCandidates(
      memoryRoot,
      'project',
    );
    const deleted = candidates.find(
      (candidate) => candidate.filePath === deletedPath,
    )!;
    const renamed = candidates.find(
      (candidate) => candidate.filePath === renamedPath,
    )!;
    const destination = path.join(memoryRoot, 'project', 'moved.md');
    await fs.rm(deletedPath);
    await fs.rename(renamedPath, destination);

    await expect(
      commitMigratedMemoryMetadata(deleted, metadata(deleted)),
    ).resolves.toBe('conflict');
    await expect(
      commitMigratedMemoryMetadata(renamed, metadata(renamed)),
    ).resolves.toBe('conflict');
    expect(await fs.readFile(destination, 'utf-8')).toBe(legacyContent());
  });

  it('treats a concurrent extraction update as a CAS conflict', async () => {
    const filePath = await write('project/legacy.md', legacyContent());
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) => {
        await fs.writeFile(
          filePath,
          `${legacyContent()}Extraction wrote a newer body.`,
          'utf-8',
        );
        return metadata(candidate);
      },
    );

    const result = await runMemoryMetadataMigration({
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project',
      generateMetadata,
    });

    expect(result).toEqual({
      filesScanned: 1,
      legacyFiles: 1,
      remainingLegacyFiles: 1,
      attempted: 1,
      committed: 0,
      conflicts: 1,
      failed: 0,
      agentDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(await fs.readFile(filePath, 'utf-8')).toContain(
      'Extraction wrote a newer body.',
    );
  });

  it('rejects invalid generated metadata without changing the file', async () => {
    const original = legacyContent();
    await write('project/legacy.md', original);
    const [candidate] = await scanMemoryMetadataMigrationCandidates(
      memoryRoot,
      'project',
    );
    const invalid = { ...metadata(candidate!), keywords: ['one'] };

    expect(await commitMigratedMemoryMetadata(candidate!, invalid)).toBe(
      'invalid',
    );
    expect(await fs.readFile(candidate!.filePath, 'utf-8')).toBe(original);
  });

  it('rebuilds vocabulary after every successful file', async () => {
    await write('project/one.md', legacyContent('First body'));
    await write('project/two.md', legacyContent('Second body'));
    const vocabularies: string[] = [];
    const generateMetadata = vi.fn(
      async (
        _config: Config,
        candidate: MemoryMetadataMigrationCandidate,
        vocabulary: string,
      ) => {
        vocabularies.push(vocabulary);
        return metadata(
          candidate,
          candidate.relativePath.endsWith('one.md')
            ? 'new canonical phrase'
            : 'second phrase',
        );
      },
    );

    const result = await runMemoryMetadataMigration({
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project',
      generateMetadata,
    });

    expect(result).toEqual({
      filesScanned: 2,
      legacyFiles: 2,
      remainingLegacyFiles: 0,
      attempted: 2,
      committed: 2,
      conflicts: 0,
      failed: 0,
      agentDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(vocabularies[0]).not.toContain('new canonical phrase');
    expect(vocabularies[1]).toContain('new canonical phrase');
  });

  it('rebuilds project vocabulary across configured and compatibility roots', async () => {
    const compatibilityRoot = memoryRoot;
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    const configuredRoot = getAutoMemoryRoot(projectRoot);
    await fs.mkdir(path.join(compatibilityRoot, 'project'), {
      recursive: true,
    });
    await fs.mkdir(path.join(configuredRoot, 'project'), { recursive: true });
    await fs.writeFile(
      path.join(compatibilityRoot, 'project', 'one.md'),
      legacyContent('First body'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(configuredRoot, 'project', 'two.md'),
      legacyContent('Second body'),
      'utf-8',
    );
    const vocabularies: string[] = [];

    const result = await runMemoryMetadataMigration({
      config: {} as Config,
      projectRoot,
      roots: [compatibilityRoot, configuredRoot],
      scope: 'project',
      generateMetadata: async (_config, candidate, vocabulary) => {
        vocabularies.push(vocabulary);
        return metadata(
          candidate,
          candidate.relativePath.endsWith('one.md')
            ? 'cross root phrase'
            : 'second phrase',
        );
      },
    });

    expect(result).toMatchObject({ attempted: 2, committed: 2 });
    expect(vocabularies[0]).not.toContain('cross root phrase');
    expect(vocabularies[1]).toContain('cross root phrase');
  });

  it('migrates team metadata only when explicitly given the team root', async () => {
    const teamRoot = getTeamAutoMemoryRoot(projectRoot);
    await fs.mkdir(path.join(teamRoot, 'project'), { recursive: true });
    const teamFile = path.join(teamRoot, 'project', 'legacy.md');
    const original = legacyContent('Shared team body');
    await fs.writeFile(teamFile, original, 'utf-8');

    const result = await runMemoryMetadataMigration({
      config: {} as Config,
      projectRoot,
      root: teamRoot,
      scope: 'team',
      generateMetadata: async (_config, candidate) => metadata(candidate),
    });

    expect(result).toMatchObject({ attempted: 1, committed: 1 });
    const migrated = await fs.readFile(teamFile, 'utf-8');
    expect(migrated).toContain('name: Migrated memory');
    expect(migrated.endsWith('Shared team body')).toBe(true);
    await expect(
      fs.readFile(path.join(teamRoot, 'MEMORY.md'), 'utf-8'),
    ).resolves.toContain('Migrated memory');
  });

  it('aggregates migration agent latency and token usage', async () => {
    await write('project/one.md', legacyContent('First body'));
    await write('project/two.md', legacyContent('Second body'));

    const result = await runMemoryMetadataMigration({
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project',
      generateMetadata: async (_config, candidate) => ({
        metadata: metadata(candidate),
        durationMs: 25,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    });

    expect(result).toMatchObject({
      agentDurationMs: 50,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
  });

  it('processes at most ten files per run and resumes from a fresh scan', async () => {
    for (let index = 0; index < 12; index += 1) {
      await write(
        `project/${String(index).padStart(2, '0')}.md`,
        legacyContent(),
      );
    }
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) =>
        metadata(candidate),
    );
    const params = {
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project' as const,
      generateMetadata,
    };

    expect(await runMemoryMetadataMigration(params)).toMatchObject({
      attempted: 10,
      committed: 10,
    });
    expect(await runMemoryMetadataMigration(params)).toMatchObject({
      attempted: 2,
      committed: 2,
    });
  });

  it('caps an oversized single-file agent body input and still commits it', async () => {
    await write('project/large.md', legacyContent('x'.repeat(50_000)));
    let receivedBodyChars = 0;
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) => {
        receivedBodyChars = candidate.bodyChars;
        return metadata(candidate);
      },
    );

    const result = await runMemoryMetadataMigration({
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project',
      generateMetadata,
    });

    expect(result).toMatchObject({ attempted: 1, committed: 1 });
    expect(receivedBodyChars).toBe(40_000);
  });

  it('defers a second file when the current batch exhausts the body budget', async () => {
    await write('project/one.md', legacyContent('a'.repeat(50_000)));
    await write('project/two.md', legacyContent('b'.repeat(50_000)));
    const receivedBodies: number[] = [];
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) => {
        receivedBodies.push(candidate.bodyChars);
        return metadata(candidate);
      },
    );
    const params = {
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project' as const,
      generateMetadata,
    };

    await expect(runMemoryMetadataMigration(params)).resolves.toMatchObject({
      attempted: 1,
      committed: 1,
      remainingLegacyFiles: 1,
    });
    await expect(runMemoryMetadataMigration(params)).resolves.toMatchObject({
      attempted: 1,
      committed: 1,
      remainingLegacyFiles: 0,
    });
    expect(receivedBodies).toEqual([40_000, 40_000]);
  });

  it('continues after one invalid result and retries that file on the next run', async () => {
    await write('project/one.md', legacyContent('One'));
    await write('project/two.md', legacyContent('Two'));
    const failedPaths = new Set<string>();
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) => {
        if (failedPaths.size === 0) {
          failedPaths.add(candidate.relativePath);
          return { ...metadata(candidate), keywords: ['invalid'] };
        }
        return metadata(candidate);
      },
    );
    const params = {
      config: {} as Config,
      projectRoot,
      root: memoryRoot,
      scope: 'project' as const,
      generateMetadata,
    };

    expect(await runMemoryMetadataMigration(params)).toEqual({
      filesScanned: 2,
      legacyFiles: 2,
      remainingLegacyFiles: 1,
      attempted: 2,
      committed: 1,
      conflicts: 0,
      failed: 1,
      agentDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(await runMemoryMetadataMigration(params)).toMatchObject({
      attempted: 1,
      committed: 1,
    });
  });

  it('rebuilds the index for files committed before cancellation', async () => {
    await write('project/one.md', legacyContent('One'));
    await write('project/two.md', legacyContent('Two'));
    const controller = new AbortController();
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) => {
        controller.abort();
        return metadata(candidate);
      },
    );

    await expect(
      runMemoryMetadataMigration({
        config: {} as Config,
        projectRoot,
        root: memoryRoot,
        scope: 'project',
        generateMetadata,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const index = await fs.readFile(
      path.join(memoryRoot, 'MEMORY.md'),
      'utf-8',
    );
    expect(index).toContain('Migrated memory');
  });

  it('rebuilds committed indexes when the active agent rejects on abort', async () => {
    await write('project/one.md', legacyContent('One'));
    await write('project/two.md', legacyContent('Two'));
    const controller = new AbortController();
    let callCount = 0;
    const generateMetadata = vi.fn(
      async (_config: Config, candidate: MemoryMetadataMigrationCandidate) => {
        callCount += 1;
        if (callCount === 2) {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        return metadata(candidate);
      },
    );

    await expect(
      runMemoryMetadataMigration({
        config: {} as Config,
        projectRoot,
        root: memoryRoot,
        scope: 'project',
        generateMetadata,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      fs.readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf-8'),
    ).resolves.toContain('Migrated memory');
  });
});
