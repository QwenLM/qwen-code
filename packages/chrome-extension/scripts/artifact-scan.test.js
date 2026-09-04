/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  readZipEntries,
  scanArtifactRoots,
  scanEsbuildMetafile,
  scanZipArtifact,
} from './artifact-scan.js';

const zipAvailable = () =>
  spawnSync('zip', ['--version'], { stdio: 'ignore' }).status === 0;

describe('scanArtifactRoots', () => {
  it('accepts a generated payload without external adapter signatures', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-clean-'));
    try {
      mkdirSync(path.join(root, 'background'));
      writeFileSync(
        path.join(root, 'background/service-worker.js'),
        'console.log("qwen bridge");',
      );

      await expect(scanArtifactRoots([root])).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports external Chrome DevTools MCP source signatures', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-dirty-'));
    try {
      const file = path.join(root, 'adapter.js');
      writeFileSync(file, 'class McpContext {} class PageCollector {}');

      await expect(scanArtifactRoots([root])).resolves.toEqual([
        { file, signature: 'class McpContext' },
        { file, signature: 'class PageCollector' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlinks in a packaged artifact tree',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-link-'));
      try {
        const target = path.join(root, 'target.js');
        writeFileSync(target, 'console.log("target");');
        symlinkSync(target, path.join(root, 'linked.js'));

        await expect(scanArtifactRoots([root])).rejects.toThrow(
          'Symbolic links are not allowed in release artifacts',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('reports forbidden dependencies from the production esbuild metafile', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-meta-'));
    try {
      const metafile = path.join(root, 'esbuild.json');
      writeFileSync(
        metafile,
        JSON.stringify({
          inputs: {
            'node_modules/chrome-devtools-mcp/build/src/index.js': {
              bytes: 1,
              imports: [],
            },
          },
          outputs: {},
        }),
      );

      await expect(scanEsbuildMetafile(metafile)).resolves.toEqual([
        {
          file: `${metafile}:node_modules/chrome-devtools-mcp/build/src/index.js`,
          signature: 'node_modules/chrome-devtools-mcp/',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing extension zip', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-zip-'));
    try {
      const zip = path.join(root, 'extension.zip');
      await expect(scanZipArtifact(zip)).rejects.toThrow(
        'Artifact archive does not exist',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!zipAvailable())(
    'rejects symlinks inside a zip archive',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-zipsym-'));
      try {
        const source = path.join(root, 'source');
        mkdirSync(source);
        writeFileSync(path.join(source, 'real.js'), 'console.log("real");');
        symlinkSync(path.join(source, 'real.js'), path.join(source, 'link.js'));

        const archive = path.join(root, 'test.zip');
        const result = spawnSync('zip', ['-ry', archive, '.'], {
          cwd: source,
        });
        expect(result.status).toBe(0);

        await expect(readZipEntries(archive)).rejects.toThrow(
          'Symbolic links are not allowed in release artifacts',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('artifact-scan.js command line', () => {
  const scanScript = fileURLToPath(
    new URL('./artifact-scan.js', import.meta.url),
  );
  const runScan = (args) =>
    spawnSync(process.execPath, [scanScript, ...args], { encoding: 'utf8' });

  it('scans explicit positional roots instead of the default artifacts', () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'qwen-artifact-cli-dirty-'),
    );
    try {
      const file = path.join(root, 'adapter.js');
      writeFileSync(file, 'class McpContext {}');

      const result = runScan([root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${file}: forbidden signature class McpContext`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('exits clean for explicit positional roots without forbidden signatures', () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'qwen-artifact-cli-clean-'),
    );
    try {
      mkdirSync(path.join(root, 'background'));
      writeFileSync(
        path.join(root, 'background/service-worker.js'),
        'console.log("qwen bridge");',
      );

      const result = runScan([root]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ARTIFACT-SCAN: PASS');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
