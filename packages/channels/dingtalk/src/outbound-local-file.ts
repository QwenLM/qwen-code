import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative } from 'node:path';

export const MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024;

export interface ValidatedLocalFile {
  data: Buffer;
  fileName: string;
}

function isInside(realPath: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, realPath);
  return (
    pathFromDirectory === '' ||
    (!pathFromDirectory.startsWith('..') && !isAbsolute(pathFromDirectory))
  );
}

export function readValidatedLocalFile(
  filePath: string,
  options: {
    workspaceDir: string;
    temporaryDir?: string;
    label: 'File' | 'Image';
    allowEmpty?: boolean;
  },
): ValidatedLocalFile {
  const { label } = options;
  if (!isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute`);
  }

  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    throw new Error(`${label} file not found`);
  }
  let allowedDirectories: string[];
  try {
    allowedDirectories = [
      realpathSync(options.workspaceDir),
      realpathSync(options.temporaryDir ?? tmpdir()),
    ];
  } catch {
    throw new Error(`${label} allowed directory unavailable`);
  }
  if (!allowedDirectories.some((directory) => isInside(realPath, directory))) {
    throw new Error(`${label} path outside allowed directories`);
  }

  let descriptor: number;
  try {
    descriptor = openSync(realPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new Error(`${label} could not be opened`);
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error('Not a regular file');
    }
    if (stats.size === 0 && options.allowEmpty !== true) {
      throw new Error(`${label} is empty`);
    }
    if (stats.size > MAX_OUTBOUND_MEDIA_BYTES) {
      throw new Error(
        `${label} too large: ${stats.size} bytes (max ${MAX_OUTBOUND_MEDIA_BYTES})`,
      );
    }

    const data = Buffer.alloc(stats.size);
    let offset = 0;
    try {
      while (offset < data.length) {
        const bytesRead = readSync(
          descriptor,
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
    } catch {
      throw new Error(`${label} could not be read`);
    }
    if (offset === 0 && options.allowEmpty !== true) {
      throw new Error(`${label} is empty`);
    }

    return { data: data.subarray(0, offset), fileName: basename(realPath) };
  } finally {
    closeSync(descriptor);
  }
}
