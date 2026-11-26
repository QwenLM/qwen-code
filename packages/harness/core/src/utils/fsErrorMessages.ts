/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isNodeError, getErrorMessage } from './errors.js';

export const EXECUTION_ENVIRONMENT_ERROR_CODES = {
  storageInsufficient: 'storage_insufficient',
  filesystemAccessDenied: 'filesystem_access_denied',
  openFilesLimitReached: 'open_files_limit_reached',
  filesystemIoFailed: 'filesystem_io_failed',
  memoryInsufficient: 'memory_insufficient',
  filesystemBusy: 'filesystem_busy',
} as const;

const ENVIRONMENT_ERRORS = {
  storageInsufficient: {
    code: EXECUTION_ENVIRONMENT_ERROR_CODES.storageInsufficient,
    message:
      'The execution environment does not have enough available disk space to complete this operation. Free up disk space, then try again.',
  },
  filesystemAccessDenied: {
    code: EXECUTION_ENVIRONMENT_ERROR_CODES.filesystemAccessDenied,
    message:
      'Access permissions or read-only restrictions in the execution environment prevent this operation. Check the permissions and directory status.',
  },
  openFilesLimitReached: {
    code: EXECUTION_ENVIRONMENT_ERROR_CODES.openFilesLimitReached,
    message:
      'The execution environment has reached the limit on open files and cannot complete this operation.',
  },
  filesystemIoFailed: {
    code: EXECUTION_ENVIRONMENT_ERROR_CODES.filesystemIoFailed,
    message:
      'A file system read or write operation failed in the execution environment. Check whether the storage location is accessible.',
  },
  memoryInsufficient: {
    code: EXECUTION_ENVIRONMENT_ERROR_CODES.memoryInsufficient,
    message:
      'The execution environment does not have enough available memory to complete this operation.',
  },
  filesystemBusy: {
    code: EXECUTION_ENVIRONMENT_ERROR_CODES.filesystemBusy,
    message:
      'A file or directory required for this operation is currently in use. Try again later.',
  },
} as const;

type EnvironmentError =
  (typeof ENVIRONMENT_ERRORS)[keyof typeof ENVIRONMENT_ERRORS];
const NATIVE_ERRORS: Readonly<Record<string, EnvironmentError>> = {
  EDQUOT: ENVIRONMENT_ERRORS.storageInsufficient,
  ENOSPC: ENVIRONMENT_ERRORS.storageInsufficient,
  EACCES: ENVIRONMENT_ERRORS.filesystemAccessDenied,
  EPERM: ENVIRONMENT_ERRORS.filesystemAccessDenied,
  EROFS: ENVIRONMENT_ERRORS.filesystemAccessDenied,
  EMFILE: ENVIRONMENT_ERRORS.openFilesLimitReached,
  ENFILE: ENVIRONMENT_ERRORS.openFilesLimitReached,
  EIO: ENVIRONMENT_ERRORS.filesystemIoFailed,
  ESTALE: ENVIRONMENT_ERRORS.filesystemIoFailed,
  ENOMEM: ENVIRONMENT_ERRORS.memoryInsufficient,
  EBUSY: ENVIRONMENT_ERRORS.filesystemBusy,
  ETXTBSY: ENVIRONMENT_ERRORS.filesystemBusy,
};
const AMBIGUOUS_FILESYSTEM_CODES = new Set([
  'EACCES',
  'EPERM',
  'EIO',
  'ESTALE',
  'EBUSY',
]);
const STORAGE_CODES = new Set(['EDQUOT', 'ENOSPC']);

// Unix 使用系统 errno 的负值；Windows 使用 libuv 定义的 ENOSPC 值。
const STORAGE_ERRNOS: Partial<Record<NodeJS.Platform, readonly number[]>> = {
  linux: [-28, -122],
  darwin: [-28, -69],
  win32: [-4055],
};
const FILESYSTEM_SYSCALL =
  /^(?:open|read|readv|write|writev|fsync|fdatasync|close|mkdir|rename|truncate|ftruncate|stat|lstat|fstat|statfs|fstatfs|scandir|readdir|unlink|rmdir|access|chmod|fchmod|chown|fchown|lchown|utime|utimes|futimes|lutimes|realpath|readlink|link|symlink|copyfile|sendfile)$/;

