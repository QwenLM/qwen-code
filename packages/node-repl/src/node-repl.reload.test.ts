/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplKernelManager } from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';

// Locks down the documented asymmetry that has no other coverage:
//   - local .js/.mjs files RELOAD on every execution
//   - bare packages keep Node singleton semantics for the kernel's lifetime

const managers: NodeReplKernelManager[] = [];
const tmpDirs: string[] = [];

function makeManager(cwd: string): NodeReplKernelManager {
  const manager = new NodeReplKernelManager({
    cwd,
    homeDir: os.homedir(),
    tmpRootDir: fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-node-repl-reload-'),
    ),
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: [cwd],
  });
  managers.push(manager);
  return manager;
}

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-src-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.dispose();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function textOf(events: Array<{ type: string; text?: string }>): string {
  return events
    .filter((e) => e.type === 'text')
    .map((e) => e.text ?? '')
    .join('');
}

describe('local module reload semantics', () => {
  it('reloads a local .mjs file after it changes on disk', async () => {
    const dir = makeTmpDir();
    const modulePath = path.join(dir, 'mod.mjs');
    fs.writeFileSync(modulePath, 'export const value = "first";');
    const manager = makeManager(dir);

    const first = await manager.exec({
      code: `const m1 = await import(${JSON.stringify(modulePath)}); nodeRepl.write(m1.value);`,
      timeoutMs: 30_000,
    });
    expect(first.status).toBe('ok');
    expect(textOf(first.events).trim()).toBe('first');

    fs.writeFileSync(modulePath, 'export const value = "second";');

    const second = await manager.exec({
      code: `const m2 = await import(${JSON.stringify(modulePath)}); nodeRepl.write(m2.value);`,
      timeoutMs: 30_000,
    });
    expect(second.status).toBe('ok');
    expect(textOf(second.events).trim()).toBe('second');
  });

  it('gives each execution a fresh instance of local module state', async () => {
    const dir = makeTmpDir();
    const modulePath = path.join(dir, 'counter.mjs');
    fs.writeFileSync(
      modulePath,
      'let n = 0; export function bump() { return ++n; }',
    );
    const manager = makeManager(dir);

    const spec = JSON.stringify(modulePath);
    const first = await manager.exec({
      code: `const a = await import(${spec}); nodeRepl.write(String(a.bump()));`,
      timeoutMs: 30_000,
    });
    const second = await manager.exec({
      code: `const b = await import(${spec}); nodeRepl.write(String(b.bump()));`,
      timeoutMs: 30_000,
    });

    // Module-level state resets because the local file is re-instantiated.
    expect(textOf(first.events).trim()).toBe('1');
    expect(textOf(second.events).trim()).toBe('1');
  });
});
