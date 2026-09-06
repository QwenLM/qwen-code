/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { makeRelative, shortenPath, unescapePath } from '../utils/paths.js';
import { isInForkExecution } from './agent/fork-subagent.js';
import { ToolErrorType } from './tool-error.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  MAX_TERMINAL_IMAGE_BYTES,
  type TerminalImageDisplay,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
} from './tools.js';

const PNG_SIGNATURE = '89504e470d0a1a0a';

export interface DisplayImageToolParams {
  file_path: string;
}

function errorResult(message: string, type: ToolErrorType): ToolResult {
  return {
    llmContent: message,
    returnDisplay: `Error: ${message}`,
    error: { message, type },
  };
}

class DisplayImageInvocation extends BaseToolInvocation<
  DisplayImageToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: DisplayImageToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return shortenPath(
      makeRelative(this.params.file_path, this.config.getTargetDir()),
    );
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path }];
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    // The fork registry keeps this tool's declaration for prompt-cache parity,
    // so the execution ban cannot live in declaration stripping alone. Enforce
    // it here so the invariant holds no matter how the allowlist is wired.
    if (isInForkExecution()) {
      return errorResult(
        'display_image can only be executed by the main agent.',
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    const filePath = path.resolve(this.params.file_path);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      const message =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Image file not found: ${filePath}`
          : `Unable to access image file "${filePath}": ${
              error instanceof Error ? error.message : String(error)
            }`;
      return errorResult(
        message,
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? ToolErrorType.FILE_NOT_FOUND
          : ToolErrorType.READ_CONTENT_FAILURE,
      );
    }

    if (stat.isDirectory()) {
      return errorResult(
        `Image path is a directory: ${filePath}`,
        ToolErrorType.TARGET_IS_DIRECTORY,
      );
    }
    if (!stat.isFile()) {
      return errorResult(
        `Image path is not a regular file: ${filePath}`,
        ToolErrorType.TARGET_NOT_REGULAR_FILE,
      );
    }
    if (stat.size > MAX_TERMINAL_IMAGE_BYTES) {
      return errorResult(
        `Image exceeds the ${MAX_TERMINAL_IMAGE_BYTES} byte display limit: ${filePath}`,
        ToolErrorType.FILE_TOO_LARGE,
      );
    }

    signal.throwIfAborted();
    let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      fileHandle = await fs.open(filePath, 'r');
      // Read the full 24-byte PNG header (signature + IHDR width/height) so a
      // truncated file is rejected here, before the renderer support check
      // reports success. A valid PNG is always at least 24 bytes.
      const header = Buffer.alloc(24);
      const { bytesRead } = await fileHandle.read(header, 0, header.length, 0);
      if (
        bytesRead !== header.length ||
        header.subarray(0, 8).toString('hex') !== PNG_SIGNATURE
      ) {
        return errorResult(
          `Only PNG images are supported by display_image: ${filePath}`,
          ToolErrorType.INVALID_TOOL_PARAMS,
        );
      }
    } catch (error) {
      return errorResult(
        `Unable to read image file "${filePath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    } finally {
      await fileHandle?.close();
    }

    const renderSupport = await this.config.getTerminalImageRenderSupport();
    if (!renderSupport.available) {
      return errorResult(
        `The image was not displayed: ${renderSupport.reason}`,
        ToolErrorType.EXECUTION_FAILED,
      );
    }

    const display: TerminalImageDisplay = {
      type: 'terminal_image',
      filePath,
      mimeType: 'image/png',
    };
    return {
      llmContent:
        `The terminal renderer accepted "${path.basename(filePath)}" for display. ` +
        'This display-only tool does not provide the image contents to you; use read_file if you need to inspect the image.',
      returnDisplay: display,
      resultFilePaths: [filePath],
    };
  }
}

export class DisplayImageTool extends BaseDeclarativeTool<
  DisplayImageToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.DISPLAY_IMAGE;

  constructor(private readonly config: Config) {
    super(
      DisplayImageTool.Name,
      ToolDisplayNames.DISPLAY_IMAGE,
      'Displays an existing workspace PNG in the user’s interactive terminal. Only the main agent can execute this tool. This is only a user-visible preview: it does not return image contents to you. Use read_file when you need to inspect or understand the image. The file_path must be absolute.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to a PNG inside the current workspace.',
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      false,
    );
  }

  protected override validateToolParamValues(
    params: DisplayImageToolParams,
  ): string | null {
    params.file_path = unescapePath(params.file_path.trim());
    if (!params.file_path) {
      return 'Missing or empty "file_path".';
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute: ${params.file_path}`;
    }
    if (
      !this.config.getWorkspaceContext().isPathWithinWorkspace(params.file_path)
    ) {
      return `Image path is outside the current workspace: ${params.file_path}`;
    }
    return null;
  }

  protected createInvocation(
    params: DisplayImageToolParams,
  ): ToolInvocation<DisplayImageToolParams, ToolResult> {
    return new DisplayImageInvocation(this.config, params);
  }
}
