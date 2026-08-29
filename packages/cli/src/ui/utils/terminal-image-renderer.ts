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
import { MAX_INLINE_IMAGE_ENCODED_LENGTH } from './inline-image-parts.js';

const CHAFA_TIMEOUT_MS = 8000;
const CHAFA_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_WIDTH_CELLS = 72;
const MAX_PREVIEW_ROWS = 24;
const ESTIMATED_CELL_WIDTH_PX = 8;
const ESTIMATED_CELL_HEIGHT_PX = 16;
const MAX_REASON_CHARS = 200;
const MAX_INLINE_IMAGE_DIMENSION = 1_000_000;
export const MAX_INLINE_IMAGE_PIXELS = 64_000_000;
// cmd.exe treats these as command separators / metacharacters. With shell:true
// Node forwards arguments unquoted, so a model-chosen path containing any of
// them is a command-injection vector through a .cmd/.bat chafa shim.
const CMD_SHELL_METACHARACTERS = /[&|<>^%"!()\n\r]/;

// Completed tool rows enter Ink's append-only Static region immediately, so
// rendering must stay synchronous. A terminal resize or a restored session
// re-renders every visible image, which would otherwise re-read the file and
// re-spawn chafa for each one. This cache makes those repeats cheap; it mirrors
// the bounded LRU the Mermaid renderer keeps for the same reason.
const RENDER_CACHE_LIMIT = 40;
const RENDER_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
const renderCache = new Map<string, TerminalImageRenderResult>();
let renderCacheBytes = 0;
const INLINE_DECODE_CACHE_LIMIT = 4;
const inlineDecodeCache = new Map<
  string,
  { png: Buffer; size: { width: number; height: number } }
>();

// A Kitty terminal keeps a transmitted image and redraws it from the placeholder
// cells alone. The live-row -> Static-row move and every resize remount
// TerminalImage, which would re-transmit the same base64 payload (megabytes at
// the size cap) even though the terminal already holds that image id. This
// session-scoped set remembers which render keys were written so a remount only
// re-emits the cheap placeholders. It is bounded so a long session cannot grow
// it without limit; evicting an old key costs at most a re-transmit, never a
// blank image, because the payload is rebuilt from the still-cached render.
export const TRANSMITTED_KEY_LIMIT = 256;
const transmittedKeys = new Set<string>();

export function wasKittyImageWritten(key: string): boolean {
  return transmittedKeys.has(key);
}

export function markKittyImageWritten(key: string): void {
  transmittedKeys.add(key);
  if (transmittedKeys.size > TRANSMITTED_KEY_LIMIT) {
    const oldest = transmittedKeys.values().next().value;
    if (oldest !== undefined) {
      transmittedKeys.delete(oldest);
    }
  }
}

export type TerminalImageRenderResult =
  | {
      kind: 'kitty';
      key: string;
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

export interface InlineTerminalImageRenderOptions {
  data: string;
  mimeType: string;
  contentWidth: number;
  availableTerminalHeight?: number;
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
  disabled?: boolean;
}

export interface PreparedInlineTerminalImage {
  fallbackText: string;
  result: TerminalImageRenderResult | null;
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

export function containsCmdShellMetacharacters(filePath: string): boolean {
  return CMD_SHELL_METACHARACTERS.test(filePath);
}

export function prepareInlineTerminalImage({
  data,
  mimeType,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
  stdoutIsTTY = process.stdout.isTTY,
  disabled = false,
}: InlineTerminalImageRenderOptions): PreparedInlineTerminalImage {
  const format = getImageFormat(mimeType);
  const emptyFallback = format ? `[image: ${format}]` : '[image]';
  if (format !== 'png') {
    return { fallbackText: emptyFallback, result: null };
  }

  const decoded = getDecodedInlinePng(data);
  if (!decoded) {
    return { fallbackText: emptyFallback, result: null };
  }
  const { png, size } = decoded;

  const fallbackText = `[image: ${size.width}x${size.height} png]`;
  if (disabled) {
    return { fallbackText, result: null };
  }

  const shape = fitImageToTerminal(size, contentWidth, availableTerminalHeight);
  const useKitty = supportsKittyImageProtocol(env, stdoutIsTTY);
  const chafaPath = useKitty ? null : findExecutable('chafa', env);
  const cacheKey = createInlineRenderCacheKey(png, shape, useKitty, chafaPath);
  const cached = getCachedRenderResult(cacheKey);
  if (cached) {
    return { fallbackText, result: cached };
  }

  const result: TerminalImageRenderResult = useKitty
    ? { ...renderKitty(png, shape), key: cacheKey }
    : renderWithChafa({ data: png }, shape, env, chafaPath);
  if (result.kind !== 'unavailable') {
    rememberRenderResult(cacheKey, result);
  }
  return { fallbackText, result };
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

  // Read only the 24-byte PNG header to size the preview and build the cache
  // key, so a cache hit never re-reads the full file or re-spawns chafa.
  const headerSize = readPngHeaderSize(display.filePath);
  if (!headerSize) {
    return { kind: 'unavailable', reason: 'Image is not a valid PNG.' };
  }

  const shape = fitImageToTerminal(
    headerSize,
    contentWidth,
    availableTerminalHeight,
  );
  const useKitty = supportsKittyImageProtocol(env, stdoutIsTTY);
  const chafaPath = useKitty ? null : findExecutable('chafa', env);
  const cacheKey = createRenderCacheKey(
    display.filePath,
    stat,
    shape,
    useKitty,
    chafaPath,
  );
  const cached = getCachedRenderResult(cacheKey);
  if (cached) return cached;

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

  const result: TerminalImageRenderResult = useKitty
    ? { ...renderKitty(png, shape), key: cacheKey }
    : renderWithChafa({ filePath: display.filePath }, shape, env, chafaPath);
  if (result.kind !== 'unavailable') {
    rememberRenderResult(cacheKey, result);
  }
  return result;
}

function readPngHeaderSize(
  filePath: string,
): { width: number; height: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(24);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return bytesRead === header.length ? readPngSize(header) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a read-only handle should not fail the render.
      }
    }
  }
}

