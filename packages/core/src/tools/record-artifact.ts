/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { isNodeError } from '../utils/errors.js';
import { isWithinRoot } from '../utils/fileUtils.js';
import {
  MAX_DIRECTORY_ARTIFACT_DEPTH,
  collectRecordableWorkspaceFiles,
  pathHasSkippedDirectoryComponent,
} from '../utils/workspace-artifact-directory.js';
import {
  resolveBoundWorkspaceRoot,
  toCanonicalWorkspaceArtifactPath,
} from '../utils/workspace-artifact-path.js';
import type {
  ToolArtifact,
  ToolArtifactKind,
  ToolArtifactStorage,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

export interface RecordArtifactParams {
  title: string;
  kind?: ToolArtifactKind;
  storage?: Exclude<ToolArtifactStorage, 'published'>;
  description?: string;
  workspacePath?: string;
  managedId?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

const DESCRIPTION = `Registers a session artifact so clients can show it in an artifacts panel. Use it after creating a useful file, URL, image, report, notebook, or other intermediate result that the user may want to open later, unless the producing tool already returned artifact metadata. For example, write_file automatically records HTML, image, PDF, notebook, CSV, and office documents it writes inside the workspace, so do not call record_artifact again for the same workspacePath; still call it for other formats such as Markdown, JSON, and plain text, and for files produced outside write_file. When the session creates a remote resource, such as a pull request, issue, or comment submitted via gh, record its URL with kind "link" and the url locator so the user can reopen it later.

Provide exactly one locator: workspacePath, managedId, or url. Do not use the old "path" field. Use the Artifact tool, not record_artifact, for published interactive HTML artifacts.

For workspace files, workspacePath must be relative to the current execution directory (for example "report.csv" or "reports/summary.html") or an absolute path inside the bound workspace. Do not add workspace folder prefixes such as "w/agent/", and do not use ".." to walk up from a worktree. This tool resolves the path and verifies it stays inside the workspace. A regular file is stored as one workspace-root-relative canonical workspacePath. A directory is never stored as an artifact; each recordable file inside it is recorded separately. Word, Excel, PowerPoint, and other office documents use kind "document". A successful file result includes status=available, the canonical workspacePath, and resolvedPath. A successful directory result lists the expanded files instead of "Recorded artifact". If verification fails, the tool returns an error — do not tell the user the artifact can be opened or downloaded.`;

export const ARTIFACT_TITLE_MAX_LENGTH = 200;
export const ARTIFACT_WORKSPACE_PATH_MAX_LENGTH = 500;

const WORKSPACE_PATH_HINT =
  '"workspacePath" must be relative to the current execution directory (for example "report.csv") or an absolute path inside the workspace. Do not add workspace folder prefixes such as "w/agent/".';

type WorkspaceLocatorSuccess = {
  ok: true;
  workspacePath: string;
  resolvedPath: string;
  workspaceRoot: string;
  sizeBytes: number;
  isDirectory?: boolean;
};

type WorkspaceLocatorFailure = {
  ok: false;
  message: string;
  type: ToolErrorType;
};

type WorkspaceLocatorResult = WorkspaceLocatorSuccess | WorkspaceLocatorFailure;

class RecordArtifactInvocation extends BaseToolInvocation<
  RecordArtifactParams,
  ToolResult
> {
  constructor(
    params: RecordArtifactParams,
    private readonly config: Config,
  ) {
    super(params);
  }

  override getDescription(): string {
    return `Recording artifact ${this.params.title}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const workspacePathInput = trimOptional(this.params.workspacePath);
    if (workspacePathInput) {
      const locator = await resolveWorkspaceArtifactLocator(
        workspacePathInput,
        this.config,
      );
      if (!locator.ok) {
        return {
          llmContent: locator.message,
          returnDisplay: locator.message,
          error: {
            message: locator.message,
            type: locator.type,
          },
        };
      }

      if (locator.isDirectory) {
        return this.expandDirectoryLocator(locator);
      }

      const artifact: ToolArtifact = {
        title: this.params.title.trim(),
        kind: this.params.kind,
        storage: 'workspace',
        description: trimOptional(this.params.description),
        workspacePath: locator.workspacePath,
        mimeType: trimOptional(this.params.mimeType),
        sizeBytes: this.params.sizeBytes ?? locator.sizeBytes,
        metadata: this.params.metadata,
      };
      return {
        llmContent: formatWorkspaceSuccess(artifact.title, locator),
        returnDisplay: formatWorkspaceSuccess(artifact.title, locator),
        artifacts: [artifact],
      };
    }

    const artifact: ToolArtifact = {
      title: this.params.title.trim(),
      kind: this.params.kind,
      storage: this.params.storage ?? inferStorage(this.params),
      description: trimOptional(this.params.description),
      managedId: trimOptional(this.params.managedId),
      url: trimOptional(this.params.url),
      mimeType: trimOptional(this.params.mimeType),
      sizeBytes: this.params.sizeBytes,
      metadata: this.params.metadata,
    };

    return {
      llmContent: `Recorded artifact "${artifact.title}".`,
      returnDisplay: `Recorded artifact **${artifact.title}**.`,
      artifacts: [artifact],
    };
  }

  private async expandDirectoryLocator(
    locator: WorkspaceLocatorSuccess,
  ): Promise<ToolResult> {
    if (pathHasSkippedDirectoryComponent(locator.workspacePath)) {
      const message = [
        `Failed to record artifact: "${locator.workspacePath}" is a skipped directory and cannot be recorded.`,
        WORKSPACE_PATH_HINT,
      ].join('\n');
      return {
        llmContent: message,
        returnDisplay: message,
        error: {
          message,
          type: ToolErrorType.TARGET_IS_DIRECTORY,
        },
      };
    }
    let collected: {
      files: string[];
      truncated: boolean;
      depthLimited: boolean;
      unreadable: boolean;
      skippedUnrecordable: number;
    };
    try {
      collected = await collectRecordableWorkspaceFiles(
        locator.resolvedPath,
        locator.workspacePath,
        locator.workspaceRoot,
        (workspacePath) =>
          isRecordableDerivedChild(
            path.posix.basename(workspacePath),
            workspacePath,
          ),
      );
    } catch (error) {
      const failure = pathInspectFailure(
        error,
        locator.resolvedPath,
        locator.workspacePath,
        `Failed to record artifact: could not inspect "${locator.workspacePath}" (${error instanceof Error ? error.message : String(error)}).`,
      );
      return {
        llmContent: failure.message,
        returnDisplay: failure.message,
        error: {
          message: failure.message,
          type: failure.type,
        },
      };
    }
    if (collected.files.length === 0) {
      const message = [
        collected.depthLimited
          ? `Failed to record artifact: "${locator.workspacePath}" is a directory whose recordable files are deeper than ${MAX_DIRECTORY_ARTIFACT_DEPTH} levels.`
          : `Failed to record artifact: "${locator.workspacePath}" is a directory with no recordable files.`,
        WORKSPACE_PATH_HINT,
      ].join('\n');
      return {
        llmContent: message,
        returnDisplay: message,
        error: {
          message,
          type: ToolErrorType.TARGET_IS_DIRECTORY,
        },
      };
    }

    if (metadataExceedsBudget(this.params.metadata)) {
      const message =
        'Failed to record artifact: metadata is too large to expand a directory.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: {
          message,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }
    const parentTitle = this.params.title.trim();
    const parentDescription = trimOptional(this.params.description);
    const artifacts: ToolArtifact[] = [];
    for (const workspacePath of collected.files) {
      const title = path.posix.basename(workspacePath).trim();
      const description =
        parentDescription ||
        (parentTitle && parentTitle !== title ? parentTitle : undefined);
      artifacts.push({
        title,
        storage: 'workspace',
        workspacePath,
        metadata: {
          ...this.params.metadata,
          expandedFromDirectory: true,
        },
        ...(description ? { description } : {}),
      });
    }
    const message = formatDirectoryExpansion(locator, {
      ...collected,
      files: artifacts.map((artifact) => artifact.workspacePath!),
    });
    return {
      llmContent: message,
      returnDisplay: message,
      artifacts,
    };
  }
}

export class RecordArtifactTool extends BaseDeclarativeTool<
  RecordArtifactParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.RECORD_ARTIFACT;

  constructor(private readonly config: Config) {
    super(
      RecordArtifactTool.Name,
      ToolDisplayNames.RECORD_ARTIFACT,
      DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: {
            type: 'string',
            description: 'Concise title shown in the client artifact list.',
          },
          kind: {
            type: 'string',
            enum: [
              'file',
              'link',
              'html',
              'image',
              'video',
              'audio',
              'pdf',
              'notebook',
              'document',
              'other',
            ],
            description: 'Best-effort artifact type for client rendering.',
          },
          storage: {
            type: 'string',
            enum: ['workspace', 'external_url', 'managed'],
            description:
              'Storage class. Omit it to infer from the provided locator.',
          },
          description: {
            type: 'string',
            description: 'Optional short description for the user.',
          },
          workspacePath: {
            type: 'string',
            description:
              'Path relative to the current execution directory, or an absolute path inside the bound workspace. The tool verifies a regular file, or expands a directory into one artifact per recordable file.',
          },
          managedId: {
            type: 'string',
            description:
              'Opaque identifier for a resource managed by an extension or tool.',
          },
          url: {
            type: 'string',
            description:
              'HTTP or HTTPS URL that the user can open for details.',
          },
          mimeType: {
            type: 'string',
            description: 'Optional MIME type.',
          },
          sizeBytes: {
            type: 'integer',
            minimum: 0,
            description: 'Optional size in bytes.',
          },
          metadata: {
            type: 'object',
            additionalProperties: {
              anyOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
            description:
              'Small primitive metadata bag for client-specific display hints.',
          },
        },
        required: ['title'],
      },
      true,
      false,
      true,
      false,
      'artifact url link file image report notebook dashboard',
    );
  }

  override validateToolParams(params: RecordArtifactParams): string | null {
    if (hasLegacyPathField(params)) {
      return (
        '"path" is not supported; use "workspacePath" for a file in the current execution directory ' +
        '(relative to that directory, or an absolute path inside the workspace). Example: "report.csv".'
      );
    }
    return super.validateToolParams(params);
  }

  protected override validateToolParamValues(
    params: RecordArtifactParams,
  ): string | null {
    params.title = (params.title ?? '').trim();
    const titleError = validateString(
      params.title,
      'title',
      ARTIFACT_TITLE_MAX_LENGTH,
      true,
    );
    if (titleError) {
      return titleError;
    }
    const descriptionError = validateString(
      params.description,
      'description',
      1000,
      false,
    );
    if (descriptionError) {
      return descriptionError;
    }
    const mimeTypeError = validateString(
      params.mimeType,
      'mimeType',
      120,
      false,
    );
    if (mimeTypeError) {
      return mimeTypeError;
    }
    if (params.kind && !isArtifactKind(params.kind)) {
      return '"kind" must be a supported artifact kind';
    }
    if (
      params.storage &&
      params.storage !== 'workspace' &&
      params.storage !== 'external_url' &&
      params.storage !== 'managed'
    ) {
      return '"storage" must be workspace, external_url, or managed';
    }
    const locators = [
      trimOptional(params.workspacePath),
      trimOptional(params.managedId),
      trimOptional(params.url),
    ].filter(Boolean);
    if (locators.length !== 1) {
      return 'Provide exactly one of "workspacePath", "managedId", or "url"';
    }

    const inferredStorage = inferStorage(params);
    if (params.storage && params.storage !== inferredStorage) {
      return `"storage" must be "${inferredStorage}" for the provided locator`;
    }

    if (params.workspacePath) {
      const workspacePathError = validateWorkspacePath(
        params.workspacePath,
        this.config.getTargetDir(),
      );
      if (workspacePathError) {
        return workspacePathError;
      }
    }
    if (params.managedId) {
      const managedIdError = validateManagedId(params.managedId);
      if (managedIdError) {
        return managedIdError;
      }
    }
    if (params.url) {
      try {
        const parsed = new URL(params.url);
        if (parsed.username || parsed.password) {
          return '"url" must not include credentials';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return '"url" must use http or https';
        }
      } catch {
        return '"url" must be a valid URL';
      }
    }
    if (
      params.sizeBytes !== undefined &&
      (!Number.isSafeInteger(params.sizeBytes) || params.sizeBytes < 0)
    ) {
      return '"sizeBytes" must be a non-negative safe integer';
    }
    const metadataError = validateMetadata(params.metadata);
    if (metadataError) {
      return metadataError;
    }

    return null;
  }

  protected createInvocation(
    params: RecordArtifactParams,
  ): ToolInvocation<RecordArtifactParams, ToolResult> {
    return new RecordArtifactInvocation(params, this.config);
  }
}

function inferStorage(
  params: Pick<RecordArtifactParams, 'workspacePath' | 'managedId' | 'url'>,
): Exclude<ToolArtifactStorage, 'published'> {
  if (trimOptional(params.workspacePath)) {
    return 'workspace';
  }
  if (trimOptional(params.managedId)) {
    return 'managed';
  }
  return 'external_url';
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateString(
  value: string | undefined,
  field: string,
  maxLength: number,
  required: boolean,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return required ? `Missing or empty "${field}"` : null;
  }
  if (trimmed.length > maxLength) {
    return `"${field}" exceeds ${maxLength} characters`;
  }
  if (hasControlCharacter(trimmed, field === 'description')) {
    return `"${field}" contains control characters`;
  }
  if (isDisplayField(field) && hasUnsafeDisplayPayload(trimmed)) {
    return `"${field}" contains unsafe markup`;
  }
  return null;
}

function validateManagedId(value: string): string | null {
  const trimmed = value.trim();
  const stringError = validateString(trimmed, 'managedId', 200, true);
  if (stringError) {
    return stringError;
  }
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed)
  ) {
    return '"managedId" must be an opaque managed resource id';
  }
  return null;
}

function isDisplayField(field: string): boolean {
  return (
    field === 'title' ||
    field === 'description' ||
    field === 'mimeType' ||
    field === 'workspacePath' ||
    field === 'managedId'
  );
}

export function hasControlCharacter(
  value: string,
  allowLineWhitespace = false,
): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      allowLineWhitespace &&
      (code === 0x09 || code === 0x0a || code === 0x0d)
    ) {
      continue;
    }
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

export function hasUnsafeDisplayPayload(value: string): boolean {
  return (
    /<\s*\/?[a-z!]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|javascript\s*:|data\s*:\s*(?:text\/(?:html|javascript)|application\/javascript|image\/svg\+xml)/i.test(
      value,
    ) || /(?:^|[\s"'`<])on[a-z][a-z0-9-]*\s*=/i.test(value)
  );
}

