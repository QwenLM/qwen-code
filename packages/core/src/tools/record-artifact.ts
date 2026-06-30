/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
    if (!params.title) {
      return 'Missing or empty "title"';
    }

    const locators = [
      trimOptional(params.workspacePath),
      trimOptional(params.managedId),
      trimOptional(params.url),
    ].filter(Boolean);
    if (locators.length !== 1) {
      return 'Provide exactly one of "workspacePath", "managedId", or "url"';
    }

    if ((params as { storage?: string }).storage === 'published') {
      return 'record_artifact cannot create published artifacts; use the Artifact tool instead';
    }

    const inferredStorage = inferStorage(params);
    if (params.storage && params.storage !== inferredStorage) {
      return `"storage" must be "${inferredStorage}" for the provided locator`;
    }

    if (params.url) {
      try {
        const parsed = new URL(params.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return '"url" must use http or https';
        }
      } catch {
        return '"url" must be a valid URL';
      }
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
