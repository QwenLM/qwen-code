/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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
  return runCli(['extensions', 'validate-mods', ...args]);
}
function runCli(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, QWEN_HOME: home, QWEN_RUNTIME_DIR: home },
  });
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
  it.each([
    ['extensions', 'validate-mods', '-h'],
    ['extensions', 'validate-mods', '-h', 'plugin'],
    ['-h', 'extensions', 'validate-mods', 'plugin'],
    ['extensions', 'validate-mods', '--help'],
  ])('prints help with no path reads or startup writes: %s', (...args) => {
    const before = snapshot(root);
    const result = runCli(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('validate-mods <path>');
    expect(result.stdout).toContain('--json');
    expect(result.stderr).toBe('');
    expect(snapshot(root)).toEqual(before);
  });
  it('accepts a value-taking global flag without model or settings startup', () => {
    const before = snapshot(root);
    const result = runCli([
      '--proxy',
      'http://127.0.0.1:1',
      'extensions',
      'validate-mods',
      plugin,
      '--json',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      discovery: 'absent',
      static: { status: 'not-checked', complete: true },
      runtime: 'unavailable',
    });
    expect(snapshot(root)).toEqual(before);
  });
  it('renders text provenance, matchers, catch, and diagnostics without executing source', () => {
    write('hooks/hooks.json', JSON.stringify({ modules: ['./register.mjs'] }));
    write(
      'hooks/register.mjs',
      [
        "import './helper.mjs';",
        'while (true) {}',
        'export function register(on) {',
        "  on('tool.call', {tool:'Bash'}, ($,e,next) => $.fs.read('x')).catch(($,e,next) => next(e));",
        "  on('tool.check', {tool:'Write'}, ($,e,next) => next(e));",
        '  on(getEvent(), ($,e,next) => next(e));',
        '}',
      ].join('\n'),
    );
    write(
      'hooks/helper.mjs',
      'export function read($) { return $.clock.now(); }\n',
    );
    const before = snapshot(root);
    const result = run([plugin]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Static: incomplete\n');
    expect(result.stdout).not.toContain('incomplete (incomplete)');
    expect(result.stdout).toContain('Runtime: unavailable');
    expect(result.stdout).toMatch(
      /api: clock\.now \(M5\) hooks\/helper\.mjs:1:\d+/,
    );
    expect(result.stdout).toContain(
      'event: tool.call (M4) hooks/register.mjs:4:3 matcher={"tool":"Bash"} catch',
    );
    expect(result.stdout).toMatch(
      /api: fs\.read \(M5\) hooks\/register\.mjs:4:\d+/,
    );
    expect(
      result.stdout
        .split('\n')
        .find((line) => line.startsWith('event: tool.check')),
    ).toBe(
      'event: tool.check (M4) hooks/register.mjs:5:3 matcher={"tool":"Write"}',
    );
    expect(result.stdout).toContain(
      'error MOD_ANALYSIS_INCOMPLETE hooks/register.mjs:6:6:',
    );
    expect(snapshot(root)).toEqual(before);
  });
  it('keeps a valid validation exit when its stdout reader closes', async () => {
    write('hooks/hooks.json', JSON.stringify({ modules: ['./register.mjs'] }));
    write(
      'hooks/register.mjs',
      'while (true) {} export function register(on) {}',
    );
    const before = snapshot(root);
    const child = spawn(
      process.execPath,
      [cli, 'extensions', 'validate-mods', plugin, '--json'],
      {
        cwd: root,
        env: { ...process.env, QWEN_HOME: home, QWEN_RUNTIME_DIR: home },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    child.stdout.destroy();
    expect(await closed).toBe(0);
    expect(stderr).toBe('');
    expect(snapshot(root)).toEqual(before);
  });
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
