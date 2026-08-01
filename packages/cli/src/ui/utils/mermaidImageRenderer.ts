/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export type TerminalImageProtocol = 'kitty' | 'iterm2';

export interface MermaidImageRenderOptions {
  source: string;
  contentWidth: number;
  availableTerminalHeight?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface MermaidTerminalImageResult {
  kind: 'terminal-image';
  title: string;
  sequence: string;
  rows: number;
  protocol: TerminalImageProtocol;
  placeholder?: KittyImagePlaceholder;
}

export interface MermaidAnsiImageResult {
  kind: 'ansi';
  title: string;
  lines: string[];
}

export interface MermaidImageUnavailableResult {
  kind: 'unavailable';
  reason: string;
  showReason?: boolean;
}

export type MermaidImageRenderResult =
  | MermaidTerminalImageResult
  | MermaidAnsiImageResult
  | MermaidImageUnavailableResult;

interface PngSize {
  width: number;
  height: number;
}

export interface KittyImagePlaceholder {
  color: string;
  imageId: number;
  lines: string[];
}

const CACHE_LIMIT = 40;
const PNG_CACHE_LIMIT = 20;
const CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
const PNG_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
const DEFAULT_RENDER_TIMEOUT_MS = 8000;
const DEFAULT_MERMAID_RENDER_WIDTH = 1280;
const MAX_MERMAID_PNG_BYTES = 8 * 1024 * 1024;
const MAX_RENDERER_OUTPUT_CHARS = 16 * 1024;
const MAX_RENDER_TIMEOUT_MS = 60_000;
const OUTPUT_TRUNCATION_MARKER = '\n... renderer output truncated ...';
const NPX_MERMAID_CLI = 'npx:@mermaid-js/mermaid-cli@11.12.0';
const PNG_SIGNATURE = '89504e470d0a1a0a';
const KITTY_PLACEHOLDER = '\u{10EEEE}';
const RENDERER_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'LOCALAPPDATA',
  'APPDATA',
  'CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'PUPPETEER_CACHE_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
] as const;
const KITTY_PLACEHOLDER_DIACRITICS = [
  '\u{305}',
  '\u{30D}',
  '\u{30E}',
  '\u{310}',
  '\u{312}',
  '\u{33D}',
  '\u{33E}',
  '\u{33F}',
  '\u{346}',
  '\u{34A}',
  '\u{34B}',
  '\u{34C}',
  '\u{350}',
  '\u{351}',
  '\u{352}',
  '\u{357}',
  '\u{35B}',
  '\u{363}',
  '\u{364}',
  '\u{365}',
  '\u{366}',
  '\u{367}',
  '\u{368}',
  '\u{369}',
  '\u{36A}',
  '\u{36B}',
  '\u{36C}',
  '\u{36D}',
  '\u{36E}',
  '\u{36F}',
  '\u{483}',
  '\u{484}',
  '\u{485}',
  '\u{486}',
  '\u{487}',
  '\u{592}',
  '\u{593}',
  '\u{594}',
  '\u{595}',
  '\u{597}',
  '\u{598}',
  '\u{599}',
  '\u{59C}',
  '\u{59D}',
  '\u{59E}',
  '\u{59F}',
  '\u{5A0}',
  '\u{5A1}',
  '\u{5A8}',
  '\u{5A9}',
  '\u{5AB}',
  '\u{5AC}',
  '\u{5AF}',
  '\u{5C4}',
  '\u{610}',
  '\u{611}',
  '\u{612}',
  '\u{613}',
  '\u{614}',
  '\u{615}',
  '\u{616}',
  '\u{617}',
  '\u{657}',
  '\u{658}',
  '\u{659}',
  '\u{65A}',
  '\u{65B}',
  '\u{65D}',
  '\u{65E}',
  '\u{6D6}',
  '\u{6D7}',
  '\u{6D8}',
  '\u{6D9}',
  '\u{6DA}',
  '\u{6DB}',
  '\u{6DC}',
  '\u{6DF}',
  '\u{6E0}',
  '\u{6E1}',
  '\u{6E2}',
  '\u{6E4}',
  '\u{6E7}',
  '\u{6E8}',
  '\u{6EB}',
  '\u{6EC}',
  '\u{730}',
  '\u{732}',
  '\u{733}',
  '\u{735}',
  '\u{736}',
  '\u{73A}',
  '\u{73D}',
  '\u{73F}',
  '\u{740}',
  '\u{741}',
  '\u{743}',
  '\u{745}',
  '\u{747}',
  '\u{749}',
  '\u{74A}',
  '\u{7EB}',
  '\u{7EC}',
  '\u{7ED}',
  '\u{7EE}',
  '\u{7EF}',
  '\u{7F0}',
  '\u{7F1}',
  '\u{7F3}',
  '\u{816}',
  '\u{817}',
  '\u{818}',
  '\u{819}',
  '\u{81B}',
  '\u{81C}',
  '\u{81D}',
  '\u{81E}',
  '\u{81F}',
  '\u{820}',
  '\u{821}',
  '\u{822}',
  '\u{823}',
  '\u{825}',
  '\u{826}',
  '\u{827}',
  '\u{829}',
  '\u{82A}',
  '\u{82B}',
  '\u{82C}',
];
const cachedResults = new Map<string, MermaidImageRenderResult>();
const cachedPngResults = new Map<
  string,
  { ok: true; png: Buffer } | { ok: false; error: string }
