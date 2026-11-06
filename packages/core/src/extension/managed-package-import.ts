/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractArchiveFile, extractFile } from './github.js';
import { parseSkillContent } from '../skills/skill-load.js';
import {
  compileManagedExtensionPackage,
  listManagedPackageFiles,
  MANAGED_PACKAGE_COMPILER_VERSION,
  MANAGED_PACKAGE_MAX_ARCHIVE_BYTES,
  ManagedPackageCompatibilityError,
  prepareManagedExtensionPackage,
  type ManagedPackageManifest,
  type ManagedPackageTarget,
} from './managed-package.js';
import {
  parseManagedMcpRecipe,
  type ManagedMcpRecipe,
} from './managed-mcp-recipe.js';

export interface ManagedPackageImportMetadata {
  sourceKind: 'skill' | 'extension' | 'mcp';
  target: ManagedPackageTarget;
  sourceDigest: string;
  compilerVersion: 1 | 2;
  packageName?: string;
}

export interface ManagedPackageInspection {
  manifest: ManagedPackageManifest;
  fileCount: number;
  files: string[];
  truncated: boolean;
  skills: Array<{ name: string; description: string }>;
  mcpServers: Array<{
    name: string;
    recipe: ManagedMcpRecipe;
    redacted: boolean;
  }>;
  settings: Array<{ name: string; envVar: string; sensitive?: boolean }>;
}

const identity = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const invalid = (reason: string): never => {
  throw new ManagedPackageCompatibilityError([reason]);
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('invalid import object');
  return value as Record<string, unknown>;
}

export function parseManagedPackageImportMetadata(
  value: unknown,
): ManagedPackageImportMetadata {
  const input = object(value);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'sourceKind',
          'target',
          'sourceDigest',
          'compilerVersion',
          'packageName',
        ].includes(key),
    )
  )
    invalid('unknown import field');
  const target = object(input['target']);
  if (
    Object.keys(target).sort().join(',') !== 'arch,platform' ||
    !['linux', 'darwin'].includes(String(target['platform'])) ||
    !['x64', 'arm64', 'any'].includes(String(target['arch'])) ||
    !['skill', 'extension', 'mcp'].includes(String(input['sourceKind'])) ||
    ![MANAGED_PACKAGE_COMPILER_VERSION, 2].includes(
      input['compilerVersion'] as number,
    ) ||
    typeof input['sourceDigest'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input['sourceDigest']) ||
    (input['packageName'] !== undefined &&
      (typeof input['packageName'] !== 'string' ||
        !identity.test(input['packageName'])))
  ) {
    invalid('invalid import metadata');
  }
  return structuredClone(input) as unknown as ManagedPackageImportMetadata;
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function archiveCopy(file: string, directory: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  const prefix = Buffer.alloc(4);
  try {
    await handle.read(prefix, 0, prefix.length, 0);
  } finally {
    await handle.close();
  }
  const extension =
    prefix[0] === 0x1f && prefix[1] === 0x8b
      ? '.tar.gz'
      : prefix[0] === 0x50 && prefix[1] === 0x4b
        ? '.zip'
        : invalid('unsupported archive format');
  const archive = path.join(directory, `source${extension}`);
  await fs.copyFile(file, archive);
  return archive;
}

async function inspectDirectory(
  root: string,
  target: ManagedPackageTarget,
): Promise<ManagedPackageInspection> {
  const compiled = await compileManagedExtensionPackage(root, {
    target,
    resolveRecipes: false,
  });
  const files = await listManagedPackageFiles(root);
  const { contributions } = compiled;
  const inspection: ManagedPackageInspection = {
    manifest: compiled.manifest,
    fileCount: files.length,
    files: files.slice(0, 256),
    truncated: files.length > 256,
    skills: contributions.skills.map(({ name, description }) => ({
      name,
      description,
    })),
    mcpServers: Object.entries(contributions.mcpServers).map(
      ([name, value]) => {
        const recipe = parseManagedMcpRecipe(value, {
          allowPlaceholders: true,
        });
        let redacted = false;
        for (const field of ['env', 'headers'] as const) {
          const entries = recipe[field];
          if (entries)
            recipe[field] = Object.fromEntries(
              Object.entries(entries).map(([key, item]) => {
                if (/^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(item))
                  return [key, item];
                redacted = true;
                return [key, '[redacted]'];
              }),
            );
        }
        return { name, recipe, redacted };
      },
    ),
    settings: contributions.settings,
  };
  if (Buffer.byteLength(JSON.stringify(inspection)) > 2 * 1024 * 1024)
    invalid('package inspection exceeds its size limit');
  return inspection;
}

