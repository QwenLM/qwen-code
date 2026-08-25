/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeReplKernelManager } from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';

// #9333 acceptance criterion 6: a neutral fixture must cover N-API (.node)
// package loading. We compile a trivial N-API addon on demand with node-gyp and
// load it through a REPL cell via createRequire(import.meta.url) — the same
// native path the roadmap's Computer Use SDK (cua-driver, N-API) will use.
//
// If a C toolchain / node-gyp is unavailable, compilation fails and the addon
// test is skipped with a logged reason (the fixture is real, not synthesized).

const fixtureDir = fileURLToPath(new URL('./fixtures/napi', import.meta.url));
let builtAddonPath: string | null = null;
let buildError: string | null = null;
let manager: NodeReplKernelManager | null = null;

beforeAll(() => {
  try {
    const nodeGyp = fileURLToPath(
      new URL('../../../node_modules/.bin/node-gyp', import.meta.url),
    );
    execFileSync(nodeGyp, ['rebuild'], {
      cwd: fixtureDir,
      stdio: 'pipe',
    });
    const candidate = path.join(
      fixtureDir,
      'build',
      'Release',
      'napi_fixture.node',
    );
    if (fs.existsSync(candidate)) {
      builtAddonPath = candidate;
    } else {
      buildError = `addon not found at ${candidate} after build`;
    }
  } catch (error) {
    buildError = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

afterAll(() => {
  manager?.dispose();
  // Clean the build output so it isn't left dirtying the tree.
  fs.rmSync(path.join(fixtureDir, 'build'), { recursive: true, force: true });
});

function makeManager(): NodeReplKernelManager {
  manager = new NodeReplKernelManager({
    cwd: process.cwd(),
    homeDir: os.homedir(),
    tmpRootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-napi-')),
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: [process.cwd(), fixtureDir],
  });
  return manager;
}

describe('node_repl N-API loading', () => {
  it('loads a native .node addon via createRequire and calls it', async () => {
    if (!builtAddonPath) {
      console.warn(
        `[node-repl] skipping N-API test — addon build unavailable: ${buildError}`,
      );
      return;
    }
    const m = makeManager();
    const code = [
      "const { createRequire } = await import('node:module');",
      'const require = createRequire(import.meta.url);',
      `const addon = require(${JSON.stringify(builtAddonPath)});`,
      'nodeRepl.write(String(addon.add(19, 23)));',
    ].join('\n');
    const outcome = await m.exec({ code, timeoutMs: 60_000 });
    expect(outcome.status).toBe('ok');
    const text = outcome.events
      .filter((e) => e.type === 'text')
      .map((e) => (e.type === 'text' ? e.text : ''))
      .join('');
    expect(text.trim()).toBe('42');
  });
});
