/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKArtifactInfo } from '@qwen-code/core';

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolErrorType,
  type ToolInvocation,
  type ToolResult,
} from '@qwen-code/core';
import {
  createPresentFilesToolUseResult,
  PRESENT_FILES_TOOL_NAME,
} from './artifactProtocol.js';

export interface PresentFilesParams {
  files: Array<{ file_path: string }>;
}

export type ArtifactPresenter = (
  paths: readonly string[],
) => Promise<readonly SDKArtifactInfo[]>;

const REMOTE_PRESENT_FILES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      minItems: 1,
      description: 'Files to deliver to the user.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file_path'],
        properties: {
          file_path: {
            type: 'string',
            minLength: 1,
            description:
              'Exact path to a local file. Relative paths resolve from the session working directory.',
          },
        },
      },
    },
  },
} as const;

class PresentFilesInvocation extends BaseToolInvocation<
  PresentFilesParams,
  ToolResult
> {
  constructor(
    params: PresentFilesParams,
    private readonly present: ArtifactPresenter,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, toolName, displayName);
  }

  getDescription(): string {
    const count = this.params.files.length;
    return `Presenting ${count} file${count === 1 ? '' : 's'} to the user`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      signal.throwIfAborted();
      const artifacts = await this.present(
        this.params.files.map(({ file_path }) => file_path),
      );
      signal.throwIfAborted();
      const toolUseResult = createPresentFilesToolUseResult(artifacts);
      const paths = artifacts.map(({ display_path }) => display_path);
      return {
        llmContent: `Delivered ${artifacts.length} file${
          artifacts.length === 1 ? '' : 's'
        } to the user:\n${paths.join('\n')}`,
        returnDisplay: paths.join('\n'),
        toolUseResult,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'File delivery failed';
      return {
        llmContent: `Unable to deliver the requested files: ${message}`,
        returnDisplay: message,
        error: {
          message,
          type: ToolErrorType.EXECUTION_FAILED,
        },
        toolUseResult: createPresentFilesToolUseResult([], true),
      };
    }
  }
}

/**
 * Root-session file presentation tool.
 *
 * The presenter validates paths, updates the authoritative artifact snapshot,
 * and flushes that snapshot before this invocation returns its tool result.
 */
export class PresentFilesTool extends BaseDeclarativeTool<
  PresentFilesParams,
  ToolResult
> {
  constructor(private readonly present: ArtifactPresenter) {
    super(
      PRESENT_FILES_TOOL_NAME,
      'Present Files',
      'Deliver final files that are outputs requested by the user. Use this after creating, generating, writing, exporting, packaging, or updating a file for the user, even when they do not explicitly ask to download, attach, send, or present it. Call it only after every requested file exists and is ready. Do not deliver incidental source-code edits, temporary or intermediate files, files mentioned only in explanatory text, or failed or incomplete outputs. Pass every requested file as an exact path; do not pass directories, filename ranges, or missing files.',
      Kind.Communicate,
      REMOTE_PRESENT_FILES_SCHEMA,
      false,
    );
  }

  protected createInvocation(
    params: PresentFilesParams,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<PresentFilesParams, ToolResult> {
    return new PresentFilesInvocation(
      params,
      this.present,
      toolName,
      displayName,
    );
  }
}
