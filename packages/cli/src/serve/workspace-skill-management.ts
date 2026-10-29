import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { Config } from '@qwen-code/qwen-code-core';
import { SkillManager } from '@qwen-code/qwen-code-core/skills/skill-manager.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { sanitizeChildEnv } from '@qwen-code/qwen-code-core/utils/sanitize-child-env.js';
import {
  fromBuffer,
  open as openZipFile,
  type Entry,
  type ZipFile,
} from 'yauzl';

export type WorkspaceSkillScope = 'workspace' | 'global';

export type WorkspaceSkillInstallSource =
  | { type: 'github'; url: string }
  | { type: 'folder'; path: string }
  | { type: 'zip'; contentBase64: string }
  | { type: 'prepared-zip'; path: string };

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

export interface WorkspaceSkillInstallOptions {
  signal?: AbortSignal;
  beforePublish?: () => void;
  onCommitted?: (result: WorkspaceSkillMutationResult) => void;
}

// Largest raw ZIP that fits in the 10 MiB JSON body:
// 3 * floor((10 * 1024 * 1024 - 330) / 4).
export const MAX_ZIP_ARCHIVE_BYTES = 7_864_071;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 2000;
export const MAX_SKILL_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_ARCHIVE_EXPANDED_BYTES = 200 * 1024 * 1024;
export const MAX_SKILL_ARCHIVE_ENTRIES = 4096;
export const MAX_SKILL_ARCHIVE_MANIFEST_BYTES = 32 * 1024 * 1024;
const LEGACY_ZIP_LIMITS = {
  fileBytes: MAX_FILE_BYTES,
  packageBytes: MAX_PACKAGE_BYTES,
  files: MAX_FILES,
};
const FILE_ZIP_LIMITS = {
  fileBytes: MAX_SKILL_ARCHIVE_EXPANDED_BYTES,
  packageBytes: MAX_SKILL_ARCHIVE_EXPANDED_BYTES,
  files: MAX_SKILL_ARCHIVE_ENTRIES,
};
const MAX_PATH_LENGTH = 512;
const MAX_PATH_DEPTH = 16;
// GitHub returns at most 1000 entries per Contents API listing and silently
// truncates larger directories, so a page-sized listing is re-read via git.
const GITHUB_CONTENTS_PAGE_LIMIT = 1000;
const PACKAGE_TOO_MANY = 'Skill package has too many files (max 2000)';
const ZIP_TOO_MANY = 'Skill ZIP contains too many files (max 2000)';
export const MAX_WORKSPACE_SKILL_NAME_LENGTH = 256;
const execFileAsync = promisify(execFile);

// Live staging and backup directories owned by in-flight installs. The orphan
// sweep in removeInstallArtifacts must reclaim crashed runs without deleting a
// concurrent install that has not committed yet.
const liveInstallArtifacts = new Set<string>();

