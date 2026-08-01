/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  MAX_TERMINAL_IMAGE_BYTES,
  type TerminalImageRenderSupport,
  type TerminalImageDisplay,
} from '@qwen-code/qwen-code-core';
import {
  buildKittyPlaceholder,
  createRendererChildEnv,
  encodeKittyVirtualImage,
  findExecutable,
  readPngSize,
  shouldRunThroughShell,
  type KittyImagePlaceholder,
} from './mermaidImageRenderer.js';

const CHAFA_TIMEOUT_MS = 8000;
const CHAFA_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_WIDTH_CELLS = 72;
const MAX_PREVIEW_ROWS = 24;
const ESTIMATED_CELL_WIDTH_PX = 8;
const ESTIMATED_CELL_HEIGHT_PX = 16;

export type TerminalImageRenderResult =
  | {
      kind: 'kitty';
      sequence: string;
      placeholder: KittyImagePlaceholder;
    }
  | { kind: 'ansi'; lines: string[] }
  | { kind: 'unavailable'; reason: string };

export interface TerminalImageRenderOptions {
  display: TerminalImageDisplay;
  contentWidth: number;
  availableTerminalHeight?: number;
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
}

export function supportsKittyImageProtocol(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY = process.stdout.isTTY,
): boolean {
  if (!stdoutIsTTY || env['TMUX'] || env['SSH_TTY'] || env['SSH_CLIENT']) {
    return false;
  }

  const term = env['TERM']?.toLowerCase() ?? '';
  const termProgram = env['TERM_PROGRAM']?.toLowerCase() ?? '';
  if (termProgram === 'warpterminal') {
    return false;
  }

  return Boolean(
    env['KITTY_WINDOW_ID'] ||
      term.includes('kitty') ||
      termProgram.includes('ghostty'),
  );
}

export function getTerminalImageRenderSupport(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY = process.stdout.isTTY,
): TerminalImageRenderSupport {
  if (supportsKittyImageProtocol(env, stdoutIsTTY)) {
    return { available: true };
  }

  // Detect chafa with a PATH lookup instead of rendering the user's image:
  // this runs during display_image execution and must never spawn a
  // synchronous subprocess. A render failure still surfaces later, as a
  // fallback notice, when renderTerminalImage actually runs chafa.
  return findExecutable('chafa', env)
    ? { available: true }
    : {
        available: false,
        reason:
          'No compatible native image protocol was detected, and chafa is not installed.',
      };
}

export function renderTerminalImage({
  display,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
  stdoutIsTTY = process.stdout.isTTY,
}: TerminalImageRenderOptions): TerminalImageRenderResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(display.filePath);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `Image file is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!stat.isFile()) {
    return {
      kind: 'unavailable',
      reason: 'Image path is not a regular file.',
    };
  }
  if (stat.size > MAX_TERMINAL_IMAGE_BYTES) {
    return {
      kind: 'unavailable',
      reason: `Image exceeds the ${MAX_TERMINAL_IMAGE_BYTES} byte display limit.`,
    };
  }

  let png: Buffer;
  try {
    png = fs.readFileSync(display.filePath);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `Unable to read image: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (png.length > MAX_TERMINAL_IMAGE_BYTES) {
    return {
      kind: 'unavailable',
      reason: `Image exceeds the ${MAX_TERMINAL_IMAGE_BYTES} byte display limit.`,
    };
  }
  const size = readPngSize(png);
  if (!size) {
    return { kind: 'unavailable', reason: 'Image is not a valid PNG.' };
  }

  const shape = fitImageToTerminal(size, contentWidth, availableTerminalHeight);
  if (supportsKittyImageProtocol(env, stdoutIsTTY)) {
    const imageId = createImageId(png, shape);
    return {
      kind: 'kitty',
      sequence: encodeKittyVirtualImage(
        png,
        imageId,
        shape.widthCells,
        shape.rows,
      ),
      placeholder: buildKittyPlaceholder(imageId, shape.widthCells, shape.rows),
    };
  }

  return renderWithChafa(display.filePath, shape, env);
}

function fitImageToTerminal(
  size: { width: number; height: number },
  contentWidth: number,
  availableTerminalHeight?: number,
): { widthCells: number; rows: number } {
  const maxWidthCells = Math.max(
    1,
    Math.min(Math.floor(contentWidth), MAX_PREVIEW_WIDTH_CELLS),
  );
  const maxRows = Math.max(
    1,
    Math.min(
      Math.floor(availableTerminalHeight ?? MAX_PREVIEW_ROWS),
      MAX_PREVIEW_ROWS,
    ),
  );
  const naturalWidthCells = Math.max(1, size.width / ESTIMATED_CELL_WIDTH_PX);
  const naturalRows = Math.max(1, size.height / ESTIMATED_CELL_HEIGHT_PX);
  const scale = Math.min(
    1,
    maxWidthCells / naturalWidthCells,
    maxRows / naturalRows,
  );

  return {
    widthCells: Math.max(
      1,
      Math.min(maxWidthCells, Math.floor(naturalWidthCells * scale)),
    ),
    rows: Math.max(1, Math.min(maxRows, Math.floor(naturalRows * scale))),
  };
}

function createImageId(
  png: Buffer,
  shape: { widthCells: number; rows: number },
): number {
  const hash = crypto
    .createHash('sha256')
    .update(png)
    .update('\0')
    .update(String(shape.widthCells))
    .update('\0')
    .update(String(shape.rows))
    .digest();
  const id = hash.readUIntBE(0, 3);
  return id === 0 ? 1 : id;
}

function renderWithChafa(
  filePath: string,
  shape: { widthCells: number; rows: number },
  env: NodeJS.ProcessEnv,
): Extract<TerminalImageRenderResult, { kind: 'ansi' | 'unavailable' }> {
  // Resolve chafa through the hardened lookup so a project-local
  // node_modules/.bin/chafa is never executed unless the user opted in, then
  // spawn the resolved path rather than a bare name resolved off PATH.
  const chafaPath = findExecutable('chafa', env);
  if (!chafaPath) {
    return {
      kind: 'unavailable',
      reason:
        'No compatible native image protocol was detected, and chafa is not installed.',
    };
  }
  try {
    const stdout = execFileSync(
      chafaPath,
      [
        '--animate=off',
        '--colors=256',
        '--format=symbols',
        '--symbols=block',
        `--size=${shape.widthCells}x${shape.rows}`,
        filePath,
      ],
      {
        encoding: 'utf8',
        env: createRendererChildEnv(env),
        shell: shouldRunThroughShell(chafaPath),
        maxBuffer: CHAFA_MAX_OUTPUT_BYTES,
        timeout: CHAFA_TIMEOUT_MS,
      },
    );
    const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
    return lines.length > 0
      ? { kind: 'ansi', lines }
      : { kind: 'unavailable', reason: 'chafa produced no output.' };
  } catch (error) {
    const execError = error as Error & {
      stderr?: Buffer | string;
    };
    return {
      kind: 'unavailable',
      reason:
        String(execError.stderr ?? '').trim() ||
        execError.message ||
        'chafa could not render the image.',
    };
  }
}
