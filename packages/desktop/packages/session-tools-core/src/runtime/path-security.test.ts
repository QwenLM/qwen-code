import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isPathInsideOrEqual,
  isPathWithinDirectory,
  isPathWithinDirectoryForCreation,
} from './path-security.ts';

describe('path-security', () => {
  let rootDir: string;
  let sessionDir: string;
  let dataDir: string;
  let outsideDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'path-security-'));
    sessionDir = join(rootDir, 'session');
    dataDir = join(sessionDir, 'data');
    outsideDir = join(rootDir, 'outside');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('blocks sibling prefix bypass', () => {
    const sibling = join(rootDir, 'session-evil', 'file.txt');
    expect(isPathWithinDirectory(sibling, sessionDir)).toBe(false);
    expect(isPathWithinDirectoryForCreation(sibling, sessionDir)).toBe(false);
  });

  it('allows child names that start with dots but are not parent-directory segments', () => {
    expect(isPathInsideOrEqual(sessionDir, join(sessionDir, '..backup', 'file.txt'))).toBe(true);
    expect(isPathInsideOrEqual(sessionDir, join(sessionDir, '..notes.md'))).toBe(true);
  });

  it('blocks symlink escape for creation paths', () => {
    if (process.platform === 'win32') {
      // Symlink creation on Windows is permission-sensitive in CI/dev.
      return;
    }

    const escapeLink = join(dataDir, 'escape-link');
    symlinkSync(outsideDir, escapeLink, 'dir');

    const escapedOutput = join(escapeLink, 'out.json');
    expect(isPathWithinDirectoryForCreation(escapedOutput, dataDir)).toBe(false);
  });

  it('blocks creation through a broken final symlink', () => {
    if (process.platform === 'win32') {
      return;
    }

    const outsideFile = join(outsideDir, 'created.txt');
    const linkInSession = join(dataDir, 'created.txt');
    symlinkSync(outsideFile, linkInSession, 'file');

    expect(isPathWithinDirectoryForCreation(linkInSession, dataDir)).toBe(false);
  });

  it('allows paths inside a root directory that is itself a symlink', () => {
    if (process.platform === 'win32') {
      return;
    }

    const linkedSessionDir = join(rootDir, 'session-link');
    symlinkSync(sessionDir, linkedSessionDir, 'dir');
    const filePath = join(linkedSessionDir, 'data', 'file.txt');
    writeFileSync(filePath, 'inside');

    expect(isPathWithinDirectory(filePath, linkedSessionDir)).toBe(true);
    expect(isPathWithinDirectoryForCreation(filePath, linkedSessionDir)).toBe(true);
  });

  it('blocks symlink escape for existing files', () => {
    if (process.platform === 'win32') {
      return;
    }

    const outsideFile = join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret');

    const linkInSession = join(sessionDir, 'linked-secret.txt');
    symlinkSync(outsideFile, linkInSession, 'file');

    expect(isPathWithinDirectory(linkInSession, sessionDir)).toBe(false);
  });
});
