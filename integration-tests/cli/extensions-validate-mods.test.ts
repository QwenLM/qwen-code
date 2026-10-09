/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
let root: string;
let plugin: string;
let home: string;
function write(relative: string, content: string) {
  const file = join(plugin, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(file));
    else files[file] = readFileSync(file).toString('base64');
  }
  return files;
}
function run(args: string[]) {
  return spawnSync(
    process.execPath,
    [cli, 'extensions', 'validate-mods', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, QWEN_HOME: home, QWEN_RUNTIME_DIR: home },
    },
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qwen-mod-cli-'));
  plugin = join(root, 'plugin');
  home = join(root, 'home');
  mkdirSync(plugin);
  mkdirSync(home);
  write(
    'qwen-extension.json',
    JSON.stringify({ name: 'cli-mod', version: '1.0.0' }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('built CLI Mod validation', () => {
  it('parses reachable source without executing loops, throws, or side effects and writes nothing', () => {
    write('hooks/hooks.json', JSON.stringify({ modules: ['./register.mjs'] }));
    write(
      'hooks/register.mjs',
      "import './side.mjs'; while (true) {} throw new Error('not executed'); export function register(on) { on('session.start', async ($, e, next) => next(e)); }",
    );
    write(
      'hooks/side.mjs',
      "throw new Error('side effect module must not execute');",
    );
    const before = snapshot(root);
    const result = run([plugin, '--json']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      discovery: 'declared',
      static: { status: 'valid', complete: true },
      runtime: 'unavailable',
    });
    expect(report.files).toEqual(['hooks/register.mjs', 'hooks/side.mjs']);
    expect(snapshot(root)).toEqual(before);
  });
  it('reports absent modules and invalid imports with distinct validation exits', () => {
    const absent = run([plugin, '--json']);
    expect(absent.status).toBe(0);
    expect(JSON.parse(absent.stdout).discovery).toBe('absent');
    write('hooks/hooks.json', JSON.stringify({ modules: ['./register.mjs'] }));
    write(
      'hooks/register.mjs',
      "import fs from 'node:fs'; export function register(on) {}",
    );
    const invalid = run([plugin, '--json']);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      ]),
    );
  });
  it('uses exit 2 for command usage errors before startup', () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(readdirSync(home)).toEqual([]);
  });
});
