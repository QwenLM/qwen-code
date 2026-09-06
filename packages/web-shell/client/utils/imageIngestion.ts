import type { PromptFile, PromptImage } from '../adapters/promptTypes';

export type ImageIngestionRejectionReason =
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

export interface AttachmentFileCandidate {
  file: File;
  mediaType: string;
}

export interface ExtractedFileTransfer {
  claimed: boolean;
  imageCandidates: ImageFileCandidate[];
  fileCandidates: AttachmentFileCandidate[];
  rejected: ImageIngestionRejection[];
}

export interface ImageIngestionBatchResult {
  accepted: PromptImage[];
  rejected: ImageIngestionRejection[];
}

export interface FileIngestionBatchResult {
  accepted: PromptFile[];
  rejected: ImageIngestionRejection[];
}

interface ReaderLifecycle {
  onReaderCreated?: (reader: FileReader) => void;
  onReaderSettled?: (reader: FileReader) => void;
  maxBytes?: number;
}

export const MAX_IMAGE_ATTACHMENT_DATA_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_ATTACHMENT_DATA_BYTES = 8 * 1024 * 1024;
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
  if (normalized === 'image/jpg') return 'image/jpeg';
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
  'svg',
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
  // conflicting MIME (`.ts`/`video/mp2t`, `.csv`/`vnd.ms-excel`).
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension && TEXT_FILE_EXTENSIONS.has(extension)) return 'text/plain';
  if (TEXT_FILENAMES.has(fileName.trim().toLowerCase())) return 'text/plain';
  return undefined;
}

/* eslint-disable no-control-regex -- intentionally strips C0/DEL controls and invisible bidi/zero-width format chars from dropped file names */
const CONTROL_CHAR_RE =
  /[\u0000-\u001f\u007f\ud800-\udfff\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu;
/* eslint-enable no-control-regex */
const INVALID_ATTACHMENT_NAME_RE = /[<>:"|?*]/g;
const WINDOWS_RESERVED_NAME_RE =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_ATTACHMENT_NAME_BYTES = 255;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function sanitizeAttachmentName(name: string): string {
  let cleaned = name
    .replace(/^.*[\\/]/, '')
    .trim()
    .replace(CONTROL_CHAR_RE, '')
    .replace(INVALID_ATTACHMENT_NAME_RE, '_')
    .replace(/[. ]+$/u, '');
  if (WINDOWS_RESERVED_NAME_RE.test(cleaned)) cleaned = `_${cleaned}`;
  cleaned = truncateUtf8(cleaned, MAX_ATTACHMENT_NAME_BYTES).replace(
    /[. ]+$/u,
    '',
  );
  return cleaned || 'attachment';
}

export function dedupeAttachmentName(
  name: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i += 1) {
    const suffix = ` (${i})`;
    const extensionBudget = MAX_ATTACHMENT_NAME_BYTES - utf8Length(suffix) - 1;
    const safeExtension = truncateUtf8(extension, extensionBudget).replace(
      /[. ]+$/u,
      '',
    );
    const stemBudget =
      MAX_ATTACHMENT_NAME_BYTES -
      utf8Length(suffix) -
      utf8Length(safeExtension);
    const candidate = `${truncateUtf8(stem, stemBudget)}${suffix}${safeExtension}`;
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

function classifyFile(
  file: File,
  typeHint: string,
  result: ExtractedFileTransfer,
) {
  const imageMediaType = normalizeImageMediaType(typeHint, file.name);
  if (imageMediaType) {
    result.imageCandidates.push({ file, mediaType: imageMediaType });
    return;
  }
  result.fileCandidates.push({
    file,
    mediaType:
      normalizeTextMediaType(typeHint, file.name) ||
      typeHint ||
      'application/octet-stream',
  });
}

export function extractFiles(files: readonly File[]): ExtractedFileTransfer {
  const result: ExtractedFileTransfer = {
    claimed: files.length > 0,
    imageCandidates: [],
    fileCandidates: [],
    rejected: [],
  };
  for (const file of files) classifyFile(file, file.type, result);
  return result;
}

export function extractFileTransfer(
  dataTransfer: DataTransfer,
  source: 'paste' | 'drop',
): ExtractedFileTransfer {
  const result: ExtractedFileTransfer = {
    claimed: false,
    imageCandidates: [],
    fileCandidates: [],
    rejected: [],
  };
  let hasUnavailableFileItem = false;

  if (dataTransfer.files.length > 0) {
    for (const file of Array.from(dataTransfer.files)) {
      classifyFile(file, file.type, result);
    }
  } else {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) {
        hasUnavailableFileItem = true;
        result.rejected.push({ reason: 'unavailable' });
        continue;
      }
      classifyFile(file, file.type || item.type, result);
    }
  }

  return {
    ...result,
    claimed:
      source === 'drop'
        ? hasFileTransferPayload(dataTransfer)
        : result.imageCandidates.length > 0 ||
          result.fileCandidates.length > 0 ||
          hasUnavailableFileItem,
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
  const maxBytes = lifecycle.maxBytes ?? MAX_IMAGE_ATTACHMENT_DATA_BYTES;
  for (const candidate of imageCandidates) {
    if (candidate.file.size > maxBytes) {
      rejected.push({ name: candidate.file.name, reason: 'too-large' });
      continue;
    }
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

export function readFileTransfer(
  fileCandidates: readonly AttachmentFileCandidate[],
  options: { maxBytes?: number } = {},
): Promise<FileIngestionBatchResult> {
  const accepted: PromptFile[] = [];
  const rejected: ImageIngestionRejection[] = [];
  const maxBytes = options.maxBytes ?? MAX_FILE_ATTACHMENT_DATA_BYTES;
  for (const candidate of fileCandidates) {
    if (candidate.file.size > maxBytes) {
      rejected.push({ name: candidate.file.name, reason: 'too-large' });
      continue;
    }
    const name = sanitizeAttachmentName(candidate.file.name);
    const nameImageType = normalizeImageMediaType('', name);
    const declaredImageType = normalizeImageMediaType(candidate.mediaType);
    const shieldedName =
      nameImageType && nameImageType !== declaredImageType
        ? `${truncateUtf8(name, MAX_ATTACHMENT_NAME_BYTES - utf8Length('.file')).replace(/[. ]+$/u, '') || 'attachment'}.file`
        : name;
    accepted.push({
      name: shieldedName,
      media_type: declaredImageType ?? candidate.mediaType,
      data: candidate.file,
      size: candidate.file.size,
    });
  }
  return Promise.resolve({ accepted, rejected });
}