>();
let cachedResultsBytes = 0;
let cachedPngResultsBytes = 0;

export function detectTerminalImageProtocol(
  env: NodeJS.ProcessEnv = process.env,
): TerminalImageProtocol | null {
  if (env['QWEN_CODE_DISABLE_MERMAID_IMAGES'] === '1') {
    return null;
  }

  const forced = env['QWEN_CODE_MERMAID_IMAGE_PROTOCOL']?.toLowerCase();
  if (forced === 'off' || forced === 'none' || forced === '0') {
    return null;
  }

  if (
    !process.stdout.isTTY ||
    env['TMUX'] ||
    env['SSH_TTY'] ||
    env['SSH_CLIENT']
  ) {
    return null;
  }

  if (forced) {
    if (forced === 'kitty') return 'kitty';
    if (forced === 'iterm' || forced === 'iterm2') return 'iterm2';
  }

  const term = env['TERM']?.toLowerCase() ?? '';
  const termProgram = env['TERM_PROGRAM']?.toLowerCase() ?? '';

  if (
    env['KITTY_WINDOW_ID'] ||
    term.includes('kitty') ||
    termProgram.includes('ghostty')
  ) {
    return 'kitty';
  }

  if (termProgram === 'iterm.app' || termProgram.includes('wezterm')) {
    return 'iterm2';
  }

  return null;
}

export function encodeITerm2InlineImage(
  png: Buffer,
  widthCells: number,
  rows: number,
): string {
  return `\u001b]1337;File=inline=1;width=${widthCells};height=${rows};preserveAspectRatio=1:${png.toString(
    'base64',
  )}\u0007`;
}

export function encodeKittyImage(
  png: Buffer,
  widthCells: number,
  rows: number,
): string {
  return encodeKittyImageCommand(png, `a=T,f=100,c=${widthCells},r=${rows}`);
}

export function encodeKittyVirtualImage(
  png: Buffer,
  imageId: number,
  widthCells: number,
  rows: number,
): string {
  return encodeKittyImageCommand(
    png,
    `a=T,f=100,i=${imageId},q=2,U=1,c=${widthCells},r=${rows}`,
  );
}

function encodeKittyImageCommand(png: Buffer, firstControl: string): string {
  const encoded = png.toString('base64');
  const chunkSize = 4096;
  const chunks: string[] = [];

  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    const chunk = encoded.slice(offset, offset + chunkSize);
    const hasMore = offset + chunkSize < encoded.length;
    const control =
      offset === 0
        ? `${firstControl},m=${hasMore ? 1 : 0}`
        : `m=${hasMore ? 1 : 0}`;
    chunks.push(`\u001b_G${control};${chunk}\u001b\\`);
  }

  return chunks.join('');
}