function artifactToken(): string {
  return `${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

// Artifact names embed the owning pid so a second daemon can reclaim a crashed
// run without deleting a live peer's staging directory.
function artifactOwnerIsLive(suffix: string): boolean {
  const match = /^(\d+)-/.exec(suffix);
  if (!match) return false;
  const pid = Number(match[1]);
  if (pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface PackageState {
  count: number;
  totalBytes: number;
  paths: Set<string>;
}

interface StagedFile {
  normalized: string;
  target: string;
}

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

export class WorkspaceSkillRecoveryError extends WorkspaceSkillManagementError {
  constructor(
    readonly retainedPaths: string[],
    cause: unknown,
  ) {
    super(
      'skill_install_recovery_required',
      'Skill installation could not restore the previous state; recovery materials were retained',
      500,
    );
    this.cause = cause;
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

function rejectInstallArtifactSkillName(name: string): void {
  if (
    /^\..*\.(backup|installing)-[A-Za-z0-9-]+$/.test(name) ||
    /\.(backup|installing)-\d+-\d+$/.test(name)
  ) {
    skillError(
      'invalid_skill_name',
      'Skill name ends with a reserved install-artifact suffix',
    );
  }
}

function assertBase64Shape(value: string): void {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    skillError('invalid_skill_source', 'Invalid base64 skill content');
  }
}

function decodeBase64(value: string): Buffer {
  assertBase64Shape(value);
  const content = Buffer.from(value, 'base64');
  if (content.length > MAX_ZIP_ARCHIVE_BYTES) {
    skillError(
      'skill_package_too_large',
      'Skill ZIP exceeds the allowed archive size',
      413,
    );
  }
  return content;
}

const STAGING_DISK_ERRNOS = new Set([
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'EACCES',
  'EPERM',
]);

// Errnos a read cannot produce, so a copyFile failure carrying one of these
// is the destination write.
const COPY_STAGING_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EROFS']);

// Node reports both `path` (source) and `dest` (target) for every copyFile
// failure, so a permission error is the staging write only while the source
// is still readable.
const COPY_AMBIGUOUS_ERRNOS = new Set(['EACCES', 'EPERM']);

function stagingWriteError(
  error: unknown,
): WorkspaceSkillManagementError | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error instanceof WorkspaceSkillManagementError) return undefined;
  if (error.name === 'WorkspaceGenerationClosedError') return undefined;
  const { code } = error as NodeJS.ErrnoException;
  if (!code || !STAGING_DISK_ERRNOS.has(code)) return undefined;
  return new WorkspaceSkillManagementError(
    'skill_staging_failed',
    error.message,
    500,
  );
}

async function stageWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw stagingWriteError(error) ?? error;
  }
}

async function copyIntoStaging(source: string, target: string): Promise<void> {
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code) throw error;
    if (COPY_STAGING_ERRNOS.has(code)) {
      throw stagingWriteError(error) ?? error;
    }
    if (COPY_AMBIGUOUS_ERRNOS.has(code)) {
      const sourceReadable = await fs.access(source, fs.constants.R_OK).then(
        () => true,
        () => false,
      );
      if (sourceReadable) throw stagingWriteError(error) ?? error;
    }
    throw error;
  }
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

function pathIsTakenAsFileOrDirectory(
  normalized: string,
  paths: Set<string>,
): boolean {
  const segments = normalized.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    if (paths.has(segments.slice(0, i).join('/'))) return true;
  }
  return [...paths].some((existing) => existing.startsWith(`${normalized}/`));
}

function beginStagedFile(
  staging: string,
  relativePath: string,
  state: PackageState,
  tooManyMessage: string,
  maxFiles = MAX_FILES,
): StagedFile | undefined {
  if (isPlatformMetadataPath(relativePath)) return undefined;
  const normalized = normalizeRelativePath(relativePath);
  if (state.paths.has(normalized)) {
    skillError(
      'invalid_skill_package',
      `Duplicate skill file path: ${normalized}`,
    );
  }
  if (pathIsTakenAsFileOrDirectory(normalized, state.paths)) {
    skillError(
      'invalid_skill_package',
      `Skill package has conflicting file and directory entries: ${normalized}`,
    );
  }
  if (state.count >= maxFiles) {
    skillError('skill_too_many_files', tooManyMessage);
  }
  return {
    normalized,
    target: path.join(staging, ...normalized.split('/')),
  };
}

function commitStagedFile(
  normalized: string,
  bytes: number,
  state: PackageState,
): void {
  state.paths.add(normalized);
  state.count += 1;
  state.totalBytes += bytes;
}

async function prepareTarget(
  target: string,
  assertGenerationOpen?: () => void,
): Promise<void> {
  assertGenerationOpen?.();
  await stageWrite(() => fs.mkdir(path.dirname(target), { recursive: true }));
  assertGenerationOpen?.();
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

function githubHeaders(githubToken?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'qwen-code',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };
}

async function writeGitHubFile(
  url: string,
  staged: StagedFile,
  state: PackageState,
  githubToken: string | undefined,
  assertGenerationOpen?: () => void,
): Promise<void> {
  const response = await fetch(url, { headers: githubHeaders(githubToken) });
  if (!response.ok) {
    throw githubRequestError(
      'github_skill_download_failed',
      response.status,
      'Skill file',
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    skillError('skill_package_too_large', 'Skill file is too large', 413);
  }
  if (
    Number.isFinite(declared) &&
    state.totalBytes + declared > MAX_PACKAGE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    skillError(
      'skill_package_too_large',
      'Skill package exceeds the allowed size',
      413,
    );
  }
  if (!response.body) {
    await prepareTarget(staged.target, assertGenerationOpen);
    await stageWrite(() => fs.writeFile(staged.target, ''));
    commitStagedFile(staged.normalized, 0, state);
    return;
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    await prepareTarget(staged.target, assertGenerationOpen);
    handle = await stageWrite(() => fs.open(staged.target, 'w'));
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (
        size > MAX_FILE_BYTES ||
        state.totalBytes + size > MAX_PACKAGE_BYTES
      ) {
        await reader.cancel().catch(() => undefined);
        skillError(
          'skill_package_too_large',
          size > MAX_FILE_BYTES
            ? 'Skill file is too large'
            : 'Skill package exceeds the allowed size',
          413,
        );
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await stageWrite(() =>
          handle.write(value.subarray(offset)),
        );
        if (result.bytesWritten <= 0) {
          throw new Error('Failed to write Skill file');
        }
        offset += result.bytesWritten;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await stageWrite(() => handle.close());
  }
  commitStagedFile(staged.normalized, size, state);
}

async function downloadGitHubDirectory(
  owner: string,
  repo: string,
  ref: string,
  directory: string,
  staging: string,
  state: PackageState,
  githubToken?: string,
  assertGenerationOpen?: () => void,
  relativeRoot = '',
  depth = 0,
): Promise<void> {
  if (depth > MAX_PATH_DEPTH)
    skillError('invalid_skill_package', 'GitHub Skill is nested too deeply');
  const encodedDirectory = directory
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedDirectory ? `/${encodedDirectory}` : ''}?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(apiUrl, { headers: githubHeaders(githubToken) });
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
  if (items.length >= GITHUB_CONTENTS_PAGE_LIMIT) {
    throw new WorkspaceSkillManagementError(
      'github_api_failed',
      'GitHub directory listing reached the API page limit; retrying with git',
      502,
    );
  }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const itemName = typeof record['name'] === 'string' ? record['name'] : '';
    const itemPath = typeof record['path'] === 'string' ? record['path'] : '';
    const itemType = typeof record['type'] === 'string' ? record['type'] : '';
    const relativePath = relativeRoot
      ? `${relativeRoot}/${itemName}`
      : itemName;
    if (isPlatformMetadataPath(relativePath)) continue;
    if (itemType === 'dir') {
      await downloadGitHubDirectory(
        owner,
        repo,
        ref,
        itemPath,
        staging,
        state,
        githubToken,
        assertGenerationOpen,
        relativePath,
        depth + 1,
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
      const staged = beginStagedFile(
        staging,
        relativePath,
        state,
        PACKAGE_TOO_MANY,
      );
      if (!staged) continue;
      await writeGitHubFile(
        downloadUrl,
        staged,
        state,
        githubToken,
        assertGenerationOpen,
      );
    }
  }
}

async function downloadGitHubDirectoryWithGit(
  owner: string,
  repo: string,
  ref: string,
  directory: string,
  staging: string,
  state: PackageState,
  assertGenerationOpen?: () => void,
): Promise<void> {
  assertGenerationOpen?.();
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
      {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { ...sanitizeChildEnv(), GIT_TERMINAL_PROMPT: '0' },
      },
    );
    if (directory) {
      await execFileAsync(
        'git',
        ['-C', checkout, 'sparse-checkout', 'set', '--cone', directory],
        {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { ...sanitizeChildEnv(), GIT_TERMINAL_PROMPT: '0' },
        },
      );
    } else {
      await execFileAsync(
        'git',
        ['-C', checkout, 'sparse-checkout', 'disable'],
        {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { ...sanitizeChildEnv(), GIT_TERMINAL_PROMPT: '0' },
        },
      );
    }
    assertGenerationOpen?.();
    await copyFolder(
      path.join(checkout, directory),
      staging,
      state,
      assertGenerationOpen,
    );
  } catch (error) {
    if (error instanceof WorkspaceSkillManagementError) throw error;
    if (
      error instanceof Error &&
      error.name === 'WorkspaceGenerationClosedError'
    ) {
      throw error;
    }
    throw new WorkspaceSkillManagementError(
      'github_skill_download_failed',
      `Failed to download GitHub Skill: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  } finally {
    await fs.rm(checkout, { recursive: true, force: true });
  }
}

