import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { SkillManager, Storage, type Config } from '@qwen-code/qwen-code-core';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

export type WorkspaceSkillScope = 'workspace' | 'global';

export type WorkspaceSkillInstallSource =
  | { type: 'github'; url: string }
  | { type: 'folder'; path: string }
  | { type: 'zip'; contentBase64: string };

export interface WorkspaceSkillInstallRequest {
  name: string;
  scope: WorkspaceSkillScope;
  source: WorkspaceSkillInstallSource;
}

export interface WorkspaceSkillMutationResult {
  skillName: string;
  scope: WorkspaceSkillScope;
  installedPath?: string;
  deleted?: boolean;
}

interface SkillPackageFile {
  relativePath: string;
  content: Buffer;
}

const MAX_FILES = 128;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_DEPTH = 16;
export const MAX_WORKSPACE_SKILL_NAME_LENGTH = 100;
const execFileAsync = promisify(execFile);

export class WorkspaceSkillManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'WorkspaceSkillManagementError';
  }
}

function skillError(code: string, message: string, statusCode = 400): never {
  throw new WorkspaceSkillManagementError(code, message, statusCode);
}

export function validateWorkspaceSkillName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.length > MAX_WORKSPACE_SKILL_NAME_LENGTH ||
    !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) {
    skillError('invalid_skill_name', 'Invalid skill name');
  }
  return normalized;
}

function decodeBase64(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    skillError('invalid_skill_source', 'Invalid base64 skill content');
  }
  const content = Buffer.from(value, 'base64');
  if (content.length > MAX_TOTAL_BYTES) {
    skillError(
      'skill_package_too_large',
      'Skill package exceeds the allowed size',
      413,
    );
  }
  return content;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.length > MAX_PATH_LENGTH ||
    normalized.startsWith('/') ||
    segments.length > MAX_PATH_DEPTH ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    skillError('invalid_skill_package', `Invalid skill file path: ${value}`);
  }
  return segments.join('/');
}

function isPlatformMetadataPath(value: string): boolean {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .some(
      (segment) =>
        segment === '__MACOSX' ||
        segment === '.DS_Store' ||
        segment.startsWith('._'),
    );
}

function normalizePackageFiles(files: SkillPackageFile[]): SkillPackageFile[] {
  files = files.filter((file) => !isPlatformMetadataPath(file.relativePath));
  if (!files.length || files.length > MAX_FILES) {
    skillError(
      'invalid_skill_package',
      'Skill package has an invalid file count',
    );
  }
  let normalized = files.map((file) => ({
    relativePath: normalizeRelativePath(file.relativePath),
    content: file.content,
  }));
  if (!normalized.some((file) => file.relativePath === 'SKILL.md')) {
    const roots = new Set(
      normalized.map((file) => file.relativePath.split('/')[0]),
    );
    if (roots.size !== 1) {
      skillError(
        'skill_manifest_missing',
        'Skill package must contain a root SKILL.md',
      );
    }
    const [root] = roots;
    normalized = normalized.map((file) => ({
      ...file,
      relativePath: file.relativePath.slice(root.length + 1),
    }));
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of normalized) {
    file.relativePath = normalizeRelativePath(file.relativePath);
    if (seen.has(file.relativePath)) {
      skillError(
        'invalid_skill_package',
        `Duplicate skill file path: ${file.relativePath}`,
      );
    }
    seen.add(file.relativePath);
    if (file.content.length > MAX_FILE_BYTES) {
      skillError(
        'skill_package_too_large',
        `Skill file is too large: ${file.relativePath}`,
        413,
      );
    }
    totalBytes += file.content.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      skillError(
        'skill_package_too_large',
        'Skill package exceeds the allowed size',
        413,
      );
    }
  }
  if (!seen.has('SKILL.md')) {
    skillError(
      'skill_manifest_missing',
      'Skill package must contain a root SKILL.md',
    );
  }
  return normalized;
}