export function buildKittyPlaceholder(
  imageId: number,
  widthCells: number,
  rows: number,
): KittyImagePlaceholder {
  const clampedRows = Math.min(rows, KITTY_PLACEHOLDER_DIACRITICS.length);
  const clampedWidth = Math.min(
    widthCells,
    KITTY_PLACEHOLDER_DIACRITICS.length,
  );
  const lines = Array.from({ length: clampedRows }, (_, row) => {
    const rowDiacritic = KITTY_PLACEHOLDER_DIACRITICS[row];
    const cells = Array.from({ length: clampedWidth }, (_, column) => {
      const columnDiacritic = KITTY_PLACEHOLDER_DIACRITICS[column];
      return `${KITTY_PLACEHOLDER}${rowDiacritic}${columnDiacritic}`;
    });
    return cells.join('');
  });

  return {
    color: `#${imageId.toString(16).padStart(6, '0')}`,
    imageId,
    lines,
  };
}

export function readPngSize(png: Buffer): PngSize | null {
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    return null;
  }

  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

function isMermaidImageRenderingDisabled(env: NodeJS.ProcessEnv): boolean {
  return env['QWEN_CODE_DISABLE_MERMAID_IMAGES'] === '1';
}

function unavailableImageRenderingDisabled(): MermaidImageUnavailableResult {
  return {
    kind: 'unavailable',
    reason:
      'Mermaid image rendering is disabled via QWEN_CODE_DISABLE_MERMAID_IMAGES.',
  };
}

/**
 * @internal Test-oriented sync renderer; the interactive TUI uses the async
 * renderer to keep external processes outside React render.
 */
export function renderMermaidImageSync({
  source,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
}: MermaidImageRenderOptions): MermaidImageRenderResult {
  if (isMermaidImageRenderingDisabled(env)) {
    return unavailableImageRenderingDisabled();
  }

  const imageRendering = env['QWEN_CODE_MERMAID_IMAGE_RENDERING'];
  if (
    imageRendering !== '1' &&
    imageRendering?.toLowerCase() !== 'on' &&
    imageRendering?.toLowerCase() !== 'true'
  ) {
    return {
      kind: 'unavailable',
      reason:
        'Mermaid image rendering is disabled by default. Set QWEN_CODE_MERMAID_IMAGE_RENDERING=1 to enable external renderers.',
      showReason: false,
    };
  }

  const protocol = detectTerminalImageProtocol(env);
  const chafa = protocol ? null : findExecutable('chafa', env);
  if (!protocol && !chafa) {
    return {
      kind: 'unavailable',
      reason:
        'No supported terminal image protocol or chafa renderer was detected.',
    };
  }

  const mmdc = findMmdc(env);
  if (!mmdc) {
    return {
      kind: 'unavailable',
      reason:
        'Mermaid CLI (mmdc) was not found. Install @mermaid-js/mermaid-cli, set QWEN_CODE_MERMAID_MMD_CLI, or set QWEN_CODE_MERMAID_ALLOW_NPX=1.',
    };
  }

  const cacheKey = createCacheKey(
    source,
    contentWidth,
    availableTerminalHeight,
    protocol ?? `chafa:${chafa}`,
    mmdc,
    env,
  );
  const cached = getResultCache(cacheKey);
  if (cached) return cached;

  const pngCacheKey = createPngCacheKey(source, mmdc, env);
  const cachedPng = getPngCache(pngCacheKey);
  const rendered =
    cachedPng ?? rememberPng(pngCacheKey, renderPngWithMmdc(source, mmdc, env));
  if (!rendered.ok) {
    return remember(cacheKey, {
      kind: 'unavailable',
      reason: rendered.error,
    });
  }

  const pngSize = readPngSize(rendered.png);
  if (!pngSize) {
    return remember(cacheKey, {
      kind: 'unavailable',
      reason: 'Mermaid CLI did not produce a valid PNG.',
    });
  }

  const imageShape = fitImageToTerminal(
    pngSize,
    contentWidth,
    availableTerminalHeight,
    env,
  );

  if (protocol) {
    const imageId =
      protocol === 'kitty'
        ? createKittyImageId(rendered.png, imageShape)
        : undefined;
    const sequence =
      protocol === 'kitty'
        ? encodeKittyVirtualImage(
            rendered.png,
            imageId!,
            imageShape.widthCells,
            imageShape.rows,
          )
        : encodeITerm2InlineImage(
            rendered.png,
            imageShape.widthCells,
            imageShape.rows,
          );
    return remember(cacheKey, {
      kind: 'terminal-image',
      title: `Mermaid diagram image (${protocol})`,
      sequence,
      rows: imageShape.rows,
      protocol,
      placeholder:
        protocol === 'kitty'
          ? buildKittyPlaceholder(
              imageId!,
              imageShape.widthCells,
              imageShape.rows,
            )
          : undefined,
    });
  }

  const ansi = renderPngWithChafa(
    rendered.png,
    imageShape.widthCells,
    imageShape.rows,
    chafa!,
    env,
  );
  if (!ansi.ok) {
    return remember(cacheKey, {
      kind: 'unavailable',
      reason: ansi.error,
    });
  }

  return remember(cacheKey, {
    kind: 'ansi',
    title: 'Mermaid diagram image (ANSI)',
    lines: ansi.output.split(/\r?\n/).filter((line) => line.length > 0),
  });
}

