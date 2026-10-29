/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as tar from 'tar';
import {
  compileManagedExtensionPackage,
  prepareManagedExtensionPackage,
  managedPackageRelativePath,
} from './managed-package.js';
import { findReleaseAsset } from './github.js';

const target = { platform: 'linux', arch: 'x64' } as const;
let temporary: string;
let root: string;
async function file(name: string, content: string): Promise<void> {
  const destination = path.join(root, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-package-test-'));
  root = path.join(temporary, 'source');
  await fs.mkdir(root);
  await file(
    'qwen-extension.json',
    JSON.stringify({ name: 'fixture', version: '1.0.0' }),
  );
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('Managed raw package compiler', () => {
  it('preserves an architecture-independent publication when compiled on either target architecture', async () => {
    const prepared = await prepareManagedExtensionPackage(
      { type: 'local', source: root },
      {
        target: { platform: 'linux', arch: 'any' },
        destination: path.join(temporary, 'prepared'),
      },
    );
    const extracted = path.join(temporary, 'target');
    await fs.mkdir(extracted);
    await tar.x({ file: prepared.archivePath, cwd: extracted });
    for (const arch of ['x64', 'arm64'] as const) {
      const compiled = await compileManagedExtensionPackage(extracted, {
        target: { platform: 'linux', arch },
        resolveRecipes: false,
      });
      expect(compiled.manifest).toEqual(prepared.manifest);
    }
    await expect(
      compileManagedExtensionPackage(extracted, {
        target: { platform: 'darwin', arch: 'arm64' },
      }),
    ).rejects.toThrow('package target does not match this Runtime');
  });

  it('compiles all seven categories using only target roots and supplied settings', async () => {
    await file(
      'qwen-extension.json',
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        mcpServers: {
          echo: {
            command: 'node',
            args: ['${extensionPath}/server.js'],
            env: { TOKEN: '${TOKEN}' },
          },
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node ${CLAUDE_PLUGIN_ROOT}/hook.js',
                },
              ],
            },
          ],
        },
        settings: [{ name: 'Token', envVar: 'TOKEN', sensitive: true }],
      }),
    );
    await file(
      'skills/inspect/SKILL.md',
      '---\nname: inspect\ndescription: inspect assets\ndisable-model-invocation: true\n---\nRead assets/data.txt.',
    );
    await file('skills/inspect/assets/data.txt', 'durable asset');
    await file(
      'commands/review.md',
      '---\ndescription: Review\nargument-hint: <file>\n---\nReview @{README.md} and !{git status}.',
    );
    await file(
      'agents/reviewer.md',
      '---\nname: reviewer\ndescription: Reviews changes\ntools: Read, Glob\nmodel: inherit\n---\nReview precisely.',
    );
    await file('QWEN.md', 'Use the fixed context.');
    const before = { cwd: process.cwd(), token: process.env['TOKEN'] };
    const compiled = await compileManagedExtensionPackage(root, {
      target,
      workspaceDirectory: '/target/workspace',
      environment: { TOKEN: 'explicit-value' },
    });
    expect(compiled.manifest.components).toEqual([
      'skills',
      'commands',
      'agents',
      'context',
      'mcp',
      'hooks',
      'settings',
    ]);
    expect(compiled.contributions.skills[0]).toMatchObject({
      name: 'fixture:inspect',
      assetDirectory: 'skills/inspect',
      model_invocable: false,
      user_invocable: true,
    });
    expect(compiled.contributions.commands[0].prompt).toContain(
      '!{git status}',
    );
    expect(compiled.contributions.mcpServers).toMatchObject({
      echo: {
        args: [path.join(root, 'server.js')],
        env: { TOKEN: 'explicit-value' },
      },
    });
    expect({ cwd: process.cwd(), token: process.env['TOKEN'] }).toEqual(before);
  });

  it.each([
    'allowed-tools: Read',
    'hooks: {PreToolUse: []}',
    'model: large',
    'paths: [src/**]',
  ])(
    'rejects dynamic Skill declarations before static conversion: %s',
    async (declaration) => {
      await file(
        'skills/unsafe/SKILL.md',
        `---\nname: unsafe\ndescription: fixture\n${declaration}\n---\nBody`,
      );
      await expect(
        compileManagedExtensionPackage(root, { target }),
      ).rejects.toThrow('unsupported');
    },
  );

  it('checks unsupported fields in source format before a converter can discard them', async () => {
    await fs.rm(path.join(root, 'qwen-extension.json'));
    await file(
      'gemini-extension.json',
      JSON.stringify({ name: 'source', version: '1', lspServers: { x: {} } }),
    );
    await expect(
      compileManagedExtensionPackage(root, { target }),
    ).rejects.toThrow('lspServers');
  });

  it('never silently reads a publisher environment variable', async () => {
    await file(
      'qwen-extension.json',
      JSON.stringify({
        name: 'fixture',
        mcpServers: { x: { command: '${HOME}/bin/server' } },
      }),
    );
    await expect(
      compileManagedExtensionPackage(root, { target }),
    ).rejects.toThrow('required');
    const raw = await compileManagedExtensionPackage(root, {
      target,
      resolveRecipes: false,
    });
    expect(raw.contributions.mcpServers).toMatchObject({
      x: { command: '${HOME}/bin/server' },
    });
  });

  it('prepares raw recipes, strips private sidecars and preserves assets and executable modes', async () => {
    await file(
      'qwen-extension.json',
      JSON.stringify({
        name: 'fixture',
        mcpServers: {
          x: { command: 'node', args: ['${extensionPath}/run.js'] },
        },
      }),
    );
    await file('run.js', 'console.log("ok")');
    await fs.chmod(path.join(root, 'run.js'), 0o755);
    await file('.env', 'DO_NOT_DISTRIBUTE=value');
    await file('.qwen-extension-settings.json', 'DO_NOT_DISTRIBUTE');
    const result = await prepareManagedExtensionPackage(
      { source: root, type: 'local' },
      { target, destination: path.join(temporary, 'output') },
    );
    const restored = path.join(temporary, 'restored');
    await fs.mkdir(restored);
    await tar.x({ file: result.archivePath, cwd: restored });
    expect(
      await fs.readFile(path.join(restored, 'qwen-extension.json'), 'utf8'),
    ).toContain('${extensionPath}');
    expect(await fs.readdir(restored)).not.toContain('.env');
    expect(await fs.readdir(restored)).not.toContain(
      '.qwen-extension-settings.json',
    );
    expect((await fs.stat(path.join(restored, 'run.js'))).mode & 0o111).toBe(
      0o111,
    );
    expect(result.packageDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses an installed copy without a separately supplied original source', async () => {
    await file('.qwen-extension-install.json', '{}');
    await expect(
      prepareManagedExtensionPackage(
        { source: root, type: 'local' },
        { target, destination: path.join(temporary, 'output') },
      ),
    ).rejects.toThrow('original source');
  });

  it('rejects symbolic links and package root escapes', async () => {
    await fs.symlink('/etc/passwd', path.join(root, 'outside'));
    await expect(
      compileManagedExtensionPackage(root, { target }),
    ).rejects.toThrow('unsupported resource');
    for (const unsafe of ['../x', '/x', 'C:/x', 'a/../x', 'a\\x', 'a//x'])
      expect(() => managedPackageRelativePath(unsafe)).toThrow();
  });

  it('chooses the target release asset when publication happens on another OS', () => {
    const asset = (name: string) => ({
      name,
      browser_download_url: `https://example.test/${name}`,
    });
    const assets = [
      asset('darwin.arm64.package.tar.gz'),
      asset('linux.x64.package.tar.gz'),
    ];
    expect(findReleaseAsset(assets, target)?.name).toBe(
      'linux.x64.package.tar.gz',
    );
    expect(
      findReleaseAsset(assets, { platform: 'linux', arch: 'arm64' }),
    ).toBeUndefined();
  });
});
