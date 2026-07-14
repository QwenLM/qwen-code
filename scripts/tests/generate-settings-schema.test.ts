/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGenerateSettingsSchema } from '../generate-settings-schema.js';

vi.unmock('node:fs');

const tempDirs: string[] = [];

function makeSchemaPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'qwen-settings-schema-'));
  tempDirs.push(root);
  return path.join(root, 'schemas', 'settings.schema.json');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runGenerateSettingsSchema', () => {
  it('runs the real entry point with the default path and exit status', () => {
    const script = path.resolve('scripts/generate-settings-schema.ts');
    const current = spawnSync('npx', ['tsx', script, '--check'], {
      encoding: 'utf8',
    });
    const invalid = spawnSync('npx', ['tsx', script, '--unknown'], {
      encoding: 'utf8',
    });

    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout).toContain('Settings JSON Schema is current');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('Unknown argument: --unknown');
  });

  it('returns success without rewriting a current schema', () => {
    const schemaPath = makeSchemaPath();
    expect(runGenerateSettingsSchema([], schemaPath)).toBe(0);

    const content = readFileSync(schemaPath, 'utf8');
    utimesSync(schemaPath, new Date(1_000_000_000), new Date(1_000_000_000));
    const mtimeMs = statSync(schemaPath).mtimeMs;

    expect(runGenerateSettingsSchema(['--check'], schemaPath)).toBe(0);
    expect(readFileSync(schemaPath, 'utf8')).toBe(content);
    expect(statSync(schemaPath).mtimeMs).toBe(mtimeMs);
  });

  it('reports a stale schema without rewriting it', () => {
    const schemaPath = makeSchemaPath();
    mkdirSync(path.dirname(schemaPath), { recursive: true });
    writeFileSync(schemaPath, 'stale schema\n');
    utimesSync(schemaPath, new Date(1_000_000_000), new Date(1_000_000_000));
    const mtimeMs = statSync(schemaPath).mtimeMs;

    expect(runGenerateSettingsSchema(['--check'], schemaPath)).toBe(1);
    expect(readFileSync(schemaPath, 'utf8')).toBe('stale schema\n');
    expect(statSync(schemaPath).mtimeMs).toBe(mtimeMs);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('npm run generate:settings-schema'),
    );
  });

  it('reports a missing schema without creating it', () => {
    const schemaPath = makeSchemaPath();

    expect(runGenerateSettingsSchema(['--check'], schemaPath)).toBe(1);
    expect(existsSync(schemaPath)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('npm run generate:settings-schema'),
    );
  });

  it('rejects unknown arguments without writing a schema', () => {
    const schemaPath = makeSchemaPath();

    expect(runGenerateSettingsSchema(['--unknown'], schemaPath)).toBe(1);
    expect(existsSync(schemaPath)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown argument: --unknown'),
    );
  });
});