function validateWorkspacePath(value: string, cwd: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Missing or empty "workspacePath"';
  }
  if (hasControlCharacter(trimmed) || hasUnsafeDisplayPayload(trimmed)) {
    return hasControlCharacter(trimmed)
      ? '"workspacePath" contains control characters'
      : '"workspacePath" contains unsafe markup';
  }
  if (isRedirectorRoutedPath(trimmed) || isForeignWindowsAbsolute(trimmed)) {
    return WORKSPACE_PATH_HINT;
  }
  if (isAbsoluteWorkspaceInput(trimmed)) {
    if (trimmed.length > 4096) {
      return '"workspacePath" exceeds 4096 characters';
    }
    const root = resolveBoundWorkspaceRoot(
      tryResolveForContainment(path.resolve(cwd)) ?? path.resolve(cwd),
    );
    const comparable = tryResolveForContainment(path.resolve(trimmed));
    if (comparable && !isWithinRoot(comparable, root)) {
      return '"workspacePath" must stay inside the workspace';
    }
    return null;
  }
  if (trimmed.length > ARTIFACT_WORKSPACE_PATH_MAX_LENGTH) {
    return `"workspacePath" exceeds ${ARTIFACT_WORKSPACE_PATH_MAX_LENGTH} characters`;
  }
  const portableNormalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  if (
    portableNormalized === '..' ||
    portableNormalized.startsWith('../') ||
    path.posix.isAbsolute(portableNormalized)
  ) {
    return '"workspacePath" must stay inside the current execution directory';
  }
  return null;
}

function validateMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
): string | null {
  if (metadata === undefined) {
    return null;
  }
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return '"metadata" must be an object';
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!key) {
      return '"metadata" keys must not be empty';
    }
    if (key.length > 120) {
      return '"metadata" keys must be 120 characters or fewer';
    }
    if (hasControlCharacter(key) || hasUnsafeDisplayPayload(key)) {
      return '"metadata" keys contain unsafe content';
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return '"metadata" values must be primitive';
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return '"metadata" numbers must be finite';
    }
    if (
      typeof value === 'string' &&
      (hasControlCharacter(value) || hasUnsafeDisplayPayload(value))
    ) {
      return '"metadata" string values contain unsafe content';
    }
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) {
    return '"metadata" must be 4096 bytes or fewer';
  }
  return null;
}

function isArtifactKind(kind: string): kind is ToolArtifactKind {
  return (
    kind === 'file' ||
    kind === 'link' ||
    kind === 'html' ||
    kind === 'image' ||
    kind === 'video' ||
    kind === 'audio' ||
    kind === 'pdf' ||
    kind === 'notebook' ||
    kind === 'document' ||
    kind === 'other'
  );
}

function hasLegacyPathField(params: RecordArtifactParams): boolean {
  const raw = params as RecordArtifactParams & { path?: unknown };
  return (
    Object.prototype.hasOwnProperty.call(raw, 'path') &&
    raw.path != null &&
    raw.path !== ''
  );
}

