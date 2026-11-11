/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, statSync, type Stats } from 'node:fs';
import {
  ENV_WINDOWS_SHELL_KIND,
  WINDOWS_SHELL_KIND_GIT_BASH,
  _resetWindowsPathsForTest,
  findGitBashPath,
  findGitBashPathSync,
  normalizeWindowsBashCommand,
  prependWindowsExecutableDirectoryToPath,
  setShellIfWindows,
  tryFindGitBashPathForOptionalRunner,
} from './windowsPaths.js';
import {
  findPreparedGitPath,
  getGitBashPreparationState,
} from './envprep/index.js';
import { ENV_BASH_PATH, ENV_GIT_BASH_PATH } from '../config/brand.js';
import { sessionLogger } from './diagnosticLogger.js';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  probe: vi.fn(
    (_name: string, _signal?: AbortSignal): string | Promise<string> => {
      throw new Error('not found');
    },
  ),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    statSync: vi.fn(),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: mocks.execFile,
  };
});

vi.mock('./windowsExecutableProbe.js', () => ({
  runWindowsExecutableProbe: (name: string, signal?: AbortSignal) =>
    mocks.probe(name, signal),
}));

vi.mock('./platform.js', () => ({
  getPlatform: vi.fn(() => 'windows'),
}));

vi.mock('./envprep/index.js', () => ({
  findPreparedGitPath: vi.fn(() => ''),
  getGitBashPreparationState: vi.fn(() => ({ status: 'idle' })),
}));

describe('normalizeWindowsBashCommand', () => {
  it.each([
    ['status.sh --compact', 'bash status.sh --compact'],
    [
      '"C:\\Program Files\\status line.sh" --compact',
      'bash "C:\\Program Files\\status line.sh" --compact',
    ],
    ['status\\ line.sh --compact', 'bash status\\ line.sh --compact'],
    ['node status.sh', 'node status.sh'],
    ['status.SH', 'status.SH'],
  ])('normalizes %j to %j', (command, expected) => {
    expect(normalizeWindowsBashCommand(command)).toBe(expected);
  });
});

describe('prependWindowsExecutableDirectoryToPath', () => {
  const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const bashDirectory = 'C:\\Program Files\\Git\\bin';

  it.each([
    {
      name: 'an uppercase hook override after an inherited mixed-case key',
      env: {
        Path: 'C:\\Windows\\System32',
        PATH: 'D:\\Hook\\bin',
      },
      effectiveKey: 'PATH',
      expectedPath: `${bashDirectory};D:\\Hook\\bin`,
    },
    {
      name: 'a mixed-case hook override after an inherited uppercase key',
      env: {
        PATH: 'C:\\Windows\\System32',
        Path: 'D:\\Hook\\bin',
      },
      effectiveKey: 'Path',
      expectedPath: `${bashDirectory};D:\\Hook\\bin`,
    },
  ])('keeps only $name', ({ env, effectiveKey, expectedPath }) => {
    prependWindowsExecutableDirectoryToPath(env, bashPath);

    expect(env[effectiveKey as keyof typeof env]).toBe(expectedPath);
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(
      [effectiveKey],
    );
  });

  it('creates PATH when the child environment does not contain one', () => {
    const env: Record<string, string | undefined> = { HOME: 'C:\\Users\\me' };

    prependWindowsExecutableDirectoryToPath(env, bashPath);

    expect(env).toEqual({
      HOME: 'C:\\Users\\me',
      PATH: bashDirectory,
    });
  });

  it('leaves PATH aliases unchanged for a relative executable', () => {
    const env = {
      Path: 'C:\\Windows\\System32',
      PATH: 'D:\\Hook\\bin',
    };

    prependWindowsExecutableDirectoryToPath(env, 'bash.exe');

    expect(env).toEqual({
      Path: 'C:\\Windows\\System32',
      PATH: 'D:\\Hook\\bin',
    });
  });
});

