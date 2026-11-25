/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getFsErrorMessage,
  getExecutionEnvironmentError,
} from './fsErrorMessages.js';

/**
 * Helper to create a mock NodeJS.ErrnoException
 */
function createNodeError(
  code: string,
  message: string,
  path?: string,
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  if (path) {
    error.path = path;
  }
  return error;
}

interface FsErrorCase {
  code: string;
  message: string;
  path?: string;
  expected: string;
}

interface FallbackErrorCase {
  value: unknown;
  expected: string;
}

describe('getFsErrorMessage', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    '%s 的标准存储错误使用统一中性提示',
    (platform) => {
      for (const code of ['EDQUOT', 'ENOSPC']) {
        const error = getExecutionEnvironmentError({ code }, platform);
        expect(error?.code).toBe('storage_insufficient');
        expect(error?.message).toBe(
          'The execution environment does not have enough available disk space to complete this operation. Free up disk space, then try again.',
        );
      }
    },
  );

  it.each([
    ['linux', -28],
    ['linux', -122],
    ['darwin', -28],
    ['darwin', -69],
    ['win32', -4055],
  ] as const)('按平台识别 %s 的存储 errno %s', (platform, errno) => {
    const message = `Unknown system error ${errno}: Unknown system error ${errno}, close`;
    expect(
      getExecutionEnvironmentError({ errno, syscall: 'close' }, platform)?.code,
    ).toBe('storage_insufficient');
    expect(getExecutionEnvironmentError(message, platform)?.code).toBe(
      'storage_insufficient',
    );
    expect(getExecutionEnvironmentError({ errno }, platform)).toBeUndefined();
    expect(
      getExecutionEnvironmentError({ errno, syscall: 'connect' }, platform),
    ).toBeUndefined();
  });

  it.each([
    ['linux', -69],
    ['linux', -4055],
    ['darwin', -122],
    ['darwin', -4055],
    ['win32', -28],
    ['win32', -69],
    ['win32', -122],
  ] as const)('不将 %s 的其他平台 errno %s 判为存储错误', (platform, errno) => {
    expect(
      getExecutionEnvironmentError({ errno, syscall: 'close' }, platform),
    ).toBeUndefined();
  });
  it.each(['close', 'fsync', 'write'])(
    '识别 Linux 文件系统调用 %s 返回的未命名配额错误',
    (syscall) => {
      expect(
        getExecutionEnvironmentError(
          { code: 'Unknown system error -122', errno: -122, syscall },
          'linux',
        )?.code,
      ).toBe('storage_insufficient');
    },
  );

  it('识别 Linux 序列化错误并支持 cause 包装', () => {
    const error = new Error(
      'Unknown system error -122: Unknown system error -122, close',
    );
    expect(getExecutionEnvironmentError(error.message, 'linux')?.code).toBe(
      'storage_insufficient',
    );
    expect(
      getExecutionEnvironmentError(
        new Error('Session failed', { cause: error }),
        'linux',
      )?.code,
    ).toBe('storage_insufficient');
  });

  it('不把其他平台 errno、计费错误或缺少系统调用证据的数值当成存储配额', () => {
    const error = Object.assign(
      new Error('Unknown system error -122: Unknown system error -122, close'),
      { errno: -122, syscall: 'close' },
    );
    expect(getExecutionEnvironmentError(error, 'darwin')).toBeUndefined();
    expect(
      getExecutionEnvironmentError(error.message, 'win32'),
    ).toBeUndefined();
    expect(
      getExecutionEnvironmentError({ errno: -122 }, 'linux'),
    ).toBeUndefined();
    expect(
      getExecutionEnvironmentError({ code: 122 }, 'linux'),
    ).toBeUndefined();
    expect(
      getExecutionEnvironmentError(
        'Billing Group quota exceeded: 122',
        'linux',
      ),
    ).toBeUndefined();
  });

  it('未知错误的循环 cause 不会无限遍历', () => {
    const error = Object.assign(new Error('Unknown'), {
      cause: undefined as unknown,
    });
    error.cause = error;
    expect(getExecutionEnvironmentError(error)).toBeUndefined();
  });
  describe('known filesystem error codes', () => {
    const testCases: FsErrorCase[] = [
      {
        code: 'EACCES',
        message: 'EACCES: permission denied',
        path: '/etc/gemini-cli/settings.json',
        expected:
          "Permission denied: cannot access '/etc/gemini-cli/settings.json'. Check the file or directory permissions.",
      },
      {
        code: 'EACCES',
        message: 'EACCES: permission denied',
        expected: 'Permission denied. Check the file or directory permissions.',
      },
      {
        code: 'ENOENT',
        message: 'ENOENT: no such file or directory',
        path: '/nonexistent/file.txt',
        expected:
          "File or directory not found: '/nonexistent/file.txt'. Check if the path exists and is spelled correctly.",
      },
      {
        code: 'ENOENT',
        message: 'ENOENT: no such file or directory',
        expected:
          'File or directory not found. Check if the path exists and is spelled correctly.',
      },
      {
        code: 'ENOSPC',
        message: 'ENOSPC: no space left on device',
        expected:
          'The execution environment does not have enough available disk space to complete this operation. Free up disk space, then try again.',
      },
      {
        code: 'EDQUOT',
        message: 'EDQUOT: disk quota exceeded',
        expected:
          'The execution environment does not have enough available disk space to complete this operation. Free up disk space, then try again.',
      },
      {
        code: 'EISDIR',
        message: 'EISDIR: illegal operation on a directory',
        path: '/some/directory',
        expected:
          "Path is a directory, not a file: '/some/directory'. Please provide a path to a file instead.",
      },
      {
        code: 'EISDIR',
        message: 'EISDIR: illegal operation on a directory',
        expected:
          'Path is a directory, not a file. Please provide a path to a file instead.',
      },
      {
        code: 'EROFS',
        message: 'EROFS: read-only file system',
        expected:
          'Read-only file system. Ensure the file system allows write operations.',
      },
      {
        code: 'EPERM',
        message: 'EPERM: operation not permitted',
        path: '/protected/file',
        expected:
          "Operation not permitted: '/protected/file'. Ensure you have the required permissions for this action.",
      },
      {
        code: 'EPERM',
        message: 'EPERM: operation not permitted',
        expected:
          'Operation not permitted. Ensure you have the required permissions for this action.',
      },
      {
        code: 'EEXIST',
        message: 'EEXIST: file already exists',
        path: '/existing/file',
        expected:
          "File or directory already exists: '/existing/file'. Try using a different name or path.",
      },
      {
        code: 'EEXIST',
        message: 'EEXIST: file already exists',
        expected:
          'File or directory already exists. Try using a different name or path.',
      },
      {
        code: 'EBUSY',
        message: 'EBUSY: resource busy or locked',
        path: '/locked/file',
        expected: "Resource busy or locked: '/locked/file'. Try again later.",
      },
      {
        code: 'EBUSY',
        message: 'EBUSY: resource busy or locked',
        expected: 'Resource busy or locked. Try again later.',
      },
      {
        code: 'EMFILE',
        message: 'EMFILE: too many open files',
        expected:
          'The execution environment has reached the limit on open files and cannot complete this operation.',
      },
      {
        code: 'ENFILE',
        message: 'ENFILE: file table overflow',
        expected:
          'The execution environment has reached the limit on open files and cannot complete this operation.',
      },
    ];

    it.each(testCases)(
      'returns friendly message for $code (path: $path)',
      ({ code, message, path, expected }) => {
        const error = createNodeError(code, message, path);
        expect(getFsErrorMessage(error)).toBe(expected);
      },
    );
  });

  describe('unknown node error codes', () => {
    const testCases: FsErrorCase[] = [
      {
        code: 'EUNKNOWN',
        message: 'Some unknown error occurred',
        expected: 'Some unknown error occurred (EUNKNOWN)',
      },
      {
        code: 'toString',
        message: 'Unexpected error',
        path: '/some/path',
        expected: 'Unexpected error (toString)',
      },
    ];

    it.each(testCases)(
      'includes code in fallback message for $code',
      ({ code, message, path, expected }) => {
        const error = createNodeError(code, message, path);
        expect(getFsErrorMessage(error)).toBe(expected);
      },
    );
  });

  describe('non-node and nullish errors', () => {
    const fallbackCases: FallbackErrorCase[] = [
      {
        value: new Error('Something went wrong'),
        expected: 'Something went wrong',
      },
      { value: 'string error', expected: 'string error' },
      { value: 12345, expected: '12345' },
      { value: null, expected: 'An unknown error occurred' },
      { value: undefined, expected: 'An unknown error occurred' },
    ];

    it.each(fallbackCases)(
      'returns a message for $value',
      ({ value, expected }) => {
        expect(getFsErrorMessage(value)).toBe(expected);
      },
    );

    it.each([null, undefined] as const)(
      'uses custom default for %s',
      (value) => {
        expect(getFsErrorMessage(value, 'Custom default')).toBe(
          'Custom default',
        );
      },
    );
  });
});