export async function renderMermaidImageAsync({
  source,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
  signal,
}: MermaidImageRenderOptions): Promise<MermaidImageRenderResult> {
  if (isMermaidImageRenderingDisabled(env)) {
    return unavailableImageRenderingDisabled();
  }

  const imageRendering = env['QWEN_CODE_MERMAID_IMAGE_RENDERING'];
  if (
    imageRendering !== '1' &&
    imageRendering?.toLowerCase() !== 'on' &&
    imageRendering?.toLowerCase() !== 'true'
  ) {
    return {
      kind: 'unavailable',
      reason:
        'Mermaid image rendering is disabled by default. Set QWEN_CODE_MERMAID_IMAGE_RENDERING=1 to enable external renderers.',
      showReason: false,
    };
  }

  const protocol = detectTerminalImageProtocol(env);
  if (protocol === 'iterm2') {
    return {
      kind: 'unavailable',
      reason:
        'iTerm2 inline image rendering is disabled in the async TUI path to avoid cursor-position races.',
      showReason: false,
    };
  }

  const chafa = protocol ? null : findExecutable('chafa', env);
  if (!protocol && !chafa) {
    return {
      kind: 'unavailable',
      reason:
        'No supported terminal image protocol or chafa renderer was detected.',
    };
  }

  const mmdc = findMmdc(env);
  if (!mmdc) {
    return {
      kind: 'unavailable',
      reason:
        'Mermaid CLI (mmdc) was not found. Install @mermaid-js/mermaid-cli, set QWEN_CODE_MERMAID_MMD_CLI, or set QWEN_CODE_MERMAID_ALLOW_NPX=1.',
    };
  }

  const cacheKey = createCacheKey(
    source,
    contentWidth,
    availableTerminalHeight,
    protocol ?? `chafa:${chafa}`,
    mmdc,
    env,
  );
  const cached = getResultCache(cacheKey);
  if (cached) return cached;

  const pngCacheKey = createPngCacheKey(source, mmdc, env);
  const cachedPng = getPngCache(pngCacheKey);
  let rendered = cachedPng;
  if (!rendered) {
    const nextRendered = await renderPngWithMmdcAsync(
      source,
      mmdc,
      env,
      signal,
    );
    rendered = signal?.aborted
      ? nextRendered
      : rememberPng(pngCacheKey, nextRendered);
  }
  if (!rendered.ok) {
    if (signal?.aborted) {
      return {
        kind: 'unavailable',
        reason: rendered.error,
      };
    }
    return remember(cacheKey, {
      kind: 'unavailable',
      reason: rendered.error,
    });
  }

  const pngSize = readPngSize(rendered.png);
  if (!pngSize) {
    return remember(cacheKey, {
      kind: 'unavailable',
      reason: 'Mermaid CLI did not produce a valid PNG.',
    });
  }

  const imageShape = fitImageToTerminal(
    pngSize,
    contentWidth,
    availableTerminalHeight,
    env,
  );

  if (protocol) {
    const imageId =
      protocol === 'kitty'
        ? createKittyImageId(rendered.png, imageShape)
        : undefined;
    const sequence =
      protocol === 'kitty'
        ? encodeKittyVirtualImage(
            rendered.png,
            imageId!,
            imageShape.widthCells,
            imageShape.rows,
          )
        : encodeITerm2InlineImage(
            rendered.png,
            imageShape.widthCells,
            imageShape.rows,
          );
    return remember(cacheKey, {
      kind: 'terminal-image',
      title: `Mermaid diagram image (${protocol})`,
      sequence,
      rows: imageShape.rows,
      protocol,
      placeholder:
        protocol === 'kitty'
          ? buildKittyPlaceholder(
              imageId!,
              imageShape.widthCells,
              imageShape.rows,
            )
          : undefined,
    });
  }

  const ansi = await renderPngWithChafaAsync(
    rendered.png,
    imageShape.widthCells,
    imageShape.rows,
    chafa!,
    env,
    signal,
  );
  if (!ansi.ok) {
    if (signal?.aborted) {
      return {
        kind: 'unavailable',
        reason: ansi.error,
      };
    }
    return remember(cacheKey, {
      kind: 'unavailable',
      reason: ansi.error,
    });
  }

  return remember(cacheKey, {
    kind: 'ansi',
    title: 'Mermaid diagram image (ANSI)',
    lines: ansi.output.split(/\r?\n/).filter((line) => line.length > 0),
  });
}