function isRedirectorRoutedPath(value: string): boolean {
  // NT junctions often readlink as `\??\UNC\host\share`. Treat that as `\\?\`.
  const slashes = value.replace(/\//g, '\\').replace(/^\\\?\?\\/, '\\\\?\\');
  if (/\\Device\\Mup\\/i.test(slashes)) {
    return true;
  }
  // On POSIX, `//repo/file` is a local absolute path, not SMB.
  const posixDoubleSlash =
    process.platform !== 'win32' &&
    !value.includes('\\') &&
    /^\/\//.test(value);
  if (
    !posixDoubleSlash &&
    (/^\\\\[^\\?]+(?:\\|$)/.test(slashes) ||
      /^\\\\\?\\[Uu][Nn][Cc]\\/.test(slashes))
  ) {
    return true;
  }
  // `\\?\C:\...` is a local drive; every other `\\?\` form (UNC, Mup,
  // GLOBALROOT, Volume GUID) can leave the machine via the redirector.
  return /^\\\\\?\\/.test(slashes) && !/^\\\\\?\\[A-Za-z]:\\/.test(slashes);
}

function isForeignWindowsAbsolute(value: string): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  return /^[A-Za-z]:/.test(value) || value.startsWith('\\');
}

function isAbsoluteWorkspaceInput(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    (process.platform === 'win32' && path.win32.isAbsolute(value))
  );
}

