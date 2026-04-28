/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type TerminalImageProtocol = 'kitty' | 'iterm2';

export interface MermaidImageRenderOptions {
  source: string;
  contentWidth: number;
  availableTerminalHeight?: number;
  env?: NodeJS.ProcessEnv;
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
const DEFAULT_RENDER_TIMEOUT_MS = 8000;
const DEFAULT_MERMAID_RENDER_WIDTH = 1280;
const NPX_MERMAID_CLI = 'npx:@mermaid-js/mermaid-cli@11.12.0';
const PNG_SIGNATURE = '89504e470d0a1a0a';
const KITTY_PLACEHOLDER = '\u{10EEEE}';
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

export function detectTerminalImageProtocol(
  env: NodeJS.ProcessEnv = process.env,
): TerminalImageProtocol | null {
  const forced = env['QWEN_CODE_MERMAID_IMAGE_PROTOCOL']?.toLowerCase();
  if (forced) {
    if (forced === 'kitty') return 'kitty';
    if (forced === 'iterm' || forced === 'iterm2') return 'iterm2';
    if (forced === 'off' || forced === 'none' || forced === '0') return null;
  }

  if (
    env['QWEN_CODE_DISABLE_MERMAID_IMAGES'] === '1' ||
    !process.stdout.isTTY ||
    env['TMUX'] ||
    env['SSH_TTY'] ||
    env['SSH_CLIENT']
  ) {
    return null;
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
  const lines = Array.from({ length: clampedRows }, (_, row) => {
    const rowDiacritic = KITTY_PLACEHOLDER_DIACRITICS[row];
    const cells = Array.from({ length: widthCells }, (_, column) => {
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

export function renderMermaidImageSync({
  source,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
}: MermaidImageRenderOptions): MermaidImageRenderResult {
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
  );
  const cached = cachedResults.get(cacheKey);
  if (cached) return cached;

  const pngCacheKey = createPngCacheKey(source, mmdc, env);
  const cachedPng = cachedPngResults.get(pngCacheKey);
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
    .digest('hex');
}

function remember<T extends MermaidImageRenderResult>(
  key: string,
  result: T,
): T {
  cachedResults.set(key, result);
  if (cachedResults.size > CACHE_LIMIT) {
    const oldest = cachedResults.keys().next().value;
    if (oldest) cachedResults.delete(oldest);
  }
  return result;
}

function rememberPng<
  T extends { ok: true; png: Buffer } | { ok: false; error: string },
>(key: string, result: T): T {
  cachedPngResults.set(key, result);
  if (cachedPngResults.size > PNG_CACHE_LIMIT) {
    const oldest = cachedPngResults.keys().next().value;
    if (oldest) cachedPngResults.delete(oldest);
  }
  return result;
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
    if (
      !allowLocalRenderers &&
      normalizeExecutableDir(dir) === localRendererDir
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
      env: {
        ...process.env,
        ...env,
      },
      shell: shouldRunThroughShell(command),
      timeout: Number(
        env['QWEN_CODE_MERMAID_RENDER_TIMEOUT_MS'] ?? DEFAULT_RENDER_TIMEOUT_MS,
      ),
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

    return { ok: true, png: fs.readFileSync(outputPath) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
        env: {
          ...process.env,
          ...env,
        },
        timeout: 2000,
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

function fitImageToTerminal(
  size: PngSize,
  contentWidth: number,
  availableTerminalHeight: number | undefined,
): { widthCells: number; rows: number } {
  const widthCells = Math.max(16, Math.min(contentWidth, 120));
  const naturalRows = Math.ceil((size.height / size.width) * widthCells * 0.5);
  const maxRows = Math.max(4, Math.min(availableTerminalHeight ?? 32, 60));

  return {
    widthCells,
    rows: Math.max(4, Math.min(naturalRows, maxRows)),
  };
}
