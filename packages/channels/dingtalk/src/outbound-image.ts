import { extname } from 'node:path';
import { readValidatedLocalFile } from './outbound-local-file.js';
import {
  findOutboundMediaMarkers,
  replaceOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  type OutboundMediaMarker,
} from './outbound-markers.js';
import {
  DingTalkMediaUploadError,
  uploadDingTalkMedia,
} from './outbound-media.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);

export { DingTalkMediaUploadError };
export type ImageMarker = OutboundMediaMarker;

export interface ValidatedImage {
  data: Buffer;
  fileName: string;
  mimeType: string;
}

export function findImageMarkers(text: string): ImageMarker[] {
  return findOutboundMediaMarkers(text, 'IMAGE');
}

export function replaceImageMarkers(
  text: string,
  markers: readonly ImageMarker[],
  replacements: readonly string[],
): string {
  return replaceOutboundMediaMarkers(text, markers, replacements);
}

export function stripPartialImageMarker(text: string): string {
  return stripPartialOutboundMediaMarker(text, 'IMAGE', '[Image pending]');
}

export function sanitizeStreamingImageMarkers(text: string): string {
  const markers = findImageMarkers(text);
  return stripPartialImageMarker(
    replaceImageMarkers(
      text,
      markers,
      markers.map(() => '[Image pending]'),
    ),
  );
}

function detectImageMime(data: Buffer): string {
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp';
  }
  throw new Error('Unrecognized image format');
}

export function readValidatedImage(
  imagePath: string,
  options: {
    workspaceDir: string;
    temporaryDir?: string;
  },
): ValidatedImage {
  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Image extension not allowed: ${extension}`);
  }

  const image = readValidatedLocalFile(imagePath, {
    ...options,
    label: 'Image',
    allowEmpty: true,
  });
  const mimeType = detectImageMime(image.data.subarray(0, 16));
  const expectedMime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  };
  if (mimeType !== expectedMime[extension]) {
    throw new Error(
      `Image type mismatch: ${extension} expects ${expectedMime[extension]} but got ${mimeType}`,
    );
  }

  return {
    data: image.data,
    fileName: image.fileName,
    mimeType,
  };
}

export function uploadDingTalkImage(
  image: ValidatedImage,
  accessToken: string,
): Promise<string> {
  return uploadDingTalkMedia(image, accessToken, 'image');
}
