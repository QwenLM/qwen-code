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
import { type Ignore, loadIgnoreRules } from '../utils/filesearch/ignore.js';
import {
  formatQwenIgnoreFileNames,
  getQwenIgnoreFileNames,
} from '../utils/qwenIgnoreParser.js';
import {
  MAX_DIRECTORY_ARTIFACT_DEPTH,
  collectRecordableWorkspaceFiles,
  pathHasSkippedArtifactDirectoryAncestor,
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

/**
 * The description names the ignore files this session's panel actually loads
 * (loadIgnoreRules reads them all), not a fixed pair.
 */
function buildDescription(customIgnoreFiles?: string[]): string {
  const ignoreFileNames = getQwenIgnoreFileNames(customIgnoreFiles)
    .map((name) => `"${name}"`)
    .join(', ');
  return `Registers a session artifact so clients can show it in an artifacts panel. Use it after creating a useful file, URL, image, report, notebook, or other intermediate result that the user may want to open later, unless the producing tool already returned artifact metadata. write_file, edit, and notebook_edit already record artifact-like workspace files (csv, html, sql, py, md, json, images, pdf, notebooks, and office documents), so do not call record_artifact again for those paths. Do call it when a shell command created or rewrote such a file, and for other formats such as plain text. When the session creates a remote resource, such as a pull request, issue, or comment submitted via gh, record its URL with kind "link" and the url locator so the user can reopen it later.

Provide exactly one locator: workspacePath, managedId, or url. Do not use the old "path" field.

For workspace files, workspacePath must be relative to the current execution directory (for example "report.csv" or "reports/summary.html") or an absolute path inside the bound workspace. Do not add workspace folder prefixes such as "w/agent/", and do not use ".." to walk up from a worktree. This tool resolves the path and verifies it stays inside the workspace. A workspace file is rejected when the Artifacts panel cannot surface it: when it sits under a skipped directory (node_modules, .git, __pycache__, dist, or .qwen) even without ignore files, or when the workspace ignore rules (.gitignore and ${ignoreFileNames} at the workspace root, plus the .git default) match the file itself or any directory above it; copy the file to a visible workspace path and record that copy instead. The file's own name does not count, so a regular file named ".gitignore" or "dist" at the workspace root is still recordable. Two locations stay recordable even when skipped or hidden: the ".qwen/reviews/" subtree (code-review reports are registered there and the panel renders those artifacts) and the "Ask for details" deliverable ".qwen/tmp/ask-details.html". A regular file is stored as one workspace-root-relative canonical workspacePath. A directory is never stored as an artifact; each recordable file inside it is recorded separately. Word, Excel, PowerPoint, and other office documents use kind "document". A successful file result includes status=available, the canonical workspacePath, and resolvedPath. A successful directory result lists the expanded files instead of "Recorded artifact". If verification fails, the tool returns an error — do not tell the user the artifact can be opened or downloaded.`;
}

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
    const workspacePath = this.params.workspacePath;
    const filename =
      typeof workspacePath === 'string'
        ? workspacePath.split('/').at(-1)
        : undefined;
    return `Recording artifact ${filename || this.params.title}`;
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

      const callerTitle = this.params.title.trim();
      const filename = path.posix.basename(locator.workspacePath);
      // A filename can be 255 bytes; a stored title stops at 200 characters.
      const title = isRecordableDerivedChild(filename, locator.workspacePath)
        ? filename
        : callerTitle;
      const { derivedFromTitle: _callerMarker, ...callerMetadata } =
        this.params.metadata ?? {};
      const callerDescription = trimOptional(this.params.description);
      const derivedDescription =
        !callerDescription && callerTitle !== title ? callerTitle : undefined;
      // The marker is extra JSON. A bag that already fills the store cap
      // cannot carry it, and ingest would drop the record after success.
      const markDerived =
        derivedDescription !== undefined &&
        !metadataExceedsBudget(callerMetadata, 'derivedFromTitle');
      const description =
        callerDescription || (markDerived ? derivedDescription : undefined);
      const metadata = markDerived
        ? { ...callerMetadata, derivedFromTitle: true }
        : Object.keys(callerMetadata).length > 0
          ? callerMetadata
          : undefined;
      const artifact: ToolArtifact = {
        title,
        kind: this.params.kind,
        storage: 'workspace',
        ...(description ? { description } : {}),
        workspacePath: locator.workspacePath,
        mimeType: trimOptional(this.params.mimeType),
        sizeBytes: this.params.sizeBytes ?? locator.sizeBytes,
        metadata,
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
    const cwd = await resolveExistingDir(this.config.getTargetDir());
    const customIgnoreFiles =
      this.config.getFileFilteringOptions().customIgnoreFiles;
    const strippedLocator = stripWorktreePrefixForCwd(
      locator.workspacePath,
      cwd,
    );
    if (
      !isQwenReviewsPath(strippedLocator) &&
      pathHasSkippedDirectoryComponent(strippedLocator)
    ) {
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
      // The same predicate the direct-file gate applies, so the expansion
      // never records a file the panel would not surface (issue #17453).
      // Rules load from the bound workspace root — the namespace the panel
      // matches stored paths against (see fileHiddenFromArtifactsPanel).
      const hiddenRules = loadPanelIgnoreRules(
        resolveBoundWorkspaceRoot(path.resolve(cwd)),
        customIgnoreFiles,
      );
      collected = await collectRecordableWorkspaceFiles(
        locator.resolvedPath,
        locator.workspacePath,
        locator.workspaceRoot,
        (workspaceRelativePath) =>
          isRecordableDerivedChild(
            path.posix.basename(workspaceRelativePath),
            workspaceRelativePath,
          ) &&
          !fileHiddenFromArtifactsPanel(
            workspaceRelativePath,
            cwd,
            customIgnoreFiles,
            hiddenRules,
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
      buildDescription(config.getFileFilteringOptions().customIgnoreFiles),
      Kind.Other,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: {
            type: 'string',
            description:
              'Concise title for a link or managed artifact. A workspace file is recorded and shown under its filename; if this title differs and description is empty, it is kept as the description.',
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
  key: 'expandedFromDirectory' | 'derivedFromTitle' = 'expandedFromDirectory',
): boolean {
  const withMarker = { ...metadata, [key]: true };
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
  // The panel's file browser loads these files (context.fileFiltering);
  // the gate must judge the path with the same rule set.
  const customIgnoreFiles = config.getFileFilteringOptions().customIgnoreFiles;
  const first = workspacePathCandidate(rawPath, cwd, root, true);
  if (!first.ok) {
    return first;
  }
  const inspected = await inspectWorkspaceCandidate(
    first.path,
    rawPath,
    cwd,
    root,
    customIgnoreFiles,
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
  return inspectWorkspaceCandidate(
    fallback.path,
    rawPath,
    cwd,
    root,
    customIgnoreFiles,
  );
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

/**
 * `.qwen/reviews` locators (the subtree itself or anything inside it) stay
 * recordable: the bundled /review skill registers its code-review artifact
 * there, and the panel's code-review renderer requires report paths to start
 * with the prefix.
 */
function isQwenReviewsPath(strippedWorkspacePath: string): boolean {
  return (
    strippedWorkspacePath === '.qwen/reviews' ||
    strippedWorkspacePath.startsWith('.qwen/reviews/')
  );
}

/**
 * Canonical paths from a worktree session always start with
 * `.qwen/worktrees/<slug>/`. That prefix is derived from the session's own
 * cwd, and only that exact prefix may be stripped before judging the path:
 * a workspace that literally contains a directory named
 * `.qwen/worktrees/<slug>` (a session whose cwd is not inside the worktree)
 * must be judged by its full path, which the panel cannot surface.
 */
function stripWorktreePrefixForCwd(workspacePath: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const boundRoot = resolveBoundWorkspaceRoot(resolvedCwd);
  if (boundRoot === resolvedCwd) {
    return workspacePath;
  }
  const prefix =
    path.relative(boundRoot, resolvedCwd).split(path.sep).join('/') + '/';
  return workspacePath.startsWith(prefix)
    ? workspacePath.slice(prefix.length)
    : workspacePath;
}

/**
 * The same rule set the serve createWorkspaceFileSystemFactory loads
 * (workspace-file-system.ts): one `loadIgnoreRules` per canonical workspace
 * root, with that root as `projectRoot`.
 */
function loadPanelIgnoreRules(
  workspaceRoot: string,
  customIgnoreFiles?: string[],
): Ignore {
  return loadIgnoreRules({
    projectRoot: workspaceRoot,
    useGitignore: true,
    useQwenignore: true,
    ...(customIgnoreFiles !== undefined ? { customIgnoreFiles } : {}),
    ignoreDirs: [],
  });
}

/**
 * Direct file records are refused when the Artifacts panel cannot surface
 * the file, so `status: available` never points at an entry the user cannot
 * find. Two independent reasons hide a file:
 *
 * 1. Skipped-directory contract (issue #17453): a proper ancestor directory
 *    named in the artifact skip list (node_modules, .git, __pycache__, dist,
 *    .qwen) is never shown by the panel, with or without ignore files. The
 *    file's own name does not count: a regular file named "dist" at the
 *    workspace root is a panel-visible file.
 * 2. Ignore rules: the workspace ignore rules the panel's file browser
 *    loads (.gitignore plus every qwen ignore file, and the .git default —
 *    the same `loadIgnoreRules` configuration createWorkspaceFileSystemFactory
 *    uses) match the file itself or any directory above it. The panel loads
 *    one rule set per canonical workspace root and matches stored
 *    bound-root-canonical paths, so the gate does the same: rules from the
 *    bound root (`resolveBoundWorkspaceRoot(cwd)`), matched against the
 *    stored path. For a root session that is the execution directory; for a
 *    worktree session it is the bound root behind the worktree.
 *
 * Two product locations stay recordable even when hidden, because the panel
 * serves them through dedicated artifact views instead of the file browser:
 * the `.qwen/reviews/` subtree and the "Ask for details" deliverable
 * `.qwen/tmp/ask-details.html` (the shipped prompt tells the side task to
 * save it there and to record it explicitly, because write_file's
 * auto-record skips `.qwen/tmp/`).
 */
const ASK_DETAILS_WORKSPACE_PATH = '.qwen/tmp/ask-details.html';

export function fileHiddenFromArtifactsPanel(
  workspacePath: string,
  cwd: string,
  customIgnoreFiles?: string[],
  preloadedRules?: Ignore,
): boolean {
  const stripped = stripWorktreePrefixForCwd(workspacePath, cwd);
  if (isQwenReviewsPath(stripped)) {
    return false;
  }
  if (stripped === ASK_DETAILS_WORKSPACE_PATH) {
    return false;
  }
  if (pathHasSkippedArtifactDirectoryAncestor(stripped)) {
    return true;
  }
  const rules =
    preloadedRules ??
    loadPanelIgnoreRules(
      resolveBoundWorkspaceRoot(path.resolve(cwd)),
      customIgnoreFiles,
    );
  const fileFilter = rules.getFileFilter();
  const dirFilter = rules.getDirectoryFilter();
  if (fileFilter(workspacePath) || dirFilter(workspacePath)) {
    return true;
  }
  // The browser cannot descend into an ignored directory, so the file is
  // invisible when any ancestor is hidden; `shouldIgnore` probes directories
  // with a trailing slash so `foo/` patterns match them.
  const segments = workspacePath.split('/').filter(Boolean);
  for (let depth = 1; depth < segments.length; depth++) {
    const ancestor = segments.slice(0, depth).join('/');
    if (dirFilter(`${ancestor}/`) || fileFilter(ancestor)) {
      return true;
    }
  }
  return false;
}

async function inspectWorkspaceCandidate(
  candidate: string,
  rawPath: string,
  cwd: string,
  root: string,
  customIgnoreFiles?: string[],
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
  if (
    !st.isDirectory() &&
    fileHiddenFromArtifactsPanel(workspacePath, cwd, customIgnoreFiles)
  ) {
    return locatorFailure(
      ToolErrorType.INVALID_TOOL_PARAMS,
      [
        `Failed to record artifact: "${rawPath}" is hidden from the Artifacts panel: it sits under a skipped directory (node_modules, .git, __pycache__, dist, .qwen) or the workspace ignore rules (.gitignore, ${formatQwenIgnoreFileNames(customIgnoreFiles)} at the workspace root, plus the .git default) hide it from the panel's file browser, so the recording would not be visible to the user.`,
        'Record the file at a visible workspace path instead (for example copy it out of the skipped directory).',
      ].join('\n'),
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