function formatWorkspaceSuccess(
  title: string,
  locator: WorkspaceLocatorSuccess,
): string {
  return [
    `Recorded artifact "${title}".`,
    'status: available',
    `workspacePath: ${locator.workspacePath}`,
    `resolvedPath: ${locator.resolvedPath}`,
  ].join('\n');
}

function formatDirectoryExpansion(
  locator: WorkspaceLocatorSuccess,
  collected: {
    files: string[];
    truncated: boolean;
    depthLimited?: boolean;
    unreadable?: boolean;
    skippedUnrecordable?: number;
  },
): string {
  const lines = [
    `Expanded directory "${locator.workspacePath}" into ${collected.files.length} artifacts.`,
    'status: available',
    `workspacePath: ${locator.workspacePath}`,
    `resolvedPath: ${locator.resolvedPath}`,
    'files:',
    ...collected.files.map((file) => `- ${file}`),
  ];
  if (collected.truncated) {
    lines.push(`Recorded the first ${collected.files.length} files.`);
  }
  if (collected.depthLimited) {
    lines.push(
      `Skipped files deeper than ${MAX_DIRECTORY_ARTIFACT_DEPTH} directory levels.`,
    );
  }
  if (collected.unreadable) {
    lines.push('Skipped subdirectories that could not be read.');
  }
  if ((collected.skippedUnrecordable ?? 0) > 0) {
    lines.push(
      `Skipped ${collected.skippedUnrecordable} files whose names cannot be recorded as artifact titles.`,
    );
  }
  return lines.join('\n');
}

function metadataExceedsBudget(
  metadata: Record<string, string | number | boolean | null> | undefined,
): boolean {
  const withMarker = { ...metadata, expandedFromDirectory: true };
  return Buffer.byteLength(JSON.stringify(withMarker), 'utf8') > 4096;
}

export function isRecordableDerivedChild(
  title: string,
  workspacePath: string,
): boolean {
  const trimmedTitle = title.trim();
  const trimmedPath = workspacePath.trim();
  if (title !== trimmedTitle || workspacePath !== trimmedPath) {
    return false;
  }
  return (
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= ARTIFACT_TITLE_MAX_LENGTH &&
    trimmedPath.length <= ARTIFACT_WORKSPACE_PATH_MAX_LENGTH &&
    !hasControlCharacter(trimmedTitle) &&
    !hasUnsafeDisplayPayload(trimmedTitle) &&
    !hasControlCharacter(trimmedPath) &&
    !hasUnsafeDisplayPayload(trimmedPath)
  );
}

function locatorFailure(
  type: ToolErrorType,
  message: string,
): WorkspaceLocatorFailure {
  return { ok: false, type, message };
}

