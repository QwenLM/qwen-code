import { basename, extname } from 'node:path';
import { readValidatedLocalFile } from './outbound-local-file.js';
import {
  findOutboundMediaMarkers,
  replaceOutboundMediaMarkers,
  sanitizeOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  type OutboundMediaMarker,
} from './outbound-markers.js';
import { uploadDingTalkMedia } from './outbound-media.js';

export const MAX_FILES_PER_RESPONSE = 5;

export type FileMarker = OutboundMediaMarker;

export interface ValidatedFile {
  data: Buffer;
  fileName: string;
  fileType: string;
  mimeType: string;
}

export function findFileMarkers(text: string): FileMarker[] {
  return findOutboundMediaMarkers(text, 'FILE');
}

export function replaceFileMarkers(
  text: string,
  markers: readonly FileMarker[],
  replacements: readonly string[],
): string {
  return replaceOutboundMediaMarkers(text, markers, replacements);
}

export function stripPartialFileMarker(text: string): string {
  return stripPartialOutboundMediaMarker(text, 'FILE', '');
}

export function sanitizeStreamingFileMarkers(text: string): string {
  return sanitizeOutboundMediaMarkers(text, 'FILE', '');
}

export function safeFileName(filePath: string): string {
  return (
    basename(filePath)
      .replace(
        /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069[\]]+/gu,
        '_',
      )
      .slice(0, 255) || 'file'
  );
}

export function readValidatedFile(
  filePath: string,
  options: { workspaceDir: string; temporaryDir?: string },
): ValidatedFile {
  const file = readValidatedLocalFile(filePath, {
    ...options,
    label: 'File',
  });
  const fileName = safeFileName(file.fileName);
  const extension = extname(fileName).slice(1).toLowerCase();
  return {
    data: file.data,
    fileName,
    fileType: extension || 'file',
    mimeType: 'application/octet-stream',
  };
}

export function uploadDingTalkFile(
  file: ValidatedFile,
  accessToken: string,
): Promise<string> {
  return uploadDingTalkMedia(file, accessToken, 'file');
}
