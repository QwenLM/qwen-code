/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

export type TerminalImageProtocol = 'kitty' | 'iterm2';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface TerminalImageDetectionOptions {
  disabled?: boolean;
  forceProtocol?: string;
  isTTY?: boolean;
}

export interface KittyImagePlaceholder {
  color: string;
  imageId: number;
  lines: string[];
}

export interface PrepareTerminalImageOptions {
  data: string;
  mimeType: string;
  contentWidth: number;
  availableTerminalHeight?: number;
  env?: NodeJS.ProcessEnv;
  detection?: TerminalImageDetectionOptions;
}

export interface PreparedTerminalImage {
  kind: 'terminal-image';
  sequence: string;
  rows: number;
  widthCells: number;
  protocol: TerminalImageProtocol;
  dimensions: ImageDimensions;
  fallbackText: string;
  placeholder?: KittyImagePlaceholder;
}

export interface TerminalImageFallback {
  kind: 'fallback';
  text: string;
  dimensions?: ImageDimensions;
  reason:
    | 'invalid-mime-type'
    | 'invalid-data'
    | 'unsupported-format'
    | 'unsupported-terminal'
    | 'unsupported-protocol-format';
}

export type TerminalImageRenderResult =
  | PreparedTerminalImage
  | TerminalImageFallback;

const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1_000_000;
const DEFAULT_MAX_IMAGE_ROWS = 24;
const MAX_IMAGE_ROWS = 32;
const MAX_IMAGE_COLUMNS = 80;
const DEFAULT_CELL_ASPECT_RATIO = 0.5;
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
] as const;

function normalizeForcedProtocol(
  value: string | undefined,
): TerminalImageProtocol | null | undefined {
  const normalized = value?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'off' || normalized === 'none' || normalized === '0') {
    return null;
  }
  if (normalized === 'kitty') {
    return 'kitty';
  }
  if (normalized === 'iterm' || normalized === 'iterm2') {
    return 'iterm2';
  }
  return undefined;
}

export function detectTerminalImageProtocol(
  env: NodeJS.ProcessEnv = process.env,
  options: TerminalImageDetectionOptions = {},
): TerminalImageProtocol | null {
  if (options.disabled || env['QWEN_CODE_DISABLE_TERMINAL_IMAGES'] === '1') {
    return null;
  }

  const term = env['TERM']?.toLowerCase() ?? '';
  const isMultiplexed =
    Boolean(env['TMUX']) ||
    Boolean(env['STY']) ||
    term.startsWith('tmux') ||
    term.startsWith('screen');
  const isRemote =
    Boolean(env['SSH_TTY']) ||
    Boolean(env['SSH_CLIENT']) ||
    Boolean(env['SSH_CONNECTION']);
  if ((options.isTTY ?? process.stdout.isTTY === true) !== true) {
    return null;
  }
  if (isMultiplexed || isRemote) {
    return null;
  }

  const forced = normalizeForcedProtocol(
    options.forceProtocol ?? env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'],
  );
  if (forced !== undefined) {
    return forced;
  }

  const termProgram = env['TERM_PROGRAM']?.toLowerCase() ?? '';
  if (
    env['KITTY_WINDOW_ID'] ||
    env['GHOSTTY_RESOURCES_DIR'] ||
    term.includes('kitty') ||
    term.includes('ghostty') ||
    termProgram === 'kitty' ||
    termProgram.includes('ghostty')
  ) {
    return 'kitty';
  }

  if (env['WEZTERM_PANE'] || termProgram.includes('wezterm')) {
    return 'iterm2';
  }

  if (
    env['WARP_SESSION_ID'] ||
    env['WARP_TERMINAL_SESSION_UUID'] ||
    termProgram === 'warpterminal'
  ) {
    return 'iterm2';
  }

  if (env['ITERM_SESSION_ID'] || termProgram === 'iterm.app') {
    return 'iterm2';
  }

  return null;
}

