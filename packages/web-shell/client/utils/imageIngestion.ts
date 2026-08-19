import type { PromptFile, PromptImage } from '../adapters/promptTypes';

export type ImageIngestionRejectionReason =
  | 'unsupported'
  | 'unavailable'
  | 'too-large'
  | 'read-failed';

export interface ImageIngestionRejection {
  name?: string;
  reason: ImageIngestionRejectionReason;
}

export interface ImageFileCandidate {
  file: File;
  mediaType: string;
}

export interface TextFileCandidate {
  file: File;
  mediaType: string;
}

export interface ExtractedFileTransfer {
  claimed: boolean;
  imageCandidates: ImageFileCandidate[];
  textCandidates: TextFileCandidate[];
  rejected: ImageIngestionRejection[];
}

export interface ImageIngestionBatchResult {
  accepted: PromptImage[];
  rejected: ImageIngestionRejection[];
}

export interface TextIngestionBatchResult {
  accepted: PromptFile[];
  rejected: ImageIngestionRejection[];
}

interface ReaderLifecycle {
  onReaderCreated?: (reader: FileReader) => void;
  onReaderSettled?: (reader: FileReader) => void;
  maxEncodedBytes?: number;
}

export const MAX_IMAGE_ATTACHMENT_DATA_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_DATA_BYTES = 512 * 1024;
const MAX_CONCURRENT_IMAGE_READERS = 4;

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const SUPPORTED_IMAGE_MIME_TYPES = new Set(
  Object.values(IMAGE_MIME_BY_EXTENSION),
);

export function normalizeImageMediaType(
  mediaType: string,
  fileName = '',
): string | undefined {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === 'image/x-bmp' || normalized === 'image/x-ms-bmp') {
    return 'image/bmp';
  }
  if (SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) return normalized;
  if (normalized && normalized !== 'application/octet-stream') {
    return undefined;
  }
  const extension = fileName.split('.').pop()?.toLowerCase();
  return extension ? IMAGE_MIME_BY_EXTENSION[extension] : undefined;
}

const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-sh',
  'application/sql',
]);

const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'log',
  'txt',
  'text',
  'md',
  'markdown',
  'json',
  'jsonl',
  'ndjson',
  'csv',
  'tsv',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'env',
  'properties',
  'sh',
  'bash',
  'zsh',
  'py',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'java',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'sql',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'diff',
  'patch',
]);

const TEXT_FILENAMES: ReadonlySet<string> = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'gemfile',
  'procfile',
  'vagrantfile',
]);

export function normalizeTextMediaType(
  mediaType: string,
  fileName = '',
): string | undefined {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.startsWith('text/')) return normalized;
  if (TEXT_MIME_TYPES.has(normalized)) return normalized;
  // Extension and well-known-name fallbacks run even when the OS reports a
  // conflicting MIME (`.ts`/`video/mp2t`, `.csv`/`vnd.ms-excel`); actually
  // binary content is still rejected downstream by the NUL sniff in readText.
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension && TEXT_FILE_EXTENSIONS.has(extension)) return 'text/plain';
  if (TEXT_FILENAMES.has(fileName.trim().toLowerCase())) return 'text/plain';
  return undefined;
}

// The daemon derives a `@<uri>` token and a `File: <uri>` label from the
// resource URI, and `@`-token scanning stops at these characters — keep the
// name identical across chip, URI, and token by normalizing once here.
const ATTACHMENT_NAME_UNSAFE_RE = /[\s,;!?()[\]{}]+/g;
/* eslint-disable no-control-regex -- intentionally strips C0/DEL controls and invisible bidi/zero-width format chars from dropped file names */
const CONTROL_CHAR_RE =
  /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

export function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .trim()
    .replace(ATTACHMENT_NAME_UNSAFE_RE, '_')
    .replace(CONTROL_CHAR_RE, '');
  return cleaned || 'attachment';
}