type GitHubSkillPlan =
  | { kind: 'raw'; url: string }
  | {
      kind: 'tree';
      owner: string;
      repo: string;
      ref: string;
      directory: string;
    };

function resolveGitHubSkill(sourceUrl: string): GitHubSkillPlan {
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
    return { kind: 'raw', url: url.toString() };
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
    !/^[A-Za-z0-9._/+-]+$/.test(ref) ||
    !/^[A-Za-z0-9._-]+$/.test(owner) ||
    !/^[A-Za-z0-9._-]+$/.test(repo)
  ) {
    skillError('invalid_skill_source', 'Invalid GitHub Skill URL');
  }
  const directory = filePath.slice(0, -1).join('/');
  const directorySegments = directory.split('/');
  if (
    directory &&
    (directory.length > MAX_PATH_LENGTH ||
      directory.includes('\\') ||
      directory.startsWith('/') ||
      directorySegments.length > MAX_PATH_DEPTH ||
      directorySegments.some(
        (segment) => !segment || segment === '.' || segment === '..',
      ))
  ) {
    skillError('invalid_skill_source', 'Invalid GitHub Skill URL path');
  }
  return { kind: 'tree', owner, repo, ref, directory };
}

async function downloadGitHubSkill(
  sourceUrl: string,
  staging: string,
  state: PackageState,
  githubToken?: string,
  assertGenerationOpen?: () => void,
): Promise<void> {
  const plan = resolveGitHubSkill(sourceUrl);
  if (plan.kind === 'raw') {
    const staged = beginStagedFile(
      staging,
      'SKILL.md',
      state,
      PACKAGE_TOO_MANY,
    );
    if (!staged) {
      skillError(
        'invalid_skill_package',
        'Skill package has an invalid file count',
      );
    }
    await writeGitHubFile(
      plan.url,
      staged,
      state,
      githubToken,
      assertGenerationOpen,
    );
    return;
  }
  try {
    await downloadGitHubDirectory(
      plan.owner,
      plan.repo,
      plan.ref,
      plan.directory,
      staging,
      state,
      githubToken,
      assertGenerationOpen,
    );
  } catch (error) {
    if (
      !(error instanceof WorkspaceSkillManagementError) ||
      error.code !== 'github_api_failed' ||
      error.statusCode === 404
    ) {
      throw error;
    }
    for (const entry of await fs.readdir(staging)) {
      assertGenerationOpen?.();
      await fs.rm(path.join(staging, entry), { recursive: true, force: true });
    }
    state.count = 0;
    state.totalBytes = 0;
    state.paths.clear();
    await downloadGitHubDirectoryWithGit(
      plan.owner,
      plan.repo,
      plan.ref,
      plan.directory,
      staging,
      state,
      assertGenerationOpen,
    );
  }
}

