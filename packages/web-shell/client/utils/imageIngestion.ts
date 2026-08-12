import type { PromptImage } from '../adapters/promptTypes';

export type ImageIngestionRejectionReason =
  | 'unsupported'
  | 'unavailable'
  | 'too-large'
  | 'read-failed';

export interface ImageIngestionRejection {
  name?: string;
  reason: ImageIngestionRejectionReason;
}

interface ImageFileCandidate {
  file: File;
  mediaType: string;
}

export interface ExtractedImageTransfer {
  claimed: boolean;
  candidates: ImageFileCandidate[];
  rejected: ImageIngestionRejection[];
}

export interface ImageIngestionBatchResult {
  accepted: PromptImage[];
  rejected: ImageIngestionRejection[];
}

interface ReaderLifecycle {
  onReaderCreated?: (reader: FileReader) => void;
  onReaderSettled?: (reader: FileReader) => void;
  maxEncodedBytes?: number;
}

export const MAX_IMAGE_ATTACHMENT_DATA_BYTES = 8 * 1024 * 1024;
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

export function hasFileTransferPayload(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.files.length > 0) return true;
  if (Array.from(dataTransfer.types).some((type) => type === 'Files')) {
    return true;
  }
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file');
}

export function extractImageTransfer(
  dataTransfer: DataTransfer,
  source: 'paste' | 'drop',
): ExtractedImageTransfer {
  const candidates: ImageFileCandidate[] = [];
  const rejected: ImageIngestionRejection[] = [];
  let hasSupportedUnavailableItem = false;

  if (dataTransfer.files.length > 0) {
    for (const file of Array.from(dataTransfer.files)) {
      const mediaType = normalizeImageMediaType(file.type, file.name);
      if (mediaType) {
        candidates.push({ file, mediaType });
      } else {
        rejected.push({ name: file.name, reason: 'unsupported' });
      }
    }
  } else {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) {
        if (normalizeImageMediaType(item.type)) {
          hasSupportedUnavailableItem = true;
          rejected.push({ reason: 'unavailable' });
        } else if (source === 'drop') {
          rejected.push({ reason: 'unavailable' });
        }
        continue;
      }
      const mediaType = normalizeImageMediaType(
        file.type || item.type,
        file.name,
      );
      if (mediaType) {
        candidates.push({ file, mediaType });
      } else {
        rejected.push({ name: file.name, reason: 'unsupported' });
      }
    }
  }

  return {
    claimed:
      source === 'drop'
        ? hasFileTransferPayload(dataTransfer)
        : candidates.length > 0 || hasSupportedUnavailableItem,
    candidates,
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
  transfer: ExtractedImageTransfer,
  lifecycle: ReaderLifecycle = {},
): Promise<ImageIngestionBatchResult> {
  const candidates: ImageFileCandidate[] = [];
  const rejected = [...transfer.rejected];
  let estimatedEncodedBytes = 0;
  const maxEncodedBytes =
    lifecycle.maxEncodedBytes ?? MAX_IMAGE_ATTACHMENT_DATA_BYTES;
  for (const candidate of transfer.candidates) {
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