function createRenderCacheKey(
  filePath: string,
  stat: fs.Stats,
  shape: { widthCells: number; rows: number },
  useKitty: boolean,
  chafaPath: string | null,
): string {
  return [
    filePath,
    stat.mtimeMs,
    stat.size,
    shape.widthCells,
    shape.rows,
    useKitty ? 'kitty' : (chafaPath ?? 'none'),
  ].join('\0');
}

function createInlineRenderCacheKey(
  png: Buffer,
  shape: { widthCells: number; rows: number },
  useKitty: boolean,
  chafaPath: string | null,
): string {
  return [
    'inline',
    crypto.createHash('sha256').update(png).digest('hex'),
    shape.widthCells,
    shape.rows,
    useKitty ? 'kitty' : (chafaPath ?? 'none'),
  ].join('\0');
}

function getImageFormat(mimeType: string): string | null {
  const match = /^image\/([a-z0-9][a-z0-9.+-]*)$/.exec(
    mimeType.trim().toLowerCase(),
  );
  return match?.[1] ?? null;
}

function decodeInlineImage(data: string): Buffer | null {
  if (data.length === 0 || data.length > MAX_INLINE_IMAGE_ENCODED_LENGTH) {
    return null;
  }

  const normalized = data.replace(/\s/g, '');
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    return null;
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (
    decoded.length === 0 ||
    decoded.length > MAX_TERMINAL_IMAGE_BYTES ||
    decoded.toString('base64').replace(/=+$/, '') !==
      normalized.replace(/=+$/, '')
  ) {
    return null;
  }
  return decoded;
}

function getDecodedInlinePng(
  data: string,
): { png: Buffer; size: { width: number; height: number } } | null {
  const cached = inlineDecodeCache.get(data);
  if (cached) {
    inlineDecodeCache.delete(data);
    inlineDecodeCache.set(data, cached);
    return cached;
  }

  const png = decodeInlineImage(data);
  if (!png) return null;
  const size = readValidatedInlinePngSize(png);
  if (!size) return null;

  const decoded = { png, size };
  inlineDecodeCache.set(data, decoded);
  while (inlineDecodeCache.size > INLINE_DECODE_CACHE_LIMIT) {
    const oldest = inlineDecodeCache.keys().next().value;
    if (oldest === undefined) break;
    inlineDecodeCache.delete(oldest);
  }
  return decoded;
}