function openZip(content: Buffer | string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, zipFile: ZipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    };
    if (typeof content === 'string') {
      openZipFile(content, { lazyEntries: true }, callback);
    } else {
      fromBuffer(content, { lazyEntries: true }, callback);
    }
  });
}

function openZipStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function writeZipEntry(
  zipFile: ZipFile,
  entry: Entry,
  target: string,
  totalBytes: number,
  limits: typeof LEGACY_ZIP_LIMITS,
  signal?: AbortSignal,
  exclusive = false,
): Promise<number> {
  const stream = await openZipStream(zipFile, entry);
  // An owned bridge keeps cancellation independent of yauzl's stream teardown.
  const source = new PassThrough();
  stream.on('error', (error) => source.destroy(error));
  stream.pipe(source);
  let size = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limits.fileBytes) {
        callback(
          new WorkspaceSkillManagementError(
            'skill_package_too_large',
            `Skill ZIP entry is too large: ${entry.fileName}`,
            413,
          ),
        );
        return;
      }
      if (totalBytes + size > limits.packageBytes) {
        callback(
          new WorkspaceSkillManagementError(
            'skill_package_too_large',
            'Skill ZIP expands beyond the allowed size',
            413,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await stageWrite(() =>
      pipeline(
        source,
        guard,
        createWriteStream(target, { flags: exclusive ? 'wx' : 'w' }),
        { signal },
      ),
    );
  } finally {
    stream.destroy();
    source.destroy();
  }
  return size;
}

async function filesFromZip(
  content: Buffer | string,
  staging: string,
  state: PackageState,
  assertGenerationOpen?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const nativeArchive = typeof content === 'string';
  const limits = nativeArchive ? FILE_ZIP_LIMITS : LEGACY_ZIP_LIMITS;
  signal?.throwIfAborted();
  const zipFile = await openZip(content);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let writing: Promise<void> | undefined;
    let entries = 0;
    const paths = new Map<string, boolean>();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      zipFile.close();
      // Closing the reader must not release the lock while a file write is live.
      void (writing ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          if (error) reject(error);
          else resolve();
        });
    };
    const onAbort = () => finish(signal?.reason);
    const writeEntry = async (entry: Entry) => {
      signal?.throwIfAborted();
      assertGenerationOpen?.();
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const fileType = mode & 0xf000;
      if (nativeArchive) {
        entries += 1;
        if (entries > MAX_SKILL_ARCHIVE_ENTRIES) {
          skillError(
            'skill_too_many_files',
            'Skill ZIP contains too many entries (max 4096)',
          );
        }
        const directory = entry.fileName.endsWith('/') || fileType === 0x4000;
        const normalized = normalizeRelativePath(
          entry.fileName.replace(/\/$/, ''),
        );
        if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
          skillError(
            'invalid_skill_package',
            'Skill ZIP contains a link or special file',
          );
        }
        if (
          paths.has(normalized) ||
          [...paths].some(
            ([existing, isDirectory]) =>
              (!isDirectory && normalized.startsWith(`${existing}/`)) ||
              (!directory && existing.startsWith(`${normalized}/`)),
          )
        ) {
          skillError(
            'invalid_skill_package',
            `Skill ZIP has conflicting paths: ${normalized}`,
          );
        }
        paths.set(normalized, directory);
      }
      if (fileType === 0xa000) {
        throw new Error('Skill ZIP contains a symbolic link');
      }
      if (entry.generalPurposeBitFlag & 1) {
        throw new Error('Encrypted Skill ZIP entries are not supported');
      }
      if (entry.fileName.endsWith('/') || fileType === 0x4000) return;
      const staged = beginStagedFile(
        staging,
        entry.fileName,
        state,
        ZIP_TOO_MANY,
        limits.files,
      );
      if (!staged) return;
      if (entry.uncompressedSize > limits.fileBytes) {
        skillError(
          'skill_package_too_large',
          'Skill ZIP entry exceeds the allowed size',
          413,
        );
      }
      if (state.totalBytes + entry.uncompressedSize > limits.packageBytes) {
        skillError(
          'skill_package_too_large',
          'Skill ZIP expands beyond the allowed size',
          413,
        );
      }
      await prepareTarget(staged.target, assertGenerationOpen);
      const written = await writeZipEntry(
        zipFile,
        entry,
        staged.target,
        state.totalBytes,
        limits,
        signal,
        nativeArchive,
      );
      commitStagedFile(staged.normalized, written, state);
    };
    zipFile.on('error', finish);
    zipFile.on('entry', (entry: Entry) => {
      if (settled) return;
      writing = writeEntry(entry);
      void writing.then(() => {
        if (!settled) zipFile.readEntry();
      }, finish);
    });
    zipFile.on('end', () => finish());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    zipFile.readEntry();
  });
}

