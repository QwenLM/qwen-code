/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import * as archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parseManagedMcpRecipe } from './managed-mcp-recipe.js';
import {
  prepareManagedPackageImport,
  inspectManagedPackageArchive,
  parseManagedPackageImportMetadata,
} from './managed-package-import.js';

const target = { platform: 'linux', arch: 'x64' } as const;
let temporary: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-import-test-'));
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});
async function input(
  bytes: string | Buffer,
  sourceKind: 'skill' | 'extension' | 'mcp',
) {
  const file = path.join(temporary, 'input');
  await fs.writeFile(file, bytes);
  return {
    file,
    metadata: {
      sourceKind,
      target,
      sourceDigest: createHash('sha256').update(bytes).digest('hex'),
      compilerVersion: 1 as const,
    },
  };
}

describe('Managed package import', () => {
  it('rejects hidden additional Skills inside an independent Skill archive', async () => {
    const root = path.join(temporary, 'source');
    await fs.mkdir(path.join(root, 'assets/other'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'SKILL.md'),
      '---\nname: first\ndescription: first\n---\nFirst',
    );
    await fs.writeFile(
      path.join(root, 'assets/other/SKILL.md'),
      '---\nname: second\ndescription: second\n---\nSecond',
    );
    const archive = path.join(temporary, 'source.tar.gz');
    await tar.create({ file: archive, cwd: root, gzip: true }, [
      'SKILL.md',
      'assets',
    ]);
    const source = await input(await fs.readFile(archive), 'skill');
    await expect(
      prepareManagedPackageImport(source.file, source.metadata, {
        destination: path.join(temporary, 'output'),
      }),
    ).rejects.toThrow('exactly one SKILL.md');
  });
  it('accepts a standalone Skill ZIP with a single enclosing directory', async () => {
    const zip = path.join(temporary, 'skill.zip');
    const archive = archiver.create('zip');
    const writing = pipeline(archive, createWriteStream(zip));
    archive.append(
      '---\nname: inspect\ndescription: inspect ZIP\n---\nRead assets.',
      { name: 'download/SKILL.md' },
    );
    archive.append('#!/bin/sh\necho inspect', {
      name: 'download/scripts/run.sh',
      mode: 0o755,
    });
    await archive.finalize();
    await writing;
    const source = await input(await fs.readFile(zip), 'skill');
    const result = await prepareManagedPackageImport(
      source.file,
      source.metadata,
      { destination: path.join(temporary, 'output') },
    );
    expect(result.inspection.skills[0].name).toBe('inspect:inspect');
    expect(result.inspection.files).toContain('skills/inspect/scripts/run.sh');
  });
  it('wraps an MCP document deterministically without resolving its credentials', async () => {
    const source = await input(
      JSON.stringify({
        name: 'example',
        serverName: 'tools',
        recipe: {
          httpUrl: '${MCP_URL}',
          headers: {
            Authorization: 'Bearer ${TOKEN}',
            'X-Auth-Token': '${TOKEN}',
          },
        },
        settings: [
          { name: 'Token', envVar: 'TOKEN', sensitive: true },
          { name: 'URL', envVar: 'MCP_URL' },
        ],
      }),
      'mcp',
    );
    const prepare = (name: string) =>
      prepareManagedPackageImport(source.file, source.metadata, {
        destination: path.join(temporary, name),
      });
    const first = await prepare('one');
    const second = await prepare('two');
    expect(first.packageDigest).toBe(second.packageDigest);
    expect(first.manifest).toMatchObject({
      name: 'example',
      sourceType: 'snapshot',
      sourceRevision: source.metadata.sourceDigest,
    });
    expect(first.inspection.mcpServers).toEqual([
      {
        name: 'tools',
        redacted: false,
        recipe: {
          httpUrl: '${MCP_URL}',
          headers: {
            Authorization: 'Bearer ${TOKEN}',
            'X-Auth-Token': '${TOKEN}',
          },
        },
      },
    ]);
    expect(first.inspection.settings[0]).toEqual({
      name: 'Token',
      envVar: 'TOKEN',
      sensitive: true,
    });
    const expanded = path.join(temporary, 'expanded-mcp');
    await fs.mkdir(expanded);
    await tar.x({ file: first.archivePath, cwd: expanded });
    const authored = await fs.readFile(
      path.join(expanded, 'qwen-extension.json'),
      'utf8',
    );
    expect(authored).toContain('${TOKEN}');
    expect(authored).not.toContain('fixture-private-token');
  });

  it('accepts declared placeholders embedded in an MCP address', async () => {
    const source = await input(
      JSON.stringify({
        name: 'example',
        serverName: 'tools',
        recipe: { httpUrl: 'https://mcp.example.test/${TENANT}/mcp' },
        settings: [{ name: 'Tenant', envVar: 'TENANT' }],
      }),
      'mcp',
    );
    const result = await prepareManagedPackageImport(
      source.file,
      source.metadata,
      { destination: path.join(temporary, 'output') },
    );
    expect(result.inspection.mcpServers[0]?.recipe.httpUrl).toBe(
      'https://mcp.example.test/${TENANT}/mcp',
    );
  });

  it.each([
    {
      recipe: {
        httpUrl: 'https://mcp.example.test',
        headers: { 'X-Auth-Token': 'fixture-private-token' },
      },
      settings: [],
    },
    {
      recipe: {
        httpUrl: 'https://mcp.example.test',
        headers: { 'X-Auth-Token': 'fixture-private-token' },
      },
      settings: [{ name: 'TOKEN', envVar: 'TOKEN', sensitive: true }],
    },
    {
      recipe: {
        command: 'node',
        env: { CUSTOM_TOKEN: 'fixture-private-token' },
      },
      settings: [],
    },
    {
      recipe: {
        httpUrl: 'https://mcp.example.test',
        headers: { 'X-Auth-Token': '${UNDECLARED}' },
      },
      settings: [],
    },
    {
      recipe: {
        httpUrl: 'https://alice:s3cret@mcp.example.test/${TENANT}',
      },
      settings: [{ name: 'Tenant', envVar: 'TENANT' }],
    },
    {
      recipe: {
        httpUrl: 'https://mcp.example.test/${UNDECLARED}',
      },
      settings: [],
    },
  ])(
    'refuses literal or undeclared MCP credential values before publication: $recipe',
    async ({ recipe, settings }) => {
      const source = await input(
        JSON.stringify({
          name: 'example',
          serverName: 'tools',
          recipe,
          settings,
        }),
        'mcp',
      );
      const destination = path.join(temporary, 'rejected-output');
      await expect(
        prepareManagedPackageImport(source.file, source.metadata, {
          destination,
        }),
      ).rejects.toThrow('declared settings placeholders');
      await expect(fs.stat(destination)).rejects.toThrow();
    },
  );

  it.each([false, true])(
    'preserves a standalone Skill directory and its executable assets (wrapped=%s)',
    async (wrapped) => {
      const root = path.join(temporary, 'source');
      const skill = wrapped ? path.join(root, 'download') : root;
      await fs.mkdir(path.join(skill, 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(skill, 'SKILL.md'),
        '---\nname: inspect\ndescription: inspect files\n---\nRun scripts/check.sh.',
      );
      await fs.writeFile(
        path.join(skill, 'scripts/check.sh'),
        '#!/bin/sh\necho checked\n',
        { mode: 0o755 },
      );
      const archive = path.join(temporary, 'source.tar.gz');
      await tar.create(
        { file: archive, cwd: root, gzip: true },
        wrapped ? ['download'] : ['SKILL.md', 'scripts'],
      );
      const source = await input(await fs.readFile(archive), 'skill');
      const result = await prepareManagedPackageImport(
        source.file,
        source.metadata,
        { destination: path.join(temporary, 'output') },
      );
      expect(result.inspection.skills).toEqual([
        { name: 'inspect:inspect', description: 'inspect files' },
      ]);
      expect(result.inspection.files).toContain(
        'skills/inspect/scripts/check.sh',
      );
      const restored = path.join(temporary, 'restored');
      await fs.mkdir(restored);
      await tar.x({ file: result.archivePath, cwd: restored });
      expect(
        (await fs.stat(path.join(restored, 'skills/inspect/scripts/check.sh')))
          .mode & 0o777,
      ).toBe(0o755);
    },
  );

  it('rejects unsupported Skill frontmatter and links before publication', async () => {
    const root = path.join(temporary, 'source');
    await fs.mkdir(root);
    await fs.writeFile(
      path.join(root, 'SKILL.md'),
      '---\nname: inspect\ndescription: inspect\nallowed-tools: Read\n---\nBody',
    );
    const archive = path.join(temporary, 'source.tar.gz');
    await tar.create({ file: archive, cwd: root, gzip: true }, ['SKILL.md']);
    const source = await input(await fs.readFile(archive), 'skill');
    await expect(
      prepareManagedPackageImport(source.file, source.metadata, {
        destination: path.join(temporary, 'output'),
      }),
    ).rejects.toThrow('unsupported');
    await fs.symlink('/etc/passwd', path.join(root, 'escape'));
    await tar.create({ file: archive, cwd: root, gzip: true }, [
      'SKILL.md',
      'escape',
    ]);
    const linked = await input(await fs.readFile(archive), 'skill');
    await expect(
      prepareManagedPackageImport(linked.file, linked.metadata, {
        destination: path.join(temporary, 'linked'),
      }),
    ).rejects.toThrow();
  });

  it('rejects changed source bytes and unknown import metadata', async () => {
    const source = await input('{}', 'mcp');
    await fs.writeFile(source.file, '{"changed":true}');
    await expect(
      prepareManagedPackageImport(source.file, source.metadata, {
        destination: path.join(temporary, 'output'),
      }),
    ).rejects.toThrow('digest');
    expect(() =>
      parseManagedPackageImportMetadata({
        ...source.metadata,
        source: '/etc/passwd',
      }),
    ).toThrow('unknown');
  });
});

describe('Managed MCP recipe validation', () => {
  it('accepts placeholders only before Runtime hydration', () => {
    expect(
      parseManagedMcpRecipe({ url: '${URL}' }, { allowPlaceholders: true }),
    ).toEqual({ url: '${URL}' });
    expect(() => parseManagedMcpRecipe({ url: '${URL}' })).toThrow();
  });

  it.each([
    { command: 'node', url: 'https://example.test/mcp' },
    { command: 'node', args: [1] },
    { url: 'file:///etc/passwd' },
    { url: 'https://user:password@example.test/mcp' },
    {
      url: 'https://example.test/mcp',
      headers: { X: 'value\r\nInjected: true' },
    },
    { command: 'node', timeout: 600_001 },
    { command: 'node', executor: 'shell' },
  ])('rejects invalid transport input %#', (recipe) => {
    expect(() => parseManagedMcpRecipe(recipe)).toThrow(
      'Invalid Managed MCP recipe',
    );
  });
});

it('redacts literal env/header values when inspecting an existing archive', async () => {
  const root = path.join(temporary, 'legacy');
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, 'qwen-extension.json'),
    JSON.stringify({
      name: 'legacy',
      version: '1',
      mcpServers: {
        tools: {
          httpUrl: 'https://mcp.example/mcp',
          headers: { 'X-Auth-Token': 'fixture-private-token' },
        },
      },
    }),
  );
  const archive = path.join(temporary, 'legacy.tar.gz');
  await tar.c({ gzip: true, cwd: root, file: archive }, [
    'qwen-extension.json',
  ]);
  const source = await input(await fs.readFile(archive), 'extension');
  const inspection = await inspectManagedPackageArchive(
    source.file,
    source.metadata,
  );
  expect(inspection.mcpServers[0]).toMatchObject({
    redacted: true,
    recipe: { headers: { 'X-Auth-Token': '[redacted]' } },
  });
  expect(JSON.stringify(inspection)).not.toContain('fixture-private-token');
});
