/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { runInForkContext } from './agent/fork-subagent.js';
import { ToolErrorType } from './tool-error.js';
import { DisplayImageTool } from './display-image.js';
import { MAX_TERMINAL_IMAGE_BYTES } from './tools.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

describe('DisplayImageTool', () => {
  let workspace: string;
  let tool: DisplayImageTool;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'display-image-test-'));
    tool = new DisplayImageTool({
      getTargetDir: () => workspace,
      getWorkspaceContext: () => ({
        isPathWithinWorkspace: (filePath: string) => {
          const relative = path.relative(workspace, path.resolve(filePath));
          return (
            relative === '' ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== '..' &&
              !path.isAbsolute(relative))
          );
        },
      }),
      getTerminalImageRenderSupport: async () => ({ available: true }),
    } as unknown as Config);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('returns a small structured display without image bytes', async () => {
    const imagePath = path.join(workspace, 'pixel.png');
    await fs.writeFile(imagePath, PNG_1X1);

    const invocation = tool.build({ file_path: imagePath });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toEqual({
      type: 'terminal_image',
      filePath: imagePath,
      mimeType: 'image/png',
    });
    expect(result.resultFilePaths).toEqual([imagePath]);
    expect(result.llmContent).toContain('does not provide the image contents');
    expect(JSON.stringify(result)).not.toContain(PNG_1X1.toString('base64'));
    expect(invocation.toolLocations()).toEqual([{ path: imagePath }]);
  });

  it('refuses to execute inside a fork subagent', async () => {
    const imagePath = path.join(workspace, 'pixel.png');
    await fs.writeFile(imagePath, PNG_1X1);

    const invocation = tool.build({ file_path: imagePath });
    const result = await runInForkContext(() =>
      invocation.execute(new AbortController().signal),
    );

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(result.llmContent).toContain('main agent');
    expect(result.returnDisplay).not.toHaveProperty('type', 'terminal_image');
  });

  it('requires an absolute workspace path', () => {
    expect(() => tool.build({ file_path: 'pixel.png' })).toThrow(
      /must be absolute/,
    );
    expect(() =>
      tool.build({ file_path: path.join(os.tmpdir(), 'outside.png') }),
    ).toThrow(/outside the current workspace/);
  });

  it('reports a renderer failure to the model and TUI', async () => {
    const imagePath = path.join(workspace, 'pixel.png');
    await fs.writeFile(imagePath, PNG_1X1);
    tool = new DisplayImageTool({
      getTargetDir: () => workspace,
      getWorkspaceContext: () => ({
        isPathWithinWorkspace: () => true,
      }),
      getTerminalImageRenderSupport: async () => ({
        available: false,
        reason:
          'No compatible native image protocol was detected, and chafa is not installed.',
      }),
    } as unknown as Config);

    const result = await tool
      .build({ file_path: imagePath })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(result.llmContent).toContain('The image was not displayed');
    expect(result.returnDisplay).toContain('The image was not displayed');
    expect(result.returnDisplay).not.toHaveProperty('type', 'terminal_image');
  });

  it('rejects missing files and directories', async () => {
    const missing = await tool
      .build({ file_path: path.join(workspace, 'missing.png') })
      .execute(new AbortController().signal);
    expect(missing.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);

    const directory = await tool
      .build({ file_path: workspace })
      .execute(new AbortController().signal);
    expect(directory.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
  });

  it('rejects non-PNG and oversized files', async () => {
    const textPath = path.join(workspace, 'not-an-image.png');
    await fs.writeFile(textPath, Buffer.from(`GIF89a${'x'.repeat(32)}`));
    const nonPng = await tool
      .build({ file_path: textPath })
      .execute(new AbortController().signal);
    expect(nonPng.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);

    const largePath = path.join(workspace, 'large.png');
    const handle = await fs.open(largePath, 'w');
    await handle.truncate(MAX_TERMINAL_IMAGE_BYTES + 1);
    await handle.close();
    const oversized = await tool
      .build({ file_path: largePath })
      .execute(new AbortController().signal);
    expect(oversized.error?.type).toBe(ToolErrorType.FILE_TOO_LARGE);
  });

  it('rejects a truncated PNG header', async () => {
    const truncatedPath = path.join(workspace, 'truncated.png');
    await fs.writeFile(truncatedPath, Buffer.from('89504e470d0a1a0a', 'hex'));

    const result = await tool
      .build({ file_path: truncatedPath })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
  });
});
