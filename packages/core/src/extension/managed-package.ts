/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseToml } from '@iarna/toml';
import * as tar from 'tar';
import {
  parseMarkdownCommand,
  MarkdownCommandDefSchema,
} from '../utils/markdown-command.js';
import { parseSkillContent } from '../skills/skill-load.js';
import { qualifySkillName } from '../skills/types.js';
import { resolveBuiltinToolName } from '../tools/tool-names.js';
import {
  convertClaudeToQwenConfig,
  type ClaudePluginConfig,
} from './claude-converter.js';
import { convertGeminiToQwenConfig } from './gemini-converter.js';
import {
  cloneFromGit,
  downloadFromArchiveUrl,
  downloadFromGitHubRelease,
  extractArchiveFile,
} from './github.js';
import { downloadFromNpmRegistry } from './npm.js';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_EXPANDED_BYTES,
} from './archive-safety.js';
import type { ExtensionInstallMetadata } from '../config/config.js';

export const MANAGED_PACKAGE_COMPILER_VERSION = 1;
export const MANAGED_PACKAGE_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export type ManagedPackageComponent =
  | 'skills'
  | 'commands'
  | 'agents'
  | 'context'
  | 'mcp'
  | 'hooks'
  | 'settings';
export interface ManagedPackageTarget {
  platform: 'linux' | 'darwin';
  arch: 'arm64' | 'x64' | 'any';
}
export interface ManagedPackageManifest {
  schemaVersion: 1;
  compilerVersion: 1;
  name: string;
  version: string;
  target: ManagedPackageTarget;
  components: ManagedPackageComponent[];
  sourceType?: string;
  sourceRevision?: string;
}
export interface ManagedPackageSkill {
  name: string;
  description: string;
  body: string;
  assetDirectory: string;
  model_invocable: boolean;
  user_invocable: boolean;
}
export interface ManagedPackageCommand {
  name: string;
  description: string;
  prompt: string;
  argumentHint?: string;
  modelInvocable: boolean;
}
export interface ManagedPackageAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
}
export interface ManagedPackageContributions {
  skills: ManagedPackageSkill[];
  commands: ManagedPackageCommand[];
  agents: ManagedPackageAgent[];
  context: Array<{ path: string; body: string }>;
  mcpServers: Record<string, unknown>;
  hooks: Record<string, unknown>;
  settings: Array<{ name: string; envVar: string; sensitive?: boolean }>;
}
export interface CompiledManagedPackage {
  manifest: ManagedPackageManifest;
  contributions: ManagedPackageContributions;
}
export class ManagedPackageCompatibilityError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Managed extension package is incompatible: ${reasons.join(', ')}`);
    this.name = 'ManagedPackageCompatibilityError';
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedPackageCompatibilityError([`${field}: invalid object`]);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxBytes = 512 * 1024): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > maxBytes
  )
    throw new ManagedPackageCompatibilityError([`${field}: invalid text`]);
  return value;
}

export function managedPackageRelativePath(value: string): string {
  const normalized = value.replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.includes(':') ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new ManagedPackageCompatibilityError([
      'package resource path escapes its root',
    ]);
  return normalized;
}

function frontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const parsed = parseMarkdownCommand(content);
  return { metadata: parsed.frontmatter ?? {}, body: parsed.prompt };
}

function hasValue(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    value !== '' &&
    (!Array.isArray(value) || value.length > 0) &&
    (typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > 0)
  );
}

function rejectFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  source: string,
): void {
  const reasons = fields
    .filter((key) => hasValue(value[key]))
    .map((key) => `${source}.${key}: unsupported`);
  if (reasons.length) throw new ManagedPackageCompatibilityError(reasons);
}

const PRIVATE_FILES = new Set([
  '.git',
  '.env',
  '.qwen-extension-settings.json',
  '.qwen-extension-git-credentials.json',
  '.qwen-extension-install.json',
]);

async function filesUnder(
  root: string,
  excludePrivate = false,
): Promise<string[]> {
  const files: string[] = [];
  let total = 0;
  const visit = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        excludePrivate &&
        (PRIVATE_FILES.has(entry.name) || entry.name.startsWith('.env.'))
      )
        continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      managedPackageRelativePath(name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new ManagedPackageCompatibilityError([
          `${name}: unsupported resource type`,
        ]);
      if (entry.isDirectory()) await visit(name);
      else {
        total += (await fs.lstat(path.join(root, name))).size;
        files.push(name);
        if (
          files.length > MAX_ARCHIVE_ENTRIES ||
          total > MAX_ARCHIVE_EXPANDED_BYTES
        )
          throw new ManagedPackageCompatibilityError([
            'package resource limit exceeded',
          ]);
      }
    }
  };
  await visit('');
  return files;
}

async function readText(root: string, relative: string): Promise<string> {
  const file = managedPackageRelativePath(relative);
  const info = await fs.lstat(path.join(root, file));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new ManagedPackageCompatibilityError([
      `${file}: invalid text resource`,
    ]);
  return new TextDecoder('utf-8', { fatal: true }).decode(
    await fs.readFile(path.join(root, file)),
  );
}

async function readObject(
  root: string,
  relative: string,
): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readText(root, relative)), relative);
}

async function rawConfig(
  root: string,
  files: readonly string[],
): Promise<Record<string, unknown>> {
  if (files.includes('qwen-extension.json'))
    return readObject(root, 'qwen-extension.json');
  if (files.includes('gemini-extension.json')) {
    const raw = await readObject(root, 'gemini-extension.json');
    rejectFields(
      raw,
      ['lspServers', 'channels', 'workflows', 'executor', 'outputStyles'],
      'gemini-extension.json',
    );
    return { ...raw, ...convertGeminiToQwenConfig(root) };
  }
  const pluginFile = files.includes('.claude-plugin/plugin.json')
    ? '.claude-plugin/plugin.json'
    : files.includes('.qoder-plugin/plugin.json')
      ? '.qoder-plugin/plugin.json'
      : undefined;
  if (pluginFile) {
    const raw = await readObject(root, pluginFile);
    rejectFields(
      raw,
      ['lspServers', 'channels', 'workflows', 'outputStyles', 'executor'],
      pluginFile,
    );
    const config: Record<string, unknown> = {
      ...convertClaudeToQwenConfig(raw as unknown as ClaudePluginConfig),
      name: raw['name'],
      version: raw['version'] ?? '1.0.0',
    };
    for (const key of [
      'commands',
      'skills',
      'agents',
      'contextFileName',
      'settings',
      'mcpServers',
      'hooks',
    ])
      if (raw[key] !== undefined) config[key] = raw[key];
    return config;
  }
  if (files.includes('plugin.json')) {
    const raw = await readObject(root, 'plugin.json');
    if (
      raw['$schema'] !==
      'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    )
      throw new ManagedPackageCompatibilityError([
        'plugin.json: unsupported schema',
      ]);
    rejectFields(
      raw,
      ['lspServers', 'channels', 'workflows', 'executor', 'outputStyles'],
      'plugin.json',
    );
    return { ...raw, name: raw['name'], version: raw['version'] ?? '1.0.0' };
  }
  throw new ManagedPackageCompatibilityError(['extension manifest missing']);
}

function resourceRoots(
  config: Record<string, unknown>,
  key: string,
  fallback: string,
): string[] {
  const value = config[key] ?? fallback;
  const roots = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(roots) || roots.some((item) => typeof item !== 'string'))
    throw new ManagedPackageCompatibilityError([
      `${key}: invalid resource roots`,
    ]);
  return (roots as string[]).map(managedPackageRelativePath);
}

function selectedFiles(
  files: readonly string[],
  roots: readonly string[],
): string[] {
  return files.filter((file) =>
    roots.some((root) => file === root || file.startsWith(`${root}/`)),
  );
}

function strings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  const entries =
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : value;
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== 'string' || !entry)
  )
    throw new ManagedPackageCompatibilityError([`${field}: invalid list`]);
  return (entries as string[]).map(
    (entry) => resolveBuiltinToolName(entry) ?? entry,
  );
}

export async function compileManagedExtensionPackage(
  root: string,
  options: {
    target: ManagedPackageTarget;
    workspaceDirectory?: string;
    environment?: Readonly<Record<string, string>>;
    resolveRecipes?: boolean;
  },
): Promise<CompiledManagedPackage> {
  const files = await filesUnder(root);
  if (
    files.some((file) =>
      file
        .split('/')
        .some((part) => PRIVATE_FILES.has(part) || part.startsWith('.env.')),
    )
  )
    throw new ManagedPackageCompatibilityError([
      'package contains private settings or credentials',
    ]);
  const config = await rawConfig(root, files);
  let packageTarget = options.target;
  if (config['managedTarget'] !== undefined) {
    const target = object(config['managedTarget'], 'managedTarget');
    if (
      target['platform'] !== options.target.platform ||
      (target['arch'] !== 'any' && target['arch'] !== options.target.arch)
    ) {
      throw new ManagedPackageCompatibilityError([
        'package target does not match this Runtime',
      ]);
    }
    packageTarget = {
      platform: options.target.platform,
      arch: target['arch'] as ManagedPackageTarget['arch'],
    };
  }
  rejectFields(
    config,
    ['lspServers', 'channels', 'workflows', 'executor', 'outputStyles'],
    'manifest',
  );
  if (files.some((file) => /^(?:workflows|channels|lsp)\//.test(file)))
    throw new ManagedPackageCompatibilityError([
      'package contains unsupported executable components',
    ]);
  const name = text(config['name'], 'name', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
    throw new ManagedPackageCompatibilityError(['name: invalid identity']);
  const contributions: ManagedPackageContributions = {
    skills: [],
    commands: [],
    agents: [],
    context: [],
    mcpServers: {},
    hooks: {},
    settings: [],
  };
  for (const file of selectedFiles(
    files,
    resourceRoots(config, 'skills', 'skills'),
  ).filter((file) => file.endsWith('/SKILL.md'))) {
    const content = await readText(root, file);
    const { metadata } = frontmatter(content);
    rejectFields(
      metadata,
      [
        'allowedTools',
        'allowed-tools',
        'hooks',
        'paths',
        'arguments',
        'args-file',
      ],
      file,
    );
    if (metadata['model'] !== undefined && metadata['model'] !== 'inherit')
      throw new ManagedPackageCompatibilityError([
        `${file}.model: unsupported`,
      ]);
    const skill = parseSkillContent(content, file);
    contributions.skills.push({
      name: qualifySkillName(name, skill.name),
      description: skill.description,
      body: skill.body,
      assetDirectory: path.posix.dirname(file),
      model_invocable: skill.disableModelInvocation !== true,
      user_invocable: skill.userInvocable !== false,
    });
  }
  const commandRoots = resourceRoots(config, 'commands', 'commands');
  for (const file of selectedFiles(files, commandRoots).filter((file) =>
    /\.(?:md|toml)$/.test(file),
  )) {
    const content = await readText(root, file);
    const parsed = file.endsWith('.toml')
      ? { metadata: {}, body: '', definition: object(parseToml(content), file) }
      : { ...frontmatter(content), definition: undefined };
    if (!parsed.definition)
      MarkdownCommandDefSchema.parse({
        frontmatter: parsed.metadata,
        prompt: parsed.body,
      });
    const metadata = parsed.definition ?? parsed.metadata;
    rejectFields(
      metadata,
      ['allowed-tools', 'allowedTools', 'hooks', 'model', 'context', 'agent'],
      file,
    );
    const relative = commandRoots.find((entry) => file.startsWith(`${entry}/`));
    const authored = (
      relative ? file.slice(relative.length + 1) : path.posix.basename(file)
    )
      .replace(/\.(?:md|toml)$/, '')
      .split('/')
      .map((part) => part.replaceAll(':', '_'))
      .join(':');
    contributions.commands.push({
      name: `${name}:${authored}`,
      description:
        typeof metadata['description'] === 'string'
          ? metadata['description']
          : authored,
      prompt: text(parsed.definition?.['prompt'] ?? parsed.body, file),
      ...(typeof metadata['argument-hint'] === 'string'
        ? { argumentHint: metadata['argument-hint'] }
        : {}),
      modelInvocable:
        metadata['disable-model-invocation'] !== true &&
        metadata['disable-model-invocation'] !== 'true',
    });
  }
  for (const file of selectedFiles(
    files,
    resourceRoots(config, 'agents', 'agents'),
  ).filter((file) => file.endsWith('.md'))) {
    const { metadata, body } = frontmatter(await readText(root, file));
    rejectFields(
      metadata,
      [
        'mcpServers',
        'mcp_servers',
        'hooks',
        'executor',
        'container',
        'isolation',
        'skills',
        'permissionMode',
        'approvalMode',
        'background',
        'memory',
      ],
      file,
    );
    const agent: ManagedPackageAgent = {
      name: `${name}:${text(metadata['name'] ?? path.posix.basename(file, '.md'), file, 128)}`,
      description: text(metadata['description'], `${file}.description`, 4096),
      systemPrompt: text(body, file),
      ...(metadata['tools'] !== undefined
        ? { tools: strings(metadata['tools'], file) }
        : {}),
      ...(metadata['disallowedTools'] !== undefined
        ? { disallowedTools: strings(metadata['disallowedTools'], file) }
        : {}),
      ...(metadata['model'] !== undefined
        ? { model: text(metadata['model'], `${file}.model`, 512) }
        : {}),
    };
    contributions.agents.push(agent);
  }
  const contextRoots =
    config['contextFileName'] === undefined
      ? files.includes('QWEN.md')
        ? ['QWEN.md']
        : files.includes('system-prompt.md')
          ? ['system-prompt.md']
          : []
      : resourceRoots(config, 'contextFileName', 'QWEN.md');
  for (const file of contextRoots)
    contributions.context.push({
      path: file,
      body: await readText(root, file),
    });
  let mcp = config['mcpServers'];
  if (typeof mcp === 'string')
    mcp = await readObject(root, managedPackageRelativePath(mcp));
  if (mcp === undefined && files.includes('.mcp.json')) {
    const loaded = await readObject(root, '.mcp.json');
    mcp = loaded['mcpServers'] ?? loaded;
  }
  if (mcp === undefined && files.includes('mcp.json')) {
    const loaded = await readObject(root, 'mcp.json');
    mcp = loaded['mcpServers'] ?? loaded['servers'] ?? loaded;
  }
  if (mcp !== undefined) contributions.mcpServers = object(mcp, 'mcpServers');
  let hooks = config['hooks'];
  if (typeof hooks === 'string')
    hooks = await readObject(root, managedPackageRelativePath(hooks));
  if (hooks === undefined && files.includes('hooks/hooks.json'))
    hooks = await readObject(root, 'hooks/hooks.json');
  if (hooks !== undefined) {
    const loaded = object(hooks, 'hooks');
    contributions.hooks = object(loaded['hooks'] ?? loaded, 'hooks');
  }
  if (config['settings'] !== undefined) {
    if (!Array.isArray(config['settings']))
      throw new ManagedPackageCompatibilityError(['settings: invalid list']);
    contributions.settings = config['settings'].map((entry: unknown) => {
      const setting = object(entry, 'setting');
      const envVar = text(setting['envVar'], 'setting.envVar', 128);
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar) ||
        envVar.startsWith('QWEN_MANAGED_') ||
        [
          'QWEN_EXTENSION_ROOT',
          'CLAUDE_PLUGIN_ROOT',
          'extensionPath',
          'workspacePath',
        ].includes(envVar)
      )
        throw new ManagedPackageCompatibilityError([
          'setting.envVar: reserved or invalid',
        ]);
      return {
        name: text(setting['name'], 'setting.name', 512),
        envVar,
        sensitive: setting['sensitive'] === true,
      };
    });
  }
  if (options.resolveRecipes !== false) {
    const environment: Readonly<Record<string, string>> = {
      ...options.environment,
      extensionPath: root,
      CLAUDE_PLUGIN_ROOT: root,
      QWEN_EXTENSION_ROOT: root,
      workspacePath: options.workspaceDirectory ?? '',
      workspaceFolder: options.workspaceDirectory ?? '',
      pathSeparator: '/',
      '/': '/',
    };
    const hydrate = (value: unknown): unknown => {
      if (typeof value === 'string')
        return value.replace(/\$\{([^}]+)\}/g, (_, variable: string) => {
          if (!Object.hasOwn(environment, variable))
            throw new ManagedPackageCompatibilityError([
              `setting ${variable}: required`,
            ]);
          return environment[variable];
        });
      if (Array.isArray(value)) return value.map(hydrate);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, hydrate(item)]),
        );
      return value;
    };
    contributions.mcpServers = hydrate(contributions.mcpServers) as Record<
      string,
      unknown
    >;
    contributions.hooks = hydrate(contributions.hooks) as Record<
      string,
      unknown
    >;
  }
  for (const entries of [
    contributions.skills,
    contributions.commands,
    contributions.agents,
  ]) {
    if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
      throw new ManagedPackageCompatibilityError([
        'duplicate component identity',
      ]);
  }
  if (
    contributions.skills.length > 256 ||
    Object.keys(contributions.mcpServers).length > 16
  )
    throw new ManagedPackageCompatibilityError([
      'component catalog limit exceeded',
    ]);
  const components: ManagedPackageComponent[] = [];
  if (contributions.skills.length) components.push('skills');
  if (contributions.commands.length) components.push('commands');
  if (contributions.agents.length) components.push('agents');
  if (contributions.context.length) components.push('context');
  if (Object.keys(contributions.mcpServers).length) components.push('mcp');
  if (Object.keys(contributions.hooks).length) components.push('hooks');
  if (contributions.settings.length) components.push('settings');
  return {
    manifest: {
      schemaVersion: 1,
      compilerVersion: MANAGED_PACKAGE_COMPILER_VERSION,
      name,
      version: text(config['version'] ?? '1.0.0', 'version', 128),
      target: packageTarget,
      components,
      ...(config['managedSource']
        ? {
            sourceType: text(
              object(config['managedSource'], 'managedSource')['type'],
              'sourceType',
              64,
            ),
            sourceRevision: text(
              object(config['managedSource'], 'managedSource')['revision'],
              'sourceRevision',
              256,
            ),
          }
        : {}),
    },
    contributions,
  };
}

export async function prepareManagedExtensionPackage(
  source: ExtensionInstallMetadata,
  options: {
    target: ManagedPackageTarget;
    destination: string;
    signal?: AbortSignal;
  },
): Promise<{
  archivePath: string;
  packageDigest: string;
  manifest: ManagedPackageManifest;
  sourceRevision: string;
}> {
  if (['local', 'link', 'snapshot'].includes(source.type)) {
    const isDirectory = (await fs.stat(source.source)).isDirectory();
    const installed =
      isDirectory &&
      (await fs
        .lstat(path.join(source.source, '.qwen-extension-install.json'))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        }));
    if (installed)
      throw new ManagedPackageCompatibilityError([
        'installed package requires its original source',
      ]);
  }
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-package-'),
  );
  const root = path.join(temporary, 'package');
  await fs.mkdir(root);
  let sourceRevision = source.ref ?? '';
  try {
    if (source.type === 'git')
      sourceRevision = await cloneFromGit(source, root, options.signal);
    else if (source.type === 'npm') {
      const result = await downloadFromNpmRegistry(
        { ...source },
        root,
        options.signal,
        { enforceResourceLimits: true },
      );
      sourceRevision = result.version;
    } else if (source.type === 'github-release') {
      const result = await downloadFromGitHubRelease(
        source,
        root,
        options.signal,
        options.target,
        { enforceResourceLimits: true },
      );
      sourceRevision = result.tagName;
    } else if (source.type === 'archive-url')
      await downloadFromArchiveUrl(source, root, options.signal, {
        enforceResourceLimits: true,
      });
    else if (/\.(?:zip|tar\.gz)$/i.test(source.source))
      await extractArchiveFile(source.source, root, options.signal, {
        enforceResourceLimits: true,
      });
    else {
      const files = await filesUnder(source.source, true);
      for (const file of files) {
        const destination = path.join(root, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(source.source, file), destination);
      }
    }
    options.signal?.throwIfAborted();
    const scrub = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const file = path.join(directory, entry.name);
        if (PRIVATE_FILES.has(entry.name) || entry.name.startsWith('.env.')) {
          await fs.rm(file, { recursive: true, force: true });
        } else if (entry.isDirectory()) await scrub(file);
      }
    };
    await scrub(root);
    let files = await filesUnder(root);
    const config = await rawConfig(root, files);
    config['managedTarget'] = options.target;
    config['managedSource'] = {
      type:
        source.type === 'local'
          ? /\.(?:zip|tar\.gz)$/i.test(source.source)
            ? 'archive'
            : 'directory'
          : source.type,
      revision:
        sourceRevision || text(config['version'] ?? 'snapshot', 'version', 128),
    };
    await fs.writeFile(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify(config),
    );
    files = await filesUnder(root);
    const compiled = await compileManagedExtensionPackage(root, {
      target: options.target,
      resolveRecipes: false,
    });
    await fs.mkdir(options.destination, { recursive: true });
    const archivePath = path.join(options.destination, 'package.tar.gz');
    await tar.create(
      {
        cwd: root,
        file: archivePath,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      files.sort(),
    );
    if ((await fs.stat(archivePath)).size > MANAGED_PACKAGE_MAX_ARCHIVE_BYTES)
      throw new ManagedPackageCompatibilityError([
        'compressed package limit exceeded',
      ]);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
    const packageDigest = hash.digest('hex');
    return {
      archivePath,
      packageDigest,
      manifest: compiled.manifest,
      sourceRevision: sourceRevision || packageDigest,
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
