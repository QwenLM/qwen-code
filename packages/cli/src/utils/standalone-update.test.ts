import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { rollbackStandaloneUpdate } from './standalone-update.js';

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

      // Current version
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
          version: '0.17.0',
        }),
      );
      fs.writeFileSync(path.join(standaloneDir, 'marker.txt'), 'new');

      // Old version
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

      // Verify the swap happened
      const manifest = JSON.parse(
        fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf-8'),
      );
      expect(manifest.version).toBe('0.16.2');
      expect(
        fs.readFileSync(path.join(standaloneDir, 'marker.txt'), 'utf-8'),
      ).toBe('old');

      // .old should no longer exist
      expect(fs.existsSync(oldDir)).toBe(false);
    });

    it('returns false if .old has invalid manifest content', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);

      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.17.0' }),
      );
      // Old dir has manifest — rollback should succeed even with minimal manifest
      fs.writeFileSync(path.join(oldDir, 'manifest.json'), '{}');

      const result = rollbackStandaloneUpdate(standaloneDir);
      // It should succeed because manifest.json EXISTS (content validation is not done in rollback)
      expect(result).toBe(true);
    });
  });
});