async function resolveExistingDir(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Compare absolute locators against a realpath'd workspace root. `path.resolve`
 * alone keeps macOS `/var` vs `/private/var` (and similar symlink roots) in
 * different namespaces and false-rejects files that are inside the workspace.
 * Returns undefined when neither the path nor its parent can be realpath'd, so
 * callers do not mix namespaces and call a missing-but-inside path "outside".
 */
function tryResolveForContainment(absolutePath: string): string | undefined {
  const resolved = path.resolve(absolutePath);
  if (pathHasRedirectorHop(resolved)) {
    return undefined;
  }
  try {
    return realpathSync(resolved);
  } catch {
    try {
      const parent = path.dirname(resolved);
      if (pathHasRedirectorHop(parent)) {
        return undefined;
      }
      return path.join(realpathSync(parent), path.basename(resolved));
    } catch {
      return undefined;
    }
  }
}

const REDIRECTOR_HOP_LIMIT = 8;

function pathHasRedirectorHop(absolutePath: string): boolean {
  if (isRedirectorRoutedPath(absolutePath)) {
    return true;
  }
  const resolved = path.resolve(absolutePath);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..')) {
    return symlinkChainHitsRedirector(resolved);
  }
  let acc = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    acc = path.join(acc, segment);
    if (isRedirectorRoutedPath(acc) || symlinkChainHitsRedirector(acc)) {
      return true;
    }
  }
  return false;
}

function symlinkChainHitsRedirector(absolutePath: string): boolean {
  let current = absolutePath;
  for (let hop = 0; hop < REDIRECTOR_HOP_LIMIT; hop++) {
    let lst;
    try {
      lst = lstatSync(current);
    } catch {
      return false;
    }
    if (!lst.isSymbolicLink()) {
      return false;
    }
    let target: string;
    try {
      target = readlinkSync(current);
    } catch {
      return false;
    }
    if (isRedirectorRoutedPath(target)) {
      return true;
    }
    const next = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(current), target);
    if (isRedirectorRoutedPath(next)) {
      return true;
    }
    current = next;
  }
  return false;
}

async function resolveWorkspaceArtifactLocator(
  rawPath: string,
  config: Config,
): Promise<WorkspaceLocatorResult> {
  const cwd = await resolveExistingDir(config.getTargetDir());
  const root = await resolveExistingDir(resolveBoundWorkspaceRoot(cwd));
  const first = workspacePathCandidate(rawPath, cwd, root, true);
  if (!first.ok) {
    return first;
  }
  const inspected = await inspectWorkspaceCandidate(
    first.path,
    rawPath,
    cwd,
    root,
  );
  if (
    inspected.ok ||
    inspected.type !== ToolErrorType.FILE_NOT_FOUND ||
    process.platform === 'win32' ||
    !rawPath.includes('\\')
  ) {
    return inspected;
  }
  const fallback = workspacePathCandidate(rawPath, cwd, root, false);
  if (!fallback.ok || fallback.path === first.path) {
    return inspected;
  }
  return inspectWorkspaceCandidate(fallback.path, rawPath, cwd, root);
}

function workspacePathCandidate(
  locator: string,
  cwd: string,
  root: string,
  preservePosixBackslash: boolean,
): { ok: true; path: string } | WorkspaceLocatorFailure {
  if (isRedirectorRoutedPath(locator) || isForeignWindowsAbsolute(locator)) {
    return locatorFailure(
      ToolErrorType.INVALID_TOOL_PARAMS,
      WORKSPACE_PATH_HINT,
    );
  }
  if (isAbsoluteWorkspaceInput(locator)) {
    const absolute = path.resolve(locator);
    const comparable = tryResolveForContainment(absolute);
    if (comparable && !isWithinRoot(comparable, root)) {
      return locatorFailure(
        ToolErrorType.PATH_NOT_IN_WORKSPACE,
        `Failed to record artifact: "${locator}" is outside the workspace.\n${WORKSPACE_PATH_HINT}`,
      );
    }
    return { ok: true, path: absolute };
  }

  const relative =
    preservePosixBackslash && process.platform !== 'win32'
      ? locator
      : locator.replace(/\\/g, '/');
  return { ok: true, path: path.resolve(cwd, relative) };
}