describe('明确的执行环境错误', () => {
  const cases = [
    ['EACCES', 'filesystem_access_denied'],
    ['EPERM', 'filesystem_access_denied'],
    ['EROFS', 'filesystem_access_denied'],
    ['EMFILE', 'open_files_limit_reached'],
    ['ENFILE', 'open_files_limit_reached'],
    ['EIO', 'filesystem_io_failed'],
    ['ESTALE', 'filesystem_io_failed'],
    ['ENOMEM', 'memory_insufficient'],
    ['EBUSY', 'filesystem_busy'],
    ['ETXTBSY', 'filesystem_busy'],
  ] as const;
  it.each(['linux', 'darwin', 'win32'] as const)(
    '%s 识别具备文件系统证据的标准系统错误',
    (platform) => {
      for (const [code, expected] of cases) {
        const error = Object.assign(
          new Error(`${code}: operation failed, open '/private/session.jsonl'`),
          {
            code,
            syscall: 'open',
            path: '/private/session.jsonl',
          },
        );
        const presentation = getExecutionEnvironmentError(error, platform);
        expect(presentation?.code).toBe(expected);
        expect(presentation?.message).not.toMatch(
          /administrator|elevated|\/private/,
        );
        expect(getExecutionEnvironmentError(error.message, platform)).toEqual(
          presentation,
        );
        expect(
          getExecutionEnvironmentError(
            new Error('Session failed', { cause: error }),
            platform,
          ),
        ).toEqual(presentation);
        if (['EACCES', 'EPERM', 'EBUSY'].includes(code)) {
          expect(getFsErrorMessage(error)).toContain('/private/session.jsonl');
        } else if (code !== 'EROFS') {
          expect(getFsErrorMessage(error)).toBe(presentation?.message);
        }
      }
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO', 'ESTALE', 'EBUSY'])(
    '%s 缺少文件系统证据或来自其他系统调用时不推断环境故障',
    (code) => {
      expect(getExecutionEnvironmentError({ code })).toBeUndefined();
      expect(
        getExecutionEnvironmentError(`${code}: operation failed`),
      ).toBeUndefined();
      expect(
        getExecutionEnvironmentError({
          code,
          syscall: 'connect',
          path: '/private/session',
        }),
      ).toBeUndefined();
      expect(
        getExecutionEnvironmentError(`${code}: operation failed, connect`),
      ).toBeUndefined();
      expect(
        getExecutionEnvironmentError({ code, path: '/private/session' }),
      ).toBeDefined();
    },
  );
  it.each(['ENOMEM', 'EMFILE', 'ENFILE'])(
    '%s 无需文件操作证据即可识别资源不足',
    (code) => {
      expect(getExecutionEnvironmentError({ code })).toBeDefined();
      expect(
        getExecutionEnvironmentError(
          `${code}: resource limit reached, connect`,
        ),
      ).toBeDefined();
    },
  );
  it('不把文件监听上限当作磁盘容量，也不从矛盾的文本覆盖 syscall', () => {
    expect(
      getExecutionEnvironmentError({
        code: 'ENOSPC',
        syscall: 'watch',
        message: 'ENOSPC: no space left on device',
      }),
    ).toBeUndefined();
    expect(
      getExecutionEnvironmentError('ENOSPC: no space left on device, watch'),
    ).toBeUndefined();
    expect(
      getExecutionEnvironmentError(
        {
          errno: -122,
          syscall: 'connect',
          message: 'Unknown system error -122: unknown, close',
        },
        'linux',
      ),
    ).toBeUndefined();
  });
  it('没有系统调用证据的 ENOSPC 文本不区分磁盘容量和文件监听上限', () => {
    expect(
      getExecutionEnvironmentError('ENOSPC: no space left on device'),
    ).toBeUndefined();
  });
  it.each(['ENOENT', 'EINVAL', 'EAGAIN'])(
    '%s 不直接解释为执行环境故障',
    (code) => {
      expect(
        getExecutionEnvironmentError({ code, syscall: 'open' }),
      ).toBeUndefined();
    },
  );
  it('不把服务端或进程退出信息当成本地内存不足', () => {
    expect(
      getExecutionEnvironmentError({ code: 'ENOMEM', providerCode: '500' }),
    ).toBeUndefined();
    expect(
      getExecutionEnvironmentError({ code: 137, signal: 'SIGKILL' }),
    ).toBeUndefined();
    expect(
      getExecutionEnvironmentError('Process exited with code 137'),
    ).toBeUndefined();
  });
});