function createKittyImageId(
  png: Buffer,
  imageShape: { widthCells: number; rows: number },
): number {
  const hash = crypto
    .createHash('sha256')
    .update(png)
    .update('\0')
    .update(String(imageShape.widthCells))
    .update('\0')
    .update(String(imageShape.rows))
    .digest();
  const id = hash.readUIntBE(0, 3);
  return id === 0 ? 1 : id;
}

function getResultCache(key: string): MermaidImageRenderResult | undefined {
  const cached = cachedResults.get(key);
  if (cached) {
    cachedResults.delete(key);
    cachedResults.set(key, cached);
  }
  return cached;
}

function getPngCache(
  key: string,
): { ok: true; png: Buffer } | { ok: false; error: string } | undefined {
  const cached = cachedPngResults.get(key);
  if (cached) {
    cachedPngResults.delete(key);
    cachedPngResults.set(key, cached);
  }
  return cached;
}

function createPngCacheKey(
  source: string,
  mmdc: string,
  env: NodeJS.ProcessEnv,
): string {
  return crypto
    .createHash('sha256')
    .update(source)
    .update('\0')
    .update(mmdc)
    .update('\0')
    .update(String(getMermaidRenderWidth(env)))
    .digest('hex');
}

function createCacheKey(
  source: string,
  contentWidth: number,
  availableTerminalHeight: number | undefined,
  renderer: string,
  mmdc: string,
  env: NodeJS.ProcessEnv,
): string {
  return crypto
    .createHash('sha256')
    .update(source)
    .update('\0')
    .update(String(contentWidth))
    .update('\0')
    .update(String(availableTerminalHeight ?? 'auto'))
    .update('\0')
    .update(renderer)
    .update('\0')
    .update(mmdc)
    .update('\0')
    .update(String(getMermaidCellAspectRatio(env)))
    .digest('hex');
}

function remember<T extends MermaidImageRenderResult>(
  key: string,
  result: T,
): T {
  const resultBytes = estimateResultBytes(result);
  if (resultBytes > CACHE_BYTE_LIMIT) {
    cachedResults.delete(key);
    return result;
  }

  const existing = cachedResults.get(key);
  if (existing) {
    cachedResultsBytes -= estimateResultBytes(existing);
  }
  cachedResults.set(key, result);
  cachedResultsBytes += resultBytes;
  while (
    cachedResults.size > CACHE_LIMIT ||
    cachedResultsBytes > CACHE_BYTE_LIMIT
  ) {
    const oldest = cachedResults.keys().next().value;
    if (!oldest) break;
    const oldestResult = cachedResults.get(oldest);
    if (oldestResult) {
      cachedResultsBytes -= estimateResultBytes(oldestResult);
    }
    cachedResults.delete(oldest);
  }
  return result;
}

function rememberPng<
  T extends { ok: true; png: Buffer } | { ok: false; error: string },