export function dedupeAttachmentName(
  name: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i += 1) {
    const candidate = `${name}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function hasFileTransferPayload(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.files.length > 0) return true;
  if (Array.from(dataTransfer.types).some((type) => type === 'Files')) {
    return true;
  }
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file');
}

export function extractFileTransfer(
  dataTransfer: DataTransfer,
  source: 'paste' | 'drop',
): ExtractedFileTransfer {
  const imageCandidates: ImageFileCandidate[] = [];
  const textCandidates: TextFileCandidate[] = [];
  const rejected: ImageIngestionRejection[] = [];
  let hasSupportedUnavailableItem = false;

  const classify = (file: File, typeHint: string) => {
    const imageMediaType = normalizeImageMediaType(typeHint, file.name);
    if (imageMediaType) {
      imageCandidates.push({ file, mediaType: imageMediaType });
      return;
    }
    const textMediaType = normalizeTextMediaType(typeHint, file.name);
    if (textMediaType) {
      textCandidates.push({ file, mediaType: textMediaType });
      return;
    }
    rejected.push({ name: file.name, reason: 'unsupported' });
  };

  if (dataTransfer.files.length > 0) {
    for (const file of Array.from(dataTransfer.files)) {
      classify(file, file.type);
    }
  } else {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) {
        if (
          normalizeImageMediaType(item.type) ||
          normalizeTextMediaType(item.type)
        ) {
          hasSupportedUnavailableItem = true;
          rejected.push({ reason: 'unavailable' });
        } else if (source === 'drop') {
          rejected.push({ reason: 'unavailable' });
        }
        continue;
      }
      classify(file, file.type || item.type);
    }
  }

  return {
    claimed:
      source === 'drop'
        ? hasFileTransferPayload(dataTransfer)
        : imageCandidates.length > 0 ||
          textCandidates.length > 0 ||
          hasSupportedUnavailableItem,
    imageCandidates,
    textCandidates,
    rejected,
  };
}

function readImage(
  candidate: ImageFileCandidate,
  lifecycle: ReaderLifecycle,
): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    lifecycle.onReaderCreated?.(reader);

    const settle = (result?: PromptImage) => {
      if (settled) return;
      settled = true;
      lifecycle.onReaderSettled?.(reader);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      if (result) {
        resolve(result);
      } else {
        reject(new Error('Failed to read image file'));
      }
    };

    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = dataUrl.indexOf(',');
      const data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
      settle(
        data
          ? {
              data,
              media_type: candidate.mediaType,
            }
          : undefined,
      );
    };
    reader.onerror = () => settle();
    reader.onabort = () => settle();

    try {
      reader.readAsDataURL(candidate.file);
    } catch {
      settle();
    }
  });
}

export async function readImageTransfer(
  imageCandidates: readonly ImageFileCandidate[],
  lifecycle: ReaderLifecycle = {},
): Promise<ImageIngestionBatchResult> {
  const candidates: ImageFileCandidate[] = [];
  const rejected: ImageIngestionRejection[] = [];
  let estimatedEncodedBytes = 0;
  const maxEncodedBytes =
    lifecycle.maxEncodedBytes ?? MAX_IMAGE_ATTACHMENT_DATA_BYTES;
  for (const candidate of imageCandidates) {
    const candidateBytes = Math.ceil(candidate.file.size / 3) * 4;
    if (estimatedEncodedBytes + candidateBytes > maxEncodedBytes) {
      rejected.push({ name: candidate.file.name, reason: 'too-large' });
      continue;
    }
    estimatedEncodedBytes += candidateBytes;
    candidates.push(candidate);
  }

  const settled: Array<PromiseSettledResult<PromptImage>> = new Array(
    candidates.length,
  );
  let nextIndex = 0;
  const readNext = async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex++;
      try {
        settled[index] = {
          status: 'fulfilled',
          value: await readImage(candidates[index]!, lifecycle),
        };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_IMAGE_READERS, candidates.length) },
      readNext,
    ),
  );
  const accepted: PromptImage[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      accepted.push(result.value);
    } else {
      rejected.push({
        name: candidates[index]?.file.name,
        reason: 'read-failed',
      });
    }
  });
  return { accepted, rejected };
}

class BinaryContentError extends Error {
  constructor() {
    super('File decodes to binary content');
    this.name = 'BinaryContentError';
  }
}

function readText(
  candidate: TextFileCandidate,
  lifecycle: ReaderLifecycle,
): Promise<PromptFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    lifecycle.onReaderCreated?.(reader);

    const settle = (result?: PromptFile, error?: Error) => {
      if (settled) return;
      settled = true;
      lifecycle.onReaderSettled?.(reader);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      if (result) {
        resolve(result);
      } else {
        reject(error ?? new Error('Failed to read text file'));
      }
    };

    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (text.includes(String.fromCharCode(0))) {
        settle(undefined, new BinaryContentError());
        return;
      }
      settle({
        name: candidate.file.name,
        media_type: candidate.mediaType,
        text,
        size: candidate.file.size,
      });
    };
    reader.onerror = () => settle();
    reader.onabort = () => settle();

    try {
      reader.readAsText(candidate.file);
    } catch {
      settle();
    }
  });
}

export async function readTextTransfer(
  textCandidates: readonly TextFileCandidate[],
  lifecycle: ReaderLifecycle = {},
): Promise<TextIngestionBatchResult> {
  const candidates: TextFileCandidate[] = [];
  const rejected: ImageIngestionRejection[] = [];
  let estimatedBytes = 0;
  const maxBytes = lifecycle.maxEncodedBytes ?? MAX_TEXT_ATTACHMENT_DATA_BYTES;
  for (const candidate of textCandidates) {
    if (estimatedBytes + candidate.file.size > maxBytes) {
      rejected.push({ name: candidate.file.name, reason: 'too-large' });
      continue;
    }
    estimatedBytes += candidate.file.size;
    candidates.push(candidate);
  }

  const settled: Array<PromiseSettledResult<PromptFile>> = new Array(
    candidates.length,
  );
  let nextIndex = 0;
  const readNext = async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex++;
      try {
        settled[index] = {
          status: 'fulfilled',
          value: await readText(candidates[index]!, lifecycle),
        };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_IMAGE_READERS, candidates.length) },
      readNext,
    ),
  );
  const accepted: PromptFile[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      accepted.push(result.value);
    } else {
      rejected.push({
        name: candidates[index]?.file.name,
        reason:
          result.reason instanceof BinaryContentError
            ? 'unsupported'
            : 'read-failed',
      });
    }
  });
  return { accepted, rejected };
}
