/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actualFs: undefined as typeof import('node:fs') | undefined,
  writeFileSync: vi.fn(),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  renameSync: vi.fn(),
  lstatSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mocks.actualFs = actual;
  return {
    ...actual,
    writeFileSync: mocks.writeFileSync,
    fsyncSync: mocks.fsyncSync,
    closeSync: mocks.closeSync,
    renameSync: mocks.renameSync,
    lstatSync: mocks.lstatSync,
  };
});
import { SettingsFileSource } from './settingsFileSource.js';
import { mutateSettingsFile } from './settingsPersistence.js';

function isFileDescriptor(value: unknown): value is number {
  return typeof value === 'number';
}

function resetFsMocks(): void {
  const actual = mocks.actualFs!;
  mocks.writeFileSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.writeFileSync, actual, args),
  );
  mocks.fsyncSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.fsyncSync, actual, args),
  );
  mocks.closeSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.closeSync, actual, args),
  );
  mocks.renameSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.renameSync, actual, args),
  );
  mocks.lstatSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.lstatSync, actual, args),
  );
}

describe('settings persistence', () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(() => {
    resetFsMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-settings-write-'));
    settingsPath = path.join(tempDir, 'settings.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('owns the read-modify-write transaction and invalidates shared sources', () => {
    fs.writeFileSync(settingsPath, '{\n  // retained\n  "value": 1\n}\n');
    const first = new SettingsFileSource(settingsPath);
    const second = new SettingsFileSource(settingsPath);
    expect(first.read()).toContain('"value": 1');
    expect(second.read()).toContain('"value": 1');

    const result = mutateSettingsFile(settingsPath, (latest) => {
      latest['value'] = 2;
      latest['added'] = true;
      return true;
    });

    expect(result.changed).toBe(true);
    expect(result.originalSettings).toEqual({ value: 2, added: true });
    expect(first.read()).toContain('// retained');
    expect(JSON.parse(second.read()!.replace('// retained', ''))).toEqual({
      value: 2,
      added: true,
    });
  });

  it('does not create a missing file for a no-op mutation', () => {
    const result = mutateSettingsFile(settingsPath, () => false);

    expect(result).toMatchObject({ changed: false, rawJson: '{}\n' });
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('invalidates a cached source when a mutation cannot parse the file', () => {
    fs.writeFileSync(settingsPath, '{"value":1}\n');
    const source = new SettingsFileSource(settingsPath);
    expect(source.read()).toContain('"value":1');
    mocks.actualFs!.writeFileSync(settingsPath, '{ invalid');

    expect(() => mutateSettingsFile(settingsPath, () => false)).toThrow(
      'invalid JSON',
    );
    expect(source.read()).toBe('{ invalid');
  });

  it('preserves a relative symlink while updating its target', () => {
    const targetDir = path.join(tempDir, 'target');
    fs.mkdirSync(targetDir);
    const targetPath = path.join(targetDir, 'actual.json');
    fs.writeFileSync(targetPath, '{"value":1}\n');
    fs.symlinkSync(path.join('target', 'actual.json'), settingsPath);

    mutateSettingsFile(settingsPath, (latest) => {
      latest['value'] = 2;
      return true;
    });

    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({ value: 2 });
  });

  it.each([
    ['write', 'writeFileSync'],
    ['flush', 'fsyncSync'],
    ['close', 'closeSync'],
    ['rename', 'renameSync'],
  ] as const)(
    'leaves the original intact when atomic %s fails',
    (_stage, method) => {
      const original = '{ "value": 1 }\n';
      fs.writeFileSync(settingsPath, original);
      mocks[method].mockImplementation((...args: unknown[]) => {
        if (method === 'writeFileSync' && !isFileDescriptor(args[0])) {
          return Reflect.apply(
            mocks.actualFs!.writeFileSync,
            mocks.actualFs,
            args,
          );
        }
        throw Object.assign(new Error(`${method} failed`), { code: 'EIO' });
      });

      expect(() =>
        mutateSettingsFile(settingsPath, (latest) => {
          latest['value'] = 2;
          return true;
        }),
      ).toThrow();
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
    },
  );

  it('skips a colliding Windows temp candidate and retries rename errors', () => {
    fs.writeFileSync(settingsPath, '{}\n');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    let tempChecks = 0;
    mocks.lstatSync.mockImplementation((candidate, ...args) => {
      if (String(candidate).includes('.tmp.')) {
        tempChecks += 1;
        if (tempChecks === 1) return fs.statSync(settingsPath);
      }
      return Reflect.apply(mocks.actualFs!.lstatSync, mocks.actualFs, [
        candidate,
        ...args,
      ]);
    });
    let renameAttempts = 0;
    mocks.renameSync.mockImplementation((source, destination) => {
      renameAttempts += 1;
      if (renameAttempts < 3) {
        throw Object.assign(new Error('file busy'), { code: 'EPERM' });
      }
      mocks.actualFs!.renameSync(source, destination);
    });

    mutateSettingsFile(settingsPath, (latest) => {
      latest['windows'] = true;
      return true;
    });

    expect(tempChecks).toBeGreaterThanOrEqual(2);
    expect(renameAttempts).toBe(3);
  });

  it('keeps the original after Windows rename retries are exhausted', () => {
    const original = '{ "value": 1 }\n';
    fs.writeFileSync(settingsPath, original);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mocks.renameSync.mockImplementation(() => {
      throw Object.assign(new Error('file busy'), { code: 'EBUSY' });
    });

    expect(() =>
      mutateSettingsFile(settingsPath, (latest) => {
        latest['value'] = 2;
        return true;
      }),
    ).toThrow();
    expect(mocks.renameSync).toHaveBeenCalledTimes(4);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('retries a Windows EACCES rename error', () => {
    fs.writeFileSync(settingsPath, '{}\n');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mocks.renameSync
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('file busy'), { code: 'EACCES' });
      })
      .mockImplementation((...args) =>
        Reflect.apply(mocks.actualFs!.renameSync, mocks.actualFs, args),
      );

    expect(
      mutateSettingsFile(settingsPath, (latest) => {
        latest['windows'] = true;
        return true;
      }).changed,
    ).toBe(true);
    expect(mocks.renameSync).toHaveBeenCalledTimes(2);
  });
});