>(key: string, result: T): T {
  const resultBytes = estimatePngResultBytes(result);
  if (resultBytes > PNG_CACHE_BYTE_LIMIT) {
    cachedPngResults.delete(key);
    return result;
  }

  const existing = cachedPngResults.get(key);
  if (existing) {
    cachedPngResultsBytes -= estimatePngResultBytes(existing);
  }
  cachedPngResults.set(key, result);
  cachedPngResultsBytes += resultBytes;
  while (
    cachedPngResults.size > PNG_CACHE_LIMIT ||
    cachedPngResultsBytes > PNG_CACHE_BYTE_LIMIT
  ) {
    const oldest = cachedPngResults.keys().next().value;
    if (!oldest) break;
    const oldestResult = cachedPngResults.get(oldest);
    if (oldestResult) {
      cachedPngResultsBytes -= estimatePngResultBytes(oldestResult);
    }
    cachedPngResults.delete(oldest);
  }
  return result;
}

function estimateResultBytes(result: MermaidImageRenderResult): number {
  switch (result.kind) {
    case 'terminal-image':
      return (
        Buffer.byteLength(result.sequence, 'utf8') +
        (result.placeholder?.lines.reduce(
          (total, line) => total + Buffer.byteLength(line, 'utf8'),
          0,
        ) ?? 0)
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

function estimatePngResultBytes(
  result: { ok: true; png: Buffer } | { ok: false; error: string },
): number {
  return result.ok ? result.png.byteLength : Buffer.byteLength(result.error);
}

function findMmdc(env: NodeJS.ProcessEnv): string | null {
  const explicit = env['QWEN_CODE_MERMAID_MMD_CLI'];
  if (explicit && isExecutable(explicit)) return explicit;

  const mmdc = findExecutable('mmdc', env);
  if (mmdc) return mmdc;

  if (
    env['QWEN_CODE_MERMAID_ALLOW_NPX'] === '1' &&
    findExecutable('npx', env)
  ) {
    return NPX_MERMAID_CLI;
  }

  return null;
}

function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const candidates: string[] = [];
  const extensions =
    process.platform === 'win32'
      ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

  const addCandidates = (dir: string) => {
    for (const extension of extensions) {
      candidates.push(path.join(dir, `${command}${extension}`));
    }
  };

  const allowLocalRenderers =
    env['QWEN_CODE_MERMAID_ALLOW_LOCAL_RENDERERS'] === '1';
  const localRendererDir = normalizeExecutableDir(
    process.cwd(),
    'node_modules',
    '.bin',
  );

  if (allowLocalRenderers) {
    addCandidates(localRendererDir);
  }
  for (const dir of (env['PATH'] ?? '').split(path.delimiter).filter(Boolean)) {
    const normalizedDir = normalizeExecutableDir(dir);
    if (
      !allowLocalRenderers &&
      (normalizedDir === localRendererDir ||
        normalizedDir.endsWith(`${path.sep}node_modules${path.sep}.bin`))
    ) {
      continue;
    }
    addCandidates(dir);
  }

  return candidates.find(isExecutable) ?? null;
}

function normalizeExecutableDir(...segments: string[]): string {
  const dir = path.resolve(...segments);
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function renderPngWithMmdc(
  source: string,
  mmdc: string,
  env: NodeJS.ProcessEnv,
): { ok: true; png: Buffer } | { ok: false; error: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mermaid-'));
  const inputPath = path.join(tempDir, 'diagram.mmd');
  const outputPath = path.join(tempDir, 'diagram.png');
  const renderWidth = getMermaidRenderWidth(env);

  try {
    fs.writeFileSync(inputPath, source, 'utf8');
    const mmdcArgs = [
      '-i',
      inputPath,
      '-o',
      outputPath,
      '-b',
      'transparent',
      '-w',
      String(renderWidth),
    ];
    const command =
      mmdc === NPX_MERMAID_CLI ? findExecutable('npx', env)! : mmdc;
    const args =
      mmdc === NPX_MERMAID_CLI
        ? ['-y', '@mermaid-js/mermaid-cli@11.12.0', ...mmdcArgs]
        : mmdcArgs;
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: createRendererChildEnv(env),
      shell: shouldRunThroughShell(command),
      timeout: getMermaidRenderTimeout(env),
    });

    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      return {
        ok: false,
        error: stderr || `Mermaid CLI exited with status ${result.status}.`,
      };
    }
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: 'Mermaid CLI did not write an output file.' };
    }
    const outputSize = fs.statSync(outputPath).size;
    if (outputSize > MAX_MERMAID_PNG_BYTES) {
      return {
        ok: false,
        error: `Mermaid CLI output exceeded ${MAX_MERMAID_PNG_BYTES} bytes.`,
      };
    }

    return { ok: true, png: fs.readFileSync(outputPath) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function renderPngWithMmdcAsync(
  source: string,
  mmdc: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ ok: true; png: Buffer } | { ok: false; error: string }> {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'qwen-mermaid-'),
  );
  const inputPath = path.join(tempDir, 'diagram.mmd');
  const outputPath = path.join(tempDir, 'diagram.png');
  const renderWidth = getMermaidRenderWidth(env);

  try {
    await fs.promises.writeFile(inputPath, source, 'utf8');
    const mmdcArgs = [
      '-i',
      inputPath,
      '-o',
      outputPath,
      '-b',
      'transparent',
      '-w',
      String(renderWidth),
    ];
    const command =
      mmdc === NPX_MERMAID_CLI ? findExecutable('npx', env)! : mmdc;
    const args =
      mmdc === NPX_MERMAID_CLI
        ? ['-y', '@mermaid-js/mermaid-cli@11.12.0', ...mmdcArgs]
        : mmdcArgs;
    const result = await runCommand(command, args, {
      env: createRendererChildEnv(env),
      shell: shouldRunThroughShell(command),
      timeout: getMermaidRenderTimeout(env),
      signal,
    });

    if (result.error) {
      return { ok: false, error: result.error };
    }
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      return {
        ok: false,
        error: stderr || `Mermaid CLI exited with status ${result.status}.`,
      };
    }

    let outputSize: number;
    try {
      outputSize = (await fs.promises.stat(outputPath)).size;
    } catch {
      return { ok: false, error: 'Mermaid CLI did not write an output file.' };
    }
    if (outputSize > MAX_MERMAID_PNG_BYTES) {
      return {
        ok: false,
        error: `Mermaid CLI output exceeded ${MAX_MERMAID_PNG_BYTES} bytes.`,
      };
    }

    return { ok: true, png: await fs.promises.readFile(outputPath) };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function shouldRunThroughShell(command: string): boolean {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

function getMermaidRenderWidth(env: NodeJS.ProcessEnv): number {
  const configuredWidth = Number(env['QWEN_CODE_MERMAID_RENDER_WIDTH']);
  if (Number.isFinite(configuredWidth) && configuredWidth > 0) {
    return Math.max(320, Math.min(1800, Math.round(configuredWidth)));
  }
  return DEFAULT_MERMAID_RENDER_WIDTH;
}

function getMermaidRenderTimeout(env: NodeJS.ProcessEnv): number {
  const configuredTimeout = Number(env['QWEN_CODE_MERMAID_RENDER_TIMEOUT_MS']);
  if (Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
    return Math.min(Math.round(configuredTimeout), MAX_RENDER_TIMEOUT_MS);
  }
  return DEFAULT_RENDER_TIMEOUT_MS;
}

function createRendererChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sourceEnv = { ...process.env, ...env };
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of RENDERER_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  return childEnv;
}