async function validatedFolderRoot(folderPath: string): Promise<string> {
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
  return root;
}

async function copyFolder(
  folderPath: string,
  staging: string,
  state: PackageState,
  assertGenerationOpen?: () => void,
): Promise<void> {
  const root = await validatedFolderRoot(folderPath);
  const stagingReal = await fs.realpath(staging);
  const visit = async (directory: string, relativeRoot = '', depth = 0) => {
    if (depth > MAX_PATH_DEPTH)
      skillError('invalid_skill_package', 'Skill folder is nested too deeply');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (depth === 0 && entry.name === '.git') continue;
      const absolutePath = path.join(directory, entry.name);
      if (path.resolve(absolutePath) === stagingReal) continue;
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
        if (isPlatformMetadataPath(relativePath)) continue;
        await visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile())
        skillError('unsafe_skill_path', 'Skill folder contains a special file');
      if (isPlatformMetadataPath(relativePath)) continue;
      const staged = beginStagedFile(
        staging,
        relativePath,
        state,
        PACKAGE_TOO_MANY,
      );
      if (!staged) continue;
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        skillError('unsafe_skill_path', 'Skill folder contains an unsafe file');
      }
      if (stats.size > MAX_FILE_BYTES) {
        skillError(
          'skill_package_too_large',
          `Skill file is too large: ${staged.normalized}`,
          413,
        );
      }
      if (state.totalBytes + stats.size > MAX_PACKAGE_BYTES) {
        skillError(
          'skill_package_too_large',
          'Skill package exceeds the allowed size',
          413,
        );
      }
      await prepareTarget(staged.target, assertGenerationOpen);
      await copyIntoStaging(absolutePath, staged.target);
      const copied = await fs.lstat(staged.target);
      if (copied.size !== stats.size) {
        skillError(
          'invalid_skill_package',
          `Skill file changed while reading: ${staged.normalized}`,
        );
      }
      commitStagedFile(staged.normalized, copied.size, state);
    }
  };
  await visit(root);
}