/** 只分类明确的执行环境故障；含义依赖操作的错误必须具有文件系统证据。 */
export function getExecutionEnvironmentError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): EnvironmentError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const record =
      typeof current === 'object'
        ? (current as Record<string, unknown>)
        : undefined;
    // 服务端错误描述的是远端请求，不据此判断本地执行环境。
    if (
      record &&
      ('providerCode' in record || 'providerStatus' in record)
    )
      return undefined;
    const message =
      typeof current === 'string'
        ? current
        : typeof record?.['message'] === 'string'
          ? record['message']
          : '';
    const text = message.replace(/^\[?API Error:\s*/, '').replace(/\]$/, '');
    for (const presentation of Object.values(ENVIRONMENT_ERRORS)) {
      if (
        record?.['code'] === presentation.code ||
        text === presentation.message
      ) {
        return presentation;
      }
    }
    const messageCode = /^([A-Z]+):/.exec(text)?.[1];
    const code =
      typeof record?.['code'] === 'string' &&
      Object.hasOwn(NATIVE_ERRORS, record['code'])
        ? record['code']
        : messageCode;
    // Node 系统错误格式为 CODE: description, syscall 'path'。
    const messageSyscall = /^[A-Z]+:.*?, (\w+)\b/.exec(text)?.[1];
    const syscall =
      typeof record?.['syscall'] === 'string'
        ? record['syscall']
        : messageSyscall;
    const filesystemCall =
      syscall !== undefined && FILESYSTEM_SYSCALL.test(syscall);
    const filesystemEvidence =
      filesystemCall ||
      (syscall === undefined && typeof record?.['path'] === 'string');
    if (code && Object.hasOwn(NATIVE_ERRORS, code)) {
      if (
        (!AMBIGUOUS_FILESYSTEM_CODES.has(code) || filesystemEvidence) &&
        // ENOSPC 也可能来自文件监听数量上限，不能解释为磁盘容量。
        (!STORAGE_CODES.has(code) || syscall === undefined || filesystemCall) &&
        // 只有 ENOSPC 文本而没有调用信息时，也可能是文件监听上限。
        (code !== 'ENOSPC' ||
          filesystemEvidence ||
          (record?.['code'] === code && syscall === undefined))
      ) {
        return NATIVE_ERRORS[code];
      }
    } else {
      const unknownError = /^Unknown system error (-\d+):.*?, (\w+)\b/.exec(
        text,
      );
      const storageErrnos = STORAGE_ERRNOS[platform] ?? [];
      if (
        (storageErrnos.includes(Number(record?.['errno'])) && filesystemCall) ||
        (syscall === undefined &&
          unknownError &&
          storageErrnos.includes(Number(unknownError[1])) &&
          FILESYSTEM_SYSCALL.test(unknownError[2] ?? ''))
      ) {
        return ENVIRONMENT_ERRORS.storageInsufficient;
      }
    }
    current = record?.['cause'];
  }
  return undefined;
}

/**
 * Map of Node.js filesystem error codes to user-friendly message generators.
 * Each function takes the path (if available) and returns a descriptive message.
 */
const errorMessageGenerators: Record<string, (path?: string) => string> = {
  EACCES: (path) =>
    (path
      ? `Permission denied: cannot access '${path}'. `
      : 'Permission denied. ') + 'Check the file or directory permissions.',
  ENOENT: (path) =>
    (path
      ? `File or directory not found: '${path}'. `
      : 'File or directory not found. ') +
    'Check if the path exists and is spelled correctly.',
  EISDIR: (path) =>
    (path
      ? `Path is a directory, not a file: '${path}'. `
      : 'Path is a directory, not a file. ') +
    'Please provide a path to a file instead.',
  EROFS: () =>
    'Read-only file system. Ensure the file system allows write operations.',
  EPERM: (path) =>
    (path
      ? `Operation not permitted: '${path}'. `
      : 'Operation not permitted. ') +
    'Ensure you have the required permissions for this action.',
  EEXIST: (path) =>
    (path
      ? `File or directory already exists: '${path}'. `
      : 'File or directory already exists. ') +
    'Try using a different name or path.',
  EBUSY: (path) =>
    (path
      ? `Resource busy or locked: '${path}'. `
      : 'Resource busy or locked. ') + 'Try again later.',
};

/**
 * Converts a Node.js filesystem error to a user-friendly message.
 *
 * @param error - The error to convert
 * @param defaultMessage - Optional default message if error cannot be interpreted
 * @returns A user-friendly error message
 */
export function getFsErrorMessage(
  error: unknown,
  defaultMessage = 'An unknown error occurred',
): string {
  if (error == null) {
    return defaultMessage;
  }

  // 工具内的路径错误保留目标位置，帮助调用方修正具体操作。
  if (
    isNodeError(error) &&
    error.code &&
    Object.hasOwn(errorMessageGenerators, error.code)
  ) {
    return errorMessageGenerators[error.code](error.path);
  }
  const environmentError = getExecutionEnvironmentError(error);
  if (environmentError) return environmentError.message;

  if (isNodeError(error)) {
    const code = error.code;

    // 调用方已明确这是文件系统操作，不要求异常再次携带 syscall 或 path。
    if (code && Object.hasOwn(NATIVE_ERRORS, code)) {
      return NATIVE_ERRORS[code].message;
    }

    // For unknown error codes, include the code in the message
    if (code) {
      const baseMessage = error.message || defaultMessage;
      return `${baseMessage} (${code})`;
    }
  }

  // For non-Node errors, return the error message or string representation
  return getErrorMessage(error);
}