async function inspectWorkspaceCandidate(
  candidate: string,
  rawPath: string,
  cwd: string,
  root: string,
): Promise<WorkspaceLocatorResult> {
  if (pathHasRedirectorHop(candidate)) {
    return locatorFailure(
      ToolErrorType.PATH_NOT_IN_WORKSPACE,
      `Failed to record artifact: "${rawPath}" resolves outside the workspace.\n${WORKSPACE_PATH_HINT}`,
    );
  }

  try {
    await fs.lstat(candidate);
  } catch (error) {
    return pathInspectFailure(
      error,
      candidate,
      rawPath,
      `Failed to record artifact: could not inspect "${candidate}" (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  let resolved: string;
  try {
    resolved = await fs.realpath(candidate);
  } catch (error) {
    return pathInspectFailure(
      error,
      candidate,
      rawPath,
      `Failed to record artifact: could not resolve "${rawPath}" (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (!isWithinRoot(resolved, root)) {
    return locatorFailure(
      ToolErrorType.PATH_NOT_IN_WORKSPACE,
      `Failed to record artifact: "${rawPath}" resolves outside the workspace.\n${WORKSPACE_PATH_HINT}`,
    );
  }

  let st;
  try {
    st = await fs.stat(resolved);
  } catch (error) {
    return pathInspectFailure(
      error,
      resolved,
      rawPath,
      `Failed to record artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!st.isFile() && !st.isDirectory()) {
    return locatorFailure(
      ToolErrorType.TARGET_NOT_REGULAR_FILE,
      `Failed to record artifact: "${resolved}" is not a regular file.\n${WORKSPACE_PATH_HINT}`,
    );
  }

  if (st.isDirectory() && path.resolve(resolved) === path.resolve(cwd)) {
    return locatorFailure(
      ToolErrorType.TARGET_IS_DIRECTORY,
      `Failed to record artifact: "${rawPath}" is the workspace root, which cannot be recorded as a directory artifact.`,
    );
  }

  const workspacePath = toCanonicalWorkspaceArtifactPath(resolved, cwd);
  if (!workspacePath) {
    if (st.isDirectory()) {
      return locatorFailure(
        ToolErrorType.TARGET_IS_DIRECTORY,
        `Failed to record artifact: "${rawPath}" is the workspace root, which cannot be recorded as a directory artifact.`,
      );
    }
    return locatorFailure(
      ToolErrorType.PATH_NOT_IN_WORKSPACE,
      `Failed to record artifact: "${rawPath}" could not be converted to a workspace-root-relative path.\n${WORKSPACE_PATH_HINT}`,
    );
  }
  const canonicalError = validateString(
    workspacePath,
    'workspacePath',
    ARTIFACT_WORKSPACE_PATH_MAX_LENGTH,
    true,
  );
  if (canonicalError) {
    return locatorFailure(
      ToolErrorType.INVALID_TOOL_PARAMS,
      canonicalError.includes('exceeds')
        ? `Failed to record artifact: the stored workspace-root-relative path "${workspacePath}" exceeds ${ARTIFACT_WORKSPACE_PATH_MAX_LENGTH} characters.`
        : canonicalError,
    );
  }

  return {
    ok: true,
    workspacePath,
    resolvedPath: resolved,
    workspaceRoot: root,
    sizeBytes: st.isDirectory() ? 0 : st.size,
    ...(st.isDirectory() ? { isDirectory: true } : {}),
  };
}

function classifyPathError(error: unknown): ToolErrorType {
  if (!isNodeError(error)) {
    return ToolErrorType.EXECUTION_FAILED;
  }
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    return ToolErrorType.FILE_NOT_FOUND;
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return ToolErrorType.PERMISSION_DENIED;
  }
  return ToolErrorType.EXECUTION_FAILED;
}

function pathInspectFailure(
  error: unknown,
  candidate: string,
  rawPath: string,
  fallbackMessage: string,
): WorkspaceLocatorFailure {
  const type = classifyPathError(error);
  if (type === ToolErrorType.FILE_NOT_FOUND) {
    return locatorFailure(
      type,
      [
        `Failed to record artifact: file not found at "${candidate}".`,
        WORKSPACE_PATH_HINT,
      ].join('\n'),
    );
  }
  if (type === ToolErrorType.PERMISSION_DENIED) {
    return locatorFailure(
      type,
      `Failed to record artifact: permission denied for "${rawPath}".\n${WORKSPACE_PATH_HINT}`,
    );
  }
  return locatorFailure(type, fallbackMessage);
}
