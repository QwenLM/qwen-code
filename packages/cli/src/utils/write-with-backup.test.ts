/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nativeFs, * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeWithBackup, writeWithBackupSync } from './write-with-backup.js';
import { readOperatorSandboxSettings } from '../config/execution-sandbox-settings.js';
import {
  loadSettings,
  SettingScope,
  SETTINGS_VERSION,
} from '../config/settings.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    copyFileSync: vi.fn(actual.copyFileSync),
    renameSync: vi.fn(actual.renameSync),
    readFileSync: vi.fn(actual.readFileSync),
    rmSync: vi.fn(actual.rmSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

describe('writeWithBackup', () => {
  let tempDir: string;
  let targetPath: string;

  beforeEach(() => {
    vi.mocked(fs.writeFileSync).mockImplementation(nativeFs.writeFileSync);
    vi.mocked(fs.copyFileSync).mockImplementation(nativeFs.copyFileSync);
    vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
    vi.mocked(fs.readFileSync).mockImplementation(nativeFs.readFileSync);
    vi.mocked(fs.rmSync).mockImplementation(nativeFs.rmSync);
    vi.mocked(fs.unlinkSync).mockImplementation(nativeFs.unlinkSync);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-with-backup-test-'));
    targetPath = path.join(tempDir, 'settings.json');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    nativeFs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a new file and removes its working artifacts', () => {
    writeWithBackupSync(targetPath, 'Hello, World!');

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('Hello, World!');
    expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
  });

  it('replaces existing content without accumulating working artifacts', () => {
    fs.writeFileSync(targetPath, 'v0');
    for (const content of ['v1', 'v2', 'v3']) {
      writeWithBackupSync(targetPath, content);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(content);
      expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
    }
  });

  it('keeps the sandbox policy and loaded scope readable until publication', () => {
    vi.stubEnv('QWEN_HOME', tempDir);
    vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', path.join(tempDir, 'system'));
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
      path.join(tempDir, 'defaults'),
    );
    const policy = { filesystem: 'read-only', network: 'closed' };
    const settings = (theme: string) =>
      JSON.stringify({
        $version: SETTINGS_VERSION,
        tools: { executionSandbox: policy },
        ui: { theme },
      });
    const oldContent = settings('old');
    const newContent = settings('new');
    fs.writeFileSync(targetPath, oldContent);
    const loaded = loadSettings(tempDir, { skipLoadEnvironment: true });
    const checkpoints: string[] = [];
    const observe = (checkpoint: string) => {
      checkpoints.push(checkpoint);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(oldContent);
      expect(readOperatorSandboxSettings().tools?.executionSandbox).toEqual(
        policy,
      );
      expect(loaded.reloadScopeFromDisk(SettingScope.User)).toBe(true);
      expect(loaded.user.settings.tools?.executionSandbox).toEqual(policy);
      expect(loaded.user.settings.ui?.theme).toBe('old');
    };
    vi.mocked(fs.writeFileSync).mockImplementation((...args) => {
      nativeFs.writeFileSync(...args);
      observe('staging');
    });
    vi.mocked(fs.copyFileSync).mockImplementation((...args) => {
      nativeFs.copyFileSync(...args);
      observe('backup');
    });
    vi.mocked(fs.renameSync).mockImplementation((...args) => {
      observe('publication');
      nativeFs.renameSync(...args);
    });

    writeWithBackupSync(targetPath, newContent);

    expect(checkpoints).toEqual(['staging', 'backup', 'publication']);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(newContent);
    expect(readOperatorSandboxSettings().tools?.executionSandbox).toEqual(
      policy,
    );
    expect(loaded.reloadScopeFromDisk(SettingScope.User)).toBe(true);
    expect(loaded.user.settings.ui?.theme).toBe('new');
  });

  it('rejects a directory target without leaving artifacts', () => {
    fs.mkdirSync(targetPath);

    expect(() => writeWithBackupSync(targetPath, 'content')).toThrow(
      'directory',
    );
    expect(fs.statSync(targetPath).isDirectory()).toBe(true);
    expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
  });

  it('preserves the target and removes partial staging after a write failure', () => {
    fs.writeFileSync(targetPath, 'old');
    vi.mocked(fs.writeFileSync).mockImplementation((file) => {
      nativeFs.writeFileSync(file, 'partial');
      throw new Error('write or flush failed');
    });

    expect(() => writeWithBackupSync(targetPath, 'new')).toThrow(
      'write or flush failed',
    );
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('old');
    expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
  });

  it('aborts a failed backup copy and removes its incomplete artifacts', () => {
    fs.writeFileSync(targetPath, 'old');
    vi.mocked(fs.copyFileSync).mockImplementation((_source, destination) => {
      nativeFs.writeFileSync(destination, 'partial');
      throw new Error('copy failed');
    });

    expect(() => writeWithBackupSync(targetPath, 'new')).toThrow(
      'Failed to backup existing file: copy failed',
    );
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('old');
    expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
  });

  it.each(['EPERM', 'EACCES'])(
    'preserves the target and removes its identical recovery copy on %s',
    (code) => {
      fs.writeFileSync(targetPath, 'old');
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });

      let error: unknown;
      try {
        writeWithBackupSync(targetPath, 'new', { backupSuffix: '.bak' });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(code);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('old');
      expect(String(error)).not.toContain('Recovery copy retained');
      expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
    },
  );

  it('does not accumulate identical backups when publication keeps failing', () => {
    fs.writeFileSync(targetPath, 'old');
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });

    for (const content of ['v1', 'v2', 'v3']) {
      expect(() => writeWithBackupSync(targetPath, content)).toThrow('EBUSY');
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('old');
      expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
    }
  });

  it.each(['target', 'backup'])(
    'retains the recovery copy when reading the %s for comparison fails',
    (unreadable) => {
      fs.writeFileSync(targetPath, 'old');
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw new Error('publication failed');
      });
      vi.mocked(fs.readFileSync).mockImplementation((...args) => {
        const isTarget = args[0] === targetPath;
        if (isTarget === (unreadable === 'target')) {
          throw new Error('comparison read failed');
        }
        return nativeFs.readFileSync(...args);
      });

      let error: unknown;
      try {
        writeWithBackupSync(targetPath, 'new');
      } catch (caught) {
        error = caught;
      }

      expect(String(error)).toContain('publication failed');
      expect(String(error)).not.toContain('comparison read failed');
      expect(nativeFs.readFileSync(targetPath, 'utf8')).toBe('old');
      const directory = fs
        .readdirSync(tempDir)
        .find((name) => name.startsWith('settings.json.write-'))!;
      const recoveryPath = path.join(tempDir, directory, 'settings.json.orig');
      expect(String(error)).toContain(recoveryPath);
      expect(nativeFs.readFileSync(recoveryPath, 'utf8')).toBe('old');
      expect(fs.readdirSync(path.join(tempDir, directory))).toEqual([
        'settings.json.orig',
      ]);
    },
  );

  it('cleans up a failed first publication without claiming a recovery copy', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error('rename failed');
    });

    expect(() => writeWithBackupSync(targetPath, 'new')).toThrow(
      'rename failed',
    );
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('keeps the publication error when deleting identical working artifacts fails', () => {
    fs.writeFileSync(targetPath, 'old');
    const failure = new Error('publication failed');
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw failure;
    });
    vi.mocked(fs.rmSync).mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    let error: unknown;
    try {
      writeWithBackupSync(targetPath, 'new');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(failure);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('old');
  });

  it('retains the recovery pointer and newer target when staging cleanup fails', () => {
    fs.writeFileSync(targetPath, 'old');
    vi.mocked(fs.renameSync).mockImplementation(() => {
      nativeFs.writeFileSync(targetPath, 'newer writer');
      throw new Error('publication failed');
    });
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    let error: unknown;
    try {
      writeWithBackupSync(targetPath, 'new');
    } catch (caught) {
      error = caught;
    }
    const directory = fs
      .readdirSync(tempDir)
      .find((entry) => entry.startsWith('settings.json.write-'))!;
    const backup = path.join(tempDir, directory, 'settings.json.orig');
    expect(String(error)).toContain('publication failed');
    expect(String(error)).toContain(backup);
    expect(String(error)).not.toContain('cleanup failed');
    expect(fs.readFileSync(backup, 'utf8')).toBe('old');
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('newer writer');
  });

  it('never rolls back a second writer when the first publication fails', () => {
    fs.writeFileSync(targetPath, 'original');
    let secondWriter = false;
    vi.mocked(fs.renameSync).mockImplementation((...args) => {
      if (secondWriter) {
        nativeFs.renameSync(...args);
        return;
      }
      secondWriter = true;
      writeWithBackupSync(targetPath, 'writer B');
      throw new Error('writer A failed');
    });

    let error: unknown;
    try {
      writeWithBackupSync(targetPath, 'writer A', { backupSuffix: '.bak' });
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toContain('writer A failed');
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('writer B');
    const directory = fs
      .readdirSync(tempDir)
      .find((name) => name.startsWith('settings.json.write-'))!;
    const recoveryPath = path.join(tempDir, directory, 'settings.json.bak');
    expect(String(error)).toContain(recoveryPath);
    expect(fs.readFileSync(recoveryPath, 'utf8')).toBe('original');
    expect(fs.readdirSync(path.join(tempDir, directory))).toEqual([
      'settings.json.bak',
    ]);
  });

  it('isolates overlapping successful writers and publishes complete content', () => {
    fs.writeFileSync(targetPath, 'original');
    let secondWriter = false;
    vi.mocked(fs.renameSync).mockImplementation((...args) => {
      if (!secondWriter) {
        secondWriter = true;
        writeWithBackupSync(targetPath, 'writer B');
        expect(fs.readFileSync(targetPath, 'utf8')).toBe('writer B');
      }
      nativeFs.renameSync(...args);
    });

    writeWithBackupSync(targetPath, 'writer A');

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('writer A');
    expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
  });

  it('still reports success when cleanup after publication fails', () => {
    fs.writeFileSync(targetPath, 'old');
    vi.mocked(fs.rmSync).mockImplementation(() => {
      throw new Error('cleanup failed');
    });

    expect(() => writeWithBackupSync(targetPath, 'new')).not.toThrow();
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('new');
  });

  it('ignores historical staging directories and backup symlinks', () => {
    fs.writeFileSync(targetPath, 'old');
    fs.mkdirSync(`${targetPath}.tmp`);
    const unrelated = path.join(tempDir, 'unrelated');
    fs.writeFileSync(unrelated, 'unrelated');
    fs.symlinkSync(unrelated, `${targetPath}.orig`);

    writeWithBackupSync(targetPath, 'new');

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('new');
    expect(fs.statSync(`${targetPath}.tmp`).isDirectory()).toBe(true);
    expect(fs.lstatSync(`${targetPath}.orig`).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated');
  });

  it('supports async creation and overwriting with a custom encoding', async () => {
    await writeWithBackup(targetPath, '初始', { encoding: 'utf16le' });
    expect(fs.readFileSync(targetPath, 'utf16le')).toBe('初始');
    await writeWithBackup(targetPath, '更新', { encoding: 'utf16le' });
    expect(fs.readFileSync(targetPath, 'utf16le')).toBe('更新');
    expect(fs.readdirSync(tempDir)).toEqual(['settings.json']);
  });
});