function githubRequestError(
  code: 'github_api_failed' | 'github_skill_download_failed',
  status: number,
  resource: 'Skill path' | 'Skill file',
): WorkspaceSkillManagementError {
  const message =
    status === 404
      ? `GitHub ${resource} was not found; check the repository URL, branch, and path`
      : status === 401
        ? 'GitHub authentication failed; check GH_TOKEN or GITHUB_TOKEN'
        : status === 403
          ? 'GitHub access was denied; the repository may be private or API rate-limited'
          : status === 429
            ? 'GitHub API rate limit exceeded; try again later or configure GH_TOKEN'
            : `GitHub request failed (HTTP ${status})`;
  return new WorkspaceSkillManagementError(
    code,
    message,
    status === 404 ? 404 : 502,
  );
}

async function fetchBytes(url: string, githubToken?: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qwen-code',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });
  if (!response.ok) {
    throw githubRequestError(
      'github_skill_download_failed',
      response.status,
      'Skill file',
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    skillError('skill_package_too_large', 'Skill file is too large', 413);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => undefined);
        skillError('skill_package_too_large', 'Skill file is too large', 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function downloadGitHubDirectory(
  owner: string,
  repo: string,
  ref: string,
  directory: string,
  githubToken?: string,
  relativeRoot = '',
  depth = 0,
  files: SkillPackageFile[] = [],
): Promise<SkillPackageFile[]> {
  if (depth > MAX_PATH_DEPTH)
    skillError('invalid_skill_package', 'GitHub Skill is nested too deeply');
  const encodedDirectory = directory
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedDirectory ? `/${encodedDirectory}` : ''}?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qwen-code',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });
  if (!response.ok) {
    throw githubRequestError(
      'github_api_failed',
      response.status,
      'Skill path',
    );
  }
  const items = (await response.json()) as unknown;
  if (!Array.isArray(items))
    skillError('invalid_skill_source', 'GitHub URL must point to SKILL.md');
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const itemName = typeof record['name'] === 'string' ? record['name'] : '';
    const itemPath = typeof record['path'] === 'string' ? record['path'] : '';
    const itemType = typeof record['type'] === 'string' ? record['type'] : '';
    const relativePath = relativeRoot
      ? `${relativeRoot}/${itemName}`
      : itemName;
    if (itemType === 'dir') {
      await downloadGitHubDirectory(
        owner,
        repo,
        ref,
        itemPath,
        githubToken,
        relativePath,
        depth + 1,
        files,
      );
    } else if (itemType === 'file') {
      const downloadUrl = record['download_url'];
      if (typeof downloadUrl !== 'string') continue;
      const parsedDownloadUrl = new URL(downloadUrl);
      if (
        parsedDownloadUrl.protocol !== 'https:' ||
        parsedDownloadUrl.hostname !== 'raw.githubusercontent.com'
      ) {
        skillError(
          'github_skill_download_failed',
          'GitHub returned an invalid Skill file URL',
          502,
        );
      }
      files.push({
        relativePath,
        content: await fetchBytes(downloadUrl, githubToken),
      });
      if (files.length > MAX_FILES)
        skillError('invalid_skill_package', 'Skill package has too many files');
      if (
        files.reduce((total, file) => total + file.content.length, 0) >
        MAX_TOTAL_BYTES
      ) {
        skillError(
          'skill_package_too_large',
          'Skill package exceeds the allowed size',
          413,
        );
      }
    }
  }
  return files;
}

async function downloadGitHubDirectoryWithGit(
  owner: string,
  repo: string,
  ref: string,
  directory: string,
): Promise<SkillPackageFile[]> {
  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-git-'));
  try {
    await execFileAsync(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--filter=blob:none',
        '--sparse',
        '--branch',
        ref,
        `https://github.com/${owner}/${repo}.git`,
        checkout,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    if (directory) {
      await execFileAsync(
        'git',
        ['-C', checkout, 'sparse-checkout', 'set', '--cone', directory],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
    } else {
      await execFileAsync(
        'git',
        ['-C', checkout, 'sparse-checkout', 'disable'],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
    }
    return await filesFromFolder(path.join(checkout, directory));
  } catch (error) {
    if (error instanceof WorkspaceSkillManagementError) throw error;
    throw new WorkspaceSkillManagementError(
      'github_skill_download_failed',
      `Failed to download GitHub Skill: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  } finally {
    await fs.rm(checkout, { recursive: true, force: true });
  }
}

async function downloadGitHubSkill(
  sourceUrl: string,
  githubToken?: string,
): Promise<SkillPackageFile[]> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    skillError('invalid_skill_source', 'Invalid GitHub Skill URL');
  }
  if (url.protocol !== 'https:')
    skillError('invalid_skill_source', 'GitHub URL must use HTTPS');
  if (url.hostname === 'raw.githubusercontent.com') {
    if (!url.pathname.endsWith('/SKILL.md')) {
      skillError('invalid_skill_source', 'GitHub URL must point to SKILL.md');
    }
    return [
      {
        relativePath: 'SKILL.md',
        content: await fetchBytes(url.toString(), githubToken),
      },
    ];
  }
  if (url.hostname !== 'github.com') {
    skillError('invalid_skill_source', 'Only GitHub Skill URLs are supported');
  }
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    skillError('invalid_skill_source', 'Invalid GitHub Skill URL');
  }
  if (
    segments.length < 5 ||
    segments[2] !== 'blob' ||
    segments.at(-1) !== 'SKILL.md'
  ) {
    skillError(
      'invalid_skill_source',
      'GitHub URL must point to a repository SKILL.md file',
    );
  }
  const [owner, repo, , ref, ...filePath] = segments;
  if (
    !owner ||
    !repo ||
    !ref ||
    ref.startsWith('-') ||
    !/^[A-Za-z0-9._-]+$/.test(owner) ||
    !/^[A-Za-z0-9._-]+$/.test(repo)
  ) {
    skillError('invalid_skill_source', 'Invalid GitHub Skill URL');
  }
  const directory = filePath.slice(0, -1).join('/');
  try {
    return await downloadGitHubDirectory(
      owner,
      repo,
      ref,
      directory,
      githubToken,
    );
  } catch (error) {
    if (
      !(error instanceof WorkspaceSkillManagementError) ||
      error.code !== 'github_api_failed' ||
      error.statusCode === 404
    ) {
      throw error;
    }
    return downloadGitHubDirectoryWithGit(owner, repo, ref, directory);
  }
}

function openZip(content: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(content, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    });
  });
}

function readZipEntry(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) {
          stream.destroy(
            new WorkspaceSkillManagementError(
              'skill_package_too_large',
              `Skill ZIP entry is too large: ${entry.fileName}`,
              413,
            ),
          );
        } else {
          chunks.push(chunk);
        }
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function filesFromZip(content: Buffer): Promise<SkillPackageFile[]> {
  const zipFile = await openZip(content);
  const files: SkillPackageFile[] = [];
  let totalBytes = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      if (error) reject(error);
      else resolve(files);
    };
    zipFile.on('error', finish);
    zipFile.on('entry', (entry: Entry) => {
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const fileType = mode & 0xf000;
      if (fileType === 0xa000) {
        finish(new Error('Skill ZIP contains a symbolic link'));
        return;
      }
      if (entry.generalPurposeBitFlag & 1) {
        finish(new Error('Encrypted Skill ZIP entries are not supported'));
        return;
      }
      if (entry.fileName.endsWith('/') || fileType === 0x4000) {
        zipFile.readEntry();
        return;
      }
      if (files.length >= MAX_FILES) {
        finish(
          new WorkspaceSkillManagementError(
            'invalid_skill_package',
            'Skill ZIP contains too many files',
          ),
        );
        return;
      }
      if (entry.uncompressedSize > MAX_FILE_BYTES) {
        finish(
          new WorkspaceSkillManagementError(
            'skill_package_too_large',
            'Skill ZIP entry exceeds the allowed size',
            413,
          ),
        );
        return;
      }
      if (totalBytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
        finish(
          new WorkspaceSkillManagementError(
            'skill_package_too_large',
            'Skill ZIP expands beyond the allowed size',
            413,
          ),
        );
        return;
      }
      void readZipEntry(zipFile, entry).then((entryContent) => {
        totalBytes += entryContent.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          finish(
            new WorkspaceSkillManagementError(
              'skill_package_too_large',
              'Skill ZIP expands beyond the allowed size',
              413,
            ),
          );
          return;
        }
        files.push({ relativePath: entry.fileName, content: entryContent });
        if (!settled) zipFile.readEntry();
      }, finish);
    });
    zipFile.on('end', () => finish());
    zipFile.readEntry();
  });
}

async function filesFromSource(
  source: WorkspaceSkillInstallSource,
  githubToken?: string,
): Promise<SkillPackageFile[]> {
  try {
    if (source.type === 'github')
      return normalizePackageFiles(
        await downloadGitHubSkill(source.url, githubToken),
      );
    if (source.type === 'folder')
      return normalizePackageFiles(await filesFromFolder(source.path));
    const archive = decodeBase64(source.contentBase64);
    return normalizePackageFiles(await filesFromZip(archive));
  } catch (error) {
    if (error instanceof WorkspaceSkillManagementError) throw error;
    const code =
      source.type === 'github'
        ? 'github_skill_download_failed'
        : source.type === 'folder'
          ? 'invalid_skill_folder'
          : 'invalid_skill_package';
    throw new WorkspaceSkillManagementError(
      code,
      error instanceof Error ? error.message : String(error),
      source.type === 'github' ? 502 : 400,
    );
  }
}

async function filesFromFolder(
  folderPath: string,
): Promise<SkillPackageFile[]> {
  if (!path.isAbsolute(folderPath)) {
    skillError('invalid_skill_folder', 'Skill folder path must be absolute');
  }
  if ((await fs.lstat(folderPath)).isSymbolicLink()) {
    skillError(
      'invalid_skill_folder',
      'Skill folder path must not be a symbolic link',
    );
  }
  const root = await fs.realpath(folderPath);
  if (!(await fs.stat(root)).isDirectory()) {
    skillError(
      'invalid_skill_folder',
      'Skill folder path must point to a directory',
    );
  }
  const files: SkillPackageFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeRoot = '', depth = 0) => {
    if (depth > MAX_PATH_DEPTH)
      skillError('invalid_skill_package', 'Skill folder is nested too deeply');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (depth === 0 && entry.name === '.git') continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeRoot
        ? `${relativeRoot}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        skillError(
          'unsafe_skill_path',
          'Skill folder contains a symbolic link',
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile())
        skillError('unsafe_skill_path', 'Skill folder contains a special file');
      if (files.length >= MAX_FILES) {
        skillError('invalid_skill_package', 'Skill package has too many files');
      }
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        skillError('unsafe_skill_path', 'Skill folder contains an unsafe file');
      }
      if (stats.size > MAX_FILE_BYTES) {
        skillError(
          'skill_package_too_large',
          `Skill file is too large: ${relativePath}`,
          413,
        );
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        skillError(
          'skill_package_too_large',
          'Skill package exceeds the allowed size',
          413,
        );
      }
      const content = await fs.readFile(absolutePath);
      if (content.length !== stats.size) {
        skillError(
          'invalid_skill_package',
          `Skill file changed while reading: ${relativePath}`,
        );
      }
      files.push({ relativePath, content });
    }
  };
  await visit(root);
  return files;
}

function skillBaseDir(workspace: string, scope: WorkspaceSkillScope): string {
  return scope === 'workspace'
    ? path.join(workspace, '.qwen', 'skills')
    : path.join(Storage.getGlobalQwenDir(), 'skills');
}

async function ensureDirectoryWithoutSymlinks(
  directory: string,
): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        skillError('unsafe_skill_path', `Unsafe Skill directory: ${current}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const entry of missing.reverse()) await fs.mkdir(entry);
}

export async function installWorkspaceSkill(
  workspace: string,
  request: WorkspaceSkillInstallRequest,
  githubToken?: string,
): Promise<WorkspaceSkillMutationResult> {
  const skillName = validateWorkspaceSkillName(request.name);
  const files = await filesFromSource(request.source, githubToken);
  const baseDir = skillBaseDir(workspace, request.scope);
  await ensureDirectoryWithoutSymlinks(baseDir);
  const destination = path.join(baseDir, skillName);
  const existing = await fs.lstat(destination).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    skillError('unsafe_skill_path', 'Refusing to replace an unsafe Skill path');
  }
  const staging = await fs.mkdtemp(
    path.join(baseDir, `.${skillName}.installing-`),
  );
  const backup = path.join(baseDir, `.${skillName}.backup-${Date.now()}`);
  let movedExisting = false;
  try {
    for (const file of files) {
      const target = path.join(staging, ...file.relativePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content);
    }
    const skillFile = path.join(staging, 'SKILL.md');
    let parsed: ReturnType<SkillManager['parseSkillContent']>;
    try {
      parsed = new SkillManager({} as Config).parseSkillContent(
        await fs.readFile(skillFile, 'utf8'),
        skillFile,
        request.scope === 'workspace' ? 'project' : 'user',
      );
    } catch (error) {
      throw new WorkspaceSkillManagementError(
        'invalid_skill_manifest',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (parsed.name !== skillName) {
      skillError(
        'skill_name_mismatch',
        `Skill name "${parsed.name}" does not match requested name "${skillName}"`,
      );
    }
    if (existing) {
      await fs.rename(destination, backup);
      movedExisting = true;
    }
    await fs.rename(staging, destination);
  } catch (error) {
    await fs
      .rm(staging, { recursive: true, force: true })
      .catch(() => undefined);
    if (movedExisting) {
      await fs.rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
  if (movedExisting) {
    await fs
      .rm(backup, { recursive: true, force: true })
      .catch(() => undefined);
  }
  return {
    skillName,
    scope: request.scope,
    installedPath: path.join(destination, 'SKILL.md'),
  };
}

export async function deleteWorkspaceSkill(
  workspace: string,
  scope: WorkspaceSkillScope,
  skillNameInput: string,
  installedPath: string,
): Promise<WorkspaceSkillMutationResult> {
  const skillName = validateWorkspaceSkillName(skillNameInput);
  const skillDir = path.resolve(path.dirname(installedPath));
  const skillFile = path.resolve(installedPath);
  const allowedBaseDirs = new SkillManager({
    getProjectRoot: () => workspace,
  } as Config)
    .getSkillsBaseDirs(scope === 'workspace' ? 'project' : 'user')
    .map((directory) => path.resolve(directory));
  const baseDir = path.dirname(skillDir);
  if (
    skillFile !== path.join(skillDir, 'SKILL.md') ||
    !allowedBaseDirs.includes(baseDir) ||
    path.basename(skillDir) !== skillName
  ) {
    skillError(
      'skill_not_managed',
      'Skill is not managed in the requested scope',
      409,
    );
  }
  const baseRealPath = await fs.realpath(baseDir);
  const skillDirStats = await fs.lstat(skillDir);
  const skillFileStats = await fs.lstat(skillFile);
  if (
    skillDirStats.isSymbolicLink() ||
    !skillDirStats.isDirectory() ||
    skillFileStats.isSymbolicLink() ||
    !skillFileStats.isFile()
  ) {
    skillError('unsafe_skill_path', 'Refusing to delete an unsafe Skill path');
  }
  const skillDirRealPath = await fs.realpath(skillDir);
  if (path.dirname(skillDirRealPath) !== baseRealPath) {
    skillError('unsafe_skill_path', 'Refusing to delete an unsafe Skill path');
  }
  const parsed = new SkillManager({} as Config).parseSkillContent(
    await fs.readFile(skillFile, 'utf8'),
    skillFile,
    scope === 'workspace' ? 'project' : 'user',
  );
  if (parsed.name !== skillName) {
    skillError(
      'skill_name_mismatch',
      'Skill name does not match its installed directory',
    );
  }
  await fs.rm(skillDir, { recursive: true, force: true });
  return { skillName, scope, deleted: true };
}
