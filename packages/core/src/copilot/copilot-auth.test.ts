import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.mkdir.mockImplementation(actual.mkdir);
  fsMocks.readFile.mockImplementation(actual.readFile);
  fsMocks.writeFile.mockImplementation(actual.writeFile);
  fsMocks.rename.mockImplementation(actual.rename);
  return {
    ...actual,
    mkdir: fsMocks.mkdir,
    readFile: fsMocks.readFile,
    writeFile: fsMocks.writeFile,
    rename: fsMocks.rename,
  };
});

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import lockfile from 'proper-lockfile';
import {
  parseProxyEp,
  discoverGithubToken,
  exchangeGhuForCapi,
  createCopilotTokenManager,
  runCopilotDeviceFlow,
  persistGithubToken,
} from './copilot-auth.js';
import { mockCompromisedLock } from '../test-utils/mock-compromised-lock.js';

const CHILD_LOCK_HOLDER_TIMEOUT_MS = 5_000;

function waitForPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startCooperatingLockHolder(
  hostsFile: string,
): Promise<{ release(): Promise<void> }> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import lockfile from 'proper-lockfile';
        const release = await lockfile.lock(process.argv[1], {
          realpath: false,
          retries: 0,
          stale: 10_000,
        });
        process.stdout.write('locked\\n');
        process.stdin.once('data', async () => {
          try {
            await release();
            process.exit(0);
          } catch (error) {
            console.error(error);
            process.exit(1);
          }
        });
      `,
      hostsFile,
    ],
    { stdio: 'pipe' },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const locked = new Promise<void>((resolve, reject) => {
    let acquired = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `Child lock holder timed out before acquiring lock: ${stderr}`,
        ),
      );
    }, CHILD_LOCK_HOLDER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (acquired || !chunk.toString().includes('locked')) return;
      acquired = true;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (acquired) return;
      clearTimeout(timer);
      reject(
        new Error(
          `Child lock holder exited before acquiring lock (code ${code}, signal ${signal}): ${stderr}`,
        ),
      );
    });
  });

  try {
    await locked;
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await waitForPromise(
          new Promise<void>((resolve, reject) => {
            child.once('exit', (code, signal) => {
              if (code === 0 && signal === null) {
                resolve();
                return;
              }
              reject(
                new Error(
                  `Child lock holder exited unexpectedly (code ${code}, signal ${signal}): ${stderr}`,
                ),
              );
            });
            child.stdin.end('release\\n');
          }),
          CHILD_LOCK_HOLDER_TIMEOUT_MS,
        );
      } catch (error) {
        child.kill('SIGKILL');
        throw error;
      }
    },
  };
}

describe('parseProxyEp', () => {
  it('extracts and rewrites proxy-ep from ghu_-minted token', () => {
    const bearer =
      'tid=abc;exp=123;proxy-ep=proxy.individual.githubcopilot.com;extra=1';
    expect(parseProxyEp(bearer)).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });
  it('returns null when proxy-ep absent', () => {
    const bearer = 'tid=abc;exp=123';
    expect(parseProxyEp(bearer)).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(parseProxyEp('')).toBeNull();
  });
  it('handles bearer without trailing semicolons', () => {
    const bearer = 'proxy-ep=proxy.enterprise.githubcopilot.com';
    expect(parseProxyEp(bearer)).toBe(
      'https://api.enterprise.githubcopilot.com',
    );
  });
});

describe('discoverGithubToken', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds ghu_ in hosts.json shape', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_TESTABCD1234' },
      }),
      { mode: 0o600 },
    );
    const result = await discoverGithubToken({ overridePath: hostsFile });
    expect(result.token).toBe('ghu_TESTABCD1234');
    expect(result.token.startsWith('ghu_')).toBe(true);
  });

  it('finds gho_ in Copilot CLI config shape', async () => {
    const configFile = join(tempDir, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        copilotTokens: { 'https://github.com:login': 'gho_TESTEFGH5678' },
      }),
      { mode: 0o600 },
    );
    const result = await discoverGithubToken({ overridePath: configFile });
    expect(result.token).toBe('gho_TESTEFGH5678');
    expect(result.token.startsWith('gho_')).toBe(true);
  });

  it('ignores ghp_ PAT tokens', async () => {
    const file = join(tempDir, 'hosts.json');
    writeFileSync(
      file,
      JSON.stringify({ 'github.com': { oauth_token: 'ghp_PATIGNORE' } }),
      {
        mode: 0o600,
      },
    );
    await expect(discoverGithubToken({ overridePath: file })).rejects.toThrow();
  });

  it('throws when no token found', async () => {
    await expect(
      discoverGithubToken({ overridePath: join(tempDir, 'nonexistent.json') }),
    ).rejects.toThrow();
  });

  it('parses VS Code accounts shape', async () => {
    const file = join(tempDir, 'vsc.json');
    writeFileSync(
      file,
      JSON.stringify({ accounts: [{ token: 'ghu_VSCODE1234' }] }),
      { mode: 0o600 },
    );
    const result = await discoverGithubToken({ overridePath: file });
    expect(result.token).toBe('ghu_VSCODE1234');
  });
});

describe('persistGithubToken', () => {
  let tempDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'copi-hosts-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes token to hosts.json under Copilot client ID key', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    await persistGithubToken('ghu_test123', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_test123',
    );
  });

  it('preserves existing entries when writing', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({ 'github.com:other-app': { oauth_token: 'existing' } }),
    );
    await persistGithubToken('ghu_test456', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:other-app'].oauth_token).toBe('existing');
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_test456',
    );
  });

  it('updates existing Copilot entry in place', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_old' },
      }),
    );
    await persistGithubToken('ghu_new', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_new',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'sets file permissions to 0o600',
    async () => {
      const hostsFile = join(tempDir, 'hosts.json');
      await persistGithubToken('ghu_perm', { hostsFilePath: hostsFile });
      const st = statSync(hostsFile);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it('creates parent directory if missing', async () => {
    const hostsFile = join(tempDir, 'sub', 'dir', 'hosts.json');
    await persistGithubToken('ghu_mkdir', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_mkdir',
    );
  });

  it('persisted token is discoverable by discoverGithubToken', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    await persistGithubToken('ghu_roundtrip', { hostsFilePath: hostsFile });
    const result = await discoverGithubToken({ overridePath: hostsFile });
    expect(result.token).toBe('ghu_roundtrip');
  });

  it('does not replace hosts.json when cancellation is already observed', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
      }),
    );
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      persistGithubToken('ghu_new', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancel/i);

    expect(JSON.parse(readFileSync(hostsFile, 'utf-8'))).toEqual({
      'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
    });
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('does not start the non-abortable rename after cancellation follows its temp write', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
      }),
    );
    const ctrl = new AbortController();
    fsMocks.writeFile.mockImplementationOnce(async () => {
      ctrl.abort();
    });

    await expect(
      persistGithubToken('ghu_new', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancel/i);

    expect(fsMocks.rename).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(hostsFile, 'utf-8'))).toEqual({
      'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
    });
  });

  it('restores the exact existing bytes when cancellation follows a completed rename', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    const original = Buffer.from(
      '{\n  "github.com:other-app": { "oauth_token": "existing" }\n}\n',
    );
    writeFileSync(hostsFile, original);
    const ctrl = new AbortController();
    fsMocks.rename.mockImplementationOnce(async (from, to) => {
      renameSync(from, to);
      ctrl.abort();
    });

    await expect(
      persistGithubToken('ghu_new', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancel/i);

    expect(readFileSync(hostsFile)).toEqual(original);
  });

  it('removes its post-image when cancellation follows a completed rename without an original file', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    const ctrl = new AbortController();
    fsMocks.rename.mockImplementationOnce(async (from, to) => {
      renameSync(from, to);
      ctrl.abort();
    });

    await expect(
      persistGithubToken('ghu_new', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancel/i);

    expect(existsSync(hostsFile)).toBe(false);
  });

  it('preserves a conflicting post-image after cancellation follows a completed rename', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    const original = Buffer.from('{"existing":true}\n');
    const external = Buffer.from('{"external":"writer"}\n');
    writeFileSync(hostsFile, original);
    const ctrl = new AbortController();
    fsMocks.rename.mockImplementationOnce(async (from, to) => {
      renameSync(from, to);
      writeFileSync(hostsFile, external);
      ctrl.abort();
    });

    await expect(
      persistGithubToken('ghu_new', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/recovery conflict/i);

    expect(readFileSync(hostsFile)).toEqual(external);
  });

  it('serializes a cancelled writer before a subsequent successful writer', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(hostsFile, '{"existing":true}\n');
    const ctrl = new AbortController();
    let releaseFirstRename!: () => void;
    const firstRenameReleased = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let firstRenameReached!: () => void;
    const firstRenameReachedPromise = new Promise<void>((resolve) => {
      firstRenameReached = resolve;
    });
    let secondSnapshotStarted!: () => void;
    const secondSnapshotStartedPromise = new Promise<void>((resolve) => {
      secondSnapshotStarted = resolve;
    });
    fsMocks.readFile
      .mockImplementationOnce(async (path) => readFileSync(String(path)))
      .mockImplementationOnce(async (path) => {
        secondSnapshotStarted();
        return readFileSync(String(path));
      });
    fsMocks.rename.mockImplementationOnce(async (from, to) => {
      renameSync(from, to);
      ctrl.abort();
      firstRenameReached();
      await firstRenameReleased;
    });

    const first = persistGithubToken('ghu_cancelled', {
      hostsFilePath: hostsFile,
      signal: ctrl.signal,
    });
    await firstRenameReachedPromise;
    const second = persistGithubToken('ghu_success', {
      hostsFilePath: hostsFile,
    });
    const secondBeforeRelease = await Promise.race([
      secondSnapshotStartedPromise.then(() => 'started'),
      new Promise<'waiting'>((resolve) => {
        setTimeout(() => resolve('waiting'), 50);
      }),
    ]);
    expect(secondBeforeRelease).toBe('waiting');

    releaseFirstRename();
    await expect(first).rejects.toThrow(/^Login cancelled$/);
    await expect(second).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(hostsFile, 'utf-8'))).toEqual({
      existing: true,
      'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_success' },
    });
  });

  it('uses a distinct temporary name for each persistence operation', async () => {
    const hostsFile = join(tempDir, 'hosts.json');

    await persistGithubToken('ghu_first', { hostsFilePath: hostsFile });
    await persistGithubToken('ghu_second', { hostsFilePath: hostsFile });

    const tempPaths = fsMocks.rename.mock.calls
      .filter(([, path]) => path === hostsFile)
      .map(([path]) => String(path));
    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
  });

  it('waits for a held cooperating lock before reading or mutating hosts.json', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(hostsFile, '{"existing":true}\n');
    const release = await lockfile.lock(hostsFile, {
      realpath: false,
      retries: 0,
      stale: 10_000,
    });
    let lockHeld = true;
    let preimageRead!: () => void;
    const preimageReadPromise = new Promise<void>((resolve) => {
      preimageRead = resolve;
    });
    fsMocks.readFile.mockImplementationOnce(async (path) => {
      preimageRead();
      return readFileSync(String(path));
    });

    const persistence = persistGithubToken('ghu_waiting', {
      hostsFilePath: hostsFile,
    });
    try {
      const beforeRelease = await Promise.race([
        preimageReadPromise.then(() => 'read'),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => resolve('waiting'), 100);
        }),
      ]);
      expect(beforeRelease).toBe('waiting');
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
      expect(fsMocks.rename).not.toHaveBeenCalled();

      await release();
      lockHeld = false;
      await expect(persistence).resolves.toBeUndefined();
      expect(existsSync(`${hostsFile}.lock`)).toBe(false);
    } finally {
      if (lockHeld) {
        await release().catch(() => undefined);
      }
      await persistence.catch(() => undefined);
    }
  });

  it('holds the cooperating lock through cancelled post-rename recovery', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    const original = Buffer.from('{"existing":true}\n');
    writeFileSync(hostsFile, original);
    const ctrl = new AbortController();
    let continueRecovery!: () => void;
    const recoveryCanContinue = new Promise<void>((resolve) => {
      continueRecovery = resolve;
    });
    let recoveryReadStarted!: () => void;
    const recoveryReadStartedPromise = new Promise<void>((resolve) => {
      recoveryReadStarted = resolve;
    });
    fsMocks.readFile
      .mockImplementationOnce(async (path) => readFileSync(String(path)))
      .mockImplementationOnce(async (path) => {
        recoveryReadStarted();
        await recoveryCanContinue;
        return readFileSync(String(path));
      });
    fsMocks.rename.mockImplementationOnce(async (from, to) => {
      renameSync(from, to);
      ctrl.abort();
    });

    const first = persistGithubToken('ghu_cancelled', {
      hostsFilePath: hostsFile,
      signal: ctrl.signal,
    });
    await recoveryReadStartedPromise;
    const second = persistGithubToken('ghu_success', {
      hostsFilePath: hostsFile,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fsMocks.readFile).toHaveBeenCalledTimes(2);
      expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
      expect(fsMocks.rename).toHaveBeenCalledTimes(1);

      const competingLock = await lockfile
        .lock(hostsFile, { realpath: false, retries: 0, stale: 10_000 })
        .then(
          async (release) => {
            await release();
            return 'acquired';
          },
          (error: unknown) => error,
        );
      expect(competingLock).toMatchObject({ code: 'ELOCKED' });
    } finally {
      continueRecovery();
      await first.catch(() => undefined);
      await second.catch(() => undefined);
    }

    await expect(first).rejects.toThrow(/^Login cancelled$/);
    await expect(second).resolves.toBeUndefined();
    expect(existsSync(`${hostsFile}.lock`)).toBe(false);
  });

  it('removes the cooperating lock after every persistence terminal path', async () => {
    const normalHostsFile = join(tempDir, 'normal-hosts.json');
    const normalWriteFile = fsMocks.writeFile.getMockImplementation();
    let normalLockHeld = false;
    fsMocks.writeFile.mockImplementationOnce(async (...args) => {
      normalLockHeld = existsSync(`${normalHostsFile}.lock`);
      return normalWriteFile!(...args);
    });
    await persistGithubToken('ghu_normal', { hostsFilePath: normalHostsFile });
    expect(normalLockHeld).toBe(true);
    expect(existsSync(`${normalHostsFile}.lock`)).toBe(false);

    const preAbortedHostsFile = join(tempDir, 'pre-aborted-hosts.json');
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      persistGithubToken('ghu_pre_aborted', {
        hostsFilePath: preAbortedHostsFile,
        signal: preAborted.signal,
      }),
    ).rejects.toThrow(/^Login cancelled$/);
    expect(existsSync(`${preAbortedHostsFile}.lock`)).toBe(false);

    const cancelledHostsFile = join(tempDir, 'cancelled-hosts.json');
    writeFileSync(cancelledHostsFile, '{"existing":true}\n');
    const cancelled = new AbortController();
    let cancelledLockHeld = false;
    fsMocks.rename.mockImplementationOnce(async (from, to) => {
      cancelledLockHeld = existsSync(`${cancelledHostsFile}.lock`);
      renameSync(from, to);
      cancelled.abort();
    });
    await expect(
      persistGithubToken('ghu_cancelled', {
        hostsFilePath: cancelledHostsFile,
        signal: cancelled.signal,
      }),
    ).rejects.toThrow(/^Login cancelled$/);
    expect(cancelledLockHeld).toBe(true);
    expect(existsSync(`${cancelledHostsFile}.lock`)).toBe(false);

    const writeFailureHostsFile = join(tempDir, 'write-failure-hosts.json');
    let writeFailureLockHeld = false;
    fsMocks.writeFile.mockImplementationOnce(async () => {
      writeFailureLockHeld = existsSync(`${writeFailureHostsFile}.lock`);
      throw new Error('write failed');
    });
    await expect(
      persistGithubToken('ghu_write_failure', {
        hostsFilePath: writeFailureHostsFile,
      }),
    ).rejects.toThrow('write failed');
    expect(writeFailureLockHeld).toBe(true);
    expect(existsSync(`${writeFailureHostsFile}.lock`)).toBe(false);

    const renameFailureHostsFile = join(tempDir, 'rename-failure-hosts.json');
    let renameFailureLockHeld = false;
    fsMocks.rename.mockImplementationOnce(async () => {
      renameFailureLockHeld = existsSync(`${renameFailureHostsFile}.lock`);
      throw new Error('rename failed');
    });
    await expect(
      persistGithubToken('ghu_rename_failure', {
        hostsFilePath: renameFailureHostsFile,
      }),
    ).rejects.toThrow('rename failed');
    expect(renameFailureLockHeld).toBe(true);
    expect(existsSync(`${renameFailureHostsFile}.lock`)).toBe(false);
  });

  it('surfaces a failed lock release after mutating hosts.json', async () => {
    const hostsFile = join(tempDir, 'release-failure-hosts.json');
    const releaseError = new Error('lock release failed');
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockResolvedValueOnce(async () => {
        throw releaseError;
      });
    let outcome: unknown;

    try {
      outcome = await persistGithubToken('ghu_release_failure', {
        hostsFilePath: hostsFile,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      lockSpy.mockRestore();
    }

    expect(JSON.parse(readFileSync(hostsFile, 'utf8'))).toEqual({
      'github.com:Iv1.b507a08c87ecfe98': {
        oauth_token: 'ghu_release_failure',
      },
    });
    expect(outcome).toBe(releaseError);
  });

  it('surfaces a compromised lock release after mutating hosts.json', async () => {
    const hostsFile = join(tempDir, 'compromised-lock-hosts.json');
    const { lockSpy, getOnCompromised } = mockCompromisedLock();
    let outcome: unknown;

    try {
      outcome = await persistGithubToken('ghu_compromised_lock', {
        hostsFilePath: hostsFile,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      lockSpy.mockRestore();
    }

    expect(getOnCompromised()).toBeTypeOf('function');
    expect(outcome).toMatchObject({ code: 'ERELEASED' });
    expect(JSON.parse(readFileSync(hostsFile, 'utf8'))).toEqual({
      'github.com:Iv1.b507a08c87ecfe98': {
        oauth_token: 'ghu_compromised_lock',
      },
    });
  });

  it('preserves cancellation when lock release also fails', async () => {
    const hostsFile = join(tempDir, 'cancelled-release-failure-hosts.json');
    const original = Buffer.from('{"existing":true}\n');
    writeFileSync(hostsFile, original);
    const ctrl = new AbortController();
    const releaseError = new Error('lock release failed');
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockResolvedValueOnce(async () => {
        throw releaseError;
      });
    fsMocks.rename.mockImplementationOnce(async (from, to) => {
      renameSync(from, to);
      ctrl.abort();
    });
    let outcome: unknown;

    try {
      outcome = await persistGithubToken('ghu_cancelled', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      lockSpy.mockRestore();
    }

    expect(readFileSync(hostsFile)).toEqual(original);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('Login cancelled');
    expect((outcome as Error & { cause?: unknown }).cause).toBe(releaseError);
  });

  it('recovers a deterministically stale cooperating lock', async () => {
    const hostsFile = join(tempDir, 'stale-lock-hosts.json');
    writeFileSync(hostsFile, '{"existing":true}\n');
    const staleLock = `${hostsFile}.lock`;
    mkdirSync(staleLock);
    const staleAt = new Date(Date.now() - 20_000);
    utimesSync(staleLock, staleAt, staleAt);

    await persistGithubToken('ghu_stale_recovery', {
      hostsFilePath: hostsFile,
    });

    expect(JSON.parse(readFileSync(hostsFile, 'utf8'))).toEqual({
      existing: true,
      'github.com:Iv1.b507a08c87ecfe98': {
        oauth_token: 'ghu_stale_recovery',
      },
    });
    expect(existsSync(staleLock)).toBe(false);
  });

  it('waits for a cooperating child-process lock before mutating hosts.json', async () => {
    const hostsFile = join(tempDir, 'child-lock-hosts.json');
    const original = Buffer.from('{"existing":true}\n');
    writeFileSync(hostsFile, original);
    const holder = await startCooperatingLockHolder(hostsFile);
    let lockAttempted!: () => void;
    const lockAttemptedPromise = new Promise<void>((resolve) => {
      lockAttempted = resolve;
    });
    const originalLock = lockfile.lock;
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation((file, options) => {
        lockAttempted();
        return originalLock(file, options);
      });
    const persistence = persistGithubToken('ghu_child_waiting', {
      hostsFilePath: hostsFile,
    });

    try {
      await waitForPromise(lockAttemptedPromise, CHILD_LOCK_HOLDER_TIMEOUT_MS);
      const beforeRelease = await Promise.race([
        persistence.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'blocked'>((resolve) => {
          setTimeout(() => resolve('blocked'), 75);
        }),
      ]);
      expect(beforeRelease).toBe('blocked');
      expect(readFileSync(hostsFile)).toEqual(original);
      expect(fsMocks.readFile).not.toHaveBeenCalled();
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
      expect(fsMocks.rename).not.toHaveBeenCalled();

      await holder.release();
      await expect(
        waitForPromise(persistence, CHILD_LOCK_HOLDER_TIMEOUT_MS),
      ).resolves.toBeUndefined();
      expect(JSON.parse(readFileSync(hostsFile, 'utf8'))).toEqual({
        existing: true,
        'github.com:Iv1.b507a08c87ecfe98': {
          oauth_token: 'ghu_child_waiting',
        },
      });
    } finally {
      lockSpy.mockRestore();
      await holder.release().catch(() => undefined);
      await persistence.catch(() => undefined);
    }
  });

  it('cancels after a cooperating child-process lock releases without mutation', async () => {
    const hostsFile = join(tempDir, 'child-lock-cancelled-hosts.json');
    const original = Buffer.from('{"existing":true}\n');
    writeFileSync(hostsFile, original);
    const holder = await startCooperatingLockHolder(hostsFile);
    const ctrl = new AbortController();
    let lockAttempted!: () => void;
    const lockAttemptedPromise = new Promise<void>((resolve) => {
      lockAttempted = resolve;
    });
    const originalLock = lockfile.lock;
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation((file, options) => {
        lockAttempted();
        return originalLock(file, options);
      });
    const persistence = persistGithubToken('ghu_child_cancelled', {
      hostsFilePath: hostsFile,
      signal: ctrl.signal,
    });

    try {
      await waitForPromise(lockAttemptedPromise, CHILD_LOCK_HOLDER_TIMEOUT_MS);
      ctrl.abort();
      const beforeRelease = await Promise.race([
        persistence.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'blocked'>((resolve) => {
          setTimeout(() => resolve('blocked'), 75);
        }),
      ]);
      expect(beforeRelease).toBe('blocked');
      expect(readFileSync(hostsFile)).toEqual(original);
      expect(fsMocks.readFile).not.toHaveBeenCalled();
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
      expect(fsMocks.rename).not.toHaveBeenCalled();

      await holder.release();
      const outcome = await waitForPromise(
        persistence.then(
          () => undefined,
          (error: unknown) => error,
        ),
        CHILD_LOCK_HOLDER_TIMEOUT_MS,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('Login cancelled');
      expect(readFileSync(hostsFile)).toEqual(original);
      expect(fsMocks.readFile).not.toHaveBeenCalled();
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
      expect(fsMocks.rename).not.toHaveBeenCalled();
      expect(existsSync(`${hostsFile}.lock`)).toBe(false);
    } finally {
      lockSpy.mockRestore();
      await holder.release().catch(() => undefined);
      await persistence.catch(() => undefined);
    }
  });
});

function makeMockFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const mockFetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const res = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: mockFetch, calls };
}

describe('exchangeGhuForCapi', () => {
  it('exchanges ghu_ for CAPI bearer', async () => {
    const { fetch, calls } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const result = await exchangeGhuForCapi('ghu_TEST1234', {
      fetchImpl: fetch,
    });
    expect(result.bearer).toContain('tid=');
    expect(result.endpointsApi).toBe(
      'https://api.individual.githubcopilot.com',
    );
    expect(result.expiresAtMs).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('api.github.com/copilot_internal/v2/token');
    expect(calls[0].headers['Authorization']).toBe('token ghu_TEST1234');
  });

  it('4xx short-circuits (no retry)', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 401, body: { error: 'bad token' } },
    ]);
    await expect(
      exchangeGhuForCapi('ghu_BAD', { fetchImpl: fetch }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('throws on non-ghu_ prefix', async () => {
    await expect(exchangeGhuForCapi('gho_NOTGHU')).rejects.toThrow();
  });

  it('uses parseProxyEp for endpointsApi when proxy-ep present', async () => {
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.enterprise.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://fallback.example.com' },
        },
      },
    ]);
    const result = await exchangeGhuForCapi('ghu_TEST', { fetchImpl: fetch });
    // parseProxyEp wins over endpoints.api
    expect(result.endpointsApi).toBe(
      'https://api.enterprise.githubcopilot.com',
    );
  });
});

describe('CopilotTokenManager', () => {
  it('does not expose a live model catalog method', () => {
    const mgr = createCopilotTokenManager({ cacheFile: false });
    expect(mgr).not.toHaveProperty('getAvailableModelIds');
  });

  it('does not expose live catalog APIs from the core barrel', async () => {
    const core = await import('../index.js');
    expect(core).not.toHaveProperty('fetchCopilotModels');
    expect(core).not.toHaveProperty('enableAllCopilotModels');
  });

  it('getSnapshot returns atomic bearer+endpointsApi pair', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const snap = await mgr.getSnapshot();
    // bearer is a RedactedString (toString→[redacted]); use valueOf() for the
    // functional primitive value (Ruling 2: brief's bare toContain/toBe are
    // incompatible with the Global-Constraint RedactedString).
    expect(snap.bearer.valueOf()).toContain('tid=');
    expect(snap.endpointsApi).toBe('https://api.individual.githubcopilot.com');
    expect(snap.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('gho_ path skips fetch (no exchange HTTP)', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    const hostsFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'hosts.json',
    );
    writeFileSync(
      hostsFile,
      JSON.stringify({ 'github.com': { oauth_token: 'gho_TEST1234' } }),
      {
        mode: 0o600,
      },
    );
    const { fetch, calls } = makeMockFetch([]);
    process.env['COPILOT_GITHUB_TOKEN_PATH'] = hostsFile;
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const snap = await mgr.getSnapshot();
    expect(snap.bearer.valueOf()).toBe('gho_TEST1234');
    expect(calls).toHaveLength(0); // no exchange HTTP
    delete process.env['COPILOT_GITHUB_TOKEN_PATH'];
  });

  it('redacts bearer in inspect/toString/toJSON', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=SECRETBEARER;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const snap = await mgr.getSnapshot();
    expect(String(snap.bearer)).not.toContain('SECRETBEARER');
    expect(JSON.stringify(snap)).not.toContain('SECRETBEARER');
    expect(inspect(snap)).not.toContain('SECRETBEARER');
  });

  it('concurrent getSnapshot calls share a single mint (mintInFlight dedup)', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    let fetchCallCount = 0;
    const countingFetch = (async (_url: URL | string, _init?: RequestInit) => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const mgr = createCopilotTokenManager({
      cacheFile,
      fetchImpl: countingFetch,
    });
    const [a, b, c] = await Promise.all([
      mgr.getSnapshot(),
      mgr.getSnapshot(),
      mgr.getSnapshot(),
    ]);
    expect(fetchCallCount).toBe(1);
    expect(a.bearer.valueOf()).toBe(b.bearer.valueOf());
    expect(b.bearer.valueOf()).toBe(c.bearer.valueOf());
  });

  it('cache dir created with 0o700 permissions', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'copi-perm-'));
    const cacheFile = join(tempRoot, 'subdir', 'copilot.json');
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    await mgr.getSnapshot();
    const dirStat = statSync(join(tempRoot, 'subdir'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

async function withGithubToken<T>(
  token: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = process.env['GITHUB_TOKEN'];
  process.env['GITHUB_TOKEN'] = token;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env['GITHUB_TOKEN'];
    else process.env['GITHUB_TOKEN'] = previous;
  }
}

function cacheEnvelope(
  overrides?: Partial<{
    bearer: string;
    endpointsApi: string;
    expiresAtMs: number;
    cachedAtMs: number;
    ghuSource: string;
  }>,
): {
  bearer: string;
  endpointsApi: string;
  expiresAtMs: number;
  cachedAtMs: number;
  ghuSource?: string;
} {
  return {
    bearer: 'tid=cached;proxy-ep=proxy.individual.githubcopilot.com',
    endpointsApi: 'https://api.individual.githubcopilot.com',
    expiresAtMs: Date.now() + 3_600_000,
    cachedAtMs: Date.now(),
    ...overrides,
  };
}

function exchangeResponse(bearer: string): {
  status: number;
  body: unknown;
} {
  return {
    status: 200,
    body: {
      token: bearer,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      endpoints: { api: 'https://api.individual.githubcopilot.com' },
    },
  };
}

describe('CopilotTokenManager shared cache', () => {
  it('uses a fresh complete disk cache without discovery or exchange', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-fresh-cache-')),
      'copilot.json',
    );
    const cached = cacheEnvelope();
    writeFileSync(cacheFile, JSON.stringify(cached), { mode: 0o600 });
    const { fetch, calls } = makeMockFetch([
      exchangeResponse(
        'tid=minted;proxy-ep=proxy.individual.githubcopilot.com',
      ),
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });

    const snapshot = await withGithubToken('ghu_SHOULD_NOT_MINT', () =>
      mgr.getSnapshot(),
    );

    expect(calls).toHaveLength(0);
    expect(snapshot.bearer.valueOf()).toBe(cached.bearer);
    expect(snapshot.endpointsApi).toBe(cached.endpointsApi);
    expect(snapshot.expiresAtMs).toBe(cached.expiresAtMs);
  });

  it('remints an expired disk cache exactly once across concurrent managers', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-expired-cache-')),
      'copilot.json',
    );
    writeFileSync(
      cacheFile,
      JSON.stringify(
        cacheEnvelope({
          bearer: 'tid=expired;proxy-ep=proxy.individual.githubcopilot.com',
          expiresAtMs: Date.now() - 1,
        }),
      ),
      { mode: 0o600 },
    );
    const mintedBearer =
      'tid=minted-expired;proxy-ep=proxy.individual.githubcopilot.com';
    const { fetch, calls } = makeMockFetch([exchangeResponse(mintedBearer)]);
    const firstManager = createCopilotTokenManager({
      cacheFile,
      fetchImpl: fetch,
    });
    const secondManager = createCopilotTokenManager({
      cacheFile,
      fetchImpl: fetch,
    });

    const [first, second] = await withGithubToken('ghu_EXPIRED_CACHE', () =>
      Promise.all([firstManager.getSnapshot(), secondManager.getSnapshot()]),
    );

    expect(calls).toHaveLength(1);
    expect(first.bearer.valueOf()).toBe(mintedBearer);
    expect(second.bearer.valueOf()).toBe(mintedBearer);
    expect(JSON.parse(readFileSync(cacheFile, 'utf-8'))).toMatchObject({
      bearer: mintedBearer,
    });
  });

  it('coordinates a cold shared cache so two managers exchange once', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-cold-shared-cache-')),
      'copilot.json',
    );
    const mintedBearer =
      'tid=minted-cold;proxy-ep=proxy.individual.githubcopilot.com';
    const { fetch, calls } = makeMockFetch([exchangeResponse(mintedBearer)]);
    const first = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const second = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });

    const [firstSnapshot, secondSnapshot] = await withGithubToken(
      'ghu_COLD_SHARED_CACHE',
      () => Promise.all([first.getSnapshot(), second.getSnapshot()]),
    );

    expect(calls).toHaveLength(1);
    expect(firstSnapshot.bearer.valueOf()).toBe(mintedBearer);
    expect(secondSnapshot.bearer.valueOf()).toBe(mintedBearer);
    expect(secondSnapshot.bearer.valueOf()).toBe(
      firstSnapshot.bearer.valueOf(),
    );
  });

  it('coalesces concurrent force refreshes across managers onto one replacement', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-force-shared-cache-')),
      'copilot.json',
    );
    const cached = cacheEnvelope({
      bearer: 'tid=before-force;proxy-ep=proxy.individual.githubcopilot.com',
    });
    writeFileSync(cacheFile, JSON.stringify(cached), { mode: 0o600 });
    const replacementBearer =
      'tid=after-force;proxy-ep=proxy.individual.githubcopilot.com';
    const { fetch, calls } = makeMockFetch([
      exchangeResponse(replacementBearer),
    ]);
    const first = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const second = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });

    await withGithubToken('ghu_FORCE_SHARED_CACHE', () =>
      Promise.all([first.getSnapshot(), second.getSnapshot()]),
    );
    calls.splice(0);

    await withGithubToken('ghu_FORCE_SHARED_CACHE', () =>
      Promise.all([first.forceRefresh(), second.forceRefresh()]),
    );
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first.getSnapshot(),
      second.getSnapshot(),
    ]);
    const disk = JSON.parse(readFileSync(cacheFile, 'utf-8')) as {
      bearer: string;
    };

    expect(calls).toHaveLength(1);
    expect(firstSnapshot.bearer.valueOf()).toBe(replacementBearer);
    expect(secondSnapshot.bearer.valueOf()).toBe(replacementBearer);
    expect(disk.bearer).toBe(replacementBearer);
  });

  it('coalesces concurrent same-manager force refreshes but refreshes again later', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-force-single-manager-')),
      'copilot.json',
    );
    writeFileSync(cacheFile, JSON.stringify(cacheEnvelope()), { mode: 0o600 });
    const { fetch, calls } = makeMockFetch([
      exchangeResponse(
        'tid=first-force;proxy-ep=proxy.individual.githubcopilot.com',
      ),
      exchangeResponse(
        'tid=second-force;proxy-ep=proxy.individual.githubcopilot.com',
      ),
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });

    await mgr.getSnapshot();
    await withGithubToken('ghu_FORCE_SINGLE_MANAGER', () =>
      Promise.all([mgr.forceRefresh(), mgr.forceRefresh()]),
    );
    expect(calls).toHaveLength(1);

    await withGithubToken('ghu_FORCE_SINGLE_MANAGER', () => mgr.forceRefresh());
    expect(calls).toHaveLength(2);
  });

  it('rejects malformed disk cache envelopes before promoting them', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-malformed-cache-')),
      'copilot.json',
    );
    writeFileSync(
      cacheFile,
      JSON.stringify({
        bearer: '',
        endpointsApi: 'https://api.individual.githubcopilot.com',
        expiresAtMs: Date.now() + 3_600_000,
        cachedAtMs: Date.now(),
      }),
      { mode: 0o600 },
    );
    const mintedBearer =
      'tid=minted-malformed;proxy-ep=proxy.individual.githubcopilot.com';
    const { fetch, calls } = makeMockFetch([exchangeResponse(mintedBearer)]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });

    const snapshot = await withGithubToken('ghu_MALFORMED_CACHE', () =>
      mgr.getSnapshot(),
    );

    expect(calls).toHaveLength(1);
    expect(snapshot.bearer.valueOf()).toBe(mintedBearer);
    expect(JSON.parse(readFileSync(cacheFile, 'utf-8'))).toMatchObject({
      bearer: mintedBearer,
    });
  });
});

describe('runCopilotDeviceFlow', () => {
  it('polls device flow and returns ghu_ token', async () => {
    let pollCount = 0;
    const mockFetch = (async (url: URL | string, _init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev123',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 0, // fast poll for test
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.endsWith('/login/oauth/access_token')) {
        pollCount++;
        if (pollCount < 2) {
          return new Response(
            JSON.stringify({ error: 'authorization_pending' }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return new Response(
          JSON.stringify({ access_token: 'ghu_DEVICEFLOW1234' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const events: string[] = [];
    const result = await runCopilotDeviceFlow({
      fetchImpl: mockFetch,
      notify: (e) => {
        if (e.type === 'device_code') events.push(`code:${e.userCode}`);
        if (e.type === 'progress') events.push('progress');
      },
    });
    expect(result.token).toBe('ghu_DEVICEFLOW1234');
    expect(events).toContain('code:ABCD-1234');
  });

  it('handles slow_down by increasing interval', async () => {
    let pollCount = 0;
    const mockFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev456',
            user_code: 'WXYZ-9999',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      pollCount++;
      if (pollCount === 1) {
        return new Response(
          JSON.stringify({ error: 'slow_down', interval: 1 }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response(
        JSON.stringify({ access_token: 'ghu_SLOWDOWN1234' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await runCopilotDeviceFlow({ fetchImpl: mockFetch });
    expect(result.token).toBe('ghu_SLOWDOWN1234');
  });

  it('throws on expired_token', async () => {
    const mockFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev789',
            user_code: 'EXPI-RED0',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'expired_token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(
      runCopilotDeviceFlow({ fetchImpl: mockFetch }),
    ).rejects.toThrow(/expired/i);
  });

  it('cancel via AbortSignal rejects with "cancelled"', async () => {
    const ctrl = new AbortController();
    const mockFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev000',
            user_code: 'CANC-EL01',
            verification_uri: 'https://github.com/login/device',
            interval: 5,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    setTimeout(() => ctrl.abort(), 50);
    await expect(
      runCopilotDeviceFlow({ fetchImpl: mockFetch, signal: ctrl.signal }),
    ).rejects.toThrow(/cancel/i);
  });

  it('rejects when cancelled while a polling response resolves late', async () => {
    const ctrl = new AbortController();
    let deviceRequestSignal: AbortSignal | null | undefined;
    let pollRequestSignal: AbortSignal | null | undefined;
    let resolvePollResponse!: (response: Response) => void;
    let notifyPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      notifyPollStarted = resolve;
    });
    const latePollResponse = new Promise<Response>((resolve) => {
      resolvePollResponse = resolve;
    });
    const mockFetch = (async (url: URL | string, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        deviceRequestSignal = init?.signal;
        return new Response(
          JSON.stringify({
            device_code: 'dev-late',
            user_code: 'LATE-0001',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      pollRequestSignal = init?.signal;
      notifyPollStarted();
      return latePollResponse;
    }) as typeof fetch;

    const flow = runCopilotDeviceFlow({
      fetchImpl: mockFetch,
      signal: ctrl.signal,
    });
    await pollStarted;
    ctrl.abort();
    resolvePollResponse(
      new Response(JSON.stringify({ access_token: 'ghu_LATE_TOKEN' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(flow).rejects.toThrow(/cancel/i);
    expect(deviceRequestSignal).toBe(ctrl.signal);
    expect(pollRequestSignal).toBe(ctrl.signal);
  });
});
