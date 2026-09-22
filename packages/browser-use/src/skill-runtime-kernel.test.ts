/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The bundled skill has the model import the staged runtime/index.js from
// inside the node_repl kernel's untrusted vm context, which has no `process`
// global. build.mjs's own load check imports dist/index.js in Node's main
// realm and therefore cannot see that difference, so this test runs the
// skill's first cell, verbatim from SKILL.md, through the real kernel built in
// packages/node-repl/dist against a runtime it stages itself, the way the
// bundle step and `npm run dev` do, into a temporary skill directory.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const skillFile = path.join(
  repoRoot,
  'packages/core/src/skills/bundled/browser-use/SKILL.md',
);
const browserUseDist = path.join(repoRoot, 'packages/browser-use/dist');
const nodeReplDist = path.join(repoRoot, 'packages/node-repl/dist');
const requiredArtifacts = [
  path.join(nodeReplDist, 'kernel-manager.js'),
  path.join(nodeReplDist, 'security-policy.js'),
  path.join(nodeReplDist, 'runtime/kernel.mjs'),
  path.join(browserUseDist, 'index.js'),
  path.join(browserUseDist, 'native-host.js'),
];

interface KernelOutcome {
  status: string;
  error?: { name: string; message: string; code?: string };
}

interface Kernel {
  exec(request: { code: string; timeoutMs: number }): Promise<KernelOutcome>;
  addModuleRoot(rawPath: string): Promise<{ path: string; added: boolean }>;
  dispose(): void;
}

interface KernelManagerModule {
  NodeReplKernelManager: new (options: {
    cwd: string;
    homeDir: string;
    tmpRootDir: string;
    policy: unknown;
    readableRoots: string[];
  }) => Kernel;
}

interface SecurityPolicyModule {
  NodeReplSecurityPolicy: { default(): unknown };
}

interface CopyAssetsModule {
  copyBrowserUseAssets(root: string, skillDir: string): void;
}

function firstSkillCell(skillBase: string): string {
  const skill = fs.readFileSync(skillFile, 'utf8');
  const cell = /```js\n([\s\S]*?)```/.exec(skill)?.[1];
  if (cell === undefined) throw new Error('SKILL.md has no ```js cell');
  expect(cell).toContain("import('/absolute/skill/base/runtime/index.js')");
  return cell.replaceAll('/absolute/skill/base', skillBase);
}

describe('bundled skill runtime inside the node_repl kernel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs SKILL.md's first cell up to the Chrome bridge without a ReferenceError", async (context) => {
    const missing = requiredArtifacts.filter((file) => !fs.existsSync(file));
    context.skip(
      missing.length > 0,
      'needs `npm run build` in packages/node-repl and packages/browser-use; ' +
        `missing ${missing.join(', ')}`,
    );
    context.skip(
      process.platform === 'win32',
      'asserts the Unix-socket bridge failure; the realm check is host-neutral',
    );

    const { NodeReplKernelManager } = (await import(
      pathToFileURL(path.join(nodeReplDist, 'kernel-manager.js')).href
    )) as KernelManagerModule;
    const { NodeReplSecurityPolicy } = (await import(
      pathToFileURL(path.join(nodeReplDist, 'security-policy.js')).href
    )) as SecurityPolicyModule;
    const { copyBrowserUseAssets } = (await import(
      pathToFileURL(path.join(repoRoot, 'scripts/copy-browser-use-assets.js'))
        .href
    )) as CopyAssetsModule;

    const tmpRootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-browser-use-kernel-'),
    );
    const skillBase = path.join(tmpRootDir, 'skill');
    copyBrowserUseAssets(repoRoot, skillBase);
    const stagedModules = path.join(skillBase, 'runtime/node_modules');
    // A regular file in place of a socket fails the private peer check after
    // the runtime has loaded, without touching the user's Chrome.
    const invalidSocket = path.join(tmpRootDir, 'bridge.sock');
    fs.writeFileSync(invalidSocket, 'not a socket');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', invalidSocket);
    const manager = new NodeReplKernelManager({
      cwd: process.cwd(),
      homeDir: os.homedir(),
      tmpRootDir,
      policy: NodeReplSecurityPolicy.default(),
      readableRoots: [process.cwd()],
    });
    try {
      await manager.addModuleRoot(stagedModules);
      const outcome = await manager.exec({
        code: firstSkillCell(skillBase),
        timeoutMs: 60_000,
      });

      expect(outcome.status).toBe('error');
      // A `ReferenceError: process is not defined` here means the staged
      // runtime lost the kernel-realm `process` binding that build.mjs adds
      // through createRequire.
      expect(outcome.error).toMatchObject({
        name: 'BrowserRuntimeError',
        code: 'TRANSPORT_UNAVAILABLE',
        message: expect.stringContaining(
          'Could not connect to the local Chrome Host',
        ),
      });
    } finally {
      manager.dispose();
      fs.rmSync(tmpRootDir, { recursive: true, force: true });
    }
  }, 90_000);
});
