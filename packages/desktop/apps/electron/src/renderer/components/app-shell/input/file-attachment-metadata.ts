import type { FileAttachment } from '../../../../shared/types';

const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream']);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  icns: 'image/x-icns',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function fileExtension(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext === fileName.toLowerCase() ? '' : (ext ?? '');
}

function inferImageMimeType(fileName: string, mimeType: string): string | null {
  if (mimeType.startsWith('image/')) return mimeType;
  if (!GENERIC_MIME_TYPES.has(mimeType)) return null;
  return IMAGE_MIME_BY_EXTENSION[fileExtension(fileName)] ?? null;
}

export function inferFileAttachmentMetadata(
  fileName: string,
  rawMimeType: string,
): Pick<FileAttachment, 'type' | 'mimeType'> {
  const imageMimeType = inferImageMimeType(fileName, rawMimeType);
  if (imageMimeType) {
    return { type: 'image', mimeType: imageMimeType };
  }

  const mimeType = rawMimeType || 'application/octet-stream';
  let type: FileAttachment['type'] = 'unknown';
  if (mimeType === 'application/pdf') type = 'pdf';
  else if (
    mimeType.includes('text') ||
    fileName.match(/\.(txt|md|json|js|ts|tsx|py|css|html)$/i)
  ) {
    type = 'text';
  } else if (
    mimeType.includes('officedocument') ||
    fileName.match(/\.(docx?|xlsx?|pptx?)$/i)
  ) {
    type = 'office';
  }

  return { type, mimeType };
}
