/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe.skipIf(process.platform === 'win32')(
  'separate Managed runtime archive',
  () => {
    let temporary;
    let script;
    let args;
    let outDir;
    beforeEach(() => {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-package-'));
      const checkout = path.join(temporary, 'checkout');
      fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, 'package.json'),
        JSON.stringify({ type: 'module', version: '0.25.3' }),
      );
      const source = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
      );
      for (const file of [
        'create-managed-runtime-package.js',
        'managed-local-package.js',
      ]) {
        fs.copyFileSync(
          path.join(source, file),
          path.join(checkout, 'scripts', file),
        );
      }
      script = path.join(
        checkout,
        'scripts',
        'create-managed-runtime-package.js',
      );
      const jre = path.join(temporary, 'jre');
      fs.mkdirSync(path.join(jre, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(jre, 'lib'));
      fs.mkdirSync(path.join(jre, 'legal'));
      fs.writeFileSync(
        path.join(jre, 'release'),
        'JAVA_VERSION="21.0.12"\nOS_NAME="Darwin"\nOS_ARCH="aarch64"\n',
      );
      fs.writeFileSync(path.join(jre, 'bin', 'java'), 'fixture', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(jre, 'lib', 'modules'), 'modules');
      fs.writeFileSync(path.join(jre, 'legal', 'LICENSE'), 'license');
      if (process.platform === 'darwin') {
        execFileSync('xattr', [
          '-w',
          'com.qwen.package-test',
          'fixture',
          path.join(jre, 'bin', 'java'),
        ]);
      }
      const jar = path.join(temporary, 'server.jar');
      fs.writeFileSync(jar, Buffer.from('504b03040000', 'hex'));
      outDir = path.join(temporary, 'output');
      args = [
        '--target',
        'darwin-arm64',
        '--server-jar',
        jar,
        '--jre-home',
        jre,
        '--out-dir',
        outDir,
      ];
    });
    afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

    it('builds from JAR/JRE inputs alone and installs under the exact CLI version and target', () => {
      execFileSync(process.execPath, [script, ...args], { cwd: temporary });
      const name = 'qwen-code-managed-runtime-darwin-arm64.tar.gz';
      const archive = path.join(outDir, name);
      // macOS tar hides AppleDouble entries when listing; inspect raw headers.
      const tar = gunzipSync(fs.readFileSync(archive));
      const entries = [];
      for (let offset = 0; tar[offset]; ) {
        const name = tar
          .subarray(offset, offset + 100)
          .toString()
          .split('\0')[0];
        const type = String.fromCharCode(tar[offset + 156]);
        if (type !== 'x' && type !== 'g') entries.push(name);
        const size = Number.parseInt(
          tar.subarray(offset + 124, offset + 136).toString(),
          8,
        );
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      expect(
        entries.every((entry) => entry.startsWith('managed-runtime/')),
      ).toBe(true);
      expect(
        entries.some((entry) =>
          entry.split('/').some((part) => part.startsWith('._')),
        ),
      ).toBe(false);
      const digest = createHash('sha256')
        .update(fs.readFileSync(archive))
        .digest('hex');
      expect(fs.readFileSync(`${archive}.sha256`, 'utf8')).toBe(
        `${digest}  ${name}\n`,
      );
      const extraction = path.join(temporary, 'extracted');
      fs.mkdirSync(extraction);
      execFileSync('tar', ['-xzf', archive, '-C', extraction]);
      const payload = path.join(
        extraction,
        'managed-runtime',
        '0.25.3',
        'darwin-arm64',
      );
      expect(fs.readdirSync(extraction)).toEqual(['managed-runtime']);
      expect(fs.readdirSync(payload).sort()).toEqual([
        'jre',
        'manifest.json',
        'server.jar',
      ]);
      expect(
        fs.readFileSync(path.join(payload, 'jre', 'legal', 'LICENSE'), 'utf8'),
      ).toBe('license');
      expect(
        JSON.parse(
          fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8'),
        ),
      ).toMatchObject({
        schemaVersion: 1,
        cliVersion: '0.25.3',
        target: 'darwin-arm64',
        javaMajor: 21,
        javaSource: 'bundled',
        serverSha256: createHash('sha256')
          .update(fs.readFileSync(args[3]))
          .digest('hex'),
      });
      expect(
        fs.existsSync(path.join(path.dirname(path.dirname(script)), 'dist')),
      ).toBe(false);
    });
    it('builds a separate lite archive from the server alone, without replacing the bundled archive', () => {
      execFileSync(process.execPath, [script, ...args]);
      const bundled = path.join(
        outDir,
        'qwen-code-managed-runtime-darwin-arm64.tar.gz',
      );
      const bundledBytes = fs.readFileSync(bundled);
      const liteArgs = [...args.slice(0, 4), '--without-jre', ...args.slice(6)];
      fs.rmSync(args[5], { recursive: true });
      execFileSync(process.execPath, [script, ...liteArgs]);
      const name = 'qwen-code-managed-runtime-lite-darwin-arm64.tar.gz';
      const archive = path.join(outDir, name);
      const digest = createHash('sha256')
        .update(fs.readFileSync(archive))
        .digest('hex');
      expect(fs.readFileSync(`${archive}.sha256`, 'utf8')).toBe(
        `${digest}  ${name}\n`,
      );
      const extraction = path.join(temporary, 'lite-extracted');
      fs.mkdirSync(extraction);
      execFileSync('tar', ['-xzf', archive, '-C', extraction]);
      const payload = path.join(
        extraction,
        'managed-runtime',
        '0.25.3',
        'darwin-arm64',
      );
      expect(fs.readdirSync(payload).sort()).toEqual([
        'manifest.json',
        'server.jar',
      ]);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8'),
        ),
      ).toMatchObject({ javaSource: 'system', javaMajor: 21 });
      expect(fs.readFileSync(bundled)).toEqual(bundledBytes);
    });
    it('requires exactly one Java delivery mode', () => {
      for (const invalid of [
        [...args.slice(0, 4), ...args.slice(6)],
        [...args, '--without-jre'],
      ]) {
        const result = spawnSync(process.execPath, [script, ...invalid], {
          encoding: 'utf8',
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'exactly one of --jre-home DIR or --without-jre',
        );
      }
      expect(fs.existsSync(outDir)).toBe(false);
    });
    it('keeps default archives outside existing CLI assets and runtime discovery', () => {
      const checkout = path.dirname(path.dirname(script));
      const cliDist = path.join(checkout, 'dist');
      fs.mkdirSync(cliDist);
      fs.writeFileSync(path.join(cliDist, 'cli.js'), 'existing CLI');
      execFileSync(process.execPath, [script, ...args.slice(0, -2)]);

      expect(fs.readdirSync(cliDist)).toEqual(['cli.js']);
      expect(
        fs.existsSync(
          path.join(
            checkout,
            'packages',
            'managed-agent-server',
            'target',
            'managed-runtime',
            'qwen-code-managed-runtime-darwin-arm64.tar.gz',
          ),
        ),
      ).toBe(true);
    });
    it('refuses missing runtime inputs and an unsupported target without emitting an archive', () => {
      const missing = spawnSync(
        process.execPath,
        [script, '--target', 'darwin-arm64'],
        { encoding: 'utf8' },
      );
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('--server-jar is required');
      const unsupported = spawnSync(
        process.execPath,
        [
          script,
          ...args.map((arg) => (arg === 'darwin-arm64' ? 'win-x64' : arg)),
        ],
        { encoding: 'utf8' },
      );
      expect(unsupported.status).toBe(1);
      expect(unsupported.stderr).toContain('native Linux/macOS');
      expect(fs.existsSync(outDir)).toBe(false);
    });
  },
);
