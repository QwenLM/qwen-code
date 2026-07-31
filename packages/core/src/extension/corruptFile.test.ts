/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { quarantineCorruptFile } from './corruptFile.js';

describe('quarantineCorruptFile', () => {
  let testDir: string;
  let stderrSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-file-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('renames the file aside to ${path}.corrupted, preserving its bytes', () => {
    const filePath = path.join(testDir, 'prefs.json');
    fs.writeFileSync(filePath, '{ broken json', 'utf-8');

    quarantineCorruptFile(filePath);

    // Original is gone; the bytes are preserved in the .corrupted sibling.
    expect(fs.existsSync(filePath)).toBe(false);
    const quarantined = `${filePath}.corrupted`;
    expect(fs.existsSync(quarantined)).toBe(true);
    expect(fs.readFileSync(quarantined, 'utf-8')).toBe('{ broken json');
    // The quarantine event is surfaced on stderr (debug log is gated off).
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('moved aside'),
    );
  });

  it('does not throw when the file cannot be moved aside', () => {
    // Renaming a non-existent file throws ENOENT inside the helper; it must be
    // swallowed (best-effort) and reported on stderr rather than propagated.
    const missing = path.join(testDir, 'does-not-exist.json');

    expect(() => quarantineCorruptFile(missing)).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not be moved aside'),
    );
  });
});
