/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'vitest';
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

describe(
  'bundled skill runtime inside the node_repl kernel',
  { timeout: 90_000 },
  () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function runFirstSkillCell(
      context: TestContext,
      prepareRuntime: (runtimeDir: string) => void = () => {},
    ): Promise<{ outcome: KernelOutcome; runtimeDir: string }> {
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
      const runtimeDir = fs.realpathSync(path.join(skillBase, 'runtime'));
      prepareRuntime(runtimeDir);
      // A regular file in place of a socket fails the private peer check after
      // the runtime has loaded, without touching the user's Chrome.
      const invalidSocket = path.join(tmpRootDir, 'bridge.sock');
      fs.writeFileSync(invalidSocket, 'not a socket');
      vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', invalidSocket);
      // The kernel also resolves bare packages from the cwd's node_modules, and
      // this package's own node_modules holds playwright-core. An empty
      // workspace leaves the SDK's own lookup as the only way to find it.
      const workspace = path.join(tmpRootDir, 'workspace');
      fs.mkdirSync(workspace);
      const manager = new NodeReplKernelManager({
        cwd: workspace,
        homeDir: os.homedir(),
        tmpRootDir,
        policy: NodeReplSecurityPolicy.default(),
        readableRoots: [workspace],
      });
      try {
        const outcome = await manager.exec({
          code: firstSkillCell(skillBase),
          timeoutMs: 60_000,
        });
        return { outcome, runtimeDir };
      } finally {
        manager.dispose();
        fs.rmSync(tmpRootDir, { recursive: true, force: true });
      }
    }

    function expectRuntimeError(
      outcome: KernelOutcome,
      code: string,
      message: string,
    ): void {
      expect(outcome.status).toBe('error');
      expect(outcome.error).toMatchObject({
        name: 'BrowserRuntimeError',
        code,
        message: expect.stringContaining(message),
      });
    }

    it("runs SKILL.md's first cell up to the Chrome bridge without a ReferenceError", async (context) => {
      const { outcome } = await runFirstSkillCell(context);

      // A `ReferenceError: process is not defined` here means the staged
      // runtime lost the kernel-realm `process` binding that build.mjs adds
      // through createRequire; "cannot resolve package 'playwright-core'"
      // means the SDK stopped loading its bundled dependency by itself.
      expectRuntimeError(
        outcome,
        'TRANSPORT_UNAVAILABLE',
        'Could not connect to the local Chrome Host',
      );
    });

    it('reports an incomplete runtime when its bundled playwright-core is missing', async (context) => {
      const { outcome, runtimeDir } = await runFirstSkillCell(
        context,
        (runtime) => {
          fs.rmSync(path.join(runtime, 'node_modules/playwright-core'), {
            recursive: true,
            force: true,
          });
        },
      );

      expectRuntimeError(
        outcome,
        'OPERATION_FAILED',
        `The Browser Use runtime in ${runtimeDir} is incomplete`,
      );
    });

    it('refuses a playwright-core other than the pinned version', async (context) => {
      // Stands in for a missing bundled copy that Node's lookup replaced with
      // an unrelated install further up the directory tree.
      const { outcome, runtimeDir } = await runFirstSkillCell(
        context,
        (runtime) => {
          const manifestPath = path.join(
            runtime,
            'node_modules/playwright-core/package.json',
          );
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          fs.writeFileSync(
            manifestPath,
            JSON.stringify({ ...manifest, version: '0.0.0-foreign' }),
          );
        },
      );

      expectRuntimeError(
        outcome,
        'OPERATION_FAILED',
        `it resolved playwright-core 0.0.0-foreign at ${runtimeDir}/node_modules/playwright-core instead of its bundled`,
      );
    });
  },
);
