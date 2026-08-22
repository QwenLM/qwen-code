import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, sep } from 'node:path';

export const MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024;

export interface ValidatedLocalFile {
  data: Buffer;
  fileName: string;
}

function isInside(realPath: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, realPath);
  if (pathFromDirectory === '') return true;
  if (isAbsolute(pathFromDirectory)) return false;
  // `startsWith('..')` alone also rejects legitimate names that merely begin
  // with two dots (`..config`, `..cache/report.pdf`). Only a `..` that is a
  // whole path SEGMENT means the target escaped the directory.
  return (
    pathFromDirectory !== '..' && !pathFromDirectory.startsWith(`..${sep}`)
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

  // R7-2: identity of the validated path BEFORE the open. The kernel follows
  // a DIRECTORY component swapped between the containment check and the open
  // — both the open and the post-open `statSync(realPath)` resolve through
  // the swapped path and agree, so the descriptor check alone cannot see it.
  // Comparing this pre-open resolution against the opened descriptor catches
  // a swap landing in that window; only the stat-to-open gap remains, and
  // closing even that needs openat(2)-style traversal node's sync fs API
  // does not expose.
  let preOpen: Stats;
  try {
    preOpen = statSync(realPath);
  } catch {
    throw new Error(`${label} path changed during validation`);
  }

  let descriptor: number;
  try {
    // O_NOFOLLOW: `realPath` has no symlink final component by construction, so
    // if one is there by the time we open, the path was swapped between the
    // containment check and this call. Refusing to follow it closes the widest
    // leg of that race.
    descriptor = openSync(
      realPath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(`${label} could not be opened`);
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error('Not a regular file');
    }
    // The descriptor is what the validated path pointed at, not merely what
    // that path resolves to now.
    let current: Stats;
    try {
      current = statSync(realPath);
    } catch {
      throw new Error(`${label} path changed during validation`);
    }
    if (
      preOpen.ino !== stats.ino ||
      preOpen.dev !== stats.dev ||
      current.ino !== stats.ino ||
      current.dev !== stats.dev
    ) {
      throw new Error(`${label} path changed during validation`);
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
    // A short read means the file was truncated under us. Returning the partial
    // buffer would upload a silently corrupt attachment that the recipient has
    // no way to tell apart from the real thing.
    if (offset !== stats.size) {
      throw new Error(`${label} changed while being read`);
    }
    if (offset === 0 && options.allowEmpty !== true) {
      throw new Error(`${label} is empty`);
    }

    return { data, fileName: basename(realPath) };
  } finally {
    closeSync(descriptor);
  }
}