function getMermaidCellAspectRatio(env: NodeJS.ProcessEnv): number {
  const configuredAspectRatio = Number(
    env['QWEN_CODE_MERMAID_CELL_ASPECT_RATIO'],
  );
  if (Number.isFinite(configuredAspectRatio) && configuredAspectRatio > 0) {
    return Math.max(0.2, Math.min(configuredAspectRatio, 2));
  }
  return 0.5;
}

function renderPngWithChafa(
  png: Buffer,
  widthCells: number,
  rows: number,
  chafa: string,
  env: NodeJS.ProcessEnv,
): { ok: true; output: string } | { ok: false; error: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mermaid-'));
  const imagePath = path.join(tempDir, 'diagram.png');

  try {
    fs.writeFileSync(imagePath, png);
    const result = spawnSync(
      chafa,
      [
        '--animate=off',
        '--format=symbols',
        '--symbols=block',
        `--size=${widthCells}x${rows}`,
        imagePath,
      ],
      {
        encoding: 'utf8',
        env: createRendererChildEnv(env),
        shell: shouldRunThroughShell(chafa),
        timeout: getMermaidRenderTimeout(env),
      },
    );

    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        error:
          result.stderr?.trim() || `chafa exited with status ${result.status}.`,
      };
    }

    return { ok: true, output: result.stdout };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function renderPngWithChafaAsync(
  png: Buffer,
  widthCells: number,
  rows: number,
  chafa: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'qwen-mermaid-'),
  );
  const imagePath = path.join(tempDir, 'diagram.png');

  try {
    await fs.promises.writeFile(imagePath, png);
    const result = await runCommand(
      chafa,
      [
        '--animate=off',
        '--format=symbols',
        '--symbols=block',
        `--size=${widthCells}x${rows}`,
        imagePath,
      ],
      {
        env: createRendererChildEnv(env),
        shell: shouldRunThroughShell(chafa),
        timeout: getMermaidRenderTimeout(env),
        signal,
      },
    );

    if (result.error) {
      return { ok: false, error: result.error };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        error:
          result.stderr.trim() || `chafa exited with status ${result.status}.`,
      };
    }

    return { ok: true, output: result.stdout };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface BoundedRendererOutput {
  text: string;
  truncated: boolean;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    shell?: boolean;
    timeout: number;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        status: null,
        stdout: '',
        stderr: '',
        error: 'Command cancelled.',
      });
      return;
    }

    const child = spawn(command, args, {
      env: options.env,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: BoundedRendererOutput = { text: '', truncated: false };
    let stderr: BoundedRendererOutput = { text: '', truncated: false };
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let terminationRequested = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!terminationRequested && killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', handleAbort);
      resolve(result);
    };
    const terminateChild = () => {
      terminationRequested = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1000);
      killTimer.unref?.();
    };
    const handleAbort = () => {
      terminateChild();
      finish({
        status: null,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr),
        error: 'Command cancelled.',
      });
    };
    const timer = setTimeout(() => {
      terminateChild();
      finish({
        status: null,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr),
        error: `Command timed out after ${options.timeout}ms.`,
      });
    }, options.timeout);
    options.signal?.addEventListener('abort', handleAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendBoundedRendererOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendBoundedRendererOutput(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({
        status: null,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr),
        error: error.message,
      });
    });
    child.on('close', (status) => {
      finish({
        status,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr),
      });
    });
  });
}

