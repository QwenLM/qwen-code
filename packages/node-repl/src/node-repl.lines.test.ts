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

// Regression: reported stack line numbers must match the source the caller
// wrote, and must NOT drift as session bindings accumulate. The generated
// prelude is one physical line (compensated by lineOffset: -1) and the
// per-statement snapshot markers are newline-free.

const managers: NodeReplKernelManager[] = [];

function makeManager(): NodeReplKernelManager {
  const manager = new NodeReplKernelManager({
    cwd: process.cwd(),
    homeDir: os.homedir(),
    tmpRootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-line-')),
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: [process.cwd()],
  });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.dispose();
});

/** First `<cellfile>:<line>:<col>` frame from the error stack. */
function reportedLine(stack: string | undefined): number | null {
  if (!stack) return null;
  const match = stack.match(/_cell_[^\s:]*:(\d+):\d+/);
  return match?.[1] ? Number(match[1]) : null;
}

describe('cell stack line fidelity', () => {
  it('reports the correct line with no prior bindings', async () => {
    const manager = makeManager();
    // throw is on source line 1
    const outcome = await manager.exec({
      code: 'throw new Error("boom");',
      timeoutMs: 30_000,
    });
    expect(outcome.status).toBe('error');
    expect(reportedLine(outcome.error?.stack)).toBe(1);
  });

  it('reports the correct line further down a cell', async () => {
    const manager = makeManager();
    const code = ['const a = 1;', 'const b = 2;', 'throw new Error("deep");'];
    const outcome = await manager.exec({
      code: code.join('\n'),
      timeoutMs: 30_000,
    });
    expect(outcome.status).toBe('error');
    // throw is on source line 3
    expect(reportedLine(outcome.error?.stack)).toBe(3);
  });

  it('does not drift as accumulated bindings grow', async () => {
    const manager = makeManager();
    // Build up many live bindings across several cells.
    for (let i = 0; i < 12; i++) {
      const ok = await manager.exec({
        code: `const v${i} = ${i};`,
        timeoutMs: 30_000,
      });
      expect(ok.status).toBe('ok');
    }
    // Same shape as the earlier test: throw on source line 3.
    const outcome = await manager.exec({
      code: ['const x = 1;', 'const y = 2;', 'throw new Error("late");'].join(
        '\n',
      ),
      timeoutMs: 30_000,
    });
    expect(outcome.status).toBe('error');
    expect(reportedLine(outcome.error?.stack)).toBe(3);
  });

  it('keeps imported-module line numbers correct (no cell offset leakage)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-lm-'));
    const modulePath = path.join(dir, 'thrower.mjs');
    // The throw sits on line 4 of the imported file.
    fs.writeFileSync(
      modulePath,
      [
        '// line 1',
        '// line 2',
        'export function boom() {',
        '  throw new Error("inner");',
        '}',
      ].join('\n'),
    );
    const manager = makeManager();
    try {
      const outcome = await manager.exec({
        code: [
          `const m = await import(${JSON.stringify(modulePath)});`,
          'm.boom();',
        ].join('\n'),
        timeoutMs: 30_000,
      });
      expect(outcome.status).toBe('error');
      const stack = outcome.error?.stack ?? '';
      // The imported module has no prelude and no lineOffset.
      expect(stack).toMatch(/thrower\.mjs:4:/);
      // The cell call-site is on cell source line 2.
      expect(reportedLine(stack)).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