describe('setShellIfWindows', () => {
  const originalShell = process.env['SHELL'];
  const originalHint = process.env[ENV_WINDOWS_SHELL_KIND];

  beforeEach(() => {
    _resetWindowsPathsForTest();
    delete process.env['SHELL'];
    delete process.env[ENV_WINDOWS_SHELL_KIND];
  });

  afterEach(() => {
    _resetWindowsPathsForTest();
    if (originalShell === undefined) {
      delete process.env['SHELL'];
    } else {
      process.env['SHELL'] = originalShell;
    }
    if (originalHint === undefined) {
      delete process.env[ENV_WINDOWS_SHELL_KIND];
    } else {
      process.env[ENV_WINDOWS_SHELL_KIND] = originalHint;
    }
  });

  it('does not set SHELL to a bare bash.exe when Git Bash is unresolved', async () => {
    await setShellIfWindows();

    expect(process.env['SHELL']).toBeUndefined();
    expect(process.env[ENV_WINDOWS_SHELL_KIND]).toBe(
      WINDOWS_SHELL_KIND_GIT_BASH,
    );
  });
});

describe('tryFindGitBashPathForOptionalRunner', () => {
  const originalGitBashPath = process.env[ENV_GIT_BASH_PATH];
  const originalGenericGitBashPath = process.env['GIT_BASH'];
  const originalShell = process.env['SHELL'];
  const originalSystemRoot = process.env['SYSTEMROOT'];

  beforeEach(() => {
    _resetWindowsPathsForTest();
    vi.clearAllMocks();
    vi.mocked(findPreparedGitPath).mockReturnValue('');
    vi.mocked(getGitBashPreparationState).mockReturnValue({ status: 'idle' });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.spyOn(sessionLogger, 'setExitContext').mockImplementation(
      () => undefined,
    );
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        callback(new Error('not found'), '', '');
      },
    );
    delete process.env[ENV_GIT_BASH_PATH];
    delete process.env['GIT_BASH'];
    delete process.env['SHELL'];
    process.env['SYSTEMROOT'] = 'C:\\Windows';
  });

  afterEach(() => {
    _resetWindowsPathsForTest();
    vi.restoreAllMocks();
    if (originalGitBashPath === undefined) {
      delete process.env[ENV_GIT_BASH_PATH];
    } else {
      process.env[ENV_GIT_BASH_PATH] = originalGitBashPath;
    }
    if (originalGenericGitBashPath === undefined) {
      delete process.env['GIT_BASH'];
    } else {
      process.env['GIT_BASH'] = originalGenericGitBashPath;
    }
    if (originalShell === undefined) {
      delete process.env['SHELL'];
    } else {
      process.env['SHELL'] = originalShell;
    }
    if (originalSystemRoot === undefined) {
      delete process.env['SYSTEMROOT'];
    } else {
      process.env['SYSTEMROOT'] = originalSystemRoot;
    }
  });

  it('returns null without synchronous discovery or preparation when Bash is unavailable', async () => {
    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();

    expect(mocks.execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\where.exe',
      ['git'],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(findPreparedGitPath).not.toHaveBeenCalled();
    expect(getGitBashPreparationState).toHaveBeenCalledOnce();
  });

  it('uses a succeeded managed preparation without revalidating executables', async () => {
    const preparedPath =
      'C:\\Users\\me\\.qwen\\bin\\git\\bin\\bash.exe';
    vi.mocked(getGitBashPreparationState).mockReturnValue({
      status: 'succeeded',
      bashPath: preparedPath,
    });
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === preparedPath,
    );

    await expect(tryFindGitBashPathForOptionalRunner()).resolves.toBe(
      preparedPath,
    );
    expect(process.env['SHELL']).toBeUndefined();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(findPreparedGitPath).not.toHaveBeenCalled();
  });

  it('uses a valid explicit override without a PATH lookup', async () => {
    const configuredPath = 'D:\\Tools\\Git\\bin\\bash.exe';
    process.env[ENV_GIT_BASH_PATH] = configuredPath;
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === configuredPath,
    );

    await expect(tryFindGitBashPathForOptionalRunner()).resolves.toBe(
      configuredPath,
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('uses a standard Git for Windows installation without a PATH lookup', async () => {
    const standardPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === standardPath,
    );

    await expect(tryFindGitBashPathForOptionalRunner()).resolves.toBe(
      standardPath,
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('derives Git Bash from an asynchronously discovered git.exe', async () => {
    const gitPath = 'D:\\Tools\\Git\\cmd\\git.exe';
    const bashPath = 'D:\\Tools\\Git\\bin\\bash.exe';
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === gitPath || candidate === bashPath,
    );
    mocks.execFile.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        callback(null, `${gitPath}\r\n`, '');
      },
    );

    await expect(tryFindGitBashPathForOptionalRunner()).resolves.toBe(
      bashPath,
    );
    expect(process.env['SHELL']).toBeUndefined();
  });

  it('does not derive Bash from later where.exe results', async () => {
    const firstGitPath = 'C:\\Tools\\Shim\\cmd\\git.exe';
    const secondGitPath = 'D:\\Tools\\Git\\cmd\\git.exe';
    const secondBashPath = 'D:\\Tools\\Git\\bin\\bash.exe';
    vi.mocked(existsSync).mockImplementation(
      (candidate) =>
        candidate === firstGitPath ||
        candidate === secondGitPath ||
        candidate === secondBashPath,
    );
    mocks.execFile.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        callback(null, `${firstGitPath}\r\n${secondGitPath}\r\n`, '');
      },
    );

    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();
    expect(process.env['SHELL']).toBeUndefined();
  });

  it('does not replace the Bash selected by the main resolver', async () => {
    const mainBashPath = 'C:\\custom\\bin\\bash.exe';
    const optionalBashPath = 'D:\\Tools\\Git\\bin\\bash.exe';
    process.env['GIT_BASH'] = mainBashPath;
    vi.mocked(existsSync).mockImplementation(
      (candidate) =>
        candidate === mainBashPath || candidate === optionalBashPath,
    );

    await expect(findGitBashPath()).resolves.toBe(mainBashPath);
    expect(process.env['SHELL']).toBe(mainBashPath);

    process.env[ENV_GIT_BASH_PATH] = optionalBashPath;
    await expect(tryFindGitBashPathForOptionalRunner()).resolves.toBe(
      optionalBashPath,
    );
    expect(process.env['SHELL']).toBe(mainBashPath);
    await expect(findGitBashPath()).resolves.toBe(mainBashPath);
  });

  it('rejects git.exe discovered inside the current workspace', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\workspace');
    const gitPath = 'C:\\workspace\\cmd\\git.exe';
    const bashPath = 'C:\\workspace\\bin\\bash.exe';
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === gitPath || candidate === bashPath,
    );
    mocks.execFile.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        callback(null, `${gitPath}\r\n`, '');
      },
    );

    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();
    expect(process.env['SHELL']).toBeUndefined();
  });

  it('rejects where.exe results without a Windows executable extension', async () => {
    const gitPath = 'D:\\Tools\\Git\\cmd\\git';
    const bashPath = 'D:\\Tools\\Git\\bin\\bash.exe';
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === gitPath || candidate === bashPath,
    );
    mocks.execFile.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        callback(null, `${gitPath}\r\n`, '');
      },
    );

    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();
    expect(process.env['SHELL']).toBeUndefined();
  });

  it('memoizes a negative asynchronous git.exe lookup', async () => {
    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();
    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();

    expect(mocks.execFile).toHaveBeenCalledOnce();
  });

  it('ignores an invalid override without changing diagnostic exit state', async () => {
    process.env[ENV_GIT_BASH_PATH] = 'C:\\missing\\bash.exe';

    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();
    expect(sessionLogger.setExitContext).not.toHaveBeenCalled();
  });

  it('ignores a script-wrapper override without changing diagnostic exit state', async () => {
    const wrapperPath = 'C:\\Users\\me\\scoop\\shims\\bash.cmd';
    process.env[ENV_GIT_BASH_PATH] = wrapperPath;
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === wrapperPath,
    );

    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();
    expect(sessionLogger.setExitContext).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledOnce();
  });

  it('does not trust a global Bash cache populated by a non-optional source', async () => {
    const genericBash = 'C:\\cygwin64\\bin\\bash.exe';
    process.env['GIT_BASH'] = genericBash;
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === genericBash,
    );

    await expect(findGitBashPath()).resolves.toBe(genericBash);
    delete process.env['GIT_BASH'];
    await expect(
      tryFindGitBashPathForOptionalRunner(),
    ).resolves.toBeNull();
    expect(mocks.execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\where.exe',
      ['git'],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe('findGitBashPath cancellation', () => {
  it('rejects an already cancelled discovery before falling back to setup', async () => {
    _resetWindowsPathsForTest();
    const controller = new AbortController();
    const reason = new Error('shell initialization cancelled');
    controller.abort(reason);
    await expect(findGitBashPath(controller.signal)).rejects.toBe(reason);
  });
});

describe('findGitBashPath', () => {
  const managedEnvNames = [
    ENV_GIT_BASH_PATH,
    ENV_BASH_PATH,
    'GIT_BASH',
    'BASH_PATH',
    'GIT_HOME',
    'SHELL',
    'PATH',
    'Path',
    'PATHEXT',
  ] as const;
  const originalEnv = new Map(
    managedEnvNames.map((name) => [name, process.env[name]]),
  );

  beforeEach(() => {
    _resetWindowsPathsForTest();
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(findPreparedGitPath).mockReturnValue('');
    vi.mocked(getGitBashPreparationState).mockReturnValue({ status: 'idle' });
    mocks.probe.mockImplementation(() => {
      throw new Error('not found');
    });
    vi.spyOn(sessionLogger, 'setExitContext').mockImplementation(
      () => undefined,
    );
    for (const name of managedEnvNames) delete process.env[name];
  });

  afterEach(() => {
    _resetWindowsPathsForTest();
    vi.restoreAllMocks();
    for (const [name, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it.each([
    {
      name: 'git.exe on PATH',
      entries: ['D:\\PortableGit\\cmd'],
      files: ['D:\\PortableGit\\cmd\\git.exe', 'D:\\PortableGit\\bin\\bash.exe'],
      expected: 'D:\\PortableGit\\bin\\bash.exe',
    },
    {
      name: 'native bash.exe after wrappers and WSL',
      entries: ['C:\\Windows\\System32', 'D:\\Shims', 'D:\\OnlyBash'],
      files: [
        'C:\\Windows\\System32\\bash.exe',
        'D:\\Shims\\bash.cmd',
        'D:\\OnlyBash\\bash.exe',
      ],
      expected: 'D:\\OnlyBash\\bash.exe',
    },
    {
      name: 'later Git after an unrelated shim',
      entries: ['D:\\Shims', 'D:\\PortableGit\\cmd'],
      files: [
        'D:\\Shims\\git.cmd',
        'D:\\PortableGit\\cmd\\git.exe',
        'D:\\PortableGit\\bin\\bash.exe',
      ],
      expected: 'D:\\PortableGit\\bin\\bash.exe',
    },
  ])(
    'preserves synchronous discovery of $name without a subprocess',
    ({ entries, files, expected }) => {
      process.env['Path'] = entries.map((entry) => `"${entry}"`).join(';');
      process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';
      const available = new Set(files.map((file) => file.toLowerCase()));
      vi.mocked(existsSync).mockImplementation((candidate) =>
        available.has(String(candidate).toLowerCase()),
      );
      vi.mocked(statSync).mockReturnValue({ isFile: () => true } as Stats);
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('unexpected process exit');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(findGitBashPathSync().toLowerCase()).toBe(expected.toLowerCase());
      expect(mocks.execFile).not.toHaveBeenCalled();
      expect(mocks.probe).not.toHaveBeenCalled();
    },
  );

  it.each(['git', 'bash'] as const)(
    'reports a %s probe timeout without caching absence and permits retry',
    async (target) => {
      const error = new DOMException(
        `where.exe ${target} timed out`,
        'TimeoutError',
      );
      mocks.probe.mockImplementation((name) => {
        if (name === target) throw error;
        return '';
      });
      await expect(findGitBashPath()).rejects.toBe(error);
      expect(getGitBashPreparationState).not.toHaveBeenCalled();
      const gitPath = 'D:\\Tools\\Git\\cmd\\git.exe';
      const bashPath = 'D:\\Tools\\Git\\bin\\bash.exe';
      vi.mocked(existsSync).mockImplementation(
        (candidate) => candidate === gitPath || candidate === bashPath,
      );
      mocks.probe.mockReturnValue(`${gitPath}\r\n`);
      await expect(findGitBashPath()).resolves.toBe(bashPath);
    },
  );

  it('cancels an in-flight PATH scan and permits a later retry', async () => {
    const controller = new AbortController();
    const reason = new Error('discovery cancelled');
    let probeStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    mocks.probe.mockImplementationOnce(
      (_name, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), {
            once: true,
          });
          probeStarted();
        }),
    );
    const first = findGitBashPath(controller.signal);
    await entered;
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);

    const gitPath = 'D:\\Tools\\Git\\cmd\\git.exe';
    const bashPath = 'D:\\Tools\\Git\\bin\\bash.exe';
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === gitPath || candidate === bashPath,
    );
    mocks.probe.mockReturnValueOnce(`${gitPath}\r\n`);
    await expect(findGitBashPath()).resolves.toBe(bashPath);
  });

  it('rejects an explicit script-wrapper override with an actionable error', async () => {
    const wrapperPath = 'C:\\Users\\me\\scoop\\shims\\bash.CMD';
    process.env[ENV_GIT_BASH_PATH] = wrapperPath;
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === wrapperPath,
    );

    await expect(findGitBashPath()).rejects.toThrow(
      'Windows shell script wrapper',
    );
    expect(process.env['SHELL']).toBeUndefined();
    expect(sessionLogger.setExitContext).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'config_error' }),
    );
  });

  it('skips a script wrapper returned before a native bash executable', async () => {
    const wrapperPath = 'C:\\Users\\me\\scoop\\shims\\bash.cmd';
    const nativePath = 'D:\\PortableGit\\bin\\bash.exe';
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === wrapperPath || candidate === nativePath,
    );
    mocks.probe.mockImplementation((name) => {
      if (name === 'bash') {
        return `${wrapperPath}\r\n${nativePath}\r\n`;
      }
      throw new Error('not found');
    });

    await expect(findGitBashPath()).resolves.toBe(nativePath);
    expect(process.env['SHELL']).toBe(nativePath);
  });

  it('does not activate a script wrapper when no native Bash is available', async () => {
    const wrapperPath = 'C:\\Users\\me\\scoop\\shims\\bash.cmd';
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === wrapperPath,
    );
    mocks.probe.mockImplementation((name) => {
      if (name === 'bash') return `${wrapperPath}\r\n`;
      throw new Error('not found');
    });

    await expect(findGitBashPath()).rejects.toThrow(
      'automatic setup is not currently running',
    );
    expect(process.env['SHELL']).toBeUndefined();
  });

  it('ignores a generic script-wrapper environment value and continues discovery', async () => {
    const wrapperPath = 'C:\\Users\\me\\scoop\\shims\\bash.cmd';
    const nativePath = 'D:\\PortableGit\\bin\\bash.exe';
    process.env['GIT_BASH'] = wrapperPath;
    vi.mocked(existsSync).mockImplementation(
      (candidate) => candidate === wrapperPath || candidate === nativePath,
    );
    mocks.probe.mockImplementation((name) => {
      if (name === 'bash') return `${nativePath}\r\n`;
      throw new Error('not found');
    });

    await expect(findGitBashPath()).resolves.toBe(nativePath);
  });

  it('throws when preparation is idle', async () => {
    await expect(findGitBashPath()).rejects.toThrow(
      'automatic setup is not currently running',
    );
  });

  it('throws with last error when preparation failed', async () => {
    vi.mocked(getGitBashPreparationState).mockReturnValue({
      status: 'failed',
      lastError: 'network failed',
    });

    await expect(findGitBashPath()).rejects.toThrow('network failed');
  });

  it('waits for running preparation and returns bash path on success', async () => {
    vi.mocked(getGitBashPreparationState).mockReturnValue({
      status: 'running',
      promise: Promise.resolve({
        ok: true,
        bashPath: 'C:\\Users\\me\\.qwen\\bin\\git\\bin\\bash.exe',
      }),
    });

    await expect(findGitBashPath()).resolves.toBe(
      'C:\\Users\\me\\.qwen\\bin\\git\\bin\\bash.exe',
    );
    expect(process.env['SHELL']).toBe(
      'C:\\Users\\me\\.qwen\\bin\\git\\bin\\bash.exe',
    );
  });

  it('waits for running preparation and throws on failure', async () => {
    vi.mocked(getGitBashPreparationState).mockReturnValue({
      status: 'running',
      promise: Promise.resolve({
        ok: false,
        error: 'download failed',
      }),
    });

    await expect(findGitBashPath()).rejects.toThrow('download failed');
  });
});