async function assertStagedFilesPresent(
  staging: string,
  state: PackageState,
): Promise<void> {
  for (const filePath of state.paths) {
    const stats = await fs
      .lstat(path.join(staging, ...filePath.split('/')))
      .catch(() => undefined);
    if (!stats?.isFile()) {
      skillError(
        'skill_staging_failed',
        'Skill staging directory was modified during install',
        500,
      );
    }
  }
}

async function finalizeStagedPackage(
  staging: string,
  state: PackageState,
  assertGenerationOpen?: () => void,
): Promise<void> {
  if (state.paths.size === 0) {
    skillError(
      'invalid_skill_package',
      'Skill package has an invalid file count',
    );
  }
  await assertStagedFilesPresent(staging, state);
  if (state.paths.has('SKILL.md')) return;
  const roots = new Set(
    [...state.paths].map((filePath) => filePath.split('/')[0]),
  );
  if (roots.size !== 1) {
    skillError(
      'skill_manifest_missing',
      'Skill package must contain a root SKILL.md',
    );
  }
  const [root] = roots;
  if (!root) {
    skillError(
      'skill_manifest_missing',
      'Skill package must contain a root SKILL.md',
    );
  }
  const rootPath = path.join(staging, root);
  const rootStats = await fs.lstat(rootPath);
  if (!rootStats.isDirectory()) {
    skillError(
      'skill_manifest_missing',
      'Skill package must contain a root SKILL.md',
    );
  }
  const stripped = new Set<string>();
  for (const filePath of state.paths) {
    stripped.add(normalizeRelativePath(filePath.slice(root.length + 1)));
  }
  const children = await fs.readdir(rootPath);
  let holdingName = '.qwen-skill-strip';
  while (children.includes(holdingName)) holdingName = `${holdingName}-x`;
  const holding = path.join(staging, holdingName);
  assertGenerationOpen?.();
  await fs.rename(rootPath, holding);
  for (const child of children) {
    assertGenerationOpen?.();
    await fs.rename(path.join(holding, child), path.join(staging, child));
  }
  await fs.rmdir(holding);
  state.paths.clear();
  for (const filePath of stripped) state.paths.add(filePath);
  if (!state.paths.has('SKILL.md')) {
    skillError(
      'skill_manifest_missing',
      'Skill package must contain a root SKILL.md',
    );
  }
}

