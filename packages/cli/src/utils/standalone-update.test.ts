/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  rollbackStandaloneUpdate,
  ensureBinWrapper,
  ensurePathInShellRc,
} from './standalone-update.js';

describe('standalone-update', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-update-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('rollbackStandaloneUpdate', () => {
    it('returns false when .old directory does not exist', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      fs.mkdirSync(standaloneDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
        }),
      );

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result).toBe(false);
    });

    it('returns false when .old directory has no manifest.json', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
        }),
      );

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result).toBe(false);
    });

    it('swaps current with .old directory on valid rollback', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);

      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
          version: '0.17.0',
        }),
      );
      fs.writeFileSync(path.join(standaloneDir, 'marker.txt'), 'new');

      fs.writeFileSync(
        path.join(oldDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
          version: '0.16.2',
        }),
      );
      fs.writeFileSync(path.join(oldDir, 'marker.txt'), 'old');

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf-8'),
      );
      expect(manifest.version).toBe('0.16.2');
      expect(
        fs.readFileSync(path.join(standaloneDir, 'marker.txt'), 'utf-8'),
      ).toBe('old');
      expect(fs.existsSync(oldDir)).toBe(false);
    });

    it('succeeds even with minimal manifest in .old', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);

      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.17.0' }),
      );
      fs.writeFileSync(path.join(oldDir, 'manifest.json'), '{}');

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result).toBe(true);
    });
  });

  describe('ensureBinWrapper', () => {
    // Unix wrapper test relies on POSIX file permissions (mode bits) and
    // the SHELL env var, neither of which behave consistently on Windows.
    it.skipIf(process.platform === 'win32')(
      'creates a Unix shell wrapper script',
      () => {
        const libDir = path.join(tempDir, '.local', 'lib');
        const standaloneDir = path.join(libDir, 'qwen-code');
        fs.mkdirSync(standaloneDir, { recursive: true });

        // Isolate HOME so ensurePathInShellRc doesn't touch real shell rc
        const origHome = process.env['HOME'];
        const origShell = process.env['SHELL'];
        process.env['HOME'] = tempDir;
        process.env['SHELL'] = '/bin/zsh';
        try {
          ensureBinWrapper(standaloneDir, 'darwin-arm64');
        } finally {
          process.env['HOME'] = origHome;
          process.env['SHELL'] = origShell;
        }

        const wrapperPath = path.join(tempDir, '.local', 'bin', 'qwen');
        expect(fs.existsSync(wrapperPath)).toBe(true);
        const content = fs.readFileSync(wrapperPath, 'utf-8');
        expect(content).toContain('#!/bin/sh');
        expect(content).toContain(standaloneDir);
        const mode = fs.statSync(wrapperPath).mode;
        expect(mode & 0o111).toBeGreaterThan(0);
      },
    );

    it('creates a Windows cmd wrapper', () => {
      const libDir = path.join(tempDir, '.local', 'lib');
      const standaloneDir = path.join(libDir, 'qwen-code');
      fs.mkdirSync(standaloneDir, { recursive: true });

      ensureBinWrapper(standaloneDir, 'win-x64');

      const wrapperPath = path.join(tempDir, '.local', 'bin', 'qwen.cmd');
      expect(fs.existsSync(wrapperPath)).toBe(true);
      const content = fs.readFileSync(wrapperPath, 'utf-8');
      expect(content).toContain('@echo off');
    });

    it.skipIf(process.platform === 'win32')(
      'does not overwrite existing wrapper',
      () => {
        const libDir = path.join(tempDir, '.local', 'lib');
        const standaloneDir = path.join(libDir, 'qwen-code');
        const binDir = path.join(tempDir, '.local', 'bin');
        fs.mkdirSync(standaloneDir, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        const origHome = process.env['HOME'];
        const origShell = process.env['SHELL'];
        process.env['HOME'] = tempDir;
        process.env['SHELL'] = '/bin/zsh';

        const wrapperPath = path.join(binDir, 'qwen');
        fs.writeFileSync(wrapperPath, 'existing-content', { mode: 0o755 });

        try {
          ensureBinWrapper(standaloneDir, 'linux-x64');
          expect(fs.readFileSync(wrapperPath, 'utf-8')).toBe(
            'existing-content',
          );
        } finally {
          process.env['HOME'] = origHome;
          process.env['SHELL'] = origShell;
        }
      },
    );
  });

  describe.skipIf(process.platform === 'win32')('ensurePathInShellRc', () => {
    it('appends PATH export to zshrc when SHELL is zsh', () => {
      const binDir = path.join(tempDir, 'bin');
      const zshrc = path.join(tempDir, '.zshrc');
      fs.writeFileSync(zshrc, '# existing config\n');

      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(zshrc, 'utf-8');
        expect(content).toContain('# Added by Qwen Code standalone installer');
        expect(content).toContain(`export PATH="${binDir}:$PATH"`);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('skips if marker already in rc file', () => {
      const binDir = path.join(tempDir, 'bin');
      const zshrc = path.join(tempDir, '.zshrc');
      fs.writeFileSync(
        zshrc,
        `# Added by Qwen Code standalone installer\nexport PATH="${binDir}:$PATH"\n`,
      );

      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(zshrc, 'utf-8');
        const matches = content.match(
          /# Added by Qwen Code standalone installer/g,
        );
        expect(matches).toHaveLength(1);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('does nothing for unknown shells', () => {
      const binDir = path.join(tempDir, 'bin');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/csh';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        // No rc file should be created
        expect(
          fs.readdirSync(tempDir).filter((f) => f.startsWith('.')),
        ).toHaveLength(0);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });
  });
});