function readValidatedInlinePngSize(
  png: Buffer,
): { width: number; height: number } | null {
  if (
    png.length < 24 ||
    png.readUInt32BE(8) !== 13 ||
    png.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return null;
  }
  const size = readPngSize(png);
  if (
    !size ||
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > MAX_INLINE_IMAGE_DIMENSION ||
    size.height > MAX_INLINE_IMAGE_DIMENSION ||
    size.width * size.height > MAX_INLINE_IMAGE_PIXELS
  ) {
    return null;
  }
  return size;
}

function getCachedRenderResult(
  key: string,
): TerminalImageRenderResult | undefined {
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
  }
  return cached;
}

function rememberRenderResult(
  key: string,
  result: TerminalImageRenderResult,
): void {
  const bytes = estimateRenderResultBytes(result);
  if (bytes > RENDER_CACHE_BYTE_LIMIT) {
    renderCache.delete(key);
    return;
  }

  const existing = renderCache.get(key);
  if (existing) {
    renderCacheBytes -= estimateRenderResultBytes(existing);
  }
  renderCache.set(key, result);
  renderCacheBytes += bytes;
  while (
    renderCache.size > RENDER_CACHE_LIMIT ||
    renderCacheBytes > RENDER_CACHE_BYTE_LIMIT
  ) {
    const oldest = renderCache.keys().next().value;
    if (!oldest) break;
    const oldestResult = renderCache.get(oldest);
    if (oldestResult) {
      renderCacheBytes -= estimateRenderResultBytes(oldestResult);
    }
    renderCache.delete(oldest);
  }
}

function estimateRenderResultBytes(result: TerminalImageRenderResult): number {
  switch (result.kind) {
    case 'kitty':
      return (
        Buffer.byteLength(result.sequence, 'utf8') +
        result.placeholder.lines.reduce(
          (total, line) => total + Buffer.byteLength(line, 'utf8'),
          0,
        )
      );
    case 'ansi':
      return result.lines.reduce(
        (total, line) => total + Buffer.byteLength(line, 'utf8'),
        0,
      );
    case 'unavailable':
      return Buffer.byteLength(result.reason, 'utf8');
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
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

function renderKitty(
  png: Buffer,
  shape: { widthCells: number; rows: number },
): Omit<Extract<TerminalImageRenderResult, { kind: 'kitty' }>, 'key'> {
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

type ChafaImageSource = { filePath: string } | { data: Buffer };

function renderWithChafa(
  source: ChafaImageSource,
  shape: { widthCells: number; rows: number },
  env: NodeJS.ProcessEnv,
  chafaPath: string | null,
): Extract<TerminalImageRenderResult, { kind: 'ansi' | 'unavailable' }> {
  // Resolve chafa through the hardened lookup so a project-local
  // node_modules/.bin/chafa is never executed unless the user opted in, then
  // spawn the resolved path rather than a bare name resolved off PATH.
  if (!chafaPath) {
    return {
      kind: 'unavailable',
      reason:
        'No compatible native image protocol was detected, and chafa is not installed.',
    };
  }
  const useShell = shouldRunThroughShell(chafaPath);
  if (
    useShell &&
    'filePath' in source &&
    containsCmdShellMetacharacters(source.filePath)
  ) {
    return {
      kind: 'unavailable',
      reason:
        'Image path contains characters that cannot be safely passed to the renderer on this platform.',
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
        'filePath' in source ? source.filePath : '-',
      ],
      {
        encoding: 'utf8',
        env: createRendererChildEnv(env),
        shell: useShell,
        maxBuffer: CHAFA_MAX_OUTPUT_BYTES,
        timeout: CHAFA_TIMEOUT_MS,
        ...('data' in source ? { input: source.data } : {}),
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
    const stderr = firstLineBounded(String(execError.stderr ?? '').trim());
    return {
      kind: 'unavailable',
      reason:
        stderr || execError.message || 'chafa could not render the image.',
    };
  }
}

function firstLineBounded(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.length > MAX_REASON_CHARS
    ? `${firstLine.slice(0, MAX_REASON_CHARS)}…`
    : firstLine;
}
