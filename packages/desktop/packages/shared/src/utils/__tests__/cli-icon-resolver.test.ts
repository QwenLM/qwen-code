/**
 * Tests for CLI tool icon resolver.
 *
 * Covers:
 * - splitCommands: splitting bash strings on &&, ||, ;, |
 * - extractCommandName: extracting command from a single sub-command
 * - extractCommandNames: full parsing of complex bash command strings
 * - resolveToolIcon: end-to-end resolution with config and icon files
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  splitCommands,
  extractCommandName,
  extractCommandNames,
  resolveToolIcon,
  loadToolIconConfig,
  type ToolIconConfig,
} from '../cli-icon-resolver.ts';

// ============================================
// splitCommands
// ============================================

describe('splitCommands', () => {
  test('single command', () => {
    expect(splitCommands('git status')).toEqual(['git status']);
  });

  test('&& chained', () => {
    expect(splitCommands('git add . && git commit -m "msg"')).toEqual([
      'git add .',
      'git commit -m "msg"',
    ]);
  });

  test('|| chained', () => {
    expect(splitCommands('npm test || echo failed')).toEqual([
      'npm test',
      'echo failed',
    ]);
  });

  test('semicolon separated', () => {
    expect(splitCommands('mkdir dist; cp src/* dist/')).toEqual([
      'mkdir dist',
      'cp src/* dist/',
    ]);
  });

  test('pipe', () => {
    expect(splitCommands('git log | head -10')).toEqual([
      'git log',
      'head -10',
    ]);
  });

  test('mixed operators', () => {
    expect(splitCommands('npm install && npm run build || echo failed; npm test')).toEqual([
      'npm install',
      'npm run build',
      'echo failed',
      'npm test',
    ]);
  });

  test('preserves double-quoted strings with operators', () => {
    expect(splitCommands('git commit -m "fix && improve"')).toEqual([
      'git commit -m "fix && improve"',
    ]);
  });

  test('preserves single-quoted strings with operators', () => {
    expect(splitCommands("echo 'hello | world'")).toEqual([
      "echo 'hello | world'",
    ]);
  });

  test('empty string', () => {
    expect(splitCommands('')).toEqual([]);
  });

  test('whitespace only', () => {
    expect(splitCommands('   ')).toEqual([]);
  });

  test('pipe does not confuse with ||', () => {
    // "a || b" should split into two parts, not three
    expect(splitCommands('a || b')).toEqual(['a', 'b']);
  });
});

// ============================================
// extractCommandName
// ============================================

describe('extractCommandName', () => {
  test('simple command', () => {
    expect(extractCommandName('git status')).toBe('git');
  });

  test('command with flags', () => {
    expect(extractCommandName('npm install --save-dev')).toBe('npm');
  });

  test('env var prefix', () => {
    expect(extractCommandName('NODE_ENV=production npm run build')).toBe('npm');
  });

  test('multiple env var prefixes', () => {
    expect(extractCommandName('FOO=1 BAR=2 python3 script.py')).toBe('python3');
  });

  test('sudo prefix', () => {
    expect(extractCommandName('sudo docker ps')).toBe('docker');
  });

  test('time prefix', () => {
    expect(extractCommandName('time npm test')).toBe('npm');
  });

  test('nohup prefix', () => {
    expect(extractCommandName('nohup node server.js')).toBe('node');
  });

  test('env prefix', () => {
    expect(extractCommandName('env npm start')).toBe('npm');
  });

  test('timeout with numeric arg', () => {
    expect(extractCommandName('timeout 30 python3 script.py')).toBe('python3');
  });

  test('combined: env var + sudo', () => {
    expect(extractCommandName('NODE_ENV=prod sudo docker-compose up')).toBe('docker-compose');
  });

  test('absolute path prefix', () => {
    expect(extractCommandName('/usr/local/bin/node script.js')).toBe('node');
  });

  test('relative path prefix', () => {
    expect(extractCommandName('./node_modules/.bin/jest --watch')).toBe('jest');
  });

  test('home path prefix', () => {
    expect(extractCommandName('~/.local/bin/python3 test.py')).toBe('python3');
  });

  test('empty string returns undefined', () => {
    expect(extractCommandName('')).toBeUndefined();
  });

  test('env-only (no actual command) returns undefined', () => {
    // A bare env assignment has no command after it — correctly returns undefined
    expect(extractCommandName('FOO=bar')).toBeUndefined();
  });

  test('caffeinate prefix (macOS)', () => {
    expect(extractCommandName('caffeinate npm run build')).toBe('npm');
  });

  // Shell wrapper tests
  test('zsh -lc wrapper', () => {
    expect(extractCommandName("/bin/zsh -lc 'git status'")).toBe('git');
  });

  test('bash -c wrapper', () => {
    expect(extractCommandName('bash -c "npm install"')).toBe('npm');
  });

  test('sh -c wrapper', () => {
    expect(extractCommandName("sh -c 'docker ps'")).toBe('docker');
  });

  test('nested env vars in shell wrapper', () => {
    expect(extractCommandName("/bin/bash -c 'NODE_ENV=prod npm run build'")).toBe('npm');
  });

  test('shell wrapper with path prefix', () => {
    expect(extractCommandName("/bin/zsh -lc '/usr/local/bin/git status'")).toBe('git');
  });

  test('shell wrapper with sudo inside', () => {
    expect(extractCommandName("bash -c 'sudo docker ps'")).toBe('docker');
  });
});

// ============================================
// extractCommandNames (full pipeline)
// ============================================

describe('extractCommandNames', () => {
  test('simple command', () => {
    expect(extractCommandNames('git status')).toEqual(['git']);
  });

  test('env vars + command', () => {
    expect(extractCommandNames('NODE_ENV=prod npm run build')).toEqual(['npm']);
  });

  test('multiple env vars', () => {
    expect(extractCommandNames('FOO=1 BAR=2 python3 script.py')).toEqual(['python3']);
  });

  test('chained with &&', () => {
    expect(extractCommandNames('git add . && npm publish')).toEqual(['git', 'npm']);
  });

  test('chained with ||', () => {
    expect(extractCommandNames('npm test || echo failed')).toEqual(['npm', 'echo']);
  });

  test('semicolons', () => {
    expect(extractCommandNames('mkdir dist; cp src/* dist/')).toEqual(['mkdir', 'cp']);
  });

  test('pipes', () => {
    expect(extractCommandNames('git log | head -10')).toEqual(['git', 'head']);
  });

  test('sudo', () => {
    expect(extractCommandNames('sudo docker ps')).toEqual(['docker']);
  });

  test('time prefix', () => {
    expect(extractCommandNames('time npm test')).toEqual(['npm']);
  });

  test('absolute path', () => {
    expect(extractCommandNames('/usr/local/bin/node script.js')).toEqual(['node']);
  });

  test('relative path', () => {
    expect(extractCommandNames('./node_modules/.bin/jest')).toEqual(['jest']);
  });

  test('empty string', () => {
    expect(extractCommandNames('')).toEqual([]);
  });

  test('quoted args preserved', () => {
    expect(extractCommandNames('git commit -m "feat: add feature"')).toEqual(['git']);
  });

  test('complex mixed command', () => {
    expect(
      extractCommandNames('NODE_ENV=prod sudo docker-compose up && npm run migrate')
    ).toEqual(['docker-compose', 'npm']);
  });

  test('triple chain', () => {
    expect(
      extractCommandNames('git add . && git commit -m "msg" && git push')
    ).toEqual(['git', 'git', 'git']);
  });

  test('pipe chain', () => {
    expect(
      extractCommandNames('cat package.json | jq .scripts | head')
    ).toEqual(['cat', 'jq', 'head']);
  });
});

// ============================================
// loadToolIconConfig
// ============================================

describe('loadToolIconConfig', () => {
  test('loads valid config from bundled assets', () => {
    const assetsDir = join(__dirname, '../../../../../apps/electron/resources/tool-icons');
    const config = loadToolIconConfig(assetsDir);
    expect(config).not.toBeNull();
    expect(config!.version).toBe(1);
    expect(config!.tools.length).toBeGreaterThan(50);

    // Check a known entry
    const git = config!.tools.find(t => t.id === 'git');
    expect(git).toBeDefined();
    expect(git!.displayName).toBe('Git');
    expect(git!.commands).toContain('git');
  });

  test('returns null for non-existent directory', () => {
    expect(loadToolIconConfig('/nonexistent/path')).toBeNull();
  });

  test('returns null for directory without tool-icons.json', () => {
    expect(loadToolIconConfig(tmpdir())).toBeNull();
  });
});

// ============================================
// resolveToolIcon (end-to-end with real files)
// ============================================

describe('resolveToolIcon', () => {
  const testDir = join(tmpdir(), 'cli-icon-resolver-test-' + Date.now());

  beforeAll(() => {
    // Create a minimal test config with a tiny valid PNG icon
    mkdirSync(testDir, { recursive: true });

    // 1x1 transparent PNG (68 bytes)
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    writeFileSync(join(testDir, 'git.png'), tinyPng);
    writeFileSync(join(testDir, 'npm.png'), tinyPng);
    writeFileSync(join(testDir, 'jq.png'), tinyPng);
    writeFileSync(join(testDir, 'docker.png'), tinyPng);

    const config: ToolIconConfig = {
      version: 1,
      tools: [
        { id: 'git', displayName: 'Git', icon: 'git.png', commands: ['git'] },
        { id: 'npm', displayName: 'npm', icon: 'npm.png', commands: ['npm', 'npx'] },
        { id: 'jq', displayName: 'jq', icon: 'jq.png', commands: ['jq'] },
        { id: 'docker', displayName: 'Docker', icon: 'docker.png', commands: ['docker', 'docker-compose'] },
      ],
    };
    writeFileSync(join(testDir, 'tool-icons.json'), JSON.stringify(config));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('resolves simple git command', () => {
    const result = resolveToolIcon('git status', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('Git');
    expect(result!.iconDataUrl).toStartWith('data:image/png;base64,');
  });

  test('resolves npm command', () => {
    const result = resolveToolIcon('npm install', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('npm');
  });

  test('resolves npx alias to npm tool', () => {
    const result = resolveToolIcon('npx vitest', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('npm');
  });

  test('first icon match wins in chained commands', () => {
    // echo has no icon, git does — should resolve to git
    const result = resolveToolIcon('echo hello && git push', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('Git');
  });

  test('resolves pipe — first match with icon', () => {
    // cat has no icon, jq does
    const result = resolveToolIcon('cat foo.json | jq .name', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('jq');
  });

  test('no match for unknown command', () => {
    const result = resolveToolIcon('ls -la', testDir);
    expect(result).toBeUndefined();
  });

  test('handles env vars before command', () => {
    const result = resolveToolIcon('NODE_ENV=production npm run build', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('npm');
  });

  test('handles sudo prefix', () => {
    const result = resolveToolIcon('sudo docker ps', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('Docker');
  });

  test('handles docker-compose (hyphenated command)', () => {
    const result = resolveToolIcon('docker-compose up -d', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('Docker');
  });

  test('returns undefined for empty command', () => {
    expect(resolveToolIcon('', testDir)).toBeUndefined();
  });

  test('returns undefined for non-existent config dir', () => {
    expect(resolveToolIcon('git status', '/nonexistent/path')).toBeUndefined();
  });

  test('resolves with real bundled assets', () => {
    // Use the actual bundled assets to verify end-to-end
    const assetsDir = join(__dirname, '../../../../../apps/electron/resources/tool-icons');
    const result = resolveToolIcon('git status', assetsDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('Git');
    expect(result!.id).toBe('git');
    expect(result!.iconDataUrl).toStartWith('data:image/');
  });

  test('resolves git from zsh -lc wrapper', () => {
    const result = resolveToolIcon("/bin/zsh -lc 'git status'", testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('Git');
  });

  test('resolves npm from bash -c wrapper', () => {
    const result = resolveToolIcon('bash -c "npm install"', testDir);
    expect(result).toBeDefined();
    expect(result!.displayName).toBe('npm');
  });
});