async function stageSkillSource(
  source: WorkspaceSkillInstallSource,
  staging: string,
  githubToken: string | undefined,
  assertGenerationOpen?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const state: PackageState = { count: 0, totalBytes: 0, paths: new Set() };
  try {
    if (source.type === 'github') {
      await downloadGitHubSkill(
        source.url,
        staging,
        state,
        githubToken,
        assertGenerationOpen,
      );
    } else if (source.type === 'folder') {
      await copyFolder(source.path, staging, state, assertGenerationOpen);
    } else {
      await filesFromZip(
        source.type === 'prepared-zip'
          ? source.path
          : decodeBase64(source.contentBase64),
        staging,
        state,
        assertGenerationOpen,
        signal,
      );
    }
    await finalizeStagedPackage(staging, state, assertGenerationOpen);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof WorkspaceSkillManagementError) throw error;
    if (
      error instanceof Error &&
      error.name === 'WorkspaceGenerationClosedError'
    ) {
      throw error;
    }
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

export function workspaceSkillBaseDir(
  workspace: string,
  scope: WorkspaceSkillScope,
): string {
  return scope === 'workspace'
    ? path.join(workspace, '.qwen', 'skills')
    : path.join(Storage.getGlobalQwenDir(), 'skills');
}

async function removeInstallArtifacts(
  baseDir: string,
  skillName: string,
  assertGenerationOpen?: () => void,
): Promise<void> {
  const workDir = path.dirname(baseDir);
  const workPrefix = `.${path.basename(baseDir)}-${skillName}`;
  const locations = [
    {
      directory: baseDir,
      prefixes: [`.${skillName}.installing-`],
    },
    {
      directory: workDir,
      prefixes: [`${workPrefix}.installing-`],
    },
  ];
  for (const { directory, prefixes } of locations) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => {
          if (liveInstallArtifacts.has(path.join(directory, entry.name))) {
            return false;
          }
          return prefixes.some((prefix) => {
            if (!entry.name.startsWith(prefix)) return false;
            const suffix = entry.name.slice(prefix.length);
            return (
              /^[A-Za-z0-9-]+$/.test(suffix) && !artifactOwnerIsLive(suffix)
            );
          });
        })
        .map(async (entry) => {
          assertGenerationOpen?.();
          await fs.rm(path.join(directory, entry.name), {
            recursive: true,
            force: true,
          });
        }),
    );
  }
}

async function ensureDirectoryWithoutSymlinks(
  directory: string,
  assertGenerationOpen?: () => void,
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
  for (const entry of missing.reverse()) {
    assertGenerationOpen?.();
    await fs.mkdir(entry);
  }
}

