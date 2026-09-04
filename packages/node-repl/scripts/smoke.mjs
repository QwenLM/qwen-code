/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Standalone smoke test: drives the built kernel manager directly (no MCP wire)
// to prove persistence, dynamic import + package singleton, image output, and
// reset. Run: node scripts/smoke.mjs  (from packages/node-repl, after build)
import os from 'node:os';
import path from 'node:path';
import { NodeReplKernelManager } from '../dist/kernel-manager.js';
import { NodeReplSecurityPolicy } from '../dist/security-policy.js';
import { convertOutcomeToMcpResult } from '../dist/output-adapter.js';

const manager = new NodeReplKernelManager({
  cwd: process.cwd(),
  homeDir: os.homedir(),
  tmpRootDir: path.join(os.tmpdir(), 'qwen-node-repl-smoke'),
  policy: NodeReplSecurityPolicy.default(),
  readableRoots: [process.cwd()],
});

const run = async (code) => {
  const outcome = await manager.exec({ code, timeoutMs: 30_000 });
  const mcp = convertOutcomeToMcpResult(outcome);
  return { status: outcome.status, mcp };
};

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

try {
  // 1. Persistence across cells.
  await run('const a = 21;');
  const r2 = await run('nodeRepl.write(String(a * 2));');
  const text2 = r2.mcp.content.find((b) => b.type === 'text')?.text ?? '';
  check('binding persists across cells', text2.includes('42'), text2.trim());

  // 2. Dynamic import of a builtin + closure persistence.
  await run(
    "const os2 = await import('node:os'); const host = os2.hostname();",
  );
  const r3 = await run('nodeRepl.write(typeof host);');
  const text3 = r3.mcp.content.find((b) => b.type === 'text')?.text ?? '';
  check('dynamic import binding persists', text3.includes('string'), text3.trim());

  // 3. Image output (1x1 PNG).
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r4 = await run(
    `await nodeRepl.emitImage({ bytes: Uint8Array.from(atob(${JSON.stringify(png)}), c => c.charCodeAt(0)), mimeType: 'image/png' });`,
  );
  const hasImage = r4.mcp.content.some((b) => b.type === 'image');
  check('emitImage produces an image block', hasImage);

  // 4. Reset discards bindings.
  await manager.reset();
  const r5 = await run('nodeRepl.write(typeof a);');
  const text5 = r5.mcp.content.find((b) => b.type === 'text')?.text ?? '';
  check('reset discards bindings', text5.includes('undefined'), text5.trim());

  // 5. Error surfaces as isError with status note.
  const r6 = await run('throw new Error("boom");');
  const errText = r6.mcp.content.find((b) => b.type === 'text')?.text ?? '';
  check(
    'runtime error -> isError + message',
    r6.mcp.isError === true && errText.includes('boom'),
    errText.trim(),
  );
} finally {
  manager.dispose();
}

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