function appendBoundedRendererOutput(
  current: BoundedRendererOutput,
  chunk: string,
): BoundedRendererOutput {
  if (current.truncated) {
    return current;
  }

  const next = current.text + chunk;
  if (next.length <= MAX_RENDERER_OUTPUT_CHARS) {
    return { text: next, truncated: false };
  }

  return {
    text:
      next.slice(
        0,
        MAX_RENDERER_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length,
      ) + OUTPUT_TRUNCATION_MARKER,
    truncated: true,
  };
}

function finalizeBoundedRendererOutput(output: BoundedRendererOutput): string {
  if (!output.truncated || output.text.endsWith(OUTPUT_TRUNCATION_MARKER)) {
    return output.text;
  }

  return (
    output.text.slice(
      0,
      MAX_RENDERER_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length,
    ) + OUTPUT_TRUNCATION_MARKER
  );
}

function fitImageToTerminal(
  size: PngSize,
  contentWidth: number,
  availableTerminalHeight: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { widthCells: number; rows: number } {
  const widthCells = Math.max(16, Math.min(contentWidth, 120));
  const naturalRows = Math.ceil(
    (size.height / size.width) * widthCells * getMermaidCellAspectRatio(env),
  );
  const maxRows = Math.max(4, Math.min(availableTerminalHeight ?? 32, 60));

  return {
    widthCells,
    rows: Math.max(4, Math.min(naturalRows, maxRows)),
  };
}