export async function installWorkspaceSkill(
  workspace: string,
  request: WorkspaceSkillInstallRequest,
  githubToken?: string,
  assertGenerationOpen?: () => void,
  options: WorkspaceSkillInstallOptions = {},
): Promise<WorkspaceSkillMutationResult> {
  options.signal?.throwIfAborted();
  assertGenerationOpen?.();
  const skillName = validateWorkspaceSkillName(request.name);
  rejectInstallArtifactSkillName(skillName);
  if (
    request.source.type === 'folder' &&
    !path.isAbsolute(request.source.path)
  ) {
    skillError('invalid_skill_folder', 'Skill folder path must be absolute');
  }
  if (request.source.type === 'github') resolveGitHubSkill(request.source.url);
  if (request.source.type === 'zip') {
    assertBase64Shape(request.source.contentBase64);
  }
  const baseDir = workspaceSkillBaseDir(workspace, request.scope);
  assertGenerationOpen?.();
  await ensureDirectoryWithoutSymlinks(baseDir, assertGenerationOpen);
  assertGenerationOpen?.();
  await removeInstallArtifacts(baseDir, skillName, assertGenerationOpen);
  const destination = path.join(baseDir, skillName);
  const existing = await fs.lstat(destination).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    skillError('unsafe_skill_path', 'Refusing to replace an unsafe Skill path');
  }
  const workDir = path.dirname(baseDir);
  const workPrefix = `.${path.basename(baseDir)}-${skillName}`;
  assertGenerationOpen?.();
  const staging = path.join(
    workDir,
    `${workPrefix}.installing-${artifactToken()}`,
  );
  liveInstallArtifacts.add(staging);
  try {
    await fs.mkdir(staging, { mode: 0o700 });
  } catch (error) {
    liveInstallArtifacts.delete(staging);
    throw error;
  }
  const backup = path.join(workDir, `${workPrefix}.backup-${artifactToken()}`);
  let movedExisting = false;
  let committedStaging = false;
  try {
    await stageSkillSource(
      request.source,
      staging,
      githubToken,
      assertGenerationOpen,
      options.signal,
    );
    const skillFile = path.join(staging, 'SKILL.md');
    options.signal?.throwIfAborted();
    if (
      request.source.type === 'prepared-zip' &&
      (await fs.stat(skillFile)).size > MAX_SKILL_ARCHIVE_MANIFEST_BYTES
    ) {
      skillError(
        'skill_package_too_large',
        'Root SKILL.md exceeds 32 MiB',
        413,
      );
    }
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
    options.signal?.throwIfAborted();
    assertGenerationOpen?.();
    options.beforePublish?.();
    if (existing) {
      assertGenerationOpen?.();
      liveInstallArtifacts.add(backup);
      await fs.rename(destination, backup);
      movedExisting = true;
    }
    assertGenerationOpen?.();
    await fs.rename(staging, destination);
    committedStaging = true;
    assertGenerationOpen?.();
  } catch (error) {
    let recoveryError: unknown;
    try {
      await fs.rm(committedStaging ? destination : staging, {
        recursive: true,
        force: true,
      });
    } catch (cleanupError) {
      if (committedStaging) recoveryError = cleanupError;
    }
    if (movedExisting) {
      try {
        await fs.rename(backup, destination);
        recoveryError = undefined;
      } catch (restoreError) {
        recoveryError = restoreError;
      }
    }
    if (recoveryError !== undefined) {
      throw new WorkspaceSkillRecoveryError(
        [destination, ...(movedExisting ? [backup] : []), staging],
        new AggregateError([error, recoveryError]),
      );
    }
    throw error;
  } finally {
    liveInstallArtifacts.delete(staging);
    liveInstallArtifacts.delete(backup);
  }
  const result = {
    skillName,
    scope: request.scope,
    installedPath: path.join(destination, 'SKILL.md'),
  };
  options.onCommitted?.(result);
  if (movedExisting) {
    await fs
      .rm(backup, { recursive: true, force: true })
      .catch(() => undefined);
  }
  return result;
}

export async function deleteWorkspaceSkill(
  workspace: string,
  scope: WorkspaceSkillScope,
  skillNameInput: string,
  installedPath: string,
  assertGenerationOpen?: () => void,
): Promise<WorkspaceSkillMutationResult> {
  assertGenerationOpen?.();
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
  assertGenerationOpen?.();
  await fs.rm(skillDir, { recursive: true, force: true });
  return { skillName, scope, deleted: true };
}