export function encodeITerm2InlineImage(
  image: Buffer,
  widthCells: number,
  rows: number,
): string {
  return `\u001b]1337;File=inline=1;width=${widthCells};height=${rows};preserveAspectRatio=1:${image.toString(
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

function encodeKittyImageCommand(image: Buffer, firstControl: string): string {
  const encoded = image.toString('base64');
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

function validDimensions(
  width: number,
  height: number,
): ImageDimensions | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION
  ) {
    return null;
  }
  return { width, height };
}

export function readPngSize(png: Buffer): ImageDimensions | null {
  if (
    png.length < 24 ||
    png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE ||
    png.readUInt32BE(8) !== 13 ||
    png.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return null;
  }

  return validDimensions(png.readUInt32BE(16), png.readUInt32BE(20));
}

function readJpegSize(jpeg: Buffer): ImageDimensions | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < jpeg.length && jpeg[offset] === 0xff) {
      offset += 1;
    }
    const marker = jpeg[offset];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    if (offset + 2 >= jpeg.length) {
      return null;
    }

    const segmentLength = jpeg.readUInt16BE(offset + 1);
    if (segmentLength < 2 || offset + 1 + segmentLength > jpeg.length) {
      return null;
    }
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) {
        return null;
      }
      return validDimensions(
        jpeg.readUInt16BE(offset + 6),
        jpeg.readUInt16BE(offset + 4),
      );
    }
    offset += segmentLength + 1;
  }

  return null;
}

function readGifSize(gif: Buffer): ImageDimensions | null {
  if (gif.length < 10) {
    return null;
  }
  const signature = gif.subarray(0, 6).toString('ascii');
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    return null;
  }
  return validDimensions(gif.readUInt16LE(6), gif.readUInt16LE(8));
}

function readWebpSize(webp: Buffer): ImageDimensions | null {
  if (
    webp.length < 21 ||
    webp.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    webp.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    webp.readUInt32LE(4) + 8 > webp.length
  ) {
    return null;
  }

  const chunkType = webp.subarray(12, 16).toString('ascii');
  const chunkLength = webp.readUInt32LE(16);
  if (chunkLength > webp.length - 20) {
    return null;
  }
  if (chunkType === 'VP8 ') {
    if (
      chunkLength < 10 ||
      webp.length < 30 ||
      webp[23] !== 0x9d ||
      webp[24] !== 0x01 ||
      webp[25] !== 0x2a
    ) {
      return null;
    }
    return validDimensions(
      webp.readUInt16LE(26) & 0x3fff,
      webp.readUInt16LE(28) & 0x3fff,
    );
  }
  if (chunkType === 'VP8L') {
    if (chunkLength < 5 || webp.length < 25 || webp[20] !== 0x2f) {
      return null;
    }
    const bits = webp.readUInt32LE(21);
    return validDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunkType === 'VP8X') {
    if (chunkLength < 10 || webp.length < 30) {
      return null;
    }
    const width =
      (webp[24] ?? 0) | ((webp[25] ?? 0) << 8) | ((webp[26] ?? 0) << 16);
    const height =
      (webp[27] ?? 0) | ((webp[28] ?? 0) << 8) | ((webp[29] ?? 0) << 16);
    return validDimensions(width + 1, height + 1);
  }

  return null;
}

export function readImageSize(
  image: Buffer,
  mimeType: string,
): ImageDimensions | null {
  switch (mimeType.trim().toLowerCase()) {
    case 'image/png':
      return readPngSize(image);
    case 'image/jpeg':
    case 'image/jpg':
      return readJpegSize(image);
    case 'image/gif':
      return readGifSize(image);
    case 'image/webp':
      return readWebpSize(image);
    default:
      return null;
  }
}

function getImageFormat(mimeType: string): string | null {
  const normalized = mimeType.trim().toLowerCase();
  const match = /^image\/([a-z0-9][a-z0-9.+-]*)$/.exec(normalized);
  return match?.[1] ?? null;
}

export function formatImageFallback(
  mimeType: string,
  dimensions?: ImageDimensions,
): string {
  const format = getImageFormat(mimeType);
  if (!format) {
    return '[image]';
  }
  const size = dimensions ? `${dimensions.width}x${dimensions.height} ` : '';
  return `[image: ${size}${format}]`;
}

function decodeBase64Image(data: string): Buffer | null {
  const maxEncodedLength = Math.ceil((MAX_INLINE_IMAGE_BYTES * 4) / 3) + 4;
  if (data.length === 0 || data.length > maxEncodedLength) {
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
  if (decoded.length === 0 || decoded.length > MAX_INLINE_IMAGE_BYTES) {
    return null;
  }
  const canonicalInput = normalized.replace(/=+$/, '');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  return canonicalInput === canonicalDecoded ? decoded : null;
}

export function fitTerminalImage(
  dimensions: ImageDimensions,
  contentWidth: number,
  availableTerminalHeight?: number,
): { widthCells: number; rows: number } {
  const requestedWidth = Number.isFinite(contentWidth)
    ? Math.floor(contentWidth)
    : 1;
  const maxWidth = Math.max(1, Math.min(requestedWidth, MAX_IMAGE_COLUMNS));
  const requestedRows =
    availableTerminalHeight === undefined
      ? DEFAULT_MAX_IMAGE_ROWS
      : Number.isFinite(availableTerminalHeight)
        ? Math.floor(availableTerminalHeight)
        : 1;
  const maxRows = Math.max(1, Math.min(requestedRows, MAX_IMAGE_ROWS));
  const naturalRows = Math.max(
    1,
    Math.ceil(
      (dimensions.height / dimensions.width) *
        maxWidth *
        DEFAULT_CELL_ASPECT_RATIO,
    ),
  );
  if (naturalRows <= maxRows) {
    return { widthCells: maxWidth, rows: naturalRows };
  }

  const widthCells = Math.max(
    1,
    Math.floor((maxWidth * maxRows) / naturalRows),
  );
  const rows = Math.max(
    1,
    Math.min(
      maxRows,
      Math.ceil(
        (dimensions.height / dimensions.width) *
          widthCells *
          DEFAULT_CELL_ASPECT_RATIO,
      ),
    ),
  );
  return { widthCells, rows };
}

export function createKittyImageId(
  image: Buffer,
  imageShape: { widthCells: number; rows: number },
): number {
  const hash = crypto
    .createHash('sha256')
    .update(image)
    .update('\0')
    .update(String(imageShape.widthCells))
    .update('\0')
    .update(String(imageShape.rows))
    .digest();
  const id = hash.readUIntBE(0, 3);
  return id === 0 ? 1 : id;
}

export function prepareTerminalImage({
  data,
  mimeType,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
  detection,
}: PrepareTerminalImageOptions): TerminalImageRenderResult {
  const format = getImageFormat(mimeType);
  if (!format) {
    return {
      kind: 'fallback',
      text: '[image]',
      reason: 'invalid-mime-type',
    };
  }

  const image = decodeBase64Image(data);
  if (!image) {
    return {
      kind: 'fallback',
      text: formatImageFallback(mimeType),
      reason: 'invalid-data',
    };
  }

  const dimensions = readImageSize(image, mimeType);
  if (!dimensions) {
    return {
      kind: 'fallback',
      text: formatImageFallback(mimeType),
      reason: 'unsupported-format',
    };
  }

  const fallbackText = formatImageFallback(mimeType, dimensions);
  const protocol = detectTerminalImageProtocol(env, detection);
  if (!protocol) {
    return {
      kind: 'fallback',
      text: fallbackText,
      dimensions,
      reason: 'unsupported-terminal',
    };
  }
  if (protocol === 'kitty' && mimeType.trim().toLowerCase() !== 'image/png') {
    return {
      kind: 'fallback',
      text: fallbackText,
      dimensions,
      reason: 'unsupported-protocol-format',
    };
  }

  const imageShape = fitTerminalImage(
    dimensions,
    contentWidth,
    availableTerminalHeight,
  );
  if (protocol === 'kitty') {
    const imageId = createKittyImageId(image, imageShape);
    return {
      kind: 'terminal-image',
      sequence: encodeKittyVirtualImage(
        image,
        imageId,
        imageShape.widthCells,
        imageShape.rows,
      ),
      ...imageShape,
      protocol,
      dimensions,
      fallbackText,
      placeholder: buildKittyPlaceholder(
        imageId,
        imageShape.widthCells,
        imageShape.rows,
      ),
    };
  }

  return {
    kind: 'terminal-image',
    sequence: encodeITerm2InlineImage(
      image,
      imageShape.widthCells,
      imageShape.rows,
    ),
    ...imageShape,
    protocol,
    dimensions,
    fallbackText,
  };
}