export async function inspectManagedPackageArchive(
  file: string,
  metadata: ManagedPackageImportMetadata,
  signal?: AbortSignal,
): Promise<ManagedPackageInspection> {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-inspect-'),
  );
  try {
    if (
      (await fs.stat(file)).size > MANAGED_PACKAGE_MAX_ARCHIVE_BYTES ||
      (await digest(file)) !== metadata.sourceDigest
    ) {
      invalid('source digest or size mismatch');
    }
    const archive = await archiveCopy(file, temporary);
    const root = path.join(temporary, 'package');
    await fs.mkdir(root);
    await extractArchiveFile(archive, root, signal, {
      enforceResourceLimits: true,
    });
    return await inspectDirectory(root, metadata.target);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function prepareManagedPackageImport(
  file: string,
  metadata: ManagedPackageImportMetadata,
  options: { destination: string; signal?: AbortSignal },
): Promise<{
  archivePath: string;
  packageDigest: string;
  manifest: ManagedPackageManifest;
  inspection: ManagedPackageInspection;
  byteLength: number;
}> {
  parseManagedPackageImportMetadata(metadata);
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-import-'),
  );
  try {
    const stat = await fs.stat(file);
    if (
      !stat.isFile() ||
      stat.size > MANAGED_PACKAGE_MAX_ARCHIVE_BYTES ||
      (await digest(file)) !== metadata.sourceDigest
    )
      invalid('source digest or size mismatch');
    const root = path.join(temporary, 'package');
    await fs.mkdir(root);
    let source = root;
    if (metadata.sourceKind === 'mcp') {
      if (stat.size > 64 * 1024) invalid('MCP input is too large');
      const input = object(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await fs.readFile(file),
          ),
        ),
      );
      if (
        Object.keys(input).some(
          (key) => !['name', 'serverName', 'recipe', 'settings'].includes(key),
        ) ||
        typeof input['name'] !== 'string' ||
        !identity.test(input['name']) ||
        typeof input['serverName'] !== 'string' ||
        !identity.test(input['serverName'])
      )
        invalid('invalid MCP document');
      const recipe = parseManagedMcpRecipe(input['recipe'], {
        allowPlaceholders: true,
      });
      await fs.writeFile(
        path.join(root, 'qwen-extension.json'),
        JSON.stringify({
          name: metadata.packageName ?? input['name'],
          version: '1.0.0',
          mcpServers: { [input['serverName'] as string]: recipe },
          ...(input['settings'] === undefined
            ? {}
            : { settings: input['settings'] }),
        }),
        { mode: 0o644 },
      );
    } else {
      const archive = await archiveCopy(file, temporary);
      if (metadata.sourceKind === 'extension') {
        await extractArchiveFile(archive, root, options.signal, {
          enforceResourceLimits: true,
        });
      } else {
        await extractFile(archive, root, options.signal, {
          enforceResourceLimits: true,
        });
        const entries = await fs.readdir(root, { withFileTypes: true });
        if (
          !entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())
        ) {
          if (entries.length !== 1 || !entries[0].isDirectory())
            invalid('Skill archive must contain one SKILL.md root');
          source = path.join(root, entries[0].name);
        }
        const skillFiles = await listManagedPackageFiles(source);
        if (
          skillFiles.filter(
            (file) => file === 'SKILL.md' || file.endsWith('/SKILL.md'),
          ).length !== 1
        )
          invalid(
            'Standalone Skill archives must contain exactly one SKILL.md',
          );
        const skillFile = path.join(source, 'SKILL.md');
        if ((await fs.stat(skillFile)).size > 1024 * 1024)
          invalid('Skill manifest exceeds its size limit');
        const skill = parseSkillContent(
          await fs.readFile(skillFile, 'utf8'),
          skillFile,
        );
        const wrapper = path.join(temporary, 'wrapper');
        await fs.mkdir(path.join(wrapper, 'skills'), { recursive: true });
        await fs.rename(source, path.join(wrapper, 'skills', skill.name));
        await fs.writeFile(
          path.join(wrapper, 'qwen-extension.json'),
          JSON.stringify({
            name: metadata.packageName ?? skill.name,
            version: '1.0.0',
          }),
          { mode: 0o644 },
        );
        source = wrapper;
      }
    }
    const prepared = await prepareManagedExtensionPackage(
      {
        type: 'snapshot',
        source,
        ref: metadata.sourceDigest,
      },
      {
        target: metadata.target,
        destination: options.destination,
        signal: options.signal,
      },
    );
    const inspection = await inspectManagedPackageArchive(
      prepared.archivePath,
      {
        ...metadata,
        sourceKind: 'extension',
        sourceDigest: prepared.packageDigest,
      },
      options.signal,
    );
    if (prepared.manifest.compilerVersion > metadata.compilerVersion)
      invalid('compiler version does not match package requirements');
    return {
      ...prepared,
      inspection,
      byteLength: (await fs.stat(prepared.archivePath)).size,
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
