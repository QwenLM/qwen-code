/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type {
  ToolArtifact,
  ToolArtifactKind,
  ToolArtifactStorage,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
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

const DESCRIPTION = `Registers a session artifact so clients can show it in an artifacts panel. Use it after creating a useful file, URL, image, report, notebook, or other intermediate result that the user may want to open later.

This tool only records metadata. It does not publish, upload, read, write, or verify the referenced resource. Provide exactly one locator: workspacePath, managedId, or url. Use the Artifact tool, not record_artifact, for published interactive HTML artifacts.`;

class RecordArtifactInvocation extends BaseToolInvocation<
  RecordArtifactParams,
  ToolResult
> {
  override getDescription(): string {
    return `Recording artifact ${this.params.title}`;
  }

  execute(_signal: AbortSignal): Promise<ToolResult> {
    const artifact: ToolArtifact = {
      title: this.params.title.trim(),
      kind: this.params.kind,
      storage: this.params.storage ?? inferStorage(this.params),
      description: trimOptional(this.params.description),
      workspacePath: trimOptional(this.params.workspacePath),
      managedId: trimOptional(this.params.managedId),
      url: trimOptional(this.params.url),
      mimeType: trimOptional(this.params.mimeType),
      sizeBytes: this.params.sizeBytes,
      metadata: this.params.metadata,
    };

    return Promise.resolve({
      llmContent: `Recorded artifact "${artifact.title}".`,
      returnDisplay: `Recorded artifact **${artifact.title}**.`,
      artifacts: [artifact],
    });
  }
}

export class RecordArtifactTool extends BaseDeclarativeTool<
  RecordArtifactParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.RECORD_ARTIFACT;

  constructor() {
    super(
      RecordArtifactTool.Name,
      ToolDisplayNames.RECORD_ARTIFACT,
      DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
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
              'Workspace-relative path for a file produced in the current workspace.',
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

  protected override validateToolParamValues(
    params: RecordArtifactParams,
  ): string | null {
    params.title = (params.title ?? '').trim();
    const titleError = validateString(params.title, 'title', 200, true);
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
      params.storage !== 'managed' &&
      (params as { storage?: string }).storage !== 'published'
    ) {
      return '"storage" must be workspace, external_url, managed, or published';
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
      const workspacePathError = validateWorkspacePath(params.workspacePath);
      if (workspacePathError) {
        return workspacePathError;
      }
    }
    if (params.managedId) {
      const managedIdError = validateString(
        params.managedId,
        'managedId',
        200,
        true,
      );
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
    return new RecordArtifactInvocation(params);
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
  if (hasControlCharacter(trimmed)) {
    return `"${field}" contains control characters`;
  }
  if (
    (field === 'title' || field === 'description') &&
    hasUnsafeDisplayPayload(trimmed)
  ) {
    return `"${field}" contains unsafe markup`;
  }
  return null;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafeDisplayPayload(value: string): boolean {
  return /<\s*\/?[a-z!]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|javascript\s*:|data\s*:\s*(?:text\/(?:html|javascript)|application\/javascript)|on[a-z]+\s*=/i.test(
    value,
  );
}

function validateWorkspacePath(value: string): string | null {
  const trimmed = value.trim();
  const stringError = validateString(trimmed, 'workspacePath', 500, true);
  if (stringError) {
    return stringError;
  }
  if (path.isAbsolute(trimmed)) {
    return '"workspacePath" must be relative to the workspace';
  }
  const normalized = path.normalize(trimmed);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    return '"workspacePath" must stay inside the workspace';
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
    kind === 'other'
  );
}
